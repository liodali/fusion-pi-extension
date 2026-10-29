// Runs in a separate Bun process so SDK mocks cannot affect other tests.
import { expect, mock, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.FUSION_PI_TEST_DIR;
setDefaultTimeout(20000);
if (!root) throw new Error("Missing isolated Pi test directory");
let failThinking = false;
let failPrompt = false;
let prompts = 0;
let promptGate;
let promptEntered;
let disposals = 0;
let durableEnabled = false;
let durableResumes = [];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const capabilities = { transcriptReopen: true, activeTurnReattach: false, durableExecution: false, idempotentSubmission: false, readOnlyScout: true, exactScoutToolLimit: false };
const handle = {
	resumeRef: () => join(root, "session.jsonl"),
	setThinking: async () => { if (failThinking) throw new Error("thinking failed"); },
	prompt: async () => { prompts++; promptEntered?.(); if (promptGate) await promptGate; if (failPrompt) throw new Error("connection lost"); return { text: '```json\n{"status":"done","summary":"ok"}\n```', usage }; },
	resume: async () => { throw new Error("not supported"); }, abort: async () => {}, dispose: () => { disposals++; },
};
mock.module("../../src/pi/executor-backend.ts", () => ({
	createSessionExecutorBackend: () => ({ kind: "session", capabilities,
		createExecutor: async () => handle, dispose: async () => {} }),
}));
mock.module("../../src/pi/durable/backend.ts", () => ({ createDurableExecutorBackend: async () => {
	if (!durableEnabled) throw new Error("unavailable");
	return { kind: "durable", capabilities: { ...capabilities, activeTurnReattach: true, durableExecution: true, exactScoutToolLimit: true },
		openExecutor: async () => ({ ...handle, resumeRef: () => "42", resume: async (options) => { durableResumes.push(options.requestId); return { text: "recovered", usage }; } }),
		dispose: async () => {} };
} }));

const { default: registerFusion } = await import("../../src/index.ts");
const { writeRun, readRun, runsDir } = await import("../../src/runs.ts");

test("Pi keeps pre-submission revisions retryable and blocks an uncertain final fix", async () => {
	process.env.FUSION_OWNERSHIP_DIR = join(root, "ownership-initial");
	const tools = new Map();
	const commands = new Map();
	const hooks = new Map();
	const notifications = [];
	let active = [];
	const pi = { registerTool: (tool) => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
		on: (name, callback) => hooks.set(name, callback), getActiveTools: () => active, setActiveTools: (value) => { active = value; },
		setModel: async () => true, setThinkingLevel: () => {}, sendUserMessage: () => {},
		exec: async () => ({ code: 1, stdout: "" }) };
	const models = [
		{ provider: "fake", id: "gpt-6", name: "GPT 6", reasoning: false, cost: { output: 20 } },
		{ provider: "fake", id: "glm-5", name: "GLM 5", reasoning: false, cost: { output: 1 } },
	];
	const ctx = { cwd: root, sessionManager: { getSessionId: () => "supervisor" }, hasUI: true, mode: "rpc", scopedModels: [], modelRegistry: { getAvailable: () => models },
		waitForIdle: async () => {}, ui: { notify: (message) => notifications.push(message), input: async () => "",
			select: async (_title, options) => options[0], setWidget: () => {} } };
	registerFusion(pi);
	await commands.get("fusion").handler("original task", ctx);
	const delegate = (action, brief) => tools.get("fusion_delegate").execute("call", { action, brief }, undefined, undefined, ctx);
	expect((await delegate("execute", "build")).details.error).toBeUndefined();
	failThinking = true;
	const failedBefore = await delegate("revise", "fix");
	expect(failedBefore.details.error).toContain("thinking failed");
	expect(failedBefore.details.revisions).toBe(0);
	failThinking = false;
	expect((await delegate("revise", "fix")).details.error).toBeUndefined();
	expect(prompts).toBe(2);
	failPrompt = true;
	expect((await delegate("final_fix", "audit")).details.error).toContain("connection lost");
	expect((await delegate("revise", "retry")).content[0].text).toContain("unknown outcome");
	await commands.get("fusion-clean").handler("", ctx);
	expect(notifications.at(-1)).toContain("uncertain");
	const files = await readdir(join(root, "fusion", "runs"));
	const run = JSON.parse(await readFile(join(root, "fusion", "runs", files[0]), "utf8"));
	expect(run.status).toBe("interrupted");
	expect(run.revisions).toBe(1);
	expect(run.finalFixUsed).toBe(true);
	expect(prompts).toBe(3);
});

function makePi(cwd, supervisorId = "supervisor") {
	process.env.FUSION_OWNERSHIP_DIR = join(cwd, ".test-state");
	const tools = new Map(), commands = new Map(), hooks = new Map(), notifications = [];
	let active = [], confirmed = false;
	const pi = { registerTool: (tool) => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
		on: (name, callback) => hooks.set(name, callback), getActiveTools: () => active, setActiveTools: (value) => { active = value; },
		setModel: async () => true, setThinkingLevel: () => {}, sendUserMessage: () => {}, exec: async () => ({ code: 1, stdout: "" }) };
	const model = { provider: "fake", id: "glm-5", name: "GLM 5", reasoning: false, cost: { output: 1 } };
	const supervisor = { provider: "fake", id: "gpt-6", name: "GPT 6", reasoning: false, cost: { output: 20 } };
	const ctx = { cwd, sessionManager: { getSessionId: () => supervisorId }, hasUI: true, mode: "rpc", scopedModels: [], modelRegistry: { find: () => model, getAvailable: () => [supervisor, model] },
		waitForIdle: async () => {}, ui: { notify: (message) => notifications.push(message), input: async () => "",
			select: async (_title, options) => options[0], confirm: async () => confirmed, setWidget: () => {} } };
	registerFusion(pi);
	return { tools, commands, hooks, notifications, ctx, confirm: (value) => { confirmed = value; } };
}

async function interruptedRun(id, pending) {
	const cwd = join(root, id);
	await mkdir(cwd, { recursive: true });
	const run = { runId: id, cwd, task: "original", originalTask: "original", brief: "brief", backend: "durable", conversationId: 42,
		executor: { provider: "fake", modelId: "glm-5", label: "fake/glm-5", thinking: "off" },
		status: "interrupted", revisions: 0, results: {}, updatedAt: new Date().toISOString(), ...(pending ? { pending } : {}) };
	await writeRun(runsDir(root), run);
	return run;
}

test("Pi mode changes do not dispose an active executor", async () => {
	failPrompt = false;
	const cwd = join(root, "active-mode-workspace");
	await mkdir(cwd, { recursive: true });
	const f = makePi(cwd);
	await f.commands.get("fusion-mode").handler("", f.ctx);
	expect(f.notifications.at(-1)).toContain("mode enabled");
	let release;
	promptGate = new Promise((resolve) => { release = resolve; });
	const entered = new Promise((resolve) => { promptEntered = resolve; });
	try {
		const running = f.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "work" }, undefined, undefined, f.ctx);
		await entered;
		const before = disposals;
		await f.commands.get("fusion-mode").handler("", f.ctx);
		expect(f.notifications.at(-1)).toContain("active or uncertain");
		expect(disposals).toBe(before);
		await f.commands.get("fusion-status").handler("", f.ctx);
		expect(f.notifications.at(-1)).toContain("mode enabled");
		release();
		expect((await running).details.error).toBeUndefined();
		await f.commands.get("fusion-mode").handler("", f.ctx);
		expect(f.notifications.at(-1)).toContain("mode disabled");
		expect(disposals).toBeGreaterThan(before);
	} finally { release(); promptGate = undefined; promptEntered = undefined; }
});

