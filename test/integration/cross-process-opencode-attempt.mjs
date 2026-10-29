// Runs in its own Bun process. Loads the real OpenCode plugin entrypoint with a
// fake native subagent tool and a REAL canonical workspace resolver, then tries
// one delegation. Prints one JSON verdict line the parent asserts on.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import plugin from "../../src/opencode/index.ts";

const phase = process.argv[2] ?? "";
const workspacePath = process.argv[3];
const ownershipRoot = process.env.FUSION_OWNERSHIP_DIR;
if (!phase || !workspacePath) throw new Error("Usage: cross-process-opencode-attempt <phase> <directory>");
if (!ownershipRoot) throw new Error("Missing FUSION_OWNERSHIP_DIR");
const location = phase === "blocked-nested" ? join(workspacePath, "nested") : workspacePath;
await mkdir(location, { recursive: true });

const verdict = (value) => console.log(`RESULT ${JSON.stringify(value)}`);

const memoryStorage = () => {
	const values = new Map();
	return { get: async (key) => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)); }, remove: async (key) => { values.delete(key); } };
};

const tools = new Map();
const context = (sessionID) => ({ sessionID, agent: "fusion", signal: new AbortController().signal, progress: async () => {} });
let calls = 0;
const get = async ({ sessionID }) => ({ id: sessionID, parentID: sessionID.startsWith("child") ? "one" : undefined, location: { directory: location } });
const result = await plugin.setup({
	location: { directory: location },
	session: { context: async () => [], get, hook: async () => {} },
	storage: memoryStorage(),
	tool: {
		hook: async () => {},
		list: async () => [{ id: "subagent", execute: async () => { calls++; return { output: { sessionID: `child-${calls}`, status: "completed", output: "done" } }; } }],
		transform: async (callback) => { callback({ add: (tool) => tools.set(tool.name, tool) }); },
	},
}, { ownershipRoot });
result.close?.();
const delegate = tools.get("fusion_delegate");
try {
	const outcome = await delegate.execute({ action: "execute", brief: "build", originalTask: "build" }, context("one"));
	verdict({ phase, ok: true, content: outcome.content });
} catch (error) {
	verdict({ phase, ok: false, message: error instanceof Error ? error.message : String(error) });
}
