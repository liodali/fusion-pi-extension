import { FusionController } from "./core/controller.ts";
import { createPiWorkerRuntime } from "./pi/worker-runtime.ts";
import { piModelConfig } from "./pi/worker-translation.ts";
import { translatePiRun } from "./pi/manifest-translation.ts";
import { readRunManifest, type RunManifest } from "./core/manifest.ts";
import type { WorkspaceLease } from "./workspace/ownership.ts";
import type { FusionPhase } from "./core/workflow.ts";
import { scoutLimitError } from "./core/workflow.ts";
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
} from "./pi/executor-backend.ts";
import { snapshotWorkspace, snapshotWorkspaceAfter, workspaceDiffStat, workspaceEvidenceRefs, type GitExec } from "./workspace/evidence.ts";
import {
	MAX_SCOUT_TOOL_CALLS,
	RENDER_THROTTLE_MS,
	SCOUT_ANSWER_MAX_CHARS,
	TOOL_STREAM_TAIL_LINES,
	TRANSCRIPT_TAIL_LINES,
} from "./limits.ts";
import { type DelegationAction, formatRunStats } from "./metrics.ts";
import {
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
} from "./report.ts";
import {
	type FusionRun,
	delegationKey,
	listRuns,
	newRunId,
	runsDir,
	writeRun,
} from "./runs.ts";
import { selectScrollableOption, selectSearchableOption } from "./scrollable-select.ts";
import {
	defaultThinkingLevel,
	orderThinkingLevels,
	scoutDefaultThinkingLevel,
	smallTaskThinkingLevel,
} from "./thinking.ts";
import { createThrottle } from "./throttle.ts";
import { normalizeTaskSize } from "./core/task-size.ts";
import {
	addUsage,
	aggregateAssistantUsage,
	createEmptyUsage,
	formatUsageSummary,
} from "./usage.ts";