test("Pi blocks delegation during mode setup and releases the guard on cancellation", async () => {
	const cwd = join(root, "mode-setup-workspace");
	await mkdir(cwd, { recursive: true });
	const f = makePi(cwd);
	let release;
	let entered;
	const gate = new Promise((resolve) => { release = resolve; });
	const waiting = new Promise((resolve) => { entered = resolve; });
	f.ctx.ui.input = async () => { entered(); await gate; return undefined; };
	const enabling = f.commands.get("fusion-mode").handler("", f.ctx);
	await waiting;
	const before = prompts;
	const result = await f.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "work" }, undefined, undefined, f.ctx);
	expect(result.content[0].text).toContain("mode change is in progress");
	expect(prompts).toBe(before);
	release();
	await enabling;
	expect(f.notifications.at(-1)).toContain("mode not enabled");
	f.ctx.ui.input = async () => "";
	await f.commands.get("fusion-mode").handler("", f.ctx);
	expect(f.notifications.at(-1)).toContain("mode enabled");
});

test("an aborted Durable resume retains the original request and can retry reattachment", async () => {
	durableEnabled = true; durableResumes = [];
	const run = await interruptedRun("aborted-resume", { action: "execute", requestId: "original-request" });
	const f = makePi(run.cwd);
	f.confirm(true);
	await f.commands.get("fusion-resume").handler("", f.ctx);
	const delegate = (signal) => f.tools.get("fusion_delegate").execute("call", { action: "resume", brief: "resume" }, signal, undefined, f.ctx);
	const aborted = await delegate(AbortSignal.abort());
	expect(aborted.details.error).toContain("aborted");
	expect(durableResumes).toEqual([]);
	const saved = await readRun(runsDir(root), run.runId);
	expect(saved.status).toBe("interrupted");
	expect(saved.pending.requestId).toBe("original-request");
	const blocked = await f.tools.get("fusion_delegate").execute("call", { action: "revise", brief: "retry" }, undefined, undefined, f.ctx);
	expect(blocked.content[0].text).toContain("unknown outcome");
	expect((await delegate(undefined)).details.error).toBeUndefined();
	expect(durableResumes).toEqual(["original-request"]);
	expect((await readRun(runsDir(root), run.runId)).pending).toBeUndefined();
});

