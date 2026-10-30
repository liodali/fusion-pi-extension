import { expect, test } from "bun:test";
import { createOpenCodeWorkerRuntime } from "../src/opencode/worker-runtime.ts";
import type { WorkerEvent } from "../src/core/worker.ts";
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
	// Reconciliation after an interrupted turn cannot attribute usage to it.
	expect(result.usage).toBeUndefined();
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

type BusEvent = { id?: string; created?: number; type: string; data?: Record<string, unknown> };
function busFixture(execute: NativeSubagentExecute<Context>) {
	const forwarded: unknown[] = [];
	const context: Context = { sessionID: "parent", id: "call", messageID: "message", signal: new AbortController().signal, progress: async (update) => { forwarded.push(update); } };
	const sinks = new Set<(event: BusEvent) => void>();
	const runtime = createOpenCodeWorkerRuntime({ execute, contextFor: () => context, validateReference: async () => {}, bus: { add: (registered) => { sinks.add(registered); return () => { sinks.delete(registered); }; } } });
	return { runtime, context, forwarded, sinks, push: (event: BusEvent) => { for (const sink of sinks) sink(event); } };
}

test("owned-child bus events map to worker events with native identity and ownership", async () => {
	const observed: unknown[] = [];
	const f = busFixture(async (_input, ctx) => {
		await ctx.progress({ sessionID: "child", status: "running" });
		f.push({ id: "evt1", type: "session.text.started", data: { sessionID: "child", assistantMessageID: "m1" } });
		f.push({ id: "evt2", type: "session.text.delta", data: { sessionID: "child", delta: "hello" } });
		f.push({ id: "evt3", type: "session.reasoning.delta", data: { sessionID: "child", delta: "thinking" } });
		f.push({ type: "session.reasoning.ended", data: { sessionID: "child", text: "private reasoning content" } });
		f.push({ type: "session.text.ended", data: { sessionID: "child", text: "hello world" } });
		f.push({ id: "evt4", type: "session.step.started", data: { sessionID: "child" } });
		f.push({ id: "evt5", type: "session.text.delta", data: { sessionID: "other-child", delta: "foreign" } });
		f.push({ id: "evt6", type: "session.text.delta" });
		f.push({ type: "garbage" });
		f.push({ id: "evt7", type: "session.usage.updated", data: { sessionID: "child", cost: 0, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } });
		return { output: { sessionID: "child", status: "completed", output: "done" } };
	});
	const worker = await f.runtime.create(owner, config);
	const result = await f.runtime.submit({ runId: "run", requestId: "request", worker, prompt: "work" }, { onEvent: (event) => { observed.push(event); }, onReference: async () => {} });
	expect(observed).toEqual([
		{ runId: "run", requestId: "request", worker, nativeEventId: "evt1", event: { type: "text_start" } },
		{ runId: "run", requestId: "request", worker, nativeEventId: "evt2", event: { type: "text_delta", delta: "hello" } },
		{ runId: "run", requestId: "request", worker, nativeEventId: "evt3", event: { type: "reasoning_delta", delta: "thinking" } },
		{ runId: "run", requestId: "request", worker, nativeEventId: undefined, event: { type: "text_end", content: "hello world" } },
	]);
	// Full reasoning content never surfaces, and usage is accounting, not an event.
	expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0 });
	await f.runtime.settle({ runId: "run", requestId: "request", worker, prompt: "work" }, async () => {});
	await f.runtime.release(worker);
	await f.runtime.shutdown();
});

test("tool lifecycle maps through call identity with tracked names", async () => {
	const observed: unknown[] = [];
	const f = busFixture(async (_input, ctx) => {
		await ctx.progress({ sessionID: "child", status: "running" });
		f.push({ id: "e1", type: "session.tool.input.started", data: { sessionID: "child", id: "t1", name: "execute" } });
		f.push({ id: "e2", type: "session.tool.called", data: { sessionID: "child", id: "t1", input: { code: "x" }, executed: false } });
		f.push({ id: "e3", type: "session.tool.progress", data: { sessionID: "child", id: "t1", metadata: { status: "running" } } });
		f.push({ id: "e4", type: "session.tool.success", data: { sessionID: "child", id: "t1", content: [{ type: "text", text: "ok" }], metadata: { error: true } } });
		// A call whose input stream was never observed still ends with a name.
		f.push({ id: "e5", type: "session.tool.called", data: { sessionID: "child", id: "t2", input: {}, executed: false } });
		f.push({ id: "e6", type: "session.tool.success", data: { sessionID: "child", id: "t2", content: "clean", metadata: {} } });
		return { output: { sessionID: "child", status: "completed", output: "done" } };
	});
	const worker = await f.runtime.create(owner, config);
	await f.runtime.submit({ runId: "run", requestId: "request", worker, prompt: "work" }, { onEvent: (event) => { observed.push(event.event); }, onReference: async () => {} });
	expect(observed).toEqual([
		{ type: "tool_start", toolCallId: "t1", toolName: "execute", args: { code: "x" } },
		{ type: "tool_update", toolCallId: "t1", partialResult: { status: "running" } },
		{ type: "tool_end", toolCallId: "t1", toolName: "execute", isError: true, result: [{ type: "text", text: "ok" }] },
		{ type: "tool_start", toolCallId: "t2", toolName: "unknown", args: {} },
		{ type: "tool_end", toolCallId: "t2", toolName: "unknown", isError: false, result: "clean" },
	]);
});

