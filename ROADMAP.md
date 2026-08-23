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

| Priority | Item                                     | Status / Depends on                              |
| -------- | ---------------------------------------- | ------------------------------------------------ |
| P0.1     | Context Capsule v2                       | Shipped in v0.7.0                                |
| P0.2     | Compact Evidence Packets                 | Shipped in v0.7.0                                |
| P0.2a    | Explicit Change Intent Contracts         | Implemented in the working tree; pending release |
| P0.3     | Worker Continuation                      | Delivered in the working tree; depends on P0.2a  |
| P0.4     | Bounded Repair Loop                      | P0.3, P0.2a                                      |
| P1.0     | Parent Model and Pricing Discovery       | Discovery before P1.2                            |
| P1.1     | Reasoned Retry and Effort Escalation     | P0.4                                             |
| P1.2     | Adaptive Worker Routing + Compute Policy | P1.0, P1.1                                       |
| P1.3     | Automatic Context Lifecycle Management   | P0.1, P0.2, P0.3                                 |
| P2.1     | Optional Explorer                        | P1.2                                             |
| P2.2     | Cross-Session Handoff                    | P1.3                                             |
| P2.3     | End-to-End Automated Workflow            | P1.2, P1.3, P2.1, P2.2                           |
| P2.4     | Mature Benchmark and Acceptance Pass     | P2.3                                             |

```
Context Capsule v2 (shipped in v0.7.0)
        |
        v
Compact Evidence Packets (shipped in v0.7.0)
        |
        v
Explicit Change Intent Contracts
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
        +------------------------------+
                                       |
Parent Model / Pricing Discovery ------+
                                       |
                                       v
                 Adaptive Worker Routing + Compute Policy

Context Capsule v2 + Compact Evidence Packets + Worker Continuation
                                       |
                                       v
                 Automatic Context Lifecycle Management

Explorer ................ later, optional
Cross-session handoff ... later, optional
End-to-end workflow ..... later capstone
Mature acceptance ....... latest, after the capstone
```

The chain matters. Routing work to a stronger or more expensive executor before
continuation, repair, failure classification, and policy discovery exist would
be a blunt "spend more on failure" mechanism, which is the opposite of the
intent. Start at the top; the explorer, handoff, capstone, and acceptance work
build on the resulting primitives.

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

## P0.2a Explicit Change Intent Contracts

**Status.** Implemented in the working tree; pending release. The shipped
version remains recorded in `CHANGELOG.md` until the next release.

**Problem.** A zero-change result can be correct for a read-only investigation,
but the current contract vocabulary does not make the expectation explicit.
That ambiguity makes zero-change classification and repair decisions less safe.

**Delivered.** `changeIntent` is accepted per task by `delegate_task` and every
task in `delegate_tasks`, defaulting to `required` when omitted. The selected
intent is stated distinctly in the worker brief and returned in structured and
readable review evidence. A PASS with no claimed or observed changes is clean
for `forbidden` and `optional`, while `required` retains the prior discrepancy
and scrutiny. Intent is independent of `allowedFiles` and task category.
Runtime-observed edits under `forbidden` are classified as a contract violation
and fail the orchestrator verdict; claimed-only edits retain the existing
claimed-versus-observed reconciliation.

**Constraints.** `allowedFiles: []` means that there is no in-workspace
allowlist; it does not mean the task is read-only. A read-only contract must
say that changes are forbidden, while optional and required changes must remain
distinct. The explicit intent should be available before classifying a
zero-change result or deciding whether a repair turn is appropriate.

**Depends on** P0.2.

## P0.3 Worker Continuation

**Problem.** Every delegation starts a fresh worker with an empty context
window. A small follow-up on work that just finished pays full setup cost and
discards everything the worker learned.

