import { expect, test } from "bun:test";
import type { WorkerConfig, WorkerHandle, WorkerOwner, WorkerReference, WorkerRuntime } from "../src/core/worker.ts";
import { createNativeExecutor, OPENCODE_CAPABILITIES } from "../src/opencode/native-executor.ts";

const owner: WorkerOwner = { harness: "opencode", supervisorId: "parent", workspace: "/workspace" };

test("the runtime contract permits a lazy native child and awaits reference persistence", async () => {
	let proceed!: () => void;
	const persisted = new Promise<void>((resolve) => { proceed = resolve; });
	let observedReference!: () => void;
	const referenceSeen = new Promise<void>((resolve) => { observedReference = resolve; });
	let nativeContinued = false;
	const native = createNativeExecutor({ parentSessionID: "parent", agent: "fusion-executor", execute: async (_input, context) => {
		await context.progress({ sessionID: "child" });
		nativeContinued = true;
		return { output: { sessionID: "child", status: "completed", output: "done" } };
	} });
	const reference = (): WorkerReference | undefined => native.childSessionID
		? { owner, runtime: "native-subagent", id: native.childSessionID } : undefined;
	const handle: WorkerHandle = { owner, runtime: "native-subagent", get reference() { return reference(); } };
	const runtime: WorkerRuntime = {
		capabilities: OPENCODE_CAPABILITIES,
		async create() { return handle; },
		async open() { throw new Error("not used"); },
		async submit(request, options) {
			await native.prompt(request.prompt, request.requestId, {
				sessionID: owner.supervisorId,
				signal: options.signal ?? new AbortController().signal,
				progress: async () => { await options.onReference(reference()!); },
			});
			return { runId: request.runId, requestId: request.requestId, worker: request.worker,
				role: "executor", status: "completed", text: "done" };
		},
		async reattach() { throw new Error("not supported"); },
		async abort() {}, async release() {}, async shutdown() {},
	};
	const worker = await runtime.create(owner, { role: "executor" });
	expect(worker.reference).toBeUndefined();
	const result = runtime.submit({ runId: "run", requestId: "request", worker, prompt: "work" }, {
		onEvent: () => {}, onReference: async (ref) => {
			expect(ref).toEqual({ owner, runtime: "native-subagent", id: "child" });
			observedReference();
			await persisted;
		},
	});
	await referenceSeen;
	expect(nativeContinued).toBe(false);
	proceed();
	expect((await result).worker.reference?.id).toBe("child");
	expect(nativeContinued).toBe(true);
});

test("the scout contract carries its tool limit and reports whether it was hit", () => {
	const config: WorkerConfig = { role: "scout", maxToolCalls: 5 };
	const worker: WorkerHandle = { owner, runtime: "native-subagent" };
	const result: Awaited<ReturnType<WorkerRuntime["submit"]>> = {
		runId: "run", requestId: "scout", worker, role: "scout", status: "completed", text: "partial", capped: true,
	};
	expect(config.maxToolCalls).toBe(5);
	expect(result.capped).toBe(true);
});

test("a rejected reference write stops native progress and retains the observed child", async () => {
	let continued = false;
	const native = createNativeExecutor({ parentSessionID: "parent", agent: "fusion-executor", execute: async (_input, context) => {
		await context.progress({ sessionID: "child" });
		continued = true;
		return { output: { sessionID: "child", status: "completed", output: "done" } };
	} });
	await expect(native.prompt("work", "request", {
		sessionID: "parent", signal: new AbortController().signal,
		progress: async () => { throw new Error("storage unavailable"); },
	})).rejects.toThrow("storage unavailable");
	expect(continued).toBe(false);
	expect(native.childSessionID).toBe("child");
});

// These declarations are checked by tsc so required scout and cleanup fields
// cannot disappear while the production adapters are migrated in M2.
if (false) {
	// @ts-expect-error A scout must specify its tool limit.
	const missingLimit: WorkerConfig = { role: "scout" };
	// @ts-expect-error A scout result must report whether its limit was hit.
	const missingCapped: Awaited<ReturnType<WorkerRuntime["submit"]>> = { runId: "r", requestId: "q", worker: {} as WorkerHandle, role: "scout", status: "completed", text: "" };
	const releaseRequired: "release" extends keyof WorkerRuntime ? true : never = true;
	const shutdownRequired: "shutdown" extends keyof WorkerRuntime ? true : never = true;
	void [missingLimit, missingCapped, releaseRequired, shutdownRequired];
}
