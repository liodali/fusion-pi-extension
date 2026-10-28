import type { AgentEvent } from "@earendil-works/pi-durable";
import type { ExecutorEvent } from "../../core/worker.ts";

export function createDurableEventMapper(): (event: AgentEvent) => ExecutorEvent[] {
	const toolOutput = new Map<string, string>();
	return (event) => {
		if (event.type === "message_update") {
			const mapped: ExecutorEvent[] = [];
			for (const change of event.changes) {
				if (change.type === "thinking_start") {
					mapped.push({ type: "reasoning_start" });
				} else if (change.type === "thinking_delta") {
					mapped.push({ type: "reasoning_delta", delta: change.delta });
				} else if (change.type === "text_start") {
					mapped.push({ type: "text_start" });
				} else if (change.type === "text_delta") {
					mapped.push({ type: "text_delta", delta: change.delta });
				} else if (change.type === "block" && change.block.type === "text") {
					mapped.push({ type: "text_end", content: change.block.text });
				}
			}
			return mapped.length === 0 ? [{ type: "other" }] : mapped;
		}
		if (event.type === "message_end") {
			return [{ type: "message_end" }];
		}
		if (event.type === "tool_execution_start") {
			return [
				{
					type: "tool_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				},
			];
		}
		if (event.type === "tool_execution_update") {
			if (event.output === undefined) {
				return [{ type: "other" }];
			}
			const buffer =
				"set" in event.output
					? event.output.set
					: (toolOutput.get(event.toolCallId) ?? "").slice(event.output.trimStart ?? 0) +
						(event.output.append ?? "");
			toolOutput.set(event.toolCallId, buffer);
			return [
				{
					type: "tool_update",
					toolCallId: event.toolCallId,
					partialResult: { content: [{ type: "text", text: buffer }] },
				},
			];
		}
		if (event.type === "tool_execution_end") {
			const message = event.entry?.model?.[0] as
				| { isError?: boolean; content?: unknown }
				| undefined;
			toolOutput.delete(event.toolCallId);
			return [
				{
					type: "tool_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					isError: event.entry === undefined || message?.isError === true,
					result: message === undefined ? undefined : { content: message.content },
				},
			];
		}
		return [{ type: "other" }];
	};
}
