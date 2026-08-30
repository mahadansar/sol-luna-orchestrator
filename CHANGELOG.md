# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.0] - 2026-08-30

### Changed

- Closed the second independent Freeze 3 review's remaining A/B/C blockers
  without changing the V3 experiment. Codex `config.toml` is now parsed as TOML,
  recursively sanitized through nested/inline/array/multiline structures, and
  canonicalized only after credential-, auth-, cookie-, and header-sensitive
  paths are redacted; parse failures are presence-only, and raw config length is
  absent. Trust-material variables retain presence/readability/type and safe
  content fingerprints but no raw path, basename, or path hash. The environment
  drift scan is explicitly a syntactic defense-in-depth check, not proof of every
  possible environment read. The v0.11.0 baseline is now provisioned from a
  clean exact-tag worktree with `npm ci`, built, runtime-pruned, and sealed by the
  frozen aggregate manifest digest
  `d63af9ef92ac99c9a0f8425012fce2777a6dee020c76161bc504aee96dafad17` over
  package/lock, dist, and runtime dependency bytes. Every Adaptive V3 cell must
  match that digest immediately before launch and after grading before a result
  can be written. Finally, the live runner writes a durable campaign launch
  marker immediately before its first SDK call, and freshness now fails closed
  on any marker, valid/invalid/unreadable V3 shard, or ambiguous non-empty event
  stream. Codex SDK provenance and all frozen experimental factors are unchanged.
- Froze Benchmark V3 methodology **freeze 3 (P2.4B pre-launch)**, superseding
  freeze 2. It changes no model-facing text, task, grader, hidden reference,
  mutation case, arm, model, effort, speed profile, pricing applicability,
  repetition count, or third-run admission rule, and no production runtime
  behaviour. It reconciles the delegation-call metric with the refusal traces
  the runtime actually emits — a call the runtime refuses before any worker
  attempt starts publishes `batch.started` and then `batch.rejected`, and is now
  counted in `delegationCallsRefused` rather than as an opened worker batch,
  contributing no batch mode, no queued worker effort, and no phase boundary.
  Benchmark environment capture now resolves `git`, `npm`, and `codex` through
  the production executable resolver, so the current directory is never searched
  and both versions are readable on Windows for the first time. The recorded
  reproducibility inventory maintains the repository-owned execution settings,
  anything deliberately excluded carries a recorded reason, and a deterministic
  syntactic test scans the direct access forms it explicitly supports. That inventory no
  longer claims more than it establishes: a benchmark record now carries three
  separate layers — the production-owned settings recorded verbatim, an ambient
  layer that inventories every inherited variable _name_ and records values only
  under an explicit safe classification (proxy and endpoint URLs as
  scheme/host/port with an embedded-credential flag, certificate and trust
  material without path metadata, everything else including every
  credential-shaped name as present-and-opaque), and the non-secret identity of
  the effective Codex configuration (a digest of the structurally parsed and
  recursively sanitized `config.toml`, its registered MCP server names, and
  an authentication mode). A `REPRODUCIBILITY_BOUNDARY` record states in the
  artifact itself what is and is not reproducible, including that the source
  scan proves nothing about environment reads by the Codex SDK, the Codex CLI,
  Node, or the operating system, and that credential state is opaque rather than
  absent. The V3 production baseline under evaluation is repinned to the
  released `v0.11.0` commit, and a campaign is now _bound_ to it: a
  delegation-enabled V3 arm launches the orchestrator from a verified baseline
  artifact — a git worktree of the `v0.11.0` tag built at
  `bench/baseline/v0.11.0` — whose commit, tree object, cleanliness, package
  name and version, declared entry point and its digest, installed dependencies,
  and isolation from the development tree are checked together with its frozen
  runtime-byte manifest, with an unreadable check counted as a failure. The harness passes that
  artifact's absolute entry point as the Codex `mcp_servers` command, so a run
  no longer depends on a mutable external MCP registration, and a V3 snapshot
  refuses to be written without the verified runtime identity. Added
  `npm run bench:v3:checkpoint`, which generates the pre-launch checkpoint from
  the harness rather than by hand, derives live-execution history and campaign
  identity from the committed evidence directory rather than asserting them, and
  leaves pricing explicitly unresolved until an authoritative source is read.
- Completed Benchmark V3 campaign `2026-08-30T04-26-16-817Z` against the
  released v0.11.0 production baseline at standard Codex speed. All 36 runs were
  valid: nine tasks, Solo Medium versus Adaptive Medium, two repetitions, with
  `gpt-5.6-sol` at Medium supervising. Both strategies passed every task, but
  v0.11.0 Adaptive delegated zero workers and was slower and more expensive
  overall. This two-repetition result is directional and not statistically
  significant. It led to the post-V3 routing corrections intended for v0.12.0;
  those corrections have not received another full campaign, so no post-v0.11
  performance improvement is claimed.

## [0.11.0] - 2026-08-29

### Added

- Added P1.1 reasoned failure decisions on top of canonical per-execution
  evidence. Current task outcomes conservatively classify success,
  cancellation, timeout, runtime/process, verification, scope/conflict,
  security/trust, contract/requirement, environment/tooling, implementation,
  effort, capability, evidence, and unknown failures, then select exactly one
  stop, repair, continuation, retry, effort-escalation, stronger-executor
  fallback recommendation, or parent-takeover action. Existing automatic repair
  precedes existing one-turn parallel recovery and neither may nest or chain;
  generic runtime errors and counter availability alone never authorize retry.
  Decisions retain source execution ids, retry bounds, lineage, truthful usage,
  cancellation, and successful siblings. Stronger-executor selection and compute
  policy remain P1.2-owned.
