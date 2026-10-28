import { existsSync } from "node:fs";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
	Api,
	Context,
	Model,
	Models,
	ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";

// Specifiers live in widened `string` constants: pi-durable is optional and not
// installed here — a literal specifier would fail typecheck module resolution,
// and every load must degrade to a clear runtime message instead of a crash.
const PKG_DURABLE: string = "@earendil-works/pi-durable";
const PKG_DURABLE_TOOLS: string = "@earendil-works/pi-durable/tools";
const PKG_DURABLE_ENV_NODE: string = "@earendil-works/pi-durable/env/node";
const PKG_DURABLE_SQLITE_NODE: string = "@earendil-works/pi-durable/storage/sqlite/node";
const PKG_CHORD_CONTEXT: string = "@earendil-works/chord/context";

const REQUEST_ID = "fusion-spike-1";
const DRAFT = {
	type: "input",
	content:
		"Use the bash tool to run exactly: sleep 45 && echo done > marker.txt . After it finishes, reply with the single word DONE.",
	requestId: REQUEST_ID,
} as const;

const dataDir = () => join(getAgentDir(), "fusion", "spike");
const storageFile = () => join(dataDir(), "durable.sqlite");
const sandboxDir = () => join(dataDir(), "work");
const markerFile = () => join(sandboxDir(), "marker.txt");

const errorText = (error: unknown): string =>
	error instanceof Error ? (error.stack ?? error.message) : String(error);

function reporting(ctx: ExtensionContext) {
	const file = join(dataDir(), "report.log");
	const write = async (line: string): Promise<void> => {
		try {
			await mkdir(dirname(file), { recursive: true });
			await appendFile(file, `${new Date().toISOString()} ${line}\n`);
		} catch {}
	};
	const log = async (line: string, type: "info" | "error" = "info"): Promise<void> => {
		await write(line);
		ctx.ui.notify(line, type);
	};
	return { file, write, log };
}

type ModelPick = { provider: string; modelId: string; source: string };

function pickModel(ctx: ExtensionContext): ModelPick | undefined {
	const provider = process.env.SPIKE_PROVIDER;
	const modelId = process.env.SPIKE_MODEL;
	if (provider && modelId) return { provider, modelId, source: "env" };
	if (ctx.model) return { provider: ctx.model.provider, modelId: ctx.model.id, source: "ctx.model" };
	return undefined;
}

type Backend = "runtime" | "registry";

async function buildModels(backend: Backend, ctx: ExtensionContext): Promise<Models> {
	if (backend === "registry") {
		const reg = ctx.modelRegistry;
		return {
			getModel: (provider: string, id: string) => reg.find(provider, id),
			streamSimple: (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) =>
				reg.streamSimple(model, context, options),
			completeSimple: (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) =>
				reg.streamSimple(model, context, options).result(),
			fetchDeferred: async () => {
				throw new Error("deferred unsupported by registry backend");
			},
			cancelDeferred: async () => {},
		} as unknown as Models;
	}
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const agentDir = getAgentDir();
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
}

// Module-level state so the session shutdown hook can close whatever `run` opened.
// `any`: pi-durable types are unavailable — the package is intentionally absent.
let ctx0: any;
let harness: any;
let eventStream: { stop(): Promise<unknown> } | undefined;

async function openSpike(backend: Backend, ctx: ExtensionContext) {
	const durable = await import(PKG_DURABLE).catch((error) => {
		throw new Error(`pi-durable not installed or failed to load: ${errorText(error)}`);
	});
	const [{ openNodeSqliteStorage }, { CodingTools }, { NodeExecutionEnv }, chord] = await Promise.all([
		import(PKG_DURABLE_SQLITE_NODE),
		import(PKG_DURABLE_TOOLS),
		import(PKG_DURABLE_ENV_NODE),
		import(PKG_CHORD_CONTEXT),
	]);
	ctx0 = chord.BACKGROUND_CONTEXT;
	await mkdir(sandboxDir(), { recursive: true });
	const storage = await openNodeSqliteStorage(storageFile());
	const registry = durable.createRegistry();
	registry.install(CodingTools);
	const env = ({ cwd }: { cwd?: string }) => new NodeExecutionEnv({ cwd: cwd ?? sandboxDir() });
	const models = await buildModels(backend, ctx);
	const h = await durable.Harness.open(storage, { models, registry, env }, ctx0);
	return { durable, h };
}

