/** Stable Fusion identities are separate from identifiers allocated by a host. */
export interface WorkerOwner {
	harness: string;
	supervisorId: string;
	workspace: string;
}

/** An opaque native reference is meaningful only within its runtime and owner. */
export interface WorkerReference {
	owner: WorkerOwner;
	runtime: string;
	id: string;
}

/**
 * Process-local handle; a lazily created worker has no native reference yet.
 * A reference already present after create/open is persisted by the caller
 * before submission; later references are delivered through onReference.
 */
export interface WorkerHandle {
	readonly owner: WorkerOwner;
	readonly runtime: string;
	readonly reference?: WorkerReference;
}

export interface WorkerModelConfig {
	provider: string;
	modelId: string;
	/** Host-specific thinking level or variant, when configured. */
	variant?: string;
}

export type WorkerConfig =
	| { role: "executor"; model?: WorkerModelConfig }
	| { role: "scout"; model?: WorkerModelConfig; maxToolCalls: number };

export interface WorkerTurnRequest {
	runId: string;
	requestId: string;
	worker: WorkerHandle;
	prompt: string;
	/** Per-turn override; the meaning of a variant belongs to the host adapter. */
	variant?: string;
}

/** Missing accounting fields mean unknown, not zero. Costs use the host's currency. */
export interface WorkerUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	cost?: number;
}

interface WorkerTurnResultBase {
	runId: string;
	requestId: string;
	worker: WorkerHandle;
	/** Native identity, if the host exposes one; it is not settlement evidence. */
	nativeTurnId?: string;
	status: "completed" | "error" | "cancelled";
	text: string;
	errorMessage?: string;
	usage?: WorkerUsage;
}

/** `capped` reports that the scout hit its limit; exact enforcement is a capability. */
export type WorkerTurnResult = WorkerTurnResultBase & (
	| { role: "executor" }
	| { role: "scout"; capped: boolean }
);

/** Worker activity emitted to the Fusion controller and presentation adapters. */
export type ExecutorEvent =
	| { type: "reasoning_start" }
	| { type: "reasoning_delta"; delta: string }
	| { type: "text_start" }
	| { type: "text_delta"; delta: string }
	| { type: "text_end"; content: string }
	| { type: "message_end" }
	| { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_update"; toolCallId: string; partialResult: unknown }
	| { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; result: unknown }
	| { type: "other" };

export interface WorkerEvent {
	runId: string;
	requestId: string;
	worker: WorkerHandle;
	nativeTurnId?: string;
	nativeEventId?: string;
	event: ExecutorEvent;
}

export interface WorkerTurnOptions {
	signal?: AbortSignal;
	onEvent: (event: WorkerEvent) => void;
	/**
	 * Called when submission or reattachment first reveals a native reference.
	 * The adapter awaits this before returning or forwarding that native progress,
	 * so the caller can persist it. Rejection leaves the outcome unknown. The
	 * reference must belong to the handle's owner and runtime and cannot change.
	 */
	onReference: (reference: WorkerReference) => Promise<void>;
}

/** Host resources and native tool contexts remain inside the runtime adapter. */
export interface WorkerRuntime {
	readonly capabilities: WorkerCapabilities;
	create(owner: WorkerOwner, config: WorkerConfig): Promise<WorkerHandle>;
	open(reference: WorkerReference, config: WorkerConfig): Promise<WorkerHandle>;
	submit(request: WorkerTurnRequest, options: WorkerTurnOptions): Promise<WorkerTurnResult>;
	reattach(request: WorkerTurnRequest, options: WorkerTurnOptions): Promise<WorkerTurnResult>;
	abort(worker: WorkerHandle): Promise<void>;
	/** Release local resources without deleting the transcript or implying settlement. */
	release(worker: WorkerHandle): Promise<void>;
	/** Close runtime resources without deleting transcripts or assuming turns settled. */
	shutdown(): Promise<void>;
}

/** Explicit capabilities prevent adapters from implying stronger recovery guarantees. */
export interface WorkerCapabilities {
	transcriptReopen: boolean;
	activeTurnReattach: boolean;
	durableExecution: boolean;
	idempotentSubmission: boolean;
	readOnlyScout: boolean;
	exactScoutToolLimit: boolean;
	/** The runtime can interrupt a native child turn it owns; absence means unsupported. */
	workerAbort: boolean;
}
