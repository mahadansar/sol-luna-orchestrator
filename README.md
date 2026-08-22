# sol-luna-orchestrator

[![npm](https://img.shields.io/npm/v/sol-luna-orchestrator)](https://www.npmjs.com/package/sol-luna-orchestrator)
[![CI](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml)
[![M8ven Verified](https://m8ven.ai/badge/mcp/mahadansar-sol-luna-orchestrator-1k52hj)](https://m8ven.ai/mcp/mahadansar-sol-luna-orchestrator-1k52hj) <!-- m8ven-verify: 11a42c6cbe4b21f5016f5899ac006562 -->
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](docs/CONFIGURATION.md#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An MCP server that lets a supervising OpenAI Codex agent delegate bounded
executable work as one task, dependent tasks in sequence, or independent tasks
in parallel. Delegated tasks carry a declared file scope, scope-violation
detection, and results the orchestrator verifies instead of taking on trust.

The parent supervisor is model-agnostic: it decides what should happen, whether
delegating is worth it at all, and reviews what comes back. Workers
(`gpt-5.6-luna`, at an effort chosen per task) carry out bounded
implementation, testing, investigation and other executable work in their own
Codex threads.

Two ideas do most of the work here: **a worker's `PASS` is a claim, not a
conclusion**, and **not every task should be delegated**.

## The core idea

The parent orchestrator first decides whether delegation is worthwhile. More agents are not
automatically better, and the optimal worker count can be zero. Good
orchestration is not about maximising agent count; it includes knowing when one
strong supervisor should do the work itself.

The split is the one most teams already use with people. The supervisor holds
requirements, architecture, decomposition and review, because it has the
context. Workers do bounded executable work—implementation, test writing,
mechanical refactors, focused investigation and chores—because they need a clear
brief rather than the whole picture.

There is a second adaptive layer once the parent does delegate: each worker gets
`medium`, `high`, `xhigh` or `max` reasoning effort based on that task's
difficulty. Running everything at maximum wastes time on work that was
mechanical to begin with. Worker count and worker effort are separate decisions.

Raw token counts are not credit cost. Under the current pricing schedule,
equivalent Luna input, cached-input and output tokens are roughly 25x cheaper
than Sol tokens; that ratio is schedule-dependent, not an architectural
guarantee.

**Worth using when** one substantial bounded task is worth moving out of the parent orchestrator's
context, dependent tasks benefit from sequential execution, independent tasks
can run in parallel, or declared scopes and independently re-run verification
justify the fixed coordination cost.

**Not worth it when** work is small, simple, tightly coupled, already obvious,
or would take longer to specify and review than to do.

## Quick start

Prerequisite: [OpenAI Codex](https://developers.openai.com/codex) installed and
authenticated (`codex login`), and Node.js ≥ 22.12.

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
```

Then open Codex with any compatible parent model and work normally. Creator
examples (not requirements): **GPT-5.6 Sol at Medium effort** is commonly
sufficient for substantial repository work; **GPT-5.6 Luna at High effort** has
successfully handled simpler docs and maintenance work and can delegate bounded
Luna work.

```
Fix the failing tests in src/auth/, src/payments/, and src/search/.
Review the changes and run the full test suite.
```

You do not need to identify a particular parent model, call any tool by hand, or
decide worker counts and efforts. The parent orchestrator decides whether
delegation is worthwhile:

- If the work is small, tightly coupled, or better done directly, it handles it
  itself. Zero workers is a valid outcome.
- If one substantial task is worth moving out of the parent's context, it delegates one
  bounded task with `delegate_task`.
- If two or more tasks depend on earlier changes, share workspace state, or may
  touch the same files, it runs them sequentially in the shared workspace.
- If two or more tasks are genuinely independent and have disjoint declared
  scopes, it runs them in parallel, one isolated worktree per task.

`init` registers the MCP server with Codex, applies the two settings Codex needs
for delegation to work at all, and adds a tiny managed discovery hint to the
active global Codex instructions (`AGENTS.override.md` when active, otherwise
`AGENTS.md`). It changes only the keys and exact marker block it owns and
preserves the rest of the user-owned file. Run it twice and it says `Already
configured`; use `init --no-discovery-hint` to opt out.

```bash
sol-luna-orchestrator activity    # print a snapshot of the latest batch, then exit
sol-luna-orchestrator doctor      # diagnose, with the fix for anything broken
sol-luna-orchestrator status      # short summary
sol-luna-orchestrator uninstall   # remove this project's entry, nothing else
```

Uninstall removes only this project's MCP table and the exact managed discovery
hint. It leaves your other `AGENTS.md` instructions, logs, and activity history
alone. Both `init --dry-run` and `uninstall --dry-run` write nothing.

Full install options, environment variables and Codex settings are in
[Configuration](docs/CONFIGURATION.md).

### Fresh-chat discovery and explicit delegation

Codex may defer MCP tools in a fresh chat, and a generic delegation request may
surface built-in multi-agent tools instead. The managed hint does not force a
delegation or start workers: the parent may choose `delegate_task`,
`delegate_tasks`, or zero workers. When you want to name this MCP explicitly,
use this canonical fresh-chat prompt:

```
Use the sol-luna-orchestrator MCP for this task. Decide whether delegate_task or
delegate_tasks is appropriate based on the work.
```

For an explicit batch request, use:

```
Use sol-luna-orchestrator's delegate_tasks tool for this task. Split the work
only where the tasks are genuinely independent, otherwise use sequential mode.
```

These are stable user-facing names; no generated MCP function name is needed.
You can also name worker counts, scopes and efforts when you have a reason to.
Leave them unspecified otherwise.

Parallel delegation needs more from the repository than sequential does:

- it must be a **git repository with at least one commit**, since each worker
  gets a detached worktree branched from `HEAD`;
- the declared scopes must have **no uncommitted changes** inside them, or the
  batch is refused (override with `SOL_LUNA_ALLOW_DIRTY=1`);
- scopes should be **disjoint**; overlapping `allowedFiles` are refused before
  any worker starts;
- if two workers do change the same file, that collision is **detected, not
  prevented**: nothing is integrated and the worktrees are kept for you.

`delegate_task`, a single task, has none of these requirements.

### Watching a run

`activity` prints one snapshot and exits. To follow a run live, leave a watcher
open in a second terminal:

```bash
# terminal 1
sol-luna-orchestrator activity --watch

# terminal 2: Codex, working normally or delegating explicitly
```

It refreshes as each worker starts, verifies and completes, and stops on Ctrl+C.
The default view leads with the batch state, mode, active/total workers, elapsed
time and peak concurrency, then gives each worker a compact block with its
optional activity label (or `Delegated task N` fallback), model, effort, state,
duration, verification outcome, changed-file count and any known failure reason.
Internal task, batch, and thread identifiers and the fuller telemetry projection remain available through
`activity --json` instead of crowding the terminal view. Worker prompts,
objectives, task context, source code, and command output are intentionally
absent from the activity stream. Delegations may optionally provide a concise
`activityLabel` for the human view; that label is deliberately persisted locally
and can reveal a short work description.
At startup it folds existing history silently and renders only the latest run;
records appended during that catch-up are picked up without needing another
append. Before anything has been delegated it shows
`No orchestration activity found.` and keeps waiting, so you can start it first.
`activity --json` prints one machine-readable snapshot of the latest run instead;
`--watch` and `--json` cannot be combined.

`init` configures the event log this reads, so no environment variable needs to
be exported.

## How it works

```
You
 |
 v
Parent supervisor  ......  decides whether delegating is worth it
 |
 |-- handles it directly  ......................  zero workers, a valid outcome
 |
 '-- delegates bounded tasks
        |
        v
     orchestrator (MCP, stdio)
        |  validates contracts and scopes
        |-- one task ............... shared workspace
        |-- sequential batch ...... shared workspace; later tasks see earlier changes
        '-- parallel batch ........ one git worktree per task
                                      independent, disjoint scopes
        v
     Luna workers, siblings, no delegation tools
        |  each with its own declared scope and effort
        v
     evidence, produced by the orchestrator, not the worker
        |  verification commands re-run
        |  claimed edits compared against observed ones
        |  scope violations detected
         |  parallel integration conflicts detected
         v
     integrate parallel changes only when file sets are disjoint
        |
        v
Parent reviews the evidence proportionally and decides
```

Workers are siblings, never a hierarchy: a Luna worker has no delegation tools,
so it cannot spawn further workers. A single task and sequential batches run in
the shared workspace. Parallel batches deliberately use separate worktrees, so
their tasks must be independent and their declared scopes disjoint.

### Tools

`delegate_task` runs one substantial bounded task directly in the workspace,
with no git requirement. `delegate_tasks` runs several with `mode: "parallel"`
or `mode: "sequential"`, each carrying its own contract and effort.

After invoking either tool, await the active call without repetitive polling or
status narration. Intervene only for a result, error, cancellation, timeout, or
meaningful new state. Delegated `verificationCommands` should normally be
targeted deterministic checks for the bounded task; leave broader final
validation to the parent unless the delegated task genuinely requires a full
suite. The orchestrator still independently processes the supplied checks.

The runtime schema is the field-level contract. Legacy plain `context` and
structured `contextCapsule` may be used together without duplication; neither
replaces objective, scope, acceptance, verification, or security constraints.
For routine calls prefer `resultDetail: "compact"`, which removes only successful
verification output. Failed, refused, and skipped output and all verdict, scope,
discrepancy, and file evidence remain; the schema default stays `"full"` for
compatibility.

Concise supervisor policy reaches the parent through the MCP instructions, tool
descriptions, and schemas. [`SOL_RULES.md`](SOL_RULES.md) is the optional fuller
human/AGENTS reference.

## Guardrails and trust

Read [`SECURITY.md`](SECURITY.md) before pointing this at anything you care
about. The short version:

**Prevented**

- Verification commands are parsed into argv with **no shell**. `;`, `&&`, `|`,
  backticks and `$(...)` are rejected, not executed. Only allowlisted
  executables may launch, and never via a path.
- Credential-shaped environment variables are withheld from verification
  commands, whose output flows back into a model transcript.
- Workspace escapes are caught after resolving symlinks. `allowedFiles: ["**"]`
  still cannot authorize writing outside the workspace.
- Workers cannot delegate, by config and by an environment marker that makes a
  worker-side server register zero tools.
- Parallel batches are refused when scopes overlap, and worker changes are never
  merged when two workers touched the same file.

**Detected, not prevented**

- **File-scope validation is detective.** Workers really write files; a declared
  scope does not stop a write, it makes the violation visible afterwards.
- **Verification runs outside the Codex sandbox**, with your user's permissions.
  `npm test` runs your project's test code, which can do anything you can.
- **Parallel batches write inside your repository**, under
  `.sol-luna/worktrees/`, adding that path to `.git/info/exclude`. Integration
  copies files into your working tree.
- `SOL_LUNA_VERIFY_MODE=shell` disables all command protections. Opt-in, logged
  loudly.
- **The supervisor's own token usage is not observable** to this server. Codex
  does not report the parent turn to an MCP server it launched, so it is
  recorded as `null`, never as zero.

This is a set of guardrails, **not a sandbox**.

## What the benchmarks show

Three suites, all reproducible, all graded by the harness after the agent stops,
never by the agent. Full methodology, per-task numbers and everything that could
not be measured are in [`bench/RESULTS.md`](bench/RESULTS.md). The benchmark
tables report raw token measurements, not billed credit cost.

- **On small tasks, delegating is worse.** About 2.3x slower and 3.5x the
  tokens, with no measurable quality difference.
- **Parallel delegation beats sequential delegation** once you are delegating at
  all: median 155s against 248s, and far more consistent.
- **Delegation has not beaten the supervisor working alone in these fixtures.**
  A dedicated crossover investigation at four and six independent workstreams
  found no latency crossover and no token crossover. Going from four streams to
  six moved forced parallel further behind, +46% to +108%. The runs also showed
  a wide slow-worker tail, but the sample is too small to establish a single
  cause.
- **Left to decide for itself, Sol never delegated** in the six free-choice runs,
  passed every time, and was the fastest arm on two of three fixtures.
- **No raw-token saving has been demonstrated.** Forced parallel execution used
  roughly 5.1x the known tokens on the four-stream fixture and 4.8x on the
  six-stream one. Those raw-token ratios do not equal credit cost; pricing is
  schedule-dependent and this integration does not expose billed cost.

These results describe specific fixtures, models, prompts and versions. They do
not establish that single-agent execution is universally better.

## Limitations

- **Delegation is not free**, and for small tasks it is measurably worse.
- **Parallel mode requires git** with at least one commit and a clean in-scope
  working tree.
- **Integration is a file copy, not a merge.** It is only attempted when worker
  file sets are disjoint; anything else is handed back to you.
- **Workers are verified in isolation.** Passing separately is not passing
  together, so the supervisor is told to run an integration check whenever the
  integrated changes can interact. It is not told to rerun everything by reflex
  after every parallel batch.
- **Verification is not sandboxed.**
- **File-scope validation is detective, not preventive.**
- **Built against experimental surfaces.** Several behaviours this depends on
  are undocumented and were established by testing. Upstream changes may break
  it.
- **Linux and macOS are CI-verified only.** No live model runs there yet.
- **Benchmarks are small.** Directional, not statistically significant.

## Roadmap

**Now**

- Worker Continuation, resuming a worker for bounded follow-up work
- Bounded Repair Loop, one automatic repair turn on routine local defects

**Next**

- Reasoned retry and effort escalation driven by the kind of failure
- Adaptive worker routing inside a user-controlled compute policy

**Later**

- An optional read-only Explorer for reconnaissance
- Lightweight cross-session handoff
- Research and platform work: sandboxed verification, live Linux and macOS
  end-to-end runs, larger fixtures, slow-worker-tail characterisation

See [ROADMAP.md](ROADMAP.md) for priorities, dependencies and the design
constraints on each item, including what is deliberately **not** a goal.

## Documentation

| Document                                   | Why you would open it                                          |
| ------------------------------------------ | -------------------------------------------------------------- |
| [Configuration](docs/CONFIGURATION.md)     | Environment variables, init flags, Codex settings, log paths   |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Symptoms and what they mean, recovering a broken configuration |
| [`SOL_RULES.md`](SOL_RULES.md)             | Supervisor policy: when to delegate, effort choice, reviewing  |
| [`SECURITY.md`](SECURITY.md)               | Trust boundaries, what the logs contain, reporting an issue    |
| [`bench/RESULTS.md`](bench/RESULTS.md)     | Benchmark methodology, raw numbers, limitations                |
| [ROADMAP.md](ROADMAP.md)                   | Prioritised future work and design constraints                 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)       | Development setup, project layout, release process             |
| [`CHANGELOG.md`](CHANGELOG.md)             | What actually shipped, per version                             |

## Contributing

Bug reports and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md)
covers the development setup, the project layout and the ground rules, the main
one being that behaviour is verified against the real thing rather than against
the documentation.

If you are looking for something to work on, [ROADMAP.md](ROADMAP.md) is ordered
by priority and states what has to exist first.

## License

MIT, see [LICENSE](LICENSE).
