# Phase 4 independent branch audit

Reviewed 2026-10-04 on Windows. Base: `77b42f9` (v0.12.0). Committed tip:
`338ed69`; nine original commits. Fixes and tests described here are committed
through runtime checkpoint `3224d4a`.
The supplied Opus report was treated as a hypothesis, not acceptance evidence.

## Commit coverage

| Commit    | Review focus and disposition                                                                                                                                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `16e607a` | CLI registration/config diagnostics, latest-batch reduction, watcher replacement and polling; stream-read race confirmed as F4.                                                                                                                 |
| `c11b565` | Continuation reserve/commit/release, persistent ownership and Git rename evidence; setup and expiry settlement gaps identified below.                                                                                                           |
| `84dcf12` | Broad runtime checkpoint: operation/metadata lease ordering, Git/submodule evidence, private dependency copies, verifier enclosure, integration accounting, cleanup and shutdown. Additional lifecycle and obsolete-link gaps identified below. |
| `6be2557` | Historical acceptance freshness correction is appropriate; recovered checkpoint text must remain historical.                                                                                                                                    |
| `5dafae3` | Routing fixtures use minimal isolated Git workspaces and preserve focused production snapshot tests.                                                                                                                                            |
| `c70a7d4` | Missing-parent provisioning, exact created-directory identities, rollback and file-level mutation accounting; current docs still described the replaced refusal approach.                                                                       |
| `11888df` | Disposal attempts all retained releases and trust failure settles ownership; synchronous expiry failure remained untreated.                                                                                                                     |
| `eb54447` | Production deletion uses verified same-parent tombstones plus recovery backups; protocol-loss accounting distinguishes proven and unknown outcomes. Obsolete helper paths remained.                                                             |
| `338ed69` | Source/private-copy semantic content binding and internal-link rebasing; asynchronous pre-commit checks exposed the helper revalidation gap.                                                                                                    |

Review followed production call paths and their focused adversarial tests. This
is a semantic audit of the complete branch delta, not a claim that every test
line was independently inspected or that races have been formally eliminated.

## Audit fix commits

| Commit    | Scope                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| `317fc5c` | Late shutdown cleanup and independent forced finalizers                                                        |
| `b73c8c0` | Activity stat-to-stream race recovery                                                                          |
| `f8a465d` | Continuation workspace/Git authority, admission, cancellation, and expiry settlement                           |
| `bb7cd51` | Post-acquire metadata cancellation; disproved handoff-leak regression                                          |
| `13a35a7` | Helper spawn/closure settlement and authority recheck after awaited setup                                      |
| `843520f` | Original private snapshot authority across retained continuations; removal of obsolete link exemptions/helpers |
| `90b7441` | Separate child fixture setup deadlines from shutdown liveness bounds                                           |
| `3bff404` | Reattach silent activity watchers after same-size rewrites/inode reuse                                         |
| `32c7522` | Preserve unknown rollback state when a created directory's pathname is replaced                                |
| `e2f2d71` | Scope and delete the admitted leaf link without following its target; update drift-refusal assertion           |
| `8e1eba5` | Canonicalize workspace aliases before Git/worktree confinement and dirty-scope checks                          |
| `3224d4a` | Canonicalize trusted workspace evidence projection, with a real junction regression                            |

## Supplied findings independently checked

- **F1 confirmed:** single delegation omitted the authoritative workspace and
  captured Git authority when issuing a continuation. Both values are now
  preserved; a real temporary Git fixture compares stored authority with the
  parent's captured authority and distinguishes worker directory from workspace.
- **F2 dismissed as a permanent leak:** the catch does not locally release its
  reservation, but `runBatch` releases all unspent reservations after the
  execution window and on its exception path. The new real-slot cancellation
  regression passes with the proposed catch fix removed. That redundant change
  was removed; the regression remains. Release waits for the execution window
  to settle, consistent with batch ownership.
- **F3 confirmed and extended:** late settlements could start normal cleanup
  after timeout. A guard after settlements and before each normal cleanup now
  prevents both late entry and subsequent hooks after an in-flight hook settles.
  Two separate regressions cover those interleavings. Already-running hooks
  cannot be cancelled by `Promise.race`.
- **F4 confirmed:** ENOENT between stat and stream iteration terminated activity
  watch. Recovery resets byte/decoder/history state and reattaches. A real
  read-stream error regression recreates the file and proves history recovery.

## Additional findings fixed

| Finding                               | Before                                                                                                                                                                       | Fix and regression                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forced cleanup exception              | `Promise.resolve(cleanup())` executes synchronously inside `map`; one throw skips later finalizers and replaces the timeout error.                                           | Defer each call into its own promise; assert every finalizer is attempted and the timeout remains authoritative.                                                              |
| Metadata acquisition cancellation     | The post-acquire abort check was outside the lease settlement `finally`, stranding its persistent owner.                                                                     | Check cancellation inside the owned cleanup region; abort exactly after real acquisition, assert artifact removal and successful reacquisition.                               |
| Helper spawn/closure lifecycle        | Missing CWD rejects readiness but waiting for `exit` can never settle after spawn failure; pre-ready closure can also leave readiness pending. `exit` need not drain stdout. | Use `close`, reject pre-ready closure, handle stdin pipe errors; disappeared-parent regression proves prompt rejection.                                                       |
| Awaited helper setup                  | Parent identity was checked before an awaited `beforeExecute`, so arbitrary hook duration invalidated the supplied microsecond-window argument.                              | Recheck identity/canonical path after the hook; junction/ancestor replacement regression proves no mutation in either directory. The final namespace race remains documented. |
| Continuation lifecycle admission      | Registry/execution-lease setup could throw after reservation without restoring it.                                                                                           | Restore the reservation on setup refusal; assert no repository authority or executor is entered.                                                                              |
| Continuation trust-setup cancellation | Cancellation during asynchronous evidence capture could still commit authority and enter the executor.                                                                       | Recheck cancellation immediately before commit; assert restored authority, no execution, and one operation release.                                                           |
| Expiry settlement queue               | A synchronous release throw escaped `.catch` and poisoned the shared lease-release chain, preventing subsequent releases and disposal.                                       | Defer invocation into the caught promise; two expired leases prove later settlement survives the first failure.                                                               |
| Obsolete link evidence authority      | A worker-created link matching an operator dependency directory could be filtered as setup, although production no longer provisions those links.                            | Remove the legacy evidence filter in worktree and retained-continuation paths; separate regressions preserve the forged link and its scope violation.                         |

