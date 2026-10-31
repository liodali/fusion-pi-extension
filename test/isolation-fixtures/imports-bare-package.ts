// Deliberately violates the M7.1 exact-.ts convention for the bare-side
// check: a non-.ts relative specifier must be reported as a convention
// violation, and a bare package import must be flagged. Only read by
// test/package-isolation.test.ts; never executed.
import "typebox";

export {};
