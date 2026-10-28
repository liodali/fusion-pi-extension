import { delegationError, scoutLimitError, type DelegationAction, type DelegationState, type FusionPhase, type LifecycleState } from "./workflow.ts";
import { needsContinuation } from "../settle.ts";

/** Owns the shared workflow transitions; adapters retain their native run data. */
export class FusionController {
	constructor(readonly state: DelegationState & { scoutCalls: number }) {}

	beginDelegation(action: DelegationAction): string | undefined {
		const error = delegationError(this.state, action);
		if (error) return error;
		this.state.delegating = true;
		if (action === "revise") this.state.revisions += 1;
		if (action === "final_fix") this.state.finalFixUsed = true;
		return undefined;
	}

	completeDelegation(): void {
		this.state.executed = true;
	}

	endDelegation(action: DelegationAction): void {
		this.state.delegating = false;
		if (action === "resume") this.state.resumePending = false;
	}

	beginScout(): string | undefined {
		const error = scoutLimitError(this.state.scoutCalls);
		if (!error) this.state.scoutCalls += 1;
		return error;
	}
}

/** Shared task and run lifecycle; native resources and persistence remain adapters' responsibility. */
export class FusionLifecycle extends FusionController {
	declare readonly state: LifecycleState;
	constructor(state: LifecycleState) { super(state); }

	start(task: string): void {
		Object.assign(this.state, { runActive: true, phase: "planning", task, originalTask: task, executorBrief: undefined,
			revisions: 0, finalFixUsed: false, executed: false, delegating: false, settleNudges: 0, scoutCalls: 0, resumePending: false });
	}

	prepareExecution(brief: string): void {
		this.state.runActive = true;
		this.state.task = brief;
		this.state.originalTask ??= brief;
		this.state.executorBrief = brief;
	}

	restore(run: { task: string; originalTask?: string; brief: string; revisions: number; finalFixUsed?: boolean }, resumePending: boolean): void {
		Object.assign(this.state, { runActive: true, task: run.task, originalTask: run.originalTask ?? run.task, executorBrief: run.brief,
			revisions: run.revisions, finalFixUsed: run.finalFixUsed ?? false, executed: true, delegating: false,
			settleNudges: 0, resumePending });
	}

	setPhase(phase: FusionPhase): void { this.state.phase = phase; }

	continuation(input: { lastAssistantText: string; outcome: "completed" | "aborted" | "error"; canContinue: boolean }): string | undefined {
		if (!this.state.runActive || this.state.delegating) return undefined;
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
		Object.assign(this.state, { runActive: false, phase: "idle", task: undefined, originalTask: undefined, executorBrief: undefined,
			revisions: 0, finalFixUsed: false, executed: false, delegating: false, settleNudges: 0, scoutCalls: 0, resumePending: false });
	}
}
