# Benchmark V3 methodology

## Freeze status

This document is the pre-results specification for Benchmark V3. It was frozen
before the first live V3 result was collected, and no live V3 run has been
executed under any freeze. It contains no V3 result, pass rate, cost, latency,
routing, or model-performance claim.

- Freeze review: **freeze 3 (P2.4B pre-launch)**, superseding freeze 2 (P2.4A),
  whose content commit was `c9b6bbe657a91808c9b91d3f46105f61b3243866`, which in
  turn superseded the freeze-1 content commit
  `544d217967646e5f48b9aa73e936567e87d87c8b`.
- Methodology content digest: `a08ccb260c6691faa3fd3722dcccc67791f495e843c6231ae591d8af11409f94`, verified at launch by `assertMethodologyFrozen`.
- Production baseline under evaluation: **v0.11.0**, the commit the `v0.11.0`
  release tag resolves to, `df215a170e6a88a6097c56f7ca404358d9d4b050`.
- Initial normal campaign: nine tasks, two arms, and exactly two repetitions per
  task/arm cell (36 live runs).
- Any post-freeze correction follows the correction policy below and cannot
  silently change a task, arm, prompt, grader, repetition rule, or result.

Freeze 1 fixed the workload, arms, graders, repetition rules, holdout
protections, and economic accounting. Freeze 2 added the measurement,
reproducibility, exclusion, and reporting discipline in the sections below, and
made one deliberate change to what the harness configures: V3 no longer passes a
per-fixture worker-concurrency ceiling, because that ceiling was derived from
the same stream count that defines the evaluator-only routing category. Both
remain in force and are unchanged.

Freeze 3 changes nothing a model can observe either. It corrects the
measurement, reproducibility, and attribution defects found while preparing the
launch, and repins the product the campaign evaluates:

- **A refused delegation call is no longer counted as an opened worker batch.**
  The runtime opens a batch identity before its pre-execution gates run, so a
  call that admission, routing structure, scope overlap, or worktree
  availability then refuses publishes `batch.started` and afterwards
  `batch.rejected`, with zero worker attempts. Counting those starts inflated
  `delegationCalls`, `batchesByMode`, and the queued worker efforts of a refused
  parallel batch, and let a refusal anchor the supervisor and worktree phase
  boundaries. The metric fold now reads the terminal event each batch identity
  published; production telemetry is unchanged, because it never claimed
  `batch.started` meant a worker ran.
- **Benchmark environment capture resolves its tools the way production does.**
  The probe used to hand bare `git`, `npm`, and `codex` names to a launcher,
  which on Windows searches the current directory ahead of `PATH`. It now uses
  the production resolver — `PATH` only, current directory never searched,
  absolute path handed to the launcher, current-directory lookup pinned off in
  the child environment. The production resolver is used unchanged; nothing in
  it was relaxed for the benchmark.
- **The recorded environment inventory covers every execution-affecting
  production variable, and states its own boundary.** The freeze-2 allowlist
  omitted variables that change the worker model, the Codex configuration
  directory, timeouts, network access, workspace roots, worktree linking,
  verification allowances and environment passthrough, and the
  recursive-delegation backstop. A campaign recorded under the old inventory
  could not be reproduced from its own record. The allowlist also carried a
  claim it could not support — that a finite list of names captured the
  execution environment. It does not, and the record now says so: a second
  layer inventories every inherited variable _name_, records safe values only,
  represents proxy and trust state without credentials, and marks everything
  else present-and-opaque. See "Reproducibility and integrity controls" below.
- **The effective Codex configuration is identified without publishing it.**
  `config.toml` is structurally parsed, recursively sanitized through nested and
  multiline values, and only then canonicalized and hashed; header-bearing
  structures are conservatively redacted. `auth.json` contributes a mode and a
  presence marker and nothing else. Trust-material paths and raw config lengths
  are not retained.
