# Completed orchestrator hardening plan

Last audited: 2026-10-04

Branch: `feature/orchestrator-upgrades-2026-09-21`

Accepted hardening runtime checkpoint: `3224d4a` (`fix: project trusted workspace evidence through canonical aliases`)

Status: Phases 0 through 6 complete. Exact-source cross-platform CI is green.

Audit fixes and regressions are committed. See
[phase4-audit-report.md](phase4-audit-report.md) for the independent review,
including corrections to the supplied handoff.

Base: `77b42f9` (`v0.12.0`, current `main` at the time of this audit)

This file records the completed unreleased hardening pass and its historical
recovery sequence. The branch name above identifies the audited branch. It
records intent, completed work, checkpoint gaps, and acceptance evidence.
Runtime behavior remains
authoritative in the implementation and tests. Shipped behavior belongs in
`CHANGELOG.md`, future product work belongs in `ROADMAP.md`, and acceptance claims
belong in `docs/FEATURE_ACCEPTANCE.md` only after their evidence is fresh for the
tree being described.

Both this plan and the preserved September 21 checkpoint live at the repository
root intentionally. `npm pack --dry-run` on the recovery tree confirms they are
not included in the published package, avoiding a branch-internal handoff becoming
release documentation by accident.

## Current recovery status (2026-10-04)

The original audit covered nine commits through `338ed69` after `77b42f9`.
Twelve focused audit commits now follow that checkpoint. Phases 0 through 4 are implemented:
`6be2557` restored documentation freshness, `5dafae3` isolated routing fixtures,
`c70a7d4` provisioned integration parents, `eb54447` consolidated pinned deletion
and filesystem authority, and `338ed69` bound dependency snapshots to content.
`11888df` additionally hardened continuation lease settlement.

Phase 4 reviewed all nine commits by ownership boundary and added focused fixes
and regressions. The supplied F2 permanent-reservation-leak claim was disproved:
the new test passes without its proposed fix because the outer batch owner
already releases unspent reservations. Other handoff findings were confirmed,
and additional lifecycle, helper, and obsolete-link evidence gaps were found.

Phase 5 has a complete Windows verifier at `a0217f8` and a green six-job
cross-platform gate at `3224d4a`. Phase 6 reconciles current documentation and
binds acceptance to that unchanged source checkpoint. No release is authorized
from this branch. The checkpoint gaps below describe the historical `84dcf12`
tree; they are not current implementation claims.

The first full post-fix test run reached 1,263 tests with one shutdown-fixture
deadline failure. The isolated case passed; `90b7441` separates fixture setup
from the existing shutdown liveness bound, and its full eight-test suite passes.
The next Windows verifier passed all 1,263 tests (1,258 passed, five skipped),
protocol smoke, and all 17 benchmark fixtures at `a0217f8`. Native CI then exposed
inode reuse, leaf-link deletion, rollback uncertainty, and macOS canonical-path
issues. Their fixes and regressions are committed through `3224d4a`, with a
passing 140-test local focused run and additional canonical-evidence regression.
Fresh complete CI passed for that source checkpoint on Windows, Ubuntu, and
macOS with Node 24 and 26: 1,267 tests per job, zero failures, four Windows/macOS
platform skips and five Ubuntu skips. All jobs also passed protocol smoke and
all 17 benchmark fixtures. Hardening was merged into `main` before the separate
[worker-model upgrade plan](WORKER_MODEL_UPGRADE_PLAN.md) was committed. The
GPT-6 default and optional automatic mode were implemented on that separate branch
and have now been merged into `main` for the prepared, unreleased 0.13.0 candidate;
they are outside this accepted hardening checkpoint. The user authorized merging hardening into
`main`, then creating a new branch and committing a model-upgrade plan before
model implementation. Existing stashed work remains separate.

## Why this branch exists

The branch began from the v0.12.0 release and is a reliability/security hardening
pass over existing orchestration behavior rather than a new feature milestone. The
work concentrates on four connected boundaries:

1. operator-facing setup, diagnostics, and activity recovery;
2. continuation and retained-worktree authority;
3. trustworthy Git/workspace/dependency evidence across delegated execution; and
4. filesystem mutation/integration behavior under cancellation, races, process
   overlap, and path replacement.

The practical goal is to make every terminal success depend on authority and
evidence that remain valid through the final mutation, verification, reconciliation,
lease settlement, and cleanup boundaries.

## Recovered branch history

At the recovered `84dcf12` checkpoint, the branch was three commits ahead of
`v0.12.0`/`main` and clean and synchronized with
`origin/feature/orchestrator-upgrades-2026-09-21`. The sections below describe
that historical checkpoint, not the current branch tip.

### `16e607a` - operator diagnostics and activity

