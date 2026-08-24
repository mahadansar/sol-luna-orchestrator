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

Build, typecheck, formatting, tests, `smoke`, `smoke:cli`, `bench:validate`,
`bench:report`, and `bench:analyze` are deterministic and make no model calls.
Only the explicitly live-model scripts (`smoke:live`, `smoke:parallel`,
`smoke:isolation`, and `bench`) invoke real Codex turns; they may consume the
quota or billing associated with your Codex setup.

## Developing the MCP locally

The normal end-user setup, `sol-luna-orchestrator init`, registers the published
npm package. It does not switch that registration to a source checkout and
should not be used to switch an active checkout into local development. For
development, create an untracked `.codex/config.toml` in this repository so
Codex sessions started here override the global registration while leaving the
normal installation intact:

```toml
[mcp_servers.sol-luna-orchestrator]
command = "<absolute-path-to-node>"
args = ["<absolute-path-to-checkout>/dist/server.js"]
tool_timeout_sec = 3600
default_tools_approval_mode = "approve"
startup_timeout_sec = 30

[mcp_servers.sol-luna-orchestrator.env]
SOL_LUNA_LOG = "<codex-home>/sol-luna-orchestrator.log"
SOL_LUNA_EVENTS = "<codex-home>/sol-luna-orchestrator.events.jsonl"
SOL_LUNA_SERVER_NAME = "sol-luna-orchestrator"
```

Use absolute paths for both the Node executable and `dist/server.js`; on
Windows, forward slashes avoid TOML backslash escaping. Find Node with
`command -v node` on Linux or macOS, or `where.exe node` on Windows. Keep this
machine-specific config out of commits by following the repository's local
ignore policy (add `.codex/` to `.git/info/exclude` if it is not already
there); do not commit it.

The development loop is: change source → `npm run build` → confirm the
repo-local config points at this checkout's `dist/server.js` → start a fresh
Codex session from this repository → Codex runs the local MCP build.
`npm run build` only rebuilds the checkout; it does not change which MCP Codex
launches. After changing runtime source, run `npm run build`. After rebuilding
runtime code or changing MCP configuration, start a fresh session as required
by [Step 0 of live model-backed acceptance](#acceptance-procedure).

To verify what Codex will launch, run
`codex mcp get sol-luna-orchestrator` from this repository and inspect the
effective `command` and `args`. The server argument must be this checkout's
absolute `dist/server.js` path, not a path under a global `node_modules`.

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

| Path                          | What it is                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `src/server.ts`               | MCP server; registers `delegate_task` and `delegate_tasks`                      |
| `src/worker.ts`               | Single-worker lifecycle, concurrency slots, claim-checking                      |
| `src/batch.ts`                | Batch scheduling, integration, cleanup                                          |
| `src/worktree.ts`             | Per-task git worktree lifecycle                                                 |
| `src/git.ts`                  | Cross-platform git wrapper (argument arrays, no shell)                          |
| `src/overlap.ts`              | Scope-overlap and integration-conflict detection (pure)                         |
| `src/events.ts`               | Structured run telemetry                                                        |
| `src/command.ts`              | Verification command parsing and policy (pure)                                  |
| `src/verify.ts`               | Verification execution                                                          |
| `src/scope.ts`                | File-scope validation and workspace-boundary checks                             |
| `src/workspace.ts`            | `workingDirectory` validation                                                   |
| `src/contract.ts`             | Task contract and result schemas                                                |
| `src/prompt.ts`               | The worker's brief                                                              |
| `src/cli.ts`                  | User CLI entry (`activity`, `init`, `doctor`, `status`, `uninstall`, `version`) |
| `src/cli/activity.ts`         | Activity rendering, snapshot and `--watch` stream                               |
| `src/cli/activity-reducer.ts` | Pure event-stream reducer producing an activity snapshot                        |
| `src/cli/events-path.ts`      | Canonical resolver for the effective activity event file                        |
| `src/cli/`                    | Other CLI internals, including the surgical TOML config editor                  |
| `src/bench/`                  | Benchmark harness and fixtures                                                  |

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

## Live model-backed acceptance

The project uses deterministic verification and live/model-backed acceptance.
Deterministic verification comes first. Use the live procedure when affected
behavior cannot be established mechanically and the model-backed run has been
explicitly authorized; treat its results as observations, not guarantees.

### Deterministic verification comes first

Everything mechanical must be green before a live run is worth anyone's time:

```bash
npm run format:check
npm run build
npm run typecheck
npm test
```

Also run the model-free smoke suites, `npm run smoke` (the MCP protocol
handshake) and `npm run smoke:cli`, plus `npm run bench:validate` (benchmark
fixture validation). Record the real totals, including skips: a test skipped for
a platform permission is a skip, not a pass.

`smoke:isolation`, `smoke:parallel` and `smoke:live` are not deterministic
checks. They drive real Codex turns and spend model tokens, so they belong to
the live acceptance work below. `smoke:isolation` is the one to reach whenever a
worker appears able to delegate: it proves from the log that no orchestrator was
started for the worker, which a model's own answer never can.

What deterministic tests cannot prove is that a real parent, in a real session,
with no prompting toward this project, finds the orchestrator and makes a
sensible decision. This procedure is manual and model-backed; treat its results
as observations, not guarantees.

### Acceptance procedure

**Step 0 — rebuild, then restart the client.** Run `npm run build` first, then
fully terminate the Codex client or session and open a new one. Rebuilding
`dist/` does not reload an MCP server that is already running: Codex spawned that
process, and it keeps serving the old build until the session that owns it ends.
The same applies to `SERVER_INSTRUCTIONS`, tool descriptions and the discovery
hint — all of them are read at session start. A rebuild without a restart
silently tests the previous build.

1. **Fresh session.** Start a new Codex session, with any compatible parent model
   and whatever effort the task warrants. Confirm `sol-luna-orchestrator status`
   reports the installation configured and the discovery hint installed.
2. **Natural prompting.** Give it a genuine, substantial task that would plausibly
   benefit from bounded delegation. Do not mention this MCP, delegation, workers,
   or the tool names. If you have to hint, the run does not test discovery.
3. **Discovery.** Confirm the parent found the orchestrator and consulted its
   guidance without being pointed at it. The diagnostic log is ground truth;
   the model's own account of what tools it has is not.
4. **Routing.** Inspect the decision between solo work, `delegate_task` and
   `delegate_tasks`. Judge whether it was sensible for this task, including
   solo. Zero workers is a pass when the work did not warrant delegation; a run
   is a failure only if the decision was wrong, not if it was solo.
5. **Activity output.** If it delegated, watch `sol-luna-orchestrator activity
--watch` in a second terminal. Confirm it shows what is running, the
   `activityLabel` or its `Delegated task N` fallback, model and effort, elapsed
   time, verification state, changed-file and check summary, failures, and batch
   mode, state and concurrency. Confirm no objective or prompt text appears
   anywhere in it. Where usage is unavailable, confirm it reads as unavailable
   rather than as zero.
6. **Silence while pending.** Observe the parent while a call is in flight. It
   should stay quiet when there is no meaningful new state — no polling
   narration, no elapsed-time commentary, no "still working on it". This is
   guidance to the parent, not a server-enforced output guarantee: the server
   cannot make a client stay silent, so a chatty parent is a guidance
   observation, not a server defect.
7. **Result handling.** Confirm results, errors, cancellations and timeouts are
   each surfaced to the parent and reported by it. Silence applies to non-events
   only; every one of these must be reported.
8. **Independent parent review.** Confirm that after the worker returns, the
   parent reviews the work itself — verdict, verification outcome, observed
   changed files, discrepancies, and scope violations — rather than repeating a
   worker `PASS` as though it settled the matter.

### Recording a run

Record one entry per acceptance run using this complete template:

- **Date**:
- **Client and version**:
- **Parent model**:
- **Parent effort**:
- **Orchestrator version / commit**:
- **Worker model and effort**:
- **Discovery**: (found unprompted / needed a cue / not found)
- **Routing**: (solo / single task / batch — and whether that was the right call)
- **Silence while pending**: (held / narrated)
- **Parent review**: (independent / deferred to the worker)
- **Outcome and anything surprising**:
- **Retained evidence**: (where the event-stream excerpt and diagnostic log for
  this run are kept)

Record what happened, including a run that went badly. An acceptance log that
only contains successes is not evidence.

## Releasing

Maintainers only. Releases are published by GitHub Actions using
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers), so there is
no npm token in this repository, no publish secret, and nothing to rotate.

