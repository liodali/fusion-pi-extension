import { describe, expect, test } from "bun:test";
import {
	appendProgressEntry,
	formatProgressTranscript,
	MAX_PROGRESS_CHARS,
	summarizeToolResult,
	truncateInline,
} from "../src/progress.ts";

describe("truncateInline", () => {
	test("collapses whitespace and trims", () => {
		expect(truncateInline("  alpha\n\n beta \t gamma  ")).toBe("alpha beta gamma");
	});

	test("truncates long values with an ellipsis", () => {
		const value = "x".repeat(300);
		const result = truncateInline(value);
		expect(result.length).toBe(240);
		expect(result.endsWith("…")).toBe(true);
	});
});

describe("formatProgressTranscript", () => {
	test("joins entries chronologically and appends live text", () => {
		const transcript = formatProgressTranscript(
			["[tool] read src/index.ts", "[done] read"],
			"partial report text",
		);
		expect(transcript).toBe("[tool] read src/index.ts\n\n[done] read\n\npartial report text");
	});

	test("returns empty string when nothing is available", () => {
		expect(formatProgressTranscript([], "")).toBe("");
	});
});

describe("appendProgressEntry", () => {
	test("appends trimmed entries and discards oldest past the bound", () => {
		let entries: string[] = [];
		entries = appendProgressEntry(entries, "  first  ", 15);
		entries = appendProgressEntry(entries, "second", 15);
		entries = appendProgressEntry(entries, "third", 15);
		expect(entries).toEqual(["second", "third"]);
	});

	test("ignores empty entries", () => {
		expect(appendProgressEntry(["kept"], "   ", 100)).toEqual(["kept"]);
	});

	test("retains the newest tail of an oversized single entry", () => {
		const entries = appendProgressEntry([], "z".repeat(MAX_PROGRESS_CHARS + 50));
		expect(entries.length).toBe(1);
		expect(entries[0].startsWith("…")).toBe(true);
		expect(entries[0].length).toBe(MAX_PROGRESS_CHARS);
	});
});

describe("summarizeToolResult", () => {
	test("accepts a plain string", () => {
		expect(summarizeToolResult("  some output  ")).toBe("some output");
	});

	test("collects text parts from an AgentToolResult-like object", () => {
		expect(
			summarizeToolResult({
				content: [
					{ type: "text", text: "line one" },
					{ type: "image", data: "…" },
					{ type: "text", text: "line two" },
				],
			}),
		).toBe("line one\nline two");
	});

	test("falls back to a string text field", () => {
		expect(summarizeToolResult({ text: "fallback body" })).toBe("fallback body");
	});

	test("returns undefined for empty or unsupported results", () => {
		expect(summarizeToolResult("   ")).toBeUndefined();
		expect(summarizeToolResult({ content: [] })).toBeUndefined();
		expect(summarizeToolResult(undefined)).toBeUndefined();
		expect(summarizeToolResult(42)).toBeUndefined();
	});

	test("truncates long results from the beginning with a trailing ellipsis", () => {
		const long = `${"a\n".repeat(500)}tail`;
		const summary = summarizeToolResult(long, 100);
		expect(summary?.length).toBe(100);
		expect(summary?.endsWith("…")).toBe(true);
		expect(summary?.startsWith("a\na")).toBe(true);
	});
});
