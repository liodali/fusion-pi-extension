import { expect, test } from "bun:test";
import { createManifestStore, readRunManifest, translateOpenCodeV1, type RunManifest } from "../src/core/manifest.ts";
import { OPENCODE_CAPABILITIES } from "../src/opencode/native-executor.ts";
import { translatePiRun } from "../src/pi/manifest-translation.ts";
import type { FusionRun } from "../src/runs.ts";

const scope = { harness: "opencode", workspace: "/workspace" };
const owner = { ...scope, supervisorId: "parent" };
const state = { runActive: true, phase: "executing" as const, delegating: true, executed: false, revisions: 1, finalFixUsed: false, resumePending: false, scoutCalls: 0, settleNudges: 0, originalTask: "original" };
function manifest(): RunManifest {
	return { version: 2, runId: "run", owner, state: { ...state }, capabilities: OPENCODE_CAPABILITIES, recovery: "pending", pending: { action: "revise", requestId: "exact" }, worker: { owner, runtime: "native-subagent", id: "child" } };
}
function legacy() {
	return { version: 1, harness: "opencode", workspace: "/workspace", parentSessionID: "parent", state, childSessionID: "child", pending: { action: "revise", description: "exact" } };
}

test("shared manifests preserve pending intent even with a completed result and no child", () => {
	const value = { ...manifest(), worker: undefined, lastResult: { requestId: "exact", status: "completed" as const, text: "report" } };
	const read = readRunManifest(value, scope);
	expect(read.pending?.requestId).toBe("exact");
	expect(read.recovery).toBe("pending");
	read.state.originalTask = "changed";
	expect(value.state.originalTask).toBe("original");
});

test("malformed or mismatched recovery data never becomes a fresh run", () => {
	const invalid = [
		{ ...manifest(), version: 3 },
		{ ...manifest(), pending: undefined },
		{ ...manifest(), recovery: "settled" },
		{ ...manifest(), pending: { action: "resume", requestId: "exact" } },
		{ ...manifest(), worker: { ...manifest().worker, owner: { ...owner, supervisorId: "other" } } },
		{ ...manifest(), worker: { owner, runtime: "durable", id: "child" } },
		{ ...manifest(), capabilities: {} },
		{ ...manifest(), state: { ...state, revisions: -1 } },
		{ ...manifest(), lastResult: { requestId: "q", status: "running" } },
	];
	for (const value of invalid) expect(() => readRunManifest(value, scope)).toThrow();
	expect(() => readRunManifest(manifest(), { ...scope, workspace: "/other" })).toThrow();
});

test("OpenCode v1 translation preserves original request, budgets and legacy metadata", () => {
	const old = legacy();
	const before = JSON.stringify(old);
	const read = translateOpenCodeV1(old, scope.workspace, OPENCODE_CAPABILITIES);
	expect(read.pending).toEqual({ action: "revise", requestId: "exact" });
	expect(read.worker?.id).toBe("child");
	expect(read.state.revisions).toBe(1);
	expect(read.runId).toBe("opencode:parent");
	expect(read.adapterData?.legacyOpenCode).toEqual(old);
	expect(JSON.stringify(old)).toBe(before);
});

test("injected store loads v1 without writing and propagates every transport failure", async () => {
	let raw: unknown = legacy();
	let writes = 0, removals = 0, failure = "";
	const store = createManifestStore({
		read: async () => { if (failure === "read") throw new Error("read failure"); return raw; },
		write: async (value) => { if (failure === "write") throw new Error("write failure"); writes++; raw = value; },
		remove: async () => { if (failure === "remove") throw new Error("remove failure"); removals++; raw = undefined; },
	}, scope, (value) => translateOpenCodeV1(value, scope.workspace, OPENCODE_CAPABILITIES));
	expect((await store.load())?.pending?.requestId).toBe("exact"); expect(writes).toBe(0);
	await expect(store.removeSettled("opencode:parent")).rejects.toThrow("unsettled"); expect(removals).toBe(0);
	failure = "read"; await expect(store.load()).rejects.toThrow("read failure");
	failure = "write"; await expect(store.save(manifest())).rejects.toThrow("write failure");
	failure = "";
	const settled = { ...manifest(), state: { ...state, delegating: false }, recovery: "settled" as const, pending: undefined };
	await store.save(settled);
	settled.state.originalTask = "caller mutation";
	expect((await store.load())?.state.originalTask).toBe("original");
	await expect(store.removeSettled("other")).rejects.toThrow("differently owned");
	failure = "remove"; await expect(store.removeSettled("run")).rejects.toThrow("remove failure");
	failure = ""; expect((await store.load())?.runId).toBe("run");
	await store.removeSettled("run"); expect(await store.load()).toBeUndefined();
	raw = { ...legacy(), version: 99 }; await expect(store.load()).rejects.toThrow("Unsupported");
});

test("Pi translation preserves exact Durable and legacy session references without inventing requests", () => {
	const piOwner = { harness: "pi", supervisorId: "pi-parent", workspace: "/pi" };
	const run: FusionRun = { runId: "pi-run", cwd: "/pi", task: "task", brief: "brief", executor: { provider: "provider", modelId: "model", label: "provider/model", thinking: "low" }, status: "interrupted", revisions: 2, finalFixUsed: true, results: {}, updatedAt: "2026-10-29T00:00:00Z", backend: "durable", conversationId: 42, pending: { action: "final_fix", requestId: "original" } };
	const before = JSON.stringify(run);
	const durable = translatePiRun(run, piOwner, { ...OPENCODE_CAPABILITIES, activeTurnReattach: true, durableExecution: true });
	expect(durable.worker).toEqual({ owner: piOwner, runtime: "durable", id: "42" });
	expect(durable.pending).toEqual(run.pending);
	expect(durable.state.finalFixUsed).toBe(true);
	expect(durable.adapterData?.legacyPi).toEqual(run);
	const session = translatePiRun({ ...run, backend: undefined, conversationId: undefined, pending: undefined, sessionFile: "/session.jsonl" }, piOwner, OPENCODE_CAPABILITIES);
	expect(session.worker?.runtime).toBe("session"); expect(session.worker?.id).toBe("/session.jsonl");
	expect(session.recovery).toBe("manual"); expect(session.pending).toBeUndefined();
	const resolved = translatePiRun({ ...run, status: "failed", manualResolution: { at: "2026-10-29T00:00:00Z" } }, piOwner, OPENCODE_CAPABILITIES);
	expect(resolved.recovery).toBe("settled"); expect(resolved.pending).toBeUndefined();
	expect(resolved.operatorResolution?.pending).toEqual(run.pending);
	expect(JSON.stringify(run)).toBe(before);
});
