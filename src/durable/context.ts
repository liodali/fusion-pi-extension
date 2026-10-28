import {
	DefaultResourceLoader,
	formatSkillsForPrompt,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type Extension, section } from "@earendil-works/pi-durable";
import { EXECUTOR_SYSTEM_PROMPT, SCOUT_SYSTEM_PROMPT } from "../prompts.ts";

export type FusionContextRole = "executor" | "scout";

export interface FusionContext {
	extension: Extension;
	instructions(cwd: string): Promise<string>;
}

export function createFusionContext(role: FusionContextRole): FusionContext {
	const loaders = new Map<string, DefaultResourceLoader>();
	const systemPrompt = role === "scout" ? SCOUT_SYSTEM_PROMPT : EXECUTOR_SYSTEM_PROMPT;
	async function cachedLoader(cwd: string): Promise<DefaultResourceLoader> {
		const cached = loaders.get(cwd);
		if (cached) return cached;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noPromptTemplates: true,
			appendSystemPrompt: [systemPrompt],
		});
		await loader.reload();
		loaders.set(cwd, loader);
		return loader;
	}
	return {
		extension: {
			name: role === "scout" ? "fusion-scout-context" : "fusion-context",
			sections: [
				section("environment", (input) => {
					const cwd = input.agent.cwd;
					if (cwd === undefined) return undefined;
					return `Current working directory: ${cwd}`;
				}),
				section("project_context", async (input) => {
					const cwd = input.agent.cwd;
					if (cwd === undefined) return undefined;
					const { agentsFiles } = (await cachedLoader(cwd)).getAgentsFiles();
					if (agentsFiles.length === 0) return undefined;
					return agentsFiles
						.map((file) => `## ${file.path}\n\n${file.content}`)
						.join("\n\n");
				}),
				section("skills", async (input) => {
					const cwd = input.agent.cwd;
					if (cwd === undefined) return undefined;
					const text = formatSkillsForPrompt((await cachedLoader(cwd)).getSkills().skills);
					return text === "" ? undefined : text;
				}),
			],
		},
		instructions: async (cwd) => {
			const loader = await cachedLoader(cwd);
			return [loader.getSystemPrompt(), ...loader.getAppendSystemPrompt()]
				.filter((part) => part !== undefined && part !== "")
				.join("\n\n");
		},
	};
}
