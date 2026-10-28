import { expect, test } from "bun:test";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { piModelConfig, piWorkerReference, piWorkerUsage } from "../src/pi/worker-translation.ts";

test("Pi worker references retain their runtime and supervisor ownership", () => {
	const owner = { harness: "pi", supervisorId: "supervisor", workspace: "/workspace" };
	expect(piWorkerReference(owner, "session", "/session.jsonl")).toEqual({ owner, runtime: "session", id: "/session.jsonl" });
	expect(piWorkerReference(owner, "durable", "42").runtime).toBe("durable");
	expect(() => piWorkerReference({ ...owner, harness: "opencode" }, "session", "child")).toThrow("Invalid Pi worker reference");
});

test("Pi model and usage translation preserve the host's fields and unknown usage", () => {
	expect(piModelConfig({ provider: "provider", id: "model" } as Model<Api>, "high")).toEqual({ provider: "provider", modelId: "model", variant: "high" });
	expect(piWorkerUsage(undefined)).toBeUndefined();
	expect(piWorkerUsage({ input: 4, output: 3, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 } } as Usage)).toEqual({ inputTokens: 4, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: undefined, cost: 0.5 });
});
