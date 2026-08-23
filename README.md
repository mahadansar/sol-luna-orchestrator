# sol-luna-orchestrator

[![npm](https://img.shields.io/npm/v/sol-luna-orchestrator)](https://www.npmjs.com/package/sol-luna-orchestrator)
[![npm downloads](https://img.shields.io/npm/dt/sol-luna-orchestrator)](https://www.npmjs.com/package/sol-luna-orchestrator)
[![CI](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml)
[![M8ven Verified](https://m8ven.ai/badge/mcp/mahadansar-sol-luna-orchestrator-1k52hj)](https://m8ven.ai/mcp/mahadansar-sol-luna-orchestrator-1k52hj) <!-- m8ven-verify: 11a42c6cbe4b21f5016f5899ac006562 -->
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](docs/CONFIGURATION.md#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An MCP server that lets a supervising OpenAI Codex agent hand bounded executable
work to separate worker agents: one task on its own, dependent tasks in
sequence, or independent tasks in parallel. Every delegated task carries a
declared file scope, and what comes back is evidence the orchestrator produced
rather than a claim the worker made.

The parent supervisor runs in OpenAI Codex but is not hardcoded to one specific
Codex model. It holds the requirements, decides whether delegating is worth it
at all, and reviews the result. Workers run `gpt-5.6-luna` in their own Codex
threads, at a reasoning effort chosen per task.

Two ideas do most of the work here: **a worker's `PASS` is a claim, not a
conclusion**, and **not every task should be delegated**.

## Quick Start

You need [OpenAI Codex](https://developers.openai.com/codex) installed and
logged in (`codex login`), and Node.js 22.12 or newer.

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
sol-luna-orchestrator doctor
```

Global installation is the normal path because Codex needs a durable server
path; `init` refuses an ephemeral npx-cache install unless you explicitly opt
in. On first setup, `init` registers the installed server, reconciles the
required Codex settings (`tool_timeout_sec = 3600` and
`default_tools_approval_mode = "approve"`), its server environment (including
the log/event paths and server name), and its managed discovery hint. Run it
again after every upgrade so the registration and any newly required, missing,
or incorrect owned values are reconciled with the upgraded install. Plain reruns
preserve unrelated config and custom log/event paths; `--log` or `--events`
explicitly replaces those paths. `init` is idempotent, and
`--no-discovery-hint` opts out of the hint.

`doctor` follows setup and upgrades: it checks the local Node.js, Codex, git,
registration, settings, runtime policy, logs, and discovery hint, and prints
remedies without making a model call. Project-local MCP overrides are mainly
for developing Sol-Luna itself, not normal user setup.

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

## Updating

After installing a new release, rerun the lifecycle against the durable global
install:

```bash
npm install -g sol-luna-orchestrator@latest
sol-luna-orchestrator init
sol-luna-orchestrator doctor
```

`init` reconciles Codex with the upgraded install and repairs the values it
owns; `doctor` confirms the resulting setup.

## Features

| Capability                               | What it does                                                                                                                       | Added  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Adaptive zero-worker delegation          | Lets the supervisor decide that a task is better done directly when delegation is not worth its overhead.                          | v0.6.0 |
| Single-task delegation                   | Runs one bounded executable task in the shared workspace through `delegate_task`.                                                  | v0.5.0 |
| Sequential and parallel batches          | Runs dependent tasks in sequence or independent tasks in parallel through `delegate_tasks`.                                        | v0.5.0 |
| Isolated worktrees and safe integration  | Gives parallel workers separate worktrees and detects scope or same-file conflicts before copying safe changes back.               | v0.5.0 |
| Bounded concurrency                      | Queues excess batch tasks behind a shared semaphore with a small configurable ceiling.                                             | v0.5.0 |
| Adaptive worker effort                   | Chooses reasoning effort independently for each delegated task.                                                                    | v0.5.0 |
| Independent verification                 | Re-runs declared verification commands after the worker exits and reports the evidence.                                            | v0.5.0 |
| Claimed-versus-observed reconciliation   | Compares worker-reported edits with runtime-observed file changes and surfaces discrepancies.                                      | v0.5.0 |
| Context Capsule v2                       | Passes selected structured background context to a worker without dumping the supervisor's whole session.                          | v0.7.0 |
| Compact Evidence Packets                 | Omits routine successful verification output while retaining verdicts, failures, discrepancies and scope violations.               | v0.7.0 |
| CLI, setup and diagnostics lifecycle     | Provides idempotent `init`, `doctor`, `status` and `uninstall` commands for setup and diagnosis.                                   | v0.5.0 |
| Activity and observability               | Records structured lifecycle events and exposes live or machine-readable batch and worker activity.                                | v0.6.0 |
| Natural discovery and normal Codex usage | Installs a managed fresh-session discovery hint while leaving the supervisor free to work normally and choose whether to delegate. | v0.8.0 |

Versions before v0.5.0 were development milestones; v0.5.0 was the first tagged
and published release.

## Coming next

Explicit Change Intent Contracts, Worker Continuation, and the Bounded Repair
Loop are implemented on `main` but await a release. The [roadmap](ROADMAP.md)
then covers reasoned retry and effort escalation, adaptive worker routing with
compute policy and stronger-executor fallback, automatic context lifecycle
management, an optional Explorer, cross-session handoff, and an end-to-end
automated workflow.

## How it works

```
Parent in Codex
  |-- Solo .............. zero workers; often the right choice
  |-- Single ............ shared workspace via `delegate_task`
  |-- Sequential ........ shared workspace; later tasks see earlier changes
  +-- Parallel .......... isolated git worktree per task; normally disjoint scopes
          |
          v
      MCP orchestrator validates contracts, runs Luna workers,
      re-runs verification, and returns evidence for parent review.
```

The parent owns requirements, decomposition and review. Workers are siblings,
not a hierarchy: they have no delegation tools of their own. Parallel
integration is a file copy, not a merge, and only proceeds safely for disjoint
observed file sets; otherwise the work is returned for review. See
[`SOL_RULES.md`](SOL_RULES.md) for the supervisor policy and
[Delegation Discovery](docs/DELEGATION_DISCOVERY.md) for fresh-session discovery.

`delegate_tasks` handles sequential and parallel batches; a single task is
supported there for compatibility.

`init` installs a managed discovery hint but does not force delegation;
`init --no-discovery-hint` opts out. For activity, use `sol-luna-orchestrator
activity` for a snapshot, `activity --watch` to follow a run, or `activity
--json` for one machine-readable snapshot. `--watch` and `--json` cannot be combined;
event shapes and privacy details are in [Observability](docs/OBSERVABILITY.md).

## Verification & safety

A worker reports its own status, structured failure causes, summary, changed
files and verification result. Those are claims: the orchestrator independently
reruns declared verification, compares claimed with observed edits, and reports
scope violations and parallel integration conflicts. In the default mode,
verification commands are parsed without a shell and credential-shaped
environment variables are withheld.

A worker `FAILED` becomes an orchestrator `PASS` only for one narrow evidence
contradiction: its sole declared cause is `verification`, every failed
worker-reported command machine-matches a distinct passing authoritative run,
and every configured command ran successfully with no other terminal evidence.
The worker claim and both verification sources remain visible,
`trustworthy` stays false, and review guidance calls out the disagreement.
Windows matching treats bare `npm`, `npm.cmd`, and `npm.ps1` launchers as the
same logical executable only when all arguments match; path-qualified commands,
shell syntax, and POSIX launcher suffixes are not normalized.

These are guardrails, not a sandbox. File scopes are detective rather than a
write boundary, and verification runs outside the Codex sandbox with the user's
permissions. Parallel worktrees also write inside the repository. Read the
[`SECURITY.md`](SECURITY.md) threat model before using it on untrusted code.

## Benchmark highlights

The three reproducible suites are directional measurements of specific fixtures,
models, prompts and versions:

- Small tasks: delegation was roughly 2.3x slower and used 3.5x the raw tokens,
  with no measurable quality difference.
- Three-module projects: actual delegated parallel runs had a 155s median versus
  248s sequential, but neither beat the strong solo baseline in these fixtures.
- Scale: no latency or token crossover was found at four or six streams; the
  free-choice supervisor chose zero workers in all six runs and passed each time.

The harness graded every run after the agent stopped. Raw tokens are not billed
cost, and no cost saving is claimed. See [`bench/RESULTS.md`](bench/RESULTS.md)
for methodology, per-task numbers and limitations, and
[Configuration](docs/CONFIGURATION.md#cost) for the distinct cost concepts.

## Requirements

- Node.js 22.12 or newer and a logged-in [Codex CLI](https://developers.openai.com/codex).
- git 2.20 or newer for parallel batches only; single-task and sequential modes
  do not require git.
- Live model runs have been verified on Windows; Linux and macOS are covered by
  deterministic CI but have not been driven end to end with a real model.

`doctor` checks the installation. Configuration, platform details and runtime
limits are in [Configuration](docs/CONFIGURATION.md); planned work is in
[ROADMAP.md](ROADMAP.md).

## Documentation

| Document                                             | Why you would open it                                         |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| [Configuration](docs/CONFIGURATION.md)               | Environment variables, init flags, Codex settings, cost notes |
| [Troubleshooting](docs/TROUBLESHOOTING.md)           | Symptoms, and recovering a broken configuration               |
| [Observability](docs/OBSERVABILITY.md)               | Event stream shapes, activity log, privacy                    |
| [Live Acceptance](docs/ACCEPTANCE.md)                | Manual procedure for testing a fresh Codex session            |
| [Feature Acceptance](docs/FEATURE_ACCEPTANCE.md)     | Per-feature evidence, freshness, confidence, and retest gaps  |
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
