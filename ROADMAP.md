# Roadmap

Where Sol-Luna is going, in priority order, with the dependencies between items
made explicit. [`CHANGELOG.md`](CHANGELOG.md) is the record of what actually exists.

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

| Priority | Item                                     | Status / Depends on |
| -------- | ---------------------------------------- | ------------------- |
| P0.1     | Context Capsule v2                       | Shipped in v0.7.0   |
| P0.2     | Compact Evidence Packets                 | Shipped in v0.7.0   |
| P0.3     | Worker Continuation                      | P0.2                |
| P0.4     | Bounded Repair Loop                      | P0.3                |
| P1.1     | Reasoned Retry and Effort Escalation     | P0.4                |
| P1.2     | Adaptive Worker Routing + Compute Policy | P1.1                |
| P2.1     | Optional Explorer                        | mostly independent  |
| P2.2     | Cross-Session Handoff                    | mostly independent  |

```
Context Capsule v2 (shipped in v0.7.0)
        |
        v
Compact Evidence Packets (shipped in v0.7.0)
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
Adaptive Worker Routing + Compute Policy

Explorer ................ later, mostly independent
Cross-session handoff ... later, mostly independent
```

The chain matters. Routing work to a more expensive worker before continuation
and repair exist would be a blunt "spend more on failure" mechanism, which is
the opposite of the intent. Start at the top.

---

## P0.1 Context Capsule v2

**Status.** Shipped in v0.7.0.

**Problem.** A worker receives an objective, a declared scope, acceptance
criteria and verification commands. That is enough to act, but it leaves the
worker rediscovering context the supervisor already had: which interfaces it
must not break, which decisions upstream are already settled, which pitfalls
were hit last time.

**Delivered.** A richer structured work package (`contextCapsule`), assembled by
the supervisor, containing optional fields: `relevantContext`, `interfaces`,
`dependencies`, `invariants`, `upstreamDecisions`, and `knownPitfalls`. Empty
fields are omitted from the worker prompt, and existing task contracts remain
fully compatible.

## P0.2 Compact Evidence Packets

**Status.** Shipped in v0.7.0.

**Problem.** Reviewing a delegated result costs the supervisor a lot of context.
The evidence it needs to make a decision is smaller than the evidence it
receives.

**Delivered.** Optional `resultDetail: "compact"` on `delegate_task` and
`delegate_tasks`. It drops the stdout/stderr of passing verification commands
from `structuredContent`, preserving verdicts, changed files, scope violations,
discrepancies, failing command outputs, and the unchanged readable text result.
The default remains `"full"` for compatibility.

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

## P1.2 Adaptive Worker Routing + Compute Policy

**Problem.** Once the supervisor can classify a failure and reason about repair
and escalation, routing every delegated task to the same worker model becomes
unnecessarily restrictive. Different bounded tasks may suit different available
worker models, while reasoning effort remains an independent per-task decision.

Letting the supervisor choose without limits would be worse than the
restriction. Model and effort choices are spending decisions, and orchestration
must not silently expand beyond the compute envelope the user has explicitly
authorised. A user may intentionally allow inexpensive workers while reserving
stronger models or higher effort for exceptional cases. The orchestrator must
respect that boundary.

**Direction.** Two separable pieces. The user controls the compute envelope, the
supervisor chooses a strategy inside it, and the runtime enforces the boundary
between the two.

The routing half. The supervisor may eventually choose, per bounded task, no
worker at all, Luna, Terra, a Sol worker, or another supported model, and
independently choose a reasoning effort, selecting only from what the user has
authorised. A stronger worker after repeated failure then becomes one routing
decision among several rather than a separate mechanism with its own permanent
role in the architecture. Which model suits which kind of work is deliberately
not settled here. Those preferences should come from measured results rather
than from assumptions about what each model is presumed to be good at.

The policy half. A user-owned compute policy covering which worker models are
allowed, a maximum reasoning effort per model, a maximum number of concurrent
workers per model, a global concurrency ceiling, and whether cross-model
escalation is permitted at all. Defaults should be conservative: Luna enabled,
other worker models disabled, cross-model escalation disabled, and concurrency
no higher than the current bounded behaviour, so that a fresh install behaves
the way Sol-Luna behaves today. The envelope is whatever the user has set,
never something inferred from how the supervisor itself happens to be running.
None of that configuration exists yet.

Editing it should not mean hand-writing TOML. The intended shape is a small CLI
surface, roughly `sol-luna-orchestrator policy` to change the envelope and
`sol-luna-orchestrator policy --show` to inspect it, covering the obvious
operations: enable or disable a worker model, set an effort ceiling, set
concurrency limits, allow or disallow cross-model escalation, and reset to the
conservative defaults. Configuration files stay the interface underneath for
anyone who prefers them.

The supervisor should also be told the effective policy before it routes
anything, so that it reasons inside the real envelope instead of proposing
workers the runtime will reject. An illustrative envelope, not a default and not
a configuration that exists today:

```text
Allowed:
  Luna up to XHigh
  Sol up to High, max 1
  3 workers in total

Not allowed:
  Terra
  Sol above High
```

A likely build order, though not a commitment:

- **P1.2a, the policy foundation.** Allowed models, effort ceilings,
  concurrency ceilings, inspection, and enforcement in the runtime.
- **P1.2b, adaptive routing.** The supervisor sees the policy and chooses a
  model and an effort per task. Choosing no worker stays valid.
- **P1.2c, cross-model escalation.** Failure classification first, bounded
  repair and effort changes next, a different permitted model only where the
  evidence justifies it.

The guardrails come before the routing freedom, not after it.

**Constraints.**

- The supervisor cannot expand its own permissions. It cannot enable a worker
  model, raise an effort ceiling, raise a concurrency ceiling or turn escalation
  on. It may recommend one, for instance that a stronger worker looks likely to
  help but the current compute policy does not permit it. Acting on that
  recommendation is the user's decision, and until the user makes it the runtime
  refuses the request.
- Enforcement lives in the runtime, not in the prompt. A policy that holds only
  while the supervisor chooses to respect it is not a policy.
- Routing changes who does the work and nothing else. Declared scope, worktree
  isolation, independent verification, evidence handling, bounded retries,
  conservative concurrency and the activity stream behave exactly as they do for
  a single-model batch.
- No promises about any specific model. What is routable is whatever the runtime
  can actually reach and the user has actually allowed.

**Not decided.** The policy schema and where it lives, the final CLI syntax, how
the effective policy reaches the supervisor, and the routing rules themselves.

**Depends on** P1.1, and through it on the rest of the P0 chain. Before choosing
a different model is a sensible move, the supervisor needs to know whether the
same worker could simply continue, whether the defect is locally repairable,
whether the failure was reasoning-related at all, whether more effort would
help, and whether the work should go back to the supervisor instead. Without
that, routing degenerates into spending more on every failure, which is the
outcome the compute policy exists to prevent.

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
