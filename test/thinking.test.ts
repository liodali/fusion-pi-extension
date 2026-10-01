import { describe, expect, test } from "bun:test";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	defaultThinkingLevel,
	orderThinkingLevels,
	scoutDefaultThinkingLevel,
	toAgentThinkingLevel,
} from "../src/thinking.ts";

describe("orderThinkingLevels", () => {
	test("orders levels highest first", () => {
		expect(
			orderThinkingLevels(["off", "low", "max", "medium", "high", "minimal", "xhigh"]),
		).toEqual(["max", "xhigh", "high", "medium", "low", "minimal", "off"]);
	});

	test("keeps the input order for equal ranks and does not mutate the input", () => {
		const input = ["off", "high", "low"] as const;
		expect(orderThinkingLevels(input)).toEqual(["high", "low", "off"]);
		expect(input).toEqual(["off", "high", "low"]);
	});

	test("sorts unknown levels below known ones", () => {
		expect(orderThinkingLevels(["high", "bogus" as never, "off"])).toEqual([
			"high",
			"off",
			"bogus" as never,
		]);
	});
});

describe("defaultThinkingLevel", () => {
	test("returns the highest supported level", () => {
		expect(defaultThinkingLevel(["off", "low", "high"])).toBe("high");
		expect(defaultThinkingLevel(["off", "xhigh", "medium"])).toBe("xhigh");
		expect(defaultThinkingLevel(["max", "high"])).toBe("max");
	});

	test("returns off for an empty list", () => {
		expect(defaultThinkingLevel([])).toBe("off");
	});

	test("returns off when only off is supported", () => {
		expect(defaultThinkingLevel(["off"])).toBe("off");
	});
});

describe("scoutDefaultThinkingLevel", () => {
	test("prefers low when supported", () => {
		expect(scoutDefaultThinkingLevel(["off", "low", "high", "max"])).toBe("low");
	});

	test("falls back to the lowest supported level that is not off", () => {
		expect(scoutDefaultThinkingLevel(["off", "medium", "high"])).toBe("medium");
		expect(scoutDefaultThinkingLevel(["minimal", "off"])).toBe("minimal");
	});

	test("returns off when only off is supported", () => {
		expect(scoutDefaultThinkingLevel(["off"])).toBe("off");
	});

	test("returns off for an empty list", () => {
		expect(scoutDefaultThinkingLevel([])).toBe("off");
	});

	test("skips unknown levels when picking the lowest", () => {
		expect(scoutDefaultThinkingLevel(["high", "bogus" as never, "off"])).toBe("high");
	});
});

describe("toAgentThinkingLevel", () => {
	test("maps model thinking levels to agent thinking levels", () => {
		const levels: ModelThinkingLevel[] = [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		];
		for (const level of levels) {
			const converted: ThinkingLevel = toAgentThinkingLevel(level);
			expect(converted).toBe(level);
		}
	});
});