This commit hardened the CLI/runtime configuration view and activity watcher. It
added stronger `init`, `status`, and `doctor` reconciliation/diagnostics; aligned
registered log/event path handling with runtime behavior; and made activity watch
mode recover from file replacement, delete/recreate, and silent watcher failure.
The relevant production surfaces are primarily `src/cli.ts`, `src/cli/doctor.ts`,
`src/cli/server-config.ts`, `src/cli/activity.ts`, and
`src/cli/activity-reducer.ts`, with focused activity/CLI regression coverage and
matching observability/troubleshooting documentation.

### `c11b565` - continuation and worktree evidence hardening

This commit tightened single-use continuation authority and retained-worktree
ownership. Continuations reserve authority during pre-execution setup, remain
retryable after transient setup failure, and fail closed when persistent ownership
is lost. It also strengthened shared worktree-link configuration/evidence and added
dedicated Git/worktree-link regression suites. The main implementation surfaces are
`src/continuation.ts`, `src/worktree.ts`, `src/git.ts`, `src/server.ts`, and
`src/config.ts`.

### `84dcf12` - broad hardening checkpoint

This checkpoint substantially expanded the branch. It added or strengthened:

- persistent same-repository operation authority and lease health/ownership checks;
- trusted Git evidence with private Git state, bounded output, control-metadata
  fingerprinting, initialized submodule recursion, and uninitialized gitlink pinning;
- private dependency snapshots instead of writable shared dependency links;
- independent filesystem evidence for ignored and non-Git workspace effects;
- evidence checks around worker verification and final integrated verification;
- pinned-parent filesystem mutation primitives in `src/fs-authority.ts`;
- confined directory provisioning with identity-aware rollback in `src/worktree.ts`;
- integration write accounting for short, partial, failed, cancelled, and rolled
  back mutations; and
- extensive adversarial regression coverage in `src/parallel.test.ts`,
  `src/git-evidence.test.ts`, `src/worktree-link.test.ts`, lifecycle tests, and
  shutdown tests.

This commit is a checkpoint rather than completed acceptance. The original
`HARDENING_CHECKPOINT_2026-09-21.md` explicitly recorded that fact, and current code
contained the incomplete seams listed below.

## Confirmed gaps at the recovered checkpoint

### 1. Parallel integration could not safely create missing destination ancestry

`src/worktree.ts` exports `ensureConfinedDirectoryChain(...)`, which creates missing
directory segments one at a time beneath pinned parent authority and returns the
exact created identities plus an identity-aware rollback function. Dependency
snapshot provisioning already uses it.

The production parallel integration path in `src/batch.ts` still calls
`assertConfinedDirectoryChain(...)` before file creation. A worker that legitimately
adds `fresh/deep/file.txt` therefore cannot integrate unless `fresh/deep` already
exists in the authoritative workspace. The current regression test intentionally
asserts that refusal. This was recorded as unfinished in the September 21 handoff
and remains unfinished at `84dcf12`.

Required closure:

- provision only the missing parent segments required by the accepted file path;
- retain the returned pinned parent authority for the final file mutation;
- roll back only directories created by this integration attempt and only while
  they are still identical and empty;
- if rollback cannot be proven, report the namespace mutation truthfully rather
  than claiming zero authoritative change; and
- keep cancellation, source drift, destination drift, scope checks, and integration
  accounting consistent with the existing write boundary.

### 2. The newer pinned deletion helper is not wired into production integration

`src/batch.ts` contains `performPinnedIntegrationDeletion(...)`, a newer copy-first
backup plus same-parent verified tombstone flow built around pinned directory
mutation. There is no production call to that function at this checkpoint.

The active deletion branch later in `src/batch.ts` still carries the older inline
quarantine flow using direct `fs.rename(...)` and `fs.unlink(...)`. In addition,
`ensureIntegrationDeleteQuarantineRoot(...)` still creates missing quarantine
directories with direct path-based `fs.mkdir(...)` before later authority is
captured. The existence of the newer helper therefore must not be treated as proof
that the production deletion path has adopted the stronger boundary.

Required closure:

- finish or revise the pinned deletion helper after adversarial review;
- make quarantine-root provisioning use the same pinned/confined parent model;
- route the production deletion branch through one authoritative implementation;
- remove the superseded duplicate inline path once equivalence is covered; and
- prove cancellation, source replacement, destination replacement, rollback,
  cleanup failure, partial authoritative mutation, symlink/junction, and retained
  recovery behavior with focused tests.

### 3. Acceptance freshness had drifted and was not re-established

`docs/FEATURE_ACCEPTANCE.md` records a full `npm run verify` from 2026-09-21 and
previously described it as evidence for the current hardening tree. The later
checkpoint handoff states that this full run predates the newest filesystem-authority
work and must not be treated as fresh evidence for the exact checkpoint. The
2026-09-27 recovery audit corrected that top-level freshness claim. Exact-tree
acceptance was pending a fresh full verifier run at recovery; the completed
October 4 acceptance above closes this gap.

