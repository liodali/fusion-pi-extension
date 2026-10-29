import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExecutorBackend, ExecutorHandle } from "../src/pi/executor-backend.ts";
import { createPiWorkerRuntime } from "../src/pi/worker-runtime.ts";
import { createEmptyUsage } from "../src/usage.ts";

const owner = { harness: "pi", supervisorId: "parent", workspace: "/workspace" };
const model = { provider: "test", id: "model" } as Model<Api>;
const config = { role: "executor" as const, model: { provider: "test", modelId: "model", variant: "high" } };
const options = { onEvent: () => {}, onReference: async () => {} };

function fixture() {
	const calls: string[] = [];
	let finish!: () => void;
	let wait = false;
	const native: ExecutorHandle = {
		model, thinking: "high", resumeRef: () => "42",
		async setThinking(level) { calls.push(`thinking:${level}`); },
		async prompt(_text, opts) { calls.push(`submit:${opts.requestId}`); opts.onEvent({ type: "text_start" }); if (wait) await new Promise<void>((resolve) => { finish = resolve; }); return { text: "done", usage: createEmptyUsage() }; },
		async resume(opts) { calls.push(`resume:${opts.requestId}`); return { text: "recovered", stopReason: "aborted", usage: createEmptyUsage() }; },
		async abort() { calls.push("abort"); }, dispose() { calls.push("release"); },
	};
	const backend: ExecutorBackend = {
		kind: "durable", capabilities: { transcriptReopen: true, activeTurnReattach: true, durableExecution: true, idempotentSubmission: false, readOnlyScout: true, exactScoutToolLimit: true },
		async createExecutor() { return native; }, async openExecutor(_config, ref) { calls.push(`open:${ref}`); return native; },
		async scout(request) { calls.push(`scout:${request.maxToolCalls}:${request.thinking}`); return { text: "partial", capped: true, usage: createEmptyUsage() }; },
		async dispose() { calls.push("shutdown"); },
	};
	return { calls, native, backend, runtime: createPiWorkerRuntime(backend, () => model), wait: () => { wait = true; }, finish: () => finish() };
}

test("Pi executor applies per-turn thinking, forwards owned events and preserves usage", async () => {
	const f = fixture();
	const worker = await f.runtime.create(owner, config);
	expect(worker.reference).toEqual({ owner, runtime: "durable", id: "42" });
	const events: unknown[] = [];
	const result = await f.runtime.submit({ runId: "run", requestId: "req", worker, prompt: "work", variant: "low" }, { ...options, onEvent: (event) => events.push(event) });
	expect(f.calls).toEqual(["thinking:low", "submit:req"]);
	expect(events).toEqual([{ runId: "run", requestId: "req", worker, event: { type: "text_start" } }]);
	expect(result).toMatchObject({ status: "completed", role: "executor", text: "done", usage: { inputTokens: 0 } });
	await f.runtime.release(worker);
	await f.runtime.shutdown();
	expect(f.calls.slice(-2)).toEqual(["release", "shutdown"]);
});

test("reattachment uses the original request without submitting or reconfiguring", async () => {
	const f = fixture();
	const worker = await f.runtime.open({ owner, runtime: "durable", id: "42" }, config);
	const result = await f.runtime.reattach({ runId: "run", requestId: "original", worker, prompt: "ignored" }, options);
	expect(f.calls).toEqual(["open:42", "resume:original"]);
	expect(result).toMatchObject({ status: "cancelled", text: "recovered" });
	await expect(f.runtime.open({ owner, runtime: "session", id: "42" }, config)).rejects.toThrow();
});

test("active workers cannot be released, shut down, or submitted twice", async () => {
	const f = fixture();
	f.wait();
	const worker = await f.runtime.create(owner, config);
	const request = { runId: "run", requestId: "req", worker, prompt: "work" };
	const pending = f.runtime.submit(request, options);
	await Promise.resolve();
	await expect(f.runtime.submit(request, options)).rejects.toThrow("active turn");
	await expect(f.runtime.release(worker)).rejects.toThrow("active");
	await expect(f.runtime.shutdown()).rejects.toThrow("active");
	await f.runtime.abort(worker);
	f.finish();
	await pending;
	await f.runtime.shutdown();
});

