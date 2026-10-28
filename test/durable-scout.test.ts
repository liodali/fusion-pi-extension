import { describe, expect, test } from "bun:test";
import { findArgv, grepArgv, scoutCapDecision } from "../src/durable/scout-args.ts";

describe("grepArgv", () => {
	test("builds the ripgrep argv with defaults", () => {
		expect(grepArgv({ pattern: "foo" })).toEqual([
			"rg",
			"--line-number",
			"--no-heading",
			"--color",
			"never",
			"--max-count",
			"50",
			"-e",
			"foo",
			".",
		]);
	});

	test("adds ignore-case, glob, and path", () => {
		expect(
			grepArgv({ pattern: "foo", path: "src", glob: "*.ts", ignoreCase: true }),
		).toEqual([
			"rg",
			"--line-number",
			"--no-heading",
			"--color",
			"never",
			"--max-count",
			"50",
			"-i",
			"--glob",
			"*.ts",
			"-e",
			"foo",
			"src",
		]);
	});
});

describe("findArgv", () => {
	test("builds the ripgrep file-list argv", () => {
		expect(findArgv({ pattern: "*.md" })).toEqual([
			"rg",
			"--files",
			"--glob",
			"*.md",
			".",
		]);
		expect(findArgv({ pattern: "*.md", path: "docs" })).toEqual([
			"rg",
			"--files",
			"--glob",
			"*.md",
			"docs",
		]);
	});
});

describe("scoutCapDecision", () => {
	test("allows calls up to the cap", () => {
		expect(scoutCapDecision(20, 20)).toBe("allow");
		expect(scoutCapDecision(1, 20)).toBe("allow");
	});

	test("refuses the first three calls past the cap", () => {
		expect(scoutCapDecision(21, 20)).toBe("refuse");
		expect(scoutCapDecision(23, 20)).toBe("refuse");
	});

	test("terminates beyond the refusal window", () => {
		expect(scoutCapDecision(24, 20)).toBe("terminate");
		expect(scoutCapDecision(50, 20)).toBe("terminate");
	});
});
