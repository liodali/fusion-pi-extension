import { describe, expect, test } from "bun:test";
import type { FusionRun } from "../src/runs.ts";
import { STOPPED_RUN_REFUSAL, stopFusionRun, type StopDeps } from "../src/pi/run-stop.ts";

function makeRun(overrides: Partial<FusionRun> = {}): FusionRun {
	return {
		runId: "run-1",
		cwd: "/repo",
		task: "implement the fixture and verify it with checks",
		brief: "executor brief",
		executor: { provider: "prov", modelId: "model", label: "prov/model", thinking: "off" },
		status: "running",
		revisions: 1,
		finalFixUsed: false,
		results: {},
		updatedAt: "2026-11-04T00:00:00.000Z",
		...overrides,
	};
}

function makeDeps(overrides: Partial<StopDeps> & { activeRun?: FusionRun } = {}): StopDeps & { persisted: string[] } {
	const persisted: string[] = [];
	return {
		persisted,
		activeRun: makeRun(),
		uncertain: false,
		abortExecutor: async () => {},
		executorLabel: "prov/model",
		backend: "durable",
		activity: "running edit",
		transcriptTail: ["[execute] Executor started", "[tool] edit file.ts"],
		persist: async () => { persisted.push("write"); },
		now: () => new Date("2026-11-04T12:00:00.000Z"),
		...overrides,
		// Keep the capture even when persist is overridden.
		...(overrides.persist ? {} : {}),
	};
}

describe("stopFusionRun", () => {
	test("no active run reports honestly and changes nothing", async () => {
		const deps = makeDeps({ activeRun: undefined });
		const outcome = await stopFusionRun(deps);
		expect(outcome).toMatchObject({ stopped: false, abort: "skipped", persisted: false });
		expect(outcome.text).toBe("No Fusion run is active; nothing to stop.");
	});

	test("marks the run stopped, persists it, and delivers a deterministic recap without a live turn", async () => {
		const run = makeRun({ pending: { action: "revise", requestId: "req-9" } });
		const deps = makeDeps({ activeRun: run, uncertain: false });
		const outcome = await stopFusionRun(deps, "User asked to stop");
		expect(outcome.stopped).toBe(true);
		// No uncertain turn: nothing to abort, and that is reported as such.
		expect(outcome.abort).toBe("skipped");
		expect(run.stopped).toEqual({ at: "2026-11-04T12:00:00.000Z", reason: "User asked to stop" });
		expect(run.updatedAt).toBe("2026-11-04T12:00:00.000Z");
		expect(deps.persisted).toEqual(["write"]);
		expect(outcome.text).toContain("run run-1");
		expect(outcome.text).toContain("implement the fixture and verify it with checks");
		expect(outcome.text).toContain("Executor: prov/model on the durable backend");
		expect(outcome.text).toContain("Last observed: running edit");
		expect(outcome.text).toContain("Pending request: revise:req-9")
		expect(outcome.text).toContain("Revisions used: 1/3");
		expect(outcome.text).toContain("no executor turn was known to be running")
		expect(outcome.text).toContain("- [execute] Executor started")
		expect(outcome.text).toContain("Partial edits are preserved")
		expect(outcome.text).toContain("No further executor or scout work will run for this run.")
	});

	test("an uncertain turn aborts the live executor and never overstates termination", async () => {
		const run = makeRun();
		const deps = makeDeps({ activeRun: run, uncertain: true });
		const outcome = await stopFusionRun(deps);
		expect(outcome.abort).toBe("delivered");
		expect(outcome.text).toContain("Abort: delivered to the live executor conversation; termination is not independently verified.")
		expect(run.stopped).toEqual({ at: "2026-11-04T12:00:00.000Z" });
	});

	test("a failed abort reports the failure honestly and still stops the run", async () => {
		const run = makeRun();
		const deps = makeDeps({ activeRun: run, uncertain: true, abortExecutor: async () => { throw new Error("harness unreachable"); } });
		const outcome = await stopFusionRun(deps);
		expect(outcome).toMatchObject({ stopped: true, abort: "failed", error: "harness unreachable" });
		expect(outcome.text).toContain("Abort failed: harness unreachable. Termination is not confirmed.")
	});

	test("a stopped run is idempotent and does not abort again", async () => {
		const run = makeRun({ stopped: { at: "2026-11-04T11:00:00.000Z" } });
		let aborts = 0;
		const deps = makeDeps({ activeRun: run, uncertain: true, abortExecutor: async () => { aborts++; }, persist: async () => {} });
		const outcome = await stopFusionRun(deps);
		expect(aborts).toBe(0);
		expect(outcome.abort).toBe("skipped");
		expect(outcome.text).toContain("already stopped at 2026-11-04T11:00:00.000Z")
		expect(run.stopped).toEqual({ at: "2026-11-04T11:00:00.000Z" });
	});

	test("a failed marker write keeps the in-memory stop and warns in the recap", async () => {
		const run = makeRun();
		const deps = makeDeps({ activeRun: run, persist: async () => { throw new Error("disk full"); } });
		const outcome = await stopFusionRun(deps);
		expect(outcome.stopped).toBe(true);
		expect(outcome.persisted).toBe(false);
		expect(run.stopped).toBeTruthy();
		expect(outcome.text).toContain("stop marker could not be written")
		expect(outcome.text).toContain("Verify saved status before recovery.")
	});

	test("the shared refusal names the recovery path", () => {
		expect(STOPPED_RUN_REFUSAL).toContain("/fusion-resume")
		expect(STOPPED_RUN_REFUSAL).toContain("/fusion-clean")
	});

	test("a long task and reason are truncated for a bounded recap", async () => {
		const run = makeRun({ task: "x".repeat(120) });
		const deps = makeDeps({ activeRun: run });
		const outcome = await stopFusionRun(deps, "r".repeat(120));
		expect(outcome.text).toContain(`task "${"x".repeat(77)}..."`)
		expect(run.stopped?.reason).toBe(`${"r".repeat(77)}...`)
	});
});
