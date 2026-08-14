# Release notes draft — v0.5.0

Draft for the first public release. Not published; paste into the GitHub Release
body when the tag is created.

---

## sol-luna-orchestrator v0.5.0

First public release. An MCP server that lets a supervising OpenAI Codex agent
delegate bounded implementation tasks to isolated worker threads, with enforced
file scopes and results the orchestrator verifies rather than takes on trust.

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
```

Then open Codex, select **GPT-5.6 Sol at High effort**, and work normally.

### What it does

**Adaptive orchestration.** The supervisor decides whether delegating is worth it
at all, then picks sequential or parallel execution. Small work stays with the
supervisor — the tool descriptions push it that way, and the benchmarks support
the choice.

**Per-task reasoning effort.** Each worker runs at an effort the supervisor
chooses for that task, from `medium` to `max`, with a stated reason. A batch of
three routinely runs at three different efforts. Importance is not difficulty.

**Sequential and parallel delegation.** Sequential shares the workspace so later
tasks see earlier changes. Parallel gives every worker its own detached git
worktree branched from `HEAD`.

**Scope and conflict protection.** A parallel batch is refused before it starts
if two tasks declare overlapping file scopes, or if the repository has
uncommitted changes inside a declared scope. Results are integrated only when no
two workers touched the same file; otherwise the worktrees are kept for manual
review.

**Verified, not trusted.** A worker's `PASS` is a claim. Verification commands
are re-run by the orchestrator, claimed edits are compared against observed ones,
and scope violations fail a task that otherwise passed. Verification commands are
parsed into argv with no shell, and only allowlisted executables may launch.

**Workers cannot delegate.** Enforced two independent ways: the worker's Codex
process starts with this server disabled, and a `SOL_LUNA_WORKER=1` marker makes
any server that does start register zero tools.

**Setup CLI.** `init`, `doctor`, `status`, `uninstall`. `init` is idempotent and
edits only the keys it owns — comments, formatting and other MCP servers in your
Codex config survive byte for byte. `doctor` runs 14 checks and prints the fix
for each failure, with `--json` for automation. `uninstall` removes one table and
verifies nothing else went missing.

**Usage telemetry.** With `SOL_LUNA_EVENTS` set, every worker's input, cached
input, output and reasoning tokens are recorded alongside its model, effort,
duration and verdict, plus worktree lifecycle and conflict events.

### What the benchmarks show

Both suites are reproducible and graded by the harness after the agent stops,
never by the agent.

- On small single-file tasks, delegating was **worse on every axis**: ~2.3x
  slower and ~3.5x the tokens, with no quality difference.
- Parallel delegation **beat sequential delegation in every task and every
  repetition** (median 155s vs 248s) and was far more consistent.
- Orchestration has **not** beaten the supervisor working alone on any fixture in
  the suite. The fixtures are small by construction, which is the regime that
  favours solo, so the crossover point is unknown rather than proven absent.
- **No token saving and no cost saving is claimed**, because none has been
  measured. Orchestration used more tokens in every measured configuration.

The value on offer is explicit delegation control, isolated workers, adaptive
effort, parallel execution, structured review and observability — not a cheaper
bill.

### Platform status

| Platform   | Deterministic CI | Live Codex delegation |
| ---------- | ---------------- | --------------------- |
| Windows 11 | Verified         | **Verified**          |
| Linux      | Verified         | Not yet run           |
| macOS      | Verified         | Not yet run           |

CI covers build, typecheck, format, unit, security, parallel-orchestration and
CLI suites, the MCP protocol handshake and benchmark fixture validation on
Node 24 and 26 across all three platforms.

### Requirements

- Node.js ≥ 22.12
- OpenAI Codex CLI, logged in. Built against `codex-cli 0.147.0`.
- git ≥ 2.20, for parallel batches only.

### Known limitations

- Scope enforcement is **detective, not preventive** — workers write real files
  and violations are caught afterwards.
- Verification runs **outside** the Codex sandbox with your user's permissions.
  This is a set of guardrails, not a sandbox. Read `SECURITY.md`.
- Integration is a file copy, not a merge, and is attempted only when worker file
  sets are disjoint.
- Parallel mode requires git, one commit, and a clean in-scope working tree.
- Built against experimental upstream surfaces; several behaviours were
  established by testing rather than from documentation, and upstream changes may
  break them.
- Live end-to-end model runs have happened on Windows only.
- Benchmarks are small and directional, not statistically significant.

### Links

- [README](https://github.com/mahadansar/sol-luna-orchestrator#readme)
- [Benchmark results and methodology](https://github.com/mahadansar/sol-luna-orchestrator/blob/main/bench/RESULTS.md)
- [Security model](https://github.com/mahadansar/sol-luna-orchestrator/blob/main/SECURITY.md)
- [Changelog](https://github.com/mahadansar/sol-luna-orchestrator/blob/main/CHANGELOG.md)

MIT licensed.
