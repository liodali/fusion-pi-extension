# OpenCode installation and model configuration plan

Status: steps 1-5 complete. Step 1 live-probed on OpenCode v2.2.5; steps 2-4
implemented and covered by unit tests and model-free host fixtures; step 5's
integrated acceptance passed, including the opt-in model workflow on the
installed package. Git-source installation is now verified through the root
package's explicit `./server` export on OpenCode v2.2.5. Version 0.1.1 is
prepared; commit/push, tagging, and publication remain release actions.
v0.1.0 is not retagged.

## Outcome

A developer installs the OpenCode package through OpenCode's native plugin
manager, gets the Fusion supervisor/executor/scout without copying files, and
can configure the worker model with `/fusion-config` before starting a run.
Renamed to `fusion-harness-extension` (2026-11-04): the package was never published, so installs and `fusion-harness-extension/opencode` imports simply use the new name.

## 1. Verify the native extension surfaces

- [x] Probe the installed OpenCode 2.2.5 host in isolated config/data/state directories.
- [x] Verify native package loading, server export resolution, and Git package installation.
- [x] Establish how a package contributes NEW agents. The current server docs
  show `ctx.agent.transform` with get/update/remove/default but no add method;
  do not assume update creates an agent. Check the versioned implementation
  and prove the supported registration or package discovery mechanism live.
- [x] Verify command presentation and available model-selection UI surfaces.
  A searchable picker is a separate UI feature unless the host provides one.
- [x] Record exact supported host versions and API shapes in the readiness report.

Gate: a model-free fixture can install a minimal package and discover a new
primary agent and subagent. If native agent contribution is unavailable,
record that limitation and use an explicit initializer fallback; do not claim
one-command native setup is complete.

**Gate result: passed** — a model-free Git package installed through
`opencode plugin add` contributed a new subagent and a command with no file
copying. Full evidence in the readiness report below.

### Step 1 readiness report (verified live, OpenCode v2.2.5, 2026-11-01)

Environment: host binary v2.2.5 (`opencode serve` in throwaway
`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`/`HOME`),
SDK cross-checked against `@opencode/plugin@2.2.5` and `@opencode/schema@2.2.5`
type definitions.

Agent contribution — the mechanism the old docs left open:

- `ctx.agent.transform` editor methods are exactly `list`, `get`, `default`,
  `update`, `remove`. There is no `add` (live: `typeof editor.add ===
  "undefined"`; SDK `dist/promise/agent.d.ts` agrees).
- **`editor.update(id, fn)` on a missing ID creates the agent.** The callback
  receives an `Agent.Info.default(id)` draft: `{ id, name: id, request:
  { settings: {}, headers: {}, body: {} }, mode: "primary", hidden: false,
  permissions: [default policy set] }`. Set `mode: "subagent"` for subagents.
- Fields that survive on the created agent (schema `Agent.Info` 2.2.5):
  `system` (the prompt; there is no `prompt` field), `description`, `mode`
  (`"subagent" | "primary" | "all"`), `permissions: { action, resource,
  effect: "allow" | "deny" | "ask" }[]`, `model?`, `hidden`, `color?`,
  `steps?`. Assignments to non-schema fields are dropped. The host appends its
  own default `browser`/`skill(browser)` denies after custom permissions.
- Created agents are served by `GET /api/agent` and survive config-watch
  reloads without duplication (count stable across a touched plugin file).
- Both a local plugin (`.opencode/plugins/<dir>/index.ts`) and an installed
  package (below) contribute agents through the same transform.

Collision and precedence:

- Markdown-defined agents (`.opencode/agent/*.md`, loaded by the builtin
  `opencode.agent` plugin) **win over plugin contributions of the same ID**:
  a plugin `update` of an existing markdown agent leaves the markdown values
  in place, and a plugin `remove` of a markdown agent does not remove it.
- The plugin's transform callback *can see* the markdown agent via
  `editor.get(id)` (draft present), so conflict detection and warning are
  possible even though overriding is not. This becomes the step-3 collision
  policy: legacy manual installs keep precedence; Fusion reports conflicts.
