import { canonicalWorkspace, openWorkspaceRegistry } from "./ownership.ts";

/** An operator must independently verify worker termination and review the tree. */
export async function resolveWorkspaceOwnership(input: { cwd: string; runId: string; requestId?: string; confirmStopped: boolean }, directory?: string): Promise<void> {
	if (!input.confirmStopped || !input.runId.trim()) throw new Error("Explicit confirmation and a run ID are required.");
	const workspace = await canonicalWorkspace(input.cwd);
	const registry = await openWorkspaceRegistry(directory);
	const owned = await registry.inspect(workspace);
	if (!owned) {
		const archived = await registry.archived(input.runId);
		if (archived?.owner.workspace === workspace && archived.operatorResolution && archived.operatorResolution.pending?.requestId === input.requestId) return;
		throw new Error("No matching Fusion workspace ownership exists.");
	}
	const record = owned.manifest;
	if (record.owner.workspace !== workspace || record.runId !== input.runId) throw new Error("Workspace or run ID does not match the owner.");
	const recordedRequest = record.pending?.requestId ?? record.operatorResolution?.pending?.requestId;
	if (recordedRequest !== input.requestId) throw new Error("Request ID does not match the retained intent.");
	if (record.recovery === "settled" && !record.operatorResolution) throw new Error("The run is already settled; use its normal cleanup control.");
	const lease = await registry.claim(record, owned.token);
	try {
		if (record.recovery !== "settled") {
			await lease.save({ ...record, recovery: "settled", pending: undefined,
				state: { ...record.state, runActive: false, delegating: false, resumePending: false, phase: "failed" },
				operatorResolution: { at: new Date().toISOString(), pending: record.pending } });
		}
		await lease.release();
	} finally { lease.close(); }
}

if (import.meta.main) {
	const [cwd, runId, request, confirmation, ...extra] = process.argv.slice(2);
	if (!cwd || !runId || !request || confirmation !== "--confirm-stopped" || extra.length) {
		console.error("Usage: bun src/workspace/resolve.ts <workspace> <run-id> <request-id|--no-request-id> --confirm-stopped");
		process.exitCode = 2;
	} else {
		try {
			await resolveWorkspaceOwnership({ cwd, runId, requestId: request === "--no-request-id" ? undefined : request, confirmStopped: true });
			console.log("Fusion ownership resolved. Review native transcripts and the working tree before further work.");
		} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
	}
}
