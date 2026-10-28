import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	AssistantEntry,
	type Conversation,
	type ConversationId,
	createRegistry,
	type Cursor,
	type EntryRecord,
	type Extension,
	Harness,
	type HarnessOptions,
	type SettledSubmissionRecord,
	type Submission,
	type SubmissionId,
	type TaskId,
	UserEntry,
	watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	type ExecutorBackend,
	type ExecutorConfig,
	type ExecutorEvent,
	type ExecutorHandle,
	type ExecutorResumeOptions,
	type ExecutorTurnResult,
	lastAssistantOutputFromMessages,
	type ScoutRequest,
	type ScoutResult,
} from "../../executor-backend.ts";
import { aggregateUsage, createEmptyUsage } from "../../usage.ts";
import { createFusionContext } from "./context.ts";
import { createDurableEventMapper } from "./events.ts";
import { scoutCallsDoc, scoutTools } from "./scout-tools.ts";
import { pendingSubmission, staleWork } from "./stale.ts";

async function collectAssistantMessages(
	conversation: Conversation,
	boundary: (entry: EntryRecord) => boolean,
): Promise<AssistantMessage[]> {
	const messages: AssistantMessage[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await conversation.entries({}, 50, cursor, BACKGROUND_CONTEXT);
		let reached = false;
		for (const entry of page.items) {
			if (boundary(entry)) {
				reached = true;
				break;
			}
			const message = AssistantEntry.is(entry) ? entry.model?.[0] : undefined;
			if (message !== undefined) {
				messages.push(message as unknown as AssistantMessage);
			}
		}
		if (reached || page.next === undefined) break;
		cursor = page.next;
	}
	messages.reverse();
	return messages;
}

