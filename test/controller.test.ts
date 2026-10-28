import { expect, test } from "bun:test";
import { FusionController, FusionLifecycle } from "../src/core/controller.ts";
import { readRecoveryRecord, recoveryDisposition } from "../src/core/recovery.ts";

test("controller applies delegation budgets and releases the in-flight guard", () => {
	const state = { delegating: false, executed: false, revisions: 0, finalFixUsed: false, resumePending: false, scoutCalls: 0 };
	const controller = new FusionController(state);
	expect(controller.beginDelegation("execute")).toBeUndefined();
	expect(controller.beginDelegation("execute")).toContain("already in progress");
	controller.completeDelegation();
	controller.endDelegation("execute");
	for (let i = 0; i < 3; i++) { expect(controller.beginDelegation("revise")).toBeUndefined(); controller.endDelegation("revise"); }
	expect(controller.beginDelegation("revise")).toContain("Revision limit");
	expect(controller.beginDelegation("final_fix")).toBeUndefined();
	controller.endDelegation("final_fix");
	expect(controller.beginDelegation("final_fix")).toContain("already used");
	for (let i = 0; i < 4; i++) expect(controller.beginScout()).toBeUndefined();
	expect(controller.beginScout()).toContain("Scout limit");
});

test("shared lifecycle retains the original request and restores legacy runs", () => {
	const state = { runActive: false, phase: "idle" as const, delegating: false, executed: false, revisions: 0, finalFixUsed: false, resumePending: false, settleNudges: 0, scoutCalls: 0 };
	const controller = new FusionLifecycle(state);
	controller.start("original request");
	expect(controller.continuation({ lastAssistantText: "", outcome: "completed", canContinue: true })).toContain("have not delegated");
	expect(controller.state.settleNudges).toBe(1);
	controller.prepareExecution("implementation brief");
	expect(controller.state.originalTask).toBe("original request");
	controller.restore({ task: "legacy task", brief: "legacy brief", revisions: 2 }, true);
	expect(controller.state.originalTask).toBe("legacy task");
	expect(controller.state.resumePending).toBe(true);
	expect(controller.state.revisions).toBe(2);
	controller.setPhase("failed");
	controller.settled(false);
	expect(controller.state.phase).toBe("failed");
	expect(controller.state.runActive).toBe(false);
	controller.clear();
	expect(controller.state.runActive).toBe(false);
	expect(controller.state.originalTask).toBeUndefined();
});

test("recovery rejects unsupported versions and records belonging to other workspaces", () => {
	const state = { runActive: true, phase: "executing", delegating: true, executed: false, revisions: 0, finalFixUsed: false, resumePending: false, settleNudges: 0, scoutCalls: 0 };
	const record = { version: 1, harness: "opencode", workspace: "/one", parentSessionID: "parent", state, pending: { action: "execute", description: "turn" } };
	expect(readRecoveryRecord(record, "/one", "opencode").pending?.description).toBe("turn");
	expect(recoveryDisposition(record as Parameters<typeof recoveryDisposition>[0])).toBe("manual");
	expect(recoveryDisposition({ ...record, childSessionID: "child" } as Parameters<typeof recoveryDisposition>[0])).toBe("reconcile");
	expect(recoveryDisposition({ ...record, pending: undefined } as Parameters<typeof recoveryDisposition>[0])).toBe("settled");
	expect(() => readRecoveryRecord({ ...record, version: 2 }, "/one", "opencode")).toThrow("Unsupported");
	expect(() => readRecoveryRecord(record, "/two", "opencode")).toThrow("Invalid");
	expect(() => readRecoveryRecord(record, "/one", "pi")).toThrow("Invalid");
});
