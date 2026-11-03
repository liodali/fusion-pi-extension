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
import { FUSION_AGENTS, fusionPermissionsEqual } from "./agents.ts";
import { DELEGATE_INPUT, delegateInput, delegateMonitor, shortLabel } from "./delegate-presentation.ts";
import { readExecutorStop, stopFeedback, stopWait, type ExecutorStop } from "./executor-stop.ts";
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
/** v2.2.5 `Agent.Info` subset Fusion reads and writes. `system` is the prompt; there is no `prompt` field. */
interface AgentRecord {
	id: string;
	name: string;
	mode: "subagent" | "primary" | "all";
	hidden: boolean;
	description?: string;
	system?: string;
	permissions?: { action: string; resource: string; effect: string }[];
}
/** Pinned live on OpenCode v2.2.5: the agent editor has exactly these methods — no `add`. `update` on a missing ID creates the agent. */
interface AgentEditor {
	list(): readonly AgentRecord[];
	get(id: string): AgentRecord | undefined;
	default(id: string | undefined): void;
	update(id: string, update: (agent: AgentRecord) => void): void;
	remove(id: string): void;
}
/** A registration handle returned by transforms; disposing removes the transform's effect. */
interface NativeRegistration {
	dispose(): unknown;
}
interface PluginContext {
	location: { directory: string };
	storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown>; remove(key: string): Promise<unknown> };
	/** Pinned live on OpenCode v2.2.5. Absence leaves Fusion's agents to manual Markdown installation. */
	agent?: {
		transform(callback: (editor: AgentEditor) => void): Promise<NativeRegistration>;
		list?(): Promise<unknown>;
		reload?(): Promise<void>;
	};
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
		interrupt?(input: { sessionID: string; resume?: boolean }): Promise<unknown>;
		/** Present in OpenCode v2 hosts; absence leaves /fusion unable to inject the supervisor prompt. */
		prompt?(input: { sessionID: string; id?: string; text?: string }): Promise<unknown>;
		switchAgent?(input: { sessionID: string; agent: string }): Promise<unknown>;
		synthetic?(input: { sessionID: string; text: string; description?: string; resume?: boolean; metadata?: Record<string, unknown> }): Promise<unknown>;
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
const FUSION_TOOLS = [...FUSION_GATED_TOOLS, "fusion_resume", "fusion_stats", "fusion_status", "fusion_stop"];

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
	turnAbort?: AbortController;
	monitor?: ReturnType<typeof delegateMonitor>;
	stopFlight?: Promise<ExecutorStop | undefined>;
	interruptFlight?: Promise<void>;
	persistFlight?: Promise<void>;
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
		const turnVisibility = new Map<string, { agent: string; tools: string[] }>();
		const processedTurnIds = new Map<string, Set<string>>();
		/** Settlement is serialized per run: one terminal settles at a time, in bus order. */
		const settlementChains = new Map<string, Promise<void>>();
		const forgetTurnState = (sessionID: string): void => {
			supervisorText.delete(sessionID);
			turnAgent.delete(sessionID);
			turnVisibility.delete(sessionID);
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
			const nudgeCancelled = (): boolean => !!readExecutorStop(run.adapterData?.fusionStop) || (run.adapterData?.fusionNudge as { state?: unknown } | undefined)?.state === "cancelled";
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
			const canDeliver = typeof ctx.session.prompt === "function" && !nudgeCancelled();
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
			// Match requireSupervisor at discovery time too. Showing Build tools
			// it cannot execute seeds misleading failures into the conversation
			// before the user switches to Fusion.
			else for (const name of FUSION_TOOLS) delete event.tools[name];
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
			if (event.sessionID) {
				turnVisibility.set(event.sessionID, { agent: event.agent, tools: FUSION_TOOLS.filter((name) => Object.hasOwn(event.tools, name)).sort() });
				if (turnVisibility.size > 32) turnVisibility.delete(turnVisibility.keys().next().value!);
			}
		});
		// Native agent contribution (pinned live on OpenCode v2.2.5; see
		// docs/opencode-install-and-config-plan.md step 1): the agent editor has
		// no `add` method — `update()` on a missing ID creates the agent from an
		// `Agent.Info.default` draft — so Fusion contributes its supervisor,
		// executor, and scout through update-on-missing. Markdown/config-defined
		// agents with the same ID keep precedence over plugin contributions on
		// this host, which is exactly the collision policy: a legacy manual
		// install stays authoritative and is never silently overridden.
		// Conflicts are detected in the transform callback when the editor
		// already exposes the legacy agent, and — authoritatively — by
		// re-reading the merged registry at query time (agentReport below),
		// because the first transform replay may run before Markdown agents are
		// visible in its editor. The transform callback runs after setup returns
		// and replays on every registry rebuild, so contribution state is
		// deduplicated here and registry reads are never awaited inside setup
		// (a read awaited in setup never resolves on this host).
		const agentContribution: { supported: boolean; contributed: string[]; acceptedLegacy: string[]; conflicts: { id: string; differences: string[] }[] } = {
			supported: typeof ctx.agent?.transform === "function",
			contributed: [],
			acceptedLegacy: [],
			conflicts: [],
		};
		const agentRegistration = agentContribution.supported ? await ctx.agent!.transform((editor) => {
			for (const definition of FUSION_AGENTS) {
				const existing = editor.get(definition.id);
				if (existing) {
					const differences: string[] = [];
					if (existing.mode !== definition.mode) differences.push("mode");
					if ((existing.description ?? "") !== definition.description) differences.push("description");
					if ((existing.system ?? "") !== definition.system) differences.push("system");
					if (!fusionPermissionsEqual(existing.permissions, definition.permissions)) differences.push("permissions");
					if (differences.length === 0) {
						if (!agentContribution.acceptedLegacy.includes(definition.id)) agentContribution.acceptedLegacy.push(definition.id);
					} else if (!agentContribution.conflicts.some((conflict) => conflict.id === definition.id)) {
						agentContribution.conflicts.push({ id: definition.id, differences });
					}
					continue;
				}
				editor.update(definition.id, (agent) => {
					agent.mode = definition.mode;
					agent.description = definition.description;
					agent.system = definition.system;
					agent.permissions = definition.permissions.map((rule) => ({ action: rule.action, resource: rule.resource, effect: rule.effect }));
				});
				if (!agentContribution.contributed.includes(definition.id)) agentContribution.contributed.push(definition.id);
			}
		}) : undefined;
		/** Authoritative agent report at query time. The transform callback runs
		 * before Markdown/config agents are guaranteed visible in its editor
		 * (live-observed on v2.2.5: first replay may not see them, later replays
		 * do), so detection recorded during the transform is advisory; this read
		 * — safe outside setup, where registry reads never resolve — reconciles
		 * what actually holds in the merged registry. */
		async function agentReport(): Promise<{ supported: boolean; contributed: string[]; acceptedLegacy: string[]; conflicts: { id: string; differences: string[] }[]; observed?: { id: string; state: "available" | "conflict" | "unavailable"; differences?: string[] }[] }> {
			if (!agentContribution.supported) return { ...agentContribution, observed: [] };
			const report = { ...agentContribution, observed: [] as { id: string; state: "available" | "conflict" | "unavailable"; differences?: string[] }[] };
			if (typeof ctx.agent?.list !== "function") return report;
			try {
				const listed = await ctx.agent.list();
				const agents = Array.isArray(listed) ? listed : Array.isArray((listed as { data?: unknown[] })?.data) ? (listed as { data: unknown[] }).data : [];
				const byId = new Map<string, AgentRecord>();
				for (const agent of agents) if (agent && typeof (agent as AgentRecord).id === "string") byId.set((agent as AgentRecord).id, agent as AgentRecord);
				for (const definition of FUSION_AGENTS) {
					const agent = byId.get(definition.id);
					if (!agent) { report.observed!.push({ id: definition.id, state: "unavailable" }); continue; }
					const differences: string[] = [];
					if (agent.mode !== definition.mode) differences.push("mode");
					if ((agent.description ?? "") !== definition.description) differences.push("description");
					if ((agent.system ?? "") !== definition.system) differences.push("system");
					if (!fusionPermissionsEqual(agent.permissions, definition.permissions)) differences.push("permissions");
					report.observed!.push(differences.length > 0 ? { id: definition.id, state: "conflict", differences } : { id: definition.id, state: "available" });
				}
			} catch {
				/* the registry read is unavailable: the advisory transform state stands */
			}
			return report;
		}
		const storageKey = `run/${createHash("sha256").update(ctx.location.directory).digest("hex")}`;
		async function makeRun(sessionID: string, record?: RunManifest): Promise<Run> {
			const toolContexts = new WeakMap<WorkerHandle, ToolContext>();
			const workerOwner = { harness: "opencode", supervisorId: sessionID, workspace };
			const runtime = createOpenCodeWorkerRuntime<ToolContext>({
				execute: native!.execute,
				contextFor: (request) => { const toolContext = toolContexts.get(request.worker); if (!toolContext) throw new Error("OpenCode tool context is unavailable."); return toolContext; },
				interrupt: typeof ctx.session.interrupt === "function" ? ((childSessionID: string) => Promise.resolve(ctx.session.interrupt!({ sessionID: childSessionID, resume: false }))) : undefined,
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
		async function persist(_sessionID: string, run: Run, settled = false): Promise<void> {
			if (!run.lease) throw new Error("Fusion workspace has not been claimed.");
			const operation = (run.persistFlight ?? Promise.resolve()).catch(() => {}).then(async () => {
				const value = { ...manifest(run), ...(settled ? { recovery: "settled" as const } : {}) };
				await run.lease!.save(value);
				await store.save(value);
			});
			run.persistFlight = operation;
			try { await operation; } finally { if (run.persistFlight === operation) run.persistFlight = undefined; }
		}
		async function saveStop(sessionID: string, run: Run, stop: ExecutorStop): Promise<void> {
			if (!run.lease) return;
			if (!await stopWait(persist(sessionID, run), 250)) stop.persistenceWarning = true;
		}
		async function stopNotice(sessionID: string, stop: ExecutorStop): Promise<void> {
			if (!ctx.session.synthetic) return;
			const text = stopFeedback(stop);
			try { await ctx.session.synthetic({ sessionID, text, description: `Fusion executor stop\n${text}`, resume: false, metadata: { fusionStop: { ...stop } } }); } catch {}
		}
		async function confirmStop(sessionID: string, run: Run, stop: ExecutorStop, terminal: "completed" | "error" | "cancelled"): Promise<void> {
			if (stop.state === "confirmed") return;
			stop.state = "confirmed";
			stop.terminal = terminal;
			stop.updatedAt = Date.now();
			await run.monitor?.finish("stopped");
			await saveStop(sessionID, run, stop);
			await stopNotice(sessionID, stop);
		}
		async function interruptExecutor(sessionID: string, run: Run, stop: ExecutorStop): Promise<void> {
			if (run.interruptFlight) return run.interruptFlight;
			const operation = (async () => {
				const confirmed = () => stop.state === "confirmed";
				const reference = run.handle.reference;
				if (!reference || confirmed() || run.controller.pending?.requestId !== stop.requestId) return;
				stop.childSessionID = reference.id;
				try {
					const child = await ctx.session.get({ sessionID: reference.id });
					if (child.id !== reference.id || child.parentID !== sessionID || !child.location?.directory || await canonicalize(child.location.directory) !== workspace || reference.owner.supervisorId !== sessionID || reference.owner.workspace !== workspace) throw new Error("Executor ownership does not match this Fusion session.");
					if (run.controller.pending?.requestId !== stop.requestId || confirmed()) return;
					const interruption = run.runtime.abort(run.handle);
					run.turnAbort?.abort(new Error("Fusion executor stop requested."));
					await interruption;
					if (!confirmed()) stop.state = "acknowledged";
				} catch (error) {
					if (!confirmed()) { stop.state = "failed"; stop.error = shortLabel(error instanceof Error ? error.message : String(error), 160); }
				} finally {
					run.turnAbort?.abort(new Error("Fusion executor stop requested."));
					stop.updatedAt = Date.now();
					await saveStop(sessionID, run, stop);
				}
			})();
			run.interruptFlight = operation;
			try { await operation; } finally { if (run.interruptFlight === operation) run.interruptFlight = undefined; }
		}
		async function stopExecutor(sessionID: string, reason = "User requested stop"): Promise<ExecutorStop | undefined> {
			const run = runs.get(sessionID);
			if (!run) {
				if (await registry.inspect(workspace)) throw new Error("The Fusion run belongs to another session; stop it from its owning session.");
				return;
			}
			if (owner && owner !== sessionID || run.handle.owner.supervisorId !== sessionID || run.handle.owner.workspace !== workspace) throw new Error("The Fusion run belongs to another session.");
			if (run.stopFlight) return run.stopFlight;
			const operation = (async () => {
				const requestId = run.controller.pending?.requestId ?? `idle:${run.runId}`;
				const existing = readExecutorStop(run.adapterData?.fusionStop);
				if (existing?.requestId === requestId && existing.state === "confirmed") return existing;
				const activity = run.monitor?.snapshot();
				const stop: ExecutorStop = existing?.requestId === requestId ? existing : { requestId, requestedAt: Date.now(), updatedAt: Date.now(), state: "requested", reason: shortLabel(reason, 120), activity: activity?.activity, tools: activity?.tools };
				run.adapterData = { ...run.adapterData, fusionStop: stop, fusionNudge: { ...(run.adapterData?.fusionNudge as object ?? {}), state: "cancelled" } };
				run.monitor?.requestStop();
				const saving = saveStop(sessionID, run, stop);
				if (!run.controller.pending) stop.state = "not-submitted";
				else if (run.handle.reference && (run.controller.submissionBegan || !run.controller.state.delegating)) await stopWait(interruptExecutor(sessionID, run, stop), 1500);
				else run.turnAbort?.abort(new Error("Fusion executor stop requested."));
				await saving;
				stop.updatedAt = Date.now();
				await saveStop(sessionID, run, stop);
				return stop;
			})();
			run.stopFlight = operation;
			try { return await operation; } finally { if (run.stopFlight === operation) run.stopFlight = undefined; }
		}
		const onStopBusEvent = (event: { created?: number; type: string; data?: Record<string, unknown> }): void => {
			if (typeof event.created !== "number" || typeof event.data?.sessionID !== "string") return;
			for (const [sessionID, run] of runs) {
				const stop = readExecutorStop(run.adapterData?.fusionStop);
				if (!stop || stop.state === "confirmed" || event.created <= stop.requestedAt || stop.requestId !== run.controller.pending?.requestId || run.handle.reference?.id !== event.data.sessionID) continue;
				if (event.type === "session.execution.started") void interruptExecutor(sessionID, run, stop);
				const terminal = event.type === "session.execution.interrupted" ? "cancelled" : event.type === "session.execution.succeeded" ? "completed" : event.type === "session.execution.failed" ? "error" : undefined;
				if (terminal) void confirmStop(sessionID, run, stop, terminal);
			}
		};
		busSinks.add(onStopBusEvent);
		function hasUnconfirmedPrompt(run: Run): boolean {
			const prompt = run.adapterData?.fusionPrompt;
			return !!prompt && typeof prompt === "object" && (prompt as { state?: unknown }).state === "pending";
		}
		/** POSIX single-quote a shell argument so paths and request ids with
		 * spaces or metacharacters stay single arguments in displayed commands. */
		function shellQuote(value: string): string {
			return `'${value.replaceAll("'", `'\\''`)}'`;
		}
		/** Aggregate one observed worker turn into the run's persisted usage
		 * record. A turn whose result carried no usage reading counts as missing,
		 * so the totals honestly under-report instead of guessing, and per-field
		 * coverage (`fieldTurns`) keeps a token-carrying turn from making a
		 * cost-only turn's totals look complete. `dedupeKey` suppresses a
		 * re-recorded turn across settlement retries. */
		function recordUsage(run: Run, result: WorkerTurnResult, dedupeKey?: string): void {
			const current = (run.adapterData?.fusionUsage ?? {}) as Record<string, unknown> & { turnsReported?: number; turnsMissing?: number; counted?: string[]; fieldTurns?: Record<string, number> };
			if (dedupeKey && current.counted?.includes(dedupeKey)) return;
			const next: Record<string, unknown> = { ...current };
			next.turnsReported = (current.turnsReported ?? 0) + (result.usage ? 1 : 0);
			next.turnsMissing = (current.turnsMissing ?? 0) + (result.usage ? 0 : 1);
			const fieldTurns = { ...(current.fieldTurns ?? {}) };
			for (const [field, value] of Object.entries(result.usage ?? {})) {
				if (typeof value !== "number" || !Number.isFinite(value)) continue;
				next[field] = (typeof current[field] === "number" ? current[field] as number : 0) + value;
				fieldTurns[field] = (fieldTurns[field] ?? 0) + 1;
			}
			next.fieldTurns = fieldTurns;
			if (dedupeKey) next.counted = [...current.counted ?? [], dedupeKey].slice(-16);
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
			if (readExecutorStop(run.adapterData?.fusionStop)) throw new Error("This Fusion run was stopped. Reconcile retained work and reset before starting another run.");
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
		/** One configuration operation shared by the fusion_configure tool and
		 * the /fusion-config command: validate the selection against the live
		 * catalog before any mutation, serialize with run start/reset/delegation
		 * transitions, persist the preference, and apply it immediately only to
		 * a safely replaceable executor handle — one that cannot have produced
		 * worker work: no submission, no native child to orphan, and no scout
		 * activity or history (scouts run on the run's model, so a mid-run
		 * change would misreport what this run used). Pending, uncertain,
		 * backgrounded, and foreign-owned work never has its handle replaced.
		 * Failures stay retryable: a failed preference write releases the
		 * replacement handle and changes nothing; a failed handle replacement
		 * never reaches the write. */
		async function configureExecutorModel(sessionID: string, selection: { provider: string; modelId: string; variant?: string }): Promise<{ applied: "now" | "next-run"; appliedReason: string; config: WorkerModelConfig; metadata: Record<string, unknown> }> {
			const { config, metadata } = await validateCatalogModel(selection.provider, selection.modelId, selection.variant);
			if (resetting || starting || configuring) throw new Error("A Fusion run transition is in progress.");
			configuring = true;
			try {
				const run = await runFor(sessionID);
				const active = run.runtime.status(run.handle);
				const executorStarted = run.controller.state.executed || !!run.controller.pending || run.controller.uncertain || run.reconciling || active.backgrounded || active.backgroundPending || active.unsettled;
				// Scout work counts: an in-flight or backgrounded scout holds a
				// handle built from the run's model, and completed scouts already
				// consumed their budget on it.
				const scoutActive = scoutInFlight || hasBackgroundScout();
				const scoutDone = run.controller.state.scoutCalls > 0;
				const workStarted = executorStarted || scoutActive || scoutDone;
				let applied: "now" | "next-run";
				let appliedReason = "";
				if (!workStarted && !run.handle.reference) {
					const replacement = await run.runtime.create({ harness: "opencode", supervisorId: sessionID, workspace }, { role: "executor", model: config });
					try { await ctx.storage.set(modelKey, config); } catch (error) { await run.runtime.release(replacement); throw error; }
					await run.runtime.release(run.handle);
					run.handle = replacement;
					run.model = config;
					applied = "now";
				} else {
					await ctx.storage.set(modelKey, config);
					applied = "next-run";
					appliedReason = executorStarted ? "executor work has already started" : scoutActive ? "a Fusion scout is still running" : scoutDone ? "a scout has already run in this run" : "the executor child already exists";
				}
				preferredModel = config;
				if (run.lease) await persist(sessionID, run);
				return { applied, appliedReason, config, metadata };
			} finally { configuring = false; }
		}
		/** Presentation shared by the tool and the command. */
		function formatConfiguredModel(result: { applied: "now" | "next-run"; appliedReason: string; config: WorkerModelConfig; metadata: Record<string, unknown> }): string {
			return `Fusion executor model configured for ${result.applied === "now" ? "this run" : `the next run (${result.appliedReason})`}: ${result.config.provider}/${result.config.modelId}${result.config.variant ? ` (variant ${result.config.variant})` : ""}. The scout uses its run's executor model; the supervisor's model stays OpenCode's own selector. ${JSON.stringify(result.metadata)}`;
		}
		/** Parse /fusion-config text per the published contract. The explicit
		 * selection splits on the FIRST slash so model IDs containing slashes
		 * still work; the variant is one optional whitespace-separated token. */
		function parseConfigCommand(text: string): { action: "show" } | { action: "list"; filter?: string } | { action: "set"; provider: string; modelId: string; variant?: string } | { action: "error"; message: string } {
			const trimmed = text.trim();
			if (!trimmed) return { action: "show" };
			const tokens = trimmed.split(/\s+/);
			if (tokens[0] === "list") {
				const filter = tokens.slice(1).join(" ").trim();
				return { action: "list", ...(filter ? { filter } : {}) };
			}
			if (tokens.length > 2) return { action: "error", message: "Too many arguments." };
			const slash = tokens[0].indexOf("/");
			if (slash <= 0 || slash >= tokens[0].length - 1) return { action: "error", message: "A model selection must be <provider>/<model>." };
			const provider = tokens[0].slice(0, slash);
			const modelId = tokens[0].slice(slash + 1);
			return { action: "set", provider, modelId, ...(tokens[1] !== undefined ? { variant: tokens[1] } : {}) };
		}
		/** Bounded, optionally filtered listing of validated catalog choices. */
		async function listCatalogModels(filter: string | undefined): Promise<string> {
			const enabled = (await hostModels()).filter((entry) => entry.enabled !== false);
			const needle = filter?.toLowerCase();
			const matched = enabled.filter((entry) => !needle || `${entry.providerID}/${entry.id}`.toLowerCase().includes(needle) || (entry.name ?? "").toLowerCase().includes(needle));
			const MAX_LISTED = 40;
			const shown = matched.slice(0, MAX_LISTED);
			const lines = shown.map((entry) => {
				const variants = (entry.variants ?? []).map((candidate) => typeof candidate?.id === "string" ? candidate.id : "").filter(Boolean);
				return `- ${entry.providerID}/${entry.id}${entry.name ? ` (${entry.name})` : ""}${variants.length ? ` [variants: ${variants.join(", ")}]` : ""}`;
			});
			const header = matched.length > MAX_LISTED
				? `${matched.length} models match; showing the first ${MAX_LISTED}. Narrow the output with /fusion-config list <filter>.`
				: `${matched.length} model${matched.length === 1 ? "" : "s"} ${needle ? `matching "${filter}"` : "available"}.`;
			return `${header}\n${lines.join("\n")}`;
		}
		/** The no-argument view: saved preference, current run model, and the
		 * command syntax. Read-only — it never creates a run or claims the
		 * workspace, unlike an explicit selection. */
		function configStatusText(sessionID: string): string {
			const format = (model: WorkerModelConfig | undefined) => model ? `${model.provider}/${model.modelId}${model.variant ? `#${model.variant}` : ""}` : undefined;
			const run = runs.get(sessionID);
			const visible = turnVisibility.get(sessionID);
			return [
				"Fusion executor model configuration.",
				`Fusion mode: ${fusionMode ? "on" : "off"}.`,
				visible ? `Last Fusion context hook: agent=${visible.agent}; tools=${visible.tools.join(", ") || "none"}.` : "Last Fusion context hook: no model turn observed in this session since plugin load.",
				`Saved preference: ${format(preferredModel) ?? "none"}.`,
				`Current run: ${run ? format(run.model) ?? "the host-configured model" : "no run in this session"}.`,
				"Usage:",
				"  /fusion-config <provider>/<model> [variant]",
				"  /fusion-config list [filter]",
				"The selection splits on the first slash, so model IDs containing slashes work.",
				"The executor and the scout share the chosen model; the supervisor's model stays OpenCode's own selector.",
			].join("\n");
		}
		/** Release settled Fusion resources for a session, or a settled workspace record left by another one. */
		async function cleanWorkspace(sessionID: string): Promise<string> {
			if (resetting || starting || configuring || promptInFlight) throw new Error("A Fusion run transition is in progress.");
			// A persistent-mode run stays armed (runActive true) after it settles;
			// phase "complete" is the settled marker, so it releases like any
			// other settled run instead of deadlocking the session's cleanup.
			const cleanable = (state: { runActive: boolean; phase: string }): boolean => state.runActive && state.phase !== "complete";
			const run = runs.get(sessionID);
			if (run) {
				if (run.stopFlight || run.interruptFlight || readExecutorStop(run.adapterData?.fusionStop) && run.persistFlight) throw new Error("Executor stop or persistence is still in progress.");
				if (hasUnconfirmedPrompt(run)) throw new Error("Fusion prompt delivery is unconfirmed. Retry /fusion-run with the same task before cleaning.");
				if (cleanable(run.controller.state)) throw new Error("The Fusion run is still active; finish and reset it before cleaning.");
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
				if (owned.manifest.state.runActive && owned.manifest.state.phase !== "complete" || scoutInFlight || hasBackgroundScout()) throw new Error("A Fusion run or scout is still active; clean it from its owning session after it finishes.");
				// An adopted run's held lease is the same record: release through it
				// rather than claiming the workspace a second time in this process.
				const holder = [...runs.values()].find((candidate) => candidate.lease && candidate.lease.manifest.runId === owned.manifest.runId);
				if (holder?.lease) {
					const error = holder.controller.resetError(false, holder.reconciling);
					if (error || cleanable(holder.controller.state)) throw new Error("The owning Fusion run is still active; clean it from its owning session after it finishes.");
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
				if (!owned) {
					const report = await agentReport();
					const observedConflicts = (report.observed ?? []).filter((entry) => entry.state === "conflict");
					if (observedConflicts.length > 0) {
						const detail = observedConflicts.map((conflict) => `${conflict.id} (${conflict.differences!.join(", ")})`).join("; ");
						return `No Fusion run in this session. Installed agent definitions override this plugin's for: ${detail}. Update or remove those agent files to let the plugin manage them.`;
					}
					return "No Fusion run in this session.";
				}
				return JSON.stringify({ message: "Another Fusion run owns this workspace.", runId: owned.manifest.runId, owner: owned.manifest.owner, recovery: owned.manifest.recovery, pending: owned.manifest.pending, nextAction: "Reconcile in the owning harness or explicitly resolve ownership after inspecting the worker and workspace." });
			}
			const status = run.runtime.status(run.handle);
			const promptDelivery = run.adapterData?.fusionPrompt as { state?: unknown } | undefined;
			const nudgeDelivery = (run.adapterData?.fusionNudge as { state?: unknown } | undefined)?.state;
			const settlementWrite = (run.adapterData?.fusionSettlement as { state?: unknown } | undefined)?.state;
			const stopped = readExecutorStop(run.adapterData?.fusionStop);
			const nextAction = stopped ? stopFeedback(stopped) : run.incomplete
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
			return JSON.stringify({ ...run.controller.state, runId: run.runId, owner: run.handle.owner, workspaceClaimed: !!run.lease, model: run.model, fusionMode: fusionMode ? "on" : "off", pending: run.controller.pending, promptDelivery: promptDelivery?.state, nudgeDelivery, settlementWrite, incomplete: !!run.incomplete, childSessionID: run.handle.reference?.id, capabilities: run.runtime.capabilities, uncertain: run.controller.uncertain, backgroundPending: status.backgroundPending, reconciling: !!run.reconciling, stop: stopped, agents: await agentReport(), nextAction });
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
					nextAction: `Call fusion_resume in the owning session (${owned.manifest.owner.supervisorId}), or after inspecting the worker and workspace run: bun src/workspace/resolve.ts ${shellQuote(workspace)} ${shellQuote(owned.manifest.runId)} ${shellQuote(owned.manifest.pending?.requestId ?? "--no-request-id")} --confirm-stopped`,
				});
			}
			const status = run.runtime.status(run.handle);
			const outstanding = { backgroundPending: status.backgroundPending, recordedResult: !!status.unsettled, reconciling: !!run.reconciling, delegating: !!run.controller.state.delegating, scoutInFlight, backgroundScout: hasBackgroundScout() };
			const pendingRequest = run.controller.pending;
			// The capability mirrors the fusion_reconcile guard; the detail names
			// which proof reconcile would adopt, or why none can exist.
			const resolveCommand = run.runId ? `bun src/workspace/resolve.ts ${shellQuote(workspace)} ${shellQuote(run.runId)} ${shellQuote(pendingRequest?.requestId ?? "--no-request-id")} --confirm-stopped` : "bun src/workspace/resolve.ts --confirm-stopped";
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
			const usage = (run.adapterData?.fusionUsage ?? {}) as Record<string, unknown> & { turnsReported?: number; turnsMissing?: number; fieldTurns?: Record<string, number> };
			const reported = usage.turnsReported ?? 0;
			const missing = usage.turnsMissing ?? 0;
			// A summed field is only complete when every reporting turn carried
			// it: a token total that came from fewer turns than reported must
			// not look whole.
			const fieldsFull = reported > 0 && !(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cost"] as const).some((field) => typeof usage[field] === "number" && (usage.fieldTurns?.[field] ?? 0) !== reported);
			return JSON.stringify({ runId: run.runId, executed: run.controller.state.executed,
				revisions: { used: run.controller.state.revisions, limit: MAX_REVISIONS },
				scoutCalls: { used: run.controller.state.scoutCalls, limit: MAX_SCOUT_CALLS },
				finalFixUsed: run.controller.state.finalFixUsed,
				lastResult: run.lastResult ? { requestId: run.lastResult.requestId, status: run.lastResult.status } : undefined,
				usage: {
					available: reported > 0,
					reason: reported > 0 ? undefined : run.controller.state.executed || run.controller.state.scoutCalls > 0 ? "No Fusion worker turn has reported usage on this host yet." : "No Fusion worker turn has run yet.",
					complete: missing === 0 && (reported === 0 || fieldsFull),
					turns: { reported, missing },
					fieldTurns: usage.fieldTurns,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens,
					cacheWriteTokens: usage.cacheWriteTokens,
					reasoningTokens: usage.reasoningTokens,
					cost: usage.cost,
				} });
		}

		await ctx.tool.transform((editor) => {
			editor.add({
				name: "fusion_stop",
				description: "Stop this supervisor's executor when the user requests it. Requests native interruption and returns bounded activity feedback. Acknowledgement is not proof of termination. Do not retry, reset, or start more work after stopping; reconcile retained results first.",
				input: { type: "object", properties: { reason: { type: "string", maxLength: 120 } }, additionalProperties: false },
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					const reason = input && typeof input === "object" ? (input as { reason?: unknown }).reason : undefined;
					if (reason !== undefined && typeof reason !== "string") throw new Error("Invalid Fusion stop reason.");
					const stop = await stopExecutor(context.sessionID, reason);
					return { content: stop ? stopFeedback(stop) : "No Fusion run in this session.", metadata: stop ? { stop: { ...stop }, childSessionID: stop.childSessionID } : {} };
				},
			});
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
					const result = await configureExecutorModel(context.sessionID, { provider: value.provider.trim(), modelId: value.model.trim(), ...(typeof value.variant === "string" && value.variant.trim() ? { variant: value.variant.trim() } : {}) });
					return { content: formatConfiguredModel(result), metadata: { model: result.config, applied: result.applied, ...result.metadata } };
				},
			});
			editor.add({
				name: "fusion_delegate",
				description: "Delegate a decided implementation brief to the Fusion executor. Supply a short title and put the full brief in details.brief so it stays collapsed in the UI. Use execute once, then up to three revise calls and one final_fix after the acceptance audit. Review the actual working tree after each call.",
				input: DELEGATE_INPUT,
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					const value = delegateInput(input);
					const action = value.action;
					const run = await runFor(context.sessionID);
					if (resetting || starting || configuring) throw new Error("Fusion reset is in progress, a run is starting, or configuration is in progress.");
					if (context.signal.aborted) throw new Error("Fusion delegation cancelled before submission.");
					if (run.reconciling) throw new Error("Fusion reconciliation is already in progress.");
					if (readExecutorStop(run.adapterData?.fusionStop)) throw new Error("This Fusion run was stopped. Reconcile retained work and reset before further delegation.");
					if (run.controller.uncertain) throw new Error("The executor's last turn has an unknown outcome. Review the child session and working tree before recovery; automatic retry is disabled.");
					if (owner && owner !== context.sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
					if (action === "execute" && run.controller.state.originalTask && typeof value.originalTask === "string" && value.originalTask !== run.controller.state.originalTask) throw new Error("The original task was already recorded by fusion_start and cannot be replaced.");
					const error = run.controller.beginDelegation(action, OPENCODE_CAPABILITIES, value.brief);
					if (error) throw new Error(error);
					const monitor = delegateMonitor({ action, title: value.title, requestId: run.controller.pending?.requestId, streaming: !!busHost, progress: (update) => context.progress(update) });
					run.monitor = monitor;
					const turnAbort = new AbortController();
					run.turnAbort = turnAbort;
					const parentCancelled = () => { void stopExecutor(context.sessionID, "Supervisor turn cancelled").then((stop) => stop && stopNotice(context.sessionID, stop)).catch(() => {}); };
					context.signal.addEventListener("abort", parentCancelled, { once: true });
					// Keep the native call's ownership/request/cancellation fields. The
					// progress overlay adds display metadata after reference persistence.
					run.setContext(run.handle, { ...context, progress: (update) => monitor.nativeProgress(update) });
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
						await monitor.start();
						const request: WorkerTurnRequest = { runId: run.runId, requestId: description, worker: run.handle, prompt };
						return await run.controller.performWorkerDelegation(request, { signal: AbortSignal.any([context.signal, turnAbort.signal]), onEvent: monitor.onEvent }, {
							// Authoritative in-sequence claim: the precondition above is a
							// fast guard, this re-check wins the workspace before intent.
							claim: async () => {
								if (owner && owner !== context.sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
								if (!run.lease) run.lease = await registry.claim(manifest(run));
								owner = context.sessionID;
							},
							recordIntent: () => persist(context.sessionID, run),
							snapshot: async () => {
								if (readExecutorStop(run.adapterData?.fusionStop)?.requestId === request.requestId) throw new Error("Fusion executor stopped before submission.");
								const before = await snapshotWorkspace(ctx.location.directory, nodeGitExec);
								if (readExecutorStop(run.adapterData?.fusionStop)?.requestId === request.requestId) throw new Error("Fusion executor stopped before submission.");
								run.before = before;
								return before;
							},
							recordReference: async (reference) => {
								// A queued stop interrupts the owned child without waiting
								// on the reference persistence below: a stalled storage
								// write must not delay interrupting a running child (the
								// bus watcher would otherwise retry the interruption only
								// on a later qualifying event). Persistence still gates
								// the forwarded progress, and since nothing has been
								// submitted in the pre-submission path, the idle child
								// only needs the stop-before-submission throw.
								const stop = readExecutorStop(run.adapterData?.fusionStop);
								if (stop?.requestId === request.requestId && run.controller.submissionBegan) void interruptExecutor(context.sessionID, run, stop);
								await persist(context.sessionID, run);
								if (stop?.requestId === request.requestId && !run.controller.submissionBegan) throw new Error("Fusion executor stopped before submission.");
								await monitor.nativeProgress({ sessionID: reference.id });
							},
							collect: async (result, before) => {
								recordUsage(run, result);
								const workspaceAfter = await snapshotWorkspaceAfter(before, nodeGitExec);
								const evidence = await workspaceEvidenceRefs(before, nodeGitExec, undefined, workspaceAfter);
								run.lastResult = { requestId: result.requestId, status: result.status, text: result.text, evidence: evidence ?? [] };
								return { result, parsed: run.controller.executorReport(result.text), diffStat: await workspaceDiffStat(before, nodeGitExec) };
							},
							settle: async ({ result, parsed, diffStat }) => {
								const stop = readExecutorStop(run.adapterData?.fusionStop);
								if (stop?.requestId === result.requestId) await confirmStop(context.sessionID, run, stop, result.status);
								await run.runtime.settle(request, async () => {
									await run.controller.persistSettlement(result.status, async () => {
										run.lastResult = { requestId: result.requestId, status: result.status, text: result.text, evidence: run.lastResult?.evidence ?? [] };
										await persist(context.sessionID, run, true);
									});
								});
								run.before = undefined;
								// Display activity is advisory, not evidence of complete edits.
								const activity = await monitor.finish(result.status === "completed" ? "completed" : "failed");
								return { content: formatCompactReport(parsed.report, diffStat, parsed.prose, [busHost ? "review the full working tree" : "executor tool activity unavailable; review the full working tree"]), metadata: { childSessionID: run.handle.reference?.id, action, fusion: activity } };
							},
						});
					} catch (error) {
						const stop = readExecutorStop(run.adapterData?.fusionStop);
						if (stop && !run.controller.submissionBegan) { stop.state = "not-submitted"; stop.updatedAt = Date.now(); await monitor.finish("stopped"); await stopNotice(context.sessionID, stop); }
						await monitor.finish(run.runtime.status(run.handle).backgrounded ? "background" : run.controller.submissionBegan ? "uncertain" : "failed");
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
						if (run.runtime.status(run.handle).backgrounded) return { content: "Fusion executor is running in the background. After OpenCode delivers its completion notification, call fusion_reconcile before reviewing or delegating again.", metadata: { childSessionID: run.handle.reference?.id, status: "running", fusion: monitor.snapshot() } };
						throw error;
					} finally {
						context.signal.removeEventListener("abort", parentCancelled);
						if (run.turnAbort === turnAbort) run.turnAbort = undefined;
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
					if (readExecutorStop(run.adapterData?.fusionStop)) throw new Error("This Fusion run was stopped; do not start more scout work.");
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
						if (run.lease && !run.persistFlight) { try { await persist(context.sessionID, run); } catch {} }
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
						if (run.lease && !run.persistFlight) { try { await persist(context.sessionID, run); } catch {} }
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
						const unresolvedStatus = run.runtime.status(run.handle);
						const unsettled = unresolvedStatus.unsettled;
						const persistResult = async (result: import("../core/worker.ts").WorkerTurnResult) => {
							// The proven terminal result updates a matching stop record
							// before the settlement clears the pending intent: after a
							// successful cancelled-work reconciliation, stop feedback
							// must read confirmed termination instead of a still
							// unconfirmed interrupt. confirmStop is idempotent and
							// bounded-wait on its persistence, like on the bus path.
							const stop = readExecutorStop(run.adapterData?.fusionStop);
							if (stop?.requestId === result.requestId) await confirmStop(context.sessionID, run, stop, result.status);
							await run.controller.persistSettlement(result.status, async () => {
								// The reconciled turn's usage is recorded inside the
								// persisted settlement itself, so a reload before
								// another write loses neither the settlement nor the
								// count. The dedupe key (keyed on the pending request)
								// keeps a re-run of the same reconciliation — after a
								// failed settlement write, for instance — from
								// counting the turn twice. A recorded (unsettled)
								// result was already counted when its turn
								// completed, so only notification-adopted turns are
								// new to the totals.
								if (!unsettled) recordUsage(run, result, `reconcile:${pending.requestId}`);
								// Reconciliation settles the same request the evidence was
								// collected for; anything else gets empty evidence.
								const retained = run.lastResult;
								run.lastResult = { requestId: result.requestId, status: result.status, text: result.text, evidence: retained?.requestId === result.requestId ? retained.evidence ?? [] : [] };
								await persist(context.sessionID, run, true);
							});
						};
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
						run.controller.setUncertain(false);
						const terminalState = result.status;
						const parsed = run.controller.executorReport(result.text);
						const stat = await workspaceDiffStat(run.before, nodeGitExec);
						run.before = undefined;
						if (terminalState !== "completed") return { content: `Fusion executor ${terminalState}: ${result.text}\nReview the full working tree before deciding whether to revise.`, metadata: { childSessionID: run.handle.reference?.id, requestId: pending.requestId, action: pending.action, status: terminalState } };
						return { content: formatCompactReport(parsed.report, stat, parsed.prose, ["reconciled background turn; review the full working tree"]), metadata: { childSessionID: run.handle.reference?.id, requestId: pending.requestId, action: pending.action, status: terminalState } };
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
					if (run.stopFlight || run.interruptFlight || readExecutorStop(run.adapterData?.fusionStop) && run.persistFlight) throw new Error("Executor stop or persistence is still in progress.");
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
			// OpenCode 2.2.5's TUI renders synthetic messages from `description`
			// only (SessionNoticeMessageV2); `text` alone is model/inbox content.
			// Keep the full report visible without submitting a model turn.
			await ctx.session.synthetic({ sessionID, text: content, description: `${description}\n${content}`, resume: false });
			return content;
		}
		const commandRegistration = await ctx.command?.transform?.((editor) => {
			editor.add({
				name: "fusion-run",				description: "Start a Fusion run with the given task [task]",
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
				description: "Show or toggle Fusion persistent mode [on|off]",
				execute: async (args) => {
					if (!ctx.session.synthetic) throw new Error("This OpenCode host cannot deliver Fusion command output.");
					const arg = args.prompt?.text?.trim().toLowerCase();
					// No argument is read-only: it reports the current mode without
					// touching storage, like the /fusion-config no-argument view.
					if (!arg) return await reportCommand(args.sessionID, "Fusion mode", [
						`Fusion persistent mode is ${fusionMode ? "on" : "off"}.`,
						fusionMode ? "Fusion tools stay available to the fusion agent between runs; tasks can start without /fusion-run." : "Fusion tools require an active run; /fusion-run starts one.",
						"Usage: /fusion-mode <on|off>.",
					].join("\n"));
					if (arg !== "on" && arg !== "off") throw new Error("Use /fusion-mode, /fusion-mode on, or /fusion-mode off.");
					const enabled = arg === "on";
					await setFusionMode(enabled);
					return await reportCommand(args.sessionID, "Fusion mode", enabled
						? "Fusion persistent mode enabled: fusion tools stay available to the fusion agent between runs."
						: "Fusion persistent mode disabled: fusion tools require an active run (/fusion-run starts one).");
				},
			});
			editor.add({
				name: "fusion-config",
				description: "Show or set the Fusion executor model (executor and scout) [list [filter] | provider/model [variant]]",
				execute: async (args) => {
					if (!ctx.session.synthetic) throw new Error("This OpenCode host cannot deliver Fusion command output.");
					// The command is user-driven: no supervisor authorization, no
					// active run required, and no model call — an explicit selection
					// shares the serialized operation the fusion_configure tool uses.
					const parsed = parseConfigCommand(args.prompt?.text ?? "");
					if (parsed.action === "error") throw new Error(`${parsed.message} Usage: /fusion-config [list [filter] | <provider>/<model> [variant]]`);
					if (parsed.action === "show") return await reportCommand(args.sessionID, "Fusion config", configStatusText(args.sessionID));
					if (parsed.action === "list") return await reportCommand(args.sessionID, "Fusion config models", await listCatalogModels(parsed.filter));
					const result = await configureExecutorModel(args.sessionID, parsed);
					return await reportCommand(args.sessionID, "Fusion config", formatConfiguredModel(result));
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
			editor.add({
				name: "fusion-stop",
				description: "Stop the owned executor immediately and report observed activity (no model call)",
				async execute(args) {
					if (!ctx.session.synthetic) throw new Error("This host cannot deliver Fusion stop feedback.");
					const stop = await stopExecutor(args.sessionID, args.prompt?.text?.trim() || undefined);
					if (!stop) return reportCommand(args.sessionID, "Fusion executor stop", "No Fusion run in this session.");
					await stopNotice(args.sessionID, stop);
					return stopFeedback(stop);
				},
			});
		});
		// Embedding hosts may call this on unload. Process exit also releases SQLite locks.
		/** Dispose a native registration handle defensively: unload paths must never throw. */
		const disposeRegistration = (registration: unknown): void => {
			if (!registration || typeof (registration as { dispose?: unknown }).dispose !== "function") return;
			try { void Promise.resolve((registration as { dispose: () => unknown }).dispose()).catch(() => {}); } catch {}
		};
		return {
			close() {
				busController.abort();
				busSinks.delete(onScoutBusEvent);
				busSinks.delete(onTurnBusEvent);
				busSinks.delete(onStopBusEvent);
				scoutGuards.clear();
				settlementChains.clear();
				activeScout = undefined;
				for (const run of runs.values()) run.lease?.close();
				// Owned native registrations (agents, commands) are removed so a
				// close-without-unload cannot leave Fusion's contributions behind.
				disposeRegistration(agentRegistration);
				disposeRegistration(commandRegistration);
			},
		};
	},
};
