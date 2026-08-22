# Live Acceptance

Two kinds of verification, and only one of them can be automated. This document
covers the second.

## Deterministic verification comes first

Everything mechanical is checked without a model, and must be green before a live
run is worth anyone's time:

```bash
npm run format:check
npm run build
npm run typecheck
npm test
```

Plus the two model-free smoke suites, `npm run smoke` (the MCP protocol
handshake) and `npm run smoke:cli`, and `npm run bench:validate` (benchmark
fixture validation). Together these cover contracts, guidance invariants, scope
and verification enforcement, worktree lifecycle, the handshake and the CLI.
Record the real totals, including skips: a test skipped for a platform
permission is a skip, not a pass.

`smoke:isolation`, `smoke:parallel` and `smoke:live` are **not** in that set —
they drive real Codex turns and spend model tokens. They belong with the live
acceptance work below, not with the deterministic checks. `smoke:isolation` is
the one to reach for whenever a worker appears able to delegate: it proves from
the log that no orchestrator was started for the worker, which a model's own
answer never can.

What deterministic tests cannot prove is that a real parent, in a real session,
with no prompting toward this project, finds the orchestrator and makes a sensible
decision. That is what the procedure below is for. It is manual and
model-backed — treat its results as observations, not guarantees.

## Acceptance procedure

**Step 0 — rebuild, then restart the client.** Run `npm run build` first, then
**fully terminate the Codex client or session and open a new one**. Rebuilding
`dist/` does not reload an MCP server that is already running: Codex spawned that
process, and it keeps serving the old build until the session that owns it ends.
The same applies to `SERVER_INSTRUCTIONS`, tool descriptions and the discovery
hint — all of them are read at session start. A rebuild without a restart
silently tests the previous build.

1. **Fresh session.** Start a new Codex session, with any compatible parent model
   and whatever effort the task warrants. Confirm `sol-luna-orchestrator status`
   reports the installation configured and the discovery hint installed.
2. **Natural prompting.** Give it a genuine, substantial task that would plausibly
   benefit from bounded delegation. **Do not** mention this MCP, delegation,
   workers, or the tool names. If you have to hint, the run does not test
   discovery.
3. **Discovery.** Confirm the parent found the orchestrator and consulted its
   guidance without being pointed at it. The diagnostic log is ground truth here;
   the model's own account of what tools it has is not.
4. **Routing.** Inspect the decision between solo work, `delegate_task` and
   `delegate_tasks`. Judge whether the decision was sensible for this task —
   **including solo.** Zero workers is a pass when the work did not warrant
   delegation; a run is a failure only if the decision was wrong, not if it was
   solo.
5. **Activity output.** If it delegated, watch `sol-luna-orchestrator activity
--watch` in a second terminal. Confirm it shows what is running, the
   `activityLabel` or its `Delegated task N` fallback, model and effort, elapsed
   time, verification state, changed-file and check summary, failures, and batch
   mode, state and concurrency. Confirm no objective or prompt text appears
   anywhere in it. Where usage is unavailable, confirm it reads as unavailable
   rather than as zero.
6. **Silence while pending.** Observe the parent while a call is in flight. It
   should stay quiet when there is no meaningful new state — no polling
   narration, no elapsed-time commentary, no "still working on it". Note that
   this is **guidance to the parent, not a server-enforced output guarantee**: the
   server cannot make a client stay silent, so a chatty parent is a guidance
   observation, not a server defect.
7. **Result handling.** Confirm results, errors, cancellations and timeouts are
   each surfaced to the parent and reported by it. Silence applies to non-events
   only; every one of these must be reported.
8. **Independent parent review.** Confirm that after the worker returns, the
   parent reviews the work itself — verdict, verification outcome, observed
   changed files, discrepancies, scope violations — rather than repeating a worker
   `PASS` as though it settled the matter.

## Recording a run

One entry per acceptance run:

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

### 2026-08-22 — v0.8.0 natural-discovery run

- **Date**: 2026-08-22
- **Client and version**: Codex; version not recorded
- **Parent model**: GPT-5.6 Sol
- **Parent effort**: medium
- **Orchestrator version / commit**: v0.8.0; commit not recorded
- **Worker model and effort**: GPT-5.6 Luna, high
- **Discovery**: found unprompted before the parent researched the public Sol-Luna
  repository
- **Routing**: one bounded read-only investigation for the initial broad audit;
  later, zero workers for a tightly coupled README refinement. Both decisions fit
  the work.
- **Silence while pending**: not recorded
- **Parent review**: independent; the parent retained synthesis, editing and final
  verification, and checked package, release, CI and link evidence itself
- **Outcome and anything surprising**: completed successfully. The read-only task
  returned `PASS` with no changed files, but the orchestrator still emitted the
  generic no-file-changes discrepancy. This run had no solo control and was not a
  performance benchmark, so it supports no speed, cost or quality comparison.
- **Retained evidence**: the task ran in another repository; its transcript and
  diagnostic evidence are not retained here
