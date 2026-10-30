import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import plugin from "../src/opencode/index.ts";
import { nodeGitExec } from "../src/workspace/node-git.ts";
import { openWorkspaceRegistry } from "../src/workspace/ownership.ts";
import { readRunManifest } from "../src/core/manifest.ts";
import { OPENCODE_CAPABILITIES } from "../src/opencode/native-executor.ts";

type Context = { sessionID: string; agent: string; signal: AbortSignal; progress: (update: Record<string, unknown>) => Promise<void> };
type Tool = { name: string; execute: (input: unknown, context: Context) => Promise<{ content: string; metadata?: Record<string, unknown> }> };
type CommandDefinition = { name: string; description: string; execute: (args: { sessionID: string; prompt?: { text?: string } }) => unknown };
const context = (sessionID: string, agent = "fusion"): Context => ({ sessionID, agent, signal: new AbortController().signal, progress: async () => {} });

function memoryStorage() {
	const values = new Map<string, unknown>();
	return { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }, remove: async (key: string) => { values.delete(key); } };
}
type TestContext = Omit<Parameters<typeof plugin.setup>[0], "storage" | "session"> & { session: Omit<Parameters<typeof plugin.setup>[0]["session"], "get"> & Partial<Pick<Parameters<typeof plugin.setup>[0]["session"], "get">> };
const ownershipFixtures = new WeakMap<object, { root: string; close?: () => void }>();
const fixtureCleanup: { root: string; close?: () => void }[] = [];
afterEach(async () => { for (const fixture of fixtureCleanup.splice(0)) { fixture.close?.(); await rm(fixture.root, { recursive: true, force: true }); } });
async function setupTest(context: TestContext, storage = memoryStorage()) {
	let fixture = ownershipFixtures.get(storage);
	if (!fixture) { fixture = { root: await mkdtemp(join(tmpdir(), "fusion-plugin-owner-")) }; ownershipFixtures.set(storage, fixture); fixtureCleanup.push(fixture); }
	fixture.close?.();
	const get = context.session.get ?? (async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: sessionID.startsWith("child") ? "one" : undefined, location: { directory: context.location.directory } }));
	const result = await plugin.setup({ ...context, session: { ...context.session, get }, storage }, { ownershipRoot: fixture.root, canonicalize: async (path) => path });
	fixture.close = result.close;
	return result;
}

