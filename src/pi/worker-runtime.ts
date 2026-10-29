import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { WorkerConfig, WorkerHandle, WorkerModelConfig, WorkerOwner, WorkerReference, WorkerRuntime, WorkerTurnOptions, WorkerTurnRequest, WorkerTurnResult } from "../core/worker.ts";
import type { ExecutorBackend, ExecutorConfig, ExecutorHandle, ExecutorTurnResult } from "./executor-backend.ts";
import { piWorkerReference, piWorkerUsage } from "./worker-translation.ts";

export interface PiWorkerRuntime extends WorkerRuntime {
	/** Wrap a host-owned executor; construct this runtime with disposeBackend: false. */
	adoptExecutor(owner: WorkerOwner, config: WorkerConfig, native: ExecutorHandle): WorkerHandle;
	nativeResult(result: WorkerTurnResult): ExecutorTurnResult | undefined;
}

const levels: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function thinking(variant: string | undefined): ThinkingLevel {
	if (!variant || !levels.includes(variant)) throw new Error("A valid Pi thinking level is required.");
	return variant as ThinkingLevel;
}

type PiHandle = WorkerHandle & {
	config: WorkerConfig;
	nativeConfig: ExecutorConfig;
	native?: ExecutorHandle;
	ownsNative: boolean;
	active: boolean;
	released: boolean;
	abortController?: AbortController;
};