**Delivered.** `continue_task` accepts an opaque in-memory
`continuationReference` plus one explicit follow-up instruction and resumes the
same Luna thread. References are single-use, expire after 15 minutes, and die
with the server process. Eligible single and batch results expose the reference.
Parallel batch results bind to the integrated workspace after safe integration,
or to a retained worktree when integration is disabled or conflicted.

**Constraints.**

- The declared scope carries over. A continuation cannot widen its own scope.
- Supervision is unchanged: the supervisor still decides and still reviews.
- No recursive delegation. A resumed worker has no delegation tools, exactly as
  a fresh one does not.
- Verification, scope validation, evidence reconciliation and verdict
  classification run again on the continued result.
- Continuations are bounded, and the bound is small.

The original objective, `allowedFiles`, `forbiddenFiles`, `changeIntent`,
acceptance criteria and verification commands are preserved exactly. The
continuation API accepts no widening fields, and resumed workers retain both
recursive-delegation guards.

**Depends on** P0.2a and P0.2.

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
- The change-intent contract is checked first: a repair cannot turn a
  forbidden/read-only task into an editing task, and optional versus required
  changes remain distinguishable.

**Depends on** P0.3 and P0.2a.

---

## P1.0 Parent Model and Pricing Discovery

**Problem.** Quantitative cost-aware routing would be unsafe if the
orchestrator cannot reliably identify the selected parent model or cannot tell
which usage schedule applies. API pricing, Codex credits, included usage,
promotions, and legacy schedules are different concepts and may not be
interchangeable.

**Direction.** First investigate and design, without assuming an
implementation, whether Codex or MCP exposes the selected parent model to the
orchestrator and which signal could be relied on. In parallel, map how API
pricing, Codex credits, included usage, promotions, and legacy schedules could
affect a task's quantitative cost, including their scope, time bounds,
entitlements, and uncertainty. Define how a future policy could use those
facts without presenting an estimate as a bill or confusing credits and
included usage with API charges.

**Constraints.** Cost comparisons and cost measurements must only be treated
as quantitative when the applicable pricing or entitlement schedule is
knowable for the work being compared. If the parent-model signal or schedule
is unavailable, stale, ambiguous, promotional, or legacy in a way that cannot
be resolved, future routing should fall back to qualitative policy or leave
cost out rather than inventing precision. This item is discovery and design;
it does not claim that model visibility, pricing lookup, or cost accounting
exists today.

**Not decided.** Whether the selected parent model is exposed, which source is
authoritative for each usage category, how schedule freshness is established,
and the eventual representation of uncertainty.

**Dependency.** This discovery does not depend on implementing repair. It must
finish before P1.2 treats cost as a quantitative routing input.

---

## P1.1 Reasoned Retry and Effort Escalation

**Problem.** Current guidance is that a genuine difficulty failure should be
retried at higher effort. That is right as far as it goes, but "it failed, so
think harder" is the wrong response to most failures.

**Direction.** Classify the failure before deciding whether to repair, retry,
raise effort, select a stronger executor, or take the work back. The initial
classification should cover at least these classes and use the concrete
failure evidence rather than a retry counter:

| Failure class                   | Bounded response                                                          |
| ------------------------------- | ------------------------------------------------------------------------- |
| Contract or requirement failure | Return to the supervisor for a clearer contract                           |
| Implementation failure          | Consider a local repair with the same worker                              |
| Verification failure            | Inspect the failing evidence; repair or retry only if local and justified |
| Timeout failure                 | Assess remaining bounds and retry only if useful                          |
| Environment failure             | Treat tooling or host conditions separately                               |
| Scope or conflict failure       | Stop and return for safe integration or takeover                          |
| Effort failure                  | Consider higher authorized effort                                         |
| Capability failure              | Consider an authorized stronger executor or takeover                      |

The classifier should also distinguish failures that are transient from those
that show the task, contract, or environment is unsuitable for another turn.
It should feed the bounded repair loop, reasoned retry and effort escalation,
generalized stronger-executor fallback, or parent takeover. A failure must not
be retried merely because a counter permits it.

