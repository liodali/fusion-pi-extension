import { expect, test } from "bun:test";
import { FusionController } from "../src/core/controller.ts";
import type { WorkerHandle, WorkerRuntime, WorkerTurnResult } from "../src/core/worker.ts";
import type { LifecycleState } from "../src/core/workflow.ts";
import { MAX_SETTLE_NUDGES } from "../src/limits.ts";

function fixture(failWrite = false) {
	const log: string[] = [];
	const owner = { harness: "test", supervisorId: "parent", workspace: "/work" };
	const worker: WorkerHandle = { owner, runtime: "test", reference: { owner, runtime: "test", id: "child" } };
	const runtime: WorkerRuntime = {
		capabilities: { transcriptReopen: true, activeTurnReattach: true, durableExecution: false, idempotentSubmission: false, readOnlyScout: false, exactScoutToolLimit: false, workerAbort: true },
		async create() { return worker; }, async open() { return worker; },
		async submit(request) { log.push("submit"); return { ...request, role: "executor", status: "completed", text: "done" }; },
		async reattach(request) { log.push("reattach"); return { ...request, role: "executor", status: "completed", text: "recovered" }; },
		async abort() {}, async release() {}, async shutdown() {},
	};
	const state: LifecycleState = { runActive: false, phase: "idle", delegating: false, executed: false, revisions: 0, finalFixUsed: false, resumePending: false, scoutCalls: 0, settleNudges: 0 };
	const controller = new FusionController(state, { now: () => 0, newRunId: () => "run", newRequestId: () => "req" }, runtime);
	const ports = {
		claim: async () => { log.push("claim"); }, recordIntent: async () => { log.push("intent"); }, snapshot: async () => { log.push("snapshot"); return "before"; },
		recordReference: async () => { log.push("reference"); if (failWrite) throw new Error("storage"); },
		collect: async (result: WorkerTurnResult, snapshot: string) => { expect(snapshot).toBe("before"); log.push("collect"); return result.text; },
		settle: async (value: string) => { log.push("settle"); return value; },
	};
	return { controller, worker, runtime, ports, log };
}
const options = { onEvent: () => {} };

test("controller persists known references before invoking the injected runtime", async () => {
	const f = fixture(); f.controller.beginDelegation("execute", undefined, "brief");
	const result = await f.controller.performWorkerDelegation({ runId: "run", requestId: "req", worker: f.worker, prompt: "work" }, options, f.ports);
	expect(result).toBe("done"); expect(f.log).toEqual(["claim", "intent", "snapshot", "reference", "submit", "collect", "settle"]);
});

test("a reference persistence failure prevents submission and refunds the revision", async () => {
	const f = fixture(true); f.controller.start("task"); f.controller.completeDelegation(); f.controller.beginDelegation("revise", undefined, "feedback");
	await expect(f.controller.performWorkerDelegation({ runId: "run", requestId: "req", worker: f.worker, prompt: "work" }, options, f.ports)).rejects.toThrow("storage");
	expect(f.log).not.toContain("submit"); expect(f.controller.state.revisions).toBe(0); expect(f.controller.uncertain).toBe(false);
});

test("wrong worker results leave submission uncertain", async () => {
	const f = fixture(); f.runtime.submit = async (request) => ({ ...request, requestId: "other", role: "executor", status: "completed", text: "wrong" });
	f.controller.beginDelegation("execute", undefined, "brief");
	await expect(f.controller.performWorkerDelegation({ runId: "run", requestId: "req", worker: f.worker, prompt: "work" }, options, f.ports)).rejects.toThrow("does not match");
	expect(f.controller.uncertain).toBe(true); expect(f.log).not.toContain("settle");
});

test("resume uses the original pending request and reattaches", async () => {
	const f = fixture(); f.controller.state.resumePending = true; f.controller.setPending({ action: "execute", requestId: "original" });
	f.controller.beginDelegation("resume", f.runtime.capabilities);
	expect(await f.controller.performWorkerDelegation({ runId: "run", requestId: "original", worker: f.worker, prompt: "" }, options, f.ports)).toBe("recovered");
	expect(f.log).toContain("reattach"); expect(f.log).not.toContain("submit");
});

