import { FusionController } from "../core/controller.ts";
import { createManifestStore, readRunManifest, translateOpenCodeV1, type RunManifest } from "../core/manifest.ts";
import { canonicalWorkspace, openWorkspaceRegistry, type WorkspaceLease } from "../workspace/ownership.ts";
import { EXECUTOR_SYSTEM_PROMPT } from "../prompts.ts";
import { formatCompactReport } from "../report.ts";
import { snapshotWorkspace, snapshotWorkspaceAfter, workspaceDiffStat, workspaceEvidenceRefs } from "../workspace/evidence.ts";
import { nodeGitExec } from "../workspace/node-git.ts";
import { OPENCODE_CAPABILITIES, type NativeSubagentExecute, type NativeToolContext } from "./native-executor.ts";
import { createOpenCodeWorkerRuntime, type OpenCodeWorkerRuntime } from "./worker-runtime.ts";
import type { WorkerHandle, WorkerTurnRequest } from "../core/worker.ts";
import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceSnapshot } from "../workspace/evidence.ts";

interface ToolContext extends NativeToolContext { readonly agent: string }
interface ToolDefinition {
	name: string;
	description: string;
	input: Record<string, unknown>;
	options: { codemode: false };
	execute: (input: unknown, context: ToolContext) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
}
interface PluginContext {
	location: { directory: string };
	storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown>; remove(key: string): Promise<unknown> };
	tool: {
		list(): Promise<readonly { id: string; execute: NativeSubagentExecute<ToolContext> }[]>;
		transform(callback: (editor: { add(tool: ToolDefinition): void }) => void): Promise<unknown>;
		hook(name: "execute.before", callback: (event: { tool: string; agent: string }) => void): Promise<unknown>;
	};
	session: {
		context(input: { sessionID: string }): Promise<readonly unknown[]>;
		get(input: { sessionID: string }): Promise<{ id: string; parentID?: string; location?: { directory?: string } }>;
		hook(name: "context", callback: (event: { agent: string; tools: Record<string, unknown> }) => void): Promise<unknown>;
	};
}

interface Run {
	controller: FusionController;
	handle: WorkerHandle;
	runtime: OpenCodeWorkerRuntime;
	runId: string;
	lease?: WorkspaceLease;
	lastResult?: RunManifest["lastResult"];
	model?: RunManifest["model"];
	adapterData?: RunManifest["adapterData"];
	setContext(context: ToolContext): void;
	reconciling?: boolean;
	before?: WorkspaceSnapshot;
}

/** Match OpenCode's completion notification to this specific native job generation. */
function notificationResult(messages: readonly unknown[], childID: string, description: string): { state: "completed" | "error" | "cancelled"; output: string } {
	for (const item of messages) {
		if (!item || typeof item !== "object") continue;
		const message = item as Record<string, unknown>;
		if (message.type !== "synthetic" || message.description !== description || !message.metadata || typeof message.metadata !== "object") continue;
		const metadata = message.metadata as Record<string, unknown>;
		if (metadata.source !== "subagent" || metadata.childID !== childID || metadata.agent !== "fusion-executor" || (metadata.state !== "completed" && metadata.state !== "error" && metadata.state !== "cancelled") || typeof message.text !== "string") continue;
		const prefix = `<subagent sessionID="${childID}" state="${metadata.state}" description="${description}">\n`;
		const suffix = "\n</subagent>";
		if (!message.text.startsWith(prefix) || !message.text.endsWith(suffix)) continue;
		const output = message.text.slice(prefix.length, -suffix.length);
		return { state: metadata.state, output };
	}
	throw new Error("No matching completion notification yet. Retry reconciliation if it arrives; otherwise inspect the worker and workspace, then explicitly resolve ownership after confirming the worker has stopped.");
}