describe("OpenCode Fusion plugin", () => {
	test("registers native commands and /fusion starts a run and injects the supervisor prompt", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const commands: CommandDefinition[] = [];
		const prompts: { sessionID: string; text?: string }[] = [];
		const pushPrompt = (input: unknown) => { const value = input as { sessionID: string; text?: string }; prompts.push(value); };
		await setupTest({
			location: { directory: "/workspace" },
			session: { context: async () => [], hook: async () => {}, prompt: async (input: unknown) => { pushPrompt(input); } },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { const editor = { add: (command: CommandDefinition) => { commands.push(command); } }; await callback(editor); } },
			tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		}, storage);
		expect(commands.map((command) => command.name)).toEqual(["fusion-run", "fusion-mode", "fusion-status", "fusion-stats", "fusion-clean"]);
		await expect(commands[0].execute({ sessionID: "one", prompt: { text: "  " } })).rejects.toThrow("Provide a task");
		await commands[0].execute({ sessionID: "one", prompt: { text: "Build the thing" } });
		expect(prompts).toHaveLength(1);
		expect(prompts[0].sessionID).toBe("one");
		expect(prompts[0].text).toContain("Build the thing");
		expect(prompts[0].text).toContain("Fusion supervisor");
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.originalTask).toBe("Build the thing");
		expect(status.runActive).toBe(true);
		expect(status.workspaceClaimed).toBe(true);
		await expect(commands[0].execute({ sessionID: "one", prompt: { text: "Another" } })).rejects.toThrow("Finish and reset");
		// /fusion-status command reports the same payload as the tool.
		const commandStatus = JSON.parse(String(await commands[2].execute({ sessionID: "one" })));
		expect(commandStatus.originalTask).toBe("Build the thing");
		await tools.get("fusion_reset")!.execute({}, context("one"));
		// After reset the run is gone: /fusion can start the next one.
		await commands[0].execute({ sessionID: "one", prompt: { text: "Next run" } });
		expect(prompts).toHaveLength(2);
	});

	test("/fusion refuses honestly when the host cannot inject prompts", async () => {
		const commands: CommandDefinition[] = [];
		await setupTest({
			location: { directory: tmpdir() },
			session: { context: async () => [], hook: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async (callback) => { const editor = { add: (command: CommandDefinition) => { commands.push(command); } }; await callback(editor); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({}) }], transform: async () => {} },
		});
		await expect(commands[0].execute({ sessionID: "one", prompt: { text: "task" } })).rejects.toThrow("cannot inject the run prompt");
	});

	test("persistent mode gates fusion tools per session until a run is active", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		let commandTransform!: (editor: { add: (command: CommandDefinition) => void }) => Promise<void>;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void;
		let commands: CommandDefinition[] = [];
		const reportBlock = '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```';
		const base = () => ({
			location: { directory: "/workspace" },
			session: { context: async () => [], hook: async (_name: string, callback: (event: { agent: string; tools: Record<string, unknown>; sessionID?: string }) => void) => { contextHook = callback; }, prompt: async () => {} },
			command: { list: async () => ({ data: [] }), transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => Promise<void>) => { commandTransform = callback; } },
			tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: reportBlock } }) }],
				transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		});
		await setupTest(base() as TestContext, storage);
		await commandTransform({ add: (command) => { commands.push(command); } });
		const fusionTools = () => { const record: Record<string, unknown> = { fusion_start: {}, fusion_delegate: {}, fusion_scout: {}, fusion_reconcile: {}, fusion_reset: {}, fusion_configure: {}, fusion_status: {}, fusion_stats: {}, read: {} }; contextHook({ agent: "fusion", tools: record, sessionID: "one" }); return record; };
		// Mode off by default: a session without an active run loses mutation tools.
		let record = fusionTools();
		expect(record).not.toHaveProperty("fusion_start");
		expect(record).not.toHaveProperty("fusion_delegate");
		expect(record).toHaveProperty("fusion_status");
		expect(record).toHaveProperty("fusion_stats");
		expect(record).toHaveProperty("read");
		// Non-fusion agents are never touched.
		const buildRecord: Record<string, unknown> = { fusion_delegate: {}, read: {} };
		contextHook({ agent: "build", tools: buildRecord, sessionID: "one" });
		expect(buildRecord).toHaveProperty("fusion_delegate");
		// /fusion starts the run: tools become visible for that session.
		await commands[0].execute({ sessionID: "one", prompt: { text: "Build it" } });
		record = fusionTools();
		expect(record).toHaveProperty("fusion_delegate");
		// Mode on: visible even without an active run; the toggle persists.
		await commands[1].execute({ sessionID: "one", prompt: { text: "on" } });
		await tools.get("fusion_reset")!.execute({}, context("one"));
		record = fusionTools();
		expect(record).toHaveProperty("fusion_start");
		// Reload: the persisted mode survives, and the new instance's toggle owns it now.
		await setupTest(base() as TestContext, storage);
		const commandsAfterReload: CommandDefinition[] = [];
		await commandTransform({ add: (command) => { commandsAfterReload.push(command); } });
		record = fusionTools();
		expect(record).toHaveProperty("fusion_start");
		// Mode off again hides them.
		await commandsAfterReload[1].execute({ sessionID: "one", prompt: { text: "off" } });
		record = fusionTools();
		expect(record).not.toHaveProperty("fusion_start");
	});

	test("fusion-clean refuses an unsettled foreign record", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-plugin-clean-"));
		const storage = memoryStorage();
		const tools = new Map<string, Tool>();
		let failNative = false;
		const makeContext = (capture: CommandDefinition[]) => ({
			location: { directory: root },
			session: { context: async () => [], hook: async () => {}, prompt: async () => {}, get: async ({ sessionID: id }: { sessionID: string }) => ({ id, location: { directory: root } }) },
			command: { list: async () => ({ data: [] }), transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => unknown) => { await callback({ add: (command) => capture.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { if (failNative) throw new Error("connection lost"); return { output: { sessionID: "child", status: "completed", output: "done" } }; } }], transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		let host: { close(): void } | undefined;
		try {
			// Instance A owns the run as session "A"; a failed delegation leaves the record pending.
			const commandsA: CommandDefinition[] = [];
			host = await setupTest(makeContext(commandsA) as TestContext, storage);
			await commandsA[0].execute({ sessionID: "A", prompt: { text: "Task" } });
			failNative = true;
			await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("A"))).rejects.toThrow("connection lost");
			// Instance B adopts the pending record; clean from B's own session refuses it.
			host.close(); host = undefined;
			failNative = false;
			const commandsB: CommandDefinition[] = [];
			let cleanB: ((args: { sessionID: string }) => unknown) | undefined;
			host = await setupTest({ ...makeContext(commandsB), command: { list: async () => ({ data: [] }), transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => unknown) => { await callback({ add: (command) => { commandsB.push(command); if (command.name === "fusion-clean") cleanB = command.execute; } }); } } } as TestContext, storage);
			await expect(cleanB!({ sessionID: "B" })).rejects.toThrow("is pending; reconcile it or run the explicit operator resolution");
			host.close(); host = undefined;
		} finally { host?.close(); await rm(root, { recursive: true, force: true }); }
	});

	test("fusion-clean releases a settled foreign record through claim-then-release", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-plugin-clean-settled-"));
		const storage = memoryStorage();
		const tools = new Map<string, Tool>();
		const makeContext = (capture: CommandDefinition[]) => ({
			location: { directory: root },
			session: { context: async () => [], hook: async () => {}, prompt: async () => {}, get: async ({ sessionID: id }: { sessionID: string }) => ({ id, location: { directory: root } }) },
			command: { list: async () => ({ data: [] }), transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => unknown) => { await callback({ add: (command) => capture.push(command) }); } },
			tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }], transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => { callback({ add: (tool) => tools.set(tool.name, tool) }); } },
		});
		let host: { close(): void } | undefined;
		let runId: string | undefined;
		try {
			const commandsA: CommandDefinition[] = [];
			host = await setupTest(makeContext(commandsA) as TestContext, storage);
			// fusion_start persists a settled record (no executor work yet).
			await commandsA[0].execute({ sessionID: "A", prompt: { text: "Task" } });
			const ownedStatus = JSON.parse((await tools.get("fusion_status")!.execute({}, context("B"))).content);
			expect(ownedStatus.recovery).toBe("settled");
			runId = ownedStatus.runId;
			// Instance B adopts the settled record; clean from B's own session releases it.
			host.close(); host = undefined;
			const commandsB: CommandDefinition[] = [];
			let cleanB: ((args: { sessionID: string }) => unknown) | undefined;
			host = await setupTest({ ...makeContext(commandsB), command: { list: async () => ({ data: [] }), transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => unknown) => { await callback({ add: (command) => { commandsB.push(command); if (command.name === "fusion-clean") cleanB = command.execute; } }); } } } as TestContext, storage);
			expect(await cleanB!({ sessionID: "B" })).toBe("Released settled Fusion ownership for this workspace.");
			// The record is released: another session sees no Fusion run here.
			expect(await tools.get("fusion_status")!.execute({}, context("B"))).toHaveProperty("content", "No Fusion run in this session.");
			expect(runId).toBeString();
		} finally { host?.close(); await rm(root, { recursive: true, force: true }); }
	});

	test("configures a catalog-validated executor model that reaches scout and executor submissions", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		const nativeInputs: { agent?: string; model?: string }[] = [];
		const executorReport = '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```';
		const catalog = { list: async () => ({ data: [
			{ providerID: "prov", id: "executor-model", name: "Executor Model", status: "active", enabled: true, variants: [{ id: "low" }, { id: "high" }], cost: [{ input: 1, output: 3 }], time: { released: 1750000000000 } },
			{ providerID: "prov", id: "no-variants", name: "No Variants", status: "active", enabled: true, cost: [{ output: 20 }] },
			{ providerID: "other", id: "disabled-model", name: "Disabled", status: "active", enabled: false, cost: [] },
		] }) };
		await setupTest({ location: { directory: "/workspace" }, model: catalog, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input) => {
				nativeInputs.push({ agent: input.agent, model: input.model });
				return { output: { sessionID: input.agent === "fusion-scout" ? "scout" : "child", status: "completed", output: input.agent === "fusion-scout" ? "answer" : executorReport } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		const configure = tools.get("fusion_configure")!;
		await expect(configure.execute({ provider: "prov", model: "missing-model" }, context("one"))).rejects.toThrow("not in the OpenCode model catalog");
		await expect(configure.execute({ provider: "prov", model: "executor-model", variant: "turbo" }, context("one"))).rejects.toThrow('has no variant "turbo"');
		await expect(configure.execute({ provider: "prov", model: "no-variants", variant: "low" }, context("one"))).rejects.toThrow("no variants");
		await expect(configure.execute({ provider: "other", model: "disabled-model" }, context("one"))).rejects.toThrow("disabled");
		await expect(configure.execute({ provider: "prov", model: "executor-model" }, context("one", "fusion-executor"))).rejects.toThrow("only to the fusion primary agent");
		// Valid configuration: applies to this run, shared tier/cohort metadata is reported.
		const configured = await configure.execute({ provider: "prov", model: "executor-model", variant: "low" }, context("one"));
		expect(configured.metadata).toMatchObject({ applied: "now", model: { provider: "prov", modelId: "executor-model", variant: "low" }, tier: "executor", outputPricePerM: 3 });
		// The scout picks up the configured model with its variant immediately.
		const scout = await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
		expect(scout.content).toContain("answer");
		expect(nativeInputs[0]).toEqual({ agent: "fusion-scout", model: "prov/executor-model#low" });
		// The executor delegation uses the same configured model.
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		expect(nativeInputs[1]).toEqual({ agent: "fusion-executor", model: "prov/executor-model#low" });
		// The configuration persists in the shared manifest.
		const persisted = await storage.get(`run/${createHash("sha256").update("/workspace").digest("hex")}`) as { model?: { provider?: string; modelId?: string; variant?: string } };
		expect(persisted.model).toEqual({ provider: "prov", modelId: "executor-model", variant: "low" });
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.model).toEqual({ provider: "prov", modelId: "executor-model", variant: "low" });
		// Reconfiguration after executor work applies to the next run only.
		const later = await configure.execute({ provider: "prov", model: "no-variants" }, context("one"));
		expect(later.metadata).toMatchObject({ applied: "next-run" });
		await tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"));
		expect(nativeInputs[2]).toEqual({ agent: "fusion-executor", model: "prov/executor-model#low" });
	});

	test("configure without a host catalog refuses honestly and fusion tools stay on host defaults", async () => {
		const tools = new Map<string, Tool>();
		let modelSeen = false;
		const reportBlock = '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```';
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input) => {
				modelSeen = input.model !== undefined && input.model !== null;
				return { output: { sessionID: "child", status: "completed", output: reportBlock } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		await expect(tools.get("fusion_configure")!.execute({ provider: "prov", model: "m" }, context("one"))).rejects.toThrow("model catalog is unavailable");
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		// Without configuration no model override reaches the native call.
		expect(modelSeen).toBe(false);
	});

	test("persists the original request before delegation and retains it through the final fix after reload", async () => {
		const storage = memoryStorage();
		const prompts: string[] = [];
		const makeContext = (tools: Map<string, Tool>): TestContext => ({
			location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input) => {
					prompts.push(input.prompt);
					return { output: { sessionID: "child-1", status: "completed", output: "done" } };
				} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		});
		const first = new Map<string, Tool>();
		await setupTest(makeContext(first), storage);
		await expect(first.get("fusion_start")!.execute({ task: "Original acceptance requirements" }, context("other-agent", "ordinary"))).rejects.toThrow("only to the fusion primary agent");
		await first.get("fusion_start")!.execute({ task: "Original acceptance requirements" }, context("one"));
		const restored = new Map<string, Tool>();
		await setupTest(makeContext(restored), storage);
		const status = JSON.parse((await restored.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.originalTask).toBe("Original acceptance requirements");
		expect(status.nextAction).toContain("action execute");
		expect(status.capabilities.activeTurnReattach).toBe(false);
		await expect(restored.get("fusion_delegate")!.execute({ action: "execute", brief: "Implement", originalTask: "replacement" }, context("one"))).rejects.toThrow("cannot be replaced");
		await restored.get("fusion_delegate")!.execute({ action: "execute", brief: "Implement" }, context("one"));
		await restored.get("fusion_delegate")!.execute({ action: "final_fix", brief: "Fix remaining gaps" }, context("one"));
		expect(prompts[1]).toContain("Original acceptance requirements");
		const stats = JSON.parse((await restored.get("fusion_stats")!.execute({}, context("one"))).content);
		expect(stats).toMatchObject({ executed: true, revisions: { used: 0, limit: 3 }, scoutCalls: { used: 0, limit: 4 }, finalFixUsed: true, lastResult: { status: "completed" }, usage: { available: false } });
		await expect(restored.get("fusion_stats")!.execute({}, context("one", "ordinary"))).rejects.toThrow("only to the fusion primary agent");
		await expect(restored.get("fusion_start")!.execute({ task: "Another task" }, context("one"))).rejects.toThrow("reset the existing Fusion run");
		await restored.get("fusion_reset")!.execute({}, context("one"));
		await restored.get("fusion_start")!.execute({ task: "Another task" }, context("one"));
	});

	test("blocks new work and reset while a run start is being persisted", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let release!: () => void;
		let entered!: () => void;
		const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const storage = { ...backing, set: async (key: string, value: unknown) => { entered(); await gate; await backing.set(key, value); } };
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { throw new Error("unexpected submission"); } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		const start = tools.get("fusion_start")!.execute({ task: "Original task" }, context("one"));
		await enteredWrite;
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("run is starting");
		await expect(tools.get("fusion_scout")!.execute({ questions: ["where?"] }, context("one"))).rejects.toThrow("run is starting");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("run is starting");
		release();
		await start;
	});

	test("rejects a run start for a session outside the workspace without claiming ownership", async () => {
		const tools = new Map<string, Tool>();
		await setupTest({ location: { directory: "/workspace" }, session: {
			context: async () => [], hook: async () => {}, get: async ({ sessionID }) => ({ id: sessionID, location: { directory: "/other" } }),
		}, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { throw new Error("unexpected submission"); } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		await expect(tools.get("fusion_start")!.execute({ task: "task" }, context("one"))).rejects.toThrow("session or workspace does not match");
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.runActive).toBe(false);
		expect(status.originalTask).toBeUndefined();
	});

	test("reset holds workspace ownership until storage removal finishes", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let hold = true;
		const storage = { ...backing, remove: async (key: string) => { if (hold) await gate; await backing.remove(key); } };
		let calls = 0;
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => {
				calls++;
				return { output: { sessionID: `child-${calls}`, status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		const delegate = tools.get("fusion_delegate")!;
		const reset = tools.get("fusion_reset")!;
		await delegate.execute({ action: "execute", brief: "build" }, context("one"));
		const deleting = reset.execute({}, context("one"));
		await expect(delegate.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("reset is in progress");
		await expect(delegate.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("reset is in progress");
		await expect(reset.execute({}, context("one"))).rejects.toThrow("reset is in progress");
		expect(calls).toBe(1);
		hold = false; release();
		await deleting;
		await delegate.execute({ action: "execute", brief: "other" }, context("two"));
		expect(calls).toBe(2);
	});

	test("a failed reset keeps the owner and permits a later retry", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let fail = true;
		const storage = { ...backing, remove: async (key: string) => {
			if (fail) { fail = false; throw new Error("remove failed"); }
			await backing.remove(key);
		} };
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("remove failed");
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("owns this workspace");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).resolves.toHaveProperty("content", "Fusion run reset.");
	});

	test("preserves pending work when saving a completed turn fails", async () => {
		const backing = memoryStorage();
		let failSettlement = false;
		let messages: unknown[] = [];
		let description = "";
		let calls = 0;
		const storage = { ...backing, set: async (key: string, value: unknown) => {
			if (failSettlement && !(value as { pending?: unknown }).pending) {
				failSettlement = false;
				throw new Error("settlement write failed");
			}
			await backing.set(key, value);
		} };
		const makeContext = (tools: Map<string, Tool>): TestContext => ({
			location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input, ctx) => {
					calls++;
					await ctx.progress({ sessionID: "child" });
					if (calls === 1) { description = input.description; failSettlement = true; }
					return { output: { sessionID: "child", status: "completed", output: "done" } };
				} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		});
		const first = new Map<string, Tool>();
		await setupTest(makeContext(first), storage);
		await expect(first.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("settlement write failed");
		await expect(first.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
		const restored = new Map<string, Tool>();
		await setupTest(makeContext(restored), storage);
		await expect(restored.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("unknown outcome");
		messages = [{ type: "synthetic", description, metadata: { source: "subagent", childID: "child", agent: "fusion-executor", state: "completed" }, text: `<subagent sessionID="child" state="completed" description="${description}">\ndone\n</subagent>` }];
		await restored.get("fusion_reconcile")!.execute({}, context("one"));
		await restored.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"));
		expect(calls).toBe(2);
	});

	test("retries a revision after confirmed pre-submission storage failure", async () => {
		const tools = new Map<string, Tool>();
		const backing = memoryStorage();
		let failNext = false;
		const storage = { ...backing, set: async (key: string, value: unknown) => {
			if (failNext) { failNext = false; throw new Error("temporary storage failure"); }
			await backing.set(key, value);
		} };
		let calls = 0;
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => {
				calls++;
				return { output: { sessionID: "child", status: "completed", output: "done" } };
			} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		const delegate = tools.get("fusion_delegate")!;
		await delegate.execute({ action: "execute", brief: "build" }, context("one"));
		failNext = true;
		await expect(delegate.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("temporary storage failure");
		expect(calls).toBe(1);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.revisions).toBe(0);
		expect(status.phase).toBe("failed");
		expect(status.uncertain).toBe(false);
		await delegate.execute({ action: "revise", brief: "fix" }, context("one"));
		expect(calls).toBe(2);
	});

	test("does not submit work when the pending record cannot be saved", async () => {
		const tools = new Map<string, Tool>();
		let calls = 0;
		const storage = { get: async () => undefined, set: async () => { throw new Error("storage unavailable"); }, remove: async () => {} };
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { calls++; return { output: {} }; } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"))).rejects.toThrow("storage unavailable");
		expect(calls).toBe(0);
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
	});

	test("restores a pending turn after reload and requires its own completion before continuing", async () => {
		const storage = memoryStorage();
		let description = "";
		let messages: unknown[] = [];
		const calls: Record<string, unknown>[] = [];
		const makeContext = (tools: Map<string, Tool>): TestContext => ({
			location: { directory: "/workspace" }, session: { context: async () => messages, hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input, ctx) => {
					calls.push({ ...input });
					await ctx.progress({ sessionID: "child-1" });
					if (calls.length === 1) { description = input.description; throw new Error("connection lost"); }
					return { output: { sessionID: "child-1", status: "completed", output: "fixed" } };
				} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			},
		});
		const first = new Map<string, Tool>();
		await setupTest(makeContext(first), storage);
		await expect(first.get("fusion_delegate")!.execute({ action: "execute", brief: "build", originalTask: "original" }, context("one"))).rejects.toThrow("connection lost");
		const failedStatus = JSON.parse((await first.get("fusion_status")!.execute({}, context("one"))).content);
		expect(failedStatus.phase).toBe("failed");
		expect(failedStatus.uncertain).toBe(true);
		expect(failedStatus.pending.requestId).toBe(description);
		expect(failedStatus.owner.supervisorId).toBe("one");
		expect(failedStatus.runId).toBeString();
		const restored = new Map<string, Tool>();
		await setupTest(makeContext(restored), storage);
		await expect(restored.get("fusion_delegate")!.execute({ action: "execute", brief: "retry" }, context("one"))).rejects.toThrow("unknown outcome");
		await expect(restored.get("fusion_delegate")!.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("owns this workspace");
		await expect(restored.get("fusion_reconcile")!.execute({}, context("one"))).rejects.toThrow("No matching completion");
		messages = [{ type: "synthetic", description, metadata: { source: "subagent", childID: "child-1", agent: "fusion-executor", state: "completed" }, text: `<subagent sessionID="child-1" state="completed" description="${description}">\nfinished\n</subagent>` }];
		expect((await restored.get("fusion_reconcile")!.execute({}, context("one"))).content).toContain("finished");
		await restored.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"));
		expect(calls[1].sessionID).toBe("child-1");
		expect((await restored.get("fusion_status")!.execute({}, context("one"))).content).toContain("original");
		await restored.get("fusion_reset")!.execute({}, context("one"));
		const afterReset = new Map<string, Tool>();
		await setupTest(makeContext(afterReset), storage);
		expect((await afterReset.get("fusion_status")!.execute({}, context("one"))).content).toContain("No Fusion run");
	});
	test("blocks direct subagent calls only for the Fusion supervisor", async () => {
		const tools = new Map<string, Tool>();
		let before!: (event: { tool: string; agent: string }) => void;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown> }) => void;
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async (_name, callback) => { contextHook = callback; } }, tool: {
			hook: async (_name, callback) => { before = callback; },
			list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		expect(() => before({ agent: "fusion", tool: "subagent" })).toThrow("fusion_delegate");
		expect(() => before({ agent: "build", tool: "subagent" })).not.toThrow();
		expect(() => before({ agent: "fusion", tool: "read" })).not.toThrow();
		const fusionTools = { subagent: {}, read: {} } as Record<string, unknown>;
		contextHook({ agent: "fusion", tools: fusionTools });
		expect(fusionTools).not.toHaveProperty("subagent");
		const buildTools = { subagent: {} };
		contextHook({ agent: "build", tools: buildTools });
		expect(buildTools).toHaveProperty("subagent");
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"))).resolves.toHaveProperty("content");
	});
	test("fusion tools refuse every non-supervisor agent, including the executor", async () => {
		const tools = new Map<string, Tool>();
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		for (const name of ["fusion_delegate", "fusion_status", "fusion_reconcile", "fusion_reset"]) {
			await expect(tools.get(name)!.execute(name === "fusion_delegate" ? { action: "execute", brief: "recursion" } : {}, context("one", "fusion-executor"))).rejects.toThrow("only to the fusion primary agent");
			await expect(tools.get(name)!.execute(name === "fusion_delegate" ? { action: "execute", brief: "recursion" } : {}, context("one", "general"))).rejects.toThrow("only to the fusion primary agent");
		}
	});

	test("fusion_scout runs a disposable read-only scout through the shared invocation budget", async () => {
		const tools = new Map<string, Tool>();
		let scoutCalls = 0;
		let executorCalls = 0;
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				if (input.agent !== "fusion-scout") { executorCalls++; return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } }; }
				scoutCalls++;
				return { output: { sessionID: `scout-${scoutCalls}`, status: "completed", output: `1. fixture.txt:1 has the answer ${scoutCalls}` } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const scout = tools.get("fusion_scout")!;
		const delegate = tools.get("fusion_delegate")!;
		await expect(scout.execute({}, context("one"))).rejects.toThrow("Invalid Fusion scout input");
		await expect(scout.execute({ questions: [] }, context("one"))).rejects.toThrow("Invalid Fusion scout input");
		await expect(scout.execute({ questions: ["a", "b", "c", "d", "e", "f"] }, context("one"))).rejects.toThrow("Invalid Fusion scout input");
		await expect(scout.execute({ questions: ["q"] }, context("one", "fusion-executor"))).rejects.toThrow("only to the fusion primary agent");
		expect(scoutCalls).toBe(0);
		// Scouting before any delegation lazily creates the session's run.
		const first = await scout.execute({ questions: ["where is the answer?"] }, context("one"));
		expect(first.content).toContain("1. fixture.txt:1 has the answer 1");
		expect(first.content).toContain("Scout usage:");
		expect(first.metadata).toMatchObject({ childSessionID: "scout-1", status: "completed", capped: false });
		expect(executorCalls).toBe(0);
		for (let i = 2; i <= 4; i++) await scout.execute({ questions: ["more"] }, context("one"));
		expect(scoutCalls).toBe(4);
		// The fifth call is refused by the shared budget before any native work.
		const fifth = await scout.execute({ questions: ["again?"] }, context("one"));
		expect(fifth.content).toContain("Scout limit reached");
		expect(scoutCalls).toBe(4);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.scoutCalls).toBe(4);
		// The same session's run still accepts a delegation after scouting.
		await delegate.execute({ action: "execute", brief: "build" }, context("one"));
		expect(executorCalls).toBe(1);
		// ... and the budget stays shared across the whole run.
		expect((await scout.execute({ questions: ["more"] }, context("one"))).content).toContain("Scout limit reached");
		expect(scoutCalls).toBe(4);
	});

	test("scout tool calls are capped synchronously before execution and allowlisted", async () => {
		const tools = new Map<string, Tool>();
		let before!: (event: { tool: string; agent: string; sessionID?: string }) => void;
		const interrupted: string[] = [];
		let release!: () => void, seen!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { seen = resolve; });
		let scoutRuns = 0;
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {}, interrupt: async ({ sessionID }) => { interrupted.push(sessionID); } }, tool: {
			hook: async (_name, callback) => { before = callback; },
			list: async () => [{ id: "subagent", execute: async (input, ctx) => {
				if (input.agent !== "fusion-scout") return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
				scoutRuns++;
				if (scoutRuns === 1) { await ctx.progress({ sessionID: "scout-1" }); seen(); await gate; }
				return { output: { sessionID: `scout-${scoutRuns}`, status: "completed", output: "answer" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const scout = tools.get("fusion_scout")!;
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		const pending = scout.execute({ questions: ["q"] }, context("one"));
		await entered;
		// While the scout is in flight, its child's tool calls pass through this hook.
		expect(() => before({ agent: "build", tool: "edit", sessionID: "scout-1" })).not.toThrow();
		expect(() => before({ agent: "fusion-executor", tool: "edit", sessionID: "scout-1" })).not.toThrow();
		// Non-allowlisted tools are denied before their effects, without consuming the cap.
		expect(() => before({ agent: "fusion-scout", tool: "edit", sessionID: "scout-1" })).toThrow("denied before execution");
		expect(() => before({ agent: "fusion-scout", tool: "shell", sessionID: "scout-1" })).toThrow("denied before execution");
		expect(() => before({ agent: "fusion-scout", tool: "subagent", sessionID: "scout-1" })).toThrow("denied before execution");
		expect(() => before({ agent: "fusion-scout", tool: "webfetch", sessionID: "scout-1" })).toThrow("denied before execution");
		// Calls from other sessions never touch this scout's cap.
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "someone-else" })).not.toThrow();
		// Exactly 20 read/search/list calls run; the 21st is refused before execution.
		for (let i = 0; i < 20; i++) expect(() => before({ agent: "fusion-scout", tool: i % 2 ? "grep" : "read", sessionID: "scout-1" })).not.toThrow();
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-1" })).toThrow("Tool call limit reached");
		// Refused attempts count too: the terminate window interrupts the child.
		expect(() => before({ agent: "fusion-scout", tool: "glob", sessionID: "scout-1" })).toThrow("Tool call limit reached");
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-1" })).toThrow("Tool call limit reached");
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-1" })).toThrow("Tool call limit reached");
		expect(interrupted).toEqual(["scout-1"]);
		release();
		const result = await pending;
		expect(result.content).toContain("Scout stopped after 20 tool calls; partial answer:");
		expect(result.metadata).toMatchObject({ capped: true, childSessionID: "scout-1" });
		// After the turn the child is no longer the active scout, but scout-agent
		// calls are never unguarded: edits stay denied and reads get a fresh cap.
		expect(() => before({ agent: "fusion-scout", tool: "edit", sessionID: "scout-1" })).toThrow("denied before execution");
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-1" })).not.toThrow();
	});

	test("a cancelled scout is reported and leaves executor work unaffected", async () => {
		const tools = new Map<string, Tool>();
		let release!: () => void, seen!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { seen = resolve; });
		const calls: string[] = [];
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				calls.push(input.agent);
				if (input.agent !== "fusion-scout") return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
				seen();
				await gate;
				throw new Error("cancelled native call");
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const scout = tools.get("fusion_scout")!;
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		const controller = new AbortController();
		const pending = scout.execute({ questions: ["q"] }, { ...context("one"), signal: controller.signal });
		await entered;
		controller.abort();
		release();
		const result = await pending;
		expect(result.content).toContain(`stopped with status "cancelled"`);
		expect(result.metadata).toMatchObject({ status: "cancelled" });
		// The cancelled scout neither locked the run nor touched the executor child.
		await expect(tools.get("fusion_delegate")!.execute({ action: "revise", brief: "fix" }, context("one"))).resolves.toHaveProperty("content");
		expect(calls).toEqual(["fusion-executor", "fusion-scout", "fusion-executor"]);
		await tools.get("fusion_reset")!.execute({}, context("one"));
	});

	test("a backgrounded scout keeps its guard until its execution is observed to end", async () => {
		const tools = new Map<string, Tool>();
		let before!: (event: { tool: string; agent: string; sessionID?: string }) => void;
		const busQueue: { type: string; data?: Record<string, unknown> }[] = [];
		let busWake: (() => void) | undefined;
		const eventHost = { subscribe: () => ({
			[Symbol.asyncIterator]() {
				return { next: async () => {
					for (;;) {
						const next = busQueue.shift();
						if (next) return { value: next, done: false as const };
						await new Promise<void>((resolve) => { busWake = resolve; });
						busWake = undefined;
					}
				} };
			},
		}) };
		await setupTest({ location: { directory: tmpdir() }, event: eventHost, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async (_name, callback) => { before = callback; },
			list: async () => [{ id: "subagent", execute: async (input, ctx) => {
				if (input.agent !== "fusion-scout") return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
				await ctx.progress({ sessionID: "scout-bg" });
				// The host backgrounds the scout; the child keeps running.
				return { output: { sessionID: "scout-bg", status: "running", output: "backgrounded" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const scout = tools.get("fusion_scout")!;
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		const result = await scout.execute({ questions: ["q"] }, context("one"));
		expect(result.content).toContain("Fusion scout failed");
		// The call returned, but the child is still running: enforcement persists.
		for (let i = 0; i < 20; i++) expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-bg" })).not.toThrow();
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-bg" })).toThrow("Tool call limit reached");
		expect(() => before({ agent: "fusion-scout", tool: "shell", sessionID: "scout-bg" })).toThrow("denied before execution");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("still running");
		expect(JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content).executed).toBe(true);
		// The child's execution ends: the guard is released, and a later scout-agent
		// session starts with a fresh cap.
		busQueue.push({ type: "session.execution.succeeded", data: { sessionID: "scout-bg" } });
		busWake?.();
		await new Promise((resolve) => setTimeout(resolve, 25));
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).resolves.toHaveProperty("content", "Fusion run reset.");
		expect(() => before({ agent: "fusion-scout", tool: "read", sessionID: "scout-bg" })).not.toThrow();
		// Prohibited tools stay denied regardless of guard state.
		expect(() => before({ agent: "fusion-scout", tool: "edit", sessionID: "scout-bg" })).toThrow("denied before execution");
	});

	test("reset during an active scout is refused before touching the run", async () => {
		const tools = new Map<string, Tool>();
		const storage = memoryStorage();
		let release!: () => void, seen!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { seen = resolve; });
		await setupTest({ location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				if (input.agent !== "fusion-scout") return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
				seen();
				await gate;
				return { output: { sessionID: "scout", status: "completed", output: "answer" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		const scout = tools.get("fusion_scout")!;
		const reset = tools.get("fusion_reset")!;
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		const key = `run/${createHash("sha256").update("/workspace").digest("hex")}`;
		expect(await storage.get(key)).toBeDefined();
		const pending = scout.execute({ questions: ["q"] }, context("one"));
		await seen;
		await expect(reset.execute({}, context("one"))).rejects.toThrow("still running");
		// Nothing was dismantled: the record, the lease state, and the run survive.
		expect(await storage.get(key)).toBeDefined();
		release();
		expect((await pending).content).toContain("answer");
		await expect(reset.execute({}, context("one"))).resolves.toHaveProperty("content", "Fusion run reset.");
	});

	test("scouts are serialized and their release never blocks reset", async () => {
		const tools = new Map<string, Tool>();
		let release!: () => void, seen!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { seen = resolve; });
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				if (input.agent !== "fusion-scout") return { output: { sessionID: "child", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
				seen();
				await gate;
				return { output: { sessionID: "scout", status: "completed", output: "answer" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const scout = tools.get("fusion_scout")!;
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
		const pending = scout.execute({ questions: ["q"] }, context("one"));
		await entered;
		await expect(scout.execute({ questions: ["q"] }, context("one"))).rejects.toThrow("already running");
		release();
		const result = await pending;
		expect(result.content).toContain("answer");
		// The disposable scout released its handle, so reset is not blocked.
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).resolves.toHaveProperty("content", "Fusion run reset.");
	});


	test("reconciles only a matching native background completion and retains the child", async () => {
		const tools = new Map<string, Tool>();
		const calls: Record<string, unknown>[] = [];
		let messages: unknown[] = [];
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => {
				calls.push({ ...input });
				return { output: { sessionID: "child-1", status: calls.length === 1 ? "running" : "completed", output: "done" } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const delegate = tools.get("fusion_delegate")!;
		const reconcile = tools.get("fusion_reconcile")!;
		expect((await delegate.execute({ action: "execute", brief: "work" }, context("one"))).content).toContain("fusion_reconcile");
		const description = calls[0].description as string;
		const notification = (childID: string, label: string) => ({ type: "synthetic", description: label, metadata: { source: "subagent", childID, agent: "fusion-executor", state: "completed" }, text: `<subagent sessionID="${childID}" state="completed" description="${label}">\nfinal report\n</subagent>` });
		messages = [notification("child-1", "old turn"), notification("other-child", description)];
		await expect(reconcile.execute({}, context("one"))).rejects.toThrow("No matching completion");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
		messages.push(notification("child-1", description));
		const result = await reconcile.execute({}, context("one"));
		expect(result.content).toContain("final report");
		expect(result.content).toContain("Review: full");
		await delegate.execute({ action: "revise", brief: "fix" }, context("one"));
		expect(calls[1].sessionID).toBe("child-1");
		await expect(reconcile.execute({}, context("one"))).rejects.toThrow("No backgrounded");
	});

	test("reports failed background work as failed even if its output contains a success report", async () => {
		const tools = new Map<string, Tool>();
		let description = "";
		let messages: unknown[] = [];
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
			hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input) => { description = input.description; return { output: { sessionID: "child", status: "running", output: "working" } }; } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"));
		const output = '```json\n{"status":"done"}\n```';
		messages = [{ type: "synthetic", description, metadata: { source: "subagent", childID: "child", agent: "fusion-executor", state: "error" }, text: `<subagent sessionID="child" state="error" description="${description}">\n${output}\n</subagent>` }];
		const result = await tools.get("fusion_reconcile")!.execute({}, context("one"));
		expect(result.content).toContain("Fusion executor error");
		expect(result.content).not.toContain("Status: done");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).resolves.toHaveProperty("content", "Fusion run reset.");
	});

	test("reports real workspace changes while requiring a full review", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-plugin-workspace-"));
		const storage = memoryStorage();
		try {
			const init = await nodeGitExec(["init", "-q"], { cwd: root, timeout: 5000 });
			expect(init.code).toBe(0);
			const tools = new Map<string, Tool>();
			await setupTest({ location: { directory: root }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
				list: async () => [{ id: "subagent", execute: async () => {
					await writeFile(join(root, "fixture.txt"), "changed\n");
					return { output: { sessionID: "child-1", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[{"command":"check","result":"pass"}],"files_changed":[],"blockers":[]}\n```' } };
				} }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} }, storage);
			const result = await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "create fixture" }, context("one"));
			expect(result.content).toContain("new: fixture.txt");
			expect(result.content).toContain("Review: full");
			expect(result.content).toContain("executor tool activity unavailable");
			const persisted = await storage.get(`run/${createHash("sha256").update(root).digest("hex")}`) as unknown;
			expect(persisted).toBeDefined();
			const manifest = readRunManifest(persisted, { harness: "opencode", workspace: root });
			expect(manifest.lastResult?.status).toBe("completed");
			expect(manifest.lastResult?.evidence).toContain("new:fixture.txt");
		} finally { await rm(root, { recursive: true, force: true }); }
	});
	test("registers tools and continues the same child through guarded turns", async () => {
		const tools = new Map<string, Tool>();
		const calls: Record<string, unknown>[] = [];
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (input, ctx) => {
				calls.push({ ...input });
				await ctx.progress({ sessionID: "child-1" });
				return { output: { sessionID: "child-1", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[],"files_changed":[],"blockers":[]}\n```' } };
			} }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const delegate = tools.get("fusion_delegate")!;
		const reset = tools.get("fusion_reset")!;
		await expect(delegate.execute({ action: "revise", brief: "fix" }, context("one"))).rejects.toThrow("Cannot revise");
		await expect(delegate.execute({ action: "execute", brief: "build" }, context("one", "build"))).rejects.toThrow("fusion primary");
		const result = await delegate.execute({ action: "execute", brief: "build", originalTask: "original request" }, context("one"));
		expect(result.content).toContain("Status: done");
		await expect(delegate.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("owns this workspace");
		await delegate.execute({ action: "revise", brief: "fix" }, context("one"));
		await delegate.execute({ action: "final_fix", brief: "audit" }, context("one"));
		expect(calls[0]?.sessionID).toBeUndefined();
		expect(calls[1]?.sessionID).toBe("child-1");
		expect(calls[2]?.prompt).toContain("original request");
		await expect(delegate.execute({ action: "final_fix", brief: "again" }, context("one"))).rejects.toThrow("Final fix already used");
		await reset.execute({}, context("one"));
		await delegate.execute({ action: "execute", brief: "next" }, context("two"));
	});

	test("does not permit a retry or release when a child outcome is unknown", async () => {
		const tools = new Map<string, Tool>();
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
			list: async () => [{ id: "subagent", execute: async (_input, ctx) => { await ctx.progress({ sessionID: "child-1" }); throw new Error("lost connection"); } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const delegate = tools.get("fusion_delegate")!;
		await expect(delegate.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("lost connection");
		await expect(delegate.execute({ action: "execute", brief: "retry" }, context("one"))).rejects.toThrow("unknown outcome");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
		await expect(delegate.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("owns this workspace");
	});

	test("also blocks retries when the native call fails before reporting a child ID", async () => {
		const tools = new Map<string, Tool>();
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => { throw new Error("connection lost"); } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const delegate = tools.get("fusion_delegate")!;
		await expect(delegate.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("connection lost");
		await expect(delegate.execute({ action: "execute", brief: "retry" }, context("one"))).rejects.toThrow("unknown outcome");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
	});

	test("blocks other delegations and reset while the executor is active", async () => {
		const tools = new Map<string, Tool>();
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => { finish = resolve; });
		await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => { await pending; return { output: { sessionID: "child-1", status: "completed", output: "done" } }; } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} });
		const delegate = tools.get("fusion_delegate")!;
		const first = delegate.execute({ action: "execute", brief: "build" }, context("one"));
		await expect(delegate.execute({ action: "execute", brief: "again" }, context("one"))).rejects.toThrow("already in progress");
		await expect(delegate.execute({ action: "execute", brief: "other" }, context("two"))).rejects.toThrow("owns this workspace");
		await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("active");
		finish();
		await first;
	});
});

test("restoration rejects a child owned by a different supervisor", async () => {
	const storage = memoryStorage();
	const first = new Map<string, Tool>();
	const base: TestContext = { location: { directory: "/workspace" }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
		transform: async (callback) => { callback({ add: (tool) => first.set(tool.name, tool) }); },
	} };
	await setupTest(base, storage);
	await first.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
	const wrong = { ...base, session: { ...base.session, get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: "other", location: { directory: "/workspace" } }) } };
	await expect(setupTest(wrong, storage)).rejects.toThrow("ownership or workspace");
});

test("a rejected concurrent delegation cannot replace the active native tool context", async () => {
	const tools = new Map<string, Tool>();
	const backing = memoryStorage();
	let release!: () => void, seen!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const ready = new Promise<void>((resolve) => { seen = resolve; });
	let held = true, nativeContext: Context | undefined;
	const storage = { ...backing, set: async (key: string, value: unknown) => { if (held) { held = false; seen(); await gate; } await backing.set(key, value); } };
	await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { nativeContext = ctx; return { output: { sessionID: "child", status: "completed", output: "done" } }; } }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} }, storage);
	const firstContext = { ...context("one"), marker: "first" }; const secondContext = { ...context("one"), marker: "second" };
	const first = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, firstContext);
	await ready;
	await expect(tools.get("fusion_delegate")!.execute({ action: "revise", brief: "other" }, secondContext)).rejects.toThrow("already in progress");
	release(); await first;
	expect((nativeContext as (Context & { marker: string }) | undefined)?.marker).toBe("first");
});

test("a foreground result can be settled after a failed write without another native call", async () => {
	const tools = new Map<string, Tool>();
	const backing = memoryStorage();
	let fail = true, calls = 0;
	const storage = { ...backing, set: async (key: string, value: unknown) => {
		if (fail && !(value as { pending?: unknown }).pending) { fail = false; throw new Error("settlement write failed"); }
		await backing.set(key, value);
	} };
	await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { calls++; return { output: { sessionID: "child", status: "completed", output: "report" } }; } }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} }, storage);
	await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("settlement write failed");
	await expect(tools.get("fusion_reset")!.execute({}, context("one"))).rejects.toThrow("uncertain");
	expect((await tools.get("fusion_reconcile")!.execute({}, context("one"))).content).toContain("report");
	expect(calls).toBe(1);
	await tools.get("fusion_reset")!.execute({}, context("one"));
});

test("an archived settled request does not resurrect stale native intent on reload", async () => {
	const backing = memoryStorage();
	let key = "", stale: unknown;
	const storage = { ...backing, set: async (k: string, value: unknown) => {
		key = k;
		const record = value as { pending?: unknown; worker?: unknown };
		if (record.pending && record.worker) stale = structuredClone(value);
		await backing.set(k, value);
	} };
	const createContext = (tools: Map<string, Tool>): TestContext => ({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { await ctx.progress({ sessionID: "child" }); return { output: { sessionID: "child", status: "completed", output: "done" } }; } }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} });
	const first = new Map<string, Tool>(); await setupTest(createContext(first), storage);
	await first.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"));
	await first.get("fusion_reset")!.execute({}, context("one"));
	expect(stale).toBeDefined(); await backing.set(key, stale);
	const restarted = new Map<string, Tool>(); await setupTest(createContext(restarted), storage);
	expect((await restarted.get("fusion_status")!.execute({}, context("one"))).content).toContain("No Fusion run");
});

test("shared terminal proof recovers after native storage fails across restart", async () => {
	const backing = memoryStorage(); let fail = false, calls = 0;
	const storage = { ...backing, set: async (key: string, value: unknown) => { if (fail) throw new Error("storage offline"); await backing.set(key, value); } };
	const makeContext = (tools: Map<string, Tool>): TestContext => ({ location: { directory: tmpdir() }, session: { context: async () => { throw new Error("notifications unavailable"); }, hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async (_input, ctx) => { calls++; await ctx.progress({ sessionID: "child" }); fail = true; return { output: { sessionID: "child", status: "completed", output: "persisted report" } }; } }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} });
	const first = new Map<string, Tool>(); await setupTest(makeContext(first), storage);
	await expect(first.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"))).rejects.toThrow("storage offline");
	fail = false;
	const restored = new Map<string, Tool>(); await setupTest(makeContext(restored), storage);
	expect((await restored.get("fusion_reconcile")!.execute({}, context("one"))).content).toContain("persisted report");
	expect(calls).toBe(1);
	await restored.get("fusion_reset")!.execute({}, context("one"));
});

test("OpenCode v1 recovery is read-only until a write and preserves legacy metadata", async () => {
	const tools = new Map<string, Tool>(); const backing = memoryStorage();
	const workspace = tmpdir(); const key = `run/${createHash("sha256").update(workspace).digest("hex")}`;
	const legacy = { version: 1, harness: "opencode", workspace, parentSessionID: "one", childSessionID: "child", extra: "preserve me", state: { runActive: true, phase: "reviewing", task: "task", originalTask: "original", executorBrief: "brief", delegating: false, executed: true, revisions: 0, finalFixUsed: false, resumePending: false, scoutCalls: 0, settleNudges: 0 } };
	await backing.set(key, legacy); let writes = 0;
	const storage = { ...backing, set: async (k: string, value: unknown) => { writes++; await backing.set(k, value); } };
	await setupTest({ location: { directory: workspace }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "child", status: "completed", output: "done" } }) }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} }, storage);
	expect(writes).toBe(0); expect(await backing.get(key)).toEqual(legacy);
	await tools.get("fusion_delegate")!.execute({ action: "revise", brief: "feedback" }, context("one"));
	const migrated = await backing.get(key) as { version: number; adapterData: { legacyOpenCode: unknown } };
	expect(migrated.version).toBe(2); expect(migrated.adapterData.legacyOpenCode).toEqual(legacy);
	await tools.get("fusion_reset")!.execute({}, context("one"));
});

