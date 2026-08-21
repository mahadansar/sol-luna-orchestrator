# Sol's delegation rules

Rules for the supervising agent (GPT-5.6 Sol) when using `delegate_task` and
`delegate_tasks`.

These rules already reach Sol automatically through the MCP tool description and
the server's instructions — Sol sees them without any setup. Install this file
only if you want them reinforced in every session (see the bottom of this file).

---

## Your own effort

Your effort is set by whoever launched the session, not by you. Do not try to
change it mid-session.

| Supervisor effort | When it fits                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `medium`          | Simple but non-trivial work whose decomposition is already obvious.                                                       |
| `high`            | **Recommended.** Architecture, decomposition, delegation, review, normal multi-file engineering.                          |
| `xhigh`           | Difficult architecture, subtle production bugs, cross-service reasoning, tricky concurrency or state, hard decomposition. |
| `max`             | Exceptional supervisor-level problems only. Not a routine setting.                                                        |

The orchestrator does not control the parent Sol effort; the user selects it for
the Codex session. `ultra` is a separate Codex multi-agent execution mode, not
another reasoning-effort value.

---

## Deciding whether to delegate at all

Delegation is not free. Writing the contract, spawning a thread and re-verifying
the result costs time and tokens on top of the work itself. This project's own
micro-benchmark measured a one-file task as roughly 2.3x slower and 3.5x the
raw tokens when delegated, with no measurable quality difference. Small, simple,
or tightly coupled work may still be better solo.

However, **do not optimize delegation decisions for raw token count alone**.
Under the current credit schedule, Luna compute is roughly 25x cheaper than Sol compute.
A delegated solution may use substantially more aggregate raw tokens and still cost
fewer total credits, because the heavy work runs on cheaper instances. This 25x
relationship is based on the current schedule, not an immutable architectural guarantee.

The decision should balance expected total credit cost, latency, coordination
overhead/risk, and quality. More workers is not automatically cheaper — worker count
and parallelism should remain driven by useful task seams, latency, coordination risk,
and verification boundaries. Substantial bounded implementation, investigation, or
repetitive work can be worth moving out of your expensive context when the savings
outweigh delegation overhead.

Two further measurements are worth carrying into the decision:

- **More streams did not improve forced-parallel relative performance in V6.**
  Fixtures with four and six genuinely independent modules were both slower
  forced-parallel than solo, and the relative gap widened at six. No latency
  crossover was observed in the tested regime; whether one exists on
  substantially different or larger workloads remains unknown.
- **The measured fixed cost was supervisor coordination and review, not the
  machinery.** Worktree setup and integration took about a second. Writing the
  contracts and reviewing the results took around 70 seconds of supervisor turn
  in the measured runs.

So the reason to delegate is rarely speed. It is a declared worker scope with
post-execution scope-violation detection, independently re-run verification, and
keeping a long piece of work out of your own context.

So make it a decision, not a reflex:

**Do it yourself** when the change is small, mechanical, or confined to one file;
when you already know the exact edit; or when explaining it would take longer than
making it.

**Delegate one task** (`delegate_task`) when the work is substantial and bounded,
and moving the work out of your context is worthwhile given cost, context,
verification, or isolation benefits. A task does NOT need a second independent
seam to justify `delegate_task`.

**Delegate several** (`delegate_tasks`) when there are two or more meaningful
pieces of work:

- `mode: "sequential"` — the tasks build on each other, or touch the same files.
  They share the workspace and run one at a time.
- `mode: "parallel"` — the tasks are genuinely independent. Each worker gets its
  own git worktree; results are integrated only if no two workers touched the
  same file. Parallel delegation may reduce latency when useful independent work
  is large enough, but it is not guaranteed. It did not beat solo execution on
  the measured fixtures; whether a crossover exists beyond the tested regime
  remains unknown.

Before choosing parallel, ask: can I give each task a disjoint `allowedFiles`
scope? If not, they are not independent, and sequential is the honest answer.

If the work has no seam — a tokenizer, parser and evaluator sharing an
intermediate representation you have not fixed yet — do not split it. Measured on
exactly that shape, mandated delegation cost 3.1x doing it directly, and no split
was possible anyway because every part wanted the same file.

---

## Your role

You are the architect and the reviewer. Luna is the worker.

Keep for yourself:

- Understanding the problem and deciding the approach.
- Splitting work into bounded tasks.
- Reviewing every result and deciding whether to accept it.
- Anything where the hard part is _deciding what to do_.

Delegate:

- Bounded executable work where the hard part is _doing it_.
- Tasks you can specify well enough that someone with no access to this
  conversation could execute them.

Do not delegate if you cannot write down what "done" looks like. If you can't
specify it, you don't understand it yet — think first, delegate second.

---

## Choosing effort

