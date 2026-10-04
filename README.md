# sol-luna-orchestrator

[![npm](https://img.shields.io/npm/v/sol-luna-orchestrator)](https://www.npmjs.com/package/sol-luna-orchestrator)
[![npm downloads](https://img.shields.io/npm/dt/sol-luna-orchestrator?logo=npm&label=downloads)](https://www.npmjs.com/package/sol-luna-orchestrator)
[![CI](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/mahadansar/sol-luna-orchestrator/actions/workflows/ci.yml)
[![M8ven Verified](https://m8ven.ai/badge/mcp/mahadansar-sol-luna-orchestrator-1k52hj)](https://m8ven.ai/mcp/mahadansar-sol-luna-orchestrator-1k52hj) <!-- m8ven-verify: 11a42c6cbe4b21f5016f5899ac006562 -->
[![Node](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](docs/CONFIGURATION.md#requirements)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Give Codex a team of workers for substantial tasks, with clear scopes and
independently checked results.

Sol plans the work and reviews the outcome. Luna workers handle bounded tasks,
with parallel work isolated in separate Git worktrees. The orchestrator checks
what actually changed, reruns verification, and returns evidence for the parent
to review. Workers cannot delegate further.

Use one worker for a focused task, sequential workers for dependent steps, or
parallel workers for independent work. Codex can also stay solo when delegation
would add more overhead than value.

## Quick start

You need Node.js 22.12 or newer and a logged-in
[OpenAI Codex CLI](https://developers.openai.com/codex).

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
sol-luna-orchestrator doctor
```

Start a fresh Codex session and work normally. Codex can discover the
orchestrator and choose when to delegate; you do not need to select workers or
call MCP tools yourself.

Watch task progress in another terminal:

```bash
sol-luna-orchestrator activity --watch
```

Use `status` to inspect setup and `doctor` to diagnose problems. For clone
installs, model settings, and advanced options, see
[Configuration](docs/CONFIGURATION.md).

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

Any compatible parent model may supervise. You can pin a worker model or opt
into automatic Luna selection, which freezes the chosen model for each server
session. See [model selection](docs/CONFIGURATION.md#worker-model-selection)
for defaults, configuration, and availability limits.

## Features

| Capability                                 | What it provides                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Adaptive orchestration                     | Choose solo, single, sequential, or parallel work within your model, effort, and concurrency limits.  |
| Isolated parallel execution                | Give independent workers separate worktrees, then check scopes and conflicts before integration.      |
| Authoritative verification                 | Check observed edits and rerun declared checks, including final batch verification after integration. |
| Bounded repair and recovery                | Allow an eligible repair or recovery attempt without uncontrolled retry chains.                       |
| Continuations and next actions             | Resume eligible work under its original contract and single-use execution authority.                  |
| Context lifecycle management               | Keep routine handoffs compact while preserving evidence and execution history for review.             |
| Read-only exploration and portable context | Investigate an admitted scope and carry informational history across sessions.                        |
| Observability and diagnostics              | Inspect progress, results, and setup without exposing task prompts in the activity stream.            |

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
[bench/RESULTS.md](bench/RESULTS.md). Benchmark V3 used the frozen
[methodology](bench/V3_METHODOLOGY.md) and completed 36/36 valid runs against the
v0.11.0 production baseline: both Solo Medium and Adaptive Medium passed all
nine tasks across two repetitions, but Adaptive delegated zero workers and was
slower and more expensive overall. The two-repetition result is directional,
not statistically significant. It motivated the post-V3 routing corrections
shipped in v0.12.0; those corrections have not been evaluated by another full
campaign, so no v0.12.0 performance improvement is claimed.

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
