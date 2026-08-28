# Feature Acceptance Ledger

This is the authoritative current capability, evidence, freshness, and
confidence ledger for the repository. The package version is `0.10.0`, and the
current main runtime is its release baseline. The current development tree adds
P1.0 attempt-usage and failure-evidence hardening plus P1.1 reasoned failure
decisions to the Thin Supervisor, terminal batch verification, and bounded
parallel recovery baseline described below. Shipped history belongs in
`CHANGELOG.md`; future work belongs in `ROADMAP.md`.

## Current baseline

- **Runtime baseline:** commit-relative current main for v0.10.0 after the Thin
  Supervisor work above. Package and lockfile versions are `0.10.0`.
- **Latest full deterministic validation:** `npm run verify` passed on
  2026-08-28 with **810/813 tests passed**, no failures and three expected
  platform-specific Windows skips, plus typecheck and the deterministic MCP
  protocol smoke test.
- **Current native platform evidence:** deterministic CI covers Windows, Linux,
  and macOS. Focused Linux/POSIX symlink, dependency-link, and process-group
  paths passed natively. Live Codex delegation has representative Windows and
  Linux evidence; the accepted Ubuntu runs used the documented repo-local
  `LUNA_SANDBOX=danger-full-access` trusted-development workaround.
- **Live-evidence boundary:** published-v0.9.0 and earlier pre-release live runs
  remain historical evidence. They support unchanged behavior, but do not by
  themselves prove the later cancellation, reconciliation, or retention-policy
  semantics. Those changed seams have current deterministic regression evidence.

## Current capability matrix

| Capability                                              | Coverage | Deterministic | Live evidence | Confidence    |
| ------------------------------------------------------- | -------- | ------------- | ------------- | ------------- |
| Zero-worker/adaptive delegation                         | PASS     | PASS          | PASS          | Strong        |
| Single delegation                                       | PASS     | PASS          | PASS          | Strong        |
| Sequential batches                                      | PASS     | PASS          | PASS          | Strong        |
| Parallel batches                                        | PASS     | DEEP PASS     | DEEP PASS     | Battle-tested |
| Worktree isolation/integration                          | PASS     | DEEP PASS     | DEEP PASS     | Battle-tested |
| Bounded concurrency                                     | PASS     | PASS          | DEEP PASS     | Battle-tested |
| Adaptive effort                                         | PASS     | PASS          | PASS          | Strong        |
| Independent verification                                | PASS     | PASS          | DEEP PASS     | Strong        |
| Claimed-vs-observed reconciliation                      | PASS     | PASS          | DEEP PASS     | Strong        |
| Context Capsule v2                                      | PASS     | PASS          | PASS          | Strong        |
| Compact Evidence Packets                                | PASS     | PASS          | DEEP PASS     | Strong        |
| Terminal verification and thin handoff boundary         | PASS     | PASS          | PASS          | Strong        |
| CLI lifecycle                                           | PASS     | PASS          | PASS          | Strong        |
| Activity, observability, and privacy                    | PASS     | PASS          | DEEP PASS     | Strong        |
| Natural discovery                                       | PASS     | PASS          | PASS          | Strong        |
| Explicit Change Intent                                  | PASS     | PASS          | DEEP PASS     | Strong        |
| Worker Continuation                                     | PASS     | DEEP PASS     | DEEP PASS     | Battle-tested |
| Bounded Repair                                          | PASS     | PASS          | DEEP PASS     | Strong        |
| Bounded parallel automatic recovery                     | PASS     | PASS          | PASS          | Strong        |
| P1.0 parent/pricing foundation                          | PASS     | PASS          | N/A           | Strong        |
| P1.0 per-execution failure and usage evidence           | PASS     | DEEP PASS     | N/A           | Strong        |
| P1.1 reasoned retry and effort escalation decisions     | PASS     | DEEP PASS     | N/A           | Strong        |
| P1.2 user-owned compute policy and enforcement          | PASS     | PASS          | N/A           | Strong        |
| P1.2 adaptive routing and compute selection             | PASS     | PASS          | N/A           | Strong        |
| P1.3 Context lifecycle management (P1.3A/B/C)           | PASS     | PASS          | N/A           | Strong        |
| P2.1 Optional Explorer                                  | PASS     | PASS          | N/A           | Strong        |
| `failureCauses` and verification contradiction handling | PASS     | PASS          | PASS          | Strong        |

Dates, provenance, dependencies, and retest triggers are recorded below. A live
status can combine historical evidence for unchanged behavior with current
deterministic evidence for a later changed seam; the detailed record says when
that distinction matters.

Bounded parallel automatic recovery is deterministic and internal to the original
batch call. The default is enabled with an explicit opt-out. Only one eligible
failed task turn is added after the initial parallel window: timeout continuation
uses the same thread/worktree, while canonical `process-exit` evidence may use a
fresh thread in the same owned worktree. Recovery preserves partial successes,
reruns verification, reconciles final worktree evidence before integration, and
records stable identities, attempt ordinals, classifications, and separate usage
and duration. Fresh Benchmark V2 evidence exercised one real 300-second timeout:
the runtime preserved two successful parallel streams, retried only the failed
task in its owned worktree, passed final verification, and exposed the missing
failed-attempt usage as unknown. The 475-second run is evidence that recovery
works and that timeout latency and accounting remain open problems.

Current P1.0 hardening makes each worker SDK invocation independently
attributable through an append-only attempt record and canonical lifecycle
events. Deterministic cases cover success, reported failure, verification
failure, timeout, cancellation, stream/runtime/process failure, partial
messages/files, repair, manual continuation, timeout recovery, fresh-process
retry, failed recovery, sibling preservation, and post-execution lifecycle
failure. Aggregate usage now fails closed whenever any constituent lacks
authoritative `turn.completed` usage; the known constituent remains visible.

P1.1 now derives one `failureDecision` from that factual evidence. Deterministic
coverage distinguishes success, cancellation, timeout, exact process exit,
generic runtime failure, local and non-local verification failure, scope,
security/trust, contract/requirement, environment/tooling, implementation,
effort, capability, and evidence failure. It proves repair-before-recovery
precedence, one-turn bounds, no retry from counter availability alone, one-step
effort escalation, stronger-executor recommendation without selection, lineage
and truthful usage preservation, terminal cancellation, and successful sibling
preservation. No model-backed P1.1 campaign was run; the later P1.2 closure adds
executor authorization and server-authoritative selection.

P1.2 adaptive routing and compute selection (`src/adaptive.ts`, `src/seam-plan.ts`,
`src/selection.ts`, `src/routing.ts`, `src/policy.ts`, `src/adaptive-routing.test.ts`,
`src/selection.test.ts`, `src/seam-plan.test.ts`, `src/routing.test.ts`, `src/policy.test.ts`)
is recorded with **PASS** deterministic coverage and **Strong** confidence.
The unified pipeline wires decomposition, routing evaluation, shape recommendation,
compute selection, explicit operator-declared executor ordering, and telemetry
into one pure, synchronous flow. Seam planning decides whether work stays whole or
splits based strictly on declared evidence, with undeclared coupling keeping work
whole. Route evaluation computes the execution shape inside the policy envelope.
Compute selection determines the starting model and effort, ascending rungs only
with evidence. An explicit operator hierarchy (`SOL_LUNA_EXECUTOR_ORDER` / `executorOrder`)
allows stronger-executor fallback resolution (`stronger-executor-selected` / `exhausted`)
without treating `allowedModels` list position as an inferred strength order. Telemetry
in single delegation, preflight, and batch execution records recommended mechanism,
worker count, concurrency, effort, selected model, selected effort, and selection reason;
existing worker lifecycle and attempt records remain the authority on actual execution.
The production single and batch surfaces now pass selected model and effort into
the Codex SDK turn, and continuation retains the model/effort lineage it actually
resumes. An eligible P1.1 bounded retry can bootstrap authenticated lineage,
after which effort-escalation and stronger-executor decisions can issue an
opaque, single-use, 15-minute in-memory handoff. Consumption restores the
authoritative task contract and factual predecessor evidence; caller history or
replacement fields cannot create escalation authority. Deterministic coverage
includes concurrent double consumption, expiry/replay/malformed refusal, exact
contract restoration, batch sibling preservation, and selected SDK thread options.
Restart loss is intentionally fail-closed and no model-backed P1.2 campaign is
claimed.

