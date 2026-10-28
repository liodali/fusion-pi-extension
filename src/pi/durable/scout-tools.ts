import type { Context } from "@earendil-works/chord";
import {
	defineDoc,
	defineExtension,
	defineTool,
	type Extension,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { findArgv, grepArgv, scoutCapDecision } from "./scout-args.ts";

export const scoutCallsDoc = defineDoc({
	kind: "fusion.scoutCalls",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ count: 0, max: 0 }),
});

const CAP_REFUSAL = "Tool call limit reached. Answer now with what you have.";
const NO_ENV = "No execution environment available for the durable scout.";

async function capCheck(
	api: ToolExecutionApi,
	context: Context,
): Promise<"allow" | "refuse" | "terminate"> {
	const { count, max } = await api.commit(async (tx) => {
		const doc = await tx.doc(scoutCallsDoc, api.conversationId);
		doc.count += 1;
		return { count: doc.count, max: doc.max };
	}, context);
	return scoutCapDecision(count, max);
}

async function withCap(
	api: ToolExecutionApi,
	context: Context,
	run: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
	const decision = await capCheck(api, context);
	if (decision === "allow") return run();
	return {
		content: [{ type: "text", text: CAP_REFUSAL }],
		isError: true,
		...(decision === "terminate" ? { control: { terminate: true as const } } : {}),
	};
}

const NO_MATCHES = "No matches.";

const grep = defineTool({
	name: "grep",
	description:
		"Search file contents with ripgrep. Returns matching lines with line numbers, at most 50 per file.",
	parameters: Type.Object({
		pattern: Type.String(),
		path: Type.Optional(Type.String()),
		glob: Type.Optional(Type.String()),
		ignoreCase: Type.Optional(Type.Boolean()),
	}),
	replay: "safe",
	outputLimits: { maxLines: 200, retain: "head" },
	execute(input, api, context) {
		return withCap(api, context, async () => {
			const env = api.env;
			if (!env) {
				return { content: [{ type: "text", text: NO_ENV }], isError: true };
			}
			const agent = await api.agent(context);
			const result = await env.exec(
				grepArgv(input),
				{ cwd: agent.cwd, onOutput: (text) => api.output(text) },
				context,
			);
			if (!result.ok) {
				const message =
					result.error.code === "spawn_error"
						? "ripgrep (rg) is required for the durable scout"
						: result.error.message;
				return { content: [{ type: "text", text: message }], isError: true };
			}
			if (result.value.exitCode === 1) {
				return { content: [{ type: "text", text: NO_MATCHES }] };
			}
			if (result.value.exitCode !== 0) {
				return {
					content: [{ type: "text", text: `rg exited with code ${result.value.exitCode}.` }],
					isError: true,
				};
			}
			return {};
		});
	},
});

const find = defineTool({
	name: "find",
	description: "List files whose paths match a glob pattern.",
	parameters: Type.Object({
		pattern: Type.String(),
		path: Type.Optional(Type.String()),
	}),
	replay: "safe",
	outputLimits: { maxLines: 200, retain: "head" },
	execute(input, api, context) {
		return withCap(api, context, async () => {
			const env = api.env;
			if (!env) {
				return { content: [{ type: "text", text: NO_ENV }], isError: true };
			}
			const agent = await api.agent(context);
			const result = await env.exec(
				findArgv(input),
				{ cwd: agent.cwd, onOutput: (text) => api.output(text) },
				context,
			);
			if (!result.ok) {
				const message =
					result.error.code === "spawn_error"
						? "ripgrep (rg) is required for the durable scout"
						: result.error.message;
				return { content: [{ type: "text", text: message }], isError: true };
			}
			if (result.value.exitCode === 1) {
				return { content: [{ type: "text", text: NO_MATCHES }] };
			}
			if (result.value.exitCode !== 0) {
				return {
					content: [{ type: "text", text: `rg exited with code ${result.value.exitCode}.` }],
					isError: true,
				};
			}
			return {};
		});
	},
});

const ls = defineTool({
	name: "ls",
	description: "List the entries of a directory. Directories end with a slash.",
	parameters: Type.Object({
		path: Type.Optional(Type.String()),
	}),
	replay: "safe",
	outputLimits: { maxLines: 500, retain: "head" },
	execute(input, api, context) {
		return withCap(api, context, async () => {
			const env = api.env;
			if (!env) {
				return { content: [{ type: "text", text: NO_ENV }], isError: true };
			}
			const result = await env.listDir(input.path ?? ".", context);
			if (!result.ok) {
				return { content: [{ type: "text", text: result.error.message }], isError: true };
			}
			const names = result.value
				.map((entry) => (entry.kind === "directory" ? `${entry.name}/` : entry.name))
				.sort()
				.slice(0, 500);
			api.output(names.join("\n"));
			return {};
		});
	},
});

const read = createReadTool();

export const scoutTools: Extension = defineExtension({
	name: "fusion-scout-tools",
	tools: [
		defineTool({
			...read,
			replay: "safe",
			execute: (args, api, context) => withCap(api, context, () => read.execute(args, api, context)),
		}),
		grep,
		find,
		ls,
	],
});
