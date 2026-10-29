// Opt-in native background/restart probe. All project and OpenCode state is disposable.
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
const root = await mkdtemp(join(tmpdir(), "fusion-opencode-live-"));
let child;
try {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await mkdir(join(project, ".opencode/agents"), { recursive: true });
  await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
  await cp(join(repo, "examples/opencode/agents"), join(project, ".opencode/agents"), { recursive: true });
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), `
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fusion from "../fusion/opencode/index.ts";
export default { id: "fusion-live-restart-probe", async setup(ctx) {
 const marker = join(ctx.location.directory, "native-marker.json"), result = join(ctx.location.directory, "restart-result.json");
 let prior; try { prior = JSON.parse(await readFile(marker, "utf8")); } catch {}
 let submissions = 0;
 if (!prior) {
  await ctx.tool.hook("execute.before", (event) => { if (event.tool === "fusion_reconcile" || event.tool === "fusion_reset") throw new Error("Restart probe defers settlement until after restart."); });
  await ctx.tool.transform((editor) => editor.add({ name: "probe_wait", description: "Wait for the native background completion notification for the restart test.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false }, async execute() {
   const deadline = Date.now() + 55000;
   while (Date.now() < deadline) {
    let data; try { data = JSON.parse(await readFile(marker, "utf8")); } catch {}
    if (data?.parent && data?.child && data?.description) {
     const messages = await ctx.session.context({ sessionID: data.parent });
     if (messages.some((item) => item?.type === "synthetic" && item.description === data.description && item.metadata?.childID === data.child && item.metadata?.source === "subagent")) return { content: "The native completion notification is present. Stop for the restart test." };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
   }
   return { content: "No completion notification was observed during the wait." };
  } }));
 }
 const proxy = { ...ctx, tool: { ...ctx.tool, list: async () => (await ctx.tool.list()).map((tool) => tool.id !== "subagent" ? tool : { ...tool, execute: async (input, context) => {
   submissions++; const returned = await tool.execute({ ...input, background: true }, context);
   await writeFile(marker, JSON.stringify({ parent: context.sessionID, description: input.description, child: returned.output?.sessionID, nativeStatus: returned.output?.status }));
   return returned;
 } }) } };
 try {
  await fusion.setup(proxy);
  if (prior) {
   const tools = await ctx.tool.list();
   const context = { sessionID: prior.parent, agent: "fusion", messageID: "restart-probe", id: "restart-probe", signal: new AbortController().signal, progress: async () => {} };
   const status = await tools.find((tool) => tool.id === "fusion_status").execute({}, context);
   const messages = await ctx.session.context({ sessionID: prior.parent });
   const childMessages = await ctx.session.context({ sessionID: prior.child });
   const childShapes = childMessages.map((item) => ({ type: item?.type, role: item?.role, keys: Object.keys(item ?? {}), metadataKeys: Object.keys(item?.metadata ?? {}), finish: item?.finish, errorKeys: Object.keys(item?.error ?? {}), containsRequestDescription: typeof item?.text === "string" && item.text.includes(prior.description) }));
   const matching = messages.filter((item) => item && item.type === "synthetic" && item.description === prior.description && item.metadata?.childID === prior.child && item.metadata?.source === "subagent");
   let reconciled = false, error;
   try { await tools.find((tool) => tool.id === "fusion_reconcile").execute({}, context); reconciled = true; await tools.find((tool) => tool.id === "fusion_reset").execute({}, context); } catch (e) { error = String(e); }
   await writeFile(result, JSON.stringify({ status: JSON.parse(status.content), notificationFound: matching.length > 0, reconciled, error, submissions, childShapes }));
  }
 } catch (e) { await writeFile(result, JSON.stringify({ setupError: String(e), submissions })); }
} };
`);
  await writeFile(join(project, ".opencode/plugins/fusion-observer.ts"), `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "fusion-workflow-observer", async setup(ctx) {
  const turns = [];
  await ctx.tool.hook("execute.after", async (event) => {
    if (event.tool !== "fusion_delegate" || event.status !== "completed") return;
    turns.push({ action: event.result.metadata?.action, childSessionID: event.result.metadata?.childSessionID });
    await writeFile(join(ctx.location.directory, "observer.json"), JSON.stringify(turns));
  });
} };
`);
  await writeFile(join(project, "opencode.json"), JSON.stringify({ permissions: [
    ...["shell", "external_directory", "webfetch", "websearch", "skill", "glob", "grep", "read", "edit"].map((action) => ({ action, resource: "*", effect: "deny" })),
    ...["read", "edit"].flatMap((action) => ["fixture.txt", "*/fixture.txt"].map((resource) => ({ action, resource, effect: "allow" }))),
  ] }));
  const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
  env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
  await mkdir(join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
  // Copy only credentials, never the user's database, plugins, or project config.
  const provider = model.split("/")[0];
  let auth = {};
  try { auth = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8")); } catch {}
  if (auth[provider]) await writeFile(join(env.XDG_DATA_HOME, "opencode/auth.json"), JSON.stringify({ [provider]: auth[provider] }), { mode: 0o600 });
  // OpenCode v2 uses account.json for active integrations; retain only this provider.
  let account;
  try { account = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/account.json"), "utf8")); } catch {}
  const accountID = account?.active?.[provider];
  const selectedAccount = accountID && account?.accounts?.[accountID];
  if (selectedAccount) await writeFile(join(env.XDG_DATA_HOME, "opencode/account.json"), JSON.stringify({ version: account.version, accounts: { [accountID]: selectedAccount }, active: { [provider]: accountID } }), { mode: 0o600 });
  // V2 stores active credentials in its database. Read only the requested
  // provider's active value; never copy the database into the fixture.
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
  if (process.env.FUSION_OPENCODE_LIST_MODELS === "1") {
    const catalog = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["models", "--standalone"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    catalog.stdout.on("data", (data) => { output += data; });
    const code = await new Promise((res, rej) => { catalog.on("error", rej); catalog.on("exit", res); });
    console.log(JSON.stringify({ provider, code, models: output.split("\n").filter((line) => line.includes(provider)).slice(0, 100) }));
    process.exitCode = code ?? 1;
  } else {
  const prompt = 'Use fusion_delegate execute to create fixture.txt containing exactly "alpha\\n". After it responds, call probe_wait once to wait for the native completion notification. Then stop without calling fusion_reconcile, fusion_reset, or submitting another task.';
  child = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["run", "--standalone", "--auto", "--agent", "fusion", "--model", model, "--format", "json", prompt], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  let killTimer;
  const timeout = setTimeout(() => { child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 5000); }, 240000);
  const code = await new Promise((res, rej) => { child.on("error", rej); child.on("exit", res); });
  clearTimeout(timeout);
  clearTimeout(killTimer);
  // The CLI output can include provider diagnostics. Do not print it verbatim.
  const events = stdout.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const toolNames = events.flatMap((event) => [event.tool, event.part?.tool, event.part?.name].filter((v) => typeof v === "string"));
  let contents;
  try { contents = await readFile(join(project, "fixture.txt"), "utf8"); } catch {}
  let turns = [];
  try { turns = JSON.parse(await readFile(join(project, "observer.json"), "utf8")); } catch {}
  const secrets = [...Object.values(auth[provider] ?? {}), ...Object.values(selectedAccount?.credential ?? {}), ...Object.values(databaseCredential ?? {}), goKey].filter((value) => typeof value === "string" && value.length > 12);
  const redact = (value) => secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
  const errors = events.filter((event) => event.type === "error").map((event) => redact(JSON.stringify(event.error ?? event).slice(0, 1000)));
  assert.equal(code, 0, "Initial OpenCode process failed");
  const marker = JSON.parse(await readFile(join(project, "native-marker.json"), "utf8"));
  assert.equal(marker.nativeStatus, "running", "Native subagent did not enter background");
  assert.ok(marker.parent && marker.child && marker.description);
  // Start a second real OpenCode process against the same isolated state.
  child = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let startup = "", spawnError;
  child.on("error", (error) => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { startup = (startup + data.toString()).slice(-16384); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Restarted OpenCode exited before readiness (${child.exitCode})`);
    const url = startup.match(new RegExp("server listening on (http://[^\\s]+)"))?.[1];
    const password = startup.match(/server password ([^\s]+)/)?.[1];
    if (url && password) {
      const response = await fetch(`${url}/api/location`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200); break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  let restart;
  while (Date.now() < deadline) {
    try { restart = JSON.parse(await readFile(join(project, "restart-result.json"), "utf8")); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(restart, "Restart probe timed out");
  console.log(JSON.stringify({ model, fixture: contents, firstTools: toolNames, nativeStatus: marker.nativeStatus, childRestored: restart.status?.childSessionID === marker.child, uncertain: restart.status?.uncertain, notificationFound: restart.notificationFound, reconciled: restart.reconciled, resubmissions: restart.submissions, error: redact(String(restart.error ?? restart.setupError ?? "")), childShapes: restart.childShapes, errors, stderrPresent: !!stderr }));
  assert.equal(contents, "alpha\n", "Native background worker did not finish its edit");
  assert.equal(restart.status?.uncertain, true);
  assert.equal(restart.status?.childSessionID, marker.child);
  assert.equal(restart.submissions, 0);
  assert.equal(restart.notificationFound, true, "Exact native completion notification missing after restart");
  assert.equal(restart.reconciled, true, "Native completion reconciliation failed");
  }
} finally {
  if (child && child.exitCode === null) { const exiting = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGKILL"); await exiting; }
  await rm(root, { recursive: true, force: true });
}
