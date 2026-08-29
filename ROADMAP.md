# Roadmap

Future work is listed in priority order with dependencies and constraints. The
[`CHANGELOG.md`](CHANGELOG.md) is authoritative for shipped behavior; runtime
semantics belong to the implementation and focused documentation.

## Direction

Sol-Luna optimises for adaptive delegation, context efficiency, bounded
orchestration, independent verification, observability, conservative failure
handling, and reproducible evidence. It does not optimise for agent count,
delegating whenever possible, fixed user-selected routes, or automatic Git
actions.

The project priority is:

1. Correctness and trustworthy verified output
2. Reliability and conservative failure handling
3. Effective parallel execution
4. Latency/context efficiency
5. Cost efficiency

Cost matters, but it is not the primary objective. The orchestrator should use parallelism when it improves execution, while staying Solo when delegation would hurt correctness or efficiency.

## Priorities at a glance

| Priority | Item                                                   | Status / dependency                                                         |
| -------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| P0       | Context Capsule v2; Compact Evidence Packets           | Shipped in v0.7.0                                                           |
| P0.2a    | Explicit Change Intent Contracts                       | Shipped in v0.9.0                                                           |
| P0.3     | Worker Continuation                                    | Shipped in v0.9.0; depends on P0.2a                                         |
| P0.4     | Bounded Repair Loop                                    | Shipped in v0.9.0; depends on P0.3 and P0.2a                                |
| P1.0     | Parent Identity, Billing, and Post-Hoc Cost Foundation | Shipped foundation in v0.9.0; attempt-evidence hardening shipped in v0.11.0 |
| P1.1     | Reasoned Retry and Effort Escalation                   | Shipped in v0.11.0; built on P0.4 and completed P1.0 hardening              |
| P1.2     | Adaptive Worker Routing and Compute Policy             | Shipped in v0.11.0                                                          |
| P1.3     | Automatic Context Lifecycle Management                 | Shipped in v0.11.0; depends on P0.1, P0.2, and P0.3                         |
| P2.1     | Optional Explorer                                      | Shipped in v0.11.0; depends on P1.2                                         |
| P2.2     | Lightweight Cross-Session Handoff                      | Shipped in v0.11.0; depends on P1.3                                         |
| P2.3     | End-to-End Automated Workflow                          | Shipped in v0.11.0; depends on P1.2, P1.3, P2.1, and P2.2                   |
| P2.4A    | Acceptance Harness and Benchmark V3 Methodology        | Shipped in v0.11.0; methodology and harness frozen, no V3 run               |
| P2.4B    | Benchmark V3 Execution and Mature Acceptance Pass      | NOT EXECUTED; depends on P2.4A and an operator launch decision              |

The order is intentional: continuation, repair, failure classification, and
policy discovery should precede stronger-executor routing. Explorer, handoff,
the capstone, and mature acceptance build on those primitives.

## Completed and implemented foundations

The following entries are retained only as roadmap anchors; their release status
is maintained in [`CHANGELOG.md`](CHANGELOG.md):

- **Context Capsule v2 and Compact Evidence Packets (P0).** Structured context
  and compact review output reduce redundant handoff material.
- **Explicit Change Intent Contracts (P0.2a).** Tasks can state whether changes
  are forbidden, optional, or required; this is distinct from file scope.
- **Worker Continuation (P0.3).** An eligible result can expose a bounded,
  single-use continuation for an explicit follow-up in the same worker thread.
- **Bounded Repair Loop (P0.4).** A narrowly classified local verification defect
  may receive one automatic same-thread repair before returning to the parent.
- **Parent Identity, Billing, and Post-Hoc Cost Foundation (P1.0).** The original
  foundation shipped in v0.9.0 and keeps identity and billing evidence explicit
  without inventing estimates. The attempt-evidence hardening shipped in v0.11.0;
  it adds immutable per-execution lineage, factual
  termination and timing, authoritative-or-unavailable usage, and retained
  post-start failure evidence as inputs for later P1.1 decisions.
