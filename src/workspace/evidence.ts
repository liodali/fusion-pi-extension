import { relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { changedPaths, hashFiles, parsePorcelain } from "../git-changes.ts";
import { GIT_TIMEOUT_MS, MAX_EVIDENCE_REFS, MAX_HASHED_DIRTY_PATHS } from "../limits.ts";

/** Execute git without a shell. Adapters supply the process implementation. */
export type GitExec = (args: string[], options: { cwd: string; timeout: number }) => Promise<{ code: number; stdout: string }>;

export interface WorkspaceSnapshot {
	cwd: string;
	toplevel: string;
	headExists: boolean;
	status: Map<string, string>;
	hashes?: Map<string, string>;
}

export interface WorkspaceAfter {
	status: Map<string, string>;
	hashes?: Map<string, string>;
}

async function git(exec: GitExec, args: string[], cwd: string): Promise<{ code: number; stdout: string } | undefined> {
	try { return await exec(args, { cwd, timeout: GIT_TIMEOUT_MS }); } catch { return undefined; }
}

/** Returns no snapshot when Git status is unavailable; callers should require full review. */
export async function snapshotWorkspace(cwd: string, exec: GitExec): Promise<WorkspaceSnapshot | undefined> {
	const root = await git(exec, ["rev-parse", "--show-toplevel"], cwd);
	const toplevel = root?.code === 0 ? root.stdout.trim() : "";
	if (!toplevel) return undefined;
	const head = await git(exec, ["rev-parse", "--verify", "--quiet", "HEAD"], toplevel);
	const status = await git(exec, ["status", "--porcelain=v1", "-z", "-uall"], toplevel);
	if (!status || status.code !== 0) return undefined;
	const paths = parsePorcelain(status.stdout);
	const hashes = paths.size <= MAX_HASHED_DIRTY_PATHS ? await hashFiles(toplevel, paths.keys()) : undefined;
	// Git reports a physical root on platforms where the caller's cwd is a symlink.
	// Resolve the cwd as well so relative tool paths remain inside that root.
	let physicalCwd = cwd;
	try { physicalCwd = await realpath(cwd); } catch { /* Keep the original cwd. */ }
	return { cwd: physicalCwd, toplevel, headExists: head?.code === 0, status: paths, hashes };
}

export async function snapshotWorkspaceAfter(before: WorkspaceSnapshot | undefined, exec: GitExec): Promise<WorkspaceAfter | undefined> {
	if (!before) return undefined;
	try {
		const status = await git(exec, ["status", "--porcelain=v1", "-z", "-uall"], before.toplevel);
		if (!status || status.code !== 0) return undefined;
		return { status: parsePorcelain(status.stdout), hashes: before.hashes ? await hashFiles(before.toplevel, before.hashes.keys()) : undefined };
	} catch { return undefined; }
}

/** Compare worktree state around one turn. Touched paths are optional host evidence. */
export async function workspaceDiffStat(
	before: WorkspaceSnapshot | undefined,
	exec: GitExec,
	touchedFiles: ReadonlySet<string> = new Set(),
	afterSnapshot?: WorkspaceAfter,
): Promise<string | undefined> {
	if (!before) return undefined;
	const { cwd, toplevel, headExists, status: previous, hashes } = before;
	try {
		const captured = afterSnapshot ?? await snapshotWorkspaceAfter(before, exec);
		if (!captured) return undefined;
		const { status: after, hashes: afterHashes } = captured;
		const diffBase = headExists ? ["diff", "HEAD"] : ["diff"];
		const touchedRepoPaths = [...touchedFiles]
			.map((path) => relative(toplevel, resolve(cwd, path)))
			.filter((path) => path.length > 0 && !path.startsWith(".."));
		const { modified, added, preDirty } = changedPaths(previous, after, hashes, afterHashes);
		const diffPaths = new Set(modified);
		for (const path of touchedRepoPaths) {
			if (after.has(path)) diffPaths.add(path);
			if (previous.has(path) && !preDirty.includes(path)) preDirty.push(path);
		}
		const remaining = touchedRepoPaths.filter((path) => !diffPaths.has(path));
		if (remaining.length > 0) {
			const names = await git(exec, [...diffBase, "--name-only", "--", ...remaining], toplevel);
			if (!names || names.code !== 0) return undefined;
			for (const line of names.stdout.split("\n")) if (line.trim()) diffPaths.add(line.trim());
		}
		const parts: string[] = [];
		if (diffPaths.size > 0) {
			const diff = await git(exec, [...diffBase, "--stat", "--", ...diffPaths], toplevel);
			if (!diff || diff.code !== 0) return undefined;
			if (diff.stdout.trim()) parts.push(diff.stdout.trim());
		}
		for (const path of added) parts.push(`new: ${path}`);
		if (preDirty.length > 0) parts.push(`pre-existing changes (affected during this delegation; inspect original edits): ${preDirty.join(", ")}`);
		if (previous.size > 0 && (!hashes || [...hashes.values()].includes("missing"))) parts.push("pre-existing changes (some dirty files could not be compared reliably)");
		return parts.length > 0 ? parts.join("\n") : undefined;
	} catch {
		return undefined;
	}
}

/** Bounded, stable evidence references persisted beside a settled result. */
export async function workspaceEvidenceRefs(
	before: WorkspaceSnapshot | undefined,
	exec: GitExec,
	touchedFiles: ReadonlySet<string> = new Set(),
	afterSnapshot?: WorkspaceAfter,
): Promise<string[] | undefined> {
	if (!before) return undefined;
	try {
		const captured = afterSnapshot ?? await snapshotWorkspaceAfter(before, exec);
		if (!captured) return undefined;
		const { cwd, toplevel, headExists, status: previous, hashes } = before;
		const { status: after, hashes: afterHashes } = captured;
		const diffBase = headExists ? ["diff", "HEAD"] : ["diff"];
		const touchedRepoPaths = [...touchedFiles]
			.map((path) => relative(toplevel, resolve(cwd, path)))
			.filter((path) => path.length > 0 && !path.startsWith(".."));
		const { modified, added, preDirty } = changedPaths(previous, after, hashes, afterHashes);
		const diffPaths = new Set(modified);
		for (const path of touchedRepoPaths) {
			if (after.has(path)) diffPaths.add(path);
			if (previous.has(path) && !preDirty.includes(path)) preDirty.push(path);
		}
		const remaining = touchedRepoPaths.filter((path) => !diffPaths.has(path));
		if (remaining.length > 0) {
			const names = await git(exec, [...diffBase, "--name-only", "--", ...remaining], toplevel);
			if (!names || names.code !== 0) return undefined;
			for (const line of names.stdout.split("\n")) if (line.trim()) diffPaths.add(line.trim());
		}
		// Stable, uri-style references keep offline review self-describing.
		const refs: string[] = [];
		for (const path of diffPaths) if (refs.length < MAX_EVIDENCE_REFS) refs.push(`git:${path}`);
		for (const path of added) if (refs.length < MAX_EVIDENCE_REFS) refs.push(`new:${path}`);
		for (const path of preDirty) if (refs.length < MAX_EVIDENCE_REFS) refs.push(`pre-dirty:${path}`);
		if (previous.size > 0 && (!hashes || [...hashes.values()].includes("missing")) && refs.length < MAX_EVIDENCE_REFS) {
			refs.push("unverifiable:pre-existing-changes");
		}
		const total = diffPaths.size + added.length + preDirty.length;
		if (total > MAX_EVIDENCE_REFS && refs.length < MAX_EVIDENCE_REFS) refs.push("evidence-truncated");
		return refs.length > 0 ? refs : undefined;
	} catch {
		return undefined;
	}
}
