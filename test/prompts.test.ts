import { describe, expect, test } from "bun:test";
import {
	buildExecutorPrompt,
	buildRevisionPrompt,
	buildSupervisorPrompt,
	EXECUTOR_SYSTEM_PROMPT,
	MAX_REVISIONS,
} from "../src/prompts.ts";

describe("buildSupervisorPrompt", () => {
	test("embeds task, executor label, tool contract, and review duties", () => {
		const prompt = buildSupervisorPrompt("add a /health endpoint", "anthropic/claude-sonnet-4-5");
		expect(prompt).toContain("add a /health endpoint");
		expect(prompt).toContain("anthropic/claude-sonnet-4-5");
		expect(prompt).toContain("fusion_delegate");
		expect(prompt).toContain("working tree");
		expect(prompt).toContain("diff");
		expect(prompt).toContain(`${MAX_REVISIONS}`);
		expect(prompt).toContain("3");
	});

	test("forbids implementing before delegation just for speed", () => {
		const prompt = buildSupervisorPrompt("task", "executor");
		expect(prompt).toContain("Do not implement the task yourself before delegating");
	});
});

describe("buildExecutorPrompt", () => {
	test("embeds the brief and assigns implementation and verification ownership", () => {
		const prompt = buildExecutorPrompt("implement retry backoff");
		expect(prompt).toContain("implement retry backoff");
		expect(prompt).toContain("implementation");
		expect(prompt).toContain("verification");
	});
});

describe("buildRevisionPrompt", () => {
	test("embeds consolidated feedback, the revision number, and a working tree check", () => {
		const prompt = buildRevisionPrompt("fix the null check in parse()", 2);
		expect(prompt).toContain("feedback");
		expect(prompt).toContain("fix the null check in parse()");
		expect(prompt).toContain("2");
		expect(prompt).toContain(`${MAX_REVISIONS}`);
		expect(prompt).toContain("current working tree");
	});
});

describe("EXECUTOR_SYSTEM_PROMPT", () => {
	test("assigns implementation and verification ownership and forbids delegation", () => {
		expect(EXECUTOR_SYSTEM_PROMPT).toContain("implementation and verification");
		expect(EXECUTOR_SYSTEM_PROMPT).toContain("Never delegate");
	});
});
