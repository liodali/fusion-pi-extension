// Exercise the installed Durable SDK against a disposable SQLite database.
// The fixture records a completed turn directly; no model is invoked.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, UserEntry, AssistantEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createDurableExecutorBackend } from "../../src/pi/durable/backend.ts";

const root = process.env.PI_CODING_AGENT_DIR;
if (!root) throw new Error("Missing isolated Pi directory");
await mkdir(join(root, "fusion"), { recursive: true });
const storage = await openNodeSqliteStorage(join(root, "fusion/durable.sqlite"));
const harness = await Harness.open(storage, { models: {}, registry: createRegistry() }, BACKGROUND_CONTEXT);
const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
await conversation.commit(async (tx) => {
	const user = await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: "original", timestamp: 1 }] });
	const answer = await tx.appendEntry(AssistantEntry, conversation.id, { model: [{ role: "assistant", content: [{ type: "text", text: "exact result" }], stopReason: "stop", usage, api: "openai-completions", provider: "fake", model: "fake", timestamp: 2 }] });
	await tx.createSubmission({ conversationId: conversation.id, requestId: "exact-request", type: "input", status: "done", entry: user.id, answer: answer.id });
}, BACKGROUND_CONTEXT);
const id = String(conversation.id);
await harness.close(BACKGROUND_CONTEXT);

const backend = await createDurableExecutorBackend();
try {
	const handle = await backend.openExecutor({ cwd: root, model: { provider: "fake", id: "fake" }, thinking: "off" }, id);
	let rejected = false;
	try { await handle.resume({ requestId: "wrong", onEvent: () => {} }); }
	catch (error) { if (!String(error).includes("No matching executor submission")) throw error; rejected = true; }
	if (!rejected) throw new Error("Unmatched request was accepted");
	const result = await handle.resume({ requestId: "exact-request", onEvent: () => {} });
	if (result.text !== "exact result") throw new Error("Matched request did not return its recorded answer");
} finally { await backend.dispose(); }
