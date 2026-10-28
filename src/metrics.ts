import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { formatDuration } from "./progress.ts";
import type { FusionRun } from "./runs.ts";

export type DelegationAction = "execute" | "revise" | "final_fix" | "resume";

export interface DelegationMetric {
	action: DelegationAction;
	size: "small" | "standard";
	briefChars: number;
	thinking: ThinkingLevel;
	totalMs: number;
	firstEventMs?: number;
	reasoningChars: number;
	toolCalls: number;
	editCalls: number;
	stopReason?: string;
	reportStatus?: string;
	usage: Usage;
}

export interface FusionRunMetrics {
	backend: "session" | "durable";
	startedAt: string;
	finishedAt?: string;
	delegations: DelegationMetric[];
	supervisorUsage: Usage;
	scout: {
		calls: number;
		ms: number;
		usage: Usage;
	};
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

export function formatRunStats(runs: readonly FusionRun[], limit: number): string {
	const measured = runs.filter((run) => run.metrics !== undefined).slice(0, Math.max(0, limit));
	if (measured.length === 0) {
		return "No Fusion runs with metrics for this directory yet.";
	}
	const lines: string[] = [`Fusion run stats (${measured.length} run${measured.length === 1 ? "" : "s"}):`];
	const walls: number[] = [];
	const smallWalls: number[] = [];
	const standardWalls: number[] = [];
	let executorTotal = 0;
	let supervisorTotal = 0;
	let revisionsTotal = 0;
	let costTotal = 0;
	for (const run of measured) {
		const metrics = run.metrics as NonNullable<FusionRun["metrics"]>;
		const first = metrics.delegations[0];
		const execute = metrics.delegations.find((delegation) => delegation.action === "execute") ?? first;
		const wall = Math.max(
			0,
			Date.parse(metrics.finishedAt ?? run.updatedAt) - Date.parse(metrics.startedAt),
		);
		const executorMs = metrics.delegations.reduce((sum, delegation) => sum + delegation.totalMs, 0);
		const revisions = metrics.delegations.filter((delegation) => delegation.action === "revise").length;
		const supervisorMs = Math.max(0, wall - executorMs - metrics.scout.ms);
		const cost =
			metrics.delegations.reduce((sum, delegation) => sum + delegation.usage.cost.total, 0) +
			metrics.supervisorUsage.cost.total +
			metrics.scout.usage.cost.total;
		walls.push(wall);
		if (first?.size === "small") {
			smallWalls.push(wall);
		} else {
			standardWalls.push(wall);
		}
		executorTotal += executorMs;
		supervisorTotal += supervisorMs;
		revisionsTotal += revisions;
		costTotal += cost;
		const when = metrics.startedAt.slice(0, 16).replace("T", " ");
		const size = first?.size ?? "standard";
		const scoutText = `${metrics.scout.calls} call${metrics.scout.calls === 1 ? "" : "s"} ${formatDuration(metrics.scout.ms)}`;
		lines.push(
			`- ${when} ${run.status} ${size} | wall ${formatDuration(wall)} | executor ${formatDuration(executorMs)} (${metrics.delegations.length} delegation${metrics.delegations.length === 1 ? "" : "s"}, ${revisions} revision${revisions === 1 ? "" : "s"}) | scout ${scoutText} | supervisor+review ${formatDuration(supervisorMs)} | brief ${execute?.briefChars ?? 0} chars | $${cost.toFixed(2)}`,
		);
	}
	const wallTotal = walls.reduce((sum, wall) => sum + wall, 0);
	const medianParts = [`median wall ${formatDuration(median(walls))}`];
	if (smallWalls.length > 0) {
		medianParts.push(`small ${formatDuration(median(smallWalls))}`);
	}
	if (standardWalls.length > 0) {
		medianParts.push(`standard ${formatDuration(median(standardWalls))}`);
	}
	const executorShare = wallTotal > 0 ? Math.round((executorTotal / wallTotal) * 100) : 0;
	const supervisorShare = wallTotal > 0 ? Math.round((supervisorTotal / wallTotal) * 100) : 0;
	lines.push(
		`Totals: ${measured.length} run${measured.length === 1 ? "" : "s"} | ${medianParts.join(" | ")}`,
	);
	lines.push(
		`avg revisions ${(revisionsTotal / measured.length).toFixed(1)} | total cost $${costTotal.toFixed(2)} | executor ${executorShare}% of wall | supervisor+review ${supervisorShare}%`,
	);
	return lines.join("\n");
}
