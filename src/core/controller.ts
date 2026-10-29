import { randomUUID } from "node:crypto";
import { delegationError, scoutLimitError, type DelegationAction, type FusionPhase, type LifecycleState } from "./workflow.ts";
import { needsContinuation } from "../settle.ts";
import { buildExecutorPrompt, buildFinalFixPrompt, buildRevisionPrompt } from "../prompts.ts";
import { parseExecutorReport } from "../report.ts";
import type { WorkerCapabilities, WorkerReference, WorkerRuntime, WorkerTurnOptions, WorkerTurnRequest, WorkerTurnResult } from "./worker.ts";

/**
 * Injectable time and identity. Adapters keep their native formats (deterministic
 * request keys for durable reattach, timestamped run ids) while the policy that
 * mints them lives in the controller.
 */
export interface ControllerServices {
	now(): number;
	newRunId(): string;
	/** Must stay stable across restart when a runtime reattaches to a pending submission. */
	newRequestId(action: DelegationAction, brief: string, revision: number): string;
}

export const defaultControllerServices: ControllerServices = {
	now: () => Date.now(),
	newRunId: () => randomUUID(),
	newRequestId: (action, brief, revision) => `${action}:${revision}:${randomUUID()}`,
};

/**
 * Adapter closures keep native contexts and storage formats outside the core.
 * `claim` rejects the delegation before intent is recorded; budget refunds apply,
 * but clearing a recorded intent stays with the adapter that persisted it.
 */
export interface DelegationPorts<Snapshot, Output, Evidence, Result> {
	claim(): Promise<void>;
	recordIntent(): Promise<void>;
	snapshot(): Promise<Snapshot>;
	submit(snapshot: Snapshot): Promise<Output>;
	collect(output: Output, snapshot: Snapshot): Promise<Evidence>;
	settle(evidence: Evidence): Promise<Result>;
}

export interface WorkerDelegationPorts<Snapshot, Evidence, Result> extends Omit<DelegationPorts<Snapshot, WorkerTurnResult, Evidence, Result>, "submit"> {
	/** Persist a reference already known before submission, or first observed later. */
	recordReference(reference: WorkerReference): Promise<void>;
}

export interface PendingDelegation {
	action: DelegationAction;
	requestId: string;
}

/** Owns the shared workflow transitions; adapters retain their native run data. */
export class FusionController {
	private activeAction?: DelegationAction;
	private submissionStarted = false;
	private performing = false;
	private previousBudget?: { revisions: number; finalFixUsed: boolean };
	private pendingTurn?: PendingDelegation;
	private outcomeUnknown = false;
	constructor(readonly state: LifecycleState, private services: ControllerServices = defaultControllerServices, private workerRuntime?: WorkerRuntime) {}

	/** Bind the runtime selected by the host before starting the acquired turn. */
	bindWorkerRuntime(runtime: WorkerRuntime): void {
		if (this.performing || this.submissionStarted) throw new Error("Cannot change worker runtime during a delegation.");
		this.workerRuntime = runtime;
	}

	now(): number { return this.services.now(); }

	newRunId(): string { return this.services.newRunId(); }

	/** Mint a delegation's request identity without mutating state. */
	requestIdFor(action: DelegationAction, brief: string): string {
		return this.services.newRequestId(action, brief, action === "revise" ? this.state.revisions + 1 : 0);
	}

	validateDelegation(action: DelegationAction, brief?: string): string | undefined {
		if (brief !== undefined && !brief.trim()) return "Fusion delegation requires a non-empty brief.";
		if (this.state.delegating) return delegationError(this.state, action);
		if ((this.outcomeUnknown || this.pendingTurn) && !(action === "resume" && this.state.resumePending)) return "The executor's last turn has an unknown outcome. Review the child session and working tree before recovery; automatic retry is disabled.";
		return delegationError(this.state, action);
	}

	beginDelegation(action: DelegationAction, capabilities?: WorkerCapabilities, brief?: string, requestId?: string): string | undefined {
		const error = this.validateDelegation(action, brief);
		if (error) return error;
		if (action === "resume" && !capabilities?.activeTurnReattach) return "This worker cannot reattach to an interrupted turn.";
		// Minted before budget mutation so a pre-begin mint and an in-begin mint agree.
		const pendingId = action === "resume" ? undefined : requestId ?? this.requestIdFor(action, brief ?? "");
		this.activeAction = action;
		this.submissionStarted = false;
		this.previousBudget = { revisions: this.state.revisions, finalFixUsed: this.state.finalFixUsed };
		this.state.delegating = true;
		if (action === "revise") this.state.revisions += 1;
		if (action === "final_fix") this.state.finalFixUsed = true;
		if (pendingId) this.pendingTurn = { action, requestId: pendingId };
		return undefined;
	}

	canReopen(capabilities: WorkerCapabilities): boolean {
		return capabilities.transcriptReopen;
	}