### 4. Platform boundary for destructive namespace mutation remains explicit

Standard Node does not provide a portable `unlinkat`/`renameat`-style API bound to
an already-open directory handle. The child helper pins its CWD directory identity
and refuses a replaced path, which closes important redirection races, but the
September 21 handoff correctly records the remaining POSIX namespace caveat for an
already-bound directory object that another process can move. This limitation must
remain documented and must not be upgraded into a stronger sandbox claim.

### 5. The canonical verifier currently exercises an unexpectedly expensive dependency path

The 2026-09-27 recovery audit started a fresh `npm run verify` from checkpoint
`84dcf12`. Typecheck and formatting passed, but the deterministic suite became
impractically slow in `src/adaptive-routing.test.ts`: the handoff test at line 929
passed after roughly 146 seconds and the two-worker adaptive dispatch test at line
1094 passed after roughly 305 seconds. The run was interrupted during later tests
rather than treating an open-ended gate as fresh acceptance evidence.

The implementation explains the likely source and makes it part of this hardening
scope rather than a generic machine-speed observation:

- `runBatch(...)` fingerprints configured shared dependency directories whenever
  a task declares verification commands;
- every isolated worktree calls `snapshotSharedDirectories(...)`; and
- the default shared directory is `node_modules`, whose content is recursively
  fingerprinted and privately copied into each worktree.

Several adaptive-routing tests use the repository's real `process.cwd()` as their
workspace, so they exercise the full installed dependency tree even when the test
is primarily about routing or handoff semantics. This is valid production behavior
to test somewhere, but it makes the canonical deterministic gate a poor acceptance
signal if unrelated contract tests repeatedly pay that full I/O cost.

Required closure:

- characterize the cost separately for dependency fingerprinting, one private
  snapshot, and multi-worker snapshot setup;
- identify which tests actually need the real dependency snapshot security path;
- move routing/handoff tests that do not need it to isolated minimal fixtures or an
  existing deterministic dependency seam without weakening production behavior;
- retain focused tests that prove the real private-snapshot path and its security
  properties; and
- rerun the complete gate to prove it finishes predictably before recording fresh
  acceptance evidence.

## Execution plan

### Phase 0 - restore documentation truth

Status: completed by the 2026-09-27 recovery audit.

- Keep this file as the active branch plan and keep
  `HARDENING_CHECKPOINT_2026-09-21.md` as the historical September 21 checkpoint.
- Correct acceptance-ledger freshness so historical validation is not presented as
  proof for a later tree.
- Record exact branch/base/commit state and distinguish completed behavior from
  incomplete wiring.
- Run the canonical verifier to establish a measured recovery baseline. A green
  verifier at this stage is useful regression evidence but does not close known
  design/implementation gaps above.

Exit criteria: a future agent can recover the branch purpose, exact progress,
known gaps, and next code change from tracked documentation without relying on a
chat transcript.

The attempted canonical verifier established useful evidence but was not green to
completion: typecheck and formatting passed, two especially expensive adaptive
routing tests passed at roughly 146 seconds and 305 seconds, and the run was then
interrupted while later tests were still active. That result is recorded as a
recovery diagnostic only, never as exact-tree acceptance.

### Phase 1 - restore a practical deterministic acceptance gate

1. Measure the dependency fingerprint/snapshot cost independently of worker logic.
2. Audit tests that use the repository root as `workingDirectory` and separate
   cases that need production dependency provisioning from routing/contract tests
   that only need a valid workspace.
3. Give the latter minimal isolated Git fixtures or an existing deterministic
   seam, while keeping focused real-snapshot coverage.
4. Run the affected suites directly and then `npm test` to establish that the
   deterministic gate completes predictably.

Exit criteria: the suite still covers private dependency snapshot security, but
ordinary routing/handoff tests do not repeatedly fingerprint/copy the repository's
full dependency tree as incidental setup.

### Phase 2 - finish confined parent provisioning in parallel integration

1. Replace the regular integration destination's read-only ancestry assertion with
   `ensureConfinedDirectoryChain(...)` at the last safe point before the final
   pinned file mutation.
2. Preserve the returned parent authority into the write operation rather than
   re-resolving the parent by path.
3. Track created directories as part of the integration attempt's authoritative
   mutation state.
4. Roll them back after a blocked/cancelled/failed file mutation only when the
   helper proves the same empty directories still exist.
5. Extend `src/parallel.test.ts` so a worker-created nested file integrates when its
   parents were absent, while parent replacement/junction races remain fail closed
   and rollback/accounting are explicit.

Exit criteria: legitimate nested adds integrate without pre-creating destination
parents, adversarial parent replacement cannot redirect a mutation, and every
created namespace object is either safely rolled back or truthfully reported.

