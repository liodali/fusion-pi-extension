import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentToolResult,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildExecutorPrompt,
	buildRevisionPrompt,
	buildSupervisorPrompt,
	EXECUTOR_SYSTEM_PROMPT,
	MAX_REVISIONS,
} from "./prompts.ts";
import {
	FUSION_OUTPUT_PRICE_THRESHOLD,
	formatPricedModelLabel,
	type FusionModelTier,
	getOutputPrice,
	isModelInTier,
} from "./pricing.ts";
import { isRecentModel, RECENT_MODEL_COHORT, searchRecentModels } from "./recent-models.ts";
import { selectScrollableOption } from "./scrollable-select.ts";
import { aggregateUsage } from "./usage.ts";

const WIDGET_KEY = "fusion";

type FusionPhase = "idle" | "planning" | "executing" | "reviewing" | "revising" | "complete" | "failed";

interface FusionToolDetails {
	action: "execute" | "revise";
	revisions: number;
	executor: string;
	output: string;
	error?: string;
	usage?: Usage;
}

interface FusionState {
	modeEnabled: boolean;
	runActive: boolean;
	phase: FusionPhase;
	revisions: number;
	executed: boolean;
	delegating: boolean;
	task?: string;
	supervisorModel?: Model<Api>;
	executorModel?: Model<Api>;
	supervisorLabel?: string;
	executorLabel?: string;
	executorSession?: AgentSession;
}

function modelLabel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function priceText(model: Model<Api>): string {
	const price = getOutputPrice(model);
	return price === undefined ? "price unknown" : `$${price.toFixed(2)}/M output`;
}

function collectModels(ctx: ExtensionContext): Model<Api>[] {
	const models =
		ctx.scopedModels.length > 0 ? ctx.scopedModels.map((scoped) => scoped.model) : ctx.modelRegistry.getAvailable();
	const seen = new Set<string>();
	const unique: Model<Api>[] = [];
	for (const model of models) {
		const label = modelLabel(model);
		if (seen.has(label)) continue;
		seen.add(label);
		unique.push(model);
	}
	unique.sort((a, b) => modelLabel(a).localeCompare(modelLabel(b)));
	return unique;
}

function lastAssistantOutput(session: AgentSession): { text: string; stopReason?: string; errorMessage?: string } {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return { text, stopReason: message.stopReason, errorMessage: message.errorMessage };
	}
	return { text: "" };
}