	get submissionBegan(): boolean { return this.submissionStarted; }
	get pending(): Readonly<PendingDelegation> | undefined { return this.pendingTurn; }
	get uncertain(): boolean { return this.outcomeUnknown; }

	/** Restore path only: delegation begins record their pending request directly. */
	setPending(pending: PendingDelegation): void { this.pendingTurn = { ...pending }; }
	clearPending(): void { this.pendingTurn = undefined; }
	setUncertain(uncertain: boolean): void { this.outcomeUnknown = uncertain; }

	resetError(uncertain = false, reconciling = false): string | undefined {
		if (this.state.delegating || this.pendingTurn || this.outcomeUnknown || uncertain || reconciling) return "Cannot reset an active or uncertain executor turn.";
		return undefined;
	}

	completeDelegation(): void {
		this.state.executed = true;
	}

	settleDelegation(outcome: "completed" | "error" | "cancelled"): void {
		this.completeDelegation();
		this.state.phase = outcome === "completed" ? "reviewing" : "failed";
	}

	/** Save a terminal outcome before allowing any further delegation. */
	async persistSettlement(outcome: "completed" | "error" | "cancelled", persist: () => Promise<void>): Promise<void> {
		const pending = this.pendingTurn;
		this.settleDelegation(outcome);
		this.clearPending();
		try { await persist(); } catch (error) { this.pendingTurn = pending; throw error; }
	}

	endDelegation(action: DelegationAction): void {
		this.state.delegating = false;
		if (action === "resume" && !this.outcomeUnknown && !this.pendingTurn) this.state.resumePending = false;
		this.activeAction = undefined;
		this.previousBudget = undefined;
	}

	/** Refund a budget only when the runtime was definitely never invoked. */
	failBeforeSubmission(): void {
		if (!this.activeAction || this.submissionStarted || !this.previousBudget) return;
		this.state.revisions = this.previousBudget.revisions;
		this.state.finalFixUsed = this.previousBudget.finalFixUsed;
		this.previousBudget = undefined;
	}

	/** Record a failed attempt, including failures before the delegation sequence starts. */
	failDelegation(): void {
		this.failBeforeSubmission();
		if (this.submissionStarted) this.outcomeUnknown = true;
		this.state.phase = "failed";
	}

	async performDelegation<Snapshot, Output, Evidence, Result>(ports: DelegationPorts<Snapshot, Output, Evidence, Result>): Promise<Result> {
		if (!this.state.delegating || !this.activeAction) throw new Error("No Fusion delegation is in progress.");
		if (this.performing) throw new Error("Fusion delegation is already in progress.");
		this.performing = true;
		try {
			await ports.claim();
			await ports.recordIntent();
			const snapshot = await ports.snapshot();
			this.submissionStarted = true;
			const output = await ports.submit(snapshot);
			const evidence = await ports.collect(output, snapshot);
			return await ports.settle(evidence);
		} catch (error) {
			this.failDelegation();
			throw error;
		} finally {
			this.performing = false;
		}
	}

	/** Run through the shared worker contract; adapters keep native contexts in the runtime. */
	async performWorkerDelegation<Snapshot, Evidence, Result>(request: WorkerTurnRequest, options: Omit<WorkerTurnOptions, "onReference">, ports: WorkerDelegationPorts<Snapshot, Evidence, Result>): Promise<Result> {
		const runtime = this.workerRuntime;
		if (!runtime) throw new Error("No worker runtime is configured.");
		if (!this.activeAction || !this.pendingTurn || this.pendingTurn.requestId !== request.requestId) throw new Error("Worker request does not match the pending delegation.");
		if (!request.runId || !request.requestId) throw new Error("Worker run and request IDs are required.");
		if (this.activeAction === "resume" && !runtime.capabilities.activeTurnReattach) throw new Error("This worker cannot reattach to an interrupted turn.");
		const worker = request.worker;
		let referenceId: string | undefined;
		const validateReference = (reference: WorkerReference): void => {
			if (!reference.id || reference.runtime !== worker.runtime || reference.owner.harness !== worker.owner.harness || reference.owner.supervisorId !== worker.owner.supervisorId || reference.owner.workspace !== worker.owner.workspace) throw new Error("Worker reference does not match its owner and runtime.");
			if (referenceId && referenceId !== reference.id) throw new Error("Worker reference changed during delegation.");
			referenceId = reference.id;
		};
		return this.performDelegation({
			...ports,
			snapshot: async () => {
				const snapshot = await ports.snapshot();
				if (worker.reference) { validateReference(worker.reference); await ports.recordReference(worker.reference); }
				return snapshot;
			},
			submit: async () => {
				let acceptingCallbacks = true;
				// Duplicate native event identities deliver once; events without a
				// native id cannot be deduplicated and always deliver.
				const seenEventIds = new Set<string>();
				const turnOptions: WorkerTurnOptions = {
					...options,
					onEvent: (event) => {
						if (!acceptingCallbacks || event.worker !== worker || event.runId !== request.runId || event.requestId !== request.requestId) return;
						if (event.nativeEventId !== undefined) {
							if (seenEventIds.has(event.nativeEventId)) return;
							seenEventIds.add(event.nativeEventId);
						}
						options.onEvent(event);
					},
					onReference: async (reference) => {
						if (!acceptingCallbacks) throw new Error("Worker turn no longer accepts reference updates.");
						validateReference(reference); await ports.recordReference(reference);
					},
				};
				try {
					const result = this.activeAction === "resume" ? await runtime.reattach(request, turnOptions) : await runtime.submit(request, turnOptions);
					if (result.role !== "executor" || result.worker !== worker || result.runId !== request.runId || result.requestId !== request.requestId) throw new Error("Worker result does not match the pending delegation.");
					return result;
				} finally { acceptingCallbacks = false; }
			},
		});
	}

