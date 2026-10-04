import { describe, expect, test } from "bun:test";
import { MAX_SETTLE_NUDGES } from "../src/limits.ts";
import { FUSION_SUMMARY_HEADING } from "../src/prompts.ts";
import { needsContinuation } from "../src/settle.ts";

const BASE = {
	executed: true,
	lastAssistantText: "",
	nudges: 0,
	outcome: "completed" as const,
	canContinue: true,
};

describe("needsContinuation", () => {
	test("does not continue when the outcome is not completed", () => {
		expect(needsContinuation({ ...BASE, outcome: "aborted" })).toBeUndefined();
		expect(needsContinuation({ ...BASE, outcome: "error" })).toBeUndefined();
	});

	test("does not continue when continuation is impossible", () => {
		expect(needsContinuation({ ...BASE, canContinue: false })).toBeUndefined();
	});

	test("does not continue past the nudge cap", () => {
		expect(needsContinuation({ ...BASE, nudges: MAX_SETTLE_NUDGES })).toBeUndefined();
		expect(
			needsContinuation({ ...BASE, nudges: MAX_SETTLE_NUDGES + 1 }),
		).toBeUndefined();
	});

	test("does not continue once the fusion summary heading was written", () => {
		expect(
			needsContinuation({
				...BASE,
				lastAssistantText: `All done.\n\n${FUSION_SUMMARY_HEADING}\nEverything passed.`,
			}),
		).toBeUndefined();
	});

	test("nudges delegation when the supervisor never delegated", () => {
		const nudge = needsContinuation({ ...BASE, executed: false });
		expect(nudge).toContain("fusion_delegate");
		expect(nudge).toContain('"execute"');
		expect(nudge).toContain("Do not stop to ask the user");
	});

	test("nudges protocol completion when the run executed but no summary was written", () => {
		const nudge = needsContinuation(BASE);
		expect(nudge).toContain("final acceptance audit");
		expect(nudge).toContain("final_fix");
		expect(nudge).toContain(FUSION_SUMMARY_HEADING);
	});

	test("the summary heading only counts after execution", () => {
		const nudge = needsContinuation({
			...BASE,
			executed: false,
			lastAssistantText: FUSION_SUMMARY_HEADING,
		});
		expect(nudge).toBeDefined();
	});
});
