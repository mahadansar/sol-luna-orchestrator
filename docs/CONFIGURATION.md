# Configuration reference

Everything the orchestrator reads, and how to change it. The
[README](../README.md) covers normal install and use; this is the full detail.

- [Requirements](#requirements)
- [Advanced installation](#advanced-installation)
- [Codex settings and environment variables](#codex-settings-and-environment-variables)
- [Activity and diagnostics logs](#activity-and-diagnostics-logs)
- [Parent model and effort](#parent-model-and-effort)
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

`sol-luna-orchestrator doctor` verifies all of this and tells you what to do
about anything missing.

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

Both of the first two settings are required and were found the hard way: Codex's
60s default tool timeout aborts every delegation mid-flight, and
`default_tools_approval_mode` must be `"approve"` — `"auto"`, despite the name,
makes non-interactive runs cancel the call.

Both env paths default to your Codex home (`$CODEX_HOME`, or `~/.codex`), so
they accumulate across projects rather than inside whichever repository you ran
`init` from. Override either with `init --log <path>` or `init --events <path>`;
a plain `init` never overwrites a path you set.

Normal `init` also adds one exact, managed discovery hint to the active global
Codex instruction file: a non-empty `$CODEX_HOME/AGENTS.override.md` when one
exists, otherwise `$CODEX_HOME/AGENTS.md` (normally `~/.codex/AGENTS.md`). It is
intentionally tiny and helps fresh chats distinguish this MCP from built-in
delegation while Codex's MCP catalog is deferred. For non-trivial work where
delegation could plausibly help, it requires the parent to discover this MCP
first and use its guidance to choose solo work, `delegate_task`, or
`delegate_tasks`; it does not require delegation, and zero workers remains
valid. The file is user-owned, so init preserves its existing bytes, migrates
the prior exact managed hint, repeated init is idempotent, and uninstall removes
only recognized exact managed blocks from either global instruction file. Use
`sol-luna-orchestrator init --no-discovery-hint` to opt out. Both
`init --dry-run` and `uninstall --dry-run` write nothing.

A fully annotated example is in [`examples/codex-config.toml`](../examples/codex-config.toml).

### Why init edits the file directly

`init` does not use `codex mcp add`. That command round-trips the whole config:
measured against codex-cli 0.147.0, adding a server deleted the comment above an
unrelated `context7` table and rewrote that server's `startup_timeout_sec = 15`
as `15.0`. `init` edits only the keys it owns, so comments, formatting, key order
and other servers survive byte for byte. Every write is atomic and leaves a
`config.toml.sol-luna-backup`.

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

| Setting                       | Value       | Why                                                                                |
| ----------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `tool_timeout_sec`            | `3600`      | Codex's 60s default aborts every real delegation                                   |
| `default_tools_approval_mode` | `"approve"` | Permits the tool without prompting. `"auto"` causes `user cancelled MCP tool call` |

### Environment variables

| Variable                          | Default                 | Purpose                                                           |
| --------------------------------- | ----------------------- | ----------------------------------------------------------------- |
| `LUNA_MODEL`                      | `gpt-5.6-luna`          | Worker model                                                      |
| `LUNA_TIMEOUT_SECONDS`            | `1800`                  | Wall-clock budget per delegated task                              |
| `LUNA_VERIFY_TIMEOUT_SECONDS`     | `600`                   | Wall-clock budget per independently rerun verification command    |
| `LUNA_SANDBOX`                    | `workspace-write`       | Codex sandbox mode for workers                                    |
| `LUNA_NETWORK_ACCESS`             | off                     | `1` allows workers network access                                 |
| `SOL_LUNA_MAX_PARALLEL`           | `3`                     | Concurrent workers; hard ceiling 8                                |
| `SOL_LUNA_WORKTREE_LINK`          | `node_modules`          | Directories linked into each worktree                             |
| `SOL_LUNA_KEEP_WORKTREES`         | `onFailure`             | `always`, `never`, or `onFailure`                                 |
| `SOL_LUNA_ALLOW_DIRTY`            | off                     | `1` permits parallel batches over uncommitted in-scope changes    |
| `SOL_LUNA_VERIFY_MODE`            | `allowlist`             | `allowlist`, `off`, or `shell` — see [Security](../SECURITY.md)   |
| `SOL_LUNA_VERIFY_ALLOW`           | —                       | Extra permitted executables, comma separated                      |
| `SOL_LUNA_VERIFY_ENV_PASSTHROUGH` | off                     | `1` stops withholding credential-shaped env vars                  |
| `SOL_LUNA_ALLOWED_ROOTS`          | —                       | Confine delegation to these directory trees                       |
| `SOL_LUNA_SERVER_NAME`            | `sol-luna-orchestrator` | **Must match** the name registered in Codex                       |
| `SOL_LUNA_WORKER`                 | set per worker          | Internal marker; a server seeing it registers zero tools          |
| `SOL_LUNA_EVENTS`                 | set by `init`           | Structured JSONL activity log, read by `activity`. Unset = no log |
| `SOL_LUNA_LOG`                    | set by `init`           | Human-readable diagnostics log. Unset in the server env = no log  |

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

#### Dated Sol-Luna unit-rate example

As of **2026-08-23**, OpenAI's official
[ChatGPT Work and Codex rate card](https://help.openai.com/en/articles/11481834-chatgpt-rate-card-business-enterprise-edu)
listed purchased credit rates per 1M tokens of 100/10/500 for GPT-5.6 Sol and
5/0.5/30 for GPT-5.6 Luna (input/cached input/output). For eligible usage paid
with purchased credits, that is a **20:1** Sol:Luna unit-rate ratio for input and
cached input and about **16.7:1** for output. The different ratios reflect
promotional Sol purchased-credit pricing available at least through 2026-11-21.
The rate card says the promotion does not change included plan usage, 5-hour or
weekly limits, or legacy credit rates.

The official API model pages separately listed Sol at $5/$0.50/$30 and Luna at
$0.20/$0.02/$1.20 per 1M tokens, a **25:1** Sol:Luna unit-price ratio for input,
cached input, and output:
[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) and
[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

This is a dated human reference only, not a bundled runtime rate card. It does
not make Sol the required parent or convert a per-token ratio into a task
saving. Aggregate task token usage and its input/cache/output mix, the selected
parent, worker count, applicable Codex or API schedule, fixed orchestration cost,
coordination and review overhead, latency and quality determine realised task
cost. Purchased-credit rates do not describe every included Plus or Pro task;
promotional, included-plan, and legacy schedules may differ. The implementation
requires the caller to supply the applicable card, and operators must re-check
official sources before relying on this example.

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
| **Linux**      | Verified         | Not yet run           | `ubuntu-latest`, GitHub-hosted                                              |
| **macOS**      | Verified         | Not yet run           | `macos-latest`, GitHub-hosted                                               |

Platform-specific behaviour is exercised by real code paths rather than mocked:
worktree tests create actual git worktrees and directory links, and the CLI tests
spawn the real binary, so each runner tests its own filesystem and process
semantics (path separators, case sensitivity, symlink support, file locking).
Windows uses junctions and `taskkill /T` for process-tree cleanup; POSIX uses
directory symlinks and process-group kills.

What that means in practice: the code paths that differ per platform are proven
on all three, but only Windows has been driven end to end with a live model.
Treat Linux and macOS as expected-to-work with the mechanics verified, rather
than as proven end to end.
