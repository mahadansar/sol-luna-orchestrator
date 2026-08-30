# sol-luna-orchestrator

[![npm](https://img.shields.io/npm/v/sol-luna-orchestrator)](https://www.npmjs.com/package/sol-luna-orchestrator)
[![CI](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml)
[![M8ven Verified](https://m8ven.ai/badge/mcp/mahadansar-sol-luna-orchestrator-1k52hj)](https://m8ven.ai/mcp/mahadansar-sol-luna-orchestrator-1k52hj) <!-- m8ven-verify: 11a42c6cbe4b21f5016f5899ac006562 -->
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](docs/CONFIGURATION.md#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Bounded delegation for OpenAI Codex. Sol remains the supervisor and architect;
Luna workers execute well-defined tasks and cannot delegate further. The runtime
admits compute under operator policy, checks observed changes against declared
scope, isolates parallel work, and independently verifies outcomes.

For each task, the supervisor can stay solo or use one worker, dependent workers
in sequence, or independent workers in parallel.

## Quick start

Prerequisites: Node.js 22.12 or newer and a logged-in
[OpenAI Codex CLI](https://developers.openai.com/codex).

Any compatible parent model may supervise.

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
sol-luna-orchestrator doctor
```

Open Codex and work normally. It can discover the orchestrator and decide
whether delegation is useful; you do not need to select workers or call MCP
tools yourself. For clone installs, platform requirements, and advanced setup,
see [Configuration](docs/CONFIGURATION.md).

The most useful CLI commands are `init` to register or reconcile the server,
`doctor` to diagnose setup, `status` for a runtime summary, and `activity` for
recent orchestration activity. See [Configuration](docs/CONFIGURATION.md) for
the remaining lifecycle commands and options.

## How it works

```text
Codex parent
    |
    +--> stay solo
    +--> optional read-only explore or routing preflight
    +--> bounded contract: scope + intent + acceptance + verification
              |
              +--> one Luna worker
              +--> sequential workers sharing workspace state
              +--> parallel workers in isolated worktrees
                            |
                            v
               observed edits + authoritative verification
                            |
                            v
             thin verified handoff, evidence, or next action
```

The parent chooses the execution shape. A user-owned compute policy bounds the
worker model, effort, count, and concurrency; adaptive routing may recommend
solo, single, sequential, or parallel execution but never widens that policy.
The orchestrator reconciles worker claims with observed changes and reruns the
declared checks, including a final deduplicated batch check after integration.
See [discovery and adaptive routing](docs/CONFIGURATION.md#discovery-hint-and-adaptive-routing)
for the fresh-session setup and routing guidance.

## Features

| Capability                                 | What it provides                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adaptive orchestration                     | Solo, single, sequential, or parallel execution, with semantic routing and operator-bounded model, effort, worker-count, and concurrency policy.             |
| Isolated parallel execution                | Independent workers use separate worktrees, bounded concurrency, conservative integration, and conflict and scope checks; sequential tasks can share state.  |
| Authoritative verification                 | Observed changes and independently rerun checks determine trust, including final workspace verification after batch integration.                             |
| Bounded repair and recovery                | Evidence can authorize one eligible task-local repair or one bounded parallel recovery attempt, without uncontrolled retry chains.                           |
| Continuations and next actions             | Eligible work can resume under its original contract, while single-use handoffs preserve only execution authority earned from authoritative evidence.        |
| Context lifecycle management               | Model-facing context and routine results stay compact while authoritative evidence, diagnostics, and execution lineage remain available for review.          |
| Read-only exploration and portable context | Optional exploration runs in a read-only disposable surface; cross-session handoffs carry informational history without importing execution authority.       |
| Observability and diagnostics              | Structured activity, execution evidence, status, and diagnostic tooling make orchestration inspectable without exposing task prompts in the activity stream. |

## MCP surface

The normal parent process registers exactly five MCP tools:

- `delegate_task` - run one bounded task.
- `delegate_tasks` - run sequential or parallel task batches.
- `continue_task` - resume an eligible task with an explicit follow-up.
- `routing_preflight` - after cheap bounded structural inspection, classify
  concrete candidate leaves and ask for advisory routing guidance.
- `explore` - investigate an admitted scope without changing it.

Worker processes register **no MCP tools** and cannot recurse into delegation.
The workflow coordinator and cross-session handoff helpers are programmatic
APIs, not additional MCP tools. Cross-session handoff data is informational: it
does not grant authority, retry permission, continuation rights, or a wider
compute policy.

## Safety

Delegated work runs under server-enforced compute policy and declared-scope
controls; parallel workers use isolated worktrees, and the runtime detects and
reports scope or integration conflicts. These are guardrails, not an absolute
sandbox: workers write real files, and some execution runs with the operator's
permissions. Read [Security](SECURITY.md) for the threat model and limitations.

## Benchmark status

V2 is historical architecture evidence, documented in
[bench/RESULTS.md](bench/RESULTS.md). The V3 methodology and harness are frozen
in [bench/V3_METHODOLOGY.md](bench/V3_METHODOLOGY.md), but V3 has **NOT
EXECUTED**. Therefore v0.11.0 is not claimed or proven faster, cheaper, or
better by V3.

## Documentation

- [Configuration](docs/CONFIGURATION.md) - requirements, setup, policies, and platform details.
- [Security](SECURITY.md) - threat model and trust boundaries.
- [Observability](docs/OBSERVABILITY.md) - activity, result surfaces, and privacy semantics.
- [Troubleshooting](docs/TROUBLESHOOTING.md) - diagnosis and recovery.
- [Supervisor rules](SOL_RULES.md) - delegation, effort, contracts, and review policy.
- [Roadmap](ROADMAP.md) - future priorities and constraints.
- [Changelog](CHANGELOG.md) - shipped release history.
- [Contributing](CONTRIBUTING.md) - development and release workflow.

## Contributing

Bug reports and pull requests are welcome. Start with
[Contributing](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE).