- **Thin Supervisor.** A supporting architectural milestone shipped in v0.10.0.

See the implementation, tests, [`SOL_RULES.md`](SOL_RULES.md),
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md), and
[`CHANGELOG.md`](CHANGELOG.md) for current semantics and release history.

## P1.1 Reasoned Retry and Effort Escalation

**Shipped in v0.11.0.**

Classify concrete failure evidence before choosing repair, retry, higher effort,
a stronger authorised executor, or parent takeover. The classifier must
distinguish contract, implementation, verification, timeout, environment,
scope/conflict, effort, and capability failures, and must not retry merely because
a counter permits it.

**Boundary with P1.2:** P1.1 owns failure classification and deciding whether
repair, retry, effort escalation, stronger-executor fallback, or parent takeover
is warranted. P1.2 owns actual authorized worker/model selection and enforcement
of user-owned compute policy.

The implemented policy:

- derives one conservative `failureDecision` from canonical attempt,
  verification, scope, contract, recovery, and repair evidence
- chooses one of stop, repair, bounded continuation, retry, one-step effort
  escalation, stronger-executor fallback recommendation, or parent takeover
- keeps automatic repair ahead of parallel recovery, prevents nesting or
  chaining after either bound, and never treats an unused retry count as evidence
- preserves task/batch identity, execution lineage, per-attempt usage, successful
  siblings, and terminal cancellation semantics
- recommends stronger-executor fallback only; P1.2 still owns authorization,
  selection, and compute-policy enforcement

**Constraints.** Keep classification conservative; specification and environment
failures should return to the supervisor rather than burn another worker turn.

## P1.2 Adaptive Worker Routing and Compute Policy

**Shipped in v0.11.0.**

Separate user-owned compute policy from supervisor routing. Compute policy
authorizes worker models, explicit executor ordering, effort ceilings, concurrency,
and cross-model escalation; the runtime enforces it rather than relying on
prompts. Routing chooses solo, a worker, a sequential batch, a parallel batch,
continuation, repair, retry, an authorised stronger executor, or parent takeover,
based on evidence and within that envelope.

The delivered capabilities provide:

1. **Cheap Routing Eligibility / Preflight**: Deterministic eligibility
   is separated from expensive architecture: a pure synchronous evaluator decides
   obvious solo cases from a small declared card before any repository exploration,
   worktree, thread, or worker exists.
2. **User-Owned Compute Policy and Runtime Enforcement**: A canonical policy
   envelope names the authorised worker models, operator-declared executor ordering
   (`SOL_LUNA_EXECUTOR_ORDER`), permitted effort levels, concurrency and worker-count
   limits, and whether effort escalation or a stronger-executor fallback may be
   recommended. The baseline is operator-owned, read from the environment and
   bounded by the runtime's own ceilings; a call may narrow it and can never widen it.
   Enforcement is at admission for model, effort, and worker count; on the resolved
   envelope for concurrency, across both the initial worker window and the bounded
   recovery pass; and on the failure ladder, which a narrowed envelope can only shorten
   toward parent takeover.
3. **Adaptive Route Planning**: The same cheap preflight recommends one bounded
   execution shape for work the parent has declared: solo versus delegate, the
   mechanism (single, sequential, parallel), a conservative starting effort, and
   the worker and concurrency counts the active compute policy permits. The shape
   follows the route — a `solo` route yields the `solo` mechanism and zero workers.
4. **Decomposition and Seam Planning**: A pure synchronous planner decides whether
   work the parent has described stays one unit or becomes several, and emits the
   result as a routing preflight card. A split has to be earned by declared evidence
   or by structure derivable from it, while undeclared coupling keeps the work whole.
5. **Selection Policy**: A pure synchronous selector computes the exact model and
   effort for a turn. It starts at the envelope's authorised executor and routing's
   starting effort, climbing rungs only with evidence.
