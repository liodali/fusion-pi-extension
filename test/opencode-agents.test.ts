import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FUSION_AGENTS, FUSION_EXECUTOR_AGENT, FUSION_SCOUT_AGENT, FUSION_SUPERVISOR_AGENT, fusionAgentMarkdown, fusionPermissionsEqual } from "../src/opencode/agents.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("centralized Fusion agent definitions", () => {
	test("the shipped legacy Markdown examples are byte-identical with the definitions", async () => {
		for (const agent of FUSION_AGENTS) {
			const file = await readFile(join(repo, "examples/opencode/agents", `${agent.id}.md`), "utf8");
			expect(file).toBe(fusionAgentMarkdown(agent));
		}
	});

	test("three agents: one primary supervisor and two restricted subagents", () => {
		expect(FUSION_AGENTS.map((agent) => agent.id)).toEqual(["fusion", "fusion-executor", "fusion-scout"]);
		expect(FUSION_SUPERVISOR_AGENT.mode).toBe("primary");
		expect(FUSION_EXECUTOR_AGENT.mode).toBe("subagent");
		expect(FUSION_SCOUT_AGENT.mode).toBe("subagent");
	});

	test("the supervisor may reach only the two Fusion subagents", () => {
		const permissions = FUSION_SUPERVISOR_AGENT.permissions;
		expect(permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" });
		expect(permissions).toContainEqual({ action: "subagent", resource: "fusion-executor", effect: "allow" });
		expect(permissions).toContainEqual({ action: "subagent", resource: "fusion-scout", effect: "allow" });
		expect(permissions.filter((rule) => rule.effect === "allow")).toHaveLength(2);
	});

	test("the executor cannot delegate, start runs, or recurse", () => {
		for (const rule of FUSION_EXECUTOR_AGENT.permissions) expect(rule.effect).toBe("deny");
		for (const denied of ["subagent", "fusion_delegate", "fusion_start", "fusion_scout", "fusion_reconcile", "fusion_reset"]) {
			expect(FUSION_EXECUTOR_AGENT.permissions).toContainEqual({ action: denied, resource: "*", effect: "deny" });
		}
	});

	test("the scout is read-only: every mutating action is denied", () => {
		for (const rule of FUSION_SCOUT_AGENT.permissions) expect(rule.effect).toBe("deny");
		for (const denied of ["subagent", "edit", "write", "patch", "shell", "webfetch", "websearch", "skill", "fusion_delegate"]) {
			expect(FUSION_SCOUT_AGENT.permissions).toContainEqual({ action: denied, resource: "*", effect: "deny" });
		}
	});

	test("permission equality is order-insensitive and rejects differences", () => {
		const permissions = FUSION_SUPERVISOR_AGENT.permissions;
		expect(fusionPermissionsEqual(permissions, [...permissions].reverse())).toBe(true);
		expect(fusionPermissionsEqual(undefined, permissions)).toBe(false);
		expect(fusionPermissionsEqual(permissions.slice(0, 2), permissions)).toBe(false);
		expect(fusionPermissionsEqual([...permissions, { action: "read", resource: "*", effect: "allow" }], permissions)).toBe(false);
	});
});