`previousAttempts` and the failure evidence should drive this rather than a
counter.

**Constraints.** Classification has to be conservative. Misreading a
specification problem as a difficulty problem burns tokens and still fails.

**Not decided.** The classification rules, the evidence schema, and which
responses are automatic versus recommendations the supervisor acts on.

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
authorised. A stronger executor after a failure then becomes one routing
decision among several rather than a separate mechanism with its own permanent
role in the architecture. Automatic fallback should be driven by the failure
classification and concrete evidence, and should select from the user-authorized
model pool; it must never hardcode a Luna-to-Sol progression. If no permitted
executor is justified or available, the parent takes over or the task ends.
Which model suits which kind of work is deliberately not settled here. Those
preferences should come from measured results rather than from assumptions
about what each model is presumed to be good at.

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
workers the runtime will reject. A later policy may weigh model, effort,
context pressure, cost, latency, coordination overhead, verification needs,
and risk. Cost is a quantitative input only when P1.0 establishes that the
applicable schedule is knowable; otherwise the policy must keep cost
qualitative or unknown. An illustrative envelope, not a default and not a
configuration that exists today:

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
  model and an effort per task, considering solo, single-worker, sequential,
  parallel, explorer, continuation, repair, retry, stronger-executor, and
  parent-takeover paths. Choosing no worker stays valid.
- **P1.2c, cross-model escalation.** Failure classification first, bounded
  repair and effort changes next, a different permitted model only where the
  evidence justifies it and the user-authorized model pool permits it. The
  fallback remains model-agnostic rather than assuming any particular model
  ordering.

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
- A route may remain solo, may use one worker, or may use sequential or
  parallel workers; adaptive selection is allowed to choose zero workers. An
  explorer, continuation, repair, retry, stronger executor, or parent takeover
  is a bounded option, not a mandatory stage.
- No promises about any specific model. What is routable is whatever the runtime
  can actually reach and the user has actually allowed.

**Not decided.** The policy schema and where it lives, the final CLI syntax, how
the effective policy reaches the supervisor, the routing rules themselves, and
how context pressure and uncertain cost should be represented. Supporting
worker models outside the currently supported runtime may require a
provider/executor abstraction; the design must not assume that swapping a model
identifier is sufficient.

**Depends on** P1.0 and P1.1, and through them on the rest of the P0 chain.
Before choosing a different model is a sensible move, the supervisor needs to
know whether the same worker could simply continue, whether the defect is
locally repairable, whether the failure was reasoning-related at all, whether
more effort would help, whether a cost comparison is valid, and whether the
work should go back to the supervisor instead. Without that, routing
degenerates into spending more on every failure, which is the outcome the
compute policy exists to prevent.

---

## P1.3 Automatic Context Lifecycle Management

**Problem.** Context Capsules and Compact Evidence Packets reduce redundant
input and review output at individual boundaries, but a long adaptive run can
still accumulate repeated tool output, logs, worker turns, and stale context.
That pressure can obscure important requirements, decisions, and evidence.

**Direction.** Build automatic, bounded context lifecycle management on P0.1
Context Capsules and P0.2 Compact Evidence Packets. At appropriate handoff,
continuation, repair, retry, and review boundaries, preserve important
requirements, settled decisions, scope and safety constraints, and verification
evidence while compacting or removing redundant tool, log, and context noise.
The resulting context should remain sufficient for the supervisor and any
resumed worker to make the next bounded decision.

**Constraints.** Compaction must not silently discard acceptance criteria,
upstream decisions, failure evidence, scope or conflict information, or the
distinction between verified and claimed results. It should be automatic where
safe, bounded in work and output, and observable enough to explain what was
retained or omitted. This is lifecycle management, not permission to widen a
contract or to turn an evidence packet into an unchecked summary.