6. **Explicit Operator Executor Ordering and Fallback**: Resolves stronger-executor
   fallback along an explicit operator-declared ordering ladder, returning
   `stronger-executor-selected` or `stronger-executor-exhausted`. Model list position
   in `allowedModels` is never treated as a strength hierarchy.
7. **Unified Adaptive Routing Pipeline and Telemetry**: Pure synchronous pipeline
   (`routeAdaptiveTask`, `routeAdaptiveCard`) chaining seam planning -> routing
   evaluation -> shape recommendation -> compute selection. Telemetry in single
   delegation, preflight, and batch execution emits recommended mechanism, worker
   count, concurrency, effort, selected model, selected effort, and selection reason.
   Factual worker lifecycle and attempt records separately name what actually runs,
   so advisory selection cannot be mistaken for execution.
8. **Semantic Task-Contract Seam Planning**: Derives real `SeamCandidate` units directly from actual
   `DelegateTaskInput` contracts without synthesizing artificial seams from `allowedFiles`
   globs, feeding them directly into the pure seam planning -> routing -> selection pipeline.
9. **Evidence-Earned Next-Action Handoff**: Server-lifetime, single-use, TTL-bounded (`hdf_...`)
   reference issued for an earned P1.1 bounded retry, effort escalation, or stronger-executor fallback. Consuming
   the handoff strictly restores the immutable contract fields (`objective`, `allowedFiles`,
   `forbiddenFiles`, `changeIntent`, `acceptanceCriteria`, `verificationCommands`) and truthful
   predecessor lineage (`predecessorExecutionId`, incremented `logicalAttempt`, `model`, `effort`,
   `failureDecision`). Caller-supplied `previousAttempts` without a valid server handoff cannot
   authorize escalation or stronger executors.
10. **Live Adaptive Compute Integration**: Directly wired into authoritative
    `delegate_task` and `delegate_tasks` lifecycles without parallel façades or dual retry loops.
    Mechanism recommendations remain advisory and supervisor-owned; pure/preflight solo and
    zero-worker routes create no worktree, thread, or worker. Once the supervisor selects a
    delegation surface, selected model and effort reach worker turns, `AttemptEvidence`, and batch
    results, preserving truthful attempt evidence and continuation lineage.

**Constraints.** The supervisor cannot expand permissions. Routing preserves
scope, isolation, independent verification, evidence handling, bounded retries,
and conservative concurrency; no model hierarchy is assumed. Cost is quantitative
only when applicable billing evidence is known; otherwise it remains qualitative.

## P1.3 Automatic Context Lifecycle Management

**Shipped in v0.11.0.**

Compact repeated tool output, logs, worker turns, and stale context at safe
handoff, continuation, repair, retry, and review boundaries while retaining
requirements, decisions, constraints, and verification evidence.

The implemented P1.3 scope encompasses:

1. **Structured Context Retention and Compaction Core (P1.3A):** The pure,
   deterministic retention and compaction primitive in `src/context.ts`
   projects a decision-safe, redacted view without mutating authoritative state.
   It preserves complete contract arrays, distinct decisions, constraints, blockers,
   execution lineage, failure/conflict evidence, and authoritative verification facts.
   Clean verified PASS results omit passing command stdout while retaining execution
   metadata, files changed, and risks.
2. **Context Pressure Metrics and Trigger Policy (P1.3B):** A pure, synchronous,
   deterministic policy in `src/context.ts` measures context size pressure in exact
   UTF-8 bytes, turn distribution (clean, diagnostic, narration, tool-prose, routing),
   exactly removable repeated-turn overhead, exact projection-size reclaimable bytes,
   and complete factual token usage (when every constituent reports it). It evaluates
   configurable trigger thresholds (size limit, turn count, clean-history accumulation,
   tool overhead, reclaimable ratio) against strict safety and protected-evidence block
   conditions (unsafe lifecycle boundary gating, no new turns since compaction,
   insufficient reclaimable gain, and authoritative turn-based cooldown hysteresis).
   Issued handoffs and continuations survive compaction because their originating
   authority and issued/unconsumed state remain represented in the compact projection;
   neither projections nor pressure metrics expose capability values. Failure, conflict, security/scope,
   lineage, and unresolved review evidence remain protected by the P1.3A projection.
   Explicit reason codes (`trigger:*`, `block:*`, `noop:*`) accompany all evaluations.