test("startup blocks an interrupted legacy run until explicit manual resolution", async () => {
	const run = await interruptedRun("legacy-restart");
	const f = makePi(run.cwd);
	f.hooks.get("session_start")({}, f.ctx);
	for (let i = 0; i < 100 && !f.notifications.some((message) => message.includes("Interrupted Fusion run found")); i++) await Bun.sleep(10);
	expect(f.notifications.some((message) => message.includes("Interrupted Fusion run found"))).toBe(true);
	const result = await f.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "new work" }, undefined, undefined, f.ctx);
	expect(result.content[0].text).toContain("requires recovery");
	await f.commands.get("fusion-resume").handler("", f.ctx);
	expect(f.notifications.at(-1)).toContain("no valid original request ID");
	await f.commands.get("fusion-resolve").handler("", f.ctx);
	expect((await readRun(runsDir(root), run.runId)).status).toBe("interrupted");
	f.confirm(true);
	await f.commands.get("fusion-resolve").handler("", f.ctx);
	const resolved = await readRun(runsDir(root), run.runId);
	expect(resolved.status).toBe("failed");
	expect(resolved.manualResolution.at).toBeString();
	expect(resolved.task).toBe("original");
	failPrompt = false;
	const previousPrompts = prompts;
	await f.commands.get("fusion").handler("new task", f.ctx);
	const next = await f.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "new work" }, undefined, undefined, f.ctx);
	expect(next.details.error).toBeUndefined();
	expect(prompts).toBe(previousPrompts + 1);
});

test("Pi does not invoke its worker if the write-ahead record cannot be saved", async () => {
	const path = join(root, "not-a-directory");
	await writeFile(path, "file");
	const cwd = join(root, "failed-write-workspace");
	await mkdir(cwd, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path;
	try {
		const before = prompts;
		const f = makePi(cwd);
		await f.commands.get("fusion").handler("task", f.ctx);
		const result = await f.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "work" }, undefined, undefined, f.ctx);
		expect(result.details.error).toBeDefined();
		expect(prompts).toBe(before);
		await f.commands.get("fusion-clean").handler("", f.ctx);
		expect(f.notifications.at(-1)).toContain("uncertain");
	} finally { process.env.PI_CODING_AGENT_DIR = previous; }
});

