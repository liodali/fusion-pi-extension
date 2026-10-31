#!/usr/bin/env bun
// Parse-only syntax gate: Bun-native equivalent of `node --check`. Each
// given file is parsed with Bun.Transpiler without executing it, resolving
// imports, or touching the network — so a typo is caught for free before a
// model-consuming fixture spends a run. Loader is chosen from the file
// extension; parse errors print the file and exit 1.
const files = process.argv.slice(2);
if (files.length === 0) {
	console.error("usage: bun scripts/check-syntax.mjs <file...>");
	process.exit(1);
}
let failed = false;
for (const file of files) {
	const source = await Bun.file(file).text();
	const loader = file.endsWith(".mts") ? "mts" : file.endsWith(".mjs") ? "mjs" : "ts";
	try {
		new Bun.Transpiler({ loader }).transformSync(source);
		console.log(`syntax ok: ${file}`);
	} catch (error) {
		failed = true;
		console.error(`syntax error in ${file}: ${String(error).split("\n")[0]}`);
	}
}
process.exit(failed ? 1 : 0);