Unused writable-link provisioning and unchecked `rename`/standalone `symlink`
helper operations were removed. Their obsolete tests were removed or converted
to production snapshot tests. Cleanup still handles directory links safely.
`unlink` remains a production operation for tombstones and recovery backups;
the supplied claim that production never uses it was inaccurate.

Retained continuation dependency authority also needed correction. The store now
clones the original private-snapshot fingerprint, the batch/server registration
path transfers it, and reconciliation excludes only those proven setup paths.
Setup refuses dependency drift before worker entry; completion catches mutation
even on turns without verification. Regressions cover actual batch-to-store
wiring, defensive metadata copies, unchanged setup attribution, pre-start drift,
and post-turn mutation. Ignored paths outside those pinned setup directories
remain part of retained evidence.

The full test run also exposed an outdated partial-integration warning assertion
from the missing-parent rewrite. Its applied-file and terminal-event assertions
remain intact; the warning assertion now matches the confined ancestry refusal.

## Independently dismissed Git-object hypothesis

A disposable repository test replaced a committed tree object's bytes under its
original object ID and changed the corresponding worktree file to match the
forged tree. Trusted collection's `git read-tree` refused the object with a hash
mismatch (exit 128). This specific hypothesis did not hide evidence; it does not
establish a general guarantee against arbitrary same-user Git-object attacks.

## Native CI follow-up

The initial complete Windows gate passed at `a0217f8`, but native CI exposed
additional issues. Acceptance remained open rather than treating the local
platform's skips as proof:

- Linux recycled an inode after same-size delete/recreate. History recovered,
  but the stale watcher was not reattached. Same-size rewrites now rebind it;
  deterministic tests cover both recreation and overwrite without callbacks.
- A redirected-destination test expected a later refusal diagnostic even
  though the earlier workspace-drift gate already blocked the mutation. Its
  refusal and untouched outside-target assertions remain intact.
- Deletion followed a leaf link during scope validation, incorrectly refusing
  an admitted unlink and snapshotting target bytes. Deletion now canonicalizes
  the parent while preserving the leaf entry, with in-workspace and external
  target regressions proving the targets survive.
- Rollback interpreted a replacement pathname as proof that a created directory
  had been removed. It now reports uncertainty and leaves the replacement
  untouched; a real moved-directory regression runs on Windows too.
- macOS temporary paths use `/var` and `/private/var` aliases. Git/worktree
  confinement, dirty-scope comparison, and trusted evidence projection now use
  canonical workspace paths. A real directory-link regression proves setup,
  dirty-scope refusal, and correct changed-file attribution.

## Documentation reconciliation

`SECURITY.md` and `CHANGELOG.md` previously still required all parents to exist
and described moving originals into the recovery directory. They now describe
confined parent creation, reverse identity-aware rollback, same-parent tombstones,
separate backups, and proven versus unknown mutation accounting. Shutdown and
activity recovery semantics are updated in their canonical documents. Runtime
instructions now describe private snapshots instead of shared dependency links.

## Evidence and remaining boundaries

Focused regression results and complete gate results are recorded in
`docs/FEATURE_ACCEPTANCE.md`. No model-backed smoke campaign or publication
is implied; native results are limited to the CI runners and commits recorded there.

The first complete post-fix Windows suite recorded 1,263 tests: 1,257 passed,
one failed, and five skipped. The failure was an existing three-second child
deadline covering both repository setup and shutdown; it passed in isolation.
`90b7441` separately bounds setup and starts the same three-second liveness
deadline at an explicit readiness marker. All eight shutdown tests pass; full
The next complete `npm run verify` passed at `a0217f8`: 1,263 tests, 1,258 passed,
zero failed, five Windows skips, protocol smoke, and all 17 benchmark fixtures.
After the native-CI follow-ups above, complete acceptance passed in
[CI run 37194760358](https://github.com/mahadansar/sol-luna-orchestrator/actions/runs/37194760358)
at source checkpoint `3224d4a`: all six Windows/Ubuntu/macOS jobs on Node 24 and
26 are green, each with 1,267 tests and zero failures. Windows/macOS skipped four
platform cases and Ubuntu skipped five. All jobs passed protocol smoke and all
17 benchmark fixtures. Documentation-only reconciliation does not change the
accepted runtime/workflow/fixture source.

The Node filesystem helper does not provide atomic directory-handle-relative
namespace mutation. Rechecking a parent after asynchronous work narrows the
window; it does not remove a concurrent change after that check. File scopes are
detective, verification runs with operator permissions, and private Git/dependency
evidence is not a sandbox against arbitrary same-user filesystem access.