- **The production baseline is repinned to the released v0.11.0 commit, and a
  campaign is bound to it.** The pin previously named a pre-release commit, so
  the campaign would not have been evaluating a shipped release. Pinning alone
  was also not enough: the orchestrator a delegation-enabled arm actually
  launches was decided by an MCP registration outside the repository. V3 now
  deterministically provisions a byte-sealed baseline artifact, freezes its
  aggregate runtime-manifest digest, launches its absolute entry point, and
  verifies all execution-affecting bytes before and after every Adaptive cell.
- **The pre-launch checkpoint derives execution history instead of asserting
  it.** A durable marker written immediately before the first model call proves
  even an abort before cell 1. Valid, malformed, and unreadable V3 shards,
  launch markers, and ambiguous non-empty event streams are all read from the
  evidence directory and conservatively block a fresh-launch claim.

None of this is comparable to a mid-campaign edit: no live V3 run exists under
any freeze, so no result is reinterpreted and no evidence is rewritten.

Because freeze 3 changes a telemetry definition, the reproducibility record, and
how a campaign is bound to the product it evaluates, it is a new freeze review
under the correction policy below and requires a new campaign ID. No freeze-1 or
freeze-2 campaign ID may be resumed under it.

### Two commits, two questions

A V3 record carries two commit identities and they must never be conflated:

| Identity                    | Question it answers                                       | Where it lives                                                  |
| --------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| Methodology / freeze commit | Which reviewed specification did this campaign run under? | `holdoutFreezeSha`, alongside the authoritative content digest. |
| Production baseline commit  | Which released product was evaluated?                     | `productionBaseline{version, sha}` — v0.11.0 at `df215a1`.      |

The freeze commit describes this document. The production baseline describes the
orchestrator under test. A change to one is not a change to the other, and a
report that cites only one has not identified the experiment.

Freeze identity itself is content-addressed rather than commit-addressed. The
digest above is the sha256 of this file with line endings normalized and the
digest line itself removed, so the gate works in a working tree, a published
tarball, or a checkout whose history was rewritten. `src/bench/integrity.ts`
holds the expected value and `assertMethodologyFrozen` enforces it at launch.
The commit-addressed companion pin is repinned after this document is committed,
because a pin cannot name the commit that contains it; `assertV3FreezePinned`
refuses a live launch while that pin still names the previous review.

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
same Thin Supervisor / adaptive runtime at the same commit — the v0.11.0
production baseline named in the freeze status above — and the only difference
is whether that runtime's orchestration path is reachable.

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
| `delegationCalls`, `batchesByMode`           | Delegation calls that opened a worker batch, split by single / sequential / parallel.           |
| `delegationCallsRefused`                     | Calls the runtime refused before any worker attempt started.                                    |
| `refusedBatchesByMode`                       | Modes of refused calls, where the refusal came late enough for a mode to be observed.           |
| `delegationCallsCancelled`                   | Opened batches later cancelled. A subset of `delegationCalls`, not a refusal.                   |
| `attemptsStarted`, `attemptsCompleted`       | Individual worker SDK invocations, from canonical `attempt.*` lineage.                          |
| `attemptsByRole`                             | `initial`, `automatic-repair`, `manual-continuation`, `timeout-recovery`, `process-retry`.      |
| `explorations`, `explorationsRejected`       | Read-only `explore` calls admitted and refused.                                                 |
| `routingPreflights`, `routingDeclarations*`  | Advisory routing evaluations, and whether a call attached a declaration at all.                 |
| `maxParallelConfigured`, `concurrencyPolicy` | What the harness configured, and under which rule. For V3 always `null` / `production-default`. |

