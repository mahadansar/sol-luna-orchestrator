# Observability

How the orchestrator records what it did and which file holds what. This
document owns the event and activity representations. For path setup and
precedence see [Configuration](CONFIGURATION.md#activity-and-diagnostics-logs);
for sensitivity and sharing advice see
[Logs and telemetry](../SECURITY.md#logs-and-telemetry).

## Diagnostic log vs activity event stream

Two separate local files, holding deliberately different things.

1. **Diagnostic log (`SOL_LUNA_LOG`)** — line-oriented human-readable
   diagnostics for the server itself: client connections, each delegation as it
   starts and finishes, objective previews for single delegations, working
   directories, thread ids, durations, verdicts, and errors. Verification
   command output is returned in tool-result evidence; it is not copied into
   this diagnostic log.
2. **Activity event stream (`SOL_LUNA_EVENTS`)** — an append-only JSONL file of
   structured orchestration records. This is what `sol-luna-orchestrator activity`
   reads.

The event stream is append-only JSONL; the diagnostic log is line-oriented.
Representation details below describe what each contains and how consumers
should interpret it. Sensitivity and sharing boundaries are defined in
[Security](../SECURITY.md#logs-and-telemetry).

## Model-facing result surfaces

The human-readable tool text has a thin fast path for a clean verified PASS. It
contains verdict and task/batch identity, observed changed paths, authoritative
verification counts, integration status, an eligible continuation reference,
and only actionable risks. It omits routine summaries, usage dumps,
transcript-like narration, and generic review prose; actionable worker notes are
surfaced as risks. Failed, blocked, untrustworthy,
discrepant, scope-violating, refused/skipped, runtime-error, partial, and
integration-conflict results retain progressive diagnostics. The default
`resultDetail=handoff` omits `structuredContent` only for a clean verified PASS;
non-clean results expand automatically. Explicit `compact` retains the
compatibility structure but removes successful verification output, while
`full` returns the complete structure.

A clean batch additionally reports `completionState: "verified-complete"` and
`TERMINAL: VERIFIED_COMPLETE` only after final-workspace verification of the
deduplicated declared checks. The handoff directs the parent to finish without
routine file rereads or duplicate checks. `needs-supervisor` retains the final
failure, refusal, skip, or incompleteness evidence for targeted diagnosis.

Current structured task outcomes also carry `failureDecision`: one conservative
classification and next action, the canonical execution ids consulted, optional
next effort, any automatic repair/recovery handler already used, and the bounded
automatic retry count/limit. This is result evidence, not a separate activity
event. It contains no prompt, source, command output, or new usage estimate.

An eligible failed result may return an opaque `handoffReference` directly to
that caller. The token is deliberately absent from diagnostic logs, the event
stream, usage records, and activity history; those surfaces record only routing
recommendations, selections, and factual execution. Handoffs live in memory for
15 minutes and are single-use. A server restart loses them, and later consumption
fails conservatively as unknown rather than reconstructing authority from logs or
caller-supplied history.

## What the event stream contains

Records are appended as the run progresses: batch started, completed, cancelled
or rejected; task queued; worker started, completed, failed, cancelled or timed
out; canonical attempt started and completed; worktree created, removed or
retained; verification started and completed;
scope conflicts; integration conflicts, applied file counts, blocked integration, and completed,
not-attempted, partial or failed integration; final-workspace verification
started and completed; bounded repair started and completed; bounded recovery
skipped, started, and completed; cheap routing preflight, declaration, and
contradiction records; safe context pressure evaluation and compaction events;
and automated workflow started, transition, and completion events.

Every execution for which the runtime invokes the worker SDK has a unique
`executionId` and emits `attempt.started` before invocation. Unless the host
process itself dies, exactly one `attempt.completed` follows. The terminal event
records the logical attempt ordinal, role (`initial`, `automatic-repair`,
`manual-continuation`, `timeout-recovery`, or `process-retry`), predecessor,
requested model/effort, thread operation and identity match when knowable,
timestamps, elapsed worker/verification time, configured timeout, factual
termination, usage status, claimed outcome, and authoritative verification
counts. A real host crash may leave only the start event; that is truthful
incomplete evidence rather than a fabricated completion.

Attempt termination is a runtime fact, not a derived P1.1 diagnosis. Known
categories are `completed`, `timed-out`, `cancelled`, `turn-failed`,
`stream-error`, `process-exit`, and `runtime-error`. Untyped SDK exceptions stay
`runtime-error`; their text is not promoted to a network, transport, provider,
or implementation classification. Terminal messages and verification output
remain in structured tool-result evidence, not attempt activity events.

The family list above describes the raw JSONL writer, not the narrower
`activity` snapshot schema. The current reducer recognizes delegation/attempt,
worktree, verification, repair/recovery, integration-summary, and exploration
lifecycle records. It deliberately does not project routing, context,
`integration.blocked`, or workflow records into the latest-batch snapshot; those
remain available to consumers of the raw event stream. Unknown records are
validated out rather than treated as snapshot facts.

There is no separate `shutdown.*` family. Caller cancellation or graceful
`SIGINT`/`SIGTERM` shutdown uses the ordinary `worker.cancelled`,
`batch.cancelled`, and canonical cancelled-attempt evidence when those
lifecycles can settle. If the host process dies before emission, a terminal
record may be absent; the event log does not manufacture one on restart.

Parallel recovery keeps the original batchId/taskId and emits an explicit attempt
ordinal. Its classification and concise evidence identify a timeout continuation
or an exact process-exit retry, while separate initial/recovery duration and usage
remain in the structured result and recovery completion event. Recovery decisions
are made before integration and cleanup; an opted-out or ineligible task emits a
skipped decision rather than another worker turn. The JSON activity snapshot keeps
the recovery attempt, classification, evidence, initial/recovery usage and duration;
the human view labels running and completed recovery turns.

The structured task result carries the same canonical `attempts` history. Repair,
manual continuation, timeout recovery, and process retry append records linked to
their predecessor; they do not overwrite the earlier execution. A batch task also
retains this history when no nested final result could be built, so completed
siblings remain independently attributable. Post-execution continuation,
worktree, integration, or cleanup failure changes the batch to
`needs-supervisor` and retains completed evidence rather than rejecting the whole
result. Historical results and event streams without `attempts` remain readable.

Worktree events describe the outcome after configured cleanup, not merely why a
worktree might have been useful. `worktree.removed` carries the historical
`kept` boolean, and `worktree.retained` is emitted only when the path actually
remains. Integration conflict, partial, failed, disabled, or not-attempted
events preserve what happened independently of retention. Consequently an
integration diagnostic can be followed by cleanup with no retained-worktree
event when `SOL_LUNA_KEEP_WORKTREES=never`.

An explicit `continue_task` turn emits the same ordinary single-task lifecycle
events and receives a fresh completion record. The opaque continuation reference
itself is returned only in the tool result; it is not persisted in this event
stream, and references expire with the server's in-memory store.

An opted-in automatic repair emits `repair.started` and `repair.completed` on
the original task id, with turn fixed to `1`. The start records the conservative
classification and the completion records the repaired verdict. Failure command
output is deliberately absent from activity events; it remains in the tool
result's repair evidence for the parent. The activity view shows both an active
repair and whether its single turn passed or was exhausted.

Carried on those records:

- Opaque task ids, and a batch id
- Worker model and effort, and the configured worker model before a worker starts
- Worker thread id, start and end times, duration
- Verdict, claimed status, changed-file count, concise failure reason
- Verification counts (passed, failed, refused) and the command count
- Token usage per worker, or `null`
- Working-directory and worktree paths, and whether a worktree was kept
- Optional explicit `activityLabel` (never derived from the objective)
- Batch mode, task count and configured concurrency
- Attempt ordinal and bounded recovery classification/evidence when applicable
- Per-execution identity, role, predecessor, lifecycle timing, termination, and
  reported/unavailable usage status
- Raw declared routing values, seam and unknown counts, matched rule, resolved
  route, explicit/defaulted card provenance, gates and signals
- Recommended routing shape and compute selection; factual worker lifecycle
  records separately carry the model and effort that actually ran

Deliberately **not** written to this stream:

- Worker objectives and prompts
- Task context (`context`, `contextCapsule`)
- Source code
- Attempt termination messages and sensitive subprocess output
- Verification command output — only a short failure reason may surface
- Routing seam labels, routing rationale, routing scores, and cost estimates

Task ids are opaque (`t1`, `t2`, …) and batch ids are generated: neither is
derived from the objective text, so an id can never leak the brief. Paths,
labels, conflicting file names and failure reasons can still be revealing.

Legacy and hand-edited JSONL are treated as untrusted input. Every line is
validated against the known event shapes; unknown properties and malformed
optional legacy fields are dropped rather than trusted, and strings are stripped
of control characters and bearer-shaped `ctr_*` / `hdf_*` values again on read,
so a crafted event cannot rewrite the terminal it is rendered into or expose a
capability-shaped value. Current writers apply the same sanitization recursively
before file or injected event sinks receive nested message, array, or accounting
metadata. Short prefix prose that is not capability-shaped remains unchanged.

Current writers omit objectives and task context, but an activity file retained
from a pre-hardening version may still contain older schema fields such as an
objective. Rotate or remove historical JSONL if that older local content is too
sensitive to retain. The current reader validates and drops unsupported fields;
it does not rewrite the file on disk.

### Routing preflight records

Three records describe cheap routing. They are decision records, not lifecycle
records, and the activity reducer deliberately does not know them: it drops
unknown event shapes, so they never alter an `ActivitySnapshot` or raise an
operator warning.

`routing.preflight` records one advisory `routing_preflight` call. It carries a
`preflightId`, matched rule ID, resolved route, card provenance (`explicit` or
`pessimistic-defaults`), seam count, unknown count, gates, signals, and
`parallelEligible`, plus the five raw declared values. It also records the bounded
recommended mechanism, worker count, concurrency and effort, followed by the
selector's model, effort and reason. It has **no** `batchId` and no actual execution
fields because no batch or worker exists at that point.

It does not create, mutate, evaluate, or compact a persisted execution context.
There is no server-authoritative lineage key at preflight time, so associating it
with a later call would risk mixing unrelated requests.

### Context lifecycle records

`context.evaluated` is emitted only when an isolated execution context is actually
evaluated after delegation, batch, or continuation work. It carries numeric pressure,
reference counts, cooldown state, the evaluated boundary, and the factual decision and
reason codes. `context.compacted` is emitted only when that evaluation really creates a
new projection. Neither event contains task contracts, prompts, verification output,
worker output, paths, failure prose, secrets, or continuation/handoff capability values.

`routing.declared` records what a real delegation call declared. It always
carries `batchId`, `declaration` (`attached` or `absent`), `mode`, and
`taskCount`. An attached declaration additionally carries `seamCount`,
`unknownCount`, matched `ruleId`, resolved `route`, `cardProvenance`, `gates`,
`signals`, `refusedGate` (or `null`), the raw
declared values, and `parallelEligible`. An absent declaration carries none of
those: nothing was evaluated, so no route or eligibility is claimed for it.
Attached declarations also carry the same recommended/selected fields as preflight.
They deliberately do not claim what executed: a later gate may still refuse the
call. Factual `task.queued`, `worker.started`, per-attempt, and `worker.completed`
records carry the model and effort actually requested or observed. Those values may
differ because routing advice is advisory and never rewrites an admitted task contract.

`routing.contradiction` records that the runtime's own already-computed evidence
disagrees with the declaration — `declared-disjoint-core-scopes-overlap` when
declared-disjoint cores have overlapping declared scopes, and
`declared-disjoint-core-files-collided` when workers demonstrably wrote the same
file. Each keeps only the declared value and a count of what was observed. These
are advisory records: the existing scope and integration gates remain
authoritative for what actually happens.

Routing records its evaluation before it enforces it, so an attached card appears
in `routing.declared` — including the `refusedGate` it would have refused on —
even when the observed scope-conflict gate rejects the batch first. A rejection
therefore has exactly one `batch.rejected` reason, while telemetry still shows
what routing concluded.

Declared values are recorded **raw**, never conservatively resolved, so a reader
can always distinguish a declared hazard from an admitted `unknown` — which is
also why `unknownCount` is kept. Deliberately **not** written for any routing
record: seam labels, objective text, free-text rationale, any numeric routing
score, and any cost estimate. The seam count is kept because a count describes no
work; the labels are dropped because they can.

### activityLabel

`activityLabel` is optional, concise, and supplied explicitly by the parent in
the task contract (for example, `Update auth retries`). Unlike the objective it
**is** persisted locally, deliberately, because the human view is close to
useless without it — and because it is persisted it can reveal a short
description of the delegated work. Provide it whenever a safe label is
available, omit it when the subject itself is sensitive, and never derive it
from or copy the objective.

When it is absent, the human and watch views use a safe label for the explicit
`taskCategory` when one is present (for example, `Implementation task`). If
both semantic fields are absent, they fall back to `Delegated task N`, where
`N` is the worker's position in the run. A generic warning notes that the
positional fallback was needed. None of these fallbacks is derived from the
objective or the opaque task id.

### Exploration telemetry

The `explore` tool emits typed lifecycle events to record investigation companion sessions:

- `explore.started`: emitted only after the disposable surface and worker slot are ready; records `batchId`, optional non-sensitive `activityLabel`, requested and selected model/effort, and the admitted `computePolicy`.
- `explore.completed`: records `batchId`, final `verdict`, claimed worker status, duration, worker-grounded-claim/runtime-fact/inference/unknown counts, actually executed model/effort, and provider `usage`.
- `explore.rejected`: emitted only before execution starts and records `batchId` plus a bounded `reasonCode` (`compute-policy` or `execution-setup`). An admitted execution error completes as `FAILED` instead.

Exploration telemetry never includes the target or prompt, working-directory or source paths,
source excerpts, thread ids, raw worker output, capability references, or free-form error text.
Canonical `attempt.started` and `attempt.completed` records carry the same bounded compute and
termination evidence as other worker-capacity consumers.

### Workflow telemetry

The automated workflow coordinator emits allowlisted structural events:

- `workflow.started`: emitted when an automated workflow begins execution; records `workflowId`, optional `batchId`, `taskCount`, `requestedMode`, `requestedWorkerCount`, `requestedModels`, `requestedEfforts`, `maxSteps`, `maxEscalations`, `maxContinuations`, `importedContext` flag, and admitted `computePolicy`.
- `workflow.transition`: emitted on each state machine step transition; records `workflowId`, optional `batchId`, `fromState`, `toState`, `reasonCode`, `stepNumber`, and optional advisory routing fields (`recommendedMode`, `recommendedWorkerCount`, `recommendedConcurrency`, `recommendedEffort`, `selectedModel`, `selectedEffort`).
- `workflow.completed`: emitted when the workflow reaches a terminal state; records `workflowId`, optional `batchId`, `finalState`, terminal `status`, `durationMs`, `totalSteps`, `passed`, `delegated`, `explored`, `escalated`, `executionMode`, and actually observed executed compute (`executedModels`, `executedEfforts`).

Workflow telemetry uses allowlisted structural fields and never includes prompts, objectives, task context, working-directory or source paths, file contents, raw worker output, verification command outputs, or bearer capability references (`ctr_*`, `hdf_*`). Requested, recommended, and executed compute remain explicitly separated.

## The two representations of a single delegation

Current behaviour, and the thing most likely to trip up anyone parsing the JSONL
directly.

A normally returned `delegate_task` result is written **twice**:

- as typed lifecycle events — a synthetic single-mode batch (`mode: "single"`,
  `taskCount: 1`, task id `t1`) plus the worker records, and
- as one legacy typeless record: a flat line with no `type` field carrying model,
  effort, attempt, verdict, trustworthiness, thread id, duration, and counts of
  changed files, scope violations and discrepancies.

A rejected call or a failure before a normal result has typed lifecycle evidence
only. A `delegate_tasks` batch also writes typed events only.

`activity` is unaffected — the typeless line fails event validation and is
dropped, so the CLI counts each delegation once. A consumer reading the raw file
must reconcile the pair itself or it will double-count every single delegation.
Thread identity is the field that links the two, and both representations have
always carried it.

## Human view vs `--json`

- **`sol-luna-orchestrator activity`** renders the latest run for a person: batch
  state, mode, active/total workers, elapsed time and peak concurrency, then one
  compact block per worker with its label or safe category fallback, model,
  effort, state, duration, verification outcome, changed-file and check summary,
  and any known failure reason, followed by scope and integration conflicts plus
  concise integration or retained-worktree warnings. It never prints
  opaque task, batch or thread ids, absolute/worktree paths or token counts — not
  even on failure. Failure diagnostics redact path-like details while preserving
  their concise reason. Those details exist for machines, and crowding them into
  the terminal made the view harder to read without making it more truthful.
- **`sol-luna-orchestrator activity --json`** prints one reduced snapshot of the
  same latest run as machine-readable JSON — not the raw event lines. It is the
  fuller projection: it does include the task, batch and thread ids, worktree
  paths, per-worker token usage and the verification and integration breakdowns,
  including retained-worktree diagnostics. Its per-worker `attempts` history
  keeps execution lineage and reported/unavailable usage independently; legacy
  worker events are still reduced for compatibility but do not duplicate a
  canonical attempt. Older records use truthful unknown or empty defaults for
  fields introduced later.

`--watch` and `--json` cannot be combined; the CLI rejects the pair rather than
guessing which was meant.

### Snapshot semantics

Both views reduce the whole event history to the **latest batch**, not a
cumulative total across every run. Reduction is deterministic and tolerates
out-of-order and non-ISO timestamps in old files.

Integration diagnostics use typed `integration.completed`,
`integration.notAttempted`, `integration.partial`, `integration.failed`, and
`integration.disabled` events plus `worktree.retained` records. The reduced JSON
reports an `unknown`, `completed`, `notAttempted`, `conflicted`, `partial`,
`failed`, or `disabled` integration status, file counts when known, retained-worktree count,
and generic warnings. Historical `integration.applied` records alone remain
unknown because they did not prove that every attempted copy succeeded. Human
and watch views render integration facts without claiming a worktree was kept;
an actual `worktree.retained` event supplies that separate warning. They do not
render command output, objectives, thread ids, or raw retention paths.
Raw `integration.blocked` records identify the excluded task and either a
`scope-violation` or `protected-control-path` reason; the current reduced
snapshot derives its public integration summary from the terminal integration
events above rather than projecting `integration.blocked` itself.

Typed `integration.verification.started` and
`integration.verification.completed` events are reduced into a separate final
workspace verification summary. Human and JSON views expose passed, failed, and
refused counts without inventing another worker; the raw command strings and
their output remain outside the activity stream.

`--watch` folds the existing history silently at startup and renders only that
latest run, so an old log does not scroll past. It attaches its watcher before
reading history, and records appended during that catch-up are replayed as a
normal incremental read rather than falling into the gap. Before anything has
ever been delegated it prints `No orchestration activity found.` and keeps
waiting, so it is safe to start the watcher first.

The snapshot also carries a legacy `objective` field. It is always `null`:
objectives are not persisted, and the field survives only so that older readers
do not break.

## Usage data

Authoritative worker usage comes only from an observed Codex SDK
`turn.completed` event. Each execution record carries either
`{ status: "reported", source: "codex-turn.completed", value: ... }` or
`{ status: "unavailable", reason: ... }`; elapsed time, another execution, and
error text are never used to estimate tokens.

| Field                   | Meaning                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `inputTokens`           | Prompt tokens for that worker's turn                                                                  |
| `cachedInputTokens`     | Portion of the input served from cache                                                                |
| `cacheWriteInputTokens` | Input tokens written to the prompt cache; optional because older SDK/event records may not include it |
| `outputTokens`          | Tokens the worker generated                                                                           |
| `reasoningOutputTokens` | Reasoning portion of the output                                                                       |
| `model`, `effort`       | Which model and effort that worker ran at                                                             |
| `durationSeconds`       | Wall-clock for that worker                                                                            |

**Anything unavailable is written as `null`, never as `0`.** A timeout,
cancellation, failed turn, stream/runtime error, or abnormal process exit may
produce no `turn.completed` event; in that case exact usage is fundamentally
unavailable to this runtime. A later repair or recovery cannot reconstruct it.
The attempt retains the factual unavailable reason and any other evidence that
was already observed.

Top-level task usage is a complete aggregate, not a known-minimum subtotal. It
is non-null only when every constituent execution being aggregated has reported
authoritative usage: known + known is summed, while known + unknown and unknown

- unknown are `null`. Known constituent usage remains visible in its own attempt
  record. Within an otherwise complete aggregate, the additive
  `cacheWriteInputTokens` field is included only when every constituent reported
  that optional meter; omitting that one meter does not erase the other complete
  token totals. Historical records without attempt evidence remain readable.

The parent's own usage is not among these fields and cannot be: Codex does not
report the parent turn to an MCP server it launched, so the snapshot's
`supervisor.usage` is permanently `null` and `supervisor.state` reports only what
the stream can honestly support. The benchmark harness records parent usage
separately because it drives the parent itself.

## Test isolation

Deterministic tests never write synthetic telemetry into the configured
production paths. Each test supplies its own events file, so running the suite
cannot pollute the activity history or the diagnostic log of the machine it runs
on.
