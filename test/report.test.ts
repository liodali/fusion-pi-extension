import { describe, expect, test } from "bun:test";
import {
	type ExecutorReport,
	formatCompactReport,
	parseExecutorReport,
	REPORT_PROSE_MAX_CHARS,
	REPORT_SUMMARY_MAX_CHARS,
} from "../src/report.ts";

const VALID_REPORT: ExecutorReport = {
	status: "done",
	summary: "Added a health endpoint.",
	files_changed: [{ path: "src/api.ts", change: "added /health route" }],
	checks: [{ command: "bun test", result: "pass", note: "12 tests" }],
	blockers: [],
};

describe("parseExecutorReport", () => {
	test("parses the trailing json block and returns the remaining prose", () => {
		const text = `All done here.\n\n\`\`\`json\n${JSON.stringify(VALID_REPORT)}\n\`\`\``;
		const { report, prose } = parseExecutorReport(text);
		expect(report).toEqual(VALID_REPORT);
		expect(prose).toBe("All done here.");
	});

	test("returns unknown with a truncated summary and the full text when no block exists", () => {
		const text = ` ${"long prose ".repeat(60)} `;
		const { report, prose } = parseExecutorReport(text);
		expect(report.status).toBe("unknown");
		expect(report.summary.length).toBe(REPORT_SUMMARY_MAX_CHARS);
		expect(report.files_changed).toEqual([]);
		expect(report.checks).toEqual([]);
		expect(report.blockers).toEqual([]);
		expect(prose).toBe(text.trim());
	});

	test("treats malformed JSON as missing", () => {
		const text = "done\n\n```json\n{not json\n```";
		const { report, prose } = parseExecutorReport(text);
		expect(report.status).toBe("unknown");
		expect(prose).toBe(text);
	});

	test("the last json block wins", () => {
		const first = JSON.stringify({ status: "blocked", summary: "stale" });
		const last = JSON.stringify({ status: "partial", summary: "real" });
		const text = `\`\`\`json\n${first}\n\`\`\`\nmiddle\n\`\`\`json\n${last}\n\`\`\``;
		const { report, prose } = parseExecutorReport(text);
		expect(report.status).toBe("partial");
		expect(report.summary).toBe("real");
		expect(prose).toBe(`\`\`\`json\n${first}\n\`\`\`\nmiddle`);
	});

	test("coerces a bad status to unknown but keeps valid fields", () => {
		const payload = { ...VALID_REPORT, status: "finished" };
		const { report } = parseExecutorReport(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``);
		expect(report.status).toBe("unknown");
		expect(report.files_changed).toEqual(VALID_REPORT.files_changed);
	});

	test("drops malformed array items", () => {
		const payload = {
			status: "done",
			summary: "x",
			files_changed: [{ path: "a.ts", change: "ok" }, { path: 42 }, "nope"],
			checks: [
				{ command: "bun test", result: "pass" },
				{ command: "bun run x", result: "maybe" },
				{ result: "fail" },
			],
			blockers: ["real blocker", 7],
		};
		const { report } = parseExecutorReport(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``);
		expect(report.files_changed).toEqual([{ path: "a.ts", change: "ok" }]);
		expect(report.checks).toEqual([{ command: "bun test", result: "pass" }]);
		expect(report.blockers).toEqual(["real blocker"]);
	});
});

describe("formatCompactReport", () => {
	test("renders all sections", () => {
		const text = formatCompactReport(
			{
				status: "partial",
				summary: "half done",
				files_changed: [{ path: "a.ts", change: "edit" }],
				checks: [
					{ command: "bun test", result: "pass", note: "all green" },
					{ command: "bun run typecheck", result: "fail" },
				],
				blockers: ["missing API key"],
			},
			" a.ts | 2 +-",
		);
		expect(text).toContain("Status: partial");
		expect(text).toContain("Summary: half done");
		expect(text).toContain("- a.ts: edit");
		expect(text).toContain("- PASS bun test (all green)");
		expect(text).toContain("- FAIL bun run typecheck");
		expect(text).toContain("- missing API key");
		expect(text).toContain("Diff stat:\na.ts | 2 +-");
	});

	test("omits empty sections and renders without a diff stat", () => {
		const report: ExecutorReport = {
			status: "done",
			summary: "fine",
			files_changed: [],
			checks: [],
			blockers: [],
		};
		const text = formatCompactReport(report);
		expect(text).toBe("Status: done\nSummary: fine");
	});

	test("appends truncated prose for unknown status", () => {
		const report: ExecutorReport = {
			status: "unknown",
			summary: "",
			files_changed: [],
			checks: [],
			blockers: [],
		};
		const prose = "p".repeat(REPORT_PROSE_MAX_CHARS + 100);
		const text = formatCompactReport(report, undefined, prose);
		expect(text).toContain("Executor report (unstructured):");
		expect(text.length).toBeLessThan(REPORT_PROSE_MAX_CHARS + 100);
		expect(text).toContain("…");
	});
});
