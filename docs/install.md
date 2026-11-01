# Fusion — install and operating guide

Fusion is a supervisor-executor orchestration extension that runs on two
harnesses with one shared policy core. This guide is the consolidated install
and operating documentation; each claim it makes is pinned by the repository's
own verification (see "Verifying your install" at the end).

## The two entrypoints

`package.json` exposes an explicit `exports` map — import paths a host can
rely on:

| Import | Loads | Consumer |
| --- | --- | --- |
| `pi-fusion-extension` | Pi extension (`src/index.ts`) | Pi hosts |
| `pi-fusion-extension/pi` | same file (alias) | Pi hosts |
| `pi-fusion-extension/opencode` | OpenCode plugin (`src/opencode/index.ts`) | OpenCode hosts |
| `pi-fusion-extension/package.json` | package metadata | tooling |
| `fusion-resolve` (bin) | operator ownership resolution CLI (`src/workspace/resolve.ts`, runs under bun) | operators, package installs |

The import graphs behind the two entrypoints are isolated and statically
pinned (`test/package-isolation.test.ts`): the OpenCode closure contains no
`src/pi/**`, never the Pi extension entry, and has **zero bare package
imports** (only `node:*` builtins); the Pi closure never reaches
`src/opencode/**`.

## Dependencies an install actually pulls

Every `@earendil-works/*` package and `typebox` is declared as an **optional
peer**. Consequences, verified through `test:consumer-install` from fresh
consumer directories (real tarball installs):

- **OpenCode-only install**: installs no Pi SDKs and no Pi Durable. The
  OpenCode plugin imports nothing but Node builtins, so nothing is missing at
  runtime.
- **Pi install**: the host must supply the Pi stack it already runs
  (`@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-durable`,
  `pi-tui`, `typebox`). These are optional peers — the host is responsible
  for them because it *is* the Pi runtime.
- **Compatibility constraint** (read before a fresh Pi-flavored install):
  `@earendil-works/pi-coding-agent@1.0.3` declares
  `@earendil-works/pi-codemode: ^1.0.3`, but its own dist needs symbols
  (`MCP_TYPESCRIPT_PREAMBLE`) that only the 1.0.x codemode line carries.
  Unguided resolution can pick a newer codemode and crash the Pi-side import
  chain. **Constrain it in the consumer's own package.json** — overrides are
  only honored where they are written:
  ```json
  { "overrides": { "@earendil-works/pi-codemode": "~1.0.3" } }
  ```
  `test:consumer-install` asserts this override green on both bun and npm and
  additionally records the unguided outcomes per manager (bun drifts and
  crashes today; npm currently resolves in-window because fusion's optional
  peer participates in its placement). This range gap is an upstream issue;
  if upstream tightens the declared range, the recorded rows turn green
  without any change here.

## Installing for Pi

1. Install `pi-fusion-extension` into the Pi host (or workspace). A Pi host
   resolves the extension from the targets listed in the package manifest's
   `pi.extensions` field — `./src/index.ts`, the extension's default export.
   The package also ships a project-local discovery file,
   `.pi/extensions/fusion.ts`, which re-exports that same extension; both
   forms are pinned by `test:pi-load`, which loads the manifest targets
   exactly as the manifest states them and asserts the shim re-exports the
   same module.
2. Ensure the Pi stack versions are compatible (see the codemode constraint
   above). Development pins validated in this repository:
   `@earendil-works/*` 1.0.3, `typebox` 1.3.27.
3. Point every Pi process that may touch the same workspaces at the same
   ownership directory (below).

Registration surface a Pi host sees — tools: `fusion_delegate`,
`fusion_scout`; commands: `fusion`, `fusion-config`, `fusion-mode`,
`fusion-status`, `fusion-stats`, `fusion-resume`, `fusion-resolve`,
`fusion-clean`; events: `input`, `agent_end`, `agent_before_settle`,
`agent_settled`, `session_start`, `session_shutdown`.

Run state is written under the Pi agent directory (`fusion/runs`), scoped to
the host; the ownership registry is shared across harnesses (below).

## Installing for OpenCode

### Downloading a GitHub Actions package

Run **Package OpenCode plugin** from the repository's Actions tab (Run
workflow). The workflow also runs for `v*` tags and relevant pull requests.
It checks package isolation and a clean consumer install, then uploads
`fusion-opencode-<commit>` containing the package tarball and `SHA256SUMS`.
Download and extract that artifact, then install it from your project:

```sh
sha256sum -c /path/to/extracted-artifact/SHA256SUMS # run from the extracted directory
cd /path/to/your/project
bun add /path/to/extracted-artifact/pi-fusion-extension-0.1.0.tgz
mkdir -p .opencode/plugins .opencode/agents
printf '%s\n' 'export { default } from "pi-fusion-extension/opencode";' > .opencode/plugins/fusion.ts
cp node_modules/pi-fusion-extension/examples/opencode/agents/*.md .opencode/agents/
```

Use the tarball filename from your downloaded artifact if its version differs.
Restart OpenCode in that project and start with `/fusion-run <task>`.
This workflow uploads build artifacts; it does not publish to npm or create a
GitHub release. The package contains both harness entrypoints; loading
`/opencode` requires no Pi dependencies.

**Supported versions: OpenCode v2.2.3 – v2.2.5.** The plugin API is
hand-mirrored in `src/opencode/index.ts` — there is no `@opencode-ai`
dependency — so an OpenCode release outside this range must be re-pinned and
its surfaces reverified (plugin tools/commands, `session.execution.*` and
`session.text.ended` events, `session.prompt`, catalog shape) before it can
be declared supported. This boundary is deliberate honesty, not a bug.

1. Install the package and load the plugin through the `./opencode` entry —
   a project-local discovered plugin that re-exports it:
   ```ts
   // .opencode/plugins/fusion.ts
   export { default } from "pi-fusion-extension/opencode";
   ```
   (The parity fixture uses the equivalent copied-checkout form: it copies
   `src` into the project `.opencode/fusion` and re-exports
   `../fusion/opencode/index.ts` — both shapes load the same entry.)
2. Copy the three agent definitions into the project's `.opencode/agents/`:
   - `fusion.md` — primary supervisor agent; grants subagents only for the
     two Fusion subagents and denies direct subagents otherwise.
   - `fusion-executor.md` — subagent that implements the decided brief and is
     denied every Fusion control except its tool surface.
   - `fusion-scout.md` — read-only investigation subagent.
   The agent files ship in the published package
   (`node_modules/pi-fusion-extension/examples/opencode/agents/` in an
   install; `examples/opencode/agents/` in this checkout).
   These are the exact agent files the live parity fixture ran with
   (`opencode-go/glm-5.3-flash`, OpenCode v2.2.5). Other permission
   inheritance shapes remain unverified.
3. **Credentials — gateway models need a credential PAIR.** A serve-mode
   gateway model (e.g. `opencode-go/glm-5.3-flash`) requires two rows in the
   host credential store: the provider API key **and** the opencode account
   credential. A bare provider key is rejected by the workspace policy. This
   is a recorded M6.6 finding from the live parity run.

## Configuration

| Setting | Meaning | Default |
| --- | --- | --- |
| `FUSION_OWNERSHIP_DIR` | Directory of the cross-process workspace-claim registry (SQLite). Must be a private directory owned by the current user (mode 0700), and **the same for every Pi and OpenCode process working on the same workspaces** | `~/.local/state/fusion/ownership` |

Model/variant selection is not an env var: `fusion_configure` (OpenCode
plugin tool) and `fusion-config` (Pi command) validate a model against the
live catalog of the installed host and apply it, shared price/cohort metadata
reported. Configure also reaches the scout and executor submissions.

## Operating

OpenCode (user-facing commands): `fusion-run` — starts a run,
`fusion-mode` — persistent mode gate, `fusion-status`, `fusion-stats`,
`fusion-resume`, `fusion-clean`. The supervisor calls `fusion_reset` itself
at summary time unless the task says otherwise.

Pi: the `fusion` command starts a run; `fusion-status` / `fusion-stats` /
`fusion-resume` / `fusion-clean` mirror the OpenCode controls;
`fusion-resolve` runs operator resolution (below).

Persistent mode keeps the `fusion` agent and Fusion tools available between
runs. A persistent-mode run settles to `runActive: true` with
`phase: "complete"` and is releasable by `fusion-clean`; an unfinished run is
refused. Treat both active values when inspecting state.

