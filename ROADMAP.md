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

## Priorities at a glance

| Priority | Item                                                   | Status / dependency                          |
| -------- | ------------------------------------------------------ | -------------------------------------------- |
| P0       | Context Capsule v2; Compact Evidence Packets           | Shipped in v0.7.0                            |
| P0.2a    | Explicit Change Intent Contracts                       | Shipped in v0.9.0                            |
| P0.3     | Worker Continuation                                    | Shipped in v0.9.0; depends on P0.2a          |
| P0.4     | Bounded Repair Loop                                    | Shipped in v0.9.0; depends on P0.3 and P0.2a |
| P1.0     | Parent Identity, Billing, and Post-Hoc Cost Foundation | Shipped in v0.9.0                            |
| P1.1     | Reasoned Retry and Effort Escalation                   | Depends on P0.4                              |
| P1.2a    | Cheap Routing Eligibility / Preflight                  | Shipped unreleased                           |
| P1.2     | Adaptive Worker Routing and Compute Policy             | Depends on P1.0 and P1.1                     |
| P1.3     | Automatic Context Lifecycle Management                 | Depends on P0.1, P0.2, and P0.3              |
| P2.1     | Optional Explorer                                      | Depends on P1.2                              |
| P2.2     | Lightweight Cross-Session Handoff                      | Depends on P1.3                              |
| P2.3     | End-to-End Automated Workflow                          | Depends on P1.2, P1.3, P2.1, and P2.2        |
| P2.4     | Mature Benchmark and Acceptance Pass                   | Depends on P2.3                              |

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
- **Parent Identity, Billing, and Post-Hoc Cost Foundation (P1.0).** The runtime
  keeps identity and billing evidence explicit and does not invent estimates.

See the implementation, tests, [`SOL_RULES.md`](SOL_RULES.md),
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md), and
[`CHANGELOG.md`](CHANGELOG.md) for current semantics and release history.

## P1.1 Reasoned Retry and Effort Escalation

Classify concrete failure evidence before choosing repair, retry, higher effort,
a stronger authorised executor, or parent takeover. The classifier must
distinguish contract, implementation, verification, timeout, environment,
scope/conflict, effort, and capability failures, and must not retry merely because
a counter permits it.

**Constraints.** Keep classification conservative; specification and environment
failures should return to the supervisor rather than burn another worker turn.

**Not decided.** The derived classifier schema and which responses are automatic
versus recommendations. Depends on P0.4.

## P1.2a Cheap Routing Eligibility / Preflight

**Shipped (unreleased).** Deterministic eligibility is now separated from
expensive architecture: a pure synchronous evaluator decides obvious solo cases
from a small declared card before any repository exploration, worktree, thread,
or worker exists. Raw declarations feed a few structural gates; conservatively
resolved values feed advice only. Uncertainty biases advice toward solo and can
never refuse.

This is deliberately _not_ P1.2. It owns no compute policy: it reads no effort,
recommends no worker count, and changes no concurrency. `parallelEligible` is a
structural boolean, not a plan. Routing rules are declaration-driven and carry no
score, threshold, or benchmark-derived tuning, and the V3 routing holdout remains
isolated from runtime logic.

**Not decided.** Whether observed-versus-declared contradictions should ever
become enforcement rather than telemetry, and whether the card should later carry
anything the parent does not already know.

## P1.2 Adaptive Worker Routing and Compute Policy

Separate user-owned compute policy from supervisor routing. A future policy will
authorize worker models, effort ceilings, concurrency, and cross-model escalation;
the runtime must enforce it rather than relying on prompts. Routing may choose
solo, a worker, a batch, continuation, repair, retry, an authorised stronger
executor, or parent takeover, based on evidence and within that envelope.

**Constraints.** The supervisor cannot expand permissions. Routing must preserve
scope, isolation, independent verification, evidence handling, bounded retries,
and conservative concurrency; no model hierarchy is assumed. Cost is quantitative
only when applicable billing evidence is known; otherwise it remains qualitative.

**Not decided.** Policy storage and CLI shape, how effective policy reaches the
supervisor, routing rules, and representation of uncertain cost. Depends on P1.0,
P1.1, and the preceding P0 chain. The cheap preflight in P1.2a is a deliberate
subset: it decides eligibility, never policy.

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
