import type { DelegationAction, LifecycleState } from "./workflow.ts";

/** A write-ahead record describes intent, not proof that the worker settled. */
export interface RecoveryRecord {
	version: 1;
	harness: string;
	workspace: string;
	parentSessionID: string;
	state: LifecycleState;
	childSessionID?: string;
	pending?: { description: string; action: Exclude<DelegationAction, "resume"> };
}

export function readRecoveryRecord(value: unknown, workspace: string, harness: string): RecoveryRecord {
	if (!value || typeof value !== "object") throw new Error("Invalid Fusion recovery record.");
	const record = value as Record<string, unknown>;
	if (record.version !== 1) throw new Error("Unsupported Fusion recovery record version.");
	const state = record.state as Record<string, unknown> | undefined;
	const pending = record.pending as Record<string, unknown> | undefined;
	if (record.harness !== harness || record.workspace !== workspace || typeof record.parentSessionID !== "string" || !record.parentSessionID ||
		!state || typeof state !== "object" || typeof state.runActive !== "boolean" ||
		typeof state.executed !== "boolean" || typeof state.delegating !== "boolean" || typeof state.finalFixUsed !== "boolean" ||
		typeof state.resumePending !== "boolean" || !Number.isSafeInteger(state.revisions) || (state.revisions as number) < 0 ||
		!Number.isSafeInteger(state.scoutCalls) || (state.scoutCalls as number) < 0 || !Number.isSafeInteger(state.settleNudges) || (state.settleNudges as number) < 0 ||
		!["idle", "planning", "executing", "reviewing", "revising", "finalizing", "scouting", "complete", "failed"].includes(state.phase as string) ||
		[state.task, state.originalTask, state.executorBrief].some((v) => v !== undefined && typeof v !== "string") ||
		(record.childSessionID !== undefined && (typeof record.childSessionID !== "string" || !record.childSessionID)) ||
		(pending !== undefined && (!pending || typeof pending !== "object" || typeof pending.description !== "string" || !pending.description || !["execute", "revise", "final_fix"].includes(pending.action as string)))) {
		throw new Error("Invalid Fusion recovery record.");
	}
	return value as RecoveryRecord;
}

/** A saved pending request is never safe to resubmit without proof of settlement. */
export function recoveryDisposition(record: RecoveryRecord): "settled" | "reconcile" | "manual" {
	if (!record.pending) return "settled";
	return record.childSessionID ? "reconcile" : "manual";
}
