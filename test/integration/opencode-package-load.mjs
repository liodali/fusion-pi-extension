// Dedicated-package load fixture (steps 2-3 acceptance, model-free): builds
// the fusion-opencode package from the shared sources, packs it, installs it
// as the ONLY dependency of a bare consumer (no Pi SDKs), configures it
// through OpenCode's native `plugins` entry, and boots the real host with
// EMPTY agent directories. The plugin must load from the installed package
// and contribute fusion / fusion-executor / fusion-scout with the centralized
// definitions, register the Fusion commands, and report its agents accurately
// through /fusion-status — all without any model call.
//
// Set FUSION_OPENCODE_TARBALL to test an already-packed tarball (CI packs the
// exact artifact it uploads); otherwise the fixture builds and packs one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile, writeFile as write } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeArtifact } from "./artifact.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bin = process.env.FUSION_OPENCODE_BIN || "opencode";
const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
if (version.status !== 0) throw new Error(`OpenCode binary not available (${bin}); set FUSION_OPENCODE_BIN.`);
const run = (command, args, opts = {}) => spawnSync(command, args, { encoding: "utf8", ...opts });
const result = { ok: false, hostVersion: version.stdout.trim(), failures: [] };
const check = (label, condition, detail) => {
	if (condition) return;
	result.failures.push(label);
	result[`${label} (detail)`] = detail ?? null;
};