test("reconciliation preserves retained evidence across reload", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-evidence-reload-"));
	let host: { close(): void } | undefined;
	try {
		const init = await nodeGitExec(["init", "-q"], { cwd: root, timeout: 5000 });
		expect(init.code).toBe(0);
		await nodeGitExec(["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid", "-c", "commit.gpgsign=false", `commit`, "--allow-empty", "-qm", "fixture"], { cwd: root, timeout: 5000 });
		const storage = memoryStorage();
		let fail = true, calls = 0;
		const faulty = { ...storage, set: async (key: string, value: unknown) => {
			if (fail && (value as { recovery?: string }).recovery === "settled") { fail = false; throw new Error("settlement write failed"); }
			await storage.set(key, value);
		} };
		const tools = new Map<string, Tool>();
		const build = async () => {
			await setupTest({ location: { directory: root }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
				list: async () => [{ id: "subagent", execute: async (_input, ctx) => {
					calls++;
					await ctx.progress({ sessionID: "child-1" });
					await writeFile(join(root, "worker-new.txt"), "evidence\n");
					return { output: { sessionID: "child-1", status: "completed", output: "report" } };
				} }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} }, faulty);
			return tools;
		};
		const first = await build();
		await expect(first.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, context("one"))).rejects.toThrow("settlement write failed");
		const hash = createHash("sha256").update(root).digest("hex");
		const firstManifest = readRunManifest(await faulty.get(`run/${hash}`), { harness: "opencode", workspace: root });
		expect(firstManifest.recovery).toBe("pending");
		expect(firstManifest.lastResult?.evidence).toEqual(["new:worker-new.txt"]);
		// Reload from the retained record, then reconcile without a native call.
		host?.close();
		host = await setupTest({ location: { directory: root }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
			list: async () => [{ id: "subagent", execute: async () => { calls++; throw new Error("native must not be called after reload"); } }],
			transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
		} }, storage);
		const status = JSON.parse((await tools.get("fusion_status")!.execute({}, context("one"))).content);
		expect(status.uncertain).toBe(true);
		expect(status.childSessionID).toBe("child-1");
		const reconciled = await tools.get("fusion_reconcile")!.execute({}, context("one"));
		expect(reconciled.content).toContain("reconciled background turn");
		const manifest = readRunManifest(await storage.get(`run/${hash}`), { harness: "opencode", workspace: root });
		expect(manifest.recovery).toBe("settled");
		expect(manifest.lastResult?.evidence).toEqual(["new:worker-new.txt"]);
		expect(calls).toBe(1);
		await tools.get("fusion_reset")!.execute({}, context("one"));
	} finally { host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("shared settlement failure preserves the exact result and blocks another submission", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-shared-fault-"));
	let host: { close(): void } | undefined;
	try {
		const workspace = tmpdir(); const tools = new Map<string, Tool>(); const storage = memoryStorage();
		const registry = await openWorkspaceRegistry(root); let fail = true, calls = 0;
		const openRegistry: typeof openWorkspaceRegistry = async () => ({ ...registry, claim: async (...args) => {
			const lease = await registry.claim(...args);
			return { get token() { return lease.token; }, get manifest() { return lease.manifest; }, close: () => lease.close(), release: () => lease.release(),
				save: async (value) => { if (fail && value.recovery === "settled") throw new Error("shared settlement unavailable"); await lease.save(value); } };
		} });
		host = await plugin.setup({ location: { directory: workspace }, storage, session: { context: async () => [], get: async ({ sessionID }) => ({ id: sessionID, parentID: "one", location: { directory: workspace } }), hook: async () => {} }, tool: {
				hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { calls++; return { output: { sessionID: "child", status: "completed", output: "report" } }; } }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} }, { ownershipRoot: root, canonicalize: async (path) => path, openRegistry });
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "work" }, context("one"))).rejects.toThrow("shared settlement unavailable");
		const saved = (await registry.inspect(workspace))!.manifest;
		expect(saved.recovery).toBe("pending"); expect(saved.pending?.requestId).toBe(saved.lastResult?.requestId);
		await expect(tools.get("fusion_delegate")!.execute({ action: "execute", brief: "retry" }, context("one"))).rejects.toThrow("unknown outcome");
		fail = false;
		expect((await tools.get("fusion_reconcile")!.execute({}, context("one"))).content).toContain("report");
		expect(calls).toBe(1);
		await tools.get("fusion_reset")!.execute({}, context("one"));
	} finally { host?.close(); await rm(root, { recursive: true, force: true }); }
});