test("Pi recovers shared pending intent when its legacy run file is missing", async () => {
	const cwd = join(root, "missing-native-record");
	await mkdir(cwd, { recursive: true });
	const first = makePi(cwd);
	await first.commands.get("fusion").handler("original task", first.ctx);
	failPrompt = true;
	const failed = await first.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "build" }, undefined, undefined, first.ctx);
	failPrompt = false;
	expect(failed.details.error).toContain("connection lost");
	const dir = runsDir(root);
	let saved;
	for (const file of await readdir(dir)) {
		const value = JSON.parse(await readFile(join(dir, file), "utf8"));
		if (value.cwd === cwd) { saved = value; await rm(join(dir, file)); break; }
	}
	expect(saved?.pending?.requestId).toBeString();
	await first.hooks.get("session_shutdown")();
	const resumed = makePi(cwd);
	await resumed.commands.get("fusion-resume").handler("", resumed.ctx);
	expect(resumed.notifications.at(-1)).toContain("session backend cannot reattach");
	resumed.confirm(true);
	await resumed.commands.get("fusion-resolve").handler("", resumed.ctx);
	const resolved = await readRun(dir, saved.runId);
	expect(resolved.status).toBe("failed");
	expect(resolved.manualResolution.at).toBeString();
	expect(resolved.pending.requestId).toBe(saved.pending.requestId);
});

test("Pi and OpenCode entrypoints exclude each other in the same workspace", async () => {
	const cwd = join(root, "cross-harness");
	await mkdir(cwd, { recursive: true });
	const piRun = makePi(cwd);
	await piRun.commands.get("fusion").handler("task", piRun.ctx);
	expect((await piRun.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "build" }, undefined, undefined, piRun.ctx)).details.error).toBeUndefined();
	const { default: opencode } = await import("../../src/opencode/index.ts");
	const tools = new Map(); const values = new Map(); let nativeCalls = 0;
	const plugin = await opencode.setup({ location: { directory: cwd },
		storage: { get: async (key) => values.get(key), set: async (key, value) => values.set(key, value), remove: async (key) => values.delete(key) },
		session: { context: async () => [], get: async () => ({}), hook: async () => {} },
		tool: { hook: async () => {}, list: async () => [{ id: "subagent", execute: async () => { nativeCalls++; return { output: { sessionID: "child", status: "completed", output: "done" } }; } }], transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
	});
	const context = { sessionID: "parent", agent: "fusion", signal: new AbortController().signal, progress: async () => {} };
	await expect(tools.get("fusion_delegate").execute({ action: "execute", brief: "other" }, context)).rejects.toThrow("coordinating");
	expect(nativeCalls).toBe(0);
	await piRun.commands.get("fusion-clean").handler("", piRun.ctx);
	await tools.get("fusion_delegate").execute({ action: "execute", brief: "other" }, context);
	expect(nativeCalls).toBe(1);
	await tools.get("fusion_reset").execute({}, context);
	plugin.close();
});

test("Pi discovery never rewrites a possibly live legacy run and recovery requires a decision", async () => {
	const run = await interruptedRun("legacy-live-discovery", { action: "execute", requestId: "legacy-request" });
	run.status = "running";
	await writeRun(runsDir(root), run);
	const path = join(runsDir(root), `${run.runId}.json`);
	const before = await readFile(path, "utf8");
	const f = makePi(run.cwd);
	await f.hooks.get("session_start")({}, f.ctx);
	for (let i = 0; i < 100 && !f.notifications.some((message) => message.includes("Interrupted Fusion run found")); i++) await Bun.sleep(10);
	expect(await readFile(path, "utf8")).toBe(before);
	await f.commands.get("fusion-resume").handler("", f.ctx);
	expect(f.notifications.at(-1)).toContain("Legacy recovery requires confirming");
	expect(await readFile(path, "utf8")).toBe(before);
});

