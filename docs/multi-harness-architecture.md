# Fusion across harnesses

Status: implementation started. Shared workflow transitions, model selection shape,
and worker event types are harness-independent. An experimental OpenCode entrypoint
connects the shared transitions to the native subagent wrapper, with in-memory
per-session state. A real v2.2.0 smoke test verifies tool registration and calling
the native executor (missing-parent rejection only); actual child execution has
not been tested against a live model. See
[readiness and testing](./opencode-testing.md) for current gaps and test commands.

## Product boundary

Fusion owns the supervisor/executor workflow. Pi and OpenCode provide the agent
runtime, model catalog, permissions, session lifecycle, and user interface.
Both integrations must use the same orchestration implementation and acceptance
suite. Functional parity means the same workflow and controls; rendering follows
each harness's supported UI.

Initial target: Pi supervisor + Pi workers, and OpenCode supervisor + OpenCode
workers. Mixing harnesses within a run is a later capability, not a prerequisite.
The `pi-durable` implementation and its SQLite storage belong exclusively to the
Pi harness. OpenCode does not depend on, configure, or use that implementation.

## Current coupling

- `src/index.ts` combines run state, delegation, diff collection, model selection,
  persistence, commands, Pi events, and TUI rendering.
- `src/executor-backend.ts` provides a useful worker boundary, but imports Pi at
  runtime and exposes Pi model, thinking, and usage types.
- `src/runs.ts` and `src/metrics.ts` currently store Pi session/durable backend
  identities; retain those legacy fields when extracting shared persistence.
- `src/usage.ts`, `src/thinking.ts`, and model selection use Pi catalog semantics.
- Prompts mention Pi; lifecycle completion currently depends on a summary heading
  plus bounded continuation nudges. This is a heuristic, not proof of acceptance.
- Reports, diff attribution, limits, transcript formatting, and most prompt
  construction can be reused with little or no behavioral change.

## Boundaries

```text
Pi host adapter ---------+                  +-- Pi session runtime
                         |                  |
                         +-- Fusion core ---+-- Pi durable runtime
                         |                  |
OpenCode host adapter ---+                  +-- OpenCode session runtime
```

Separate host from worker runtime. Pi's session/durable choices are internal Pi
execution strategies, while Pi/OpenCode are harness identities. Do not expose
Pi Durable as a cross-harness option or turn these concepts into one backend enum.

Suggested eventual package layout:

```text
packages/core/       workflow, contracts, reports, policies, metrics
packages/workspace/ git snapshots, dirty-file hashing, actual diff collection
packages/pi/         Pi host, session runtime, optional durable runtime, Pi UI
packages/opencode/   OpenCode host, child-session runtime, native presentation
```

Begin with these boundaries inside `src/`; split publishing only after both
adapters exercise the contracts. Keep the existing Pi entrypoint as a compatibility
shim. Installing the OpenCode package must not require Pi peer dependencies.

### Shared core

The core must import no harness SDK or TUI package. It owns:

- Original task, brief, phases, one execute, three revisions, one final fix, scout
  budgets, and completion policy, including the existing small-task fast path.
- Tool input validation and all workflow guards. Both adapters invoke the same
  controller methods for delegate, scout, resume, status, clean, and mode changes.
- Before/after workspace evidence, report parsing, review classification, and
  acceptance-audit context.
- Run-scoped progress events and accounting, with no hidden reasoning content.
- Versioned manifests, request IDs, and recovery decisions.

Use typed contracts for host identity, worker identity, model references,
reasoning configuration, usage, events, and session references. Reasoning options
are advertised by adapters; do not assume OpenCode variants map one-to-one to Pi
thinking levels. Unknown pricing or token components remain unknown, not zero.

Model selection retains the current price/cohort policy by default, operating on
normalized catalog metadata. Authentication and provider credentials stay with
the harness. Configured roles must be validated against the actual catalog.

### Host adapter

