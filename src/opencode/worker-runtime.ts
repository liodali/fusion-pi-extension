import type { WorkerConfig, WorkerHandle, WorkerOwner, WorkerReference, WorkerRuntime, WorkerTurnOptions, WorkerTurnRequest, WorkerTurnResult } from "../core/worker.ts";
import { createNativeExecutor, OPENCODE_CAPABILITIES, type NativeSubagentExecute, type NativeToolContext } from "./native-executor.ts";

const RUNTIME = "native-subagent";
type Native<C extends NativeToolContext> = ReturnType<typeof createNativeExecutor<C>>;
type Handle<C extends NativeToolContext> = WorkerHandle & {
	native: Native<C>;
	active: boolean;
	uncertain?: { runId: string; requestId: string };
	publish?: (id: string) => Promise<void>;
};

/** Reconciliation requires host-provided proof for the exact pending request. */
export interface OpenCodeWorkerRuntime extends WorkerRuntime {
	reconcile(request: WorkerTurnRequest, options: WorkerTurnOptions, wait: (childId: string, request: WorkerTurnRequest, signal: AbortSignal) => Promise<string>): Promise<WorkerTurnResult>;
}

/** The host supplies the original tool context and validates ownership on reopen. */
export function createOpenCodeWorkerRuntime<C extends NativeToolContext>(params: {
	execute: NativeSubagentExecute<C>;
	contextFor: (request: WorkerTurnRequest) => C;
	validateReference: (reference: WorkerReference) => Promise<void>;
	agent?: string;
}): OpenCodeWorkerRuntime {
	const handles = new Set<Handle<C>>();
	const openingReferences = new Set<string>();
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
	function make(owner: WorkerOwner, config: WorkerConfig, childSessionID?: string): Handle<C> {
		const owned = Object.freeze({ ...owner });
		let handle: Handle<C>;
		const native = createNativeExecutor<C>({ parentSessionID: owned.supervisorId, agent: params.agent ?? "fusion-executor", execute: params.execute, childSessionID,
			model: config.model ? `${config.model.provider}/${config.model.modelId}` : undefined,
			onReference: async (id) => { assertUnowned(id, handle); if (!handle.publish) throw new Error("No active reference persistence callback."); await handle.publish(id); },
		});
		handle = { owner: owned, runtime: RUNTIME, get reference() { return native.childSessionID ? Object.freeze({ owner: owned, runtime: RUNTIME, id: native.childSessionID }) : undefined; }, native, active: false };
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
	return {
		capabilities: OPENCODE_CAPABILITIES,
		async create(owner, config) { if (closed) throw new Error("OpenCode runtime is shut down."); check(owner, config); return make(owner, config); },
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
			if (handle.active || handle.uncertain) throw new Error("OpenCode worker is active or its outcome is uncertain.");
			const ctx = context(request, options);
			if (ctx.signal.aborted) throw new Error("OpenCode worker turn was cancelled before submission.");
			handle.active = true;
			handle.publish = async (id) => { await options.onReference({ owner: handle.owner, runtime: RUNTIME, id }); };
			try {
				const output = await handle.native.prompt(request.prompt, request.requestId, ctx);
				return result(request, output.output);
			} catch (error) { handle.uncertain = { runId: request.runId, requestId: request.requestId }; throw error; }
			finally { handle.active = false; handle.publish = undefined; }
		},
		async reattach() { throw new Error("OpenCode active-turn reattachment is not supported; reconcile proven background completion instead."); },
		async reconcile(request, options, wait) {
			const handle = valid(request.worker);
			if (handle.active || !handle.uncertain || handle.uncertain.runId !== request.runId || handle.uncertain.requestId !== request.requestId) throw new Error("No matching uncertain OpenCode request.");
			if (!handle.native.backgroundPending || !handle.reference) throw new Error("No background completion is available for reconciliation.");
			const ctx = context(request, options);
			handle.active = true;
			try {
				await options.onReference(handle.reference);
				handle.native.markReferencePublished();
				const output = await handle.native.settleBackground(ctx, (child, signal) => wait(child, request, signal));
				handle.uncertain = undefined;
				return result(request, output.output);
			} finally { handle.active = false; }
		},
		async abort(worker) { valid(worker); throw new Error("OpenCode worker abort is not supported; use the host tool signal."); },
		async release(worker) { const handle = valid(worker); if (handle.active || handle.uncertain) throw new Error("Cannot release an active or uncertain OpenCode worker."); handles.delete(handle); },
		async shutdown() { if (closed) return; if (opening || [...handles].some((h) => h.active || h.uncertain)) throw new Error("Cannot shut down with active or uncertain OpenCode workers."); closed = true; handles.clear(); },
	};
}
