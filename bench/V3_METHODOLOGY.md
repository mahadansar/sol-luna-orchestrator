# Benchmark V3 methodology

## Freeze status

This document is the pre-results specification for Benchmark V3. It was frozen
before the first live V3 result was collected. It contains no V3 result,
pass rate, cost, latency, routing, or model-performance claim.

- Content-freeze commit: `544d217967646e5f48b9aa73e936567e87d87c8b`
- Initial normal campaign: nine tasks, two arms, and exactly two repetitions per
  task/arm cell (36 live runs).
- Any post-freeze correction follows the correction policy below and cannot
  silently change a task, arm, prompt, grader, repetition rule, or result.

The content-freeze SHA above identifies the reviewed workload and methodology.
This administrative record was added immediately afterward and is not a V3
result.

## Question and interpretation boundary

V3 asks when a bounded task should be completed directly by the supervisor and
when an adaptive supervisor should use the available Sol-Luna orchestration
path, comparing correctness first, then credits, then end-to-end latency, and
then diagnostic telemetry.

Benchmark V2 is frozen historical architecture evidence. It includes the Thin
Supervisor BEFORE/AFTER findings and records the behavior of those earlier
architecture candidates, guidance, and campaigns. V2 is not the primary
unbiased routing target for V3: its architecture state, task suite, prompt
history, and candidate probes are historical, and its results cannot be treated
as a fresh holdout of the V3 routing question. V3 is the fresh routing holdout.
V2 records remain immutable and are not reclassified as V3 evidence.

Evaluator-only categories are labels for fixture selection, analysis, and
predeclared routing hypotheses. They are never model-facing, never included in
the task objective or delegation brief, and never correctness grades. A model
must receive the same task contract and grading target regardless of the label.

## Fixed workload suite

The following nine task IDs, categories, and workload descriptions are copied
from the fixture task contract and are fixed for the campaign.

