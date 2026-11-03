import type { DelegateActivity } from "./delegate-presentation.ts";
import { shortLabel } from "./delegate-presentation.ts";
import { readExecutorStop, type ExecutorStop } from "./executor-stop.ts";

/** Read only the latest delegation in the current session's message list. */
export function latestDelegateActivity(messages: readonly unknown[]): DelegateActivity | undefined {
	const reconciled = new Map<string, { completed: boolean; at: number }>();
	const stops = new Map<string, ExecutorStop>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { type?: string; content?: unknown[]; metadata?: Record<string, unknown> };
		const notice = message?.type === "synthetic" ? readExecutorStop(message.metadata?.fusionStop) : undefined;
		if (notice && !stops.has(notice.requestId)) stops.set(notice.requestId, notice);
		if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
		for (let j = message.content.length - 1; j >= 0; j--) {
			const part = message.content[j] as { type?: string; name?: string; state?: { status?: string; input?: unknown; metadata?: Record<string, unknown> }; time?: { created?: number; completed?: number } };
			const stopped = part?.name === "fusion_stop" && part.state?.status === "completed" ? readExecutorStop(part.state.metadata?.stop) : undefined;
			if (stopped && !stops.has(stopped.requestId)) stops.set(stopped.requestId, stopped);
			if (part?.type === "tool" && part.name === "fusion_reconcile" && part.state?.status === "completed") {
				const metadata = part.state.metadata;
				if (typeof metadata?.childSessionID === "string" && typeof metadata.requestId === "string" && ["completed", "error", "cancelled"].includes(String(metadata.status))) {
					const key = JSON.stringify([metadata.childSessionID, metadata.requestId]);
					if (!reconciled.has(key)) reconciled.set(key, { completed: metadata.status === "completed", at: part.time?.completed ?? part.time?.created ?? 0 });
				}
			}
			if (part?.type !== "tool" || part.name !== "fusion_delegate") continue;
			const activity = part.state?.metadata?.fusion as Partial<DelegateActivity> | undefined;
			if (activity?.version === 1 && ["execute", "revise", "final_fix"].includes(activity.action ?? "") && ["starting", "working", "stopping", "stopped", "completed", "background", "uncertain", "failed"].includes(activity.phase ?? "") && typeof activity.title === "string" && typeof activity.activity === "string" && Number.isFinite(activity.startedAt) && Number.isFinite(activity.updatedAt) && Number.isSafeInteger(activity.tools) && activity.tools! >= 0) {
				const final = typeof activity.childSessionID === "string" && typeof activity.requestId === "string" ? reconciled.get(JSON.stringify([activity.childSessionID, activity.requestId])) : undefined;
				const stop = typeof activity.requestId === "string" ? stops.get(activity.requestId) : undefined;
				return { ...activity, title: shortLabel(activity.title, 80), activity: shortLabel(activity.activity), ...(typeof activity.childSessionID === "string" && activity.childSessionID.startsWith("ses_") ? { childSessionID: activity.childSessionID } : { childSessionID: undefined }), ...(stop ? { phase: stop.state === "confirmed" ? stop.terminal === "completed" ? "completed" : stop.terminal === "error" ? "failed" : "stopped" : stop.state === "not-submitted" ? "stopped" : stop.state === "failed" ? "uncertain" : "stopping", activity: stop.state === "confirmed" ? stop.terminal === "completed" ? "Executor completed before interruption" : stop.terminal === "error" ? "Executor ended with an error" : "Executor stopped; reconcile partial results" : stop.state === "not-submitted" ? "Stopped before executor submission" : stop.state === "failed" ? "Stop failed; inspect executor" : "Stop requested; awaiting confirmation", updatedAt: Math.max(activity.updatedAt!, stop.updatedAt) } : {}), ...(final ? { phase: final.completed ? "completed" : "failed", activity: final.completed ? "Reconciled; ready for supervisor review" : "Reconciled executor failure", updatedAt: Math.max(activity.updatedAt!, final.at) } : {}) } as DelegateActivity;
			}
			// During input streaming the host has no progress metadata yet. Do
			// not fall back to an older completed delegation's activity.
			const input = part.state?.input as { action?: string; title?: string } | undefined;
			if (!input || !["execute", "revise", "final_fix"].includes(input.action ?? "")) return;
			return { version: 1, action: input.action as DelegateActivity["action"], title: shortLabel(input.title ?? "Executor delegation", 80), phase: part.state?.status === "completed" ? "completed" : part.state?.status === "error" ? "failed" : "starting", activity: part.state?.status === "error" ? "Delegation failed" : part.state?.status === "completed" ? "Executor completed; activity unavailable" : "Waiting for executor activity", tools: 0, startedAt: part.time?.created ?? 0, updatedAt: part.time?.completed ?? part.time?.created ?? 0 };
		}
	}
}

export function elapsedLabel(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function actionLabel(action: DelegateActivity["action"]): string {
	return action === "execute" ? "Execute" : action === "revise" ? "Revise" : "Final fix";
}