- Verified with a local plugin; package plugins use the same transform
  system, but markdown-vs-package precedence as such was not separately run.

Lifecycle constraints discovered (all live-observed):

- The transform callback runs **after `setup` returns** (deferred registry
  rebuild). Do not mutate shared plugin state expecting the callback to have
  run synchronously.
- **Never await registry reads (`ctx.agent.list()`) inside `setup`** — the
  observed behavior is that setup does not complete (deadlock); reads after
  setup, e.g. from commands/tools, are fine.
- Plugin setup is **lazy per location**: during 90 s of idle server uptime no
  plugin code ran; setup executed immediately after the first HTTP API
  request for the location. Integration tests should hit an API endpoint
  (the existing smoke test's `/api/location` call does exactly this) and not
  assume boot-time activation.
- Watched-file changes re-run setup and re-apply transforms idempotently
  (no duplicate agents/commands).
- Transform registrations return `{ dispose() }` for agent and command
  transforms — owned registrations can be disposed on unload.

Package installation (native manager, isolated config):

- `opencode plugin add "git+file://<bare-repo>.git#main"` installs the
  package, pins the resolved commit (e.g. `dc171ce…`), and appends the spec
  to `plugins` in the **global** `config/opencode/opencode.json`. npm specs,
  hosted Git shortcuts, SSH/HTTPS, and `::path:` subdirectory selectors are
  documented; `git+file://` was proven live here.
- The installed package's server part resolved through `package.json`
  `exports["."]` → `./index.ts`. A **raw `{ id, setup }` default export loads
  without `@opencode/plugin`** — no SDK dependency is required for Fusion's
  server part.
- The plugin ID comes from the definition (`id: "probe-package"`), not the
  package name; `GET /api/plugin` lists it as `{ source: { type: "package",
  target, version }, state: { status: "active" } }`.
- The installed package contributed both a new subagent (`pkg-created`) and a
  command (`pkg-command`) — the step-1 gate.
- `opencode plugin remove <exact-spec>` empties the config entry; re-add
  works. `plugin remove` takes the configured specifier, not the package
  name, and accepts no `--standalone` flag.
- Quirk: `opencode plugin list --standalone` printed "No plugins found" from
  a non-project cwd even with the global package installed and active;
  `/api/plugin` is the authoritative listing.

Commands and model selection:

- `ctx.command` exposes `list`, `transform`, `reload`; the editor has `add`;
  `editor.add({ name, description, execute })` registers commands that
  appear in `GET /api/command`. Registration returns `{ dispose() }`.
- The server plugin API exposes no searchable model picker. A picker would be
  a separate TUI plugin part; text listing remains the `/fusion-config`
  contract (consistent with this plan's existing wording).

Implications carried into steps 2-4:

- Step 2: the dedicated package's server part can stay the existing raw
  default export via `exports["."]`; no new SDK dependency.
- Step 3: contribute `fusion`/`fusion-executor`/`fusion-scout` via
  `update`-on-missing with `system` prompts and `permissions` parity;
  markdown installs keep precedence and get a conflict warning (detected via
  `editor.get`); no registry reads in setup; dispose registrations on unload.
- Step 4: `/fusion-config` rides the verified command transform; nothing in
  the host provides a picker, so "list" stays text output.


## 2. Dedicated OpenCode package entrypoint

- [x] Generate a separate `fusion-opencode` package from the shared sources.
  Its default export loads `src/opencode/index.ts`; expose a server export too
  if the verified loader requires it. The final registry name needs availability
  verification before publishing.
- [x] Preserve the existing Pi package default, Pi manifest, optional peers,
  and `/opencode` compatibility export. Do not change the Pi package root to
  OpenCode or install the Pi stack for OpenCode users.
- [x] Include the full shared import closure and required agent resources;
  resolve resources relative to the installed module, never the caller's cwd.
- [x] Provide native Git-install packaging. The root package now exports
  `./server` → `src/opencode/index.ts`, which OpenCode v2.2.5 prefers over
  the Pi default export. No generated subdirectory or preparation hook is
  needed. The earlier thin-subpackage/prepare experiments failed; this
  explicit server export supersedes that approach. The native fixture tests
  export precedence with a deliberately failing default, then installs a
  Git snapshot of Fusion's actual manifest/assets and discovers all three
  agents and `/fusion-config` from the active package plugin.
- [x] Update Actions to build the dedicated tarball, checksums, and install
  evidence. Test the exact tarball uploaded, not a separately repacked copy.

Acceptance: a fresh consumer loads the dedicated package default without Pi
SDKs; the legacy Pi and OpenCode entrypoints retain their current behavior.
The native loader installs and loads the package from the supported source.
Npm publication and release creation are separate actions from artifact builds.

**Status: implemented and verified, including root Git-source installation** —
`scripts/build-opencode-package.mjs` materializes `dist/fusion-opencode`
(shared `src` closure, generated agent Markdown, install guide, the
`fusion-resolve` bin; `exports["."]` → `src/opencode/index.ts`; no
dependencies). `fusion-opencode` is unclaimed on npm (checked 2026-11-01).
No repository subdirectory is committed: the preparation step
(`build:opencode-package` + `npm pack ./dist/fusion-opencode`) works outside
this checkout. The root Git package loads through its explicit server export;
the remote GitHub install becomes available after these changes are pushed.
The workflow builds
and checksums both tarballs and runs `test:opencode-package-load` against the
exact uploaded tarball (`FUSION_OPENCODE_TARBALL`). Verified live on v2.2.5:
bare consumer install pulls no Pi SDKs, the package loads through the native
`plugins` entry with empty agent directories, the recovery CLI is linked and
executable from the installed consumer, and a model-free run lifecycle holds
(`artifacts/opencode-package-load-*.json`).

## 3. Automatic agent contribution

- [x] Centralize the three agent definitions so native contributions and legacy
  Markdown examples share prompts, modes, and permission rules.
- [x] Contribute `fusion` (primary), `fusion-executor` (subagent), and
  `fusion-scout` (read-only subagent) through the mechanism verified in step 1.
- [x] Preserve the supervisor's restricted subagent access, executor recursion
  guard, and scout read-only permissions and tool cap.
- [x] Define collision behavior: accept identical legacy definitions; report
  conflicting same-name definitions clearly without silently changing user policy.
- [x] Make reload/unload idempotent and dispose owned registrations where supported.
- [x] Keep legacy manual installation working; document removal of redundant
  wrappers to prevent loading Fusion twice.

Acceptance: native installation into an empty project exposes all three agents
without file copying. Reload produces no duplicate registrations. Permission,
conflict, and existing-manual-install tests pass. Configuration files unrelated
to Fusion are untouched.

**Status: implemented and verified** — `src/opencode/agents.ts` is the single
source of truth; `bun run generate:agent-markdown` regenerates the legacy
examples and `test/opencode-agents.test.ts` enforces byte-identity plus the
permission invariants. The plugin contributes all three agents through
`ctx.agent.transform` update-on-missing (capability-guarded: hosts without the
surface keep the Markdown path). Collision policy follows the verified host
precedence: Markdown/config agents win, identical legacy definitions are
accepted silently, and conflicts are reported through `fusion_status` /
`/fusion-status` — authoritatively at query time by re-reading the merged
registry (`agentReport`), because the first transform replay may run before
Markdown agents are visible in its editor (live-observed). Reload replays are
deduplicated; `close()` disposes the agent and command registrations. Unit
coverage in `test/opencode-plugin.test.ts` (contribution, dedup, precedence,
conflict reporting, missing-surface fallback, disposal); end-to-end coverage in
`test:opencode-package-load` (all three agents observed `available` in an empty
project, `/fusion-status` delivered through the real command surface).

## 4. User-facing `/fusion-config`

Initial command contract:

```text
/fusion-config
/fusion-config list [filter]
/fusion-config <provider>/<model> [variant]
```

- [x] With no arguments, show the saved preference, current run model, supported
  syntax, and how to list models. Do not create a run or acquire workspace ownership.
- [x] List validated host catalog choices and variants with bounded output and
  optional filtering. Split explicit model selection on the first slash so
  model IDs containing slashes still work. Reject extra or malformed arguments.
- [x] Extract one configuration operation used by both the command and
  `fusion_configure`; preserve tool authorization while allowing a direct user
  command without requiring an active Fusion run or invoking an LLM.
- [x] Validate provider/model/variant against the live catalog before mutation.
  Persist the preference across plugin reloads. Invalid input changes nothing.
- [x] Apply immediately only to a safely replaceable executor handle before
  executor/scout work has started. Otherwise save for the next run and report
  that explicitly. Preserve pending, uncertain, backgrounded, and foreign-owned work.
- [x] Serialize configuration with run start/reset/delegation transitions; preserve
  retryable state on storage or handle replacement failures.
- [x] State clearly that executor and scout share the chosen model. Supervisor
  selection remains OpenCode's native model selector; do not change host defaults.
- [x] Update command help, README, install guide, and native smoke expectations.

Acceptance: command works before a run, during an untouched run, after work
starts, and after reload. Test invalid catalog choices, variants, model IDs
with slashes, concurrent transitions, persistence failures, and uncertain work.
Verify the command does not cause model calls or prompt injection. An interactive
picker can follow after the command contract is verified; text listing alone
must not be described as a picker.

**Status: implemented and verified** — `configureExecutorModel` in
`src/opencode/index.ts` is the one operation behind both the `fusion_configure`
tool (which keeps its supervisor-only authorization) and the new
`/fusion-config` command: live-catalog validation before any mutation, the
`configuring` transition guard shared with start/reset/delegation, preference
persistence in plugin storage, immediate handle replacement only while no
executor **or scout** work exists (scout history, an in-flight scout, and a
backgrounded scout all defer the change to the next run with an explicit
reason — a scout consumed its budget on the run's model), and retryable
failure semantics (a failed
preference write releases the replacement handle and changes nothing). The
no-argument view is read-only — it never creates a run or claims the workspace.
Selection parsing splits on the first slash (slash-bearing model IDs work);
`list` is bounded to 40 lines with an optional filter and hides disabled
entries; malformed input is rejected with usage. Unit coverage in
`test/opencode-plugin.test.ts` (`/fusion-config command`: show/list/set,
slash IDs, invalid catalog choices and variants, malformed arguments,
persistence failure retry, work-started deferral including the scout-history
and in-flight-scout regressions); model-free host coverage in
`test:opencode-smoke` (registration, show, list through the real command
surface) and `test:opencode-package-load` (show/list/set against the live
catalog, saved preference visible immediately and after a full server
restart; the set check skips with an explicit artifact marker only when the
host catalog exposes no enabled model). The command makes no model calls and
injects no prompts; output is delivered through `session.synthetic`. The
listing is text, not a picker.

## 5. Integrated acceptance and delivery

- [x] Run focused configuration/registration/package tests, type checking,
  existing Pi load checks, and import-isolation tests.
- [x] Install the generated dedicated tarball into a clean consumer and load it
  through the real OpenCode package loader with empty agent directories.
- [x] Run native model-free checks: agent discovery, command registration,
  catalog listing, configuration persistence, run start/status/cleanup, reload.
- [x] Run the opt-in model workflow using that installed package: configure a
  model, scout, execute, revise/final-fix where needed, verify usage and cleanup.
- [x] Verify the supported native `opencode plugin add` path in isolated global
  config. Test manual-install coexistence and removal/reinstall behavior.
- [x] Update Actions evidence and installation documentation to reflect only
  verified installation sources and host versions.

Deliver in order: native API probe → package entrypoint → agent contribution →
configuration command → installed-package acceptance and documentation.
Do not retag v0.1.0. Choose a new version/tag after the new package passes gates.

**Status: complete; version/tag selection remains an explicit release action.**
Evidence: unit/typecheck/Pi-load/import-isolation green (404 tests, `tsc`,
`test:pi-load`, `test:clean-install`, `test/package-isolation.test.ts`);
`test:opencode-package-load` loads the exact dedicated tarball into a bare
consumer through the native `plugins` entry with empty agent directories and
covers agent discovery, command registration (including `/fusion-config`),
catalog listing, set + persistence across a full server restart, the recovery
CLI bin, and manual-install coexistence with conflict reporting;
`test:opencode-native` covers the `opencode plugin add` Git path plus
removal/reinstall in isolated global config; `test:opencode-parity` with
`FUSION_OPENCODE_TARBALL` ran the opt-in model workflow on the installed
package (configure → scout → execute → revise → final_fix, usage complete,
persistent mode, resume refusal, clean release; artifact
`artifacts/opencode-parity-2026-11-01T154348-392Z.json`, `ok: true`, host
v2.2.5). One earlier parity attempt stalled on a silent child turn (no
terminal for 300 s during final_fix, run correctly held `delegating`); the
identical-code re-run passed, and the failure artifact now carries the
observer record for future diagnosis. The version bump and tag are deliberate
release actions, not taken here.

### Step 5 revalidation (2026-11-01)

- `bun test`: 404 passed, 0 failed; typecheck, Pi load, native command smoke,
  syntax checks, and `git diff --check` passed.
- Bare legacy-package install: `artifacts/clean-install-2026-11-01T164611-861Z.json`.
- Dedicated package and configuration restart/coexistence:
  `artifacts/opencode-package-load-2026-11-01T164619-702Z.json`.
- Native API/package-manager probe, including fresh-host checks after removal
  and reinstall: `artifacts/opencode-native-surface-2026-11-01T164623-364Z.json`.
- Installed-package live workflow:
  `artifacts/opencode-parity-2026-11-01T164936-001Z.json` (`ok: true`, host
  2.2.5, `opencode-go/glm-5.3-flash`). First run: scout, execute, revise,
  final_fix with supervisor review/audit; second run: persistent mode and
  execute. Both runs reported complete worker usage and released resources.
  This revalidation passed on its first attempt without stall recovery.
- Package-load and live reports both identify the tested dedicated tarball
  with SHA-256
  `088d32b5d903969721f1d2047bbfa5e29c0f03d271ef2549fe22db7216aa00e9`.
  The fixtures now record this digest so future acceptance can be tied to an
  exact artifact, rather than just a filename.
- The packaging workflow now gates artifacts on the full unit suite,
  typecheck, Pi load, clean install, native API probe, and exact-tarball load.
  The workflow changes were validated locally; a hosted Actions run is still
  part of delivery after commit/push. Model-consuming parity remains opt-in.

At this revalidation, Git-source installation was still deferred and no
release actions were taken. The subsequent 0.1.1 preparation below resolves
the Git-source packaging gap.

### Version 0.1.1 preparation

- Root version bumped to 0.1.1; the dedicated package inherits that version.
- The root keeps the Pi default and adds `./server` for OpenCode. Package
  isolation asserts the alias, and Pi load still passes.
- The native fixture proves OpenCode v2.2.5 prefers `./server` over a failing
  default, installs Fusion's actual package assets from a temporary Git
  repository, and discovers its agents/configuration command.
- Documented the version-pinned GitHub command for use after the release
  tag exists: `opencode plugin add 'github:liodali/fusion-pi-extension#v0.1.1'`.
- No model runtime changed in this preparation; the previous live workflow
  remains the runtime acceptance evidence. The new package version receives
  fresh model-free package and Git-install checks. No commit/push, tag, or
  npm publication is performed by version preparation.
- 0.1.1 validation: 404 tests and typecheck passed; Pi loading and package
  isolation passed. Native Git evidence:
  `artifacts/opencode-native-surface-2026-11-01T204920-930Z.json`
  (`phaseC.addExit: 0`, `phaseC.version: 0.1.1`). Dedicated-tarball evidence:
  `artifacts/opencode-package-load-2026-11-01T205026-327Z.json` (`ok: true`).
  Both versioned tarballs and `SHA256SUMS` are available in `dist/`.

## Post-release command display correction

The v0.1.1 TUI displayed only the labels "Fusion config" / "Fusion config
models". OpenCode v2.2.5's `SessionNoticeMessageV2` renders a synthetic
message's `description`, not its `text`. Inbox-only assertions missed this.
The shared command reporter now puts the full report in both fields (title
plus body in `description`) and still uses `resume: false`. Tests require
the body in the visible field for configuration, catalog, and other command
reports. Verified with 75 plugin tests, typecheck, installed-package checks,
and a private native TUI session showing configuration details and model IDs
with variants from `/fusion-config list`, without model execution. Evidence
is recorded under `artifacts/opencode-command-display-*.json`.

This correction is prepared as version 0.1.2, with installation examples
updated to the new tag. v0.1.1 remains unchanged.

## Persistent-mode tool investigation (2026-11-02)

Affected live session metadata confirmed mode saved as true, v0.1.2 active,
earlier fusion_start rejections on the Build agent, and a subsequent Fusion
assistant claiming tools were missing. Historical messages alone do not
prove the tools actually supplied to that later model call.

An isolated native context-hook probe observes nine Fusion tools with mode
on/Fusion selected and only reporting tools with mode off. It also exposed a
discovery defect: Build was offered tools that requireSupervisor rejected.
The local fix hides Fusion tools from other agents and adds supervisor
instructions to stop rather than implement directly when orchestration tools
are unavailable. Prompt instructions guide behavior; they are not an enforced
ban on direct edits.

`test:opencode-tool-visibility` now covers mode off, mode on/Build, and mode
on/Fusion in the same conversation, aborting before each model request. The
corrected fixture passes: reporting tools, zero tools, all nine tools,
respectively. `/fusion-config` gains loaded-mode and last-hook visibility
diagnostics so the affected session can be inspected after installing the
fix. The exact cause of that historical missing-tools claim remains
unconfirmed; stale conversation assumptions are a hypothesis, not a proven
host tool omission. No release or user-project modification was made.

Version 0.1.3 packages these fixes and diagnostics, with the native visibility
regression included in the packaging workflow. This improves diagnosis and
prevents Build from discovering supervisor-only tools; it does not claim to
prove the cause of the historical model response. The user's project files
remain untouched.

## OpenCode delegation UI and executor stop (2026-11-03)

Current release remains **v0.1.3**, commit `86797ff`. All work below is local,
uncommitted, and unreleased. The user's other project has not been modified.

Implemented locally:

- Compact delegation input: `action`, short `title`, and nested
  `details.brief` / `details.originalTask`. The full brief remains intact and
  expandable. Legacy top-level brief calls remain accepted by the schema and
  runtime; historical rows are not rewritten.
- OpenCode TUI activity card above the composer: action/title, observed tool
  activity/count, elapsed time, and navigation to the owned executor child.
  Activity ignores reasoning, text deltas, shell arguments, and tool results.
- UI updates use existing scoped WorkerEvents and native progress metadata;
  no extra model calls or network polling. The elapsed timer runs only while
  active. Pi entrypoints remain separate; Pi UI expansion is deferred.
- Found and fixed bare-package JSX loading failure (`@opentui/solid` could
  not resolve after runtime JSX transformation). `src/opencode/tui.ts` now
  uses explicit host render primitives. Both package manifests export `./tui`.
- Added `fusion_stop`, `/fusion-stop`, and a clickable Stop executor control.
  Stop targets only the owning session's executor, disables continuation
  nudges/new delegation/scouting, preserves partial edits and unresolved
  ownership, and provides bounded deterministic feedback without asking a
  model to summarize. Parent cancellation also requests child interruption.
- Stop-before-reference requests are retained, interruptions pass
  `resume: false`, and termination is confirmed only by fresh owned-child
  terminal evidence or a matching worker result. RPC acknowledgement alone
  is not confirmation. Restored background work remains stoppable.
- Added serialized per-run persistence and bounded stop waits so a slow
  write does not prevent interruption. Advisory scout writes skip an already
  busy persistence queue; strict settlement writes remain ordered.
- Progress delivery has a bounded coalescing queue and cannot block executor
  submission, stopping, or settlement. Reconciliation display matches both
  the child and request ID; completion during a stop is reported as completion.

Review fixes (2026-11-03, local):

- Stop records requested before publication now interrupt a newly
  discovered owned child independently of the reference persistence write,
  while persistence still gates the forwarded progress overlay. Previously
  a stalled write delayed the interrupt until another qualifying bus
  event arrived. The pre-submission branch is unchanged: an idle child
  still only produces the stop-before-submission throw (an idle child
  needs no interruption), and it still follows the persisted intent.
- Reconciliation of a backgrounded turn now updates and persists a
  matching stop record from the proven terminal result before the
  settlement clears the pending intent, so cancelled-work reconciliation
  no longer leaves stop feedback claiming an unconfirmed termination.
  A stale confirmed record produces no second feedback.

Validation so far:

- The full suite passed with 418 tests, including parent cancellation and
  completion-during-stop feedback. With the review fixes the suite grew to
  420 tests, adding the stalled-persistence interruption regression and the
  cancelled-work reconciliation feedback regression; both fail when the
  respective fix is reverted. Native visual, native stop, smoke, and Pi
  loading fixtures passed with the fixes in place.
- The native visual fixture passed using a bare installed tarball. It checks
  the compact card, live and completed states, Stop button dispatch, and
  acknowledged feedback. Its activity feed is deterministic fixture data.
- A model-free native stop fixture passed using a bare installed tarball:
  real OpenCode created and interrupted the owned child, Fusion confirmed
  its cancelled outcome, and the pending request remained for recovery.
  A context hook blocks the child before any provider request; a driver
  invokes delegation without a supervisor model call.
- Native package loading, tool visibility, Pi entrypoint loading, and
  TypeScript checks passed. No paid model or provider credentials were used.

Next steps:

1. Review and commit the changes, then prepare a new version and package when
   a release is requested; the v0.1.3 tag does not contain these controls.
2. Perform a real-model user acceptance run in OpenCode to check ordinary
   supervisor behavior, display, cancellation, feedback, and recovery together.
   The model-free probes do not demonstrate model compliance with the prompts.
3. Consider a Pi presentation and stop control separately; its existing
   entrypoint and behavior have not been migrated to these OpenCode controls.

Main files: `src/opencode/delegate-presentation.ts`, `activity-view.ts`,
`executor-stop.ts`, `tui.ts`, and `index.ts`;
`test/opencode-delegate-presentation.test.ts`, `test/opencode-plugin.test.ts`,
and `test/integration/opencode-{delegate-display,stop-native}.mjs`. Development-only UI
types/libraries and the headless terminal emulator were added to package.json;
the generated OpenCode runtime package still has no dependencies.

## Pi executor stop and Fusion mode visibility (2026-11-04, local)

Review finding: the stop control existed only on OpenCode (native subagent);
the Pi extension had the abort primitive (`WorkerHandle.abort`, durable
conversation and session abort) but no supervisor-reachable stop, and
`/fusion-mode` could not report its current state.

Implemented locally:

- `fusion_stop` Pi tool (`src/pi/run-stop.ts` + registration in
  `src/index.ts`): the supervisor calls it when the user asks to stop. It
  aborts a live executor conversation only when an uncertain pending turn
  exists (an idle executor is not interrupted), marks the run
  `stopped` in the persisted run record, and returns a deterministic recap:
  run/task, executor label and backend, last observed activity, pending
  request, revisions used, abort delivery (delivered / failed / nothing
  running — never overstated), executor progress tail, and the
  `/fusion-resume` / `/fusion-resolve` / `/fusion-clean` recovery path. No
  model summarizes; a failed marker write keeps the in-memory stop and warns.
- Stopped-run gating: `fusion_delegate` refuses execute/revise/final_fix and
  `fusion_scout` refuses new calls with one shared recovery message; resume
  stays available as the recovery path for an interrupted durable turn.
  `/fusion-status` shows the stop marker. Mid-delegation stops remain host
  interruptions (the Pi supervisor is blocked inside the tool call), which
  already abort the executor through the delegation signal.
- OpenCode `/fusion-mode` with no arguments reports the current mode, its
  effect, and usage without touching storage; invalid arguments name all
  three forms; `/fusion-status` now carries `fusionMode`.

Validation: unit coverage in `test/pi-run-stop.test.ts` (recap contents,
abort branches, idempotence, persistence failure, truncation) and
`test/opencode-plugin.test.ts` (mode show/status); the Pi surface fixtures
(`pi-load`, `pi-parity` registration) expect `fusion_stop`. The full suite
passed with 429 tests. A live Pi stop against a real durable executor is
still pending (the model-free fixtures register the surface; a real-model Pi
acceptance run should exercise the stop and recap end to end).

Review fixes (2026-11-04, local):

- A repeated stop no longer claims successful persistence after a failed
  marker write: every call retries the (idempotent) write and reports the
  real outcome, so the recap warning survives until a write actually lands.
  A failed abort delivery is likewise retried by a repeated stop; a
  delivered or in-flight one never is.
- A stalled abort can no longer block the stop marker or the supervisor
  feedback: the marker is set before any awaited I/O, the abort wait is
  bounded (default 1500 ms) and reports delivery as pending past it, and a
  follower updates the marker and record when the abort settles. Marker
  writes are bounded too (default 2000 ms), so the recap always returns.
  Both regressions fail against the previous implementation (false-success
  assertion, 5 s hang) and pass with the fixes; the suite is at 434 tests.

## Release v0.1.4 (2026-11-04)

Ships everything since v0.1.3 (`86797ff`): the compact delegation input
and TUI activity card with a clickable stop control; the executor stop
machinery (persisted stop records, bounded deterministic feedback,
acknowledged-is-not-confirmed semantics, stall-independent interruption,
reconciliation confirming the stop record); `/fusion-stop`; the Pi
`fusion_stop` supervisor tool with stopped-run gating and the
deterministic recap (marker-first, bounded abort and writes, honest
retry semantics); `/fusion-mode` state visibility and `fusionMode` in
`/fusion-status`; and the rename to `fusion-harness-extension`
(package and repository; npm name verified unclaimed; nothing was ever
published under the old name).

Gate evidence for this release: typecheck; 434 tests; the exact
`fusion-opencode-0.1.4.tgz` loaded through the native package loader
(package-load: agents, commands, `/fusion-config` across a full server
restart, coexistence), delegate-display and stop-native fixtures on the
installed tarball (`installedPackage: true`, stop confirmed/cancelled);
smoke on v2.2.5; pi-load and clean-install for the renamed root package.
The live installed-package parity run passed on the exact tarball
(artifact `artifacts/opencode-parity-2026-11-04T121814-102Z.json`,
`ok: true`, 11 steps, no stuck recovery). The tag is annotated and the
GitHub release attaches the workflow-built tarballs and SHA256SUMS.

## Rename to fusion-harness-extension (2026-11-04, local)

The project is no longer Pi-only (OpenCode shipped; more harnesses planned),
so the package and repository are renamed `fusion-harness-extension`
(npm name verified unclaimed). The rename is free of compatibility cost:
the package was never published, the OpenCode package keeps its own
deliberate name (`fusion-opencode`), and harness-specific surfaces keep
their correct names (`pi.extensions`, `.pi/extensions` discovery shim,
`src/pi/*`, `src/opencode/*`). Historical records (the verified v0.1.1
install command, the m4 handoff working directory) keep the names they
were written under; GitHub redirects the old repository URL. Verified with
the full suite plus clean-install, consumer-install, and pi-load fixtures
installing the renamed package.

## References


- Native installation and package sources: https://dev.opencode.ai/v2/docs/plugins/
- Package exports and loading: https://dev.opencode.ai/v2/docs/build/plugins
- Agent and command APIs: https://dev.opencode.ai/v2/docs/build/plugins/server
- Existing implementation: `src/opencode/index.ts`
- Existing packaging gate: `.github/workflows/package-opencode.yml`

Current docs are discovery references, not proof of behavior on OpenCode 2.2.5.
Live proof for the mechanisms above now exists in the step 1 readiness report;
the referenced doc pages remain the source to re-check when the host version
moves.
