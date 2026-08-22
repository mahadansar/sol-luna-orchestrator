# Release notes — v0.8.1

This file stages the reviewed body of the **v0.8.1** GitHub Release, dated
2026-08-23. It is not a record of past releases:

- Shipped releases are recorded in [`CHANGELOG.md`](CHANGELOG.md), which is
  authoritative.
- Published release bodies live on the
  [Releases page](https://github.com/mahadansar/sol-luna-orchestrator/releases).

**Currently in preparation: v0.8.1, dated 2026-08-23.**

---

## sol-luna-orchestrator v0.8.1 — 2026-08-23

### What changed

- Delegation guidance is adaptive: zero workers remains valid, and cost
  decisions balance expected credits, latency, context, fixed overhead,
  verification, coordination risk and quality. Cheaper-worker economics apply
  only when the selected parent is priced above the worker on the current
  schedule; no saving is guaranteed or measured.
- Single-task and batch choices are distinct. Use `delegate_task` when no
  batch-level scheduling is needed; `delegate_tasks` is intended for multiple
  meaningful tasks but accepts one task for compatibility. Sequential batches
  are for dependent or shared-workspace tasks, while parallel batches are for
  independent tasks. Declared overlap can be accepted per call, but actual
  same-file edits still prevent automatic integration.
- `resultDetail` in a batch is one batch-level choice applied uniformly to every
  returned task result. An empty `allowedFiles` array means no in-workspace
  allowlist; it does not declare read-only intent, and workspace confinement
  still applies.
- The roadmap records a future explicit classification for read-only,
  zero-change results and does not infer that intent from `allowedFiles: []`.
- Human pricing examples are dated 2026-08-23: the documented API example gives
  a 25:1 Sol:Luna unit-price ratio, while the eligible purchased-credit example
  gives 20:1 for input and cached input and about 16.7:1 for output. These are
  illustrative rate ratios, not a measured saving or a universal billing rule.
- Regression tests cover adaptive cost guidance, single-versus-batch and overlap
  wording, batch-level result detail, empty-allowlist semantics, pricing-example
  safeguards and the read-only roadmap distinction.

### Unchanged

No delegation input/output schema shape changed, and no execution algorithm
changed. This release updates guidance and schema descriptions while preserving
the established delegation behavior and defaults.

### Links

- [README](README.md)
- [`CHANGELOG.md`](CHANGELOG.md)
- [Configuration](docs/CONFIGURATION.md)
- [SOL_RULES](SOL_RULES.md)
- [ROADMAP](ROADMAP.md)
- [MIT licence](LICENSE)