	beginScout(): string | undefined {
		const error = scoutLimitError(this.state.scoutCalls);
		if (!error) this.state.scoutCalls += 1;
		return error;
	}

	start(task: string): void {
		if (this.state.delegating || this.pendingTurn || this.outcomeUnknown) throw new Error("Cannot start a Fusion run while an executor turn is unsettled.");
		this.initializeRun(task);
	}

	private initializeRun(task: string): void {
		Object.assign(this.state, { runActive: true, phase: "planning", task, originalTask: task, executorBrief: undefined,
			revisions: 0, finalFixUsed: false, executed: false, settleNudges: 0, scoutCalls: 0, resumePending: false });
	}

	prepareExecution(brief: string): void {
		this.state.runActive = true;
		this.state.task = brief;
		this.state.originalTask ??= brief;
		this.state.executorBrief = brief;
		this.state.revisions = 0;
		this.state.finalFixUsed = false;
		this.state.executed = false;
	}

	/** Initialize a run after the delegation guard has already been acquired. */
	startExecution(task: string, brief: string): void {
		if (!this.state.delegating || this.activeAction !== "execute" || this.performing || this.submissionStarted || this.outcomeUnknown) {
			throw new Error("An initial Fusion delegation must be acquired before starting execution.");
		}
		this.initializeRun(task);
		this.prepareExecution(brief);
	}

	delegationPrompt(action: DelegationAction, brief: string, includeOriginalBrief = false): string {
		const originalBrief = includeOriginalBrief ? this.state.executorBrief : undefined;
		if (action === "execute") return buildExecutorPrompt(brief);
		if (action === "revise") return buildRevisionPrompt(brief, this.state.revisions, originalBrief);
		if (action === "final_fix") return buildFinalFixPrompt(brief, this.state.originalTask, originalBrief);
		return "";
	}

	/** Normalize executor output before native presentation and workspace review. */
	executorReport(text: string): ReturnType<typeof parseExecutorReport> {
		return parseExecutorReport(text);
	}

	/** Deactivate presentation state while retaining the current task metadata. */
	deactivate(): void {
		Object.assign(this.state, { runActive: false, phase: "idle", settleNudges: 0, scoutCalls: 0, resumePending: false });
	}

	restore(run: { task: string; originalTask?: string; brief: string; revisions: number; finalFixUsed?: boolean }, resumePending: boolean): void {
		Object.assign(this.state, { runActive: true, task: run.task, originalTask: run.originalTask ?? run.task, executorBrief: run.brief,
			revisions: run.revisions, finalFixUsed: run.finalFixUsed ?? false, executed: true, delegating: false,
			settleNudges: 0, resumePending });
	}

	setPhase(phase: FusionPhase): void { this.state.phase = phase; }

	continuation(input: { lastAssistantText: string; outcome: "completed" | "aborted" | "error"; canContinue: boolean }): string | undefined {
		if (!this.state.runActive || this.state.delegating || this.outcomeUnknown) return undefined;
		const nudge = needsContinuation({ ...input, executed: this.state.executed, nudges: this.state.settleNudges });
		if (nudge) this.state.settleNudges += 1;
		return nudge;
	}

	settled(persistentMode: boolean): void {
		if (!this.state.runActive) return;
		if (this.state.phase !== "failed") this.state.phase = "complete";
		if (!persistentMode) this.state.runActive = false;
	}

	clear(): void {
		const error = this.resetError();
		if (error) throw new Error(error);
		Object.assign(this.state, { runActive: false, phase: "idle", task: undefined, originalTask: undefined, executorBrief: undefined,
			revisions: 0, finalFixUsed: false, executed: false, delegating: false, settleNudges: 0, scoutCalls: 0, resumePending: false });
		this.pendingTurn = undefined;
		this.outcomeUnknown = false;
	}
}

/** Backwards-compatible name for callers migrating to FusionController. */
export { FusionController as FusionLifecycle };
