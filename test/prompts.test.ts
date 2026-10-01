import { describe, expect, test } from "bun:test";
import {
	buildExecutorPrompt,
	buildRevisionPrompt,
	buildScoutPrompt,
	buildSupervisorPrompt,
	EXECUTOR_SYSTEM_PROMPT,
	MAX_REVISIONS,
	MAX_SCOUT_CALLS,
	SCOUT_SYSTEM_PROMPT,
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

	test("routes broad searches through fusion_scout and mentions its cap", () => {
		const prompt = buildSupervisorPrompt("task", "executor");
		expect(prompt).toContain("fusion_scout");
		expect(prompt).toContain(`${MAX_SCOUT_CALLS}`);
		expect(prompt).toContain("scout findings");
		expect(prompt).toContain("diff stat");
	});

	test("tiers the review: light pass on clean reports, full review otherwise", () => {
		const prompt = buildSupervisorPrompt("task", "executor");
		expect(prompt).toContain("review only the changed hunks");
		expect(prompt).toContain("partial/blocked/unknown");
		expect(prompt).toContain("rerun the checks");
		expect(prompt).toContain("Never trust the summary");
	});
});

describe("buildScoutPrompt", () => {
	test("embeds a numbered list of the questions and demands citations", () => {
		const prompt = buildScoutPrompt(["where is auth handled?", "what is the db schema?"]);
		expect(prompt).toContain("1. where is auth handled?");
		expect(prompt).toContain("2. what is the db schema?");
		expect(prompt).toContain("path:line");
	});
});

describe("buildExecutorPrompt", () => {
	test("embeds the brief and assigns implementation and verification ownership", () => {
		const prompt = buildExecutorPrompt("implement retry backoff");
		expect(prompt).toContain("implement retry backoff");
		expect(prompt).toContain("implementation");
		expect(prompt).toContain("verification");
	});

	test("defers to the system prompt instead of repeating the rules", () => {
		const prompt = buildExecutorPrompt("task");
		expect(prompt).toContain("system prompt");
		expect(prompt).not.toContain("Never delegate");
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

	test("embeds the original brief before the feedback when provided", () => {
		const prompt = buildRevisionPrompt("fix it", 1, "implement retry backoff");
		expect(prompt).toContain("# Original brief");
		expect(prompt).toContain("implement retry backoff");
		expect(prompt.indexOf("# Original brief")).toBeLessThan(
			prompt.indexOf("# Feedback"),
		);
	});

	test("omits the original brief section when not provided or blank", () => {
		expect(buildRevisionPrompt("fix it", 1)).not.toContain("# Original brief");
		expect(buildRevisionPrompt("fix it", 1, "   ")).not.toContain("# Original brief");
	});

	test("reminds the executor to finish with the json report block", () => {
		expect(buildRevisionPrompt("fix it", 1)).toContain("JSON report block");
		expect(buildRevisionPrompt("fix it", 1, "brief")).toContain("JSON report block");
	});
});

describe("EXECUTOR_SYSTEM_PROMPT", () => {
	test("assigns implementation and verification ownership and forbids delegation", () => {
		expect(EXECUTOR_SYSTEM_PROMPT).toContain("implementation and verification");
		expect(EXECUTOR_SYSTEM_PROMPT).toContain("Never delegate");
	});

	test("keeps the executor fast: batched reads, no re-reads, brief-scoped checks, one-line notes", () => {
		expect(EXECUTOR_SYSTEM_PROMPT).toContain("Batch independent reads");
		expect(EXECUTOR_SYSTEM_PROMPT).toContain("Do not re-read files");
		expect(EXECUTOR_SYSTEM_PROMPT).toContain("only the checks named in the brief");
		expect(EXECUTOR_SYSTEM_PROMPT).toContain("single line");
	});

	test("requires a single trailing json report block", () => {
		expect(EXECUTOR_SYSTEM_PROMPT).toContain("```json");
		expect(EXECUTOR_SYSTEM_PROMPT).toContain('"status":"done"|"partial"|"blocked"');
		expect(EXECUTOR_SYSTEM_PROMPT).toContain("no prose after it");
		expect(EXECUTOR_SYSTEM_PROMPT).toContain("at most one short sentence");
	});

	test("makes the json block the report instead of a prose summary", () => {
		expect(EXECUTOR_SYSTEM_PROMPT).not.toContain("Report the files you changed");
	});
});

describe("SCOUT_SYSTEM_PROMPT", () => {
	test("keeps the scout read-only and citation-driven", () => {
		expect(SCOUT_SYSTEM_PROMPT).toContain("read-only");
		expect(SCOUT_SYSTEM_PROMPT).toContain("path:line");
		expect(SCOUT_SYSTEM_PROMPT).toContain("never edit files");
		expect(SCOUT_SYSTEM_PROMPT).toContain("numbered list");
	});
});
