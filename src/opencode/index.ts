import { FusionController } from "../core/controller.ts";
import { createManifestStore, readRunManifest, translateOpenCodeV1, type RunManifest } from "../core/manifest.ts";
import { canonicalWorkspace, openWorkspaceRegistry, type WorkspaceLease } from "../workspace/ownership.ts";
import { EXECUTOR_SYSTEM_PROMPT, FUSION_SUMMARY_HEADING, MAX_SCOUT_CALLS, buildScoutPrompt, buildSupervisorPrompt } from "../prompts.ts";
import { MAX_SCOUT_TOOL_CALLS, formatScoutResponse, scoutCapDecision } from "../core/scout.ts";
import { MAX_REVISIONS } from "../limits.ts";
import { getOutputPrice, isModelInTier, type FusionModelTier } from "../pricing.ts";
import { RECENT_MODEL_COHORT, isRecentModel } from "../recent-models.ts";
import { formatCompactReport } from "../report.ts";
import { snapshotWorkspace, snapshotWorkspaceAfter, workspaceDiffStat, workspaceEvidenceRefs } from "../workspace/evidence.ts";
import { nodeGitExec } from "../workspace/node-git.ts";
import { OPENCODE_CAPABILITIES, type NativeSubagentExecute, type NativeToolContext } from "./native-executor.ts";
import { createOpenCodeWorkerRuntime, type OpenCodeWorkerRuntime, type ScoutCap } from "./worker-runtime.ts";
import type { WorkerConfig, WorkerHandle, WorkerModelConfig, WorkerTurnRequest, WorkerTurnResult } from "../core/worker.ts";
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
/** Tool-call hook event. OpenCode v2.2.x pins `sessionID`, `messageID`, `id`, and `input`; older shapes carry only tool/agent. */
interface ToolHookEvent {
	tool: string;
	agent: string;
	/** Session that executes the tool; scout-child calls are counted by this ID. */
	sessionID?: string;
	input?: unknown;
}
/** The subset of the host's model catalog entry Fusion validates and reports on (pinned live on v2.2.3). */
interface HostModel {
	id?: string;
	modelID?: string;
	providerID?: string;
	type?: string;
	name?: string;
	status?: string;
	enabled?: boolean;
	variants?: readonly { id?: string }[];
	/** Per-tier pricing; the first entry is the base tier. */
	cost?: readonly { output?: number }[];
	time?: { released?: number };
}
/** A plugin-registered native command; `execute` performs the action, its return value is presentation-only. */
interface CommandDefinition {
	name: string;
	description: string;
	execute: (args: { sessionID: string; prompt?: { text?: string }; delivery?: string }) => unknown;
}
interface CommandEditor {
	add(command: CommandDefinition): unknown;
}
interface PluginContext {
	location: { directory: string };
	storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown>; remove(key: string): Promise<unknown> };
	tool: {
		list(): Promise<readonly { id: string; execute: NativeSubagentExecute<ToolContext> }[]>;
		transform(callback: (editor: { add(tool: ToolDefinition): void }) => void): Promise<unknown>;
		hook(name: "execute.before", callback: (event: ToolHookEvent) => void): Promise<unknown>;
	};
	session: {
		context(input: { sessionID: string }): Promise<readonly unknown[]>;
		get(input: { sessionID: string }): Promise<{ id: string; parentID?: string; location?: { directory?: string } }>;
		hook(name: "context", callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void): Promise<unknown>;
		/** Present in OpenCode v2 hosts; absence leaves worker abort unsupported. */
		interrupt?(input: { sessionID: string }): Promise<unknown>;
		/** Present in OpenCode v2 hosts; absence leaves /fusion unable to inject the supervisor prompt. */
		prompt?(input: { sessionID: string; id?: string; text?: string }): Promise<unknown>;
		switchAgent?(input: { sessionID: string; agent: string }): Promise<unknown>;
		synthetic?(input: { sessionID: string; text: string; description?: string; resume?: boolean }): Promise<unknown>;
	};
	/** Pinned in OpenCode v2.2.2: options-object subscribe returning a lazy async iterable. Absence leaves worker events unsupported. */
	event?: {
		subscribe(options?: { types?: string[]; signal?: AbortSignal }): AsyncIterable<{ id?: string; type: string; data?: Record<string, unknown> }>;
	};
	/** Pinned live on OpenCode v2.2.3: `{ location, data }` with the flat model catalog. Absence leaves Fusion on host-default models. */
	model?: {
		list(): Promise<{ location?: unknown; data?: readonly HostModel[] }>;
	};
	/** Pinned live on OpenCode v2.2.3: transform registers commands (`{name, description, execute}`); execute receives `{ sessionID, prompt: { text }, delivery }` and its return value is presentation-only. Absence leaves Fusion without user-facing commands. */
	command?: {
		list(): Promise<{ location?: unknown; data?: readonly { name?: string; description?: string }[] }>;
		transform(callback: (editor: CommandEditor) => unknown): Promise<unknown>;
	};
}

/** Dedicated disposable read-only scout subagent. */
const SCOUT_AGENT = "fusion-scout";
/** Read/search/list operations the scout may execute; everything else is refused before its effects occur. OpenCode v2 tool names. */
const SCOUT_TOOLS = new Set(["read", "grep", "glob"]);
/** Fusion tools hidden from the fusion agent when persistent mode is off and its session has no active run. Read-only reporting tools stay visible. */
const FUSION_GATED_TOOLS = ["fusion_start", "fusion_delegate", "fusion_scout", "fusion_reconcile", "fusion_reset", "fusion_configure"];

