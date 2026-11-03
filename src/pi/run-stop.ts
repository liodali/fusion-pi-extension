import type { FusionRun } from "../runs.ts";

/** Why further executor/scout work is refused for a stopped run, shared by
 * the delegation and scout gates so the wording stays identical. */
export const STOPPED_RUN_REFUSAL = "This Fusion run was stopped. Recover a durable turn with /fusion-resume or release the run with /fusion-clean before starting more executor work.";

export interface StopDeps {
	/** The session's active run; mutated only by marking it stopped. */
	activeRun: FusionRun | undefined;
	/** True when the controller holds an unsettled executor request. */
	uncertain: boolean;
	/** Bounded abort of the live executor conversation/session, when one exists. */
	abortExecutor: () => Promise<void>;
	/** Human label of the executor model, for the recap. */
	executorLabel: string;
	/** The backend the run actually delegated on. */
	backend: "session" | "durable" | undefined;
	/** Last observed executor activity. */
	activity: string | undefined;
	/** Most recent executor progress entries, oldest first. */
	transcriptTail: string[];
	/** Persist the stopped run record; a failure must not lose the marker. */
	persist: () => Promise<void>;
	/** Timestamp source, injectable for deterministic tests. */
	now?: () => Date;
}

export interface StopOutcome {
	text: string;
	stopped: boolean;
	/** "delivered" an abort reached a live handle, "unavailable" no handle
	 * exists in this session, "failed" the abort threw, "skipped" there was
	 * nothing to abort or the run was already stopped. */
	abort: "delivered" | "unavailable" | "failed" | "skipped";
	error?: string;
	persisted: boolean;
}

const shortTask = (task: string): string => task.length > 80 ? `${task.slice(0, 77)}...` : task;

/** Stop the current Fusion run and compose a deterministic recap. No model
 * is asked to summarize; every claim comes from recorded state, and
 * termination is never overstated: an abort that was delivered is reported
 * as delivered, a missing handle is reported as unknown, not stopped. */
export async function stopFusionRun(deps: StopDeps, reason?: string): Promise<StopOutcome> {
	const run = deps.activeRun;
	if (!run) return { text: "No Fusion run is active; nothing to stop.", stopped: false, abort: "skipped", persisted: false };
	if (run.stopped) {
		// Idempotent: repeat stops re-report without a second abort attempt.
		return { text: stopRecap(deps, run, "skipped", `already stopped at ${run.stopped.at}`), stopped: true, abort: "skipped", persisted: true };
	}
	let abort: StopOutcome["abort"] = "skipped";
	let error: string | undefined;
	// An uncertain pending turn is the one state where a live executor may
	// still be running; otherwise there is nothing to interrupt.
	if (deps.uncertain) {
		try {
			await deps.abortExecutor();
			abort = "delivered";
		} catch (stopError) {
			abort = "failed";
			error = stopError instanceof Error ? stopError.message : String(stopError);
		}
	}
	run.stopped = { at: (deps.now ?? (() => new Date()))().toISOString(), ...(reason?.trim() ? { reason: shortTask(reason.trim()) } : {}) };
	run.updatedAt = run.stopped.at;
	let persisted = true;
	try {
		await deps.persist();
	} catch {
		persisted = false;
	}
	return { text: stopRecap(deps, run, abort, error, persisted), stopped: true, abort, error, persisted };
}

function stopRecap(deps: StopDeps, run: FusionRun, abort: StopOutcome["abort"], detail?: string, persisted = true): string {
	const lines = [
		`Fusion executor stopped (run ${run.runId}, task "${shortTask(run.task)}").`,
		`Executor: ${deps.executorLabel} on the ${run.backend ?? deps.backend ?? "session"} backend. Last observed: ${deps.activity ?? "no executor activity was observed"}.`,
	];
	if (run.pending) lines.push(`Pending request: ${run.pending.action}:${run.pending.requestId}${deps.uncertain ? " (outcome uncertain)" : ""}.`);
	lines.push(`Revisions used: ${run.revisions}/3${run.finalFixUsed ? ", final fix used" : ""}.`);
	if (abort === "delivered") lines.push("Abort: delivered to the live executor conversation; termination is not independently verified.");
	else if (abort === "failed") lines.push(`Abort failed: ${detail ?? "interruption unavailable"}. Termination is not confirmed.`);
	else if (abort === "skipped" && detail) lines.push(`Abort: ${detail}.`);
	else lines.push("Abort: no executor turn was known to be running. A durable submission left by a crash keeps running until /fusion-resume attaches to it (or /fusion-resolve resolves ownership).");
	if (!persisted) lines.push("The stop marker could not be written to the run record; it is held in this session only. Verify saved status before recovery.");
	if (deps.transcriptTail.length > 0) lines.push(`Recent executor progress:\n${deps.transcriptTail.map((entry) => `- ${entry}`).join("\n")}`);
	lines.push("Partial edits are preserved in the working tree. Inspect the changes, then recover with /fusion-resume or resolve with /fusion-resolve; /fusion-clean releases the run. No further executor or scout work will run for this run.");
	return lines.join("\n");
}
