import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	delegationKey,
	type FusionRun,
	listRuns,
	markInterrupted,
	newRunId,
	readRun,
	runsDir,
	writeRun,
} from "../src/runs.ts";

const dirs: string[] = [];

async function tmpRunsDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "fusion-runs-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (dirs.length > 0) {
		await rm(dirs.pop() as string, { recursive: true, force: true });
	}
});

function makeRun(overrides: Partial<FusionRun> = {}): FusionRun {
	return {
		runId: newRunId(),
		cwd: "/repo",
		task: "implement the thing",
		brief: "executor brief",
		executor: {
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			label: "anthropic/claude-sonnet-4-5",
			thinking: "off",
		},
		status: "running",
		revisions: 0,
		results: {},
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("runsDir", () => {
	test("nests runs under the fusion dir inside the agent dir", () => {
		expect(runsDir("/agent")).toBe("/agent/fusion/runs");
	});
});

describe("writeRun/readRun", () => {
	test("roundtrips a run manifest through a tmp dir", async () => {
		const dir = await tmpRunsDir();
		const run = makeRun({
			results: { abc: "done text" },
			sessionFile: "/agent/fusion/sessions/s.jsonl",
		});
		await writeRun(dir, run);
		const loaded = await readRun(dir, run.runId);
		expect(loaded).toBeDefined();
		expect(loaded?.runId).toBe(run.runId);
		expect(loaded?.cwd).toBe("/repo");
		expect(loaded?.executor.modelId).toBe("claude-sonnet-4-5");
		expect(loaded?.results.abc).toBe("done text");
		expect(loaded?.sessionFile).toBe("/agent/fusion/sessions/s.jsonl");
	});

	test("creates the runs directory when missing", async () => {
		const dir = join(await tmpRunsDir(), "nested", "runs");
		const run = makeRun();
		await writeRun(dir, run);
		expect((await readRun(dir, run.runId))?.runId).toBe(run.runId);
	});

	test("roundtrips originalTask and finalFixUsed, and still parses runs without them", async () => {
		const dir = await tmpRunsDir();
		const run = makeRun({ originalTask: "the user's original ask", finalFixUsed: true });
		await writeRun(dir, run);
		const loaded = await readRun(dir, run.runId);
		expect(loaded?.originalTask).toBe("the user's original ask");
		expect(loaded?.finalFixUsed).toBe(true);

		const legacy = makeRun({ runId: "legacy" });
		await writeRun(dir, legacy);
		const legacyFile = join(dir, "legacy.json");
		const parsed = JSON.parse(await readFile(legacyFile, "utf8")) as Record<string, unknown>;
		delete parsed.originalTask;
		delete parsed.finalFixUsed;
		await writeFile(legacyFile, `${JSON.stringify(parsed)}\n`);
		const loadedLegacy = await readRun(dir, "legacy");
		expect(loadedLegacy).toBeDefined();
		expect(loadedLegacy?.originalTask).toBeUndefined();
		expect(loadedLegacy?.finalFixUsed).toBeUndefined();
	});

	test("roundtrips backend, conversationId, and metrics fields", async () => {
		const dir = await tmpRunsDir();
		const run = makeRun({
			backend: "durable",
			conversationId: 42,
			metrics: {
				backend: "durable",
				startedAt: "2026-01-01T10:00:00.000Z",
				finishedAt: "2026-01-01T10:05:00.000Z",
				delegations: [
					{
						action: "execute",
						size: "standard",
						briefChars: 80,
						thinking: "low",
						totalMs: 1000,
						reasoningChars: 50,
						toolCalls: 2,
						editCalls: 1,
						reportStatus: "done",
						usage: {
							input: 1,
							output: 2,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 3,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
						},
					},
				],
				supervisorUsage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				scout: {
					calls: 1,
					ms: 500,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			},
		});
		await writeRun(dir, run);
		const loaded = await readRun(dir, run.runId);
		expect(loaded?.backend).toBe("durable");
		expect(loaded?.conversationId).toBe(42);
		expect(loaded?.metrics?.delegations).toHaveLength(1);
		expect(loaded?.metrics?.delegations[0].action).toBe("execute");
		expect(loaded?.metrics?.scout.calls).toBe(1);
	});

	test("still reads run manifests written before the backend and metrics fields", async () => {
		const dir = await tmpRunsDir();
		const legacy = makeRun({ runId: "legacy-durable" });
		await writeRun(dir, legacy);
		const file = join(dir, "legacy-durable.json");
		const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
		delete parsed.backend;
		delete parsed.conversationId;
		delete parsed.metrics;
		await writeFile(file, `${JSON.stringify(parsed)}\n`);
		const loaded = await readRun(dir, "legacy-durable");
		expect(loaded).toBeDefined();
		expect(loaded?.backend).toBeUndefined();
		expect(loaded?.conversationId).toBeUndefined();
		expect(loaded?.metrics).toBeUndefined();
	});

	test("readRun returns undefined for missing or invalid manifests", async () => {
		const dir = await tmpRunsDir();
		expect(await readRun(dir, "nope")).toBeUndefined();
		await writeFile(join(dir, "broken.json"), "{not json");
		expect(await readRun(dir, "broken")).toBeUndefined();
	});
});

describe("listRuns", () => {
	test("filters by cwd and orders newest first", async () => {
		const dir = await tmpRunsDir();
		const older = makeRun({ runId: "older", cwd: "/repo" });
		const newer = makeRun({ runId: "newer", cwd: "/repo" });
		const other = makeRun({ runId: "other", cwd: "/elsewhere" });
		await writeRun(dir, older);
		await writeRun(dir, newer);
		await writeRun(dir, other);
		const olderFile = join(dir, "older.json");
		const parsed = JSON.parse(await readFile(olderFile, "utf8")) as FusionRun;
		parsed.updatedAt = "2020-01-01T00:00:00.000Z";
		await writeFile(olderFile, JSON.stringify(parsed));
		const runs = await listRuns(dir, "/repo");
		expect(runs.map((run) => run.runId)).toEqual(["newer", "older"]);
	});

	test("ignores unparseable files and non-json entries", async () => {
		const dir = await tmpRunsDir();
		await writeRun(dir, makeRun({ runId: "good" }));
		await writeFile(join(dir, "junk.json"), "not json at all");
		await writeFile(join(dir, "shape.json"), JSON.stringify({ hello: 1 }));
		await writeFile(join(dir, "leftover.tmp"), "{}");
		const runs = await listRuns(dir, "/repo");
		expect(runs.map((run) => run.runId)).toEqual(["good"]);
	});

	test("returns an empty list when the dir does not exist", async () => {
		expect(await listRuns(join(await tmpRunsDir(), "missing"), "/repo")).toEqual([]);
	});
});

describe("markInterrupted", () => {
	test("flips running runs to interrupted and leaves others", async () => {
		const dir = await tmpRunsDir();
		await writeRun(dir, makeRun({ runId: "running", status: "running" }));
		await writeRun(dir, makeRun({ runId: "done", status: "done" }));
		await writeRun(dir, makeRun({ runId: "other-cwd", cwd: "/elsewhere" }));
		const changed = await markInterrupted(dir, "/repo");
		expect(changed.map((run) => run.runId)).toEqual(["running"]);
		expect((await readRun(dir, "running"))?.status).toBe("interrupted");
		expect((await readRun(dir, "done"))?.status).toBe("done");
		expect((await readRun(dir, "other-cwd"))?.status).toBe("running");
	});
});

describe("delegationKey", () => {
	test("is stable for identical inputs", () => {
		expect(delegationKey("execute", "brief", 0)).toBe(delegationKey("execute", "brief", 0));
	});

	test("produces sha256 hex", () => {
		expect(delegationKey("execute", "brief", 0)).toMatch(/^[0-9a-f]{64}$/);
	});

	test("differs across action, brief, and revision", () => {
		const base = delegationKey("execute", "brief", 0);
		expect(delegationKey("revise", "brief", 0)).not.toBe(base);
		expect(delegationKey("execute", "other", 0)).not.toBe(base);
		expect(delegationKey("execute", "brief", 1)).not.toBe(base);
	});
});