export async function createDurableExecutorBackend(): Promise<ExecutorBackend> {
	const executorContext = createFusionContext("executor");
	const scoutContext = createFusionContext("scout");
	const executorExtensions: Extension[] = [
		CodingTools as unknown as Extension,
		executorContext.extension,
	];
	const scoutExtensions: Extension[] = [scoutTools, scoutContext.extension];
	const protectedConversations = new Set<number>();
	let harnessPromise: Promise<Harness> | undefined;
	const openHarness = (): Promise<Harness> => {
		harnessPromise ??= (async () => {
			const agentDir = getAgentDir();
			await mkdir(join(agentDir, "fusion"), { recursive: true });
			const storage = await openNodeSqliteStorage(join(agentDir, "fusion", "durable.sqlite"));
			const registry = createRegistry();
			registry.install(CodingTools as unknown as Extension);
			registry.install(executorContext.extension);
			registry.install(scoutContext.extension);
			registry.install(scoutTools);
			const models = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
			});
			return Harness.open(
				storage,
				{
					models: models as unknown as HarnessOptions["models"],
					registry,
					settings: { extensions: executorExtensions },
					env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
				},
				BACKGROUND_CONTEXT,
			);
		})().catch((error: unknown) => {
			harnessPromise = undefined;
			throw error;
		});
		return harnessPromise;
	};
	const discardStale = async (harness: Harness): Promise<void> => {
		const stale = staleWork(
			await harness.inspect(BACKGROUND_CONTEXT),
			protectedConversations,
		);
		for (const id of stale.submissions) {
			try {
				await harness.abortSubmission(id as SubmissionId, BACKGROUND_CONTEXT);
			} catch {}
		}
		for (const id of stale.tasks) {
			try {
				await harness.abortTask(id as TaskId, BACKGROUND_CONTEXT);
			} catch {}
		}
	};
	const settle = async (
		harness: Harness,
		conversation: Conversation,
		start: () => Promise<Submission>,
		options: { signal?: AbortSignal; onEvent?: (event: ExecutorEvent) => void },
	): Promise<ExecutorTurnResult> => {
		const { signal, onEvent } = options;
		const map = createDurableEventMapper();
		const stream = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
		stream.start(async (events) => {
			for (const event of events) {
				for (const mapped of map(event)) {
					try {
						onEvent?.(mapped);
					} catch {}
				}
			}
		});
		const abortExecutor = (): void => {
			void conversation.abort(BACKGROUND_CONTEXT);
		};
		signal?.addEventListener("abort", abortExecutor, { once: true });
		let record: SettledSubmissionRecord;
		try {
			record = await (await start()).wait(BACKGROUND_CONTEXT);
		} finally {
			signal?.removeEventListener("abort", abortExecutor);
			try {
				await stream.stop();
			} catch {}
		}
		const placed = record.entry;
		const messages =
			placed === undefined
				? []
				: await collectAssistantMessages(conversation, (entry) => entry.id === placed);
		const result: ExecutorTurnResult = {
			...lastAssistantOutputFromMessages(messages),
			usage: aggregateUsage(messages),
		};
		if (record.status === "unanswered") {
			if (result.stopReason !== "error" && result.stopReason !== "aborted") {
				result.stopReason = signal?.aborted ? "aborted" : "error";
			}
			result.errorMessage ??= record.reason;
		}
		return result;
	};
	const resumeTurn = async (
		harness: Harness,
		conversation: Conversation,
		options: ExecutorResumeOptions,
	): Promise<ExecutorTurnResult> => {
		const inspection = await harness.inspect(BACKGROUND_CONTEXT);
		const pending = pendingSubmission(inspection, conversation.id);
		if (pending !== undefined) {
			return settle(
				harness,
				conversation,
				async () => {
					const submission = await harness.submission(
						pending as SubmissionId,
						BACKGROUND_CONTEXT,
					);
					if (submission === undefined) {
						throw new Error("Interrupted executor submission not found.");
					}
					return submission;
				},
				options,
			);
		}
		const messages = await collectAssistantMessages(conversation, (entry) =>
			UserEntry.is(entry),
		);
		if (messages.length === 0) {
			return {
				text: "",
				stopReason: "error",
				errorMessage: "No executor output to resume.",
				usage: createEmptyUsage(),
			};
		}
		return {
			...lastAssistantOutputFromMessages(messages),
			usage: aggregateUsage(messages),
		};
	};
	const makeHandle = (
		harness: Harness,
		conversation: Conversation,
		config: ExecutorConfig,
	): ExecutorHandle => {
		let currentThinking = config.thinking;
		return {
			model: config.model,
			thinking: config.thinking,
			resumeRef: () => String(conversation.id),
			prompt: (text, options) =>
				settle(
					harness,
					conversation,
					async () => {
						protectedConversations.clear();
						protectedConversations.add(conversation.id);
						await discardStale(harness);
						return conversation.submit(
							{ type: "input", content: text, requestId: options.requestId },
							BACKGROUND_CONTEXT,
						);
					},
					options,
				),
			resume: (options) => resumeTurn(harness, conversation, options),
			abort: () => conversation.abort(BACKGROUND_CONTEXT),
			setThinking: async (level) => {
				if (level !== currentThinking) {
					await conversation.configure({ thinkingLevel: level }, BACKGROUND_CONTEXT);
					currentThinking = level;
				}
			},
			dispose: () => {},
		};
	};
	return {
		kind: "durable",
		async createExecutor(config: ExecutorConfig): Promise<ExecutorHandle> {
			const harness = await openHarness();
			const instructions = await executorContext.instructions(config.cwd);
			const conversation = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: {
						model: { provider: config.model.provider, modelId: config.model.id },
						thinkingLevel: config.thinking,
						cwd: config.cwd,
						instructions,
						extensions: executorExtensions,
					},
				},
				BACKGROUND_CONTEXT,
			);
			protectedConversations.add(conversation.id);
			return makeHandle(harness, conversation, config);
		},
		async openExecutor(config: ExecutorConfig, ref: string): Promise<ExecutorHandle> {
			const harness = await openHarness();
			const conversation = await harness.conversation(
				Number(ref) as ConversationId,
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) {
				throw new Error("Durable executor conversation not found.");
			}
			protectedConversations.clear();
			protectedConversations.add(conversation.id);
			await discardStale(harness);
			return makeHandle(harness, conversation, config);
		},
		async scout(request: ScoutRequest): Promise<ScoutResult> {
			const harness = await openHarness();
			const instructions = await scoutContext.instructions(request.cwd);
			const conversation = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: {
						model: { provider: request.model.provider, modelId: request.model.id },
						thinkingLevel: request.thinking,
						cwd: request.cwd,
						instructions,
						extensions: scoutExtensions,
					},
					init: async (tx, conversationId) => {
						const doc = await tx.doc(scoutCallsDoc, conversationId);
						doc.max = request.maxToolCalls;
					},
				},
				BACKGROUND_CONTEXT,
			);
			protectedConversations.add(conversation.id);
			try {
				await discardStale(harness);
				const result = await settle(
					harness,
					conversation,
					() =>
						conversation.submit(
							{
								type: "input",
								content: request.prompt,
								requestId: `scout:${randomUUID()}`,
							},
							BACKGROUND_CONTEXT,
						),
					request,
				);
				const doc = await harness.snapshot(
					scoutCallsDoc,
					conversation.id,
					BACKGROUND_CONTEXT,
				);
				return { ...result, capped: (doc?.count ?? 0) > request.maxToolCalls };
			} finally {
				protectedConversations.delete(conversation.id);
			}
		},
		async dispose(): Promise<void> {
			const pending = harnessPromise;
			harnessPromise = undefined;
			if (pending === undefined) return;
			try {
				await (await pending).close(BACKGROUND_CONTEXT);
			} catch {}
		},
	};
}