P1.3 Context lifecycle management (`src/context.ts`, `src/context.test.ts`, `src/context-lifecycle.test.ts`)
is recorded with **PASS** deterministic coverage and **Strong** confidence across P1.3A (retention
and compaction core), P1.3B (pressure metrics and trigger policy), and P1.3C (live runtime lifecycle integration).
The pure synchronous primitive accepts single delegations, batch delegations, continuations, and preflight turns,
producing a redacted compact projection without mutating the authoritative context. Complete
contract arrays, distinct decisions, constraints, blockers, attempt lineage, failure/conflict/refusal
evidence, per-task batch claims, observed changes, and authoritative verification facts are preserved.
Turn bounding is a soft target that prunes stale clean history while protected evidence may exceed
it. Clean verified PASS paths omit only successful command output while retaining command outcomes,
provenance, counts, changed files, and risks. Compact projections report only the count and
state of authority whose latest live registry status is issued and unconsumed; capability values
are never exposed. P1.3B adds deterministic context pressure metrics (exact
UTF-8 byte size, turn distribution, exactly removable narration/tool-prose bytes, exact compact-projection
reclaimable bytes, and complete provider-reported token usage) and a configurable trigger policy. Cached
input remains a subset of provider input, reasoning output remains a subset of provider output, and any
unavailable constituent keeps aggregate usage unknown. The evaluator accepts resolved configuration and
checks size, total turns, stale clean history, repeated tool overhead, and reclaimable ratio at inclusive
thresholds. Deterministic safety precedence blocks unsafe lifecycle boundaries, no-new-turn repeat
compaction, authoritative cooldown, and insufficient reclaimable gain; manual force bypasses none of
these. In P1.3C, a server-owned registry isolates authoritative stores for unrelated fresh
calls and batches while server-issued continuation/handoff lineage restores only its owning
context. Reference-counted execution leases cover execution, repair, recovery, reconciliation,
and continuation cleanup; one completion cannot clear another active lease. Evaluation and safe
compaction run after `delegate_task`, `delegate_tasks`, and `continue_task`. Advisory
`routing_preflight` remains side-effect-free with respect to execution context. Deterministic tests
cover overlapping calls, isolation, error release, stale-projection invalidation, live non-consuming
reference status, and capability-free projections. Factual telemetry events (`context.evaluated`,
`context.compacted`) emit exact metrics without leaking capability tokens, prompts, or sensitive output.

P2.1 Optional Explorer (`src/contract.ts`, `src/prompt.ts`, `src/worker.ts`, `src/server.ts`, `src/context.ts`, `src/explore.test.ts`, `src/security.test.ts`)
is recorded with **PASS** deterministic coverage and **Strong** confidence. The `explore` MCP tool provides
a bounded read-only investigation companion with Luna under strict `changeIntent: "forbidden"`. It requires an
explicit admitted scope, copies only that scope to a disposable surface, fixes the SDK sandbox to `read-only`, and
never uses the authoritative workspace as the explorer working directory. An independent content/symlink manifest
detects creation, deletion, modification, rename, symlink, and untracked-file changes; mutation invalidates trust,
fails the verdict, and is discarded. Findings conform to strict JSON schema `explorerOutputJsonSchema`: worker claims
carry explicit worker provenance and exact runtime-checked file/line/evidence grounding, while runtime-observed facts,
hypotheses/inferences, and open unknowns remain separate.
Suggested candidate seams provide supervisor planning input without creating an unchecked implementation plan.
The tool adheres to operator compute policy envelopes via `admitCompute`, emits `explore.started`, `explore.completed`,
and `explore.rejected` telemetry, and integrates into `ContextLifecycleStore` with execution leases and `"post-exploration"`
compaction evaluation. The tool is disabled in worker threads (`IS_WORKER_PROCESS`), preventing recursive explorer spawning.
Deterministic tests prove fail-closed single-payload parsing, prompt generation, disposable isolation and cleanup,
all mutation classes, source grounding, scope checks, compute propagation/admission/refusal, lifecycle leases and
trust-preserving compaction, privacy-safe telemetry ingestion, and semantically consistent rendering modes. No
model-backed benchmark is claimed.

The terminal handoff protocol defaults clean verified PASS responses to compact
text without `structuredContent`. A batch reruns the deduplicated declared checks
in the final workspace and reaches `verified-complete` only when every seam,
integration step, and final execution passes. Explicit `compact` and `full`
modes retain structured compatibility; non-clean results expand to full
evidence. Advertised schemas retain canonical validators/defaults while omitting
descriptive prose. Deterministic tests prove parser equivalence, final-check
deduplication, terminal closure, no-command refusal, failure expansion, activity
projection, and the protocol surface. Fresh local-runtime targeted and full
Benchmark V2 campaigns exercised the handoff from isolated Codex sessions. All
48 final records passed; natural Adaptive delegated runs spent 5.5-8.9 seconds
in observed supervisor-after time, compared with 26.8-113.1 seconds in the
delegated frozen baseline. The canonical economics and limitations are in
`bench/RESULTS.md`; this is representative live acceptance, not a claim of
universal savings.

## Current known evidence gaps and non-claims

- No fresh parent in the current natural-routing portfolio selected a sequential
  batch. Sequential execution itself has current deterministic and live
  acceptance; this is a routing evidence boundary, not a defect or blocker.
- Natural adaptive-effort evidence covers materially different `medium` and
  `high` selections. No natural `xhigh` or `max` selection is claimed, and those
  optional observations are not required for Strong confidence.
- No fresh whole-system native coverage report was produced after the v0.9.1
  runtime changes. The latest coverage percentages belong to the earlier v0.9.0
  campaign; the current 738-test deterministic suite is green with three
  expected platform-specific Windows skips.
- Raw transcripts, diagnostic logs, event streams, and some structured live
  results are session-local and intentionally uncommitted. The ledger preserves
  their reviewed conclusions, not durable raw artifacts.
- There is no broad durable model-backed OS matrix. macOS has deterministic CI
  but no current live delegation record; accepted Ubuntu live runs required the
  documented trusted-development sandbox workaround.
- Retention modes, continuation expiry, verification refusal/timeout, and
  deceptive worker-claim variants have broader deterministic than live coverage.
  These are evidence limits, not known product defects.
- Exact token usage remains fundamentally unavailable when a started execution
  never emits Codex `turn.completed`, including some timeout, cancellation,
  failed-turn, stream/runtime, and abnormal-exit paths. The runtime now records
  that unknown explicitly; no test or local timing can recover the missing
  provider fact.

**Confirmed current product defects:** none. **Product-validation blockers from
the completed v0.9.1 hardening work:** none. Optional future work remains in
`ROADMAP.md`; this ledger does not promote or implement it.

## How to read this ledger

Evidence status vocabulary is intentionally small: **N/A**, **NOT TESTED**,
**PARTIAL**, **PASS**, **DEEP PASS**, or **STALE**. Overall confidence is one of
**Unverified**, **Basic**, **Strong**, **Battle-tested**, or **Stale**.

- **N/A:** that evidence class does not apply.
- **NOT TESTED:** coverage may exist, but no execution is established.
- **PARTIAL:** only part of the relevant surface executed or a material gap
  remains.
- **PASS:** the stated relevant paths passed at the stated version or commit.
- **DEEP PASS:** broad or repeated acceptance also exercised important failure
  paths, integration boundaries, or platforms.
- **STALE:** the evidence ran, but a relevant implementation or dependency later
  changed.

- **Unverified:** no relevant execution evidence is established.
- **Basic:** focused deterministic evidence is current, or live evidence is only
  partial.
- **Strong:** broad current deterministic evidence, or current deterministic
  evidence plus a representative live path.
- **Battle-tested:** repeated, varied deterministic and live evidence covers
  important failure paths as well as the happy path.
- **Stale:** evidence once supported a higher confidence, but a relevant behavior
  or dependency changed after it ran.

Coverage means a test or artifact exists. Execution means that it actually ran;
a test file alone is not execution evidence. Freshness means the evidence still
matches the relevant implementation and dependencies at the current runtime
baseline. Freshness is dependency-aware: an unrelated source change does not
stale evidence, while a changed semantic seam does. A historical result can
therefore remain applicable to unchanged behavior or become **STALE** for a
changed seam. Dates are UTC dates from committed records or git history; an
execution date is **unknown** when the repository does not establish it.

## Historical acceptance campaigns