**Not decided.** Trigger thresholds, retention rules, whether compacted
material is represented as an updated capsule, packet, or another internal
form, and what reliable context-pressure signal Codex or the host actually
exposes. If exact context usage is unavailable, the design should use bounded,
observable proxies rather than pretend to have precise context-window
awareness.

**Depends on** P0.1, P0.2, and P0.3.

---

## P2.1 Optional Explorer

**Problem.** Some work needs reconnaissance before it can be specified: an
unfamiliar dependency, an external API, a subsystem nobody has read recently.
Specifying that work well is the hard part, and it is the supervisor doing it.

**Direction.** A bounded, read-only Explorer / Investigation Companion for
repository, research, dependency, or documentation investigation, returning a
compact research packet. It should be available as an adaptive option when
reconnaissance is useful, not a permanent role or a mandatory stage in every
workflow.

**Constraints.**

- Optional, and not worth running for ordinary work.
- Read-only. It implements nothing.
- No recursive delegation.
- Returns findings, not a plan to be followed blindly.

**Depends on** P1.2, while remaining optional at task time.

## P2.2 Lightweight Cross-Session Handoff

**Problem.** Work spanning sessions starts over. The supervisor's understanding
does not survive the session that produced it.

**Direction.** Optional persistent compact handoff for a fresh Codex session,
capturing only the essentials: current objective, completed work, key
decisions, settled invariants, remaining work, blockers, verification state,
useful failure and attempt evidence, and useful continuation references. It
should let a new supervisor session resume with the important context without
retaining the entire prior transcript.

**Constraints.**

- Keep persistent state small and optional. Do not require multiple managed
  state documents by default.
- No automatic Git commits or pushes.
- Opt-in. Once enabled, checkpoint creation and update, and consumption by a
  fresh session, should happen automatically at appropriate safe boundaries.

**Not decided.** The exact persistence format, storage location, retention
policy, and how continuation references expire.

**Depends on** P1.3, while remaining optional at task time.

## P2.3 End-to-End Automated Workflow

**Problem.** A complete automated workflow is attractive, but implementing it
as one monolithic feature would couple routing, investigation, continuation,
repair, verification, integration, and handoff before those primitives are
well understood.

**Direction.** Later, build an end-to-end capstone from the bounded primitives:
adaptive routing, optional exploration, worker continuation, evidence-driven
repair, classified retry and effort escalation, authorized stronger-executor
fallback, parent takeover, context lifecycle management, safe integration, and
optional cross-session handoff. The capstone should compose those capabilities
and retain supervisor control without imposing a fixed worker-model hierarchy
or replacing it with a fixed workflow.

**Constraints.** This remains future work after the constituent primitives and
their guardrails have been validated. A zero-worker solo route, bounded
contracts, independent verification and evidence, isolated worktrees, and safe
integration remain valid within the capstone. No monolithic first
implementation is implied.

**Depends on** P1.2, P1.3, P2.1, and P2.2.

## P2.4 Mature Benchmark and Acceptance Pass

**Problem.** Individual features can pass focused checks while the adaptive
system still makes poor decisions across task shapes and failure paths.

**Direction.** After the capstone's primitives have stabilized, run a mature
benchmark and acceptance pass that retests solo, delegated, repair, stronger
executor fallback, explorer, continuation, and free-choice adaptive modes.
Measure quality, latency, context and token use, routing decisions, retries,
and cost where the applicable pricing or entitlement schedule is knowable and
calculable correctly. Report unknown or incomparable cost rather than filling
the gap with an estimate.

**Constraints.** The pass should test zero-worker outcomes as valid, cover
bounded failure handling and parent takeover, and preserve evidence for its
claims. Cost results must identify whether they concern API pricing, Codex
credits, included usage, promotions, or legacy schedules; they must not mix
those categories or imply a quantitative comparison when the schedule is
uncertain.

**Depends on** P2.3 and the completed routing, context, and handoff
primitives.

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
