#!/usr/bin/env bun
// Materializes dist/fusion-opencode: the dedicated installable package for
// OpenCode's native plugin manager, generated from the shared sources (there
// is no committed copy to drift; the Pi package at the repository root keeps
// its own manifest and defaults untouched). The generated package's server
// part is the raw { id, setup } default export in src/opencode/index.ts,
// which OpenCode v2.2.5 loads through package.json exports["."] without any
// SDK dependency (verified live; see docs/opencode-install-and-config-plan.md
// step 1). Pack it with:
//   npm pack dist/fusion-opencode --pack-destination dist
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "dist", "fusion-opencode");

const root = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
if (typeof root.version !== "string") throw new Error("The root package.json has no version.");

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "examples", "opencode"), { recursive: true });
await mkdir(join(out, "docs"), { recursive: true });
// The full shared import closure: src/opencode/index.ts pulls ../core, ../workspace, ../prompts, ...
await cp(join(repo, "src"), join(out, "src"), { recursive: true });
// Legacy manual-install agent files, kept byte-identical with src/opencode/agents.ts by test/opencode-agents.test.ts.
await cp(join(repo, "examples", "opencode", "agents"), join(out, "examples", "opencode", "agents"), { recursive: true });
await cp(join(repo, "docs", "install.md"), join(out, "docs", "install.md"));

const manifest = {
	name: "fusion-opencode",
	version: root.version,
	description: "Fusion supervisor-executor orchestration for OpenCode (native plugin)",
	type: "module",
	license: "MIT",
	keywords: ["opencode-plugin", "multi-agent", "fusion"],
	files: ["src", "examples", "docs"],
	bin: root.bin,
	exports: {
		".": "./src/opencode/index.ts",
		"./tui": "./src/opencode/tui.ts",
		"./package.json": "./package.json",
	},
};
if (!manifest.bin || typeof manifest.bin !== "object") throw new Error("The root package.json has no bin map; the recovery CLI would be missing.");
await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`generated ${out} (fusion-opencode@${root.version})`);
