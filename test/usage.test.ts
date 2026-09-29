import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { aggregateUsage } from "../src/usage.ts";

const usageWith = (fields: object): Usage => fields as Usage;

const assistantWith = (usage: object | undefined): AgentMessage =>
	({ role: "assistant", content: [], usage }) as AgentMessage;

const toolResultWith = (usage: object | undefined): AgentMessage =>
	({ role: "toolResult", content: [], usage }) as AgentMessage;

describe("aggregateUsage", () => {
	test("returns zeroed usage for empty input", () => {
		const usage = aggregateUsage([]);
		expect(usage.input).toBe(0);
		expect(usage.output).toBe(0);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(0);
		expect(usage.cost.total).toBe(0);
	});

	test("sums token fields across assistant and tool-result messages", () => {
		const usage = aggregateUsage([
			assistantWith(usageWith({
				input: 100,
				output: 40,
				cacheRead: 10,
				cacheWrite: 5,
				cost: { input: 1, output: 0.5, cacheRead: 0.1, cacheWrite: 0.05 },
			})),
			toolResultWith(usageWith({
				input: 3,
				output: 2,
				cacheRead: 1,
				cacheWrite: 0,
				cost: { input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
		]);
		expect(usage.input).toBe(103);
		expect(usage.output).toBe(42);
		expect(usage.cacheRead).toBe(11);
		expect(usage.cacheWrite).toBe(5);
	});

	test("recomputes totalTokens and cost.total from components", () => {
		const usage = aggregateUsage([
			assistantWith(usageWith({
				input: 100,
				output: 40,
				cacheRead: 10,
				cacheWrite: 5,
				totalTokens: 999,
				cost: { input: 1, output: 0.5, cacheRead: 0.1, cacheWrite: 0.05, total: 999 },
			})),
		]);
		expect(usage.totalTokens).toBe(155);
		expect(usage.cost.total).toBeCloseTo(1.65);
	});

	test("preserves cacheWrite1h and reasoning when reported", () => {
		const usage = aggregateUsage([
			assistantWith(usageWith({
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 2,
				cacheWrite1h: 2,
				reasoning: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
			assistantWith(usageWith({
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 1,
				cacheWrite1h: 1,
				reasoning: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
		]);
		expect(usage.cacheWrite1h).toBe(3);
		expect(usage.reasoning).toBe(5);
	});

	test("leaves optional fields unset when no message reports them", () => {
		const usage = aggregateUsage([
			assistantWith(usageWith({
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
		]);
		expect(usage.cacheWrite1h).toBeUndefined();
		expect(usage.reasoning).toBeUndefined();
	});

	test("ignores messages without usage", () => {
		const usage = aggregateUsage([
			{ role: "user", content: "hello" } as AgentMessage,
			assistantWith(undefined),
			toolResultWith(undefined),
		]);
		expect(usage.input).toBe(0);
		expect(usage.totalTokens).toBe(0);
		expect(usage.cost.total).toBe(0);
	});
});