async function cmdCheck(backend: Backend, ctx: ExtensionContext, out: ReturnType<typeof reporting>) {
	const { log } = out;
	const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
	await log(`runtime: ${runtime}`);
	try {
		await import("node:sqlite");
		await log("node:sqlite: ok");
	} catch (error) {
		await log(`node:sqlite: failed: ${errorText(error)}`, "error");
	}
	let durable: any;
	try {
		durable = await import(PKG_DURABLE);
		await log("import @earendil-works/pi-durable: ok");
	} catch (error) {
		await log(`import @earendil-works/pi-durable: failed: ${errorText(error)}`, "error");
	}
	const require = createRequire(import.meta.url);
	for (const pkg of [
		"@earendil-works/pi-durable",
		"@earendil-works/pi-ai",
		"@earendil-works/chord",
		"@earendil-works/pi-coding-agent",
	]) {
		try {
			const pkgJson = require(require.resolve(`${pkg}/package.json`)) as { version?: string };
			await log(`${pkg}: ${pkgJson.version ?? "version unknown"}`);
		} catch {
			await log(`${pkg}: not resolvable`);
		}
	}
	const pick = pickModel(ctx);
	await log(
		pick
			? `model: ${pick.provider}/${pick.modelId} (source: ${pick.source})`
			: "model: none (set SPIKE_PROVIDER+SPIKE_MODEL or select a Pi model)",
		pick ? "info" : "error",
	);
	for (const kind of ["runtime", "registry"] as const) {
		try {
			const models = await buildModels(kind, ctx);
			const model = pick ? models.getModel(pick.provider, pick.modelId) : undefined;
			await log(`backend ${kind}: getModel ${model ? "found" : "not found"}`);
			if (model && kind === "runtime") {
				const auth = await models.getAuth(model);
				await log(`backend runtime: auth=${!!auth} source=${auth?.source ?? "none"}`);
			}
			if (model && kind === "registry") {
				await log(
					`backend registry: hasConfiguredAuth=${ctx.modelRegistry.hasConfiguredAuth(model)} isUsingOAuth=${ctx.modelRegistry.isUsingOAuth(model)}`,
				);
			}
		} catch (error) {
			await log(`backend ${kind}: failed: ${errorText(error)}`, "error");
		}
	}
	try {
		if (durable === undefined) throw new Error("pi-durable not installed");
		const { openNodeSqliteStorage } = await import(PKG_DURABLE_SQLITE_NODE);
		const { BACKGROUND_CONTEXT } = await import(PKG_CHORD_CONTEXT);
		const storage = await openNodeSqliteStorage(storageFile());
		const models = await buildModels(backend, ctx);
		const h = await durable.Harness.open(
			storage,
			{ models, registry: durable.createRegistry() },
			BACKGROUND_CONTEXT,
		);
		await h.close(BACKGROUND_CONTEXT);
		await log("sqlite storage + Harness.open/close: ok");
	} catch (error) {
		await log(`sqlite storage + Harness.open/close: failed: ${errorText(error)}`, "error");
	}
	await log(`check done; report: ${out.file}`);
}

function logEvent(write: (line: string) => Promise<void>, ctx?: ExtensionContext) {
	return async (events: readonly any[]) => {
		for (const event of events) {
			const type = event?.type as string | undefined;
			if (type === "tool_execution_start") {
				await write(`event tool_execution_start tool=${event.toolName}`);
				if (event.toolName === "bash") {
					ctx?.ui.notify("bash is running now: KILL PI HARD (kill -9 or close the terminal).", "warning");
				}
			} else if (type === "tool_execution_end") {
				await write(`event tool_execution_end tool=${event.toolName}`);
			} else if (type === "message_end") {
				await write("event message_end");
			} else if (type !== undefined && (type.includes("error") || type.includes("fail"))) {
				await write(`event ${type} ${JSON.stringify(event).slice(0, 300)}`);
			}
		}
	};
}