test("turn usage is the delta of cumulative readings and stays unknown without them", async () => {
	const push: BusEvent[] = [];
	let turn = 0;
	const f = busFixture(async (_input, ctx) => {
		await ctx.progress({ sessionID: "child", status: "running" });
		const event = push[turn];
		turn++;
		if (event) f.push(event);
		return { output: { sessionID: "child", status: "completed", output: `done-${turn}` } };
	});
	const worker = await f.runtime.create(owner, config);
	const request = { runId: "run", requestId: "request", worker, prompt: "work" };
	const options = { onEvent: () => {}, onReference: async () => {} };
	// Turn 1: accounting arrives mid-turn on a fresh child; the whole reading is this turn's.
	push.push({ id: "u1", type: "session.usage.updated", data: { sessionID: "child", cost: 2, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 7, write: 3 } } } });
	const first = await f.runtime.submit(request, options);
	expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 10, cost: 2 });
	await f.runtime.settle(request, async () => {});
	await f.runtime.release(worker);
	// Turn 2 reuses the child: only the growth since the last reading is this turn's.
	const secondWorker = await f.runtime.open({ owner, runtime: "native-subagent", id: "child" }, config);
	push.push({ id: "u2", type: "session.usage.updated", data: { sessionID: "child", cost: 5, tokens: { input: 160, output: 80, reasoning: 30, cache: { read: 19, write: 4 } } } });
	const second = await f.runtime.submit({ ...request, worker: secondWorker }, options);
	expect(second.usage).toEqual({ inputTokens: 60, outputTokens: 30, cacheReadTokens: 12, cacheWriteTokens: 1, reasoningTokens: 20, cost: 3 });
	await f.runtime.settle({ ...request, worker: secondWorker }, async () => {});
	// A later turn with no new reading stays unknown rather than repeating stale numbers.
	const third = await f.runtime.submit({ ...request, worker: secondWorker }, options);
	expect(third.usage).toBeUndefined();
	await f.runtime.settle({ ...request, worker: secondWorker }, async () => {});
	await f.runtime.release(secondWorker);
});

test("events without an owned active turn never restart or leak into later turns", async () => {
	const f = busFixture(async (_input, ctx) => {
		await ctx.progress({ sessionID: "child", status: "running" });
		return { output: { sessionID: "child", status: "completed", output: "done" } };
	});
	const worker = await f.runtime.create(owner, config);
	const observed: unknown[] = [];
	await f.runtime.submit({ runId: "run", requestId: "request", worker, prompt: "work" }, { onEvent: (event) => { observed.push(event); }, onReference: async () => {} });
	// Late events after the turn is gone are dropped, and garbage input is inert.
	f.push({ id: "late", type: "session.text.delta", data: { sessionID: "child", delta: "late" } });
	f.push(undefined as never);
	f.push({ type: "session.text.delta", data: { sessionID: 42 } });
	expect(observed).toEqual([]);
	await f.runtime.settle({ runId: "run", requestId: "request", worker, prompt: "work" }, async () => {});
	await f.runtime.release(worker);
	await f.runtime.shutdown();
});

test("a reopened child reports unknown usage until a verified baseline exists", async () => {
	const readings: Omit<BusEvent, "created">[] = [];
	let turn = 0;
	const f = busFixture(async (_input, ctx) => {
		await ctx.progress({ sessionID: "child", status: "running" });
		const event = readings[turn];
		turn++;
		if (event) f.push({ ...event, created: Date.now() });
		return { output: { sessionID: "child", status: "completed", output: `done-${turn}` } };
	});
	// Reopen a pre-existing child: its cumulative reading may contain unobserved history.
	const worker = await f.runtime.open({ owner, runtime: "native-subagent", id: "child" }, config);
	const request = { runId: "run", requestId: "request", worker, prompt: "work" };
	const options = { onEvent: () => {}, onReference: async () => {} };
	readings.push({ id: "u1", type: "session.usage.updated", data: { sessionID: "child", cost: 9, tokens: { input: 900, output: 90, reasoning: 9, cache: { read: 9, write: 9 } } } });
	const first = await f.runtime.submit(request, options);
	expect(first.usage).toBeUndefined();
	await f.runtime.settle(request, async () => {});
	// The next turn owns a verified baseline: the reading observed during the reopen turn.
	readings.push({ id: "u2", type: "session.usage.updated", data: { sessionID: "child", cost: 11, tokens: { input: 1000, output: 120, reasoning: 19, cache: { read: 13, write: 11 } } } });
	const second = await f.runtime.submit(request, options);
	expect(second.usage).toEqual({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 10, cost: 2 });
	await f.runtime.settle(request, async () => {});
	await f.runtime.release(worker);
});

