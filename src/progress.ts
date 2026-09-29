export const MAX_PROGRESS_CHARS = 6000;
export const MAX_TOOL_RESULT_CHARS = 800;

export function truncateInline(value: string, max = 240): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

export function appendProgressEntry(
	entries: string[],
	entry: string,
	max = MAX_PROGRESS_CHARS,
): string[] {
	const trimmed = entry.trim();
	if (!trimmed) return entries;
	const next = [...entries, trimmed];
	while (next.length > 1 && next.join("\n\n").length > max) {
		next.shift();
	}
	const joined = next.join("\n\n");
	if (joined.length <= max) return next;
	return [`…${joined.slice(joined.length - (max - 1))}`];
}

export function formatProgressTranscript(entries: string[], liveText?: string): string {
	const parts = entries.length > 0 ? entries.join("\n\n") : "";
	const live = liveText?.trim() ?? "";
	const combined = parts && live ? `${parts}\n\n${live}` : parts || live;
	if (combined.length <= MAX_PROGRESS_CHARS) return combined;
	return `…${combined.slice(combined.length - (MAX_PROGRESS_CHARS - 1))}`;
}

export function summarizeToolResult(result: unknown, max = MAX_TOOL_RESULT_CHARS): string | undefined {
	let text: string | undefined;
	if (typeof result === "string") {
		text = result;
	} else if (result && typeof result === "object") {
		const record = result as { content?: unknown; text?: unknown };
		if (Array.isArray(record.content)) {
			text = record.content
				.filter(
					(part): part is { type: string; text: string } =>
						typeof part === "object" &&
						part !== null &&
						(part as { type?: unknown }).type === "text" &&
						typeof (part as { text?: unknown }).text === "string",
				)
				.map((part) => part.text)
				.join("\n");
		}
		if (!text && typeof record.text === "string") {
			text = record.text;
		}
	}
	const trimmed = text?.trim() ?? "";
	if (!trimmed) return undefined;
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
