// Deliberately crosses the M7.1 boundary: this fixture's import graph
// reaches Pi sources (src/pi/**) and imports an SDK as a bare package.
// It exists only so test/package-isolation.test.ts can prove the boundary
// rules DETECT violations instead of passing vacuously on wrong path
// prefixes; it is never executed.
import "../../src/pi/worker-runtime.ts";
import "@earendil-works/pi-ai";

export {};