test("delayed accounting on a later fresh turn stays unknown", async () => {
	const perTurn: Omit<BusEvent, "created">[][] = [];
	let turn = 0;
	const f = busFixture(async (_input, ctx) => {
		await ctx.progress({ sessionID: "child", status: "running" });
		for (const event of perTurn[turn] ?? []) f.push({ ...event, created: Date.now() });
		turn++;
		return { output: { sessionID: "child", status: "completed", output: `done-${turn}` } };
	});
	const worker = await f.runtime.create(owner, config);
	const request = { runId: "run", requestId: "request", worker, prompt: "work" };
	const options = { onEvent: () => {}, onReference: async () => {} };
	// Turn 1 measures nothing; turn 2's first reading includes turn 1's tokens and cannot be attributed.
	perTurn.push([]);
	await f.runtime.submit(request, options);
	await f.runtime.settle(request, async () => {});
	perTurn.push([{ id: "u1", type: "session.usage.updated", data: { sessionID: "child", cost: 5, tokens: { input: 150, output: 60, reasoning: 0, cache: { read: 0, write: 0 } } } }]);
	const second = await f.runtime.submit(request, options);
	expect(second.usage).toBeUndefined();
	await f.runtime.settle(request, async () => {});
	// Turn 3 has a verified baseline from turn 2's reading.
	perTurn.push([{ id: "u2", type: "session.usage.updated", data: { sessionID: "child", cost: 7, tokens: { input: 200, output: 90, reasoning: 10, cache: { read: 5, write: 0 } } } }]);
	const third = await f.runtime.submit(request, options);
	expect(third.usage).toEqual({ inputTokens: 50, outputTokens: 30, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 10, cost: 2 });
	await f.runtime.settle(request, async () => {});
	await f.runtime.release(worker);
});

test("prior-turn replays are rejected by creation time", async () => {
	const observed: unknown[] = [];
	const f = busFixture(async (_input, ctx) => {
		await ctx.progress({ sessionID: "child", status: "running" });
		f.push({ id: "old", created: Date.now() - 60000, type: "session.text.delta", data: { sessionID: "child", delta: "stale replay" } });
		f.push({ id: "now", created: Date.now(), type: "session.text.delta", data: { sessionID: "child", delta: "current" } });
		f.push({ id: "undated", type: "session.text.delta", data: { sessionID: "child", delta: "unverifiable" } });
		return { output: { sessionID: "child", status: "completed", output: "done" } };
	});
	const worker = await f.runtime.create(owner, config);
	await f.runtime.submit({ runId: "run", requestId: "request", worker, prompt: "work" }, { onEvent: (event) => { observed.push((event as { event: { type: string; delta?: string } }).event.delta); }, onReference: async () => {} });
	expect(observed).toEqual(["current", "unverifiable"]);
	await f.runtime.settle({ runId: "run", requestId: "request", worker, prompt: "work" }, async () => {});
	await f.runtime.release(worker);
});

test("replayed usage readings cannot regress the cumulative state", async () => {
	const turns: { event: Omit<BusEvent, "created">; ageMs?: number }[][] = [];
	let turn = 0;
	const f = busFixture(async (_input, ctx) => {
		await ctx.progress({ sessionID: "child", status: "running" });
		for (const { event, ageMs } of turns[turn] ?? []) f.push({ ...event, created: Date.now() - (ageMs ?? 0) });
		turn++;
		return { output: { sessionID: "child", status: "completed", output: `done-${turn}` } };
	});
	const worker = await f.runtime.create(owner, config);
	const request = { runId: "run", requestId: "request", worker, prompt: "work" };
	const options = { onEvent: () => {}, onReference: async () => {} };
	// Turn 1 sees a newer reading and then an older replay; the replay must not overwrite it.
	turns.push([
		{ event: { id: "u1", type: "session.usage.updated", data: { sessionID: "child", cost: 4, tokens: { input: 400, output: 40, reasoning: 4, cache: { read: 4, write: 4 } } } } },
		{ event: { id: "u0", type: "session.usage.updated", data: { sessionID: "child", cost: 1, tokens: { input: 100, output: 10, reasoning: 1, cache: { read: 1, write: 1 } } } }, ageMs: 60000 },
	]);
	const first = await f.runtime.submit(request, options);
	expect(first.usage).toMatchObject({ inputTokens: 400, cost: 4 });
	await f.runtime.settle(request, async () => {});
	// The verified baseline for the next turn is the newest reading, not the replay.
	turns.push([
		{ event: { id: "u2", type: "session.usage.updated", data: { sessionID: "child", cost: 6, tokens: { input: 500, output: 60, reasoning: 6, cache: { read: 6, write: 6 } } } } },
	]);
	const second = await f.runtime.submit(request, options);
	expect(second.usage).toMatchObject({ inputTokens: 100, cost: 2 });
	await f.runtime.settle(request, async () => {});
	await f.runtime.release(worker);
});