The following sections preserve concise campaign chronology and historical test
counts. They describe the state at each checkpoint and are superseded wherever
the current baseline, matrix, gaps, or detailed records above say otherwise.

### Thin-supervisor terminal-verification campaign

The 2026-08-25 Candidate 3 runtime at
`187f962be18998a6a4e0b5d9e717d62001ffbe41`, with targeted evidence committed
at `62d9e00f9e44b51ca9bae4941c50f332bfe93585`, passed the full deterministic
gate: 513/516 tests passed with three expected Windows skips and no failures,
plus typecheck, protocol smoke, fixture validation, formatting, and build. The
local development checkout was rebuilt and registered with
`init --allow-ephemeral`; status, doctor, and `codex mcp get` all resolved
`D:\code\gpt-test\sol-luna-orchestrator\dist\server.js`.

Fresh Codex sessions then ran the frozen V2 contract with `gpt-5.6-sol` Medium,
`gpt-5.6-luna`, standard speed, and Fast disabled. The targeted campaign was
`benchmark-v2-terminal-verification-c3-187f962-20260825`; the full campaign was
`benchmark-v2-final-terminal-verification-62d9e00-20260825`. All 48 final
records passed external grading. The campaign repeatedly exercised terminal
integration verification, text-only successful handoffs, zero-worker routing,
single workers, parallel peaks 3 and 4, mixed Medium/High effort, and one
targeted timeout recovery. The recovery preserved completed siblings and
retried only the failed ownership seam, while truthfully leaving total credits
unknown because failed-attempt usage was unavailable.

The campaign establishes live functional acceptance and a materially thinner
post-delegation Sol lifecycle. It does not establish overall Adaptive savings:
the seven fully priced task medians were about 2% more expensive than Solo and
the full Adaptive total is unknown. `bench/RESULTS.md` owns the complete
candidate mapping, BEFORE/AFTER economics, failure analysis, thresholds, and
reproduction sequence.

The initial deterministic campaign executed against the released v0.9.0 tree on
2026-08-24. `npm ci` and `npm run build` passed. An initial native Node coverage
run across every package test suite reported **453 tests: 452 pass, 0 fail, 1
skipped**; the skip was the real on-disk symlink case because symlink creation was
not permitted on this Windows host. It measured **90.56% lines, 84.24% branches,
and 87.93% functions**. Five focused test blocks were then retained for cost
foundation boundaries, Codex subprocess failure handling, and legacy path-only
worktree leases. After rebuild, the affected suites reported **196 pass, 0
fail**, and the final Wave 1 coverage run reported **458 tests: 457 pass, 0 fail,
1 skipped**, measuring **90.70% lines, 84.70% branches, and 88.24% functions**.
The full run covered schemas, prompts, guidance, evidence, CLI/config lifecycle,
activity/reducer/watch compatibility, benchmark invariants, command and
filesystem security, worker verdicts and repair, sequential/parallel scheduling,
worktrees, leases, cancellation, integration, continuation, reconciliation,
pricing primitives, and verification.

Fresh Linux closure evidence then executed on 2026-08-24 against the same v0.9.0
runtime baseline on Ubuntu 24.04.4 LTS, kernel 7.0.0-28-generic, Node v24.15.0,
npm 11.12.1, and Codex CLI 0.149.1. Before Linux-only additions, the full
deterministic suite reported **458 tests: 458 pass, 0 fail, 0 skipped**, so the
Windows-skipped real on-disk symlink test executed successfully. Two narrow
test-only cases were retained for an actual directory-symlink escape and POSIX
process-group descendant termination; the existing worktree dependency-link
case gained an assertion that Linux created a real directory symlink to the
source dependency tree. The affected suites reported **45/45 security**,
**73/73 parallel/worktree**, and **97/97 CLI plus activity-configuration**
tests passing. The final full deterministic suite reported **460 tests: 460
pass, 0 fail, 0 skipped**.

### v0.9.0 confidence-hardening campaign

Wave 1 completed on 2026-08-24. Every material matrix row now has a fresh
deterministic execution at the released baseline. The scheduler/worktree suite
included configured concurrency peaks, queue progress, disjoint integration,
same-file conflicts, partial failure, setup failure, cancellation, retained
worktrees, lease acquisition/refresh/loss/release, continuation binding, and
cleanup. The worker/evidence suites included strict report parsing, explicit
change intent, claimed-versus-observed reconciliation, authoritative verification,
verification-only contradiction promotion and negative controls, one-turn repair
admission/exhaustion, compact/full projection, and P1.0 cost/identity boundaries.
This deterministic refresh does not by itself refresh stale live routing or
effort evidence, and it does not convert a repeated happy path into DEEP PASS.

Wave 2 completed on 2026-08-24 against the globally installed published v0.9.0
server at
`C:\Users\mahad\AppData\Local\nvm\v26.7.0\node_modules\sol-luna-orchestrator\dist\server.js`.
All mutation scenarios used committed disposable Git repositories under the
campaign fixture root, not product source. Fresh live evidence included:

- a compact single required edit with authoritative verification and matching
  Git state;
- a Context Capsule task whose exact JSON output depended on structured service,
  numeric-port, and header invariants, with a private sentinel absent from human,
  JSON, and campaign-appended activity telemetry;
- a 4/4 sequential dependency batch: Task 2 consumed Task 1's file, followed by
  legitimate optional and forbidden zero-change tasks;
- a 3/3 parallel batch with distinct worktrees, observed activity peak 3 (the
  configured ceiling), 3 attempted/3 applied integrations, and complete cleanup;
- retained-worktree continuation on the same Luna thread, cumulative two-file
  reconciliation, repeated authoritative verification, single-use replay
  refusal, and lease release;
- bounded repair after one controlled authoritative failure, classified
  `local-verification`, with exactly one same-thread repair and final PASS;
- the exact verification-contradiction promotion: worker `FAILED`, sole
  `verification` cause and matching failed row, authoritative PASS, preserved
  discrepancy/claim provenance, final PASS, and untrustworthy review semantics;
- an isolated published-CLI lifecycle covering init, repeat init, dry runs,
  doctor, status, activity/human/JSON, owned-setting reconciliation, backup,
  uninstall, repeated uninstall, discovery-hint ownership, and unrelated byte
  preservation; hashes proved the real Codex config/instructions were unchanged;
- three genuinely fresh Codex parents without explicit Sol-Luna instructions:
  two consulted guidance and deliberately chose zero workers for small tasks;
  one discovered the server and naturally selected one high-effort Luna worker
  for a broad read-only lifecycle audit, then independently reviewed its claims;
- a controlled same-file parallel conflict where both isolated tasks passed,
  nothing integrated, both worktrees were retained, and activity/integration
  evidence named the conflict.

At that checkpoint, the campaign had not naturally elicited a sequential or
parallel batch from a fresh parent after three materially different discovery
attempts. Adaptive effort had only one natural high-effort selection and was
then **PARTIAL**. The later focused adaptive-routing campaign superseded both
limits with current natural parallel-batch evidence and natural `medium` plus
`high` selections; a natural sequential batch remains unobserved.

### Focused Linux platform evidence closure

The 2026-08-24 Linux pass closed the deterministic platform gaps that the
Windows campaign could not execute, without changing production/runtime source:

- real file and directory symlinks were created on disk; both an existing target
  and a nonexistent child beneath an escaping directory symlink were rejected as
  outside the workspace even under allowedFiles: ["**"];
- a timed-out verification command spawned a descendant, and the POSIX detached
  process group was terminated with exitCode: null, timeout classification,
  no surviving descendant, and no continuing heartbeat;
- the full worktree suite passed on native Git/POSIX filesystems, including
  isolation, dependency-directory symlinking, unlink-before-cleanup, source
  dependency survival, stale pruning limited to orchestrator paths, persistent
  lease acquire/refresh/loss/release/sweep, retained continuation protection,
  and cancellation leaving no worktrees;
- the real CLI lifecycle smoke passed all 11 groups using temporary isolated
  CODEX_HOME directories: init, repeat init, repair, doctor/status, uninstall
  and repeat uninstall, round trip, empty/malformed config, v0.6.0 migration,
  discovery opt-out, and active override handling.

These results added the missing Linux/POSIX platform evidence. At this
checkpoint, the three known cross-module abnormal lifecycle handoffs remained
out of scope; the later focused lifecycle closure superseded that state.
Adaptive Effort was addressed by a later focused campaign. P1.1 was future work
at this checkpoint and was never part of these campaigns.