/** OpenCode v2 server plugin. A plugin instance is scoped to one location. */
export default {
	id: "fusion",
	async setup(ctx: PluginContext, dependencies: { ownershipRoot?: string; canonicalize?: (cwd: string) => Promise<string>; openRegistry?: typeof openWorkspaceRegistry } = {}) {
		const native = (await ctx.tool.list()).find((tool) => tool.id === "subagent");
		if (!native) throw new Error("Fusion requires OpenCode's native subagent tool.");
		const canonicalize = dependencies.canonicalize ?? canonicalWorkspace;
		const workspace = await canonicalize(ctx.location.directory);
		const registry = await (dependencies.openRegistry ?? openWorkspaceRegistry)(dependencies.ownershipRoot);
		const runs = new Map<string, Run>();
		let owner: string | undefined;
		let resetting = false;
		// Native notification matching depends on this exact description format.
		const services = {
			now: () => Date.now(),
			newRunId: () => randomUUID(),
			newRequestId: (action: "execute" | "revise" | "final_fix" | "resume") => `Fusion ${action} ${randomUUID()}`,
		};
		const storageKey = `run/${createHash("sha256").update(ctx.location.directory).digest("hex")}`;
		async function makeRun(sessionID: string, record?: RunManifest): Promise<Run> {
			let toolContext: ToolContext | undefined;
			const workerOwner = { harness: "opencode", supervisorId: sessionID, workspace };
			const runtime = createOpenCodeWorkerRuntime<ToolContext>({
				execute: native!.execute,
				contextFor: () => { if (!toolContext) throw new Error("OpenCode tool context is unavailable."); return toolContext; },
				validateReference: async (reference) => {
					const [parent, child] = await Promise.all([ctx.session.get({ sessionID }), ctx.session.get({ sessionID: reference.id })]);
					if (parent.id !== sessionID || !parent.location?.directory || await canonicalize(parent.location.directory) !== workspace || child.id !== reference.id || child.parentID !== sessionID || !child.location?.directory || await canonicalize(child.location.directory) !== workspace) throw new Error("OpenCode child ownership or workspace does not match.");
				},
			});
			const state = record ? { ...record.state, delegating: false } : { runActive: false, phase: "idle" as const, settleNudges: 0, delegating: false, executed: false, revisions: 0, finalFixUsed: false, resumePending: false, scoutCalls: 0 };
			const controller = new FusionController(state, services, runtime);
			const runId = record?.runId ?? randomUUID();
			const reference = record?.worker;
			const config = { role: "executor" as const };
			const handle = record?.pending ? await runtime.restorePending(workerOwner, config, { runId, requestId: record.pending.requestId }, reference) : reference ? await runtime.open(reference, config) : await runtime.create(workerOwner, config);
			if (record?.pending) controller.setPending({ action: record.pending.action, requestId: record.pending.requestId });
			controller.setUncertain(!!record && record.recovery !== "settled");
			return { controller, handle, runtime, runId, lastResult: record?.lastResult, model: record?.model, adapterData: record?.adapterData, setContext(context) { toolContext = context; } };
		}
		const store = createManifestStore({
			read: () => ctx.storage.get(storageKey), write: async (value) => { await ctx.storage.set(storageKey, value); }, remove: async () => { await ctx.storage.remove(storageKey); },
		}, { harness: "opencode", workspace }, (raw) => {
			const legacy = translateOpenCodeV1(raw, ctx.location.directory, OPENCODE_CAPABILITIES);
			legacy.owner.workspace = workspace;
			if (legacy.worker) legacy.worker.owner.workspace = workspace;
			return legacy;
		});
		let localSaved = await store.load();
		const sharedSaved = await registry.inspect(workspace);
		if (!sharedSaved && localSaved) {
			const archived = await registry.archived(localSaved.runId);
			if (archived && archived.owner.harness === "opencode" && archived.owner.workspace === workspace && archived.owner.supervisorId === localSaved.owner.supervisorId && archived.recovery === "settled" &&
				(!localSaved.pending && !localSaved.adapterData?.legacyOpenCode || !!localSaved.pending && (archived.lastResult?.requestId === localSaved.pending.requestId || archived.operatorResolution?.pending?.requestId === localSaved.pending.requestId))) localSaved = undefined;
		}
		if (sharedSaved && sharedSaved.manifest.owner.workspace !== workspace) throw new Error("An overlapping Fusion workspace requires recovery before this location can be used.");
		const saved = sharedSaved?.manifest.owner.harness === "opencode" ? sharedSaved.manifest : localSaved;
		if (saved) {
			if (sharedSaved && (sharedSaved.manifest.runId !== saved.runId || sharedSaved.manifest.owner.harness !== "opencode")) throw new Error("Another Fusion run owns this workspace.");
			const run = await makeRun(saved.owner.supervisorId, saved);
			run.lease = await registry.claim(saved, sharedSaved?.token);
			runs.set(saved.owner.supervisorId, run);
			owner = saved.owner.supervisorId;
		}
		function manifest(run: Run): RunManifest {
			const pending = run.controller.pending;
			if (pending?.action === "resume") throw new Error("OpenCode cannot persist a resume action.");
			return readRunManifest({ version: 2, runId: run.runId, owner: run.handle.owner,
				state: { ...run.controller.state, delegating: !!pending && run.controller.state.delegating }, worker: run.handle.reference,
				capabilities: run.runtime.capabilities, recovery: pending ? "pending" : run.controller.uncertain ? "manual" : "settled",
				pending, lastResult: run.lastResult, model: run.model, adapterData: run.adapterData }, { harness: "opencode", workspace });
		}
		async function persist(_sessionID: string, run: Run): Promise<void> {
			if (!run.lease) throw new Error("Fusion workspace has not been claimed.");
			const value = manifest(run);
			await run.lease.save(value);
			await store.save(value);
		}
		// The native executor is called directly below; model-originated calls pass
		// through OpenCode's tool hook and must not bypass Fusion's run guards.
		await ctx.tool.hook("execute.before", (event) => {
			if (event.agent === "fusion" && event.tool === "subagent") throw new Error("Use fusion_delegate to start Fusion executor work.");
		});
		await ctx.session.hook("context", (event) => {
			if (event.agent === "fusion") delete event.tools.subagent;
		});
		function requireSupervisor(context: ToolContext): void {
			if (context.agent !== "fusion") throw new Error("Fusion tools are available only to the fusion primary agent.");
		}
		const creating = new Map<string, Promise<Run>>();
		async function runFor(sessionID: string): Promise<Run> {
			const existing = runs.get(sessionID);
			if (existing) return existing;
			let pending = creating.get(sessionID);
			if (!pending) {
				pending = makeRun(sessionID).then((run) => { runs.set(sessionID, run); return run; });
				creating.set(sessionID, pending);
			}
			try { return await pending; } finally { if (creating.get(sessionID) === pending) creating.delete(sessionID); }
		}

		await ctx.tool.transform((editor) => {
			editor.add({
				name: "fusion_delegate",
				description: "Delegate a decided implementation brief to the Fusion executor. Use execute once, then up to three revise calls and one final_fix after the acceptance audit. Review the actual working tree after each call.",
				input: { type: "object", properties: { action: { type: "string", enum: ["execute", "revise", "final_fix"] }, brief: { type: "string", minLength: 1 }, originalTask: { type: "string" } }, required: ["action", "brief"], additionalProperties: false },
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					if (resetting) throw new Error("Fusion reset is in progress.");
					if (!input || typeof input !== "object") throw new Error("Invalid Fusion delegation input.");
					const value = input as Record<string, unknown>;
					if ((value.action !== "execute" && value.action !== "revise" && value.action !== "final_fix") || typeof value.brief !== "string" || !value.brief.trim() || (value.originalTask !== undefined && typeof value.originalTask !== "string")) throw new Error("Invalid Fusion delegation input.");
					const action = value.action;
					const run = await runFor(context.sessionID);
					if (resetting) throw new Error("Fusion reset is in progress.");
					if (run.reconciling) throw new Error("Fusion reconciliation is already in progress.");
					if (run.controller.uncertain) throw new Error("The executor's last turn has an unknown outcome. Review the child session and working tree before recovery; automatic retry is disabled.");
					if (owner && owner !== context.sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
					const error = run.controller.beginDelegation(action, OPENCODE_CAPABILITIES, value.brief);
					if (error) throw new Error(error);
					run.setContext(context);
					if (action === "execute") {
						run.controller.startExecution(typeof value.originalTask === "string" && value.originalTask.trim() ? value.originalTask : value.brief, value.brief);
					}
					run.controller.setPhase(action === "execute" ? "executing" : action === "revise" ? "revising" : "finalizing");
					const promptText = run.controller.delegationPrompt(action, value.brief);
					const prompt = action === "execute" ? `${EXECUTOR_SYSTEM_PROMPT}\n\n${promptText}` : promptText;
					// beginDelegation minted and recorded the pending request identity.
					const description = run.controller.pending?.requestId;
					if (!description) throw new Error("Fusion delegation lost its pending request identity.");
					try {
						const request: WorkerTurnRequest = { runId: run.runId, requestId: description, worker: run.handle, prompt };
						return await run.controller.performWorkerDelegation(request, { signal: context.signal, onEvent: () => {} }, {
							// Authoritative in-sequence claim: the precondition above is a
							// fast guard, this re-check wins the workspace before intent.
							claim: async () => {
								if (owner && owner !== context.sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
								if (!run.lease) run.lease = await registry.claim(manifest(run));
								owner = context.sessionID;
							},
							recordIntent: () => persist(context.sessionID, run),
							snapshot: async () => {
								const before = await snapshotWorkspace(ctx.location.directory, nodeGitExec);
								run.before = before;
								return before;
							},
							recordReference: () => persist(context.sessionID, run),
							collect: async (result, before) => {
								const workspaceAfter = await snapshotWorkspaceAfter(before, nodeGitExec);
								const evidence = await workspaceEvidenceRefs(before, nodeGitExec, undefined, workspaceAfter);
								run.lastResult = { requestId: result.requestId, status: result.status, text: result.text, evidence: evidence ?? [] };
								return { result, parsed: run.controller.executorReport(result.text), diffStat: await workspaceDiffStat(before, nodeGitExec) };
							},
							settle: async ({ result, parsed, diffStat }) => {
								await run.runtime.settle(request, async () => {
									await run.controller.persistSettlement(result.status, async () => {
										run.lastResult = { requestId: result.requestId, status: result.status, text: result.text, evidence: run.lastResult?.evidence ?? [] };
										const value = { ...manifest(run), recovery: "settled" as const };
										await run.lease!.save(value); await store.save(value);
									});
								});
								run.before = undefined;
								// Child tool events are unavailable, so require a full working-tree review.
								return { content: formatCompactReport(parsed.report, diffStat, parsed.prose, ["executor tool activity unavailable; review the full working tree"]), metadata: { childSessionID: run.handle.reference?.id, action } };
							},
						});
					} catch (error) {
						run.controller.failDelegation();
						if (!run.lease) { run.controller.clearPending(); throw error; }
						if (!run.controller.submissionBegan && !run.controller.pending) throw error;
						if (!run.controller.submissionBegan && run.controller.pending) {
							// No native call occurred. Clear the write-ahead intent before
							// allowing another attempt; a failed clear remains uncertain.
							const pending = run.controller.pending;
							run.controller.clearPending();
							let cleared = false;
							try {
								await persist(context.sessionID, run);
								cleared = true;
							} catch {
								run.controller.setPending(pending);
							}
							if (cleared) { run.before = undefined; throw error; }
						}
						// Child creation and submission can fail before progress delivers an ID.
						// Without proof of settlement, retrying could duplicate edits.
						run.controller.setUncertain(true);
						// Save a child ID returned only in the native result as well as IDs
						// delivered through progress. Failure keeps the run locked.
						if (run.controller.pending) await persist(context.sessionID, run);
						if (run.runtime.status(run.handle).backgrounded) return { content: "Fusion executor is running in the background. After OpenCode delivers its completion notification, call fusion_reconcile before reviewing or delegating again.", metadata: { childSessionID: run.handle.reference?.id, status: "running" } };
						throw error;
					} finally {
						run.controller.endDelegation(action);
					}
				},
			});
			editor.add({
				name: "fusion_reconcile", description: "Reconcile a backgrounded Fusion executor after OpenCode delivers its completion notification.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					if (resetting) throw new Error("Fusion reset is in progress.");
					const run = runs.get(context.sessionID);
					if (!run?.controller.uncertain || !run.controller.pending || !run.runtime.status(run.handle).backgroundPending && !run.runtime.status(run.handle).unsettled) throw new Error("No backgrounded Fusion turn is available for reconciliation.");
					if (run.controller.state.delegating || run.reconciling) throw new Error("Fusion reconciliation is already in progress.");
					const pending = run.controller.pending;
					run.reconciling = true;
					try {
						run.setContext(context);
						const request: WorkerTurnRequest = { runId: run.runId, requestId: pending.requestId, worker: run.handle, prompt: "" };
						const persistResult = async (result: import("../core/worker.ts").WorkerTurnResult) => {
							await run.controller.persistSettlement(result.status, async () => {
								// Reconciliation settles the same request the evidence was
								// collected for; anything else gets empty evidence.
								const retained = run.lastResult;
								run.lastResult = { requestId: result.requestId, status: result.status, text: result.text, evidence: retained?.requestId === result.requestId ? retained.evidence ?? [] : [] };
								const value = { ...manifest(run), recovery: "settled" as const };
								await run.lease!.save(value); await store.save(value);
							});
						};
						const result = run.runtime.status(run.handle).unsettled
							? await run.runtime.settle(request, persistResult)
							: await run.runtime.reconcile(request, { signal: context.signal, onEvent: () => {}, onReference: () => persist(context.sessionID, run) }, async (childID, _request, signal) => {
								if (signal.aborted) throw new Error("Fusion reconciliation was cancelled.");
								const retained = run.lastResult;
								if (retained?.requestId === pending.requestId && retained.text !== undefined) return { status: retained.status, text: retained.text };
								const messages = await ctx.session.context({ sessionID: context.sessionID });
								if (signal.aborted) throw new Error("Fusion reconciliation was cancelled.");
								const notification = notificationResult(messages, childID, pending.requestId);
								return { status: notification.state, text: notification.output };
							}, persistResult);
						run.controller.setUncertain(false);
						const terminalState = result.status;
						const parsed = run.controller.executorReport(result.text);
						const stat = await workspaceDiffStat(run.before, nodeGitExec);
						run.before = undefined;
						if (terminalState !== "completed") return { content: `Fusion executor ${terminalState}: ${result.text}\nReview the full working tree before deciding whether to revise.`, metadata: { childSessionID: run.handle.reference?.id, action: pending.action, status: terminalState } };
						return { content: formatCompactReport(parsed.report, stat, parsed.prose, ["reconciled background turn; review the full working tree"]), metadata: { childSessionID: run.handle.reference?.id, action: pending.action } };
					} finally { run.reconciling = false; }
				},
			});
			editor.add({
				name: "fusion_status", description: "Show the current Fusion run state.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					const run = runs.get(context.sessionID);
					if (!run) {
						const owned = await registry.inspect(workspace);
						if (!owned) return { content: "No Fusion run in this session." };
						return { content: JSON.stringify({ message: "Another Fusion run owns this workspace.", runId: owned.manifest.runId, owner: owned.manifest.owner, recovery: owned.manifest.recovery, pending: owned.manifest.pending, nextAction: "Reconcile in the owning harness or explicitly resolve ownership after inspecting the worker and workspace." }) };
					}
					const status = run.runtime.status(run.handle);
					const nextAction = run.controller.uncertain
						? status.backgroundPending || status.unsettled
							? "Call fusion_reconcile; if exact completion proof is unavailable, inspect the worker and workspace and explicitly resolve ownership after confirming the worker stopped."
							: "Inspect the worker and workspace; explicitly resolve ownership after confirming the worker stopped."
						: "Review the working tree or reset when the run is finished.";
					return { content: JSON.stringify({ ...run.controller.state, runId: run.runId, owner: run.handle.owner, pending: run.controller.pending, childSessionID: run.handle.reference?.id, uncertain: run.controller.uncertain, backgroundPending: status.backgroundPending, reconciling: !!run.reconciling, nextAction }) };
				},
			});
			editor.add({
				name: "fusion_reset", description: "Finish a settled Fusion run and release its workspace for another session.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					if (resetting) throw new Error("Fusion reset is in progress.");
					const run = runs.get(context.sessionID);
					if (!run) return { content: "No Fusion run in this session." };
					const error = run.controller.resetError(false, run.reconciling);
					if (error) throw new Error(error);
					resetting = true;
					try {
						await store.removeSettled(run.runId);
						await run.lease?.release();
						await run.runtime.release(run.handle);
						await run.runtime.shutdown();
						runs.delete(context.sessionID);
						if (owner === context.sessionID) owner = undefined;
						return { content: "Fusion run reset." };
					} finally { resetting = false; }
				},
			});
		});
		// Embedding hosts may call this on unload. Process exit also releases SQLite locks.
		return { close() { for (const run of runs.values()) run.lease?.close(); } };
	},
};
