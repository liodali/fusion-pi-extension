import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import plugin from "../src/opencode/index.ts";
import { nodeGitExec } from "../src/workspace/node-git.ts";

type Context = { sessionID: string; agent: string; signal: AbortSignal; progress: (update: Record<string, unknown>) => Promise<void> };
type Tool = { name: string; execute: (input: unknown, context: Context) => Promise<{ content: string }> };
const context = (sessionID: string, agent = "fusion"): Context => ({ sessionID, agent, signal: new AbortController().signal, progress: async () => {} });

describe("OpenCode Fusion plugin", () => {
	test("blocks direct subagent calls only for the Fusion supervisor", async () => {
		const tools = new Map<string, Tool>();
		let before!: (event: { tool: string; agent: string }) => void;
		let contextHook!: (event: { agent: string; tools: Record<string, unknown> }) => void;
		await plugin.setup({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async (_name, callback) => { contextHook = callback; } }, tool: {
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

	test("reconciles only a matching native background completion and retains the child", async () => {
		const tools = new Map<string, Tool>();
		const calls: Record<string, unknown>[] = [];
		let messages: unknown[] = [];
		await plugin.setup({ location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
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
		await plugin.setup({ location: { directory: tmpdir() }, session: { context: async () => messages, hook: async () => {} }, tool: {
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
		try {
			const init = await nodeGitExec(["init", "-q"], { cwd: root, timeout: 5000 });
			expect(init.code).toBe(0);
			const tools = new Map<string, Tool>();
			await plugin.setup({ location: { directory: root }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
				list: async () => [{ id: "subagent", execute: async () => {
					await writeFile(join(root, "fixture.txt"), "changed\n");
					return { output: { sessionID: "child-1", status: "completed", output: '```json\n{"status":"done","summary":"ok","checks":[{"command":"check","result":"pass"}],"files_changed":[],"blockers":[]}\n```' } };
				} }],
				transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
			} });
			const result = await tools.get("fusion_delegate")!.execute({ action: "execute", brief: "create fixture" }, context("one"));
			expect(result.content).toContain("new: fixture.txt");
			expect(result.content).toContain("Review: full");
			expect(result.content).toContain("executor tool activity unavailable");
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("registers tools and continues the same child through guarded turns", async () => {
		const tools = new Map<string, Tool>();
		const calls: Record<string, unknown>[] = [];
		await plugin.setup({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
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
		await plugin.setup({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
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
		await plugin.setup({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
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
		await plugin.setup({ location: { directory: tmpdir() }, session: { context: async () => [], hook: async () => {} }, tool: { hook: async () => {},
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