Maps native commands, incoming prompts, supervisor configuration, tool schemas,
idle/completion/abort events, and progress rendering onto the controller.
Registers Fusion tools only where permitted; where dynamic registration is
unavailable, enforces the same restriction at execution time.

State is keyed by project/workspace and supervisor session, with explicit child
ownership. OpenCode can have several sessions in one plugin process. Preserve
the current single active writer per workspace until workspace isolation exists;
separate session maps alone do not prevent conflicting edits.

### Worker runtime

Creates and reopens workers, prompts them, streams normalized events, aborts
active turns, and releases resources. Advertise capabilities separately:

- Persistent transcript/reopen.
- Reattach to an active turn.
- Durable execution after process death.
- Idempotent submission.
- Enforced read-only tools and exact tool-call budgets.
- Available usage and cost fields.

Persistence must not imply durable execution or exactly-once side effects. An
unsupported guarantee must be reported explicitly; do not silently substitute a
fresh worker or duplicate a submission.

## OpenCode mapping

Use a dedicated `fusion` primary agent, `fusion-executor` subagent, and
`fusion-scout` subagent. Configure them through the supported plugin/config API
for a pinned OpenCode release. Users retain normal OpenCode agents outside Fusion.

Keep `fusion_delegate` and `fusion_scout` as the supervisor-facing tools. These
call the controller. The preferred executor path wraps OpenCode v2's registered
native `subagent` tool with the originating tool context, using foreground calls
and retaining its child session ID for revisions and final fixes. Scouts are
disposable. This preserves native permission checks, parent ownership, model
selection, progress, and cancellation while Fusion controls its own budgets,
reports, accounting, and diff attribution.

OpenCode v2.1.4's native tool checks nesting depth, agent mode and the parent's
`subagent` permission; resumes only a child of that parent; creates a linked child
with the selected agent/model; emits its ID before prompting; and waits for the
child job. On interruption it interrupts the child and cancels the job. Child
sessions inherit session-scoped permission rules, and the selected child agent has
its own rules. Native tool execution can fail after child creation, so persist the
progress ID before work starts and reconcile state before any retry. Retaining an
ID alone is not an exactly-once guarantee.

The entrypoint in `src/opencode/index.ts` calls the registered native tool through
the wrapper, as verified by the no-model smoke test. It supports execute, revise,
final fix, status and reset with in-memory session ownership. Actual child execution
and lifecycle handling remain unverified. Run state and workspace ownership do not
survive plugin reloads or cover separate OpenCode processes/locations.
When a foreground call is backgrounded, it blocks further prompts until a supplied
settlement handler confirms completion and returns the child's final response. If
settlement fails, the adapter must reconcile the child before delegating again;
the OpenCode integration must supply and test that handler.
Test actual child execution and lifecycle behavior in a running v2 instance before
selecting this approach definitively. If unsupported, reproduce the relevant
checks using the public session API rather than importing internals.
Restrict unmanaged delegation in the Fusion supervisor and prevent recursive
delegation from workers. Verify effective permissions instead of relying on prompts.

The scout needs an explicit read/search/list allowlist, with edit, shell, task,
network/MCP, and Fusion delegation tools denied unless separately justified as
read-only. Enforce tool-call limits before execution through supported hooks;
asynchronous cancellation after observing a call is insufficient for an exact cap.

Route all worker events by owned session and message IDs. Exclude worker usage
from supervisor usage; deduplicate repeated events after reconnect. Cancellation
must stop the active owned child and prevent idle events from restarting it.
Cleanup releases handles/subscriptions without deleting recovery transcripts.

Commands should expose config, run, persistent mode, status, stats, resume, and
clean using supported native commands/configuration. Progress should be visible
through native tool metadata/events; a Pi-style custom widget is not a prerequisite
for workflow parity. If custom rendering needs a separate TUI plugin, keep it
outside the server adapter.

## Persistence and migration

