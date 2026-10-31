# OpenCode readiness and testing

Current working-tree checkpoint: M1–M5 are complete at their acceptance levels
(see the [implementation plan](./multi-harness-implementation-plan.md) for the
per-milestone evidence). The notes below describe the validated baseline and
the opt-in fixtures that maintain it. A two-process
restart fixture uses a simulated subagent result and notification. A separate
model-backed probe verifies recovery of a real notification already present before
restart; completion after an in-flight restart remains unverified.

The opt-in `FUSION_OPENCODE_MODEL=opencode-go/glm-5.3-flash bun run
test:opencode-restart-live` probe forces a real native background child. In the
earlier runs the edit occurred and the pending child was restored without another
submission, but the matching native completion notification was absent after an
in-flight restart, leaving reconciliation blocked. A later run waited for the
real notification before restarting and successfully reconciled without another
submission. Do not use file contents or child identity alone as settlement evidence.
The child context lacked the request description and ended with a tool-call entry
and an error entry. OpenCode's [open restart issue](https://github.com/anomalyco/opencode/issues/36349)
describes a related parent completion gap; we have not established that it caused
this specific probe result.

Checked 2026-10-28 against locally installed OpenCode v2.2.0.

## Current state

| Area | Implemented | Verified |
|---|---|---|
| Shared lifecycle and delegation sequencing | Both entrypoints call the worker-backed controller | Shared port and acceptance tests, Pi entrypoint and OpenCode plugin regression tests |
| Neutral worker contracts and Pi runtime isolation | Pi worker runtime wraps session and Durable backends | Dependency-free shared import test, fake-backend runtime tests, Pi regressions, and type checking |
| Pi-only Durable directory | Yes | Existing regression tests; no new live durable run |
| Native OpenCode executor wrapper | Worker runtime adapter is wired into the entrypoint | Unit tests and isolated v2.2.0 GLM-5.3-Flash execute/revise/final-fix/reset workflow |
| Direct-delegation guard and background reconciliation | Versioned plugin-storage record and fail-closed recovery | Mock tests and a real child notification retained before restart; in-flight restart remains unverified |
| OpenCode plugin setup and native subagent registry | Experimental entrypoint | Isolated v2.2.0 registration and missing-parent smoke test |
| Shared Git workspace evidence | Pi and OpenCode use the same snapshot/diff code | Real temporary Git worktree tests; OpenCode requires full review |
| Actual executor child, revisions, and final fix | Experimental host wiring | Live v2.2.0 run with `opencode-go/glm-5.3-flash`, same child and expected final file |
| Restricted scout (M5) | `fusion_scout` tool, `fusion-scout` agent, shared budget and formatter, pre-execution allowlist and tool cap | Unit tests; live v2.2.3 run with `opencode-go/glm-5.3-flash`: citations, untouched tree, 4-call budget refusal with no extra child, mid-scout interrupt with clean reset. Review follow-up: guards persist for backgrounded scout children until their execution ends; reset during an active scout is refused before mutation |
| Run control, status, budget stats (M6.1) | `fusion_start` retains the original task and claims the workspace; `fusion_status` shows claim/capabilities/next action; `fusion_stats` shows budgets with usage explicitly unavailable | Unit tests; model-free live v2.2.3 session start → status → stats → reset |
| Configure and model validation (M6.2) | `fusion_configure` validates provider/model/variant against the live catalog; configured model reaches scout and executor submissions; shared price/cohort metadata reported | Unit tests; model-free live catalog + configure-unknown-refused/real-applied (v2.2.3); live scout child ran on the configured model (`opencode-go/glm-5.3-flash`), child session model observed |
| Commands, persistent mode, clean (M6.3) | `fusion-run`, `fusion-mode`, `fusion-status`, `fusion-stats`, `fusion-clean` native commands; mode gates mutation tools per session; clean releases settled resources only | Unit tests (registration, /fusion-run prompt injection, mode gating + persistence, clean settled/foreign/uncertain); model-free live: all five commands in `/api/command` and `fusion-status` invoked through the command API (v2.2.3) |
| Completion hooks, bounded nudges (M6.4) | Turn-end bus events feed the shared completion policy; nudges sent via session.prompt; interrupted/failed never nudge; runs settle per mode. Review follow-ups: Fusion-turn binding, event dedupe, persisted budget, incomplete reporting, retryable delivery, final-part summary detection; unresolved-work hold across all terminals (interrupt/fail included); budget + settlement + incomplete persist across reload; missing-prompt hosts consume nothing | Channel pinned live (v2.2.3 execution/text event shapes); unit-pinned nudge bound (2), summary suppression, backgrounded suppression, interrupt settle, agent binding, dedupe, reload persistence (incomplete + completed phase), delivery-failure retry and persistence-failure hold; live early-settle observation deferred to the M6.6 parity run |
| Resume/reconcile control (M6.5) | `fusion_resume` tool and `/fusion-resume` command present owner, pending request, outstanding work, and reconciliation capability (available/busy/unavailable mirroring the `fusion_reconcile` guard); routes to `fusion_reconcile` when exact proof can exist (across reload too); documents concrete operator resolution (`bun src/workspace/resolve.ts ... --confirm-stopped`) otherwise; `activeTurnReattach` refused with reason | Unit-pinned across healthy, backgrounded-miss, retained-intent-without-proof, reload continuity, and scout-only states, plus non-supervisor refusal; model-free live command registration on the installed host (v2.2.5). Recovery after a restart that lost the completion notification stays blocked pending upstream (#36349); cross-session "not attached" presentation and a real restart recovery run join M6.6 parity coverage |
| Per-run usage metrics (M6.6) | `fusion_stats` reports real worker token/cost totals from observed `session.usage.updated` deltas, aggregated per turn and persisted through `adapterData` across reload; missing readings are counted (`complete: false`) instead of guessed; persistent-mode settled runs are releasable by `fusion-clean` (phase "complete"), unfinished ones refused | Unit-pinned aggregation (scout+execute+revise deltas), reload persistence, reconciled-turn missing honesty, armed-settled clean release/refusal; live run totals observed (run 1: 4/4 turns, 15885 input / 738 output / 32640 cache-read tokens; run 2: 1/1, 5539 input) |
| Complete OpenCode Fusion workflow (M6.6 parity) | Passes through user-facing controls only on the installed v2.2.5 host: configure → run → scout → execute → file review → revise → audit → final fix → `## Fusion summary` (run 1, one executor child, alpha→beta→gamma); persistent mode + new run (run 2); resume across owning/cross-session/post-clean states | `test/integration/opencode-parity.mjs` exits 0 (`opencode-go/glm-5.3-flash`); supersedes the failed 2026-10-30 CLI workflow run. Known live boundaries: serve-mode gateway models need the provider + opencode account credentials; the prompted supervisor turn may run in a different session than the command's; the supervisor resets its own run unless the task forbids it; the upstream parent-completion gap (#36349) reproduces as an open supervisor turn after its child and the fixture recovers via interrupt + clean + reissue |
| Complete OpenCode Fusion workflow | Packaging: No | Workflow parity reached (M6.6); independent packaging and install (M7) not ready |
| Shared Git workspace evidence | Pi and OpenCode use the same snapshot/diff code | Real temporary Git worktree tests; OpenCode requires full review |

The core extraction is partial: the shared controller owns task transitions,
pending and uncertain state, delegation guards, and the main delegation sequence;
the adapters still own native worker handles, persistence, and presentation.
The experimental OpenCode entrypoint exposes delegate, scout, status, stats,
resume/reconciliation, and reset tools, native commands, and example agent
files. OpenCode
plugin storage and the shared ownership registry retain the workspace owner,
original task, budgets, child ID and pending turn across reloads. The SQLite
workspace coordinator excludes concurrent owners across processes. The package
still requires Pi peers and is not independently packaged for OpenCode (M7).
Harness parity through the user-facing controls is now established by the
M6.6 live parity run (v2.2.5): the full protocol, persistent mode, and all
six commands pass end to end, with real per-run usage totals observed.
Any native delegation failure still leaves the run uncertain and blocks
reset/retry, even when no child ID was received. Inspect the native session and
working tree before any manual recovery.

Command output is admitted as a described synthetic message with `resume: false`;
the v2.2.3 model-free test verifies its contents in the session inbox without
starting a model. Display across OpenCode clients remains to be verified. If
`/fusion-run` prompt delivery is unconfirmed, retry the same command and task;
Fusion retains the original message ID and blocks cleanup until delivery is
confirmed. A new model configured after work starts applies to the next run;
the current child's model remains in its recovery record.

For a stranded shared ownership record, first stop the coordinating Fusion host,
verify that its worker and commands have stopped, and review the working tree.
Use `fusion_status` or Pi's `/fusion-status` to obtain the run and pending request
IDs. An operator can then run `bun src/workspace/resolve.ts <workspace> <run-id>
<request-id|--no-request-id> --confirm-stopped`. This records the decision before
releasing ownership; it does not stop a worker. The command refuses to resolve a
different request or an owner with a live coordinator. The default registry is
`~/.local/state/fusion/ownership`; if `FUSION_OWNERSHIP_DIR` is set, every harness
using that workspace must use the same value.
When OpenCode backgrounds a foreground delegation, wait for its completion
notification and call `fusion_reconcile`. Fusion matches the child and unique
turn description against the native notification before returning its report.
Missing or mismatched notifications leave the run locked; errors with unknown
submission state still require manual inspection. A real child notification present before restart was reconciled after restart.
If the pending child ID or its
matching completion notification is unavailable, automatic recovery remains blocked.
OpenCode's report compares Git status before and after the delegation, including
hashes for pre-existing dirty files within the configured limit. It does not yet
collect child tool events; files restored to their prior state or changes made by
other processes can make attribution incomplete. Every OpenCode result requests
a full working-tree review, including when the snapshot or Git is unavailable.

## Experimental local setup

For a disposable project, copy `examples/opencode/agents/fusion.md` and
`fusion-executor.md` to `.opencode/agents/`. Create a discovered
`.opencode/plugins/fusion.ts` that re-exports the default export from the absolute
path to this checkout's `src/opencode/index.ts`, for example:

```ts
export { default } from "/absolute/path/to/Fusion-Pi-Extension/src/opencode/index.ts";
```

Select the `fusion` primary agent;
configure its model and the executor model through OpenCode. This is for local
experiments only, and should first be exercised in a disposable directory.
The example agents ran successfully in the live fixture with additional test-only
restrictions. Other permission inheritance and denial cases remain unverified.

## Tests available now

Run the repository checks:

```sh
bun test
bun run typecheck
```

Run the real OpenCode smoke test, with `opencode` on PATH:

```sh
bun run test:opencode-smoke
```

The opt-in live fixture runs a model in a temporary non-Git project:

```sh
FUSION_OPENCODE_MODEL=provider/model bun run test:opencode-workflow
```

It selects the requested provider's active OpenCode v2 database credential when
available, with legacy credential files as a fallback. For OpenCode Go, it passes
the selected key as `OPENCODE_API_KEY` to the isolated server. It loads the actual
plugin and example agents, denies shell, external
paths, search and web tools, and limits reads and edits to `fixture.txt`. The
supervisor is asked to delegate execute, revise and final fix in sequence. It
checks the file and that all three actions used the same child, then removes the temporary state. This
calls the selected provider and consumes its model usage; it is not part of the
ordinary test suite. On 2026-10-28 the fixture passed with OpenCode v2.2.0 and
`opencode-go/glm-5.3-flash`: the supervisor called execute, revise and final fix,
all three returned the same child ID, the final file contained `gamma`, and the
supervisor called reset. The initial attempt used an expired legacy key; the
successful run used the active v2 credential. This does not verify background
reconciliation, cancellation, actual restart, or cross-process locking.

The opt-in live scout fixture runs three scenarios against a real server and
model (read-only citations with a byte-identical tree, the four-call budget
refusal, and mid-scout supervisor interruption). Filter scenarios with
`FUSION_SCOUT_ONLY=A,B,C`:

```sh
FUSION_OPENCODE_MODEL=provider/model bun run test:opencode-scout
```

On 2026-10-30 the scout fixture passed with OpenCode v2.2.3 and
`opencode-go/glm-5.3-flash`: scenario A returned `notes.md:3`-style citations
and usage readings from one disposable scout child with the working tree
byte-identical; scenario B answered four calls, refused the fifth with the
shared budget message and created exactly four scout children (parallel
duplicate calls were refused by the serialization guard without consuming the
budget); scenario C interrupted the supervisor mid-scout, observed
`session.execution.interrupted` on the scout child, and completed a scripted
reset with no lock. The 20-call tool cap was not exceeded live; its refusal
and terminate paths are unit-pinned, and the guard itself runs on every scout
tool call.

To inspect the provider's model catalog in the same isolated setup without making
a model request, set `FUSION_OPENCODE_LIST_MODELS=1` alongside the model variable.

To select another installed executable:

```sh
FUSION_OPENCODE_BIN=/absolute/path/to/opencode bun run test:opencode-smoke
```

The script creates an isolated temporary project and XDG directories, starts a
localhost server on an available port, and loads a disposable plugin importing a
copy of the actual entrypoint. It registers Fusion tools, obtains the native
executor through `ctx.tool.list`, and calls `fusion_delegate` with a deliberately
nonexistent parent. Success requires OpenCode's own missing-parent rejection.
This confirms plugin setup, tool registration, registry access, and the native
executor call through our wrapper. It does not create a
child or call a model. Provider environment credentials are excluded, server
credentials are kept out of output, and the server and temporary files are removed
after the test. A sandbox may require permission to bind a localhost port.

## Missing implementation, in order

Follow the [extraction and implementation plan](./multi-harness-implementation-plan.md).
Its milestones replace the earlier broad implementation list:

1. M1: neutral runtime contracts and Pi dependency isolation.
2. M2: one shared controller for complete delegation orchestration.
3. M3: versioned recovery and atomic workspace ownership across processes.
4. M4: real native lifecycle, permissions, cancellation, events, and accounting.
5. M5: restricted scout with an exact pre-tool cap.
6. M6: user controls, configuration, and completion policy.
7. M7: independent packaging and actual harness parity.

Each milestone has dependencies, implementation tasks, and an explicit test gate.
M1's contracts and Pi runtime isolation are in place; the next slice is M2.
A passed live delegation fixture does not complete M2–M7.

## Next integration tests

Run the live fixture with an explicitly selected authenticated model; keep it
separate from the no-model smoke command.
Do not run editing agents against this development worktree for validation.

| Scenario | Required evidence |
|---|---|
| Initial execution | Child has expected parent, agent, model/variant and cwd; changes a fixture file; returns a parsable Fusion report |
| Revision and final fix | Same child ID for all turns; separate briefs reach it; expected final diff; controller rejects budget overrun |
| Scout restrictions | Read/search succeeds; edit, shell and recursive delegation are denied; tool cap stops the next call before execution |
|                   | Covered 2026-10-30 by `test:opencode-scout` (v2.2.3, `opencode-go/glm-5.3-flash`) plus unit-pinned denial paths; the 20-call cap was not exceeded live |
| Abort | Stop during a slow tool; child stops; no later edits; next delegation follows an explicit recovery decision |
| Foreground becomes background | No revision or acceptance review while child runs; completion returns the report; failed waiting keeps delegation blocked |
| Permissions | Parent deny remains effective in child; denied subagent launch is propagated without bypassing approval |
| Session isolation | Another supervisor cannot reuse the child; events and usage belong to the correct role; no concurrent workspace writers |
| Interrupted/reopened run | Owned child reference survives; pending turn is reconciled before retry; no duplicate edits |
| Dirty workspace | Untouched pre-existing changes are excluded from executor attribution; staged and untracked edits are represented |
| Complete user flow | Configure → run → scout → execute → actual diff review → revise → audit → final fix → summary; status/stats/mode/clean work |

Use deterministic fixture changes and explicit expected file contents/diffs.
Assert host state and actual files, not just the model's summary. Preserve
sanitized logs containing run/child IDs, reports, permission outcomes and checks.
Record the exact OpenCode/plugin versions and model/variant for each live run.