### Focused abnormal-lifecycle findings closure

The 2026-08-24 findings-closure pass added three deterministic end-to-end
regressions across the previously missing module handoffs. A real parallel
integration copied one file before a later destination-parent collision failed,
preserving the applied main-workspace change while reporting 2 attempted / 1
applied, `integration.partial`, `integrated:false`, the exact copy warning, and a
retained diagnostic worktree. A promise-barrier fixture started two real
`executeTask` lifecycles concurrently, completed and integrated one sibling, then
aborted the other while it was still inside its worker event stream; cancellation
classification, evidence scanning, events, result counts, retention policy, and
lease release all completed, and the case passed 10/10 repeated executions. A
real retained continuation was then consumed through the server handler, its
persistent lease was observed changing from `retained-continuation` to
`executing-continuation`, and a controlled post-start failure exercised handler
classification and `finally` release; replay returned `used`, the lease artifact
was gone, and orchestrator pruning removed the now-unprotected worktree.

The closure initially reported no runtime-semantic defect. Later incidental
triage recovered a production handoff that its fixture omitted: the MCP registrar
could issue a continuation for the cancelled worker and keep its retained lease.
Cancellation is now terminal for continuation eligibility, and the same focused
regression supplies a registrar and proves that only the completed sibling is
registered. Partial integration remains intentionally non-atomic and is
represented at batch/integration level without rewriting the worker's
independently established verdict or trust evidence. The default `onFailure`
policy intentionally retains an in-flight-cancelled worktree for diagnosis while
releasing its lease. The MCP schema and tool contract remain unchanged.

This closes the recorded abnormal-lifecycle blocker for Parallel batches,
Worktree isolation/integration, and Worker Continuation. Those capabilities now
meet the ledger's Battle-tested definition because existing live DEEP PASS
evidence already covers successful integration, conflict retention, and a
successful retained continuation, while broad deterministic evidence now also
covers the important partial-application, in-flight cancellation, and consumed
continuation failure paths. Bounded concurrency remains Strong: its separate
second-live-configured-limit gap remains. No other capability is promoted by
this focused pass, and Adaptive Effort and P1.1 remain untouched.

Final validation for this closure passed `npm run verify`: typecheck, **463/463**
deterministic tests with no failures or skips, and every MCP protocol smoke
check. The focused parallel/worktree suite passed **76/76**, the in-flight
cancellation case passed **10/10** repeated executions, formatting and build
passed, all nine benchmark fixtures discriminated correctly with mutation
detection, and `git diff --check` was clean.

### Focused worktree-retention precedence closure

The subsequent 2026-08-24 policy pass resolved the temporary campaign finding
between explicit `SOL_LUNA_KEEP_WORKTREES=never` and diagnostic, conflict,
`integrate:false`, evidence-failure, and continuation retention.
`never` now has absolute precedence for intentional retention after all
obtainable structured evidence is captured. Worktree-bound continuations are
issued only when configured cleanup actually retained their directory and a
persistent lease protects it; continuations bound to already integrated shared
workspace state remain eligible under every retention mode. Cleanup failure is
reported separately and can still leave a physical path because configuration
cannot make a failed filesystem operation succeed.

The same pass made `onFailure` verdict-aware: a normally returned final
`FAILED` or `BLOCKED` result is diagnostic failure, not cleanup success merely
because its worker lifecycle completed. Focused table-driven tests cover all
cleanup reasons across `onFailure`, `always`, and `never`; successful and failed
verdict finalization; integration-disabled and conflicted state; continuation
reference/lease admission; truthful worktree events and paths; and
unlink-before-cleanup survival of the source dependency tree. Existing
continuation consumption/failure and partial-integration regressions remain the
evidence for those lifecycle handoffs. This is a deterministic semantic closure;
the earlier live default-`onFailure` acceptance facts remain historical evidence
rather than a claim that every mode was rerun live.

Final validation for this closure passed `npm run verify`: typecheck,
**470/470** deterministic tests with no failures or skips, and every MCP
protocol smoke check. Formatting, all nine benchmark fixture validations,
`git diff --check`, and the explicit final build and smoke reruns also passed.

### Focused second live configured-concurrency limit

A focused live run on 2026-08-24 closed Bounded Concurrency's remaining
second-configured-limit gap. A fresh local MCP process started from this
checkout's rebuilt `dist/server.js` with `SOL_LUNA_MAX_PARALLEL=2`, distinct
from the prior live ceiling of 3. The Ubuntu/Linux host retained the deliberate
repo-local `LUNA_SANDBOX=danger-full-access` workaround because its normal Luna
workspace sandbox is unavailable; this was host configuration, not a product
change. The server's isolated command-line configuration and event paths did
not alter user/global Codex configuration and remained ignored under
`.sol-luna/`.

The one worker-consuming batch, `bmt6wx6ibe3aq`, queued four independent,
read-only investigations for four real `gpt-5.6-luna` medium-effort workers.
All four `task.queued` events preceded any worker start. `t1` and `t2` then
started 1 ms apart and reached active concurrency 2. `t3` started only when
`t2` completed, after 44.018 seconds queued; `t4` started only when `t1`
completed, after 49.016 seconds queued. Replaying the typed terminal events
produced active counts 1, 2, 1, 2, 1, 0: peak 2 was reached and never exceeded.
All four task ids had queued, worktree-created, started, completed, and
worktree-removed evidence; the final event reported 4 passed / 0 failed in 106
seconds. The reduced activity snapshot independently reported
`maxParallel:2`, `current:0`, `peak:2`, four completed Luna workers, no
conflicts, zero retained worktrees, and 4/0 results. Git exposed only the main
worktree afterward, no lease artifact or worker process remained, and no source
file changed.

The configured `git status --short` verification was refused for every task
because `git` was not in the operator verification allowlist. The structured
results truthfully retained the refusal and corresponding discrepancies, so
their task-level `PASS` verdicts were `trustworthy:false`; the semantic audit
claims are not used as scheduler proof. Concurrency acceptance instead rests on
the orchestrator-owned batch, queue, worker lifecycle, worktree, result, and
activity evidence above, plus the runtime-observed empty changed-file sets. An
initial contract submission had overlapping declared scopes and was rejected
before batch creation or any worker start; it is not counted as a live run.
No runtime concurrency defect was observed.

Together with the prior live configured ceiling of 3 and the broad current
deterministic scheduler evidence, including queue progression, cancellation,
setup and failure paths, the distinct live ceiling-2 run now satisfies the
existing Battle-tested definition for Bounded Concurrency. No unrelated feature
is promoted, and Adaptive Effort, P1.1, and broader hardening remain out of
scope.

### Focused adaptive-routing acceptance

A focused Linux live pass on 2026-08-24 closed those two evidence gaps without
changing runtime source or routing guidance. Six genuinely fresh ephemeral
Codex parents ran ordinary read-only repository tasks using GPT-5.6 Sol at
medium parent effort, the checkout-local MCP, dedicated diagnostic/event paths,
and the deliberate repo-local `LUNA_SANDBOX=danger-full-access` Ubuntu
workaround. None of the six task prompts named Sol-Luna, Luna, delegation,
workers, routing, effort, or MCP discovery.

| Parent thread                          | Task shape                                           | Natural route  | Orchestrator-owned result                                                                                               | Judgment                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `01a032bd-8184-7be0-b8b7-443aae398e63` | Small CLI/README parity check                        | Solo           | MCP connected; no task events; parent PASS                                                                              | Sensible zero-worker choice                                                                                                                 |
| `01a032bf-1f8d-7612-8137-c50b146623c8` | One tightly coupled verification-contradiction trace | Solo           | MCP connected; no task events; parent PASS                                                                              | Sensible zero-worker choice                                                                                                                 |
| `01a032c2-39a7-7d63-be0c-714ad91c89ed` | Cross-module cancellation lifecycle audit            | Solo           | MCP connected; no task events; parent PASS                                                                              | Sensible because the requested boundaries formed one state machine                                                                          |
| `01a032c8-927d-7602-8301-4d49e83f9329` | Three-stream release-readiness review                | Parallel batch | Batch `bmt6y5ebj4olo`: three concurrent high-effort Luna starts; 2 PASS / 1 FAILED; no edits; independent parent review | Sensible batch; an initial overlapping-scope contract was rejected, then explicitly accepted for read-only scopes with integration disabled |
| `01a032d6-56ae-7d51-b6a7-281ac86ba7de` | Cross-surface privacy audit                          | Single         | Batch `bmt6yo0fp5mqy`: one high-effort Luna PASS/trustworthy, zero edits                                                | Sensible single bounded investigation                                                                                                       |
| `01a032dd-2aa0-7a52-af37-aff8b77a2736` | Environment-variable traceability inventory          | Parallel batch | Batch `bmt6yy5l0cjtb`: concurrent medium/high Luna starts, 2 PASS / 0 FAILED, zero edits                                | Sensible split; documentation mapping was mechanical while coverage judgment was broader                                                    |

