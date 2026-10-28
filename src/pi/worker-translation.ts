import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { WorkerModelConfig, WorkerOwner, WorkerReference, WorkerUsage } from "../core/worker.ts";

/** Translate at the Pi boundary; legacy manifests still store their original references. */
export function piWorkerReference(owner: WorkerOwner, runtime: "session" | "durable", id: string): WorkerReference {
	if (owner.harness !== "pi" || !owner.supervisorId || !owner.workspace || !id) throw new Error("Invalid Pi worker reference.");
	return { owner: { ...owner }, runtime, id };
}

export function piModelConfig(model: Model<Api>, thinking: ThinkingLevel): WorkerModelConfig {
	return { provider: model.provider, modelId: model.id, variant: thinking };
}

/** Absent usage stays absent; callers must not pass a synthetic zero aggregate as evidence. */
export function piWorkerUsage(usage: Usage | undefined): WorkerUsage | undefined {
	if (!usage) return undefined;
	return { inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite, reasoningTokens: usage.reasoning, cost: usage.cost.total };
}
