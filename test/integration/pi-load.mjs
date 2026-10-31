#!/usr/bin/env bun
// Model-free check that the Pi installation path still loads: a Pi host
// resolves the extension through the package manifest's `pi.extensions`
// field, which points at .pi/extensions/fusion.ts, and that shim re-exports
// the default export of src/index.ts. This fixture loads the shim exactly as
// a Pi host would and registers the extension against a minimal host stub,
// asserting the registration surface the host then sees. No model, no
// network. Exit 0 with a JSON summary, exit 1 on any mismatch.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "../..");
const tools = [];
const commands = [];
const hooks = [];
const pi = {
	registerTool: (tool) => tools.push(tool.name),
	registerCommand: (name) => commands.push(name),
	on: (name) => hooks.push(name),
};

const shim = await import(pathToFileURL(join(repo, ".pi/extensions/fusion.ts")).href);
if (typeof shim.default !== "function") throw new Error("the Pi shim did not export a default extension function");
shim.default(pi);
tools.sort();
commands.sort();
hooks.sort();

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
compare("tools", tools, expected.tools);
compare("commands", commands, expected.commands);
compare("hooks", hooks, expected.hooks);

const result = { surface: "Pi extension install shim (.pi/extensions/fusion.ts)", tools, commands, hooks, mismatches, ok: mismatches.length === 0 };
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
