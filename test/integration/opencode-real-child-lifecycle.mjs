// Opt-in live model test: real serve-mode OpenCode + real Fusion plugin.
// Scenarios: child interrupt (cancelled matching), parent interrupt
// (foreground-to-background + reconcile), and a deterministic child model error.
// Set FUSION_OPENCODE_MODEL to an authenticated OpenCode model (provider/model).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

const model = process.env.FUSION_OPENCODE_MODEL;
if (!model) throw new Error("Set FUSION_OPENCODE_MODEL to an authenticated OpenCode model (provider/model).");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const provider = model.split("/")[0];
const modelID = model.split("/")[1];
const results = [];

const OBSERVER = `
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "fusion-lifecycle-observer", async setup(ctx) {
	const busPath = join(ctx.location.directory, "bus-capture.jsonl");
	const turnsPath = join(ctx.location.directory, "turns.json");
	const ac = new AbortController();
	const turns = [];
	await ctx.tool.hook("execute.after", async (event) => {
		if (!["fusion_delegate", "fusion_reconcile", "fusion_reset"].includes(event.tool)) return;
		turns.push({ tool: event.tool, status: event.status, action: event.result?.metadata?.action, childSessionID: event.result?.metadata?.childSessionID, terminalStatus: event.result?.metadata?.status });
		try { await writeFile(turnsPath, JSON.stringify(turns)); } catch {}
	});
	const iter = ctx.event.subscribe({ signal: ac.signal })[Symbol.asyncIterator]();
	void (async () => {
		for (;;) {
			const next = await iter.next();
			if (next.done) break;
			try { await appendFile(busPath, JSON.stringify(next.value) + "\\n"); } catch {}
		}
	})().catch(() => {});
	return () => ac.abort();
} };
`;

