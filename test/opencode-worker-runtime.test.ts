import { expect, test } from "bun:test";
import { createOpenCodeWorkerRuntime } from "../src/opencode/worker-runtime.ts";
import type { NativeSubagentExecute, NativeToolContext } from "../src/opencode/native-executor.ts";

type Context = NativeToolContext & { id: string; messageID: string };
const owner = { harness: "opencode", supervisorId: "parent", workspace: "/workspace" };
const config = { role: "executor" as const };
function fixture(execute: NativeSubagentExecute<Context>) {
	const forwarded: unknown[] = [];
	const context: Context = { sessionID: "parent", id: "call", messageID: "message", signal: new AbortController().signal, progress: async (update) => { forwarded.push(update); } };
	const runtime = createOpenCodeWorkerRuntime({ execute, contextFor: () => context, validateReference: async () => {} });
	return { runtime, context, forwarded };
}

test("awaits reference persistence before native progress and preserves tool context", async () => {
	let proceed!: () => void, seen!: () => void;
	const gate = new Promise<void>((resolve) => { proceed = resolve; });
	const observed = new Promise<void>((resolve) => { seen = resolve; });
	const f = fixture(async (input, ctx) => {
		expect(ctx.id).toBe("call"); expect(ctx.messageID).toBe("message"); expect(input.description).toBe("request");
		await ctx.progress({ sessionID: "child", status: "running" });
		return { output: { sessionID: "child", status: "completed", output: "done" } };
	});
	const worker = await f.runtime.create(owner, config);
	const pending = f.runtime.submit({ runId: "run", requestId: "request", worker, prompt: "work" }, { onEvent: () => {}, onReference: async (ref) => { expect(ref.id).toBe("child"); seen(); await gate; } });
	await observed;
	expect(f.forwarded).toEqual([]);
	proceed();
	const result = await pending;
	expect(result.text).toBe("done");
	// Missing OpenCode accounting stays unknown: the adapter never invents zeros.
	expect(result.usage).toBeUndefined();
	expect(f.forwarded).toHaveLength(1);
	await f.runtime.settle({ runId: "run", requestId: "request", worker, prompt: "work" }, async () => {});
	await f.runtime.release(worker);
	await f.runtime.shutdown();
});

test("persists a child returned only in the result", async () => {
	const f = fixture(async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }));
	const worker = await f.runtime.create(owner, config);
	const refs: string[] = [];
	await f.runtime.submit({ runId: "r", requestId: "q", worker, prompt: "work" }, { onEvent: () => {}, onReference: async (ref) => { refs.push(ref.id); } });
	expect(refs).toEqual(["child"]);
});

test("a failed reference write retains the child and locks uncertain work", async () => {
	const f = fixture(async (_input, ctx) => { await ctx.progress({ sessionID: "child" }); return {}; });
	const worker = await f.runtime.create(owner, config);
	const request = { runId: "r", requestId: "q", worker, prompt: "work" };
	const options = { onEvent: () => {}, onReference: async () => { throw new Error("storage failed"); } };
	await expect(f.runtime.submit(request, options)).rejects.toThrow("storage failed");
	expect(worker.reference?.id).toBe("child");
	expect(f.forwarded).toEqual([]);
	await expect(f.runtime.submit(request, options)).rejects.toThrow("uncertain");
	await expect(f.runtime.release(worker)).rejects.toThrow("uncertain");
	await expect(f.runtime.shutdown()).rejects.toThrow("uncertain");
});

test("background reconciliation matches the pending request and never resubmits", async () => {
	let submissions = 0;
	const f = fixture(async () => { submissions++; return { output: { sessionID: "child", status: "running", output: "background" } }; });
	const worker = await f.runtime.create(owner, config);
	const request = { runId: "r", requestId: "q", worker, prompt: "work" };
	const options = { onEvent: () => {}, onReference: async () => {} };
	await expect(f.runtime.submit(request, options)).rejects.toThrow("settlement handler");
	await expect(f.runtime.reattach(request, options)).rejects.toThrow("not supported");
	await expect(f.runtime.reconcile({ ...request, requestId: "wrong" }, options, async () => ({ status: "completed", text: "wrong" }), async () => {})).rejects.toThrow("matching");
	await expect(f.runtime.reconcile(request, options, async () => { throw new Error("no proof"); }, async () => {})).rejects.toThrow("no proof");
	const result = await f.runtime.reconcile(request, options, async (child, pending) => { expect(child).toBe("child"); expect(pending.requestId).toBe("q"); return { status: "completed", text: "report" }; }, async () => {});
	expect(result.text).toBe("report"); expect(submissions).toBe(1);
	await f.runtime.release(worker);
});

