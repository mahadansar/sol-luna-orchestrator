# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-08-14

One-command setup, and full usage telemetry for parallel batches.

### Added

- `sol-luna-orchestrator` CLI with `init`, `doctor`, `status`, `uninstall` and
  `version`. Setup is now a single command instead of hand-editing TOML.
- Split bins: `sol-luna-orchestrator` is the user CLI, and
  `sol-luna-orchestrator-mcp` is the stdio server Codex launches. Running the
  CLI can no longer accidentally start a server that waits forever on a pipe.
- `doctor` checks Node, git, Codex, authentication, registration, the resolved
  server path, both required settings, verification mode and logging — each with
  the command that fixes it. `--json` for automation. No model calls.
- `init` is idempotent: it inspects first, repairs only what is wrong, and
  reports `Already configured` otherwise. `--dry-run`, `--force`, `--log`.
- `init` refuses to register an install running from an npx cache, which npm can
  evict, leaving a config that breaks silently later (`--allow-ephemeral` to
  override).
- A surgical TOML editor that changes only the keys this project owns, keeping
  comments, formatting, key order and unrelated tables byte-identical.
- Batch worker telemetry now records full usage (input, cached input, output and
  reasoning tokens) plus model and effort, not output tokens alone.
- CLI lifecycle smoke test (`npm run smoke:cli`) covering eight scenarios against
  a real Codex CLI and isolated `CODEX_HOME` directories. No model calls.

### Changed

- Registration no longer uses `codex mcp add` / `codex mcp remove`. Measured
  against codex-cli 0.147.0, adding a server round-trips the whole config: it
  deleted the comment above an unrelated `context7` table and rewrote that
  server's `startup_timeout_sec = 15` as `15.0`. Editing only our own keys avoids
  mutating configuration that belongs to other tools.
- Published package excludes tests, benchmarks and smoke scripts.

### Fixed

- TOML basic-string escapes (`\n`, `\t`, `\uXXXX`) were decoded as their literal
  letter, so a quoted table name did not survive a read/write round trip.

## [0.3.0] - 2026-08-14

Parallel orchestration.

### Added

- `delegate_tasks`: several task contracts in one call, `mode: "parallel"` or
  `mode: "sequential"`. Each task keeps its own effort, so one batch routinely
  mixes `medium`, `high` and `xhigh` workers.
- Git worktree isolation for parallel batches. Each worker gets a detached
  worktree under `.sol-luna/worktrees/<task-id>`, excluded via
  `.git/info/exclude` rather than the user's tracked `.gitignore`.
- Dependency directories (`node_modules` by default,
  `SOL_LUNA_WORKTREE_LINK`) are linked into each worktree — junctions on
  Windows, directory symlinks elsewhere — without which no verification command
  could resolve its imports.
- Scope overlap detection: a parallel batch is refused before any worker starts
  if two tasks could match the same files.
- Integration conflict detection from what workers _actually_ changed. When two
  workers touch the same file nothing is merged and both worktrees are kept.
- Dirty-tree guard: parallel batches are refused when the repository has
  uncommitted changes inside a declared task scope, since workers branch from
  `HEAD` and would neither see nor preserve that work
  (`SOL_LUNA_ALLOW_DIRTY=1` to override).
- Concurrency limit shared by both tools (`SOL_LUNA_MAX_PARALLEL`, default 3,
  hard ceiling 8); excess tasks queue rather than failing.
- Cancellation via the MCP request signal, propagated to worker Codex processes,
  with worktree cleanup. Stale worktrees from a crashed run are pruned, and only
  ones this project created.
- Structured telemetry (`SOL_LUNA_EVENTS`): batch, worker, worktree,
  verification, scope and integration events as JSONL.
- Parallel benchmark suite (`--suite parallel`) with four arms: Sol high solo,
  Sol xhigh solo, Sol high + sequential Luna, Sol high + parallel Luna.
- GitHub Actions CI across Windows, Linux and macOS on Node 20 and 24. No model
  access required.
- Supervisor effort documented as configurable (`medium` / `high` / `xhigh` /
  `max`, `high` recommended).

### Changed