Every parent naturally consulted the configured guidance before its routing
decision. The three solo attempts are supported by the fresh-parent transcripts
and dedicated MCP connection logs; delegated attempts additionally have typed
queued, started, completed, worktree, integration, and batch events. Attempt 4's
three initial tasks all selected `high`; its explicit same-thread continuation
preserved `high` but failed on a false-positive scope violation caused by the
orchestrator-owned shared `node_modules` link. Focused triage now excludes only a
link that still resolves to the expected dependency source and continues to fail
closed for a replaced directory or retargeted link. Attempt 5 selected one `high`.
Attempt 6 independently selected `medium` for a mechanical documentation
inventory and `high` for cross-file coverage judgment; both started as real
GPT-5.6 Luna tasks and passed with no observed edits. The effort variation is
therefore natural and plausible, not inferred from prose or supplied by the
acceptance driver.

The focused pass stopped after attempt 6 because it had both a meaningful
natural batch and two naturally selected worker-effort levels. Natural routing
now has current representative zero-worker, single, and parallel-batch evidence.
No fresh parent selected a sequential batch in this portfolio, so this is not a
claim of a complete natural sequential/parallel ladder. Adaptive effort advances
to live **PASS** and **Strong** confidence under the ledger's existing definition.
Raw transcripts, diagnostic logs, structured results, and event streams are
retained under ignored `.sol-luna/acceptance/adaptive-routing-2026-08-24/`.

### Earlier pre-release live acceptance campaign

The final real-model campaign ran on 2026-08-24 against runtime baseline
`6d610b37c277f7c6875627572306585b8f219a45`. Its results are session-local but
documented here; raw transcripts, activity output, appended events, and diagnostic
logs are not committed.

- **Single:** a real `gpt-5.6-luna` medium-effort `delegate_task` crossed the live
  API boundary, made the required edit, passed authoritative verification, and
  returned final `PASS` / `trustworthy` evidence matching Git state.
- **Sequential:** both tasks passed; Task 2 consumed and modified Task 1's file in
  the shared workspace. Authoritative verification and Git state matched;
  `integrationConflicts` was empty, `integrated` was true, and `worktreePath` was
  null.
- **Parallel:** both isolated tasks passed with peak concurrency 2 in distinct
  `.sol-luna` worktrees. Two disjoint edits integrated: 2 attempted, 2 applied,
  0 conflicts. Completed worktrees and leases were cleaned according to policy.
- **Retained-worktree continuation:** integration was disabled and the worktree
  retained; the opaque continuation resumed the same Luna thread, made a real
  follow-up edit, and reconciled both retained files under the unchanged original
  contract. Replay was rejected and lease artifacts were released according to
  policy.
- **Activity/privacy:** human and JSON views reflected the actual sequential,
  parallel, integration, concurrency, and retained-worktree states.
  `LIVE_ACCEPTANCE_PRIVATE_SENTINEL_823` was absent from both views and appended
  telemetry; appended telemetry contained neither objective nor context fields.

A later documentation-only parallel run also exercised Context Capsule v2 and
compact result packets, followed by one bounded continuation. It configured no
authoritative verification commands and is recorded only as partial supporting
evidence.

### Historical natural-discovery run

The 2026-08-22 v0.8.0 acceptance run is retained as historical evidence:

- **Client and version:** Codex; version not recorded
- **Parent model and effort:** GPT-5.6 Sol, medium
- **Orchestrator version / commit:** v0.8.0; commit not recorded
- **Worker model and effort:** GPT-5.6 Luna, high
- **Discovery:** found unprompted in a fresh Codex session before the parent
  researched the public repository
- **Routing:** one bounded read-only investigation for the initial broad audit,
  then zero workers for a tightly coupled README refinement; both decisions fit
  the work
- **Silence while pending:** not recorded
- **Parent review:** independent; the parent retained synthesis, editing, and
  final verification, and checked package, release, CI, and link evidence itself
- **Outcome:** completed successfully. The delegated read-only task returned
  `PASS` with no changed files, but the then-current orchestrator still emitted
  its generic no-file-changes discrepancy. There was no solo control; this was
  not a performance benchmark and supports no speed, cost, or quality comparison.
- **Retained evidence:** the task ran in another repository; its transcript and
  diagnostic evidence are not retained here

## System-wide invariants

- A parent chooses solo, one worker, sequential, or parallel work adaptively;
  zero workers is valid. Workers cannot delegate recursively: the child config
  disables this server and `SOL_LUNA_WORKER=1` makes the child register no tools.
- Contracts remain bounded by workspace/file scope, forbidden files, acceptance
  criteria, effort, timeout, and verification commands. Scope is a detective
  boundary, not a write sandbox; canonical path and symlink checks still apply.
- Parallel means independent tasks with isolated git worktrees and conservative
  integration. Sequential means shared workspace and ordered dependencies.
  Parallel setup mutations are serialized, concurrency is bounded, and same-file
  observed edits do not get copied over each other.
- Parallel worktree finalization obeys the operator's retention mode:
  `onFailure` is outcome/integration-aware, `always` retains every parallel task
  worktree, and `never` permits no intentional retention. Structured evidence
  survives cleanup; a deletion failure is reported as cleanup failure rather
  than policy retention.
- Workspace-bound continuation is independent of worktree retention.
  Worktree-bound continuation requires the isolated directory to survive
  cleanup under policy and hold a persistent lease. References are single-use;
  cancelled results are terminal and leases are released on finalization,
  failure, and cancellation.
- Worker reports are claims. The orchestrator independently reruns permitted
  verification, reconciles claimed and observed files, records scope and
  integration conflicts, and leaves final judgment to the parent.
- Verification is conditional on the configured policy. Default command parsing
  is argv-based, shell syntax is refused, executables are constrained, and
  credential-shaped environment variables are withheld.
- Activity is append-only local telemetry. Objectives, prompts, source, and
  verification output are excluded from the activity stream; unavailable usage
  is `null`, never zero. Canonical attempt events exclude termination messages
  and sensitive subprocess output while retaining attribution, factual lifecycle,
  usage status, and verification counts. Diagnostic logs remain more sensitive.
- Parent review is risk-based: a clean verified result can be reviewed
  proportionally, while suspicious, failed, contradictory, scope-violating,
  unverified, or integration-conflicted evidence demands deeper inspection.
- Material behavior changes require updating this ledger and marking affected
  and dependent evidence **STALE** until it is rerun. Dependency or upstream
  contract changes use the same rule.

## Detailed records

### Zero-worker/adaptive delegation

- **Implementation/tests:** `src/server.ts`, `src/prompt.ts`, `src/batch.ts`,
  `src/bench/*`; `src/guidance.test.ts`, `src/bench.test.ts`,
  `src/parallel.test.ts`.
- **Authority/history:** policy in `SOL_RULES.md`; acceptance procedure in
  `CONTRIBUTING.md`; `a03a325` (2026-08-14), `18c29b6` and
  `050c6cb` (2026-08-23), followed by `4118525` and `4657768` guidance/test
  alignment.
- **Evidence:** Coverage **PASS**. Targeted guidance/schema execution **PASS** on
  2026-08-24. Committed live benchmark evidence is **STALE**: the
  2026-08-14 scale records show 0/6 free-choice runs delegated and all 6
  passed, but later guidance, batch, evidence, repair, continuation, and
  pricing changes mean this is historical routing evidence, not a current
  closure result. Fresh live **PASS** now records six genuinely fresh parents
  consulting guidance and choosing among zero workers, one worker, and parallel
  batches; this distinguishes informed solo routing from MCP non-discovery.
