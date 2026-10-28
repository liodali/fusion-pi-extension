import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Pi Durable recovery matches the original request and transcript", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-durable-recovery-"));
	try {
		const child = Bun.spawn([process.execPath, "test", resolve(import.meta.dir, "integration/durable-recovery-probe.mjs")], {
			stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, FUSION_PI_TEST_DIR: root },
		});
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" });
	} finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

test("Pi Durable recovery uses the real SDK and a disposable SQLite database", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-durable-sqlite-"));
	try {
		const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "integration/durable-sqlite-probe.mjs")], {
			stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: root },
		});
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" });
	} finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
