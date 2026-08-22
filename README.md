# sol-luna-orchestrator

[![npm](https://img.shields.io/npm/v/sol-luna-orchestrator)](https://www.npmjs.com/package/sol-luna-orchestrator)
[![CI](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml)
[![M8ven Verified](https://m8ven.ai/badge/mcp/mahadansar-sol-luna-orchestrator-1k52hj)](https://m8ven.ai/mcp/mahadansar-sol-luna-orchestrator-1k52hj) <!-- m8ven-verify: 11a42c6cbe4b21f5016f5899ac006562 -->
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](docs/CONFIGURATION.md#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An MCP server that lets a supervising OpenAI Codex agent hand bounded executable
work to separate worker agents: one task on its own, dependent tasks in
sequence, or independent tasks in parallel. Every delegated task carries a
declared file scope, and what comes back is evidence the orchestrator produced
rather than a claim the worker made.

The parent supervisor is model-agnostic. It holds the requirements, decides
whether delegating is worth it at all, and reviews the result. Workers run
`gpt-5.6-luna` in their own Codex threads, at a reasoning effort chosen per
task.

Two ideas do most of the work here: **a worker's `PASS` is a claim, not a
conclusion**, and **not every task should be delegated**.

## Why this exists

The split is the one most teams already use with people. The supervisor keeps
requirements, architecture, decomposition and review, because it has the
context. Workers take bounded executable work such as implementation, test
writing, mechanical refactors and focused investigation, because they need a
clear brief rather than the whole picture.

Delegation here is adaptive, not automatic. The parent decides first whether
handing work off is worth the coordination cost, and the right answer is often
zero workers. Once it does delegate, each task gets its own reasoning effort
(`medium`, `high`, `xhigh` or `max`) based on that task's difficulty. Worker
count and worker effort are separate decisions.

**Worth using when** one substantial bounded task is worth moving out of the
parent's context, dependent tasks benefit from running in sequence, independent
tasks can run in parallel, or declared scopes and independently re-run
verification are worth the fixed overhead.

**Not worth it when** the work is small, tightly coupled, already obvious, or
would take longer to specify and review than to do.

Raw token counts are not credit cost. A delegated approach can use more raw
tokens and still cost fewer credits, but only when the parent you picked is
priced above the worker on the current schedule. No cost saving has been
measured or is claimed. See the [cost guidance](docs/CONFIGURATION.md#cost).

## Quick start

You need [OpenAI Codex](https://developers.openai.com/codex) installed and
logged in (`codex login`), and Node.js 22.12 or newer.

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
```

`init` registers the MCP server with Codex, applies the two Codex settings that
delegation needs to work at all, and adds a small managed hint to your global
Codex instructions so a fresh session can find the server. It changes only the
keys and marker block it owns and preserves the rest of the file. Run it twice
and it says `Already configured`; `init --no-discovery-hint` opts out of the
hint.

Now open Codex with any compatible parent model and work normally:

```
Fix the failing tests in src/auth/, src/payments/, and src/search/.
Review the changes and run the full test suite.
```

You do not need to name a model, call a tool by hand, or decide worker counts
and efforts. Creator example rather than a requirement: **GPT-5.6 Sol at Medium
effort** is commonly enough for substantial repository work.

The other commands:

```bash
sol-luna-orchestrator activity    # snapshot of the latest batch, then exit
sol-luna-orchestrator doctor      # diagnose, with the fix for anything broken
sol-luna-orchestrator status      # short summary
sol-luna-orchestrator uninstall   # remove this project's entry, nothing else
```

`uninstall` removes only this project's MCP table and its exact managed hint,
and leaves your other instructions, logs and activity history alone. Both `init`
and `uninstall` take `--dry-run` and write nothing. Install options, environment
variables and Codex settings are in [Configuration](docs/CONFIGURATION.md).

## What the parent decides

For each piece of work the parent picks one of four outcomes:

- **Solo, zero workers.** Small, tightly coupled or obvious work is done
  directly. This is a valid and often correct outcome, not a failure to
  delegate.
- **One task.** A single substantial bounded task is worth moving out of the
  parent's context on its own. No second seam is required to justify it.
- **Sequential.** Two or more tasks depend on earlier changes, share workspace
  state, or may touch the same files, so they run in order in the shared
  workspace.
- **Parallel.** Two or more tasks are genuinely independent and have disjoint
  declared scopes, so each runs in its own isolated git worktree.

### If a fresh session does not find the server

Codex can defer MCP tools in a brand new chat, and a generic "delegate this"
request may reach Codex's own built-in delegation instead. The managed hint
`init` writes exists to make this server discoverable first; it does not force a
delegation or start workers. When you want to be explicit, name it:

```
Use the sol-luna-orchestrator MCP for this task. Decide whether delegate_task or
delegate_tasks is appropriate based on the work.
```

You can also name worker counts, scopes and efforts when you have a reason to,
and leave them unspecified otherwise. The mechanics, and the evidence behind
them, are in [Delegation Discovery](docs/DELEGATION_DISCOVERY.md).

## Watching a run

`activity` prints one snapshot and exits. To follow a run live, leave a watcher
open in a second terminal:

```bash
# terminal 1
sol-luna-orchestrator activity --watch

# terminal 2: Codex, working normally
```

It refreshes as each worker starts, verifies and completes, and stops on Ctrl+C.
The view leads with batch state, mode, active and total workers, elapsed time
and peak concurrency, then gives each worker a compact block: its optional
activity label (or a `Delegated task N` fallback), model, effort, state,
duration, verification outcome, changed-file count and any known failure reason.
`activity --json` prints one machine-readable snapshot instead and cannot be
combined with `--watch`.

Worker prompts, objectives, task context, source code and command output are
deliberately absent from the activity stream. The optional `activityLabel` is
the exception: it is persisted locally on purpose, and it can reveal a short
description of the work. [Observability](docs/OBSERVABILITY.md) has the event
shapes and the fuller privacy picture.

`init` configures the event log this reads, so no environment variable needs to
be exported.

## How it works

```
You
 |
 v
Parent supervisor .......... decides whether delegating is worth it
 |
 |-- does the work itself ... zero workers, a valid outcome
 |
 +-- delegates bounded tasks
        |
        v
     orchestrator (MCP over stdio)
        |  validates contracts and declared scopes
        |-- one task ....... shared workspace
        |-- sequential ..... shared workspace, later tasks see earlier changes
        +-- parallel ....... one git worktree per task, disjoint scopes
        |
        v
     Luna workers, siblings with no delegation tools of their own
        |  each with its own declared scope and effort
        v
     evidence produced by the orchestrator, not by the worker
        |  verification commands re-run
        |  claimed edits compared against observed ones
        |  scope violations and integration conflicts detected
        v
Parent reviews the evidence and decides
```

Workers are siblings, never a hierarchy: a Luna worker has no delegation tools,
so it cannot spawn workers of its own. `delegate_task` runs one bounded task
directly in the workspace and has no git requirement. `delegate_tasks` runs
several, either `sequential` in the shared workspace or `parallel` with one
worktree per task, each task carrying its own contract, scope and effort.

While a call is in flight and there is no meaningful new state, the parent is
asked to stay quiet rather than narrate polling or elapsed time, and to report
results, errors, cancellations, timeouts and actionable state changes as soon as
they happen. That is guidance to the parent and its client, not behavior the
server can enforce.

Supervisor policy reaches the parent through the MCP instructions, tool
descriptions and schemas. [`SOL_RULES.md`](SOL_RULES.md) is the optional fuller
reference for humans and AGENTS files.

## Verification and trust

A worker reports its own status, summary, changed files and verification result.
Those are claims. The evidence the parent reviews is produced by the
orchestrator: it re-runs the verification commands itself, compares claimed
edits against observed ones, and reports scope violations and integration
conflicts. A worker `PASS` is where review starts, not where it ends.

**Enforced**

- Verification commands are parsed into argv with **no shell**, so `;`, `&&`,
  `|`, backticks and `$(...)` are rejected rather than executed. Only
  allowlisted executables may launch, and never via a path.
- Credential-shaped environment variables are withheld from those commands,
  because their output flows back into a model transcript.
- Workspace escapes are caught after resolving symlinks. `allowedFiles: ["**"]`
  still cannot authorize a write outside the workspace.
- Workers cannot delegate, both by child configuration and by an environment
  marker that makes a worker-side server register zero tools.
- Parallel batches are refused when declared scopes overlap, and changes are
  never merged when two workers touched the same file.

**Detected, not prevented**

- **File scopes are detective, not a write sandbox.** Workers write real files.
  A declared scope does not block a write, it makes the violation visible
  afterwards.
- **Verification runs outside the Codex sandbox**, with your user's permissions.
  `npm test` runs your project's own test code, which can do anything you can.
- **Parallel batches write inside your repository**, under
  `.sol-luna/worktrees/`, and integration copies files back into your working
  tree. That mode needs a git repository with at least one commit and no
  uncommitted changes inside the declared scopes.

This is a set of guardrails, not a sandbox. Read [`SECURITY.md`](SECURITY.md)
before pointing it at anything you care about.

## What the benchmarks show

Three reproducible suites, all graded by the harness after the agent stops,
never by the agent itself.

- **On small tasks, delegating is worse.** Roughly 2.3x slower and 3.5x the
  tokens, with no measurable quality difference.
- **Once you are delegating, parallel beats sequential.** Median 155s against
  248s on three-module projects, and far more consistent run to run.
- **Delegation has not beaten the supervisor working alone in these fixtures.**
  A crossover investigation at four and six independent workstreams found no
  latency crossover and no token crossover, and six streams sat further behind
  than four. Left to choose for itself, the supervisor declined to delegate in
  all six free-choice scale runs, passed every time, and was the fastest arm on
  two of the three fixtures. Those were routing decisions taken with the tools
  in front of it, not failures to find the server.

The token figures are raw measurements, not billed cost, and no raw-token or
cost saving has been demonstrated. These results describe specific fixtures,
models, prompts and versions; they do not establish that single-agent execution
is universally better. Methodology, per-task numbers and everything that could
not be measured are in [`bench/RESULTS.md`](bench/RESULTS.md).

## Requirements and limits

- **Node.js 22.12 or newer, and a logged-in Codex CLI.** `doctor` checks both
  and tells you how to fix whatever is missing.
- **git with at least one commit** is needed for parallel batches only. A single
  task and sequential batches have no git requirement.
- **Integration is a file copy, not a merge.** It is attempted only when worker
  file sets are disjoint; anything else is handed back to you, with the
  worktrees kept.
- **Workers are verified in isolation.** Passing separately is not passing
  together, so the parent is told to run an integration check whenever
  integrated changes can interact.
- **Windows is the only platform with live model runs.** Linux and macOS are
  verified in CI, with the platform-specific code paths exercised, but have not
  been driven end to end with a real model.
- **Built against experimental surfaces.** Several behaviors this depends on are
  undocumented and were established by testing, so upstream changes may break
  it.
- **The benchmarks are small.** Directional, not statistically significant.

Planned work, and what is deliberately not a goal, is in
[ROADMAP.md](ROADMAP.md).

## Documentation

| Document                                             | Why you would open it                                         |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| [Configuration](docs/CONFIGURATION.md)               | Environment variables, init flags, Codex settings, cost notes |
| [Troubleshooting](docs/TROUBLESHOOTING.md)           | Symptoms, and recovering a broken configuration               |
| [Observability](docs/OBSERVABILITY.md)               | Event stream shapes, activity log, privacy                    |
| [Live Acceptance](docs/ACCEPTANCE.md)                | Manual procedure for testing a fresh Codex session            |
| [Delegation Discovery](docs/DELEGATION_DISCOVERY.md) | Fresh-session discovery, and how routing differs from it      |
| [`SOL_RULES.md`](SOL_RULES.md)                       | Supervisor policy: delegating, effort, reviewing evidence     |
| [`SECURITY.md`](SECURITY.md)                         | Trust boundaries, what the logs hold, reporting an issue      |
| [`bench/RESULTS.md`](bench/RESULTS.md)               | Benchmark methodology, raw numbers, limitations               |
| [ROADMAP.md](ROADMAP.md)                             | Prioritised future work and design constraints                |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                 | Development setup, project layout, release process            |
| [`CHANGELOG.md`](CHANGELOG.md)                       | What actually shipped, per version                            |

## Contributing

Bug reports and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md)
covers the development setup, the project layout and the ground rules, the main
one being that behavior is verified against the real thing rather than against
the documentation. If you are looking for something to work on,
[ROADMAP.md](ROADMAP.md) is ordered by priority and states what has to exist
first.

## License

MIT, see [LICENSE](LICENSE).
