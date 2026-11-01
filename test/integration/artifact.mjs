// Sanitized integration artifact writer (M7.4). One schema across the
// opt-in integration fixtures: every artifact carries the fixture name,
// schema version, generation time, tool versions, and the fixture's result
// (models, identities, assertions, outcomes) after sanitization.
//
// Sanitization policy: absolute user/temp paths are reduced to markers
// (basenames are kept where they carry meaning), and callers redact
// credentials before handing results over (the parity fixtures already
// redact auth material in their own output path). Artifacts never contain
// transcript bodies, prompt text, or credential material.
//
// Output location: artifacts/ under the repository root by default, or
// $FUSION_ARTIFACT_DIR. The directory is local-only (gitignored).
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ARTIFACT_SCHEMA = "fusion-integration-artifact/1";

const PATH_PATTERNS = [
	[/\/(?:private\/)?var\/folders\/[^\s"']+/g, "<tmp>"],
	[/\/tmp\/[^\s"']+/g, "<tmp>"],
	[new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + /[^\s"']*/.source, "g"), "<home>"],
];

export function sanitize(value) {
	if (typeof value === "string") {
		let text = value;
		for (const [pattern, marker] of PATH_PATTERNS) text = text.replace(pattern, marker);
		return text;
	}
	if (Array.isArray(value)) return value.map(sanitize);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value)) out[key] = sanitize(value[key]);
		return out;
	}
	return value;
}

// Credential redaction, centralized so every output and artifact write goes
// through the same choke point: each secret string (and any string embedding
// it, e.g. an authorization header) becomes "[redacted]". Path sanitization
// alone does not protect credentials — fixtures must pass their secrets here.
export function redactSecrets(value, secrets) {
	const apply = (text) => secrets.reduce((accumulated, secret) => accumulated.split(secret).join("[redacted]"), text);
	if (typeof value === "string") return apply(value);
	if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets));
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value)) out[key] = redactSecrets(value[key], secrets);
		return out;
	}
	return value;
}

export async function writeArtifact(name, payload, { directory, secrets = [] } = {}) {
	const dir = directory ?? process.env.FUSION_ARTIFACT_DIR ?? join(resolve(import.meta.dirname, "../.."), "artifacts");
	const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
	const artifact = {
		schema: ARTIFACT_SCHEMA,
		name,
		generatedAt: new Date().toISOString(),
		tools: { bun: Bun.version, node: process.versions.node },
		...sanitize(redactSecrets(payload, secrets.filter((secret) => typeof secret === "string" && secret.length > 0))),
	};
	const file = join(dir, `${name}-${stamp}.json`);
	await mkdir(dir, { recursive: true });
	await writeFile(file, `${JSON.stringify(artifact, null, 2)}\n`);
	return file;
}