Add a schema version and distinct host/runtime identities. Store native worker
references as tagged opaque data, not universal file paths or integer IDs.
Record original task, counters, pending/completed request IDs, and recovery
capabilities. Validate reference ownership before reopening.

Read legacy Pi manifests without rewriting them in place. Existing Pi session
paths and durable conversation IDs must remain reopenable. New schemas need
explicit unsupported-version handling and atomic writes. Keep Pi's current data
location during the compatibility phase; resolve storage through an injected
store rather than importing Pi's agent directory from the core.

## Delivery sequence

1. Extract neutral contracts and the controller from `src/index.ts`; preserve Pi
   entrypoints, behavior, existing manifests, and default selection policies.
2. Move Pi SDK translation into its adapters. Prove the core loads without any Pi
   runtime dependency and run the existing Pi regression suite.
3. Pin an OpenCode API version and build a small integration spike: configure the
   three agents, execute two turns on the same child, run a restricted scout,
   stream progress, cancel, and reopen a stored session. Verify command/input and
   completion hooks before committing the host design. The locally installed
   OpenCode is v2.2.0; the v1 references below do not describe its plugin API.
   V2 uses `@opencode/plugin`, `Plugin.define`, and registry transforms, so target
   and validate v2 explicitly; do not mix v1 hooks with v2 examples.
4. Implement the OpenCode host/runtime against the shared controller and expose
   every existing user control. Test permission inheritance and session isolation.
5. Run the parity scenarios below against both real harnesses, then separate
   package entrypoints and document installation/version support.

## Definition of working parity

Both harnesses must demonstrate configure → execute → actual diff review →
revision → acceptance audit → optional final fix → final summary, plus:

- Small-task behavior, original-task retention, revision/final-fix guards, and
  bounded continuation after early supervisor settlement.
- Read-only scouts with invocation/tool budgets and concise citations.
- Persistent mode, status/stats, bounded chronological progress, and accurate
  role accounting without reasoning disclosure.
- Abort during execution/scouting, clean, fresh run, session shutdown, reconnect,
  and interrupted-run resume without accidental duplicate edits.
- Pre-existing dirty/staged/untracked changes attributed as in current Pi.
- No cross-session events, recursive Fusion runs, or concurrent workspace writers.
- Existing host permissions preserved and unsupported recovery guarantees visible.

Use shared controller tests for transitions and failure paths, adapter contract
tests for normalized events/lifecycle, and actual harness integration tests for
permissions, command interception, UI delivery, and restart behavior. Mock tests
alone cannot establish OpenCode parity.

## Sources and verification boundary

Research checked 2026-10-28. These establish feasibility, not a tested integration:

- [OpenCode agents](https://opencode.ai/docs/agents/): primary/subagent roles and
  model/permission configuration.
- [Plugin docs](https://opencode.ai/docs/plugins/) and
  [v1.19.4 plugin types](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/plugin/src/index.ts):
  configuration, tools, message hooks, and lifecycle events.
- [SDK](https://opencode.ai/docs/sdk/): programmatic sessions and events.
- [OpenCode v2 server plugins](https://opencode.ai/v2/docs/build/plugins/server/):
  v2 registries, session operations, and hooks for the local installation.
- [OpenCode v2.1.4 native subagent tool](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/tool/plugin/subagent.ts):
  actual child creation, permission checks, continuation, and cancellation.
- [v1.19.4 native task implementation](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/tool/task.ts):
  child sessions, task IDs, permissions, and cancellation. This is reference
  evidence, not a public module to import.

Open questions for the spike: complete user-control mapping, exact pre-tool cap
enforcement, effective SDK-child permissions, supported progress presentation,
completion interception, and recovery guarantees of the chosen release.
The local v2.2.0 process loaded the actual Fusion entrypoint under an isolated
temporary project, registered its tools, and returned the native missing-parent
rejection through the delegate tool. Actual worker sessions still need an
integration test.
