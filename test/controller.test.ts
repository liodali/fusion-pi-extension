import { expect, test } from "bun:test";
import { FusionController } from "../src/core/controller.ts";

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
