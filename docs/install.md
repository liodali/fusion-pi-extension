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
`fusion_scout`, `fusion_stop`; commands: `fusion`, `fusion-config`, `fusion-mode`,
`fusion-status`, `fusion-stats`, `fusion-resume`, `fusion-resolve`,
`fusion-clean`; events: `input`, `agent_end`, `agent_before_settle`,
`agent_settled`, `session_start`, `session_shutdown`.

Run state is written under the Pi agent directory (`fusion/runs`), scoped to
the host; the ownership registry is shared across harnesses (below).

## Installing for OpenCode

### Native Git install (Fusion 0.1.1+, OpenCode v2.2.5)

```sh
opencode plugin add 'github:liodali/fusion-pi-extension#v0.1.3'
```

This installs into OpenCode's global plugin configuration. Restart OpenCode
in your workspace, then use `/fusion-config` and `/fusion-run <task>`.
All three agents are registered automatically; no wrapper or Markdown copy
is needed. Remove any previous Fusion wrapper before enabling the package.
The referenced release tag must exist on GitHub. To use the development
branch after these changes are pushed, replace `#v0.1.3` with `#main`.

The Git package preserves its Pi default export and supplies OpenCode through
`exports["./server"]`, which OpenCode v2.2.5 prefers over `exports["."]`.
The model-free native fixture verifies this with Fusion's actual package
assets in a throwaway Git repository, in addition to the Pi load checks.
The dedicated artifact/npm package below remains supported.

There are two supported shapes: the **dedicated `fusion-opencode` package**
(preferred — the plugin contributes its agents itself, nothing to copy) and
the **legacy manual install** (copy the agent Markdown files yourself). Do
not mix them: on OpenCode v2.2.5 a Markdown-defined agent keeps precedence
over the plugin's contribution, so leftover copies silently override the
plugin's definitions. `/fusion-status` reports such conflicts.

### Dedicated package (preferred)

Once the package is published, install it through OpenCode's native plugin
manager:

```sh
opencode plugin add fusion-opencode
```

Until then, use the package built by the **Package OpenCode plugin** workflow
(see below): the `fusion-opencode-<commit>` artifact contains
`fusion-opencode-<version>.tgz`. Install it as your project's plugin:

```sh
sha256sum -c /path/to/extracted-artifact/SHA256SUMS # run from the extracted directory
cd /path/to/your/project
bun add /path/to/extracted-artifact/fusion-opencode-<version>.tgz
```

Then add the plugin to your project's `opencode.json(c)`. **Append to the
existing `plugins` array — do not replace the file**, or you will lose your
configured providers, plugins, and permissions:

```jsonc
// opencode.jsonc — merge into your existing configuration
{
  // ...your existing providers, permissions, and other settings...
  "plugins": [
    // ...your existing plugin entries, if any...
    "./node_modules/fusion-opencode"
  ]
}
```

Only if the project has no configuration file at all:

```sh
printf '{"plugins":["./node_modules/fusion-opencode"]}\n' > opencode.json
```

Restart OpenCode in that project. The plugin registers the `fusion`,
`fusion-executor`, and `fusion-scout` agents natively (no
`.opencode/agents/` copies needed), together with the Fusion tools and
`/fusion-run`, `/fusion-config`, `/fusion-status`, `/fusion-stats`,
`/fusion-resume`, `/fusion-clean`, and `/fusion-mode` commands. The package
has no dependencies — no Pi SDKs and no `@opencode/plugin` SDK — and loading
it through the native `plugins` entry, an empty-agent project, and a full
model-free run lifecycle are covered by `bun run test:opencode-package-load`.

The development version additionally provides `/fusion-stop` and an executor
activity card for OpenCode 2.2.5. They are not part of the v0.1.3 tag.

### Downloading a GitHub Actions package

Run **Package OpenCode plugin** from the repository's Actions tab (Run
workflow). The workflow also runs for `v*` tags and relevant pull requests.
It checks package isolation and a clean consumer install, verifies the
native host surfaces (`test:opencode-native`), loads the exact dedicated
tarball through the real package loader (`test:opencode-package-load`), and
uploads `fusion-opencode-<commit>` containing both package tarballs
(`pi-fusion-extension` and `fusion-opencode`) plus `SHA256SUMS`.

This workflow uploads build artifacts; it does not publish to npm or create a
GitHub release. `opencode plugin add` accepts Git sources as shown above and
published npm packages; it does not accept the downloaded tarball directly.
The artifact path configures the installed local `node_modules` directory
through `opencode.json` instead.

**Supported versions: OpenCode v2.2.3 – v2.2.5.** The plugin API is
hand-mirrored in `src/opencode/index.ts` — there is no `@opencode-ai`
dependency — so an OpenCode release outside this range must be re-pinned and
its surfaces reverified (plugin tools/commands, `session.execution.*` and
`session.text.ended` events, `session.prompt`, catalog shape) before it can
be declared supported. Native agent contribution
(`ctx.agent.transform`, update-on-missing semantics, Markdown precedence,
lazy per-location activation) is verified live on v2.2.5 and recorded in
`docs/opencode-install-and-config-plan.md`; on hosts without that surface the
plugin skips contribution silently and the legacy agent files below are
required. This boundary is deliberate honesty, not a bug.

### Legacy manual install (Pi package + copied agents)