test("worker events are delivered only for the active request and handle", async () => {
	const f = fixture();
	const observed: string[] = [];
	f.runtime.submit = async (request, options) => {
		options.onEvent({ runId: request.runId, requestId: "other", worker: request.worker, event: { type: "text_delta", delta: "wrong" } });
		options.onEvent({ runId: request.runId, requestId: request.requestId, worker: request.worker, event: { type: "text_delta", delta: "right" } });
		// A repeated native identity delivers once; id-less events always deliver.
		options.onEvent({ runId: request.runId, requestId: request.requestId, worker: request.worker, nativeEventId: "n1", event: { type: "text_delta", delta: "dup" } });
		options.onEvent({ runId: request.runId, requestId: request.requestId, worker: request.worker, nativeEventId: "n1", event: { type: "text_delta", delta: "dup" } });
		options.onEvent({ runId: request.runId, requestId: request.requestId, worker: request.worker, nativeEventId: "n2", event: { type: "text_delta", delta: "unique" } });
		options.onEvent({ runId: request.runId, requestId: request.requestId, worker: request.worker, event: { type: "text_delta", delta: "untagged" } });
		return { ...request, role: "executor", status: "completed", text: "done" };
	};
	f.controller.beginDelegation("execute", undefined, "brief");
	await f.controller.performWorkerDelegation({ runId: "run", requestId: "req", worker: f.worker, prompt: "work" }, { onEvent: ({ event }) => { if (event.type === "text_delta") observed.push(event.delta); } }, f.ports);
	expect(observed).toEqual(["right", "dup", "unique", "untagged"]);
});

for (const harness of ["pi", "opencode"] as const) {
	test(`worker acceptance: ${harness} preserves the task and enforces budgets through settlement`, async () => {
		const log: string[] = [];
		const owner = { harness, supervisorId: "supervisor", workspace: "/workspace" };
		const worker: WorkerHandle = { owner, runtime: harness };
		const runtime: WorkerRuntime = {
			capabilities: { transcriptReopen: true, activeTurnReattach: harness === "pi", durableExecution: false, idempotentSubmission: false, readOnlyScout: false, exactScoutToolLimit: false, workerAbort: true },
			async create() { return worker; }, async open() { return worker; },
			async submit(request) { log.push(`submit:${request.requestId}`); return { ...request, role: "executor", status: "completed", text: "report" }; },
			async reattach() { throw new Error("unused"); }, async abort() {}, async release() {}, async shutdown() {},
		};
		const state: LifecycleState = { runActive: false, phase: "idle", delegating: false, executed: false, revisions: 0, finalFixUsed: false, resumePending: false, scoutCalls: 0, settleNudges: 0 };
		let sequence = 0;
		const controller = new FusionController(state, { now: () => 0, newRunId: () => "run", newRequestId: () => `req-${++sequence}` }, runtime);
		controller.start("original task");
		const act = async (action: "execute" | "revise" | "final_fix") => {
			expect(controller.beginDelegation(action, runtime.capabilities, "brief")).toBeUndefined();
			const requestId = controller.pending!.requestId;
			const request = { runId: "run", requestId, worker, prompt: controller.delegationPrompt(action, "brief") };
			const result = await controller.performWorkerDelegation(request, options, {
				claim: async () => {}, recordIntent: async () => {}, snapshot: async () => undefined, recordReference: async () => {},
				collect: async (output) => output.text,
				settle: async (text) => { await controller.persistSettlement("completed", async () => {}); return text; },
			});
			controller.endDelegation(action);
			return result;
		};
		expect(await act("execute")).toBe("report");
		for (let i = 0; i < 3; i++) await act("revise");
		expect(controller.beginDelegation("revise", runtime.capabilities, "extra")).toContain("revision");
		await act("final_fix");
		expect(controller.beginDelegation("final_fix", runtime.capabilities, "extra")).toContain("already used");
		expect(controller.state.originalTask).toBe("original task");
		expect(log).toHaveLength(5);
		for (let i = 0; i < MAX_SETTLE_NUDGES; i++) expect(controller.continuation({ lastAssistantText: "", outcome: "completed", canContinue: true })).toContain("final acceptance audit");
		expect(controller.continuation({ lastAssistantText: "", outcome: "completed", canContinue: true })).toBeUndefined();
		controller.clear();
		expect(controller.state.runActive).toBe(false);
	});
}

test("finished worker callbacks cannot mutate presentation or persist a later run", async () => {
	const f = fixture();
	let callbacks!: Parameters<WorkerRuntime["submit"]>[1];
	const events: unknown[] = [];
	f.runtime.submit = async (request, options) => { callbacks = options; return { ...request, role: "executor", status: "completed", text: "done" }; };
	f.controller.beginDelegation("execute", undefined, "brief");
	await f.controller.performWorkerDelegation({ runId: "run", requestId: "req", worker: f.worker, prompt: "work" }, { onEvent: (event) => events.push(event) }, f.ports);
	const writes = f.log.filter((stage) => stage === "reference").length;
	callbacks.onEvent({ runId: "run", requestId: "req", worker: f.worker, event: { type: "text_delta", delta: "late" } });
	await expect(callbacks.onReference(f.worker.reference!)).rejects.toThrow("no longer accepts");
	expect(events).toEqual([]);
	expect(f.log.filter((stage) => stage === "reference")).toHaveLength(writes);
});
