import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import plugin from "../src/opencode/index.ts";
import { nodeGitExec } from "../src/workspace/node-git.ts";
import { openWorkspaceRegistry } from "../src/workspace/ownership.ts";

type Context = { sessionID: string; agent: string; signal: AbortSignal; progress: (update: Record<string, unknown>) => Promise<void> };
type Tool = { name: string; execute: (input: unknown, context: Context) => Promise<{ content: string }> };
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
