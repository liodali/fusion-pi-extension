import { describe, expect, test } from "bun:test";
import {
	type ExecutorReport,
	formatCompactReport,
	parseExecutorReport,
	REPORT_PROSE_MAX_CHARS,
	REPORT_SUMMARY_MAX_CHARS,
	reviewTier,
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
		expect(text).toContain("Review: full (status partial, failing checks, blockers)");
	});

	test("omits empty sections and ends with the review line", () => {
		const report: ExecutorReport = {
			status: "done",
			summary: "fine",
			files_changed: [],
			checks: [],
			blockers: [],
		};
		const text = formatCompactReport(report);
		expect(text).toBe(
			"Status: done\nSummary: fine\nReview: full (no checks run, no diff stat)",
		);
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
		expect(text.length).toBeLessThan(REPORT_PROSE_MAX_CHARS + 200);
		expect(text).toContain("…");
		expect(text).toContain("Review: full (status unknown, no checks run, no diff stat)");
	});
});

describe("reviewTier", () => {
	const DONE: ExecutorReport = {
		status: "done",
		summary: "ok",
		files_changed: [{ path: "a.ts", change: "edit" }],
		checks: [{ command: "bun test", result: "pass" }],
		blockers: [],
	};
	const STAT = " a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)";

	test("is light for a clean report with a small diff", () => {
		expect(reviewTier(DONE, STAT)).toEqual({ tier: "light", reasons: [] });
	});

	test("is full when no checks ran", () => {
		expect(reviewTier({ ...DONE, checks: [] }, STAT).reasons).toContain("no checks run");
	});

	test("is full when a check failed", () => {
		const report: ExecutorReport = {
			...DONE,
			checks: [{ command: "bun test", result: "fail" }],
		};
		expect(reviewTier(report, STAT).reasons).toContain("failing checks");
	});

	test("is full when blockers exist", () => {
		expect(reviewTier({ ...DONE, blockers: ["missing key"] }, STAT).reasons).toContain(
			"blockers",
		);
	});

	test("is full for a partial or unknown status", () => {
		expect(reviewTier({ ...DONE, status: "partial" }, STAT).reasons).toContain(
			"status partial",
		);
		expect(reviewTier({ ...DONE, status: "unknown" }, STAT).reasons).toContain(
			"status unknown",
		);
	});

	test("is full without a diff stat", () => {
		expect(reviewTier(DONE).reasons).toContain("no diff stat");
		expect(reviewTier(DONE, "  ").reasons).toContain("no diff stat");
	});

	test("is full when the diff touches too many files, counting new: lines", () => {
		const stat =
			" a.ts | 2 +-\n b.ts | 2 +-\n c.ts | 2 +-\n d.ts | 2 +-\n 4 files changed, 4 insertions(+), 4 deletions(-)\nnew: e.ts\nnew: f.ts";
		expect(reviewTier(DONE, stat).reasons).toContain("6 files > 5");
	});

	test("is full when the diff changes too many lines", () => {
		const stat =
			" a.ts | 400 +-\n 1 file changed, 300 insertions(+), 100 deletions(-)";
		expect(reviewTier(DONE, stat).reasons).toContain("400 lines > 200");
	});

	test("is full when pre-existing changes are mixed into the diff", () => {
		const stat = `${STAT}\npre-existing changes (diff includes edits made before this delegation): a.ts`;
		expect(reviewTier(DONE, stat).reasons).toContain("pre-existing changes");
	});
});
