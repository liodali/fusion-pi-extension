// Isolated process: mocks only the Durable harness and storage, not Fusion recovery.
import { expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sdk = (name, factory) => mock.module(Bun.resolveSync(name, repo), factory);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage });
let records = new Map(), entries = [], requested = [], submissions = 0;
const conversation = { id: 42, entries: async () => ({ items: entries }),
	commit: async (callback) => callback({ submissionByRequest: async (id, requestId) => { requested.push([id, requestId]); return records.get(requestId); } }),
	submit: async () => { submissions++; throw new Error("must not submit"); }, abort: async () => {} };
const harness = { inspect: async () => ({ submissions: [], tasks: [] }), conversation: async () => conversation,
	submission: async (id) => { const record = [...records.values()].find((item) => item.id === id); return record && { wait: async () => record }; }, close: async () => {} };
sdk("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => process.env.FUSION_PI_TEST_DIR, ModelRuntime: { create: async () => ({}) }, createAgentSession: async () => {}, DefaultResourceLoader: class {}, SessionManager: {} }));
sdk("@earendil-works/pi-durable", () => ({ AssistantEntry: { is: (entry) => entry.kind === "assistant" }, UserEntry: { is: (entry) => entry.kind === "user" },
	Harness: { open: async () => harness }, createRegistry: () => ({ install: () => {} }), watchEvents: async () => ({ start: () => {}, stop: async () => {} }) }));
sdk("@earendil-works/pi-durable/env/node", () => ({ NodeExecutionEnv: class {} }));
sdk("@earendil-works/pi-durable/storage/sqlite/node", () => ({ openNodeSqliteStorage: async () => ({}) }));
sdk("@earendil-works/pi-durable/tools", () => ({ CodingTools: {} }));
mock.module(repo + "/src/pi/durable/context.ts", () => ({ createFusionContext: () => ({ extension: {}, instructions: async () => "" }) }));
mock.module(repo + "/src/pi/durable/scout-tools.ts", () => ({ scoutCallsDoc: {}, scoutTools: {} }));
const { createDurableExecutorBackend } = await import("../../src/pi/durable/backend.ts");

test("Durable resume requires a matched request and its exact transcript evidence", async () => {
	const backend = await createDurableExecutorBackend();
	const handle = await backend.openExecutor({ cwd: process.env.FUSION_PI_TEST_DIR, model: { provider: "fake", id: "model" }, thinking: "off" }, "42");
	entries = [{ id: 2, kind: "assistant", model: [assistant("OLD REPORT")] }, { id: 1, kind: "user" }];
	await expect(handle.resume({ onEvent: () => {} })).rejects.toThrow("original executor request ID");
	await expect(handle.resume({ requestId: "missing", onEvent: () => {} })).rejects.toThrow("No matching executor submission");
	records = new Map([["wrong", { id: 7, conversationId: 42, requestId: "another", type: "input", status: "done", entry: 1, answer: 2 }]]);
	await expect(handle.resume({ requestId: "wrong", onEvent: () => {} })).rejects.toThrow("No matching executor submission");
	records = new Map([["right", { id: 8, conversationId: 42, requestId: "right", type: "input", status: "done", entry: 3, answer: 4 }]]);
	entries = [{ id: 4, kind: "assistant", model: [assistant("MATCHED REPORT")] }, { id: 3, kind: "user" }, ...entries];
	expect((await handle.resume({ requestId: "right", onEvent: () => {} })).text).toBe("MATCHED REPORT");
	entries.unshift({ id: 5, kind: "user" });
	await expect(handle.resume({ requestId: "right", onEvent: () => {} })).rejects.toThrow("newer user turn");
	entries = [{ id: 6, kind: "assistant", model: [assistant("WRONG REPORT")] }, { id: 3, kind: "user" }];
	await expect(handle.resume({ requestId: "right", onEvent: () => {} })).rejects.toThrow("newer assistant message");
	expect(requested).toContainEqual([42, "right"]);
	expect(submissions).toBe(0);
	await backend.dispose();
});
