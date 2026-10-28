import { relative, resolve } from "node:path";
import { FusionController } from "./core/controller.ts";
import { delegationError, scoutLimitError } from "./core/workflow.ts";
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
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createSessionExecutorBackend,
	type ExecutorBackend,
	type ExecutorEvent,
	type ExecutorHandle,
	type ExecutorTurnResult,
} from "./executor-backend.ts";
import { changedPaths, hashFiles, parsePorcelain } from "./git-changes.ts";
import {
	GIT_TIMEOUT_MS,
	MAX_HASHED_DIRTY_PATHS,
	MAX_SCOUT_TOOL_CALLS,
	RENDER_THROTTLE_MS,
	SCOUT_ANSWER_MAX_CHARS,
	TOOL_STREAM_TAIL_LINES,
	TRANSCRIPT_TAIL_LINES,
} from "./limits.ts";
import { type DelegationAction, formatRunStats } from "./metrics.ts";
import {
	buildExecutorPrompt,
	buildFinalFixPrompt,
	buildRevisionPrompt,
	buildScoutPrompt,
	buildSupervisorPrompt,
	MAX_FINAL_FIXES,
	MAX_REVISIONS,
	MAX_SCOUT_CALLS,
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
	formatDuration,
	formatProgressTranscript,
	formatReasoningSize,
	MAX_PROGRESS_CHARS,
	summarizeToolResult,
	tailLines,
	truncateInline,
} from "./progress.ts";
import {
	filterModelsByQuery,
	isRecentModel,
	RECENT_MODEL_COHORT,
} from "./recent-models.ts";
import {
	type ExecutorReport,
	formatCompactReport,
	parseExecutorReport,
} from "./report.ts";
import {
	type FusionRun,
	delegationKey,
	listRuns,
	markInterrupted,
	newRunId,
	runsDir,
	writeRun,
} from "./runs.ts";
import { selectScrollableOption, selectSearchableOption } from "./scrollable-select.ts";
import { needsContinuation } from "./settle.ts";
import {
	defaultThinkingLevel,
	orderThinkingLevels,
	scoutDefaultThinkingLevel,
	smallTaskThinkingLevel,
} from "./thinking.ts";
import { createThrottle } from "./throttle.ts";
import {
	addUsage,
	aggregateAssistantUsage,
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
	| "finalizing"
	| "scouting"
	| "complete"
	| "failed";

type ExecutorBackendKind = "session" | "durable";

interface FusionTimings {
	readyMs?: number;
	firstEventMs?: number;
	totalMs?: number;
}

interface FusionToolDetails {
	action: DelegationAction;
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
	finalFixUsed: boolean;
	executed: boolean;
	delegating: boolean;
	settleNudges: number;
	task?: string;
	originalTask?: string;
	supervisorModel?: Model<Api>;
	executorModel?: Model<Api>;
	supervisorLabel?: string;
	executorLabel?: string;
	supervisorThinking: ThinkingLevel;
	executorThinking: ThinkingLevel;
	scoutThinking: ThinkingLevel;
	executorBrief?: string;
	executorBackend: ExecutorBackendKind;
	executorHandle?: ExecutorHandle;
	executorSessionBackend?: ExecutorBackendKind;
	executorSessionModel?: Model<Api>;
	executorSessionThinking?: ThinkingLevel;
	executorReady?: Promise<ExecutorHandle>;
	executorUsed: boolean;
	lastTimings?: FusionTimings;
	scoutCalls: number;
	scoutMs: number;
	scoutUsage: Usage;
	supervisorUsage: Usage;
	executorUsage: Usage;
	executorActivity?: string;
	executorOutput?: string;
	executorTranscript: string[];
	runId?: string;
	runStartedAt?: string;
	activeRun?: FusionRun;
	delegationStartedAt?: number;
	resumePending: boolean;
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

export default function (pi: ExtensionAPI) {
	const state: FusionState = {
		modeEnabled: false,
		runActive: false,
		phase: "idle",
		revisions: 0,
		finalFixUsed: false,
		executed: false,
		delegating: false,
		settleNudges: 0,
		supervisorThinking: "off",
		executorThinking: "off",
		scoutThinking: "off",
		executorUsed: false,
		scoutCalls: 0,
		scoutMs: 0,
		scoutUsage: createEmptyUsage(),
		supervisorUsage: createEmptyUsage(),
		executorUsage: createEmptyUsage(),
		executorTranscript: [],
		executorBackend: "session",
		resumePending: false,
	};

	const sessionBackend = createSessionExecutorBackend();
	const controller = new FusionController(state);
	let loadDurablePromise: Promise<ExecutorBackend | undefined> | undefined;
	let durableUnavailable: string | undefined;

	function loadDurableBackend(): Promise<ExecutorBackend | undefined> {
		loadDurablePromise ??= import("./pi/durable/backend.ts")
			.then((module) => module.createDurableExecutorBackend())
			.catch((error: unknown) => {
				durableUnavailable = error instanceof Error ? error.message : String(error);
				return undefined;
			});
		return loadDurablePromise;
	}

	async function activeBackend(): Promise<ExecutorBackend> {
		if (state.executorBackend === "session") {
			return sessionBackend;
		}
		const durable = await loadDurableBackend();
		if (durable === undefined) {
			throw new Error(`Pi Durable backend unavailable: ${durableUnavailable}`);
		}
		return durable;
	}

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

	const persistRun = async (): Promise<void> => {
		if (!state.activeRun) return;
		const metrics = state.activeRun.metrics;
		if (metrics) {
			metrics.supervisorUsage = state.supervisorUsage;
			metrics.scout = {
				calls: state.scoutCalls,
				ms: state.scoutMs,
				usage: state.scoutUsage,
			};
		}
		try {
			await writeRun(runsDir(getAgentDir()), state.activeRun);
		} catch {}
	};

	function updateWidget(ctx: ExtensionContext): void {
		if (!state.runActive && !state.modeEnabled) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const elapsed =
			state.delegationStartedAt !== undefined
				? ` (${formatDuration(Date.now() - state.delegationStartedAt)})`
				: "";
		ctx.ui.setWidget(WIDGET_KEY, [
			`Fusion: ${state.phase}`,
			`Supervisor: ${state.supervisorLabel ?? "-"} (thinking ${state.supervisorThinking})`,
			`  Usage: ${formatUsageSummary(state.supervisorUsage)}`,
			`Executor: ${state.executorLabel ?? "-"} (thinking ${state.executorThinking})`,
			`  Usage: ${formatUsageSummary(state.executorUsage)}`,
			`Activity: ${state.executorActivity ?? "-"}${elapsed}`,
			`Revisions: ${state.revisions}/${MAX_REVISIONS}`,
			`Final fix: ${state.finalFixUsed ? 1 : 0}/${MAX_FINAL_FIXES}`,
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
			state.executorSessionThinking === state.executorThinking &&
			state.executorSessionBackend === state.executorBackend
		);
	}

	function disposeExecutor(): void {
		const handle = state.executorHandle;
		const ready = state.executorReady;
		state.executorHandle = undefined;
		state.executorSessionBackend = undefined;
		state.executorSessionModel = undefined;
		state.executorSessionThinking = undefined;
		state.executorReady = undefined;
		state.executorUsed = false;
		state.executorActivity = undefined;
		state.executorOutput = undefined;
		try {
			handle?.dispose();
		} catch {}
		void ready?.then(
			(pending) => {
				if (pending !== handle) {
					try {
						pending.dispose();
					} catch {}
				}
			},
			() => {},
		);
	}

	function launchExecutor(ctx: ExtensionContext): void {
		const model = state.executorModel;
		if (!model) return;
		const thinking = state.executorThinking;
		const cwd = ctx.cwd;
		state.executorSessionBackend = state.executorBackend;
		state.executorSessionModel = model;
		state.executorSessionThinking = thinking;
		const ready = activeBackend().then((selected) =>
			selected.createExecutor({ cwd, model, thinking }),
		);
		state.executorReady = ready;
		void ready.then(
			(handle) => {
				if (state.executorReady === ready) {
					state.executorHandle = handle;
					state.executorUsed = false;
				} else {
					try {
						handle.dispose();
					} catch {}
				}
			},
			() => {
				if (state.executorReady === ready) {
					state.executorReady = undefined;
					state.executorSessionBackend = undefined;
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
		if (!state.executorReady && !state.executorHandle) {
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

	async function gitHasHead(toplevel: string): Promise<boolean> {
		try {
			const result = await pi.exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
				cwd: toplevel,
				timeout: GIT_TIMEOUT_MS,
			});
			return result.code === 0;
		} catch {
			return false;
		}
	}

	async function gitPorcelain(toplevel: string): Promise<Map<string, string> | undefined> {
		try {
			const status = await pi.exec("git", ["status", "--porcelain=v1", "-z", "-uall"], {
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
		headExists: boolean,
		before: Map<string, string> | undefined,
		after: Map<string, string> | undefined,
		beforeHashes: Map<string, string> | undefined,
		afterHashes: Map<string, string> | undefined,
		touchedFiles: ReadonlySet<string>,
	): Promise<string | undefined> {
		if (!before || !after) return undefined;
		try {
			const diffBase = headExists ? ["diff", "HEAD"] : ["diff"];
			const touchedRepoPaths = [...touchedFiles]
				.map((path) => relative(toplevel, resolve(ctx.cwd, path)))
				.filter((path) => path.length > 0 && !path.startsWith(".."));
			const { modified, added, preDirty } = changedPaths(
				before,
				after,
				beforeHashes,
				afterHashes,
			);
			const diffPaths = new Set(modified);
			for (const path of touchedRepoPaths) {
				if (after.has(path)) diffPaths.add(path);
			}
			const remaining = touchedRepoPaths.filter((path) => !diffPaths.has(path));
			if (remaining.length > 0) {
				const names = await pi.exec("git", [...diffBase, "--name-only", "--", ...remaining], {
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
				const diff = await pi.exec("git", [...diffBase, "--stat", "--", ...diffPaths], {
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
			if (preDirty.length > 0) {
				parts.push(
					`pre-existing changes (diff includes edits made before this delegation): ${preDirty.join(", ")}`,
				);
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
		state.originalTask = task;
		state.revisions = 0;
		state.finalFixUsed = false;
		state.executed = false;
		state.settleNudges = 0;
		state.supervisorUsage = createEmptyUsage();
		state.executorUsage = createEmptyUsage();
		state.executorTranscript = [];
		state.scoutCalls = 0;
		state.scoutMs = 0;
		state.scoutUsage = createEmptyUsage();
		state.runStartedAt = new Date().toISOString();
		state.resumePending = false;
		setPhase(ctx, "planning");
	}

	async function selectModel(
		ctx: ExtensionContext,
		title: string,
		tier: FusionModelTier,
		preferredLabel?: string,
		current?: Model<Api>,
		currentThinking?: ThinkingLevel,
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
		const orderedModels = [...tierModels];
		if (preferredLabel) {
			const index = orderedModels.findIndex((model) => modelLabel(model) === preferredLabel);
			if (index > 0) {
				orderedModels.unshift(orderedModels.splice(index, 1)[0]);
			}
		}
		if (current) {
			const index = orderedModels.findIndex((model) => modelLabel(model) === modelLabel(current));
			if (index > 0) {
				orderedModels.unshift(orderedModels.splice(index, 1)[0]);
			}
		}
		const labelFor = (model: Model<Api>): string =>
			current && modelLabel(model) === modelLabel(current)
				? `${formatPricedModelLabel(model)} (current)`
				: formatPricedModelLabel(model);
		const byOption = new Map<string, Model<Api>>();
		for (const model of orderedModels) {
			byOption.set(labelFor(model), model);
		}
		const pickerTitle = current
			? `${title} — current: ${modelLabel(current)} (thinking ${currentThinking ?? "off"})`
			: title;
		const choice = await selectSearchableOption(
			ctx,
			pickerTitle,
			(query) => filterModelsByQuery(orderedModels, query).map(labelFor),
			{ placeholder: "Type to search provider, model name, or ID" },
		);
		return choice === undefined ? undefined : byOption.get(choice);
	}

	async function askSkipOrChange(
		ctx: ExtensionContext,
		role: "supervisor" | "executor",
		skipLabel: string,
	): Promise<"skip" | "change" | undefined> {
		const choice = await selectScrollableOption(ctx, `Fusion ${role} model`, [
			skipLabel,
			"Change model",
		]);
		if (choice === undefined) return undefined;
		return choice === skipLabel ? "skip" : "change";
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
		let supervisor = state.supervisorModel;
		let supervisorThinking = state.supervisorThinking;
		if (supervisor) {
			const action = await askSkipOrChange(
				ctx,
				"supervisor",
				`Skip (keep ${modelLabel(supervisor)} · thinking ${supervisorThinking})`,
			);
			if (action === undefined) return undefined;
			if (action === "change") supervisor = undefined;
		}
		if (!supervisor) {
			supervisor = await selectModel(
				ctx,
				"Fusion supervisor model",
				"supervisor",
				ctx.model && isRecentModel(ctx.model) && isModelInTier(ctx.model, "supervisor")
					? modelLabel(ctx.model)
					: undefined,
				state.supervisorModel,
				state.supervisorThinking,
			);
			if (!supervisor) return undefined;
			supervisorThinking = await selectThinkingLevel(
				ctx,
				supervisor,
				"supervisor",
				defaultThinkingLevel,
			);
		}
		ctx.ui.notify(
			`Fusion supervisor: ${modelLabel(supervisor)} · thinking ${supervisorThinking}`,
			"info",
		);
		let executor = state.executorModel;
		let executorThinking = state.executorThinking;
		let scoutThinking = state.scoutThinking;
		if (executor) {
			const action = await askSkipOrChange(
				ctx,
				"executor",
				`Skip (keep ${modelLabel(executor)} · thinking ${executorThinking} · scout ${scoutThinking})`,
			);
			if (action === undefined) return undefined;
			if (action === "change") executor = undefined;
		}
		if (!executor) {
			executor = await selectModel(
				ctx,
				"Fusion executor model",
				"executor",
				undefined,
				state.executorModel,
				state.executorThinking,
			);
			if (!executor) return undefined;
			executorThinking = await selectThinkingLevel(
				ctx,
				executor,
				"executor",
				defaultThinkingLevel,
			);
			scoutThinking = await selectThinkingLevel(
				ctx,
				executor,
				"scout",
				scoutDefaultThinkingLevel,
			);
		}
		ctx.ui.notify(
			`Fusion executor: ${modelLabel(executor)} · thinking ${executorThinking} · scout ${scoutThinking}`,
			"info",
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

	async function selectExecutorBackend(ctx: ExtensionContext): Promise<void> {
		const durable = await loadDurableBackend();
		if (durable === undefined) {
			if (state.executorBackend === "durable") {
				state.executorBackend = "session";
				ctx.ui.notify(
					`Pi Durable unavailable (${durableUnavailable}); using the session backend.`,
					"warning",
				);
			}
			return;
		}
		const labels =
			state.executorBackend === "durable"
				? ["Keep durable (experimental)", "session (default)"]
				: ["Keep session (default)", "durable (experimental)"];
		const selected = await selectScrollableOption(ctx, "Fusion executor backend", labels);
		if (selected === undefined) return;
		state.executorBackend = selected.includes("durable") ? "durable" : "session";
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
		const prevExecutor = state.executorModel;
		const prevExecutorThinking = state.executorThinking;
		const prevBackend = state.executorBackend;
		const pair = await selectModelPair(ctx);
		if (!pair) return undefined;
		state.supervisorModel = pair.supervisor;
		state.supervisorLabel = pair.supervisorLabel;
		state.supervisorThinking = pair.supervisorThinking;
		state.executorModel = pair.executor;
		state.executorLabel = pair.executorLabel;
		state.executorThinking = pair.executorThinking;
		state.scoutThinking = pair.scoutThinking;
		if (state.modeEnabled) {
			const modelSet = await pi.setModel(pair.supervisor);
			if (!modelSet) {
				ctx.ui.notify(
					`Cannot use ${modelLabel(pair.supervisor)} as supervisor: no credentials configured for ${pair.supervisor.provider}.`,
					"error",
				);
			} else {
				pi.setThinkingLevel(state.supervisorThinking);
			}
		}
		await selectExecutorBackend(ctx);
		if (
			pair.executor !== prevExecutor ||
			pair.executorThinking !== prevExecutorThinking ||
			state.executorBackend !== prevBackend
		) {
			disposeExecutor();
		}
		warmExecutor(ctx);
		updateWidget(ctx);
		return pair;
	}

	async function ensureExecutor(ctx: ExtensionContext): Promise<ExecutorHandle> {
		if (!state.executorModel) {
			throw new Error("No fusion executor model configured. Run /fusion or /fusion-mode first.");
		}
		if (!executorConfigMatches()) {
			disposeExecutor();
		}
		if (state.executorHandle) {
			return state.executorHandle;
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
			'Delegate implementation work to the Fusion executor agent. Call with action "execute" and a self-contained brief to start a task, then with action "revise" and consolidated feedback to request fixes (at most 3 revisions). After the final acceptance audit against the original task, action "final_fix" may be used once per run, in addition to the 3 revisions. Action "resume" is only for a durable run restored by /fusion-resume: it waits for the interrupted executor turn to finish and returns its report (pass "resume" as the brief). Pass size "small" for localized changes (fast path: lower executor thinking) or "standard" (default) for everything else.',
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("execute"),
				Type.Literal("revise"),
				Type.Literal("final_fix"),
				Type.Literal("resume"),
			]),
			brief: Type.String({ minLength: 1 }),
			size: Type.Optional(Type.Union([Type.Literal("small"), Type.Literal("standard")])),
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

			const error = delegationError(state, params.action);
			if (error) return respond(error);

			const isRevision = params.action === "revise";
			const isFinalFix = params.action === "final_fix";
			const isResume = params.action === "resume";
			const isFollowUp = isRevision || isFinalFix;
			const revision = isRevision ? state.revisions + 1 : 0;
			const key = isResume
				? delegationKey("resume", state.activeRun?.runId ?? "", 0)
				: delegationKey(params.action, params.brief, revision);
			const effective =
				params.size === "small"
					? smallTaskThinkingLevel(
							state.executorThinking,
							state.executorModel ? getSupportedThinkingLevels(state.executorModel) : [],
						)
					: state.executorThinking;
			const sizeNote = params.size === "small" ? ` (small task, thinking ${effective})` : "";
			const cached = isFollowUp ? state.activeRun?.results[key] : undefined;
			if (cached !== undefined) {
				return respond(`${cached}\n\n(cached result, already executed)`);
			}

			const beginError = controller.beginDelegation(params.action);
			if (beginError) return respond(beginError);
			const startedAt = Date.now();
			state.delegationStartedAt = startedAt;
			let reasoningTotalChars = 0;
			let metricToolCalls = 0;
			let metricEditCalls = 0;
			const recordDelegation = (fields: {
				stopReason?: string;
				reportStatus?: string;
				usage: Usage;
			}): void => {
				const run = state.activeRun;
				if (!run) return;
				run.metrics ??= {
					backend: state.executorSessionBackend ?? state.executorBackend,
					startedAt: state.runStartedAt ?? new Date().toISOString(),
					delegations: [],
					supervisorUsage: state.supervisorUsage,
					scout: { calls: state.scoutCalls, ms: state.scoutMs, usage: state.scoutUsage },
				};
				run.metrics.delegations.push({
					action: params.action,
					size: params.size ?? "standard",
					briefChars: params.brief.length,
					thinking: effective,
					totalMs: timings.totalMs ?? Date.now() - startedAt,
					firstEventMs: timings.firstEventMs,
					reasoningChars: reasoningTotalChars,
					toolCalls: metricToolCalls,
					editCalls: metricEditCalls,
					...fields,
				});
			};
			try {
				if (isRevision) {
					setPhase(ctx, "revising");
					appendExecutorProgress(
						`[revision ${state.revisions}/${MAX_REVISIONS}] Executor resumed with ${executorLabel()}${sizeNote}`,
					);
				} else if (isFinalFix) {
					setPhase(ctx, "finalizing");
					appendExecutorProgress(
						`[final fix] Executor resumed with ${executorLabel()}${sizeNote}`,
					);
				} else if (isResume) {
					setPhase(ctx, "executing");
					appendExecutorProgress(
						`[resume] Waiting for the interrupted executor turn with ${executorLabel()}`,
					);
				} else {
					if (state.executorUsed || !executorConfigMatches()) {
						disposeExecutor();
					}
					state.runActive = true;
					state.task = params.brief;
					state.originalTask ??= params.brief;
					state.executorBrief = params.brief;
					state.revisions = 0;
					state.finalFixUsed = false;
					state.executed = false;
					state.activeRun = {
						runId: newRunId(),
						cwd: ctx.cwd,
						task: params.brief,
						brief: params.brief,
						originalTask: state.originalTask,
						finalFixUsed: false,
						executor: {
							provider: state.executorModel?.provider ?? "",
							modelId: state.executorModel?.id ?? "",
							label: executorLabel(),
							thinking: state.executorThinking,
						},
						status: "running",
						revisions: 0,
						results: {},
						updatedAt: new Date().toISOString(),
						metrics: {
							backend: state.executorBackend,
							startedAt: state.runStartedAt ?? new Date().toISOString(),
							delegations: [],
							supervisorUsage: createEmptyUsage(),
							scout: { calls: 0, ms: 0, usage: createEmptyUsage() },
						},
					};
					state.runId = state.activeRun.runId;
					setPhase(ctx, "executing");
					appendExecutorProgress(`[execute] Executor started with ${executorLabel()}${sizeNote}`);
				}
				if (state.activeRun) {
					state.activeRun.status = "running";
					state.activeRun.revisions = state.revisions;
					state.activeRun.finalFixUsed = state.finalFixUsed;
					await persistRun();
				}
				emit(executorProgressText());
				if (signal?.aborted) throw new Error("Fusion delegation aborted.");
				const handle = await ensureExecutor(ctx);
				timings.readyMs = Date.now() - startedAt;
				if (state.activeRun) {
					const backend = state.executorSessionBackend ?? state.executorBackend;
					state.activeRun.backend = backend;
					const ref = handle.resumeRef();
					if (backend === "durable") {
						state.activeRun.conversationId = ref === undefined ? undefined : Number(ref);
						state.activeRun.sessionFile = undefined;
					} else {
						state.activeRun.sessionFile = ref;
					}
					await persistRun();
				}
				const promptText = isRevision
					? buildRevisionPrompt(
							params.brief,
							state.revisions,
							state.executorUsed ? undefined : state.executorBrief,
						)
					: isFinalFix
						? buildFinalFixPrompt(
								params.brief,
								state.originalTask,
								state.executorUsed ? undefined : state.executorBrief,
							)
						: isResume
							? ""
							: buildExecutorPrompt(params.brief);
				if (signal?.aborted) {
					await handle.abort();
					throw new Error("Fusion delegation aborted.");
				}
				const touchedFiles = new Set<string>();
				const toolStartTimes = new Map<string, number>();
				let liveText = "";
				let reasoningChars = 0;
				let reasoningStartedAt: number | undefined;
				const onEvent = (event: ExecutorEvent): void => {
					if (timings.firstEventMs === undefined) {
						timings.firstEventMs = Date.now() - startedAt;
					}
					if (event.type === "reasoning_start") {
						reasoningChars = 0;
						reasoningStartedAt = Date.now();
						state.executorActivity = "reasoning";
						appendExecutorProgress("[reasoning] Executor is reasoning privately.");
						scheduleRender();
					} else if (event.type === "reasoning_delta") {
						reasoningChars += event.delta.length;
						reasoningTotalChars += event.delta.length;
						reasoningStartedAt ??= Date.now();
						state.executorActivity = `reasoning (${formatReasoningSize(reasoningChars)}, ${formatDuration(Date.now() - reasoningStartedAt)})`;
						scheduleRender();
					} else if (event.type === "text_start") {
						reasoningStartedAt = undefined;
						liveText = "";
						state.executorOutput = undefined;
					} else if (event.type === "text_delta") {
						liveText += event.delta;
						state.executorOutput = liveText;
						state.executorActivity = "writing";
						scheduleRender();
					} else if (event.type === "text_end") {
						const content = event.content.trim();
						if (content) {
							appendExecutorProgress(`[executor]\n${content}`);
						}
						liveText = "";
						state.executorOutput = undefined;
						state.executorActivity = "working";
						scheduleRender();
					} else if (event.type === "message_end") {
						if (
							state.activeRun &&
							(state.executorSessionBackend ?? state.executorBackend) === "session" &&
							!state.activeRun.sessionFile
						) {
							state.activeRun.sessionFile = handle.resumeRef();
							void persistRun();
						}
					} else if (event.type === "tool_start") {
						reasoningStartedAt = undefined;
						metricToolCalls += 1;
						toolStartTimes.set(event.toolCallId, Date.now());
						if (event.toolName === "edit" || event.toolName === "write") {
							metricEditCalls += 1;
							const path = touchedPath(event.args);
							if (path) touchedFiles.add(path);
						}
						state.executorActivity = `running ${describeExecutorTool(event.toolName, event.args)}`;
						appendExecutorProgress(`[tool] ${describeExecutorTool(event.toolName, event.args)}`);
						scheduleRender();
					} else if (event.type === "tool_update") {
						const partial = summarizeToolResult(event.partialResult, MAX_PROGRESS_CHARS);
						if (partial) {
							state.executorOutput = tailLines(partial, TOOL_STREAM_TAIL_LINES);
							scheduleRender();
						}
					} else if (event.type === "tool_end") {
						const toolStartedAt = toolStartTimes.get(event.toolCallId);
						toolStartTimes.delete(event.toolCallId);
						const elapsed =
							toolStartedAt !== undefined
								? ` ${formatDuration(Date.now() - toolStartedAt)}`
								: "";
						appendExecutorProgress(
							`[${event.isError ? "failed" : "done"}${elapsed}] ${event.toolName}`,
						);
						const summary = summarizeToolResult(event.result);
						if (summary) {
							appendExecutorProgress(`[result]\n${summary}`);
						}
						state.executorOutput = undefined;
						state.executorActivity = `${event.toolName} ${event.isError ? "failed" : "completed"}`;
						scheduleRender();
					}
				};
				state.executorUsed = true;
				const toplevel = await gitToplevel(ctx);
				const headExists = toplevel ? await gitHasHead(toplevel) : false;
				const porcelainBefore = toplevel ? await gitPorcelain(toplevel) : undefined;
				const beforeHashes =
					toplevel && porcelainBefore && porcelainBefore.size <= MAX_HASHED_DIRTY_PATHS
						? await hashFiles(toplevel, porcelainBefore.keys())
						: undefined;
				let output: ExecutorTurnResult;
				if (isResume) {
					output = await handle.resume({ signal, onEvent });
				} else {
					await handle.setThinking(effective);
					output = await handle.prompt(promptText, { requestId: key, signal, onEvent });
				}
				if (
					state.activeRun &&
					(state.executorSessionBackend ?? state.executorBackend) === "session"
				) {
					state.activeRun.sessionFile = handle.resumeRef();
				}
				const porcelainAfter = toplevel ? await gitPorcelain(toplevel) : undefined;
				const afterHashes =
					toplevel && beforeHashes
						? await hashFiles(toplevel, beforeHashes.keys())
						: undefined;
				timings.totalMs = Date.now() - startedAt;
				state.lastTimings = { ...timings };
				const usage = output.usage;
				state.executorUsage = addUsage(state.executorUsage, usage);
				controller.completeDelegation();
				if (output.stopReason === "error" || output.stopReason === "aborted") {
					const reason = output.errorMessage ? `: ${output.errorMessage}` : "";
					state.executorActivity = "failed";
					appendExecutorProgress(
						`[failed] Executor stopped with status "${output.stopReason}"${reason}.`,
					);
					setPhase(ctx, "failed");
					renderThrottle.flush();
					const text = `Fusion executor stopped with status "${output.stopReason}"${reason}.\n\nExecutor usage this delegation: ${formatUsageSummary(usage)}\nExecutor usage this run: ${formatUsageSummary(state.executorUsage)}\n${timingLine()}`;
					recordDelegation({ stopReason: output.stopReason, usage });
					if (state.activeRun) {
						state.activeRun.status = "failed";
						state.activeRun.revisions = state.revisions;
						state.activeRun.results[key] = text;
						await persistRun();
					}
					return respond(
						text,
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
							headExists,
							porcelainBefore,
							porcelainAfter,
							beforeHashes,
							afterHashes,
							touchedFiles,
						)
					: undefined;
				renderThrottle.flush();
				const text = `${formatCompactReport(parsed.report, diffStat, parsed.prose, isResume ? ["resumed after restart"] : [])}\n\nExecutor usage this delegation: ${formatUsageSummary(usage)}\nExecutor usage this run: ${formatUsageSummary(state.executorUsage)}\n${timingLine()}`;
				recordDelegation({ reportStatus: parsed.report.status, usage });
				if (state.activeRun) {
					state.activeRun.status = "done";
					state.activeRun.revisions = state.revisions;
					state.activeRun.results[key] = text;
					await persistRun();
				}
				return respond(
					text,
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
				const text = `Fusion delegation failed: ${message}\n${timingLine()}`;
				recordDelegation({ stopReason: "error", usage: createEmptyUsage() });
				if (state.activeRun) {
					state.activeRun.status = "failed";
					state.activeRun.revisions = state.revisions;
					state.activeRun.results[key] = text;
					await persistRun();
				}
				return respond(text, message);
			} finally {
				renderThrottle.cancel();
				controller.endDelegation(params.action);
				state.delegationStartedAt = undefined;
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
					} else if (line === "Review: light") {
						lines.push(theme.fg("success", line));
					} else if (line.startsWith("Review:")) {
						lines.push(theme.fg("warning", line));
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

			const limitError = scoutLimitError(state.scoutCalls);
			if (limitError) return respond(limitError);

			if (!state.executorModel) {
				return respond("No fusion executor model configured. Run /fusion-config first.");
			}

			const scoutError = controller.beginScout();
			if (scoutError) return respond(scoutError);
			const scoutStartedAt = Date.now();
			const previousPhase = state.phase;
			setPhase(ctx, "scouting");
			appendScoutProgress(`[scout] Scouting ${params.questions.length} question(s) with ${executorLabel()}`);
			emit(scoutTranscriptText());
			try {
				const result = await (await activeBackend()).scout({
					cwd: ctx.cwd,
					model: state.executorModel,
					thinking: state.scoutThinking,
					prompt: buildScoutPrompt(params.questions),
					maxToolCalls: MAX_SCOUT_TOOL_CALLS,
					signal,
					onEvent: (event) => {
						if (event.type === "tool_start") {
							scoutActivity = `running ${describeExecutorTool(event.toolName, event.args)}`;
							appendScoutProgress(`[tool] ${describeExecutorTool(event.toolName, event.args)}`);
							scheduleRender();
						} else if (event.type === "tool_end") {
							appendScoutProgress(`[${event.isError ? "failed" : "done"}] ${event.toolName}`);
							scoutActivity = `${event.toolName} ${event.isError ? "failed" : "completed"}`;
							scheduleRender();
						}
					},
				});
				const capped = result.capped;
				const output = result;
				const usage = result.usage;
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
				state.scoutMs += Date.now() - scoutStartedAt;
				renderThrottle.cancel();
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
				`Fusion configured. Supervisor ${pair.supervisorLabel} (${priceText(pair.supervisor)}, thinking ${pair.supervisorThinking}), executor ${pair.executorLabel} (${priceText(pair.executor)}, thinking ${pair.executorThinking}), scout thinking ${pair.scoutThinking}, backend ${state.executorBackend}. Recent cohort ${RECENT_MODEL_COHORT}.`,
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
				state.settleNudges = 0;
				syncFusionTools();
				state.supervisorUsage = createEmptyUsage();
				state.executorUsage = createEmptyUsage();
				state.executorTranscript = [];
				state.scoutCalls = 0;
				state.scoutMs = 0;
				state.scoutUsage = createEmptyUsage();
				state.resumePending = false;
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
				`Fusion mode ${mode} | cohort ${RECENT_MODEL_COHORT} | supervisor ${supervisor} | executor ${executor} | phase ${state.phase} | revisions ${state.revisions}/${MAX_REVISIONS} | final fix ${state.finalFixUsed ? 1 : 0}/${MAX_FINAL_FIXES} | scout calls ${state.scoutCalls}/${MAX_SCOUT_CALLS} | scout thinking ${state.scoutThinking} | scout usage ${formatUsageSummary(state.scoutUsage)} | supervisor usage ${formatUsageSummary(state.supervisorUsage)} | executor usage ${formatUsageSummary(state.executorUsage)} | executor activity ${state.executorActivity ?? "-"} | backend ${state.executorBackend}${lastTimings}`,
				"info",
			);
		},
	});

	pi.registerCommand("fusion-stats", {
		description: "Show Fusion run metrics for this directory",
		handler: async (args, ctx) => {
			const parsed = Number.parseInt(args.trim(), 10);
			const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
			const runs = await listRuns(runsDir(getAgentDir()), ctx.cwd);
			ctx.ui.notify(formatRunStats(runs, limit), "info");
		},
	});

	pi.registerCommand("fusion-resume", {
		description: "Resume an interrupted Fusion run",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Fusion resume requires a dialog-capable UI.", "error");
				return;
			}
			await ctx.waitForIdle();
			const interrupted = (await listRuns(runsDir(getAgentDir()), ctx.cwd)).filter(
				(run) => run.status === "interrupted",
			);
			if (interrupted.length === 0) {
				ctx.ui.notify("No interrupted Fusion runs for this directory.", "info");
				return;
			}
			const options = interrupted.map(
				(run) => `${new Date(run.updatedAt).toLocaleString()} ${truncateInline(run.task, 60)}`,
			);
			const choice = await selectScrollableOption(ctx, "Resume interrupted Fusion run", options);
			if (choice === undefined) return;
			const run = interrupted[options.indexOf(choice)];
			if (run.backend === "durable") {
				if (run.conversationId === undefined) {
					ctx.ui.notify(
						"Cannot resume: the interrupted durable run has no conversation id.",
						"error",
					);
					return;
				}
				const durable = await loadDurableBackend();
				if (durable === undefined) {
					ctx.ui.notify(
						`Cannot resume: Pi Durable backend unavailable${durableUnavailable ? ` (${durableUnavailable})` : ""}.`,
						"error",
					);
					return;
				}
				const model =
					ctx.modelRegistry.find(run.executor.provider, run.executor.modelId) ??
					state.executorModel;
				if (!model) {
					ctx.ui.notify("Cannot resume: the executor model is unavailable.", "error");
					return;
				}
				let handle: ExecutorHandle;
				try {
					handle = await durable.openExecutor(
						{ cwd: ctx.cwd, model, thinking: run.executor.thinking },
						String(run.conversationId),
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Cannot resume Fusion run: ${message}`, "error");
					return;
				}
				disposeExecutor();
				state.executorHandle = handle;
				state.executorBackend = "durable";
				state.executorSessionBackend = "durable";
				state.executorSessionModel = model;
				state.executorSessionThinking = run.executor.thinking;
				state.executorModel = model;
				state.executorLabel = run.executor.label;
				state.executorThinking = run.executor.thinking;
				state.task = run.task;
				state.originalTask = run.originalTask ?? run.task;
				state.executorBrief = run.brief;
				state.revisions = run.revisions;
				state.finalFixUsed = run.finalFixUsed ?? false;
				state.executed = true;
				state.settleNudges = 0;
				state.runActive = true;
				state.executorUsed = true;
				state.runId = run.runId;
				state.runStartedAt = run.metrics?.startedAt;
				state.activeRun = run;
				state.resumePending = true;
				syncFusionTools();
				setPhase(ctx, "executing");
				ctx.ui.notify(`Resumed interrupted Fusion run ${run.runId}.`, "info");
				pi.sendUserMessage(
					`The Fusion executor run was interrupted by a restart. Its durable conversation is intact and continues where it stopped. Original task:\n${state.originalTask}\n\nCall fusion_delegate with action "resume" (brief: "resume") to let the executor finish its interrupted turn and get its report. Commands cut off by the restart may still have completed, so review the full working tree with git diff, then continue the protocol: revise only for defects, then the final acceptance audit against the original task.`,
				);
				return;
			}
			if (!run.sessionFile) {
				ctx.ui.notify(
					"Cannot resume: the interrupted run has no persisted executor session.",
					"error",
				);
				return;
			}
			const model =
				ctx.modelRegistry.find(run.executor.provider, run.executor.modelId) ??
				state.executorModel;
			if (!model) {
				ctx.ui.notify("Cannot resume: the executor model is unavailable.", "error");
				return;
			}
			let handle: ExecutorHandle;
			try {
				handle = await sessionBackend.openExecutor(
					{ cwd: ctx.cwd, model, thinking: run.executor.thinking },
					run.sessionFile,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Cannot resume Fusion run: ${message}`, "error");
				return;
			}
			disposeExecutor();
			state.executorHandle = handle;
			state.executorBackend = "session";
			state.executorSessionBackend = "session";
			state.executorSessionModel = model;
			state.executorSessionThinking = run.executor.thinking;
			state.executorModel = model;
			state.executorLabel = run.executor.label;
			state.executorThinking = run.executor.thinking;
			state.task = run.task;
			state.originalTask = run.originalTask ?? run.task;
			state.executorBrief = run.brief;
			state.revisions = run.revisions;
			state.finalFixUsed = run.finalFixUsed ?? false;
			state.executed = true;
			state.settleNudges = 0;
			state.runActive = true;
			state.executorUsed = true;
			state.runId = run.runId;
			state.runStartedAt = run.metrics?.startedAt;
			state.activeRun = run;
			syncFusionTools();
			setPhase(ctx, "reviewing");
			ctx.ui.notify(`Resumed interrupted Fusion run ${run.runId}.`, "info");
			pi.sendUserMessage(
				`The Fusion executor was interrupted mid-task. Original task:\n${state.originalTask}\n\nReview the working tree, then call fusion_delegate with action "revise" to have the executor continue, and finish with the final acceptance audit against the original task.`,
			);
		},
	});

	pi.registerCommand("fusion-clean", {
		description: "Dispose executor context and clear Fusion run state",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			disposeExecutor();
			if (state.activeRun) {
				state.activeRun.status = "done";
				await persistRun();
				state.activeRun = undefined;
				state.runId = undefined;
			}
			state.runActive = false;
			syncFusionTools();
			state.task = undefined;
			state.originalTask = undefined;
			state.revisions = 0;
			state.finalFixUsed = false;
			state.executed = false;
			state.delegating = false;
			state.settleNudges = 0;
			state.phase = "idle";
			state.supervisorUsage = createEmptyUsage();
			state.executorUsage = createEmptyUsage();
			state.executorTranscript = [];
			state.scoutCalls = 0;
			state.scoutMs = 0;
			state.scoutUsage = createEmptyUsage();
			state.resumePending = false;
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

	pi.on("agent_before_settle", (event) => {
		if (!state.runActive || state.delegating) return;
		let lastAssistantText = "";
		for (let i = event.context.llmMessages.length - 1; i >= 0; i--) {
			const message = event.context.llmMessages[i];
			if (message.role !== "assistant") continue;
			lastAssistantText = message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			break;
		}
		// The nudge lands as a trailing user message, so the runtime's post-commit
		// canContinue check passes whenever the context has any non-system message.
		const nudge = needsContinuation({
			executed: state.executed,
			lastAssistantText,
			nudges: state.settleNudges,
			outcome: event.outcome,
			canContinue:
				event.context.canContinue ||
				event.context.llmMessages.some((message) => message.role !== "system"),
		});
		if (!nudge) return;
		state.settleNudges += 1;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: "fusion-continue",
					content: nudge,
					display: true,
				},
			],
			continue: true,
		};
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state.runActive) return;
		if (state.phase !== "failed") {
			setPhase(ctx, "complete");
		}
		if (!state.modeEnabled) {
			state.runActive = false;
		}
		if (state.activeRun?.metrics) {
			state.activeRun.metrics.finishedAt = new Date().toISOString();
			void persistRun();
		}
		syncFusionTools();
	});

	pi.on("session_start", (_event, ctx) => {
		try {
			syncFusionTools();
		} catch {}
		void markInterrupted(runsDir(getAgentDir()), ctx.cwd)
			.then((changed) => {
				if (changed.length > 0) {
					ctx.ui.notify(
						"Interrupted Fusion run found. Run /fusion-resume to continue.",
						"warning",
					);
				}
			})
			.catch(() => {});
	});

	pi.on("session_shutdown", () => {
		state.runActive = false;
		state.modeEnabled = false;
		state.phase = "idle";
		state.settleNudges = 0;
		state.supervisorUsage = createEmptyUsage();
		state.executorUsage = createEmptyUsage();
		state.executorTranscript = [];
		state.scoutCalls = 0;
		state.scoutMs = 0;
		state.scoutUsage = createEmptyUsage();
		state.resumePending = false;
		disposeExecutor();
		void loadDurablePromise?.then((loaded) => loaded?.dispose()).catch(() => {});
		try {
			syncFusionTools();
		} catch {}
	});

	try {
		syncFusionTools();
	} catch {}
}
