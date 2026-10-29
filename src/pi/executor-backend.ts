import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { EXECUTOR_SYSTEM_PROMPT, SCOUT_SYSTEM_PROMPT } from "../prompts.ts";
import { aggregateUsage } from "../usage.ts";
import type { ExecutorEvent, WorkerCapabilities } from "../core/worker.ts";
export type { ExecutorEvent } from "../core/worker.ts";

export interface ExecutorConfig {
	cwd: string;
	model: Model<Api>;
	thinking: ThinkingLevel;
}

export interface ExecutorTurnResult {
	text: string;
	stopReason?: string;
	errorMessage?: string;
	usage: Usage;
}

export interface ExecutorPromptOptions {
	requestId: string;
	signal?: AbortSignal;
	onEvent: (event: ExecutorEvent) => void;
}

export interface ExecutorResumeOptions {
	/** Original request identity; never create a new submission when resuming. */
	requestId?: string;
	signal?: AbortSignal;
	onEvent: (event: ExecutorEvent) => void;
}

export interface ExecutorHandle {
	readonly model: Model<Api>;
	readonly thinking: ThinkingLevel;
	resumeRef(): string | undefined;
	prompt(text: string, options: ExecutorPromptOptions): Promise<ExecutorTurnResult>;
	resume(options: ExecutorResumeOptions): Promise<ExecutorTurnResult>;
	abort(): Promise<void>;
	setThinking(level: ThinkingLevel): Promise<void>;
	dispose(): void;
}

export interface ScoutRequest extends ExecutorConfig {
	prompt: string;
	maxToolCalls: number;
	signal?: AbortSignal;
	onEvent: (event: ExecutorEvent) => void;
}

export interface ScoutResult extends ExecutorTurnResult {
	capped: boolean;
}

export interface ExecutorBackend {
	readonly kind: "session" | "durable";
	readonly capabilities: WorkerCapabilities;
	createExecutor(config: ExecutorConfig): Promise<ExecutorHandle>;
	openExecutor(config: ExecutorConfig, ref: string): Promise<ExecutorHandle>;
	scout(request: ScoutRequest): Promise<ScoutResult>;
	dispose(): Promise<void>;
}

export function lastAssistantOutputFromMessages(messages: readonly Message[]): {
	text: string;
	stopReason?: string;
	errorMessage?: string;
} {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return { text, stopReason: message.stopReason, errorMessage: message.errorMessage };
	}
	return { text: "" };
}

export function lastAssistantOutput(session: AgentSession): {
	text: string;
	stopReason?: string;
	errorMessage?: string;
} {
	return lastAssistantOutputFromMessages(session.messages as readonly Message[]);
}

