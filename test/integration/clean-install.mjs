// Clean-install smoke (M7.4), model-free and registry-free: from a packed
// tarball of this package, a bare consumer directory installs ONLY
// fusion-harness-extension (no Pi stack) and must be able to load the OpenCode
// plugin entry — proving at runtime that the OpenCode path imports no Pi
// SDKs (if it did, this bare install could not load it). The Pi entry is
// expected NOT to load in this shape: it requires the host's Pi stack, and
// the failure mode is recorded as the honest capability boundary. Also
// verifies the published assets the install guide depends on. The full
// Pi-stack consumer matrix (guided/unguided, both package managers) lives
// in test:consumer-install.
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeArtifact } from "./artifact.mjs";

const repo = resolve(import.meta.dirname, "../..");
const result = { ok: false };
const failures = [];
const check = (label, condition, detail = "") => {
	if (condition) return;
	failures.push(`${label}${detail ? `: ${detail}` : ""}`);
};

const packTarball = async () => {
	const dest = await mkdtemp(join(tmpdir(), "fusion-pack-"));
	const pack = spawnSync("npm", ["pack", repo, "--json", "--pack-destination", dest], { encoding: "utf8" });
	if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stdout} ${pack.stderr}`);
	return join(dest, JSON.parse(pack.stdout)[0].filename);
};

const root = await mkdtemp(join(tmpdir(), "fusion-clean-install-"));
try {
	// A bare consumer: only the fusion tarball, nothing else.
	const consumerDir = join(root, "consumer");
	await mkdir(consumerDir, { recursive: true });
	const tarball = await packTarball();
	await cp(tarball, join(consumerDir, "fusion.tgz"));
	await writeFile(join(consumerDir, "package.json"), `${JSON.stringify({ name: "fusion-clean-install", private: true, type: "module", dependencies: { "fusion-harness-extension": "file:./fusion.tgz" } }, null, 2)}\n`);
	const install = spawnSync("bun", ["install"], { cwd: consumerDir, encoding: "utf8" });
	result.installExit = install.status;
	check("bun install of the bare tarball succeeds", install.status === 0, `${install.stdout ?? ""}${install.stderr ?? ""}`.split("\n").slice(-3).join(" | "));

	const pkgRoot = join(consumerDir, "node_modules/fusion-harness-extension");
	const assets = {
		"agent fusion.md": join(pkgRoot, "examples/opencode/agents/fusion.md"),
		"agent fusion-executor.md": join(pkgRoot, "examples/opencode/agents/fusion-executor.md"),
		"agent fusion-scout.md": join(pkgRoot, "examples/opencode/agents/fusion-scout.md"),
		"install guide": join(pkgRoot, "docs/install.md"),
		"Pi discovery shim": join(pkgRoot, ".pi/extensions/fusion.ts"),
		"operator CLI": join(pkgRoot, "src/workspace/resolve.ts"),
	};
	result.shippedAssets = {};
	for (const [label, path] of Object.entries(assets)) {
		try { await stat(path); result.shippedAssets[label] = true; }
		catch { result.shippedAssets[label] = false; check(`published asset ${label}`, false); }
	}

	// No Pi SDK may be installed in this bare consumer — each package is
	// checked at its actual install path (scoped packages under
	// @earendil-works/, typebox unscoped at the root).
	const prohibited = {
		"pi-coding-agent": "@earendil-works/pi-coding-agent",
		"pi-ai": "@earendil-works/pi-ai",
		"pi-durable": "@earendil-works/pi-durable",
		"pi-agent-core": "@earendil-works/pi-agent-core",
		"pi-codemode": "@earendil-works/pi-codemode",
		"pi-tui": "@earendil-works/pi-tui",
		typebox: "typebox",
	};
	result.prohibitedInstalls = {};
	for (const [name, relativePath] of Object.entries(prohibited)) {
		let present = false;
		try {
			await stat(join(consumerDir, "node_modules", relativePath));
			present = true;
			check(`bare install must not install ${name}`, false);
		} catch {}
		result.prohibitedInstalls[name] = present;
	}

	// The OpenCode entry loads in the bare install — the runtime proof of
	// "no Pi SDK imports" behind the ./opencode entrypoint.
	const loadOpenCode = spawnSync("bun", ["-e", `
		const plugin = (await import("fusion-harness-extension/opencode")).default;
		if (plugin?.id !== "fusion" || typeof plugin?.setup !== "function") throw new Error("unexpected plugin shape: " + JSON.stringify(Object.keys(plugin ?? {})));
		console.log("OPENCODE-ENTRY-OK");
	`], { cwd: consumerDir, encoding: "utf8" });
	const loadOutput = `${loadOpenCode.stdout ?? ""}${loadOpenCode.stderr ?? ""}`.trim();
	result.opencodeEntryLoads = loadOpenCode.status === 0 && loadOutput.includes("OPENCODE-ENTRY-OK");
	check("the ./opencode entry loads in a bare (no-Pi-stack) install", result.opencodeEntryLoads, loadOutput.split("\n").slice(-2).join(" | "));

	// The Pi entry must NOT load in this shape: it needs the host's Pi
	// stack. The recorded failure mode is the honest boundary.
	const loadPi = spawnSync("bun", ["-e", "await import('fusion-harness-extension'); console.log('PI-ENTRY-LOADED')"], { cwd: consumerDir, encoding: "utf8" });
	const piOutput = `${loadPi.stdout ?? ""}${loadPi.stderr ?? ""}`.trim();
	result.piEntryRefusedInBareInstall = loadPi.status !== 0;
	result.piEntryFailureHead = piOutput.split("\n").find((line) => /Cannot find module|error/i.test(line))?.slice(0, 160) ?? piOutput.slice(0, 160);
	check("the Pi entry honestly fails in a bare install (host stack required)", result.piEntryRefusedInBareInstall, result.piEntryFailureHead);

	// The installed operator CLI must actually execute from the consumer
	// directory: the generated bin shim exists, carries the bun shebang, and
	// invoking it with invalid arguments runs the script's argument
	// validation (usage text + exit 2) — proving the shipped TypeScript CLI
	// and its imports load from an installed copy.
	const binPath = join(consumerDir, "node_modules/.bin/fusion-resolve");
	result.operatorCli = {};
	try {
		const binStat = await stat(binPath);
		result.operatorCli.binPresent = binStat.isFile();
	} catch {
		result.operatorCli.binPresent = false;
	}
	if (result.operatorCli.binPresent) {
		result.operatorCli.shebang = (await readFile(binPath, "utf8")).split("\n")[0];
		const usage = spawnSync(binPath, [], { cwd: consumerDir, encoding: "utf8" });
		result.operatorCli.usageExit = usage.status;
		result.operatorCli.usageStderr = (usage.stderr ?? "").split("\n").find((line) => line.includes("Usage:"))?.slice(0, 160) ?? "";
	}
	check("the operator CLI bin shim exists after install", result.operatorCli.binPresent === true);
	check("the operator CLI runs under its bun shebang", result.operatorCli.shebang === "#!/usr/bin/env bun", String(result.operatorCli.shebang));
	check("invalid CLI arguments produce the usage response", result.operatorCli.usageExit === 2 && result.operatorCli.usageStderr.includes("Usage: fusion-resolve"), `exit=${result.operatorCli.usageExit} stderr=${result.operatorCli.usageStderr}`);

	result.ok = failures.length === 0;
	result.failures = failures;
	result.sanitized = { tarball: "fusion.tgz (packed from this checkout)" };
	const artifactPath = await writeArtifact("clean-install", result);
	console.log(JSON.stringify({ ...result, artifact: artifactPath }, null, 2));
	if (!result.ok) process.exitCode = 1;
} catch (error) {
	result.ok = false;
	result.failures = failures;
	result.error = String(error?.stack ?? error);
	// Failures preserve evidence too: the artifact is written on every exit
	// path, not only on success.
	try { result.artifact = await writeArtifact("clean-install", result); } catch {}
	console.log(JSON.stringify(result, null, 2));
	process.exitCode = 1;
} finally {
	await rm(root, { recursive: true, force: true });
}
