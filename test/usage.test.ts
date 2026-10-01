import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
	addUsage,
	aggregateAssistantUsage,
	aggregateUsage,
	createEmptyUsage,
	formatUsageSummary,
} from "../src/usage.ts";

const usageWith = (fields: object): Usage => fields as Usage;

const assistantWith = (usage: object | undefined): AgentMessage =>
	({ role: "assistant", content: [], usage }) as unknown as AgentMessage;

const toolResultWith = (usage: object | undefined): AgentMessage =>
	({ role: "toolResult", content: [], usage }) as unknown as AgentMessage;

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

describe("createEmptyUsage", () => {
	test("returns the zeroed usage shape", () => {
		const usage = createEmptyUsage();
		expect(usage.input).toBe(0);
		expect(usage.output).toBe(0);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(0);
		expect(usage.cost.input).toBe(0);
		expect(usage.cost.output).toBe(0);
		expect(usage.cost.cacheRead).toBe(0);
		expect(usage.cost.cacheWrite).toBe(0);
		expect(usage.cost.total).toBe(0);
		expect(usage.cacheWrite1h).toBeUndefined();
		expect(usage.reasoning).toBeUndefined();
	});
});

describe("aggregateAssistantUsage", () => {
	test("aggregates assistant usage and excludes tool-result usage", () => {
		const usage = aggregateAssistantUsage([
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
		expect(usage.input).toBe(100);
		expect(usage.output).toBe(40);
		expect(usage.totalTokens).toBe(155);
	});
});

describe("addUsage", () => {
	test("sums components and recomputes totalTokens and cost.total", () => {
		const usage = addUsage(
			usageWith({
				input: 100,
				output: 40,
				cacheRead: 10,
				cacheWrite: 5,
				cost: { input: 1, output: 0.5, cacheRead: 0.1, cacheWrite: 0.05 },
			}),
			usageWith({
				input: 50,
				output: 20,
				cacheRead: 2,
				cacheWrite: 1,
				cost: { input: 0.4, output: 0.2, cacheRead: 0.02, cacheWrite: 0.01 },
			}),
		);
		expect(usage.input).toBe(150);
		expect(usage.output).toBe(60);
		expect(usage.cacheRead).toBe(12);
		expect(usage.cacheWrite).toBe(6);
		expect(usage.totalTokens).toBe(228);
		expect(usage.cost.total).toBeCloseTo(2.28);
		expect(usage.cacheWrite1h).toBeUndefined();
		expect(usage.reasoning).toBeUndefined();
	});

	test("sums optional fields when either operand reports them", () => {
		const usage = addUsage(
			usageWith({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
			usageWith({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 2,
				cacheWrite1h: 2,
				reasoning: 4,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		expect(usage.cacheWrite1h).toBe(2);
		expect(usage.reasoning).toBe(7);
	});
});

describe("formatUsageSummary", () => {
	test("formats tokens, cache, total, and cost compactly", () => {
		const summary = formatUsageSummary(
			usageWith({
				input: 1234,
				output: 567,
				cacheRead: 80,
				cacheWrite: 9,
				totalTokens: 1890,
				cost: { input: 0.1, output: 0.02, cacheRead: 0.003, cacheWrite: 0.0004, total: 0.1234 },
			}),
		);
		expect(summary).toBe("in 1,234 | out 567 | cache 89 | total 1,890 | $0.1234");
	});

	test("inserts reasoning after output when reported", () => {
		const summary = formatUsageSummary(
			usageWith({
				input: 10,
				output: 20,
				cacheRead: 1,
				cacheWrite: 0,
				reasoning: 12,
				totalTokens: 31,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
			}),
		);
		expect(summary).toBe("in 10 | out 20 | reasoning 12 | cache 1 | total 31 | $0.5000");
	});
});