const WIDGET_KEY = "fusion";

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
	// Deterministic request keys keep durable reattach and follow-up result caching
	// stable across restarts; timestamped run ids match the legacy manifest format.
	const controller = new FusionController(state, {
		now: () => Date.now(),
		newRunId,
		newRequestId: delegationKey,
	});
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

	let runWrites: Promise<void> = Promise.resolve();
	let workspaceLease: WorkspaceLease | undefined;
	let lastWorkerResult: RunManifest["lastResult"];
	const registry = async () => (await import("./workspace/ownership.ts")).openWorkspaceRegistry();
	const canonical = async (cwd: string) => (await import("./workspace/ownership.ts")).canonicalWorkspace(cwd);
	async function claimWorkspace(ctx: ExtensionContext, run: FusionRun, allowUnavailableForResolution = false): Promise<void> {
		if (workspaceLease?.manifest.runId === run.runId) return;
		if (workspaceLease) { await workspaceLease.release(); workspaceLease = undefined; }
		const workspace = await canonical(ctx.cwd);
		const store = await registry();
		const existing = await store.inspect(workspace);
		if (existing && (existing.manifest.runId !== run.runId || existing.manifest.owner.harness !== "pi" || existing.manifest.owner.workspace !== workspace)) throw new Error("Another Fusion run owns this workspace. Reconcile or explicitly resolve it first.");
		const currentOwner = existing?.manifest.owner ?? { harness: "pi", supervisorId: ctx.sessionManager.getSessionId(), workspace };
		const backend = (run.backend ?? state.executorBackend) === "durable" ? await loadDurableBackend() : sessionBackend;
		if (!backend && !allowUnavailableForResolution) throw new Error("Pi Durable backend is unavailable.");
		let initial: RunManifest;
		if (existing) initial = existing.manifest;
		else if (run.manifest) initial = readRunManifest(run.manifest, { harness: "pi", workspace });
		else initial = translatePiRun({ ...run, cwd: workspace }, currentOwner, backend?.capabilities ?? { transcriptReopen: false, activeTurnReattach: false, durableExecution: false, idempotentSubmission: false, readOnlyScout: false, exactScoutToolLimit: false });
		workspaceLease = await store.claim(initial, existing?.token);
		lastWorkerResult = initial.lastResult;
		run.manifest = initial;
		if (existing) { run.pending = initial.pending; run.revisions = initial.state.revisions; run.finalFixUsed = initial.state.finalFixUsed; }
	}
	const persistRunCritical = async (): Promise<void> => {
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
		const snapshot = structuredClone(state.activeRun);
		const lease = workspaceLease;
		if (lease?.manifest.runId === snapshot.runId) {
			const pending = controller.pending;
			if (pending?.action === "resume") throw new Error("Invalid Pi pending action.");
			const prior = lease.manifest;
			snapshot.manifest = readRunManifest({ ...prior,
				state: { runActive: state.runActive, phase: state.phase, task: state.task, originalTask: state.originalTask, executorBrief: state.executorBrief,
					revisions: state.revisions, finalFixUsed: state.finalFixUsed, executed: state.executed, delegating: !!pending && state.delegating,
					resumePending: state.resumePending, scoutCalls: state.scoutCalls, settleNudges: state.settleNudges },
				worker: (state.executorHandle?.resumeRef() ? { owner: prior.owner, runtime: state.executorSessionBackend ?? state.executorBackend, id: state.executorHandle.resumeRef()! } : prior.worker),
				pending, recovery: pending ? "pending" : controller.uncertain ? "manual" : snapshot.status === "done" || snapshot.status === "failed" ? "settled" : "manual", lastResult: lastWorkerResult,
			}, { harness: "pi", workspace: prior.owner.workspace });
			state.activeRun.manifest = snapshot.manifest;
		}
		const write = runWrites.then(async () => {
			if (snapshot.manifest && lease) await lease.save(snapshot.manifest);
			await writeRun(runsDir(getAgentDir()), snapshot);
		});
		runWrites = write.catch(() => {});
		await write;
	};
	const persistRun = async (): Promise<void> => { try { await persistRunCritical(); } catch {} };

	const recoveryInitialization = new Map<string, Promise<void>>();
	let resolvingRun = false;
	let changingMode = false;
	function initializeRecovery(cwd: string): Promise<void> {
		let pending = recoveryInitialization.get(cwd);
		if (!pending) {
			// Listing a run does not establish ownership. A different Pi process
			// may still be executing it; never rewrite its status during discovery.
			pending = Promise.resolve();
			recoveryInitialization.set(cwd, pending);
		}
		return pending;
	}
	async function unresolvedRuns(cwd: string, excludeRunId?: string): Promise<FusionRun[]> {
		await initializeRecovery(cwd);
		const store = await registry();
		const candidates = (await listRuns(runsDir(getAgentDir()), cwd)).filter((run) => (run.status === "running" || run.status === "interrupted") && run.runId !== excludeRunId).map((run) => run.status === "running" ? { ...run, status: "interrupted" as const } : run);
		const unresolved: FusionRun[] = [];
		const workspace = await canonical(cwd);
		for (const run of candidates) {
			const archived = await store.archived(run.runId);
			const proven = archived?.owner.harness === "pi" && archived.owner.workspace === workspace && archived.recovery === "settled" &&
				(!run.pending || archived.lastResult?.requestId === run.pending.requestId || archived.operatorResolution?.pending?.requestId === run.pending.requestId);
			if (!proven) unresolved.push(run);
		}
		// A shared write can succeed immediately before the legacy file write fails.
		// Recover the same run from the authoritative shared record without writing
		// or submitting anything merely because the native file is absent or stale.
		const owned = await store.inspect(workspace);
		const saved = owned?.manifest;
		if (saved && saved.owner.harness === "pi" && saved.owner.workspace === workspace && saved.recovery !== "settled" && saved.runId !== excludeRunId) {
			const index = unresolved.findIndex((run) => run.runId === saved.runId);
			const legacy = index >= 0 ? unresolved[index] : saved.adapterData?.legacyPi as FusionRun | undefined;
			if (!legacy || legacy.runId !== saved.runId || !legacy.executor || !legacy.results || typeof legacy.results !== "object") throw new Error("Shared Pi recovery metadata is incomplete; inspect the workspace and resolve ownership manually.");
			const run: FusionRun = { ...structuredClone(legacy), cwd, status: "interrupted", manifest: saved,
				task: saved.state.task ?? legacy.task, originalTask: saved.state.originalTask, brief: saved.state.executorBrief ?? legacy.brief,
				revisions: saved.state.revisions, finalFixUsed: saved.state.finalFixUsed, pending: saved.pending };
			if (saved.worker?.runtime === "session") { run.backend = "session"; run.sessionFile = saved.worker.id; }
			if (saved.worker?.runtime === "durable") {
				const id = Number(saved.worker.id);
				if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid shared Pi Durable reference; inspect the workspace manually.");
				run.backend = "durable"; run.conversationId = id;
			}
			if (index >= 0) unresolved[index] = run;
			else unresolved.push(run);
		}
		return unresolved;
	}

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
		controller.setPhase(phase);
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
		// Durable recovery can start persisted work; acquire workspace ownership first.
		if (state.executorBackend === "durable") return;
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

	const gitExec: GitExec = (args, options) => pi.exec("git", args, options);

	function startRun(ctx: ExtensionContext, task: string): void {
		warmExecutor(ctx);
		state.executorActivity = undefined;
		state.executorOutput = undefined;
		controller.start(task);
		syncFusionTools();
		state.supervisorUsage = createEmptyUsage();
		state.executorUsage = createEmptyUsage();
		state.executorTranscript = [];
		state.scoutMs = 0;
		state.scoutUsage = createEmptyUsage();
		state.runStartedAt = new Date().toISOString();
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

			if (changingMode) return respond("Fusion mode change is in progress.");
			if (resolvingRun) return respond("Fusion recovery resolution is in progress.");
			if ((await unresolvedRuns(ctx.cwd, state.runId)).length > 0) return respond("An interrupted Fusion run requires recovery before new delegation. Use /fusion-resume or /fusion-resolve.");
			if (changingMode) return respond("Fusion mode change is in progress.");
			if (resolvingRun) return respond("Fusion recovery resolution is in progress.");
			const error = controller.validateDelegation(params.action, params.brief);
			if (error) return respond(error);

			const isRevision = params.action === "revise";
			const isFinalFix = params.action === "final_fix";
			const isResume = params.action === "resume";
			const isFollowUp = isRevision || isFinalFix;
			// Resume reuses the run's durable request identity; other actions mint one.
			const key = isResume
				? delegationKey("resume", state.activeRun?.runId ?? "", 0)
				: controller.requestIdFor(params.action, params.brief);
			const size = normalizeTaskSize(params.size);
			const effective =
				size === "small"
					? smallTaskThinkingLevel(
							state.executorThinking,
							state.executorModel ? getSupportedThinkingLevels(state.executorModel) : [],
						)
					: state.executorThinking;
			const sizeNote = size === "small" ? ` (small task, thinking ${effective})` : "";
			const cached = isFollowUp ? state.activeRun?.results[key] : undefined;
			if (cached !== undefined) {
				return respond(`${cached}\n\n(cached result, already executed)`);
			}

			const beginError = controller.beginDelegation(params.action, isResume ? (await activeBackend()).capabilities : undefined, params.brief, isResume ? undefined : key);
			if (beginError) return respond(beginError);
			const startedAt = controller.now();
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
					size,
					briefChars: params.brief.length,
					thinking: effective,
					totalMs: timings.totalMs ?? controller.now() - startedAt,
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
					if (!state.executorModel) throw new Error("Fusion executor model is not configured; run /fusion or /fusion-config to select models before delegating.");
					if (state.executorUsed || !executorConfigMatches()) {
						disposeExecutor();
					}
					controller.prepareExecution(params.brief);
					state.activeRun = {
						runId: controller.newRunId(),
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
					if (!isResume) state.activeRun.pending = { action: params.action as "execute" | "revise" | "final_fix", requestId: key };
				}
				emit(executorProgressText());
				if (signal?.aborted) throw new Error("Fusion delegation aborted.");
				if (!state.activeRun) throw new Error("Fusion run is unavailable.");
				await claimWorkspace(ctx, state.activeRun);
				const handle = await ensureExecutor(ctx);
				timings.readyMs = controller.now() - startedAt;
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
				}
				const promptText = controller.delegationPrompt(params.action, params.brief, !state.executorUsed);
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
						timings.firstEventMs = controller.now() - startedAt;
					}
					if (event.type === "reasoning_start") {
						reasoningChars = 0;
						reasoningStartedAt = controller.now();
						state.executorActivity = "reasoning";
						appendExecutorProgress("[reasoning] Executor is reasoning privately.");
						scheduleRender();
					} else if (event.type === "reasoning_delta") {
						reasoningChars += event.delta.length;
						reasoningTotalChars += event.delta.length;
						reasoningStartedAt ??= controller.now();
						state.executorActivity = `reasoning (${formatReasoningSize(reasoningChars)}, ${formatDuration(controller.now() - reasoningStartedAt)})`;
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
						toolStartTimes.set(event.toolCallId, controller.now());
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
								? ` ${formatDuration(controller.now() - toolStartedAt)}`
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
				if (!isResume) await handle.setThinking(effective);
				const model = state.executorSessionModel;
				if (!model || !state.runId) throw new Error("Fusion executor model or run identity is unavailable.");
				const backend = await activeBackend();
				const runtime = createPiWorkerRuntime(backend, () => model, { disposeBackend: false });
				const worker = runtime.adoptExecutor(workspaceLease!.manifest.owner, { role: "executor", model: piModelConfig(model, state.executorSessionThinking ?? state.executorThinking) }, handle);
				const requestId = isResume ? state.activeRun?.pending?.requestId : key;
				if (!requestId) throw new Error("Fusion executor request identity is unavailable.");
				controller.bindWorkerRuntime(runtime);
				return await controller.performWorkerDelegation({ runId: state.runId, requestId, worker, prompt: promptText, variant: effective }, { signal, onEvent: ({ event }) => onEvent(event) }, {
					// Authoritative in-sequence re-check: an interrupted run in this
					// workspace must recover before any submission is recorded.
					claim: async () => {
						if ((await unresolvedRuns(ctx.cwd, state.runId)).length > 0) {
							throw new Error("An interrupted Fusion run requires recovery before new delegation. Use /fusion-resume or /fusion-resolve.");
						}
						await claimWorkspace(ctx, state.activeRun!);
					},
					recordIntent: () => persistRunCritical(),
					snapshot: () => snapshotWorkspace(ctx.cwd, gitExec),
					recordReference: () => persistRunCritical(),
					collect: async (translated, workspaceBefore) => {
						lastWorkerResult = { requestId: translated.requestId, status: translated.status, text: translated.text };
						const output = runtime.nativeResult(translated);
						if (!output) throw new Error("Pi executor result is unavailable.");
						if (state.activeRun && (state.executorSessionBackend ?? state.executorBackend) === "session") {
							state.activeRun.sessionFile = handle.resumeRef();
						}
						return { output, workspaceBefore, workspaceAfter: await snapshotWorkspaceAfter(workspaceBefore, gitExec) };
					},
					settle: async ({ output, workspaceBefore, workspaceAfter }) => {
						timings.totalMs = controller.now() - startedAt;
						state.lastTimings = { ...timings };
						const usage = output.usage;
						state.executorUsage = addUsage(state.executorUsage, usage);
						if (output.stopReason === "error" || output.stopReason === "aborted") {
							const reason = output.errorMessage ? `: ${output.errorMessage}` : "";
							state.executorActivity = "failed";
							appendExecutorProgress(
								`[failed] Executor stopped with status "${output.stopReason}"${reason}.`,
							);
							updateWidget(ctx);
							renderThrottle.flush();
							const text = `Fusion executor stopped with status "${output.stopReason}"${reason}.\n\nExecutor usage this delegation: ${formatUsageSummary(usage)}\nExecutor usage this run: ${formatUsageSummary(state.executorUsage)}\n${timingLine()}`;
							recordDelegation({ stopReason: output.stopReason, usage });
							await controller.persistSettlement(output.stopReason === "error" ? "error" : "cancelled", async () => {
								if (!state.activeRun) return;
								state.activeRun.status = "failed";
								state.activeRun.revisions = state.revisions;
								state.activeRun.results[key] = text;
								const pending = state.activeRun.pending;
								delete state.activeRun.pending;
								try { await persistRunCritical(); } catch (error) { state.activeRun.pending = pending; throw error; }
							});
							controller.setUncertain(false);
							return respond(
								text,
								output.errorMessage ?? output.stopReason,
								usage,
							);
						}
						state.executorActivity = "finished";
						appendExecutorProgress("[finished] Executor completed the delegation.");
						setPhase(ctx, "reviewing");
						const parsed = controller.executorReport(output.text);
						const diffStat = workspaceAfter ? await workspaceDiffStat(workspaceBefore, gitExec, touchedFiles, workspaceAfter) : undefined;
						const evidence = await workspaceEvidenceRefs(workspaceBefore, gitExec, touchedFiles, workspaceAfter);
						lastWorkerResult = { requestId: lastWorkerResult?.requestId ?? key, status: lastWorkerResult?.status ?? "completed", text: lastWorkerResult?.text ?? "", evidence: evidence ?? [] };
						renderThrottle.flush();
						const text = `${formatCompactReport(parsed.report, diffStat, parsed.prose, isResume ? ["resumed after restart"] : [])}\n\nExecutor usage this delegation: ${formatUsageSummary(usage)}\nExecutor usage this run: ${formatUsageSummary(state.executorUsage)}\n${timingLine()}`;
						recordDelegation({ reportStatus: parsed.report.status, usage });
						await controller.persistSettlement("completed", async () => {
							if (!state.activeRun) return;
							state.activeRun.status = "done";
							state.activeRun.revisions = state.revisions;
							state.activeRun.results[key] = text;
							const pending = state.activeRun.pending;
							delete state.activeRun.pending;
							try { await persistRunCritical(); } catch (error) { state.activeRun.pending = pending; throw error; }
						});
						controller.setUncertain(false);
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
					},
				});
			} catch (error) {
				controller.failDelegation();
				if (isResume) controller.setUncertain(true);
				if (!controller.submissionBegan && !controller.uncertain) controller.clearPending();
				timings.totalMs = controller.now() - startedAt;
				state.lastTimings = { ...timings };
				state.executorActivity = "failed";
				const message = error instanceof Error ? error.message : String(error);
				appendExecutorProgress(`[failed] ${message}`);
				updateWidget(ctx);
				renderThrottle.flush();
				const text = `Fusion delegation failed: ${message}\n${timingLine()}`;
				recordDelegation({ stopReason: "error", usage: createEmptyUsage() });
				if (state.activeRun) {
					// A recorded write-ahead intent survives failure: the exact request
					// stays blocked (uncertain) until reconciliation or explicit
					// resolution, and never gets lost because the native write failed.
					const priorPending = workspaceLease?.manifest.pending;
					const intentOwnsKey = !controller.submissionBegan && !controller.uncertain && !!priorPending && priorPending.requestId === key;
					if (!controller.submissionBegan && !controller.uncertain && !intentOwnsKey) {
						controller.clearPending();
						delete state.activeRun.pending;
					}
					if (intentOwnsKey) {
						controller.setPending({ action: params.action as "execute" | "revise" | "final_fix", requestId: key });
						controller.setUncertain(true);
						state.activeRun.pending = { action: params.action as "execute" | "revise" | "final_fix", requestId: key };
					}
					state.activeRun.status = controller.uncertain ? "interrupted" : "failed";
					state.activeRun.revisions = state.revisions;
					state.activeRun.finalFixUsed = state.finalFixUsed;
					if (controller.submissionBegan && !controller.uncertain) state.activeRun.results[key] = text;
					try { await persistRunCritical(); } catch { controller.setUncertain(true); }
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
			const scoutStartedAt = controller.now();
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
				state.scoutMs += controller.now() - scoutStartedAt;
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
			if (changingMode) { ctx.ui.notify("Fusion mode change is in progress.", "error"); return; }
			if (resolvingRun) { ctx.ui.notify("Fusion recovery resolution is in progress.", "error"); return; }
			if (controller.uncertain) { ctx.ui.notify("Fusion has an uncertain executor turn. Use /fusion-resume or inspect the interrupted run before continuing.", "error"); return; }
			if ((await unresolvedRuns(ctx.cwd)).length > 0) { ctx.ui.notify("An interrupted Fusion run requires recovery. Use /fusion-resume or /fusion-resolve.", "error"); return; }
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
			const unresolved = await unresolvedRuns(ctx.cwd);
			if (changingMode) { ctx.ui.notify("Fusion mode change is in progress.", "error"); return; }
			if (resolvingRun || unresolved.length > 0) { ctx.ui.notify("An interrupted Fusion run requires recovery. Use /fusion-resume or /fusion-resolve.", "error"); return; }
			pi.setThinkingLevel(state.supervisorThinking);
			startRun(ctx, task);
			pi.sendUserMessage(buildSupervisorPrompt(task, modelLabel(executor)));
		},
	});

	pi.registerCommand("fusion-config", {
		description: "Select price-tiered Fusion supervisor and executor models",
		handler: async (_args, ctx) => {
			if (changingMode) { ctx.ui.notify("Fusion mode change is in progress.", "error"); return; }
			if (controller.uncertain) { ctx.ui.notify("Fusion has an uncertain executor turn; configuration is locked until recovery.", "error"); return; }
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
			if (changingMode || resolvingRun) { ctx.ui.notify("Fusion is busy; mode changes are locked.", "error"); return; }
			const modeError = controller.resetError();
			if (modeError) { ctx.ui.notify(`${modeError} Mode changes are locked.`, "error"); return; }
			if (!ctx.hasUI) {
				ctx.ui.notify("Fusion mode requires a dialog-capable UI.", "error");
				return;
			}
			changingMode = true;
			try {
				if (state.modeEnabled) {
					state.modeEnabled = false;
					controller.deactivate();
					syncFusionTools();
					state.supervisorUsage = createEmptyUsage();
					state.executorUsage = createEmptyUsage();
					state.executorTranscript = [];
					state.scoutMs = 0;
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
				controller.setPhase("idle");
				updateWidget(ctx);
				ctx.ui.notify(
					`Fusion mode enabled. Supervisor ${modelLabel(supervisor)} (thinking ${state.supervisorThinking}), executor ${modelLabel(executor)} (thinking ${state.executorThinking}).`,
					"info",
				);
			} finally { changingMode = false; }
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
			const owned = workspaceLease?.manifest ?? (await (await registry()).inspect(await canonical(ctx.cwd)))?.manifest;
			const ownership = owned ? ` | owner ${owned.owner.harness}:${owned.owner.supervisorId} | run ${owned.runId} | recovery ${owned.recovery}${owned.pending ? ` | pending ${owned.pending.action}:${owned.pending.requestId}` : ""}` : "";
			ctx.ui.notify(
				`Fusion mode ${mode} | cohort ${RECENT_MODEL_COHORT} | supervisor ${supervisor} | executor ${executor} | phase ${state.phase} | revisions ${state.revisions}/${MAX_REVISIONS} | final fix ${state.finalFixUsed ? 1 : 0}/${MAX_FINAL_FIXES} | scout calls ${state.scoutCalls}/${MAX_SCOUT_CALLS} | scout thinking ${state.scoutThinking} | scout usage ${formatUsageSummary(state.scoutUsage)} | supervisor usage ${formatUsageSummary(state.supervisorUsage)} | executor usage ${formatUsageSummary(state.executorUsage)} | executor activity ${state.executorActivity ?? "-"} | backend ${state.executorBackend}${controller.uncertain ? " | executor outcome uncertain" : ""}${ownership}${lastTimings}`,
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
			if (changingMode) { ctx.ui.notify("Fusion mode change is in progress.", "error"); return; }
			if (resolvingRun) { ctx.ui.notify("Fusion recovery resolution is in progress.", "error"); return; }
			resolvingRun = true;
			try {
				if (!ctx.hasUI) {
					ctx.ui.notify("Fusion resume requires a dialog-capable UI.", "error");
					return;
				}
				await ctx.waitForIdle();
				const interrupted = (await unresolvedRuns(ctx.cwd)).filter((run) => run.status === "interrupted");
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
				if (interrupted.length > 1) { ctx.ui.notify("Multiple interrupted runs require manual resolution before automatic recovery.", "error"); return; }
				if (controller.uncertain && state.activeRun?.runId !== run.runId) {
					ctx.ui.notify("Cannot resume a different run while the current executor outcome is uncertain.", "error");
					return;
				}
				if (run.backend !== "durable") {
					ctx.ui.notify("The Pi session backend cannot reattach to an interrupted turn. Inspect its session and working tree, then use /fusion-resolve.", "error");
					return;
				}
				if (!run.pending || typeof run.pending.requestId !== "string" || !run.pending.requestId || !["execute", "revise", "final_fix"].includes(run.pending.action)) {
					ctx.ui.notify("The interrupted run has no valid original request ID. Inspect it and use /fusion-resolve after confirming the worker has stopped.", "error");
					return;
				}
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
					if (!controller.canReopen(durable.capabilities)) {
						ctx.ui.notify("Cannot resume: the executor transcript cannot be reopened.", "error");
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
						const existingOwner = await (await registry()).inspect(await canonical(ctx.cwd));
						if (!existingOwner && !run.manifest) {
							if (!ctx.hasUI || !await ctx.ui.confirm("Recover legacy Fusion run", "Have you verified that no other Fusion supervisor is coordinating this run? Its legacy record predates shared workspace ownership.")) {
								ctx.ui.notify("Legacy recovery requires confirming that no other supervisor is coordinating the run.", "error");
								return;
							}
						}
						await claimWorkspace(ctx, run);
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
					controller.restore(run, true);
					controller.setPending(run.pending);
					controller.setUncertain(true);
					state.executorUsed = true;
					state.runId = run.runId;
					state.runStartedAt = run.metrics?.startedAt;
					state.activeRun = run;
					syncFusionTools();
					setPhase(ctx, "executing");
					ctx.ui.notify(`Resumed interrupted Fusion run ${run.runId}.`, "info");
					pi.sendUserMessage(
						`The Fusion executor run was interrupted. Original task:\n${state.originalTask}\n\nCall fusion_delegate with action "resume" (brief: "resume") to look up and wait for the original durable submission. If matching evidence is unavailable, the run remains locked. Review the full working tree, then continue the protocol and the final acceptance audit.`,
					);
					return;
				}
			} finally { resolvingRun = false; }
		},
	});

	pi.registerCommand("fusion-resolve", {
		description: "Manually resolve an interrupted run after verifying its worker has stopped",
		handler: async (_args, ctx) => {
			if (changingMode) { ctx.ui.notify("Fusion mode change is in progress.", "error"); return; }
			if (!ctx.hasUI) { ctx.ui.notify("Fusion resolution requires a dialog-capable UI.", "error"); return; }
			if (resolvingRun || state.delegating) { ctx.ui.notify("Fusion is busy.", "error"); return; }
			resolvingRun = true;
			try {
				await ctx.waitForIdle();
				const interrupted = (await unresolvedRuns(ctx.cwd)).filter((run) => run.status === "interrupted");
				if (!interrupted.length) { ctx.ui.notify("No interrupted Fusion runs for this directory.", "info"); return; }
				const labels = interrupted.map((run) => `${run.runId} ${truncateInline(run.task, 60)}`);
				const choice = await selectScrollableOption(ctx, "Resolve interrupted Fusion run", labels);
				if (choice === undefined) return;
				const run = interrupted[labels.indexOf(choice)];
				const confirmed = await ctx.ui.confirm("Resolve interrupted Fusion run", "Have you verified that this executor and its commands have stopped, and inspected the working tree? Fusion cannot verify this automatically.");
				if (!confirmed) return;
				await claimWorkspace(ctx, run, true);
				run.status = "failed";
				run.manualResolution = { at: new Date().toISOString() };
				await runWrites;
				const prior = workspaceLease!.manifest;
				run.manifest = { ...prior, recovery: "settled", pending: undefined, state: { ...prior.state, delegating: false, phase: "failed" }, operatorResolution: { at: run.manualResolution.at, pending: prior.pending } };
				await workspaceLease!.save(run.manifest);
				await writeRun(runsDir(getAgentDir()), run);
				await workspaceLease!.release(); workspaceLease = undefined;
				if (state.activeRun?.runId === run.runId) {
					controller.clearPending();
					controller.setUncertain(false);
					controller.clear();
					disposeExecutor();
					state.activeRun = undefined;
					state.runId = undefined;
					syncFusionTools();
				}
				ctx.ui.notify(`Resolved interrupted Fusion run ${run.runId}; its transcript and pending metadata were retained.`, "info");
			} catch (error) {
				ctx.ui.notify(`Cannot resolve Fusion run: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally { resolvingRun = false; }
		},
	});

	pi.registerCommand("fusion-clean", {
		description: "Dispose executor context and clear Fusion run state",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const resetError = controller.resetError();
			if (resetError) { ctx.ui.notify(resetError, "error"); return; }
			if (state.activeRun) {
				state.activeRun.status = "done";
				try {
					await persistRunCritical();
					await workspaceLease?.release(); workspaceLease = undefined;
				} catch (error) { ctx.ui.notify(`Cannot clean Fusion: ${String(error)}`, "error"); return; }
				state.activeRun = undefined;
				state.runId = undefined;
			} else if (workspaceLease) {
				// A settled lease adopted at startup from a previous process: release it.
				if (workspaceLease.manifest.recovery !== "settled") {
					ctx.ui.notify("Completed Fusion cleanup requires settled ownership; the retained record has an unsettled request. Reconcile or explicitly resolve it first.", "error");
					return;
				}
				try {
					await workspaceLease.release(); workspaceLease = undefined;
				} catch (error) { ctx.ui.notify(`Cannot clean Fusion: ${String(error)}`, "error"); return; }
			}
			disposeExecutor();
			controller.clear();
			syncFusionTools();
			state.supervisorUsage = createEmptyUsage();
			state.executorUsage = createEmptyUsage();
			state.executorTranscript = [];
			state.scoutMs = 0;
			state.scoutUsage = createEmptyUsage();
			updateWidget(ctx);
			ctx.ui.notify(
				"Fusion executor context and completed run data cleared. No temporary files were created.",
				"info",
			);
		},
	});

	pi.on("input", async (event, ctx) => {
		if (!state.modeEnabled || event.source !== "interactive") {
			return { action: "continue" };
		}
		if (event.text.trim().startsWith("/")) {
			return { action: "continue" };
		}
		if (changingMode) { ctx.ui.notify("Fusion mode change is in progress.", "error"); return { action: "handled" }; }
		if (resolvingRun || (await unresolvedRuns(ctx.cwd)).length > 0) {
			ctx.ui.notify("An interrupted Fusion run requires recovery. Use /fusion-resume or /fusion-resolve.", "error");
			return { action: "handled" };
		}
		if (changingMode || resolvingRun) return { action: "handled" };
		if (controller.uncertain) {
			ctx.ui.notify("Fusion has an uncertain executor turn. Use /fusion-resume or inspect the interrupted run before continuing.", "error");
			return { action: "handled" };
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
		const nudge = controller.continuation({
			lastAssistantText,
			outcome: event.outcome,
			canContinue:
				event.context.canContinue ||
				event.context.llmMessages.some((message) => message.role !== "system"),
		});
		if (!nudge) return;
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
		controller.settled(state.modeEnabled);
		updateWidget(ctx);
		if (state.activeRun?.metrics) {
			state.activeRun.metrics.finishedAt = new Date().toISOString();
			void persistRun();
		}
		syncFusionTools();
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			syncFusionTools();
		} catch {}
		// A previous process may have left a settled run owning this workspace:
		// adopt that claim so /fusion-clean can release it instead of leaving the
		// ownership record permanently stranded.
		try {
			if (!workspaceLease) {
				const owned = await (await registry()).inspect(await canonical(ctx.cwd));
				if (owned && owned.manifest.recovery === "settled" && owned.manifest.owner.harness === "pi" &&
					owned.manifest.owner.workspace === await canonical(ctx.cwd) && owned.manifest.owner.supervisorId === ctx.sessionManager.getSessionId()) {
					workspaceLease = await (await registry()).claim(owned.manifest, owned.token);
				}
			}
		} catch { /* Fail closed: an unreadable ownership record stays owned. */ }
		try {
			const runs = await unresolvedRuns(ctx.cwd);
			if (runs.length > 0) {
				ctx.ui.notify(
					"Interrupted Fusion run found. Use /fusion-resume or inspect it and use /fusion-resolve.",
					"warning",
				);
			}
		} catch { /* Interrupted discovery stays silent; the guards re-check later. */ }
	});

	pi.on("session_shutdown", async () => {
		controller.deactivate();
		state.modeEnabled = false;
		state.supervisorUsage = createEmptyUsage();
		state.executorUsage = createEmptyUsage();
		state.executorTranscript = [];
		state.scoutMs = 0;
		state.scoutUsage = createEmptyUsage();
		disposeExecutor();
		try { await runWrites; await loadDurablePromise?.then((loaded) => loaded?.dispose()); }
		finally { workspaceLease?.close(); workspaceLease = undefined; }
		try {
			syncFusionTools();
		} catch {}
	});

	try {
		syncFusionTools();
	} catch {}
}
