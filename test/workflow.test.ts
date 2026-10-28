import { describe, expect, test } from "bun:test";
import { delegationError, scoutLimitError, type DelegationState } from "../src/core/workflow.ts";
import { MAX_REVISIONS, MAX_SCOUT_CALLS } from "../src/limits.ts";

const fresh = (): DelegationState => ({
	delegating: false, executed: false, revisions: 0, finalFixUsed: false, resumePending: false,
});

describe("shared Fusion workflow policy", () => {
	test("enforces the execution, revision, and final-fix sequence", () => {
		const state = fresh();
		expect(delegationError(state, "execute")).toBeUndefined();
		expect(delegationError(state, "revise")).toContain("before the initial execution");
		expect(delegationError(state, "final_fix")).toContain("before the initial execution");
		state.executed = true;
		expect(delegationError(state, "execute")).toContain("already completed");
		expect(delegationError(state, "revise")).toBeUndefined();
		expect(delegationError(state, "final_fix")).toBeUndefined();
		state.revisions = MAX_REVISIONS;
		state.finalFixUsed = true;
		expect(delegationError(state, "revise")).toContain("Revision limit");
		expect(delegationError(state, "final_fix")).toContain("Final fix already used");
	});

	test("blocks concurrent work and only permits a requested resume", () => {
		const state = fresh();
		expect(delegationError(state, "resume")).toContain("Nothing to resume");
		state.resumePending = true;
		expect(delegationError(state, "resume")).toBeUndefined();
		state.delegating = true;
		for (const action of ["execute", "revise", "final_fix", "resume"] as const) {
			expect(delegationError(state, action)).toContain("already in progress");
		}
	});

	test("enforces the scout invocation budget", () => {
		expect(scoutLimitError(MAX_SCOUT_CALLS - 1)).toBeUndefined();
		expect(scoutLimitError(MAX_SCOUT_CALLS)).toContain("Scout limit reached");
	});
});