/** Adapt one Pi backend. Model resolution and backend lifetime stay in the Pi host. */
export function createPiWorkerRuntime(backend: ExecutorBackend, resolveModel: (config: WorkerModelConfig) => Model<Api>, options: { disposeBackend?: boolean } = {}): PiWorkerRuntime {
	const handles = new Set<PiHandle>();
	const nativeResults = new WeakMap<WorkerTurnResult, ExecutorTurnResult>();
	let closed = false;
	let opening = 0;
	let shuttingDown: Promise<void> | undefined;
	let shutdownStarted = false;
	let backendDisposed = false;
	let durableExecutorOpening = false;
	function checkOwner(owner: WorkerOwner): void {
		if (owner.harness !== "pi" || !owner.supervisorId || !owner.workspace) throw new Error("Invalid Pi worker owner.");
	}
	function configFor(owner: WorkerOwner, config: WorkerConfig): ExecutorConfig {
		checkOwner(owner);
		if (!config.model) throw new Error("A Pi worker model is required.");
		if (config.role === "scout" && (!Number.isSafeInteger(config.maxToolCalls) || config.maxToolCalls < 1)) throw new Error("Invalid scout tool limit.");
		const model = resolveModel(config.model);
		if (model.provider !== config.model.provider || model.id !== config.model.modelId) throw new Error("Resolved Pi model does not match worker configuration.");
		return { cwd: owner.workspace, model, thinking: thinking(config.model.variant) };
	}
	function valid(worker: WorkerHandle): PiHandle {
		const handle = worker as PiHandle;
		if (shutdownStarted || !handles.has(handle) || handle.released) throw new Error("Pi worker is unavailable.");
		return handle;
	}
	function make(owner: WorkerOwner, config: WorkerConfig, nativeConfig: ExecutorConfig, native?: ExecutorHandle, ownsNative = true): PiHandle {
		const owned = Object.freeze({ ...owner });
		const id = native?.resumeRef();
		if (native && !id) { if (ownsNative) native.dispose(); throw new Error("Pi executor reference is unavailable before submission."); }
		const reference = id ? Object.freeze(piWorkerReference(owned, backend.kind, id)) : undefined;
		if (reference) Object.freeze(reference.owner);
		const savedConfig = { ...config, model: config.model && { ...config.model } };
		const handle: PiHandle = { owner: owned, runtime: backend.kind, reference, config: savedConfig, nativeConfig, native, ownsNative, active: false, released: false };
		handles.add(handle);
		return handle;
	}
	async function turn(request: WorkerTurnRequest, options: WorkerTurnOptions, resume: boolean): Promise<WorkerTurnResult> {
		const handle = valid(request.worker);
		if (!request.runId || !request.requestId) throw new Error("Run and request IDs are required.");
		if (handle.active) throw new Error("Pi worker already has an active turn.");
		if (backend.kind === "durable" && (opening || [...handles].some((other) => other.active))) throw new Error("Pi Durable backend already has active work.");
		if (resume && (!backend.capabilities.activeTurnReattach || !handle.native)) throw new Error("Pi worker cannot reattach this turn.");
		const level = request.variant === undefined ? handle.nativeConfig.thinking : thinking(request.variant);
		handle.active = true;
		const abortController = new AbortController();
		handle.abortController = abortController;
		const forwardAbort = () => abortController.abort();
		options.signal?.addEventListener("abort", forwardAbort, { once: true });
		if (options.signal?.aborted) abortController.abort();
		const onEvent = (event: Parameters<WorkerTurnOptions["onEvent"]>[0]["event"]) => options.onEvent({ runId: request.runId, requestId: request.requestId, worker: handle, event });
		try {
			if (abortController.signal.aborted) throw new Error("Pi worker turn aborted before submission.");
			let result: ExecutorTurnResult;
			let capped = false;
			if (handle.native) {
				if (!resume) await handle.native.setThinking(level);
				if (abortController.signal.aborted) throw new Error("Pi worker turn aborted before submission.");
				const nativeOptions = { requestId: request.requestId, signal: abortController.signal, onEvent };
				result = resume ? await handle.native.resume(nativeOptions) : await handle.native.prompt(request.prompt, nativeOptions);
				if (handle.native.resumeRef() !== handle.reference?.id) throw new Error("Pi worker reference changed during the turn.");
			} else {
				if (handle.config.role !== "scout") throw new Error("Pi executor is unavailable.");
				const scout = await backend.scout({ ...handle.nativeConfig, thinking: level, prompt: request.prompt, maxToolCalls: handle.config.maxToolCalls, signal: abortController.signal, onEvent });
				result = scout;
				capped = scout.capped;
			}
			const common = { runId: request.runId, requestId: request.requestId, worker: handle, status: result.stopReason === "error" ? "error" as const : result.stopReason === "aborted" ? "cancelled" as const : "completed" as const, text: result.text, errorMessage: result.errorMessage, usage: piWorkerUsage(result.usage) };
			const translated: WorkerTurnResult = handle.config.role === "scout" ? { ...common, role: "scout", capped } : { ...common, role: "executor" };
			nativeResults.set(translated, result);
			return translated;
		} finally {
			options.signal?.removeEventListener("abort", forwardAbort);
			handle.abortController = undefined;
			handle.active = false;
		}
	}
	return {
		capabilities: backend.capabilities,
		adoptExecutor(owner, config, native) {
			if (shutdownStarted) throw new Error("Pi runtime is shut down.");
			if (options.disposeBackend !== false) throw new Error("Adopting a Pi executor requires a host-owned backend.");
			if (config.role !== "executor") throw new Error("Only a Pi executor can be adopted.");
			if ([...handles].some((handle) => handle.native === native)) throw new Error("Pi executor is already owned by a worker.");
			if (backend.kind === "durable" && (durableExecutorOpening || [...handles].some((handle) => handle.native || handle.active))) throw new Error("Pi Durable backend already has an executor or active work.");
			const nativeConfig = configFor(owner, config);
			if (!native.resumeRef()) throw new Error("Pi executor reference is unavailable before submission.");
			return make(owner, config, nativeConfig, native, false);
		},
		nativeResult(result) { return nativeResults.get(result); },
		async create(owner, config) {
			if (shutdownStarted) throw new Error("Pi runtime is shut down.");
			const nativeConfig = configFor(owner, config);
			if (backend.kind === "durable" && config.role === "executor") {
				if (durableExecutorOpening || [...handles].some((handle) => handle.native || handle.active)) throw new Error("Pi Durable backend already has an executor or active work.");
				durableExecutorOpening = true;
			}
			opening++;
			try {
				const native = config.role === "executor" ? await backend.createExecutor(nativeConfig) : undefined;
				return make(owner, config, nativeConfig, native);
			} finally { opening--; if (backend.kind === "durable" && config.role === "executor") durableExecutorOpening = false; }
		},
		async open(reference, config) {
			if (shutdownStarted || !backend.capabilities.transcriptReopen) throw new Error("Pi runtime cannot reopen transcripts.");
			if (reference.runtime !== backend.kind || !reference.id || config.role !== "executor") throw new Error("Invalid Pi worker reference.");
			const nativeConfig = configFor(reference.owner, config);
			if (backend.kind === "durable") {
				if (durableExecutorOpening || [...handles].some((handle) => handle.native || handle.active)) throw new Error("Pi Durable backend already has an executor or active work.");
				durableExecutorOpening = true;
			}
			opening++;
			try {
				const native = await backend.openExecutor(nativeConfig, reference.id);
				if (native.resumeRef() !== reference.id) { native.dispose(); throw new Error("Reopened Pi worker reference does not match."); }
				return make(reference.owner, config, nativeConfig, native);
			} finally { opening--; if (backend.kind === "durable") durableExecutorOpening = false; }
		},
		submit: (request, options) => turn(request, options, false),
		reattach: (request, options) => turn(request, options, true),
		async abort(worker) { const handle = valid(worker); handle.abortController?.abort(); if (handle.native && handle.active) await handle.native.abort(); },
		async release(worker) { const handle = valid(worker); if (handle.active) throw new Error("Cannot release an active Pi worker."); if (handle.ownsNative) handle.native?.dispose(); handle.released = true; handles.delete(handle); },
		async shutdown() {
			if (closed) return;
			if (shuttingDown) return shuttingDown;
			if (opening || [...handles].some((handle) => handle.active)) throw new Error("Cannot shut down with an active Pi worker.");
			shutdownStarted = true;
			shuttingDown = (async () => {
				const errors: unknown[] = [];
				for (const handle of handles) {
					try { if (handle.ownsNative) handle.native?.dispose(); handle.released = true; handles.delete(handle); }
					catch (error) { errors.push(error); }
				}
				if (!backendDisposed && options.disposeBackend !== false) {
					try { await backend.dispose(); backendDisposed = true; }
					catch (error) { errors.push(error); }
				}
				if (errors.length) throw new AggregateError(errors, "Pi runtime cleanup failed.");
				closed = true;
			})();
			try { await shuttingDown; } finally { shuttingDown = undefined; }
		},
	};
}
