# OpenCode readiness and testing

Checked 2026-10-28 against locally installed OpenCode v2.2.0.

## Current state

| Area | Implemented | Verified |
|---|---|---|
| Shared delegation/scout transitions | Yes; used by Pi and OpenCode | Unit tests |
| Neutral catalog shape and worker events | Yes | Type checking and existing Pi tests |
| Pi-only Durable directory | Yes | Existing regression tests; no new live durable run |
| Native OpenCode executor wrapper | Prototype | Unit tests, including foreground-to-background handling |
| OpenCode plugin setup and native subagent registry | Experimental entrypoint | Isolated v2.2.0 registration and missing-parent smoke test |
| Actual executor child, revisions, and final fix | In-memory host wiring | Mock tests only; not tested with a model |
| Complete OpenCode Fusion workflow | No | Not ready to install/use |

The core extraction is partial: `src/index.ts` still owns most run lifecycle,
workspace diff collection, persistence, and Pi UI. The experimental OpenCode
entrypoint exposes delegate, status, and reset tools, with example agent files.
It has no scout, command registration, persistence, or production settlement
handler. Run state and workspace ownership are in memory and scoped to one plugin
instance. A restart or separate process can lose that protection. The package
still requires Pi peers and is not independently packaged for OpenCode. Passing
mock tests and the no-model smoke test does not establish harness parity.
Any native delegation failure leaves the in-memory run uncertain and blocks
reset/retry, even when no child ID was received. Inspect the native session and
working tree before any manual recovery. Reloading loses that in-memory guard.

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
experiments only, and should first be exercised in a disposable Git repository.
The example agent permissions have not yet been verified with a real child.

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

1. Continue extracting the controller and workspace evidence handling from the Pi
   entrypoint, keeping the current Pi controls and saved runs compatible.
2. Complete the OpenCode host and verify the example supervisor and executor
   permissions; add a restricted scout and its exact pre-tool budget.
3. Implement child ownership/persistence, native event/usage mapping, cancellation,
   and the real background settlement handler. Waiting must verify the relevant
   executor turn finished and read its final report; an old final message or an
   idle event alone is insufficient.
4. Add config, run, mode, status, stats, resume, and clean controls, including
   effective tool permissions and scout caps, plus one writer per workspace.
5. Produce an independently installable OpenCode package without Pi dependencies,
   then run the full parity suite.

## Next integration tests

First extend the isolated probe to register the real agents/tools and create a
parent and executor child. Use an explicitly selected authenticated model in a
disposable Git repository; keep this separate from the no-model smoke command.
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
