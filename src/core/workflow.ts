import { MAX_REVISIONS, MAX_SCOUT_CALLS } from "../limits.ts";

export type DelegationAction = "execute" | "revise" | "final_fix" | "resume";
export type FusionPhase = "idle" | "planning" | "executing" | "reviewing" | "revising" | "finalizing" | "scouting" | "complete" | "failed";

/** The policy is independent of the agent runtime and its session types. */
export interface DelegationState {
	delegating: boolean;
	executed: boolean;
	revisions: number;
	finalFixUsed: boolean;
	resumePending: boolean;
}

export interface LifecycleState extends DelegationState {
	runActive: boolean;
	phase: FusionPhase;
	task?: string;
	originalTask?: string;
	executorBrief?: string;
	settleNudges: number;
	scoutCalls: number;
}

/** Validate persisted state before restoring guards or budgets. */
export function isLifecycleState(value: unknown): value is LifecycleState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Record<string, unknown>;
	return ["runActive", "executed", "delegating", "finalFixUsed", "resumePending"].every((key) => typeof state[key] === "boolean") &&
		["revisions", "scoutCalls", "settleNudges"].every((key) => Number.isSafeInteger(state[key]) && (state[key] as number) >= 0) &&
		["idle", "planning", "executing", "reviewing", "revising", "finalizing", "scouting", "complete", "failed"].includes(state.phase as string) &&
		[state.task, state.originalTask, state.executorBrief].every((v) => v === undefined || typeof v === "string");
}

export function delegationError(state: DelegationState, action: DelegationAction): string | undefined {
	if (state.delegating) return "A fusion delegation is already in progress. Wait for it to complete before delegating again.";
	if (action === "execute" && state.executed) return 'Initial execution already completed. Review the working tree and use action "revise" with consolidated feedback.';
	if (action === "revise" && !state.executed) return 'Cannot revise before the initial execution. Call fusion_delegate with action "execute" first.';
	if (action === "final_fix" && !state.executed) return 'Cannot run the final fix before the initial execution. Call fusion_delegate with action "execute" first.';
	if (action === "final_fix" && state.finalFixUsed) return "Final fix already used: only one final_fix is allowed per run. Report remaining gaps to the user.";
	if (action === "revise" && state.revisions >= MAX_REVISIONS) return `Revision limit reached: at most ${MAX_REVISIONS} revisions are allowed. Take over the implementation yourself.`;
	if (action === "resume" && !state.resumePending) return 'Nothing to resume: action "resume" is only valid right after /fusion-resume restores a durable run.';
	return undefined;
}

export function scoutLimitError(calls: number): string | undefined {
	return calls >= MAX_SCOUT_CALLS
		? `Scout limit reached: at most ${MAX_SCOUT_CALLS} fusion_scout calls are allowed per run.`
		: undefined;
}
