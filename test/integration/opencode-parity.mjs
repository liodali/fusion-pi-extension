// Opt-in live parity run (consumes model usage). Drives the full Fusion
// protocol through the USER-FACING controls only: /fusion-run, /fusion-status,
// /fusion-stats, /fusion-resume, /fusion-clean, /fusion-mode. Configure runs
// through the plugin API before any run (no user-facing configure command
// exists by design); everything the model does flows from the run prompt.
// Supersedes the failed 2026-10-30 CLI workflow run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Database } from "bun:sqlite";

const model = process.env.FUSION_OPENCODE_MODEL || "opencode-go/glm-5.3-flash";
const [modelRef, variant] = model.split("#");
const [provider, modelId] = modelRef.split("/");
if (!provider || !modelId) throw new Error(`FUSION_OPENCODE_MODEL must be provider/model, got ${model}`);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = await mkdtemp(join(tmpdir(), "fusion-opencode-parity-"));
const result = { model, steps: [], usageEvents: 0, configure: null, runs: [], errors: [] };
let child;
let startup = "";
let observerPath;
try {
  const project = join(root, "project");
  await mkdir(join(project, ".opencode/plugins"), { recursive: true });
  await mkdir(join(project, ".opencode/agents"), { recursive: true });
  await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
  await cp(join(repo, "examples/opencode/agents"), join(project, ".opencode/agents"), { recursive: true });
  await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
  // Loads after the Fusion plugin (name ordering): configures the executor
  // model against the live catalog before any run, and observes the bus and
  // Fusion tool calls as in-process evidence.
  await writeFile(join(project, ".opencode/plugins/z-parity-observer.ts"), `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "fusion-parity-observer", async setup(ctx) {
  // Every recorded entry carries a shared monotonic sequence number: the
  // fixture scopes summary text and review/audit evidence to run windows by
  // sequence, so a reused session can never serve a previous run's evidence.
  const record = { n: 0, configure: null, sessionSurface: { prompt: "missing", switchAgent: "missing", synthetic: "missing" }, timeline: [], failedCalls: [], textsEntries: [], terminals: [], usageEvents: 0, failed: [] };
  let seq = 0;
  record.sessionSurface = { prompt: typeof ctx.session.prompt, switchAgent: typeof ctx.session.switchAgent, synthetic: typeof ctx.session.synthetic };
  const write = async () => { record.n = seq; await writeFile(join(ctx.location.directory, "parity-observer.json"), JSON.stringify(record)); };
  await ctx.tool.hook("execute.after", async (event) => {
    if (typeof event.tool !== "string") return;
    const entry = { n: ++seq, tool: event.tool, sessionID: event.sessionID ?? null, status: event.status ?? null, input: event.input === undefined ? null : JSON.stringify(event.input).slice(0, 400), result: JSON.stringify(event.result ?? null).slice(0, 1200), action: event.result?.metadata?.action ?? null, child: event.result?.metadata?.childSessionID ?? null };
    if (event.status === "completed") record.timeline.push(entry);
    else if (event.tool.startsWith("fusion_")) record.failedCalls.push(entry);
    await write();
  });
  await ctx.command.transform(async (editor) => {
    editor.add({ name: "parity-echo", description: "Report the session a command executes in", execute: async (args) => {
      await ctx.session.synthetic({ sessionID: args.sessionID, description: "Parity echo", text: JSON.stringify({ sessionID: args.sessionID }), resume: false });
      return "ok";
    } });
  });
  const stream = ctx.event.subscribe();
  void (async () => { for await (const event of stream) { try {
    if (event?.type === "session.usage.updated") { record.usageEvents++; await write(); continue; }
    if (typeof event?.type === "string" && event.type.startsWith("session.execution.")) {
      record.terminals.push({ n: ++seq, type: event.type, sessionID: event.data?.sessionID ?? null });
      if (event.type === "session.execution.failed") record.failed.push(event.data ?? {});
      await write();
    }
    if (event?.type === "session.text.ended" && event.data?.sessionID && typeof event.data?.text === "string") {
      record.textsEntries.push({ n: ++seq, sessionID: event.data.sessionID, text: event.data.text });
      await write();
    }
  } catch {} } })();
  try {
    const tools = await ctx.tool.list();
    const configure = tools.find((tool) => tool.id === "fusion_configure");
    if (!configure) throw new Error("fusion_configure was not registered before the observer loaded");
    const probe = await ctx.session.create({});
    const toolContext = { sessionID: probe.id, agent: "fusion", messageID: "msg_parity_configure", id: "call_parity_configure", signal: new AbortController().signal, progress: async () => {} };
    const configured = await configure.execute({ provider: ${JSON.stringify(provider)}, model: ${JSON.stringify(modelId)}${variant ? `, variant: ${JSON.stringify(variant)}` : ""} }, toolContext);
    record.configure = { applied: configured.metadata?.applied ?? null, model: configured.metadata?.model ?? null };
  } catch (error) { record.configure = { error: String(error) }; }
  await write();
} };
`);
  await writeFile(join(project, "opencode.json"), JSON.stringify({ permissions: [
    ...["shell", "external_directory", "webfetch", "websearch", "skill", "glob", "grep", "read", "edit"].map((action) => ({ action, resource: "*", effect: "deny" })),
    ...["read", "edit"].flatMap((action) => ["fixture.txt", "second.txt", "*/fixture.txt", "*/second.txt"].map((resource) => ({ action, resource, effect: "allow" }))),
  ] }));
  const env = Object.fromEntries(["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "SYSTEMROOT"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
  env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
  await mkdir(join(env.XDG_DATA_HOME, "opencode"), { recursive: true });
  // Credentials only, never the user's sessions, plugins, or project config.
  let auth = {};
  try { auth = JSON.parse(await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8")); } catch {}
  let providerCredentialRow = null;
  let accountCredentialRow = null;
  let db;
  try {
    db = new Database(join(homedir(), ".local/share/opencode/opencode.db"), { readonly: true });
    // Gateway models (opencode-go) need two credentials: the provider key that
    // authenticates the model, and the opencode account credential whose
    // workspace policy allows training-paid gateway models in serve mode. A
    // provider key alone is rejected by the gateway in serve mode.
    const providerRows = db.query("SELECT id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated FROM credential WHERE integration_id = ? AND active = 1").all(provider);
    if (providerRows.length > 1) throw new Error(`Multiple active credentials for ${provider}`);
    if (providerRows.length === 1) providerCredentialRow = providerRows[0];
    const accountRows = db.query("SELECT id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated FROM credential WHERE integration_id = 'opencode' AND active = 1").all();
    if (accountRows.length === 1) accountCredentialRow = accountRows[0];
  } catch (error) {
    if (!String(error).includes("unable to open database file") && !String(error).includes("no such table")) throw error;
  } finally { db?.close(); }
  const bootServer = async () => {
    child = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let bootError;
    let bootLog = "";
    child.on("error", (error) => { bootError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { const text = data.toString(); bootLog = (bootLog + text).slice(-8192); startup = (startup + text).slice(-16384); });
    const ready = Date.now() + 30000;
    while (Date.now() < ready) {
      if (bootError) throw bootError;
      if (child.exitCode !== null) throw new Error(`OpenCode exited before readiness (${child.exitCode}): ${bootLog.slice(-400)}`);
      const url = bootLog.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
      const password = bootLog.match(/server password ([^\s]+)/)?.[1];
      if (url && password) return { url, password };
      await delay(50);
    }
    throw new Error(`OpenCode did not announce readiness within 30s: ${bootLog.slice(-400)}`);
  };
  const stopServer = async () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve)); }
  };
  let goKey;
  if (accountCredentialRow && providerCredentialRow) {
    // Two-phase boot: the server first creates and migrates its fixture
    // database naturally; then only the two credential rows are inserted
    // (never any user data), and the real boot picks them up. Pinned live on
    // v2.2.5: the provider key plus the account credential together satisfy
    // the gateway's serve-mode workspace policy.
    await bootServer();
    await stopServer();
    const target = new Database(join(env.XDG_DATA_HOME, "opencode/opencode.db"));
    try {
      const insert = target.prepare("INSERT INTO credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const row of [providerCredentialRow, accountCredentialRow]) insert.run(row.id, row.integration_id, row.label, row.value, row.connector_id, row.method_id, row.active ?? 1, row.time_created, row.time_updated);
    } finally { target.close(); }
    result.credential = "account+provider";
  } else {
    if (auth[provider]) await writeFile(join(env.XDG_DATA_HOME, "opencode/auth.json"), JSON.stringify({ [provider]: auth[provider] }), { mode: 0o600 });
    goKey = process.env.OPENCODE_API_KEY ?? (providerCredentialRow ? JSON.parse(providerCredentialRow.value).key : undefined) ?? auth[provider]?.key;
    assert.ok(auth[provider] || providerCredentialRow || (provider === "opencode-go" && goKey), `No OpenCode credential for provider ${provider}`);
    if (provider === "opencode-go" && goKey) env.OPENCODE_API_KEY = goKey;
    result.credential = process.env.OPENCODE_API_KEY ? "env" : providerCredentialRow ? "database" : auth[provider] ? "auth.json" : "none";
  }
  const { url, password } = await bootServer();
  const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const post = (path, body) => fetch(`${url}${path}`, { method: "POST", headers: { authorization: authHeader, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const get = (path) => fetch(`${url}${path}`, { headers: { authorization: authHeader }, signal: AbortSignal.timeout(15000) });
  const activated = await get("/api/location");
  assert.equal(activated.status, 200, `Location activation failed (${activated.status})`);
  observerPath = join(project, "parity-observer.json");  const readObserver = async () => { try { return JSON.parse(await readFile(observerPath, "utf8")); } catch { return null; } };
  {
    const observerDeadline = Date.now() + 30000;
    let observer;
    while (Date.now() < observerDeadline) { observer = await readObserver(); if (observer?.configure) break; await delay(200); }
    assert.ok(observer?.configure, "Parity observer did not load");
    assert.ok(!observer.configure.error, `Configure failed: ${observer.configure.error}`);
    assert.equal(observer.configure.applied, "now", `Configure did not apply to the run handle: ${JSON.stringify(observer.configure)}`);
    result.configure = observer.configure;
    result.sessionSurface = observer.sessionSurface;
  }
  const created = await post("/api/session", { model: { providerID: provider, id: modelId }, ...(variant ? { variant } : {}) });
  assert.equal(created.status, 200, `Session create failed (${created.status})`);
  const sessionBody = await created.json();
  const sessionID = sessionBody.id ?? sessionBody.data?.id;
  assert.ok(typeof sessionID === "string" && sessionID, `Session create returned no ID: ${JSON.stringify(sessionBody).slice(0, 200)}`);
  result.sessionID = sessionID;
  const commandOn = async (sid, name, text) => {
    const invoked = await post(`/api/session/${sid}/command`, { name, text });
    if (!invoked.ok) {
      const body = await invoked.text().catch(() => "");
      throw new Error(`${name} invocation failed (${invoked.status}): ${body.slice(0, 400)}`);
    }
  };
  const latestPayloadOn = async (sid, description) => {
    const inbox = await (await get(`/api/session/${sid}/inbox`)).json();
    const entries = (inbox.data ?? []).filter((entry) => entry.type === "synthetic" && entry.payload?.description === description);
    return entries.length ? entries[entries.length - 1].payload : undefined;
  };
  const commandPayloadOn = async (sid, name, description, text = "") => {
    await commandOn(sid, name, text);
    for (let attempt = 0; attempt < 40; attempt++) {
      const payload = await latestPayloadOn(sid, description);
      if (payload) return payload;
      await delay(250);
    }
    throw new Error(`${name} output never arrived in the inbox of ${sid}`);
  };
  const statusJsonOn = async (sid) => {
    const payload = await commandPayloadOn(sid, "fusion-status", "Fusion status");
    try { return JSON.parse(payload.text); } catch { throw new Error(`fusion-status output was not JSON (${sid}): ${payload.text.slice(0, 200)}`); }
  };
  // v2.2.5 pinned live: the host may run the prompted supervisor turn in a
  // session distinct from the one the command was issued in. The supervisor
  // session is discovered from the first execution start after /fusion-run.
  const issueRun = async (sid, task) => {
    const before = new Set(((await readObserver())?.terminals ?? []).map((terminal) => terminal.sessionID));
    await commandOn(sid, "fusion-run", task);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const terminals = ((await readObserver())?.terminals ?? []).filter((terminal) => terminal.type === "session.execution.started");
      const fresh = terminals.find((terminal) => !before.has(terminal.sessionID));
      if (fresh) return fresh.sessionID;
      await delay(300);
    }
    throw new Error("No session started a turn after /fusion-run");
  };
  // The host's command/prompt session semantics (which session a command
  // executes in, and which session runs the prompted turn) are pinned
  // empirically: status is probed against every candidate session — the
  // discovered supervisor, the issuing session, and every session that made a
  // Fusion tool call — until one reports ITS OWN run.
  const probeStatus = async (label) => {
    const candidates = [...new Set([label.current, label.issuer, ...((await readObserver())?.timeline ?? []).map((call) => call.sessionID).filter(Boolean)])];
    const failures = [];
    for (const sid of candidates) {
      const payload = await commandPayloadOn(sid, "fusion-status", "Fusion status");
      try {
        const parsed = JSON.parse(payload.text);
        if (parsed.runId && (!parsed.owner || parsed.owner.supervisorId === sid)) { label.current = sid; return parsed; }
        failures.push(`${sid}: ${payload.text.slice(0, 80)}`);
      } catch { failures.push(`${sid}: ${payload.text.slice(0, 80)}`); }
    }
    // A run the supervisor itself reset after delivering its summary is a
    // completed protocol, not a probe failure — scoped to THIS run's
    // supervising session and its sequence window (strictly after the
    // boundary), so a previous run's summary cannot satisfy it.
    if (((await readObserver())?.textsEntries ?? []).some((entry) => entry.sessionID === label.current && entry.n > (label.startN ?? -1) && String(entry.text).includes("## Fusion summary"))) return { runActive: false, resetBySupervisor: true };
    throw new Error(`No session owns a Fusion run (${failures.join(" | ")})`);
  };
  // Wait for the run to settle: one status probe per observed turn end (any
  // session — executor children end turns too). A supervisor turn that stays
  // silent well after its delegation settled is the upstream parent-completion
  // gap (anomalyco/opencode#36349): report it as stuck for recovery.
  const waitForSettled = async (name, control, deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    let observer = await readObserver();
    const startBaseline = observer.terminals.length;
    let baseline = startBaseline;
    let last;
    let lastEvent = Date.now();
    while (Date.now() < deadline) {
      const turnDeadline = Date.now() + Math.min(deadline - Date.now(), 300000);
      let silent = 0;
      for (;;) {
        observer = await readObserver();
        if (observer.terminals.length > baseline) { baseline = observer.terminals.length; lastEvent = Date.now(); break; }
        silent = Date.now() - lastEvent;
        if (silent > 150000) {
          const probe = await probeStatus(control).catch((error) => ({ probeError: String(error) }));
          if (!probe.probeError && probe.runActive && probe.phase !== "complete" && probe.executed && !probe.delegating) return { stuck: true, status: probe, observer };
          lastEvent = Date.now();
        }
        if (Date.now() > turnDeadline) throw new Error(`${name}: no turn ended within 300s (last status: ${JSON.stringify(last).slice(0, 300)})`);
        await delay(500);
      }
      last = await probeStatus(control);
      result.steps.push({ label: name, terminal: baseline, controlSession: control.current, runActive: last.runActive, incomplete: last.incomplete ?? false, uncertain: last.uncertain ?? false, nextAction: last.nextAction });
      // A settled run deactivates in ephemeral mode and stays armed with phase
      // "complete" in persistent mode; both are completion.
      if (last.runActive === false || last.phase === "complete") return { status: last, observer };
      if (last.incomplete || last.uncertain) throw new Error(`${name} ended unhealthy: ${JSON.stringify(last).slice(0, 500)}`);
      if (baseline - startBaseline > 12) throw new Error(`${name} needed more turns than the settle budget allows: ${JSON.stringify(last).slice(0, 400)}`);
    }
    throw new Error(`${name} did not settle within ${deadlineMs}ms (last: ${JSON.stringify(last).slice(0, 400)})`);
  };
  // Drive one full protocol run through /fusion-run, recovering once from the
  // upstream parent-completion gap by interrupting the stuck supervisor turn,
  // cleaning the settled run, and reissuing.
  const driveRun = async (name, issuer, task) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const timelineFrom = ((await readObserver())?.timeline ?? []).length;
      const startN = ((await readObserver())?.n ?? 0);
      const supervisor = await issueRun(issuer, task);
      const control = { current: supervisor, issuer, startN };
      const outcome = await waitForSettled(`${name} (attempt ${attempt})`, control, 480000);
      if (!outcome.stuck) return { ...outcome, control, timelineFrom, startN };
      result.steps.push({ label: name, attempt, stuck: true, recovery: "interrupt + clean + reissue (upstream parent-completion gap)" });
      const interrupted = await fetch(`${url}/api/session/${supervisor}/interrupt`, { method: "POST", headers: { authorization: authHeader, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15000) });
      result.steps.push({ label: name, attempt, interruptStatus: interrupted.status });
      await delay(5000);
      try { result.steps.push({ label: name, attempt, cleanAfterStuck: (await commandPayloadOn(control.current, "fusion-clean", "Fusion clean")).text }); }
      catch (error) { result.steps.push({ label: name, attempt, cleanAfterStuck: String(error) }); }
      await delay(1000);
    }
    throw new Error(`${name}: the supervisor turn repeatedly failed to complete after its executor child (upstream parent-completion gap, anomalyco/opencode#36349)`);
  };
  // Read-evidence parsing: the claimed review/audit must target the exact
  // fixture path (basename match, so unrelated files like fixture-notes.md
  // cannot qualify) and the captured result must show the file's staged
  // content for that protocol step — review verifies the executed state,
  // the requirements audit re-reads the staged state it audits.
  const readTarget = (entry) => {
    try {
      const strings = [];
      const walk = (node, depth) => { if (node === null || typeof node !== "object" || depth > 3) { if (typeof node === "string") strings.push(node); return; } for (const value of Object.values(node)) walk(value, depth + 1); };
      walk(JSON.parse(entry.input ?? "null"), 0);
      return strings.map((value) => value.replace(/\\/g, "/").split("/").pop()).find((base) => base === "fixture.txt" || base === "second.txt") ?? null;
    } catch { return null; }
  };
  const readResult = (entry) => {
    try { const parsed = JSON.parse(entry.result ?? "null"); return typeof parsed === "string" ? parsed : JSON.stringify(parsed); }
    catch { return String(entry.result ?? ""); }
  };
  const task1 = 'Start with one fusion_scout question about this workspace. Then run the full Fusion protocol to create fixture.txt containing exactly "alpha" followed by a single newline. Review the file, revise it to exactly "beta" followed by a single newline, audit it against this instruction, and apply the final fix so it contains exactly "gamma" followed by a single newline. Finish with the Fusion summary. Do NOT call fusion_reset afterwards: leave the finished run in place for the user to inspect.';
  const run1 = await driveRun("run 1", sessionID, task1);
  result.supervisor1 = run1.control.current;
  const control1 = run1.control;
  const observer1 = run1.observer;
  const timeline1 = observer1.timeline.slice(run1.timelineFrom);
  result.usageEvents = observer1.usageEvents;
  const fixture = await readFile(join(project, "fixture.txt"), "utf8");
  // Delegation evidence and the protocol's review/audit windows are asserted
  // against THIS run's observed tool sequence only, in the shared sequence
  // space, and the reads must target the changed fixture file — an unrelated
  // search or a directory listing cannot satisfy the claimed review or
  // acceptance audit.
  const delegates1 = timeline1.filter((entry) => entry.tool === "fusion_delegate" && entry.status === "completed");
  const actions = delegates1.map((entry) => entry.action);
  const children = [...new Set(delegates1.filter((call) => call.child).map((call) => call.child))];
  const execute1 = timeline1.find((entry) => entry.tool === "fusion_delegate" && entry.action === "execute");
  const revise1 = timeline1.find((entry) => entry.tool === "fusion_delegate" && entry.action === "revise");
  const finalFix1 = timeline1.find((entry) => entry.tool === "fusion_delegate" && entry.action === "final_fix");
  const fixtureReads1 = timeline1.filter((entry) => entry.tool === "read" && entry.sessionID === control1.current && readTarget(entry) === "fixture.txt");
  // Review: a read of the changed fixture whose captured result shows the
  // executed stage; audit: a distinct read showing the staged state the
  // requirements audit re-examines before the final fix.
  const review1 = execute1 !== undefined && revise1 !== undefined && fixtureReads1.some((read) => read.n > execute1.n && read.n < revise1.n && readResult(read).includes("alpha"));
  const audit1 = revise1 !== undefined && finalFix1 !== undefined && fixtureReads1.some((read) => read.n > revise1.n && read.n < finalFix1.n && readResult(read).includes("beta"));
  const summary1 = (observer1.textsEntries ?? []).filter((entry) => entry.sessionID === control1.current && entry.n > (run1.startN ?? -1) && String(entry.text).includes("## Fusion summary"));
  result.runs.push({ task: 1, fixture, actions, children, scout: timeline1.some((call) => call.tool === "fusion_scout"), summary: summary1.length > 0, reviewBetweenExecuteAndRevise: review1, auditBetweenReviseAndFinalFix: audit1 });
  assert.equal(fixture, "gamma\n", `Run 1 fixture content was ${JSON.stringify(fixture)}`);
  assert.deepEqual(actions, ["execute", "revise", "final_fix"], `Run 1 delegation sequence was ${JSON.stringify(actions)}`);
  assert.ok(result.runs[0].scout, "Run 1 made no fusion_scout call");
  assert.equal(children.length, 1, `Run 1 used executor children ${children.join(", ")}`);
  assert.ok(result.runs[0].summary, "Run 1 final turn did not carry the Fusion summary heading");
  assert.ok(result.runs[0].reviewBetweenExecuteAndRevise, "Run 1 performed no supervisor file review between its execute and revise delegations");
  assert.ok(result.runs[0].auditBetweenReviseAndFinalFix, "Run 1 performed no supervisor acceptance audit between its revise and final_fix delegations");
  assert.ok(observer1.usageEvents > 0, "No session.usage.updated events were observed on the bus");
  // Stats parity: real usage totals from observed readings.
  const stats1 = JSON.parse((await commandPayloadOn(control1.current, "fusion-stats", "Fusion stats")).text);
  result.stats1 = stats1.usage;
  assert.equal(stats1.usage.available, true, `Run 1 usage was unavailable: ${JSON.stringify(stats1.usage)}`);
  assert.ok(stats1.usage.inputTokens > 0, `Run 1 input tokens were ${stats1.usage.inputTokens}`);
  assert.ok(stats1.usage.turns.reported >= 3, `Run 1 reported turns were ${JSON.stringify(stats1.usage.turns)}`);
  // Cross-session recovery presentation (the M6.5 deferred item): a session
  // that does not own the run sees the not-attached record with the owning
  // run's identity, refused reattachment, and explicit operator resolution.
  if (run1.status.runId) {
    const otherCreated = await post("/api/session", {});
    assert.equal(otherCreated.status, 200, `Second session create failed (${otherCreated.status})`);
    const otherBody = await otherCreated.json();
    const otherSessionID = otherBody.id ?? otherBody.data?.id;
    assert.ok(typeof otherSessionID === "string", "Second session create returned no ID");
    const resumeOther = JSON.parse((await commandPayloadOn(otherSessionID, "fusion-resume", "Fusion resume")).text);
    result.resumeOtherSession = { runId: resumeOther.runId, owner: resumeOther.owner, activeTurnReattach: resumeOther.activeTurnReattach, nextAction: resumeOther.nextAction };
    assert.ok(String(resumeOther.message).includes("not attached to this session"), `Cross-session resume said ${JSON.stringify(resumeOther).slice(0, 300)}`);
    assert.equal(resumeOther.runId, run1.status.runId, "Cross-session resume did not report the owning run");
    assert.equal(resumeOther.owner?.supervisorId, control1.current, "Cross-session resume did not report the owning session");
    assert.equal(resumeOther.activeTurnReattach, "refused");
    assert.ok(String(resumeOther.nextAction).includes("bun src/workspace/resolve.ts"), `Cross-session resume nextAction was ${resumeOther.nextAction}`);
  } else { result.skipCrossSessionProbe = true; }
  // Resume parity: recovery presentation refuses reattachment, nothing owed.
  const resume1 = JSON.parse((await commandPayloadOn(control1.current, "fusion-resume", "Fusion resume")).text);
  result.resume1 = { activeTurnReattach: resume1.activeTurnReattach, nextAction: resume1.nextAction };
  assert.equal(resume1.activeTurnReattach, "refused");
  assert.ok(resume1.nextAction.includes("No recovery is owed"), `Run 1 resume nextAction was ${resume1.nextAction}`);
  const clean1 = (await commandPayloadOn(control1.current, "fusion-clean", "Fusion clean")).text;
  result.clean1 = clean1;
  assert.ok(clean1.includes("Released Fusion resources for this session.") || clean1.includes("Released settled Fusion ownership for this workspace."), `Run 1 clean said ${clean1}`);
  const resume2 = (await commandPayloadOn(control1.current, "fusion-resume", "Fusion resume")).text;
  result.resumeAfterClean = resume2;
  assert.equal(resume2, "No Fusion run in this session.", `Resume after clean said ${resume2}`);
  // Persistent mode + a new run through the same controls.
  const modeOn = (await commandPayloadOn(control1.current, "fusion-mode", "Fusion mode", "on")).text;
  result.modeOn = modeOn;
  assert.ok(modeOn.includes("persistent mode enabled"), `Mode on said ${modeOn}`);
  const task2 = 'Run the Fusion protocol to create second.txt containing exactly "delta" followed by a single newline, review the file, and finish with the Fusion summary. Complete the entire protocol in this single turn without ending your response early. Do NOT call fusion_reset afterwards: leave the finished run in place for the user to inspect.';
  const run2 = await driveRun("run 2", control1.current, task2);
  result.supervisor2 = run2.control.current;
  const control2 = run2.control;
  const observer2 = run2.observer;
  const calls2 = observer2.timeline.slice(run2.timelineFrom);
  const second = await readFile(join(project, "second.txt"), "utf8");
  const actions2 = calls2.filter((call) => call.tool === "fusion_delegate" && call.status === "completed").map((call) => call.action);
  const execute2 = calls2.find((call) => call.tool === "fusion_delegate" && call.action === "execute");
  const secondReads2 = calls2.filter((call) => call.tool === "read" && call.sessionID === control2.current && readTarget(call) === "second.txt");
  const review2 = execute2 !== undefined && secondReads2.some((read) => read.n > execute2.n && readResult(read).includes("delta"));
  const summary2 = (observer2.textsEntries ?? []).filter((entry) => entry.sessionID === control2.current && entry.n > (run2.startN ?? -1) && String(entry.text).includes("## Fusion summary"));
  result.runs.push({ task: 2, fixture: second, actions: actions2, children: [...new Set(calls2.filter((call) => call.tool === "fusion_delegate" && call.child).map((call) => call.child))], scout: calls2.some((call) => call.tool === "fusion_scout"), summary: summary2.length > 0, reviewAfterExecute: review2 });
  assert.equal(second, "delta\n", `Run 2 second.txt content was ${JSON.stringify(second)}`);
  assert.ok(actions2.length > 0 && actions2[0] === "execute", `Run 2 delegation sequence was ${JSON.stringify(actions2)}`);
  assert.ok(result.runs[1].reviewAfterExecute, "Run 2 performed no supervisor file review of second.txt after its execute delegation");
  assert.ok(result.runs[1].summary, "Run 2 final turn did not carry the Fusion summary heading");
  const stats2 = JSON.parse((await commandPayloadOn(control2.current, "fusion-stats", "Fusion stats")).text);
  result.stats2 = stats2.usage;
  assert.equal(stats2.usage.available, true, `Run 2 usage was unavailable: ${JSON.stringify(stats2.usage)}`);
  assert.ok(stats2.usage.inputTokens > 0, `Run 2 input tokens were ${stats2.usage.inputTokens}`);
  const modeOff = (await commandPayloadOn(control2.current, "fusion-mode", "Fusion mode", "off")).text;
  result.modeOff = modeOff;
  assert.ok(modeOff.includes("persistent mode disabled"), `Mode off said ${modeOff}`);
  const clean2 = (await commandPayloadOn(control2.current, "fusion-clean", "Fusion clean")).text;
  result.clean2 = clean2;
  assert.ok(clean2.includes("Released Fusion resources for this session.") || clean2.includes("Released settled Fusion ownership for this workspace."), `Run 2 clean said ${clean2}`);
  const secrets = [...Object.values(auth[provider] ?? {}), goKey].filter((value) => typeof value === "string" && value.length > 12);
  const redact = (value) => secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
  console.log(JSON.stringify(JSON.parse(redact(JSON.stringify(result)))));
} catch (error) {
  // Evidence first: dump everything in-flight before the disposable root goes.
  try {
    const observer = observerPath ? JSON.parse(await readFile(observerPath, "utf8")) : null;
    console.error(`PARITY FAILURE: ${String(error?.message ?? error)}`);
    console.error(JSON.stringify({ result, observer, serverLog: startup.slice(-4000) }, null, 1).slice(0, 16000));
  } catch {}
  throw error;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve)); }
  }
  await rm(root, { recursive: true, force: true });
}
