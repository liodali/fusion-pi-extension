// Native OpenCode surface fixture (step 1 evidence, model-free): boots the
// real OpenCode host in isolated config/data/state/home directories and
// verifies the plugin-manager and agent-contract facts the installation plan
// depends on, so a host upgrade that breaks any of them fails here instead
// of in a user's install:
//   - the agent editor surface (list/get/default/update/remove; no add)
//   - update-on-missing creates agents (system/mode/permissions survive)
//   - Markdown-defined agents keep precedence over plugin contributions
//   - command registration through ctx.command.transform
//   - config-watch reload replays transforms without duplication
//   - `opencode plugin add` from a Git source installs a package that
//     contributes agents and commands, and `plugin remove` uninstalls it
// No model is called and no session prompt is sent.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeArtifact } from "./artifact.mjs";

const bin = process.env.FUSION_OPENCODE_BIN || "opencode";
const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
if (version.status !== 0) throw new Error(`OpenCode binary not available (${bin}); set FUSION_OPENCODE_BIN.`);
const hostVersion = version.stdout.trim();

const result = { ok: false, hostVersion, phaseA: {}, phaseB: {} };
const failures = [];
const check = (label, condition, detail) => {
	if (condition) return;
	failures.push(label);
	result[`${label} (detail)`] = detail ?? null;
};

const root = await mkdtemp(join(tmpdir(), "fusion-native-surface-"));
const isolatedEnv = (extra = {}) => {
	const env = Object.fromEntries(["PATH", "SHELL", "TMPDIR", "LANG", "GIT_CONFIG_NOSYSTEM"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
	env.HOME = join(root, "home");
	for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
	return { ...env, ...extra };
};

const servers = [];
async function start(project, env) {
	const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
	const startup = [];
	const [url, password] = await new Promise((resolve, reject) => {
		let u, p;
		const timer = setTimeout(() => reject(new Error(`server startup timeout; log tail: ${startup.join("").slice(-2000)}`)), 90000);
		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			startup.push(text);
			u ??= text.match(/server listening on (http:\/\/\S+)/)?.[1];
			p ??= text.match(/server password (\S+)/)?.[1];
			if (u && p) { clearTimeout(timer); resolve([u, p]); }
		});
		child.stderr.on("data", (chunk) => startup.push(chunk.toString()));
		child.on("exit", (code) => reject(new Error(`server exited early (${code}); log tail: ${startup.join("").slice(-2000)}`)));
	});
	const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
	const server = {
		url, password, child, startup,
		get: async (path) => (await fetch(`${url}${path}`, { headers: auth, signal: AbortSignal.timeout(15000) })).json().catch(() => null),
	};
	servers.push(server);
	return server;
}

const agentsOf = (body) => (Array.isArray(body) ? body : body?.data ?? []);
const commandsOf = (body) => (Array.isArray(body) ? body : body?.data ?? []);

