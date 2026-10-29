// Runs in a separate Bun process so SDK mocks cannot affect other tests.
// Holds ONE active workspace lease: a delegation gates inside the executor
// prompt until a stop-file appears, proving the claim persists as a real
// cross-process ownership row, then completes and releases it.
// Run via bun run test:ownership-cross-process; bun test runs it standalone.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.FUSION_PI_TEST_DIR;
const cwd = process.env.FUSION_CROSS_WORKSPACE;
const stopFile = process.env.FUSION_CROSS_STOP;

if (root && cwd && stopFile) {
	const { expect, mock, setDefaultTimeout, test } = await import("bun:test");
	setDefaultTimeout(60000);
	let prompts = 0;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const capabilities = { transcriptReopen: true, activeTurnReattach: false, durableExecution: false, idempotentSubmission: false, readOnlyScout: true, exactScoutToolLimit: false, workerAbort: true };
	const handle = {
		resumeRef: () => join(root, "session.jsonl"),
		setThinking: async () => {},
		prompt: async () => {
			prompts++;
			console.log("READY");
			while (!existsSync(stopFile)) await Bun.sleep(20);
			return { text: '```json\n{"status":"done","summary":"ok"}\n```', usage };
		},
		resume: async () => { throw new Error("not supported"); }, abort: async () => {}, dispose: () => {},
	};
	mock.module("../../src/pi/executor-backend.ts", () => ({
		createSessionExecutorBackend: () => ({ kind: "session", capabilities, createExecutor: async () => handle, dispose: async () => {} }),
	}));
	mock.module("../../src/pi/durable/backend.ts", () => ({ createDurableExecutorBackend: async () => { throw new Error("unavailable"); } }));

	const { default: registerFusion } = await import("../../src/index.ts");

	test("holds the workspace lease until the stop file appears", async () => {
		await mkdir(cwd, { recursive: true });
		const tools = new Map(), commands = new Map(), hooks = new Map(), notifications = [];
		let active = [];
		const pi = { registerTool: (tool) => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
			on: (name, callback) => hooks.set(name, callback), getActiveTools: () => active, setActiveTools: (value) => { active = value; },
			setModel: async () => true, setThinkingLevel: () => {}, sendUserMessage: () => {}, exec: async () => ({ code: 1, stdout: "" }) };
		const models = [
			{ provider: "fake", id: "gpt-6", name: "GPT 6", reasoning: false, cost: { output: 20 } },
			{ provider: "fake", id: "glm-5", name: "GLM 5", reasoning: false, cost: { output: 1 } },
		];
		const ctx = { cwd, sessionManager: { getSessionId: () => "supervisor" }, hasUI: true, mode: "rpc", scopedModels: [], modelRegistry: { find: () => models[1], getAvailable: () => models },
			waitForIdle: async () => {}, ui: { notify: (message) => notifications.push(message), input: async () => "", select: async (_title, options) => options[0], setWidget: () => {} } };
		registerFusion(pi);
		await commands.get("fusion").handler("original task", ctx);
		const result = await tools.get("fusion_delegate").execute("call", { action: "execute", brief: "build" }, undefined, undefined, ctx);
		expect(result.details.error).toBeUndefined();
		expect(prompts).toBe(1);
		await commands.get("fusion-clean").handler("", ctx);
		expect(notifications.at(-1)).toContain("cleared");
		console.log("DONE");
	});
}
