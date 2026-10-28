import { expect, test } from "bun:test";
import { normalizeTaskSize } from "../src/core/task-size.ts";

test("task size selection is opt-in and never inferred", () => {
	expect(normalizeTaskSize("small")).toBe("small");
	expect(normalizeTaskSize("standard")).toBe("standard");
	expect(normalizeTaskSize(undefined)).toBe("standard");
	expect(normalizeTaskSize("huge")).toBe("standard");
	expect(normalizeTaskSize({})).toBe("standard");
});
