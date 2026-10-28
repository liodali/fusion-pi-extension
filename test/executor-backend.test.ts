import { describe, expect, test } from "bun:test";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { lastAssistantOutput, mapSessionEvent } from "../src/executor-backend.ts";

const event = (value: object): AgentSessionEvent => value as unknown as AgentSessionEvent;

describe("mapSessionEvent", () => {
	test("maps message_update thinking_start to reasoning_start", () => {
		expect(
			mapSessionEvent(
				event({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } }),
			),
		).toEqual({ type: "reasoning_start" });
	});

	test("maps message_update thinking_delta to reasoning_delta with delta", () => {
		expect(
			mapSessionEvent(
				event({
					type: "message_update",
					assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
				}),
			),
		).toEqual({ type: "reasoning_delta", delta: "hmm" });
	});

	test("maps message_update text_start to text_start", () => {
		expect(
			mapSessionEvent(
				event({ type: "message_update", assistantMessageEvent: { type: "text_start" } }),
			),
		).toEqual({ type: "text_start" });
	});

	test("maps message_update text_delta to text_delta with delta", () => {
		expect(
			mapSessionEvent(
				event({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "hello" },
				}),
			),
		).toEqual({ type: "text_delta", delta: "hello" });
	});

	test("maps message_update text_end to text_end with content", () => {
		expect(
			mapSessionEvent(
				event({
					type: "message_update",
					assistantMessageEvent: { type: "text_end", content: "done" },
				}),
			),
		).toEqual({ type: "text_end", content: "done" });
	});

	test("maps unmapped message_update sub-types to other", () => {
		expect(
			mapSessionEvent(
				event({ type: "message_update", assistantMessageEvent: { type: "toolcall_start" } }),
			),
		).toEqual({ type: "other" });
	});

	test("maps message_end to message_end", () => {
		expect(mapSessionEvent(event({ type: "message_end" }))).toEqual({ type: "message_end" });
	});

	test("maps tool_execution_start to tool_start with fields", () => {
		expect(
			mapSessionEvent(
				event({
					type: "tool_execution_start",
					toolCallId: "call-1",
					toolName: "bash",
					args: { command: "ls" },
				}),
			),
		).toEqual({ type: "tool_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } });
	});

	test("maps tool_execution_update to tool_update with partialResult", () => {
		expect(
			mapSessionEvent(
				event({
					type: "tool_execution_update",
					toolCallId: "call-1",
					toolName: "bash",
					partialResult: { output: "partial" },
				}),
			),
		).toEqual({
			type: "tool_update",
			toolCallId: "call-1",
			partialResult: { output: "partial" },
		});
	});

	test("maps tool_execution_end to tool_end with fields", () => {
		expect(
			mapSessionEvent(
				event({
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "bash",
					isError: true,
					result: { output: "boom" },
				}),
			),
		).toEqual({
			type: "tool_end",
			toolCallId: "call-1",
			toolName: "bash",
			isError: true,
			result: { output: "boom" },
		});
	});

	test("maps unrelated session events to other", () => {
		expect(mapSessionEvent(event({ type: "turn_start" }))).toEqual({ type: "other" });
	});
});

const session = (messages: object[]): AgentSession =>
	({ messages }) as unknown as AgentSession;

describe("lastAssistantOutput", () => {
	test("returns text, stopReason, and errorMessage of the last assistant message", () => {
		const output = lastAssistantOutput(
			session([
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "first" },
						{ type: "text", text: "second" },
					],
					stopReason: "stop",
				},
			]),
		);
		expect(output.text).toBe("first\nsecond");
		expect(output.stopReason).toBe("stop");
		expect(output.errorMessage).toBeUndefined();
	});

	test("picks the last assistant message, skipping trailing non-assistant messages", () => {
		const output = lastAssistantOutput(
			session([
				{
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					stopReason: "error",
					errorMessage: "boom",
				},
				{ role: "user", content: "later" },
			]),
		);
		expect(output.text).toBe("answer");
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toBe("boom");
	});

	test("returns empty text when there is no assistant message", () => {
		const output = lastAssistantOutput(session([{ role: "user", content: "hi" }]));
		expect(output.text).toBe("");
		expect(output.stopReason).toBeUndefined();
	});
});
