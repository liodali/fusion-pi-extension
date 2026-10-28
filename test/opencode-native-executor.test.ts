import { describe, expect, test } from "bun:test";
import { createNativeExecutor, type NativeSubagentInput, type NativeToolContext } from "../src/opencode/native-executor.ts";

function context(sessionID = "parent"): NativeToolContext & { agent: string; messageID: string; id: string } {
	return { sessionID, agent: "fusion", messageID: "message", id: "call", signal: new AbortController().signal, progress: async () => {} };
}

describe("OpenCode native executor adapter", () => {
	test("creates a child then continues it through the native tool", async () => {
		const inputs: NativeSubagentInput[] = [];
		const executor = createNativeExecutor<ReturnType<typeof context>>({ parentSessionID: "parent", agent: "fusion-executor", model: "provider/model#low", execute: async (input, ctx) => {
			inputs.push(input);
			expect(ctx.sessionID).toBe("parent");
			expect(ctx.id).toBe("call");
			await ctx.progress({ sessionID: "child", status: "running" });
			return { output: { sessionID: "child", status: "completed", output: "done" } };
		} });
		expect((await executor.prompt("implement", "Implement change", context())).output).toBe("done");
		await executor.prompt("revise", "Revise change", context());
		expect(inputs[0].sessionID).toBeUndefined();
		expect(inputs[1].sessionID).toBe("child");
		expect(inputs[0].model).toBe("provider/model#low");
		expect(inputs[0].background).toBe(false);
	});

	test("keeps the child reference when a native turn fails after creation", async () => {
		const executor = createNativeExecutor({ parentSessionID: "parent", agent: "fusion-executor", execute: async (_input, ctx) => {
			await ctx.progress({ sessionID: "child" });
			throw new Error("interrupted");
		} });
		await expect(executor.prompt("implement", "Implement", context())).rejects.toThrow("interrupted");
		expect(executor.childSessionID).toBe("child");
	});

	test("waits for a backgrounded foreground call before permitting a revision", async () => {
		let complete!: (output: string) => void;
		const settled = new Promise<string>((resolve) => { complete = resolve; });
		let calls = 0;
		const executor = createNativeExecutor({ parentSessionID: "parent", agent: "fusion-executor",
			execute: async (_input, ctx) => {
				calls++;
				await ctx.progress({ sessionID: "child" });
				return { output: { sessionID: "child", status: "running", output: "backgrounded" } };
			},
			waitForBackground: async (id) => { expect(id).toBe("child"); return settled; },
		});
		const initial = executor.prompt("implement", "Implement", context());
		await Promise.resolve();
		await expect(executor.prompt("revise", "Revise", context())).rejects.toThrow("already running");
		expect(calls).toBe(1);
		complete("final report");
		expect(await initial).toEqual({ sessionID: "child", status: "completed", output: "final report" });
		await executor.prompt("revise", "Revise", context());
		expect(calls).toBe(2);
	});

	test("keeps the child locked when settlement fails and allows reconciliation", async () => {
		let attempts = 0;
		const executor = createNativeExecutor({ parentSessionID: "parent", agent: "fusion-executor",
			execute: async () => ({ output: { sessionID: "child", status: "running", output: "backgrounded" } }),
			waitForBackground: async () => {
				if (++attempts === 1) throw new Error("wait interrupted");
				return "settled report";
			},
		});
		await expect(executor.prompt("implement", "Implement", context())).rejects.toThrow("wait interrupted");
		await expect(executor.prompt("revise", "Revise", context())).rejects.toThrow("awaiting settlement");
		await expect(executor.settleBackground(context("another"))).rejects.toThrow("different supervisor");
		expect(await executor.settleBackground(context())).toEqual({ sessionID: "child", status: "completed", output: "settled report" });
		await expect(executor.settleBackground(context())).rejects.toThrow("No background executor");
	});

	test("keeps delegation blocked when no background settlement handler is configured", async () => {
		const executor = createNativeExecutor({ parentSessionID: "parent", agent: "fusion-executor",
			execute: async () => ({ output: { sessionID: "child", status: "running", output: "backgrounded" } }),
		});
		await expect(executor.prompt("implement", "Implement", context())).rejects.toThrow("settlement handler");
		await expect(executor.prompt("revise", "Revise", context())).rejects.toThrow("awaiting settlement");
		expect((await executor.settleBackground(context(), async () => "recovered")).output).toBe("recovered");
	});

	test("rejects wrong parents, concurrent turns, and inconsistent native results", async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => { finish = resolve; });
		const executor = createNativeExecutor({ parentSessionID: "parent", agent: "fusion-executor", execute: async (_input, ctx) => {
			await ctx.progress({ sessionID: "child" });
			await pending;
			return { output: { sessionID: "other", status: "completed", output: "done" } };
		} });
		await expect(executor.prompt("work", "Work", context("another"))).rejects.toThrow("different supervisor");
		const first = executor.prompt("work", "Work", context());
		await expect(executor.prompt("more", "More", context())).rejects.toThrow("already running");
		finish();
		await expect(first).rejects.toThrow("different executor session");
	});
});