1. Install the Pi-shaped package and load the plugin through the `./opencode`
   entry — a project-local discovered plugin that re-exports it:
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
   The agent files are generated from the same definitions the plugin
   contributes natively (`src/opencode/agents.ts`; regenerate with
   `bun run generate:agent-markdown`, kept in sync by
   `test/opencode-agents.test.ts`) and ship in both packages
   (`node_modules/pi-fusion-extension/examples/opencode/agents/` or
   `node_modules/fusion-opencode/examples/opencode/agents/` in an install;
   `examples/opencode/agents/` in this checkout).
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

Model/variant selection is not an env var: on OpenCode, the `/fusion-config`
command (`/fusion-config` shows the saved preference and syntax;
`/fusion-config list [filter]` lists catalog choices with variants, bounded to
40 lines; `/fusion-config <provider>/<model> [variant]` selects — split on the
first slash so model IDs containing slashes work) and the `fusion_configure`
tool the supervisor can call share one serialized operation that validates
against the live host catalog before mutating anything, persists the
preference across restarts, and applies it to the current run only while no
executor/scout work has started (otherwise it is saved for the next run).
Invalid input changes nothing. On Pi, `fusion-config` is the equivalent
command. The executor and the scout share the chosen model; the supervisor's
model stays the host's own selector.

## Operating

OpenCode (user-facing commands): `fusion-run` — starts a run,
`fusion-mode` — persistent mode gate, `fusion-status`, `fusion-stats`,
`fusion-resume`, `fusion-clean`. The supervisor calls `fusion_reset` itself
at summary time unless the task says otherwise.

In the development version, use `/fusion-stop`, click **Stop executor** in the
activity card, or ask the Fusion supervisor to stop its executor. The stop
request targets the current supervisor's child and reports the last observed
tool activity without an extra model call. An acknowledged request is not
proof of termination. Partial changes remain in the working tree; check
`/fusion-status` and `/fusion-resume`, inspect the changes, and follow the
reconciliation or operator-resolution instructions before cleanup. Background
activity may be unavailable until a completion notification is reconciled.

On Pi, asking the supervisor to stop calls the `fusion_stop` tool: it aborts
a live executor conversation (durable or session backend), marks the run
stopped so further executor and scout work is refused, and returns a
deterministic recap — last observed activity, pending request, abort
delivery, and the `/fusion-resume` / `/fusion-resolve` / `/fusion-clean`
recovery path. No model summarizes the stop.

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
under bun in both forms.) The text quoted inside the tool presentation
assumes the checkout install; on a package install, follow the presented arguments through
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
| Native agent/command surfaces, reload, and isolated package-manager removal/reinstall (OpenCode v2.2.5) | `bun run test:opencode-native` |
| Actual per-turn Fusion tool visibility with mode off/on and Build → Fusion switching, aborted before model requests | `bun run test:opencode-tool-visibility` |
| Dedicated package load, configuration persistence across restart, recovery CLI, and legacy-agent coexistence | `bun run test:opencode-package-load` |
| Real cross-process workspace-claim hold | `bun run test:ownership-cross-process` |
| Dependency contract (entrypoints, closure isolation, consumer pins) | `bun test test/package-isolation.test.ts` |
| Clean-install smoke (local tarball, model-free, registry-free): bare consumer installs no Pi SDK, loads `./opencode`, Pi entry honestly refused | `bun run test:clean-install` |
| Parse-only syntax gate (Bun-native, replaces `node --check`) | `bun run test:syntax` |

To verify one dedicated artifact throughout acceptance, build and pack it once:

```sh
bun run build:opencode-package
npm pack ./dist/fusion-opencode --pack-destination dist
export FUSION_OPENCODE_TARBALL="$PWD/dist/fusion-opencode-$(bun -p 'require("./package.json").version').tgz"
bun run test:opencode-package-load
```

Keep that variable set for `bun run test:opencode-parity` below. Both reports
record its SHA-256, so the model-free and live results can be matched to the
same tarball. Parity uses existing provider credentials in an isolated test
workspace and consumes model usage. The native package-manager fixture uses
a throwaway Git probe package and a snapshot of Fusion's real dual-harness
package; neither check changes your global OpenCode configuration.

Network/opt-in (consumes something — registry or model usage):

| Check | Command |
| --- | --- |
| Fresh-consumer dependency contract (real installs; asserts consumer override on bun+npm) | `bun run test:consumer-install` |
| Full OpenCode parity workflow live (`opencode-go/glm-5.3-flash`, two runs) | `bun run test:opencode-parity` |
| Full Pi acceptance workflow live (real Pi SDK executor/scout sessions; supervisor fixture-driven — real-worker integration, not native supervisor acceptance; `--model zai/glm-5.3-flash`, `--supervisor opencode-go/gemini-4-argon` defaults) | `bun run test:pi-parity` |

### Integration artifacts

If the supervisor says Fusion tools are unavailable, stop the turn and run
`/fusion-config` in that same session. Versions 0.1.3 and later show
the instance's loaded mode and the Fusion tools left by its last context
hook. This is diagnostic evidence, not a live model turn or a claim about
later filters from other plugins. With mode on, a Fusion turn should include
`fusion_start`, `fusion_scout`, and `fusion_delegate`; Build should receive
no Fusion tools. Earlier rejected Build calls do not establish current Fusion
tool availability. The native visibility fixture checks these states without
credentials, model requests, or project edits.

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