- Added canonical per-execution attempt evidence to task and batch results, with
  stable execution identity, logical ordinal, repair/continuation/recovery
  lineage, requested model and effort, thread facts, worker and verification
  timing, termination origin, claimed outcome, authoritative verification, and
  explicitly reported or unavailable usage. New `attempt.started` and
  `attempt.completed` events make multiple executions independently observable
  without putting prompts, source, or verification/subprocess output into the
  activity stream. Post-execution cleanup and lifecycle failures now return
  `needs-supervisor` with completed task and sibling evidence retained.
- Added a cheap routing eligibility preflight. An optional `routing_preflight`
  advisory tool and an optional `routingPreflight` card on `delegate_task` and
  `delegate_tasks` let the parent test a delegation before paying for it. A pure
  synchronous evaluator (no filesystem, process, network, model call, or
  repository analysis) returns a `solo` / `either` / `delegation-plausible`
  route, the deciding signals, and a structural `parallelEligible` boolean.
  Structural refusals read raw declarations only — an empty seam list on any
  surface, and in parallel mode declared mutable shared state, a declared shared
  core, or more tasks than declared seams — and are enforced before any worktree
  is created. `allowOverlappingScopes: true` downgrades the shared-core gate
  only. Declaring `unknown` biases advice toward solo but never refuses, coupling
  advice never blocks execution, and the card is optional: with none attached,
  behavior is unchanged. The card itself declares no model or effort. The
  evaluator derives a bounded execution shape and starting compute selection
  only from the active operator envelope; those fields remain advisory and
  never rewrite an admitted task contract or widen concurrency. New
  `routing.preflight`, `routing.declared`, and
  `routing.contradiction` telemetry records raw declared values, counts, gates,
  signals, and eligibility, and never seam labels, objectives, rationale, scores,
  or cost estimates. Metadata budgets now measure the schemas the server actually
  registers: `advertisedTotal` bounds everything advertised with the routing card
  included, while `delegationContract` and `routingCombined` attribute that same
  total to the delegation protocol and to routing without either standing in for
  it.
- Changed the advertised metadata accounting so every budget bounds a schema the
  MCP server really registers. The previous per-surface delegation entries and
  the `combined` ceiling measured the delegation contract with the routing card
  removed, so they no longer bounded what the parent was actually sent.
  `delegateTask` and `delegateTasks` now include the card and have explicit
  raised ceilings, `advertisedCombined`/`advertisedTotal` bound the real
  advertised totals, and the card-excluded figures are retained as the
  `*Contract`/`delegationContract` diagnostics they always were.
- Added the frozen Benchmark V3 routing holdout: nine new deterministic
  engineering fixtures, hidden references, evaluator-only routing categories,
  Solo/Adaptive campaign support, pricing revalidation, checkpoint-compatible
  evidence, and routing/economic analysis. The P2.4A freeze-2 review and
  deterministic harness closure are complete. No model-backed V3 campaign was
  run; P2.4B remains not executed.
- Completed P1.2 compute-policy/selection, P1.3 context-lifecycle,
  P2.1 read-only explorer, P2.2 informational cross-session handoff, and P2.3
  bounded workflow composition surfaces. Their current acceptance is
  deterministic only.

### Fixed

- Prevented cancellation after a worker's final event from skipping declared
  authoritative verification and producing a trustworthy PASS.
- Classified cancellation during authoritative verification as terminal, so it
  cannot issue a continuation.
- Gave earned next-action authority an atomic `ready -> reserved -> consumed`
  lifecycle instead of consuming it at contract resolution. Both delegation
  surfaces read an `hdf_` reference before several gates that can still refuse --
  executor selection, structural routing, compute admission, workspace
  resolution, the authoritative-workspace match, scope conflicts, a refused
  routing gate, a malformed sibling reference -- and every one of those refusals
  destroyed an escalation without running a worker. A batch made this collective:
  one invalid or overlapping sibling burned every valid sibling handoff already
  read. Reserving takes the reference out of circulation and retires it as `used`
  for concurrent consumers, so the single-use bound is unchanged and two
  consumers can never both execute; a refusal that ran nothing releases it back
  with its original expiry, and entering the executor commits it permanently.
  Authority that expires while reserved is retired rather than handed back, a
  reservation settles exactly once whichever order `commit` and `release` arrive
  in, and a reserved reference still owns its lifecycle context so a concurrent
  sweep cannot reclaim a context a live capability still names.
- Made an expiring continuation surrender the persistent worktree lease it owns.
  An unused `ctr_` reference that reached its TTL dropped its lease silently, so
  the retained worktree identity stayed reserved -- and `pruneStaleWorktrees`
  refused to reclaim it -- until the lease's own unrelated filesystem TTL ran
  out. The release now happens exactly once, on the single transition out of the
  issued set, and never for a consumed reference whose turn owns the lease.
- Stopped a next-action handoff issued after a retained-worktree continuation
  from naming a directory that same turn had just released. A handoff restarts
  the contract rather than resuming the thread, so it is now bound to the
  authoritative workspace a fresh attempt belongs in, exactly as batch-issued
  handoffs already were.
- Unified which executor a first turn runs under. Single delegation preferred
  `LUNA_MODEL` and otherwise took `allowedModels[0]`, batch took
  `allowedModels[0]` outright, and selection declined to resolve the choice at
  all, so one envelope could name different executors on different surfaces and a
  membership set's incidental order was read as preference. One rule now answers
  it everywhere -- a usable `executorOrder`, else a single authorized model, else
  the configured `LUNA_MODEL` baseline -- and an envelope that declares none of
  those is refused rather than resolved by list position.
