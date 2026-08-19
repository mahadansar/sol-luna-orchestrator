# Roadmap

Where Sol-Luna is going, in priority order, with the dependencies between items
made explicit. Everything here is future work. Nothing on this page ships today;
[`CHANGELOG.md`](CHANGELOG.md) is the record of what actually exists.

## Direction

The project optimises for:

- **Adaptive delegation.** The supervisor decides whether handing work off is
  worth it. Zero workers is a valid and often correct outcome.
- **Context efficiency.** A worker should receive the minimum it needs to do the
  job, and the supervisor the minimum it needs to judge the result.
- **Bounded orchestration.** Every delegated unit has a declared scope, a
  verification step and an end.
- **Independent verification.** A worker's claim is evidence, not a conclusion.
- **Observability.** What happened should be inspectable after the fact.
- **Conservative failure handling.** When something is ambiguous, return to the
  supervisor rather than guessing.
- **Reproducible evidence.** Claims in this repository are backed by committed
  raw results.

It does not optimise for the number of agents running, for delegating whenever
delegation is possible, for fixed workflow routes a user has to choose between,
or for taking Git actions on the user's behalf.

## Priorities at a glance

| Priority | Item                                 | Depends on         |
| -------- | ------------------------------------ | ------------------ |
| P0.1     | Context Capsule v2                   | nothing            |
| P0.2     | Compact Evidence Packets             | P0.1               |
| P0.3     | Worker Continuation                  | P0.2               |
| P0.4     | Bounded Repair Loop                  | P0.3               |
| P1.1     | Reasoned Retry and Effort Escalation | P0.4               |
| P1.2     | Optional Stronger-Worker Fallback    | P1.1               |
| P2.1     | Optional Explorer                    | mostly independent |
| P2.2     | Cross-Session Handoff                | mostly independent |

```
Context Capsule v2
        |
        v
Compact Evidence Packets
        |
        v
Worker Continuation
        |
        v
Bounded Repair Loop
        |
        v
Reasoned Retry / Effort Escalation
        |
        v
Optional Stronger-Worker Fallback

Explorer ................ later, mostly independent
Cross-session handoff ... later, mostly independent
```

The chain matters. A stronger-worker fallback built before continuation and
repair exist would be a blunt "spend more on failure" mechanism, which is the
opposite of the intent. Start at the top.

---

## P0.1 Context Capsule v2

**Problem.** A worker receives an objective, a declared scope, acceptance
criteria and verification commands. That is enough to act, but it leaves the
worker rediscovering context the supervisor already had: which interfaces it
must not break, which decisions upstream are already settled, which pitfalls
were hit last time.

**Direction.** A richer structured work package, assembled by the supervisor.
Candidate fields include relevant context, interfaces, dependencies, invariants,
upstream decisions, known pitfalls and previous attempts, alongside the existing
contract.

**Constraints.**

- Backward compatible. Existing callers keep working.
- Fields are optional. Nothing should force a caller to fill in a form.
- The supervisor supplies the minimum relevant context, not a transcript dump.
  Copying the whole session into every worker would defeat the purpose.

**Not decided.** The final field set and its schema. That gets settled by
implementing it and seeing which fields workers actually use.

## P0.2 Compact Evidence Packets

**Problem.** Reviewing a delegated result costs the supervisor a lot of context.
The evidence it needs to make a decision is smaller than the evidence it
receives.

**Direction.** Return a compact, decision-relevant packet: verdict, changed
files, acceptance result, verification result, scope result, conflicts and
discrepancies, risk or contract-change signals, and the worker's own summary,
with a reference to fuller evidence when deeper review is warranted.

**Constraints.**

- This must not become "trust the worker's summary". Orchestrator-derived
  verification and scope results stay authoritative; the worker's summary is one
  field among them, labelled as the claim it is.
- Full diffs and full command output stay reachable. When risk signals or
  discrepancies appear, the supervisor needs to be able to look properly.

**Depends on** P0.1: what is worth summarising depends on what the worker was
given.

## P0.3 Worker Continuation

**Problem.** Every delegation starts a fresh worker with an empty context
window. A small follow-up on work that just finished pays full setup cost and
discards everything the worker learned.

**Direction.** Allow a bounded follow-up turn to resume the same Luna thread.

**Constraints.**

- The declared scope carries over. A continuation cannot widen its own scope.
- Supervision is unchanged: the supervisor still decides and still reviews.
- No recursive delegation. A resumed worker has no delegation tools, exactly as
  a fresh one does not.
- Verification and scope validation run again on the continued result.
- Continuations are bounded, and the bound is small.

**Not decided.** How a thread reference is surfaced, and how long it stays
resumable.

## P0.4 Bounded Repair Loop

**Problem.** When independent verification catches a small local defect, the
current answer is to return to the supervisor, which writes a new contract for a
new worker. For a failing assertion in code that was just written, that is a lot
of ceremony.

