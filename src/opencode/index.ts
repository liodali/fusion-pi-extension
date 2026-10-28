import { FusionController } from "../core/controller.ts";
import { readRecoveryRecord, recoveryDisposition, type RecoveryRecord } from "../core/recovery.ts";
import { EXECUTOR_SYSTEM_PROMPT } from "../prompts.ts";
import { formatCompactReport, parseExecutorReport } from "../report.ts";
import { snapshotWorkspace, workspaceDiffStat } from "../workspace/evidence.ts";
import { nodeGitExec } from "../workspace/node-git.ts";
import { createNativeExecutor, OPENCODE_CAPABILITIES, type NativeSubagentExecute, type NativeToolContext } from "./native-executor.ts";
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
		hook(name: "context", callback: (event: { agent: string; tools: Record<string, unknown> }) => void): Promise<unknown>;
	};
}

type Handle = ReturnType<typeof createNativeExecutor<ToolContext>>;
interface Run {
	controller: FusionController;
	handle: Handle;
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
	throw new Error("No matching completion notification yet. Wait for the native notification and retry reconciliation.");
}

/** OpenCode v2 server plugin. A plugin instance is scoped to one location. */
export default {
	id: "fusion",
	async setup(ctx: PluginContext) {
		const native = (await ctx.tool.list()).find((tool) => tool.id === "subagent");
		if (!native) throw new Error("Fusion requires OpenCode's native subagent tool.");
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
		const saved = await ctx.storage.get(storageKey);
		if (saved !== undefined && saved !== null) {
			const record = readRecoveryRecord(saved, ctx.location.directory, "opencode");
			const disposition = recoveryDisposition(record);
			const state = { ...record.state, delegating: false };
			const controller = new FusionController(state, services);
			if (record.pending) controller.setPending({ action: record.pending.action, requestId: record.pending.description });
			controller.setUncertain(disposition !== "settled");
			const run: Run = {
				controller,
				handle: createNativeExecutor({ parentSessionID: record.parentSessionID, agent: "fusion-executor", execute: native.execute, childSessionID: record.childSessionID, pending: disposition === "reconcile" }),
			};
			runs.set(record.parentSessionID, run);
			owner = record.parentSessionID;
		}
		async function persist(sessionID: string, run: Run): Promise<void> {
			const pending = run.controller.pending;
			if (pending?.action === "resume") throw new Error("OpenCode cannot persist a resume action.");
			const record: RecoveryRecord = { version: 1, harness: "opencode", workspace: ctx.location.directory, parentSessionID: sessionID,
				state: { ...run.controller.state }, childSessionID: run.handle.childSessionID,
				pending: pending && { action: pending.action, description: pending.requestId } };
			await ctx.storage.set(storageKey, record);
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
		function runFor(sessionID: string): Run {
			let run = runs.get(sessionID);
			if (!run) {
				run = {
					controller: new FusionController({ runActive: false, phase: "idle", settleNudges: 0, delegating: false, executed: false, revisions: 0, finalFixUsed: false, resumePending: false, scoutCalls: 0 }, services),
					handle: createNativeExecutor({ parentSessionID: sessionID, agent: "fusion-executor", execute: native!.execute }),
				};
				runs.set(sessionID, run);
			}
			return run;
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
					const run = runFor(context.sessionID);
					if (run.reconciling) throw new Error("Fusion reconciliation is already in progress.");
					if (run.controller.uncertain) throw new Error("The executor's last turn has an unknown outcome. Review the child session and working tree before recovery; automatic retry is disabled.");
					if (owner && owner !== context.sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
					const error = run.controller.beginDelegation(action, OPENCODE_CAPABILITIES, value.brief);
					if (error) throw new Error(error);
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
						return await run.controller.performDelegation({
							// Authoritative in-sequence claim: the precondition above is a
							// fast guard, this re-check wins the workspace before intent.
							claim: async () => {
								if (owner && owner !== context.sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
								owner = context.sessionID;
							},
							recordIntent: () => persist(context.sessionID, run),
							snapshot: async () => {
								const before = await snapshotWorkspace(ctx.location.directory, nodeGitExec);
								run.before = before;
								return before;
							},
							submit: () => run.handle.prompt(prompt, description, { ...context, progress: async (update) => {
								if (typeof update.sessionID === "string" && update.sessionID) await persist(context.sessionID, run);
								await context.progress(update);
							} }),
							collect: async (result, before) => ({ result, parsed: parseExecutorReport(result.output), diffStat: await workspaceDiffStat(before, nodeGitExec) }),
							settle: async ({ result, parsed, diffStat }) => {
								run.controller.settleDelegation("completed");
								const pending = run.controller.pending;
								run.controller.clearPending();
								try { await persist(context.sessionID, run); } catch (error) { if (pending) run.controller.setPending(pending); throw error; }
								run.before = undefined;
								// Child tool events are unavailable, so require a full working-tree review.
								return { content: formatCompactReport(parsed.report, diffStat, parsed.prose, ["executor tool activity unavailable; review the full working tree"]), metadata: { childSessionID: result.sessionID, action } };
							},
						});
					} catch (error) {
						run.controller.failDelegation();
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
						if (run.handle.backgroundPending) return { content: "Fusion executor is running in the background. After OpenCode delivers its completion notification, call fusion_reconcile before reviewing or delegating again.", metadata: { childSessionID: run.handle.childSessionID, status: "running" } };
						run.handle.markPending();
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
					if (!run?.controller.uncertain || !run.controller.pending || !run.handle.backgroundPending) throw new Error("No backgrounded Fusion turn is available for reconciliation.");
					if (run.controller.state.delegating || run.reconciling) throw new Error("Fusion reconciliation is already in progress.");
					const pending = run.controller.pending;
					run.reconciling = true;
					try {
						let terminalState: "completed" | "error" | "cancelled" = "completed";
						const result = await run.handle.settleBackground(context, async (childID, signal) => {
							if (signal.aborted) throw new Error("Fusion reconciliation was cancelled.");
							const messages = await ctx.session.context({ sessionID: context.sessionID });
							if (signal.aborted) throw new Error("Fusion reconciliation was cancelled.");
							const notification = notificationResult(messages, childID, pending.requestId);
							terminalState = notification.state;
							return notification.output;
						});
						run.controller.settleDelegation(terminalState);
						run.controller.clearPending();
						try { await persist(context.sessionID, run); } catch (error) { run.controller.setPending(pending); run.handle.markPending(); throw error; }
						run.controller.setUncertain(false);
						const parsed = parseExecutorReport(result.output);
						const stat = await workspaceDiffStat(run.before, nodeGitExec);
						run.before = undefined;
						if (terminalState !== "completed") return { content: `Fusion executor ${terminalState}: ${result.output}\nReview the full working tree before deciding whether to revise.`, metadata: { childSessionID: result.sessionID, action: pending.action, status: terminalState } };
						return { content: formatCompactReport(parsed.report, stat, parsed.prose, ["reconciled background turn; review the full working tree"]), metadata: { childSessionID: result.sessionID, action: pending.action } };
					} finally { run.reconciling = false; }
				},
			});
			editor.add({
				name: "fusion_status", description: "Show the current Fusion run state.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					const run = runs.get(context.sessionID);
					if (!run) return { content: "No Fusion run in this session." };
					return { content: JSON.stringify({ ...run.controller.state, childSessionID: run.handle.childSessionID, uncertain: run.controller.uncertain, backgroundPending: run.handle.backgroundPending, reconciling: !!run.reconciling }) };
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
						await ctx.storage.remove(storageKey);
						runs.delete(context.sessionID);
						if (owner === context.sessionID) owner = undefined;
						return { content: "Fusion run reset." };
					} finally { resetting = false; }
				},
			});
		});
	},
};