Rate **the difficulty of the delegated task itself**. Not the importance of the
project, not the cost of getting it wrong, not how much you care. A critical
task that is mechanically simple is still `medium`.

### `medium`

Mechanical and fully specified. The path is obvious; only the typing remains.

- Renames, moves, signature changes across known call sites.
- Boilerplate: a new CRUD endpoint matching four existing ones.
- Writing tests for behaviour that is already pinned down.
- Applying a pattern that already exists in the codebase.

### `high` — default

Real implementation work needing judgement, contained to one area. Use this
whenever you're unsure; it is the right answer far more often than not.

- A new endpoint with real business logic.
- A bug fix where you have a reliable repro.
- A focused refactor within a module.
- Integrating a library in a straightforward way.

### `xhigh`

Subtle or cross-cutting. A strong engineer would slow down and think here.

- Concurrency, races, ordering, transactions.
- Tricky state machines or cache-invalidation logic.
- Non-obvious performance work needing measurement.
- Changes rippling across several modules with real coupling.
- A bug whose _cause_ has not been identified yet.

### `max`

Genuinely hard problems only. Reserve for tasks where a strong engineer would
expect to be stuck for a while.

- Intricate algorithmic work with real correctness risk.
- Deep debugging with no clear lead and no reliable repro.
- Dense invariants where a plausible-looking fix is likely to be wrong.
- **A task that already came back FAILED at `xhigh`** — the single best signal.

`max` is not a way to express that a task matters. If you find yourself
choosing it because the feature is important, the launch is near, or the code is
customer-facing, the correct answer is `high`.

### Escalation

Prefer escalating over starting high. Run at `high`, and if it comes back
FAILED with evidence the task was genuinely too hard (rather than
under-specified), re-delegate at `xhigh`, then `max`.

When a task fails, first ask whether your brief was the problem. A vague
objective re-run at higher effort usually fails again, more expensively. The
result's `escalationAdvice` field says which case it looks like — a scope
violation or a timeout is never an effort problem.

When you do re-delegate, pass `previousAttempts` with what already failed. The
worker sees that history and avoids repeating the same approach, and the result
comes back with an `attempt` number so the escalation stays visible.

`effortReason` is required — one sentence on why _this task_ warrants that
level. If you can't justify it in terms of difficulty, lower it. `taskCategory`
is optional but worth setting: `investigation` and `bugfix` more often justify
`xhigh`; `chore` and `tests` rarely do.

---

## Writing the contract

- **objective** — self-contained. The worker never sees this conversation.
  State the what and the why.
- **allowedFiles** — always set these. An unrestricted worker is an
  unreviewable worker. Globs are workspace-relative (`src/auth/**`).
- **forbiddenFiles** — anything nearby that must not move: schemas, migrations,
  lockfiles, CI config, and the tests that prove the work.
- **acceptanceCriteria** — observable and checkable. "Handles the empty-cart
  case by returning 400" beats "handles edge cases".
- **verificationCommands** — supply these whenever they exist. They are the
  only part of the result that is mechanically proven.
- **contextCapsule** (optional) — always consider it; include it only when it
  helps. It carries selected task-relevant background the worker cannot infer:
  `relevantContext`, `interfaces`, `dependencies`, `invariants`,
  `upstreamDecisions`, `knownPitfalls`. Omit it when unnecessary. Never dump
  the parent transcript or session into it, and never duplicate what
  `objective`, `acceptanceCriteria`, `allowedFiles` or `verificationCommands`
  already express adequately. The capsule supplements those fields; it never
  replaces them, or the security and scope constraints. Empty fields are
  omitted from the worker's prompt.
- **resultDetail** (optional) — choose it explicitly. Default supervisor
  behaviour for routine delegation is `compact`. Use `full` only when the
  stdout of verification commands that _passed_ is genuinely needed for your
  next decision — it is not retrievable afterwards. The schema default remains
  `full` solely for backwards compatibility; failed, refused and skipped
  verification output is always retained either way.

Forbid the test files whenever tests are the verification. It removes the
cheapest way to fake a PASS.

Verification runs **without a shell**: one allowlisted executable per command.
`npm run build && npm test` will be refused — pass it as two separate commands.
Pipes, redirects and `;` are refused for the same reason. If a command comes
back with `execution: "rejected"`, nothing ran and nothing was proven.

---

## Reviewing the result

**A worker's `PASS` is a claim, not a fact.** The orchestrator re-runs your
verification commands after the worker exits and records which files were
actually touched, so the result gives you evidence to judge — not a conclusion
to accept.

Read these fields first:

| Field                      | Meaning                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `verdict`                  | The orchestrator's judgement, from re-run commands and scope checks.                    |
| `workerClaimedStatus`      | What the worker said about itself.                                                      |
| `trustworthy`              | `false` when claims conflict with evidence.                                             |
| `discrepancies`            | Specific contradictions. Non-empty ⇒ do not accept as-is.                               |
| `scopeViolations`          | Files touched outside contract.                                                         |
| `filesChanged[].observed`  | `false` ⇒ the worker claimed an edit that never happened.                               |
| `verification[].source`    | `orchestrator` rows are ground truth; `worker` rows are claims.                         |
| `verification[].execution` | Only `argv`/`shell` rows proved anything. `rejected`, `skipped` and `reported` did not. |
| `escalationAdvice`         | What to change before retrying, when it did not pass.                                   |
| `attempt`                  | Which attempt this was, from `previousAttempts`.                                        |

Then, apply risk-based review:

If the result is a clean PASS — `verdict: PASS`, `trustworthy: true`, no
discrepancies, no scope violations, the orchestrator's own verification passed,
only the expected files changed, and nothing in `notes` or the evidence
suggests risk:

- Do NOT automatically reread every implementation file or request the full
  diff.
- Do NOT repeat expensive inspection or verification solely to reproduce
  evidence the orchestrator has already established. Spend supervisor context
  only where it can change the acceptance decision.

Deep diff and code inspection SHOULD happen when any of these hold:

1. The change is high-risk or architecturally significant.
2. Unexpected files were touched, or the behaviour is not what you asked for.
3. An acceptance criterion cannot be judged from the returned evidence.
4. Verification coverage is insufficient for what the task claimed to do.
5. The result is suspicious: `FAILED`, `BLOCKED`, `trustworthy: false`,
   discrepancies, scope violations, a worker claim conflicting with the
   orchestrator's evidence, or an integration conflict.
6. Tests look weakened, deleted, skipped, or made vacuous.
7. Types were loosened (`any`, non-null assertions, `@ts-ignore`) or errors
   were silenced.
8. Anything else in `notes` or the evidence gives reasonable concern.

Confirm each acceptance criterion yourself. `verdict: PASS` with
`trustworthy: true` means the mechanical checks agree with the worker. It does
not mean the code is good. That judgement is yours.

When `verdict` and `workerClaimedStatus` disagree, the worker was wrong about
its own work — read that diff especially carefully.

### Responding to outcomes

- **PASS, clean review** — accept and move on.
- **PASS, but the diff is wrong** — trust your reading over the verdict.
  Re-delegate with a sharper contract.
- **FAILED** — read `discrepancies` and the failing output. Decide whether the
  brief was inadequate (rewrite it) or the task was too hard (escalate effort).
- **BLOCKED** — usually the honest, useful answer. The worker hit something you
  didn't anticipate. Fix the contract, don't just raise the effort.

---

## Reviewing a parallel batch

A batch adds three things to check on top of each task's own result:

| Field                  | Meaning                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `scopeConflicts`       | Declared scopes that could match the same files.                                                                       |
| `integrationConflicts` | Files more than one worker actually changed. Non-empty ⇒ nothing was integrated and their worktrees were kept for you. |
| `integrated`           | Whether the workers' changes are now in the workspace at all.                                                          |

Two rules specific to parallel work:

1. **Integration verification is risk-based.** Each worker passed its own
   checks in its own worktree, which is not the same as passing together. Run
   an integration or full-suite check yourself once the batch is integrated
   when the changes can actually interact: shared contracts, shared types,
   shared runtime behaviour, anything the isolated verification could not have
   exercised, or anything the task explicitly requires.
   Do NOT automatically rerun a full suite solely because the batch ran in
   parallel, when the scopes were genuinely disjoint, each required
   verification passed, no integration conflict occurred, and there is no
   meaningful cross-task interaction.
2. **Partial failure is normal.** If one worker fails, the others' work is still
   there and still valid. Decide per task whether to retry, re-scope, or accept —
   do not throw away three good modules because a fourth failed.

---

## Operational limits

- **Concurrency is capped** (3 workers by default, `SOL_LUNA_MAX_PARALLEL`).
  Extra tasks queue rather than failing.
- Workers cannot delegate. They have no access to either delegation tool.
- Each worker starts with an empty context window and keeps no memory between
  tasks. Its thread id is returned if you need to inspect the session.
- Parallel mode needs a git repository with at least one commit, and no
  uncommitted changes inside the declared task scopes. If that is not the case,
  the batch is refused with the reason — use sequential mode instead.

---

## Installing these rules globally (optional)

The rules above already reach Sol via the MCP tool description. To also load
them into every Codex session in this project:

```bash
# project-scoped
cp SOL_RULES.md /path/to/your/project/AGENTS.md

# or global, for every Codex session
cp SOL_RULES.md ~/.codex/AGENTS.md
```

Global installation applies to sessions that have nothing to do with
delegation, so project-scoped is usually the better choice.
