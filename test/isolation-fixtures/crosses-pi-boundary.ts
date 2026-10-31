// Deliberately crosses the M7.1 boundary from the Pi side: this fixture's
// import graph reaches OpenCode sources (src/opencode/**) and must be
// flagged by the Pi-side boundary rules in test/package-isolation.test.ts.
// Only read by that test; never executed.
import "../../src/opencode/index.ts";

export {};