`fusion-stats` reports real worker token/cost totals from observed
`session.usage.updated` deltas, aggregated per turn and persisted across
reload. Turns whose readings are missing are counted, not guessed — the
summary is `complete: false` until every reporting turn is covered, and the
summable fields (`inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `reasoningTokens`, `cost`) each track
per-field turn coverage (`fieldTurns`).

Every run completes with a final message carrying the heading
`## Fusion summary`.

## Recovery: what is automatic, what needs an operator, what is blocked

**Automatic** (unit-pinned and live-observed): pending-turn semantics with
settle/uncertain transitions on submission failures; bounded settle nudges
(event-time cancellation is unconditional on interrupts/failures); stale-run
detection across reload; early-settlement prevention so a supervisor cannot
prematurely finish a delegation sequence.

**Operator resolution.** `/fusion-resume` is a **user-facing command**
(OpenCode `/fusion-resume`; Pi `fusion-resume`) that presents the owner run,
the pending request, outstanding work, and the reconciliation capability.
Its presentation routes the next step; it is not the reconcile itself:

- When exact completion proof can exist, the presentation directs the fusion
  supervisor session to call the model-facing tool `fusion_reconcile` —
  which exists as a Fusion tool the supervisor calls by choice, never as a
  user slash command (e.g. across reload with retained intent but no proof,
  automatic retry stays disabled).
- Otherwise it quotes the operator resolution command (below).

**Operator resolution command.** In the repository/checkout install — the
shape the live parity fixture verified — the presentation quotes:

```
bun src/workspace/resolve.ts <workspace> <run-id> <request-id|--no-request-id> --confirm-stopped
```

For a package install the same script ships and is exposed as the
`fusion-resolve` bin — run it with exactly the arguments the presentation
carried:

```
./node_modules/.bin/fusion-resolve <workspace> <run-id> <request-id|--no-request-id> --confirm-stopped
bunx --bun fusion-resolve <workspace> <run-id> <request-id|--no-request-id> --confirm-stopped
```

(The bin has a `#!/usr/bin/env bun` shebang, so the TypeScript executes
under bun in both forms.) Honest limitation: the text quoted inside the
tool presentation assumes the checkout install — the only live-verified
shape so far; on a package install, follow the presented arguments through
one of the bin invocations above.

Pass the run's pending request id when one exists; pass `--no-request-id`
when nothing is retained. Every argument is POSIX-quoted by the presentation
exactly as it should be typed.

**Blocked upstream (not fixable in this repository).** Recovery from a
restart that lost the completion notification depends on parental-completion
delivery after restart — tracked upstream as anomalyco/opencode#36349. The
related parent-completion stall (a supervisor turn left open after its
executor child finished) reproduces live and is recovered by the parity
fixture via interrupt → `fusion-clean` → reissue. Re-run the opt-in fixtures
after any upstream restart-delivery change.

## Verifying your install

Model-free (always safe to run):

| Check | Command |
| --- | --- |
| Full unit + probe suites (both harnesses, real-SDK durable probes) | `bun test` |
| Types | `bun run typecheck` |
| OpenCode registration/catalog/configure/run-start smoke (v2.2.x host) | `bun run test:opencode-smoke` |
| Pi extension install-shim load | `bun run test:pi-load` |
| Real cross-process workspace-claim hold | `bun run test:ownership-cross-process` |
| Dependency contract (entrypoints, closure isolation, consumer pins) | `bun test test/package-isolation.test.ts` |
| Clean-install smoke (local tarball, model-free, registry-free): bare consumer installs no Pi SDK, loads `./opencode`, Pi entry honestly refused | `bun run test:clean-install` |
| Parse-only syntax gate (Bun-native, replaces `node --check`) | `bun run test:syntax` |

Network/opt-in (consumes something — registry or model usage):

| Check | Command |
| --- | --- |
| Fresh-consumer dependency contract (real installs; asserts consumer override on bun+npm) | `bun run test:consumer-install` |
| Full OpenCode parity workflow live (`opencode-go/glm-5.3-flash`, two runs) | `bun run test:opencode-parity` |
| Full Pi acceptance workflow live (real Pi SDK executor/scout sessions; supervisor fixture-driven — real-worker integration, not native supervisor acceptance; `--model zai/glm-5.3-flash`, `--supervisor opencode-go/gemini-4-argon` defaults) | `bun run test:pi-parity` |

### Integration artifacts

Every integration fixture writes a **sanitized artifact** to `artifacts/`
under the repository root (local-only, gitignored; override with
`FUSION_ARTIFACT_DIR`): `test:clean-install`, `test:consumer-install`,
`test:opencode-parity`, and `test:pi-parity` each emit
`artifacts/<fixture>-<timestamp>.json` on success and failure. Artifacts use
one schema (`fusion-integration-artifact/1`) and carry the fixture name,
generation time, tool versions (bun/node; manager versions for consumer
installs; `pi-coding-agent` for Pi runs; the OpenCode host version for
parity runs), the model(s) used, run/request/child identities, the scoped
assertions, and the outcomes. Sanitization: absolute user and temp paths are
reduced to markers, the parity fixtures redact credential material before
writing, and artifacts never contain transcript bodies or prompt text.
