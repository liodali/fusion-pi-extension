import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { createDurableEventMapper } from "../src/pi/durable/events.ts";
import { lastAssistantOutputFromMessages } from "../src/executor-backend.ts";

const event = (value: object): AgentEvent => value as unknown as AgentEvent;

const update = (changes: object[]): AgentEvent =>
	event({ type: "message_update", usage: {}, changes });

describe("createDurableEventMapper", () => {
	test("maps thinking_start change to reasoning_start", () => {
		const map = createDurableEventMapper();
		expect(
			map(update([{ type: "thinking_start", contentIndex: 0, block: { type: "thinking" } }])),
		).toEqual([{ type: "reasoning_start" }]);
	});

	test("maps thinking_delta change to reasoning_delta with delta", () => {
		const map = createDurableEventMapper();
		expect(
			map(update([{ type: "thinking_delta", contentIndex: 0, delta: "hmm" }])),
		).toEqual([{ type: "reasoning_delta", delta: "hmm" }]);
	});

	test("maps text_start change to text_start", () => {
		const map = createDurableEventMapper();
		expect(
			map(update([{ type: "text_start", contentIndex: 0, block: { type: "text" } }])),
		).toEqual([{ type: "text_start" }]);
	});

	test("maps text_delta change to text_delta with delta", () => {
		const map = createDurableEventMapper();
		expect(
			map(update([{ type: "text_delta", contentIndex: 0, delta: "hi" }])),
		).toEqual([{ type: "text_delta", delta: "hi" }]);
	});

	test("maps text block change to text_end with content", () => {
		const map = createDurableEventMapper();
		expect(
			map(update([{ type: "block", contentIndex: 0, block: { type: "text", text: "done" } }])),
		).toEqual([{ type: "text_end", content: "done" }]);
	});

	test("ignores non-text block changes and falls back to other", () => {
		const map = createDurableEventMapper();
		expect(
			map(update([{ type: "block", contentIndex: 0, block: { type: "thinking" } }])),
		).toEqual([{ type: "other" }]);
	});

	test("maps multiple changes in one update to multiple events", () => {
		const map = createDurableEventMapper();
		expect(
			map(
				update([
					{ type: "text_delta", contentIndex: 0, delta: "a" },
					{ type: "block", contentIndex: 0, block: { type: "text", text: "ab" } },
					{ type: "toolcall_delta", contentIndex: 1, path: ["arguments"], delta: "{}" },
				]),
			),
		).toEqual([
			{ type: "text_delta", delta: "a" },
			{ type: "text_end", content: "ab" },
		]);
	});

	test("maps message_end to message_end", () => {
		const map = createDurableEventMapper();
		expect(map(event({ type: "message_end", entry: { id: "e1" } }))).toEqual([
			{ type: "message_end" },
		]);
	});

	test("maps tool_execution_start to tool_start with fields", () => {
		const map = createDurableEventMapper();
		expect(
			map(
				event({
					type: "tool_execution_start",
					toolCallId: "call-1",
					toolName: "bash",
					args: { command: "ls" },
				}),
			),
		).toEqual([
			{ type: "tool_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } },
		]);
	});

	test("accumulates tool_execution_update appends into partialResult", () => {
		const map = createDurableEventMapper();
		const first = map(
			event({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				output: { append: "abc" },
			}),
		);
		expect(first).toEqual([
			{
				type: "tool_update",
				toolCallId: "call-1",
				partialResult: { content: [{ type: "text", text: "abc" }] },
			},
		]);
		const second = map(
			event({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				output: { append: "def" },
			}),
		);
		expect(second).toEqual([
			{
				type: "tool_update",
				toolCallId: "call-1",
				partialResult: { content: [{ type: "text", text: "abcdef" }] },
			},
		]);
	});

	test("applies trimStart then append to the retained buffer", () => {
		const map = createDurableEventMapper();
		map(
			event({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				output: { set: "abcdef" },
			}),
		);
		const trimmed = map(
			event({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				output: { trimStart: 2, append: "z" },
			}),
		);
		expect(trimmed).toEqual([
			{
				type: "tool_update",
				toolCallId: "call-1",
				partialResult: { content: [{ type: "text", text: "cdefz" }] },
			},
		]);
	});

	test("set replaces the retained buffer", () => {
		const map = createDurableEventMapper();
		map(
			event({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				output: { append: "old" },
			}),
		);
		const replaced = map(
			event({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				output: { set: "fresh" },
			}),
		);
		expect(replaced).toEqual([
			{
				type: "tool_update",
				toolCallId: "call-1",
				partialResult: { content: [{ type: "text", text: "fresh" }] },
			},
		]);
	});

	test("maps tool_execution_update without output to other", () => {
		const map = createDurableEventMapper();
		expect(
			map(
				event({
					type: "tool_execution_update",
					toolCallId: "call-1",
					toolName: "bash",
					details: { x: 1 },
				}),
			),
		).toEqual([{ type: "other" }]);
	});

	test("maps tool_execution_end with an erroring entry to tool_end", () => {
		const map = createDurableEventMapper();
		expect(
			map(
				event({
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "bash",
					entry: {
						id: "e1",
						model: [
							{
								role: "toolResult",
								isError: true,
								content: [{ type: "text", text: "boom" }],
							},
						],
					},
				}),
			),
		).toEqual([
			{
				type: "tool_end",
				toolCallId: "call-1",
				toolName: "bash",
				isError: true,
				result: { content: [{ type: "text", text: "boom" }] },
			},
		]);
	});

	test("maps tool_execution_end without entry to an erroring tool_end and resets the buffer", () => {
		const map = createDurableEventMapper();
		map(
			event({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				output: { append: "stale" },
			}),
		);
		expect(
			map(
				event({
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "bash",
				}),
			),
		).toEqual([
			{
				type: "tool_end",
				toolCallId: "call-1",
				toolName: "bash",
				isError: true,
				result: undefined,
			},
		]);
		const after = map(
			event({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				output: { append: "new" },
			}),
		);
		expect(after).toEqual([
			{
				type: "tool_update",
				toolCallId: "call-1",
				partialResult: { content: [{ type: "text", text: "new" }] },
			},
		]);
	});

	test("maps unrelated durable events to other", () => {
		const map = createDurableEventMapper();
		expect(map(event({ type: "turn_start" }))).toEqual([{ type: "other" }]);
	});
});

describe("lastAssistantOutputFromMessages", () => {
	test("returns text, stopReason, and errorMessage of the last assistant message", () => {
		const messages = [
			{ role: "user", content: "hi" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
				stopReason: "error",
				errorMessage: "boom",
			},
			{ role: "user", content: "later" },
		] as unknown as Message[];
		const output = lastAssistantOutputFromMessages(messages);
		expect(output.text).toBe("first\nsecond");
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toBe("boom");
	});
});
