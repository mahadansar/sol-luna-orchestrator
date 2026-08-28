# Benchmark V3 methodology

## Freeze status

This document is the pre-results specification for Benchmark V3. It was frozen
before the first live V3 result was collected, and no live V3 run has been
executed under any freeze. It contains no V3 result, pass rate, cost, latency,
routing, or model-performance claim.

- Freeze review: **freeze 2 (P2.4A)**, superseding the freeze-1 content commit
  `544d217967646e5f48b9aa73e936567e87d87c8b`.
- Methodology content digest: `af4860bed58f21c103c5f921c4ae3bd561cf2e0943cd1dd12b899a34a4bacc87`, verified at launch by `assertMethodologyFrozen`.
- Initial normal campaign: nine tasks, two arms, and exactly two repetitions per
  task/arm cell (36 live runs).
- Any post-freeze correction follows the correction policy below and cannot
  silently change a task, arm, prompt, grader, repetition rule, or result.

Freeze 1 fixed the workload, arms, graders, repetition rules, holdout
protections, and economic accounting. Those are unchanged and remain in force.
Freeze 2 changes nothing a model can observe. It adds the measurement,
reproducibility, exclusion, and reporting discipline in the sections below, and
makes one deliberate change to what the harness configures: V3 no longer passes
a per-fixture worker-concurrency ceiling, because that ceiling was derived from
the same stream count that defines the evaluator-only routing category. Neither
change is comparable to a mid-campaign edit: no V3 run existed under freeze 1,
so nothing is being reinterpreted after the fact.

Because freeze 2 alters telemetry definitions and harness configuration, it is a
new freeze review under the correction policy below and requires a new campaign
ID. No freeze-1 campaign ID may be resumed under it.

Identity is content-addressed rather than commit-addressed. The digest above is
the sha256 of this file with line endings normalized and the digest line itself
removed, so the gate works in a working tree, a published tarball, or a checkout
whose history was rewritten. `src/bench/integrity.ts` holds the expected value
and `assertMethodologyFrozen` enforces it at launch.

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

## Comparison candidates and baselines

The campaign compares exactly two candidates on identical work. Both run the
current Thin Supervisor / adaptive runtime at the same commit; the only
difference is whether that runtime's orchestration path is reachable.

| Candidate       | What it is                                                                                                                                                          | Role                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Solo Medium     | `gpt-5.6-sol` at Medium with the orchestrator disabled at the Codex configuration level. The supervisor reads, implements, and verifies the task itself.            | Within-campaign baseline   |
| Adaptive Medium | The same supervisor and effort with the orchestrator available: P1.2 adaptive routing, P1.3 context lifecycle, P2.1 exploration, and P0.3/P0.4 continuation/repair. | Candidate under evaluation |

Every per-task comparison is against that task's own Solo Medium cell in the
same campaign, never against a different task, a different campaign, or a
historical record.

Three further baselines exist and are explicitly **not** campaign arms:

- **Benchmark V2 (frozen historical architecture evidence).** V2 measured an
  earlier architecture on a different task suite with a different prompt
  history, a per-fixture concurrency ceiling, and a different telemetry schema.
  It may be cited for direction and for architectural context. It may not be
  differenced against V3, pooled with V3, or presented as the same measurement
  under a larger sample. Any V2/V3 sentence in the final report must name the
  methodology differences that make the two incomparable.
- **Forced Delegation.** Excluded from the normal campaign, as under freeze 1.
  It survives only as a separately identified diagnostic probe and can never be
  pooled into Adaptive results.
- **Deterministic acceptance evidence.** The P1/P2 test suites establish that a
  capability exists and is bounded. They establish nothing about latency, cost,
  or routing quality, and V3 establishes nothing about the correctness of the
  primitives they cover. The two evidence classes are reported separately and
  neither substitutes for the other.

Both candidates receive identical tasks, identical starting workspaces,
identical objective text apart from the arm's delegation-availability sentence,
identical acceptance criteria, identical grading commands, identical mutation
and immutable-specification checks, identical supervisor model and effort, and
the same standard-speed execution profile.

## Harness configuration boundary

The runner measures the shipped product. It does not tune it.

- The benchmark configures **no** orchestrator policy for V3. It sets the events
  path so telemetry can be read, and nothing else. Worker concurrency, batch
  limits, effort ceilings, executor ordering, retention, and context thresholds
  are whatever the shipped defaults are.
- In particular, V3 does **not** set `SOL_LUNA_MAX_PARALLEL`. V2 set it per
  fixture, to that fixture's declared natural stream count. In V3 that stream
  count is derived from the same structure that defines the evaluator-only
  routing category, so passing it through would hand the orchestrator a
  task-specific hint about the exact question V3 asks. `resolveWorkerConcurrency`
  enforces this, and a deterministic test proves no V3 task can produce a
  per-task value. V2's historical records keep their original behaviour.
