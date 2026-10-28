import { describe, expect, test } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
	type DelegationMetric,
	formatRunStats,
	type FusionRunMetrics,
} from "../src/metrics.ts";
import type { FusionRun } from "../src/runs.ts";
import { createEmptyUsage } from "../src/usage.ts";

function usage(cost: number): Usage {
	const value = createEmptyUsage();
	value.cost.total = cost;
	return value;
}

function delegation(overrides: Partial<DelegationMetric> = {}): DelegationMetric {
	return {
		action: "execute",
		size: "standard",
		briefChars: 120,
		thinking: "off",
		totalMs: 60_000,
		reasoningChars: 0,
		toolCalls: 3,
		editCalls: 1,
		reportStatus: "done",
		usage: usage(0.1),
		...overrides,
	};
}

function metrics(overrides: Partial<FusionRunMetrics> = {}): FusionRunMetrics {
	return {
		backend: "session",
		startedAt: "2026-01-01T10:00:00.000Z",
		finishedAt: "2026-01-01T10:01:40.000Z",
		delegations: [delegation()],
		supervisorUsage: usage(0.2),
		scout: { calls: 1, ms: 10_000, usage: usage(0.05) },
		...overrides,
	};
}

function run(overrides: Partial<FusionRun> = {}): FusionRun {
	return {
		runId: "run",
		cwd: "/repo",
		task: "task",
		brief: "brief",
		executor: {
			provider: "anthropic",
			modelId: "model",
			label: "anthropic/model",
			thinking: "off",
		},
		status: "done",
		revisions: 0,
		results: {},
		updatedAt: "2026-01-01T10:01:40.000Z",
		...overrides,
	};
}

describe("formatRunStats", () => {
	test("returns the empty message when no runs have metrics", () => {
		expect(formatRunStats([run(), run({ runId: "other" })], 10)).toBe(
			"No Fusion runs with metrics for this directory yet.",
		);
		expect(formatRunStats([], 10)).toBe(
			"No Fusion runs with metrics for this directory yet.",
		);
	});

	test("splits wall time into executor, scout, and supervisor+review", () => {
		const text = formatRunStats([run({ metrics: metrics() })], 10);
		expect(text).toContain("wall 1m 40s");
		expect(text).toContain("executor 1m 00s (1 delegation, 0 revisions)");
		expect(text).toContain("scout 1 call 10.0s");
		expect(text).toContain("supervisor+review 30.0s");
		expect(text).toContain("done standard");
		expect(text).toContain("brief 120 chars");
	});

	test("clamps supervisor+review at zero when executor time exceeds wall", () => {
		const text = formatRunStats(
			[
				run({
					metrics: metrics({
						finishedAt: "2026-01-01T10:00:30.000Z",
						delegations: [delegation({ totalMs: 60_000 })],
						scout: { calls: 0, ms: 0, usage: usage(0) },
					}),
				}),
			],
			10,
		);
		expect(text).toContain("supervisor+review 0ms");
	});

	test("sums cost across delegations, supervisor, and scout", () => {
		const text = formatRunStats(
			[
				run({
					metrics: metrics({
						delegations: [
							delegation({ usage: usage(0.1) }),
							delegation({ action: "revise", usage: usage(0.05) }),
						],
						supervisorUsage: usage(0.2),
						scout: { calls: 2, ms: 5_000, usage: usage(0.05) },
					}),
				}),
			],
			10,
		);
		expect(text).toContain("$0.40");
		expect(text).toContain("total cost $0.40");
	});

	test("counts delegations and revisions per run", () => {
		const text = formatRunStats(
			[
				run({
					metrics: metrics({
						delegations: [
							delegation(),
							delegation({ action: "revise" }),
							delegation({ action: "final_fix" }),
						],
					}),
				}),
			],
			10,
		);
		expect(text).toContain("(3 delegations, 1 revision)");
	});

	test("reports medians separately for small and standard runs", () => {
		const smallA = run({
			runId: "s1",
			metrics: metrics({
				startedAt: "2026-01-01T11:00:00.000Z",
				finishedAt: "2026-01-01T11:01:00.000Z",
				delegations: [delegation({ size: "small" })],
			}),
		});
		const smallB = run({
			runId: "s2",
			metrics: metrics({
				startedAt: "2026-01-01T12:00:00.000Z",
				finishedAt: "2026-01-01T12:02:00.000Z",
				delegations: [delegation({ size: "small" })],
			}),
		});
		const standard = run({
			runId: "std",
			metrics: metrics({
				startedAt: "2026-01-01T13:00:00.000Z",
				finishedAt: "2026-01-01T13:05:00.000Z",
			}),
		});
		const text = formatRunStats([smallA, smallB, standard], 10);
		expect(text).toContain("median wall 2m 00s");
		expect(text).toContain("small 1m 30s");
		expect(text).toContain("standard 5m 00s");
	});

	test("omits a size group when it has no runs", () => {
		const text = formatRunStats([run({ metrics: metrics() })], 10);
		expect(text).toContain("median wall");
		expect(text).not.toContain("small ");
	});

	test("respects the limit and skips runs without metrics", () => {
		const newest = run({
			runId: "newest",
			metrics: metrics({
				startedAt: "2026-01-03T10:00:00.000Z",
				finishedAt: "2026-01-03T10:01:00.000Z",
			}),
		});
		const middle = run({
			runId: "middle",
			metrics: metrics({
				startedAt: "2026-01-02T10:00:00.000Z",
				finishedAt: "2026-01-02T10:01:00.000Z",
			}),
		});
		const oldest = run({
			runId: "oldest",
			metrics: metrics({
				startedAt: "2026-01-01T10:00:00.000Z",
				finishedAt: "2026-01-01T10:01:00.000Z",
			}),
		});
		const text = formatRunStats([newest, run({ runId: "unmeasured" }), middle, oldest], 2);
		expect(text).toContain("Fusion run stats (2 runs)");
		expect(text).toContain("2026-01-03 10:00");
		expect(text).toContain("2026-01-02 10:00");
		expect(text).not.toContain("2026-01-01 10:00");
	});

	test("reports average revisions and share of wall time", () => {
		const a = run({
			metrics: metrics({
				delegations: [delegation({ totalMs: 50_000 })],
				scout: { calls: 0, ms: 0, usage: usage(0) },
			}),
		});
		const b = run({
			metrics: metrics({
				startedAt: "2026-01-02T10:00:00.000Z",
				finishedAt: "2026-01-02T10:01:40.000Z",
				delegations: [
					delegation({ totalMs: 50_000 }),
					delegation({ action: "revise", totalMs: 10_000 }),
				],
				scout: { calls: 0, ms: 0, usage: usage(0) },
			}),
		});
		const text = formatRunStats([a, b], 10);
		expect(text).toContain("avg revisions 0.5");
		expect(text).toContain("executor ");
		expect(text).toContain("% of wall");
		expect(text).toContain("supervisor+review ");
	});

	test("marks the run size from the first delegation", () => {
		const text = formatRunStats(
			[
				run({
					metrics: metrics({ delegations: [delegation({ size: "small" })] }),
				}),
			],
			10,
		);
		expect(text).toContain("done small");
	});
});