async function credentials(env) {
	await mkdir(join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
	let auth = {};
	try { auth = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8")); } catch {}
	if (auth[provider]) await writeFile(join(env.XDG_DATA_HOME, "opencode/auth.json"), JSON.stringify({ [provider]: auth[provider] }), { mode: 0o600 });
	let account;
	try { account = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/account.json"), "utf8")); } catch {}
	const accountID = account?.active?.[provider];
	const selectedAccount = accountID && account?.accounts?.[accountID];
	if (selectedAccount) await writeFile(join(env.XDG_DATA_HOME, "opencode/account.json"), JSON.stringify({ version: account.version, accounts: { [accountID]: selectedAccount }, active: { [provider]: accountID } }), { mode: 0o600 });
	let databaseCredential;
	let db;
	try {
		db = new Database(join(homedir(), ".local/share/opencode/opencode.db"), { readonly: true });
		const rows = db.query("SELECT value FROM credential WHERE integration_id = ? AND active = 1").all(provider);
		if (rows.length > 1) throw new Error(`Multiple active credentials for ${provider}`);
		if (rows.length === 1) databaseCredential = JSON.parse(rows[0].value);
	} catch (error) {
		if (!String(error).includes("unable to open database file") && !String(error).includes("no such table")) throw error;
	} finally { db?.close(); }
	const goKey = process.env.OPENCODE_API_KEY ?? databaseCredential?.key ?? selectedAccount?.credential?.key ?? auth[provider]?.key;
	assert.ok(selectedAccount || auth[provider] || databaseCredential || (provider === "opencode-go" && goKey), `No OpenCode credential for provider ${provider}`);
	if (provider === "opencode-go" && goKey) env.OPENCODE_API_KEY = goKey;
}

async function withServer(name, options, run) {
	const root = await mkdtemp(join(tmpdir(), `fusion-opencode-${name}-`));
	let child;
	try {
		const project = join(root, "project");
		await mkdir(join(project, ".opencode/plugins"), { recursive: true });
		await mkdir(join(project, ".opencode/agents"), { recursive: true });
		await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
		await cp(join(repo, "examples/opencode/agents"), join(project, ".opencode/agents"), { recursive: true });
		if (options?.bogusExecutorModel) {
			const agentPath = join(project, ".opencode/agents/fusion-executor.md");
			const text = await readFile(agentPath, "utf8");
			await writeFile(agentPath, text.replace("mode: subagent", `mode: subagent\nmodel: ${provider}/not-a-real-model-xyz`));
		}
		await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
		await writeFile(join(project, ".opencode/plugins/observer.ts"), OBSERVER);
		await writeFile(join(project, "fixture.txt"), "seed line\n");
		await writeFile(join(project, "opencode.json"), JSON.stringify({ permissions: [
			...["shell", "external_directory", "webfetch", "websearch", "skill", "glob", "grep"].map((action) => ({ action, resource: "*", effect: "deny" })),
			{ action: "read", resource: "*", effect: "allow" },
			{ action: "edit", resource: "*", effect: "allow" },
		] }));
		const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
		for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
		env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
		await credentials(env);
		child = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
		let startup = "";
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { startup += data; });
		const deadline = Date.now() + 40000;
		while (Date.now() < deadline) {
			const url = startup.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
			const password = startup.match(/server password ([^\s]+)/)?.[1];
			if (url && password) {
				const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
				const probe = await fetch(`${url}/api/location`, { headers: { authorization: authHeader }, signal: AbortSignal.timeout(10000) });
				assert.equal(probe.status, 200);
				const api = async (path, init) => {
					const response = await fetch(`${url}${path}`, { ...init, headers: { authorization: authHeader, "content-type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20000) });
					const text = await response.text();
					return { status: response.status, body: text, json: () => JSON.parse(text) };
				};
				const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(join(project, file), "utf8")); } catch { return fallback; } };
				const readBus = async () => (await readFile(join(project, "bus-capture.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
				const waitFor = async (predicate, ms, label) => {
					const start = Date.now();
					for (;;) {
						const value = await predicate();
						if (value) return value;
						if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${label}`);
						await new Promise((r) => setTimeout(r, 800));
					}
				};
				const newParent = async () => {
					const created = await api("/api/session", { method: "POST", body: JSON.stringify({ agent: "fusion", model: { providerID: provider, id: modelID } }) });
					assert.equal(created.status, 200, `session create failed: ${created.body.slice(0, 300)}`);
					const info = created.json();
					return info.id ?? info.data?.id;
				};
				const prompt = async (sessionID, text) => {
					const response = await api(`/api/session/${sessionID}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
					assert.equal(response.status, 200, `prompt failed: ${response.body.slice(0, 300)}`);
				};
				await run({ project, api, readJson, readBus, waitFor, newParent, prompt });
				break;
			}
			if (child.exitCode !== null) throw new Error(`Server exited: ${startup.slice(-400)}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	} finally {
		if (child?.exitCode === null) child.kill("SIGKILL");
		await Promise.race([new Promise((r) => child?.once("exit", r)), new Promise((r) => setTimeout(r, 3000))]);
		await rm(root, { recursive: true, force: true });
	}
}

const LONG_BRIEF = 'Use fusion_delegate execute with this exact brief: read fixture.txt, then write a detailed 400-word report about the repository into report.txt. Take your time and do not stop early.';

// Scenario A: interrupt the owned child mid-turn; observe how the turn resolves
// (foreground tool result vs backgrounded notification), then match cancelled.
await withServer("cancelled", {}, async ({ api, readJson, readBus, waitFor, newParent, prompt }) => {
	const parent = await newParent();
	await prompt(parent, LONG_BRIEF);
	const child = await waitFor(async () => (await readBus()).find((e) => e.type === "session.created" && e.data?.agent === "fusion-executor")?.data?.sessionID, 60000, "child session");
	await waitFor(async () => (await readBus()).some((e) => e.type === "session.text.delta" && e.data?.sessionID === child), 60000, "child streaming");
	const interrupted = await api(`/api/session/${child}/interrupt`, { method: "POST", body: "{}" });
	assert.equal(interrupted.status, 200, `interrupt failed: ${interrupted.body.slice(0, 200)}`);
	assert.equal(interrupted.json().interrupted ?? interrupted.json().data?.interrupted, true, "Host did not interrupt the owned child");
	// Wait for either the delegation turn to resolve or a synthetic notification.
	let resolution;
	const start = Date.now();
	while (Date.now() - start < 90000) {
		const turns = await readJson("turns.json", []);
		const delegate = turns.find((t) => t.tool === "fusion_delegate");
		const messages = await api(`/api/session/${parent}/message`);
		const list = messages.json().data ?? messages.json();
		const synthetic = (Array.isArray(list) ? list : []).find((m) => m.type === "synthetic" && m.metadata?.source === "subagent" && m.metadata?.childID === child);
		if (delegate || synthetic) { resolution = { delegate, synthetic }; break; }
		await new Promise((r) => setTimeout(r, 1500));
	}
	const childInfo = await api(`/api/session/${child}`);
	const outcome = childInfo.json().outcome ?? childInfo.json().data?.outcome;
	const bus = await readBus();
	const executionInterrupted = bus.some((e) => e.type === "session.execution.interrupted" && e.data?.sessionID === child);
	const children = bus.filter((e) => e.type === "session.created" && e.data?.agent === "fusion-executor");
	const evidence = { scenario: "cancelled", child, outcome, executionInterrupted, childSessions: children.length, resolution };
	results.push(evidence);
	console.log(JSON.stringify(evidence));
	assert.equal(children.length, 1, "Cancelled work was resubmitted as another child");
	assert.equal(outcome, "interrupted", "Child session outcome is not interrupted");
	assert.ok(executionInterrupted, "execution.interrupted missing");
	assert.ok(resolution, "The delegation never resolved after the interrupt");
	if (resolution?.synthetic) assert.equal(resolution.synthetic.metadata?.state, "cancelled", "Notification did not carry cancelled");
});

// Scenario B: interrupt the supervisor mid-turn; observe whether the child keeps
// running (background) and how the completion is eventually delivered.
await withServer("background", {}, async ({ api, readJson, readBus, waitFor, newParent, prompt }) => {
	const parent = await newParent();
	await prompt(parent, LONG_BRIEF);
	const child = await waitFor(async () => (await readBus()).find((e) => e.type === "session.created" && e.data?.agent === "fusion-executor")?.data?.sessionID, 60000, "child session");
	const childStreaming = async () => (await readBus()).filter((e) => e.data?.sessionID === child && e.type.startsWith("session."));
	await waitFor(async () => (await childStreaming()).some((e) => e.type === "session.text.delta"), 60000, "child streaming");
	const beforeInterrupt = await childStreaming();
	const interrupted = await api(`/api/session/${parent}/interrupt`, { method: "POST", body: "{}" });
	assert.equal(interrupted.status, 200, `parent interrupt failed: ${interrupted.body.slice(0, 200)}`);
	// Wait for the child's terminal execution event; it may keep working after the parent abort.
	let childTerminal;
	let synthetic;
	let delegate;
	const start = Date.now();
	while (Date.now() - start < 240000) {
		const events = await childStreaming();
		childTerminal = events.find((e) => ["session.execution.succeeded", "session.execution.interrupted", "session.execution.failed"].includes(e.type));
		const messages = await api(`/api/session/${parent}/message`);
		const list = messages.json().data ?? messages.json();
		synthetic = (Array.isArray(list) ? list : []).find((m) => m.type === "synthetic" && m.metadata?.source === "subagent" && m.metadata?.childID === child);
		delegate = (await readJson("turns.json", [])).find((t) => t.tool === "fusion_delegate");
		if (synthetic || (childTerminal && Date.now() - start > 30000)) break;
		await new Promise((r) => setTimeout(r, 2000));
	}
	const afterInterrupt = await childStreaming();
	const childInfo = await api(`/api/session/${child}`);
	const outcome = childInfo.json().outcome ?? childInfo.json().data?.outcome;
	const children = (await readBus()).filter((e) => e.type === "session.created" && e.data?.agent === "fusion-executor");
	let reconcile;
	if (synthetic) {
		await prompt(parent, "The executor's completion notification has arrived. Call fusion_reconcile now.");
		reconcile = await waitFor(async () => (await readJson("turns.json", [])).find((t) => t.tool === "fusion_reconcile" && t.status === "completed"), 90000, "fusion_reconcile");
	}
	const evidence = { scenario: "background", child, outcome, childTerminal: childTerminal?.type, syntheticState: synthetic?.metadata?.state, delegateStatus: delegate?.status, childEventsBefore: beforeInterrupt.length, childEventsAfter: afterInterrupt.length, reconcileStatus: reconcile?.terminalStatus, childSessions: children.length };
	results.push(evidence);
	console.log(JSON.stringify(evidence));
	assert.equal(children.length, 1, "Backgrounded work was resubmitted as another child");
	if (synthetic && reconcile) assert.equal(reconcile.terminalStatus, synthetic.metadata?.state, "Reconcile did not match the notification's terminal state");
});

// Scenario C: a deterministic child model error never fabricates a successful run.
await withServer("error", { bogusExecutorModel: true }, async ({ project, api, readJson, readBus, newParent, prompt }) => {
	const parent = await newParent();
	await prompt(parent, LONG_BRIEF);
	// Wait for the delegation attempt to resolve (either a failed tool result or an error notification).
	await new Promise((r) => setTimeout(r, 25000));
	const children = (await readBus()).filter((e) => e.type === "session.created" && e.data?.agent === "fusion-executor");
	const turns = await readJson("turns.json", []);
	const messages = await api(`/api/session/${parent}/message`);
	const list = messages.json().data ?? messages.json();
	const synthetic = (Array.isArray(list) ? list : []).find((m) => m.type === "synthetic" && m.metadata?.source === "subagent");
	let reportExists = true;
	try { await readFile(join(project, "report.txt"), "utf8"); } catch { reportExists = false; }
	const evidence = { scenario: "error", childSessions: children.length, turns, syntheticState: synthetic?.metadata?.state, reportExists };
	results.push(evidence);
	console.log(JSON.stringify(evidence));
	assert.ok(children.length <= 1, "Error path resubmitted children");
	assert.equal(reportExists, false, "A failed child still produced the report");
	if (synthetic) assert.equal(synthetic.metadata?.state, "error", "Error notification did not carry error");
});

console.log(JSON.stringify({ verdict: "pass", scenarios: results.map((r) => r.scenario) }));
