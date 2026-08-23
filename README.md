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
declared file scope, and the orchestrator returns independently checked evidence
for the parent to review.

The parent owns the requirements, decides whether delegation is worthwhile, and
reviews the result. Workers run in isolated Codex threads and cannot delegate
further. Zero workers is a valid choice.

Requires Node.js 22.12 or newer and a logged-in Codex CLI.
Any compatible parent model may supervise. Creator examples, platform details,
and the full requirements are in [Configuration](docs/CONFIGURATION.md).

## Quick start

Install and log in to [OpenAI Codex](https://developers.openai.com/codex), then
install the server globally and run its setup lifecycle:

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
sol-luna-orchestrator doctor
```

Global installation gives Codex a durable server path. `init` registers the
installed server and reconciles the values it owns; it is safe to rerun after an
upgrade. `doctor` checks the installation and prints remedies without making a
model call. Settings, environment variables and platform details live in
[Configuration](docs/CONFIGURATION.md).

After setup, use Codex normally. The supervisor chooses whether to work solo or
delegate bounded work; you do not need to choose worker counts or call MCP tools
by hand.

## Updating

After installing a new release, rerun the lifecycle against the durable global
install:

```bash
npm install -g sol-luna-orchestrator@latest
sol-luna-orchestrator init
sol-luna-orchestrator doctor
```

## Commands

```text
sol-luna-orchestrator init       Register or reconcile the server
sol-luna-orchestrator doctor     Diagnose the installation
sol-luna-orchestrator status     Show a short runtime summary
sol-luna-orchestrator activity   Inspect recent batch activity
sol-luna-orchestrator uninstall  Remove this project's registration
```

`init` and `uninstall` also support `--dry-run`. See [Configuration](docs/CONFIGURATION.md)
for options and [Troubleshooting](docs/TROUBLESHOOTING.md) for recovery.

## Features

| Capability                      | What it does                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adaptive delegation             | Lets the supervisor choose solo work, one worker, or sequential or parallel batches, with worker effort chosen per task.                                   |
| Bounded task contracts          | Constrains delegated work with file scopes, acceptance criteria, verification commands, and explicit `forbidden`, `optional`, or `required` change intent. |
| Isolated parallel execution     | Uses separate worktrees, bounded concurrency, leases, and conservative conflict-aware integration for independent tasks.                                   |
| Independent evidence            | Reruns declared verification, reconciles worker claims with observed Git changes, and surfaces discrepancies instead of trusting worker status.            |
| Continuation and bounded repair | Can resume an eligible worker under the original contract and optionally perform one conservatively classified repair attempt.                             |
| Context and review controls     | Uses structured Context Capsules and Compact Evidence Packets to limit unnecessary context while preserving review evidence.                               |
| Activity and observability      | Exposes human-readable and JSON batch and worker activity while keeping prompts and sensitive task context out of the activity stream.                     |
| Setup and diagnostics           | Provides `init`, `doctor`, `status`, `activity`, and `uninstall`, including managed discovery for normal Codex usage.                                      |

## How it works

```text
Parent in Codex
  |-- Solo .............. no worker
  |-- Single ............ one bounded task
  |-- Sequential ........ dependent tasks share workspace state
  +-- Parallel .......... independent tasks use isolated worktrees
          |
          v
      MCP orchestrator validates contracts, runs workers,
      reruns verification, and returns evidence for review.
```

The parent owns decomposition and final judgement. Parallel integration is a
file copy guarded by observed scope and same-file conflict checks. See
[`SOL_RULES.md`](SOL_RULES.md) for supervisor policy and
[Configuration](docs/CONFIGURATION.md#discovery-hint-and-adaptive-routing) for
fresh-session discovery setup.

## Safety

These are guardrails, not a sandbox: workers write real files, verification runs
with the operator's permissions, and logs can contain sensitive paths, contents,
or command output. Read the [`SECURITY.md`](SECURITY.md) threat model before
using Sol-Luna on untrusted code.

## Benchmark evidence

The committed benchmarks are directional measurements of specific fixtures,
models, prompts, and versions. They show that delegation overhead can outweigh
its benefits and do not establish a universal latency, quality, token, or cost
crossover. Raw tokens are not billed cost, and no cost saving is claimed. See
[`bench/RESULTS.md`](bench/RESULTS.md) for the evidence and limitations and
[Configuration](docs/CONFIGURATION.md#cost) for cost terminology.

## Release status and roadmap

Changes implemented on `main` but not yet released are recorded under
[`CHANGELOG.md` Unreleased](CHANGELOG.md#unreleased). Future priorities,
dependencies, constraints, and non-goals are maintained in
[ROADMAP.md](ROADMAP.md).

## Documentation

| Document                                         | Purpose                                               |
| ------------------------------------------------ | ----------------------------------------------------- |
| [Configuration](docs/CONFIGURATION.md)           | Settings, environment variables, and platform support |
| [Troubleshooting](docs/TROUBLESHOOTING.md)       | Diagnosis and recovery                                |
| [Observability](docs/OBSERVABILITY.md)           | Event shapes and activity projections                 |
| [Feature Acceptance](docs/FEATURE_ACCEPTANCE.md) | Evidence, freshness, confidence, and retest gaps      |
| [`SOL_RULES.md`](SOL_RULES.md)                   | Supervisor delegation, effort, and review policy      |
| [`SECURITY.md`](SECURITY.md)                     | Threat model and log sensitivity                      |
| [`bench/RESULTS.md`](bench/RESULTS.md)           | Benchmark evidence, interpretation, and limitations   |
| [ROADMAP.md](ROADMAP.md)                         | Prioritised future work and constraints               |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)             | Development, live acceptance, and release workflow    |
| [`CHANGELOG.md`](CHANGELOG.md)                   | Shipped changes and the Unreleased queue              |

## Contributing

Bug reports and pull requests are welcome. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the development and contribution
workflow, and [ROADMAP.md](ROADMAP.md) for future work.

## License

MIT, see [LICENSE](LICENSE).
