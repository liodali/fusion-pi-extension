import { expect, test } from "bun:test";
import { delegateInput, delegateMonitor } from "../src/opencode/delegate-presentation.ts";
import { actionLabel, elapsedLabel, latestDelegateActivity } from "../src/opencode/activity-view.ts";
import { stopFeedback, type ExecutorStop } from "../src/opencode/executor-stop.ts";
import type { WorkerEvent, ExecutorEvent } from "../src/core/worker.ts";

const event = (value: ExecutorEvent) => ({ event: value }) as WorkerEvent;

test("compact input preserves the full brief and original task; legacy direct calls remain valid", () => {
	const brief = "Instructions\n".repeat(1000);
	expect(delegateInput({ action: "revise", title: "Fix upload tests", details: { brief, originalTask: "Upload support" } })).toEqual({ action: "revise", title: "Fix upload tests", brief, originalTask: "Upload support" });
	expect(delegateInput({ action: "execute", brief })).toMatchObject({ action: "execute", brief });
	expect(() => delegateInput({ action: "execute", details: { brief }, brief: "conflicting" })).toThrow("details only");
	expect(() => delegateInput({ action: "execute", details: { brief: 1 } })).toThrow("Invalid");
});

test("stalled progress never blocks work and coalesces bounded updates without losing the child reference", async () => {
	const updates: Record<string, unknown>[] = [];
	let unlock!: () => void;
	const gate = new Promise<void>((resolve) => { unlock = resolve; });
	const monitor = delegateMonitor({ action: "execute", title: "Implement objects", streaming: true, progress: async (update) => { await gate; updates.push(update); }, now: () => 1000 });
	void monitor.start();
	const published = monitor.nativeProgress({ sessionID: "ses_child", status: "running" });
	monitor.onEvent(event({ type: "tool_start", toolCallId: "call", toolName: "edit", args: { secret: "private-input" } }));
	monitor.onEvent(event({ type: "tool_start", toolCallId: "call", toolName: "edit", args: {} }));
	monitor.onEvent(event({ type: "tool_end", toolCallId: "call", toolName: "edit", isError: false, result: "private-result" }));
	const final = await monitor.finish("completed");
	expect(updates).toHaveLength(0);
	expect(final).toMatchObject({ phase: "completed", tools: 1, childSessionID: "ses_child" });
	await published;
	unlock();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(updates).toHaveLength(2);
	expect(updates[1]).toMatchObject({ sessionID: "ses_child", status: "running" });
	expect((updates.at(-1)!.fusion as { phase: string }).phase).toBe("completed");
	expect(JSON.stringify(updates)).not.toContain("private-");
	monitor.onEvent(event({ type: "tool_start", toolCallId: "late", toolName: "write", args: {} }));
	expect(monitor.snapshot().tools).toBe(1);
});

test("private reasoning and output are ignored; UI failures do not fail execution", async () => {
	const monitor = delegateMonitor({ action: "final_fix", title: "Final checks", streaming: false, progress: async () => { throw Error("UI offline"); } });
	await monitor.start();
	monitor.onEvent(event({ type: "reasoning_delta", delta: "private reasoning" }));
	monitor.onEvent(event({ type: "text_delta", delta: "private output" }));
	expect(monitor.snapshot().activity).toBe("Executor activity unavailable");
	await expect(monitor.finish("background")).resolves.toMatchObject({ phase: "background", tools: 0 });
});

test("activity view selects the newest delegation and keeps streamed inputs from resurrecting old activity", () => {
	const old = { type: "tool", name: "fusion_delegate", state: { status: "completed", input: { action: "execute", title: "Old" } }, time: { created: 1000 } };
	const messages = [{ type: "assistant", content: [old] }, { type: "assistant", content: [{ type: "tool", name: "fusion_delegate", state: { status: "streaming", input: {} } }] }];
	expect(latestDelegateActivity(messages)).toBeUndefined();
	expect(latestDelegateActivity(messages.slice(0, 1))).toMatchObject({ title: "Old", phase: "completed" });
	expect(actionLabel("final_fix")).toBe("Final fix");
	expect(elapsedLabel(1000, 66000)).toBe("1:05");
	expect(elapsedLabel(5000, 0)).toBe("0:00");
});

test("a matching reconciliation updates a background card without settling unrelated children", () => {
	const activity = { version: 1, action: "execute", title: "Objects", phase: "background", activity: "Awaiting reconciliation", tools: 3, startedAt: 1000, updatedAt: 2000, childSessionID: "ses_child", requestId: "req_current" };
	const parent = { type: "assistant", content: [{ type: "tool", name: "fusion_delegate", state: { status: "completed", metadata: { fusion: activity } } }] };
	const reconcile = (childSessionID: string, requestId = "req_current") => ({ type: "assistant", content: [{ type: "tool", name: "fusion_reconcile", time: { completed: 5000 }, state: { status: "completed", metadata: { childSessionID, requestId, status: "completed" } } }] });
	expect(latestDelegateActivity([parent, reconcile("ses_other")])).toMatchObject({ phase: "background", tools: 3 });
	expect(latestDelegateActivity([parent, reconcile("ses_child", "req_previous")])).toMatchObject({ phase: "background" });
	expect(latestDelegateActivity([parent, reconcile("ses_child")])).toMatchObject({ phase: "completed", tools: 3, updatedAt: 5000 });
});

test("completion while stopping is reported as completion rather than cancellation", () => {
	const stop: ExecutorStop = { requestId: "request", requestedAt: 2000, updatedAt: 3000, state: "confirmed", terminal: "completed", reason: "stop" };
	const messages = [{ type: "assistant", content: [{ type: "tool", name: "fusion_delegate", state: { metadata: { fusion: { version: 1, action: "execute", title: "Task", phase: "working", activity: "Running edit", tools: 1, startedAt: 1000, updatedAt: 2000, childSessionID: "ses_child", requestId: "request" } } } }] }, { type: "synthetic", metadata: { fusionStop: stop } }];
	expect(latestDelegateActivity(messages)).toMatchObject({ phase: "completed", activity: "Executor completed before interruption" });
	expect(stopFeedback(stop)).toContain("completed before interruption");
});