test("validates reopened ownership and rejects unsupported operations", async () => {
	const f = fixture(async () => ({}));
	await expect(f.runtime.create(owner, { role: "scout", maxToolCalls: 2 })).rejects.toThrow("scout");
	const worker = await f.runtime.open({ owner, runtime: "native-subagent", id: "child" }, config);
	Object.assign(f.context, { sessionID: "wrong" });
	const request = { runId: "r", requestId: "q", worker, prompt: "work" };
	await expect(f.runtime.submit(request, { onEvent: () => {}, onReference: async () => {} })).rejects.toThrow("different supervisor");
	await expect(f.runtime.abort(worker)).rejects.toThrow("the host does not expose session interruption");
	await f.runtime.release(worker);
});

test("abort interrupts the owned child when the host exposes interruption", async () => {
	const interrupted: string[] = [];
	const runtime = createOpenCodeWorkerRuntime({
		execute: async () => ({ output: { sessionID: "child", status: "running", output: "pending" } }),
		contextFor: () => ({ sessionID: "parent", signal: new AbortController().signal, progress: async () => {} }),
		validateReference: async () => {},
		interrupt: async (childSessionID) => { interrupted.push(childSessionID); },
	});
	expect(runtime.capabilities.workerAbort).toBe(true);
	const referenceless = await runtime.create(owner, config);
	await expect(runtime.abort(referenceless)).rejects.toThrow("no native child");
	const worker = await runtime.open({ owner, runtime: "native-subagent", id: "child" }, config);
	await runtime.abort(worker);
	expect(interrupted).toEqual(["child"]);
	await runtime.shutdown();
});

test("an uncertain child cannot be reopened to bypass its lock", async () => {
	let calls = 0;
	const f = fixture(async () => { calls++; return { output: { sessionID: "child", status: "running", output: "pending" } }; });
	const worker = await f.runtime.create(owner, config);
	const request = { runId: "r", requestId: "q", worker, prompt: "work" };
	const options = { onEvent: () => {}, onReference: async () => {} };
	await expect(f.runtime.submit(request, options)).rejects.toThrow("settlement handler");
	await expect(f.runtime.open(worker.reference!, config)).rejects.toThrow("already owned");
	await expect(f.runtime.submit(request, options)).rejects.toThrow("uncertain");
	expect(calls).toBe(1);
});

test("concurrent opens cannot acquire the same child", async () => {
	let finish!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => { finish = resolve; });
	const seen = new Promise<void>((resolve) => { entered = resolve; });
	const runtime = createOpenCodeWorkerRuntime({ execute: async () => ({}), contextFor: () => ({ sessionID: "parent", signal: new AbortController().signal, progress: async () => {} }), validateReference: async () => { entered(); await gate; } });
	const ref = { owner, runtime: "native-subagent", id: "child" };
	const opening = runtime.open(ref, config);
	await seen;
	await expect(runtime.open(ref, config)).rejects.toThrow("already owned");
	finish();
	const worker = await opening;
	await runtime.release(worker);
	await runtime.shutdown();
});

test("progress without a child ID waits for overlapping reference persistence", async () => {
	let finish!: () => void, seen!: () => void;
	const gate = new Promise<void>((resolve) => { finish = resolve; });
	const observed = new Promise<void>((resolve) => { seen = resolve; });
	const f = fixture(async (_input, ctx) => {
		const first = ctx.progress({ sessionID: "child" });
		await observed;
		const second = ctx.progress({ status: "running" });
		await Promise.resolve();
		expect(f.forwarded).toEqual([]);
		finish();
		await Promise.all([first, second]);
		return { output: { sessionID: "child", status: "completed", output: "done" } };
	});
	const worker = await f.runtime.create(owner, config);
	await f.runtime.submit({ runId: "r", requestId: "q", worker, prompt: "work" }, { onEvent: () => {}, onReference: async () => { seen(); await gate; } });
	expect(f.forwarded).toHaveLength(2);
});