const root = await mkdtemp(join(tmpdir(), "fusion-package-load-"));
const servers = [];
try {
	// 1. Build and pack the dedicated package (or take a prebuilt tarball).
	let tarball = process.env.FUSION_OPENCODE_TARBALL;
	if (!tarball) {
		const generated = run("bun", [join(repo, "scripts", "build-opencode-package.mjs")]);
		assert.equal(generated.status, 0, `build-opencode-package failed: ${generated.stderr}`);
		const packed = run("npm", ["pack", "./dist/fusion-opencode", "--pack-destination", "dist"], { cwd: repo });
		assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`);
		const packedName = packed.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
		tarball = join(repo, "dist", packedName.split(" ").pop() ?? "");
	}
	result.tarball = tarball;
	result.tarballSha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
	const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));

	// 2. A bare consumer: only the dedicated package, nothing else.
	const consumer = join(root, "consumer");
	await mkdir(join(consumer, "project"), { recursive: true });
	await cp(tarball, join(consumer, "fusion-opencode.tgz"));
	await writeFile(join(consumer, "package.json"), `${JSON.stringify({ name: "fusion-package-load", private: true, type: "module", dependencies: { "fusion-opencode": "file:./fusion-opencode.tgz" } }, null, 2)}\n`);
	const install = run("bun", ["install"], { cwd: consumer });
	check("bare consumer installs the dedicated tarball", install.status === 0, `${install.stdout ?? ""}${install.stderr ?? ""}`.split("\n").slice(-3).join(" | "));
	const piStackPresent = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"].filter((name) => run("test", ["-d", join(consumer, "node_modules", name)]).status === 0);
	check("the bare install pulls no Pi SDKs", piStackPresent.length === 0, piStackPresent);

	// The recovery CLI ships as a bin and must work from the installed layout
	// (the operating guide documents ./node_modules/.bin/fusion-resolve).
	const resolveBin = join(consumer, "node_modules", ".bin", "fusion-resolve");
	check("the fusion-resolve bin is linked in the consumer", run("test", ["-f", resolveBin]).status === 0, resolveBin);
	const resolveViaBin = run(resolveBin, [], { timeout: 60000 });
	check("the linked bin executes and demands explicit arguments", resolveViaBin.status === 2 && /Usage: fusion-resolve/.test(resolveViaBin.stderr ?? ""), { status: resolveViaBin.status, stderr: (resolveViaBin.stderr ?? "").slice(0, 200) });
	const resolveUsage = run("bun", [join(consumer, "node_modules", "fusion-opencode", "src", "workspace", "resolve.ts")], { timeout: 60000 });
	check("the recovery CLI runs from the installed package and demands explicit arguments", resolveUsage.status === 2 && /Usage: fusion-resolve/.test(resolveUsage.stderr ?? ""), { status: resolveUsage.status, stderr: (resolveUsage.stderr ?? "").slice(0, 200) });

	// 3. Configure through the native plugins entry: the installed package
	// first, then an ordered local driver plugin that exercises the package's
	// registered tools against the real host (no model call). Agent
	// directories stay empty — contribution must come from the package.
	const project = join(consumer, "project");
	await mkdir(join(project, "probe-driver"), { recursive: true });
	await writeFile(join(project, "probe-driver", "index.ts"), `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export default { id: "fusion-load-probe", async setup(ctx) {
  const result = { version: ctx.app?.version ?? null, fusionTools: false, agentsObserved: null, runRetained: false, catalogModel: null, error: null };
  try {
    const registered = await ctx.tool.list();
    const start = registered.find((tool) => tool.id === "fusion_start");
    if (!start) throw new Error("Fusion tools were not registered by the installed package");
    result.fusionTools = true;
    const catalog = await ctx.model.list();
    const models = Array.isArray(catalog?.data) ? catalog.data : [];
    const usable = models.filter((model) => model && typeof model.providerID === "string" && typeof model.id === "string" && model.enabled !== false);
    result.catalogModel = usable[0] ? usable[0].providerID + "/" + usable[0].id : null;
    const parent = await ctx.session.create({});
    await ctx.session.switchAgent({ sessionID: parent.id, agent: "fusion" });
    const toolContext = { sessionID: parent.id, agent: "fusion", messageID: "msg_load_probe", id: "call_load_probe", signal: new AbortController().signal, progress: async () => {} };
    await start.execute({ task: "Dedicated package load probe" }, toolContext);
    const status = JSON.parse((await registered.find((tool) => tool.id === "fusion_status").execute({}, toolContext)).content);
    result.agentsObserved = status.agents?.observed ?? null;
    result.runRetained = status.originalTask === "Dedicated package load probe" && status.owner?.supervisorId === parent.id && status.workspaceClaimed === true;
    await registered.find((tool) => tool.id === "fusion_reset").execute({}, toolContext);
  } catch (error) { result.error = String(error?.stack ?? error); }
  await writeFile(join(ctx.location.directory, "load-probe.json"), JSON.stringify(result));
} };
`);
	await writeFile(join(project, "opencode.json"), `${JSON.stringify({ plugins: ["../node_modules/fusion-opencode", "./probe-driver"] }, null, 2)}\n`);

	// 4. Isolated environment and a reusable boot helper.
	const env = Object.fromEntries(["PATH", "SHELL", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
	env.HOME = join(root, "home");
	await mkdir(env.HOME, { recursive: true });
	for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, folder);
	const boot = async (projectDir) => {
		const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] });
		servers.push(child);
		const startup = [];
		const [url, password] = await new Promise((resolveProblem, reject) => {
			let u, p;
			const timer = setTimeout(() => reject(new Error(`server startup timeout: ${startup.join("").slice(-2000)}`)), 90000);
			child.stdout.on("data", (chunk) => {
				const text = chunk.toString();
				startup.push(text);
				u ??= text.match(/server listening on (http:\/\/\S+)/)?.[1];
				p ??= text.match(/server password (\S+)/)?.[1];
				if (u && p) { clearTimeout(timer); resolveProblem([u, p]); }
			});
			child.stderr.on("data", (chunk) => startup.push(chunk.toString()));
			child.on("exit", (code) => reject(new Error(`server exited early (${code}): ${startup.join("").slice(-2000)}`)));
		});
		const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
		const get = async (path) => (await fetch(`${url}${path}`, { headers: auth, signal: AbortSignal.timeout(15000) })).json().catch(() => null);
		const post = async (path, body) => {
			const response = await fetch(`${url}${path}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15000) });
			return { status: response.status, body: await response.json().catch(() => null) };
		};
		const listOf = (body) => (Array.isArray(body) ? body : body?.data ?? []);
		// Create a session, run a registered command, and return its delivered
		// synthetic output (or null on timeout). Model-free.
		const command = async (name, text, description) => {
			const session = await post("/api/session", {});
			const sessionID = session.body?.id ?? session.body?.data?.id;
			if (!sessionID) throw new Error(`session create failed for ${name}`);
			const invoked = await post(`/api/session/${sessionID}/command`, { name, text });
			if (!(invoked.status >= 200 && invoked.status < 300)) return { status: invoked.status, text: null };
			for (let i = 0; i < 40; i++) {
				const inbox = await get(`/api/session/${sessionID}/inbox`);
				const entry = (inbox?.data ?? []).find((candidate) => candidate?.type === "synthetic" && candidate?.payload?.description === `${description}\n${candidate?.payload?.text}` && typeof candidate?.payload?.text === "string");
				if (entry) return { status: invoked.status, text: entry.payload.text };
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
			return { status: invoked.status, text: null };
		};
		return { child, url, get, post, listOf, command };
	};

	// 5. Boot and wait for the plugin to activate (lazy per location).
	const first = await boot(project);
	let agents = [];
	for (let i = 0; i < 120; i++) {
		agents = first.listOf(await first.get("/api/agent"));
		if (agents.some((agent) => agent?.id === "fusion")) break;
		await new Promise((resolve) => setTimeout(resolve, 600));
	}
	const fusion = agents.find((agent) => agent?.id === "fusion");
	const executor = agents.find((agent) => agent?.id === "fusion-executor");
	const scout = agents.find((agent) => agent?.id === "fusion-scout");
	check("the installed package contributes the fusion supervisor", !!fusion, agents.map((agent) => agent?.id));
	check("the installed package contributes the executor subagent", !!executor);
	check("the installed package contributes the scout subagent", !!scout);
	check("the supervisor is a primary agent", fusion?.mode === "primary", fusion?.mode);
	check("the executor is a subagent", executor?.mode === "subagent", executor?.mode);
	check("the scout is a subagent", scout?.mode === "subagent", scout?.mode);
	const { FUSION_AGENTS } = await import(`${repo}/src/opencode/agents.ts`);
	for (const definition of FUSION_AGENTS) {
		const agent = agents.find((candidate) => candidate?.id === definition.id);
		check(`${definition.id} carries the centralized system prompt`, agent?.system === definition.system, (agent?.system ?? "").slice(0, 80));
		check(`${definition.id} carries the centralized description`, agent?.description === definition.description, agent?.description);
		for (const rule of definition.permissions) {
			check(`${definition.id} permission ${rule.action} ${rule.resource} ${rule.effect} is present`, (agent?.permissions ?? []).some((present) => present.action === rule.action && present.resource === rule.resource && present.effect === rule.effect));
		}
	}
	const commands = first.listOf(await first.get("/api/command"));
	const commandNames = commands.map((command) => command?.name);
	for (const name of ["fusion-run", "fusion-mode", "fusion-config", "fusion-status", "fusion-stats", "fusion-resume", "fusion-clean", "fusion-stop"]) check(`command ${name} is registered`, commandNames.includes(name), commandNames);
	const plugins = first.listOf(await first.get("/api/plugin"));
	const fusionPlugin = plugins.find((plugin) => plugin?.id === "fusion");
	check("the fusion plugin is active from a non-builtin source", fusionPlugin?.state?.status === "active" && !!fusionPlugin?.source && fusionPlugin.source.type !== "builtin", fusionPlugin);

	// 6. The driver plugin exercised the package's tools in-process: the
	// query-time agent report must show all three agents available, and the
	// run lifecycle (start → status → reset) must hold against the real host.
	let probe;
	for (let i = 0; i < 100; i++) {
		try { probe = JSON.parse(await readFile(join(project, "load-probe.json"), "utf8")); break; } catch {}
		await first.get("/api/agent");
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	check("the driver plugin ran", !!probe, "load-probe.json never appeared");
	if (probe) {
		check("the installed package registered the Fusion tools", probe.fusionTools === true, probe.error);
		check("a Fusion run started and retained its task and owner", probe.runRetained === true, probe);
		check("the query-time agent report shows all three agents available", JSON.stringify(probe.agentsObserved) === JSON.stringify(FUSION_AGENTS.map((definition) => ({ id: definition.id, state: "available" }))), probe.agentsObserved);
	}

	// 7. Commands through the real surface, model-free: /fusion-status, then
	// the full /fusion-config contract (show, list, set) against the live
	// catalog, using the driver's reported catalog model.
	const status = await first.command("fusion-status", "", "Fusion status");
	check("fusion-status executes and delivers its report", !!status.text, status);
	const showBefore = await first.command("fusion-config", "", "Fusion config");
	check("fusion-config with no arguments shows the saved preference", showBefore.text?.includes("Saved preference: none.") ?? false, showBefore.text?.slice(0, 200));
	check("fusion-config with no arguments documents its syntax", showBefore.text?.includes("/fusion-config <provider>/<model> [variant]") ?? false);
	const listed = await first.command("fusion-config", "list", "Fusion config models");
	check("fusion-config list delivers catalog lines", /-\s+\S+\/\S+/.test(listed.text ?? ""), (listed.text ?? "").slice(0, 200));
	result.catalogModel = probe?.catalogModel ?? null;
	if (probe?.catalogModel) {
		const set = await first.command("fusion-config", probe.catalogModel, "Fusion config");
		check("fusion-config sets a catalog model", set.text?.includes(`configured for this run: ${probe.catalogModel}`) ?? false, set.text?.slice(0, 300));
		const showAfter = await first.command("fusion-config", "", "Fusion config");
		check("the saved preference is visible immediately", showAfter.text?.includes(`Saved preference: ${probe.catalogModel}`) ?? false, showAfter.text?.slice(0, 200));
		// 8. Persistence across a server restart: the preference lives in plugin
		// storage, so a fresh process must still report it.
		first.child.kill("SIGKILL");
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const second = await boot(project);
		const showRestarted = await second.command("fusion-config", "", "Fusion config");
		check("the saved preference survives a server restart", showRestarted.text?.includes(`Saved preference: ${probe.catalogModel}`) ?? false, showRestarted.text?.slice(0, 200));
	} else {
		// Anonymous or credentialess hosts can expose an empty catalog; the set
		// and persistence checks need one real choice. The skip is explicit in
		// the artifact — never silent — and the show/list contract was still
		// verified above.
		result.catalogSetSkipped = "the host catalog exposed no enabled model";
	}

	// 9. Manual-install coexistence: a legacy Markdown agent definition keeps
	// precedence over the plugin's contribution, and /fusion-status reports
	// the conflict instead of silently overriding the user's policy.
	const legacyProject = join(consumer, "project-legacy");
	await mkdir(join(legacyProject, ".opencode", "agent"), { recursive: true });
	const staleSystem = "An outdated supervisor prompt from a legacy manual install.";
	await writeFile(join(legacyProject, ".opencode", "agent", "fusion.md"), `---\ndescription: Stale legacy supervisor\nmode: primary\n---\n${staleSystem}\n`);
	await writeFile(join(legacyProject, "opencode.json"), `${JSON.stringify({ plugins: ["../node_modules/fusion-opencode"] }, null, 2)}\n`);
	const legacy = await boot(legacyProject);
	let legacyAgents = [];
	for (let i = 0; i < 120; i++) {
		legacyAgents = legacy.listOf(await legacy.get("/api/agent"));
		if (legacyAgents.some((agent) => agent?.id === "fusion")) break;
		await new Promise((resolve) => setTimeout(resolve, 600));
	}
	const legacyFusion = legacyAgents.find((agent) => agent?.id === "fusion");
	check("the legacy markdown definition wins over the plugin's", legacyFusion?.system === staleSystem, (legacyFusion?.system ?? "").slice(0, 80));
	check("the plugin still contributes the subagents", legacyAgents.some((agent) => agent?.id === "fusion-executor") && legacyAgents.some((agent) => agent?.id === "fusion-scout"), legacyAgents.map((agent) => agent?.id));
	const legacyStatus = await legacy.command("fusion-status", "", "Fusion status");
	check("fusion-status reports the conflicting legacy definition", legacyStatus.text?.includes("Installed agent definitions override") ?? false, (legacyStatus.text ?? "").slice(0, 300));
	result.ok = result.failures.length === 0 && !result.error;
} catch (error) {
	result.ok = false;
	result.error = String(error);
} finally {
	await writeArtifact("opencode-package-load", result, { secrets: [] });
	for (const child of servers) child.kill("SIGKILL");
}
console.log(JSON.stringify({ ok: result.ok, failures: result.failures }, null, 2));
if (!result.ok) process.exit(1);
