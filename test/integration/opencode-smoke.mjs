// Real OpenCode plugin/registry probe; no provider credentials or model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = await mkdtemp(join(tmpdir(), "fusion-opencode-smoke-"));
let child;
try {
	const project = join(root, "project");
	await mkdir(join(project, ".opencode/plugins"), { recursive: true });
	await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
	await writeFile(join(project, ".opencode/plugins/fusion-probe.ts"), `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import fusion from "../fusion/opencode/index.ts";
export default {
  id: "fusion-smoke",
  async setup(ctx) {
    const result = { version: ctx.app.version, nativeFound: false, registered: false, catalogModels: 0, catalogProviders: 0, configureValidated: false, configureApplied: false, runStarted: false, nativeInvoked: false, recursiveRefused: false };
    try {
      const native = (await ctx.tool.list()).find((tool) => tool.id === "subagent");
      if (!native || typeof native.execute !== "function") throw new Error("Native subagent executor is unavailable");
      result.nativeFound = true;
      await fusion.setup(ctx);
      const registered = await ctx.tool.list();
      const delegate = registered.find((tool) => tool.id === "fusion_delegate");
      result.registered = !!delegate && ["fusion_start", "fusion_status", "fusion_stats", "fusion_configure", "fusion_reset", "fusion_reconcile", "fusion_scout"].every((id) => registered.some((tool) => tool.id === id));
      if (!result.registered) throw new Error("Fusion tools did not register");
      // Pin the host model catalog surface Fusion configures against (no model call).
      const catalog = await ctx.model.list();
      const models = Array.isArray(catalog?.data) ? catalog.data : [];
      const usable = models.filter((m) => m && typeof m.providerID === "string" && typeof m.id === "string");
      result.catalogModels = usable.length;
      result.catalogProviders = [...new Set(usable.map((m) => m.providerID))].length;
      if (!(usable.length > 0)) throw new Error("The host model catalog was empty or malformed");
      const parent = await ctx.session.create({});
      const toolContext = { sessionID: parent.id, agent: "fusion", messageID: "msg_start_probe", id: "call_start_probe", signal: new AbortController().signal, progress: async () => {} };
      await registered.find((tool) => tool.id === "fusion_start").execute({ task: "Original smoke task" }, toolContext);
      const state = JSON.parse((await registered.find((tool) => tool.id === "fusion_status").execute({}, toolContext)).content);
      if (state.originalTask !== "Original smoke task" || state.owner.supervisorId !== parent.id || !state.workspaceClaimed) throw new Error("Fusion start did not retain the task and owner");
      const stats = JSON.parse((await registered.find((tool) => tool.id === "fusion_stats").execute({}, toolContext)).content);
      if (stats.revisions.used !== 0 || stats.usage.available !== false) throw new Error("Fusion stats did not report the initial budget and unavailable usage");
      // Configure validation runs against the real catalog, without calling a model.
      const configureTool = registered.find((tool) => tool.id === "fusion_configure");
      try {
        await configureTool.execute({ provider: "prov", model: "not-in-catalog" }, toolContext);
        throw new Error("Configure accepted a model outside the catalog");
      } catch (error) {
        if (!String(error).includes("not in the OpenCode model catalog")) throw error;
        result.configureValidated = true;
      }
      const configured = await configureTool.execute({ provider: usable[0].providerID, model: usable[0].id }, toolContext);
      if (configured.metadata?.applied !== "now" || configured.metadata?.model?.modelId !== usable[0].id) throw new Error("Configure did not apply the catalog model to this run");
      result.configureApplied = true;
      const stateAfterConfigure = JSON.parse((await registered.find((tool) => tool.id === "fusion_status").execute({}, toolContext)).content);
      if (stateAfterConfigure.model?.modelId !== usable[0].id) throw new Error("Configured model did not reach status");
      await registered.find((tool) => tool.id === "fusion_reset").execute({}, toolContext);
      result.runStarted = true;
      try {
        await delegate.execute({ action: "execute", brief: "Probe only" }, { sessionID: "ses_fusion_probe_missing", agent: "fusion", messageID: "msg_probe", id: "call_probe", signal: new AbortController().signal, progress: async () => {} });
        throw new Error("Missing-parent call unexpectedly succeeded");
      } catch (error) {
        if (!String(error).includes("Parent session not found")) throw error;
        result.nativeInvoked = true;
      }
      try {
        await delegate.execute({ action: "execute", brief: "Probe only" }, { sessionID: "ses_fusion_probe_recursion", agent: "fusion-executor", messageID: "msg_probe2", id: "call_probe2", signal: new AbortController().signal, progress: async () => {} });
        throw new Error("Recursive worker call unexpectedly succeeded");
      } catch (error) {
        if (!String(error).includes("only to the fusion primary agent")) throw error;
        result.recursiveRefused = true;
      }
    } catch (error) { result.error = String(error); }
    await writeFile(join(ctx.location.directory, "probe-result.json"), JSON.stringify(result));
  },
};
`);
	// Keep user configuration, stored credentials, and provider environment keys out.
	const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
	for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
	env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
	child = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
	let startup = "";
	let spawnError;
	child.on("error", (error) => { spawnError = error; });
	for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { startup = (startup + data.toString()).slice(-16384); });
	let url, password;
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (spawnError) throw spawnError;
		if (child.exitCode !== null) throw new Error(`OpenCode exited before readiness (${child.exitCode})`);
		url = startup.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
		password = startup.match(/server password ([^\s]+)/)?.[1];
		if (url && password) break;
		await delay(50);
	}
	assert.ok(url && password, "OpenCode did not announce readiness within 30s");
	const response = await fetch(`${url}/api/location`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, signal: AbortSignal.timeout(10000) });
	assert.equal(response.status, 200, `Location activation failed (${response.status})`);
	// Native command surface: the plugin registers user-facing commands (model-free).
	const authHeader2 = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
	let fusionCommands;
	{
		const deadline2 = Date.now() + 30000;
		while (Date.now() < deadline2) {
			try {
				const commandList = await fetch(`${url}/api/command`, { headers: { authorization: authHeader2 }, signal: AbortSignal.timeout(10000) });
				const commandBody = await commandList.json();
				const names = (commandBody.data ?? []).map((entry) => entry.name);
				fusionCommands = names.filter((name) => typeof name === "string" && name.startsWith("fusion-"));
				if (fusionCommands.length >= 5) break;
			} catch {}
			await delay(100);
		}
	}
	assert.ok(fusionCommands && fusionCommands.length >= 5, `Fusion commands did not register: ${JSON.stringify(fusionCommands)}`);
	console.error("fusion commands:", fusionCommands.join(", "));
	// The command API can drive registered commands in a session (fusion-status is model-free).
	const commandSession = await fetch(`${url}/api/session`, { method: "POST", headers: { authorization: authHeader2, "content-type": "application/json" }, body: JSON.stringify({}) });
	assert.equal(commandSession.status, 200, `Command-probe session create failed (${commandSession.status})`);
	const commandSessionText = await commandSession.text();
	const commandSessionBody = JSON.parse(commandSessionText);
	const commandSessionID = commandSessionBody.id ?? commandSessionBody.data?.id;
	const commandInvoked = await fetch(`${url}/api/session/${commandSessionID}/command`, { method: "POST", headers: { authorization: authHeader2, "content-type": "application/json" }, body: JSON.stringify({ name: "fusion-status", text: "" }) });
	assert.ok(commandInvoked.status >= 200 && commandInvoked.status < 300, `fusion-status command invocation failed (${commandInvoked.status})`);
	let result;
	while (Date.now() < deadline) {
		try { result = JSON.parse(await readFile(join(project, "probe-result.json"), "utf8")); break; }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		await delay(50);
	}
	assert.ok(result, "Plugin setup did not produce a probe result");
	assert.equal(result.nativeFound, true, result.error);
	assert.equal(result.registered, true, result.error);
	assert.ok(result.catalogModels > 0 && result.catalogProviders > 0, `Host model catalog was empty (models: ${result.catalogModels})`);
	assert.equal(result.configureValidated, true, result.error);
	assert.equal(result.configureApplied, true, result.error);
	assert.equal(result.runStarted, true, result.error);
	assert.equal(result.nativeInvoked, true, result.error);
	assert.equal(result.recursiveRefused, true, result.error);
	console.log(JSON.stringify({ ...result, scope: "Fusion registration, run start/status/reset, native missing-parent rejection and recursive worker refusal; no model execution" }));
} finally {
	if (child && child.exitCode === null) {
		child.kill("SIGTERM");
		await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2000)]);
		if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve)); }
	}
	await rm(root, { recursive: true, force: true });
}
