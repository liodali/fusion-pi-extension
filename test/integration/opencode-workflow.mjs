// Opt-in live model test. All project and OpenCode state is disposable.
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
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
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
  const prompt = 'Test the Fusion workflow in this disposable directory. Use fusion_delegate execute to create fixture.txt containing exactly "alpha\\n". Then use fusion_delegate revise to change it to exactly "beta\\n". Then use fusion_delegate final_fix to change it to exactly "gamma\\n". Each step must be delegated to the same executor, even though this is a test. Review the file after each step. Finally report the outcome and call fusion_reset.';
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
  const result = { model, exitCode: code, fixture: contents, turns, tools: toolNames, eventTypes: [...new Set(events.map((event) => event.type))], errors, stderrPresent: !!stderr };
  console.log(JSON.stringify(result));
  assert.equal(code, 0, "OpenCode workflow exited unsuccessfully");
  assert.equal(contents, "gamma\n", "Executor did not complete all fixture changes");
  assert.deepEqual(turns.map((turn) => turn.action), ["execute", "revise", "final_fix"], "Expected three completed delegation actions");
  assert.ok(turns[0].childSessionID && turns.every((turn) => turn.childSessionID === turns[0].childSessionID), "Expected the same executor child for all turns");
  }
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
