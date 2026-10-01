import { describe, expect, test } from "bun:test";
import { changedPaths, parsePorcelain } from "../src/git-changes.ts";

describe("parsePorcelain", () => {
	test("parses plain tracked entries", () => {
		const paths = parsePorcelain(" M src/index.ts\nA  src/new.ts\n");
		expect(paths.get("src/index.ts")).toBe(" M");
		expect(paths.get("src/new.ts")).toBe("A ");
	});

	test("uses the new path for renames and copies", () => {
		const paths = parsePorcelain("R  old.ts -> new.ts\nC  src/a.ts -> src/b.ts\n");
		expect(paths.get("new.ts")).toBe("R ");
		expect(paths.get("src/b.ts")).toBe("C ");
		expect(paths.has("old.ts")).toBe(false);
	});

	test("strips quotes from quoted paths", () => {
		const paths = parsePorcelain(' M "src/with space.ts"\n');
		expect(paths.get("src/with space.ts")).toBe(" M");
	});

	test("parses untracked entries", () => {
		const paths = parsePorcelain("?? src/fresh.ts\n");
		expect(paths.get("src/fresh.ts")).toBe("??");
	});

	test("ignores blank or truncated lines", () => {
		expect(parsePorcelain("\n??\n").size).toBe(0);
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
		});
	});

	test("counts status changes as changes", () => {
		const before = new Map([["a.ts", " M"]]);
		const after = new Map([["a.ts", "MM"]]);
		expect(changedPaths(before, after)).toEqual({
			modified: ["a.ts"],
			added: [],
		});
	});

	test("skips entries identical in both snapshots", () => {
		const before = new Map([
			["a.ts", " M"],
			["b.ts", "??"],
		]);
		const after = new Map(before);
		expect(changedPaths(before, after)).toEqual({ modified: [], added: [] });
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
		});
	});
});
