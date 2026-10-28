import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotWorkspace, workspaceDiffStat } from "../src/workspace/evidence.ts";
import { nodeGitExec } from "../src/workspace/node-git.ts";
import { reviewTier } from "../src/report.ts";

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
