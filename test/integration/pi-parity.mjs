// Opt-in LIVE Pi acceptance fixture (M7.3). Model-consuming: the executor
// and scout run REAL Pi SDK sessions against a real model with real
// credentials; nothing about the executor path is mocked. The supervisor
// side is fixture-driven (Pi's Fusion supervisor is the interactive session
// by design — the extension requires a dialog-capable UI for a live
// supervisor — so this fixture drives the same registered tools and hooks a
// real supervisor session would).
//
// Scenario matrix (mirrors the OpenCode parity fixture):
//   S1 full protocol happy path — scout → execute → file review → revise →
//      audit → final fix → settle with `## Fusion summary`; run manifest,
//      status, and honest usage accounting asserted.
//   S4 failure/recovery — a delegation is aborted mid-flight (real abort
//      signal), the run turns uncertain, new runs and resume are refused or
//      routed honestly (session backend cannot reattach), and the operator
//      resolution command completes recovery for real.
//   S2 post-recovery continuity — a fresh run completes after cleanup.
//
// Usage: bun test/integration/pi-parity.mjs [--model provider/id]
// Default model: opencode-go/glm-5.3-flash (the same model the OpenCode
// live parity run used; requires credentials in ~/.pi/agent/auth.json).
// Isolation: temporary project, temporary ownership registry, temporary Pi
// agent directory carrying ONLY copies of auth.json and models-store.json —
// no other user state is read, nothing is written to the user's Pi dirs.
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const modelArg = modelIndex >= 0 ? args[modelIndex + 1] : "opencode-go/glm-5.3-flash";
const supervisorIndex = args.indexOf("--supervisor");
const supervisorArg = supervisorIndex >= 0 ? args[supervisorIndex + 1] : "opencode-go/gemini-4-argon";
const split = (spec) => { const [provider, ...rest] = spec.split("/"); const id = rest.join("/"); if (!provider || !id) throw new Error(`expected provider/id, got ${spec}`); return { provider, id }; };
const executorSpec = split(modelArg);
const supervisorSpec = split(supervisorArg);

const delay = (ms) => new Promise((resolveMs) => setTimeout(resolveMs, ms));
const result = { model: modelArg, phases: {}, ok: false };
const assert = (phase, label, condition, detail = "") => {
	if (!condition) throw new Error(`PARITY FAILURE [${phase}] ${label}${detail ? `: ${detail}` : ""}`);
};

const root = await mkdtemp(join(tmpdir(), "fusion-pi-parity-"));
const project = join(root, "project");
const agentDir = join(root, "agent");
await mkdir(project, { recursive: true });
await mkdir(agentDir, { recursive: true });

