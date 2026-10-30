// Opt-in live model test: a restricted Fusion scout against a real serve-mode
// OpenCode. Scenarios: A read-only scout answers with citations and leaves the
// tree untouched; B the shared per-run invocation budget refuses the fifth
// call; C an interrupted supervisor leaves the scout cancelled without
// poisoning the run. Set FUSION_OPENCODE_MODEL; filter with FUSION_SCOUT_ONLY=A,B,C.
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
const ONLY = process.env.FUSION_SCOUT_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
const run = (name) => !ONLY || ONLY.includes(name);

const OBSERVER = `
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "fusion-scout-observer", async setup(ctx) {
	const busPath = join(ctx.location.directory, "bus-capture.jsonl");
	const turnsPath = join(ctx.location.directory, "turns.json");
	const ac = new AbortController();
	const turns = [];
	await ctx.tool.hook("execute.after", async (event) => {
		if (!["fusion_scout", "fusion_delegate", "fusion_reset", "fusion_status"].includes(event.tool)) return;
		const raw = event.result?.output ?? event.result?.content;
		const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : "")).join("") : JSON.stringify(raw ?? "");
		turns.push({ tool: event.tool, status: event.status, error: String(event.error ?? ""), childSessionID: event.result?.metadata?.childSessionID, capped: event.result?.metadata?.capped, toolStatus: event.result?.metadata?.status, text });
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

async function withServer(name, runScenario) {
	const root = await mkdtemp(join(tmpdir(), `fusion-opencode-scout-${name}-`));
	let child;
	try {
		const project = join(root, "project");
		await mkdir(join(project, ".opencode/plugins"), { recursive: true });
		await mkdir(join(project, ".opencode/agents"), { recursive: true });
		await mkdir(join(project, "src"), { recursive: true });
		await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
		await cp(join(repo, "examples/opencode/agents"), join(project, ".opencode/agents"), { recursive: true });
		await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
		await writeFile(join(project, ".opencode/plugins/observer.ts"), OBSERVER);
		// Read/search/list stay available to every agent; everything with effects is denied.
		await writeFile(join(project, "opencode.json"), JSON.stringify({ permissions: [
			...["edit", "write", "patch", "shell", "external_directory", "webfetch", "websearch", "skill"].map((action) => ({ action, resource: "*", effect: "deny" })),
			{ action: "read", resource: "*", effect: "allow" },
			{ action: "grep", resource: "*", effect: "allow" },
			{ action: "glob", resource: "*", effect: "allow" },
		] }));
		const notes = "# Notes\n\nThe rendezvous fruit is cantaloupe.\nNothing else matters here.\n";
		const app = "export function scoutTarget(): string {\n\treturn \"falcon\";\n}\n";
		await writeFile(join(project, "notes.md"), notes);
		await writeFile(join(project, "src/app.ts"), app);
		const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
		for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
		env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
		await credentials(env);
		child = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
		let startup = "";
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { startup += data; });
		const deadline = Date.now() + 40000;
		for (;;) {
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
					return created.json().id ?? created.json().data?.id;
				};
				const promptParent = async (parent, text) => {
					const prompt = await api(`/api/session/${parent}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
					assert.equal(prompt.status, 200, `prompt failed: ${prompt.body.slice(0, 300)}`);
				};
				const outcome = await runScenario({ project, api, readJson, readBus, waitFor, newParent, promptParent, notes, app });
				const version = (await readBus()).find((e) => e.type === "session.created")?.data?.version ?? startup.match(/version ([\d.]+)/)?.[1] ?? "unknown";
				results.push({ scenario: name, model, provider, version, ...outcome });
				return;
			}
			if (child.exitCode !== null) throw new Error(`Server exited: ${startup.slice(-400)}`);
			if (Date.now() > deadline) throw new Error(`Server never listened: ${startup.slice(-400)}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	} finally {
		if (child?.exitCode === null) child.kill("SIGKILL");
		await Promise.race([new Promise((r) => child?.once("exit", r)), new Promise((r) => setTimeout(r, 3000))]);
		await rm(root, { recursive: true, force: true });
	}
}

async function scenarioA({ project, readJson, readBus, waitFor, newParent, promptParent, notes, app }) {
	const parent = await newParent();
	await new Promise((r) => setTimeout(r, 3000));
	await promptParent(parent, "Use fusion_scout once with these two questions: \"Which fruit name appears in notes.md, and on which line?\" and \"Which function is defined in src/app.ts, on which line, and what exact string does it return?\" After the scout answers, call fusion_reset.");
	await waitFor(async () => {
		const turns = await readJson("turns.json", []);
		return turns.some((t) => t.tool === "fusion_reset");
	}, 240000, "the scout answer and reset");
	const turns = await readJson("turns.json", []);
	const scout = turns.find((t) => t.tool === "fusion_scout");
	assert.ok(scout, "No fusion_scout turn recorded");
	assert.equal(scout.status, "completed", "The scout turn did not complete");
	assert.equal(scout.capped, false, "The scout reported capping on a normal answer");
	assert.ok(scout.childSessionID, "The scout did not report its child session");
	assert.ok(scout.text.includes("cantaloupe"), `The scout missed the notes answer: ${scout.text.slice(0, 300)}`);
	assert.ok(scout.text.includes("falcon"), `The scout missed the function answer: ${scout.text.slice(0, 300)}`);
	assert.ok(scout.text.includes("Scout usage: in "), `The scout result lacks the usage line: ${scout.text.slice(0, 300)}`);
	const bus = await readBus();
	const scoutChildren = bus.filter((e) => e.type === "session.created" && e.data?.agent === "fusion-scout");
	assert.equal(scoutChildren.length, 1, "Expected exactly one disposable scout child");
	const scoutChild = scoutChildren[0].data.sessionID;
	assert.equal(scoutChild, scout.childSessionID, "The reported scout child does not match the bus");
	const usageReadings = bus.filter((e) => e.type === "session.usage.updated" && e.data?.sessionID === scoutChild);
	assert.ok(usageReadings.length >= 1, "No usage accounting arrived for the scout child");
	// Read-only proof: the working tree is byte-identical after scouting.
	assert.equal(await readFile(join(project, "notes.md"), "utf8"), notes, "The scout modified notes.md");
	assert.equal(await readFile(join(project, "src/app.ts"), "utf8"), app, "The scout modified src/app.ts");
	const reset = turns.find((t) => t.tool === "fusion_reset");
	assert.ok(reset && reset.status === "completed", "The post-scout reset failed");
	return { scoutChild, scoutText: scout.text.slice(0, 200), usageReadings: usageReadings.length, turns: turns.map((t) => t.tool) };
}

async function scenarioB({ readJson, readBus, waitFor, newParent, promptParent }) {
	const parent = await newParent();
	await new Promise((r) => setTimeout(r, 3000));
	await promptParent(parent, "Call fusion_scout four times with the single question \"What is in notes.md?\". Important: call the tool strictly one at a time — wait for each answer before calling it again. Do not read any files yourself, and do not call fusion_reset yet.");
	await waitFor(async () => {
		const turns = await readJson("turns.json", []);
		return turns.filter((t) => t.tool === "fusion_scout" && t.toolStatus === "completed").length >= 4;
	}, 300000, "four completed scout calls");
	// The shared budget is exhausted; the next call must be refused by the tool
	// itself before any native scout child is created.
	await promptParent(parent, "Now call fusion_scout one more time, with the single question \"What is in notes.md?\". Call the tool exactly once and report its answer verbatim.");
	await waitFor(async () => {
		const turns = await readJson("turns.json", []);
		return turns.some((t) => t.tool === "fusion_scout" && t.text.includes("Scout limit reached"));
	}, 180000, "the refused fifth scout call");
	await promptParent(parent, "Call fusion_reset now.");
	await waitFor(async () => {
		const turns = await readJson("turns.json", []);
		return turns.some((t) => t.tool === "fusion_reset");
	}, 120000, "the post-budget reset");
	const turns = await readJson("turns.json", []);
	const scouts = turns.filter((t) => t.tool === "fusion_scout");
	const answered = scouts.filter((t) => t.toolStatus === "completed" && !t.text.includes("Scout limit reached"));
	const refused = scouts.filter((t) => t.text.includes("Scout limit reached"));
	assert.ok(answered.length >= 4, `Expected at least four answered scout calls, saw ${answered.length} of ${scouts.length}`);
	assert.ok(refused.length >= 1, `No fusion_scout turn was budget-refused: ${scouts.map((t) => t.text.slice(0, 80)).join(" | ")}`);
	for (const refusal of refused) assert.ok(refusal.text.includes("at most 4 fusion_scout calls"), `Unexpected refusal text: ${refusal.text.slice(0, 160)}`);
	// Every non-answered turn must be a Fusion guard (budget refusal or the
	// concurrent-scout guard), never a failed scout child.
	for (const other of scouts.filter((t) => !answered.includes(t) && !refused.includes(t))) {
		assert.ok(`${other.error} ${other.text}`.includes("already running"), `Unexpected scout error: ${other.error.slice(0, 160)} ${other.text.slice(0, 160)}`);
	}
	// The refused call created no native scout child: exactly four exist.
	const bus = await readBus();
	const scoutChildren = bus.filter((e) => e.type === "session.created" && e.data?.agent === "fusion-scout");
	assert.equal(scoutChildren.length, 4, `Expected exactly four scout children, saw ${scoutChildren.length}`);
	assert.ok(turns.some((t) => t.tool === "fusion_reset" && t.status === "completed"), "The post-budget reset failed");
	return { scoutTurns: scouts.length, answered: answered.length, refusals: refused.length, scoutChildren: scoutChildren.length };
}

async function scenarioC({ project, api, readJson, readBus, waitFor, newParent, promptParent, notes, app }) {
	const parent = await newParent();
	await new Promise((r) => setTimeout(r, 3000));
	await promptParent(parent, "Use fusion_scout with one question: \"List every file in this repository and describe the full contents of each file in detail, including anything relevant to a migration of the build system.\" The answer must be thorough.");
	const scoutChild = await waitFor(async () => (await readBus()).find((e) => e.type === "session.created" && e.data?.agent === "fusion-scout")?.data?.sessionID, 90000, "the scout child session");
	// Let the scout start reading, then interrupt the supervisor mid-scout.
	await new Promise((r) => setTimeout(r, 6000));
	const interrupt = await api(`/api/session/${parent}/interrupt`, { method: "POST", body: "{}" });
	assert.equal(interrupt.status, 200, `parent interrupt failed: ${interrupt.body.slice(0, 200)}`);
	await waitFor(async () => {
		const bus = await readBus();
		return bus.some((e) => e.type === "session.execution.interrupted" && e.data?.sessionID === scoutChild);
	}, 60000, "the interrupted scout child");
	// The cancelled scout left no effects and no lock: a scripted reset on the same session succeeds.
	await promptParent(parent, "The scout was interrupted. Call fusion_reset now.");
	await waitFor(async () => {
		const turns = await readJson("turns.json", []);
		return turns.some((t) => t.tool === "fusion_reset");
	}, 120000, "the post-interrupt reset");
	const turns = await readJson("turns.json", []);
	const reset = turns.find((t) => t.tool === "fusion_reset");
	assert.ok(reset && reset.status === "completed", "The post-interrupt reset failed");
	assert.equal(await readFile(join(project, "notes.md"), "utf8"), notes, "The interrupted scout modified notes.md");
	assert.equal(await readFile(join(project, "src/app.ts"), "utf8"), app, "The interrupted scout modified src/app.ts");
	return { scoutChild, scoutInterrupted: true, resetCompleted: reset.status === "completed", turns: turns.map((t) => t.tool) };
}

if (run("A")) await withServer("a", scenarioA);
if (run("B")) await withServer("b", scenarioB);
if (run("C")) await withServer("c", scenarioC);
console.log(JSON.stringify(results, null, 2));
