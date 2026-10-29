import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { readRunManifest, type RunManifest } from "../core/manifest.ts";

const execute = promisify(execFile);
/** A harness-specific XDG state directory must not split the ownership registry. */
export const ownershipDirectory = () => process.env.FUSION_OWNERSHIP_DIR ?? join(homedir(), ".local", "state", "fusion", "ownership");

/** Resolve aliases and Git subdirectories; non-Git overlaps are checked in the registry. */
export async function canonicalWorkspace(cwd: string): Promise<string> {
	const physical = await realpath(cwd);
	try {
		const { stdout } = await execute("git", ["rev-parse", "--show-toplevel"], { cwd: physical, timeout: 5000 });
		return await realpath(stdout.trim());
	} catch {
		// Even if Git is unavailable, a worktree marker makes sibling locations
		// share one ownership boundary. A false positive only blocks more work.
		let current = physical;
		for (;;) {
			try { await lstat(join(current, ".git")); return current; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			const parent = dirname(current);
			if (parent === current) return physical;
			current = parent;
		}
	}
}
function overlaps(a: string, b: string): boolean {
	const inside = (parent: string, child: string) => { const path = relative(parent, child); return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)); };
	return inside(a, b) || inside(b, a);
}
export interface OwnedRun { token: string; manifest: RunManifest }
export interface WorkspaceLease {
	readonly token: string;
	readonly manifest: RunManifest;
	save(manifest: RunManifest): Promise<void>;
	release(): Promise<void>;
	/** Drop this process's coordinator only; persistent ownership is retained. */
	close(): void;
}