- The single-worker lock became a shared concurrency semaphore. `delegate_task`
  is unchanged from a caller's point of view and still runs directly in the
  workspace with no git requirement.
- Tool descriptions now push the supervisor to decide _whether_ delegating is
  worthwhile, citing the measured micro-benchmark result.

### Fixed

- A task that completed was marked `cancelled` if the batch was cancelled while
  it ran, discarding finished work. Only genuinely interrupted tasks are
  cancelled now.
- Scope overlap between a deep pattern and an extension pattern
  (`src/auth/**` vs `src/**/*.ts`) was missed, because expanded example paths
  carried no file extension.
- `SOL_LUNA_VERIFY_ALLOW` split on `:` and `;`, mangling Windows paths such as
  `C:\tools\runner.exe`. It is comma-separated only.

## [0.2.0] - 2026-08-14

First public release.

### Added

- Verification execution policy (`SOL_LUNA_VERIFY_MODE`): `allowlist` (default),
  `off`, `shell`. The default parses commands into argv with no shell and only
  launches allowlisted executables.
- Credential-shaped environment variables are withheld from verification
  commands (`SOL_LUNA_VERIFY_ENV_PASSTHROUGH=1` to opt out).
- `SOL_LUNA_ALLOWED_ROOTS` confines delegation to specific directory trees.
- Escalation metadata: `taskCategory`, `previousAttempts`, and an `attempt`
  counter plus `escalationAdvice` in the result.
- `SOL_LUNA_EVENTS` writes one JSONL record per delegation (effort, verdict,
  duration, token usage).
- Benchmark harness (`npm run bench`) comparing a solo supervisor against a
  supervisor that delegates, with fixture validation (`bench:validate`) proving
  each task discriminates.
- Security regression suite (`src/security.test.ts`).

### Fixed

- **Symlink escape.** Scope checks compared lexical paths, so a symlink inside
  the workspace pointing outside it looked contained. Paths are now resolved
  through symlinks before comparison.
- **Shell injection surface.** `verificationCommands` were previously executed
  with `shell: true`, so a model-supplied string could chain arbitrary commands.
- **Process-tree leak.** A timed-out verification killed only the direct child,
  orphaning grandchildren (`npm` → `node` → test runner).
- **Case-insensitive scope bypass on macOS.** Glob matching was only
  case-insensitive on Windows, so `SRC/x.ts` could pass an `src/**` rule on a
  case-insensitive macOS filesystem.
- Unvalidated `workingDirectory` is now required to be an absolute path to an
  existing directory.
- A worker `PASS` resting on a command that was refused or skipped is now
  reported as unverified rather than silently accepted.

## [0.1.0] - 2026-08-14

Initial working version, verified end to end.

### Added

- `delegate_task` MCP tool: bounded delegation from a `gpt-5.6-sol` supervisor to
  an isolated `gpt-5.6-luna` worker thread.
- Dynamic worker effort (`medium` / `high` / `xhigh` / `max`), defaulting to
  `high`, with a required `effortReason`.
- Task contract: objective, allowed/forbidden files, acceptance criteria,
  verification commands.
- Independent re-running of verification commands after the worker exits, with
  cross-checking of the worker's claims against runtime-observed file changes.
- Worker isolation via `mcp_servers.<name>.enabled=false` plus a
  `SOL_LUNA_WORKER=1` environment backstop.
- Structured `PASS` / `BLOCKED` / `FAILED` results with discrepancies, scope
  violations, a review checklist, and the worker thread id.

### Notes

- `--config mcp_servers={}` does not isolate workers: Codex merges the override
  and every server still starts. Verified against codex-cli 0.147.0.
- Codex requires `tool_timeout_sec` well above its 60s default, and
  `default_tools_approval_mode = "approve"` (not `"auto"`), or delegation is
  cancelled.

[Unreleased]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/mahadansar/sol-luna-orchestrator/releases/tag/v0.4.0
[0.3.0]: https://github.com/mahadansar/sol-luna-orchestrator/releases/tag/v0.3.0
[0.2.0]: https://github.com/mahadansar/sol-luna-orchestrator/releases/tag/v0.2.0
[0.1.0]: https://github.com/mahadansar/sol-luna-orchestrator/releases/tag/v0.1.0