| Task ID                      | Evaluator-only category     | Workload description                                                                                                                                       |
| ---------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v3-csv-dialect`             | expected-solo               | Infer comma, semicolon, tab, or pipe dialects while respecting quoted separators, then distinguish label headers from typed data rows.                     |
| `v3-lru-cache-tests`         | expected-solo               | Author deterministic contract tests for an existing LRU cache, including recency updates, eviction, capacity validation, fluent writes, and missing reads. |
| `v3-reservation-ledger`      | likely-solo                 | Implement a coupled reservation ledger with shared inventory state, atomic holds and releases, expiry, idempotency, and cross-operation invariants.        |
| `v3-workflow-journal`        | likely-solo                 | Implement a coupled append-only workflow journal with ordered transitions, replay, idempotency, and consistent state-history invariants.                   |
| `v3-static-site-pipeline`    | strong-delegation-candidate | Implement tokenizer, template renderer, asset fingerprinter, and deterministic site assembly modules against explicit compatible contracts.                |
| `v3-observability-ingestors` | delegation-candidate        | Normalize JSONL traces and line-oriented access logs into one canonical request shape, then deterministically validate, deduplicate, and merge batches.    |
| `v3-markup-renderers`        | strong-delegation-candidate | Validate one immutable markup AST and independently render structural HTML, readable plain text, and canonical Markdown.                                   |
| `v3-policy-engine`           | ambiguous                   | Parse, compile, evaluate, and LRU-cache a small boolean policy language whose components share precedence and authorization semantics.                     |
| `v3-sync-reconciler`         | ambiguous                   | Plan and apply portable three-way file-tree reconciliation with normalized paths, rename detection, deterministic conflicts, and immutable inputs.         |

Each run materializes a fresh fixture workspace from the same immutable starting
state. Hidden reference material, mutation cases, evaluator categories, arm
names, routing hypotheses, and campaign analysis are not supplied to the model.
The task's declared verification and grading commands are run after the model
stops; model self-reports do not establish correctness.

### Grading and V2 distinctness

| Task                         | External grading strategy                                                                                                                                                                    | Material distinction from V2                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `v3-csv-dialect`             | Immutable `node:test` cases cover four delimiter modes, quoted separators, header inference, single-column fallback, and type rejection; a constant-result mutation must fail.               | Inference over sample records is not V2's layered configuration merge or front-matter parsing contract.                               |
| `v3-lru-cache-tests`         | The authored suite must pass the immutable cache and fail a mutation that omits read-recency refresh.                                                                                        | It grades cache eviction/recency test quality, not V2's fixed-window boundary tests.                                                  |
| `v3-reservation-ledger`      | Immutable state-machine cases cover stock competition, idempotent retry, commit/release exclusion, exact expiry, and validation; a non-transactional mutation must fail.                     | It centers temporary holds and lifecycle transitions rather than V2 checkout pricing, coupons, shipping, and final stock consumption. |
| `v3-workflow-journal`        | Immutable cases grade global sequence, per-workflow version, transition legality, command idempotency, defensive copies, and replay; a per-workflow sequencing mutation must fail.           | V2 has no append-only event journal or replay contract.                                                                               |
| `v3-static-site-pipeline`    | One immutable integration suite grades every module contract and their deterministic assembly; removal of content fingerprints must fail.                                                    | It is a coherent build pipeline, not V2's unrelated service-utility collection.                                                       |
| `v3-observability-ingestors` | Immutable parser and canonical-merge cases cover malformed input, field preservation, sorting, deduplication, and non-mutation; a reverse/no-dedup merge must fail.                          | It works over telemetry normalization, not V2 JSON Patch/ETag/circuit-breaker data contracts.                                         |
| `v3-markup-renderers`        | Immutable AST and output snapshots grade validation plus three render targets; an incomplete unescaped HTML renderer must fail.                                                              | It tests multiple projections of one shared tree rather than V2 repository-policy utilities.                                          |
| `v3-policy-engine`           | Immutable parser/evaluator/cache cases grade precedence, literals, missing paths, operators, syntax errors, LRU identity, eviction, and statistics; a parse/cache bypass mutation must fail. | V2 contains no language implementation or compiler/cache boundary.                                                                    |
| `v3-sync-reconciler`         | Immutable three-way merge cases grade independent edits, portable renames, conflicts, safe paths, application, and non-mutation; a no-op planner must fail.                                  | It evaluates reconciliation judgment and conflict planning, not V2 repository manifest/path/change summaries.                         |

## Arms and execution controls

The normal campaign has exactly these two arms:

| Arm             | Supervisor and effort   | Orchestrator availability and routing                                                                                              |
| --------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Solo Medium     | `gpt-5.6-sol`, `medium` | Orchestrator unavailable at the Codex configuration level. The supervisor completes the task directly.                             |
| Adaptive Medium | `gpt-5.6-sol`, `medium` | Orchestrator available. Zero, one, or multiple workers are all valid outcomes; the supervisor chooses whether and how to delegate. |

When Adaptive delegates, the worker model is `gpt-5.6-luna`. The actual effort
selected for every worker, worker count, task partition, batch mode, and
concurrency are recorded as observed routing telemetry; they are not inferred
from the evaluator-only category. The normal campaign does not force a worker
count or delegation outcome.

Forced Delegation is excluded from the normal V3 campaign. It may remain as a
narrow, separately identified diagnostic probe when a specific routing or
economic mechanism needs isolation. Such a probe cannot be pooled into normal
Adaptive results, used to change the frozen stopping rule, or presented as a
normal-arm comparison.

Both normal arms use the same task, starting workspace, objective, protected
specification, grader, verification contract, and supervisor model/effort.
Only orchestrator availability and the resulting valid routing decision differ.
Standard speed is required and Fast mode is disabled. No Fast, speed, service
tier, or alternate supervisor-effort arm is introduced. The launch operator
must confirm this execution profile before each campaign.

## Primary measures and decision order

Results are evaluated lexicographically in this order:

1. deterministic correctness and pass/fail outcome;
2. total estimated credits under the frozen pricing profile;
3. end-to-end wall-clock latency for the complete supervisor turn, including
   delegation setup, worker execution, integration, review, and verification;
4. diagnostic telemetry explaining routing, usage, concurrency, and failures.

Credits and latency do not compensate for a correctness regression. For
correctness-equivalent results, report absolute values and deltas against the
same-task Solo cell. Raw token counts are diagnostic only. They must not be
reported as credits, currency, or the primary economic measure.

Correctness is determined by the immutable grader and authoritative verification
outcome after the run. A worker claim, a supervisor statement, a refused or
skipped check, or an unverified self-report is not a pass. Missing measurements
remain unknown/null and are never converted to zero. A zero-worker Adaptive run
has a genuine worker count of zero and no Luna usage, subject to the runtime's
available telemetry.

## Pricing and economic accounting

Pricing is a measurement dependency, not a frozen assumption. Immediately
before live execution, revalidate that the existing V2 pricing profile still
applies to the account, model versions, and credit schedule. Reuse the V2
profile only if that validation is still true at launch. Otherwise create a new
dated profile, record its source, snapshot date, applicability, units, and rates
in the campaign evidence, and leave all V2 evidence unchanged.

The campaign records the complete profile used for every estimate: model,
uncached input, cached input, output, reasoning/output treatment, cache writes,
and any authoritative actual-credit field. The calculator charges uncached and
cached input separately and does not charge cache writes unless the revalidated
profile explicitly says otherwise. `rateCardCredits` or `estimatedCredits`
means a profile-based estimate, never authoritative billing. An incomplete
participant usage record yields unknown credits for that participant and the
affected aggregate; it is not zero-filled.

## Repetitions and review-only third runs

Freeze exactly two initial repetitions for every Solo Medium and Adaptive Medium
task cell. The initial design therefore contains 36 normal-arm runs. Repetition
order is fixed before launch, and each repetition uses a fresh workspace and a
new run identity.

A third repetition is review input, never automatic. It may be approved only
when at least one of these predeclared conditions holds:

- the two repetitions have inconsistent pass/fail outcomes;
- latency relative range is at least 25%;
- total-credit relative range is at least 20%;
- Adaptive delegates in one repetition but not the other;
- worker-count absolute difference is at least 2; or
- the non-Solo correctness-equivalent median-credit delta is within 10% of
  Solo.

The review records the triggering cell, metric values, decision, approver, and
reason before the third run starts. A third run is not allowed merely because a
result is surprising or inconvenient. Solo-vs-Solo near-ties are explicitly
excluded from third-run admission. No claim of statistical significance is made
from two or three repetitions; these are bounded directional evidence and
diagnostic review rules.

## Required routing, economic, and diagnostic telemetry

Every raw run record must preserve, or explicitly mark unavailable:

- campaign ID, run ID, task ID, arm, repetition, fixture revision, frozen
  methodology SHA, repository/architecture SHA, and execution timestamp;
- model and selected effort for the supervisor and every worker, speed profile,
  Fast-disabled confirmation, orchestrator availability, and environment
  metadata;
- Adaptive routing decision: zero/one/multiple workers, delegation tool/path,
  worker task IDs and thread IDs, task partition, sequential/parallel mode,
  configured and observed concurrency, retries/continuations, and integration
  or conflict state;
- supervisor and worker input, cached-input, output, reasoning, and cache-write
  token fields, with per-participant and aggregate credit estimates;
- start/end timestamps and end-to-end duration, plus individual worker
  durations, setup, integration, review, verification, timeout, and failure
  diagnostics;
- correctness grade, authoritative verification rows and exit codes, immutable
  specification check, mutation/holdout check, scope/evidence status, and the
  final run verdict; and
- raw evidence paths, the exact campaign invocation/configuration, pricing
  profile ID and validation record, and any approved third-run review record.

Raw JSON/event evidence is authoritative for measured fields. Human summaries
must link each conclusion to retained raw evidence and must distinguish unknown,
not applicable, zero workers, and zero tokens.

For the predeclared straggler diagnostic, a run is counted only when at least
two workers and both timing fields are observed. It is a straggler when the
slowest worker duration is at least 75% of the complete worker window. Single-
worker runs and missing timing remain not applicable/unknown rather than false.

## Holdout integrity and anti-gaming rules

The holdout remains a routing evaluation, not a prompt optimization exercise.
Before launch:

- freeze the nine task contracts, hidden references, graders, mutation cases,
  protected methodology, and verification commands;
- give both normal arms the same task-facing objective and context, omitting
  evaluator-only categories, expected routing, arm labels, campaign IDs,
  repetition numbers, pricing, and stopping rules;
- keep fixture order and repetition assignment predeclared or independently
  randomized from a recorded seed; do not reorder based on an observed result;
- use fresh isolated workspaces and clean model sessions for every repetition;
- do not inspect hidden references, grading fixtures, other arm results, raw
  telemetry, or prior attempts while the model is solving a task;
- do not add examples, hints, decomposition instructions, delegation commands,
  category labels, or task-specific effort guidance after seeing results;
- do not tune the fixture, prompt, grader, concurrency, model, speed, pricing,
  or stopping rule to improve an arm; and
- quarantine any run with contamination, an environment failure, a changed
  contract, or a post-start configuration drift instead of silently repairing
  its result.

The evaluator may use the category labels and hidden cases after execution for
analysis, but never as a model-facing correctness criterion. Narrow Forced
Delegation diagnostics follow the same holdout protections and remain separate
from the normal campaign.

## Campaign checkpoints and evidence

The supervisor must retain a checkpoint before live execution containing the
frozen methodology, fixture-contract revision, architecture/repository SHA,
pricing validation or new pricing profile, launch configuration, task order or
seed, arm list, repetition plan, and expected raw-output locations. The launch
must assign a unique campaign ID and include it in every raw record.

At completion, retain raw per-run records, event/telemetry evidence, verifier
outputs, grader outputs, campaign configuration, pricing evidence, and any
review decision for a third repetition. Generated summaries are derived views;
they must not overwrite raw evidence or historical V2 files.

## Post-freeze correction policy

After the content-freeze commit, corrections are limited to factual or
mechanical defects discovered before the affected live run and must be logged
with the old text, new text, reason, reviewer, timestamp, and new content SHA.
A correction that changes workload semantics, hidden grading, arm availability,
model, effort, speed, pricing applicability, telemetry definition, repetition
admission, or holdout integrity invalidates the pending campaign and requires a
new freeze review and new campaign ID.

If a live run has already started, do not edit its contract or reinterpret it.
Quarantine the affected run, preserve its raw evidence, explain the deviation,
and decide explicitly whether it is excluded from the normal set or the entire
campaign is restarted under a new frozen SHA. Never rewrite V2 evidence and
never retroactively turn an exploratory or Forced Delegation probe into a normal
Adaptive result.

## Reporting limits

The final V3 report will present correctness first, then correctness-equivalent
credit comparisons, then end-to-end latency, with routing and raw-token data in
diagnostic sections. It will state the number of valid and quarantined runs,
unknown fields, any approved third repetitions, and pricing profile identity.
It will not claim that Adaptive should always delegate, that a category is a
correctness grade, that raw tokens equal credits, that V3 proves universal
superiority, or that the repetition sample establishes statistical
significance.