A delegation call **opened a worker batch** when the runtime admitted it past
every pre-execution gate: its batch identity published `batch.started` and did
not publish `batch.rejected`. `batch.started` on its own does not establish
this. The identity is created before admission, routing structure, scope
overlap, and worktree availability are checked, so a refused call publishes
`batch.started` and then `batch.rejected` having started no worker attempt —
`batch.started` → `batch.rejected`, and `batch.started` → `routing.declared` →
`batch.rejected` are both ordinary refusal traces. Such a call is a routing
observation, counted in `delegationCallsRefused`, and it is never reported as a
delegation, never contributes a mode to `batchesByMode`, never contributes a
worker effort from the `task.queued` rows a refused parallel batch leaves
behind, and never anchors `supervisorBeforeSeconds` or `worktreeSetupSeconds`.
Cancellation is different in kind: a cancelled batch passed every gate, so it is
an opened call whose outcome is recorded separately.

This is a reading rule, not a change to the product. `batch.started` means the
runtime opened a batch identity, which is what it has always meant and what the
activity surfaces depend on; freeze 2 read it as something it never claimed.

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
  recorded as read or as `null`. Those tools are located through the production
  executable resolver: `PATH` only, never the current directory, absolute path
  handed to the launcher. Evidence a file planted in the audited directory could
  answer is not evidence, and the same resolution rule protects the shipped
  runtime, so the benchmark reuses it rather than copying a weaker one;
- the exact campaign invocation and working directory;
- the environment, in three layers with three different guarantees (below);
- the verified identity of the orchestrator that will actually execute (below);
- the verified methodology content digest;
- the execution ordering mode, seed, and full planned sequence; and
- the predeclared retry and exclusion policy.

### What the environment record establishes, and what it does not

The environment record is deliberately layered, because a single "environment"
blob would let its weakest part borrow its strongest part's credibility.

**Production-owned execution settings.** An allowlist of _names_, never a dump
of the environment, because the value of a listed name is committed verbatim and
an unbounded snapshot would publish credentials. The allowlist is derived from
the production configuration a run executes under — a delegation-enabled arm
launches the orchestrator through Codex, which inherits the launching
environment — and covers the worker model, the Codex configuration directory,
sandbox and network access, task and verification timeouts, compute-policy and
executor admission, workspace roots, worktree lifecycle and linking,
context-lifecycle thresholds, verification mode/allowances/environment
passthrough, server identity, the recursive-delegation backstop, and the harness
task bound. A production variable deliberately left out carries a recorded
argument that it cannot affect a measured run. As defense in depth, a
deterministic syntactic test detects the direct `process.env.NAME`,
`process.env["NAME"]`, and resolvable constant-key forms the scanner explicitly
supports. It is not a semantic proof of every possible repository environment
read: computed, indirect, or novel future access can fall outside those forms.
It also detects no variable read by the Codex SDK, the Codex CLI, Node, or the
operating system, and is not evidence that the execution environment is fully
captured. No name whose value would be a credential may be added to the
allowlist.

**Ambient inherited environment.** Every other variable the benchmark process
inherited, and therefore passes to the Codex SDK and to the orchestrator it
launches, is inventoried by _name_, sorted, with a digest of the inventory for
run-to-run comparison. Values are recorded only under an explicit
classification: safe scalar settings verbatim (locale, timezone, Node options,
TLS verification state); proxy and endpoint URLs as scheme, host, port and an
embedded-credential flag, never as the raw URL, because a proxy URL routinely
carries `user:password@`; explicitly safe certificate and trust-material
variables as presence, readability, file category, and a digest of readable
file content. Their raw paths, basenames, and path hashes are never persisted.
Credential-shaped path variables remain presence-only and no secret value is
hashed. Everything else, including every credential-shaped name, is recorded as
_present-and-opaque_: the name appears, the value never does. Opaque is the
honest answer, and it is not the same as absent — an unreproducible difference
between two runs stays visible rather than being hidden by omission.

