#!/usr/bin/env bun
// Model-free check that the Pi installation path still loads, through the
// entrys a host actually resolves. A Pi host loads the extension from the
// targets listed in the package manifest's `pi.extensions` field
// (./src/index.ts) — not from any other file — and a project-local
// discovery shim (.pi/extensions/fusion.ts, shipped in the package) must
// re-export exactly that same extension. This fixture loads the manifest
// targets as the manifest states them, asserts the registration surface a
// Pi host then sees, and checks the discovery shim re-exports the same
// extension object. No model, no network. Exit 0 with a JSON summary, exit
// 1 on any mismatch.
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "../..");

const buildHost = () => {
	const tools = [];
	const commands = [];
	const hooks = [];
	return {
		host: {
			registerTool: (tool) => tools.push(tool.name),
			registerCommand: (name) => commands.push(name),
			on: (name) => hooks.push(name),
		},
		surface: () => ({ tools: tools.sort(), commands: commands.sort(), hooks: hooks.sort() }),
	};
};

const expected = {
	tools: ["fusion_delegate", "fusion_scout"],
	commands: ["fusion", "fusion-clean", "fusion-config", "fusion-mode", "fusion-resolve", "fusion-resume", "fusion-stats", "fusion-status"],
	hooks: ["agent_before_settle", "agent_end", "agent_settled", "input", "session_shutdown", "session_start"],
};

const mismatches = [];
const compare = (label, actual, want) => {
	const missing = want.filter((name) => !actual.includes(name));
	const unexpected = actual.filter((name) => !want.includes(name));
	if (missing.length > 0 || unexpected.length > 0) mismatches.push(`${label}: missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(unexpected)}`);
};

// 1. The manifest targets: load exactly what pi.extensions lists, resolved
// against the package root.
const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
const manifestExtensions = pkg.pi?.extensions ?? [];
if (manifestExtensions.length === 0) mismatches.push("package.json declares no pi.extensions targets");
const manifestSurfaces = [];
const manifestDefaults = [];
for (const target of manifestExtensions) {
	const relativeSpec = target.startsWith("./") ? target.slice(2) : target;
	const { default: registerFusion } = await import(pathToFileURL(join(repo, relativeSpec)).href);
	if (typeof registerFusion !== "function") {
		mismatches.push(`manifest target ${target}: default export is not a function`);
		continue;
	}
	manifestDefaults.push(registerFusion);
	const { host, surface } = buildHost();
	registerFusion(host);
	manifestSurfaces.push({ target, ...surface() });
}
if (manifestDefaults.length > 0) {
	compare("manifest tools", manifestSurfaces[0].tools, expected.tools);
	compare("manifest commands", manifestSurfaces[0].commands, expected.commands);
	compare("manifest hooks", manifestSurfaces[0].hooks, expected.hooks);
	const others = manifestSurfaces.slice(1).filter((entry) => JSON.stringify(entry) !== JSON.stringify(manifestSurfaces[0]));
	if (others.length > 0) mismatches.push(`manifest targets beyond the first differ: ${others.map((entry) => entry.target).join(", ")}`);
}

// 2. Project-local discovery: .pi/extensions/fusion.ts must re-export the
// same extension object the manifest target loads (same module identity),
// registering the same surface.
const shim = await import(pathToFileURL(join(repo, ".pi/extensions/fusion.ts")).href);
if (manifestDefaults.length > 0 && shim.default !== manifestDefaults[0]) mismatches.push("the project-local discovery shim does not re-export the manifest extension (different module identity)");
const shimProbe = buildHost();
shim.default?.(shimProbe.host);
compare("discovery-shim tools", shimProbe.surface().tools, expected.tools);
compare("discovery-shim commands", shimProbe.surface().commands, expected.commands);
compare("discovery-shim hooks", shimProbe.surface().hooks, expected.hooks);

const result = {
	manifestTargets: manifestExtensions,
	manifestSurface: manifestSurfaces[0] ?? null,
	discoveryShimReExportsManifestEntry: manifestDefaults.length > 0 && shim.default === manifestDefaults[0],
	shimSurface: shimProbe.surface(),
	mismatches,
	ok: mismatches.length === 0,
};
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
