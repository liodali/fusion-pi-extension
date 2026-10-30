export interface GrepInput {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
}

export interface FindInput {
	pattern: string;
	path?: string;
}

export function grepArgv(input: GrepInput): string[] {
	return [
		"rg",
		"--line-number",
		"--no-heading",
		"--color",
		"never",
		"--max-count",
		"50",
		...(input.ignoreCase ? ["-i"] : []),
		...(input.glob ? ["--glob", input.glob] : []),
		"-e",
		input.pattern,
		input.path ?? ".",
	];
}

export function findArgv(input: FindInput): string[] {
	return ["rg", "--files", "--glob", input.pattern, input.path ?? "."];
}

export { scoutCapDecision } from "../../core/scout.ts";