3. **Live Context Lifecycle Integration (P1.3C):** Wired context pressure evaluation
   and compaction into live execution lifecycles (`delegate_task`, `delegate_tasks`,
   and `continue_task`) through an in-memory registry of isolated authoritative
   `ContextLifecycleStore` instances. Fresh calls and batches receive distinct contexts;
   only a server-issued continuation or handoff may restore its own lineage context.
   Execution leases are reference-counted, so compaction occurs only at safe
   post-execution boundaries (`post-delegation`, `post-batch`, `post-continuation`) after
   all relevant repair, recovery, reconciliation, and cleanup work has finished, and is
   blocked while any related execution remains in flight. The advisory
   `routing_preflight` call emits routing telemetry but cannot mutate or compact an
   execution context. Canonical runtime evidence and cooldown state remain authoritative;
   only projected views compact, and a new authoritative turn invalidates an older
   projection before reevaluation. Live `ContinuationStore` and `HandoffStore` state
   determines reference eligibility, preventing stale or consumed authority from appearing
   active. Factual telemetry events (`context.evaluated`, `context.compacted`) emit exact
   metrics without leaking secrets, prompts, sensitive output, or capability tokens.

**Constraints.** Compaction must be bounded and observable and must not discard
acceptance criteria, failure or conflict evidence, scope, or the distinction
between claimed and verified results. Depends on P0.1, P0.2, and P0.3.

## P2.1 Optional Explorer

**Shipped in v0.11.0.**

Provide an adaptive, bounded, read-only investigation companion (`explore` MCP tool)
for unfamiliar repositories, dependencies, APIs, or documentation. It returns structured
findings rather than an unchecked plan, implements nothing, and cannot delegate.
Optional and supervisor-owned.

The implemented P2.1 capabilities provide:

1. **Read-Only Companion Contract and Schema (`explore` tool):** Bounded `ExploreInput`
   and `ExploreOutput` contracts in `src/contract.ts` requiring specific investigation
   targets, explicit effort justifications, optional question lists, and structured
   capsules (`contextCapsule`).
2. **Strict Read-Only Enforcement:** `changeIntent` is strictly `"forbidden"`. The Codex
   thread uses the fixed SDK `read-only` sandbox in a disposable admitted-scope copy, never
   the authoritative workspace. A content/symlink manifest detects creation, deletion,
   modification, rename, symlink, and untracked-file changes; attempted mutation fails trust
   and the disposable surface is removed.
3. **Grounded Structured Findings:** Worker output conforms to strict JSON schema
   `explorerOutputJsonSchema`, cleanly segregating:
   - `observedFacts`: explicitly worker-provenanced claims whose exact source file, one-based
     line, and evidence text receive a runtime grounding status.
   - `runtimeObservedFacts`: only source-grounding and mutation facts established by the runtime.
   - `inferences`: explicit hypotheses with stated rationale.
   - `unknowns`: open, unresolved questions with why they could not be determined.
   - `relevantFiles`: files key to the target with reason for relevance.
   - `recommendedSeams`: candidate decoupled seams for supervisor delegation planning.
4. **Advisory Seam Discovery Without Delegation Façade:** Proposes candidate seams
   and files to assist supervisor architecture without generating speculative unchecked
   implementation plans or usurping supervisor decomposition.
5. **Single-Worker Compute Policy Enforcement:** Adheres to the operator compute policy
   envelope via `admitCompute`, admitting or refusing exploration calls based on
   declared model and effort permissions and emitting `explore.started`, `explore.completed`,
   and `explore.rejected` telemetry events.
