/** Task size selects the executor effort tier; each harness applies it natively. */
export type TaskSize = "small" | "standard";

/** The fast path is opt-in: absent, unknown, or invalid sizes stay standard. */
export function normalizeTaskSize(value: unknown): TaskSize {
	return value === "small" ? "small" : "standard";
}
