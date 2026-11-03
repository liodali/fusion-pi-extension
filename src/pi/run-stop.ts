import type { FusionRun } from "../runs.ts";

/** Why further executor/scout work is refused for a stopped run, shared by
 * the delegation and scout gates so the wording stays identical. */
export const STOPPED_RUN_REFUSAL = "This Fusion run was stopped. Recover a durable turn with /fusion-resume or release the run with /fusion-clean before starting more executor work.";

/** Abort delivery recorded on the stop marker. "pending" means the bounded
 * stop wait elapsed without the abort settling; a follower updates the
 * marker when it does. */
export type StopAbortState = "delivered" | "failed" | "pending";

export interface StopDeps {
	/** The session's active run; mutated only by marking it stopped. */
	activeRun: FusionRun | undefined;
	/** True when the controller holds an unsettled executor request. */
	uncertain: boolean;
	/** Abort the live executor conversation/session, when one exists. */
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
	/** Bound for the abort wait (default 1500ms); past it delivery reports pending. */
	abortTimeoutMs?: number;
	/** Bound for each marker-write wait (default 2000ms); a slow disk cannot stall the stop. */
	persistTimeoutMs?: number;
}

export interface StopOutcome {
	text: string;
	stopped: boolean;
	/** "delivered" the abort settled, "failed" it rejected, "pending" the
	 * bounded wait elapsed without it settling (it is still followed), and
	 * "skipped" nothing was known to be running or a delivery already holds. */
	abort: StopAbortState | "skipped";
	error?: string;
	persisted: boolean;
}

const shortTask = (task: string): string => task.length > 80 ? `${task.slice(0, 77)}...` : task;

/** One bounded wait, never polling: the caller's recap must not hang behind
 * a stalled write or abort. The operation may still settle after the bound. */
function waitOrTimeout(operation: Promise<void>, milliseconds: number, label: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		operation,
		new Promise<void>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds); }),
	]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** Stop the current Fusion run and compose a deterministic recap. No model
 * is asked to summarize; every claim comes from recorded state, and
 * termination is never overstated. Ordering is deliberate: the stop marker
 * is set before any awaited I/O, so a stalled abort or write can never
 * leave the run unmarked or block the supervisor's feedback; the abort wait
 * is bounded and reports delivery as pending until it settles; and every
 * call retries a previously failed marker write, so a repeated stop never
 * claims a persistence that did not happen. */
export async function stopFusionRun(deps: StopDeps, reason?: string): Promise<StopOutcome> {
	const run = deps.activeRun;
	if (!run) return { text: "No Fusion run is active; nothing to stop.", stopped: false, abort: "skipped", persisted: false };
	const at = (deps.now ?? (() => new Date()))().toISOString();
	// Marker first: the delegation and scout gates key off it immediately,
	// in memory, whatever happens to the writes or abort below.
	const fresh = !run.stopped;
	const marker = run.stopped ?? { at, ...(reason?.trim() ? { reason: shortTask(reason.trim()) } : {}) };
	run.stopped = marker;
	run.updatedAt = marker.at;
	// Retry an abort only when a live turn may still exist and no delivery
	// holds or is in flight: repeat stops retry failures, never successes
	// and never a pending attempt.
	const wantsAbort = deps.uncertain && (fresh || marker.abort === undefined || marker.abort === "failed");
	let persisted = true;
	const writeMarker = async (): Promise<void> => {
		try {
			await waitOrTimeout(deps.persist(), deps.persistTimeoutMs ?? 2000, "stop-marker write");
		} catch {
			persisted = false;
		}
	};
	await writeMarker();
	let abortError: string | undefined;
	if (wantsAbort) {
		marker.abort = "pending";
		const operation = deps.abortExecutor();
		const outcome = await new Promise<"delivered" | "failed" | "timeout">((resolve) => {
			const timer = setTimeout(() => resolve("timeout"), deps.abortTimeoutMs ?? 1500);
			void operation.then(
				() => { clearTimeout(timer); resolve("delivered"); },
				(error) => { clearTimeout(timer); abortError = error instanceof Error ? error.message : String(error); resolve("failed"); },
			);
		});
		if (outcome === "timeout") {
			// The abort keeps running: the marker (and the run record, best
			// effort) catch up when it settles so /fusion-status stays honest.
			void operation.then(
				() => { if (marker.abort === "pending") { marker.abort = "delivered"; void deps.persist().catch(() => {}); } },
				(error) => { if (marker.abort === "pending") { marker.abort = "failed"; abortError = error instanceof Error ? error.message : String(error); void deps.persist().catch(() => {}); } },
			);
		} else if (outcome === "failed") marker.abort = "failed";
		else marker.abort = "delivered";
		// The delivery state belongs on the record; a failed write never
		// un-stops the run and stays retryable by the next stop.
		await writeMarker();
	}
	const abort: StopOutcome["abort"] = marker.abort ?? "skipped";
	return { text: stopRecap(deps, run, abort, abortError, persisted, fresh), stopped: true, abort, ...(abortError !== undefined ? { error: abortError } : {}), persisted };
}

function stopRecap(deps: StopDeps, run: FusionRun, abort: StopOutcome["abort"], detail?: string, persisted = true, fresh = true): string {
	const lines = [
		`Fusion executor stopped (run ${run.runId}, task "${shortTask(run.task)}")${fresh ? "." : `; already stopped at ${run.stopped?.at}.`}`,
		`Executor: ${deps.executorLabel} on the ${run.backend ?? deps.backend ?? "session"} backend. Last observed: ${deps.activity ?? "no executor activity was observed"}.`,
	];
	if (run.pending) lines.push(`Pending request: ${run.pending.action}:${run.pending.requestId}${deps.uncertain ? " (outcome uncertain)" : ""}.`);
	lines.push(`Revisions used: ${run.revisions}/3${run.finalFixUsed ? ", final fix used" : ""}.`);
	if (abort === "delivered") lines.push("Abort: delivered to the live executor conversation; termination is not independently verified.");
	else if (abort === "failed") lines.push(`Abort failed: ${detail ?? "interruption unavailable"}. Termination is not confirmed.`);
	else if (abort === "pending") lines.push("Abort: pending (the bounded stop wait elapsed without delivery); termination is not confirmed. The stop record updates when the abort settles.");
	else lines.push("Abort: no executor turn was known to be running. A durable submission left by a crash keeps running until /fusion-resume attaches to it (or /fusion-resolve resolves ownership).");
	if (!persisted) lines.push("The stop marker could not be written to the run record; it is held in this session only. Verify saved status before recovery.");
	if (deps.transcriptTail.length > 0) lines.push(`Recent executor progress:\n${deps.transcriptTail.map((entry) => `- ${entry}`).join("\n")}`);
	lines.push("Partial edits are preserved in the working tree. Inspect the changes, then recover with /fusion-resume or resolve with /fusion-resolve; /fusion-clean releases the run. No further executor or scout work will run for this run.");
	return lines.join("\n");
}
