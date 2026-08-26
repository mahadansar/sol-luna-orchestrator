# Configuration reference

Everything the orchestrator reads, and how to change it. The
[README](../README.md) covers normal install and use; this is the full detail.

- [Requirements](#requirements)
- [Advanced installation](#advanced-installation)
- [Discovery hint and adaptive routing](#discovery-hint-and-adaptive-routing)
- [Cheap routing preflight](#cheap-routing-preflight)
- [Codex settings and environment variables](#codex-settings-and-environment-variables)
- [Activity and diagnostics logs](#activity-and-diagnostics-logs)
- [Parent model and effort](#parent-model-and-effort)
- [Metadata and thin result fast path](#metadata-and-thin-result-fast-path)
- [Platform support](#platform-support)

---

## Requirements

- **Node.js ≥ 22.12** — tested in CI on 24 (active LTS) and 26 (current). Node 20
  and earlier are end-of-life and are neither tested nor supported.
- **OpenAI Codex CLI**, logged in (`codex login`). Built against `codex-cli 0.147.0`.
- **git ≥ 2.20** — only for parallel batches, which use `git worktree`.
- Access to a compatible parent Codex model and the configured worker model
  `gpt-5.6-luna`. The creator's examples are `gpt-5.6-sol` for the parent and
  `gpt-5.6-luna` for workers; compatible parent models are allowed.

`sol-luna-orchestrator doctor` checks the supported Node range, git and Codex
availability, the presence of Codex's local authentication file, registration,
owned settings, and runtime policy, then prints remedies. It does not validate
git's numeric minimum or make a network call to prove the stored credentials
are currently usable.

Some required Codex behaviors are experimental surfaces established by testing
rather than documented stable APIs. This release was built against
`codex-cli 0.147.0`; upstream changes may require a compatibility update even
when the local Node.js and git requirements are satisfied.

## Advanced installation

`init` is the supported path. These notes are for people who want to know what it
does, or who prefer to do it themselves.

### From a clone

```bash
git clone https://github.com/mahadansar/sol-luna-orchestrator.git
cd sol-luna-orchestrator
npm install && npm run build
node dist/cli.js init
```

### What init writes

One table in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) plus the
managed discovery hint in `$CODEX_HOME/AGENTS.md` (described below):

```toml
[mcp_servers.sol-luna-orchestrator]
command = "/path/to/node"
args = ["/path/to/sol-luna-orchestrator/dist/server.js"]
tool_timeout_sec = 3600                   # default is 60s; delegations take minutes
default_tools_approval_mode = "approve"   # "auto" does NOT work here
startup_timeout_sec = 30

[mcp_servers.sol-luna-orchestrator.env]
SOL_LUNA_LOG = "/path/to/codex-home/sol-luna-orchestrator.log"
# Structured activity events, read by `sol-luna-orchestrator activity`.
SOL_LUNA_EVENTS = "/path/to/codex-home/sol-luna-orchestrator.events.jsonl"
```

Both env paths default to your Codex home (`$CODEX_HOME`, or `~/.codex`), so
they accumulate across projects rather than inside whichever repository you ran
`init` from. Override either with `init --log <path>` or `init --events <path>`;
a plain `init` never overwrites a path you set.

A fully annotated example is in [`examples/codex-config.toml`](../examples/codex-config.toml).

### Discovery hint and adaptive routing

Fresh sessions can fail to discover the orchestrator before they ever evaluate
whether delegation is useful. That is different from a session that has the
tools and chooses to work solo. The discovery hint exists to make the routing
decision informed; it does not make delegation mandatory.

Normal `init` adds one exact, managed discovery hint to the active global Codex
instruction file: a non-empty `$CODEX_HOME/AGENTS.override.md` when one exists,
otherwise `$CODEX_HOME/AGENTS.md` (normally `~/.codex/AGENTS.md`). The hint tells
the parent:

> For non-trivial work where delegation could plausibly help, first discover the
> configured sol-luna-orchestrator MCP and use its guidance to decide between
> solo work, delegate_task, or delegate_tasks. Do not substitute Codex built-in
> delegation. Zero workers is valid.

Discovery comes before the routing decision so the parent can use the
orchestrator's actual scoping, verification and isolation guidance. The parent
may still choose solo work when that is right; zero workers remains a valid
outcome. This is guidance to a model, not a deterministic guarantee that a
parent will read the hint.

The instruction file is user-owned. `init` preserves its existing bytes,
migrates the prior exact managed hint, and is idempotent. A block you edit is
treated as your content and left alone. `uninstall` removes only recognized
exact managed blocks from either global instruction file. Use
`sol-luna-orchestrator init --no-discovery-hint` to opt out. Both
`init --dry-run` and `uninstall --dry-run` write nothing. `status` reports
whether the hint is installed, missing or modified; `doctor` checks it and
prints the command that repairs a missing or incorrect setup.

### Cheap routing preflight

The runtime advertises an optional advisory tool, `routing_preflight`, and an
optional `routingPreflight` card on `delegate_task` and `delegate_tasks`. The
parent declares the seams it is considering and what they share; the runtime
evaluates that declaration with a pure synchronous function — no filesystem,
process, network, model call, or repository analysis — and answers before any
exploration has been paid for.

Nothing about this is required. With no card attached, behavior is exactly what
it was before the feature existed, and the telemetry simply records the
declaration as `absent`. Calling `routing_preflight` and then delegating nothing
is a normal successful outcome.

Any declared field may be `unknown`. Unknown biases the _advice_ toward staying
solo but can never produce a structural refusal, because refusals read the raw
declaration only. The runtime refuses only an empty seam list, and — in parallel
mode alone — explicitly declared mutable shared state, an explicitly declared
shared core, or more tasks than declared seams. Those parallel gates are enforced
before any worktree is created. `allowOverlappingScopes: true` downgrades the
shared-core gate to a warning and never downgrades mutable shared state.
Everything else is advice the parent may override; see
[SOL_RULES.md](../SOL_RULES.md#cheap-routing-preflight) for the full route table.

Routing is independent of compute policy. It never reads, outputs, or selects
worker effort, never recommends a worker count, and never changes `maxParallel`
or any concurrency behavior. `parallelEligible` is a structural boolean only, and
`seams.length` describes separability rather than a worker target.

### Metadata and thin result fast path

The MCP registration advertises a compact routing card and bounded input
metadata. Output schemas are intentionally not advertised in tool metadata, and
the advertised input schemas reuse the exact runtime validators/defaults without
repeating per-field prose — the optional `routingPreflight` card is the single
deliberate exception, because it is the only optional input that can refuse a
delegation and the parent has to be able to see that from the schema.
Deterministic metadata-size budgets protect this boundary.

Every budget is checked against the schema the server actually registers.
`advertisedTotal` is the honest ceiling: instructions, all four tool
descriptions, and all four input schemas, with the routing card included where it
is really advertised. `delegationContract` and `routingCombined` split that same
total by owner so a regression can be attributed to the delegation protocol or to
routing, and they sum to it exactly — no ceiling is reached by excluding one
advertised surface from another. The routing card is advertised on both
delegation tools whether or not a call uses it, so its cost is counted on both.
A routing advisory that prevents one unnecessary delegation must stay materially
cheaper than that delegation would have been, so the surface is kept deliberately
small. Advisory routing output is one compact line on a delegation result, and is
omitted entirely when routing has nothing to add — the thin verified handoff is
unaffected.

Clean verified PASS text is a thin handoff with identity, changed paths,
authoritative verification counts, integration status, continuation reference,
and actionable risks. Rich diagnostics remain for any suspicious or incomplete
result. `resultDetail: "handoff"` is the default and omits `structuredContent`
only on that clean fast path. `compact` and `full` explicitly retain the existing
structured compatibility forms; a suspicious or failed default result expands
automatically. These are context and routing controls; no measured cost or
latency saving is claimed. Same-thread continuation prompts carry only the
bounded follow-up and an immutable-contract reminder.

After a batch is integrated (or a sequential batch finishes in its shared
workspace), the runtime reruns the deduplicated union of all declared
`verificationCommands` there. Only complete executed passes produce
`completionState: "verified-complete"` and `TERMINAL: VERIFIED_COMPLETE`.
No declared commands, policy refusal, disabled verification, a failed command,
or incomplete execution produces `needs-supervisor` and keeps diagnostic
evidence. This final pass uses the same verification mode, allowlist, timeout,
credential filtering, and operator permissions shown below.

### Why init edits the file directly

`init` does not use `codex mcp add`. That command round-trips the whole config:
measured against codex-cli 0.147.0, adding a server deleted the comment above an
unrelated `context7` table and rewrote that server's `startup_timeout_sec = 15`
as `15.0`. `init` edits only the keys it owns, so comments, formatting, key order
and other servers survive byte for byte. Every write is atomic and leaves a
`config.toml.sol-luna-backup` when an existing config is replaced. The separate
discovery-hint write is also atomic but does not create a backup.

### Installing without a global install

`npx sol-luna-orchestrator init` works, but `init` will refuse to register a
package running from an npx cache: npm can evict that directory, leaving a Codex
config that points at nothing. Install it properly, or pass `--allow-ephemeral`
if you understand the trade.

## Codex settings and environment variables

Configuration comes from you: the Codex config `init` writes on your behalf, and
environment variables you set yourself. **The model never gets to change any of
it** — a worker cannot widen its own scope, relax verification or raise its
concurrency. That separation is the core of the security model.

### Required Codex settings

The annotated table under [What init writes](#what-init-writes) is the single
authoritative presentation of the required keys, values, and failure rationale.
`init` reconciles those owned values and `doctor` diagnoses either mismatch.

### Environment variables

| Variable                          | Default                 | Purpose                                                           |
| --------------------------------- | ----------------------- | ----------------------------------------------------------------- |
| `LUNA_MODEL`                      | `gpt-5.6-luna`          | Worker model                                                      |
| `LUNA_TIMEOUT_SECONDS`            | `1800`                  | Wall-clock budget per worker turn                                 |
| `LUNA_VERIFY_TIMEOUT_SECONDS`     | `600`                   | Wall-clock budget per independently rerun verification command    |
| `LUNA_SANDBOX`                    | `workspace-write`       | Codex sandbox mode for workers                                    |
| `LUNA_NETWORK_ACCESS`             | off                     | `1` allows workers network access                                 |
| `SOL_LUNA_MAX_PARALLEL`           | `3`                     | Concurrent workers; hard ceiling 8                                |
| `SOL_LUNA_WORKTREE_LINK`          | `node_modules`          | Directories linked into each worktree                             |
| `SOL_LUNA_KEEP_WORKTREES`         | `onFailure`             | Parallel-task retention: `always`, `never`, or `onFailure`        |
| `SOL_LUNA_ALLOW_DIRTY`            | off                     | `1` permits parallel batches over uncommitted in-scope changes    |
| `SOL_LUNA_VERIFY_MODE`            | `allowlist`             | `allowlist`, `off`, or `shell` — see [Security](../SECURITY.md)   |
| `SOL_LUNA_VERIFY_ALLOW`           | —                       | Extra permitted executables, comma separated                      |
| `SOL_LUNA_VERIFY_ENV_PASSTHROUGH` | off                     | `1` stops withholding credential-shaped env vars                  |
| `SOL_LUNA_ALLOWED_ROOTS`          | —                       | Confine delegation to these directory trees                       |
| `SOL_LUNA_SERVER_NAME`            | `sol-luna-orchestrator` | **Must match** the name registered in Codex                       |
| `SOL_LUNA_WORKER`                 | set per worker          | Internal marker; a server seeing it registers zero tools          |
| `SOL_LUNA_EVENTS`                 | set by `init`           | Structured JSONL activity log, read by `activity`. Unset = no log |
| `SOL_LUNA_LOG`                    | set by `init`           | Human-readable diagnostics log. Unset in the server env = no log  |

`LUNA_SANDBOX` accepts `read-only`, `workspace-write` and
`danger-full-access`. Keep the default `workspace-write` for normal use.
`danger-full-access` disables Codex filesystem sandboxing for Luna and is only
appropriate as an explicit trusted-machine workaround, such as for a diagnosed
[Ubuntu AppArmor/bwrap compatibility failure](TROUBLESHOOTING.md#luna-commands-fail-with-bwrap--rtm_newaddr-on-ubuntu).
The orchestrator's scope and evidence controls remain active, but they do not
replace filesystem confinement. After changing an MCP environment value, close
the current Codex session and open a new one so the server reloads it.

Every variable above configures this orchestrator and its workers. None of them
reaches the parent — the parent model and effort are set in your Codex session,
as described under [Parent model and effort](#parent-model-and-effort).

**Batch size is not worker concurrency.** `MAX_BATCH_SIZE` is an implementation
constant, currently `12`: the most tasks one `delegate_tasks` contract accepts,
however they are scheduled. It is published as `maxItems` on the tool's schema
and rejected again at runtime. `SOL_LUNA_MAX_PARALLEL` is a different thing:
sequential mode runs one task at a time whatever the batch size, and parallel
mode runs at most `SOL_LUNA_MAX_PARALLEL` at once — default 3, hard ceiling 8 —
and queues the rest. A 12-task batch never means 12 simultaneous workers.

### Automatic recovery

`delegate_tasks` has a batch-level `automaticRecovery` boolean that defaults to
`true`; set it to `false` to opt out. It affects only parallel batches and only
after the initial worker window. Each eligible failed task receives at most one
additional turn in its existing owned worktree: timeouts resume the same thread,
and a worker-process failure with no result starts one fresh thread. Effort,
scope, acceptance, verification commands, batchId, and taskId remain unchanged.
Successful tasks and cancellation, scope/security/evidence, refused-verification,
contract-discrepancy, and integration-conflict cases are not retried.

### Worktree retention

`SOL_LUNA_KEEP_WORKTREES` applies only to the isolated worktrees created for
parallel batches. A single `delegate_task` and a sequential batch run directly
in the requested workspace and create no orchestrator-managed task worktree.

The configured mode has final precedence over every reason that might make an
isolated worktree useful:

| Mode        | Finalization behavior                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onFailure` | Retains a worktree when the final verdict is `FAILED` or `BLOCKED`, the task is cancelled or times out, final evidence cannot be read, or integration is conflicted, partial, failed, disabled, or not attempted. A clean completed `PASS` whose state is integrated or needs no integration is removed. |
| `always`    | Retains every parallel task worktree at finalization.                                                                                                                                                                                                                                                    |
| `never`     | Performs no intentional retention. It attempts to remove every parallel task worktree after capturing all obtainable structured result, conflict, integration, and cleanup evidence. This overrides diagnostic, failure, conflict, `integrate:false`, evidence-failure, and continuation retention.      |

`always` and `onFailure` describe finalization, not permanent archival. A
retained worktree needed by an unused or executing continuation has a bounded
persistent lease. Other retained worktrees are unleased and may be removed by a
later batch's stale-worktree pruning. If deletion itself fails, the path may
physically remain under any mode; that is reported as a cleanup failure, not as
policy retention.

Continuation eligibility follows the directory that remains truthful after
cleanup. When completed worker state was copied into the requested workspace,
an eligible result can receive a workspace-bound continuation under all three
modes. When a continuation requires an unintegrated isolated worktree, it is
issued only under `onFailure` or `always`, only if that path survived cleanup,
and only after its persistent lease was refreshed. Under `never` the worktree is
removed, the continuation reference is omitted, and its lease is released.

## Activity and diagnostics logs

Detailed information about the diagnostic log (`SOL_LUNA_LOG`), the structured event stream (`SOL_LUNA_EVENTS`), privacy implications, and telemetry representations can be found in [Observability](OBSERVABILITY.md).

The effective log paths are resolved in this order, highest first:

1. `SOL_LUNA_EVENTS` / `SOL_LUNA_LOG` in the current process — a deliberate one-off override.
2. `SOL_LUNA_EVENTS` / `SOL_LUNA_LOG` in the registered server's `env` table, which is what `init` writes and the running server uses.
3. Nothing, in which case `activity` tells you to run `init`.

The default is `sol-luna-orchestrator.events.jsonl` inside your Codex home, so
the log accumulates across projects rather than landing in whichever repository
you happened to run `init` from. Choose another with
`sol-luna-orchestrator init --events /path/to/events.jsonl`, which replaces an
existing value because you asked it to; a plain `init` never overwrites a path
you set. `--log` behaves the same way for the diagnostic log.

`sol-luna-orchestrator status` shows the effective path and where it came from.
The CLI and the server are separate processes: exporting `SOL_LUNA_EVENTS` in
the shell you run the CLI from changes what the CLI reads, not what the
already-running server writes. When the two disagree, the running server and
the file it is actually appending to are the evidence — which is why `status`
reports the registered server's value rather than only this shell's.

### Cost

- **Token counts are measured.** They come from the API, per turn, per worker.
- **P1.0 provides a pure, post-hoc calculation foundation.** The calculation
  applies a caller-supplied rate card to explicitly supplied, billing-ready
  observed usage. The caller must provide complete uncached-input, cached-input,
  cache-write-input, and output quantities rather than passing raw SDK totals. It
  is not an invoice, estimate, forecast, or account statement.
- **Parent identity is unknown by default.** A known identity must come from
  explicit supported, controller, or request-scoped evidence. The project does
  not infer it from client versions, sessions, environment variables, or process
  heuristics.
- **Billing contexts remain distinct.** API, purchased Codex credits, included
  subscription usage, legacy arrangements, other arrangements, and unknown are
  separate categories. A promotion is a temporary rate card for one of those
  underlying contexts, not a billing context of its own. API prices and Codex
  credit rates are not interchangeable.
- **Rate cards are caller-owned evidence.** A usable card carries its source URL,
  retrieval time, exact model/billing-context applicability, effective bounds,
  freshness bound, rate basis, charge unit, and per-meter rates. Promotional
  pricing is represented by those rate-card fields while the underlying billing
  context remains unchanged. Currency and credit units remain distinct. No current
  prices are bundled and no live retrieval or account lookup is performed.
- **Calculation is eligibility-gated.** Only complete finite, nonnegative,
  post-hoc inputs with a known applicable identity, known billing context,
  effective/current rate card, and rates for every nonzero usage meter produce a
  quantitative result. Otherwise the result is qualitative/unavailable with a
  stable reason code.
- Nothing in this project claims a cost saving, because none has been measured.

Benchmark V2 is a separate, reproducible experiment: each schema-4 result embeds
the dated official Codex credit-rate snapshot used to calculate
`rateCardCredits`, while `actualCredits` stays unknown unless authoritative
per-run billing is available. That benchmark snapshot is not a production
default or account lookup. See [`bench/RESULTS.md`](../bench/RESULTS.md).

#### Dated Sol-Luna unit-rate example

As of **2026-08-24**, the official API model pages listed Sol at $4/$0.40/$20
and Luna at $0.20/$0.02/$1.20 per 1M tokens (input/cached input/output). That is
a **20:1** Sol:Luna API unit-price ratio for input and cached input and about
**16.7:1** for output:
[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) and
[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

Codex credit rates are a separate billing context and cannot be derived from
those API prices. They depend on the plan and rate card applicable to the
account; operators must consult that current official rate card rather than
reusing this API ratio.

Benchmark V2 specifically snapshots the ChatGPT Plus Codex rate card linked in
[`bench/RESULTS.md`](../bench/RESULTS.md); it must not reuse the separate
Business/Enterprise purchased-credit promotional schedule. Its live campaign
also requires normal/standard Codex speed with Fast mode disabled. The installed
SDK cannot pin or observe a service tier, so this remains an operator-confirmed
pre-run account condition recorded in schema-4 campaign metadata.

This is a dated human reference only, not a bundled runtime rate card. It does
not make Sol the required parent or convert a per-token ratio into a task
saving. Aggregate task token usage and its input/cache/output mix, the selected
parent, worker count, applicable Codex or API schedule, fixed orchestration cost,
coordination and review overhead, latency and quality determine realised task
cost. Purchased-credit rates do not describe every included Plus or Pro task;
Codex credit, included-plan, promotional, and legacy schedules may differ from
the API. The implementation requires the caller to supply the applicable card,
and operators must re-check official sources before relying on this example.

## Parent model and effort

The parent model is yours to choose; the orchestrator does not require a
particular model. Creator experience, documented as examples rather than
requirements: `gpt-5.6-sol` at `medium` is commonly sufficient for substantial
repository work, while `gpt-5.6-luna` at `high` has successfully handled simpler
docs and maintenance work and can delegate bounded Luna work. The effort is
yours to set, not the model's to change mid-session.

| Effort   | Use for                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| `medium` | The creator's usual setting; simple through substantial work with clear decomposition                           |
| `high`   | Heavier work requiring more architecture, decomposition, delegation, or review                                  |
| `xhigh`  | Difficult architecture, subtle production bugs, cross-service reasoning, tricky concurrency, hard decomposition |
| `max`    | Exceptional supervisor-level problems only — not a routine setting                                              |

The orchestrator does not set the parent effort. Choose the effort the work
warrants; the creator usually uses `medium` and selects `high` for heavier work.
`ultra` is a separate Codex multi-agent execution mode, not another
reasoning-effort value.

## Platform support

Statuses reflect what has actually been executed, not what the code intends.

Two different things get called "supported", so they are reported separately.
**Deterministic CI** runs the build, typecheck, format check, unit, security,
parallel-orchestration and CLI suites, the MCP protocol handshake and the
benchmark fixture validation — no model access. **Live model testing** drives
real Codex sessions with real parent and Luna turns.

| Platform       | Deterministic CI | Live Codex delegation | Notes                                                                       |
| -------------- | ---------------- | --------------------- | --------------------------------------------------------------------------- |
| **Windows 11** | Verified         | **Verified**          | Single + parallel delegation, worktree lifecycle, CLI lifecycle, benchmarks |
| **Linux**      | Verified         | **Verified**          | Ubuntu acceptance used the trusted-development sandbox workaround below     |
| **macOS**      | Verified         | Not yet run           | `macos-latest`, GitHub-hosted                                               |

Platform-specific behaviour is exercised by real code paths rather than mocked:
worktree tests create actual git worktrees and directory links, and the CLI tests
spawn the real binary, so each runner tests its own filesystem and process
semantics (path separators, case sensitivity, symlink support, file locking).
Windows uses junctions and `taskkill /T` for process-tree cleanup; POSIX uses
directory symlinks and process-group kills.

What that means in practice: the code paths that differ per platform are proven
on all three. Windows and Linux have also been driven end to end with live
models; macOS has not. The accepted Ubuntu host could not run nested Codex
`workspace-write` workers because AppArmor blocked the required bwrap/user-
namespace setup, so its repo-local development MCP explicitly used
`LUNA_SANDBOX=danger-full-access`. That is live product evidence under a
qualified trusted-development configuration, not proof that the normal Luna
sandbox works on every Linux host. See [Troubleshooting](TROUBLESHOOTING.md#luna-commands-fail-with-bwrap--rtm_newaddr-on-ubuntu).
