import type { FusionModel } from "./core/model.ts";

export const FUSION_OUTPUT_PRICE_THRESHOLD = 10;

export type FusionModelTier = "supervisor" | "executor";

export function getOutputPrice(model: FusionModel): number | undefined {
	const price = model.cost?.output;
	if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return undefined;
	return price;
}

export function isModelInTier(model: FusionModel, tier: FusionModelTier): boolean {
	const price = getOutputPrice(model);
	if (tier === "supervisor") {
		return price !== undefined && price >= FUSION_OUTPUT_PRICE_THRESHOLD;
	}
	return price === undefined || price <= FUSION_OUTPUT_PRICE_THRESHOLD;
}

export function formatPricedModelLabel(model: FusionModel): string {
	const price = getOutputPrice(model);
	return price === undefined
		? `${model.provider}/${model.id} — price unknown`
		: `${model.provider}/${model.id} — $${price.toFixed(2)}/M output`;
}
