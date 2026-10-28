import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Pi delegation handles submission failures using the shared controller", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-pi-controller-"));
	try {
		const child = Bun.spawn([process.execPath, "test", resolve(import.meta.dir, "integration/pi-controller-probe.mjs")], {
			stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, FUSION_PI_TEST_DIR: root, PI_CODING_AGENT_DIR: root },
		});
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30000);
