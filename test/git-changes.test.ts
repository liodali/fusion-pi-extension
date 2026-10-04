import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { changedPaths, hashFiles, parsePorcelain } from "../src/git-changes.ts";

const NUL = "\0";

describe("parsePorcelain", () => {
	test("parses NUL-separated plain tracked entries", () => {
		const paths = parsePorcelain(` M src/index.ts${NUL}A  src/new.ts${NUL}`);
		expect(paths.get("src/index.ts")).toBe(" M");
		expect(paths.get("src/new.ts")).toBe("A ");
	});

	test("uses the new path and consumes the original-path field for renames and copies", () => {
		const paths = parsePorcelain(
			`R  new.ts${NUL}old.ts${NUL}C  src/b.ts${NUL}src/a.ts${NUL} M dirty.ts${NUL}`,
		);
		expect(paths.get("new.ts")).toBe("R ");
		expect(paths.get("src/b.ts")).toBe("C ");
		expect(paths.has("old.ts")).toBe(false);
		expect(paths.has("src/a.ts")).toBe(false);
		expect(paths.get("dirty.ts")).toBe(" M");
	});

	test("parses untracked files in nested directories", () => {
		const paths = parsePorcelain(`?? src/deep/nested/fresh.ts${NUL}`);
		expect(paths.get("src/deep/nested/fresh.ts")).toBe("??");
	});

	test("keeps paths with spaces or unicode raw", () => {
		const paths = parsePorcelain(` M src/with space.ts${NUL}?? src/üñïçødé.ts${NUL}`);
		expect(paths.get("src/with space.ts")).toBe(" M");
		expect(paths.get("src/üñïçødé.ts")).toBe("??");
	});

	test("ignores empty or truncated fields", () => {
		expect(parsePorcelain(` M a.ts${NUL}${NUL}`).size).toBe(1);
		expect(parsePorcelain(`${NUL}??${NUL}`).size).toBe(0);
		expect(parsePorcelain("").size).toBe(0);
	});
});

describe("changedPaths", () => {
	test("counts paths absent from before as modified or added", () => {
		const before = new Map([["a.ts", " M"]]);
		const after = new Map([
			["a.ts", " M"],
			["b.ts", " M"],
			["c.ts", "??"],
		]);
		expect(changedPaths(before, after)).toEqual({
			modified: ["b.ts"],
			added: ["c.ts"],
			preDirty: [],
		});
	});

	test("counts status changes as changes and flags them pre-dirty", () => {
		const before = new Map([["a.ts", " M"]]);
		const after = new Map([["a.ts", "MM"]]);
		expect(changedPaths(before, after)).toEqual({
			modified: ["a.ts"],
			added: [],
			preDirty: ["a.ts"],
		});
	});

	test("marks same-status pre-dirty paths with a different hash as modified", () => {
		const before = new Map([["a.ts", " M"]]);
		const after = new Map([["a.ts", " M"]]);
		const beforeHashes = new Map([["a.ts", "h1"]]);
		const afterHashes = new Map([["a.ts", "h2"]]);
		expect(changedPaths(before, after, beforeHashes, afterHashes)).toEqual({
			modified: ["a.ts"],
			added: [],
			preDirty: ["a.ts"],
		});
	});

	test("skips same-status pre-dirty paths whose hash did not change", () => {
		const before = new Map([
			["a.ts", " M"],
			["b.ts", "??"],
		]);
		const after = new Map(before);
		const beforeHashes = new Map([
			["a.ts", "h1"],
			["b.ts", "h2"],
		]);
		const afterHashes = new Map(beforeHashes);
		expect(changedPaths(before, after, beforeHashes, afterHashes)).toEqual({
			modified: [],
			added: [],
			preDirty: [],
		});
	});

	test("falls back to status-only comparison without hash maps", () => {
		const before = new Map([["a.ts", " M"]]);
		const after = new Map([
			["a.ts", " M"],
			["b.ts", "??"],
		]);
		expect(changedPaths(before, after)).toEqual({
			modified: [],
			added: ["b.ts"],
			preDirty: [],
		});
	});

	test("classifies staged adds as added and everything else as modified", () => {
		const after = new Map([
			["new.ts", "A "],
			["fresh.ts", "??"],
			["renamed.ts", "R "],
			["dirty.ts", " M"],
		]);
		expect(changedPaths(new Map(), after)).toEqual({
			modified: ["renamed.ts", "dirty.ts"],
			added: ["new.ts", "fresh.ts"],
			preDirty: [],
		});
	});
});

describe("hashFiles", () => {
	test("hashes file contents and reports unreadable files as missing", async () => {
		const root = await mkdtemp(join(tmpdir(), "fusion-hash-"));
		try {
			await writeFile(join(root, "a.ts"), "hello");
			await writeFile(join(root, "b.ts"), "world");
			const hashes = await hashFiles(root, ["a.ts", "b.ts", "gone.ts"]);
			expect(hashes.get("a.ts")).toMatch(/^[0-9a-f]{40}$/);
			expect(hashes.get("a.ts")).not.toBe(hashes.get("b.ts"));
			expect(hashes.get("gone.ts")).toBe("missing");
			await writeFile(join(root, "a.ts"), "changed");
			const rehashed = await hashFiles(root, ["a.ts"]);
			expect(rehashed.get("a.ts")).not.toBe(hashes.get("a.ts"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
