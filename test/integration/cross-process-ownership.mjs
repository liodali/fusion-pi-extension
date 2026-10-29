// Cross-process ownership acceptance: a real Pi entrypoint process holds a
// workspace lease while real OpenCode plugin processes — direct path, symlink
// alias, and a nested location — are refused. After the Pi run settles and
// cleans, the same workspace is claimable again. Prints a summary and exits
// nonzero on any failure.
import { spawn } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), `fusion-cross-${process.pid}`);
const workspace = join(dir, "workspace");
const alias = join(dir, "alias");
const ownership = join(dir, "ownership");
const stopFile = join(dir, "stop");
const parent = new URL(".", import.meta.url).pathname;

const waitUntil = async (predicate, timeoutMs = 30000) => {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for a cross-process marker");
		setTimeout(() => {}, 0);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

const attempt = (invocation) => new Promise((resolve) => {
	const child = spawn("bun", [join(parent, "cross-process-opencode-attempt.mjs"), invocation.phase, invocation.directory], {
		env: { ...process.env, FUSION_OWNERSHIP_DIR: ownership },
	});
	let out = "";
	child.stdout.on("data", (chunk) => { out += chunk; });
	child.stderr.on("data", (chunk) => { out += chunk; });
	child.on("close", () => {
		const line = out.split("\n").find((value) => value.startsWith("RESULT "));
		resolve(line ? JSON.parse(line.slice(7)) : { phase: invocation.phase, ok: false, message: out.slice(-500) });
	});
});

const failures = [];
const expectBlocked = (verdict) => {
	if (!verdict.ok && /Another Fusion run owns this workspace/.test(verdict.message ?? "")) return;
	failures.push(`${verdict.phase}: expected an ownership refusal, got ${JSON.stringify(verdict)}`);
};
const expectClaimable = (verdict) => {
	if (verdict.ok) return;
	failures.push(`${verdict.phase}: expected a successful claim, got ${JSON.stringify(verdict)}`);
};

let exitCode = 0;
try {
	await mkdir(workspace, { recursive: true });
	// The registry guard requires a private directory; create it accordingly
	// so both harnesses accept the same ownership directory.
	await mkdir(ownership, { recursive: true, mode: 0o700 });
	await symlink(workspace, alias, "dir");
	const holder = spawn("bun", ["test", join(parent, "cross-process-pi-hold.test.mjs")], {
		env: {
			...process.env,
			FUSION_PI_TEST_DIR: join(dir, "agent-pi"),
			PI_CODING_AGENT_DIR: join(dir, "agent-pi"),
			// The holder must claim the SAME registry the attempts inspect.
			FUSION_OWNERSHIP_DIR: ownership,
			FUSION_CROSS_WORKSPACE: workspace,
			FUSION_CROSS_STOP: stopFile,
		},
	});
	let holderOut = "";
	const chunk = (data) => { holderOut += data; return data; };
	const status = new Promise((resolve) => { holder.on("close", (code) => resolve(code)); });
	holder.stdout.on("data", chunk);
	holder.stderr.on("data", chunk);
	try {
		await waitUntil(() => holderOut.includes("READY"), 60000);
	} catch {
		// Surface the holder's own output so a stalled start is diagnosable.
		throw new Error(`The Pi holder never became READY before stop: ${holderOut.slice(-1200)}`);
	}
	expectBlocked(await attempt({ phase: "blocked", directory: workspace }));
	expectBlocked(await attempt({ phase: "blocked-alias", directory: alias }));
	expectBlocked(await attempt({ phase: "blocked-nested", directory: workspace }));
	await writeFile(stopFile, "");
	await waitUntil(() => holderOut.includes("DONE"));
	expectClaimable(await attempt({ phase: "fresh", directory: workspace }));
	console.log(JSON.stringify({ direction: "pi holds, opencode refuses", alias: "symlink", nested: true }));
} catch (error) {
	exitCode = 1;
	console.log(`CROSS-PROCESS FAILED: ${error instanceof Error ? error.stack : error}`);
} finally {
	await rm(dir, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
