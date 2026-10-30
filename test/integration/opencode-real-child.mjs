// Opt-in live model test: a real serve-mode OpenCode runs the real Fusion plugin,
// a real parent delegates to a real owned child, and the raw bus is captured.
// All project and OpenCode state is disposable. Set FUSION_OPENCODE_MODEL.
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
const root = await mkdtemp(join(tmpdir(), "fusion-opencode-real-child-"));
let child;
try {
	const project = join(root, "project");
	await mkdir(join(project, ".opencode/plugins"), { recursive: true });
	await mkdir(join(project, ".opencode/agents"), { recursive: true });
	await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
	await cp(join(repo, "examples/opencode/agents"), join(project, ".opencode/agents"), { recursive: true });
	await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
	await writeFile(join(project, ".opencode/plugins/observer.ts"), `
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "fusion-real-child-observer", async setup(ctx) {
	const busPath = join(ctx.location.directory, "bus-capture.jsonl");
	const turnsPath = join(ctx.location.directory, "turns.json");
	const ac = new AbortController();
	const turns = [];
	await ctx.tool.hook("execute.after", async (event) => {
		if (event.tool !== "fusion_delegate" && event.tool !== "fusion_reset") return;
		turns.push({ tool: event.tool, status: event.status, action: event.result?.metadata?.action, childSessionID: event.result?.metadata?.childSessionID });
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
`);
	await writeFile(join(project, "opencode.json"), JSON.stringify({ permissions: [
		...["shell", "external_directory", "webfetch", "websearch", "skill", "glob", "grep"].map((action) => ({ action, resource: "*", effect: "deny" })),
		{ action: "read", resource: "*", effect: "allow" },
		{ action: "edit", resource: "*", effect: "allow" },
	] }));
	const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
	for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
	env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
	const provider = model.split("/")[0];
	const modelID = model.split("/")[1];
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
			const created = await fetch(`${url}/api/session`, { method: "POST", headers: { authorization: authHeader, "content-type": "application/json" }, body: JSON.stringify({ agent: "fusion", model: { providerID: provider, id: modelID } }) });
			const createdBody = await created.text();
			assert.equal(created.status, 200, `session create failed: ${createdBody.slice(0, 300)}`);
			const session = JSON.parse(createdBody);
			const parentID = session.id ?? session.data?.id;
			await new Promise((r) => setTimeout(r, 4000));
			const prompt = await fetch(`${url}/api/session/${parentID}/prompt`, { method: "POST", headers: { authorization: authHeader, "content-type": "application/json" }, body: JSON.stringify({ text: 'Test Fusion in this disposable directory. Use fusion_delegate execute to create fixture.txt containing exactly "alpha" and then read it back. Then use fusion_delegate revise to change it to exactly "beta". Finally call fusion_reset.' }) });
			assert.equal(prompt.status, 200, `prompt failed: ${await prompt.text()}`);
			const waitStart = Date.now();
			let fixture = "";
			while (Date.now() - waitStart < 260000) {
				try { fixture = await readFile(join(project, "fixture.txt"), "utf8"); } catch {}
				let resets = [];
				try { resets = JSON.parse(await readFile(join(project, "turns.json"), "utf8")).filter((t) => t.tool === "fusion_reset"); } catch {}
				if (fixture === "beta" && resets.length > 0) break;
				if (child.exitCode !== null) break;
				await new Promise((r) => setTimeout(r, 2000));
			}
			let fixtureContent = "";
			try { fixtureContent = await readFile(join(project, "fixture.txt"), "utf8"); } catch {}
			let turns = [];
			try { turns = JSON.parse(await readFile(join(project, "turns.json"), "utf8")); } catch {}
			let bus = [];
			try { bus = (await readFile(join(project, "bus-capture.jsonl"), "utf8")).split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch {}
			const kinds = {};
			for (const event of bus) kinds[event.type] = (kinds[event.type] ?? 0) + 1;
			const childSessions = bus.filter((e) => e.type === "session.created" && e.data?.agent === "fusion-executor");
			const childID = childSessions[0]?.data?.sessionID;
			const childKinds = {};
			for (const event of bus) if (childID && (event.data?.sessionID === childID || event.durable?.aggregateID === childID)) childKinds[event.type] = (childKinds[event.type] ?? 0) + 1;
			const ids = bus.map((e) => e.id).filter((id) => typeof id === "string");
			const duplicateIds = ids.length - new Set(ids).size;
			const result = { model, version: bus.find((e) => e.type === "session.created")?.data?.version ?? startup.match(/version ([\d.]+)/)?.[1] ?? "unknown", fixture: fixtureContent, turns, childSessions: childSessions.length, childID, childKinds, busEvents: bus.length, kinds, duplicateIds, usageReadings: childKinds["session.usage.updated"] ?? 0 };
			console.log(JSON.stringify(result));
			assert.ok(child.exitCode === null || child.exitCode === 0, "OpenCode server exited during the run");
			assert.equal(fixtureContent.replace(/\n+$/, ""), "beta", "Executor did not complete both fixture changes");
			assert.deepEqual(turns.map((t) => `${t.tool}:${t.action ?? ""}`), ["fusion_delegate:execute", "fusion_delegate:revise", "fusion_reset:"], "Unexpected delegation turn sequence");
			const delegations = turns.filter((t) => t.tool === "fusion_delegate");
			assert.ok(delegations[0].childSessionID && delegations.every((t) => t.childSessionID === delegations[0].childSessionID), "Expected the same executor child for all turns");
			assert.equal(childSessions.length, 1, "Expected exactly one owned child session");
			assert.ok((childKinds["session.execution.started"] ?? 0) >= 1 && (childKinds["session.execution.succeeded"] ?? 0) >= 1, "Child execution lifecycle events missing");
			assert.ok((childKinds["session.tool.called"] ?? 0) >= 1, "Child tool activity missing");
			assert.ok((childKinds["session.text.delta"] ?? 0) >= 1, "Child text streaming missing");
			assert.ok((childKinds["session.usage.updated"] ?? 0) >= 1, "Child usage accounting missing");
			assert.equal(duplicateIds, 0, "The bus itself delivered duplicate event identities");
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