- Stopped a failure raised after a result was already published from emitting a
  second, contradicting terminal event for the same batch identity. A throw in
  post-completion bookkeeping or rendering is now reported to the caller without
  re-reporting a settled worker outcome as a failure.
- Stopped `ContextLifecycleStore.reset` from clearing live execution leases.
  Replacing history reported an in-flight store as idle, which is exactly the
  state that lets compaction run under a running worker and lets the registry
  reclaim a context another call still holds.
- Corrected aggregate usage truthfulness across repair and recovery executions.
  A top-level total is now present only when every constituent execution has
  authoritative Codex `turn.completed` usage; known constituent usage remains
  visible in its own attempt evidence when the aggregate is unknown.

## [0.10.0] - 2026-08-25

This release introduces the Thin Supervisor execution model. It intentionally
changes the successful-response default: callers omitting `resultDetail` now
receive the thin verified handoff for a clean PASS instead of the full structured
successful response.

### Added

- Added deterministic final-workspace verification for delegated batches. The
  runtime reruns the deduplicated union of declared verification commands after
  sequential work or successful parallel integration and reports explicit
  `verified-complete` or `needs-supervisor` completion states.
- Added bounded, targeted parallel recovery with a batch-level opt-out. One
  eligible timeout may resume in its task's thread/worktree, or one no-result
  worker-process failure may retry in a fresh thread in the same worktree.
  Successful sibling work is preserved, and recovery decisions, attempt
  ordinals, duration, usage, final verification, and activity events remain
  observable.
- Added Benchmark V2 with eight externally graded fixtures, fixed-effort
  Solo/Adaptive/Forced arms, schema-4 credit telemetry, resumable campaign
  checkpoints, Pareto reporting, selective third-repetition recommendations,
  and committed evidence-qualified campaign results.
- Added the initial P2.4A acceptance-harness foundation and froze Benchmark V3
  methodology freeze 1 before any model-backed V3 run. The current freeze-2
  completion is recorded under Unreleased, not as v0.10.0 behavior. The
  benchmark runner now captures
  reproducibility evidence with every shard — git commit, branch, describe,
  working-tree cleanliness, Node/platform/OS/CPU/timezone, package, npm, Codex
  CLI and SDK versions, the exact invocation, and allowlisted orchestrator
  environment overrides — and a V3 campaign refuses to launch without it or
  against a dirty working tree. Execution order is fixed and published before
  the first live turn, either as the declared fixture order or as a
  platform-independent seeded shuffle of tasks within a repetition and arms
  within a task; a resume cannot reorder work after results exist.
  `bench/V3_METHODOLOGY.md` is content-addressed and verified at launch, so a
  silent edit to arms, graders, or stopping rules fails loudly instead of
  passing unnoticed. Predeclared exclusion rules classify each run as valid or
  quarantined from evidence alone — blind to pass/fail, credits, latency, worker
  count, and arm — and quarantined runs are retained, listed with their reasons,
  and excluded from every aggregate; a failing grade, a changed protected
  specification, an uncaught mutation, and an exhausted time bound remain
  results, not exclusions. The harness performs no automatic re-execution of a
  live cell and no grading retries. Run records now also carry delegation,
  exploration, attempt-by-role, repair, recovery, continuation, effort- and
  executor-escalation, wasted-attempt, unavailable-usage, scope, routing,
  integration, and context size/compaction counts folded from the orchestrator's
  own event stream, and generated reports add reproducibility, run-validity,
  supervisor-overhead, orchestration, and context sections. Unknown stays
  unknown throughout; no token, credit, or timing field is ever back-filled.
- Added `docs/FEATURE_ACCEPTANCE.md` final acceptance boundary for P1.0 through
  P2.3, separating deterministic/code-confirmed acceptance from live
  model-backed behavioural evidence and from benchmark performance/economics
  evidence. P1.1, P1.2, P1.3, P2.1, P2.2, and P2.3 hold deterministic acceptance
  only; no live or benchmark evidence is claimed for them.

### Changed

- Benchmark V3 no longer configures worker concurrency. V2 set
  `SOL_LUNA_MAX_PARALLEL` per fixture from that fixture's declared natural
  stream count; in V3 the same stream count is derived from the structure that
  defines the evaluator-only routing category, so passing it through would give
  the orchestrator a task-specific hint about the exact question V3 asks. V3
  now configures no orchestrator policy at all and measures the shipped
  production defaults. V2's committed records and behaviour are unchanged.
- Made `resultDetail: "handoff"` the default. Clean verified PASS responses are
  text-only and omit `structuredContent`; failures and suspicious states expand
  to rich evidence progressively. Callers requiring structured success output
  can explicitly request `compact` or `full`.
- Reduced repeated MCP instruction, tool-schema, and successful-result metadata
  while preserving runtime validators, ownership, security, verification,
  recovery, evidence, and cost qualifications. Benchmark V2 showed substantially
  less supervisor duplication and overhead, but final Adaptive did not beat Solo
  overall on the frozen campaign.

### Fixed

- Corrected future Benchmark V2 third-repetition analysis so Solo cells no
  longer receive meaningless Solo-versus-Solo near-tie recommendations. Frozen
  historical campaign evidence remains unchanged.

### Migration

- Callers that relied on omitted `resultDetail` returning `structuredContent` on
  clean successful responses should explicitly request `resultDetail="compact"`
  or `resultDetail="full"`.

## [0.9.1] - 2026-08-24

A maintenance and hardening patch for worktree retention, cancellation, and
release evidence.

### Changed

