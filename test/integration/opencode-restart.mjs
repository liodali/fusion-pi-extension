// Real local OpenCode process restart; native subagent completion is simulated.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = await mkdtemp(join(tmpdir(), "fusion-opencode-restart-"));
let child;
async function stop() {
	if (!child || child.exitCode !== null) return;
	const exiting = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	await Promise.race([exiting, delay(2000)]);
	if (child.exitCode === null) { child.kill("SIGKILL"); await exiting; }
}
try {
	const project = join(root, "project");
	await mkdir(join(project, ".opencode/plugins"), { recursive: true });
	await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
	await writeFile(join(project, ".opencode/plugins/restart-probe.ts"), `
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fusion from "../fusion/opencode/index.ts";
export default { id: "fusion-restart-probe", async setup(ctx) {
  const phaseFile = join(ctx.location.directory, "phase.json");
  const resultFile = join(ctx.location.directory, "result.json");
  try {
    let saved; try { saved = JSON.parse(await readFile(phaseFile, "utf8")); } catch {}
    let calls = 0, description = "";
    const parent = saved ? { id: saved.parent } : await ctx.session.create({});
    const child = saved ? { id: saved.child } : await ctx.session.create({ parentID: parent.id });
    const notification = saved && !saved.missing && { type: "synthetic", description: saved.description, metadata: { source: "subagent", childID: child.id, agent: "fusion-executor", state: "completed" }, text: '<subagent sessionID="' + child.id + '" state="completed" description="' + saved.description + '">\\nrecovered report\\n</subagent>' };
    const proxy = { ...ctx, session: { ...ctx.session, context: async () => notification ? [notification] : [] }, tool: { ...ctx.tool,
      list: async () => (await ctx.tool.list()).map((tool) => tool.id === "subagent" ? { ...tool, execute: async (input, toolContext) => { calls++; description = input.description; await toolContext.progress({ sessionID: child.id }); return { output: { sessionID: child.id, status: "running", output: "pending" } }; } } : tool)
    } };
    await fusion.setup(proxy);
    const tools = await ctx.tool.list();
    const toolContext = { sessionID: parent.id, agent: "fusion", messageID: "probe", id: "probe", signal: new AbortController().signal, progress: async () => {} };
    if (!saved) {
      const first = await tools.find((tool) => tool.id === "fusion_delegate").execute({ action: "execute", brief: "restart probe" }, toolContext);
      await writeFile(phaseFile, JSON.stringify({ version: ctx.app.version, parent: parent.id, child: child.id, description, status: first.metadata?.status, calls }));
    } else if (saved.missing) {
      const status = await tools.find((tool) => tool.id === "fusion_status").execute({}, toolContext);
      const state = JSON.parse(status.content);
      let refusal = "", blocked = false;
      try { await tools.find((tool) => tool.id === "fusion_reconcile").execute({}, toolContext); } catch (error) { refusal = String(error); blocked = true; }
      let resetRefusal = false;
      try { await tools.find((tool) => tool.id === "fusion_reset").execute({}, toolContext); } catch { resetRefusal = true; }
      const retry = await tools.find((tool) => tool.id === "fusion_delegate").execute({ action: "revise", brief: "retry" }, toolContext).catch((error) => String(error));
      await writeFile(resultFile, JSON.stringify({ uncertain: state.uncertain, child: state.childSessionID, blocked, refusal, resetRefusal, calls, retry: typeof retry === "string" ? retry : retry?.content }));
    } else {
      const status = await tools.find((tool) => tool.id === "fusion_status").execute({}, toolContext);
      const state = JSON.parse(status.content);
      const answer = await tools.find((tool) => tool.id === "fusion_reconcile").execute({}, toolContext);
      await tools.find((tool) => tool.id === "fusion_reset").execute({}, toolContext);
      await writeFile(resultFile, JSON.stringify({ uncertain: state.uncertain, child: state.childSessionID, answer: answer.content, calls }));
    }
  } catch (error) { await writeFile(resultFile, JSON.stringify({ error: String(error) })); }
} };
`);
	const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
	for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
	env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
	async function start() {
		child = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", error;
		child.on("error", (value) => { error = value; });
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-16384); });
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			if (error) throw error;
			if (child.exitCode !== null) throw new Error(`OpenCode exited before readiness (${child.exitCode})`);
			const url = output.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
			const password = output.match(/server password ([^\s]+)/)?.[1];
			if (url && password) {
				const response = await fetch(`${url}/api/location`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, signal: AbortSignal.timeout(10000) });
				assert.equal(response.status, 200); return;
			}
			await delay(50);
		}
		throw new Error("OpenCode startup timed out");
	}
	async function waitForFile(path) {
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
			if (child.exitCode !== null) throw new Error("OpenCode exited before the probe finished");
			await delay(50);
		}
		try { const error = JSON.parse(await readFile(join(project, "result.json"), "utf8")); throw new Error(error.error); } catch (error) { if (error.code !== "ENOENT") throw error; }
		throw new Error("OpenCode restart probe timed out");
	}
	await start();
	const first = await waitForFile(join(project, "phase.json"));
	assert.equal(first.status, "running"); assert.equal(first.calls, 1); assert.ok(first.parent && first.child && first.description);
	await stop();
	// Second restart: no completion notification exists for the still-running
	// child (the upstream process-local parent-completion gap), so reconciliation
	// must refuse, reset must stay blocked, and no native call may be made.
	await writeFile(join(project, "phase.json"), JSON.stringify({ ...first, missing: true }));
	await start();
	const missing = await waitForFile(join(project, "result.json"));
	if (missing.error) throw new Error(missing.error);
	assert.equal(missing.uncertain, true); assert.equal(missing.child, first.child); assert.equal(missing.calls, 0);
	assert.equal(missing.blocked, true); assert.ok(/No matching completion notification yet/.test(missing.refusal));
	assert.equal(missing.resetRefusal, true); assert.ok(/unknown outcome/.test(missing.retry ?? ""));
	await stop();
	// Third restart: the notification arrives (child finished), so remove the
	// missing marker, reconcile succeeds without another submission, and the
	// run settles.
	await writeFile(join(project, "phase.json"), JSON.stringify(first));
	await rm(join(project, "result.json"), { force: true });
	await start();
	const second = await waitForFile(join(project, "result.json"));
	if (second.error) throw new Error(second.error);
	assert.equal(second.uncertain, true); assert.equal(second.child, first.child); assert.equal(second.calls, 0); assert.ok(second.answer.includes("recovered report"));
	console.log(JSON.stringify({ version: first.version, processes: 3, restoredPending: true, sameChild: true, missingEvidence: { blocked: missing.blocked, resubmissions: missing.calls }, resubmissions: second.calls, reconciled: true, completion: "simulated native result and notification" }));
} finally { await stop(); await rm(root, { recursive: true, force: true }); }
