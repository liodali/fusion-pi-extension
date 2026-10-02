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
