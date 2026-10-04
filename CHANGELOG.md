# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Repository development and documentation now use `0.13.0` as the retained
  baseline. Superseded hardening plans, release-history clutter, and the frozen
  V2/V3 benchmark harness, fixtures, checkpoints, results, and scripts were
  removed from the maintained tree.
- Builds now remove generated `dist/` output before compiling so deleted source
  cannot survive as stale package contents.
- New cross-session handoff exports identify `0.13.0` as their default source
  version.
- Runtime dependencies are now exact and the published package carries
  `npm-shrinkwrap.json`, so installs of the same package version use the validated
  runtime dependency graph instead of floating within semver ranges. The current
  graph includes `@modelcontextprotocol/sdk` `1.32.0` and has no npm audit findings.
- Verification allowlist mode now keeps direct interpreters and ad-hoc package
  fetchers out of the default-safe set, constrains multi-purpose package/tool
  launchers to verification-oriented subcommands, and lets operators explicitly
  add, deny, or replace executable policy. Worker Codex processes receive a
  least-privilege environment with explicit opt-in passthrough for extra variables.
- CI remains manually dispatched, now with an exact Node 22.12 floor lane in
  addition to the Node 24/26 cross-platform matrix. Release actions are pinned to
  immutable commits, and tagged publishing now requires the exact current `main`
  commit plus a successful manual CI run for that SHA before packaging. OIDC
  authority is isolated to a minimal job that publishes the already-validated tarball.
- Local diagnostics and activity files are owner-only on POSIX where supported,
  bounded to 16 MiB with one rotated predecessor, and activity reads use bounded
  tail windows for oversized legacy files.

### Fixed

- Parent-side workspace and dependency evidence hashing now streams file content
  under explicit per-file, aggregate-byte, entry-count, and elapsed-time budgets,
  preventing worker-controlled files from forcing unbounded parent memory use.
- Pinned filesystem mutation helpers now inherit orchestration cancellation and a
  finite deadline, are killed/reaped on cancellation or timeout, and preserve
  conservative mutation evidence when interruption happens after dispatch.
- The previously shared-checkout throwing-executor lifecycle fixture now runs in
  an isolated temporary Git repository, removing the demonstrated release-gate flake.
- `init --no-discovery-hint` now removes exact managed discovery hints from an
  existing install while preserving user instructions. CLI help, uninstall scope,
  `status` health exit codes, doctor remedies, and parent-model onboarding copy are
  aligned with current product behavior.
- Human activity output now includes a privacy-safe workspace/run discriminator
  so concurrent projects sharing one Codex home are distinguishable without
  exposing absolute paths or raw batch identifiers.

## [0.13.0] - 2026-10-04

### Added

- Optional `LUNA_MODEL=latest-luna` selects the newest visible compatible numeric
  Luna model from the installed Codex catalog once at startup, freezes the
  concrete executor across policy/descriptions/continuations, and fails closed
  on discovery or cleanup failure. Discovery is bounded and performs no
  inference; offline CLI inspection stays offline. Catalog presence does not
  establish account access or global freshness.

### Changed

- The Codex SDK dependency is now `^0.160.0` (lockfile 0.160.0), whose bundled
  catalog exposes GPT-6 Luna. Native SDK effort types replace the old `max` cast.
- The pinned worker default is now `gpt-6-luna`. Explicit `LUNA_MODEL` overrides
  remain honored.

### Fixed

- Parallel live smoke resolves optional automatic model selection before worker
  execution and checks the exact selected model in usage telemetry.
- Git isolation, worktree setup, and trusted evidence projection canonicalize
  workspace aliases before containment and dirty-scope comparisons, including
  macOS temporary paths.
- Parallel integration deletes an admitted symbolic-link entry without
  following its target; the canonical parent and the leaf scope remain checked.
- Confined parent rollback now reports displaced or replaced created-directory
  identities as uncertain rather than claiming their removal.
- Activity watch now reattaches after same-size rewrites, including
  delete/recreate when the filesystem recycles an inode.
- Retained continuations now carry the original private dependency-snapshot
  fingerprint, exclude only proven setup directories from change attribution,
  and check dependency integrity before and after resuming, including turns
  with no verification commands.
- Continuation references now reserve their single-use authority through
  pre-execution setup, so a retained-worktree lease refresh failure or
  cancellation before worker entry no longer burns an otherwise retryable
  continuation. Reservations keep lifecycle/worktree ownership protected,
  preserve the original expiry, and still become permanently consumed at
  executor entry.
