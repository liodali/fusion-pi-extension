// Fresh-consumer install test for the M7.1 dependency contract.
//
// npm ignores dependency packages' overrides, so the codemode override in
// this repository's package.json only protects the checkout itself. What a
// consumer gets is decided by the consumer's own install, and that is what
// this fixture exercises, from fresh temporary consumer directories.
//
// The fusion package is installed from a packed tarball, not from `file:<dir>`:
// npm symlinks directory dependencies, so a file: directory install would make
// every import resolve through this repository's own node_modules — masked by
// this repo's dev override — and the consumer tree would never be tested at
// all. A tarball install gives both managers a real copy inside the consumer.
//
// Scenarios:
// 1. bun install, guided by the documented consumer override (~1.0.3) —
//    asserted: the tree must only carry codemode copies from the compatible
//    1.0.x window (pi-coding-agent 1.0.3 declares pi-codemode ^1.0.3 while
//    its own dist needs symbols only the 1.0.x line carries — an upstream
//    boundary), each copy must still carry the released symbol, and the
//    import chain must work.
// 2. npm install, guided by the documented consumer override (~1.0.3) —
//    asserted with the same rule: the consumer override is the supported
//    way to constrain this transitive range on npm (npm does not shape its
//    tree from an optional peer when a fresh consumer also installs the Pi
//    stack — measured).
// 3. bun install, unguided — recorded, not asserted: bun ignores packages'
//    overrides and does not shape versions from optional peers, so an
//    unguided bun consumer resolves pi-codemode 1.4.0 and importing the
//    Pi-side chain crashes (measured; both manager guides exist precisely
//    for this).
// 4. npm install, unguided — recorded, not asserted: under the current
//    registry state npm resolves inside the window for this consumer shape
//    (fusion's optional ~1.0.3 peer participates in the placement); if
//    upstream or the registry change someday, the recorded row flips.
//
// All import probes run bun: the package publishes TypeScript sources for
// Bun-native hosts (the Pi harness and the OpenCode plugin runtime), so a
// plain-node consumer needing its own transpile pipeline is a recorded
// boundary, not a defect this fixture polices.
//
// Model-free; touches the network only to install from the registry.
import { mkdtemp, readdir, readFile, rm, writeFile, copyFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "../..");

const manifest = (tarball, override) => ({
	name: "fusion-consumer-probe",
	private: true,
	type: "module",
	dependencies: {
		"@earendil-works/chord": "1.0.3",
		"@earendil-works/pi-coding-agent": "1.0.3",
		"@earendil-works/pi-durable": "1.0.3",
		"pi-fusion-extension": `file:${tarball}`,
	},
	...(override ? { overrides: { "@earendil-works/pi-codemode": override } } : {}),
});

async function codemodeCopies(consumerDir) {
	const copies = [];
	const pending = [join(consumerDir, "node_modules")];
	while (pending.length > 0) {
		const dir = pending.pop();
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const path = join(dir, entry.name);
			if (entry.name === "pi-codemode") {
				copies.push(await describeCopy(consumerDir, path));
				continue;
			}
			pending.push(path);
		}
	}
	return copies;
}

// The published surface the install guide depends on: the OpenCode agent
// definitions ship with the package, the consolidated install guide ships,
// and the Pi project-local discovery shim ships. Missing files break the
// documented install steps, so these are asserted like the codemode rows.
async function shippedAssets(consumerDir) {
	const pkgRoot = join(consumerDir, "node_modules/pi-fusion-extension");
	const wanted = {
		"agent fusion.md": join(pkgRoot, "examples/opencode/agents/fusion.md"),
		"agent fusion-executor.md": join(pkgRoot, "examples/opencode/agents/fusion-executor.md"),
		"agent fusion-scout.md": join(pkgRoot, "examples/opencode/agents/fusion-scout.md"),
		"install guide": join(pkgRoot, "docs/install.md"),
		"Pi discovery shim": join(pkgRoot, ".pi/extensions/fusion.ts"),
		"operator CLI": join(pkgRoot, "src/workspace/resolve.ts"),
	};
	const assets = {};
	for (const [label, path] of Object.entries(wanted)) {
		try {
			await stat(path);
			assets[label] = true;
		} catch {
			assets[label] = false;
		}
	}
	return assets;
}

async function describeCopy(consumerDir, packageDir) {
	const base = { inTree: relative(consumerDir, packageDir), version: "unreadable", carriesSymbol: false };
	try {
		const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
		base.version = pkg.version;
		const declarations = await readFile(join(packageDir, "dist/declarations.js"), "utf8");
		base.carriesSymbol = declarations.includes("MCP_TYPESCRIPT_PREAMBLE");
	} catch {}
	return base;
}

