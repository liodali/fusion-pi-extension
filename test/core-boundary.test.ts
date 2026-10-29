import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

test("shared modules have no package imports and load without harness dependencies", async () => {
	const coreDir = resolve(import.meta.dir, "../src/core");
	const entries = (await readdir(coreDir)).filter((name) => name.endsWith(".ts"));
	// Check type-only imports too: the bundler deliberately erases those.
	const pending = entries.map((name) => join(coreDir, name));
	const visited = new Set<string>();
	while (pending.length) {
		const file = pending.pop()!;
		if (visited.has(file)) continue;
		visited.add(file);
		for (const imported of ts.preProcessFile(await readFile(file, "utf8"), true, true).importedFiles) {
			if (imported.fileName.startsWith("node:")) continue;
			expect(imported.fileName.startsWith(".")).toBe(true);
			if (imported.fileName.startsWith(".")) pending.push(resolve(file, "..", imported.fileName));
		}
	}
	const result = await Bun.build({
		entrypoints: entries.map((name) => join(coreDir, name)),
		target: "bun",
		plugins: [{
			name: "shared-import-boundary",
			setup(build) {
				build.onResolve({ filter: /^[^./]/ }, (args) => {
					if (args.path.startsWith("node:")) return { path: args.path, external: true };
					throw new Error(`Shared module imports package ${args.path} from ${args.importer}`);
				});
			},
		}],
	});
	expect(result.logs.map(String)).toEqual([]);
	expect(result.success).toBe(true);

	const dir = await mkdtemp(join(tmpdir(), "fusion-core-boundary-"));
	try {
		await cp(coreDir, join(dir, "core"), { recursive: true });
		for (const name of ["limits.ts", "prompts.ts", "report.ts", "settle.ts"]) {
			await cp(resolve(import.meta.dir, "../src", name), join(dir, name));
		}
		const imports = entries.map((name) => `import(${JSON.stringify(pathToFileURL(join(dir, "core", name)).href)})`);
		const process = Bun.spawn([processExecPath(), "-e", `await Promise.all([${imports.join(",")}])`], {
			cwd: dir, stdout: "pipe", stderr: "pipe", env: { PATH: globalThis.process.env.PATH ?? "" },
		});
		const stderr = await new Response(process.stderr).text();
		expect({ exit: await process.exited, stderr }).toEqual({ exit: 0, stderr: "" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

function processExecPath(): string { return globalThis.process.execPath; }