**Direction.** When verification finds a routine, locally repairable defect,
optionally resume the same worker with the exact failure evidence, then verify
again.

**Constraints.**

- One automatic repair turn to begin with. No unbounded loops.
- Only failures classified as locally repairable qualify.
- Everything else returns to the supervisor: bad decomposition, scope
  violations, ambiguous requirements, environment and tooling failures, and
  anything touching the security boundary.
- A repair turn is visible in the event stream like any other work.

**Depends on** P0.3.

---

## P1.1 Reasoned Retry and Effort Escalation

**Problem.** Current guidance is that a genuine difficulty failure should be
retried at higher effort. That is right as far as it goes, but "it failed, so
think harder" is the wrong response to most failures.

**Direction.** Classify the failure, then choose the response.

| Failure looks like                    | Response                     |
| ------------------------------------- | ---------------------------- |
| Routine implementation defect         | Same worker, same effort     |
| Genuine reasoning deficiency          | Consider higher Luna effort  |
| Bad decomposition, scope or ambiguity | Return to the supervisor     |
| Environment or tooling failure        | Do not spend reasoning on it |

`previousAttempts` and the failure evidence should drive this rather than a
counter.

**Constraints.** Classification has to be conservative. Misreading a
specification problem as a difficulty problem burns tokens and still fails.

**Not decided.** The classification rules, and whether escalation is automatic
or a recommendation the supervisor acts on.

**Depends on** P0.4.

## P1.2 Optional Stronger-Worker Fallback

**Problem.** Some tasks are genuinely beyond the worker model at any effort.
Once bounded repair and escalation are exhausted, there is nowhere to go.

**Direction.** One configurable stronger fallback worker, tried at most once,
after the earlier steps.

**Constraints.**

- Conservative. Off or opt-in initially.
- At most one stronger fallback per task.
- Configured as a model choice, not as a new permanent named role in the
  architecture.
- No promises about any specific future model. What is available is whatever the
  runtime can actually reach.

**Depends on** P1.1. Built first, it would reach for an expensive model on
failures a repair turn would have fixed.

---

## P2.1 Optional Explorer

**Problem.** Some work needs reconnaissance before it can be specified: an
unfamiliar dependency, an external API, a subsystem nobody has read recently.
Specifying that work well is the hard part, and it is the supervisor doing it.

**Direction.** A bounded, read-only investigation worker returning a compact
research packet.

**Constraints.**

- Optional, and not worth running for ordinary work.
- Read-only. It implements nothing.
- No recursive delegation.
- Returns findings, not a plan to be followed blindly.

## P2.2 Lightweight Cross-Session Handoff

**Problem.** Work spanning sessions starts over. The supervisor's understanding
does not survive the session that produced it.

**Direction.** Optional persistent state capturing only the essentials: current
objective, completed work, key decisions, remaining work, blockers, verification
state, and useful continuation references.

**Constraints.**

- Keep persistent state small and optional. Do not require multiple managed
  state documents by default.
- No automatic Git commits or pushes.
- Opt-in.

**Not decided.** Storage format and location.

---

## Research and platform work

Visible, lower priority, not actively being implemented.

- **Sandboxed verification**, if Codex exposes a mechanism that makes it
  possible. Verification currently runs outside the Codex sandbox with the
  user's permissions, which is the largest trust boundary in the project.
- **Live end-to-end verification on Linux**, beyond the deterministic CI that
  already runs there.
- **Live end-to-end verification on macOS**, likewise.
- **Fixtures larger than one supervisor session.** Every benchmark fixture so
  far fits comfortably in one Sol context, which structurally favours solo
  execution. Larger ones are also where deterministic grading becomes hard, so
  this is a research problem rather than a bigger fixture file.
- **Slow-worker-tail characterisation.** A parallel batch finishes when its
  slowest worker finishes, and the measured spread between median and slowest
  was wide. Two repetitions cannot characterise a tail; more targeted
  repetitions would come before any mitigation work.
- **Supervisor effort comparison.** Whether Medium changes the delegation
  decision relative to High, when it is worth the model usage to find out.

## Not current goals

Deliberate choices, not oversights.

1. **Fixed user-selected orchestration modes.** Sol-Luna should not require the
   user to decide how much orchestration a task needs before the work starts.
   The supervisor's adaptive decision stays central.
2. **Maximising worker count.** More agents are a tool, not the objective. The
   default concurrency stays small on purpose, and the measured evidence does
   not support raising it.
3. **Automatic Git closure.** Nothing commits, pushes or tags because an
   orchestration finished. Integrating changes into the working tree is as far
   as it goes; what happens to them is the user's decision.

## Contributing to the roadmap

If you want to work on one of these, open an issue first describing the approach
you have in mind. The constraints under each item are the parts most likely to
be got wrong, and the "not decided" notes are genuinely open.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup and project
layout.
