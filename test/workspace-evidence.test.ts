import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotWorkspace, workspaceDiffStat, workspaceEvidenceRefs } from "../src/workspace/evidence.ts";
import { nodeGitExec } from "../src/workspace/node-git.ts";
import { reviewTier } from "../src/report.ts";
import { MAX_EVIDENCE_REFS } from "../src/limits.ts";

async function git(cwd: string, ...args: string[]) {
	const result = await nodeGitExec(args, { cwd, timeout: 5000 });
	if (result.code !== 0) throw new Error(`git ${args[0]} failed`);
}

describe("shared workspace evidence", () => {
	test("compares a real Git worktree with staged, untracked and pre-existing changes", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-workspace-"));
		try {
			await git(root, "init", "-q");
			await mkdir(join(root, "nested"));
			for (const name of ["unchanged-dirty.txt", "edited-dirty.txt", "clean.txt"]) await writeFile(join(root, name), "original\n");
			await git(root, "add", ".");
			await git(root, "-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
			await writeFile(join(root, "unchanged-dirty.txt"), "already dirty\n");
			await writeFile(join(root, "edited-dirty.txt"), "already dirty\n");
			const before = await snapshotWorkspace(join(root, "nested"), nodeGitExec);
			expect(before?.headExists).toBe(true);
			await writeFile(join(root, "edited-dirty.txt"), "changed again\n");
			await writeFile(join(root, "clean.txt"), "new change\n");
			await writeFile(join(root, "staged-new.txt"), "staged\n");
			await git(root, "add", "staged-new.txt");
			await writeFile(join(root, "untracked.txt"), "untracked\n");
			const stat = await workspaceDiffStat(before, nodeGitExec);
			expect(stat).toContain("edited-dirty.txt");
			expect(stat).toContain("clean.txt");
			expect(stat).toContain("new: staged-new.txt");
			expect(stat).toContain("new: untracked.txt");
			expect(stat).toContain("pre-existing changes");
			expect(stat).not.toContain("unchanged-dirty.txt");
			const withTouched = await workspaceDiffStat(before, nodeGitExec, new Set(["../unchanged-dirty.txt"]));
			expect(withTouched).toContain("unchanged-dirty.txt");
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("returns no evidence when Git is unavailable or status fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-no-git-"));
		try {
			expect(await snapshotWorkspace(root, nodeGitExec)).toBeUndefined();
			expect(await snapshotWorkspace(root, async () => { throw new Error("unavailable"); })).toBeUndefined();
			expect(await workspaceDiffStat(undefined, nodeGitExec)).toBeUndefined();
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("reports truncation when evidence passes the cap and stays bounded", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-refs-overflow-"));
		try {
			const git = (args: string[]) => nodeGitExec(args, { cwd: root, timeout: 5000 });
			await git(["init", "-q"]);
			await git(["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture"]);
			const before = await snapshotWorkspace(root, nodeGitExec);
			for (let i = 0; i < 40; i++) await writeFile(join(root, `overflow-${String(i).padStart(2, "0")}.txt`), "addition\n");
			const refs = await workspaceEvidenceRefs(before, nodeGitExec);
			expect((refs ?? []).length).toBe(MAX_EVIDENCE_REFS);
			expect((refs ?? []).every((ref) => ref.startsWith("new:") || ref === "evidence-truncated")).toBe(true);
			expect(refs?.at(-1)).toBe("evidence-truncated");
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("collects bounded evidence references for a settled turn", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-refs-"));
		try {
			const git = (args: string[]) => nodeGitExec(args, { cwd: root, timeout: 5000 });
			await git(["init", "-q"]);
			await mkdir(join(root, "nested"));
			for (const name of ["dirty-nonworker.txt", "worker-dirty.txt"]) await writeFile(join(root, name), "original\n");
			await git(["add", "."]);
			await git(["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
			await writeFile(join(root, "dirty-nonworker.txt"), "changed outside\n");
			const before = await snapshotWorkspace(join(root, "nested"), nodeGitExec);
			await writeFile(join(root, "worker-dirty.txt"), "worker edit\n");
			await writeFile(join(root, "worker-new.txt"), "worker addition\n");
			const refs = await workspaceEvidenceRefs(before, nodeGitExec, new Set(["worker-dirty.txt", "worker-new.txt"]));
			expect(refs).toContain("git:worker-dirty.txt");
			expect(refs).toContain("new:worker-new.txt");
			expect(refs!.join("\n")).not.toContain("dirty-nonworker");
			for (const ref of refs!) expect(ref.length).toBeGreaterThan(0);
			expect(refs!.length).toBeLessThanOrEqual(MAX_EVIDENCE_REFS);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	test("forces full review when a pre-existing edit is restored to HEAD", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-restored-"));
		try {
			await git(root, "init", "-q");
			await writeFile(join(root, "user.txt"), "original\n");
			await writeFile(join(root, "worker.txt"), "original\n");
			await git(root, "add", ".");
			await git(root, "-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
			await writeFile(join(root, "user.txt"), "user edit\n");
			const before = await snapshotWorkspace(root, nodeGitExec);
			await writeFile(join(root, "user.txt"), "original\n");
			await writeFile(join(root, "worker.txt"), "worker change\n");
			const stat = await workspaceDiffStat(before, nodeGitExec, new Set(["user.txt", "worker.txt"]));
			expect(stat).toContain("pre-existing changes");
			expect(stat).toContain("user.txt");
			expect(reviewTier({ status: "done", summary: "done", files_changed: [], checks: [{ command: "check", result: "pass" }], blockers: [] }, stat).tier).toBe("full");
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
