import { MAX_SCOUT_TOOL_CALLS, SCOUT_ANSWER_MAX_CHARS } from "../limits.ts";
import type { WorkerUsage } from "./worker.ts";

export { MAX_SCOUT_TOOL_CALLS };

/**
 * The shared scout tool-call window: the first `max` attempts run, the next
 * three are refused, and beyond that the caller should stop the scout. The
 * count includes refused attempts, so a model that keeps calling is bounded.
 */
export function scoutCapDecision(count: number, max: number): "allow" | "refuse" | "terminate" {
	if (count <= max) return "allow";
	if (count <= max + 3) return "refuse";
	return "terminate";
}

/** Missing accounting fields mean unknown, not zero (see WorkerUsage). */
export function formatWorkerUsageSummary(usage: WorkerUsage | undefined): string {
	if (!usage) return "unknown";
	const tokens = (value: number | undefined): string =>
		typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "unknown";
	const cache = usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined
		? usage.cacheReadTokens + usage.cacheWriteTokens
		: undefined;
	const reasoning = usage.reasoningTokens !== undefined ? ` | reasoning ${tokens(usage.reasoningTokens)}` : "";
	return `in ${tokens(usage.inputTokens)} | out ${tokens(usage.outputTokens)}${reasoning} | cache ${tokens(cache)} | $${
		usage.cost !== undefined && Number.isFinite(usage.cost) ? usage.cost.toFixed(4) : "unknown"
	}`;
}

export interface ScoutResponseInput {
	status: "completed" | "error" | "cancelled";
	text: string;
	errorMessage?: string;
	/** True when the scout hit its tool-call cap and returned a partial answer. */
	capped: boolean;
	usage?: WorkerUsage;
}

/**
 * Shared scout tool-response policy used by both harnesses: capping, answer
 * truncation, terminal-status reporting, and the usage line. Rendering beyond
 * this text (transcripts, details, colors) stays in the adapters.
 */
export function formatScoutResponse(input: ScoutResponseInput): { text: string; error?: string } {
	const usageLine = `Scout usage: ${formatWorkerUsageSummary(input.usage)}`;
	if (input.capped) {
		const partial = input.text.trim();
		const body = partial.length <= SCOUT_ANSWER_MAX_CHARS ? partial : `${partial.slice(0, SCOUT_ANSWER_MAX_CHARS - 1)}…`;
		return { text: `Scout stopped after ${MAX_SCOUT_TOOL_CALLS} tool calls; partial answer:\n${body}\n\n${usageLine}` };
	}
	if (input.status === "error" || input.status === "cancelled") {
		const reason = input.errorMessage ? `: ${input.errorMessage}` : "";
		return {
			text: `Fusion scout stopped with status "${input.status}"${reason}.\n\n${usageLine}`,
			error: input.errorMessage ?? input.status,
		};
	}
	const answer = (input.text || "The scout returned no answer.").trim();
	const truncated = answer.length <= SCOUT_ANSWER_MAX_CHARS ? answer : `${answer.slice(0, SCOUT_ANSWER_MAX_CHARS - 1)}…`;
	return { text: `${truncated}\n\n${usageLine}` };
}