6. **Context Lifecycle and Compaction Integration:** Integrates into authoritative
   `ContextLifecycleStore`, acquiring execution leases to guard in-flight exploration,
   recording exploration turns, and triggering safe compaction evaluations at the
   `"post-exploration"` lifecycle boundary. `compactContext` compacts clean exploration turns
   while preserving grounded facts, inferences, unknowns, and candidate seams.
7. **Anti-Recursion and Isolation:** The `explore` tool is disabled inside worker processes
   (`IS_WORKER_PROCESS` / `SOL_LUNA_WORKER=1`), preventing recursive explorer spawning.
8. **Proportional Rendering:** Supports `handoff` (concise human-readable report),
   `compact` (the same reduced canonical structure in text and `structuredContent`), and
   `full` (complete `ExploreOutput`); modes do not change factual semantics.

**Constraints.** Exploration must remain optional, bounded, read-only, and supervisor-owned.
Zero-worker direct solo execution or immediate task delegation without exploration remain first-class.
Depends on P1.2.

## P2.2 Lightweight Cross-Session Handoff

**Shipped in v0.11.0.**

Provide an optional, compact, deterministic cross-session handoff artifact containing
caller-supplied historical context for resuming work across server restarts or separate
supervisor sessions without replaying raw conversation logs or weakening authority
boundaries.

### Implemented capabilities

1. **Deterministic Structured Schema (`SessionHandoffArtifact`):** Strict Zod schema
   (`SESSION_HANDOFF_SCHEMA_VERSION = "sol-luna-handoff/v1"`) with canonical key ordering,
   mandatory deep sanitization, explicit imported provenance, and a 256 KiB fail-closed
   artifact limit.
2. **Contract, Decision, and Blocker Fidelity:** Preserves objective, acceptance criteria,
   allowed/forbidden scope, change intent, task category, settled architectural/user/policy/invariant
   decisions (`ContextDecision`), active constraints (`ContextConstraint`), and active/resolved
   blockers (`ContextBlocker` with failure classifications).
3. **Strict Epistemic Segregation:** Explicitly segregates worker claims (`observedFacts` with
   grounding provenance and `workerClaims`), runtime-verified facts (`runtimeObservedFacts`),
   inferences/hypotheses (`inferences`), and clearly labeled open unknowns (`unknowns`).
4. **Historical Verification & Completed Work:** Retains prior observed file modifications,
   verification counts (executed/passed/failed/refused), failed verification diagnostic evidence,
   discrepancies, scope violations, integration conflicts, and unresolved review checklist items as
   imported history that cannot satisfy current-session verification.
5. **No Capability-Token or Credential Leakage:** Deeply redacts all bearer capability tokens
   (`ctr_*`, `hdf_*`), API keys (`sk-*`), bearer tokens, and secrets. Replaces live bearer references
   with explicit expiration markers.
6. **Fail-Closed Restart & Re-Entry Semantics:** Marks all in-memory continuations and next-action
   handoffs as expired (`inMemoryContinuationsExpired: true`, `inMemoryHandoffsExpired: true`).
   In-memory capability stores in a new server process reject prior-session references (`status: "unknown"`).
   Restoring a handoff into a new session context requires all new task delegations to re-enter
   normal admission, compute policy, scope constraints, and verification gates.
7. **Deterministic & Bounded Serialization:** Recursive canonical key sorting (`canonicalizeObject`)
   makes repeated serialization of one artifact byte-for-byte stable. Export creates identity and time
   metadata unless supplied; a pure parse/restore/re-export preserves them, while a snapshot containing
   fresh current-session evidence receives new metadata. P1.3 compaction omits clean passing stdout,
   status narration turns, and verbose tool prose while preserving diagnostic evidence. Oversized
   diagnostic artifacts fail instead of truncating semantics.
