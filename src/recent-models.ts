import type { Api, Model } from "@earendil-works/pi-ai";

export const RECENT_MODEL_COHORT = "2025–2026";

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

function normalizedModelText(model: Model<Api>): string {
	return `${model.provider} ${model.id} ${model.name}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-");
}

export function isRecentModel(model: Model<Api>): boolean {
	const text = normalizedModelText(model);
	return RECENT_MODEL_PATTERNS.some((pattern) => pattern.test(text));
}

export function searchRecentModels(models: Model<Api>[], query: string): Model<Api>[] {
	const recent = models.filter(isRecentModel);
	const tokens = query
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return recent;
	return recent.filter((model) => {
		const combined = `${model.provider} ${model.id} ${model.name}`.toLowerCase();
		return tokens.every((token) => combined.includes(token));
	});
}