Before every release, perform and record a semantic documentation freshness
audit. At minimum, reconcile all of these documents with one another and with
the implementation being released:

- `CHANGELOG.md`
- `README.md`
- `ROADMAP.md`
- `SOL_RULES.md`
- `SECURITY.md`
- `docs/CONFIGURATION.md`
- `docs/TROUBLESHOOTING.md`
- `docs/OBSERVABILITY.md`
- `CONTRIBUTING.md`
- `docs/FEATURE_ACCEPTANCE.md`

Also audit `bench/RESULTS.md` when benchmark, routing, model, or performance
claims changed. Audit the root or scoped `AGENTS.md` files and
`.github/pull_request_template.md` when architecture, ownership, test selection,
security-sensitive modules, or the release workflow changed. Reconcile the
intended transient GitHub Release body against the matching `CHANGELOG.md`
entry for every release.

This final audit is a safety net, not a substitute for same-change maintenance:
material behavior, configuration, security, or CLI changes must update every
affected canonical document in the same change.

1. Bump the version and record what shipped:
   `npm version <x.y.z> --no-git-tag-version`, then add the matching
   `CHANGELOG.md` entry. Prepare and review the intended GitHub Release body
   transiently from that entry; do not commit a second release-body source.
2. Commit and push the release candidate to `main`.
3. Wait for the required CI checks to pass on that exact `main` commit.
4. Create the annotated release tag from that validated commit and push it:
   `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
5. `.github/workflows/publish.yml` fires on the tag. It refuses to continue if
   the tag does not match `package.json`, then builds, typechecks, runs the
   tests and the MCP smoke test, and publishes via OIDC.
6. npm attaches provenance automatically — the repository and package are both
   public, so `--provenance` is neither passed nor needed.
7. Only after the tag-triggered publish succeeds and the remote tag exists,
   create the GitHub Release against that existing tag. Do not create it as a
   draft. CLI automation must use
   `gh release create vX.Y.Z --verify-tag ...` so it cannot implicitly create or
   retarget a tag. Supply the reviewed body transiently; do not add a tracked
   release-notes file.

Only tags matching `vX.Y.Z` trigger a publish. Branches and pull requests never
can. Pre-release tags such as `v1.0.0-rc.1` deliberately do not match; publishing
one is a manual decision.

v0.5.0 was published manually before this was set up, so it carries no provenance
attestation. Everything from v0.5.1 onward is published this way.

## Pull requests

Say what you changed and how you verified it. If you found upstream behaviour
that differs from the documentation, put it in a comment next to the code that
depends on it — that context is the most valuable thing in this codebase.