- No task identity appears in harness control flow. There is no per-task prompt,
  guidance, timeout, grading tolerance, routing hint, or special case keyed on a
  V3 task ID.
- The runner introduces no benchmark-only production behaviour and mutates no
  orchestrator production policy. Anything a benchmark run can do, a user's run
  can do.
- Both arms' guidance text is fixed in `ARMS` and is identical apart from
  whether delegation exists. Neither text mandates, forbids, or hints at a
  worker count.

## Metric catalog and measurement semantics

Every metric below is fixed before any V3 result exists. Each is either an
observed fact or explicitly unknown; a quantity that was not reported is `null`
and is never converted to zero, an average, or an estimate.

### Correctness and verification

| Metric                       | Semantics                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `passed`                     | Every declared grade command exited zero, no immutable specification file changed, and the mutation check caught. |
| `grades[]`                   | Per-command label, exit code, and captured output. A `null` exit code means the grader did not execute.           |
| `immutableViolations[]`      | Protected specification files whose content hash changed. A scope violation, not a stylistic finding.             |
| `mutationCaught`             | Whether the work fails the predeclared mutation. `null` when the task declares none.                              |
| `verificationFailed/Refused` | Authoritative in-run verification outcomes counted from `verification.completed`.                                 |
| `integrationVerification`    | The integrated workspace's re-run of the deduplicated declared checks. `null` when no batch integrated.           |
| `integrationConflicts`       | Distinct integration conflicts. A correctness-relevant orchestration cost, not a latency detail.                  |
| `scopeConflicts`             | Declared-scope violations detected by the runtime.                                                                |
| `routingContradictions`      | Declarations the runtime's own evidence contradicted.                                                             |

### Latency and supervisor overhead

| Metric                    | Semantics                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `durationSeconds`         | End-to-end wall-clock for the complete supervisor turn: reading, contracts, setup, workers, integration, review, verification. |
| `supervisorBeforeSeconds` | Run start to the first `batch.started`. Supervisor work before any worker exists.                                              |
| `worktreeSetupSeconds`    | First `batch.started` to the last `worktree.created`.                                                                          |
| `workerWindowSeconds`     | First worker start to last worker end.                                                                                         |
| `slowestWorkerSeconds`    | Longest single worker span, for straggler analysis.                                                                            |
| `integrationSeconds`      | Last worker end to `batch.completed`.                                                                                          |
| `supervisorAfterSeconds`  | `batch.completed` to run end. The thin-handoff cost.                                                                           |
| `peakConcurrency`         | Highest number of workers alive at one instant, from start/end sweeps rather than from configuration.                          |

Supervisor overhead is derived from event timestamps the runtime already emits.
No timing instrumentation is added for the benchmark, so measurement cannot
perturb what is measured. Individual worker durations are never summed into, or
substituted for, end-to-end wall-clock. A phase never observed is `null`.

### Worker and model calls

| Metric                                       | Semantics                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `workerCount`                                | Distinct worker delegations observed. Zero is a valid, first-class Adaptive outcome.            |
| `delegationCalls`, `batchesByMode`           | Delegation calls that opened a batch, split by single / sequential / parallel.                  |
| `attemptsStarted`, `attemptsCompleted`       | Individual worker SDK invocations, from canonical `attempt.*` lineage.                          |
| `attemptsByRole`                             | `initial`, `automatic-repair`, `manual-continuation`, `timeout-recovery`, `process-retry`.      |
| `explorations`, `explorationsRejected`       | Read-only `explore` calls admitted and refused.                                                 |
| `routingPreflights`, `routingDeclarations*`  | Advisory routing evaluations, and whether a call attached a declaration at all.                 |
| `maxParallelConfigured`, `concurrencyPolicy` | What the harness configured, and under which rule. For V3 always `null` / `production-default`. |

### Token usage

Token fields use Codex SDK semantics exactly and are recorded per participant
(one supervisor row, one row per observed delegation) as well as in aggregate.

- `inputTokens` is total input and **includes** `cachedInputTokens`. The
  full-rate portion is `inputTokens - cachedInputTokens`.
- `outputTokens` **includes** `reasoningOutputTokens`. Reasoning tokens are a
  retained diagnostic and are never added to output a second time.
- `cacheWriteInputTokens` is a diagnostic meter and is uncharged.
- Usage is authoritative only when the Codex turn reported it. A started
  execution that never emits `turn.completed` — some timeout, cancellation,
  turn-failure, stream, and abnormal-exit paths — has genuinely unavailable
  usage. `usageUnavailableAttempts` counts those, the affected participant's
  credits become `null`, and every aggregate containing it becomes `null` too.
  Nothing is back-filled.

