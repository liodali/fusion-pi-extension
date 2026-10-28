import { describe, expect, test } from "bun:test";
import { FusionController, type ControllerServices, type DelegationPorts } from "../src/core/controller.ts";
import type { LifecycleState } from "../src/core/workflow.ts";
import { OPENCODE_CAPABILITIES } from "../src/opencode/native-executor.ts";

function controller(services?: Partial<ControllerServices>): FusionController {
	const state: LifecycleState = { runActive: false, phase: "idle", delegating: false, executed: false, revisions: 0,
		finalFixUsed: false, resumePending: false, scoutCalls: 0, settleNudges: 0 };
	return new FusionController(state, services ? { now: () => 0, newRunId: () => "run", newRequestId: () => "", ...services } : undefined);
}

function ports(log: string[], fail?: string): DelegationPorts<string, string, string, string> {
	const stage = (name: string, value: string) => async () => {
		log.push(name);
		if (fail === name) throw new Error(name);
		return value;
	};
	return { claim: async () => { await stage("claim", "")(); }, recordIntent: async () => { await stage("intent", "")(); }, snapshot: stage("snapshot", "baseline"),
		submit: async (snapshot) => { expect(snapshot).toBe("baseline"); return stage("submit", "output")(); },
		collect: async (output, snapshot) => { expect([output, snapshot]).toEqual(["output", "baseline"]); return stage("collect", "evidence")(); },
		settle: async (evidence) => { expect(evidence).toBe("evidence"); return stage("settle", "result")(); } };
}

for (const harness of ["pi", "opencode"] as const) {
	describe(`shared delegation sequence: ${harness}`, () => {
		test("retains the original task, runs ordered ports, and blocks concurrent work", async () => {
			const fusion = controller();
			if (harness === "pi") fusion.start("original task");
			expect(fusion.beginDelegation("execute", undefined, "  ")).toContain("non-empty");
			expect(fusion.state.delegating).toBe(false);
			expect(fusion.beginDelegation("execute")).toBeUndefined();
			if (harness === "pi") fusion.prepareExecution("brief");
			else fusion.startExecution("original task", "brief");
			expect(fusion.state.originalTask).toBe("original task");
			expect(fusion.beginDelegation("execute")).toContain("already in progress");
			expect(fusion.resetError()).toContain("active");
			const log: string[] = [];
			expect(await fusion.performDelegation(ports(log))).toBe("result");
			expect(log).toEqual(["claim", "intent", "snapshot", "submit", "collect", "settle"]);
			fusion.settleDelegation("completed");
			fusion.clearPending();
			fusion.endDelegation("execute");
			expect(fusion.beginDelegation("final_fix")).toBeUndefined();
			expect(fusion.delegationPrompt("final_fix", "gaps")).toContain("original task");
			fusion.clearPending();
			fusion.endDelegation("final_fix");
			expect(fusion.resetError()).toBeUndefined();
			fusion.settleDelegation("error");
			expect(fusion.state.phase).toBe("failed");
		});

		test("refunds confirmed pre-submission failures but retains uncertain budgets", async () => {
			const fusion = controller();
			fusion.start("task");
			fusion.completeDelegation();
			fusion.clearPending();
			for (const failure of ["claim", "intent", "snapshot"]) {
				expect(fusion.beginDelegation("revise")).toBeUndefined();
				const log: string[] = [];
				await expect(fusion.performDelegation(ports(log, failure))).rejects.toThrow(failure);
				expect(log).not.toContain("submit");
				expect(fusion.state.phase).toBe("failed");
				expect(fusion.state.revisions).toBe(0);
				// A confirmed pre-submission failure clears its intent before retry.
				fusion.clearPending();
				fusion.endDelegation("revise");
			}
			expect(fusion.beginDelegation("final_fix")).toBeUndefined();
			await expect(fusion.performDelegation(ports([], "submit"))).rejects.toThrow("submit");
			expect(fusion.state.phase).toBe("failed");
			expect(fusion.state.finalFixUsed).toBe(true);
			fusion.endDelegation("final_fix");
			expect(fusion.resetError()).toContain("uncertain");
			expect(fusion.beginDelegation("revise")).toContain("unknown outcome");
			expect(() => fusion.clear()).toThrow("uncertain");
			expect(() => fusion.start("new task")).toThrow("unsettled");
			expect(fusion.continuation({ lastAssistantText: "", outcome: "completed", canContinue: true })).toBeUndefined();
			fusion.setUncertain(false); // Reconciliation verified settlement and cleared the pending request.
			fusion.clearPending();
			expect(fusion.beginDelegation("final_fix")).toContain("already used");
		});
	});
}

