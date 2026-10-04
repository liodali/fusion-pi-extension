import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	filterModelsByQuery,
	isRecentModel,
	MODEL_PICKER_INITIAL_COUNT,
	RECENT_MODEL_COHORT,
	searchRecentModels,
} from "../src/recent-models.ts";

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

describe("filterModelsByQuery", () => {
	const models = () => [
		model("claude-sonnet-4.5", "anthropic", "Claude Sonnet 4.5"),
		model("gpt-5.2", "openai", "GPT 5.2"),
		model("gemini-3-pro", "google", "Gemini 3 Pro"),
		model("claude-opus-4.5", "anthropic", "Claude Opus 4.5"),
		model("grok-4.1", "xai", "Grok 4.1"),
		model("glm-4.7", "zai", "GLM 4.7"),
		model("deepseek-v3.2", "deepseek", "DeepSeek V3.2"),
	];

	test("blank query returns the first MODEL_PICKER_INITIAL_COUNT models in input order", () => {
		expect(MODEL_PICKER_INITIAL_COUNT).toBe(5);
		const result = filterModelsByQuery(models(), "   ");
		expect(result.map((m) => m.id)).toEqual([
			"claude-sonnet-4.5",
			"gpt-5.2",
			"gemini-3-pro",
			"claude-opus-4.5",
			"grok-4.1",
		]);
	});

	test("custom emptyLimit is respected", () => {
		expect(filterModelsByQuery(models(), "", 3).map((m) => m.id)).toEqual([
			"claude-sonnet-4.5",
			"gpt-5.2",
			"gemini-3-pro",
		]);
	});

	test("non-blank query searches all models, including past the first page", () => {
		const result = filterModelsByQuery(models(), "deepseek");
		expect(result.map((m) => m.id)).toEqual(["deepseek-v3.2"]);
	});

	test("matches provider, id, and display name case-insensitively", () => {
		expect(filterModelsByQuery(models(), "ANTHROPIC").map((m) => m.id)).toEqual([
			"claude-sonnet-4.5",
			"claude-opus-4.5",
		]);
		expect(filterModelsByQuery(models(), "gpt-5.2").map((m) => m.id)).toEqual(["gpt-5.2"]);
		expect(filterModelsByQuery(models(), "GEMINI").map((m) => m.id)).toEqual(["gemini-3-pro"]);
	});

	test("requires every query token", () => {
		expect(filterModelsByQuery(models(), "anthropic opus").map((m) => m.id)).toEqual([
			"claude-opus-4.5",
		]);
		expect(filterModelsByQuery(models(), "anthropic openai")).toEqual([]);
	});

	test("does not apply the recent-model cohort filter", () => {
		const all = [model("claude-sonnet-4", "anthropic", "Claude Sonnet 4"), ...models()];
		const result = filterModelsByQuery(all, "claude sonnet");
		expect(result.map((m) => m.id)).toEqual(["claude-sonnet-4", "claude-sonnet-4.5"]);
	});

	test("returns an empty list when nothing matches", () => {
		expect(filterModelsByQuery(models(), "no-such-model")).toEqual([]);
	});
});