### Phase 3 - consolidate the deletion boundary

1. Re-audit `performPinnedIntegrationDeletion(...)` and quarantine-root creation
   against the same authority rules as file writes and directory provisioning.
2. Add any missing pinned-parent creation/cleanup primitive needed by the helper.
3. Replace the older inline deletion path with the reviewed helper.
4. Remove dead/superseded deletion code so there is one production behavior to
   reason about.
5. Run the focused integration/deletion suite on Windows and retain platform-specific
   skips/caveats honestly.

Exit criteria: the production path itself uses the reviewed pinned deletion
implementation and tests exercise that exact path, including unsafe rollback and
cleanup failure accounting.

### Phase 4 - adversarial whole-branch review

Audit the entire branch delta from `77b42f9` with emphasis on authority
lifetime and duplicate implementations rather than adding new product scope.

Review at minimum:

- operation-authority acquisition, renewal, cancellation, final health check, and
  release ordering;
- continuation reservation/consumption and retained-worktree lease settlement;
- Git control-state authority, submodules, uninitialized gitlinks, ignored files,
  and non-Git workspaces;
- dependency snapshot creation, fingerprints, verification, and cleanup;
- final verifier enclosure and any command capable of mutating evidence after a
  passing check;
- integration add/replace/delete paths and their authoritative mutation counts;
- shutdown/process-liveness behavior; and
- Windows junction/case behavior plus the documented POSIX namespace limitation.

Any production defect found in this pass requires a focused regression before the
fix lands. Remove test-only or dead helper paths that could mislead future audits.

Exit criteria: no known duplicate authority path, dead security-critical helper,
or unreviewed broad checkpoint change remains.

### Phase 5 - fresh exact-tree acceptance

After implementation and adversarial review are complete:

1. run `npm run typecheck` and the focused changed-area suites;
2. run `npm run verify` on the exact finished tree;
3. update `docs/FEATURE_ACCEPTANCE.md` from that run, including date, commit,
   platform, totals, skips, and the specific seams whose evidence is refreshed;
4. validate the documented source checkpoint with the complete gate, locally
   with `npm run verify` or the equivalent CI steps (typecheck, formatting,
   complete tests, MCP protocol smoke, and fixture validation), and check the
   ledger/documentation edits with formatting and `git diff --check`; and
5. run `git diff --check` and a mechanical changed-file/scope review.

Do not copy the September 21 counts forward as current evidence and do not promote
focused tests into a full acceptance claim.

### Phase 6 - merge/release readiness

- Reconcile `[Unreleased]` in `CHANGELOG.md` against the final implementation and
  delete claims for approaches that were replaced before merge.
- Re-audit `SECURITY.md`, `SOL_RULES.md`, configuration, troubleshooting,
  observability, and acceptance docs against the final code.
- Update `README.md` only where normal user-visible behavior actually changed.
- Confirm the working tree is clean, fetch/prune, prove the branch tip matches its
  remote, and compare against freshly fetched `origin/main`.
- Follow the release workflow in `CONTRIBUTING.md`; do not tag or publish from this
  feature branch.

Exit criteria: the branch is reviewable as one coherent hardening change with fresh
evidence and no documentation claiming more than the implementation proves.

## Recommended micro-commit sequence

Keep the remaining work reviewable and avoid another broad checkpoint commit:

1. documentation recovery and acceptance-freshness correction;
2. deterministic-gate fixture/performance repair with focused snapshot coverage;
3. confined missing-parent integration plus its focused tests;
4. pinned deletion consolidation plus its focused tests;
5. any defects found by the whole-branch adversarial review, grouped by one
   underlying authority/lifecycle issue per commit;
6. final acceptance-ledger refresh after a green exact-tree verifier; and
7. final documentation/release-readiness reconciliation.

## Documentation discipline for this branch

Use the repository's existing ownership boundaries consistently:

- implementation and focused tests define current runtime behavior;
- `CHANGELOG.md` describes unreleased behavior that is actually implemented;
- `ROADMAP.md` describes future product work and constraints;
- `SECURITY.md` owns threat-model and trust-boundary claims;
- `SOL_RULES.md` owns supervisor/delegation/review policy;
- configuration, troubleshooting, and observability details stay in their named
  canonical documents;
- `docs/FEATURE_ACCEPTANCE.md` records evidence and its freshness, never intent;
- this file records only the active branch's engineering sequence and handoff
  context; and
- `HARDENING_CHECKPOINT_2026-09-21.md` remains historical evidence of what was believed at
  the September 21 checkpoint.

When behavior changes, update the canonical document in the same change. When an
acceptance claim depends on a full verifier run, bind it to the exact tree that was
actually verified. Do not let a passing focused suite, an unused helper, or a
historical live run stand in for production wiring plus current evidence.