**Effective Codex configuration.** A real TOML parser first constructs the
complete nested `config.toml` value graph, including tables, inline tables,
arrays/tables, comments, and multiline values. The graph is recursively
sanitized before canonical serialization or hashing: any credential-, secret-,
authentication-, token-, password-, cookie-, bearer-, key-, or header-sensitive
key/path segment is redacted, and a header-bearing structure is conservatively
replaced as a whole. The digest of that sanitized canonical structure and its
registered MCP server names are recorded. Raw config byte length is not
recorded. An unparseable config records presence and parse failure but no digest.
`CODEX_HOME` records only whether it is the default or an override; its raw path
and path hash are absent. `auth.json` contributes a presence marker and an
authentication mode (`api-key`, `chatgpt`, `unknown`) and nothing else; no
credential, and no digest of one, enters a committed artifact.

The boundary is therefore stated precisely, and is committed inside every
record: **reproducible** are the maintained repository-owned settings detected in
the explicitly supported access forms, the complete ambient name inventory, the
classified-safe ambient values, the non-secret identity of the Codex
configuration, and the git/runtime/toolchain facts. **Not reproducible** are
computed, indirect, or otherwise undetected repository environment reads; the
raw values of unclassified ambient variables; every credential; environment
reads performed by the Codex SDK, the Codex CLI, Node, or the operating system;
and machine or account state outside the environment — system trust stores,
network policy, DNS, clock skew, and provider-side model or account
configuration. A campaign whose two runs differ only in opaque state will show
that the opaque state existed; it cannot show what it was.

### Binding a run to the production baseline

A V3 record claims that the orchestrator under evaluation is the released
v0.11.0 product at `df215a1`. Stamping that pair into a record establishes
nothing on its own: the Codex SDK launches whatever the `mcp_servers`
registration resolves to, and that registration lives outside the repository, is
edited by hand, and can point at a global install, another checkout, or the
benchmark-development tree.

So V3 does not rely on it. The canonical `npm run bench:v3:baseline` path removes
any prior artifact, materializes detached commit
`df215a170e6a88a6097c56f7ca404358d9d4b050` (the exact `v0.11.0` tag target),
runs `npm ci` from that commit's lockfile, builds that exact source, and runs
`npm prune --omit=dev` so the installed tree contains runtime dependencies only.
It writes a canonical manifest whose sorted entries cryptographically identify
`package.json`, `package-lock.json`, every file under `dist`, and every file
under `node_modules` except `.bin` command shims and the manifest itself. `.bin`
is irrelevant because the harness launches the absolute Node executable and
absolute `dist/server.js`, and Node module resolution does not consult command
shims. Paths use canonical `/` separators and the aggregate hashes the manifest
schema plus every path, type, byte length, and file-content digest. Symlinks in
the included runtime material fail verification rather than being followed out
of the sealed tree.

The expected aggregate runtime-manifest digest frozen by Freeze 3 is
`d63af9ef92ac99c9a0f8425012fce2777a6dee020c76161bc504aee96dafad17`.
This is distinct from both the v0.11.0 git commit/tree and any freshly observed
digest. A new observation is accepted only when it equals that independent
expected value; provisioning cannot bless an arbitrary new digest. The artifact
also must have the exact commit and tree, a clean tracked worktree, the expected
package name and version, the version recorded at the baseline commit, installed
declared dependencies, and a regular, contained, absolute entry point. Null or
unreadable evidence fails closed.

Every measured Adaptive V3 cell freshly computes the sealed manifest immediately
before the SDK call that launches the orchestrator, launches using the absolute
entry point authorized by that observation, and computes it again after the cell
and deterministic grading finish but before a result can be returned or written.
The record carries the expected digest and both observed digests plus entry-point
identities. Both observations must match the frozen digest and each other. A
modified dist file, dependency byte, package/lock file, symlink/substitution,
unreadable manifest, or post-preflight mutation fails the cell/campaign closed;
no result survives claiming valid v0.11.0 execution. Nothing about v0.11.0
production behavior is modified.

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

The live runner creates a durable `*.v3-launch.json` campaign marker immediately
before the first model-backed SDK call, after every deterministic launch gate
and per-cell setup has passed. It records schema, campaign ID, methodology
digest/freeze identity, production baseline including the expected sealed
runtime digest, timestamp, `state: started`, and initially zero completed cells.
It is updated atomically as accepted cells complete and is never erased. A crash
after marker creation but before cell 1 completes therefore remains authoritative
proof that V3 launched. Checkpoint generation, deterministic validation, and
baseline provisioning never create this marker.

