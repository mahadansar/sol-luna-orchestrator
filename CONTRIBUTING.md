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

There are three suites. `--suite micro` covers small single-file tasks, where
delegation overhead is expected to hurt; `--suite parallel` covers projects with
three independent modules; `--suite scale` covers four- and six-stream projects
plus a coupled control, and exists to test whether orchestration ever overtakes a
supervisor working alone. Keep all three: the negative results are findings, not
embarrassments to be tuned away.

`npm run bench:analyze` reports the crossover verdict across every committed
results file and spends nothing. Add a fixture to `src/bench/scale-tasks.ts` with
a matching entry in `src/bench/scale-solutions.ts`; `src/bench.test.ts` will fail
if a fixture's stream count, module list, objective and reference solution
disagree, or if it forgets to mark its own test files immutable.

Orchestrated arms are given `SOL_LUNA_MAX_PARALLEL` equal to the fixture's stream
count so that stream count, rather than the shipped default of 3, is the variable
under test. That value is recorded per run. Do not change production defaults to
improve a benchmark number.

Do not report benchmark numbers that the committed raw results in
`bench/results/` do not support.

## Releasing

Maintainers only. Releases are published by GitHub Actions using
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers), so there is
no npm token in this repository, no publish secret, and nothing to rotate.

1. Bump the version and record what shipped:
   `npm version <x.y.z> --no-git-tag-version`, then add the `CHANGELOG.md` entry
   and draft the release body in `RELEASE_NOTES.md`.
2. Commit and push to `main`.
3. Wait for CI to go green on `main`.
4. Tag the release commit and push the tag:
   `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
5. `.github/workflows/publish.yml` fires on the tag. It refuses to continue if
   the tag does not match `package.json`, then builds, typechecks, runs the
   tests and the MCP smoke test, and publishes via OIDC.
6. npm attaches provenance automatically — the repository and package are both
   public, so `--provenance` is neither passed nor needed.
7. Create the GitHub Release from the tag, using `RELEASE_NOTES.md` as the body,
   then reset that file to its template so it never describes a shipped version.

Only tags matching `vX.Y.Z` trigger a publish. Branches and pull requests never
can. Pre-release tags such as `v1.0.0-rc.1` deliberately do not match; publishing
one is a manual decision.

v0.5.0 was published manually before this was set up, so it carries no provenance
attestation. Everything from v0.5.1 onward is published this way.

## Pull requests

Say what you changed and how you verified it. If you found upstream behaviour
that differs from the documentation, put it in a comment next to the code that
depends on it — that context is the most valuable thing in this codebase.
