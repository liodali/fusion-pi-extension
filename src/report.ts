export const REPORT_SUMMARY_MAX_CHARS = 300;
export const REPORT_PROSE_MAX_CHARS = 1500;

export interface ExecutorReport {
	status: "done" | "partial" | "blocked" | "unknown";
	summary: string;
	files_changed: { path: string; change: string }[];
	checks: { command: string; result: "pass" | "fail"; note?: string }[];
	blockers: string[];
}

function unknownReport(text: string): ExecutorReport {
	const trimmed = text.trim();
	return {
		status: "unknown",
		summary:
			trimmed.length <= REPORT_SUMMARY_MAX_CHARS
				? trimmed
				: `${trimmed.slice(0, REPORT_SUMMARY_MAX_CHARS - 1)}…`,
		files_changed: [],
		checks: [],
		blockers: [],
	};
}

function normalizeReport(value: Record<string, unknown>): ExecutorReport {
	const files = Array.isArray(value.files_changed) ? value.files_changed : [];
	const checks = Array.isArray(value.checks) ? value.checks : [];
	const blockers = Array.isArray(value.blockers) ? value.blockers : [];
	return {
		status:
			value.status === "done" || value.status === "partial" || value.status === "blocked"
				? value.status
				: "unknown",
		summary: typeof value.summary === "string" ? value.summary.trim() : "",
		files_changed: files.flatMap((file) => {
			if (!file || typeof file !== "object") return [];
			const record = file as Record<string, unknown>;
			if (typeof record.path !== "string" || typeof record.change !== "string") return [];
			return [{ path: record.path, change: record.change }];
		}),
		checks: checks.flatMap((check) => {
			if (!check || typeof check !== "object") return [];
			const record = check as Record<string, unknown>;
			if (
				typeof record.command !== "string" ||
				(record.result !== "pass" && record.result !== "fail")
			) {
				return [];
			}
			return [
				{
					command: record.command,
					result: record.result,
					...(typeof record.note === "string" ? { note: record.note } : {}),
				},
			];
		}),
		blockers: blockers.filter((blocker): blocker is string => typeof blocker === "string"),
	};
}

export function parseExecutorReport(text: string): { report: ExecutorReport; prose: string } {
	let blockStart = -1;
	let blockEnd = -1;
	let blockBody = "";
	for (const match of text.matchAll(/```json\s*\r?\n?([\s\S]*?)```/g)) {
		blockStart = match.index;
		blockEnd = match.index + match[0].length;
		blockBody = match[1];
	}
	if (blockStart === -1) {
		return { report: unknownReport(text), prose: text.trim() };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(blockBody);
	} catch {
		return { report: unknownReport(text), prose: text.trim() };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { report: unknownReport(text), prose: text.trim() };
	}
	const prose = `${text.slice(0, blockStart)}${text.slice(blockEnd)}`.trim();
	return { report: normalizeReport(parsed as Record<string, unknown>), prose };
}

export function formatCompactReport(
	report: ExecutorReport,
	diffStat?: string,
	prose?: string,
): string {
	const lines: string[] = [`Status: ${report.status}`];
	if (report.summary.trim()) {
		lines.push(`Summary: ${report.summary.trim()}`);
	}
	if (report.files_changed.length > 0) {
		lines.push("Files:");
		for (const file of report.files_changed) {
			lines.push(`- ${file.path}: ${file.change}`);
		}
	}
	if (report.checks.length > 0) {
		lines.push("Checks:");
		for (const check of report.checks) {
			const note = check.note?.trim();
			lines.push(
				`- ${check.result === "pass" ? "PASS" : "FAIL"} ${check.command}${note ? ` (${note})` : ""}`,
			);
		}
	}
	if (report.blockers.length > 0) {
		lines.push("Blockers:");
		for (const blocker of report.blockers) {
			lines.push(`- ${blocker}`);
		}
	}
	const stat = diffStat?.trim() ?? "";
	if (stat) {
		lines.push("Diff stat:");
		lines.push(stat);
	}
	if (report.status === "unknown") {
		const fallback = prose?.trim() || report.summary;
		if (fallback) {
			lines.push("Executor report (unstructured):");
			lines.push(
				fallback.length <= REPORT_PROSE_MAX_CHARS
					? fallback
					: `${fallback.slice(0, REPORT_PROSE_MAX_CHARS - 1)}…`,
			);
		}
	}
	return lines.join("\n");
}