test("a replayed native id is rejected in later turns even without a timestamp", async () => {
	const observed: string[] = [];
	const perTurn: BusEvent[][] = [];
	let turn = 0;
	const f = busFixture(async (_input, ctx) => {
		await ctx.progress({ sessionID: "child", status: "running" });
		for (const event of perTurn[turn] ?? []) f.push(event);
		turn++;
		return { output: { sessionID: "child", status: "completed", output: `done-${turn}` } };
	});
	const worker = await f.runtime.create(owner, config);
	const request = { runId: "run", requestId: "request", worker, prompt: "work" };
	const options = { onEvent: (event: WorkerEvent) => { if (event.event.type === "text_delta") observed.push(event.event.delta); }, onReference: async () => {} };
	perTurn.push([{ id: "e1", type: "session.text.delta", data: { sessionID: "child", delta: "first-turn delivery" } }]);
	await f.runtime.submit(request, options);
	await f.runtime.settle(request, async () => {});
	// The id was routed during the first turn; a redelivery must not join the next request.
	perTurn.push([
		{ id: "e1", type: "session.text.delta", data: { sessionID: "child", delta: "replayed" } },
		{ id: "e2", type: "session.text.delta", data: { sessionID: "child", delta: "fresh" } },
	]);
	await f.runtime.submit(request, options);
	await f.runtime.settle(request, async () => {});
	await f.runtime.release(worker);
	// Reopening the child keeps the replay memory: past ids stay rejected.
	const reopened = await f.runtime.open({ owner, runtime: "native-subagent", id: "child" }, config);
	perTurn.push([{ id: "e1", type: "session.text.delta", data: { sessionID: "child", delta: "replayed after reopen" } }]);
	await f.runtime.submit({ ...request, worker: reopened }, options);
	await f.runtime.settle({ ...request, worker: reopened }, async () => {});
	expect(observed).toEqual(["first-turn delivery", "fresh"]);
	await f.runtime.release(reopened);
});

test("capabilities stay per-instance: streaming only with the host bus", async () => {
	const plain = fixture(async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }));
	expect(plain.runtime.capabilities.workerEvents).toBe(false);
	let sink: ((event: BusEvent) => void) | undefined;
	const streaming = createOpenCodeWorkerRuntime({ execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }), contextFor: () => plain.context, validateReference: async () => {}, bus: { add: (registered) => { sink = registered; return () => { sink = undefined; }; } } });
	expect(streaming.capabilities.workerEvents).toBe(true);
	expect(typeof sink).toBe("function");
	await streaming.shutdown();
	expect(sink).toBeUndefined();
});

test("a decreasing cumulative reading leaves turn usage unknown", async () => {
	const readings: BusEvent[] = [];
	let turn = 0;
	const f = busFixture(async (_input, ctx) => {
		await ctx.progress({ sessionID: "child", status: "running" });
		const event = readings[turn];
		turn++;
		if (event) f.push(event);
		return { output: { sessionID: "child", status: "completed", output: `done-${turn}` } };
	});
	const worker = await f.runtime.create(owner, config);
	const request = { runId: "run", requestId: "request", worker, prompt: "work" };
	const options = { onEvent: () => {}, onReference: async () => {} };
	readings.push({ id: "u1", type: "session.usage.updated", data: { sessionID: "child", cost: 5, tokens: { input: 160, output: 80, reasoning: 30, cache: { read: 19, write: 4 } } } });
	const first = await f.runtime.submit(request, options);
	expect(first.usage?.inputTokens).toBe(160);
	await f.runtime.settle(request, async () => {});
	// A later reading below the baseline would otherwise produce negative accounting.
	readings.push({ id: "u2", type: "session.usage.updated", data: { sessionID: "child", cost: 1, tokens: { input: 40, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } });
	const second = await f.runtime.submit(request, options);
	expect(second.usage).toBeUndefined();
	await f.runtime.settle(request, async () => {});
	await f.runtime.release(worker);
});
