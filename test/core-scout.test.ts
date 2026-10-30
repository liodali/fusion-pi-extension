import { describe, expect, test } from "bun:test";
import { MAX_SCOUT_TOOL_CALLS, formatScoutResponse, formatWorkerUsageSummary, scoutCapDecision } from "../src/core/scout.ts";
import { scoutCapDecision as legacyScoutCapDecision } from "../src/pi/durable/scout-args.ts";

describe("scoutCapDecision", () => {
	test("allows up to the cap, refuses the next three, then terminates", () => {
		expect(scoutCapDecision(0, 2)).toBe("allow");
		expect(scoutCapDecision(1, 2)).toBe("allow");
		expect(scoutCapDecision(2, 2)).toBe("allow");
		expect(scoutCapDecision(3, 2)).toBe("refuse");
		expect(scoutCapDecision(5, 2)).toBe("refuse");
		expect(scoutCapDecision(6, 2)).toBe("terminate");
		expect(scoutCapDecision(99, 2)).toBe("terminate");
	});
	test("stays shared with the Pi durable scout tools", () => {
		expect(legacyScoutCapDecision).toBe(scoutCapDecision);
	});
});

describe("formatWorkerUsageSummary", () => {
	test("renders known fields and leaves missing ones unknown", () => {
		expect(formatWorkerUsageSummary(undefined)).toBe("unknown");
		expect(formatWorkerUsageSummary({})).toBe("in unknown | out unknown | cache unknown | $unknown");
		expect(formatWorkerUsageSummary({ inputTokens: 1234, outputTokens: 56 })).toBe("in 1,234 | out 56 | cache unknown | $unknown");
		expect(formatWorkerUsageSummary({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 10, cost: 0.5 }))
			.toBe("in 100 | out 50 | reasoning 10 | cache 10 | $0.5000");
	});
});

describe("formatScoutResponse", () => {
	const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 10, cost: 0.0123 };

	test("completed answers truncate at the shared limit and append the usage line", () => {
		const ok = formatScoutResponse({ status: "completed", text: "  answer  ", capped: false, usage });
		expect(ok).toEqual({ text: `answer\n\nScout usage: in 100 | out 50 | reasoning 10 | cache 10 | $0.0123` });
		const empty = formatScoutResponse({ status: "completed", text: "", capped: false });
		expect(empty.text).toContain("The scout returned no answer.");
		const long = formatScoutResponse({ status: "completed", text: "x".repeat(3100), capped: false });
		expect(long.text.startsWith("x".repeat(2999) + "…")).toBe(true);
		expect(long.text).not.toContain("x".repeat(3000));
	});

	test("capped answers report the shared tool-call cap with the partial answer", () => {
		const result = formatScoutResponse({ status: "completed", text: "partial findings", capped: true, usage });
		expect(result.text).toBe(`Scout stopped after ${MAX_SCOUT_TOOL_CALLS} tool calls; partial answer:\npartial findings\n\nScout usage: in 100 | out 50 | reasoning 10 | cache 10 | $0.0123`);
		expect(result.error).toBeUndefined();
		const oversized = formatScoutResponse({ status: "completed", text: `  ${"y".repeat(3001)}  `, capped: true });
		expect(oversized.text).toContain(`partial answer:\n${"y".repeat(2999)}…`);
	});

	test("error and cancelled statuses report the terminal state with an error marker", () => {
		const failed = formatScoutResponse({ status: "error", text: "", errorMessage: "boom", capped: false, usage });
		expect(failed).toEqual({ text: `Fusion scout stopped with status "error": boom.\n\nScout usage: in 100 | out 50 | reasoning 10 | cache 10 | $0.0123`, error: "boom" });
		const cancelled = formatScoutResponse({ status: "cancelled", text: "", capped: false });
		expect(cancelled).toEqual({ text: `Fusion scout stopped with status "cancelled".\n\nScout usage: unknown`, error: "cancelled" });
	});
});
