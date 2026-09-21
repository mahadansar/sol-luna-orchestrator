# Orchestrator hardening wrap-up

Date: 2026-09-21

Branch: `feature/orchestrator-upgrades-2026-09-21`

This document is a checkpoint/handoff for the current hardening branch. It is
deliberately **not** a final acceptance or publication claim. The last complete
`npm run verify` evidence predates the newest filesystem-authority work, so
`docs/FEATURE_ACCEPTANCE.md` must not be treated as fresh evidence for this
exact tree until the TODOs below are completed.

## Done

- Preserved the already-published branch history at `16e607a` and `c11b565`
  without amend/rebase/reset/clean.
- Hardened registered telemetry/config authority, init repair, status/doctor
  diagnostics, and activity watcher recovery.
- Hardened cancellation/handoff/continuation behavior so pre-worker
  cancellation does not consume authority and owner-loss remains fail closed.
- Added canonical same-repository operation serialization with persistent
  lease ownership, renewal/liveness checks, forced-shutdown handling, stale
  retirement retries, replay/identity checks, and ancestor confinement.
- Hardened trusted Git evidence with a private Git environment, no replace
  objects, bounded Git output, common/worktree Git-control fingerprinting, and
  real `.git/modules/**` authority.
- Added recursive initialized-submodule evidence, including tracked,
  untracked, and ignored child changes even when parent `.gitmodules` uses
  `ignore = all`.
- Added admission pinning for previously uninitialized gitlinks. Later
  population, replacement, redirect, non-directory state, or identity change
  fails closed.
- Replaced writable shared dependency links in production worktrees with
  private dependency snapshots and dependency fingerprints before/after
  evidence-bearing execution.
- Added independent ignored-file and non-Git workspace evidence; worker SDK
  file claims are not the sole authority.
- Delayed terminal completion until trusted reconciliation and enclosed the
  final integrated verifier with workspace/Git/dependency evidence checks.
- Hardened parallel integration against operator/source drift, final
  source-byte changes, destination replacement, short writes, partial writes,
  cancellation boundaries, and deletion rollback/accounting.
- Added `src/fs-authority.ts`, a two-phase pinned-directory mutation helper:
  the helper starts with the already-admitted directory as its CWD, reports its
  exact identity/canonical path, waits for the parent GO decision, and performs
  only single-child relative mutations. Existing-file replacement verifies the
  opened file identity and accepted content before truncate/write.
- Worktree/dependency provisioning now creates missing ancestry one segment at
  a time through pinned parent authority, records exact created-directory
  identities, and rolls them back in reverse only when the same empty
  directories are still proven.
- Private dependency snapshots use pinned destination parents and a random
  private staging child followed by an identity-verified final rename.
- Shared-link creation and runtime/common-Git control-root provisioning use the
  same pinned-parent creation model where applicable.
- Integration file creation/replacement now uses the pinned-directory helper
  instead of a final path-based `open`.
- Integration deletion now has a stronger copy-first quarantine / same-parent
  tombstone path under active development, while retaining truthful
  authoritative-mutation accounting and recoverability.

## Current wrap-up validation

The following checks are green on this checkpoint:

- `npm run typecheck`
- `npm run build`
- `git diff --check`
- focused integration/filesystem authority regression set: **8/8 passed**
  - missing destination parent refusal on the current batch path
  - raced parent junction refusal
  - pinned short-write completion
  - existing-file post-truncate failure accounting
  - new-file partial-write failure accounting
  - operator replacement during deletion boundary
  - successful proven deletion cleanup
  - deletion cancellation after namespace move
- `node --test dist/worktree-link.test.js`: **13/13 passed**
  - nested parent provisioning
  - pinned segment race protection
  - pinned dependency snapshot destination commit
  - private snapshot isolation
  - external-link rejection
  - redirected `.sol-luna` refusal
  - nested workspace placement
  - link-safe cleanup
- worker-side lease-focused regressions after the pinned provisioning change:
  **8/8 passed**

The latest full Git-evidence run before this final wrap-up work was **29/29
passed**. It covered initialized/uninitialized gitlinks, real
`.git/modules/**` control, output bounds, filters/replace refs, and trusted
Git control evidence.

## TODO before final acceptance/publication

1. **Finish batch-side missing-parent provisioning.** `src/worktree.ts` now
   exports `ensureConfinedDirectoryChain(...)`, but `src/batch.ts` still
   intentionally uses the read-only `assertConfinedDirectoryChain(...)` path
   for regular integration destinations. The next pass should switch batch
   integration to the safe creator, preserve created-parent rollback, and count
   unrollbackable namespace mutation truthfully.
2. **Finish/re-audit the newest deletion helper path.** The current copy-first
   quarantine + same-parent tombstone implementation has focused green tests,
   but it has not received another full whole-branch adversarial audit.
3. **Keep the platform caveat explicit.** Standard Node does not expose portable
   handle-relative `unlinkat/renameat` equivalents. CWD-bound helpers prevent
   replacement-path/junction redirection to another object; on POSIX an
   already-bound directory object can still be moved elsewhere in the
   namespace by another process. A strict adversarial proof for that case
   requires a native handle-relative primitive or a stronger external
   serialization guarantee.
4. **Re-run repository-wide formatting after any further edits** and keep
   `git diff --check` clean.
5. **Run a brand-new full `npm run verify`** on the finished exact tree. Do not
   reuse the historical **1,187 tests / 1,184 passed / 3 skipped** result as
   current evidence.
6. **Update `docs/FEATURE_ACCEPTANCE.md` only from that fresh green run**, then
   run the entire verifier again because the acceptance ledger changed.
7. **Perform the final adversarial whole-branch audit and mechanical scope
   review**, including deterministic test/coverage wiring, dependency state,
   ignored/untracked/generated state, significant production diffs, and scope
   creep.
8. **Publish only after final acceptance:** push
   `feature/orchestrator-upgrades-2026-09-21`, fetch/prune, prove clean tree,
   prove `HEAD == origin/feature/orchestrator-upgrades-2026-09-21`, and record
   freshly fetched `origin/main`.

## Historical evidence rule

The older verifier run with 1,141 tests / 1,134 passed / 4 failed / 3 skipped
lost the exact fourth failure block. That historical fourth failure remains
unidentified and must not be guessed or relabeled from a newer failure.