test("the same acquired delegation cannot be performed twice concurrently", async () => {
	const fusion = controller();
	fusion.beginDelegation("execute");
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => { finish = resolve; });
	const sequence = ports([]);
	sequence.recordIntent = () => gate;
	const first = fusion.performDelegation(sequence);
	await expect(fusion.performDelegation(ports([]))).rejects.toThrow("already in progress");
	finish();
	await first;
	fusion.endDelegation("execute");
});

test("starting a run cannot replace a delegation while it is active", async () => {
	const fusion = controller();
	expect(fusion.beginDelegation("execute", undefined, "brief")).toBeUndefined();
	const pending = fusion.pending;
	fusion.startExecution("original task", "brief");
	expect(fusion.state.delegating).toBe(true);
	expect(fusion.pending).toEqual(pending);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const sequence = ports([]);
	sequence.submit = async () => { await gate; return "output"; };
	const active = fusion.performDelegation(sequence);
	await Promise.resolve();
	const before = { ...fusion.state };
	expect(() => fusion.start("replacement task")).toThrow("unsettled");
	expect(() => fusion.startExecution("replacement task", "replacement brief")).toThrow("initial Fusion delegation");
	expect(fusion.state).toEqual(before);
	expect(fusion.pending).toEqual(pending);
	release();
	await active;
	fusion.clearPending();
	fusion.endDelegation("execute");
	fusion.start("next task");
	expect(fusion.state.originalTask).toBe("next task");
});

test("injected services mint time and request identity; begin records the pending request", () => {
	const fusion = controller({
		now: () => 42,
		newRunId: () => "run-7",
		newRequestId: (action, brief, revision) => `${action}#${revision}#${brief.length}`,
	});
	expect(fusion.now()).toBe(42);
	expect(fusion.newRunId()).toBe("run-7");
	expect(fusion.beginDelegation("execute", undefined, "brief")).toBeUndefined();
	// A pre-begin mint and the recorded pending identity must agree.
	expect(fusion.pending).toEqual({ action: "execute", requestId: fusion.requestIdFor("execute", "brief") });
	expect(fusion.pending?.requestId).toBe("execute#0#5");
	fusion.clearPending();
	fusion.endDelegation("execute");
	fusion.completeDelegation();
	expect(fusion.beginDelegation("revise", undefined, "feedback")).toBeUndefined();
	// Revision numbering happens at begin, so the minted identity counts the attempt in progress.
	expect(fusion.pending?.requestId).toBe("revise#1#8");
	fusion.clearPending();
	fusion.endDelegation("revise");
});

test("resume acquires no pending identity and respects injected services", () => {
	const fusion = controller({ newRequestId: (action) => `minted-${action}` });
	fusion.state.resumePending = true;
	expect(fusion.beginDelegation("resume", { ...OPENCODE_CAPABILITIES, activeTurnReattach: true })).toBeUndefined();
	expect(fusion.pending).toBeUndefined();
	fusion.endDelegation("resume");
});

test("a claim rejection runs before intent and refunds the consumed budget", async () => {
	const fusion = controller();
	fusion.start("task");
	fusion.completeDelegation();
	fusion.endDelegation("execute");
	expect(fusion.beginDelegation("revise", undefined, "feedback")).toBeUndefined();
	const log: string[] = [];
	await expect(fusion.performDelegation(ports(log, "claim"))).rejects.toThrow("claim");
	expect(log).toEqual(["claim"]);
	expect(fusion.submissionBegan).toBe(false);
	expect(fusion.state.revisions).toBe(0);
	fusion.clearPending();
	fusion.endDelegation("revise");
	// The refunded budget is spendable again.
	expect(fusion.beginDelegation("revise", undefined, "feedback")).toBeUndefined();
});
