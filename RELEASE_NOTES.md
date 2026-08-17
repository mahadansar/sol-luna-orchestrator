# Release notes — working draft

This file stages the body of the **next** GitHub Release. It is not a record of
past releases:

- Shipped releases are recorded in [`CHANGELOG.md`](CHANGELOG.md), which is
  authoritative.
- Published release bodies live on the
  [Releases page](https://github.com/mahadansar/sol-luna-orchestrator/releases).

Drafting the narrative version here rather than in the changelog means a release
body can be written and reviewed before the tag exists. Once a release has
shipped, clear this file back to the outline below: a copy of an entry that is
already published only drifts from it.

**Currently in preparation: v0.6.0.**

---

## sol-luna-orchestrator v0.6.0

Live orchestration activity inspection, adaptive delegation onboarding, scale
benchmarks, and event stream reliability hardening.

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
```

### 1. Live orchestration activity inspection

Inspect ongoing and completed orchestration runs with:

```bash
sol-luna-orchestrator activity          # snapshot view
sol-luna-orchestrator activity --watch  # continuous live stream
sol-luna-orchestrator activity --json   # machine-readable snapshot
```

- **Truthful observability**: Exposes active batch ID, execution mode, worker
  state (`queued`, `running`, `verifying`, `completed`, `failed`, `cancelled`,
  `timedOut`), model, effort level, duration, worktree paths, verification
  results, and integration conflicts.
- **Supervisor boundary**: The MCP server cannot observe parent Sol execution
  or token usage once a delegation call finishes. While a delegation tool call is
  active, activity reports Sol as `awaiting delegation`; otherwise supervisor
  state is reported as `not observable` with `null` usage (never fabricated as
  zero or active).

### 2. Adaptive delegation onboarding

- The Quick Start now reflects normal Sol-Luna usage: after `init`, work with
  Sol naturally.
- You do not need to command Sol to act as supervisor, dictate worker counts, or
  force tool calls. Sol decides whether delegation is worthwhile.
- More agents are a tool, not an objective — the optimal number of additional
  workers can be zero.
- Explicit delegation patterns for testing and benchmarks remain available in
  advanced documentation.

### 3. Reliability and stream hardening

- **Incremental UTF-8 & partial line buffering**: The activity watcher safely
  buffers partial JSONL writes and decodes multibyte UTF-8 characters across
  read boundaries without data loss or corruption.
- **Non-TTY safety**: Screen-clearing escape sequences are disabled when output
  is piped or redirected.
- **Scale benchmark suite**: Added 4-module, 6-module, and coupled fixtures to
  evaluate crossover limits, with timestamp-derived overhead decomposition and
  `npm run bench:analyze`.

### Unchanged

- Core task contract and verification security model remain unchanged.
- Benchmark conclusions remain unchanged: orchestration has not demonstrated a
  token crossover, and parallel execution is beneficial for independent
  multi-stream tasks where wall-clock time is prioritized.

### Links

- [README](https://github.com/mahadansar/sol-luna-orchestrator#readme)
- [Changelog](https://github.com/mahadansar/sol-luna-orchestrator/blob/main/CHANGELOG.md)
- [Security policy](https://github.com/mahadansar/sol-luna-orchestrator/blob/main/SECURITY.md)