The checkpoint's account of execution history is derived, never transcribed.
`freshLaunch` is true only when the authoritative evidence directory contains no
launch marker, no valid V3 result shard (including a zero-record shard), no
invalid or malformed V3-named shard, no unreadable V3 shard or launch marker,
and no non-empty or unreadable event stream that could represent V3 but cannot
be safely attributed. Ambiguity blocks freshness: malformed `{}` shards and
orphan streams cannot degrade to `runCount: null` while preserving a claim that
V3 never ran. Evidence explicitly attributed to V2 or the earlier parallel and
scale suites remains unrelated and does not block V3 freshness.

Result-campaign collision, the current campaign's launch-marker state, and a
retained checkpoint for the current campaign are separate facts. A campaign ID
that already carries results may not be reused; any current or other campaign
launch marker is prior live evidence; and a retained checkpoint alone is not
live execution because the deterministic generator writes it before launch.
All of these readiness facts appear in both checkpoint JSON and Markdown.

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

| Freeze | Date       | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Campaign IDs                       |
| ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1      | 2026-08-25 | Workload suite, graders, hidden references, arms, repetitions and third-run rules, holdout protections, pricing and economic accounting, primary decision order. Content commit `544d217`.                                                                                                                                                                                                                                                                                                                                                                                                         | None launched.                     |
| 2      | 2026-08-29 | P2.4A. Adds comparison candidates and baselines, harness configuration boundary, metric catalog and measurement semantics, execution ordering, run validity and retry treatment, statistical and reporting discipline, and reproducibility controls. Removes the per-fixture worker-concurrency ceiling for V3. Content commit `c9b6bbe`.                                                                                                                                                                                                                                                          | Requires a new campaign ID prefix. |
| 3      | 2026-08-29 | P2.4B pre-launch. Reconciles the delegation-call metric with the refusal traces production actually emits, hardens benchmark executable resolution to the production rule, completes the execution-affecting environment inventory and replaces its overclaimed completeness with a layered record and a stated boundary, identifies the effective Codex configuration without publishing secrets, repins the production baseline to the released v0.11.0 commit `df215a1` and binds a campaign to a verified baseline artifact, and derives pre-launch execution history from committed evidence. | Requires a new campaign ID prefix. |

Freeze 3 changed no model-facing text, no task, no grader, no hidden reference,
no mutation case, no arm, no model, no effort, no speed profile, no pricing
applicability, no repetition count, and no third-run admission rule. It changed
one telemetry definition, the reproducibility record, the production baseline
pin and how a run is bound to it, and how pre-launch execution history is
established, which under the correction policy above makes it a new freeze
review rather than a correction. It changed no production runtime behaviour: the
refusal defect was in how the benchmark read `batch.started`, not in what the
runtime published, and the baseline binding checks out, builds, verifies, and
executes v0.11.0 exactly as released. No live V3 run existed under freeze 1 or
freeze 2, so no result is reinterpreted and no evidence is rewritten.

The second independent review narrowed the remaining Freeze 3 repair to Findings
A, B, and C. Those corrections replaced line-based config redaction and sensitive
path metadata with structural secret sanitation, replaced source/version-only
baseline attribution with the frozen byte manifest and per-cell pre/post gate,
and replaced result/event inference with authoritative launch evidence and
conservative malformed/ambiguous history classification. Finding D, Codex SDK
provenance, is unchanged. The nine tasks, two Medium arms, two repetitions, 36
cells, deterministic/external grading, evaluator-only routing categories,
credit-first analysis, and repetition policy are unchanged.

Reviewer of record and the freeze-3 content commit are recorded in the campaign
checkpoint at launch, alongside the digest the harness verified.