async function cmdRun(backend: Backend, ctx: ExtensionContext, out: ReturnType<typeof reporting>) {
	const { write, log } = out;
	const pick = pickModel(ctx);
	if (!pick) throw new Error("no model: set SPIKE_PROVIDER+SPIKE_MODEL or select a Pi model");
	const { durable, h } = await openSpike(backend, ctx);
	harness = h;
	await rm(markerFile(), { force: true });
	const root = await h.root(ctx0, {
		agent: { model: { provider: pick.provider, modelId: pick.modelId }, cwd: sandboxDir() },
	});
	const stream = await durable.watchEvents(h, root.id, ctx0);
	eventStream = stream;
	stream.start(logEvent(write, ctx));
	const submission = await root.submit(DRAFT, ctx0);
	await log(`model ${pick.provider}/${pick.modelId} (${pick.source}), backend ${backend}`);
	await log(`submitted id=${submission.id} requestId=${REQUEST_ID}`);
	await log(
		"Spike run started. When the bash warning appears, kill this Pi process hard (close the terminal or kill -9). Then restart pi with the same --extension and run /durable-spike resume.",
	);
	void submission.wait(ctx0).then(
		async (settled: { status: string }) => {
			await log(`submission settled: status=${settled.status}`);
			await log(`run finished without kill; report: ${out.file}`);
		},
		async (error: unknown) => log(`submission wait failed: ${errorText(error)}`, "error"),
	);
}

async function cmdResume(backend: Backend, ctx: ExtensionContext, out: ReturnType<typeof reporting>) {
	const { write, log } = out;
	const pick = pickModel(ctx);
	if (!pick) throw new Error("no model: set SPIKE_PROVIDER+SPIKE_MODEL or select a Pi model");
	const { h } = await openSpike(backend, ctx);
	harness = h;
	h.resume();
	const root = await h.root(ctx0);
	const submission = await root.submit(DRAFT, ctx0);
	await log(`re-submitted id=${submission.id} requestId=${REQUEST_ID} (exactly-once: must match original)`);
	const settled = await submission.wait(ctx0);
	await log(`resumed submission settled: status=${settled.status}`);
	const page = await root.entries({}, 200, undefined, ctx0);
	await write(`transcript entries: ${page.items.length}`);
	for (const entry of page.items) {
		await write(`entry kind=${entry.kind} model=${JSON.stringify(entry.model).slice(0, 300)}`);
	}
	const marker = existsSync(markerFile());
	await log(`marker.txt exists in sandbox: ${marker}`);
	const usage = await h.usage(ctx0);
	await write(`usage: ${JSON.stringify(usage)}`);
	await h.close(ctx0);
	harness = undefined;
	await log(`resume done; transcript + usage in ${out.file}`);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("durable-spike", {
		description: "pi-durable crash-resume spike: /durable-spike check|run|resume [runtime|registry]",
		handler: async (args, ctx) => {
			const [sub = "", backendArg = "runtime"] = args.trim().split(/\s+/);
			const backend: Backend = backendArg === "registry" ? "registry" : "runtime";
			const out = reporting(ctx);
			try {
				if (sub === "check") await cmdCheck(backend, ctx, out);
				else if (sub === "run") await cmdRun(backend, ctx, out);
				else if (sub === "resume") await cmdResume(backend, ctx, out);
				else ctx.ui.notify("usage: /durable-spike check|run|resume [runtime|registry]", "error");
			} catch (error) {
				await out.write(`FATAL ${errorText(error)}`);
				ctx.ui.notify(
					`durable-spike ${sub || "?"} failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("session_shutdown", () => {
		void eventStream?.stop().catch(() => {});
		eventStream = undefined;
		const h = harness;
		harness = undefined;
		if (h !== undefined && ctx0 !== undefined) {
			void Promise.resolve(h.close(ctx0)).catch(() => {});
		}
	});
}
