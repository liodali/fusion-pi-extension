import { relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
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
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { changedPaths, parsePorcelain } from "./git-changes.ts";
import {
	GIT_TIMEOUT_MS,
	MAX_SCOUT_TOOL_CALLS,
	RENDER_THROTTLE_MS,
	SCOUT_ANSWER_MAX_CHARS,
	TRANSCRIPT_TAIL_LINES,
} from "./limits.ts";
import {
	buildExecutorPrompt,
	buildRevisionPrompt,
	buildScoutPrompt,
	buildSupervisorPrompt,
	EXECUTOR_SYSTEM_PROMPT,
	MAX_REVISIONS,
	MAX_SCOUT_CALLS,
	SCOUT_SYSTEM_PROMPT,
} from "./prompts.ts";
import {
	FUSION_OUTPUT_PRICE_THRESHOLD,
	formatPricedModelLabel,
	type FusionModelTier,
	getOutputPrice,
	isModelInTier,
} from "./pricing.ts";
import {
	appendProgressEntry,
	formatProgressTranscript,
	summarizeToolResult,
	truncateInline,
} from "./progress.ts";
import { isRecentModel, RECENT_MODEL_COHORT, searchRecentModels } from "./recent-models.ts";
import {
	type ExecutorReport,
	formatCompactReport,
	parseExecutorReport,
} from "./report.ts";
import { selectScrollableOption } from "./scrollable-select.ts";
import {
	defaultThinkingLevel,
	orderThinkingLevels,
	scoutDefaultThinkingLevel,
} from "./thinking.ts";
import { createThrottle } from "./throttle.ts";
import {
	addUsage,
	aggregateAssistantUsage,
	aggregateUsage,
	createEmptyUsage,
	formatUsageSummary,
} from "./usage.ts";

const WIDGET_KEY = "fusion";

type FusionPhase =
	| "idle"
	| "planning"
	| "executing"
	| "reviewing"
	| "revising"
	| "scouting"
	| "complete"
	| "failed";

interface FusionTimings {
	readyMs?: number;
	firstEventMs?: number;
	totalMs?: number;
}

interface FusionToolDetails {
	action: "execute" | "revise";
	revisions: number;
	executor: string;
	output: string;
	error?: string;
	usage?: Usage;
	timings?: FusionTimings;
	report?: ExecutorReport;
	diffStat?: string;
	transcript?: string;
}

interface FusionScoutDetails {
	answer: string;
	error?: string;
	usage?: Usage;
	transcript?: string;
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
	supervisorThinking: ThinkingLevel;
	executorThinking: ThinkingLevel;
	scoutThinking: ThinkingLevel;
	executorBrief?: string;
	executorSession?: AgentSession;
	executorSessionModel?: Model<Api>;
	executorSessionThinking?: ThinkingLevel;
	executorReady?: Promise<AgentSession>;
	executorUsed: boolean;
	lastTimings?: FusionTimings;
	scoutCalls: number;
	scoutUsage: Usage;
	supervisorUsage: Usage;
	executorUsage: Usage;
	executorActivity?: string;
	executorOutput?: string;
	executorTranscript: string[];
}

function modelLabel(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function priceText(model: Model<Api>): string {
	const price = getOutputPrice(model);
	return price === undefined ? "price unknown" : `$${price.toFixed(2)}/M output`;
}

function describeExecutorTool(toolName: string, args: unknown): string {
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		for (const key of ["file_path", "path", "command", "pattern", "query"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim().length > 0) {
				return `${toolName} ${truncateInline(value)}`;
			}
		}
	}
	return toolName;
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
		supervisorThinking: "off",
		executorThinking: "off",
		scoutThinking: "off",
		executorUsed: false,
		scoutCalls: 0,
		scoutUsage: createEmptyUsage(),
		supervisorUsage: createEmptyUsage(),
		executorUsage: createEmptyUsage(),
		executorTranscript: [],
	};

	const executorLabel = (): string =>
		state.executorLabel ?? (state.executorModel ? modelLabel(state.executorModel) : "unconfigured");

	const appendExecutorProgress = (entry: string): void => {
		state.executorTranscript = appendProgressEntry(state.executorTranscript, entry);
	};

	const executorProgressText = (): string => {
		const transcript = formatProgressTranscript(state.executorTranscript, state.executorOutput);
		const header = `Fusion executor: ${state.executorActivity ?? "working"}`;
		return transcript ? `${header}\n\n${transcript}` : header;
	};

	function updateWidget(ctx: ExtensionContext): void {
		if (!state.runActive && !state.modeEnabled) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, [
			`Fusion: ${state.phase}`,
			`Supervisor: ${state.supervisorLabel ?? "-"} (thinking ${state.supervisorThinking})`,
			`  Usage: ${formatUsageSummary(state.supervisorUsage)}`,
			`Executor: ${state.executorLabel ?? "-"} (thinking ${state.executorThinking})`,
			`  Usage: ${formatUsageSummary(state.executorUsage)}`,
			`Activity: ${state.executorActivity ?? "-"}`,
			`Revisions: ${state.revisions}/${MAX_REVISIONS}`,
			`Scout: ${state.scoutCalls}/${MAX_SCOUT_CALLS} calls, ${formatUsageSummary(state.scoutUsage)} (thinking ${state.scoutThinking})`,
		]);
	}

	function setPhase(ctx: ExtensionContext, phase: FusionPhase): void {
		state.phase = phase;
		updateWidget(ctx);
	}

	const FUSION_TOOL_NAMES = ["fusion_delegate", "fusion_scout"];

	function syncFusionTools(): void {
		const active = pi.getActiveTools();
		const next = active.filter((name) => !FUSION_TOOL_NAMES.includes(name));
		if (state.runActive || state.modeEnabled) {
			next.push(...FUSION_TOOL_NAMES);
		}
		const nextSet = new Set(next);
		const changed =
			next.length !== active.length || active.some((name) => !nextSet.has(name));
		if (changed) {
			pi.setActiveTools(next);
		}
	}

	function executorConfigMatches(): boolean {
		return (
			state.executorSessionModel !== undefined &&
			state.executorSessionModel === state.executorModel &&
			state.executorSessionThinking === state.executorThinking
		);
	}

	function disposeExecutor(): void {
		const session = state.executorSession;
		const ready = state.executorReady;
		state.executorSession = undefined;
		state.executorSessionModel = undefined;
		state.executorSessionThinking = undefined;
		state.executorReady = undefined;
		state.executorUsed = false;
		state.executorActivity = undefined;
		state.executorOutput = undefined;
		try {
			session?.dispose();
		} catch {}
		void ready?.then(
			(pending) => {
				if (pending !== session) {
					try {
						pending.dispose();
					} catch {}
				}
			},
			() => {},
		);
	}

	const executorResourceLoaders = new Map<string, DefaultResourceLoader>();
	const scoutResourceLoaders = new Map<string, DefaultResourceLoader>();

	async function cachedResourceLoader(
		cache: Map<string, DefaultResourceLoader>,
		cwd: string,
		systemPrompt: string,
	): Promise<DefaultResourceLoader> {
		const cached = cache.get(cwd);
		if (cached) return cached;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noPromptTemplates: true,
			appendSystemPrompt: [systemPrompt],
		});
		await loader.reload();
		cache.set(cwd, loader);
		return loader;
	}

	function launchExecutor(ctx: ExtensionContext): void {
		const model = state.executorModel;
		if (!model) return;
		const thinking = state.executorThinking;
		const cwd = ctx.cwd;
		const agentDir = getAgentDir();
		state.executorSessionModel = model;
		state.executorSessionThinking = thinking;
		const ready = (async (): Promise<AgentSession> => {
			const resourceLoader = await cachedResourceLoader(
				executorResourceLoaders,
				cwd,
				EXECUTOR_SYSTEM_PROMPT,
			);
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				thinkingLevel: thinking,
				resourceLoader,
				sessionManager: SessionManager.inMemory(cwd),
			});
			return session;
		})();
		state.executorReady = ready;
		void ready.then(
			(session) => {
				if (state.executorReady === ready) {
					state.executorSession = session;
					state.executorUsed = false;
				} else {
					try {
						session.dispose();
					} catch {}
				}
			},
			() => {
				if (state.executorReady === ready) {
					state.executorReady = undefined;
					state.executorSessionModel = undefined;
					state.executorSessionThinking = undefined;
				}
			},
		);
	}

	function warmExecutor(ctx: ExtensionContext): void {
		if (!state.executorModel) {
			disposeExecutor();
			return;
		}
		if (state.executorUsed || !executorConfigMatches()) {
			disposeExecutor();
		}
		if (!state.executorReady && !state.executorSession) {
			launchExecutor(ctx);
		}
	}

	function touchedPath(args: unknown): string | undefined {
		if (args && typeof args === "object") {
			const record = args as Record<string, unknown>;
			for (const key of ["path", "file_path"]) {
				const value = record[key];
				if (typeof value === "string" && value.trim().length > 0) {
					return value;
				}
			}
		}
		return undefined;
	}

	async function gitToplevel(ctx: ExtensionContext): Promise<string | undefined> {
		try {
			const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
				cwd: ctx.cwd,
				timeout: GIT_TIMEOUT_MS,
			});
			if (result.code !== 0) return undefined;
			return result.stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	}

	async function gitPorcelain(toplevel: string): Promise<Map<string, string> | undefined> {
		try {
			const status = await pi.exec("git", ["status", "--porcelain"], {
				cwd: toplevel,
				timeout: GIT_TIMEOUT_MS,
			});
			if (status.code !== 0) return undefined;
			return parsePorcelain(status.stdout);
		} catch {
			return undefined;
		}
	}

	async function executorDiffStat(
		ctx: ExtensionContext,
		toplevel: string,
		before: Map<string, string> | undefined,
		after: Map<string, string> | undefined,
		touchedFiles: ReadonlySet<string>,
	): Promise<string | undefined> {
		if (!before || !after) return undefined;
		try {
			const touchedRepoPaths = [...touchedFiles]
				.map((path) => relative(toplevel, resolve(ctx.cwd, path)))
				.filter((path) => path.length > 0 && !path.startsWith(".."));
			const { modified, added } = changedPaths(before, after);
			const diffPaths = new Set(modified);
			for (const path of touchedRepoPaths) {
				if (after.has(path)) diffPaths.add(path);
			}
			const remaining = touchedRepoPaths.filter((path) => !diffPaths.has(path));
			if (remaining.length > 0) {
				const names = await pi.exec("git", ["diff", "--name-only", "--", ...remaining], {
					cwd: toplevel,
					timeout: GIT_TIMEOUT_MS,
				});
				if (names.code !== 0) return undefined;
				for (const line of names.stdout.split("\n")) {
					const path = line.trim();
					if (path) diffPaths.add(path);
				}
			}
			const parts: string[] = [];
			if (diffPaths.size > 0) {
				const diff = await pi.exec("git", ["diff", "--stat", "--", ...diffPaths], {
					cwd: toplevel,
					timeout: GIT_TIMEOUT_MS,
				});
				if (diff.code !== 0) return undefined;
				if (diff.stdout.trim()) {
					parts.push(diff.stdout.trim());
				}
			}
			for (const path of added) {
				parts.push(`new: ${path}`);
			}
			return parts.length > 0 ? parts.join("\n") : undefined;
		} catch {
			return undefined;
		}
	}

	function startRun(ctx: ExtensionContext, task: string): void {
		warmExecutor(ctx);
		state.executorActivity = undefined;
		state.executorOutput = undefined;
		state.runActive = true;
		syncFusionTools();
		state.task = task;
		state.revisions = 0;
		state.executed = false;
		state.supervisorUsage = createEmptyUsage();
		state.executorUsage = createEmptyUsage();
		state.executorTranscript = [];
		state.scoutCalls = 0;
		state.scoutUsage = createEmptyUsage();
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

	async function selectThinkingLevel(
		ctx: ExtensionContext,
		model: Model<Api>,
		role: "supervisor" | "executor" | "scout",
		pickDefault: (levels: readonly ModelThinkingLevel[]) => ThinkingLevel,
	): Promise<ThinkingLevel> {
		const levels = getSupportedThinkingLevels(model);
		const ordered = orderThinkingLevels(levels);
		const defaultLevel = pickDefault(levels);
		if (ordered.length <= 1) {
			return defaultLevel;
		}
		const options = [
			`${defaultLevel} (default)`,
			...ordered.filter((level) => level !== defaultLevel),
		];
		const choice = await selectScrollableOption(ctx, `Fusion ${role} thinking level`, options);
		if (choice === undefined) return defaultLevel;
		return (
			ordered.find((level) => level === choice.replace(/ \(default\)$/, "")) ??
			defaultLevel
		);
	}

	async function selectModelPair(
		ctx: ExtensionContext,
	): Promise<
		| {
				supervisor: Model<Api>;
				executor: Model<Api>;
				supervisorLabel: string;
				executorLabel: string;
				supervisorThinking: ThinkingLevel;
				executorThinking: ThinkingLevel;
				scoutThinking: ThinkingLevel;
			}
		| undefined
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
		const supervisorThinking = await selectThinkingLevel(
			ctx,
			supervisor,
			"supervisor",
			defaultThinkingLevel,
		);
		const executor = await selectModel(ctx, "Fusion executor model", "executor");
		if (!executor) return undefined;
		const executorThinking = await selectThinkingLevel(
			ctx,
			executor,
			"executor",
			defaultThinkingLevel,
		);
		const scoutThinking = await selectThinkingLevel(
			ctx,
			executor,
			"scout",
			scoutDefaultThinkingLevel,
		);
		return {
			supervisor,
			executor,
			supervisorLabel: modelLabel(supervisor),
			executorLabel: modelLabel(executor),
			supervisorThinking,
			executorThinking,
			scoutThinking,
		};
	}

	async function configureModels(ctx: ExtensionContext): Promise<
		| {
				supervisor: Model<Api>;
				executor: Model<Api>;
				supervisorLabel: string;
				executorLabel: string;
				supervisorThinking: ThinkingLevel;
				executorThinking: ThinkingLevel;
				scoutThinking: ThinkingLevel;
			}
		| undefined
	> {
		const pair = await selectModelPair(ctx);
		if (!pair) return undefined;
		state.supervisorModel = pair.supervisor;
		state.supervisorLabel = pair.supervisorLabel;
		state.supervisorThinking = pair.supervisorThinking;
		state.executorModel = pair.executor;
		state.executorLabel = pair.executorLabel;
		state.executorThinking = pair.executorThinking;
		state.scoutThinking = pair.scoutThinking;
		disposeExecutor();
		warmExecutor(ctx);
		updateWidget(ctx);
		return pair;
	}

	async function ensureExecutor(ctx: ExtensionContext): Promise<AgentSession> {
		if (!state.executorModel) {
			throw new Error("No fusion executor model configured. Run /fusion or /fusion-mode first.");
		}
		if (!executorConfigMatches()) {
			disposeExecutor();
		}
		if (state.executorSession) {
			return state.executorSession;
		}
		if (!state.executorReady) {
			launchExecutor(ctx);
		}
		if (!state.executorReady) {
			throw new Error("Fusion executor session did not start.");
		}
		return state.executorReady;
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
			const timings: FusionTimings = {};
			const respond = (
				text: string,
				error?: string,
				usage?: Usage,
				extras?: { output?: string; report?: ExecutorReport; diffStat?: string },
			): AgentToolResult<FusionToolDetails> => ({
				content: [{ type: "text", text }],
				details: {
					action: params.action,
					revisions: state.revisions,
					executor: executorLabel(),
					output: extras?.output ?? text,
					error,
					usage,
					timings,
					report: extras?.report,
					diffStat: extras?.diffStat,
					transcript: executorProgressText(),
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
						timings,
						transcript: executorProgressText(),
					},
				});
			};
			const renderThrottle = createThrottle(() => {
				emit(executorProgressText());
				updateWidget(ctx);
			}, RENDER_THROTTLE_MS);
			const scheduleRender = renderThrottle.schedule;
			const timingLine = (): string =>
				`Timing: ready ${timings.readyMs ?? "-"}ms, first event ${timings.firstEventMs ?? "-"}ms, total ${timings.totalMs ?? "-"}ms`;

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
			const startedAt = Date.now();
			try {
				const isRevision = params.action === "revise";
				if (isRevision) {
					state.revisions += 1;
					setPhase(ctx, "revising");
					appendExecutorProgress(
						`[revision ${state.revisions}/${MAX_REVISIONS}] Executor resumed with ${executorLabel()}`,
					);
				} else {
					if (state.executorUsed || !executorConfigMatches()) {
						disposeExecutor();
					}
					state.runActive = true;
					state.task = params.brief;
					state.executorBrief = params.brief;
					state.revisions = 0;
					state.executed = false;
					setPhase(ctx, "executing");
					appendExecutorProgress(`[execute] Executor started with ${executorLabel()}`);
				}
				emit(executorProgressText());
				if (signal?.aborted) throw new Error("Fusion delegation aborted.");
				const session = await ensureExecutor(ctx);
				timings.readyMs = Date.now() - startedAt;
				const promptText = isRevision
					? buildRevisionPrompt(
							params.brief,
							state.revisions,
							state.executorUsed ? undefined : state.executorBrief,
						)
					: buildExecutorPrompt(params.brief);
				if (signal?.aborted) {
					await session.abort();
					throw new Error("Fusion delegation aborted.");
				}
				const abortExecutor = (): void => {
					void session.abort();
				};
				signal?.addEventListener("abort", abortExecutor, { once: true });
				const messageStart = session.messages.length;
				const touchedFiles = new Set<string>();
				let liveText = "";
				const unsubscribe = session.subscribe((event) => {
					if (timings.firstEventMs === undefined) {
						timings.firstEventMs = Date.now() - startedAt;
					}
					if (event.type === "message_update") {
						const streamEvent = event.assistantMessageEvent;
						if (streamEvent.type === "thinking_start") {
							state.executorActivity = "reasoning";
							appendExecutorProgress("[reasoning] Executor is reasoning privately.");
							scheduleRender();
						} else if (streamEvent.type === "text_start") {
							liveText = "";
							state.executorOutput = undefined;
						} else if (streamEvent.type === "text_delta") {
							liveText += streamEvent.delta;
							state.executorOutput = liveText;
							state.executorActivity = "writing";
							scheduleRender();
						} else if (streamEvent.type === "text_end") {
							const content = streamEvent.content.trim();
							if (content) {
								appendExecutorProgress(`[executor]\n${content}`);
							}
							liveText = "";
							state.executorOutput = undefined;
							state.executorActivity = "working";
							scheduleRender();
						}
					} else if (event.type === "tool_execution_start") {
						if (event.toolName === "edit" || event.toolName === "write") {
							const path = touchedPath(event.args);
							if (path) touchedFiles.add(path);
						}
						state.executorActivity = `running ${describeExecutorTool(event.toolName, event.args)}`;
						appendExecutorProgress(`[tool] ${describeExecutorTool(event.toolName, event.args)}`);
						scheduleRender();
					} else if (event.type === "tool_execution_end") {
						appendExecutorProgress(`[${event.isError ? "failed" : "done"}] ${event.toolName}`);
						const summary = summarizeToolResult(event.result);
						if (summary) {
							appendExecutorProgress(`[result]\n${summary}`);
						}
						state.executorActivity = `${event.toolName} ${event.isError ? "failed" : "completed"}`;
						scheduleRender();
					}
				});
				state.executorUsed = true;
				const toplevel = await gitToplevel(ctx);
				const porcelainBefore = toplevel ? await gitPorcelain(toplevel) : undefined;
				try {
					await session.prompt(promptText, { source: "extension" });
				} finally {
					signal?.removeEventListener("abort", abortExecutor);
					unsubscribe();
				}
				const porcelainAfter = toplevel ? await gitPorcelain(toplevel) : undefined;
				timings.totalMs = Date.now() - startedAt;
				state.lastTimings = { ...timings };
				const output = lastAssistantOutput(session);
				const usage = aggregateUsage(session.messages.slice(messageStart));
				state.executorUsage = addUsage(state.executorUsage, usage);
				state.executed = true;
				if (output.stopReason === "error" || output.stopReason === "aborted") {
					const reason = output.errorMessage ? `: ${output.errorMessage}` : "";
					state.executorActivity = "failed";
					appendExecutorProgress(
						`[failed] Executor stopped with status "${output.stopReason}"${reason}.`,
					);
					setPhase(ctx, "failed");
					renderThrottle.flush();
					return respond(
						`Fusion executor stopped with status "${output.stopReason}"${reason}.\n\nExecutor usage this delegation: ${formatUsageSummary(usage)}\nExecutor usage this run: ${formatUsageSummary(state.executorUsage)}\n${timingLine()}`,
						output.errorMessage ?? output.stopReason,
						usage,
					);
				}
				state.executorActivity = "finished";
				appendExecutorProgress("[finished] Executor completed the delegation.");
				setPhase(ctx, "reviewing");
				const parsed = parseExecutorReport(output.text);
				const diffStat = toplevel
					? await executorDiffStat(
							ctx,
							toplevel,
							porcelainBefore,
							porcelainAfter,
							touchedFiles,
						)
					: undefined;
				renderThrottle.flush();
				return respond(
					`${formatCompactReport(parsed.report, diffStat, parsed.prose)}\n\nExecutor usage this delegation: ${formatUsageSummary(usage)}\nExecutor usage this run: ${formatUsageSummary(state.executorUsage)}\n${timingLine()}`,
					undefined,
					usage,
					{
						output: parsed.prose || output.text,
						report: parsed.report,
						diffStat,
					},
				);
			} catch (error) {
				timings.totalMs = Date.now() - startedAt;
				state.lastTimings = { ...timings };
				state.executorActivity = "failed";
				const message = error instanceof Error ? error.message : String(error);
				appendExecutorProgress(`[failed] ${message}`);
				setPhase(ctx, "failed");
				renderThrottle.flush();
				return respond(`Fusion delegation failed: ${message}\n${timingLine()}`, message);
			} finally {
				renderThrottle.cancel();
				state.delegating = false;
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("fusion_delegate ")) + theme.fg("muted", args.action),
				0,
				0,
			);
		},
		renderResult(result, { isPartial }, theme) {
			const details = result.details as FusionToolDetails | undefined;
			const transcript = details?.transcript;
			if (details?.report && !isPartial) {
				const lines: string[] = [];
				if (transcript) {
					const transcriptLines = transcript.split("\n");
					const tail = transcriptLines.slice(-TRANSCRIPT_TAIL_LINES);
					if (transcriptLines.length > tail.length) {
						lines.push(theme.fg("muted", `… ${transcriptLines.length - tail.length} earlier lines`));
					}
					for (const line of tail) {
						lines.push(theme.fg("muted", line));
					}
					lines.push("");
				}
				let inBlockers = false;
				for (const line of formatCompactReport(
					details.report,
					details.diffStat,
					details.output,
				).split("\n")) {
					if (!line.startsWith("- ") && line !== "Blockers:") inBlockers = false;
					if (line === "Blockers:") inBlockers = true;
					if (line.startsWith("Status:")) {
						lines.push(theme.fg("text", theme.bold(line)));
					} else if (line.startsWith("- PASS")) {
						lines.push(theme.fg("success", line));
					} else if (line.startsWith("- FAIL") || inBlockers) {
						lines.push(theme.fg("error", line));
					} else {
						lines.push(theme.fg("text", line));
					}
				}
				return new Text(lines.join("\n"), 0, 0);
			}
			const fallback = result.content.find((part) => part.type === "text");
			const text = transcript || (fallback?.type === "text" ? fallback.text : "");
			const color = details?.error ? "error" : isPartial ? "muted" : "text";
			return new Text(theme.fg(color, text), 0, 0);
		},
	});

	pi.registerTool({
		name: "fusion_scout",
		label: "Fusion Scout",
		description:
			"Ask the Fusion scout read-only questions about this repository. Runs on the cheap executor model in an isolated session with read-only tools (read, grep, find, ls). Pass 1-5 questions; each call answers all of them with path:line citations. At most 4 calls per run.",
		parameters: Type.Object({
			questions: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 5 }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<FusionScoutDetails>> {
			let scoutTranscript: string[] = [];
			let scoutActivity = "scouting";
			const appendScoutProgress = (entry: string): void => {
				scoutTranscript = appendProgressEntry(scoutTranscript, entry);
			};
			const scoutTranscriptText = (): string => {
				const transcript = formatProgressTranscript(scoutTranscript);
				const header = `Fusion scout: ${scoutActivity}`;
				return transcript ? `${header}\n\n${transcript}` : header;
			};
			const respond = (text: string, error?: string, usage?: Usage): AgentToolResult<FusionScoutDetails> => ({
				content: [{ type: "text", text }],
				details: {
					answer: text,
					error,
					usage,
					transcript: scoutTranscriptText(),
				},
				usage,
			});
			const emit = (text: string): void => {
				onUpdate?.({
					content: [{ type: "text", text }],
					details: {
						answer: text,
						transcript: scoutTranscriptText(),
					},
				});
			};
			const renderThrottle = createThrottle(() => {
				emit(scoutTranscriptText());
				updateWidget(ctx);
			}, RENDER_THROTTLE_MS);
			const scheduleRender = renderThrottle.schedule;

			if (state.scoutCalls >= MAX_SCOUT_CALLS) {
				return respond(
					`Scout limit reached: at most ${MAX_SCOUT_CALLS} fusion_scout calls are allowed per run.`,
				);
			}

			if (!state.executorModel) {
				return respond("No fusion executor model configured. Run /fusion-config first.");
			}

			state.scoutCalls += 1;
			const previousPhase = state.phase;
			setPhase(ctx, "scouting");
			appendScoutProgress(`[scout] Scouting ${params.questions.length} question(s) with ${executorLabel()}`);
			emit(scoutTranscriptText());
			let session: AgentSession | undefined;
			try {
				const cwd = ctx.cwd;
				const resourceLoader = await cachedResourceLoader(
					scoutResourceLoaders,
					cwd,
					SCOUT_SYSTEM_PROMPT,
				);
				const created = await createAgentSession({
					cwd,
					agentDir: getAgentDir(),
					model: state.executorModel,
					thinkingLevel: state.scoutThinking,
					resourceLoader,
					sessionManager: SessionManager.inMemory(cwd),
					tools: ["read", "grep", "find", "ls"],
				});
				session = created.session;
				if (signal?.aborted) {
					await session.abort();
					throw new Error("Fusion scout aborted.");
				}
				const abortScout = (): void => {
					void session?.abort();
				};
				signal?.addEventListener("abort", abortScout, { once: true });
				const messageStart = session.messages.length;
				let toolCalls = 0;
				let capped = false;
				const unsubscribe = session.subscribe((event) => {
					if (event.type === "tool_execution_start") {
						toolCalls += 1;
						if (toolCalls > MAX_SCOUT_TOOL_CALLS && !capped) {
							capped = true;
							void session?.abort();
						}
						scoutActivity = `running ${describeExecutorTool(event.toolName, event.args)}`;
						appendScoutProgress(`[tool] ${describeExecutorTool(event.toolName, event.args)}`);
						scheduleRender();
					} else if (event.type === "tool_execution_end") {
						appendScoutProgress(`[${event.isError ? "failed" : "done"}] ${event.toolName}`);
						scoutActivity = `${event.toolName} ${event.isError ? "failed" : "completed"}`;
						scheduleRender();
					}
				});
				try {
					await session.prompt(buildScoutPrompt(params.questions), { source: "extension" });
				} finally {
					signal?.removeEventListener("abort", abortScout);
					unsubscribe();
				}
				const output = lastAssistantOutput(session);
				const usage = aggregateUsage(session.messages.slice(messageStart));
				state.scoutUsage = addUsage(state.scoutUsage, usage);
				if (capped && output.text.trim()) {
					const partial =
						output.text.trim().length <= SCOUT_ANSWER_MAX_CHARS
							? output.text.trim()
							: `${output.text.trim().slice(0, SCOUT_ANSWER_MAX_CHARS - 1)}…`;
					appendScoutProgress(
						`[capped] Scout stopped after ${MAX_SCOUT_TOOL_CALLS} tool calls.`,
					);
					renderThrottle.flush();
					return respond(
						`Scout stopped after ${MAX_SCOUT_TOOL_CALLS} tool calls; partial answer:\n${partial}\n\nScout usage: ${formatUsageSummary(usage)}`,
						undefined,
						usage,
					);
				}
				if (output.stopReason === "error" || output.stopReason === "aborted") {
					const reason = output.errorMessage ? `: ${output.errorMessage}` : "";
					appendScoutProgress(
						`[failed] Scout stopped with status "${output.stopReason}"${reason}.`,
					);
					renderThrottle.flush();
					return respond(
						`Fusion scout stopped with status "${output.stopReason}"${reason}.\n\nScout usage: ${formatUsageSummary(usage)}`,
						output.errorMessage ?? output.stopReason,
						usage,
					);
				}
				const answer = (output.text || "The scout returned no answer.").trim();
				const truncated =
					answer.length <= SCOUT_ANSWER_MAX_CHARS
						? answer
						: `${answer.slice(0, SCOUT_ANSWER_MAX_CHARS - 1)}…`;
				appendScoutProgress("[done] Scout answered.");
				renderThrottle.flush();
				return respond(
					`${truncated}\n\nScout usage: ${formatUsageSummary(usage)}`,
					undefined,
					usage,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				appendScoutProgress(`[failed] ${message}`);
				renderThrottle.flush();
				return respond(`Fusion scout failed: ${message}`, message);
			} finally {
				renderThrottle.cancel();
				try {
					session?.dispose();
				} catch {}
				if (state.phase === "scouting") {
					setPhase(ctx, previousPhase);
				}
			}
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("fusion_scout ")) +
					theme.fg("muted", `${args.questions.length} question(s)`),
				0,
				0,
			);
		},
		renderResult(result, { isPartial }, theme) {
			const details = result.details as FusionScoutDetails | undefined;
			const fallback = result.content.find((part) => part.type === "text");
			const text =
				(isPartial ? details?.transcript : undefined) ||
				(fallback?.type === "text" ? fallback.text : "");
			const color = details?.error ? "error" : isPartial ? "muted" : "text";
			return new Text(theme.fg(color, text), 0, 0);
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
			pi.setThinkingLevel(state.supervisorThinking);
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
				`Fusion configured. Supervisor ${pair.supervisorLabel} (${priceText(pair.supervisor)}, thinking ${pair.supervisorThinking}), executor ${pair.executorLabel} (${priceText(pair.executor)}, thinking ${pair.executorThinking}), scout thinking ${pair.scoutThinking}. Recent cohort ${RECENT_MODEL_COHORT}.`,
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
				syncFusionTools();
				state.supervisorUsage = createEmptyUsage();
				state.executorUsage = createEmptyUsage();
				state.executorTranscript = [];
				state.scoutCalls = 0;
				state.scoutUsage = createEmptyUsage();
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
			pi.setThinkingLevel(state.supervisorThinking);
			state.modeEnabled = true;
			syncFusionTools();
			state.phase = "idle";
			updateWidget(ctx);
			ctx.ui.notify(
				`Fusion mode enabled. Supervisor ${modelLabel(supervisor)} (thinking ${state.supervisorThinking}), executor ${modelLabel(executor)} (thinking ${state.executorThinking}).`,
				"info",
			);
		},
	});

	pi.registerCommand("fusion-status", {
		description: "Show Fusion mode status",
		handler: async (_args, ctx) => {
			const mode = state.modeEnabled ? "enabled" : "disabled";
			const supervisor = state.supervisorModel
				? `${modelLabel(state.supervisorModel)} (${priceText(state.supervisorModel)}, thinking ${state.supervisorThinking})`
				: "none";
			const executor = state.executorModel
				? `${modelLabel(state.executorModel)} (${priceText(state.executorModel)}, thinking ${state.executorThinking})`
				: "none";
			const lastTimings = state.lastTimings
				? ` | last timing ready ${state.lastTimings.readyMs ?? "-"}ms, first event ${state.lastTimings.firstEventMs ?? "-"}ms, total ${state.lastTimings.totalMs ?? "-"}ms`
				: "";
			ctx.ui.notify(
				`Fusion mode ${mode} | cohort ${RECENT_MODEL_COHORT} | supervisor ${supervisor} | executor ${executor} | phase ${state.phase} | revisions ${state.revisions}/${MAX_REVISIONS} | scout calls ${state.scoutCalls}/${MAX_SCOUT_CALLS} | scout thinking ${state.scoutThinking} | scout usage ${formatUsageSummary(state.scoutUsage)} | supervisor usage ${formatUsageSummary(state.supervisorUsage)} | executor usage ${formatUsageSummary(state.executorUsage)} | executor activity ${state.executorActivity ?? "-"}${lastTimings}`,
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
			syncFusionTools();
			state.task = undefined;
			state.revisions = 0;
			state.executed = false;
			state.delegating = false;
			state.phase = "idle";
			state.supervisorUsage = createEmptyUsage();
			state.executorUsage = createEmptyUsage();
			state.executorTranscript = [];
			state.scoutCalls = 0;
			state.scoutUsage = createEmptyUsage();
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
		pi.setThinkingLevel(state.supervisorThinking);
		return { action: "transform", text: buildSupervisorPrompt(event.text, executorLabel()) };
	});

	pi.on("agent_end", (event, ctx) => {
		if (!state.runActive) return;
		state.supervisorUsage = addUsage(state.supervisorUsage, aggregateAssistantUsage(event.messages));
		updateWidget(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state.runActive) return;
		if (state.phase !== "failed") {
			setPhase(ctx, "complete");
		}
		if (!state.modeEnabled) {
			state.runActive = false;
		}
		syncFusionTools();
	});

	pi.on("session_start", () => {
		try {
			syncFusionTools();
		} catch {}
	});

	pi.on("session_shutdown", () => {
		state.runActive = false;
		state.modeEnabled = false;
		state.phase = "idle";
		state.supervisorUsage = createEmptyUsage();
		state.executorUsage = createEmptyUsage();
		state.executorTranscript = [];
		state.scoutCalls = 0;
		state.scoutUsage = createEmptyUsage();
		disposeExecutor();
		try {
			syncFusionTools();
		} catch {}
	});

	try {
		syncFusionTools();
	} catch {}
}
