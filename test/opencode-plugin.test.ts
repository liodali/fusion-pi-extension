import { describe, expect, test } from "bun:test";
import plugin from "../src/opencode/index.ts";

type Context = { sessionID: string; agent: string; signal: AbortSignal; progress: (update: Record<string, unknown>) => Promise<void> };
type Tool = { name: string; execute: (input: unknown, context: Context) => Promise<{ content: string }> };
const context = (sessionID: string, agent = "fusion"): Context => ({ sessionID, agent, signal: new AbortController().signal, progress: async () => {} });

describe("OpenCode Fusion plugin", () => {
	test("registers tools and continues the same child through guarded turns", async () => {
		const tools = new Map<string, Tool>();
		const calls: Record<string, unknown>[] = [];
		await plugin.setup({ tool: {
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
		await plugin.setup({ tool: {
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
		await plugin.setup({ tool: {
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
		await plugin.setup({ tool: {
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