test("scout passes the limit and reports capping without creating an executor", async () => {
	const f = fixture();
	const worker = await f.runtime.create(owner, { ...config, role: "scout", maxToolCalls: 3 });
	const result = await f.runtime.submit({ runId: "r", requestId: "s", worker, prompt: "find", variant: "low" }, options);
	expect(f.calls).toEqual(["scout:3:low"]);
	expect(result).toMatchObject({ role: "scout", capped: true });
	await f.runtime.shutdown();
});

test("Durable runtime prevents another executor or scout from disturbing active work", async () => {
	const f = fixture();
	f.wait();
	const executor = await f.runtime.create(owner, config);
	const scout = await f.runtime.create(owner, { ...config, role: "scout", maxToolCalls: 3 });
	const pending = f.runtime.submit({ runId: "r", requestId: "q", worker: executor, prompt: "work" }, options);
	await Promise.resolve();
	await expect(f.runtime.open({ owner, runtime: "durable", id: "42" }, config)).rejects.toThrow("already has an executor");
	await expect(f.runtime.create(owner, config)).rejects.toThrow("already has an executor");
	await expect(f.runtime.submit({ runId: "r", requestId: "s", worker: scout, prompt: "find" }, options)).rejects.toThrow("active work");
	expect(f.calls).not.toContain("open:42");
	f.finish();
	await pending;
	await f.runtime.shutdown();
});

test("shutdown attempts all cleanup and retries only failed resources", async () => {
	const f = fixture();
	const calls: string[] = [];
	let created = 0;
	let backendAttempts = 0;
	const backend: ExecutorBackend = { ...f.backend, kind: "session", createExecutor: async () => {
		const id = ++created;
		let attempts = 0;
		return { ...f.native, resumeRef: () => String(id), dispose() {
			calls.push(`handle:${id}`);
			if (id === 1 && ++attempts === 1) throw new Error("handle failure");
		} };
	}, dispose: async () => { calls.push("backend"); if (++backendAttempts === 1) throw new Error("backend failure"); } };
	const runtime = createPiWorkerRuntime(backend, () => model);
	await runtime.create(owner, config);
	await runtime.create(owner, config);
	await expect(runtime.shutdown()).rejects.toThrow("cleanup failed");
	expect(calls).toEqual(["handle:1", "handle:2", "backend"]);
	await expect(runtime.create(owner, config)).rejects.toThrow("shut down");
	await runtime.shutdown();
	expect(calls).toEqual(["handle:1", "handle:2", "backend", "handle:1", "backend"]);
	await runtime.shutdown();
	expect(calls).toHaveLength(5);
});

test("a small turn does not change the configured thinking for the next standard turn", async () => {
	const f = fixture();
	const worker = await f.runtime.create(owner, config);
	await f.runtime.submit({ runId: "r", requestId: "small", worker, prompt: "work", variant: "low" }, options);
	await f.runtime.submit({ runId: "r", requestId: "standard", worker, prompt: "work" }, options);
	expect(f.calls).toEqual(["thinking:low", "submit:small", "thinking:high", "submit:standard"]);
	await f.runtime.release(worker);
});

test("adopted executors retain host ownership and cannot be adopted twice", async () => {
	const f = fixture();
	expect(() => f.runtime.adoptExecutor(owner, config, f.native)).toThrow("host-owned backend");
	const runtime = createPiWorkerRuntime(f.backend, () => model, { disposeBackend: false });
	const worker = runtime.adoptExecutor(owner, config, f.native);
	expect(() => runtime.adoptExecutor(owner, config, f.native)).toThrow("already owned");
	expect(() => runtime.adoptExecutor(owner, config, { ...f.native })).toThrow("already has an executor");
	await runtime.release(worker);
	const next = runtime.adoptExecutor(owner, config, f.native);
	await runtime.shutdown();
	expect(f.calls).not.toContain("release");
	expect(f.calls).not.toContain("shutdown");
	await expect(runtime.submit({ runId: "r", requestId: "q", worker: next, prompt: "work" }, options)).rejects.toThrow("unavailable");
});
