import { describe, expect, test } from "bun:test";
import { FusionController, type DelegationPorts } from "../src/core/controller.ts";
import type { LifecycleState } from "../src/core/workflow.ts";

function controller(): FusionController {
	const state: LifecycleState = { runActive: false, phase: "idle", delegating: false, executed: false, revisions: 0,
		finalFixUsed: false, resumePending: false, scoutCalls: 0, settleNudges: 0 };
	return new FusionController(state);
}

function ports(log: string[], fail?: string): DelegationPorts<string, string, string, string> {
	const stage = (name: string, value: string) => async () => {
		log.push(name);
		if (fail === name) throw new Error(name);
		return value;
	};
	return { recordIntent: async () => { await stage("intent", "")(); }, snapshot: stage("snapshot", "baseline"),
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
			expect(log).toEqual(["intent", "snapshot", "submit", "collect", "settle"]);
			fusion.settleDelegation("completed");
			fusion.endDelegation("execute");
			expect(fusion.beginDelegation("final_fix")).toBeUndefined();
			expect(fusion.delegationPrompt("final_fix", "gaps")).toContain("original task");
			fusion.endDelegation("final_fix");
			expect(fusion.resetError()).toBeUndefined();
			fusion.settleDelegation("error");
			expect(fusion.state.phase).toBe("failed");
		});

		test("refunds confirmed pre-submission failures but retains uncertain budgets", async () => {
			const fusion = controller();
			fusion.start("task");
			fusion.completeDelegation();
			for (const failure of ["intent", "snapshot"]) {
				expect(fusion.beginDelegation("revise")).toBeUndefined();
				const log: string[] = [];
				await expect(fusion.performDelegation(ports(log, failure))).rejects.toThrow(failure);
				expect(log).not.toContain("submit");
				expect(fusion.state.revisions).toBe(0);
				fusion.endDelegation("revise");
			}
			expect(fusion.beginDelegation("final_fix")).toBeUndefined();
			await expect(fusion.performDelegation(ports([], "submit"))).rejects.toThrow("submit");
			expect(fusion.state.finalFixUsed).toBe(true);
			fusion.endDelegation("final_fix");
			expect(fusion.resetError()).toContain("uncertain");
			expect(fusion.beginDelegation("revise")).toContain("unknown outcome");
			expect(() => fusion.clear()).toThrow("uncertain");
			expect(() => fusion.start("new task")).toThrow("unsettled");
			expect(fusion.continuation({ lastAssistantText: "", outcome: "completed", canContinue: true })).toBeUndefined();
			fusion.setUncertain(false); // The adapter has verified settlement.
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