test("scout guard capacity refuses new children without resetting live caps", async () => {
	const tools = new Map<string, Tool>();
	let before!: (event: { agent: string; tool: string; sessionID: string }) => void;
	await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async (_name, callback) => { before = callback; },
		list: async () => [{ id: "subagent", execute: async () => ({ output: { sessionID: "scout-bg", status: "running", output: "" } }) }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} });
	await tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("one"));
	const read = (sessionID: string) => before({ agent: "fusion-scout", tool: "read", sessionID });
	for (let i = 0; i < 20; i++) read("scout-bg");
	expect(() => read("scout-bg")).toThrow("Tool call limit reached");
	for (let i = 0; i < 7; i++) read(`other-${i}`);
	for (let i = 7; i < 10; i++) expect(() => read(`other-${i}`)).toThrow("tracking is full");
	expect(() => read("scout-bg")).toThrow("Tool call limit reached");
	await expect(tools.get("fusion_scout")!.execute({ questions: ["q"] }, context("two"))).rejects.toThrow("tracking is full");
});

test("concurrent scouting preserves the pending executor's native call context", async () => {
	const tools = new Map<string, Tool>();
	let resume!: () => void, entered!: () => void;
	const gate = new Promise<void>((resolve) => { resume = resolve; });
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const storage = memoryStorage();
	let block = true;
	const faulty = { ...storage, set: async (key: string, value: unknown) => {
		if (block && (value as { pending?: unknown }).pending) { block = false; entered(); await gate; }
		await storage.set(key, value);
	} };
	const nativeCalls: { agent: string; callID: string }[] = [];
	await setupTest({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: {
		hook: async () => {}, list: async () => [{ id: "subagent", execute: async (input, ctx) => {
			nativeCalls.push({ agent: input.agent, callID: (ctx as Context & { id: string }).id });
			return { output: { sessionID: input.agent === "fusion-scout" ? "scout-child" : "child", status: "completed", output: "done" } };
		} }], transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	} }, faulty);
	const executorContext = { ...context("one"), id: "executor-call" };
	const scoutContext = { ...context("one"), id: "scout-call" };
	const pending = tools.get("fusion_delegate")!.execute({ action: "execute", brief: "build" }, executorContext);
	try {
		await ready;
		await tools.get("fusion_scout")!.execute({ questions: ["q"] }, scoutContext);
	} finally { resume(); }
	await pending;
	expect(nativeCalls).toEqual([
		{ agent: "fusion-scout", callID: "scout-call" },
		{ agent: "fusion-executor", callID: "executor-call" },
	]);
	await tools.get("fusion_reset")!.execute({}, context("one"));
});
