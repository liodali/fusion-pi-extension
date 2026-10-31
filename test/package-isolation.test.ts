import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

// M7.1: the two harness entrypoints are explicit published surfaces, and the
// import graphs behind them are isolated. All paths below are repo-relative
// POSIX paths of source files, not absolute filesystem paths. This is a
// static source-graph test: the graph is read from every file's import
// declarations (including type-only and dynamic `import(...)` specifiers,
// which the bundler may erase) — nothing is executed.

const root = resolve(import.meta.dir, "..");

const toRepoPath = (file: string) => relative(root, file).replaceAll("\\", "/");

type Graph = {
	closure: Set<string>;
	bare: Set<string>;
	violations: string[];
};

function walk(entry: string): Graph {
	const graph: Graph = { closure: new Set(), bare: new Set(), violations: [] };
	const pending = [resolve(root, entry)];
	while (pending.length > 0) {
		const file = pending.pop()!;
		const repoPath = toRepoPath(file);
		if (graph.closure.has(repoPath)) continue;
		graph.closure.add(repoPath);
		const specifiers = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map((imported) => imported.fileName);
		for (const spec of specifiers) {
			if (spec.startsWith("node:")) continue;
			if (!spec.startsWith(".")) {
				graph.bare.add(spec);
				continue;
			}
			if (!spec.endsWith(".ts")) graph.violations.push(`${repoPath}: local import "${spec}" must use an explicit .ts specifier`);
			const target = resolve(dirname(file), spec);
			if (!existsSync(target)) {
				graph.violations.push(`${repoPath}: local import "${spec}" does not resolve to a file`);
				continue;
			}
			pending.push(target);
		}
	}
	return graph;
}

const piEntry = walk("src/index.ts");
const opencodeEntry = walk("src/opencode/index.ts");

test("published entrypoints pi and opencode exist and stay on their own side of the graph", () => {
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
		exports: Record<string, string>;
	};
	expect(pkg.exports["."]).toBe("./src/index.ts");
	expect(pkg.exports["./pi"]).toBe("./src/index.ts");
	expect(pkg.exports["./opencode"]).toBe("./src/opencode/index.ts");
	for (const [key, target] of Object.entries(pkg.exports)) {
		if (key === "./package.json") continue;
		expect(existsSync(resolve(root, target))).toBe(true);
	}
	// Same entrypoint, imported two ways: the alias and the Pi default export
	// must agree, so the Pi install path keeps working unchanged.
	expect(pkg.exports["."]).toBe(pkg.exports["./pi"]);
});

test("the OpenCode entry closure never imports the Pi adapter, Pi Durable, or the Pi extension entry", () => {
	const forbidden = [...opencodeEntry.closure].filter((path) => path.startsWith("pi/") || path === "index.ts");
	expect(forbidden).toEqual([]);
});

test("the OpenCode entry closure has no package imports at all (OpenCode-only installs import no Pi SDKs)", () => {
	expect([...opencodeEntry.bare]).toEqual([]);
});

test("the Pi entry closure never imports the OpenCode adapter", () => {
	const forbidden = [...piEntry.closure].filter((path) => path.startsWith("opencode/"));
	expect(forbidden).toEqual([]);
});

test("every local import in both entry closures resolves through the exact-.ts convention", () => {
	expect(piEntry.violations).toEqual([]);
	expect(opencodeEntry.violations).toEqual([]);
});

test("Pi SDK peers are optional so an OpenCode-only install auto-installs none of them", () => {
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
		peerDependencies: Record<string, string>;
		peerDependenciesMeta: Record<string, { optional?: boolean }>;
	};
	const piSdks = Object.keys(pkg.peerDependencies).filter((name) => name.startsWith("@earendil-works/") || name === "typebox");
	expect(piSdks.length).toBeGreaterThan(0);
	for (const name of piSdks) {
		expect({ sdk: name, meta: pkg.peerDependenciesMeta[name] }).toEqual({ sdk: name, meta: { optional: true } });
	}
});
