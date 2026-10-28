import { describe, expect, test } from "bun:test";
import { pendingSubmission, staleWork } from "../src/pi/durable/stale.ts";

describe("staleWork", () => {
	test("selects submissions and tasks outside the protected set", () => {
		const inspection = {
			submissions: [
				{ id: 1, conversationId: 10 },
				{ id: 2, conversationId: 20 },
			],
			tasks: [
				{ record: { id: 3, conversationId: 10 } },
				{ record: { id: 4, conversationId: 30 } },
			],
		};
		expect(staleWork(inspection, new Set([10]))).toEqual({
			submissions: [2],
			tasks: [4],
		});
	});

	test("returns nothing when every conversation is protected", () => {
		const inspection = {
			submissions: [{ id: 1, conversationId: 10 }],
			tasks: [{ record: { id: 2, conversationId: 10 } }],
		};
		expect(staleWork(inspection, new Set([10]))).toEqual({
			submissions: [],
			tasks: [],
		});
	});
});

describe("pendingSubmission", () => {
	test("returns the latest live submission of the conversation", () => {
		const inspection = {
			submissions: [
				{ id: 1, conversationId: 10 },
				{ id: 5, conversationId: 10 },
				{ id: 7, conversationId: 20 },
			],
			tasks: [],
		};
		expect(pendingSubmission(inspection, 10)).toBe(5);
	});

	test("ignores other conversations and returns undefined when none is pending", () => {
		const inspection = {
			submissions: [{ id: 3, conversationId: 20 }],
			tasks: [],
		};
		expect(pendingSubmission(inspection, 10)).toBeUndefined();
		expect(pendingSubmission({ submissions: [] }, 10)).toBeUndefined();
	});
});