export default function (pi: ExtensionAPI) {
	const state: FusionState = {
		modeEnabled: false,
		runActive: false,
		phase: "idle",
		revisions: 0,
		executed: false,
		delegating: false,
	};

	const executorLabel = (): string =>
		state.executorLabel ?? (state.executorModel ? modelLabel(state.executorModel) : "unconfigured");

	function updateWidget(ctx: ExtensionContext): void {
		if (!state.runActive && !state.modeEnabled) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, [
			`Fusion: ${state.phase}`,
			`Supervisor: ${state.supervisorLabel ?? "-"}`,
			`Executor: ${state.executorLabel ?? "-"}`,
			`Revisions: ${state.revisions}/${MAX_REVISIONS}`,
		]);
	}

	function setPhase(ctx: ExtensionContext, phase: FusionPhase): void {
		state.phase = phase;
		updateWidget(ctx);
	}

	function disposeExecutor(): void {
		const session = state.executorSession;
		state.executorSession = undefined;
		try {
			session?.dispose();
		} catch {}
	}

	function startRun(ctx: ExtensionContext, task: string): void {
		disposeExecutor();
		state.runActive = true;
		state.task = task;
		state.revisions = 0;
		state.executed = false;
		setPhase(ctx, "planning");
	}

	async function selectModel(
		ctx: ExtensionContext,
		title: string,
		tier: FusionModelTier,
		preferredLabel?: string,
	): Promise<Model<Api> | undefined> {
		const tierModels = collectModels(ctx).filter(
			(model) => isRecentModel(model) && isModelInTier(model, tier),
		);
		if (tierModels.length === 0) {
			ctx.ui.notify(
				tier === "supervisor"
					? `No authenticated recent supervisor models (${RECENT_MODEL_COHORT}) have output pricing at or above $${FUSION_OUTPUT_PRICE_THRESHOLD}/M.`
					: `No authenticated recent executor models (${RECENT_MODEL_COHORT}) have output pricing at or below $${FUSION_OUTPUT_PRICE_THRESHOLD}/M.`,
				"error",
			);
			return undefined;
		}
		const query = await ctx.ui.input(
			`Search recent Fusion ${tier} models (${RECENT_MODEL_COHORT})`,
			"Provider, model name, or ID (blank for all)",
		);
		if (query === undefined) return undefined;
		const models = searchRecentModels(tierModels, query);
		if (models.length === 0) {
			ctx.ui.notify(`No recent ${tier} models match "${query.trim()}".`, "warning");
			return undefined;
		}
		const byOption = new Map<string, Model<Api>>();
		const options: string[] = [];
		for (const model of models) {
			const option = formatPricedModelLabel(model);
			byOption.set(option, model);
			options.push(option);
		}
		if (preferredLabel) {
			const index = models.findIndex((model) => modelLabel(model) === preferredLabel);
			if (index > 0) {
				options.unshift(options.splice(index, 1)[0]);
			}
		}
		const choice = await selectScrollableOption(ctx, title, options);
		return choice === undefined ? undefined : byOption.get(choice);
	}

	async function selectModelPair(
		ctx: ExtensionContext,
	): Promise<
		{ supervisor: Model<Api>; executor: Model<Api>; supervisorLabel: string; executorLabel: string } | undefined
	> {
		const supervisor = await selectModel(
			ctx,
			"Fusion supervisor model",
			"supervisor",
			ctx.model && isRecentModel(ctx.model) && isModelInTier(ctx.model, "supervisor")
				? modelLabel(ctx.model)
				: undefined,
		);
		if (!supervisor) return undefined;
		const executor = await selectModel(ctx, "Fusion executor model", "executor");
		if (!executor) return undefined;
		return {
			supervisor,
			executor,
			supervisorLabel: modelLabel(supervisor),
			executorLabel: modelLabel(executor),
		};
	}

	async function configureModels(ctx: ExtensionContext): Promise<
		{ supervisor: Model<Api>; executor: Model<Api>; supervisorLabel: string; executorLabel: string } | undefined
	> {
		const pair = await selectModelPair(ctx);
		if (!pair) return undefined;
		state.supervisorModel = pair.supervisor;
		state.supervisorLabel = pair.supervisorLabel;
		state.executorModel = pair.executor;
		state.executorLabel = pair.executorLabel;
		updateWidget(ctx);
		return pair;
	}

	async function ensureExecutor(ctx: ExtensionContext): Promise<AgentSession> {
		if (state.executorSession) return state.executorSession;
		const model = state.executorModel;
		if (!model) {
			throw new Error("No fusion executor model configured. Run /fusion or /fusion-mode first.");
		}
		const cwd = ctx.cwd;
		const agentDir = getAgentDir();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noExtensions: true,
			noPromptTemplates: true,
			appendSystemPrompt: [EXECUTOR_SYSTEM_PROMPT],
		});
		await resourceLoader.reload();
		const thinkingLevel: ThinkingLevel | undefined = ctx.thinkingLevel;
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			thinkingLevel,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
		});
		state.executorSession = session;
		return session;
	}

	pi.registerTool({
		name: "fusion_delegate",
		label: "Fusion Delegate",
		description:
			'Delegate implementation work to the Fusion executor agent. Call with action "execute" and a self-contained brief to start a task, then with action "revise" and consolidated feedback to request fixes (at most 3 revisions).',
		parameters: Type.Object({
			action: Type.Union([Type.Literal("execute"), Type.Literal("revise")]),
			brief: Type.String({ minLength: 1 }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<FusionToolDetails>> {
			const respond = (text: string, error?: string, usage?: Usage): AgentToolResult<FusionToolDetails> => ({
				content: [{ type: "text", text }],
				details: {
					action: params.action,
					revisions: state.revisions,
					executor: executorLabel(),
					output: text,
					error,
					usage,
				},
				usage,
			});
			const emit = (text: string): void => {
				onUpdate?.({
					content: [{ type: "text", text }],
					details: {
						action: params.action,
						revisions: state.revisions,
						executor: executorLabel(),
						output: text,
					},
				});
			};

			if (state.delegating) {
				return respond("A fusion delegation is already in progress. Wait for it to complete before delegating again.");
			}
			if (params.action === "execute" && state.executed) {
				return respond('Initial execution already completed. Review the working tree and use action "revise" with consolidated feedback.');
			}
			if (params.action === "revise" && !state.executed) {
				return respond('Cannot revise before the initial execution. Call fusion_delegate with action "execute" first.');
			}
			if (params.action === "revise" && state.revisions >= MAX_REVISIONS) {
				return respond(
					`Revision limit reached: at most ${MAX_REVISIONS} revisions are allowed. Take over the implementation yourself.`,
				);
			}

			state.delegating = true;
			try {
				const isRevision = params.action === "revise";
				if (isRevision) {
					state.revisions += 1;
					setPhase(ctx, "revising");
				} else {
					disposeExecutor();
					state.runActive = true;
					state.task = params.brief;
					state.revisions = 0;
					state.executed = false;
					setPhase(ctx, "executing");
				}
				emit(
					isRevision
						? `Fusion executor revising (${state.revisions}/${MAX_REVISIONS}) via ${executorLabel()}`
						: `Fusion executor executing via ${executorLabel()}`,
				);
				const promptText = isRevision
					? buildRevisionPrompt(params.brief, state.revisions)
					: buildExecutorPrompt(params.brief);
				if (signal?.aborted) throw new Error("Fusion delegation aborted.");
				const session = await ensureExecutor(ctx);
				if (signal?.aborted) {
					await session.abort();
					throw new Error("Fusion delegation aborted.");
				}
				const abortExecutor = (): void => {
					void session.abort();
				};
				signal?.addEventListener("abort", abortExecutor, { once: true });
				const messageStart = session.messages.length;
				try {
					await session.prompt(promptText, { source: "extension" });
				} finally {
					signal?.removeEventListener("abort", abortExecutor);
				}
				const output = lastAssistantOutput(session);
				const usage = aggregateUsage(session.messages.slice(messageStart));
				state.executed = true;
				if (output.stopReason === "error" || output.stopReason === "aborted") {
					const reason = output.errorMessage ? `: ${output.errorMessage}` : "";
					setPhase(ctx, "failed");
					return respond(
						`Fusion executor stopped with status "${output.stopReason}"${reason}.`,
						output.errorMessage ?? output.stopReason,
						usage,
					);
				}
				setPhase(ctx, "reviewing");
				emit(`Fusion executor finished (${executorLabel()})`);
				return respond(output.text || "The executor finished without producing a text report.", undefined, usage);
			} catch (error) {
				setPhase(ctx, "failed");
				const message = error instanceof Error ? error.message : String(error);
				return respond(`Fusion delegation failed: ${message}`, message);
			} finally {
				state.delegating = false;
			}
		},
	});

	pi.registerCommand("fusion", {
		description: "Run a task through the Fusion supervisor/executor protocol",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Fusion requires a dialog-capable UI.", "error");
				return;
			}
			await ctx.waitForIdle();
			let supervisor = state.supervisorModel;
			let executor = state.executorModel;
			if (!supervisor || !executor) {
				const pair = await configureModels(ctx);
				if (!pair) {
					ctx.ui.notify("Fusion cancelled.", "info");
					return;
				}
				supervisor = pair.supervisor;
				executor = pair.executor;
			}
			let task = args.trim();
			if (!task) {
				task = (await ctx.ui.editor("Fusion task"))?.trim() ?? "";
				if (!task) {
					ctx.ui.notify("Fusion cancelled: no task provided.", "info");
					return;
				}
			}
			const modelSet = await pi.setModel(supervisor);
			if (!modelSet) {
				ctx.ui.notify(
					`Cannot use ${modelLabel(supervisor)} as supervisor: no credentials configured for ${supervisor.provider}.`,
					"error",
				);
				return;
			}
			startRun(ctx, task);
			pi.sendUserMessage(buildSupervisorPrompt(task, modelLabel(executor)));
		},
	});

	pi.registerCommand("fusion-config", {
		description: "Select price-tiered Fusion supervisor and executor models",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Fusion configuration requires a dialog-capable UI.", "error");
				return;
			}
			await ctx.waitForIdle();
			const pair = await configureModels(ctx);
			if (!pair) {
				ctx.ui.notify("Fusion configuration cancelled.", "info");
				return;
			}
			ctx.ui.notify(
				`Fusion configured. Supervisor ${pair.supervisorLabel} (${priceText(pair.supervisor)}), executor ${pair.executorLabel} (${priceText(pair.executor)}). Recent cohort ${RECENT_MODEL_COHORT}.`,
				"info",
			);
		},
	});

	pi.registerCommand("fusion-mode", {
		description: "Toggle Fusion mode for ordinary interactive prompts",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Fusion mode requires a dialog-capable UI.", "error");
				return;
			}
			if (state.modeEnabled) {
				state.modeEnabled = false;
				state.runActive = false;
				state.phase = "idle";
				disposeExecutor();
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.notify("Fusion mode disabled.", "info");
				return;
			}
			let supervisor = state.supervisorModel;
			let executor = state.executorModel;
			if (!supervisor || !executor) {
				const pair = await configureModels(ctx);
				if (!pair) {
					ctx.ui.notify("Fusion mode not enabled.", "info");
					return;
				}
				supervisor = pair.supervisor;
				executor = pair.executor;
			}
			const modelSet = await pi.setModel(supervisor);
			if (!modelSet) {
				ctx.ui.notify(
					`Cannot use ${modelLabel(supervisor)} as supervisor: no credentials configured for ${supervisor.provider}.`,
					"error",
				);
				return;
			}
			state.modeEnabled = true;
			state.phase = "idle";
			updateWidget(ctx);
			ctx.ui.notify(
				`Fusion mode enabled. Supervisor ${modelLabel(supervisor)}, executor ${modelLabel(executor)}.`,
				"info",
			);
		},
	});

	pi.registerCommand("fusion-status", {
		description: "Show Fusion mode status",
		handler: async (_args, ctx) => {
			const mode = state.modeEnabled ? "enabled" : "disabled";
			const supervisor = state.supervisorModel
				? `${modelLabel(state.supervisorModel)} (${priceText(state.supervisorModel)})`
				: "none";
			const executor = state.executorModel
				? `${modelLabel(state.executorModel)} (${priceText(state.executorModel)})`
				: "none";
			ctx.ui.notify(
				`Fusion mode ${mode} | cohort ${RECENT_MODEL_COHORT} | supervisor ${supervisor} | executor ${executor} | phase ${state.phase} | revisions ${state.revisions}/${MAX_REVISIONS}`,
				"info",
			);
		},
	});

	pi.registerCommand("fusion-clean", {
		description: "Dispose executor context and clear Fusion run state",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			disposeExecutor();
			state.runActive = false;
			state.task = undefined;
			state.revisions = 0;
			state.executed = false;
			state.delegating = false;
			state.phase = "idle";
			updateWidget(ctx);
			ctx.ui.notify(
				"Fusion executor context and completed run data cleared. No temporary files were created.",
				"info",
			);
		},
	});

	pi.on("input", (event, ctx) => {
		if (!state.modeEnabled || event.source !== "interactive") {
			return { action: "continue" };
		}
		if (event.text.trim().startsWith("/")) {
			return { action: "continue" };
		}
		if (event.images && event.images.length > 0) {
			ctx.ui.notify("Fusion mode is text-only; image attachments are not supported.", "warning");
			return { action: "handled" };
		}
		if (!state.executorModel) {
			ctx.ui.notify("Fusion mode has no executor configured; run /fusion-mode to reconfigure.", "warning");
			return { action: "continue" };
		}
		startRun(ctx, event.text);
		return { action: "transform", text: buildSupervisorPrompt(event.text, executorLabel()) };
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state.runActive || state.phase === "failed") return;
		setPhase(ctx, "complete");
	});

	pi.on("session_shutdown", () => {
		state.runActive = false;
		state.modeEnabled = false;
		state.phase = "idle";
		disposeExecutor();
	});
}
