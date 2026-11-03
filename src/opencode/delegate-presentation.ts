import type { WorkerEvent } from "../core/worker.ts";

export type DelegateAction = "execute" | "revise" | "final_fix";
export type DelegatePhase = "starting" | "working" | "stopping" | "stopped" | "completed" | "background" | "uncertain" | "failed";
export interface DelegateActivity {
	version: 1;
	action: DelegateAction;
	title: string;
	phase: DelegatePhase;
	activity: string;
	tools: number;
	startedAt: number;
	updatedAt: number;
	childSessionID?: string;
	requestId?: string;
}

/** Only the action/title are top-level strings: OpenCode's generic row leaves
 * the detailed instructions collapsed instead of printing them in full. */
export const DELEGATE_INPUT = {
	type: "object",
	properties: {
		action: { type: "string", enum: ["execute", "revise", "final_fix"] },
		title: { type: "string", minLength: 1, maxLength: 80, description: "Short display title, e.g. Implement S3 object operations. Do not put the brief here." },
		details: { type: "object", properties: { brief: { type: "string", minLength: 1 }, originalTask: { type: "string" } }, required: ["brief"], additionalProperties: false },
		brief: { type: "string", minLength: 1, deprecated: true, description: "Legacy calls only. For new calls use title and details.brief to keep the row compact." },
		originalTask: { type: "string", deprecated: true, description: "Legacy calls only. For new calls use details.originalTask if needed." },
	},
	required: ["action"],
	oneOf: [
		{ required: ["title", "details"], not: { anyOf: [{ required: ["brief"] }, { required: ["originalTask"] }] } },
		{ required: ["brief"], not: { required: ["details"] } },
	],
	additionalProperties: false,
};

export function shortLabel(value: string, limit = 100): string {
	return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** Legacy direct callers keep working; newly advertised host calls use details. */
export function delegateInput(input: unknown): { action: DelegateAction; title: string; brief: string; originalTask?: string } {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Fusion delegation input.");
	const value = input as Record<string, unknown>;
	if (value.action !== "execute" && value.action !== "revise" && value.action !== "final_fix") throw new Error("Invalid Fusion delegation input.");
	const details = value.details === undefined ? value : value.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) throw new Error("Invalid Fusion delegation input.");
	const payload = details as Record<string, unknown>;
	if (typeof payload.brief !== "string" || !payload.brief.trim() || (payload.originalTask !== undefined && typeof payload.originalTask !== "string") || (value.title !== undefined && (typeof value.title !== "string" || !value.title.trim()))) throw new Error("Invalid Fusion delegation input.");
	if (value.details !== undefined && (value.brief !== undefined || value.originalTask !== undefined)) throw new Error("Put delegation instructions in details only.");
	return { action: value.action, title: shortLabel(typeof value.title === "string" ? value.title : payload.brief, 80), brief: payload.brief, ...(typeof payload.originalTask === "string" ? { originalTask: payload.originalTask } : {}) };
}

/** Best-effort UI updates never decide execution or settlement. No reasoning,
 * text deltas, shell arguments, or tool results enter progress metadata. */
export function delegateMonitor(options: {
	action: DelegateAction; title: string; streaming: boolean; requestId?: string;
	progress(update: Record<string, unknown>): Promise<void>;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	const state: DelegateActivity = { version: 1, action: options.action, title: options.title, requestId: options.requestId, phase: "starting", activity: options.streaming ? "Starting executor" : "Executor activity unavailable", tools: 0, startedAt: now(), updatedAt: now() };
	let stopped = false;
	let inFlight = false;
	let pending: Record<string, unknown> | undefined;
	const seen = new Set<string>();
	const snapshot = (): DelegateActivity => ({ ...state });
	const flush = () => {
		if (inFlight || !pending) return;
		const update = pending;
		pending = undefined;
		inFlight = true;
		void Promise.resolve().then(() => options.progress(update)).catch(() => {}).finally(() => {
			inFlight = false;
			flush();
		});
	};
	const send = (extra: Record<string, unknown> = {}) => {
		// Keep at most one pending update. A broken host progress callback must
		// never block submission, stopping, or settlement, or grow this queue.
		pending = { ...pending, ...extra, fusion: snapshot() };
		flush();
	};
	return {
		snapshot,
		start: () => send(),
		requestStop() {
			if (stopped) return;
			state.phase = "stopping";
			state.activity = "Stop requested; awaiting executor";
			state.updatedAt = now();
			void send();
		},
		async nativeProgress(update: Record<string, unknown>) {
			if (stopped) return;
			if (typeof update.sessionID === "string" && update.sessionID) state.childSessionID = update.sessionID;
			state.updatedAt = now();
			send(update);
		},
		onEvent(update: WorkerEvent) {
			if (stopped) return;
			const event = update.event;
			if (event.type !== "tool_start" && event.type !== "tool_end") return;
			if (state.phase !== "stopping") state.phase = "working";
			const tool = shortLabel(event.toolName, 32) || "tool";
			if (event.type === "tool_start") {
				if (seen.has(event.toolCallId)) return;
				seen.add(event.toolCallId);
				state.tools++;
				const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : undefined;
				const path = typeof args?.filePath === "string" ? args.filePath : typeof args?.path === "string" ? args.path : undefined;
				const file = ["read", "edit", "write", "patch"].includes(tool) && path && !path.includes("://") ? shortLabel(path, 70) : "";
				state.activity = `Running ${tool}${file ? ` · ${file}` : ""}`;
			} else state.activity = `${event.isError ? "Failed" : "Finished"} ${tool}`;
			state.updatedAt = now();
			void send();
		},
		async finish(phase: DelegatePhase) {
			if (!stopped) {
				stopped = true;
				state.phase = phase;
				state.activity = phase === "completed" ? "Ready for supervisor review" : phase === "stopped" ? "Executor stopped; inspect partial changes" : phase === "background" ? "Running in background; awaiting reconciliation" : phase === "uncertain" ? "Outcome uncertain; inspect before retrying" : "Executor failed";
				state.updatedAt = now();
				send();
			}
			return snapshot();
		},
	};
}
