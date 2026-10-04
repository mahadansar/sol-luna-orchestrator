# Roadmap

This file tracks future work only. Shipped behavior belongs in
[`CHANGELOG.md`](CHANGELOG.md), current operating rules belong in the focused
documentation, and acceptance evidence belongs in
[`docs/FEATURE_ACCEPTANCE.md`](docs/FEATURE_ACCEPTANCE.md).

## Direction

Sol-Luna optimises for trustworthy verified output, conservative failure
handling, useful parallel execution, context efficiency, and reproducible
evidence. Delegation is adaptive: zero workers is a valid outcome, and worker
count is never the objective by itself.

Priority remains:

1. Correctness and trustworthy verified output.
2. Reliability and conservative failure handling.
3. Effective parallel execution.
4. Latency and context efficiency.
5. Cost efficiency when authoritative billing evidence exists.

## Current future work

The 0.13.0 baseline is feature-complete for the currently shipped orchestration
surface. Future work should be justified by a concrete product or reliability
need and should preserve the existing security and evidence boundaries.

- **Sandboxed verification.** Evaluate stronger verifier confinement if Codex or
  the host platform exposes a mechanism that preserves the current deterministic
  command-policy and evidence guarantees.
- **Broader live platform coverage.** Add representative native macOS live
  delegation and broaden Linux coverage beyond the documented trusted-development
  sandbox workaround.
- **Longer-lived workflows.** Characterise handoff and context behavior across
  work that exceeds one supervisor session without weakening capability expiry or
  imported-history boundaries.
- **Parallel tail behavior.** Characterise slow-worker tails, cancellation, and
  queueing under realistic parallel batches.
- **Supervisor effort comparison.** Compare parent effort levels only when the
  experiment has a clear decision it can inform and authoritative usage evidence
  is available.

## Not current goals

1. Fixed user-selected orchestration modes. The supervisor remains adaptive.
2. Maximising worker count. More agents are useful only when the work has real,
   separable ownership seams.
3. Automatic Git closure. Sol-Luna does not commit, push, tag, or publish merely
   because orchestration completed.
4. Inferred pricing or savings claims. Cost claims require the applicable
   authoritative billing evidence.

## Contributing to the roadmap

Open an issue before implementing roadmap work. State the problem, the proposed
boundary, the evidence needed to accept it, and any security or cross-platform
constraints. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