- Expanded deterministic lifecycle, integration, symlink, process-cleanup, and
  security coverage across the supported worktree and verification paths.
- Reconciled configuration, troubleshooting, observability, security, release,
  and acceptance documentation. Removed the temporary `findings.md` after its
  durable conclusions were incorporated into the feature-acceptance ledger.

### Fixed

- Cancelled worker results are now terminal for continuation eligibility, so a
  retained diagnostic worktree does not receive a continuation reference or
  keep a continuation lease after cancellation.
- Retained-continuation reconciliation now ignores the unchanged,
  orchestrator-owned shared dependency link while still reporting a replaced
  directory or retargeted link as observed evidence.
- Defined `SOL_LUNA_KEEP_WORKTREES=never` as absolute for intentional retention,
  including conflicts, disabled or partial integration, evidence failures, and
  worktree-bound continuations. Continuation references and leases now agree
  with the path that survives cleanup, while structured failure and integration
  evidence remains available.
- `onFailure` now retains normally completed `FAILED` and `BLOCKED` results
  instead of treating their completed lifecycle state as cleanup success, and
  integration/activity wording no longer claims a worktree was retained when
  configured cleanup removed it.

## [0.9.0] - 2026-08-24

### Added

- Explicit per-task `changeIntent` contracts distinguish work where edits are
  `forbidden`, `optional`, or `required`, independently of file scope and task
  category. Omitted intent retains the compatible `required` default.
- An opaque, single-use `continue_task` reference can resume one eligible worker
  thread for one explicit follow-up without widening its original contract.
- Fresh tasks can opt into one bounded same-thread automatic repair after the
  runtime conservatively classifies a single authoritative verification failure
  as a local implementation defect.
- A pure post-hoc cost foundation keeps parent identity and billing context
  explicit, applies caller-supplied rate cards only to eligible observed usage,
  and returns stable unavailable reasons instead of inferring prices or account
  state.
- Structured worker-declared `failureCauses`, with conservative normalization
  for legacy reports and fail-closed validation for invalid new reports.

### Changed

- Authoritative verification may override a worker `FAILED` only when its sole
  declared cause is verification and complete one-to-one structured command
  evidence proves every worker-side failure is contradicted by successful
  authoritative execution. The contradiction and worker claim remain visible,
  and the result is not marked trustworthy.
- Documentation now has explicit ownership boundaries, a feature-acceptance
  ledger, and a transient release-body workflow instead of duplicate discovery,
  acceptance, and release-note sources. Setup and upgrade guidance now presents
  `init` and `doctor` as the normal reconciliation lifecycle.

### Fixed

- Parallel worktree lifecycle now serializes shared Git metadata operations,
  protects active and continuation-owned worktrees with bounded owner-specific
  leases, fails closed on renewal or evidence errors, and reports partial,
  failed, disabled, or unattempted integration without overstating success.
- The worker structured-output schema stays within the live model's supported
  subset while duplicate `failureCauses` remain rejected after parsing.
- Sequential batches no longer construct or render parallel integration
  conflicts when a later dependent task intentionally edits an earlier task's
  file. Parallel same-file collision behavior is unchanged.

## [0.8.1] - 2026-08-23

A focused delegation-guidance and cost-semantics patch.

### Changed

- Clarified adaptive zero-worker guidance, single-task versus batch use, batch
  cost trade-offs, and declared-overlap behavior.
- Documented batch-level `resultDetail`, the meaning of an empty `allowedFiles`,
  the read-only classification roadmap note, and dated human pricing examples.
- Added regression coverage for these guidance and schema-description
  distinctions.

No delegation input/output schema shape or execution algorithm changed.

## [0.8.0] - 2026-08-22

### Added

- Normal `init` now installs an idempotent, surgical discovery hint in the active
  global Codex instruction file (`AGENTS.override.md` when it is the file Codex
  loads, otherwise `AGENTS.md`), so a fresh chat is directed to discover this MCP
  before deciding how to route work. `status`, `doctor`, dry-run, opt-out and
  uninstall report or manage only that exact block, and never other content in
  those user-owned files.
- Fresh-chat guidance documents the canonical MCP prompt and an explicit
  `delegate_tasks` batch prompt while keeping delegation optional.
- Optional `activityLabel` on single and batch task contracts: a short,
  bounded label for the local activity view. It is deliberately persisted
  locally, so it can reveal a brief description of the delegated work.
- A single `delegate_task` now emits typed lifecycle events as a synthetic
  single-mode batch, so `activity` shows queued, started, verifying, timed-out,
  cancelled and completed states for one delegation as it does for a batch. The
  human view was reworked around batch state, per-worker blocks and known failure
  reasons.
- `delegate_tasks` publishes its task-count cap in the tool schema as `maxItems`
  and still rejects an oversized batch at runtime.