8. **Lifecycle Store & Registry Integration:** Provides `exportSessionHandoffFromStore`,
   `restoreSessionHandoffIntoStore`, and `ContextLifecycleRegistry.restoreSessionHandoff` for direct
   integration with in-memory execution lease management.

**Constraints.** Schema validation proves structure, not authenticity. Cross-session handoffs are
informational context only, not automatic authorization for retry, escalation, continuation, scope
expansion, compute selection, verification, or handoff consumption. Imported decisions, constraints,
blockers, observations, verification, and lineage remain separate from current server-owned canonical
evidence. Depends on P1.3.

## P2.3 End-to-End Automated Workflow

**Shipped in v0.11.0.**

Provide one bounded supervisor-driven workflow (`executeWorkflow`) that coordinates
task intake, optional exploration, semantic decomposition, adaptive routing, zero-worker parent
takeover, single and batch delegation, authoritative verification, P1.1 failure decisions,
bounded repair, recovery, continuation, and evidence-earned next-action escalation without creating
a second orchestration system.

### Implemented capabilities

1. **Bounded coordinator (`executeWorkflow`):** A 13-state coordinator (`assessing`,
   `exploring`, `routing`, `solo`, `delegating`, `evaluating`, `continuing`, `escalating`,
   `completed`, `failed`, `blocked`, `parent_takeover`, `cancelled`) reflects authoritative
   handler results. `solo` is a non-terminal routing state that yields to parent takeover;
   it is never verification or completion evidence.
2. **Direct primitives reuse:** Reuses the existing server lifecycle handlers
   (`handleExplore`, `handleDelegateTask`, `handleDelegateTasks`, `handleContinueTask`), adaptive
   routing and compute admission, and the existing context, handoff, and continuation stores.
   Handler-owned verification, one-turn repair, one-pass batch recovery, scope reconciliation,
   worktree cleanup, and capability consumption remain authoritative.
3. **Optional advisory exploration:** Explicit exploration uses the existing read-only handler.
   Findings remain provenance-bearing advice and never become executable task contracts.
4. **Adaptive routing and zero-worker path:** Semantic task contracts remain the only executable
   work units. A zero-worker result creates no worker, thread, or worktree and returns
   `PARENT_TAKEOVER`, because the coordinator has no evidence that the parent completed the work.
5. **Single and Batch Delegation:** Executes single delegation (`delegate_task`) or parallel /
   sequential batches (`delegate_tasks_parallel`, `delegate_tasks_sequential`) with integration verification.
6. **Handler-owned repair and recovery:** Consumes the final result after the existing single-task
   repair or batch recovery mechanisms finish; the workflow adds no repair or verification pass.
7. **Continuation & Next-Action Escalation:** Resumes incomplete tasks via single-use server-issued
   continuation references (`ctr_*`) and escalates effort or triggers stronger-executor fallback via
   authoritative handoff tokens (`hdf_*`).
8. **Fail-Closed Verification & Parent Takeover:** Untrusted results, scope violations, contradictory claims,
   and unrecoverable verification defects cleanly yield to `PARENT_TAKEOVER` with diagnostic evidence.
9. **Execution bound enforcement:** Finite non-negative bounds are normalized and clamped
   (`maxSteps` <= 20, `maxEscalations` <= 5, `maxContinuations` <= 3). Callers can narrow only.
   The existing one-turn repair, one-pass batch recovery, and single-use capabilities impose
   their independent authoritative bounds.
10. **Lifecycle Lease & Context Compaction:** Manages `ContextLifecycleStore` execution leases and triggers
    safe post-execution compaction evaluations.
11. **Privacy-preserving workflow telemetry:** Emits allowlisted structural
    `workflow.started`, `workflow.transition`, and `workflow.completed` fields. Requested,
    recommended, and executed compute remain distinct; prompts, paths, raw output, verification
    output, and capability references are absent.

The deterministic workflow suite covers coordinator scenarios and report
rendering. It is included in the canonical `npm test` and `npm run verify` gates;
its exact test count is validation output rather than a roadmap contract.