interface Run {
	controller: FusionController;
	handle: WorkerHandle;
	runtime: OpenCodeWorkerRuntime;
	runId: string;
	lease?: WorkspaceLease;
	lastResult?: RunManifest["lastResult"];
	model?: RunManifest["model"];
	adapterData?: RunManifest["adapterData"];
	setContext(worker: WorkerHandle, context: ToolContext): void;
	reconciling?: boolean;
	before?: WorkspaceSnapshot;
	/** The supervisor exhausted its continuation budget on an unfinished protocol. */
	incomplete?: boolean;
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
		let starting = false;
		let configuring = false;
		let promptInFlight = false;
		const modelKey = `model/${createHash("sha256").update(ctx.location.directory).digest("hex")}`;
		const storedModel = await ctx.storage.get(modelKey);
		function readModel(value: unknown): WorkerModelConfig | undefined {
			if (value === undefined || value === null) return undefined;
			if (!value || typeof value !== "object") throw new Error("Invalid saved Fusion model configuration.");
			const model = value as Record<string, unknown>;
			if (typeof model.provider !== "string" || !model.provider.trim() || typeof model.modelId !== "string" || !model.modelId.trim() || (model.variant !== undefined && (typeof model.variant !== "string" || !model.variant.trim()))) throw new Error("Invalid saved Fusion model configuration.");
			return { provider: model.provider, modelId: model.modelId, ...(typeof model.variant === "string" ? { variant: model.variant } : {}) };
		}
		let preferredModel = readModel(storedModel);
		// Persistent mode (default off, persisted per location): when off, gated
		// Fusion tools are visible to a fusion session only while a run is active;
		// /fusion starts runs, so the user keeps explicit control.
		let fusionMode = (await ctx.storage.get("fusion-mode")) === true;
		const setFusionMode = async (enabled: boolean): Promise<void> => {
			await ctx.storage.set("fusion-mode", enabled);
			fusionMode = enabled;
		};
		// One subscription fans every raw bus event out to each runtime's owned-child
		// routing (one async iterable cannot be consumed twice). When the host does
		// not expose the pinned subscribe surface, streaming stays unsupported.
		const busSinks = new Set<(event: { id?: string; type: string; data?: Record<string, unknown> }) => void>();
		const busController = new AbortController();
		const busHost = typeof ctx.event?.subscribe === "function" ? ctx.event : undefined;
		if (busHost) {
			void (async () => {
				const iterator = busHost.subscribe({ signal: busController.signal })[Symbol.asyncIterator]();
				for (;;) {
					const next = await iterator.next();
					if (next.done) break;
					for (const sink of busSinks) {
						try { sink(next.value); } catch {}
					}
				}
			})().catch(() => { /* bus ended or failed: streaming is best-effort; settlement paths do not depend on it */ });
		}
		// Native notification matching depends on this exact description format.
		const services = {
			now: () => Date.now(),
			newRunId: () => randomUUID(),
			newRequestId: (action: "execute" | "revise" | "final_fix" | "resume") => `Fusion ${action} ${randomUUID()}`,
		};
		// Scout enforcement outlives the fusion_scout tool call: the host may
		// background a scout, and its child keeps running after the call returns.
		// Guards are tracked per child session and stay armed until that child's
		// execution is observed to end. The host fires the hook synchronously
		// before every tool execution (pinned in OpenCode v2.2.3: events carry
		// the executing session), so refusing here denies the call before its
		// effects occur — the exact-cap requirement for scouts.
		type ScoutGuardEntry = { cap: ScoutCap; terminate: () => void; release?: () => void };
		const scoutGuards = new Map<string, ScoutGuardEntry>();
		const hasBackgroundScout = () => [...scoutGuards.values()].some((entry) => !!entry.release);
		let activeScout: { entry: ScoutGuardEntry; childSessionID?: string } | undefined;
		let scoutInFlight = false;
		const SCOUT_TERMINAL_EVENTS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);
		function freshScoutCap(): ScoutCap {
			let count = 0;
			let refused = false;
			return {
				consume: () => {
					count += 1;
					const decision = scoutCapDecision(count, MAX_SCOUT_TOOL_CALLS);
					if (decision !== "allow") refused = true;
					return decision;
				},
				get refused() { return refused; },
				get count() { return count; },
			};
		}
		const MAX_TRACKED_SCOUTS = 8;
		function trackScoutGuard(childSessionID: string, entry: ScoutGuardEntry): void {
			if (!scoutGuards.has(childSessionID) && scoutGuards.size >= MAX_TRACKED_SCOUTS) {
				throw new Error("Fusion scout tracking is full; wait for an existing scout to stop.");
			}
			// A live child's cap must survive until its terminal event. Refuse new
			// entries at capacity instead of evicting enforcement for existing work.
			scoutGuards.set(childSessionID, entry);
		}
		// A scout child that is tracked but never backgrounded (or left behind by a
		// previous plugin instance) releases its guard and handle when its
		// execution reaches a terminal state.
		const onScoutBusEvent = (event: { type: string; data?: Record<string, unknown> }): void => {
			const data = event.data && typeof event.data === "object" ? event.data : undefined;
			const sessionID = data && typeof data.sessionID === "string" ? data.sessionID : undefined;
			const entry = sessionID !== undefined ? scoutGuards.get(sessionID) : undefined;
			if (!entry || !SCOUT_TERMINAL_EVENTS.has(event.type)) return;
			scoutGuards.delete(sessionID!);
			entry.release?.();
		};
		busSinks.add(onScoutBusEvent);
		// Supervisor-turn completion channel (pinned live on v2.2.3: every session
		// turn ends in exactly one session.execution.succeeded | interrupted |
		// failed event carrying the session ID and a native event id;
		// session.text.ended carries each text part's final text). A normal end
		// feeds the shared completion policy: when the protocol is unfinished and
		// the nudge budget allows, the controller's continuation text is sent as
		// the next turn via session.prompt, bounded by MAX_SETTLE_NUDGES and
		// persisted before delivery. Interrupted and failed turns never nudge.
		// Completion is bound to Fusion turns (the context hook records the agent
		// whose context was last built) and to observed event ids, so ordinary
		// agents and redeliveries never nudge or settle the run.
		const supervisorText = new Map<string, string>();
		const turnAgent = new Map<string, string>();
		const processedTurnIds = new Map<string, Set<string>>();
		/** Settlement is serialized per run: one terminal settles at a time, in bus order. */
		const settlementChains = new Map<string, Promise<void>>();
		const forgetTurnState = (sessionID: string): void => {
			supervisorText.delete(sessionID);
			turnAgent.delete(sessionID);
			processedTurnIds.delete(sessionID);
		};
		const seenTerminalId = (sessionID: string, id: string | undefined): boolean => {
			if (typeof id !== "string") return true;
			let seen = processedTurnIds.get(sessionID);
			if (!seen) { seen = new Set(); processedTurnIds.set(sessionID, seen); }
			if (seen.has(id)) return false;
			seen.add(id);
			if (seen.size > 64) { const oldest = seen.values().next().value; if (oldest !== undefined) seen.delete(oldest); }
			return true;
		};
		const onTurnBusEvent = (event: { id?: string; type: string; data?: Record<string, unknown> }): void => {
			const data = event.data && typeof event.data === "object" ? event.data : undefined;
			const sessionID = data && typeof data.sessionID === "string" ? data.sessionID : undefined;
			if (!sessionID) return;
			const run = runs.get(sessionID);
			if (!run) return;
			// Completion is bound to turns of the Fusion agent: a session reused
			// with an ordinary agent never nudges or settles the Fusion run.
			if (turnAgent.get(sessionID) !== "fusion") return;
			if (event.type === "session.execution.started") {
				// The final assistant response is what the summary policy evaluates.
				supervisorText.set(sessionID, "");
				return;
			}
			if (event.type === "session.text.ended" && typeof data?.text === "string") {
				supervisorText.set(sessionID, data.text.slice(-20000));
				return;
			}
			const terminal = event.type === "session.execution.succeeded" ? "completed" : event.type === "session.execution.interrupted" ? "aborted" : event.type === "session.execution.failed" ? "error" : undefined;
			if (!terminal) return;
			if (!seenTerminalId(sessionID, event.id)) return;
			const lastPart = supervisorText.get(sessionID) ?? "";
			supervisorText.delete(sessionID);
			const status = run.runtime.status(run.handle);
			// A backgrounded executor, an in-flight reconciliation, or a running
			// scout means the turn is not really settled — for ANY terminal,
			// including interrupts and failures: keep the run active so its
			// control tools (fusion_reconcile among them) stay available, and let
			// the outstanding work steer what happens next.
			const workUnresolved = status.backgroundPending || status.unsettled || run.reconciling || scoutInFlight || hasBackgroundScout();
			// Cancellation is recorded the moment an interrupt or failure
			// arrives — not when its queued settlement runs — so a settlement
			// paused at persistence can never resume into delivering the
			// cancelled nudge. Outstanding work keeps recovery controls active,
			// but never revokes cancellation of a pending continuation.
			if (terminal !== "completed") {
				const pendingNudge = run.adapterData?.fusionNudge as { state?: unknown } | undefined;
				if (pendingNudge?.state === "pending") run.adapterData = { ...run.adapterData, fusionNudge: { ...pendingNudge, state: "cancelled" } };
			}
			// Settlement is serialized per run: terminals queue behind earlier
			// settlements so a late interrupt can never interleave with an
			// in-flight nudge delivery or state write.
			const previous = settlementChains.get(sessionID) ?? Promise.resolve();
			const chained = previous.then(() => settleTurn(sessionID, run, { lastPart, terminal, workUnresolved })).catch(() => { /* settlement failures are reported where they happen */ });
			settlementChains.set(sessionID, chained);
		};
		busSinks.add(onTurnBusEvent);
		/** Settle one completed Fusion turn: nudge, hold, or finish the run. */
		async function settleTurn(sessionID: string, run: Run, turn: { lastPart: string; terminal: "completed" | "aborted" | "error"; workUnresolved: boolean }): Promise<void> {
			// Revalidate after every await: a reset, an interrupt, or an agent
			// switch while settlement is in flight must not deliver a stale nudge
			// or mutate a run this instance no longer owns.
			const stale = (): boolean => runs.get(sessionID) !== run || turnAgent.get(sessionID) !== "fusion";
			// Cancellation and outstanding work are re-read from the run at
			// delivery time — not from locals captured at settlement start —
			// because an interrupt can cancel the nudge and a worker can
			// background while a settlement is paused at persistence.
			const nudgeCancelled = (): boolean => (run.adapterData?.fusionNudge as { state?: unknown } | undefined)?.state === "cancelled";
			const workUnresolvedNow = (): boolean => {
				const status = run.runtime.status(run.handle);
				return status.backgroundPending || status.unsettled || run.reconciling || scoutInFlight || hasBackgroundScout();
			};
			const persistRun = async (): Promise<boolean> => {
				if (!run.lease) return true;
				try {
					await persist(sessionID, run);
					if ((run.adapterData?.fusionSettlement as { state?: unknown } | undefined)?.state === "pending") run.adapterData = { ...run.adapterData, fusionSettlement: { state: "saved" } };
					return true;
				} catch {
					run.adapterData = { ...run.adapterData, fusionSettlement: { state: "pending" } };
					return false;
				}
			};
			const reportIssue = async (text: string): Promise<void> => {
				try {
					await reportCommand(sessionID, "Fusion settlement issue", text);
				} catch { /* hosts without session.synthetic surface the failure through fusion_status instead. */ }
			};
			// Unresolved worker or reconciliation work keeps the run active across
			// every terminal so fusion_reconcile stays available; the outstanding
			// work steers what happens next. Event-time cancellation recorded
			// before this settlement queued still becomes durable here — staleness
			// first so a reset mid-hold is never overwritten, and persistence
			// after so a reload cannot revive a continuation its turn cancelled.
			if (turn.workUnresolved) {
				if (stale()) return;
				if (!(await persistRun())) await reportIssue("Fusion could not write its settlement; it will retry when this session next settles.");
				return;
			}
			// Nudge delivery requires the host's prompt surface; without it, no
			// budget is consumed and an unfinished protocol reports incomplete.
			const deliverPrompt = (input: { sessionID: string; id?: string; text?: string }): Promise<unknown> | undefined =>
				typeof ctx.session.prompt === "function" ? ctx.session.prompt(input) : undefined;
			const canDeliver = typeof ctx.session.prompt === "function";
			const pendingNudge = run.adapterData?.fusionNudge as { id?: unknown; text?: unknown; state?: unknown } | undefined;
			// A settlement write left pending by an earlier terminal is retried
			// before anything else happens this turn.
			if ((run.adapterData?.fusionSettlement as { state?: unknown } | undefined)?.state === "pending") {
				if (!(await persistRun())) await reportIssue("Fusion could not write its settlement; it will retry when this session next settles.");
			}
			if (stale()) return;
			if (turn.terminal !== "completed") {
				// Cancelled or errored turns settle without continuation; an
				// undelivered nudge is dropped with the turn it belonged to.
				if (pendingNudge?.state === "pending") run.adapterData = { ...run.adapterData, fusionNudge: { ...pendingNudge, state: "cancelled" } };
				run.controller.settled(fusionMode);
				if (!(await persistRun())) await reportIssue("Fusion could not write its settlement; it will retry when this session next settles.");
				return;
			}
			// A nudge whose delivery failed is retried at the next completed turn
			// end before a new nudge is considered; the budget was already
			// consumed, and the intent is re-persisted before the retry sends.
			if (canDeliver && pendingNudge?.state === "pending" && typeof pendingNudge.id === "string" && typeof pendingNudge.text === "string") {
				if (!(await persistRun())) {
					await reportIssue("Fusion could not write its continuation intent; the nudge will retry when this session next settles.");
					return;
				}
				// The pause at persistence is exactly where an interrupt lands:
				// a cancellation it recorded there, or work that became
				// unresolved during the pause, aborts this delivery.
				if (stale() || nudgeCancelled() || workUnresolvedNow()) return;
				try {
					await deliverPrompt({ sessionID, id: pendingNudge.id, text: pendingNudge.text });
					run.adapterData = { ...run.adapterData, fusionNudge: { id: pendingNudge.id, text: pendingNudge.text, state: "delivered" } };
					await persistRun();
				} catch {
					await reportIssue("Fusion could not deliver its continuation nudge; it will retry when this session next settles. If it keeps failing, deliver the instruction to the fusion agent directly.");
				}
				return;
			}
			// Nudges are only consumed when they can actually be delivered.
			const nudge = canDeliver ? run.controller.continuation({ lastAssistantText: turn.lastPart, outcome: "completed", canContinue: !turn.workUnresolved }) : undefined;
			if (nudge) {
				const id = `msg_fusion_nudge_${randomUUID().replaceAll("-", "")}`;
				// Retain the retryable delivery state and persist the nudge budget
				// before sending, so a reload can neither resend nor forget it.
				run.adapterData = { ...run.adapterData, fusionNudge: { id, text: nudge, state: "pending" } };
				if (!(await persistRun())) {
					await reportIssue("Fusion could not write its continuation intent; the nudge will retry when this session next settles.");
					return;
				}
				// Same pause, same exposure: an interrupt recorded during the
				// persistence await cancels this nudge before it is sent.
				if (stale() || nudgeCancelled() || workUnresolvedNow()) return;
				try {
					await deliverPrompt({ sessionID, id, text: nudge });
					run.adapterData = { ...run.adapterData, fusionNudge: { id, text: nudge, state: "delivered" } };
					await persistRun();
				} catch {
					await reportIssue("Fusion could not deliver its continuation nudge; it will retry when this session next settles. If it keeps failing, deliver the instruction to the fusion agent directly.");
				}
				return;
			}
			if (stale()) return;
			const protocolComplete = run.controller.state.executed && turn.lastPart.includes(FUSION_SUMMARY_HEADING);
			if (!protocolComplete) {
				// The nudge budget ran out (or delivery is unsupported) on an
				// unfinished protocol: report the run incomplete instead of marking
				// it complete, and keep the state across reloads.
				run.incomplete = true;
				run.adapterData = { ...run.adapterData, fusionIncomplete: true };
				if (!(await persistRun())) await reportIssue("Fusion could not write its settlement; it will retry when this session next settles.");
				return;
			}
			run.incomplete = false;
			run.adapterData = { ...run.adapterData, fusionIncomplete: false };
			run.controller.settled(fusionMode);
			// Final settlement survives reload: the manifest carries the deactivated
			// run and its completion phase.
			if (!(await persistRun())) await reportIssue("Fusion could not write its settlement; it will retry when this session next settles.");
		}
		busSinks.add(onTurnBusEvent);
		function resolveScoutGuard(event: ToolHookEvent): ScoutGuardEntry | undefined {
			if (typeof event.sessionID === "string" && event.sessionID) {
				const tracked = scoutGuards.get(event.sessionID);
				if (tracked) return tracked;
				if (activeScout) {
					activeScout.childSessionID ??= event.sessionID;
					if (activeScout.childSessionID === event.sessionID) return activeScout.entry;
				}
				// A fusion-scout child this instance never armed must not run
				// unguarded either: give it a fresh cap and track it.
				// Reserve a slot for the active scout until its child is published.
				if (activeScout && !scoutGuards.has(activeScout.childSessionID ?? "") && scoutGuards.size >= MAX_TRACKED_SCOUTS - 1) {
					throw new Error("Fusion scout tracking is full; wait for an existing scout to stop.");
				}
				const fresh: ScoutGuardEntry = { cap: freshScoutCap(), terminate: () => {} };
				trackScoutGuard(event.sessionID, fresh);
				return fresh;
			}
			return activeScout?.entry;
		}
		await ctx.tool.hook("execute.before", (event) => {
			if (event.agent === "fusion" && event.tool === "subagent") throw new Error("Use fusion_delegate to start Fusion executor work.");
			if (event.agent !== SCOUT_AGENT) return;
			const guard = resolveScoutGuard(event);
			if (!guard) return;
			if (!SCOUT_TOOLS.has(event.tool)) throw new Error(`Fusion scout may only use read, grep, and glob; "${event.tool}" is denied before execution.`);
			const decision = guard.cap.consume();
			if (decision === "allow") return;
			if (decision === "terminate") guard.terminate();
			throw new Error("Tool call limit reached. Answer now with what you have.");
		});
		await ctx.session.hook("context", (event) => {
			// Bind the session's latest turn to its agent: completion events are
			// only handled for turns the Fusion agent drove.
			if (typeof event.sessionID === "string" && event.sessionID) {
				turnAgent.set(event.sessionID, event.agent);
				if (turnAgent.size > 32) { const oldest = turnAgent.keys().next().value; if (oldest !== undefined) turnAgent.delete(oldest); }
			}
			if (event.agent === "fusion") delete event.tools.subagent;
			// Defense in depth: hide every non-allowlisted tool from the scout agent
			// when the host exposes child sessions here. The execute.before guard
			// above stays the enforced boundary either way.
			if (event.agent === SCOUT_AGENT) for (const name of Object.keys(event.tools)) if (!SCOUT_TOOLS.has(name)) delete event.tools[name];
			// Persistent-mode gating (mode off is the default): mutation tools are
			// visible to the fusion agent only while its session runs a run. The
			// event fires per turn, so toggling applies from the next turn. The
			// host refuses calls to tools absent from this record, so hiding here
			// is enforced availability, not guidance.
			if (event.agent === "fusion" && !fusionMode) {
				const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined;
				if (!runs.get(sessionID ?? "")?.controller.state.runActive) for (const name of FUSION_GATED_TOOLS) delete event.tools[name];
			}
		});
		const storageKey = `run/${createHash("sha256").update(ctx.location.directory).digest("hex")}`;
		async function makeRun(sessionID: string, record?: RunManifest): Promise<Run> {
			const toolContexts = new WeakMap<WorkerHandle, ToolContext>();
			const workerOwner = { harness: "opencode", supervisorId: sessionID, workspace };
			const runtime = createOpenCodeWorkerRuntime<ToolContext>({
				execute: native!.execute,
				contextFor: (request) => { const toolContext = toolContexts.get(request.worker); if (!toolContext) throw new Error("OpenCode tool context is unavailable."); return toolContext; },
				interrupt: typeof ctx.session.interrupt === "function" ? ((childSessionID: string) => Promise.resolve(ctx.session.interrupt!({ sessionID: childSessionID }))) : undefined,
				bus: busHost ? { add: (sink) => { busSinks.add(sink); return () => { busSinks.delete(sink); }; } } : undefined,
				validateReference: async (reference) => {
					const [parent, child] = await Promise.all([ctx.session.get({ sessionID }), ctx.session.get({ sessionID: reference.id })]);
					if (parent.id !== sessionID || !parent.location?.directory || await canonicalize(parent.location.directory) !== workspace || child.id !== reference.id || child.parentID !== sessionID || !child.location?.directory || await canonicalize(child.location.directory) !== workspace) throw new Error("OpenCode child ownership or workspace does not match.");
				},
			});
			const state = record ? { ...record.state, delegating: false } : { runActive: false, phase: "idle" as const, settleNudges: 0, delegating: false, executed: false, revisions: 0, finalFixUsed: false, resumePending: false, scoutCalls: 0 };
			const controller = new FusionController(state, services, runtime);
			const runId = record?.runId ?? randomUUID();
			const reference = record?.worker;
			// A configured model reaches the executor handle at creation; the scout
			// role reads it per call from the run record.
			const model = record ? record.model : preferredModel;
			const config: WorkerConfig = { role: "executor", ...(model ? { model } : {}) };
			const handle = record?.pending ? await runtime.restorePending(workerOwner, config, { runId, requestId: record.pending.requestId }, reference) : reference ? await runtime.open(reference, config) : await runtime.create(workerOwner, config);
			if (record?.pending) controller.setPending({ action: record.pending.action, requestId: record.pending.requestId });
			controller.setUncertain(!!record && record.recovery !== "settled");
			return { controller, handle, runtime, runId, lastResult: record?.lastResult, model, adapterData: record?.adapterData, incomplete: (record?.adapterData as { fusionIncomplete?: unknown } | undefined)?.fusionIncomplete === true, setContext(worker, context) { toolContexts.set(worker, context); } };
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
		function hasUnconfirmedPrompt(run: Run): boolean {
			const prompt = run.adapterData?.fusionPrompt;
			return !!prompt && typeof prompt === "object" && (prompt as { state?: unknown }).state === "pending";
		}
		/** Aggregate one observed worker turn into the run's persisted usage
		 * record. A turn whose result carried no usage reading counts as missing,
		 * so the totals honestly under-report instead of guessing. */
		function recordUsage(run: Run, result: WorkerTurnResult): void {
			const current = run.adapterData?.fusionUsage as Record<string, number> | undefined;
			const next: Record<string, number> = { ...(current ?? {}) };
			next.turnsReported = (next.turnsReported ?? 0) + (result.usage ? 1 : 0);
			next.turnsMissing = (next.turnsMissing ?? 0) + (result.usage ? 0 : 1);
			if (result.usage) for (const [field, value] of Object.entries(result.usage)) if (typeof value === "number" && Number.isFinite(value)) next[field] = (next[field] ?? 0) + value;
			run.adapterData = { ...run.adapterData, fusionUsage: next };
		}
		// The native executor is called directly below; model-originated calls pass
		// through OpenCode's tool hook and must not bypass Fusion's run guards.
		// Both guards (subagent denial and scout cap) live in the single
		// execute.before hook registered above.
		function requireSupervisor(context: ToolContext): void {
			if (context.agent !== "fusion") throw new Error("Fusion tools are available only to the fusion primary agent.");
		}
		/** The flat model catalog; unavailable catalogs leave Fusion on host-default models. */
		async function hostModels(): Promise<readonly (HostModel & { id: string; providerID: string })[]> {
			if (typeof ctx.model?.list !== "function") throw new Error("The OpenCode model catalog is unavailable in this host; configure models through OpenCode itself instead.");
			const response = await ctx.model.list();
			const models = Array.isArray(response?.data) ? response.data : [];
			return models.filter((entry): entry is HostModel & { id: string; providerID: string } => typeof entry?.id === "string" && typeof entry?.providerID === "string");
		}
		/** Validate an explicit provider/model/variant choice against the active catalog. */
		async function validateCatalogModel(provider: string, modelId: string, variant?: string): Promise<{ config: WorkerModelConfig; metadata: Record<string, unknown> }> {
			const models = await hostModels();
			const entry = models.find((candidate) => candidate.providerID === provider && (candidate.id === modelId || candidate.modelID === modelId));
			if (!entry) {
				const known = [...new Set(models.map((candidate) => candidate.providerID))].sort().slice(0, 12).join(", ");
				throw new Error(`"${provider}/${modelId}" is not in the OpenCode model catalog${known ? ` (known providers: ${known})` : ""}. Check opencode models and try again.`);
			}
			if (entry.enabled === false) throw new Error(`"${provider}/${modelId}" is disabled in the OpenCode catalog.`);
			if (variant !== undefined) {
				const variants = (entry.variants ?? []).map((candidate) => typeof candidate?.id === "string" ? candidate.id : "").filter(Boolean);
				if (!variants.includes(variant)) throw new Error(`"${provider}/${modelId}" has no variant "${variant}"${variants.length ? ` (available: ${variants.join(", ")})` : " (no variants)"}.`);
			}
			const fusionModel = { id: entry.id, provider: entry.providerID, name: entry.name ?? "", cost: { output: entry.cost?.[0]?.output } };
			const tier: FusionModelTier = isModelInTier(fusionModel, "supervisor") ? "supervisor" : "executor";
			return {
				config: { provider, modelId, ...(variant !== undefined ? { variant } : {}) },
				metadata: {
					name: entry.name,
					status: entry.status,
					outputPricePerM: getOutputPrice(fusionModel),
					tier,
					recentCohort: RECENT_MODEL_COHORT,
					inRecentCohort: isRecentModel(fusionModel),
				},
			};
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
		/** Shared run-start control behind fusion_start and the /fusion command. */
		async function startRun(sessionID: string, task: string): Promise<Run> {
			if (resetting || starting || configuring) throw new Error("A Fusion run transition is in progress.");
			if (owner && owner !== sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
			if (scoutInFlight || hasBackgroundScout()) throw new Error("A Fusion scout is still running; wait for it to stop before starting a run.");
			const run = await runFor(sessionID);
			if (resetting || starting || configuring) throw new Error("A Fusion run transition is in progress.");
			if (run.controller.state.runActive || run.controller.state.executed || run.controller.pending || run.controller.uncertain || run.reconciling) throw new Error("Finish and reset the existing Fusion run before starting another.");
			starting = true;
			const priorState = structuredClone(run.controller.state);
			try {
				const parent = await ctx.session.get({ sessionID });
				if (parent.id !== sessionID || !parent.location?.directory || await canonicalize(parent.location.directory) !== workspace) throw new Error("OpenCode supervisor session or workspace does not match.");
				// Scouting that preceded the run start is part of the same run.
				run.controller.start(task, { preserveScoutCalls: true });
				if (!run.lease) run.lease = await registry.claim(manifest(run));
				owner = sessionID;
				await persist(sessionID, run);
				return run;
			} catch (error) {
				// A successful claim is authoritative even if the secondary store fails.
				// Keep that run available for reset rather than releasing ownership silently.
				if (!run.lease) Object.assign(run.controller.state, priorState);
				throw error;
			} finally { starting = false; }
		}
		/** Release settled Fusion resources for a session, or a settled workspace record left by another one. */
		async function cleanWorkspace(sessionID: string): Promise<string> {
			if (resetting || starting || configuring || promptInFlight) throw new Error("A Fusion run transition is in progress.");
			const run = runs.get(sessionID);
			if (run) {
				if (hasUnconfirmedPrompt(run)) throw new Error("Fusion prompt delivery is unconfirmed. Retry /fusion-run with the same task before cleaning.");
				if (run.controller.state.runActive) throw new Error("The Fusion run is still active; finish and reset it before cleaning.");
				const error = run.controller.resetError(false, run.reconciling);
				if (error) throw new Error(`${error} Clean releases settled resources only.`);
				if (scoutInFlight || hasBackgroundScout()) throw new Error("A Fusion scout is still running; wait for it to stop before cleaning.");
				resetting = true;
				try {
					await store.removeSettled(run.runId);
					await run.lease?.release();
					await run.runtime.release(run.handle);
					await run.runtime.shutdown();
					runs.delete(sessionID);
					forgetTurnState(sessionID);
					if (owner === sessionID) owner = undefined;
					return "Released Fusion resources for this session.";
				} finally { resetting = false; }
			}
			resetting = true;
			try {
				const owned = await registry.inspect(workspace);
				if (!owned) return "No Fusion resources to clean in this workspace.";
				if (owned.manifest.recovery !== "settled") throw new Error(`The workspace Fusion record is ${owned.manifest.recovery}; reconcile it or run the explicit operator resolution before cleaning.`);
				if (owned.manifest.state.runActive || scoutInFlight || hasBackgroundScout()) throw new Error("A Fusion run or scout is still active; clean it from its owning session after it finishes.");
				// An adopted run's held lease is the same record: release through it
				// rather than claiming the workspace a second time in this process.
				const holder = [...runs.values()].find((candidate) => candidate.lease && candidate.lease.manifest.runId === owned.manifest.runId);
				if (holder?.lease) {
					const error = holder.controller.resetError(false, holder.reconciling);
					if (error || holder.controller.state.runActive) throw new Error("The owning Fusion run is still active; clean it from its owning session after it finishes.");
					await store.removeSettled(holder.runId);
					await holder.lease.release();
					holder.lease = undefined;
					await holder.runtime.release(holder.handle);
					await holder.runtime.shutdown();
					runs.delete(holder.handle.owner.supervisorId);
					forgetTurnState(holder.handle.owner.supervisorId);
					if (owner === holder.handle.owner.supervisorId) owner = undefined;
					return "Released settled Fusion ownership for this workspace.";
				}
				// Claim-then-release archives the settled record without touching any transcript.
				const lease = await registry.claim(owned.manifest, owned.token);
				await lease.release();
				return "Released settled Fusion ownership for this workspace.";
			} finally { resetting = false; }
		}
		async function statusContent(sessionID: string): Promise<string> {
			const run = runs.get(sessionID);
			if (!run) {
				const owned = await registry.inspect(workspace);
				if (!owned) return "No Fusion run in this session.";
				return JSON.stringify({ message: "Another Fusion run owns this workspace.", runId: owned.manifest.runId, owner: owned.manifest.owner, recovery: owned.manifest.recovery, pending: owned.manifest.pending, nextAction: "Reconcile in the owning harness or explicitly resolve ownership after inspecting the worker and workspace." });
			}
			const status = run.runtime.status(run.handle);
			const promptDelivery = run.adapterData?.fusionPrompt as { state?: unknown } | undefined;
			const nudgeDelivery = (run.adapterData?.fusionNudge as { state?: unknown } | undefined)?.state;
			const settlementWrite = (run.adapterData?.fusionSettlement as { state?: unknown } | undefined)?.state;
			const nextAction = run.incomplete
				? "The Fusion run is incomplete: the supervisor stopped before finishing. Take over the task yourself, or call fusion_reset to finish the run."
				: settlementWrite === "pending"
					? "The last Fusion settlement could not be written; it retries when this session next settles."
				: run.controller.uncertain
				? status.backgroundPending || status.unsettled
					? "Call fusion_reconcile; if exact completion proof is unavailable, inspect the worker and workspace and explicitly resolve ownership after confirming the worker stopped."
					: "Inspect the worker and workspace; explicitly resolve ownership after confirming the worker stopped."
					: promptDelivery?.state === "pending"
						? "Prompt delivery is unconfirmed. Retry /fusion-run with the same task and message ID, or inspect the session before cleaning."
					: nudgeDelivery === "pending"
						? "The last continuation nudge could not be delivered; it retries when this session next settles, or deliver the instruction to the fusion agent directly."
					: !run.controller.state.executed
					? "Investigate the original task, then call fusion_delegate with action execute."
					: "Review the working tree and audit the original task; reset when the run is finished.";
			return JSON.stringify({ ...run.controller.state, runId: run.runId, owner: run.handle.owner, workspaceClaimed: !!run.lease, model: run.model, pending: run.controller.pending, promptDelivery: promptDelivery?.state, nudgeDelivery, settlementWrite, incomplete: !!run.incomplete, childSessionID: run.handle.reference?.id, capabilities: run.runtime.capabilities, uncertain: run.controller.uncertain, backgroundPending: status.backgroundPending, reconciling: !!run.reconciling, nextAction });
		}
		/** Resume presentation: recovery surface for the owned or adopted run.
		 * Routed to fusion_reconcile only when exact completion proof can exist;
		 * operator resolution is documented textually, never implied. */
		async function resumeContent(sessionID: string): Promise<string> {
			const run = runs.get(sessionID);
			if (!run) {
				const owned = await registry.inspect(workspace);
				if (!owned) return "No Fusion run in this session.";
				return JSON.stringify({
					message: "The workspace Fusion record is not attached to this session; recovery happens in its owning session or through explicit operator resolution.",
					runId: owned.manifest.runId, owner: owned.manifest.owner, recovery: owned.manifest.recovery, pending: owned.manifest.pending,
					activeTurnReattach: "refused",
					reattachReason: "Fusion never reattaches another session's executor turn into this session.",
					nextAction: `Call fusion_resume in the owning session (${owned.manifest.owner.supervisorId}), or after inspecting the worker and workspace run: bun src/workspace/resolve.ts ${workspace} ${owned.manifest.runId} ${owned.manifest.pending?.requestId ?? "--no-request-id"} --confirm-stopped`,
				});
			}
			const status = run.runtime.status(run.handle);
			const outstanding = { backgroundPending: status.backgroundPending, recordedResult: !!status.unsettled, reconciling: !!run.reconciling, delegating: !!run.controller.state.delegating, scoutInFlight, backgroundScout: hasBackgroundScout() };
			const pendingRequest = run.controller.pending;
			// The capability mirrors the fusion_reconcile guard; the detail names
			// which proof reconcile would adopt, or why none can exist.
			const resolveCommand = run.runId ? `bun src/workspace/resolve.ts ${workspace} ${run.runId} ${pendingRequest?.requestId ?? "--no-request-id"} --confirm-stopped` : "bun src/workspace/resolve.ts --confirm-stopped";
			let reconcile: { capability: "available" | "busy" | "unavailable"; detail: string };
			if (outstanding.delegating || outstanding.reconciling) reconcile = { capability: "busy", detail: "another executor transition is in progress" };
			else if (run.controller.uncertain && pendingRequest && (outstanding.backgroundPending || outstanding.recordedResult)) reconcile = { capability: "available", detail: outstanding.recordedResult ? "the executor's recorded result can be settled into the run" : "the executor's completion notification is awaited, or may already be recorded in this session" };
			else if (run.controller.uncertain && pendingRequest) reconcile = { capability: "unavailable", detail: "the retained executor request has no live turn and no recorded result; automatic retry stays disabled while the outcome is unknown" };
			else reconcile = { capability: "unavailable", detail: run.controller.uncertain ? "the outcome is unknown with no retained request" : "nothing is unsettled; the run owes no recovery" };
			const nextAction = reconcile.capability === "available"
				? "Call fusion_reconcile to adopt the executor's exact completion. If it reports no matching notification, inspect the worker and workspace, and after confirming the worker stopped run: " + resolveCommand
				: reconcile.capability === "busy"
					? "Wait for the in-flight executor transition to finish, then call fusion_resume again."
					: run.incomplete
						? "The Fusion run is incomplete: the supervisor stopped before finishing. Take over the task yourself, or call fusion_reset to finish the run."
						: run.controller.uncertain
							? "No exact completion proof can be adopted. Inspect the worker session and the working tree, and after confirming the worker stopped run: " + resolveCommand
							: "No recovery is owed; the run is active in this session. Continue the protocol and call fusion_reset when it finishes.";
			return JSON.stringify({ ...run.controller.state, runId: run.runId, owner: run.handle.owner, model: run.model, childSessionID: run.handle.reference?.id, pendingRequest, outstanding, uncertain: run.controller.uncertain, reconcile: reconcile.capability, reconcileDetail: reconcile.detail, activeTurnReattach: "refused", reattachReason: "OpenCode cannot reattach a live or interrupted executor turn back into this session; recovery routes through the completion notification (fusion_reconcile) or explicit operator resolution.", incomplete: !!run.incomplete, nextAction });
		}
		function statsContent(sessionID: string): string {
			const run = runs.get(sessionID);
			if (!run) return "No Fusion run in this session.";
			const usage = run.adapterData?.fusionUsage as Record<string, number> | undefined;
			const reported = usage?.turnsReported ?? 0;
			const missing = usage?.turnsMissing ?? 0;
			return JSON.stringify({ runId: run.runId, executed: run.controller.state.executed,
				revisions: { used: run.controller.state.revisions, limit: MAX_REVISIONS },
				scoutCalls: { used: run.controller.state.scoutCalls, limit: MAX_SCOUT_CALLS },
				finalFixUsed: run.controller.state.finalFixUsed,
				lastResult: run.lastResult ? { requestId: run.lastResult.requestId, status: run.lastResult.status } : undefined,
				usage: {
					available: reported > 0,
					reason: reported > 0 ? undefined : run.controller.state.executed || run.controller.state.scoutCalls > 0 ? "No Fusion worker turn has reported usage on this host yet." : "No Fusion worker turn has run yet.",
					complete: missing === 0,
					turns: { reported, missing },
					inputTokens: usage?.inputTokens,
					outputTokens: usage?.outputTokens,
					cacheReadTokens: usage?.cacheReadTokens,
					cacheWriteTokens: usage?.cacheWriteTokens,
					reasoningTokens: usage?.reasoningTokens,
					cost: usage?.cost,
				} });
		}

		await ctx.tool.transform((editor) => {
			editor.add({
				name: "fusion_start",
				description: "Start a Fusion run with the user's original request before scouting or delegation. Finish and reset the previous run first.",
				input: { type: "object", properties: { task: { type: "string", minLength: 1 } }, required: ["task"], additionalProperties: false },
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					if (!input || typeof input !== "object" || typeof (input as Record<string, unknown>).task !== "string" || !(input as { task: string }).task.trim()) throw new Error("Fusion requires a non-empty original task.");
					const run = await startRun(context.sessionID, (input as { task: string }).task.trim());
					return { content: "Fusion run started. Investigate the original request, then use fusion_scout and fusion_delegate as needed.", metadata: { runId: run.runId } };
				},
			});
			editor.add({
				name: "fusion_configure",
				description: "Configure the Fusion executor model (used by the executor and the scout) by validating provider, model, and an optional variant against the OpenCode catalog. Applies to this run when no executor work has started; otherwise to the next run.",
				input: { type: "object", properties: { provider: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, variant: { type: "string", minLength: 1 } }, required: ["provider", "model"], additionalProperties: false },
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					if (!input || typeof input !== "object") throw new Error("Invalid Fusion configuration input.");
					const value = input as Record<string, unknown>;
					if (typeof value.provider !== "string" || !value.provider.trim() || typeof value.model !== "string" || !value.model.trim() || (value.variant !== undefined && (typeof value.variant !== "string" || !value.variant.trim()))) throw new Error("Invalid Fusion configuration input.");
					const { config, metadata } = await validateCatalogModel(value.provider.trim(), value.model.trim(), typeof value.variant === "string" ? value.variant.trim() : undefined);
					if (resetting || starting || configuring) throw new Error("A Fusion run transition is in progress.");
					configuring = true;
					try {
						const run = await runFor(context.sessionID);
						const active = run.runtime.status(run.handle);
						const workStarted = run.controller.state.executed || !!run.controller.pending || run.controller.uncertain || run.reconciling || active.backgrounded || active.backgroundPending || active.unsettled;
						// Recreate the executor handle only while it cannot have produced
						// work: no submission yet and no native child to orphan.
						let applied: "now" | "next-run";
						let appliedReason = "";
						if (!workStarted && !run.handle.reference) {
							const replacement = await run.runtime.create({ harness: "opencode", supervisorId: context.sessionID, workspace }, { role: "executor", model: config });
							try { await ctx.storage.set(modelKey, config); } catch (error) { await run.runtime.release(replacement); throw error; }
							await run.runtime.release(run.handle);
							run.handle = replacement;
							run.model = config;
							applied = "now";
						} else {
							await ctx.storage.set(modelKey, config);
							applied = "next-run";
							appliedReason = workStarted ? "executor work has already started" : "the executor child already exists";
						}
						preferredModel = config;
						if (run.lease) await persist(context.sessionID, run);
						return {
							content: `Fusion executor model configured for ${applied === "now" ? "this run" : `the next run (${appliedReason})`}: ${config.provider}/${config.modelId}${config.variant ? ` (variant ${config.variant})` : ""}. The scout uses its run's executor model. ${JSON.stringify(metadata)}`,
							metadata: { model: config, applied, ...metadata },
						};
					} finally { configuring = false; }
				},
			});
			editor.add({
				name: "fusion_delegate",
				description: "Delegate a decided implementation brief to the Fusion executor. Use execute once, then up to three revise calls and one final_fix after the acceptance audit. Review the actual working tree after each call.",
				input: { type: "object", properties: { action: { type: "string", enum: ["execute", "revise", "final_fix"] }, brief: { type: "string", minLength: 1 }, originalTask: { type: "string" } }, required: ["action", "brief"], additionalProperties: false },
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					if (!input || typeof input !== "object") throw new Error("Invalid Fusion delegation input.");
					const value = input as Record<string, unknown>;
					if ((value.action !== "execute" && value.action !== "revise" && value.action !== "final_fix") || typeof value.brief !== "string" || !value.brief.trim() || (value.originalTask !== undefined && typeof value.originalTask !== "string")) throw new Error("Invalid Fusion delegation input.");
					const action = value.action;
					const run = await runFor(context.sessionID);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					if (run.reconciling) throw new Error("Fusion reconciliation is already in progress.");
					if (run.controller.uncertain) throw new Error("The executor's last turn has an unknown outcome. Review the child session and working tree before recovery; automatic retry is disabled.");
					if (owner && owner !== context.sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
					if (action === "execute" && run.controller.state.originalTask && typeof value.originalTask === "string" && value.originalTask !== run.controller.state.originalTask) throw new Error("The original task was already recorded by fusion_start and cannot be replaced.");
					const error = run.controller.beginDelegation(action, OPENCODE_CAPABILITIES, value.brief);
					if (error) throw new Error(error);
					run.setContext(run.handle, context);
					if (action === "execute") {
						run.controller.startExecution(run.controller.state.originalTask ?? (typeof value.originalTask === "string" && value.originalTask.trim() ? value.originalTask : value.brief), value.brief);
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
								recordUsage(run, result);
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
				name: "fusion_scout",
				description:
					`Ask the Fusion scout read-only questions about this repository. Runs as an isolated disposable ${SCOUT_AGENT} subagent with read-only tools (read, grep, glob). Pass 1-5 questions; each call answers all of them with path:line citations. At most ${MAX_SCOUT_CALLS} calls per run.`,
				input: { type: "object", properties: { questions: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 5 } }, required: ["questions"], additionalProperties: false },
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					if (!input || typeof input !== "object") throw new Error("Invalid Fusion scout input.");
					const value = input as Record<string, unknown>;
					if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 5 || !value.questions.every((question) => typeof question === "string" && !!question.trim())) throw new Error("Invalid Fusion scout input.");
					const questions = value.questions as string[];
					// Scouting precedes the first delegation, so it lazily creates this
					// session's run. A scout-only run claims no workspace and makes no
					// native call until a real delegation submits; the invocation budget
					// is still the shared per-run controller budget.
					const run = await runFor(context.sessionID);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					// Set synchronously so concurrent tool calls cannot double-submit.
					if (scoutInFlight) throw new Error("A Fusion scout is already running; wait for it to answer before asking again.");
					if (scoutGuards.size >= MAX_TRACKED_SCOUTS) throw new Error("Fusion scout tracking is full; wait for an existing scout to stop.");
					scoutInFlight = true;
					let handle: WorkerHandle | undefined;
					let cap: ScoutCap | undefined;
					const onAbort = () => activeScout?.entry.terminate();
					let response: { content: string; metadata?: Record<string, unknown> };
					try {
						const budgetError = run.controller.beginScout();
						if (budgetError) return { content: budgetError };
						// The invocation counter is advisory budget state; a failed advisory
						// write must not block a read-only scout. Settlement writes keep
						// their strict fault guarantees.
						if (run.lease) { try { await persist(context.sessionID, run); } catch {} }
						handle = await run.runtime.create(run.handle.owner, { role: "scout", maxToolCalls: MAX_SCOUT_TOOL_CALLS, ...(run.model ? { model: run.model } : {}) });
						run.setContext(handle, context);
						cap = run.runtime.scoutCap(handle, MAX_SCOUT_TOOL_CALLS);
						activeScout = {
							entry: { cap, terminate: () => { void run.runtime.abort(handle!).catch(() => {}); } },
						};
						context.signal.addEventListener("abort", onAbort, { once: true });
						const requestId = `Fusion scout ${randomUUID()}`;
						// The scout runs on the configured executor model (Pi parity).
						const request: WorkerTurnRequest = { runId: run.runId, requestId, worker: handle, prompt: buildScoutPrompt(questions) };
						const result = await run.runtime.submit(request, { signal: context.signal, onEvent: () => {}, onReference: async (reference) => {
							if (!activeScout) throw new Error("Fusion scout guard is unavailable.");
							activeScout.childSessionID = reference.id;
							trackScoutGuard(reference.id, activeScout.entry);
						} });
						recordUsage(run, result);
						// The accumulated totals are advisory: they ride the next strict
						// settlement write, with a best-effort persist here so a claimed
						// run keeps them across reloads without ever blocking the answer.
						if (run.lease) { try { await persist(context.sessionID, run); } catch {} }
						const capped = result.role === "scout" ? (cap.refused || result.capped) : false;
						const { text } = formatScoutResponse({ status: result.status, text: result.text, errorMessage: result.errorMessage, capped, usage: result.usage });
						response = { content: text, metadata: { childSessionID: handle.reference?.id, status: result.status, capped, questions: questions.length } };
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						response = { content: `Fusion scout failed: ${message}`, metadata: { error: message } };
					} finally {
						context.signal.removeEventListener("abort", onAbort);
						activeScout = undefined;
						scoutInFlight = false;
					}
					// Disposition. A backgrounded scout keeps running after this call
					// returns, so its guard stays armed — and its handle stays released-
					// pending so terminate can still interrupt the child — until the
					// child's execution is observed to end. Otherwise dispose now,
					// without deleting the transcript; a release refusal is surfaced
					// without discarding the answer.
					let releaseNote: string | undefined;
					const childID = handle?.reference?.id;
					if (handle && cap && childID && run.runtime.status(handle).backgroundPending) {
						trackScoutGuard(childID, {
							cap,
							terminate: () => { void run.runtime.abort(handle!).catch(() => {}); },
							release: () => { void run.runtime.release(handle!).catch(() => {}); },
						});
					} else if (handle) {
						if (childID) scoutGuards.delete(childID);
						try { await run.runtime.release(handle); } catch (error) { releaseNote = error instanceof Error ? error.message : String(error); }
					}
					return releaseNote ? { ...response, content: `${response.content}\n\n(Fusion scout could not be released: ${releaseNote})` } : response;
				},
			});
			editor.add({
				name: "fusion_reconcile", description: "Reconcile a backgrounded Fusion executor after OpenCode delivers its completion notification.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					if (resetting || starting || configuring) throw new Error("A Fusion run transition is in progress.");
					const run = runs.get(context.sessionID);
					if (!run?.controller.uncertain || !run.controller.pending || !run.runtime.status(run.handle).backgroundPending && !run.runtime.status(run.handle).unsettled) throw new Error("No backgrounded Fusion turn is available for reconciliation.");
					if (run.controller.state.delegating || run.reconciling) throw new Error("Fusion reconciliation is already in progress.");
					const pending = run.controller.pending;
					run.reconciling = true;
					try {
						run.setContext(run.handle, context);
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
						const unsettled = run.runtime.status(run.handle).unsettled;
						// A recorded result's usage was already counted when its turn
						// completed (the delegate's collect port); only a result adopted
						// from the completion notification is new to the totals — and it
						// carries no usage reading, so it counts as a missing turn.
						const result = unsettled
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
						if (!unsettled) recordUsage(run, result);
						run.controller.setUncertain(false);
						const terminalState = result.status;
						const parsed = run.controller.executorReport(result.text);
						const stat = await workspaceDiffStat(run.before, nodeGitExec);
						run.before = undefined;
						if (terminalState !== "completed") return { content: `Fusion executor ${terminalState}: ${result.text}\nReview the full working tree before deciding whether to revise.`, metadata: { childSessionID: run.handle.reference?.id, action: pending.action, status: terminalState } };
						return { content: formatCompactReport(parsed.report, stat, parsed.prose, ["reconciled background turn; review the full working tree"]), metadata: { childSessionID: run.handle.reference?.id, action: pending.action, status: terminalState } };
					} finally { run.reconciling = false; }
				},
			});
			editor.add({
				name: "fusion_resume", description: "Show this Fusion run's recovery state: owner, pending request, reconciliation capability, and the next valid action. Refuses outright anything it cannot honestly promise, including mid-turn reattachment.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					return { content: await resumeContent(context.sessionID) };
				},
			});
			editor.add({
				name: "fusion_status", description: "Show the current Fusion run state.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					return { content: await statusContent(context.sessionID) };
				},
			});
			editor.add({
				name: "fusion_stats", description: "Show the current Fusion run's review and scout budgets and its observed worker token and cost totals.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					return { content: statsContent(context.sessionID) };
				},
			});
			editor.add({
				name: "fusion_reset", description: "Finish a settled Fusion run and release its workspace for another session.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					if (promptInFlight) throw new Error("Fusion prompt delivery is in progress.");
					// Refuse before any mutation: dismantling storage, ownership, or the
					// executor underneath an in-flight scout leaves the run partially
					// reset and unrecoverable by retry.
					if (scoutInFlight || hasBackgroundScout()) throw new Error("A Fusion scout is still running; wait for it to stop before resetting.");
					const run = runs.get(context.sessionID);
					if (!run) return { content: "No Fusion run in this session." };
					if (hasUnconfirmedPrompt(run)) throw new Error("Fusion prompt delivery is unconfirmed. Retry /fusion-run with the same task before resetting.");
					const error = run.controller.resetError(false, run.reconciling);
					if (error) throw new Error(error);
					resetting = true;
					try {
						await store.removeSettled(run.runId);
						await run.lease?.release();
						await run.runtime.release(run.handle);
						await run.runtime.shutdown();
						runs.delete(context.sessionID);
						forgetTurnState(context.sessionID);
						if (owner === context.sessionID) owner = undefined;
						return { content: "Fusion run reset." };
					} finally { resetting = false; }
				},
			});
		});
		// User-facing controls over the native command surface (pinned live on
		// v2.2.3: `execute` receives { sessionID, prompt: { text } } and its return
		// value is presentation-only, so commands perform actions; the run's task
		// prompt is injected through session.prompt).
		async function reportCommand(sessionID: string, description: string, content: string): Promise<string> {
			if (!ctx.session.synthetic) throw new Error("This OpenCode host cannot deliver Fusion command output; use the Fusion status or stats tool.");
			await ctx.session.synthetic({ sessionID, text: content, description, resume: false });
			return content;
		}
		await ctx.command?.transform?.((editor) => {
			editor.add({
				name: "fusion-run",
				description: "Start a Fusion run with the given task [task]",
				execute: async (args) => {
					const task = args.prompt?.text?.trim();
					if (!task) throw new Error("Provide a task: /fusion-run <task>");
					if (typeof ctx.session.prompt !== "function") throw new Error("This host cannot inject the run prompt; tell the fusion agent the task directly instead.");
					if (typeof ctx.session.switchAgent !== "function") throw new Error("This host cannot select the Fusion agent; select it before starting a run.");
					if (promptInFlight) throw new Error("Fusion prompt delivery is already in progress.");
					const existing = runs.get(args.sessionID);
					const delivery = existing?.adapterData?.fusionPrompt as { id?: unknown; task?: unknown; state?: unknown } | undefined;
					const retry = !!existing && delivery?.state === "pending" && delivery.task === task && typeof delivery.id === "string";
					const run = retry ? existing! : await startRun(args.sessionID, task);
					promptInFlight = true;
					try {
						const messageID = retry ? delivery!.id as string : `msg_fusion_${randomUUID().replaceAll("-", "")}`;
						if (!retry) {
							run.adapterData = { ...run.adapterData, fusionPrompt: { id: messageID, task, state: "pending" } };
						}
						await persist(args.sessionID, run);
						const label = run.model ? `${run.model.provider}/${run.model.modelId}${run.model.variant ? `#${run.model.variant}` : ""}` : "the host-configured model";
						await ctx.session.switchAgent({ sessionID: args.sessionID, agent: "fusion" });
						await ctx.session.prompt({ sessionID: args.sessionID, id: messageID, text: buildSupervisorPrompt(task, label) });
						run.adapterData = { ...run.adapterData, fusionPrompt: { id: messageID, task, state: "delivered" } };
						try { await persist(args.sessionID, run); }
						catch (error) { run.adapterData = { ...run.adapterData, fusionPrompt: { id: messageID, task, state: "pending" } }; throw error; }
						return `Fusion run started (${label}).`;
					} catch (error) {
						throw new Error(`Fusion prompt delivery could not be confirmed. Retry /fusion-run with the same task to reuse the same message ID, or inspect the session before cleaning. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
					} finally { promptInFlight = false; }
				},
			});
			editor.add({
				name: "fusion-mode",
				description: "Toggle Fusion persistent mode [on|off]",
				execute: async (args) => {
					if (!ctx.session.synthetic) throw new Error("This OpenCode host cannot deliver Fusion command output.");
					const arg = args.prompt?.text?.trim().toLowerCase();
					if (arg !== "on" && arg !== "off") throw new Error("Use /fusion-mode on or /fusion-mode off.");
					const enabled = arg === "on";
					await setFusionMode(enabled);
					return await reportCommand(args.sessionID, "Fusion mode", enabled
						? "Fusion persistent mode enabled: fusion tools stay available to the fusion agent between runs."
						: "Fusion persistent mode disabled: fusion tools require an active run (/fusion-run starts one).");
				},
			});
			editor.add({
				name: "fusion-status",
				description: "Show the current Fusion run state",
				execute: async (args) => await reportCommand(args.sessionID, "Fusion status", await statusContent(args.sessionID)),
			});
			editor.add({
				name: "fusion-stats",
				description: "Show the current Fusion run's budgets",
				execute: async (args) => await reportCommand(args.sessionID, "Fusion stats", statsContent(args.sessionID)),
			});
			editor.add({
				name: "fusion-resume",
				description: "Show the Fusion run's recovery state",
				execute: async (args) => await reportCommand(args.sessionID, "Fusion resume", await resumeContent(args.sessionID)),
			});
			editor.add({
				name: "fusion-clean",
				description: "Release settled Fusion resources for this workspace",
				execute: async (args) => {
					if (!ctx.session.synthetic) throw new Error("This OpenCode host cannot deliver Fusion command output.");
					return await reportCommand(args.sessionID, "Fusion clean", await cleanWorkspace(args.sessionID));
				},
			});
		});
		// Embedding hosts may call this on unload. Process exit also releases SQLite locks.
		return {
			close() {
				busController.abort();
				busSinks.delete(onScoutBusEvent);
				busSinks.delete(onTurnBusEvent);
				scoutGuards.clear();
				settlementChains.clear();
				activeScout = undefined;
				for (const run of runs.values()) run.lease?.close();
			},
		};
	},
};
