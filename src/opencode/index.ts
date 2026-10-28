import { FusionController } from "../core/controller.ts";
import { buildExecutorPrompt, buildFinalFixPrompt, buildRevisionPrompt, EXECUTOR_SYSTEM_PROMPT } from "../prompts.ts";
import { formatCompactReport, parseExecutorReport } from "../report.ts";
import { createNativeExecutor, type NativeSubagentExecute, type NativeToolContext } from "./native-executor.ts";
import type { DelegationAction } from "../core/workflow.ts";

interface ToolContext extends NativeToolContext { readonly agent: string }
interface ToolDefinition {
	name: string;
	description: string;
	input: Record<string, unknown>;
	options: { codemode: false };
	execute: (input: unknown, context: ToolContext) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
}
interface PluginContext {
	tool: {
		list(): Promise<readonly { id: string; execute: NativeSubagentExecute<ToolContext> }[]>;
		transform(callback: (editor: { add(tool: ToolDefinition): void }) => void): Promise<unknown>;
	};
}

type Handle = ReturnType<typeof createNativeExecutor<ToolContext>>;
interface Run {
	controller: FusionController;
	handle: Handle;
	originalTask?: string;
	brief?: string;
	uncertain: boolean;
}

/** OpenCode v2 server plugin. A plugin instance is scoped to one location. */
export default {
	id: "fusion",
	async setup(ctx: PluginContext) {
		const native = (await ctx.tool.list()).find((tool) => tool.id === "subagent");
		if (!native) throw new Error("Fusion requires OpenCode's native subagent tool.");
		const runs = new Map<string, Run>();
		let owner: string | undefined;
		function requireSupervisor(context: ToolContext): void {
			if (context.agent !== "fusion") throw new Error("Fusion tools are available only to the fusion primary agent.");
		}
		function runFor(sessionID: string): Run {
			let run = runs.get(sessionID);
			if (!run) {
				run = {
					controller: new FusionController({ delegating: false, executed: false, revisions: 0, finalFixUsed: false, resumePending: false, scoutCalls: 0 }),
					handle: createNativeExecutor({ parentSessionID: sessionID, agent: "fusion-executor", execute: native!.execute }),
					uncertain: false,
				};
				runs.set(sessionID, run);
			}
			return run;
		}

		await ctx.tool.transform((editor) => {
			editor.add({
				name: "fusion_delegate",
				description: "Delegate a decided implementation brief to the Fusion executor. Use execute once, then up to three revise calls and one final_fix after the acceptance audit. Review the actual working tree after each call.",
				input: { type: "object", properties: { action: { type: "string", enum: ["execute", "revise", "final_fix"] }, brief: { type: "string", minLength: 1 }, originalTask: { type: "string" } }, required: ["action", "brief"], additionalProperties: false },
				options: { codemode: false },
				async execute(input, context) {
					requireSupervisor(context);
					if (!input || typeof input !== "object") throw new Error("Invalid Fusion delegation input.");
					const value = input as Record<string, unknown>;
					if ((value.action !== "execute" && value.action !== "revise" && value.action !== "final_fix") || typeof value.brief !== "string" || !value.brief.trim() || (value.originalTask !== undefined && typeof value.originalTask !== "string")) throw new Error("Invalid Fusion delegation input.");
					const action: DelegationAction = value.action;
					const run = runFor(context.sessionID);
					if (run.uncertain) throw new Error("The executor's last turn has an unknown outcome. Review the child session and working tree before recovery; automatic retry is disabled.");
					if (owner && owner !== context.sessionID) throw new Error("Another Fusion session owns this workspace. Finish and reset that run first.");
					const error = run.controller.beginDelegation(action);
					if (error) throw new Error(error);
					owner = context.sessionID;
					if (action === "execute") {
						run.originalTask = typeof value.originalTask === "string" && value.originalTask.trim() ? value.originalTask : value.brief;
						run.brief = value.brief;
					}
					const prompt = action === "execute"
						? `${EXECUTOR_SYSTEM_PROMPT}\n\n${buildExecutorPrompt(value.brief)}`
						: action === "revise"
							? buildRevisionPrompt(value.brief, run.controller.state.revisions)
							: buildFinalFixPrompt(value.brief, run.originalTask);
					try {
						const result = await run.handle.prompt(prompt, `Fusion ${action}`, context);
						run.controller.completeDelegation();
						const parsed = parseExecutorReport(result.output);
						return { content: `${formatCompactReport(parsed.report, undefined, parsed.prose)}\n\nReview the actual working tree; automatic diff attribution is not yet available.`, metadata: { childSessionID: result.sessionID, action } };
					} catch (error) {
						// Child creation and submission can fail before progress delivers an ID.
						// Without proof of settlement, retrying could duplicate edits.
						run.uncertain = true;
						throw error;
					} finally {
						run.controller.endDelegation(action);
					}
				},
			});
			editor.add({
				name: "fusion_status", description: "Show the current Fusion run state.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					const run = runs.get(context.sessionID);
					if (!run) return { content: "No Fusion run in this session." };
					return { content: JSON.stringify({ ...run.controller.state, childSessionID: run.handle.childSessionID, uncertain: run.uncertain, originalTask: run.originalTask }) };
				},
			});
			editor.add({
				name: "fusion_reset", description: "Finish a settled Fusion run and release its workspace for another session.", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: false },
				async execute(_input, context) {
					requireSupervisor(context);
					const run = runs.get(context.sessionID);
					if (!run) return { content: "No Fusion run in this session." };
					if (run.controller.state.delegating || run.uncertain) throw new Error("Cannot reset an active or uncertain executor turn.");
					runs.delete(context.sessionID);
					if (owner === context.sessionID) owner = undefined;
					return { content: "Fusion run reset." };
				},
			});
		});
	},
};
