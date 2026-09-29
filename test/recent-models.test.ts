import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isRecentModel, RECENT_MODEL_COHORT, searchRecentModels } from "../src/recent-models.ts";

const model = (id: string, provider = "test-provider", name = "Test Model"): Model<Api> =>
	({ id, provider, name }) as Model<Api>;

describe("RECENT_MODEL_COHORT", () => {
	test("is the curated cohort label", () => {
		expect(RECENT_MODEL_COHORT).toBe("2025–2026");
	});
});

describe("isRecentModel", () => {
	test("accepts curated recent families", () => {
		const accepted = [
			"claude-sonnet-4.5",
			"claude-fable-5.1",
			"gpt-5.2",
			"gpt-5.6-luna",
			"gpt-6-astra",
			"gemini-3-pro",
			"kimi-k2.5",
			"deepseek-v3.2",
			"grok-4.1",
			"glm-4.7",
			"minimax-m2.1",
			"swe-2",
			"mai-code-1.1-flash",
		];
		for (const id of accepted) {
			expect(isRecentModel(model(id))).toBe(true);
		}
	});

	test("rejects older and undated models", () => {
		const rejected = ["claude-sonnet-4", "gpt-5", "gpt-5.1", "gemini-2.5-pro", "kimi-k2", "local-model"];
		for (const id of rejected) {
			expect(isRecentModel(model(id))).toBe(false);
		}
	});

	test("matches provider-prefixed and suffixed identifiers", () => {
		expect(isRecentModel(model("anthropic/claude-sonnet-4.5-20251101", "openrouter"))).toBe(true);
		expect(isRecentModel(model("us.anthropic.claude-sonnet-4-5", "amazon-bedrock"))).toBe(true);
		expect(isRecentModel(model("openai/gpt-5.2-codex", "github-copilot"))).toBe(true);
	});
});

describe("searchRecentModels", () => {
	const models = () => [
		model("claude-sonnet-4.5", "anthropic", "Claude Sonnet 4.5"),
		model("gpt-5.2", "openai", "GPT 5.2"),
		model("gemini-3-pro", "google", "Gemini 3 Pro"),
		model("claude-sonnet-4", "anthropic", "Claude Sonnet 4"),
	];

	test("blank query returns all recent models in input order", () => {
		const result = searchRecentModels(models(), "   ");
		expect(result.map((m) => m.id)).toEqual(["claude-sonnet-4.5", "gpt-5.2", "gemini-3-pro"]);
	});

	test("matches provider, id, and display name case-insensitively", () => {
		expect(searchRecentModels(models(), "ANTHROPIC").map((m) => m.id)).toEqual(["claude-sonnet-4.5"]);
		expect(searchRecentModels(models(), "gpt-5.2").map((m) => m.id)).toEqual(["gpt-5.2"]);
		expect(searchRecentModels(models(), "GEMINI").map((m) => m.id)).toEqual(["gemini-3-pro"]);
	});

	test("requires every query token", () => {
		expect(searchRecentModels(models(), "anthropic sonnet").map((m) => m.id)).toEqual([
			"claude-sonnet-4.5",
		]);
		expect(searchRecentModels(models(), "anthropic openai")).toEqual([]);
	});

	test("old models stay excluded even when the query matches them", () => {
		const result = searchRecentModels(models(), "claude sonnet");
		expect(result.map((m) => m.id)).toEqual(["claude-sonnet-4.5"]);
	});
});
