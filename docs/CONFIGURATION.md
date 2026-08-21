# Configuration reference

Everything the orchestrator reads, and how to change it. The
[README](../README.md) covers normal install and use; this is the full detail.

- [Requirements](#requirements)
- [Advanced installation](#advanced-installation)
- [Codex settings and environment variables](#codex-settings-and-environment-variables)
- [Activity and diagnostics logs](#activity-and-diagnostics-logs)
- [Supervisor effort](#supervisor-effort)
- [Platform support](#platform-support)

---

## Requirements

- **Node.js ≥ 22.12** — tested in CI on 24 (active LTS) and 26 (current). Node 20
  and earlier are end-of-life and are neither tested nor supported.
- **OpenAI Codex CLI**, logged in (`codex login`). Built against `codex-cli 0.147.0`.
- **git ≥ 2.20** — only for parallel batches, which use `git worktree`.
- Access to `gpt-5.6-sol` and `gpt-5.6-luna`. Check with
  `codex exec -m gpt-5.6-luna "say ok"`.

`sol-luna-orchestrator doctor` verifies all of this and tells you what to do
about anything missing.

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

One table in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`):

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
| `SOL_LUNA_LOG`                    | set by `init`           | Human-readable diagnostics log. Unset in the server env = no log  |
| `SOL_LUNA_EVENTS`                 | set by `init`           | Structured JSONL activity log, read by `activity`. Unset = no log |
| `SOL_LUNA_WORKER`                 | set per worker          | Internal marker; a server seeing it registers zero tools          |

## Activity and diagnostics logs

`init` configures this for you. Every run appends structured records to the
event log: batch start and finish, each worker's start, completion, effort and
model, worktree creation and removal, verification outcomes, scope and
integration conflicts. That file is what `sol-luna-orchestrator activity` reads.

The effective path is resolved in this order, highest first:

1. `SOL_LUNA_EVENTS` in the current process — a deliberate one-off override.
2. `SOL_LUNA_EVENTS` in the registered server's `env` table, which is what
   `init` writes and the running server uses.
3. Nothing, in which case `activity` tells you to run `init`.

The default is `sol-luna-orchestrator.events.jsonl` inside your Codex home, so
the log accumulates across projects rather than landing in whichever repository
you happened to run `init` from. Choose another with
`sol-luna-orchestrator init --events /path/to/events.jsonl`, which replaces an
existing value because you asked it to; a plain `init` never overwrites a path
you set. `--log` behaves the same way for the diagnostic log. `sol-luna-orchestrator status` shows the
effective path and where it came from.

Per worker, the following are recorded exactly as the Codex SDK reports them on
`turn.completed`:

| Field                   | Meaning                                   |
| ----------------------- | ----------------------------------------- |
| `inputTokens`           | Prompt tokens for that worker's turn      |
| `cachedInputTokens`     | Portion of the input served from cache    |
| `outputTokens`          | Tokens the worker generated               |
| `reasoningOutputTokens` | Reasoning portion of the output           |
| `model`, `effort`       | Which model and effort that worker ran at |
| `durationSeconds`       | Wall-clock for that worker                |

The supervisor's own usage is not visible to this server — Codex does not report
the parent turn to an MCP server it launched. The benchmark harness records it
separately because it drives the supervisor itself. Anything unavailable is
written as `null` rather than zero, so absent data is never mistaken for free.

Both files are local and nothing is transmitted anywhere. They hold different
things, and the event log is the less sensitive of the two — see
[Logs and telemetry](../SECURITY.md#logs-and-telemetry) before sharing either.

### Cost

- **Token counts are measured.** They come from the API, per turn, per worker.
- **No currency figure is produced, by design.** Prices are not exposed through
  this integration.
- **Your Codex subscription is not a function of token counts.** Multiplying
  tokens by a public price list would produce an API-equivalent number that has
  no relationship to what you are actually billed.
- If you want an estimate, export the JSONL and apply your own pricing — the raw
  per-worker numbers are all there.
- Nothing in this project claims a cost saving, because none has been measured.

## Supervisor effort

The supervisor model is `gpt-5.6-sol`. Its effort is yours to set, not the
model's to change mid-session.

| Effort     | Use for                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `medium`   | Simple but non-trivial work whose decomposition is already obvious                                              |
| **`high`** | **Recommended.** Architecture, decomposition, delegation, review, normal multi-file engineering                 |
| `xhigh`    | Difficult architecture, subtle production bugs, cross-service reasoning, tricky concurrency, hard decomposition |
| `max`      | Exceptional supervisor-level problems only — not a routine setting                                              |

The orchestrator does not set the parent Sol effort; select it in the Codex
session. `ultra` is a separate Codex multi-agent execution mode, not another
reasoning-effort value.

## Platform support

Statuses reflect what has actually been executed, not what the code intends.

Two different things get called "supported", so they are reported separately.
**Deterministic CI** runs the build, typecheck, format check, unit, security,
parallel-orchestration and CLI suites, the MCP protocol handshake and the
benchmark fixture validation — no model access. **Live model testing** drives
real Codex sessions with real Sol and Luna turns.

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
