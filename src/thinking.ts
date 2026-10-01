import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = [
	"max",
	"xhigh",
	"high",
	"medium",
	"low",
	"minimal",
	"off",
];

function thinkingLevelRank(level: ModelThinkingLevel): number {
	const index = THINKING_LEVEL_ORDER.indexOf(level);
	return index === -1 ? THINKING_LEVEL_ORDER.length : index;
}

export function toAgentThinkingLevel(level: ModelThinkingLevel): ThinkingLevel {
	return level;
}

export function orderThinkingLevels(
	levels: readonly ModelThinkingLevel[],
): ThinkingLevel[] {
	return [...levels].sort((a, b) => thinkingLevelRank(a) - thinkingLevelRank(b));
}

export function defaultThinkingLevel(
	levels: readonly ModelThinkingLevel[],
): ThinkingLevel {
	return orderThinkingLevels(levels)[0] ?? "off";
}

export function scoutDefaultThinkingLevel(
	levels: readonly ModelThinkingLevel[],
): ThinkingLevel {
	const ordered = orderThinkingLevels(levels);
	if (ordered.includes("low")) return "low";
	for (let i = ordered.length - 1; i >= 0; i--) {
		const level = ordered[i];
		if (level !== "off" && thinkingLevelRank(level) < THINKING_LEVEL_ORDER.length) {
			return level;
		}
	}
	return "off";
}