- Startup diagnostics now report when invalid allowed-effort entries,
  parallelism, or per-batch worker limits were corrected, naming only the
  effective runtime values rather than echoing raw environment input.
- Final Git evidence now preserves both sides of staged rename/copy records, so
  deleting an out-of-scope source through a rename cannot disappear behind an
  allowed destination path during reconciliation.
- Shared worktree-link configuration now rejects paths that could escape the
  repository/worktree roots, reports the effective safe link set at startup,
  and preserves worker-created link effects in independent evidence.
- Bounded shutdown now keeps its timeout authority alive until settlement, so
  an operation that ignores cancellation fails closed with `ShutdownTimeoutError`
  instead of leaving the shutdown promise pending while the event loop drains.
- Retained-worktree continuation setup now distinguishes transient refresh
  failure from lost persistent ownership: transient failures remain retryable
  within the original TTL, while owner loss consumes the reference so unsafe
  cross-process workspace authority cannot be restored.
- Explicitly empty `SOL_LUNA_ALLOWED_EFFORTS` is now treated as a corrected
  widening and produces the same startup diagnostic as other unusable effort
  declarations.
- Persistent worktree-lease maintenance keeps its renewal timer alive until the
  owner stops it, so callers awaiting renewal failure cannot be stranded by an
  otherwise-empty event loop. An owning batch abort now stops that referenced
  timer immediately, so the same liveness guarantee cannot keep a timed-out
  process shutdown alive indefinitely.
- The deterministic test and coverage gates now include the Git-evidence and
  worktree-link regression suites added by this release.
- Runtime and CLI telemetry-path handling now share one absolute-path policy:
  `init` persists absolute log/event paths, invalid legacy relative or empty
  values are reported and disabled, and `activity` distinguishes a missing fresh
  log from an unusable directory/non-file target. Windows root-relative paths are
  rejected as drive-dependent, and a watched file that becomes unusable now
  terminates with an error rather than silently retaining stale state. NDJSON
  watch mode emits each accepted state transition even when several records
  arrive in one filesystem read. Delete/recreate and atomic log rotation now
  detach a stale inode watcher and poll/reattach the pathname; an independent
  low-frequency pathname/content health poll also stays active while `fs.watch`
  appears healthy, so a completely silent stale watcher cannot freeze the live
  view.
- `doctor` now validates both the registered interpreter command and exact server
  entry, while Codex's normal "No MCP server named ... found" response is
  classified as an absent registration instead of an inspection failure.
- Plain `init` now repairs an explicitly disabled MCP registration, verifies the
  enabled state after writing, and `status` exposes that state in human and JSON
  output.
- `status` now reports the registered diagnostic-log path and invalid-path state
  alongside activity telemetry in both human and JSON output; shell
  `SOL_LUNA_LOG` does not mask the server registration.
- Parallel dependency provisioning is now private per worktree. The historical
  `SOL_LUNA_WORKTREE_LINK` setting still selects directories (default
  `node_modules`), but production snapshots them instead of creating writable
  links to the operator workspace. Snapshot ancestry and descendant
  symlink/junction targets are confined, worker mutations cannot alter the source
  dependency tree, and parent verification fingerprints the private copy before
  execution so worker-authored dependency code is never silently executed.
- Git evidence is pinned to an immutable pre-worker authority: common/worktree
  control metadata is fingerprinted, delegated/evidence Git gets private
  config/refs/index/object-write state with replace objects disabled, trusted
  scans use a fresh index and immutable base, ignored files are enumerated, and
  Git stdout/stderr are bounded. Real `.git/modules/**` submodule control
  metadata (including config/hooks/refs/index and lock/control state) is part of
  that authority, and redirected module/control paths fail closed without hashing
  submodule object databases. Nested workspaces preserve normal Git semantics
  while local worker Git config remains private.
- Worktree metadata and integration are serialized by canonical common-Git
  identity across linked worktrees/processes. Integration revalidates
  authoritative destination state and sealed source evidence under that
  authority, binds final copies to the accepted source bytes and destination
  state, and moves proven deletions through a same-parent tombstone before unlink,
  with a separate confined recovery backup.
  Cancellation observed before the first write produces no authoritative write;
  later observed cancellation stops further writes and reports already-applied
  changes truthfully, preserving quarantined deletion bytes when rollback is
  unsafe.
