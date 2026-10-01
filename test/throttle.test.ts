import { describe, expect, test } from "bun:test";
import { createThrottle } from "../src/throttle.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("createThrottle", () => {
	test("coalesces rapid schedules into one trailing call", async () => {
		let calls = 0;
		const throttle = createThrottle(() => {
			calls += 1;
		}, 20);
		throttle.schedule();
		throttle.schedule();
		throttle.schedule();
		expect(calls).toBe(0);
		await sleep(50);
		expect(calls).toBe(1);
	});

	test("fires again once the window has elapsed", async () => {
		let calls = 0;
		const throttle = createThrottle(() => {
			calls += 1;
		}, 15);
		throttle.schedule();
		await sleep(40);
		throttle.schedule();
		await sleep(40);
		expect(calls).toBe(2);
	});

	test("flush runs immediately and clears the pending timer", async () => {
		let calls = 0;
		const throttle = createThrottle(() => {
			calls += 1;
		}, 50);
		throttle.schedule();
		throttle.flush();
		expect(calls).toBe(1);
		await sleep(80);
		expect(calls).toBe(1);
	});

	test("cancel drops the pending call", async () => {
		let calls = 0;
		const throttle = createThrottle(() => {
			calls += 1;
		}, 20);
		throttle.schedule();
		throttle.cancel();
		await sleep(50);
		expect(calls).toBe(0);
	});
});