### Cost

- Credits are computed only from the revalidated pricing profile embedded in the
  result file, using the freeze-1 accounting rules: uncached input, cached input,
  and output charged separately; cache writes uncharged.
- The computed value is named `rateCardCredits` / `estimatedCredits` and is an
  estimate. `actualCredits` is a separate nullable field that may be populated
  only from an authoritative external accounting source, and is never derived by
  summing estimates.
- An incomplete participant usage record yields unknown credits for that
  participant and for every aggregate containing it.
- Raw token counts are diagnostic. They are never reported as credits, currency,
  or the primary economic measure.

### Failure, repair, and waste

| Metric                                  | Semantics                                                                                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repairsStarted`, `repairsCompleted`    | Bounded one-turn same-thread repair (P0.4).                                                                                                                                                    |
| `recoveriesStarted/Skipped/Completed`   | Bounded one-pass parallel recovery after timeout or process exit.                                                                                                                              |
| `continuations`                         | Attempts resuming a server-issued single-use continuation.                                                                                                                                     |
| `effortEscalations`, `executorChanges`  | Attempts that resumed a predecessor at a higher effort rung, or on a different model. Derived from attempt lineage, not from configuration.                                                    |
| `workerTimeouts`, `workerCancellations` | Runtime-observed worker terminations.                                                                                                                                                          |
| `workerFailures[]`                      | Declared worker failure reasons, retained in full rather than counted away.                                                                                                                    |
| `wastedAttempts`                        | Attempts that ended abnormally or left a failing verification behind. A diagnostic, not a cost: bounded recovery is expected behaviour, and a wasted attempt can still be correct engineering. |
| `worktreesRetained`                     | Worktrees kept because integration could not safely complete.                                                                                                                                  |
| `terminationReason`                     | `completed`, `harness-timeout`, or `agent-error`.                                                                                                                                              |

### Context size and compaction

| Metric                                       | Semantics                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `evaluations`, `triggers`, `blocks`, `noops` | Context pressure evaluations and their decisions.                      |
| `compactions`, `compactionBoundaries`        | Compactions performed, and the lifecycle boundary each occurred at.    |
| `maxTotalSizeBytes`, `lastTotalSizeBytes`    | Exact UTF-8 context size observed, at peak and at the last evaluation. |
| `maxTotalTurns`                              | Peak authoritative turn count.                                         |
| `reclaimedBytes`                             | Sum of observed compaction size deltas.                                |

A run with no context telemetry reports `null` sizes and `0` for events that
were observable and did not occur. A record predating these fields reports
`unknown` in the generated summary rather than a zero.

### Deliberately absent

No single composite score is computed. `ROADMAP.md` requires a lexicographic
order — correctness, then credits, then latency, then diagnostics — and a
weighted scalar would let a cost or latency gain silently offset a correctness
regression. Reports present the ordered measures; they do not collapse them.

## Execution ordering and randomization

Order is fixed and published before the first live turn, and recorded in every
shard as `ordering`.

- `declared` executes the frozen fixture order: repetition, then task, then arm.
- `seeded` independently shuffles task order within each repetition and arm
  order within each task, from a recorded seed, using a platform-independent
  deterministic generator. The same seed always reproduces the same sequence.
- Repetition blocks are never interleaved, so an interrupted campaign still
  holds a complete balanced earlier repetition rather than an arbitrary slice.
- Seeded ordering is preferred for the normal campaign, because it decorrelates
  arm position from time of day, account state, and service load. Whichever mode
  is chosen is recorded with its seed.
- A resumed campaign must present the same mode and seed. The harness refuses a
  resume that would reorder work after results exist.

## Run validity, exclusion, and retry treatment

These rules are fixed before execution and are applied by `classifyRunValidity`,
which is deliberately blind to `passed`, credits, latency, worker count, and
arm, so it cannot be applied selectively to an unwelcome result.

A run is **quarantined** only for missing or untrustworthy evidence:

| Reason                             | Condition                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `grader-did-not-execute`           | No grade commands ran, or a grade command produced no exit code at all.         |
| `agent-transport-error`            | The supervisor turn ended in a transport or turn failure rather than finishing. |
| `delegation-telemetry-unavailable` | An arm with an orchestrator produced an unreadable event stream.                |
| `fixture-identity-missing`         | A V3 record lacks its run ID or fixture revision.                               |
| `fixture-revision-drift`           | A record's fixture revision differs from the campaign's frozen revision.        |

The following are explicitly **results, not exclusions**, and are retained and
reported as failures:

- a non-zero grade command;
- a changed immutable specification file;
- an uncaught mutation;
- exhausting the harness time bound, which is part of the task contract; and
- any outcome that is merely surprising, inconvenient, or unfavourable to a
  candidate.

Retry treatment:

- The harness performs **zero** automatic re-executions of a live cell and zero
  grading retries. In-run repair, recovery, and continuation belong to the
  product under test and are measured, not suppressed.
- A completed cell — passing or failing — is immutable evidence. `--resume`
  skips it; an ordinary re-run refuses to overwrite it.
- A quarantined cell may be re-executed only under a recorded review and a new
  run identity. The quarantined record is retained alongside it.
- Quarantined runs are excluded from every aggregate and listed explicitly in
  the generated report with their reasons. They are never silently dropped and
  never averaged in.

## Statistical and reporting discipline

- Per-run rows are the primary record. Every task, arm, and repetition appears
  individually with its own outcome, credits, latency, routing, and diagnostics.
  Cell summaries are derived views and never replace the rows.
- Central tendency is the **median**. With two repetitions a median is a
  midpoint, not an estimate of a population, and is reported as such.
- Dispersion is reported as min, max, and relative range alongside the median,
  with the number of known values. A summary over one known value says so.
- Failures are preserved. A failing run is never averaged into a pass rate
  without also appearing as its own row, and a cell containing a failure is
  never described only by its successful repetition.
- Unknown is a reported value. Aggregates over incomplete usage stay `null`.
  Counts distinguish unknown, not-applicable, zero workers, and zero tokens.
- No claim of statistical significance is made from two or three repetitions.
  There are no p-values, confidence intervals, or "significantly faster/cheaper"
  claims. The evidence is bounded and directional.
- Measurement and interpretation are separated: measured tables first,
  interpretation in clearly labelled prose that cites the rows it rests on.
- Comparisons against V2 must state the methodology differences — architecture,
  task suite, prompt history, concurrency configuration, telemetry schema — and
  must not present a V2 number and a V3 number as two samples of one experiment.
- Negative and inconclusive findings are results. "Adaptive was not cheaper" and
  "the evidence does not separate the candidates" are both publishable outcomes.

## Reproducibility and integrity controls

Every shard records, and the harness refuses to launch a V3 campaign without:

- git commit, branch, `describe`, and a clean-working-tree check — a dirty tree
  is refused, because the recorded commit would not describe the code that ran;
- Node version, platform, architecture, OS release, CPU count, memory, and
  timezone;
- package version, npm version, Codex CLI version, and Codex SDK version, each
  recorded as read or as `null`;
- the exact campaign invocation and working directory;
- allowlisted orchestrator environment overrides in effect — an allowlist, not
  an environment dump, so a committed record cannot leak credentials;
- the verified methodology content digest;
- the execution ordering mode, seed, and full planned sequence; and
- the predeclared retry and exclusion policy.

Each case starts from a freshly materialized workspace built from the immutable
fixture, with its own run ID and a content-derived fixture revision, and the
workspace is removed afterwards. The orchestrator event stream is created before
the turn begins, so an empty stream — the supervisor never used the orchestrator
— is distinguishable from a missing one, where the evidence was lost.

Raw JSON shards and the event stream are authoritative. Generated Markdown
summaries are derived views; they never overwrite raw evidence, and they never
overwrite historical V2 files. Every conclusion in a human summary must be
traceable to a committed raw record.

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

## Freeze review log

| Freeze | Date       | Scope                                                                                                                                                                                                                                                                                                           | Campaign IDs                       |
| ------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1      | 2026-08-25 | Workload suite, graders, hidden references, arms, repetitions and third-run rules, holdout protections, pricing and economic accounting, primary decision order. Content commit `544d217`.                                                                                                                      | None launched.                     |
| 2      | 2026-08-29 | P2.4A. Adds comparison candidates and baselines, harness configuration boundary, metric catalog and measurement semantics, execution ordering, run validity and retry treatment, statistical and reporting discipline, and reproducibility controls. Removes the per-fixture worker-concurrency ceiling for V3. | Requires a new campaign ID prefix. |

Freeze 2 changed no model-facing text, no task, no grader, no hidden reference,
no mutation case, no arm, no model, no effort, no speed profile, no pricing
applicability, no repetition count, and no third-run admission rule. It changed
telemetry definitions (additively) and one harness configuration, which under
the correction policy above makes it a new freeze review rather than a
correction. No live V3 run existed under freeze 1, so no result is reinterpreted
and no evidence is rewritten.

Reviewer of record and the freeze-2 content commit are recorded in the campaign
checkpoint at launch, alongside the digest the harness verified.
