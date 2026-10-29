import type { WorkerCapabilities } from "../core/worker.ts";

/** Capabilities describe guarantees Fusion has verified at this boundary.
 * The static shape records the verified floor; the OpenCode runtime widens
 * `workerAbort` when the host exposes session interruption. */
export const OPENCODE_CAPABILITIES: Readonly<WorkerCapabilities> = Object.freeze({
	transcriptReopen: true,
	activeTurnReattach: false,
	durableExecution: false,
	idempotentSubmission: false,
	readOnlyScout: false,
	exactScoutToolLimit: false,
	workerAbort: false,
});

/** Narrow boundary around OpenCode v2's native `subagent` tool executor. */
export interface NativeSubagentInput {
	agent: string;
	description: string;
	prompt: string;
	model?: string;
	sessionID?: string;
	background?: boolean;
}

export interface NativeSubagentOutput {
	sessionID: string;
	status: "completed" | "running";
	output: string;
}

export interface NativeSubagentResult {
	output?: unknown;
	content?: unknown;
	metadata?: unknown;
}

export interface NativeToolContext {
	readonly sessionID: string;
	readonly signal: AbortSignal;
	readonly progress: (update: Record<string, unknown>) => Promise<void>;
}

export type NativeSubagentExecute<C extends NativeToolContext> = (
	input: NativeSubagentInput,
	context: C,
) => Promise<NativeSubagentResult>;

/**
 * One handle owns one child of one supervisor session. The native tool receives
 * the original tool context so that OpenCode retains its permission, progress,
 * parent ownership, job and cancellation behavior.
 */
export function createNativeExecutor<C extends NativeToolContext>(options: {
	parentSessionID: string;
	agent: string;
	model?: string;
	execute: NativeSubagentExecute<C>;
	childSessionID?: string;
	/** A previously submitted turn whose completion still needs proof. */
	pending?: boolean;
	/** Persist a newly discovered child before forwarding progress or settlement. */
	onReference?: (sessionID: string) => Promise<void>;
	/** Wait for the child to settle and return its final response. Must reject if settlement is unknown. */
	waitForBackground?: (sessionID: string, signal: AbortSignal) => Promise<string>;
}) {
	let childSessionID = options.childSessionID;
	let running = false;
	let backgroundPending = options.pending ?? false;
	let settling = false;
	let published = !!childSessionID;
	let publication: Promise<void> | undefined;
	async function publish(id: string): Promise<void> {
		if (published) return;
		publication ??= (async () => { await options.onReference?.(id); published = true; })();
		await publication;
	}

	async function settleBackground(
		context: C,
		waitForBackground = options.waitForBackground,
	): Promise<NativeSubagentOutput> {
		if (context.sessionID !== options.parentSessionID) throw new Error("Fusion executor belongs to a different supervisor session.");
		if (!backgroundPending) throw new Error("No background executor turn needs settlement.");
		if (settling) throw new Error("Fusion executor settlement is already in progress.");
		if (context.signal.aborted) throw new Error("Fusion executor settlement was cancelled.");
		if (!childSessionID || !waitForBackground) {
			throw new Error("Background executor requires a child session and a settlement handler before further delegation.");
		}
		settling = true;
		try {
			const output = await waitForBackground(childSessionID, context.signal);
			if (typeof output !== "string") throw new Error("OpenCode returned an invalid settled executor result.");
			backgroundPending = false;
			return { sessionID: childSessionID, status: "completed", output };
		} finally {
			settling = false;
		}
	}
	return {
		get childSessionID() { return childSessionID; },
		get backgroundPending() { return backgroundPending; },
		markReferencePublished() { if (childSessionID) { published = true; publication = undefined; } },
		markPending() { if (childSessionID) backgroundPending = true; },
		settleBackground,
		async prompt(prompt: string, description: string, context: C): Promise<NativeSubagentOutput> {
			if (context.sessionID !== options.parentSessionID) throw new Error("Fusion executor belongs to a different supervisor session.");
			if (running || backgroundPending) throw new Error("Fusion executor is already running or awaiting settlement.");
			if (context.signal.aborted) throw new Error("Fusion executor was cancelled.");
			if (!prompt.trim() || !description.trim()) throw new Error("Fusion executor requires a prompt and description.");
			running = true;
			try {
				const result = await options.execute({
					agent: options.agent,
					description,
					prompt,
					...(options.model ? { model: options.model } : {}),
					...(childSessionID ? { sessionID: childSessionID } : {}),
					background: false,
				}, {
					...context,
					progress: async (update: Record<string, unknown>) => {
						if (typeof update.sessionID === "string" && update.sessionID) {
							if (childSessionID && childSessionID !== update.sessionID) throw new Error("OpenCode returned a different executor session.");
							childSessionID = update.sessionID;
							await publish(childSessionID);
						}
						if (publication) await publication;
						await context.progress(update);
					},
				});
				const output = result.output;
				if (!output || typeof output !== "object") throw new Error("OpenCode returned an invalid subagent result.");
				const value = output as Record<string, unknown>;
				// OpenCode can background a foreground job. Block new prompts even if
				// the returned payload is malformed or waiting is interrupted.
				if (value.status === "running") backgroundPending = true;
				if (typeof value.sessionID !== "string" || !value.sessionID || (value.status !== "completed" && value.status !== "running") || typeof value.output !== "string") {
					throw new Error("OpenCode did not return a completed subagent result.");
				}
				if (childSessionID && childSessionID !== value.sessionID) throw new Error("OpenCode returned a different executor session.");
				childSessionID = value.sessionID;
				await publish(childSessionID);
				if (value.status === "running") return await settleBackground(context);
				return { sessionID: childSessionID, status: "completed", output: value.output };
			} finally {
				running = false;
			}
		},
	};
}
