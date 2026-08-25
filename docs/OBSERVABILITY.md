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

## What the event stream contains

Records are appended as the run progresses: batch started, completed, cancelled
or rejected; task queued; worker started, completed, failed, cancelled or timed
out; worktree created, removed or retained; verification started and completed;
scope conflicts; integration conflicts, applied file counts, and completed,
not-attempted, partial or failed integration; final-workspace verification
started and completed; bounded repair started and completed; and bounded
recovery skipped, started, and completed.

Parallel recovery keeps the original batchId/taskId and emits an explicit attempt
ordinal. Its classification and concise evidence identify a timeout continuation
or a fresh-process retry, while separate initial/recovery duration and usage
remain in the structured result and recovery completion event. Recovery decisions
are made before integration and cleanup; an opted-out or ineligible task emits a
skipped decision rather than another worker turn. The JSON activity snapshot keeps
the recovery attempt, classification, evidence, initial/recovery usage and duration;
the human view labels running and completed recovery turns.

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

Deliberately **not** written to this stream:

- Worker objectives and prompts
- Task context (`context`, `contextCapsule`)
- Source code
- Verification command output — only a short failure reason may surface

Task ids are opaque (`t1`, `t2`, …) and batch ids are generated: neither is
derived from the objective text, so an id can never leak the brief. Paths,
labels, conflicting file names and failure reasons can still be revealing.

Legacy and hand-edited JSONL are treated as untrusted input. Every line is
validated against the known event shapes; unknown properties and malformed
optional legacy fields are dropped rather than trusted, and strings are stripped
of control characters again on read, so a crafted event cannot rewrite the
terminal it is rendered into.

Current writers omit objectives and task context, but an activity file retained
from a pre-hardening version may still contain older schema fields such as an
objective. Rotate or remove historical JSONL if that older local content is too
sensitive to retain. The current reader validates and drops unsupported fields;
it does not rewrite the file on disk.

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
  including retained-worktree diagnostics. Older records use truthful unknown
  or empty defaults for fields introduced later.

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

Per-worker usage is recorded exactly as the Codex SDK reports it on
`turn.completed`:

| Field                   | Meaning                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `inputTokens`           | Prompt tokens for that worker's turn                                                                  |
| `cachedInputTokens`     | Portion of the input served from cache                                                                |
| `cacheWriteInputTokens` | Input tokens written to the prompt cache; optional because older SDK/event records may not include it |
| `outputTokens`          | Tokens the worker generated                                                                           |
| `reasoningOutputTokens` | Reasoning portion of the output                                                                       |
| `model`, `effort`       | Which model and effort that worker ran at                                                             |
| `durationSeconds`       | Wall-clock for that worker                                                                            |

**Anything unavailable is written as `null`, never as `0`.** A cancelled or
crashed worker produces no usage at all, and `null` means exactly that: not
measured. The additive `cacheWriteInputTokens` field is omitted when the SDK or
historical event record does not provide it; repair-turn totals only add it when
both turns report it, otherwise the aggregate field remains omitted. Reading
missing data as zero would turn unknown usage into free work.

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
