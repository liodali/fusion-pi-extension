export interface StaleInspection {
	submissions: readonly { id: number; conversationId: number }[];
	tasks: readonly { record: { id: number; conversationId: number } }[];
}

export function staleWork(
	inspection: StaleInspection,
	keep: ReadonlySet<number>,
): { submissions: number[]; tasks: number[] } {
	return {
		submissions: inspection.submissions
			.filter((submission) => !keep.has(submission.conversationId))
			.map((submission) => submission.id),
		tasks: inspection.tasks
			.filter((task) => !keep.has(task.record.conversationId))
			.map((task) => task.record.id),
	};
}

export function pendingSubmission(
	inspection: Pick<StaleInspection, "submissions">,
	conversationId: number,
): number | undefined {
	let latest: number | undefined;
	for (const submission of inspection.submissions) {
		if (
			submission.conversationId === conversationId &&
			(latest === undefined || submission.id > latest)
		) {
			latest = submission.id;
		}
	}
	return latest;
}