try {
	// ---------- Phase A: local plugin, agent editor contract ----------
	const project = join(root, "a-project");
	await mkdir(join(project, ".opencode", "plugins", "probe"), { recursive: true });
	await mkdir(join(project, ".opencode", "agent"), { recursive: true });
	const pluginFile = join(project, ".opencode", "plugins", "probe", "index.ts");
	const reportPath = join(root, "phase-a-report.json");
	await writeFile(pluginFile, `import { writeFileSync } from "node:fs";
const report = {};
const persist = () => { try { writeFileSync(process.env.PROBE_REPORT!, JSON.stringify(report) + "\\n"); } catch (e) { console.log("PROBE_WRITE_FAILED " + e); } };
export default {
	id: "probe-agents",
	async setup(ctx) {
		report.hostVersion = ctx.app?.version ?? null;
		await ctx.agent.transform((editor) => {
			report.editorMethods = Object.getOwnPropertyNames(editor).sort();
			report.hasAdd = typeof editor.add;
			let callbackRan = false;
			editor.update("probe-created", (agent) => {
				callbackRan = true;
				report.draftMode = agent.mode;
				agent.mode = "subagent";
				agent.description = "probe-created subagent";
				agent.system = "You are a probe agent. Answer briefly.";
				agent.permissions = [
					{ action: "read", resource: "*", effect: "allow" },
					{ action: "grep", resource: "*", effect: "allow" },
					{ action: "edit", resource: "*", effect: "deny" },
				];
			});
			report.updateOnMissing = callbackRan ? "callback ran" : "callback skipped";
			report.legacyVisible = !!editor.get("probe-legacy");
			editor.update("probe-legacy", (agent) => { agent.description = "updated-by-plugin"; });
			editor.remove("probe-removed");
			report.phase = "transform-callback";
			persist();
		});
		await ctx.command.transform((editor) => {
			editor.add({ name: "probe-command", description: "probe", execute: async () => {} });
		});
		report.phase = "setup-complete";
		persist();
	},
};
`);
	await writeFile(join(project, ".opencode", "agent", "probe-legacy.md"), "---\ndescription: Legacy markdown-defined probe agent\nmode: subagent\n---\nYou are the legacy markdown probe agent body.\n");
	await writeFile(join(project, ".opencode", "agent", "probe-removed.md"), "---\ndescription: Legacy agent the plugin tries to remove\nmode: subagent\n---\nLegacy body for removal precedence test.\n");
	const envA = isolatedEnv({ PROBE_REPORT: reportPath });
	const serverA = await start(project, envA);
	// Plugin activation is lazy per location: an API request for the location
	// triggers setup, so poll agents and the report together.
	let pluginReport;
	let agentsBefore;
	for (let i = 0; i < 100 && !pluginReport; i++) {
		agentsBefore = await serverA.get("/api/agent");
		try { pluginReport = JSON.parse(await readFile(reportPath, "utf8")); } catch {}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	for (let i = 0; i < 20 && pluginReport?.phase !== "transform-callback"; i++) {
		try { pluginReport = JSON.parse(await readFile(reportPath, "utf8")); } catch {}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	result.phaseA.pluginReport = pluginReport ?? "never written";
	const before = agentsOf(agentsBefore ?? await serverA.get("/api/agent"));
	const createdA = before.find((agent) => agent?.id === "probe-created");
	const legacyA = before.find((agent) => agent?.id === "probe-legacy");
	check("agent editor has exactly list/get/default/update/remove", JSON.stringify(pluginReport?.editorMethods) === JSON.stringify(["default", "get", "list", "remove", "update"]), pluginReport?.editorMethods);
	check("agent editor has no add method", pluginReport?.hasAdd === "undefined", pluginReport?.hasAdd);
	check("update on a missing ID runs its callback", pluginReport?.updateOnMissing === "callback ran", pluginReport?.updateOnMissing);
	check("the created draft defaults to mode primary", pluginReport?.draftMode === "primary", pluginReport?.draftMode);
	check("update-on-missing creates the agent", !!createdA, before.map((agent) => agent?.id));
	check("created agent carries the contributed system prompt", createdA?.system === "You are a probe agent. Answer briefly.", createdA?.system);
	check("created agent carries the contributed mode", createdA?.mode === "subagent", createdA?.mode);
	check("created agent carries contributed permissions before host defaults", JSON.stringify(createdA?.permissions?.slice(0, 3)) === JSON.stringify([{ action: "read", resource: "*", effect: "allow" }, { action: "grep", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "deny" }]), createdA?.permissions);
	check("markdown agent stays authoritative over a plugin update", legacyA?.description === "Legacy markdown-defined probe agent", legacyA?.description);
	check("markdown agent cannot be removed by the plugin", before.some((agent) => agent?.id === "probe-removed"));
	// Note: the transform callback's view of Markdown agents is not
	// deterministic on the first replay (live-observed), so conflict detection
	// in the real plugin reconciles the merged registry at query time; that
	// path is covered by the package-load fixture against the real plugin.
	const commandsA = commandsOf(await serverA.get("/api/command"));
	check("plugin command is registered", commandsA.some((command) => command?.name === "probe-command"), commandsA.map((command) => command?.name));
	// Config-watch reload: touching the plugin file replays transforms.
	const now = new Date();
	await utimes(pluginFile, now, now);
	let after = [];
	for (let i = 0; i < 20; i++) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		after = agentsOf(await serverA.get("/api/agent"));
		if (after.some((agent) => agent?.id === "probe-created")) break;
	}
	check("reload replays transforms without duplicating agents", after.filter((agent) => agent?.id === "probe-created").length === 1 && after.length === before.length, { before: before.length, after: after.length });
	result.phaseA = { agentsBefore: before.map((agent) => agent?.id), agentsAfter: after.map((agent) => agent?.id) };

	// ---------- Phase B: native package manager over a Git source ----------
	const pkgSrc = join(root, "b-pkg");
	await mkdir(pkgSrc, { recursive: true });
	await writeFile(join(pkgSrc, "package.json"), `${JSON.stringify({ name: "fusion-native-surface-pkg", version: "0.0.1", type: "module", exports: { ".": "./other-harness.ts", "./server": "./index.ts" } }, null, 2)}\n`);
	await writeFile(join(pkgSrc, "other-harness.ts"), 'throw new Error("OpenCode must prefer ./server over the other harness default");\n');
	await writeFile(join(pkgSrc, "index.ts"), `export default {
	id: "probe-package",
	async setup(ctx) {
		await ctx.agent.transform((editor) => {
			editor.update("pkg-created", (agent) => {
				agent.mode = "subagent";
				agent.description = "created by installed package plugin";
				agent.system = "You are the package-contributed probe agent.";
			});
		});
		await ctx.command.transform((editor) => {
			editor.add({ name: "pkg-command", description: "probe", execute: async () => {} });
		});
	},
};
`);
	const git = (args, opts = {}) => spawnSync("git", args, { encoding: "utf8", ...opts });
	assert.equal(git(["init", "-b", "main"], { cwd: pkgSrc }).status, 0, "git init");
	assert.equal(git(["-C", pkgSrc, "add", "-A"]).status, 0, "git add");
	assert.equal(git(["-C", pkgSrc, "-c", "user.email=probe@example.com", "-c", "user.name=probe", "commit", "-m", "probe package"]).status, 0, "git commit");
	const bare = join(root, "remote", "plugin-repo.git");
	await mkdir(join(root, "remote"), { recursive: true });
	assert.equal(git(["init", "--bare", "-b", "main", bare]).status, 0, "git bare init");
	assert.equal(git(["-C", pkgSrc, "push", `file://${bare}`, "main"]).status, 0, "git push");
	const spec = `git+file://${bare}#main`;
	const envB = isolatedEnv();
	const add = spawnSync(bin, ["plugin", "add", spec], { env: envB, cwd: root, encoding: "utf8", timeout: 120000 });
	check("opencode plugin add installs the Git package", add.status === 0, `${add.stdout ?? ""}${add.stderr ?? ""}`.split("\n").slice(-4).join(" | "));
	const globalConfigPath = join(envB.XDG_CONFIG_HOME, "opencode", "opencode.json");
	let globalConfig = "absent";
	try { globalConfig = JSON.parse(await readFile(globalConfigPath, "utf8")); } catch {}
	check("the installed package is recorded in the global config", Array.isArray(globalConfig?.plugins) && globalConfig.plugins.includes(spec), globalConfig);
	result.phaseB.addExit = add.status;
	result.phaseB.globalConfig = globalConfig;
	if (add.status === 0) {
		const projectB = join(root, "b-project");
		await mkdir(projectB, { recursive: true });
		const serverB = await start(projectB, envB);
		let agentsB = [];
		for (let i = 0; i < 100; i++) {
			agentsB = agentsOf(await serverB.get("/api/agent"));
			if (agentsB.some((agent) => agent?.id === "pkg-created")) break;
			await new Promise((resolve) => setTimeout(resolve, 600));
		}
		const pkgCreated = agentsB.find((agent) => agent?.id === "pkg-created");
		const commandsB = commandsOf(await serverB.get("/api/command"));
		const pluginsB = agentsOf(await serverB.get("/api/plugin"));
		const packagePlugin = pluginsB.find((plugin) => plugin?.id === "probe-package");
		check("the installed package contributes its agent", !!pkgCreated, agentsB.map((agent) => agent?.id));
		check("the package-contributed agent carries its definition", pkgCreated?.system === "You are the package-contributed probe agent." && pkgCreated?.mode === "subagent", { system: pkgCreated?.system, mode: pkgCreated?.mode });
		check("the installed package contributes its command", commandsB.some((command) => command?.name === "pkg-command"), commandsB.map((command) => command?.name));
		check("the installed package is listed as an active package plugin", packagePlugin?.source?.type === "package" && packagePlugin?.state?.status === "active", packagePlugin);
		result.phaseB.contribution = { agent: !!pkgCreated, command: true, plugin: packagePlugin };
		const remove = spawnSync(bin, ["plugin", "remove", spec], { env: envB, cwd: root, encoding: "utf8", timeout: 60000 });
		check("opencode plugin remove uninstalls the package", remove.status === 0, `${remove.stdout ?? ""}${remove.stderr ?? ""}`.split("\n").slice(-3).join(" | "));
		let configAfterRemove = "absent";
		try { configAfterRemove = JSON.parse(await readFile(globalConfigPath, "utf8")); } catch {}
		check("removal empties the global config entry", Array.isArray(configAfterRemove?.plugins) && configAfterRemove.plugins.length === 0, configAfterRemove);
		result.phaseB.removeExit = remove.status;
		result.phaseB.configAfterRemove = configAfterRemove;
		// Check the installed contributions after a fresh host start, rather
		// than treating a changed config file as proof of unloading/reinstall.
		const stop = async (server) => {
			if (server.child.exitCode !== null || server.child.signalCode !== null) return;
			await new Promise((resolve) => { server.child.once("exit", resolve); server.child.kill("SIGKILL"); });
		};
		await stop(serverB);
		const removedServer = await start(projectB, envB);
		const removedAgents = agentsOf(await removedServer.get("/api/agent"));
		const removedCommands = commandsOf(await removedServer.get("/api/command"));
		check("removal drops package agents and commands after restart", !removedAgents.some((agent) => agent?.id === "pkg-created") && !removedCommands.some((command) => command?.name === "pkg-command"));
		await stop(removedServer);
		const reinstall = spawnSync(bin, ["plugin", "add", spec], { env: envB, cwd: root, encoding: "utf8", timeout: 120000 });
		check("the removed package can be reinstalled", reinstall.status === 0, `${reinstall.stdout ?? ""}${reinstall.stderr ?? ""}`.split("\n").slice(-3).join(" | "));
		result.phaseB.reinstallExit = reinstall.status;
		if (reinstall.status === 0) {
			const reinstalledServer = await start(projectB, envB);
			const reinstalledAgents = agentsOf(await reinstalledServer.get("/api/agent"));
			const reinstalledCommands = commandsOf(await reinstalledServer.get("/api/command"));
			check("reinstall restores exactly one package agent and command", reinstalledAgents.filter((agent) => agent?.id === "pkg-created").length === 1 && reinstalledCommands.filter((command) => command?.name === "pkg-command").length === 1);
		}
	}
	// ---------- Phase C: Fusion's real dual-harness Git package ----------
	// Snapshot the package assets into a throwaway Git repository. Keep the
	// exact root manifest (including the Pi default and optional peers), so
	// this checks the shape a remote Git install actually receives.
	const repo = resolve(import.meta.dirname, "../..");
	const fusionSource = join(root, "fusion-source");
	await mkdir(fusionSource, { recursive: true });
	for (const asset of ["package.json", "src", "examples", "docs/install.md", ".pi/extensions/fusion.ts"]) {
		await mkdir(join(fusionSource, asset, ".."), { recursive: true });
		await cp(join(repo, asset), join(fusionSource, asset), { recursive: true });
	}
	assert.equal(git(["init", "-b", "main"], { cwd: fusionSource }).status, 0, "Fusion snapshot git init");
	assert.equal(git(["-C", fusionSource, "add", "-A"]).status, 0, "Fusion snapshot git add");
	assert.equal(git(["-C", fusionSource, "-c", "user.email=probe@example.com", "-c", "user.name=probe", "commit", "-m", "Fusion package snapshot"]).status, 0, "Fusion snapshot git commit");
	const fusionSpec = `git+file://${fusionSource}#main`;
	const envC = isolatedEnv({ XDG_CONFIG_HOME: join(root, "fusion-config"), XDG_DATA_HOME: join(root, "fusion-data"), XDG_STATE_HOME: join(root, "fusion-state"), XDG_CACHE_HOME: join(root, "fusion-cache"), FUSION_OWNERSHIP_DIR: join(root, "fusion-ownership") });
	const fusionAdd = spawnSync(bin, ["plugin", "add", fusionSpec], { env: envC, cwd: root, encoding: "utf8", timeout: 120000 });
	check("Fusion's real Git package installs", fusionAdd.status === 0, `${fusionAdd.stdout ?? ""}${fusionAdd.stderr ?? ""}`.split("\n").slice(-4).join(" | "));
	result.phaseC = { addExit: fusionAdd.status };
	if (fusionAdd.status === 0) {
		const fusionProject = join(root, "fusion-project");
		await mkdir(fusionProject, { recursive: true });
		const fusionServer = await start(fusionProject, envC);
		const fusionAgents = agentsOf(await fusionServer.get("/api/agent"));
		const fusionCommands = commandsOf(await fusionServer.get("/api/command"));
		const fusionPlugins = agentsOf(await fusionServer.get("/api/plugin"));
		check("Git Fusion contributes all three agents without copied Markdown", ["fusion", "fusion-executor", "fusion-scout"].every((id) => fusionAgents.filter((agent) => agent?.id === id).length === 1));
		check("Git Fusion registers its configuration command", fusionCommands.some((command) => command?.name === "fusion-config"));
		check("Git Fusion loads the server export as an active package plugin", fusionPlugins.some((plugin) => plugin?.id === "fusion" && plugin?.state?.status === "active" && plugin?.source?.type === "package"));
		result.phaseC.version = JSON.parse(await readFile(join(fusionSource, "package.json"), "utf8")).version;
	}
	result.ok = failures.length === 0;
	result.failures = failures;
} catch (error) {
	result.ok = false;
	result.error = String(error);
	result.failures = failures;
} finally {
	const secrets = servers.map((server) => server.password).filter(Boolean);
	await writeArtifact("opencode-native-surface", result, { secrets });
	for (const server of servers) server.child.kill("SIGKILL");
}
console.log(JSON.stringify({ ok: result.ok, failures, hostVersion }, null, 2));
if (!result.ok || failures.length > 0) process.exit(1);