test("an operator can resolve legacy Durable work when its backend is unavailable", async () => {
	durableEnabled = false;
	const run = await interruptedRun("unavailable-durable-resolution", { action: "execute", requestId: "original" });
	const f = makePi(run.cwd);
	f.confirm(true);
	await f.commands.get("fusion-resolve").handler("", f.ctx);
	const resolved = await readRun(runsDir(root), run.runId);
	expect(resolved.status).toBe("failed");
	expect(resolved.manualResolution.at).toBeString();
	expect(resolved.pending.requestId).toBe("original");
});

test("a settlement storage failure retains the pending request and blocks cleanup", async () => {
	const readDir = join(root, "fusion", "runs");
	const byCwd = async (want) => {
		for (const file of await readdir(readDir)) {
			if (file.endsWith(".tmp")) continue;
			const value = JSON.parse(await readFile(join(readDir, file), "utf8"));
			if (value.cwd === want) return value;
		}
		return undefined;
	};
	const cwd = join(root, "settled-write-failure");
	await mkdir(cwd, { recursive: true });
	const f = makePi(cwd);
	await f.commands.get("fusion").handler("original task", f.ctx);
	expect((await f.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "build" }, undefined, undefined, f.ctx)).details.error).toBeUndefined();
	const before = prompts;
	// The legacy boundary refuses further writes while the shared registry
	// keeps working: the write-ahead intent must still be recorded first.
	await chmod(readDir, 0o555);
	try {
		const failed = await f.tools.get("fusion_delegate").execute("call", { action: "revise", brief: "mend" }, undefined, undefined, f.ctx);
		expect(failed.details.error).toBeDefined();
		expect(prompts).toBe(before);
		await f.commands.get("fusion-clean").handler("", f.ctx);
		expect(f.notifications.at(-1)).toContain("uncertain");
		const saved = await byCwd(cwd);
		expect(saved.status).toBe("done");
		await chmod(readDir, 0o755);
		await f.hooks.get("session_shutdown")();
		const resumed = makePi(cwd);
		await resumed.commands.get("fusion-resume").handler("", resumed.ctx);
		expect(resumed.notifications.at(-1)).toContain("session backend cannot reattach");
		resumed.confirm(true);
		await resumed.commands.get("fusion-resolve").handler("", resumed.ctx);
		const resolved = await byCwd(cwd);
		expect(resolved.status).toBe("failed");
		expect(resolved.manualResolution?.at ?? resolved.manualResolution.at).toBeString();
		expect(resolved.pending?.requestId).toBeString();
		expect(resolved.pending?.action).toBe("revise");
		await resumed.commands.get("fusion-clean").handler("", resumed.ctx);
		expect(resumed.notifications.at(-1)).not.toContain("uncertain");
	} finally { await chmod(readDir, 0o755).catch(() => {}); }
});

test("a completed run's settled ownership is releasable after restart", async () => {
	const cwd = join(root, "settled-ownership-restart");
	await mkdir(cwd, { recursive: true });
	const first = makePi(cwd);
	await first.commands.get("fusion").handler("original task", first.ctx);
	expect((await first.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "build" }, undefined, undefined, first.ctx)).details.error).toBeUndefined();
	// Skip cleanup: shutdown leaves the settled ownership record behind.
	await first.hooks.get("session_shutdown")();
	const resumed = makePi(cwd);
	await resumed.hooks.get("session_start")({}, resumed.ctx);
	await resumed.commands.get("fusion-clean").handler("", resumed.ctx);
	expect(resumed.notifications.at(-1)).toContain("cleared");
	// Ownership was actually released: a fresh run can claim the workspace.
	const second = makePi(cwd);
	await second.hooks.get("session_start")({}, second.ctx);
	await second.commands.get("fusion").handler("second task", second.ctx);
	expect((await second.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "work" }, undefined, undefined, second.ctx)).details.error).toBeUndefined();
	await second.commands.get("fusion-clean").handler("", second.ctx);
});

