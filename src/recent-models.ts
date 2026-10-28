import type { FusionModel } from "./core/model.ts";

export const RECENT_MODEL_COHORT = "2025–2026";

export const MODEL_PICKER_INITIAL_COUNT = 5;

export const RECENT_MODEL_PATTERNS: readonly RegExp[] = [
	/claude-(?:fable|opus|sonnet|haiku)-(?:4-[5-9]|[5-9])/,
	/gpt-(?:5-[2-9]|[6-9])/,
	/gemini-[3-9]/,
	/(?:^|-)k(?:2-[5-9]|[3-9])/,
	/(?:^|-)v(?:3-[2-9]|[4-9])/,
	/grok-(?:4-[1-9]|[5-9])/,
	/glm-(?:4-[7-9]|[5-9])/,
	/(?:^|-)m(?:2-[1-9]|[3-9])/,
	/swe-2/,
	/mai-code-1/,
];

function normalizedModelText(model: FusionModel): string {
	return `${model.provider} ${model.id} ${model.name}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-");
}

export function isRecentModel(model: FusionModel): boolean {
	const text = normalizedModelText(model);
	return RECENT_MODEL_PATTERNS.some((pattern) => pattern.test(text));
}

function queryTokens(query: string): string[] {
	return query
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter((token) => token.length > 0);
}

function matchesQueryTokens(model: FusionModel, tokens: string[]): boolean {
	const combined = `${model.provider} ${model.id} ${model.name}`.toLowerCase();
	return tokens.every((token) => combined.includes(token));
}

export function searchRecentModels<T extends FusionModel>(models: T[], query: string): T[] {
	const recent = models.filter(isRecentModel);
	const tokens = queryTokens(query);
	if (tokens.length === 0) return recent;
	return recent.filter((model) => matchesQueryTokens(model, tokens));
}

export function filterModelsByQuery<T extends FusionModel>(
	models: T[],
	query: string,
	emptyLimit = MODEL_PICKER_INITIAL_COUNT,
): T[] {
	const tokens = queryTokens(query);
	if (tokens.length === 0) return models.slice(0, emptyLimit);
	return models.filter((model) => matchesQueryTokens(model, tokens));
}
