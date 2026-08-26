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

| Priority | Item                                                   | Status / dependency                                                           |
| -------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| P0       | Context Capsule v2; Compact Evidence Packets           | Shipped in v0.7.0                                                             |
| P0.2a    | Explicit Change Intent Contracts                       | Shipped in v0.9.0                                                             |
| P0.3     | Worker Continuation                                    | Shipped in v0.9.0; depends on P0.2a                                           |
| P0.4     | Bounded Repair Loop                                    | Shipped in v0.9.0; depends on P0.3 and P0.2a                                  |
| P1.0     | Parent Identity, Billing, and Post-Hoc Cost Foundation | Shipped foundation in v0.9.0; attempt-evidence hardening complete, unreleased |
| P1.1     | Reasoned Retry and Effort Escalation                   | Complete, unreleased; built on P0.4 and completed P1.0 hardening              |
| P1.2     | Adaptive Worker Routing and Compute Policy             | In Progress (preflight slice); full policy depends on P1.1                    |
| P1.3     | Automatic Context Lifecycle Management                 | Depends on P0.1, P0.2, and P0.3                                               |
| P2.1     | Optional Explorer                                      | Depends on P1.2                                                               |
| P2.2     | Lightweight Cross-Session Handoff                      | Depends on P1.3                                                               |
| P2.3     | End-to-End Automated Workflow                          | Depends on P1.2, P1.3, P2.1, and P2.2                                         |
| P2.4     | Mature Benchmark and Acceptance Pass                   | Depends on P2.3                                                               |

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
  without inventing estimates. The newer attempt-evidence hardening is complete
  but not yet released; it adds immutable per-execution lineage, factual
  termination and timing, authoritative-or-unavailable usage, and retained
  post-start failure evidence as inputs for later P1.1 decisions.
- **Thin Supervisor.** A supporting architectural milestone shipped in v0.10.0.

See the implementation, tests, [`SOL_RULES.md`](SOL_RULES.md),
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md), and
[`CHANGELOG.md`](CHANGELOG.md) for current semantics and release history.

## P1.1 Reasoned Retry and Effort Escalation

**Complete, unreleased.**

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

**In Progress.** Separate user-owned compute policy from supervisor routing. A
future policy will authorize worker models, effort ceilings, concurrency, and
cross-model escalation; the runtime must enforce it rather than relying on
prompts. Routing may choose solo, a worker, a batch, continuation, repair,
retry, an authorised stronger executor, or parent takeover, based on evidence
and within that envelope.

Two slices are now implemented:

1. **Cheap Routing Eligibility / Preflight**: Deterministic eligibility
   is separated from expensive architecture: a pure synchronous evaluator decides
   obvious solo cases from a small declared card before any repository exploration,
   worktree, thread, or worker exists.
2. **User-Owned Compute Policy and Runtime Enforcement**: A canonical policy
   envelope names the authorised worker model, the permitted effort levels, the
   concurrency and worker-count limits, and whether effort escalation or a
   stronger-executor fallback may be recommended. The baseline is operator-owned,
   read from the environment and bounded by the runtime's own ceilings; a call
   may narrow it and can never widen it. Enforcement is at admission for model,
   effort, and worker count; on the resolved envelope for concurrency, across
   both the initial worker window and the bounded recovery pass; and on the
   failure ladder, which a narrowed envelope can only shorten toward parent
   takeover. Each batch records the envelope it ran under.
3. **Adaptive Route Planning**: The same cheap preflight now also recommends one
   bounded execution shape for work the parent has already declared: solo versus
   delegate, the mechanism (single, sequential, parallel), a conservative starting
   effort, and the worker and concurrency counts the active compute policy
   permits. The shape follows the route — a `solo` route yields the `solo`
   mechanism and zero workers — and sequential versus parallel is decided from
   cautiously resolved values, so an undeclared hazard is staggered rather than
   raced. It stays advisory, refuses nothing, expands no permission, and the
   evaluator still reaches nothing outside its arguments: the envelope is passed
   in, and the policy module is not imported.

Future P1.2 work still includes:

- decomposition/seam decisions
- authorised worker/model selection
- effort selection from execution evidence rather than a declared seam size
- recording the recommended shape in routing telemetry
- full adaptive routing algorithm

**Constraints.** The supervisor cannot expand permissions. Routing must preserve
scope, isolation, independent verification, evidence handling, bounded retries,
and conservative concurrency; no model hierarchy is assumed. Cost is quantitative
only when applicable billing evidence is known; otherwise it remains qualitative.

**Not decided.** Policy storage and CLI shape, how effective policy reaches the
supervisor, routing rules, and representation of uncertain cost. Full policy
depends on P1.0 hardening and P1.1.

## P1.3 Automatic Context Lifecycle Management

Compact repeated tool output, logs, worker turns, and stale context at safe
handoff, continuation, repair, retry, and review boundaries while retaining
requirements, decisions, constraints, and verification evidence.

**Constraints.** Compaction must be bounded and observable and must not discard
acceptance criteria, failure or conflict evidence, scope, or the distinction
between claimed and verified results. Trigger thresholds, retention rules, and
reliable context-pressure signals remain undecided. Depends on P0.1, P0.2, and
P0.3.

## P2.1 Optional Explorer

Provide an adaptive, bounded, read-only investigation companion for unfamiliar
repositories, dependencies, APIs, or documentation. It returns findings rather
than an unchecked plan, implements nothing, and cannot delegate. Optional and
depends on P1.2.

## P2.2 Lightweight Cross-Session Handoff

Provide optional persistent compact handoff containing the current objective,
completed work, decisions, invariants, remaining work, blockers, verification
state, useful attempts, and eligible continuation references. Keep state small,
opt-in, and free of automatic Git commits or pushes. Format, location, retention,
and reference-expiry handling remain undecided. Depends on P1.3.

## P2.3 End-to-End Automated Workflow

Compose the bounded primitives into an adaptive capstone: routing, optional
exploration, continuation, evidence-driven repair, classified retry, authorised
fallback, parent takeover, context lifecycle management, safe integration, and
optional handoff.

**Constraints.** Build this only after the constituent guardrails stabilize. Solo
execution, bounded contracts, independent verification, isolated worktrees, and
supervisor control remain valid; no monolithic first implementation is implied.
Depends on P1.2, P1.3, P2.1, and P2.2.

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
