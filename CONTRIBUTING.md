# Contributing

Thanks for taking a look. This is a small, deliberately focused project: an MCP
server that lets one Codex agent delegate bounded work to another.

## Getting set up

Node 22.12 or newer. CI runs 24 (active LTS) and 26 (current) on Windows, Ubuntu
and macOS.

```bash
npm install
npm run build
npm test          # unit, security, parallel and CLI tests; no model calls
npm run smoke     # MCP protocol handshake, no model calls
```

`npm test` and `npm run smoke` spend nothing and should pass on a clean checkout.
Everything else in the repo touches the OpenAI API and costs money — those
scripts are named explicitly (`smoke:live`, `smoke:parallel`, `smoke:isolation`,
`bench`).

## Ground rules

**Verify against the real thing, not the documentation.** Several behaviours in
this project contradict what the docs imply — `mcp_servers={}` not isolating
workers, `default_tools_approval_mode = "auto"` cancelling every call, the SDK's
`ModelReasoningEffort` type omitting `max` that the CLI accepts. Each was found
by running it. If you change something in that area, run it.

**Don't let a model's self-report be the test.** A low-effort model will happily
claim it has a tool it does not have. The isolation test asserts against the
server's own log file for exactly this reason. Prefer ground truth: exit codes,
file hashes, process logs.

**Security changes need a regression test.** Anything touching `command.ts`,
`scope.ts`, `verify.ts` or `workspace.ts` should come with a case in
`src/security.test.ts` that fails without the fix.

## Project layout

| Path               | What it is                                                 |
| ------------------ | ---------------------------------------------------------- |
| `src/server.ts`    | MCP server; registers `delegate_task` and `delegate_tasks` |
| `src/worker.ts`    | Single-worker lifecycle, concurrency slots, claim-checking |
| `src/batch.ts`     | Batch scheduling, integration, cleanup                     |
| `src/worktree.ts`  | Per-task git worktree lifecycle                            |
| `src/git.ts`       | Cross-platform git wrapper (argument arrays, no shell)     |
| `src/overlap.ts`   | Scope-overlap and integration-conflict detection (pure)    |
| `src/events.ts`    | Structured run telemetry                                   |
| `src/command.ts`   | Verification command parsing and policy (pure)             |
| `src/verify.ts`    | Verification execution                                     |
| `src/scope.ts`     | File-scope and workspace-boundary enforcement              |
| `src/workspace.ts` | `workingDirectory` validation                              |
| `src/contract.ts`  | Task contract and result schemas                           |
| `src/prompt.ts`    | The worker's brief                                         |
| `src/cli.ts`       | User CLI entry (`init`, `doctor`, `status`, `uninstall`)   |
| `src/cli/`         | CLI internals, including the surgical TOML config editor   |
| `src/bench/`       | Benchmark harness and fixtures                             |

Pure logic lives apart from I/O on purpose. `buildDelegationResult` takes
measurements and returns a report with no side effects, which is why the
claim-checking rules are cheap to test.

## Style

- TypeScript strict mode; `npm run typecheck` must be clean.
- `npm run format` (Prettier) before opening a PR.
- Comment _why_, not _what_. Most existing comments record a non-obvious
  constraint or a behaviour that was verified experimentally — keep that bar.

## Changing the benchmark

`npm run bench:validate` proves the fixtures still discriminate: every task must
fail in its starting state and pass with the reference solution. Run it after
touching anything in `src/bench/tasks.ts` or `src/bench/parallel-tasks.ts`, and
add a reference solution (`src/bench/parallel-solutions.ts`) for any new task.

There are two suites. `--suite micro` covers small single-file tasks, where
delegation overhead is expected to hurt; `--suite parallel` covers projects with
three independent modules. Keep both: the micro suite's negative result is a
finding, not an embarrassment to be tuned away.

Do not report benchmark numbers that the committed raw results in
`bench/results/` do not support.

## Pull requests

Say what you changed and how you verified it. If you found upstream behaviour
that differs from the documentation, put it in a comment next to the code that
depends on it — that context is the most valuable thing in this codebase.