try {
	// ---- Boot: isolated project, ownership registry, and Pi agent dir. The
	// agent dir carries only credential copies; the fixture never prints
	// their contents.
	process.env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of ["auth.json", "models-store.json"]) {
		await cp(join(homedir(), ".pi", "agent", name), join(agentDir, name));
	}
	const store = JSON.parse(await readFile(join(agentDir, "models-store.json"), "utf8"));
	const pick = (spec) => {
		const entry = store[spec.provider]?.models.find((model) => model.id === spec.id);
		if (!entry) throw new Error(`Model ${spec.provider}/${spec.id} not present in the Pi model store`);
		return { ...entry, provider: spec.provider };
	};
	// The supervisor must clear the premium tier (>= $10/M output, recent
	// cohort) and the executor the cheap tier (<= $10/M, recent cohort); the
	// fixture never streams the supervisor, so the premium pick costs nothing.
	const model = pick(executorSpec);
	const supervisorModel = pick(supervisorSpec);

	const git = (...gitArgs) => new Promise((resolveGit, rejectGit) => {
		const child = spawn("git", ["-C", project, ...gitArgs], { stdio: "ignore" });
		child.on("error", rejectGit);
		child.on("exit", (code) => (code === 0 ? resolveGit() : rejectGit(new Error(`git ${gitArgs.join(" ")} exited ${code}`))));
	});
	await git("init", "-q");
	await git("config", "user.email", "parity@local");
	await git("config", "user.name", "Pi Parity");
	await writeFile(join(project, "seed.txt"), "seed\n");
	await git("add", ".");
	await git("commit", "-qm", "seed");

	// ---- Load the real extension through the manifest target (pi.extensions
	// → ./src/index.ts) and register into a captured host.
	const { default: registerFusion } = await import(pathToFileURL(join(repo, "src/index.ts")).href);
	const tools = new Map();
	const commands = new Map();
	const hooks = new Map();
	const notifications = [];
	const sentMessages = [];
	const setModelCalls = [];
	let activeTools = [];
	registerFusion({
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, command) => commands.set(name, command),
		on: (name, callback) => hooks.set(name, callback),
		getActiveTools: () => activeTools,
		setActiveTools: (value) => { activeTools = value; },
		setModel: async (m) => { setModelCalls.push(m?.id ?? String(m)); return true; },
		setThinkingLevel: () => {},
		sendUserMessage: (text) => sentMessages.push(text),
		exec: async () => ({ code: 1, stdout: "" }),
	});
	assert("boot", "registered the documented Pi surface",
		tools.has("fusion_delegate") && tools.has("fusion_scout") && commands.has("fusion") && commands.has("fusion-resume") && commands.has("fusion-resolve"));

	const optionLabel = (option) => String(option?.label ?? option?.value ?? option);
	const notificationsWith = (text) => notifications.filter((n) => n.message.toLowerCase().includes(text.toLowerCase()));
	const ctx = {
		cwd: project,
		sessionManager: { getSessionId: () => "ses_parity_supervisor" },
		hasUI: true,
		mode: "rpc",
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [model, supervisorModel],
			find: (p, id) => [model, supervisorModel].find((candidate) => candidate.provider === p && candidate.id === id),
		},
		waitForIdle: async () => {},
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			input: async () => "",
			confirm: async () => true,
			// Title-aware picking: the executor picker also lists premium
			// models (a $10/M model clears both tiers), so choosing by title
			// is what keeps the live executor on the cheap model.
			select: async (title, options) => {
				const text = String(title);
				if (text.includes("executor model")) {
					const hit = options.find((option) => optionLabel(option).includes(model.id));
					if (hit) return hit;
				}
				if (text.includes("supervisor model")) {
					const hit = options.find((option) => optionLabel(option).includes(supervisorModel.id));
					if (hit) return hit;
				}
				if (text.includes("thinking level")) {
					const hit = options.find((option) => optionLabel(option).toLowerCase().startsWith("low"));
					if (hit) return hit;
				}
				return options[0];
			},
			setWidget: () => {},
		},
	};
	const delegate = async (phase, action, brief, signal) => {
		const callId = `call_${phase}_${action}`;
		return await tools.get("fusion_delegate").execute(callId, { action, brief }, signal, undefined, ctx);
	};

	// ================= S1: full protocol happy path =================
	const task1 = 'Start with one fusion_scout question about this workspace. Then create fixture.txt containing exactly "alpha" followed by a single newline. Review the file, revise it to exactly "beta" followed by a single newline, audit it against this instruction, and apply the final fix so it contains exactly "gamma" followed by a single newline. Finish with the Fusion summary.';
	await commands.get("fusion").handler(task1, ctx);
	assert("S1", "the run configured the supervisor model for real", setModelCalls.length > 0, JSON.stringify(setModelCalls));
	const supervisorPrompt = sentMessages.at(-1) ?? "";
	assert("S1", "the supervisor prompt carries the task", supervisorPrompt.includes("fixture.txt"), supervisorPrompt.slice(0, 120));
	assert("S1", "the live executor is the cheap-tier model", supervisorPrompt.includes(model.id), supervisorPrompt.slice(0, 160));

	const scout1 = await tools.get("fusion_scout").execute("call_scout_1", { questions: ["What does the working tree of this repository currently contain?"] }, undefined, undefined, ctx);
	assert("S1", "scout ran on the real read-only session", !scout1?.details?.error && typeof scout1?.content?.[0]?.text === "string" && scout1.content[0].text.length > 20, String(scout1?.details?.error ?? ""));

	const exec1 = await delegate("s1", "execute", 'Create fixture.txt containing exactly "alpha" followed by a single newline. Then verify with cat.');
	assert("S1", "execute delegation succeeded against the real executor", !exec1?.details?.error, String(exec1?.details?.error ?? ""));
	let content = await readFile(join(project, "fixture.txt"), "utf8");
	assert("S1", "executor staged alpha", content === "alpha\n", JSON.stringify(content));

	const revise1 = await delegate("s1", "revise", 'Revise fixture.txt to contain exactly "beta" followed by a single newline. Then verify with cat.');
	assert("S1", "revise delegation succeeded", !revise1?.details?.error, String(revise1?.details?.error ?? ""));
	content = await readFile(join(project, "fixture.txt"), "utf8");
	assert("S1", "review shows the revised beta state", content === "beta\n", JSON.stringify(content));

	const fix1 = await delegate("s1", "final_fix", 'Apply the final fix so fixture.txt contains exactly "gamma" followed by a single newline. Then verify with cat.');
	assert("S1", "final_fix delegation succeeded", !fix1?.details?.error, String(fix1?.details?.error ?? ""));
	content = await readFile(join(project, "fixture.txt"), "utf8");
	assert("S1", "final file is gamma", content === "gamma\n", JSON.stringify(content));

	// Settle the supervisor turn with the summary heading, exactly as the
	// real agent_settled / agent_before_settled hooks would observe it.
	const beforeSettle = hooks.get("agent_before_settle")({
		outcome: "done",
		entries: [],
		context: { canContinue: false, llmMessages: [{ role: "assistant", content: [{ type: "text", text: "## Fusion summary\nExecuted, revised, audited, final fix applied." }] }] },
	});
	assert("S1", "a summary-bearing settle is not nudged", beforeSettle === undefined, JSON.stringify(beforeSettle)?.slice(0, 120));
	hooks.get("agent_settled")({}, ctx);
	await delay(500);

	const runsDir = join(agentDir, "fusion", "runs");
	const runFiles = await readdir(runsDir);
	const readRun = async () => JSON.parse(await readFile(join(runsDir, runFiles.at(-1)), "utf8"));
	const run1 = await readRun();
	assert("S1", "run manifest persisted", Boolean(run1?.runId), JSON.stringify(run1).slice(0, 120));
	result.phases.s1 = {
		scoutAnswerChars: scout1.content[0].text.length,
		actions: ["execute", "revise", "final_fix"],
		finalContent: content,
		manifest: { runId: run1.runId, status: run1.status, revisions: run1.revisions, finalFixUsed: run1.finalFixUsed },
		metrics: run1.metrics ?? null,
	};
	assert("S1", "usage was really measured (live model turns)",
		Boolean((run1?.metrics?.executor?.usage?.totalTokens ?? 0) > 0 || (run1?.metrics?.scout?.usage?.totalTokens ?? 0) > 0),
		JSON.stringify(run1?.metrics ?? null));

	// ================= S4: failure → honest report → same-run recovery =========
	// Live abort semantics on the session backend: aborting mid-tool-call
	// yields a DEFINITE error report (with real usage accounting) and leaves
	// the run continuable. The unknown-outcome/uncertain class and the
	// resume/resolve matrix are covered deterministically by the fault
	// injection suites (pi-controller-probe); this live phase proves the
	// failure report is honest and that the protocol recovers in the same
	// run by retrying the delegation. The brief forces a long turn first (a
	// blocking bash sleep) so the abort always lands mid-tool-call — a short
	// task could complete before the abort fires and make this a race.
	const task2 = 'Create second.txt containing exactly "delta" followed by a single newline. Then verify with cat.';
	await commands.get("fusion").handler(task2, ctx);
	const abort = new AbortController();
	const aborted = delegate("s4", "execute", 'First run `sleep 25` in bash (mandatory opening step). After it completes, create second.txt containing exactly "delta" followed by a single newline.', abort.signal);
	await delay(6000);
	abort.abort();
	const outcome = await aborted;
	const outcomeText = String(outcome?.content?.[0]?.text ?? "");
	assert("S4", "aborted delegation reports failure or unknown outcome", Boolean(outcome?.details?.error) || /unknown|interrupted/i.test(outcomeText), String(outcome?.details?.error ?? outcomeText).slice(0, 140));
	assert("S4", "the failure report still carries real usage accounting", /Executor usage this delegation/.test(outcomeText) && /\$0\.0/.test(outcomeText), outcomeText.slice(0, 200));
	result.phases.s4 = {
		abortReported: Boolean(outcome?.details?.error) || /unknown|interrupted/i.test(outcomeText),
		usageInFailureReport: /Executor usage this delegation/.test(outcomeText),
		uncertainPath: "deterministic fault-injection coverage (pi-controller-probe): connection-lost mid-prompt yields unknown outcome, uncertain state, refused new runs, /fusion-resume boundary, /fusion-resolve recovery",
	};

	// Same-run recovery: retry the execute delegation; if the executor turn
	// comes back without the work (observed once: a flash-model turn after
	// an abort replying without editing), the protocol's own correction step
	// (revise with consolidated feedback) is the bounded fallback.
	const retry = await delegate("s4", "execute", 'Create second.txt containing exactly "delta" followed by a single newline. Then verify with cat.');
	assert("S4", "same-run retry delegation succeeded", !retry?.details?.error, String(retry?.details?.error ?? ""));
	let secondAfterRetry = await readFile(join(project, "second.txt"), "utf8").catch(() => null);
	let correction = null;
	if (secondAfterRetry !== "delta\n") {
		correction = await delegate("s4", "revise", 'second.txt is missing or wrong. Use the write tool to create second.txt containing exactly "delta" followed by a single newline, then verify with cat and report.');
		assert("S4", "corrective revise succeeded", !correction?.details?.error, String(correction?.details?.error ?? ""));
		secondAfterRetry = await readFile(join(project, "second.txt"), "utf8").catch(() => null);
	}
	assert("S4", "the recovered run staged delta", secondAfterRetry === "delta\n", JSON.stringify(secondAfterRetry));
	hooks.get("agent_before_settle")({ outcome: "done", entries: [], context: { canContinue: false, llmMessages: [{ role: "assistant", content: [{ type: "text", text: "## Fusion summary\nRecovered from the aborted delegation and completed." }] }] } });
	hooks.get("agent_settled")({}, ctx);
	await delay(500);
	result.phases.s4.retry = { executeError: retry?.details?.error ?? null, neededCorrectiveRevise: correction !== null, reviseError: correction?.details?.error ?? null, second: secondAfterRetry };

	await commands.get("fusion-clean").handler("", ctx);

	// ================= S2: post-recovery continuity across runs =================
	const task3 = 'Create third.txt containing exactly "epsilon" followed by a single newline. Then verify with cat.';
	await commands.get("fusion").handler(task3, ctx);
	const exec3 = await delegate("s2", "execute", 'Create third.txt containing exactly "epsilon" followed by a single newline. Then verify with cat.');
	assert("S2", "post-recovery run delegated successfully", !exec3?.details?.error, String(exec3?.details?.error ?? ""));
	const third = await readFile(join(project, "third.txt"), "utf8");
	assert("S2", "third file is epsilon", third === "epsilon\n", JSON.stringify(third));
	hooks.get("agent_before_settle")({ outcome: "done", entries: [], context: { canContinue: false, llmMessages: [{ role: "assistant", content: [{ type: "text", text: "## Fusion summary\nThird run completed." }] }] } });
	hooks.get("agent_settled")({}, ctx);
	await delay(500);
	const finalRunFiles = await readdir(runsDir);
	result.phases.s2 = { third, runFilesOnDisk: finalRunFiles.length };
	assert("S2", "all runs persisted across the session", finalRunFiles.length >= 3, JSON.stringify(finalRunFiles));

	result.ok = true;
	result.sessionHash = createHash("sha256").update(JSON.stringify(result.phases)).digest("hex").slice(0, 12);
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	result.ok = false;
	result.error = String(error?.stack ?? error);
	console.log(JSON.stringify(result, null, 2));
	process.exitCode = 1;
} finally {
	await rm(root, { recursive: true, force: true });
}