**Constraints.** Supervisor remains the orchestration authority. File scopes remain detective, and
independent verification remains authoritative. Model list position is never a strength hierarchy; explicit
`executorOrder` ladder is respected. Depends on P1.2, P1.3, P2.1, and P2.2.

## P2.4 Mature Benchmark and Acceptance Pass

After the capstone stabilizes, retest solo, delegated, repair, fallback,
exploration, continuation, and adaptive modes across representative task shapes.
Measure quality, latency, context and token use, routing, retries, and cost only
when the applicable billing schedule is known. Preserve evidence, treat zero
workers as valid, and report unknown or incomparable cost rather than estimating.
Depends on P2.3 and the completed routing, context, and handoff primitives.

Benchmark V3 is frozen as a future holdout/evaluation asset. Do not run or tune
against V3 during active feature development. Major model-backed benchmark
campaigns should wait until P2.4 / mature acceptance after the planned feature
chain is substantially complete. Targeted deterministic tests, runtime tests,
smoke tests, and security tests still happen as each feature lands.

### P2.4A Acceptance harness and Benchmark V3 methodology

**Shipped in v0.11.0. Methodology and harness are frozen; no V3 run exists.**

P2.4A fixes what a V3 result will be allowed to mean, before any model-backed
V3 task is executed:

1. **Final acceptance boundary.** Every capability from P1.0 through P2.3 is
   enumerated in [`docs/FEATURE_ACCEPTANCE.md`](docs/FEATURE_ACCEPTANCE.md)
   against three separated evidence classes: deterministic/code-confirmed, live
   model-backed behavioural, and benchmark performance/economics. P1.1 through
   P2.3 hold deterministic acceptance only; no live or benchmark evidence is
   claimed for them.
2. **Frozen V3 methodology (freeze 2).** [`bench/V3_METHODOLOGY.md`](bench/V3_METHODOLOGY.md)
   adds comparison candidates and baselines, a harness configuration boundary, a
   metric catalog with provider-exact measurement semantics, execution ordering
   and randomization, run validity/exclusion and retry treatment, statistical and
   reporting discipline, and reproducibility controls. Freeze 1's workload,
   graders, arms, repetition rules, and economic accounting are unchanged. The
   document is content-addressed and the harness refuses to launch on drift.
3. **Harness maturity.** Reproducibility capture, deterministic seeded ordering,
   predeclared exclusion classification, and orchestration/context metric folding
   reuse the existing benchmark infrastructure. No task identity appears in
   harness control flow, and the runner configures no orchestrator production
   policy for V3.

**Constraints.** No composite score. No live evidence claimed where only
deterministic tests exist. No tuning of prompts, routing, thresholds, or fixtures
against V3. Quarantine covers missing evidence only, never an unwelcome result.

### P2.4B Benchmark V3 execution and mature acceptance pass

**NOT EXECUTED.** Runs the frozen campaign and reports it. Blocked on an operator
launch decision, pricing revalidation, and a clean recorded baseline commit.

## Research and platform work

Visible but lower priority and not actively implemented:

- Sandboxed verification, if Codex exposes a suitable mechanism.
- Broader live end-to-end platform coverage, especially macOS and Linux without
  the documented trusted-development sandbox workaround.
- Fixtures larger than one supervisor session.
- Characterisation of slow-worker tails in parallel batches.
- Comparison of supervisor effort levels when the evidence justifies the usage.

## Not current goals

1. **Fixed user-selected orchestration modes.** The supervisor remains adaptive.
2. **Maximising worker count.** More agents are a tool, not the objective.
3. **Automatic Git closure.** Sol-Luna does not commit, push, or tag because an
   orchestration finished; the user decides what happens to integrated changes.

## Contributing to the roadmap

Open an issue before implementing roadmap work, including the approach and how
its constraints will be tested. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
development and project workflow.
