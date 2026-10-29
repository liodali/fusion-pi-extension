import { readRunManifest, type RunManifest } from "../core/manifest.ts";
import type { WorkerCapabilities, WorkerOwner } from "../core/worker.ts";
import type { FusionRun } from "../runs.ts";

/** Pure legacy mapping. The caller supplies verified supervisor ownership and runtime capabilities. */
export function translatePiRun(run: FusionRun, owner: WorkerOwner, capabilities: WorkerCapabilities): RunManifest {
	if (owner.harness !== "pi" || run.cwd !== owner.workspace || !["running", "interrupted", "done", "failed"].includes(run.status) ||
		typeof run.task !== "string" || typeof run.brief !== "string" || !run.executor ||
		(run.backend !== undefined && run.backend !== "session" && run.backend !== "durable")) throw new Error("Invalid legacy Pi run.");
	const runtime = run.backend ?? "session";
	let id: string | undefined;
	if (runtime === "durable") {
		if (run.conversationId !== undefined && (!Number.isSafeInteger(run.conversationId) || run.conversationId <= 0)) throw new Error("Invalid legacy Pi conversation ID.");
		id = run.conversationId === undefined ? undefined : String(run.conversationId);
	} else {
		if (run.sessionFile !== undefined && (typeof run.sessionFile !== "string" || !run.sessionFile.trim())) throw new Error("Invalid legacy Pi session path.");
		id = run.sessionFile;
	}
	const resolved = run.manualResolution !== undefined;
	if (resolved && run.status !== "failed") throw new Error("Invalid legacy Pi operator resolution.");
	const pending = resolved ? undefined : run.pending;
	const interrupted = run.status === "running" || run.status === "interrupted";
	return readRunManifest({
		version: 2, runId: run.runId, owner, capabilities,
		state: { runActive: interrupted || !!pending, phase: interrupted || pending ? "failed" : run.status === "done" ? "complete" : "failed",
			task: run.task, originalTask: run.originalTask ?? run.task, executorBrief: run.brief,
			executed: run.status === "done" || run.revisions > 0, revisions: run.revisions, finalFixUsed: run.finalFixUsed ?? false,
			delegating: false, resumePending: false, scoutCalls: 0, settleNudges: 0 },
		model: { provider: run.executor.provider, modelId: run.executor.modelId, variant: run.executor.thinking },
		worker: id ? { owner, runtime, id } : undefined,
		recovery: pending ? "pending" : interrupted ? "manual" : "settled", pending,
		operatorResolution: resolved ? { at: run.manualResolution!.at, pending: run.pending } : undefined,
		adapterData: { legacyPi: run },
	}, { harness: "pi", workspace: owner.workspace });
}
