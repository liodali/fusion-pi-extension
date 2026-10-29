import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalWorkspace, openWorkspaceRegistry, ownershipDirectory } from "../src/workspace/ownership.ts";
import type { RunManifest } from "../src/core/manifest.ts";
import { OPENCODE_CAPABILITIES } from "../src/opencode/native-executor.ts";
function manifest(workspace: string, harness = "opencode"): RunManifest {
	return { version: 2, runId: "run", owner: { harness, workspace, supervisorId: "parent" }, capabilities: OPENCODE_CAPABILITIES,
		state: { runActive: true, phase: "executing", delegating: false, executed: false, revisions: 0, finalFixUsed: false, resumePending: false, scoutCalls: 0, settleNudges: 0 }, recovery: "pending", pending: { action: "execute", requestId: "exact" } };
}

test("harness-specific XDG state settings cannot split the default ownership registry", () => {
	const previousXdg = process.env.XDG_STATE_HOME;
	const previousOverride = process.env.FUSION_OWNERSHIP_DIR;
	try {
		delete process.env.FUSION_OWNERSHIP_DIR;
		process.env.XDG_STATE_HOME = "/tmp/pi-state";
		const first = ownershipDirectory();
		process.env.XDG_STATE_HOME = "/tmp/opencode-state";
		expect(ownershipDirectory()).toBe(first);
	} finally {
		if (previousXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousXdg;
		if (previousOverride === undefined) delete process.env.FUSION_OWNERSHIP_DIR; else process.env.FUSION_OWNERSHIP_DIR = previousOverride;
	}
});

test("ownership metadata cannot be stored in a public directory", async () => {
	if (process.platform === "win32") return;
	const root = await mkdtemp(join(tmpdir(), "fusion-public-owner-"));
	try {
		await chmod(root, 0o755);
		await expect(openWorkspaceRegistry(root)).rejects.toThrow("private directory");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a corrupt coordinator is reported as storage failure, not a live owner", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-corrupt-coordinator-"));
	try {
		const directory = join(root, "state");
		const registry = await openWorkspaceRegistry(directory);
		const workspace = await canonicalWorkspace(root);
		const name = `${createHash("sha256").update(workspace).digest("hex")}.sqlite`;
		await writeFile(join(directory, name), "invalid database");
		await expect(registry.claim(manifest(workspace))).rejects.toThrow("inspect the ownership storage");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace ownership excludes overlapping aliases and survives coordinator loss", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-owner-"));
	try {
		const cwd = join(root, "project"); await mkdir(join(cwd, "nested"), { recursive: true }); await symlink(cwd, join(root, "alias"));
		expect(await canonicalWorkspace(join(root, "alias"))).toBe(await canonicalWorkspace(cwd));
		const registry = await openWorkspaceRegistry(join(root, "state"));
		const initial = manifest(cwd);
		const lease = await registry.claim(initial);
		await expect(lease.save({ ...initial, pending: { action: "revise", requestId: "other" } })).rejects.toThrow("unsettled Fusion request");
		await lease.save({ ...initial, worker: { owner: initial.owner, runtime: "native-subagent", id: "child" } });
		await expect(lease.save({ ...lease.manifest, worker: { owner: initial.owner, runtime: "native-subagent", id: "other" } })).rejects.toThrow("worker of an unsettled");
		await expect(registry.claim(initial, lease.token)).rejects.toThrow("coordinating");
		await expect(registry.claim(manifest(join(cwd, "nested"), "pi"))).rejects.toThrow("owns this workspace");
		await expect(lease.release()).rejects.toThrow("unsettled");
		const token = lease.token; lease.close();
		await expect(registry.claim(manifest(cwd, "pi"))).rejects.toThrow("owns this workspace");
		const resumed = await registry.claim(initial, token);
		expect(resumed.manifest.pending?.requestId).toBe("exact");
		await resumed.save({ ...resumed.manifest, recovery: "settled", pending: undefined });
		await resumed.release();
		const pi = await registry.claim({ ...manifest(cwd, "pi"), recovery: "settled", pending: undefined }); await pi.release();
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Git marker keeps sibling workspaces together when Git cannot resolve the repository", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-marker-"));
	try {
		await mkdir(join(root, ".git"));
		await mkdir(join(root, "one"));
		await mkdir(join(root, "two"));
		const expected = await canonicalWorkspace(root);
		expect(await canonicalWorkspace(join(root, "one"))).toBe(expected);
		expect(await canonicalWorkspace(join(root, "two"))).toBe(expected);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("two real processes cannot become conflicting workspace writers", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-process-owner-"));
	const children: ReturnType<typeof Bun.spawn>[] = [];
	try {
		const file = join(root, "manifest.json"); await writeFile(file, JSON.stringify(manifest(root)));
		const script = `import { openWorkspaceRegistry } from ${JSON.stringify(join(import.meta.dir, "../src/workspace/ownership.ts"))}; const r=await openWorkspaceRegistry(process.argv[1]); const m=JSON.parse(await Bun.file(process.argv[2]).text()); try {const l=await r.claim(m); console.log("owned"); setInterval(()=>{ void l.token; },1000);}catch(e){console.log(String(e));process.exitCode=2;}`;
		const start = () => { const child = Bun.spawn([process.execPath, "-e", script, join(root, "state"), file], { stdout: "pipe", stderr: "pipe" }); children.push(child); return child; };
		const first = start();
		const reader = (first.stdout as ReadableStream<Uint8Array>).getReader();
		const line = await reader.read(); expect(new TextDecoder().decode(line.value)).toContain("owned");
		const second = start(); expect(await second.exited).toBe(2);
		expect(await new Response(second.stdout).text()).toContain("coordinating");
		first.kill(); await first.exited;
		const third = start(); expect(await third.exited).toBe(2);
		expect(await new Response(third.stdout).text()).toContain("owns this workspace");
	} finally { for (const child of children) if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); }
}, 15000);

test("operator resolution requires exact identity and never steals a live coordinator", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-operator-resolve-"));
	try {
		const { resolveWorkspaceOwnership } = await import("../src/workspace/resolve.ts");
		const cwd = await canonicalWorkspace(root);
		const directory = join(root, "state");
		const registry = await openWorkspaceRegistry(directory);
		const lease = await registry.claim(manifest(cwd));
		await expect(resolveWorkspaceOwnership({ cwd, runId: "run", requestId: "exact", confirmStopped: false }, directory)).rejects.toThrow("confirmation");
		await expect(resolveWorkspaceOwnership({ cwd, runId: "run", requestId: "other", confirmStopped: true }, directory)).rejects.toThrow("Request ID");
		await expect(resolveWorkspaceOwnership({ cwd, runId: "run", requestId: "exact", confirmStopped: true }, directory)).rejects.toThrow("coordinating");
		expect((await registry.inspect(cwd))?.manifest.pending?.requestId).toBe("exact");
		lease.close();
		await resolveWorkspaceOwnership({ cwd, runId: "run", requestId: "exact", confirmStopped: true }, directory);
		expect(await registry.inspect(cwd)).toBeUndefined();
		expect((await registry.archived("run"))?.operatorResolution?.pending?.requestId).toBe("exact");
		await resolveWorkspaceOwnership({ cwd, runId: "run", requestId: "exact", confirmStopped: true }, directory);
	} finally { await rm(root, { recursive: true, force: true }); }
});
