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
    const result = { version: ctx.app.version, nativeFound: false, registered: false, nativeInvoked: false };
    try {
      const native = (await ctx.tool.list()).find((tool) => tool.id === "subagent");
      if (!native || typeof native.execute !== "function") throw new Error("Native subagent executor is unavailable");
      result.nativeFound = true;
      await fusion.setup(ctx);
      const registered = await ctx.tool.list();
      const delegate = registered.find((tool) => tool.id === "fusion_delegate");
      result.registered = !!delegate && registered.some((tool) => tool.id === "fusion_status") && registered.some((tool) => tool.id === "fusion_reset");
      if (!result.registered) throw new Error("Fusion tools did not register");
      try {
        await delegate.execute({ action: "execute", brief: "Probe only" }, { sessionID: "ses_fusion_probe_missing", agent: "fusion", messageID: "msg_probe", id: "call_probe", signal: new AbortController().signal, progress: async () => {} });
        throw new Error("Missing-parent call unexpectedly succeeded");
      } catch (error) {
        if (!String(error).includes("Parent session not found")) throw error;
        result.nativeInvoked = true;
      }
    } catch (error) { result.error = String(error); }
    await writeFile(join(ctx.location.directory, "probe-result.json"), JSON.stringify(result));
  },
};
`);
	// Keep user configuration, stored credentials, and provider environment keys out.
	const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
	for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
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
	let result;
	while (Date.now() < deadline) {
		try { result = JSON.parse(await readFile(join(project, "probe-result.json"), "utf8")); break; }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		await delay(50);
	}
	assert.ok(result, "Plugin setup did not produce a probe result");
	assert.equal(result.nativeFound, true, result.error);
	assert.equal(result.registered, true, result.error);
	assert.equal(result.nativeInvoked, true, result.error);
	console.log(JSON.stringify({ ...result, scope: "Fusion plugin registration + native missing-parent rejection; no model execution" }));
} finally {
	if (child && child.exitCode === null) {
		child.kill("SIGTERM");
		await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2000)]);
		if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve)); }
	}
	await rm(root, { recursive: true, force: true });
}