/** SQLite provides process-lifetime coordinator exclusion; ownership survives a crash. */
export async function openWorkspaceRegistry(directory = ownershipDirectory()) {
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Fusion ownership registry is unavailable at ${directory}: ${reason}. Set the same FUSION_OWNERSHIP_DIR on every Pi and OpenCode process for this workspace.`);
	}
	if (process.platform !== "win32") {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
			throw new Error("Fusion ownership directory must be a private directory owned by the current user (mode 0700).");
		}
	}
	const connect = () => {
		const db = new DatabaseSync(join(directory, "owners.sqlite"));
		try {
			db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner (workspace TEXT PRIMARY KEY, token TEXT NOT NULL, manifest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS archive (runId TEXT PRIMARY KEY, manifest TEXT NOT NULL)");
			return db;
		} catch (error) { db.close(); throw error; }
	};
	const decode = (row: unknown): OwnedRun | undefined => {
		if (!row) return undefined;
		const value = row as { workspace: string; token: string; manifest: string };
		const raw = JSON.parse(value.manifest);
		return { token: value.token, manifest: readRunManifest(raw, { harness: raw.owner?.harness, workspace: value.workspace }) };
	};
	return {
		async archived(runId: string): Promise<RunManifest | undefined> {
			const db = connect();
			try {
				const row = db.prepare("SELECT manifest FROM archive WHERE runId = ?").get(runId) as { manifest: string } | undefined;
				if (!row) return undefined;
				const raw = JSON.parse(row.manifest);
				return readRunManifest(raw, { harness: raw.owner?.harness, workspace: raw.owner?.workspace });
			} finally { db.close(); }
		},
		async inspect(workspace: string): Promise<OwnedRun | undefined> {
			const db = connect();
			try {
				const rows = db.prepare("SELECT * FROM owner").all() as { workspace: string }[];
				const row = rows.find((value) => overlaps(workspace, value.workspace));
				return decode(row);
			} finally { db.close(); }
		},
		async claim(initial: RunManifest, resumeToken?: string): Promise<WorkspaceLease> {
			const snapshot = readRunManifest(initial, { harness: initial.owner.harness, workspace: initial.owner.workspace });
			const workspace = snapshot.owner.workspace;
			const gate = new DatabaseSync(join(directory, `${createHash("sha256").update(workspace).digest("hex")}.sqlite`));
			try { gate.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
			catch (error) {
				gate.close();
				const code = typeof error === "object" && error !== null && "errcode" in error ? (error as { errcode: unknown }).errcode : undefined;
				if (typeof code === "number" && [5, 6].includes(code & 0xff)) throw new Error("Another Fusion process is coordinating this workspace. Wait for it to finish.", { cause: error });
				throw new Error("Cannot acquire the Fusion workspace coordinator; inspect the ownership storage.", { cause: error });
			}
			let current: OwnedRun;
			let db: DatabaseSync;
			try { db = connect(); } catch (error) { gate.close(); throw error; }
			try {
				db.exec("BEGIN IMMEDIATE");
				const rows = db.prepare("SELECT * FROM owner").all() as { workspace: string }[];
				const row = rows.find((value) => overlaps(workspace, value.workspace));
				const existing = decode(row);
				if (existing) {
					const prior = existing.manifest;
					if (prior.owner.workspace !== workspace || prior.runId !== snapshot.runId || prior.owner.harness !== snapshot.owner.harness || prior.owner.supervisorId !== snapshot.owner.supervisorId || resumeToken !== existing.token) {
						throw new Error("Another Fusion run owns this workspace. Reconcile or explicitly resolve that run before starting work.");
					}
					current = existing;
				} else {
					if (resumeToken) throw new Error("Fusion ownership record is missing; inspect the workspace before recovery.");
					current = { token: randomUUID(), manifest: snapshot };
					db.prepare("INSERT INTO owner VALUES (?, ?, ?)").run(workspace, current.token, JSON.stringify(snapshot));
				}
				db.exec("COMMIT");
			} catch (error) { try { db.exec("ROLLBACK"); } catch {} db.close(); gate.close(); throw error; }
			db.close();
			let closed = false;
			function transaction(action: (connection: DatabaseSync) => void) {
				if (closed) throw new Error("Fusion workspace lease is closed.");
				const connection = connect();
				try {
					connection.exec("BEGIN IMMEDIATE");
					const row = connection.prepare("SELECT token FROM owner WHERE workspace = ?").get(workspace) as { token: string } | undefined;
					if (!row || row.token !== current.token) throw new Error("Fusion workspace ownership changed; operation blocked.");
					action(connection); connection.exec("COMMIT");
				} catch (error) { try { connection.exec("ROLLBACK"); } catch {} throw error; }
				finally { connection.close(); }
			}
			const lease: WorkspaceLease = {
				get token() { return current.token; },
				get manifest() { return structuredClone(current.manifest); },
				async save(manifest) {
					const value = readRunManifest(manifest, { harness: current.manifest.owner.harness, workspace });
					if (value.runId !== current.manifest.runId || value.owner.supervisorId !== current.manifest.owner.supervisorId) throw new Error("Cannot replace the workspace owner.");
					const pending = current.manifest.pending;
					if (pending && value.pending && (value.pending.requestId !== pending.requestId || value.pending.action !== pending.action)) throw new Error("Cannot replace an unsettled Fusion request.");
					const reference = current.manifest.worker;
					if (pending && reference && (!value.worker || value.worker.id !== reference.id || value.worker.runtime !== reference.runtime)) throw new Error("Cannot replace the worker of an unsettled Fusion request.");
					transaction((connection) => { connection.prepare("UPDATE owner SET manifest = ? WHERE workspace = ? AND token = ?").run(JSON.stringify(value), workspace, current.token); });
					current = { ...current, manifest: value };
				},
				async release() {
					if (current.manifest.recovery !== "settled") throw new Error("Cannot release unsettled Fusion ownership. Reconcile or explicitly resolve it first.");
					transaction((connection) => {
						connection.prepare("INSERT OR REPLACE INTO archive VALUES (?, ?)").run(current.manifest.runId, JSON.stringify(current.manifest));
						connection.prepare("DELETE FROM owner WHERE workspace = ? AND token = ?").run(workspace, current.token);
					});
					lease.close();
				},
				close() { if (!closed) { closed = true; gate.close(); } },
			};
			return lease;
		},
	};
}
