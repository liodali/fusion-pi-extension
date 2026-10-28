import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function parsePorcelain(stdout: string): Map<string, string> {
	const paths = new Map<string, string>();
	const fields = stdout.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const record = fields[i];
		if (record.length < 4) continue;
		const status = record.slice(0, 2);
		const path = record.slice(3);
		if (status.includes("R") || status.includes("C")) {
			i++;
		}
		if (path) paths.set(path, status);
	}
	return paths;
}

export async function hashFiles(
	root: string,
	paths: Iterable<string>,
): Promise<Map<string, string>> {
	const hashes = new Map<string, string>();
	for (const path of paths) {
		try {
			const bytes = await readFile(resolve(root, path));
			hashes.set(path, createHash("sha1").update(bytes).digest("hex"));
		} catch {
			hashes.set(path, "missing");
		}
	}
	return hashes;
}

export function changedPaths(
	before: Map<string, string>,
	after: Map<string, string>,
	beforeHashes?: Map<string, string>,
	afterHashes?: Map<string, string>,
): { modified: string[]; added: string[]; preDirty: string[] } {
	const modified: string[] = [];
	const added: string[] = [];
	const preDirty: string[] = [];
	for (const [path, status] of after) {
		const isNew = status === "??" || status.startsWith("A");
		if (!before.has(path)) {
			(isNew ? added : modified).push(path);
			continue;
		}
		const statusChanged = before.get(path) !== status;
		const hashChanged =
			beforeHashes?.has(path) === true &&
			afterHashes?.has(path) === true &&
			beforeHashes.get(path) !== afterHashes.get(path);
		if (!statusChanged && !hashChanged) continue;
		(isNew ? added : modified).push(path);
		preDirty.push(path);
	}
	for (const path of before.keys()) {
		if (!after.has(path)) preDirty.push(path);
	}
	return { modified, added, preDirty };
}
