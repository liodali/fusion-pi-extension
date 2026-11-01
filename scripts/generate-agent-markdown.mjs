#!/usr/bin/env bun
// Regenerate the legacy Markdown agent examples under examples/opencode/agents/
// from the centralized definitions in src/opencode/agents.ts. The dedicated
// OpenCode package ships the same files, and a test enforces that the checked-in
// copies stay byte-identical with the definitions (bun run generate:agent-markdown).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FUSION_AGENTS, fusionAgentMarkdown } from "../src/opencode/agents.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(repo, "examples", "opencode", "agents");
await mkdir(target, { recursive: true });
for (const agent of FUSION_AGENTS) {
	const file = join(target, `${agent.id}.md`);
	await writeFile(file, fusionAgentMarkdown(agent));
	console.log(`generated ${file}`);
}
