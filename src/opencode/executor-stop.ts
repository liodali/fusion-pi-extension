import { shortLabel } from "./delegate-presentation.ts";

export interface ExecutorStop {
	requestId: string;
	requestedAt: number;
	updatedAt: number;
	state: "requested" | "acknowledged" | "confirmed" | "not-submitted" | "failed";
	childSessionID?: string;
	reason: string;
	activity?: string;
	tools?: number;
	terminal?: "completed" | "error" | "cancelled";
	error?: string;
	persistenceWarning?: boolean;
}

export function readExecutorStop(value: unknown): ExecutorStop | undefined {
	if (!value || typeof value !== "object") return;
	const item = value as ExecutorStop;
	if (typeof item.requestId !== "string" || !Number.isFinite(item.requestedAt) || !Number.isFinite(item.updatedAt) || typeof item.reason !== "string" || !["requested", "acknowledged", "confirmed", "not-submitted", "failed"].includes(item.state)) return;
	return item;
}

/** One bounded wait, not polling. Stop feedback must not hang on a slow disk
 * or interruption acknowledgement; pending operations retain their guards. */
export async function stopWait(operation: Promise<unknown>, milliseconds: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation.then(() => true, () => false), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]);
	} finally { if (timer) clearTimeout(timer); }
}

/** Bounded deterministic feedback; cancelling never asks another model for a report. */
export function stopFeedback(stop: ExecutorStop): string {
	const status = stop.state === "confirmed" ? stop.terminal === "completed" ? "Executor completed before interruption; its turn has ended." : stop.terminal === "error" ? "Executor ended with an error; its turn has ended." : "Executor turn stopped (cancelled)."
		: stop.state === "not-submitted" ? "Executor stopped before submission."
		: stop.state === "failed" ? `Executor stop failed: ${shortLabel(stop.error ?? "interruption unavailable", 160)}. Termination is not confirmed.`
		: stop.state === "acknowledged" ? "Executor interruption requested. Termination is not confirmed yet."
		: "Executor stop queued; waiting for its child reference. Termination is not confirmed yet.";
	return [status, stop.activity ? `Last observed: ${shortLabel(stop.activity)}${typeof stop.tools === "number" ? ` (${stop.tools} tools)` : ""}.` : "No executor activity was observed.", "Partial edits are preserved. Inspect the working tree and reconcile retained work before resetting; no automatic retry will run.", ...(stop.persistenceWarning ? ["A stop-record write failed or timed out; verify saved status before recovery."] : [])].join("\n");
}