test("restored pending work reconciles exact proof without another native submission and persists before unlocking", async () => {
	let submissions = 0, proofChecks = 0, writes = 0;
	const f = fixture(async () => { submissions++; return {}; });
	const ref = { owner, runtime: "native-subagent", id: "child" };
	const worker = await f.runtime.restorePending(owner, config, { runId: "run", requestId: "original" }, ref);
	const request = { runId: "run", requestId: "original", worker, prompt: "" };
	const options = { onEvent: () => {}, onReference: async () => {} };
	await expect(f.runtime.submit({ ...request, prompt: "retry" }, options)).rejects.toThrow("uncertain");
	await expect(f.runtime.reconcile({ ...request, runId: "wrong" }, options, async () => { throw new Error("unexpected"); }, async () => {})).rejects.toThrow("matching");
	const proof = async (child: string, pending: typeof request) => { proofChecks++; expect(child).toBe("child"); expect(pending.requestId).toBe("original"); return { status: "error" as const, text: "failed" }; };
	const persist = async () => { if (++writes === 1) throw new Error("storage unavailable"); };
	await expect(f.runtime.reconcile(request, options, proof, persist)).rejects.toThrow("storage unavailable");
	await expect(f.runtime.release(worker)).rejects.toThrow("uncertain");
	const result = await f.runtime.reconcile(request, options, proof, persist);
	expect(result).toMatchObject({ status: "error", text: "failed", requestId: "original" });
	expect(submissions).toBe(0); expect(proofChecks).toBe(2);
	await f.runtime.release(worker);
});

test("restored intent without a child remains locked for manual recovery", async () => {
	const f = fixture(async () => { throw new Error("must not submit"); });
	const worker = await f.runtime.restorePending(owner, config, { runId: "r", requestId: "q" });
	const request = { runId: "r", requestId: "q", worker, prompt: "work" };
	const options = { onEvent: () => {}, onReference: async () => {} };
	await expect(f.runtime.submit(request, options)).rejects.toThrow("uncertain");
	await expect(f.runtime.reconcile(request, options, async () => ({ status: "completed", text: "" }), async () => {})).rejects.toThrow("No background completion");
	await expect(f.runtime.shutdown()).rejects.toThrow("uncertain");
});

test("restoring pending work validates ownership before creating a handle", async () => {
	const f = fixture(async () => ({}));
	await expect(f.runtime.restorePending(owner, config, { runId: "r", requestId: "q" }, { owner: { ...owner, supervisorId: "other" }, runtime: "native-subagent", id: "child" })).rejects.toThrow("Invalid");
	await expect(f.runtime.restorePending(owner, config, { runId: "r", requestId: "" })).rejects.toThrow("required");
});

test("foreground settlement failure blocks reuse until the same result is persisted", async () => {
	let submissions = 0;
	const f = fixture(async () => { submissions++; return { output: { sessionID: "child", status: "completed", output: "report" } }; });
	const worker = await f.runtime.create(owner, config);
	const request = { runId: "run", requestId: "req", worker, prompt: "work" };
	const options = { onEvent: () => {}, onReference: async () => {} };
	const result = await f.runtime.submit(request, options);
	await expect(f.runtime.submit(request, options)).rejects.toThrow("unsettled");
	await expect(f.runtime.settle({ ...request, requestId: "wrong" }, async () => {})).rejects.toThrow("matching");
	await expect(f.runtime.settle(request, async () => { throw new Error("storage failed"); })).rejects.toThrow("storage failed");
	await expect(f.runtime.release(worker)).rejects.toThrow("unsettled");
	await expect(f.runtime.shutdown()).rejects.toThrow("unsettled");
	let saved: unknown;
	await f.runtime.settle(request, async (value) => { saved = value; });
	expect(saved).toEqual(result);
	expect(submissions).toBe(1);
	await f.runtime.release(worker);
	await f.runtime.shutdown();
});
