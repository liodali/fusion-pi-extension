# OpenCode readiness and testing

Checked 2026-10-28 against locally installed OpenCode v2.2.0.

## Current state

| Area | Implemented | Verified |
|---|---|---|
| Shared delegation/scout transitions | Yes; used by Pi and OpenCode | Unit tests |
| Neutral catalog shape and worker events | Yes | Type checking and existing Pi tests |
| Pi-only Durable directory | Yes | Existing regression tests; no new live durable run |
| Native OpenCode executor wrapper | Prototype | Unit tests, including foreground-to-background handling |
| Direct-delegation guard and background reconciliation | Versioned plugin-storage record and fail-closed recovery | Mock tests including reload; real enforcement and notifications not yet tested with a child |
| OpenCode plugin setup and native subagent registry | Experimental entrypoint | Isolated v2.2.0 registration and missing-parent smoke test |
| Shared Git workspace evidence | Pi and OpenCode use the same snapshot/diff code | Real temporary Git worktree tests; OpenCode requires full review |
| Actual executor child, revisions, and final fix | Experimental host wiring | Live v2.2.0 run with `opencode-go/glm-5.3-flash`, same child and expected final file |
| Complete OpenCode Fusion workflow | No | Not ready to install/use |

The core extraction is partial: the shared controller owns task start, restoration,
reset, and delegation guards; `src/index.ts` still owns other lifecycle behavior,
Pi persistence, and Pi UI. The experimental OpenCode
entrypoint exposes delegate, status, reset, and reconciliation tools, with example agent files.
It has no scout or command registration. OpenCode plugin storage retains the
workspace owner, original task, budgets, child ID and pending turn across reloads.
It does not provide an atomic cross-process workspace lock; concurrent plugin
instances or locations must not use the same workspace. The package
still requires Pi peers and is not independently packaged for OpenCode. Passing
mock tests and the no-model smoke test does not establish harness parity.
Any native delegation failure leaves the run uncertain and blocks
reset/retry, even when no child ID was received. Inspect the native session and
working tree before any manual recovery.
When OpenCode backgrounds a foreground delegation, wait for its completion
notification and call `fusion_reconcile`. Fusion matches the child and unique
turn description against the native notification before returning its report.
Missing or mismatched notifications leave the run locked; errors with unknown
submission state still require manual inspection. Reconciliation is not tested
against a real child or a real OpenCode restart. If the pending child ID or its
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
The next slice is M1; a passed live delegation fixture does not complete M2–M7.

## Next integration tests

Run the live fixture with an explicitly selected authenticated model; keep it
separate from the no-model smoke command.
Do not run editing agents against this development worktree for validation.

| Scenario | Required evidence |
|---|---|
| Initial execution | Child has expected parent, agent, model/variant and cwd; changes a fixture file; returns a parsable Fusion report |
| Revision and final fix | Same child ID for all turns; separate briefs reach it; expected final diff; controller rejects budget overrun |
| Scout restrictions | Read/search succeeds; edit, shell and recursive delegation are denied; tool cap stops the next call before execution |
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
