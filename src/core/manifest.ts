import type { WorkerCapabilities, WorkerModelConfig, WorkerOwner, WorkerReference } from "./worker.ts";
import { isLifecycleState, type DelegationAction, type LifecycleState } from "./workflow.ts";
import { readRecoveryRecord } from "./recovery.ts";

export interface RunManifest {
	version: 2;
	runId: string;
	owner: WorkerOwner;
	state: LifecycleState;
	worker?: WorkerReference;
	model?: WorkerModelConfig;
	capabilities: WorkerCapabilities;
	/** Manual recovery represents interrupted legacy work without exact request proof. */
	recovery: "settled" | "pending" | "manual";
	pending?: { action: Exclude<DelegationAction, "resume">; requestId: string };
	lastResult?: { requestId: string; status: "completed" | "error" | "cancelled"; text?: string; evidence?: string[] };
	/** Audit of an explicit operator resolution; retained intent is not resubmittable. */
	operatorResolution?: { at: string; pending?: { action: Exclude<DelegationAction, "resume">; requestId: string } };
	/** Opaque adapter metadata retained for compatibility; never used as recovery proof. */
	adapterData?: Record<string, unknown>;
}

export interface ManifestScope { harness: string; workspace: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const capabilityKeys: (keyof WorkerCapabilities)[] = ["transcriptReopen", "activeTurnReattach", "durableExecution", "idempotentSubmission", "readOnlyScout", "exactScoutToolLimit", "workerAbort", "workerEvents"];

function ownerIs(value: unknown, scope: ManifestScope): value is WorkerOwner {
	return object(value) && nonempty(value.harness) && nonempty(value.workspace) && value.harness === scope.harness && value.workspace === scope.workspace && nonempty(value.supervisorId);
}

/** Validation never treats an unreadable or future record as an empty workspace. */
export function readRunManifest(value: unknown, scope: ManifestScope): RunManifest {
	if (!object(value) || value.version !== 2) throw new Error("Unsupported Fusion manifest version.");
	const { owner, worker, pending, lastResult, capabilities, model, operatorResolution } = value;
	if (!nonempty(value.runId) || !ownerIs(owner, scope) || !isLifecycleState(value.state) ||
		!object(capabilities) || capabilityKeys.some((key) => typeof capabilities[key] !== "boolean") ||
		!["settled", "pending", "manual"].includes(value.recovery as string) ||
		(value.recovery === "settled" && value.state.delegating) ||
		(value.adapterData !== undefined && !object(value.adapterData)) ||
		(value.recovery === "pending") !== (pending !== undefined) ||
		(pending !== undefined && (!object(pending) || !nonempty(pending.requestId) || !["execute", "revise", "final_fix"].includes(pending.action as string))) ||
		(worker !== undefined && (!object(worker) || !ownerIs(worker.owner, scope) || worker.owner.supervisorId !== owner.supervisorId || !nonempty(worker.runtime) || !nonempty(worker.id) ||
			(scope.harness === "pi" && worker.runtime !== "session" && worker.runtime !== "durable") ||
			(scope.harness === "opencode" && worker.runtime !== "native-subagent"))) ||
		(model !== undefined && (!object(model) || !nonempty(model.provider) || !nonempty(model.modelId) || (model.variant !== undefined && !nonempty(model.variant)))) ||
		(operatorResolution !== undefined && (!object(operatorResolution) || !nonempty(operatorResolution.at) || !Number.isFinite(Date.parse(operatorResolution.at)) ||
			(operatorResolution.pending !== undefined && (!object(operatorResolution.pending) || !nonempty(operatorResolution.pending.requestId) || !["execute", "revise", "final_fix"].includes(operatorResolution.pending.action as string))))) ||
		(lastResult !== undefined && (!object(lastResult) || !nonempty(lastResult.requestId) || !["completed", "error", "cancelled"].includes(lastResult.status as string) ||
			(lastResult.text !== undefined && typeof lastResult.text !== "string") || (lastResult.evidence !== undefined && (!Array.isArray(lastResult.evidence) || !lastResult.evidence.every(nonempty)))))) {
		throw new Error("Invalid Fusion run manifest; recovery remains blocked.");
	}
	return structuredClone(value) as unknown as RunManifest;
}

/** A v1 read is a pure translation: no writes, no new request identity, no submission. */
export function translateOpenCodeV1(value: unknown, workspace: string, capabilities: WorkerCapabilities): RunManifest {
	const old = readRecoveryRecord(value, workspace, "opencode");
	const owner: WorkerOwner = { harness: "opencode", supervisorId: old.parentSessionID, workspace };
	return readRunManifest({
		version: 2, runId: `opencode:${old.parentSessionID}`, owner,
		state: { ...old.state, delegating: false }, capabilities,
		worker: old.childSessionID ? { owner, runtime: "native-subagent", id: old.childSessionID } : undefined,
		recovery: old.pending ? "pending" : "settled",
		pending: old.pending ? { action: old.pending.action, requestId: old.pending.description } : undefined,
		adapterData: { legacyOpenCode: old },
	}, { harness: "opencode", workspace });
}

/** A transport is not an ownership lock or compare-and-swap guarantee. */
export interface ManifestTransport {
	read(): Promise<unknown>;
	write(manifest: RunManifest): Promise<void>;
	remove(): Promise<void>;
}

/** Inject native storage; legacy decoding is explicit and never writes on load. */
export function createManifestStore(transport: ManifestTransport, scope: ManifestScope, decodeLegacy?: (value: unknown) => RunManifest) {
	const savedScope = { ...scope };
	async function load(): Promise<RunManifest | undefined> {
		const raw = await transport.read();
		if (raw === undefined || raw === null) return undefined;
		if (object(raw) && raw.version === 2) return readRunManifest(raw, savedScope);
		if (!object(raw) || raw.version !== 1 || !decodeLegacy) throw new Error("Unsupported Fusion manifest version; recovery remains blocked.");
		return readRunManifest(decodeLegacy(structuredClone(raw)), savedScope);
	}
	return {
		load,
		async save(manifest: RunManifest): Promise<void> {
			await transport.write(readRunManifest(manifest, savedScope));
		},
		/** Caller must hold exclusive ownership across this check and removal. */
		async removeSettled(expectedRunId: string): Promise<void> {
			const current = await load();
			if (current && (current.runId !== expectedRunId || current.recovery !== "settled")) throw new Error("Cannot remove an unsettled or differently owned Fusion run.");
			await transport.remove();
		},
	};
}