- **Dependencies/retest triggers:** parent guidance, tool descriptions, cost
  semantics, batch semantics, or routing changes; rerun a fresh-session
  acceptance and the scale/adaptive benchmark. A natural sequential batch was
  not observed, but the prior natural-batch gap is closed by two meaningful
  parallel choices.
- **Confidence:** **Strong**.

### Single delegation

- **Implementation/tests:** `src/server.ts`, `src/worker.ts`, `src/batch.ts`;
  `src/selftest.ts`, `src/parallel.test.ts`, `src/bench.test.ts`,
  `src/guidance.test.ts`.
- **Authority/history:** `README.md`, `SOL_RULES.md`, `CHANGELOG.md` v0.5.0;
  initial implementation history `a03a325` (2026-08-14).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24. Final live acceptance **PASS**: a real medium-effort Luna turn
  crossed the API boundary, made the required edit, passed authoritative
  verification, and returned final `PASS` / `trustworthy` evidence matching Git.
  The older committed benchmark records remain **STALE** after later runtime
  changes.
- **Dependencies/retest triggers:** contract/schema, worker lifecycle,
  verification, continuation, repair, or result rendering changes. **Gap:** the
  final run is documented session-local evidence; its raw transcript and logs
  are not committed.
- **Confidence:** **Strong**.

### Sequential batches

- **Implementation/tests:** `src/batch.ts` shared-workspace sequential path;
  `src/parallel.test.ts`, `src/activity.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `README.md`, `SOL_RULES.md`, `CHANGELOG.md` v0.5.0;
  `a03a325` (2026-08-14), `908c977` and `da496df` (2026-08-23).
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24. The
  full batch suite refreshed shared-workspace dependency, cancellation,
  terminal-state, evidence, and event behavior.
  Current live acceptance **PASS**: 4/4 tasks passed in the shared workspace;
  Task 2 consumed Task 1's file, then optional and forbidden tasks legitimately
  made no change. Authoritative verification and Git state matched,
  `integrationConflicts` was empty, `integrated` was true, and `worktreePath`
  was null. Historical benchmark records remain **STALE** where they predate
  lifecycle and reconciliation hardening.
- **Dependencies/retest triggers:** shared-workspace semantics, cancellation,
  worktree/batch lifecycle, evidence reconciliation, or integration rendering.
  **Gap:** raw final-campaign artifacts are not committed; cancellation and
  failure paths were not part of this live run.
- **Confidence:** **Strong**.

### Parallel batches

- **Implementation/tests:** `src/batch.ts` parallel scheduler;
  `src/parallel.test.ts`, `src/activity.test.ts`, `src/bench.test.ts`.
- **Authority/history:** `README.md`, `SOL_RULES.md`, `CHANGELOG.md` v0.5.0;
  `a03a325`, `5e388c3` (2026-08-14), `da496df` (2026-08-23).
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24. The
  full parallel suite refreshed setup serialization, bounded scheduling,
  cancellation, worker/setup failures, overlap rejection/override, same-file
  conflicts, partial integration, cleanup, and risk-review behavior. The focused
  lifecycle closure advanced deterministic evidence to **DEEP PASS**: an actual
  integration applied one file before a later filesystem operation failed, and
  an already-running worker was aborted only after its concurrently started
  sibling completed; the latter passed 10/10 repeated executions without sleeps.
  Current live acceptance **DEEP PASS**: 3/3 isolated tasks passed at peak
  concurrency 3 in distinct `.sol-luna` worktrees; three disjoint edits
  integrated with 3 attempted, 3 applied, and 0 conflicts. A materially
  different same-file batch then produced two isolated PASS results, correctly
  withheld all integration, retained both worktrees under the configured
  default `onFailure` mode, and exposed the conflict. Completed non-retained
  worktrees and leases were cleaned according to that policy.
  Older committed benchmark evidence remains **STALE** where it predates
  lifecycle fixes.
- **Dependencies/retest triggers:** scheduler, worktree metadata, cancellation,
  overlap, integration, continuation, or verification changes. Raw
  final-campaign live artifacts are not committed, but the prior in-flight
  cancellation and post-application integration blockers now have durable
  deterministic regressions.
- **Confidence:** **Battle-tested**.

### Worktree isolation and integration

- **Implementation/tests:** `src/worktree.ts`, `src/git.ts`, `src/overlap.ts`,
  `src/batch.ts`; `src/parallel.test.ts`, `src/security.test.ts`.
- **Authority/history:** `SECURITY.md`, `SOL_RULES.md`,
  `docs/TROUBLESHOOTING.md`; `5e388c3` and `da496df` (2026-08-14/23).
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24. The
  full worktree suite refreshed isolation, dependency linking, cleanup, stale
  pruning, integration/conflicts, retained continuations, cross-process lease
  ownership, acquisition/refresh failure, expiry, sweep, and legacy path-only
  lease compatibility.
  Historical live acceptance **DEEP PASS** covered distinct isolated worktrees,
  clean disjoint integration, same-file conflict retention, policy cleanup of
  completed worktrees and leases, and a deliberately retained
  integration-disabled worktree used by continuation under the then-current
  default policy. It remains applicable to isolation, linking, integration, and
  cleanup mechanics, but does not prove every current retention mode. Current
  retention precedence and finalization instead have focused deterministic
  coverage in the 516-test baseline. Older committed evidence remains **STALE**
  for lifecycle/lease seams that later changed. The
  focused Linux run added native POSIX evidence: the dependency link was an
  actual directory symlink resolving to the source dependency tree, cleanup
  removed the link/worktree without deleting the source, stale pruning left a
  user worktree intact, and the complete 73-test suite passed with no skips. The
  focused lifecycle closure advanced deterministic evidence to **DEEP PASS** by
  combining partial main-workspace integration, in-flight parallel cancellation,
  retained-worktree policy, exact lease release, consumed-continuation
  finalization, and orchestrator pruning in end-to-end cases.
- **Dependencies/retest triggers:** git version/platform, junction/symlink
  handling, lease ownership, cleanup, or copy integration changes. **Gap:** raw
  final-campaign artifacts are not committed and no broad durable model-backed
  live platform matrix is established.
- **Confidence:** **Battle-tested**.

### Bounded concurrency

- **Implementation/tests:** `src/batch.ts`, `src/config.ts`; `src/parallel.test.ts`,
  `src/bench.test.ts`.
- **Authority/history:** `docs/CONFIGURATION.md`, `SOL_RULES.md`; `a03a325`
  (2026-08-14) and `da496df` (2026-08-23).
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24;
  tests measured peaks, queue progression, setup-before-run ordering, and the
  configured ceiling. Historical scale
  evidence is **STALE**: committed records measured peak concurrency 4 and 6 in
  forced arms under the then-authorized setup, before latest lifecycle changes.
- **Dependencies/retest triggers:** semaphore/config ceiling, scheduler,
  worktree setup, cancellation, or lease changes. **Live evidence:** final
  acceptance observed peak 3 at the published configured ceiling, with 3/3
  isolated checks, queued progress, 3 attempted/3 applied integrations, and
  complete worktree cleanup. A distinct fresh-server run then configured 2,
  queued 4 read-only tasks, reached but never exceeded peak 2, started the later
  two workers only after slots opened, completed 4/4, and removed all four
  worktrees and leases. Typed events and the reduced activity snapshot agreed
  on configured 2, current 0, peak 2, and 4/0 results. Live state is **DEEP
  PASS** for the repeated configured-limit evidence, not a broader scale claim.
- **Confidence:** **Battle-tested**. Two distinct live configured limits now
  complement broad deterministic happy, queue, cancellation, setup, and failure
  coverage.

### Adaptive worker effort

- **Implementation/tests:** `src/contract.ts`, `src/prompt.ts`, `src/worker.ts`;
  `src/selftest.ts`, `src/parallel.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `SOL_RULES.md`, `docs/CONFIGURATION.md`, `README.md`;
  `a03a325` (2026-08-14).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24. Historical benchmark evidence is **STALE**: 2026-08-14 records show
  per-task medium/high/xhigh choices and no max selection, but later
  prompt/schema/evidence changes affect freshness. Current fresh-parent live
  evidence naturally selected high effort for a broad cross-module audit, three
  independent release-readiness streams, and a cross-surface privacy audit. A
  separate environment-variable traceability task naturally split into a
  medium-effort mechanical documentation inventory and a high-effort focused-test
  coverage audit; typed events prove both real Luna starts and 2/2 PASS with no
  observed edits.
