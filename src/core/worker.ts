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

/** Explicit capabilities prevent adapters from implying stronger recovery guarantees. */
export interface WorkerCapabilities {
	transcriptReopen: boolean;
	activeTurnReattach: boolean;
	durableExecution: boolean;
	idempotentSubmission: boolean;
	readOnlyScout: boolean;
	exactScoutToolLimit: boolean;
}
