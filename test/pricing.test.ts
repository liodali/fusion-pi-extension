import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	FUSION_OUTPUT_PRICE_THRESHOLD,
	formatPricedModelLabel,
	getOutputPrice,
	isModelInTier,
} from "../src/pricing.ts";

const model = (output: number | undefined): Model<Api> =>
	({
		id: "test-model",
		name: "Test Model",
		provider: "test-provider",
		cost: output === undefined ? {} : { output },
	}) as Model<Api>;

describe("FUSION_OUTPUT_PRICE_THRESHOLD", () => {
	test("is 10", () => {
		expect(FUSION_OUTPUT_PRICE_THRESHOLD).toBe(10);
	});
});

describe("isModelInTier", () => {
	test("supervisor accepts at least 10", () => {
		expect(isModelInTier(model(10), "supervisor")).toBe(true);
		expect(isModelInTier(model(10.01), "supervisor")).toBe(true);
		expect(isModelInTier(model(15), "supervisor")).toBe(true);
	});

	test("supervisor rejects below 10 and unknown pricing", () => {
		expect(isModelInTier(model(9.99), "supervisor")).toBe(false);
		expect(isModelInTier(model(5), "supervisor")).toBe(false);
		expect(isModelInTier(model(undefined), "supervisor")).toBe(false);
	});

	test("executor accepts at most 10, zero, and unknown pricing", () => {
		expect(isModelInTier(model(10), "executor")).toBe(true);
		expect(isModelInTier(model(0), "executor")).toBe(true);
		expect(isModelInTier(model(undefined), "executor")).toBe(true);
	});

	test("executor rejects above 10", () => {
		expect(isModelInTier(model(10.01), "executor")).toBe(false);
	});
});

describe("getOutputPrice", () => {
	test("returns undefined for NaN, Infinity, negative, and missing prices", () => {
		expect(getOutputPrice(model(NaN))).toBeUndefined();
		expect(getOutputPrice(model(Infinity))).toBeUndefined();
		expect(getOutputPrice(model(-1))).toBeUndefined();
		expect(getOutputPrice(model(undefined))).toBeUndefined();
	});

	test("non-finite, negative, and missing prices qualify only as executor", () => {
		for (const output of [NaN, Infinity, -5, undefined]) {
			expect(isModelInTier(model(output), "supervisor")).toBe(false);
			expect(isModelInTier(model(output), "executor")).toBe(true);
		}
	});
});

describe("formatPricedModelLabel", () => {
	test("formats a known price", () => {
		expect(formatPricedModelLabel(model(15))).toBe("test-provider/test-model — $15.00/M output");
	});

	test("formats unknown pricing", () => {
		expect(formatPricedModelLabel(model(undefined))).toBe("test-provider/test-model — price unknown");
	});
});
