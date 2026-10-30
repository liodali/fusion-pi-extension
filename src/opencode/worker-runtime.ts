import type { ExecutorEvent, WorkerConfig, WorkerHandle, WorkerOwner, WorkerReference, WorkerRuntime, WorkerTurnOptions, WorkerTurnRequest, WorkerTurnResult, WorkerUsage } from "../core/worker.ts";
import { createNativeExecutor, OPENCODE_CAPABILITIES, type NativeSubagentExecute, type NativeToolContext } from "./native-executor.ts";

const RUNTIME = "native-subagent";
type Native<C extends NativeToolContext> = ReturnType<typeof createNativeExecutor<C>>;
type Handle<C extends NativeToolContext> = WorkerHandle & {
	native: Native<C>;
	active: boolean;
	/** True when this runtime spawned the child; opened references may carry unobserved history. */
	createdFresh: boolean;
	backgrounded: boolean;
	uncertain?: { runId: string; requestId: string };
	unsettled?: WorkerTurnResult;
	publish?: (id: string) => Promise<void>;
};

/** One raw host bus event, as pinned from OpenCode v2.2.2 (`GET /api/event` and the plugin `ctx.event.subscribe` stream). */
export interface OpenCodeBusEvent {
	/** Stable native identity (`evt_...`); the controller deduplicates repeats. */
	id?: string;
	/** Server timestamp (epoch ms); events created before the active turn started are prior-turn replays. */
	created?: number;
	type: string;
	/** Event payload; `sessionID` routes every session-scoped event. */
	data?: Record<string, unknown>;
}

/** Reconciliation requires host-provided proof for the exact pending request. */
export interface OpenCodeWorkerRuntime extends WorkerRuntime {
	/** Restore saved intent without starting or reattaching to native work. */
	restorePending(owner: WorkerOwner, config: WorkerConfig, pending: { runId: string; requestId: string }, reference?: WorkerReference): Promise<WorkerHandle>;
	/** Persist a completed foreground result before permitting another turn. */
	settle(request: WorkerTurnRequest, persistSettlement: (result: WorkerTurnResult) => Promise<void>): Promise<WorkerTurnResult>;
	status(worker: WorkerHandle): { uncertain: boolean; unsettled: boolean; backgroundPending: boolean; backgrounded: boolean };
	reconcile(request: WorkerTurnRequest, options: WorkerTurnOptions, wait: (childId: string, request: WorkerTurnRequest, signal: AbortSignal) => Promise<{ status: "completed" | "error" | "cancelled"; text: string }>, persistSettlement: (result: WorkerTurnResult) => Promise<void>): Promise<WorkerTurnResult>;
	/** Feed one raw host bus event into this runtime's owned-child routing. */
	ingestBusEvent(event: OpenCodeBusEvent): void;
}

/**
 * The host supplies the original tool context and validates ownership on reopen.
 * `interrupt` is the host's native session interruption (session.interrupt in
 * OpenCode v2); when absent, aborting an owned child is unsupported and the
 * adapter must say so instead of implying the control exists. `bus` is the
 * host's event fan-out (one plugin subscription, many consumers); when absent,
 * owned-child streaming and usage accounting are unavailable and the adapter
 * reports that honestly instead of implying the events exist.
 */