- Evidence-bearing operations now hold a separate persistent repository
  operation authority keyed by canonical common-Git identity, serializing
  direct/sequential/shared-workspace evidence against parallel worktree and
  continuation-lease lifecycle churn without excluding protected `.sol-luna`
  paths from evidence. Continuation expiry reacquires the same authority before
  lease release, different repositories remain concurrent, and final persistent
  owner loss is proven before terminal success and fails closed.
- Single/sequential non-Git workspaces and shared-workspace continuations now
  receive independent content-hashed pre/post filesystem evidence, so
  shell-created or ignored side effects omitted from runtime `file_change`
  events still affect scope/change-intent trust. Nested requested workspaces use
  the same path namespace for execution, evidence, recovery and integration.
- Orchestrator `.sol-luna` worktree/lease roots reject symlink/junction
  redirection before parent-owned mutation. Final/stale worktree deletion removes
  the filesystem tree junction-safely before pruning Git metadata, so
  worker-created links cannot redirect cleanup outside the isolated worktree.
- Integration now treats exclusive create, existing-file truncate, and deletion
  tombstone rename as authoritative mutation boundaries. Short writes are
  completed in a loop; a later write/sync/snapshot/unlink failure either proves a
  safe rollback or is counted truthfully as an applied partial mutation before
  integration stops, so telemetry cannot report zero after authoritative bytes or
  namespace state changed.
- Missing destination ancestry for authoritative integration and private
  dependency snapshots is provisioned segment by segment beneath captured parent
  authority. Identity-aware rollback removes only identical empty directories;
  proven residual mutation counts as applied, while protocol loss reports an
  unknown outcome separately from confirmed applied files.
- Deletion integration now saves a private recovery backup, moves the exact
  original to a verified same-parent tombstone, and restores it by rename when
  safe. Backup cleanup failure and unknown helper outcomes preserve truthful
  mutation counts and retained recovery evidence.
- Single-task continuations preserve the parent's authoritative workspace and
  pinned Git evidence. Lifecycle setup failure and cancellation during trust
  setup restore unspent continuation authority; synchronous expiry-release
  errors no longer prevent later leases from settling.
- Shutdown timeout prevents late normal cleanup from starting, including later
  hooks after an in-flight cleanup settles. Synchronous forced-cleanup errors
  cannot skip the remaining process-liveness hooks.
- Metadata cancellation after lease acquisition releases its persistent owner.
  Pinned filesystem helpers settle spawn/pre-ready failures, drain result output
  before interpreting closure, and recheck parents after awaited setup hooks.
- Activity watch recovers when a file disappears between stat and stream read.
- Removed unused writable dependency-link provisioning and unchecked mutation
  helper operations. Worker-created links to operator dependencies remain
  visible in worktree and retained-continuation evidence.
- Final integrated verification is enclosed by fresh trusted workspace/Git and
  dependency evidence, and private worktree dependency snapshots are
  fingerprinted again after each worker verification turn. A passing verifier can
  no longer mutate workspace, protected Git/control state, ignored files, or
  dependencies and still produce terminal verified completion or a poisoned
  retained continuation.
- Repository-operation and metadata leases now pin the in-memory filesystem
  identity of their common-Git lease namespace, continuation-lease root, and
  exact artifact. Refresh/release rejects ancestor redirection, artifact
  replacement, replayed stale owner records, coexisting live owners, missing live
  generations, and unexpected residual bytes while preserving replacement-owner
  state during stale-acquirer rollback.
- Trusted Git evidence now recursively pins initialized submodule worktrees from
  the immutable gitlink index and independently reports their tracked, untracked,
  and ignored effects. Committed `.gitmodules` `ignore = all` therefore cannot
  suppress child mutations, while post-capture submodule `.git`, worktree, or
  `.git/modules/**` redirection continues to fail closed before unsafe traversal.
- Gitlinks that are uninitialized at admission are pinned separately as missing or
  an exact empty-directory identity. Later population, replacement, non-directory
  state, or symlink/junction redirection invalidates trusted evidence, including
  the final integrated-verifier seal, instead of letting bytes appear underneath a
  previously uninitialized submodule path invisibly.

[Unreleased]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/mahadansar/sol-luna-orchestrator/releases/tag/v0.13.0
