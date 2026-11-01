/**
 * The three Fusion agent definitions: the single source of truth shared by
 * the plugin's native agent contribution (OpenCode v2.2.5 `ctx.agent.transform`)
 * and the generated legacy Markdown examples under `examples/opencode/agents/`
 * (regenerate with `bun run generate:agent-markdown`; a test enforces sync).
 *
 * Field mapping on OpenCode v2.2.5 (pinned live, see
 * docs/opencode-install-and-config-plan.md step 1): the Markdown body is the
 * agent's `system` prompt, frontmatter maps to `description`/`mode`/
 * `permissions`, and the plugin contributes each definition through
 * `editor.update` on a missing ID (the editor has no `add`).
 */

/** OpenCode v2.2.5 `Agent.Info` permission rule shape. */
export interface FusionAgentPermission {
	readonly action: string;
	readonly resource: string;
	readonly effect: "allow" | "deny" | "ask";
}

/** One contributed Fusion agent. */
export interface FusionAgentDefinition {
	readonly id: string;
	readonly mode: "primary" | "subagent" | "all";
	readonly description: string;
	readonly system: string;
	readonly permissions: readonly FusionAgentPermission[];
}

/** The supervisor: plans, delegates, reviews; reaches subagents only through Fusion. */
export const FUSION_SUPERVISOR_AGENT: FusionAgentDefinition = {
	id: "fusion",
	mode: "primary",
	description: "Plans and reviews work delegated to the Fusion executor",
	system:
		"You are the Fusion supervisor. The user starts runs with the /fusion-run command (or, when Fusion persistent mode is on and no run is active, by calling fusion_start with the user's request as task). Investigate the request and decide the approach. Use fusion_scout for broad read-only searches and file discovery (at most 4 calls per run); read yourself only the few files that decide the design. Use fusion_delegate with action execute and a self-contained implementation brief. Review the actual working tree and checks. Consolidate defects into at most three revise calls. Audit every original requirement and use final_fix once if needed. Summarize the outcome and checks. Do not invoke the native subagent tool directly. If a turn is backgrounded or its outcome is uncertain, wait for OpenCode's matching completion notification and call fusion_reconcile. If no matching notification is available, do not retry or reset automatically. Call fusion_reset after a settled run is finished.",
	permissions: [
		{ action: "subagent", resource: "*", effect: "deny" },
		{ action: "subagent", resource: "fusion-executor", effect: "allow" },
		{ action: "subagent", resource: "fusion-scout", effect: "allow" },
	],
};

/** The executor: implements a decided brief and never delegates or starts runs. */
export const FUSION_EXECUTOR_AGENT: FusionAgentDefinition = {
	id: "fusion-executor",
	mode: "subagent",
	description: "Implements a decided Fusion brief",
	system:
		"Implement the Fusion supervisor's brief in the shared working tree. Follow project instructions, run the requested checks, and return the report requested in the brief. Do not delegate.",
	permissions: [
		{ action: "subagent", resource: "*", effect: "deny" },
		{ action: "fusion_delegate", resource: "*", effect: "deny" },
		{ action: "fusion_start", resource: "*", effect: "deny" },
		{ action: "fusion_scout", resource: "*", effect: "deny" },
		{ action: "fusion_status", resource: "*", effect: "deny" },
		{ action: "fusion_stats", resource: "*", effect: "deny" },
		{ action: "fusion_reset", resource: "*", effect: "deny" },
		{ action: "fusion_reconcile", resource: "*", effect: "deny" },
	],
};

/** The scout: disposable read-only investigator for the supervisor. */
export const FUSION_SCOUT_AGENT: FusionAgentDefinition = {
	id: "fusion-scout",
	mode: "subagent",
	description: "Investigates the repository read-only for the Fusion supervisor",
	system:
		"You are the Fusion scout: a disposable read-only investigator for the Fusion supervisor. Answer the questions you are given concisely and cite concrete evidence as path:line references from the repository. Batch independent reads, greps, and searches into a single step; you have a hard tool-call budget, so do not wander. Never edit files, run commands, access the network, or delegate. Answer every question in one final message: a numbered list matching the questions, under 400 words total.",
	permissions: [
		{ action: "subagent", resource: "*", effect: "deny" },
		{ action: "edit", resource: "*", effect: "deny" },
		{ action: "write", resource: "*", effect: "deny" },
		{ action: "patch", resource: "*", effect: "deny" },
		{ action: "shell", resource: "*", effect: "deny" },
		{ action: "webfetch", resource: "*", effect: "deny" },
		{ action: "websearch", resource: "*", effect: "deny" },
		{ action: "skill", resource: "*", effect: "deny" },
		{ action: "fusion_delegate", resource: "*", effect: "deny" },
		{ action: "fusion_scout", resource: "*", effect: "deny" },
		{ action: "fusion_status", resource: "*", effect: "deny" },
		{ action: "fusion_reset", resource: "*", effect: "deny" },
		{ action: "fusion_reconcile", resource: "*", effect: "deny" },
	],
};

/** All Fusion agents in contribution order (supervisor first). */
export const FUSION_AGENTS: readonly FusionAgentDefinition[] = [FUSION_SUPERVISOR_AGENT, FUSION_EXECUTOR_AGENT, FUSION_SCOUT_AGENT];

/** Structural equality for permission rule lists, ignoring rule order. */
export function fusionPermissionsEqual(left: readonly { action: string; resource: string; effect: string }[] | undefined, right: readonly FusionAgentPermission[]): boolean {
	if (!left || left.length !== right.length) return false;
	const key = (rule: { action: string; resource: string; effect: string }) => `${rule.action}\u0000${rule.resource}\u0000${rule.effect}`;
	const rightKeys = new Set(right.map(key));
	return left.every((rule) => rightKeys.has(key(rule)));
}

/** YAML-scalar rendering matching the shipped Markdown files: only `*` is quoted. */
function yamlResource(resource: string): string {
	return resource === "*" ? '"*"' : resource;
}

/**
 * Render one definition as the legacy Markdown agent file. Byte-identical
 * with the files under `examples/opencode/agents/` so native and manual
 * installs share one definition.
 */
export function fusionAgentMarkdown(agent: FusionAgentDefinition): string {
	const lines = ["---", `description: ${agent.description}`, `mode: ${agent.mode}`];
	if (agent.permissions.length > 0) {
		lines.push("permissions:");
		for (const rule of agent.permissions) lines.push(`  - action: ${rule.action}`, `    resource: ${yamlResource(rule.resource)}`, `    effect: ${rule.effect}`);
	}
	lines.push("---", "", agent.system);
	return `${lines.join("\n")}\n`;
}
