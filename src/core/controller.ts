import { delegationError, scoutLimitError, type DelegationAction, type FusionPhase, type LifecycleState } from "./workflow.ts";
import { needsContinuation } from "../settle.ts";
import { buildExecutorPrompt, buildFinalFixPrompt, buildRevisionPrompt } from "../prompts.ts";
import type { WorkerCapabilities } from "./worker.ts";

/** Adapter closures keep native contexts and storage formats outside the core. */
export interface DelegationPorts<Snapshot, Output, Evidence, Result> {
	recordIntent(): Promise<void>;
	snapshot(): Promise<Snapshot>;
	submit(snapshot: Snapshot): Promise<Output>;
	collect(output: Output, snapshot: Snapshot): Promise<Evidence>;
	settle(evidence: Evidence): Promise<Result>;
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
	constructor(readonly state: LifecycleState) {}

	validateDelegation(action: DelegationAction, brief?: string): string | undefined {
		if (brief !== undefined && !brief.trim()) return "Fusion delegation requires a non-empty brief.";
		if (this.state.delegating) return delegationError(this.state, action);
		if ((this.outcomeUnknown || this.pendingTurn) && !(action === "resume" && this.state.resumePending)) return "The executor's last turn has an unknown outcome. Review the child session and working tree before recovery; automatic retry is disabled.";
		return delegationError(this.state, action);
	}

	beginDelegation(action: DelegationAction, capabilities?: WorkerCapabilities, brief?: string): string | undefined {
		const error = this.validateDelegation(action, brief);
		if (error) return error;
		if (action === "resume" && !capabilities?.activeTurnReattach) return "This worker cannot reattach to an interrupted turn.";
		this.activeAction = action;
		this.submissionStarted = false;
		this.previousBudget = { revisions: this.state.revisions, finalFixUsed: this.state.finalFixUsed };
		this.state.delegating = true;
		if (action === "revise") this.state.revisions += 1;
		if (action === "final_fix") this.state.finalFixUsed = true;
		return undefined;
	}

	canReopen(capabilities: WorkerCapabilities): boolean {
		return capabilities.transcriptReopen;
	}

	get submissionBegan(): boolean { return this.submissionStarted; }
	get pending(): Readonly<PendingDelegation> | undefined { return this.pendingTurn; }
	get uncertain(): boolean { return this.outcomeUnknown; }

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

	async performDelegation<Snapshot, Output, Evidence, Result>(ports: DelegationPorts<Snapshot, Output, Evidence, Result>): Promise<Result> {
		if (!this.state.delegating || !this.activeAction) throw new Error("No Fusion delegation is in progress.");
		if (this.performing) throw new Error("Fusion delegation is already in progress.");
		this.performing = true;
		try {
			await ports.recordIntent();
			const snapshot = await ports.snapshot();
			this.submissionStarted = true;
			const output = await ports.submit(snapshot);
			const evidence = await ports.collect(output, snapshot);
			return await ports.settle(evidence);
		} catch (error) {
			this.failBeforeSubmission();
			if (this.submissionStarted) this.outcomeUnknown = true;
			throw error;
		} finally {
			this.performing = false;
		}
	}

	beginScout(): string | undefined {
		const error = scoutLimitError(this.state.scoutCalls);
		if (!error) this.state.scoutCalls += 1;
		return error;
	}

	start(task: string): void {
		if (this.pendingTurn || this.outcomeUnknown) throw new Error("Cannot start a Fusion run while an executor turn is unsettled.");
		Object.assign(this.state, { runActive: true, phase: "planning", task, originalTask: task, executorBrief: undefined,
			revisions: 0, finalFixUsed: false, executed: false, delegating: false, settleNudges: 0, scoutCalls: 0, resumePending: false });
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
		this.start(task);
		this.state.delegating = true;
		this.prepareExecution(brief);
	}

	delegationPrompt(action: DelegationAction, brief: string, includeOriginalBrief = false): string {
		const originalBrief = includeOriginalBrief ? this.state.executorBrief : undefined;
		if (action === "execute") return buildExecutorPrompt(brief);
		if (action === "revise") return buildRevisionPrompt(brief, this.state.revisions, originalBrief);
		if (action === "final_fix") return buildFinalFixPrompt(brief, this.state.originalTask, originalBrief);
		return "";
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
