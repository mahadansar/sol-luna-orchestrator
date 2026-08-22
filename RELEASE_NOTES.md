# Release notes — v0.8.0

This file stages the reviewed body of the **v0.8.0** GitHub Release, dated
2026-08-22. It is not a record of past releases:

- Shipped releases are recorded in [`CHANGELOG.md`](CHANGELOG.md), which is
  authoritative.
- Published release bodies live on the
  [Releases page](https://github.com/mahadansar/sol-luna-orchestrator/releases).

Staging the narrative here rather than in the changelog means the release body
can be reviewed before the tag exists. Once the release has shipped, clear this
file back to an outline: a copy of an entry that is already published only drifts
from it.

**Currently in preparation: v0.8.0, dated 2026-08-22.** Everything below is the
accepted release body for the unshipped work sitting in `main`.

---

## sol-luna-orchestrator v0.8.0 — 2026-08-22

### What this release is for

Two themes, and they are related.

The first is **being found**. Deciding well between solo work, one delegated
task, and a batch only matters if the parent gets as far as reading this
project's guidance in the first place, and in fresh sessions it often did not.
The persistent hint `init` installs used to say "consider" the orchestrator,
which turned out to do no work: a parent that never looked at the server never
saw anything to consider. It now directs the parent to discover the MCP first and
decide afterwards, against the real tool guidance rather than against a guess.

The second is **saying accurately what this thing is**. The parent was described,
and in the runtime guidance priced, as though it were specifically GPT-5.6 Sol at
high effort. It never was: the parent is model-agnostic, Sol is the creator's
example, and the worker/parent price relationship that motivated cheaper-worker
reasoning was one pair on one pricing schedule. That correction runs through the
tool descriptions, the schemas, the CLI and the documentation.

Alongside both: the activity view now covers a single delegation as well as a
batch, and rather less about a run is written to disk.

### Install

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
```

### Discovery, and what it does not promise

`init` installs a three-line managed block in the global Codex instruction file
Codex actually loads — `AGENTS.override.md` when that is non-empty, otherwise
`AGENTS.md`. Your bytes are preserved, a block you have edited is treated as
yours and left alone, `status` and `doctor` report whether the exact block is
installed, missing or modified, and `init --no-discovery-hint` opts out.

Fresh live sessions have been observed discovering the orchestrator and
consulting its guidance without the user naming this MCP or the word delegation.
That is manual, model-backed observation from a small number of runs on one
platform, and it is the strongest claim available here: a hint is guidance to a
model, and no MCP server can compel a parent to read it. The stronger wording
also does not push toward delegating — zero workers remains explicitly valid, and
a run where the parent sensibly worked solo is a pass, not a failure.

The related history is worth keeping straight, because it was previously
conflated: the benchmark runs where the model chose zero workers were routing
decisions taken with the tools named in the prompt, not discovery failures. See
[Delegation Discovery](docs/DELEGATION_DISCOVERY.md).

### A model-agnostic parent

Any compatible Codex parent with access to the configured orchestrator may
supervise. GPT-5.6 Sol at Medium is recorded as the creator's usual setting for
substantial repository work — an example, not a requirement, and not a
recommendation to run everything at High.

The runtime guidance no longer carries a fixed worker/parent price ratio.
Cheaper-worker economics are conditional on the selected parent actually being
priced above the worker under the current schedule, raw token counts are not
credit cost, more workers are not automatically cheaper, and this project has
never measured a realised saving. The one historical pricing observation that
motivated the argument is retained, labelled as such, in
[Configuration](docs/CONFIGURATION.md#cost).

Delegation semantics are unchanged in substance and clearer in wording: one
substantial bounded task can justify `delegate_task` on its own, sequential
batches are for dependent or shared-workspace work, parallel batches are for
genuinely independent tasks with disjoint declared scopes, and a batch's task
count is not its worker concurrency — that cap is now visible in the tool schema
so the parent cannot mistake one for the other.

Parent guidance also asks for silence while a call is pending and has nothing new
to report. That is guidance to the parent model and client. The server awaits
completion and cannot control what a client narrates in the meantime, so
compliance is something to confirm per parent and client, not something this
release enforces.

### Watching a run

`sol-luna-orchestrator activity` now covers a single `delegate_task` the way it
already covered a batch: queued, started, verifying, completed, failed, cancelled
and timed-out states, with batch state, mode, active and total workers, elapsed
time and peak concurrency above per-worker blocks. An optional `activityLabel` on
the task contract names each worker in that view; without one it falls back to
`Delegated task N`.

Existing event files are treated as untrusted input on read. Every line is
validated against the known shapes, malformed legacy fields are dropped rather
than believed, and strings are stripped of control characters, so a hand-edited
or truncated file cannot crash the view or rewrite the terminal it renders into.
The reducer also tolerates out-of-order and non-ISO timestamps in older files.

### Less written down

Objectives, worker prompts, task context, source code and verification command
output are excluded from the activity event stream, and task ids are opaque
rather than sliced out of the objective text — which also means worktree
directories no longer carry a fragment of the brief in their names.

This reduces exposure; it is not a privacy guarantee. The stream still records
working-directory and worktree paths, conflicting file names, concise failure
reasons and any `activityLabel` you supply, all of which can be revealing. The
diagnostic log is unchanged and remains the sensitive one: it holds objectives
and verification command output, truncated but not filtered for secrets. Only
control characters are stripped from either, which stops a crafted string forging
a log line and is not a secret filter. [Observability](docs/OBSERVABILITY.md) and
[SECURITY.md](SECURITY.md) have the details.

Deterministic tests now supply their own event sink, so running the suite can no
longer append synthetic records to the activity history or diagnostic log of the
machine it runs on.

### Unchanged

Worker scheduling, concurrency limits and defaults, the worker model, isolation,
declared-scope handling, verification policy and integration rules all behave as
before. Existing public schema fields and defaults also behave as before; the only
schema additions are `activityLabel` and the published batch `maxItems` described
above. Nothing here was measured to be faster or cheaper, and `bench/RESULTS.md`
is unchanged in its measurements: on small tasks delegating is still worse, and
no latency or token crossover has been found. Declared file scope is still
detective rather than preventive, verification still runs outside the Codex
sandbox with your permissions, and worktree isolation is still between workers
rather than between a worker and your disk.

### Links

- [README](README.md)
- [`CHANGELOG.md`](CHANGELOG.md)
- [`SECURITY.md`](SECURITY.md)
- [MIT licence](LICENSE)

Keep every claim traceable to something measured or shipped. No performance or
cost claim belongs here that `bench/RESULTS.md` does not support.