export function createOpenCodeWorkerRuntime<C extends NativeToolContext>(params: {
	execute: NativeSubagentExecute<C>;
	contextFor: (request: WorkerTurnRequest) => C;
	validateReference: (reference: WorkerReference) => Promise<void>;
	interrupt?: (childSessionID: string) => Promise<unknown>;
	agent?: string;
	bus?: { add(sink: (event: OpenCodeBusEvent) => void): () => void };
}): OpenCodeWorkerRuntime {
	type ActiveTurn = { request: WorkerTurnRequest; options: WorkerTurnOptions; startedAt: number; baseline?: WorkerUsage; baselineVerified: boolean; sawUsage?: boolean; toolNames: Map<string, string> };
	const handles = new Set<Handle<C>>();
	const openingReferences = new Set<string>();
	/** Active turns keyed by owned child session; events for other sessions are ignored. */
	const activeTurns = new Map<string, ActiveTurn>();
	/** Last cumulative per-session reading (`session.usage.updated` is monotonic per session). */
	const usageByChild = new Map<string, WorkerUsage>();
	/** Server timestamp and native ids of accepted readings; replays must not regress or re-prove usage. */
	const usageCreated = new Map<string, number>();
	const usageEventIds = new Map<string, Set<string>>();
	/** Child sessions that already started a turn in this runtime; only their first turn may treat a missing baseline as zero history. */
	const startedTurns = new Set<string>();
	const referenceKey = (id: string) => id;
	function assertUnowned(id: string, except?: Handle<C>): void {
		if (openingReferences.has(referenceKey(id)) || [...handles].some((handle) => handle !== except && handle.reference?.id === id)) {
			throw new Error("OpenCode child is already owned by another worker.");
		}
	}
	let closed = false;
	let opening = 0;
	function valid(worker: WorkerHandle): Handle<C> {
		const handle = worker as Handle<C>;
		if (closed || !handles.has(handle)) throw new Error("OpenCode worker is unavailable.");
		return handle;
	}
	function check(owner: WorkerOwner, config: WorkerConfig): void {
		if (owner.harness !== "opencode" || !owner.supervisorId || !owner.workspace) throw new Error("Invalid OpenCode worker owner.");
		if (config.role !== "executor") throw new Error("OpenCode scout is not supported.");
		if (config.model?.variant) throw new Error("OpenCode model variants are not supported by this adapter.");
		if (config.model && (!config.model.provider || !config.model.modelId)) throw new Error("Invalid OpenCode worker model.");
	}
	function make(owner: WorkerOwner, config: WorkerConfig, childSessionID?: string, pending?: { runId: string; requestId: string }): Handle<C> {
		const owned = Object.freeze({ ...owner });
		let handle: Handle<C>;
		const native = createNativeExecutor<C>({ parentSessionID: owned.supervisorId, agent: params.agent ?? "fusion-executor", execute: params.execute, childSessionID, pending: !!pending && !!childSessionID,
			model: config.model ? `${config.model.provider}/${config.model.modelId}` : undefined,
			onReference: async (id) => { assertUnowned(id, handle); if (!handle.publish) throw new Error("No active reference persistence callback."); await handle.publish(id); },
		});
		handle = { owner: owned, runtime: RUNTIME, get reference() { return native.childSessionID ? Object.freeze({ owner: owned, runtime: RUNTIME, id: native.childSessionID }) : undefined; }, native, active: false, createdFresh: !childSessionID, backgrounded: !!pending && !!childSessionID, uncertain: pending && { ...pending } };
		handles.add(handle);
		return handle;
	}
	function context(request: WorkerTurnRequest, options: WorkerTurnOptions): C {
		const original = params.contextFor(request);
		if (original.sessionID !== request.worker.owner.supervisorId) throw new Error("OpenCode tool context belongs to a different supervisor.");
		return options.signal ? { ...original, signal: AbortSignal.any([original.signal, options.signal]) } : original;
	}
	function result(request: WorkerTurnRequest, text: string): WorkerTurnResult {
		return { runId: request.runId, requestId: request.requestId, worker: request.worker, role: "executor", status: "completed", text };
	}
	/** The delta of cumulative readings; any regression means the accounting model
	 * broke (e.g. a host-side reset), so the turn's usage stays unknown. */
	function usageDelta(final: WorkerUsage | undefined, baseline: WorkerUsage | undefined): WorkerUsage | undefined {
		if (!final) return undefined;
		if (!baseline) return final;
		const subtract = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? undefined : a - b);
		const delta = {
			inputTokens: subtract(final.inputTokens, baseline.inputTokens),
			outputTokens: subtract(final.outputTokens, baseline.outputTokens),
			cacheReadTokens: subtract(final.cacheReadTokens, baseline.cacheReadTokens),
			cacheWriteTokens: subtract(final.cacheWriteTokens, baseline.cacheWriteTokens),
			reasoningTokens: subtract(final.reasoningTokens, baseline.reasoningTokens),
			cost: subtract(final.cost, baseline.cost),
		};
		const negative = [delta.inputTokens, delta.outputTokens, delta.cacheReadTokens, delta.cacheWriteTokens, delta.reasoningTokens, delta.cost].some((value) => value !== undefined && value < 0);
		return negative ? undefined : delta;
	}
	function parseUsage(data: Record<string, unknown>): WorkerUsage | undefined {
		const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens as Record<string, unknown> : undefined;
		const cache = tokens?.cache && typeof tokens.cache === "object" ? tokens.cache as Record<string, unknown> : undefined;
		if (!tokens) return undefined;
		const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
		return {
			inputTokens: num(tokens.input),
			outputTokens: num(tokens.output),
			cacheReadTokens: num(cache?.read),
			cacheWriteTokens: num(cache?.write),
			reasoningTokens: num(tokens.reasoning),
			cost: num(data.cost),
		};
	}
	/** Map one pinned bus event to the shared contract; unmapped kinds stay silent. */
	function mapExecutorEvent(type: string, data: Record<string, unknown>, turn: { toolNames: Map<string, string> }): ExecutorEvent | undefined {
		switch (type) {
			case "session.reasoning.started": return { type: "reasoning_start" };
			case "session.reasoning.delta": return typeof data.delta === "string" ? { type: "reasoning_delta", delta: data.delta } : undefined;
			// `session.reasoning.ended` carries the full private reasoning content; the
			// contract has no kind for it and private reasoning is never surfaced.
			case "session.text.started": return { type: "text_start" };
			case "session.text.delta": return typeof data.delta === "string" ? { type: "text_delta", delta: data.delta } : undefined;
			case "session.text.ended": return typeof data.text === "string" ? { type: "text_end", content: data.text } : undefined;
			case "session.tool.input.started": {
				if (typeof data.id === "string" && typeof data.name === "string") turn.toolNames.set(data.id, data.name);
				return undefined;
			}
			case "session.tool.called": {
				if (typeof data.id !== "string") return undefined;
				return { type: "tool_start", toolCallId: data.id, toolName: turn.toolNames.get(data.id) ?? "unknown", args: data.input };
			}
			case "session.tool.progress": {
				if (typeof data.id !== "string") return undefined;
				return { type: "tool_update", toolCallId: data.id, partialResult: data.metadata };
			}
			case "session.tool.success":
			case "session.tool.failed": {
				if (typeof data.id !== "string") return undefined;
				const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata as Record<string, unknown> : undefined;
				return { type: "tool_end", toolCallId: data.id, toolName: turn.toolNames.get(data.id) ?? "unknown", isError: type === "session.tool.failed" || metadata?.error === true, result: data.content };
			}
			default: return undefined;
		}
	}
	/** Route one raw host bus event to owned active turns; everything else is silent. */
	function ingestBusEvent(event: OpenCodeBusEvent): void {
		if (closed || !event || typeof event !== "object") return;
		const data = event.data && typeof event.data === "object" ? event.data : undefined;
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type || !data || typeof data.sessionID !== "string") return;
		const childID = data.sessionID;
		const created = typeof event.created === "number" ? event.created : undefined;
		const turn = activeTurns.get(childID);
		// Events created before this turn started belong to a previous turn; a replay
		// delivered under the active request would misattribute prior-turn work.
		const priorTurn = created !== undefined && turn !== undefined && created < turn.startedAt;
		if (type === "session.usage.updated") {
			const usage = parseUsage(data);
			if (usage) {
				let seen = usageEventIds.get(childID);
				if (!seen) { seen = new Set(); usageEventIds.set(childID, seen); }
				const duplicate = typeof event.id === "string" && seen.has(event.id);
				const lastCreated = usageCreated.get(childID);
				const stale = created !== undefined && lastCreated !== undefined && created < lastCreated;
				if (!duplicate && !stale) {
					if (typeof event.id === "string") seen.add(event.id);
					usageByChild.set(childID, usage);
					if (created !== undefined) usageCreated.set(childID, created);
					if (turn && !priorTurn) turn.sawUsage = true;
				}
			}
			return;
		}
		if (!turn || priorTurn) return;
		const mapped = mapExecutorEvent(type, data, turn);
		if (!mapped) return;
		turn.options.onEvent({
			runId: turn.request.runId,
			requestId: turn.request.requestId,
			worker: turn.request.worker,
			nativeEventId: typeof event.id === "string" ? event.id : undefined,
			event: mapped,
		});
	}
	const unregisterBus = params.bus?.add(ingestBusEvent);
	return {
		capabilities: { ...OPENCODE_CAPABILITIES, workerAbort: !!params.interrupt, workerEvents: !!params.bus },
		async create(owner, config) { if (closed) throw new Error("OpenCode runtime is shut down."); check(owner, config); return make(owner, config); },
		async restorePending(owner, config, pending, reference) {
			if (closed) throw new Error("OpenCode runtime is shut down.");
			check(owner, config);
			if (!pending.runId?.trim() || !pending.requestId?.trim()) throw new Error("Pending run and request IDs are required.");
			const savedOwner = Object.freeze({ ...owner });
			const savedPending = { ...pending };
			if (!reference) return make(savedOwner, config, undefined, savedPending);
			if (reference.runtime !== RUNTIME || !reference.id || reference.owner.harness !== owner.harness || reference.owner.supervisorId !== owner.supervisorId || reference.owner.workspace !== owner.workspace) throw new Error("Invalid OpenCode worker reference.");
			const saved = Object.freeze({ owner: savedOwner, runtime: RUNTIME, id: reference.id });
			assertUnowned(saved.id);
			openingReferences.add(referenceKey(saved.id)); opening++;
			try {
				await params.validateReference(saved);
				if ([...handles].some((handle) => handle.reference?.id === saved.id)) throw new Error("OpenCode child is already owned by another worker.");
				return make(savedOwner, config, saved.id, savedPending);
			} finally { opening--; openingReferences.delete(referenceKey(saved.id)); }
		},
		async open(reference, config) {
			if (closed) throw new Error("OpenCode runtime is shut down.");
			check(reference.owner, config);
			if (reference.runtime !== RUNTIME || !reference.id) throw new Error("Invalid OpenCode worker reference.");
			const saved = Object.freeze({ owner: Object.freeze({ ...reference.owner }), runtime: reference.runtime, id: reference.id });
			assertUnowned(saved.id);
			openingReferences.add(referenceKey(saved.id));
			opening++;
			try {
				await params.validateReference(saved);
				if ([...handles].some((handle) => handle.reference?.id === saved.id)) throw new Error("OpenCode child is already owned by another worker.");
				return make(saved.owner, config, saved.id);
			} finally { opening--; openingReferences.delete(referenceKey(saved.id)); }
		},
		async submit(request, options) {
			const handle = valid(request.worker);
			if (!request.runId || !request.requestId || !request.prompt.trim()) throw new Error("Run, request, and prompt are required.");
			if (request.variant) throw new Error("OpenCode per-turn variants are not supported.");
			if (handle.active || handle.uncertain || handle.unsettled) throw new Error("OpenCode worker is active or its outcome is uncertain or unsettled.");
			const ctx = context(request, options);
			if (ctx.signal.aborted) throw new Error("OpenCode worker turn was cancelled before submission.");
			const startedAt = Date.now();
			handle.active = true;
			let registeredChild: string | undefined;
			let registeredTurn: ActiveTurn | undefined;
			const register = (childID: string) => {
				registeredChild = childID;
				// A missing baseline only proves zero history when this runtime spawned
				// the child and no earlier turn ran here; reopened references may carry
				// unobserved usage, so their first turn reports unknown instead.
				const firstTurn = !startedTurns.has(childID);
				startedTurns.add(childID);
				const baseline = usageByChild.get(childID);
				registeredTurn = { request, options, startedAt, baseline, baselineVerified: baseline !== undefined || (firstTurn && handle.createdFresh), toolNames: new Map() };
				activeTurns.set(childID, registeredTurn);
			};
			const existingChild = handle.reference?.id;
			if (existingChild) register(existingChild);
			handle.publish = async (id) => { if (!registeredChild) register(id); await options.onReference({ owner: handle.owner, runtime: RUNTIME, id }); };
			try {
				const output = await handle.native.prompt(request.prompt, request.requestId, ctx);
				// Only a reading observed during this turn proves this turn's usage, and
				// only a verified baseline (or a provably fresh child) makes the
				// cumulative reading attributable; anything else stays unknown.
				const usage = registeredTurn?.sawUsage && registeredTurn.baselineVerified ? usageDelta(usageByChild.get(output.sessionID), registeredTurn.baseline) : undefined;
				const completed = Object.freeze({ ...result(request, output.output), ...(usage ? { usage } : {}) });
				handle.unsettled = completed;
				return completed;
			} catch (error) { handle.uncertain = { runId: request.runId, requestId: request.requestId }; handle.backgrounded = handle.native.backgroundPending; handle.native.markPending(); throw error; }
			finally { handle.active = false; handle.publish = undefined; if (registeredChild) activeTurns.delete(registeredChild); }
		},
		async reattach() { throw new Error("OpenCode active-turn reattachment is not supported; reconcile proven background completion instead."); },
		status(worker) { const handle = valid(worker); return { uncertain: !!handle.uncertain, unsettled: !!handle.unsettled, backgroundPending: handle.native.backgroundPending, backgrounded: handle.backgrounded }; },
		async settle(request, persistSettlement) {
			const handle = valid(request.worker);
			const completed = handle.unsettled;
			if (handle.active || !completed || completed.runId !== request.runId || completed.requestId !== request.requestId) throw new Error("No matching unsettled OpenCode result.");
			handle.active = true;
			try {
				await persistSettlement(completed);
				handle.unsettled = undefined;
				return completed;
			} finally { handle.active = false; }
		},
		async reconcile(request, options, wait, persistSettlement) {
			const handle = valid(request.worker);
			if (handle.active || !handle.uncertain || handle.uncertain.runId !== request.runId || handle.uncertain.requestId !== request.requestId) throw new Error("No matching uncertain OpenCode request.");
			if (!handle.native.backgroundPending || !handle.reference) throw new Error("No background completion is available for reconciliation.");
			const ctx = context(request, options);
			handle.active = true;
			try {
				await options.onReference(handle.reference);
				handle.native.markReferencePublished();
				let terminal: { status: "completed" | "error" | "cancelled"; text: string } | undefined;
				const output = await handle.native.settleBackground(ctx, async (child, signal) => { terminal = await wait(child, request, signal); if (!terminal || !["completed", "error", "cancelled"].includes(terminal.status) || typeof terminal.text !== "string") throw new Error("Invalid OpenCode completion proof."); return terminal.text; });
				const settled: WorkerTurnResult = { ...result(request, output.output), role: "executor", status: terminal!.status };
				try { await persistSettlement(settled); } catch (error) { handle.native.markPending(); throw error; }
				handle.uncertain = undefined;
				handle.backgrounded = false;
				return settled;
			} finally { handle.active = false; }
		},
		async abort(worker) {
			const handle = valid(worker);
			if (!params.interrupt) throw new Error("OpenCode worker abort is unavailable: the host does not expose session interruption.");
			if (!handle.reference) throw new Error("OpenCode worker has no native child session to interrupt.");
			await params.interrupt(handle.reference.id);
		},
		async release(worker) { const handle = valid(worker); if (handle.active || handle.uncertain || handle.unsettled) throw new Error("Cannot release an active, uncertain or unsettled OpenCode worker."); handles.delete(handle); },
		async shutdown() { if (closed) return; if (opening || [...handles].some((h) => h.active || h.uncertain || h.unsettled)) throw new Error("Cannot shut down with active, uncertain or unsettled OpenCode workers."); unregisterBus?.(); closed = true; handles.clear(); },
		ingestBusEvent,
	};
}