- **Dependencies/retest triggers:** effort ladder/default, worker prompt/schema,
  continuation/repair attempt rules, parent routing guidance, or model support
  changes. Live is **PASS**: medium and high were selected naturally for
  materially different, plausibly matched subtasks. No xhigh or max selection is
  claimed.
- **Confidence:** **Strong**.

### Independent verification

- **Implementation/tests:** `src/verify.ts`, `src/command.ts`, `src/worker.ts`;
  `src/security.test.ts`, `src/selftest.ts`, `src/evidence.test.ts`.
- **Authority/history:** `SECURITY.md`, `SOL_RULES.md`, `CONTRIBUTING.md`;
  initial implementation in `a03a325` (2026-08-14), hardening in `908c977`
  (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24, including real exit-code capture, timeout, refusal, authority
  ordering, and output handling. Current live acceptance **DEEP PASS**: single,
  sequential, parallel, continuation, and repaired tasks ran configured
  authoritative verification; controlled repair exercised an initial
  authoritative failure and successful rerun; and the exact contradiction case
  preserved a failed worker row beside a passing authoritative row. Linux
  deterministic evidence additionally exercised the real POSIX detached
  process-group timeout path, verified exitCode: null timeout classification,
  and established that the spawned descendant exited and stopped writing.
- **Dependencies/retest triggers:** verification policy/parser, command runner,
  worker output schema, or authoritative evidence rules. **Gap:** raw
  final-campaign verification rows are not committed; command refusal and
  timeout paths remain deterministic-only.
- **Confidence:** **Strong**.

### Claimed-versus-observed reconciliation

- **Implementation/tests:** `src/worker.ts`, `src/batch.ts`, `src/worktree.ts`;
  `src/evidence.test.ts`, `src/parallel.test.ts`, `src/selftest.ts`.
- **Authority/history:** `README.md`, `SOL_RULES.md`, `SECURITY.md`; initial
  implementation `a03a325`, latest contradiction/evidence fixes `908c977` and
  `6d610b3` (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for claimed files, observed edits, forbidden edits, final Git
  snapshots, and discrepancies. Final live acceptance **DEEP PASS**: single and
  sequential authoritative results matched actual Git state; parallel
  integration matched two disjoint edits; and retained-worktree continuation
  reconciled both the original and follow-up files. Historical benchmark workers
  did not produce false passes, but that remains **STALE** context rather than
  current adversarial evidence.
- **Dependencies/retest triggers:** Git snapshot/reconciliation, change intent,
  worktree integration, worker schema, or final-verdict rules. **Gap:** raw
  final-campaign artifacts are not committed and no deceptive worker claim was
  forced live.
- **Confidence:** **Strong**.

### Context Capsule v2

- **Implementation/tests:** `src/contract.ts`, `src/prompt.ts`, `src/server.ts`;
  `src/prompt.test.ts`, `src/evidence.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `CHANGELOG.md` v0.7.0, `SOL_RULES.md`, `ROADMAP.md` P0.1;
  `debd8cb` (2026-08-19).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24; tests cover optional fields, omission of empty values, ordering,
  bounded rendering, malformed input, and activity privacy. The 2026-08-24
  session-local documentation run exercised Context Capsule v2, but its raw
  artifacts are not committed. Current live **PASS** produced an exact verified
  JSON artifact whose service, numeric port, and trace-header values materially
  depended on the structured capsule; the private sentinel did not enter
  campaign activity telemetry.
- **Dependencies/retest triggers:** capsule schema/prompt rendering, prompt
  boundaries, worker contract, or telemetry changes. **Gap:** no model-backed
  context-efficiency measurement is committed.
- **Confidence:** **Strong**.

### Compact Evidence Packets

- **Implementation/tests:** `src/evidence.test.ts`, `src/worker.ts`,
  `src/server.ts`, `src/contract.ts`.
- **Authority/history:** `CHANGELOG.md` v0.7.0, `SOL_RULES.md`, `ROADMAP.md` P0.2;
  `debd8cb` (2026-08-19).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24; tests verify compact/full defaults, removal of only passing output,
  retention of failures, discrepancies, scope evidence, and text parity. The
  2026-08-24 session-local documentation run exercised compact result packets,
  but its raw artifacts are not committed. Current live **DEEP PASS** includes
  compact verified success plus compact scope-failure and same-file-conflict
  results that retained discrepancies, terminal evidence, conflicts, files,
  and review guidance while removing only passing verbosity.
- **Dependencies/retest triggers:** result schema/detail projection, verification
  capture, failure handling, or batch result rendering changes.
- **Confidence:** **Strong**.

### CLI init/doctor/status/uninstall

- **Implementation/tests:** `src/cli.ts`, `src/cli/init.ts`, `src/cli/doctor.ts`,
  `src/cli/uninstall.ts`, `src/cli/settings.ts`, `src/cli/toml-edit.ts`;
  `src/cli.test.ts`, `src/activity-config.test.ts`, `src/smoke-cli.ts`.
- **Authority/history:** `README.md`, `docs/CONFIGURATION.md`,
  `docs/TROUBLESHOOTING.md`, `CHANGELOG.md` v0.5.0/v0.6.1/v0.8.0; `868726b`
  (2026-08-14), `c966365` (2026-08-22).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24. The CLI and CLI-activity configuration suites covered idempotent
  init, repair, doctor, status, uninstall, dry-run, migration, and discovery-hint
  behavior. Current published-CLI acceptance **PASS** used an isolated campaign
  `CODEX_HOME` for init/repeat/dry-run/doctor/status/activity/reconciliation/
  backup/uninstall, preserving unrelated TOML and user instruction bytes.
- **Dependencies/retest triggers:** Codex config format, Node/Codex versions,
  path resolution, discovery-hint ownership, or CLI writes. The packaged/local
  smoke:cli program was rerun on both campaign platforms. The focused Linux
  run passed all 11 lifecycle groups with the real Codex CLI and temporary
  isolated CODEX_HOME directories; no user Codex home was mutated. This closes
  the prior missing POSIX lifecycle execution, while a broader live platform
  matrix remains uncommitted.
- **Confidence:** **Strong**.

### Activity, observability, and privacy

- **Implementation/tests:** `src/events.ts`, `src/activity.test.ts`,
  `src/activity-watch.test.ts`, `src/activity-config.test.ts`,
  `src/cli/activity.ts`, `src/cli/activity-reducer.ts`, `docs/OBSERVABILITY.md`.
- **Authority/history:** `docs/OBSERVABILITY.md`, `SECURITY.md`, `CHANGELOG.md`
  v0.6.0/v0.8.0; `ce42a06` (2026-08-17), `deca34d` (2026-08-22), `da496df`
  (2026-08-23).
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24:
  event-path configuration, prompt-to-activity privacy, reducer, watch,
  redaction, legacy compatibility, and latest-batch suites all passed. Historical
  live acceptance **DEEP PASS**: human and JSON
  activity views reflected actual sequential, parallel, integration,
  concurrency, and retained-worktree state. The private sentinel was absent from
  both views and appended telemetry, which contained neither objective nor
  context fields.
- **Dependencies/retest triggers:** event schema, reducer projection, path
  resolution, privacy fields, watch attachment, or CLI rendering changes.
  That live run still supports the unchanged privacy and activity projections;
  current retention-neutral integration wording and truthful retained/removed
  projection are covered deterministically after the retention-policy change.
  **Gap:** raw activity and telemetry artifacts are not committed; diagnostic
  logs and tool-result evidence remain more sensitive than activity events.
  Historical pre-hardening JSONL may contain objective fields that current
  writers exclude.
- **Confidence:** **Strong**.

### Natural discovery

- **Implementation/tests:** `src/cli/discovery-hint.ts`, `src/cli/init.ts`,
  `src/cli/doctor.ts`, `src/cli.test.ts`, `src/activity-config.test.ts`,
  `src/guidance.test.ts`.
- **Authority/history:** setup mechanics in `docs/CONFIGURATION.md`; routing
  policy in `SOL_RULES.md`; acceptance procedure in `CONTRIBUTING.md`;
  `CHANGELOG.md` v0.8.0; `c966365` (2026-08-22), then
  `deca34d` and `4118525` (2026-08-22).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for installation, opt-out, override, and guidance behavior. The
  committed live record reports one 2026-08-22 fresh-session run found the
  orchestrator unprompted, but its transcript and diagnostic evidence were not
  retained, so it was previously **PARTIAL**. Current live **PASS** records six
  fresh-parent run and worker identifiers whose informed routing decisions span
  zero workers, one high-effort Luna task, a three-task high-effort parallel
  batch, and a mixed medium/high two-task parallel batch, each with independent
  parent review. Raw JSONL transcripts are retained locally under the ignored
  acceptance-artifact path and are not committed.
- **Dependencies/retest triggers:** global instruction-file selection, hint text,
  Codex startup/discovery behavior, parent guidance, or init/uninstall changes.
  **Gap:** no fresh parent naturally selected sequential batching; natural
  parallel batching now has current representative evidence.
- **Confidence:** **Strong**.

### Explicit Change Intent

- **Implementation/tests:** `src/contract.ts`, `src/prompt.ts`, `src/worker.ts`,
  `src/server.ts`; `src/selftest.ts`, `src/prompt.test.ts`,
  `src/evidence.test.ts`, `src/parallel.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `ROADMAP.md` P0.2a (implemented for v0.9.0),
  `SOL_RULES.md`, `README.md`; `d1be8d6` (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for `required`, `optional`, and `forbidden`, independent of
  `allowedFiles` and task category, including zero-change and forbidden-edit
  classification. Current live **DEEP PASS** covers required edits across single,
  sequential, parallel, repair, contradiction, and continuation; legitimate
  optional and forbidden zero-change tasks; and fail-closed scope precedence
  from a malformed supervisor contract.
- **Dependencies/retest triggers:** contract/schema, worker prompt, observed-file
  reconciliation, repair admission, or release of P0.2a.
- **Confidence:** **Strong**.

### Worker Continuation

- **Implementation/tests:** `src/continuation.ts`, `src/batch.ts`,
  `src/contract.ts`, `src/server.ts`; `src/selftest.ts`, `src/parallel.test.ts`,
  `src/evidence.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `ROADMAP.md` P0.3 (implemented for v0.9.0),
  `SOL_RULES.md`, `docs/OBSERVABILITY.md`; `cdaf9f5` and `da496df`
  (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for opaque single-use expiry, exact-thread resume, immutable
  contract, repeat verification, integrated/retained worktree binding, lease
  protection, terminal cancellation, dependency-link reconciliation, and all
  retention modes. The focused lifecycle and policy closures advanced deterministic evidence to
  **DEEP PASS**: a real retained continuation crossed store consumption, lease
  refresh, same-thread/immutable-contract checks, server start/failure events,
  handler `finally`, replay refusal, lease release, and stale-worktree pruning in
  one test. Historical live acceptance is **DEEP PASS** for the unaffected
  continuation behavior: an integration-disabled worktree
  was retained, the continuation resumed the same Luna thread, completed a real
  follow-up edit, and reconciled both retained files under the unchanged original
  contract. Replay was rejected and lease artifacts were released according to
  the configured policy. That run predates the cancellation-eligibility,
  dependency-link, and retention-precedence fixes and is not used as proof of
  those changed semantics; current deterministic regressions are their authority.
- **Dependencies/retest triggers:** continuation TTL/reference store, worktree
  leases, final Git reconciliation, contract fields, or worker lifecycle changes.
  Raw final-campaign artifacts are not committed and expiry was not exercised
  live, but the abnormal consumed-continuation finalization blocker now has a
  durable deterministic regression.
- **Confidence:** **Battle-tested**.

### Bounded Repair

- **Implementation/tests:** `src/worker.ts`, `src/batch.ts`, `src/contract.ts`,
  `src/events.ts`, `src/continuation.ts`; `src/evidence.test.ts`,
  `src/activity.test.ts`, `src/guidance.test.ts`, `src/selftest.ts`.
- **Authority/history:** `ROADMAP.md` P0.4 (implemented for v0.9.0),
  `SOL_RULES.md`, `docs/OBSERVABILITY.md`; `9d2ebe9` and `da496df`
  (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for the conservative classifier, exact failure evidence,
  same-thread one-turn repair, immutable change intent, re-verification, and
  exhaustion behavior. Current live **DEEP PASS** includes two conservative
  non-admissions with distinct environment/claims discrepancies and one clean
  `local-verification` admission with exactly one same-thread repair and final
  authoritative PASS.
- **Dependencies/retest triggers:** verifier authority, failure classification,
  continuation, change intent, event lifecycle, or worker thread reuse changes.
  **Gap:** recursive repair is proven only deterministically, by design.
- **Confidence:** **Strong**.

### P1.0 parent/pricing foundation

- **Implementation/tests:** `src/cost.ts`, `src/worker.ts`, `src/contract.ts`,
  `src/events.ts`, `src/server.ts`, `src/batch.ts`, `src/continuation.ts`,
  `src/cli/activity-reducer.ts`; `src/selftest.ts`, `src/guidance.test.ts`,
  `src/activity.test.ts`, `src/evidence.test.ts`, `src/parallel.test.ts`.
- **Authority/history:** `ROADMAP.md` P1.0 (foundation implemented for v0.9.0),
  `docs/CONFIGURATION.md`, `SOL_RULES.md`; `2d6e4c6` (2026-08-23).
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24 for
  explicit parent-identity provenance, distinct billing contexts, promotional
  cards, all rate bases and charge-unit shapes, observed usage meters, complete
  post-hoc eligibility, stable unavailable reasons (including missing input and
  non-finite totals), freshness/effective bounds, and no inferred prices. Live
  acceptance is **N/A** for these pure post-hoc primitives: real campaign usage
  was observed, but no production rate-card lookup, billing-account consumer,
  routing consumer, or cost-calculation API exists.
- **Attempt-evidence hardening:** Targeted deterministic execution **DEEP PASS**
  on 2026-08-26 for authoritative success usage; `turn.failed`; stream and
  abnormal-process errors; failure before `thread.started`; timeout and external
  cancellation; partial message/file retention; exactly one terminal record per
  start; non-1 ordinals; attributed verification; immutable automatic-repair,
  manual-continuation, timeout-recovery, and process-retry lineage; successful
  sibling preservation; post-execution lifecycle failure; activity compatibility
  and privacy; compact/full/handoff projection; and complete versus incomplete
  aggregate usage. No model-backed benchmark or live worker call was used.
- **Dependencies/retest triggers:** cost-input schema, rate-card applicability,
  usage projection, attempt/result/event schema, worker lifecycle, repair,
  continuation, recovery, activity reduction, identity provenance, or any future
  routing/policy consumer.
  **Gap:** no retrieval, account lookup, prediction, routing, or measured saving
  is implemented; the foundation remains limited to post-hoc evidence.
- **Confidence:** **Strong** for the shipped bounded foundation, not future P1.1
  policy or pricing services.

### Worker `failureCauses` and authoritative-verification contradiction handling

- **Implementation/tests:** `src/contract.ts`, `src/prompt.ts`, `src/worker.ts`,
  `src/batch.ts`; `src/selftest.ts`, `src/prompt.test.ts`, `src/evidence.test.ts`,
  `src/parallel.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `CHANGELOG.md` v0.9.0, `README.md`, `SOL_RULES.md`,
  `ROADMAP.md` P1.1 note; `908c977` and `6d610b3` (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for strict status-aligned causes, legacy normalization, malformed
  reports, complete one-to-one authoritative contradiction promotion only for a
  sole `verification` cause, terminal-evidence vetoes, and preserved worker claim
  / untrustworthy result. Current live **PASS** exercised the exact narrow
  promotion with a required observed edit, worker `FAILED`, sole `verification`
  cause, matching failed worker row, passing authoritative rerun, preserved
  discrepancy/provenance, and activity `claimed: FAILED` versus `verdict: PASS`.
- **Dependencies/retest triggers:** external worker schema, verification
  authority/equivalence, final Git evidence, repair classifier, or failure
  rendering changes. **Gap:** this is evidence for future P1.1 classification,
  not the future classifier itself; deterministic negative controls remain the
  authority for malformed and veto cases.
- **Confidence:** **Strong**.

## Closure campaign boundary

P2.4 Mature Benchmark and Acceptance Pass is a future system-wide closure
campaign, dependent on the roadmap capstone. It is not the first time these
features were tested and it does not retroactively erase the deterministic,
historical benchmark, or documented session-local live evidence above. Until a
deliberate rerun at the relevant runtime baseline exists, historical live results
remain **STALE** where implementation changed, and unknown execution dates remain
unknown.