async function importProbe(consumerDir) {
	// Two pivots, deliberately: the root entry (the extension default export)
	// alone passes everywhere — pi-coding-agent's incompatible codemode
	// imports only break when that chain itself evaluates, so the probe also
	// imports the durable/executor backend pivot and finally pi-coding-agent
	// itself, the exact evaluation that fails in an unguided tree.
	const script = [
		"const suffix = 'IMPORT-PASS';",
		"const m = await import('pi-fusion-extension');",
		"if (typeof m.default !== 'function') throw new Error('unexpected default export shape');",
		`await import('${pathToFileURL(join(consumerDir, "node_modules/pi-fusion-extension/src/pi/durable/backend.ts")).href}');`,
		`await import('${pathToFileURL(join(consumerDir, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href}');`,
		"console.log('IMPORT-OK');",
	].join("\n");
	const result = spawnSync("bun", ["-e", script], { cwd: consumerDir, encoding: "utf8" });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	return { importOk: result.status === 0 && output.includes("IMPORT-OK"), output: output.split("\n").slice(-4).join("\n") };
}

function npmAvailable() {
	return spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0;
}

const packTarball = async () => {
	const dest = await mkdtemp(join(tmpdir(), "fusion-pack-"));
	const pack = spawnSync("npm", ["pack", repo, "--json", "--pack-destination", dest], { encoding: "utf8" });
	if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stdout} ${pack.stderr}`);
	const packed = JSON.parse(pack.stdout)[0];
	return join(dest, packed.filename);
};

async function scenario(name, { manager, override, tarball }) {
	const consumerDir = await mkdtemp(join(tmpdir(), "fusion-consumer-"));
	try {
		const tarballPath = await (async () => {
			await copyFile(tarball, join(consumerDir, "fusion.tgz"));
			return join(consumerDir, "fusion.tgz");
		})();
		await writeFile(join(consumerDir, "package.json"), `${JSON.stringify(manifest(tarballPath, override), null, 2)}\n`);
		const installer = manager === "bun" ? ["bun", ["install"]] : ["npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]];
		const install = spawnSync(installer[0], installer[1], { cwd: consumerDir, encoding: "utf8" });
		const copies = await codemodeCopies(consumerDir);
		const shipped = await shippedAssets(consumerDir);
		const probe = await importProbe(consumerDir);
		return {
			name,
			manager,
			guided: Boolean(override),
			installExit: install.status,
			installNote: install.status === 0 ? "" : `${install.stdout ?? ""}${install.stderr ?? ""}`.split("\n").filter(Boolean).slice(-3).join(" | "),
			copies,
			shipped,
			importOk: probe.importOk,
			probeNote: probe.output,
		};
	} finally {
		await rm(consumerDir, { recursive: true, force: true });
	}
}

const run = async () => {
	const tarball = await packTarball();
	const result = { checkedAt: new Date().toISOString(), tarball, scenarios: [] };
	const assertHealthy = (scenario) => {
		const shippedAll = Object.values(scenario.shipped ?? {}).every(Boolean) && Object.keys(scenario.shipped ?? {}).length > 0;
		const healthy = scenario.installExit === 0 && scenario.importOk && shippedAll
			&& scenario.copies.length > 0
			&& scenario.copies.every((copy) => /^1\.0\./.test(copy.version) && copy.carriesSymbol);
		const shippedGaps = Object.entries(scenario.shipped ?? {}).filter(([, present]) => !present).map(([label]) => label);
		return {
			healthy,
			failure: healthy ? "" : `install=${scenario.installExit}, importOk=${scenario.importOk}, shippedGaps=${JSON.stringify(shippedGaps)}, copies=${JSON.stringify(scenario.copies)}`,
		};
	};

	const bunGuided = await scenario("bun with documented consumer override", { manager: "bun", override: "~1.0.3", tarball });
	bunGuided.assert = assertHealthy(bunGuided);
	result.scenarios.push(bunGuided);

	if (npmAvailable()) {
		const npmGuided = await scenario("npm with documented consumer override", { manager: "npm", override: "~1.0.3", tarball });
		npmGuided.assert = assertHealthy(npmGuided);
		result.scenarios.push(npmGuided);
	}

	// Recorded, not asserted: documents what an unguided consumer receives
	// under the current registry state for each manager.
	const bunUnguided = await scenario("bun default (unguided, recorded)", { manager: "bun", tarball });
	bunUnguided.assert = { healthy: null, failure: "(recorded outcome, not asserted)" };
	result.scenarios.push(bunUnguided);

	if (npmAvailable()) {
		const npmUnguided = await scenario("npm default (unguided, recorded)", { manager: "npm", tarball });
		npmUnguided.assert = { healthy: null, failure: "(recorded outcome, not asserted)" };
		result.scenarios.push(npmUnguided);
	}

	result.ok = result.scenarios.every((scenario) => scenario.assert.healthy !== false);
	return result;
};

const result = await run();
const outPath = process.argv[2];
if (outPath) await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
