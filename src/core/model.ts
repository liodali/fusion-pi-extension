/** Catalog fields used by Fusion's selection policy, independent of a harness SDK. */
export interface FusionModel {
	id: string;
	provider: string;
	name: string;
	cost?: { output?: number };
}
