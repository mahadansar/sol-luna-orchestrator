# sol-luna-orchestrator

[![npm](https://img.shields.io/npm/v/sol-luna-orchestrator)](https://www.npmjs.com/package/sol-luna-orchestrator)
[![CI](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml)
[![M8ven Verified](https://m8ven.ai/badge/mcp/mahadansar-sol-luna-orchestrator-1k52hj)](https://m8ven.ai/mcp/mahadansar-sol-luna-orchestrator-1k52hj) <!-- m8ven-verify: 11a42c6cbe4b21f5016f5899ac006562 -->
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](docs/CONFIGURATION.md#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An MCP server that lets a supervising OpenAI Codex agent delegate bounded
implementation tasks to isolated worker threads, one at a time or several in
parallel in their own git worktrees, with a declared file scope per task,
scope-violation detection, and results the orchestrator verifies instead of
taking on trust.

The supervisor (`gpt-5.6-sol`, high effort recommended) decides what should
happen, whether delegating is worth it at all, and reviews what comes back.
Workers (`gpt-5.6-luna`, at an effort chosen per task) do the contained
implementation work in their own Codex threads.

Two ideas do most of the work here: **a worker's `PASS` is a claim, not a
conclusion**, and **not every task should be delegated**.

## The core idea

Sol first decides whether delegation is worthwhile. More agents are not
automatically better, and the optimal worker count can be zero. Good
orchestration is not about maximising agent count; it includes knowing when one
strong supervisor should do the work itself.

The split is the one most teams already use with people. The supervisor holds
requirements, architecture, decomposition and review, because it has the
context. Workers do bounded implementation, test writing, mechanical refactors
and focused investigation, because they need a clear brief rather than the whole
picture.

There is a second adaptive layer once Sol does delegate: each worker gets
`medium`, `high`, `xhigh` or `max` reasoning effort based on that task's
difficulty. Running everything at maximum wastes time on work that was
mechanical to begin with. Worker count and worker effort are separate decisions.

Across the six measured free-choice runs in the scale benchmark, Sol declined to
delegate every time, and forced delegation was slower on each corresponding
fixture. That supports a deliberately scoped conclusion for the workloads
measured here: strong supervisor first, additional agents only when they earn
their coordination cost. It does not prove single-agent systems are universally
better than multi-agent ones.

**Worth using when** a task has two or more genuinely independent workstreams,
when you want a declared file scope per unit of work with violations reported
rather than discovered later, when you want verification re-run independently of
the agent claiming it passed, or when one long session would lose coherence.

**Not worth it when** the task is small, touches one or few files, has no useful
decomposition, or would take longer to explain than to do.

## Quick start

Prerequisite: [OpenAI Codex](https://developers.openai.com/codex) installed and
authenticated (`codex login`), and Node.js ≥ 22.12.

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
```

Then open Codex, select **GPT-5.6 Sol at High effort**, and work normally.

```
Fix the failing tests in src/auth/, src/payments/, and src/search/.
Review the changes and run the full test suite.
```

You do not need to tell Sol it is the supervisor, call any tool by hand, or
decide worker counts and efforts. Sol decides whether delegation is worthwhile:

- If the work breaks down cleanly into independent workstreams, it delegates to
  Luna workers in parallel worktrees, choosing scopes and effort adaptively.
- If subtasks are dependent, small, or better done directly, it handles them
  itself. The optimal number of additional workers can be zero.

`init` registers the MCP server with Codex and applies the two settings Codex
needs for delegation to work at all. It changes only the keys it owns, so your
comments, formatting and other MCP servers are left exactly as they were. Run it
twice and it says `Already configured`.

```bash
sol-luna-orchestrator activity    # print a snapshot of the latest batch, then exit
sol-luna-orchestrator doctor      # diagnose, with the fix for anything broken
sol-luna-orchestrator status      # short summary
sol-luna-orchestrator uninstall   # remove this project's entry, nothing else
```

Full install options, environment variables and Codex settings are in
[Configuration](docs/CONFIGURATION.md).

### Requesting delegation explicitly

Optional. Adaptive usage above is the default. When you already know the work
has clean independent seams, you can steer delegation explicitly in plain
language, with no MCP or tool syntax:

```
These three modules are independent. Use Sol-Luna to delegate them in parallel,
one Luna worker per module with disjoint file scopes. Choose each worker's
reasoning effort based on its task, then review the integrated changes and run
the full test suite.
```

You can equally ask for sequential delegation, or name worker counts, scopes and
efforts when you have a reason to. Leave them unspecified otherwise.

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
Before anything has been delegated it shows `No orchestration activity found.`
and keeps waiting, so you can start it first. `activity --json` prints a
machine-readable snapshot instead; `--watch` and `--json` cannot be combined.

`init` configures the event log this reads, so no environment variable needs to
be exported.

## How it works

```
You
 |
 v
Sol supervisor  ......  decides whether delegating is worth it
 |
 |-- handles it directly  ......................  zero workers, a valid outcome
 |
 '-- delegates bounded tasks
        |
        v
     orchestrator (MCP, stdio)
        |  refuses overlapping scopes before starting
        |  refuses a dirty in-scope working tree
        |  creates one git worktree per task
        v
     Luna workers, siblings, no delegation tools
        |  each with its own declared scope and effort
        v
     evidence, produced by the orchestrator, not the worker
        |  verification commands re-run
        |  claimed edits compared against observed ones
        |  scope violations detected
        |  integration conflicts detected
        v
     integrate only when file sets are disjoint
        |
        v
Sol reviews the diff and decides
```

Workers are siblings, never a hierarchy: a Luna worker has no delegation tools,
so it cannot spawn further workers. Sequential mode deliberately shares the
workspace so a later task sees an earlier one's changes; parallel mode
deliberately does not.

### Tools

`delegate_task` runs one bounded task directly in the workspace, with no git
requirement. `delegate_tasks` runs several with `mode: "parallel"` or
`mode: "sequential"`, each carrying its own contract and effort.

Both share the same task contract: `objective`, `effort`, `effortReason`,
`taskCategory`, `allowedFiles`, `forbiddenFiles`, `acceptanceCriteria`,
`verificationCommands`, `previousAttempts`.

Two optional additions, both of which default to today's behaviour:

- `contextCapsule` gives the worker a structured brief it cannot infer from the
  repository: `relevantContext`, `interfaces`, `dependencies`, `invariants`,
  `upstreamDecisions`, `knownPitfalls`. Every field is optional, and empty ones
  are left out of the worker's prompt. It is for selected context, not for
  copying a whole session across.
- `resultDetail: "compact"` drops the stdout of verification commands that
  passed from the structured result, keeping verdicts, discrepancies, scope
  violations and the output of anything that failed or was refused. That output
  is the only thing it removes, and the readable text block is the same either
  way. The default is `"full"`, which is unchanged. Compact makes a routine result smaller; it does not make removed
  output retrievable afterwards, so ask for `"full"` when you expect to need
  the successful command output.

The supervisor policy behind all of this, including how effort is chosen and how
results should be reviewed, is in [`SOL_RULES.md`](SOL_RULES.md). It reaches Sol
automatically through the MCP tool descriptions, so no setup is needed.

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
not be measured are in [`bench/RESULTS.md`](bench/RESULTS.md).

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
- **No token or cost saving has been demonstrated.** Forced parallel execution
  used roughly 5.1x the known tokens on the four-stream fixture and 4.8x on the
  six-stream one.

These results describe specific fixtures, models, prompts and versions. They do
not establish that single-agent execution is universally better.

## Limitations

- **Delegation is not free**, and for small tasks it is measurably worse.
- **Parallel mode requires git** with at least one commit and a clean in-scope
  working tree.
- **Integration is a file copy, not a merge.** It is only attempted when worker
  file sets are disjoint; anything else is handed back to you.
- **Workers are verified in isolation.** Passing separately is not passing
  together, so the supervisor is told to run the full suite after integration.
- **Verification is not sandboxed.**
- **File-scope validation is detective, not preventive.**
- **Built against experimental surfaces.** Several behaviours this depends on
  are undocumented and were established by testing. Upstream changes may break
  it.
- **Linux and macOS are CI-verified only.** No live model runs there yet.
- **Benchmarks are small.** Directional, not statistically significant.

## Roadmap

**Now**

- Context Capsule v2, a richer structured work package per worker
- Compact Evidence Packets, cheaper supervisor review without losing evidence
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