export function mapSessionEvent(event: AgentSessionEvent): ExecutorEvent {
	if (event.type === "message_update") {
		const streamEvent = event.assistantMessageEvent;
		if (streamEvent.type === "thinking_start") return { type: "reasoning_start" };
		if (streamEvent.type === "thinking_delta")
			return { type: "reasoning_delta", delta: streamEvent.delta };
		if (streamEvent.type === "text_start") return { type: "text_start" };
		if (streamEvent.type === "text_delta") return { type: "text_delta", delta: streamEvent.delta };
		if (streamEvent.type === "text_end") return { type: "text_end", content: streamEvent.content };
		return { type: "other" };
	}
	if (event.type === "message_end") return { type: "message_end" };
	if (event.type === "tool_execution_start") {
		return {
			type: "tool_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		};
	}
	if (event.type === "tool_execution_update") {
		return { type: "tool_update", toolCallId: event.toolCallId, partialResult: event.partialResult };
	}
	if (event.type === "tool_execution_end") {
		return {
			type: "tool_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			isError: event.isError,
			result: event.result,
		};
	}
	return { type: "other" };
}

export function createSessionExecutorBackend(): ExecutorBackend {
	const executorResourceLoaders = new Map<string, DefaultResourceLoader>();
	const scoutResourceLoaders = new Map<string, DefaultResourceLoader>();

	async function cachedResourceLoader(
		cache: Map<string, DefaultResourceLoader>,
		cwd: string,
		systemPrompt: string,
	): Promise<DefaultResourceLoader> {
		const cached = cache.get(cwd);
		if (cached) return cached;
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noPromptTemplates: true,
			appendSystemPrompt: [systemPrompt],
		});
		await loader.reload();
		cache.set(cwd, loader);
		return loader;
	}

	function wrapSession(session: AgentSession, config: ExecutorConfig): ExecutorHandle {
		let current = config.thinking;
		return {
			model: config.model,
			thinking: config.thinking,
			resumeRef: () => session.sessionManager.getSessionFile(),
			async prompt(text: string, options: ExecutorPromptOptions): Promise<ExecutorTurnResult> {
				const messageStart = session.messages.length;
				const unsubscribe = session.subscribe((event) => {
					options.onEvent(mapSessionEvent(event));
				});
				const abortExecutor = (): void => {
					void session.abort();
				};
				options.signal?.addEventListener("abort", abortExecutor, { once: true });
				try {
					await session.prompt(text, { source: "extension" });
				} finally {
					options.signal?.removeEventListener("abort", abortExecutor);
					unsubscribe();
				}
				return {
					...lastAssistantOutput(session),
					usage: aggregateUsage(session.messages.slice(messageStart)),
				};
			},
			resume: async (): Promise<ExecutorTurnResult> => {
				throw new Error(
					"Resuming an interrupted turn is only supported by the durable backend.",
				);
			},
			abort: () => session.abort(),
			async setThinking(level: ThinkingLevel): Promise<void> {
				if (level !== current) {
					session.setThinkingLevel(level);
					current = level;
				}
			},
			dispose: () => session.dispose(),
		};
	}

	return {
		kind: "session",
		capabilities: PI_SESSION_CAPABILITIES,
		async createExecutor(config: ExecutorConfig): Promise<ExecutorHandle> {
			const resourceLoader = await cachedResourceLoader(
				executorResourceLoaders,
				config.cwd,
				EXECUTOR_SYSTEM_PROMPT,
			);
			const { session } = await createAgentSession({
				cwd: config.cwd,
				agentDir: getAgentDir(),
				model: config.model,
				thinkingLevel: config.thinking,
				resourceLoader,
				sessionManager: SessionManager.create(
					config.cwd,
					join(getAgentDir(), "fusion", "sessions"),
				),
			});
			return wrapSession(session, config);
		},
		async openExecutor(config: ExecutorConfig, ref: string): Promise<ExecutorHandle> {
			const resourceLoader = await cachedResourceLoader(
				executorResourceLoaders,
				config.cwd,
				EXECUTOR_SYSTEM_PROMPT,
			);
			const { session } = await createAgentSession({
				cwd: config.cwd,
				agentDir: getAgentDir(),
				model: config.model,
				thinkingLevel: config.thinking,
				resourceLoader,
				sessionManager: SessionManager.open(ref),
			});
			return wrapSession(session, config);
		},
		async scout(request: ScoutRequest): Promise<ScoutResult> {
			const resourceLoader = await cachedResourceLoader(
				scoutResourceLoaders,
				request.cwd,
				SCOUT_SYSTEM_PROMPT,
			);
			const { session } = await createAgentSession({
				cwd: request.cwd,
				agentDir: getAgentDir(),
				model: request.model,
				thinkingLevel: request.thinking,
				resourceLoader,
				sessionManager: SessionManager.inMemory(request.cwd),
				tools: ["read", "grep", "find", "ls"],
			});
			try {
				if (request.signal?.aborted) {
					await session.abort();
					throw new Error("Fusion scout aborted.");
				}
				const abortScout = (): void => {
					void session.abort();
				};
				request.signal?.addEventListener("abort", abortScout, { once: true });
				const messageStart = session.messages.length;
				let toolCalls = 0;
				let capped = false;
				const unsubscribe = session.subscribe((event) => {
					const mapped = mapSessionEvent(event);
					if (mapped.type === "tool_start") {
						toolCalls += 1;
						if (toolCalls > request.maxToolCalls && !capped) {
							capped = true;
							void session.abort();
						}
					}
					request.onEvent(mapped);
				});
				try {
					await session.prompt(request.prompt, { source: "extension" });
				} finally {
					request.signal?.removeEventListener("abort", abortScout);
					unsubscribe();
				}
				return {
					...lastAssistantOutput(session),
					usage: aggregateUsage(session.messages.slice(messageStart)),
					capped,
				};
			} finally {
				try {
					session.dispose();
				} catch {}
			}
		},
		async dispose(): Promise<void> {},
	};
}

export const PI_SESSION_CAPABILITIES: Readonly<WorkerCapabilities> = Object.freeze({
	transcriptReopen: true,
	activeTurnReattach: false,
	durableExecution: false,
	idempotentSubmission: false,
	workerAbort: true,
	readOnlyScout: true,
	exactScoutToolLimit: false,
});