test("a fresh session releases a prior run's settled ownership by explicit cleanup", async () => {
	const cwd = join(root, "settled-ownership-fresh-session");
	await mkdir(cwd, { recursive: true });
	const first = makePi(cwd);
	await first.commands.get("fusion").handler("original task", first.ctx);
	expect((await first.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "build" }, undefined, undefined, first.ctx)).details.error).toBeUndefined();
	await first.hooks.get("session_shutdown")();
	// A fresh session ID cannot adopt the prior owner, and startup does not:
	// guarded cleanup after confirming the record is settled does the release.
	const resumed = makePi(cwd, "fresh-session");
	await resumed.hooks.get("session_start")({}, resumed.ctx);
	await resumed.commands.get("fusion-clean").handler("", resumed.ctx);
	expect(resumed.notifications.at(-1)).toContain("cleared");
	const next = makePi(cwd, "next-session");
	await next.hooks.get("session_start")({}, next.ctx);
	await next.commands.get("fusion").handler("second task", next.ctx);
	expect((await next.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "work" }, undefined, undefined, next.ctx)).details.error).toBeUndefined();
	await next.commands.get("fusion-clean").handler("", next.ctx);
});

test("failed cleanup retains the coordinator for retry instead of leaking it", async () => {
	const cwd = join(root, "settled-ownership-release-fault");
	await mkdir(cwd, { recursive: true });
	const first = makePi(cwd);
	await first.commands.get("fusion").handler("original task", first.ctx);
	expect((await first.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "build" }, undefined, undefined, first.ctx)).details.error).toBeUndefined();
	await first.hooks.get("session_shutdown")();
	// Sabotage the archive write inside the shared registry itself.
	const { DatabaseSync } = await import("node:sqlite");
	const sabotage = new DatabaseSync(join(cwd, ".test-state", "owners.sqlite"));
	sabotage.exec("CREATE TRIGGER fusion_probe_archive_denied BEFORE INSERT ON archive BEGIN SELECT RAISE(ABORT, 'archive probe denial'); END;");
	sabotage.close();
	const resumed = makePi(cwd, "fresh-session");
	await resumed.hooks.get("session_start")({}, resumed.ctx);
	await resumed.commands.get("fusion-clean").handler("", resumed.ctx);
	expect(resumed.notifications.at(-1)).toContain("Cannot clean Fusion");
	// Remove the fault: the retained coordinator must retry, not re-claim
	// against its own leaked gate.
	const edit = new DatabaseSync(join(cwd, ".test-state", "owners.sqlite"));
	edit.exec("DROP TRIGGER fusion_probe_archive_denied");
	edit.close();
	await resumed.commands.get("fusion-clean").handler("", resumed.ctx);
	expect(resumed.notifications.at(-1)).toContain("cleared");
	const check = new DatabaseSync(join(cwd, ".test-state", "owners.sqlite"));
	const rows = check.prepare("SELECT COUNT(*) AS n FROM owner").get();
	check.close();
	expect(rows.n).toBe(0);
});

test("a workspace cannot claim ownership when its registry directory is unusable", async () => {
	const cwd = join(root, "registry-conflict-workspace");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, ".test-state"), "not a directory");
	const before = prompts;
	const f = makePi(cwd);
	await expect(f.commands.get("fusion").handler("original task", f.ctx)).rejects.toThrow(/ownership registry is unavailable/);
	await expect(f.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "work" }, undefined, undefined, f.ctx)).rejects.toThrow(/ownership registry is unavailable/);
	expect(prompts).toBe(before);
	await expect(f.commands.get("fusion-clean").handler("", f.ctx)).resolves.toBeUndefined();
	expect(f.notifications.at(-1)).toContain("Cannot clean Fusion");
	await rm(join(cwd, ".test-state"));
	const misconfigured = await f.tools.get("fusion_delegate").execute("call", { action: "execute", brief: "work" }, undefined, undefined, f.ctx);
	expect(misconfigured.details.error).toContain("executor model is not configured");
	expect(prompts).toBe(before);
	await expect(f.commands.get("fusion-clean").handler("", f.ctx)).resolves.toBeUndefined();
	expect(f.notifications.at(-1)).toContain("cleared");
});