- Added discovery guidance, [Observability](docs/OBSERVABILITY.md), and a manual
  live-acceptance procedure for changes that only a real session can verify.
  Discovery mechanics now live in [Configuration](docs/CONFIGURATION.md#discovery-hint-and-adaptive-routing),
  routing policy in [SOL_RULES](SOL_RULES.md), and the acceptance procedure in
  [Contributing](CONTRIBUTING.md#live-model-backed-acceptance).

### Changed

- Parent-orchestrator guidance is model-agnostic while preserving the Sol-Luna
  product identity and the GPT-5.6 Luna worker default. Any compatible Codex
  parent may supervise; parent model and effort examples are documented as
  creator experience rather than requirements.
- Cost guidance is parent-conditional. The runtime guidance no longer states a
  fixed worker/parent price ratio: cheaper-worker economics apply only when the
  selected parent is actually priced above the worker on the current schedule,
  and no realised saving has been measured.
- Parent guidance now explicitly requires silence while an active delegation has
  no meaningful new state, while preserving result, error, cancellation, timeout
  and actionable-state reporting. This remains guidance to the parent
  model/client rather than server-enforced output behavior.
- `verificationCommands` guidance asks for targeted deterministic checks that
  prove the bounded task, leaving broader final validation with the parent unless
  the delegated task genuinely needs it.
- Task ids are opaque (`t1`, `t2`, …) rather than derived from objective text, so
  an id cannot leak the brief through telemetry or a worktree directory name.
- Telemetry privacy: objectives, worker prompts, task context, source code and
  verification command output are excluded from the activity event stream. Only a
  short failure reason may surface from a failed check. Paths, labels and failure
  reasons remain locally revealing.
- Deterministic tests supply their own event sink instead of inheriting the
  configured production telemetry paths, so running the suite cannot pollute a
  machine's activity history or diagnostic log.

### Fixed

- Activity parsing now validates known event shapes and sanitizes strings read
  from existing JSONL, so malformed legacy or hand-edited fields cannot crash the
  human view or inject terminal control sequences.
- The activity reducer selects the newest batch by event timestamp, tolerates
  out-of-order and non-ISO timestamps in older files, and no longer overwrites a
  timed-out worker state with `completed` when a compatibility completion record
  follows it.
- `status` and `doctor` report the registered server's configuration — worker
  model, maximum workers, verification mode, allowed roots and the recursion
  disable target — instead of whatever the CLI's own shell environment happens to
  hold. The two are separate processes, and the registered values are the ones
  the running server uses.
- A batch worker timeout event records the effective default timeout instead of
  `0` when the task contract did not set one.

## [0.7.1] - 2026-08-22

A focused consistency, context-efficiency, and activity reliability patch.

### Changed

- Substantially reduced always-exposed supervisor guidance, tool descriptions,
  schema descriptions, and `SOL_RULES.md` while preserving public delegation
  semantics, compatibility defaults, cost awareness, and risk-based review.
- Corrected delegation framing to cover one bounded executable task as well as
  sequential dependent/shared-workspace and parallel independent/disjoint
  batches, without narrowing valid work to implementation.
- Clarified architecture, legacy `context` versus structured `contextCapsule`,
  compact versus full result detail, verification authority, and the treatment
  of completed worker results that still require supervisor review.
- Aligned the README, contributor guidance, troubleshooting command, package
  description, and annotated Codex configuration example with current behavior.
- Kept benchmark evidence separate from operational guidance and distinguished
  raw token counts from model-priced credit cost.

### Fixed

- MCP `serverInfo.version` now follows the package implementation version rather
  than advertising the initial hard-coded `1.0.0` placeholder.
- Worker and schema wording no longer narrows valid delegated work to
  implementation or assumes the default verification policy is always active.
- `activity --watch` now catches events written before a delayed watcher attaches
  and serializes file-change processing, avoiding missed or overlapping updates.

## [0.7.0] - 2026-08-20

Context-efficient delegation with structured worker briefs and compact result
payloads.

### Added

- **Context Capsule v2 (`contextCapsule`)**: optional structured worker context
  allowing the supervisor to pass selected, task-relevant background information
  without dumping the entire supervisor session.
  - Supports `relevantContext`, `interfaces`, `dependencies`, `invariants`,
    `upstreamDecisions`, and `knownPitfalls`.
  - Empty or whitespace-only fields are automatically omitted from the worker prompt.
  - Fully backwards compatible with existing task contracts.
- **Compact Evidence Packets (`resultDetail: "full" | "compact"`)**: optional
  result detail control on `delegate_task` and `delegate_tasks`.
  - Schema and API default remains `"full"`, preserving complete backwards compatibility.
  - Callers omitting `resultDetail` retain previous full behavior.
  - In `"compact"` mode, clears successful verification command stdout/stderr
    from `structuredContent`, significantly reducing routine result payload size.
    Failed, refused, or skipped verification evidence is always retained.
  - Preserves `filesChanged[].why` and all discrepancies, verdicts, and scope violations.
  - Readable text result (`content[].text`) remains unchanged across both modes.
- `ROADMAP.md`: prioritised future work with dependencies between items and
  design choices that are deliberately not goals.

### Changed

- `ROADMAP.md`: updated roadmap tracking, marking P0.1 (Context Capsule v2) and
  P0.2 (Compact Evidence Packets) as shipped in v0.7.0 while keeping P0.3+ as
  future work. Replaced narrow P1.2 fallback item with adaptive worker routing
  inside a user-controlled compute policy.
- Reorganised the README into a landing page and moved reference details into
  focused documents: `docs/CONFIGURATION.md` for environment variables, init
  flags, Codex settings, and log paths, and `docs/TROUBLESHOOTING.md` for
  symptoms and configuration recovery.

## [0.6.1] - 2026-08-17

A patch release making live orchestration activity inspection work out of the
box after `init`, plus self-repair for existing v0.6.0 installations and explicit
log path replacement fixes.

### Fixed

- **`activity` did not work after a normal `init`.** The event path lives in
  `[mcp_servers.<name>.env]`, which Codex injects into the MCP server it
  launches — a standalone CLI process is not that child and never saw it, so
  `activity` reported `SOL_LUNA_EVENTS is not set` however well the install was
  configured. Compounding it, `init` never wrote the key at all, so no events
  were being recorded either. `init` now configures an event path, and every
  command resolves it the same way. No manual shell export is required.
- Re-running `init` on an installation made by 0.6.0 now repairs the missing
  event path instead of reporting `Already configured` and leaving `activity`
  broken. A path you set yourself is never overwritten.
- `init --log <path>` was inert on an already-configured install: the
  "already configured" shortcut returned before writing, and the write itself
  only ran when no log path was set. Both `--log` and `--events` are now treated
  as explicit requests that replace an existing value; a plain `init` still
  preserves whatever you set.
- `status` reported telemetry as off whenever the current shell lacked
  `SOL_LUNA_EVENTS`, contradicting a correctly configured server. It now shows
  the effective path and where it came from.

### Added

- `init --events <path>` chooses the activity event file. The default is
  `sol-luna-orchestrator.events.jsonl` under the Codex home, so history
  accumulates across projects rather than inside whichever repository `init` ran
  in.
- `doctor` checks the activity event configuration, so the key `init` writes is
  one the diagnostic knows about.

## [0.6.0] - 2026-08-17

Live orchestration activity inspection, adaptive delegation onboarding, scale
benchmark suites, and event stream reliability hardening.

### Added

- **Live orchestration activity inspection** (`sol-luna-orchestrator activity`):
  inspect active batch state, execution mode, worker tasks, reasoning effort,
  model, duration, worktree paths, verification status, and integration
  conflicts. Includes `--watch` (live incremental monitoring with TTY-aware
  rendering) and `--json` (machine-readable snapshot).
- **Hardened event stream consumer**: buffered handling of partial JSONL lines,
  incremental UTF-8 decoding (`StringDecoder`), safe handling of file truncation
  and non-TTY outputs.
- **Scale benchmark suite** (`npm run bench -- --suite scale`): three fixtures —
  four independent modules, six independent modules, and a deliberately coupled
  control with no natural seam — at roughly twice the module depth of the earlier
  suites. Reference solutions and `bench:validate` coverage included.
- **`adaptive` arm**: delegation tools available, guidance that neither mandates
  nor forbids their use, so the arm measures the supervisor's natural policy.
- **Overhead decomposition** per orchestrated run — supervisor before the batch,
  worktree setup, worker window, slowest worker, integration, supervisor review,
  and peak concurrency — derived from existing event timestamps.
- **`npm run bench:analyze`**: crossover verdict across every committed results
  file. Reports missing usage as `unknown` rather than zero, so pre-0.4.0 runs
  cannot silently understate worker tokens.
- 19 deterministic tests for the harness itself, including concurrency
  measurement, the overhead decomposition, and a check that every fixture marks
  its own specification immutable.

### Changed

- **Adaptive delegation Quick Start**: clarified onboarding flow so users work
  normally with Sol after `init` without manually commanding worker counts,
  modes, or tools. Explicit delegation examples moved to an optional advanced
  section.
- Audited and aligned public documentation with current runtime, benchmark,
  telemetry, and security behavior.
- Normalized benchmark, adaptive-delegation, scope, effort, and telemetry wording
  across the documentation and configuration example.
- Clarified benchmark math and interpretation, and made adaptive delegation —
  including zero workers — explicit in the product positioning.
- Benchmark documentation now reports the crossover investigation: **no latency
  or token crossover at four or six independent streams**, and going from four to
  six made orchestration relatively worse. `bench/RESULTS.md`, the README
  benchmark and value-proposition sections, and `SOL_RULES.md` were updated
  together.
- Roadmap: the "larger benchmark suite / break-even investigation" item is
  complete and has been replaced by the specific question the data raised —
  bounding the slowest worker — plus fixtures larger than a single supervisor
  context.
- Corrected two claims the project's own evidence contradicts: the README
  described a benefit as spending "fewer top-tier tokens" while the benchmarks
  show orchestration using more of them in every measured configuration, and it
  reported "12 parallel runs" with zero integration conflicts where the earlier
  parallel-suite records hold 5 parallel batches and 15 workers.
- Replaced "enforced file scope" with the accurate description — a declared
  scope with violations detected and reported — in the README lead, the npm
  package description and `SOL_RULES.md`. Scope checking is detective, and the
  Limitations section always said so; the summaries did not match it.
- `SECURITY.md` now states that worktree create/remove/prune are serialized, and
  why, so the trust boundary around shared git metadata is documented rather than
  only fixed.
- Added an explicit next-release staging convention rather than retaining a copy
  of the last release body. Release drafting is now transient and governed by
  [Contributing](CONTRIBUTING.md#releasing).

## [0.5.1] - 2026-08-14

Release infrastructure, documentation, and a fix for a race in parallel
delegation.

### Fixed

- **Parallel batches could fail a task that had nothing wrong with it.** Worker
  worktrees were created concurrently, but `git worktree add` walks the shared
  `.git/worktrees` metadata directory, so one creation could abort reading
  another's half-written entry:

  ```
  fatal: failed to read .git/worktrees/<other-task>/commondir: No error
  ```

  The affected task ended with no result, and the batch reported a failure that
  no retry of the work would have fixed. Present in 0.5.0. Every operation that
  mutates that directory — create, remove, prune — is now serialized, and a
  batch builds all of its worktrees before any worker starts.

  Reproduced roughly once per thousand worktree creations, so a run of two or
  three workers was rarely affected and a large batch on a loaded machine more
  often. Worker execution itself is unchanged and still fully concurrent.

- Parallel batches now reach their configured concurrency reliably. Workers
  previously queued behind each other's worktree setup while holding a slot: an
  eight-task batch peaked at three to six concurrent workers instead of eight.

- Parallel test fixtures no longer identify a task by the order the executor
  happened to be called in. Concurrent execution does not preserve input order,
  so a fixture could attribute one task's behaviour to another and fail for a
  reason unrelated to the code under test. Fixtures now key off each task's own
  declared scope, and batch assertions report per-task state on failure instead
  of a bare count mismatch.

### Added

- `.github/workflows/publish.yml`: npm publication from a version tag via npm
  Trusted Publishing (OIDC). No npm token, no repository secret, nothing to
  rotate. Because the repository and package are both public, npm attaches
  provenance automatically.
- The publish workflow refuses to run if the pushed tag does not match
  `package.json`, before anything is built or published.
- A release procedure for maintainers in `CONTRIBUTING.md`.
- npm version badge in the README, now that the package is actually on npm.

### Changed

- Roadmap: removed "Publishing to npm", which shipped in 0.5.0. Expanded the
  benchmark, worker-continuation and sandboxed-verification entries to say what
  each would actually involve — and, for the benchmark, that no crossover point
  has been shown to exist.

## [0.5.0] - 2026-08-14

Release-candidate pass: current Node support, stricter CLI argument handling, and
platform claims brought in line with what CI has actually executed.

### Added

- GitHub issue templates (bug report, feature request) and a pull request
  template. The bug template asks for `doctor` output, versions and a redacted
  log rather than leaving reporters to guess.
- CI now runs the CLI/configuration suite and a `npm pack --dry-run` packaging
  check, so a change to `files` or `bin` fails before it can reach npm.
- Tests that assert the supported Node range agrees across `engines`, the CLI
  doctor, the CI matrix and the README.
- `SECURITY.md` sections on parallel worktrees — including that
  `SOL_LUNA_WORKTREE_LINK` shares directories rather than copying them — and on
  what log and telemetry files can contain.

### Changed

- **Minimum supported Node is now 22.12.** Node 20 reached end of life and is no
  longer tested or supported. Nothing in the code requires a newer API; the bump
  is a support-policy decision, not a technical one.
- CI matrix is Node 24 (active LTS) and 26 (current) across Windows, Ubuntu and
  macOS. `actions/checkout` and `actions/setup-node` moved to v7, whose node24
  runner ends the Node-20 runtime deprecation warnings on every job.
- `doctor` derives its Node requirement from `engines` instead of a private
  constant, so the diagnostic and the package metadata cannot disagree.
- Platform documentation now reports deterministic CI and live model testing
  separately. CI is verified on all three platforms; live Codex delegation
  remains verified on Windows only.
- ASCII status markers are spelled out (`[ ok ]`, `[FAIL]`, `[WARN]`, `[skip]`)
  instead of abbreviations that had to be decoded.
- Dropped `main` from the manifest. This is a CLI and an MCP server, not a
  library, and pointing `main` at the stdio server meant importing the package
  would start one.

### Fixed

- `init` and `uninstall` now refuse unrecognised options instead of ignoring
  them. `init --dryrun` previously performed a real write.
- `init --log` no longer consumes a following flag as its value; `--log --force`
  reports a missing value and keeps `--force`.

## [0.4.0] - 2026-08-14

One-command setup, and full usage telemetry for parallel batches.

### Added

- `sol-luna-orchestrator` CLI with `init`, `doctor`, `status`, `uninstall` and
  `version`. Setup is now a single command instead of hand-editing TOML.
- Split bins: `sol-luna-orchestrator` is the user CLI, and
  `sol-luna-orchestrator-mcp` is the stdio server Codex launches. Running the
  CLI can no longer accidentally start a server that waits forever on a pipe.
- `doctor` checks Node, git, Codex, authentication, registration, the resolved
  server path, both required settings, verification mode and logging — each with
  the command that fixes it. `--json` for automation. No model calls.
- `init` is idempotent: it inspects first, repairs only what is wrong, and
  reports `Already configured` otherwise. `--dry-run`, `--force`, `--log`.
- `init` refuses to register an install running from an npx cache, which npm can
  evict, leaving a config that breaks silently later (`--allow-ephemeral` to
  override).
- A surgical TOML editor that changes only the keys this project owns, keeping
  comments, formatting, key order and unrelated tables byte-identical.
- Batch worker telemetry now records full usage (input, cached input, output and
  reasoning tokens) plus model and effort, not output tokens alone.
- CLI lifecycle smoke test (`npm run smoke:cli`) covering eight scenarios against
  a real Codex CLI and isolated `CODEX_HOME` directories. No model calls.

### Changed

- Registration no longer uses `codex mcp add` / `codex mcp remove`. Measured
  against codex-cli 0.147.0, adding a server round-trips the whole config: it
  deleted the comment above an unrelated `context7` table and rewrote that
  server's `startup_timeout_sec = 15` as `15.0`. Editing only our own keys avoids
  mutating configuration that belongs to other tools.
- Published package excludes tests, benchmarks and smoke scripts.

### Fixed

- TOML basic-string escapes (`\n`, `\t`, `\uXXXX`) were decoded as their literal
  letter, so a quoted table name did not survive a read/write round trip.

## [0.3.0] - 2026-08-14

Parallel orchestration.

### Added

- `delegate_tasks`: several task contracts in one call, `mode: "parallel"` or
  `mode: "sequential"`. Each task keeps its own effort, so one batch routinely
  mixes `medium`, `high` and `xhigh` workers.
- Git worktree isolation for parallel batches. Each worker gets a detached
  worktree under `.sol-luna/worktrees/<task-id>`, excluded via
  `.git/info/exclude` rather than the user's tracked `.gitignore`.
- Dependency directories (`node_modules` by default,
  `SOL_LUNA_WORKTREE_LINK`) are linked into each worktree — junctions on
  Windows, directory symlinks elsewhere — without which no verification command
  could resolve its imports.
- Scope overlap detection: a parallel batch is refused before any worker starts
  if two tasks could match the same files.
- Integration conflict detection from what workers _actually_ changed. When two
  workers touch the same file nothing is merged and both worktrees are kept.
- Dirty-tree guard: parallel batches are refused when the repository has
  uncommitted changes inside a declared task scope, since workers branch from
  `HEAD` and would neither see nor preserve that work
  (`SOL_LUNA_ALLOW_DIRTY=1` to override).
- Concurrency limit shared by both tools (`SOL_LUNA_MAX_PARALLEL`, default 3,
  hard ceiling 8); excess tasks queue rather than failing.
- Cancellation via the MCP request signal, propagated to worker Codex processes,
  with worktree cleanup. Stale worktrees from a crashed run are pruned, and only
  ones this project created.
- Structured telemetry (`SOL_LUNA_EVENTS`): batch, worker, worktree,
  verification, scope and integration events as JSONL.
- Parallel benchmark suite (`--suite parallel`) with four arms: Sol high solo,
  Sol xhigh solo, Sol high + sequential Luna, Sol high + parallel Luna.
- GitHub Actions CI across Windows, Linux and macOS on Node 20 and 24. No model
  access required.
- Supervisor effort documented as configurable (`medium` / `high` / `xhigh` /
  `max`, `high` recommended).

### Changed

- The single-worker lock became a shared concurrency semaphore. `delegate_task`
  is unchanged from a caller's point of view and still runs directly in the
  workspace with no git requirement.
- Tool descriptions now push the supervisor to decide _whether_ delegating is
  worthwhile, citing the measured micro-benchmark result.

### Fixed

- A task that completed was marked `cancelled` if the batch was cancelled while
  it ran, discarding finished work. Only genuinely interrupted tasks are
  cancelled now.
- Scope overlap between a deep pattern and an extension pattern
  (`src/auth/**` vs `src/**/*.ts`) was missed, because expanded example paths
  carried no file extension.
- `SOL_LUNA_VERIFY_ALLOW` split on `:` and `;`, mangling Windows paths such as
  `C:\tools\runner.exe`. It is comma-separated only.

## [0.2.0] - 2026-08-14

First public release.

### Added

- Verification execution policy (`SOL_LUNA_VERIFY_MODE`): `allowlist` (default),
  `off`, `shell`. The default parses commands into argv with no shell and only
  launches allowlisted executables.
- Credential-shaped environment variables are withheld from verification
  commands (`SOL_LUNA_VERIFY_ENV_PASSTHROUGH=1` to opt out).
- `SOL_LUNA_ALLOWED_ROOTS` confines delegation to specific directory trees.
- Escalation metadata: `taskCategory`, `previousAttempts`, and an `attempt`
  counter plus `escalationAdvice` in the result.
- `SOL_LUNA_EVENTS` writes one JSONL record per delegation (effort, verdict,
  duration, token usage).
- Benchmark harness (`npm run bench`) comparing a solo supervisor against a
  supervisor that delegates, with fixture validation (`bench:validate`) proving
  each task discriminates.
- Security regression suite (`src/security.test.ts`).

### Fixed

- **Symlink escape.** Scope checks compared lexical paths, so a symlink inside
  the workspace pointing outside it looked contained. Paths are now resolved
  through symlinks before comparison.
- **Shell injection surface.** `verificationCommands` were previously executed
  with `shell: true`, so a model-supplied string could chain arbitrary commands.
- **Process-tree leak.** A timed-out verification killed only the direct child,
  orphaning grandchildren (`npm` → `node` → test runner).
- **Case-insensitive scope bypass on macOS.** Glob matching was only
  case-insensitive on Windows, so `SRC/x.ts` could pass an `src/**` rule on a
  case-insensitive macOS filesystem.
- Unvalidated `workingDirectory` is now required to be an absolute path to an
  existing directory.
- A worker `PASS` resting on a command that was refused or skipped is now
  reported as unverified rather than silently accepted.

## [0.1.0] - 2026-08-14

Initial working version, verified end to end.

### Added

- `delegate_task` MCP tool: bounded delegation from a `gpt-5.6-sol` supervisor to
  an isolated `gpt-5.6-luna` worker thread.
- Dynamic worker effort (`medium` / `high` / `xhigh` / `max`), defaulting to
  `high`, with a required `effortReason`.
- Task contract: objective, allowed/forbidden files, acceptance criteria,
  verification commands.
- Independent re-running of verification commands after the worker exits, with
  cross-checking of the worker's claims against runtime-observed file changes.
- Worker isolation via `mcp_servers.<name>.enabled=false` plus a
  `SOL_LUNA_WORKER=1` environment backstop.
- Structured `PASS` / `BLOCKED` / `FAILED` results with discrepancies, scope
  violations, a review checklist, and the worker thread id.

### Notes

- `--config mcp_servers={}` does not isolate workers: Codex merges the override
  and every server still starts. Verified against codex-cli 0.147.0.
- Codex requires `tool_timeout_sec` well above its 60s default, and
  `default_tools_approval_mode = "approve"` (not `"auto"`), or delegation is
  cancelled.

0.5.0 is the first version intended for release. 0.1.0 through 0.4.0 were
development milestones and were never tagged or published, so they have no
release links.

[Unreleased]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/mahadansar/sol-luna-orchestrator/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/mahadansar/sol-luna-orchestrator/releases/tag/v0.5.1
[0.5.0]: https://github.com/mahadansar/sol-luna-orchestrator/releases/tag/v0.5.0
