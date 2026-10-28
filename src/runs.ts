import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { FusionRunMetrics } from "./metrics.ts";

export type FusionRunStatus = "running" | "done" | "failed" | "interrupted";

export interface FusionRunExecutor {
	provider: string;
	modelId: string;
	label: string;
	thinking: ThinkingLevel;
}

export interface FusionRun {
	runId: string;
	cwd: string;
	task: string;
	brief: string;
	originalTask?: string;
	executor: FusionRunExecutor;
	sessionFile?: string;
	backend?: "session" | "durable";
	conversationId?: number;
	/** Write-ahead identity of the last unsettled executor submission. */
	pending?: { action: "execute" | "revise" | "final_fix"; requestId: string };
	manualResolution?: { at: string };
	metrics?: FusionRunMetrics;
	status: FusionRunStatus;
	revisions: number;
	finalFixUsed?: boolean;
	results: Record<string, string>;
	updatedAt: string;
}

export function runsDir(agentDir: string): string {
	return join(agentDir, "fusion", "runs");
}

export function newRunId(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${suffix}`;
}

function isFusionRun(value: unknown): value is FusionRun {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.runId === "string" &&
		typeof record.cwd === "string" &&
		typeof record.task === "string" &&
		typeof record.brief === "string" &&
		typeof record.status === "string" &&
		typeof record.updatedAt === "string"
	);
}

export async function writeRun(dir: string, run: FusionRun): Promise<void> {
	await mkdir(dir, { recursive: true });
	run.updatedAt = new Date().toISOString();
	const file = join(dir, `${run.runId}.json`);
	const tmp = `${file}.tmp`;
	await writeFile(tmp, `${JSON.stringify(run, null, "\t")}\n`);
	await rename(tmp, file);
}

export async function readRun(dir: string, id: string): Promise<FusionRun | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
		return isFusionRun(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function listRuns(dir: string, cwd: string): Promise<FusionRun[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const runs: FusionRun[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const parsed: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
			if (isFusionRun(parsed) && parsed.cwd === cwd) {
				runs.push(parsed);
			}
		} catch {}
	}
	runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return runs;
}

export async function markInterrupted(dir: string, cwd: string): Promise<FusionRun[]> {
	const changed: FusionRun[] = [];
	for (const run of await listRuns(dir, cwd)) {
		if (run.status !== "running") continue;
		run.status = "interrupted";
		await writeRun(dir, run);
		changed.push(run);
	}
	return changed;
}

export function delegationKey(action: string, brief: string, revision: number): string {
	return createHash("sha256").update(`${action}:${revision}\n${brief}`).digest("hex");
}
