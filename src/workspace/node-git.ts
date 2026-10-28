import { execFile } from "node:child_process";
import type { GitExec } from "./evidence.ts";

export const nodeGitExec: GitExec = (args, options) => new Promise((resolve, reject) => {
	execFile("git", args, { cwd: options.cwd, timeout: options.timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
		if (error && typeof error.code !== "number") return reject(error);
		resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout });
	});
});
