# Feature acceptance ledger

Living verification ledger for the material behavior at runtime baseline
`6d610b37c277f7c6875627572306585b8f219a45` (2026-08-23). `CHANGELOG.md` is the
source of truth for released behavior; `ROADMAP.md` is used here only to label
unreleased implementation and future work. This ledger does not promote roadmap
items to shipped features. The live/model-backed acceptance procedure and run
template are maintained in [CONTRIBUTING](../CONTRIBUTING.md); this file records
the resulting evidence, freshness, and confidence rather than repeating that
procedure.

## How to read this ledger

Evidence status vocabulary is intentionally small: **N/A**, **NOT TESTED**,
**PARTIAL**, **PASS**, **DEEP PASS**, or **STALE**. Overall confidence is one of
**Unverified**, **Basic**, **Strong**, **Battle-tested**, or **Stale**.

- **N/A:** that evidence class does not apply.
- **NOT TESTED:** coverage may exist, but no execution is established.
- **PARTIAL:** only part of the relevant surface executed or a material gap
  remains.
- **PASS:** the stated relevant paths passed at the stated version or commit.
- **DEEP PASS:** broad or repeated acceptance also exercised important failure
  paths, integration boundaries, or platforms.
- **STALE:** the evidence ran, but a relevant implementation or dependency later
  changed.

- **Unverified:** no relevant execution evidence is established.
- **Basic:** focused deterministic evidence is current, or live evidence is only
  partial.
- **Strong:** broad current deterministic evidence, or current deterministic
  evidence plus a representative live path.
- **Battle-tested:** repeated, varied deterministic and live evidence covers
  important failure paths as well as the happy path.
- **Stale:** evidence once supported a higher confidence, but a relevant behavior
  or dependency changed after it ran.

Coverage means a test or artifact exists. Execution means that it actually ran;
a test file alone is not execution evidence. Freshness means the evidence still
matches the implementation and dependencies at this runtime baseline. A
historical result can therefore have coverage and execution evidence while its
freshness is **STALE**. Dates are UTC dates from committed records or git
history; an execution date is **unknown** when the repository does not establish
it.

Targeted deterministic evidence executed for this ledger on 2026-08-24: the
build passed, and the schema, evidence, prompt, guidance, CLI, and CLI-activity
configuration suites reported **247 pass, 0 fail, 0 skipped**. Coverage outside
those suites was not rerun for this documentation change. Exact command rows and
totals from the preceding broader deterministic cycle are not committed, so the
matrix relies only on execution detail established here or in repository records.

### Final live acceptance campaign

The final real-model campaign ran on 2026-08-24 against runtime baseline
`6d610b37c277f7c6875627572306585b8f219a45`. Its results are session-local but
documented here; raw transcripts, activity output, appended events, and diagnostic
logs are not committed.

- **Single:** a real `gpt-5.6-luna` medium-effort `delegate_task` crossed the live
  API boundary, made the required edit, passed authoritative verification, and
  returned final `PASS` / `trustworthy` evidence matching Git state.
- **Sequential:** both tasks passed; Task 2 consumed and modified Task 1's file in
  the shared workspace. Authoritative verification and Git state matched;
  `integrationConflicts` was empty, `integrated` was true, and `worktreePath` was
  null.
- **Parallel:** both isolated tasks passed with peak concurrency 2 in distinct
  `.sol-luna` worktrees. Two disjoint edits integrated: 2 attempted, 2 applied,
  0 conflicts. Completed worktrees and leases were cleaned according to policy.
- **Retained-worktree continuation:** integration was disabled and the worktree
  retained; the opaque continuation resumed the same Luna thread, made a real
  follow-up edit, and reconciled both retained files under the unchanged original
  contract. Replay was rejected and lease artifacts were released according to
  policy.
- **Activity/privacy:** human and JSON views reflected the actual sequential,
  parallel, integration, concurrency, and retained-worktree states.
  `LIVE_ACCEPTANCE_PRIVATE_SENTINEL_823` was absent from both views and appended
  telemetry; appended telemetry contained neither objective nor context fields.

A later documentation-only parallel run also exercised Context Capsule v2 and
compact result packets, followed by one bounded continuation. It configured no
authoritative verification commands and is recorded only as partial supporting
evidence.

### Historical natural-discovery run

The 2026-08-22 v0.8.0 acceptance run is retained as historical evidence:

- **Client and version:** Codex; version not recorded
- **Parent model and effort:** GPT-5.6 Sol, medium
- **Orchestrator version / commit:** v0.8.0; commit not recorded
- **Worker model and effort:** GPT-5.6 Luna, high
- **Discovery:** found unprompted in a fresh Codex session before the parent
  researched the public repository
- **Routing:** one bounded read-only investigation for the initial broad audit,
  then zero workers for a tightly coupled README refinement; both decisions fit
  the work
- **Silence while pending:** not recorded
- **Parent review:** independent; the parent retained synthesis, editing, and
  final verification, and checked package, release, CI, and link evidence itself
- **Outcome:** completed successfully. The delegated read-only task returned
  `PASS` with no changed files, but the then-current orchestrator still emitted
  its generic no-file-changes discrepancy. There was no solo control; this was
  not a performance benchmark and supports no speed, cost, or quality comparison.
- **Retained evidence:** the task ran in another repository; its transcript and
  diagnostic evidence are not retained here

## Top-level feature matrix

| Capability                                              | State at runtime baseline            | Coverage | Deterministic (last run) | Live (last run)        | Confidence |
| ------------------------------------------------------- | ------------------------------------ | -------- | ------------------------ | ---------------------- | ---------- |
| Zero-worker/adaptive delegation                         | shipped; guidance refined 2026-08-23 | PASS     | PASS (2026-08-24)        | STALE (2026-08-14)     | Stale      |
| Single delegation                                       | shipped                              | PASS     | PASS (2026-08-24)        | PASS (2026-08-24)      | Strong     |
| Sequential batches                                      | shipped                              | PASS     | PARTIAL (2026-08-24)     | PASS (2026-08-24)      | Strong     |
| Parallel batches                                        | shipped                              | PASS     | PARTIAL (2026-08-24)     | DEEP PASS (2026-08-24) | Strong     |
| Worktree isolation/integration                          | shipped                              | PASS     | PARTIAL (2026-08-24)     | DEEP PASS (2026-08-24) | Strong     |
| Bounded concurrency                                     | shipped                              | PASS     | NOT TESTED               | PARTIAL (2026-08-24)   | Basic      |
| Adaptive effort                                         | shipped                              | PASS     | PASS (2026-08-24)        | STALE (2026-08-14)     | Stale      |
| Independent verification                                | shipped                              | PASS     | PASS (2026-08-24)        | PASS (2026-08-24)      | Strong     |
| Claimed-vs-observed reconciliation                      | shipped                              | PASS     | PASS (2026-08-24)        | DEEP PASS (2026-08-24) | Strong     |
| Context Capsule v2                                      | shipped v0.7.0                       | PASS     | PASS (2026-08-24)        | PARTIAL (2026-08-24)   | Basic      |
| Compact Evidence Packets                                | shipped v0.7.0                       | PASS     | PASS (2026-08-24)        | PARTIAL (2026-08-24)   | Basic      |
| CLI init/doctor/status/uninstall                        | shipped                              | PASS     | PASS (2026-08-24)        | NOT TESTED             | Strong     |
| Activity, observability, privacy                        | shipped                              | PASS     | PARTIAL (2026-08-24)     | DEEP PASS (2026-08-24) | Strong     |
| Natural discovery                                       | shipped v0.8.0                       | PASS     | PASS (2026-08-24)        | PARTIAL (2026-08-22)   | Basic      |
| Explicit Change Intent                                  | unreleased on main                   | PASS     | PASS (2026-08-24)        | PARTIAL (2026-08-24)   | Basic      |
| Worker Continuation                                     | unreleased on main                   | PASS     | PASS (2026-08-24)        | DEEP PASS (2026-08-24) | Strong     |
| Bounded Repair                                          | unreleased on main                   | PASS     | PASS (2026-08-24)        | NOT TESTED             | Basic      |
| P1.0 parent/pricing foundation                          | unreleased on main                   | PASS     | PASS (2026-08-24)        | NOT TESTED             | Basic      |
| `failureCauses` and verification contradiction handling | unreleased on main                   | PASS     | PASS (2026-08-24)        | NOT TESTED             | Basic      |

## System-wide invariants

- A parent chooses solo, one worker, sequential, or parallel work adaptively;
  zero workers is valid. Workers cannot delegate recursively: the child config
  disables this server and `SOL_LUNA_WORKER=1` makes the child register no tools.
- Contracts remain bounded by workspace/file scope, forbidden files, acceptance
  criteria, effort, timeout, and verification commands. Scope is a detective
  boundary, not a write sandbox; canonical path and symlink checks still apply.
- Parallel means independent tasks with isolated git worktrees and conservative
  integration. Sequential means shared workspace and ordered dependencies.
  Parallel setup mutations are serialized, concurrency is bounded, and same-file
  observed edits do not get copied over each other.
- Worker reports are claims. The orchestrator independently reruns permitted
  verification, reconciles claimed and observed files, records scope and
  integration conflicts, and leaves final judgment to the parent.
- Verification is conditional on the configured policy. Default command parsing
  is argv-based, shell syntax is refused, executables are constrained, and
  credential-shaped environment variables are withheld.
- Activity is append-only local telemetry. Objectives, prompts, source, and
  verification output are excluded from the activity stream; unavailable usage
  is `null`, never zero. Diagnostic logs remain more sensitive.
- Parent review is risk-based: a clean verified result can be reviewed
  proportionally, while suspicious, failed, contradictory, scope-violating,
  unverified, or integration-conflicted evidence demands deeper inspection.
- Material behavior changes require updating this ledger and marking affected
  and dependent evidence **STALE** until it is rerun. Dependency or upstream
  contract changes use the same rule.

## Detailed records

### Zero-worker/adaptive delegation

- **Implementation/tests:** `src/server.ts`, `src/prompt.ts`, `src/batch.ts`,
  `src/bench/*`; `src/guidance.test.ts`, `src/bench.test.ts`,
  `src/parallel.test.ts`.
- **Authority/history:** policy in `SOL_RULES.md`; acceptance procedure in
  `CONTRIBUTING.md`; `a03a325` (2026-08-14), `18c29b6` and
  `050c6cb` (2026-08-23), followed by `4118525` and `4657768` guidance/test
  alignment.
- **Evidence:** Coverage **PASS**. Targeted guidance/schema execution **PASS** on
  2026-08-24. Committed live benchmark evidence is **STALE**: the
  2026-08-14 scale records show 0/6 free-choice runs delegated and all 6
  passed, but later guidance, batch, evidence, repair, continuation, and
  pricing changes mean this is historical routing evidence, not a current
  closure result. Fresh unprompted discovery is a separate acceptance surface.
- **Dependencies/retest triggers:** parent guidance, tool descriptions, cost
  semantics, batch semantics, or routing changes; rerun a fresh-session
  acceptance and the scale/adaptive benchmark. **Gap:** no current model-backed
  zero-worker run is documented at this runtime baseline.
- **Confidence:** **Stale**.

### Single delegation

- **Implementation/tests:** `src/server.ts`, `src/worker.ts`, `src/batch.ts`;
  `src/selftest.ts`, `src/parallel.test.ts`, `src/bench.test.ts`,
  `src/guidance.test.ts`.
- **Authority/history:** `README.md`, `SOL_RULES.md`, `CHANGELOG.md` v0.5.0;
  initial implementation history `a03a325` (2026-08-14).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24. Final live acceptance **PASS**: a real medium-effort Luna turn
  crossed the API boundary, made the required edit, passed authoritative
  verification, and returned final `PASS` / `trustworthy` evidence matching Git.
  The older committed benchmark records remain **STALE** after later runtime
  changes.
- **Dependencies/retest triggers:** contract/schema, worker lifecycle,
  verification, continuation, repair, or result rendering changes. **Gap:** the
  final run is documented session-local evidence; its raw transcript and logs
  are not committed.
- **Confidence:** **Strong**.

### Sequential batches

- **Implementation/tests:** `src/batch.ts` shared-workspace sequential path;
  `src/parallel.test.ts`, `src/activity.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `README.md`, `SOL_RULES.md`, `CHANGELOG.md` v0.5.0;
  `a03a325` (2026-08-14), `908c977` and `da496df` (2026-08-23).
- **Evidence:** Coverage **PASS**; targeted guidance/schema execution is
  **PARTIAL** because the batch runtime suite was not rerun for this ledger.
  Final live acceptance **PASS**: 2/2 tasks passed in the shared workspace; Task
  2 consumed and modified Task 1's file, authoritative verification and Git
  state matched, `integrationConflicts` was empty, `integrated` was true, and
  `worktreePath` was null. Historical benchmark records remain **STALE** where
  they predate lifecycle and reconciliation hardening.
- **Dependencies/retest triggers:** shared-workspace semantics, cancellation,
  worktree/batch lifecycle, evidence reconciliation, or integration rendering.
  **Gap:** raw final-campaign artifacts are not committed; cancellation and
  failure paths were not part of this live run.
- **Confidence:** **Strong**.

### Parallel batches

- **Implementation/tests:** `src/batch.ts` parallel scheduler;
  `src/parallel.test.ts`, `src/activity.test.ts`, `src/bench.test.ts`.
- **Authority/history:** `README.md`, `SOL_RULES.md`, `CHANGELOG.md` v0.5.0;
  `a03a325`, `5e388c3` (2026-08-14), `da496df` (2026-08-23).
- **Evidence:** Coverage **PASS**; targeted guidance/schema execution is
  **PARTIAL** because the parallel scheduler suite was not rerun for this ledger.
  Final live acceptance **DEEP PASS**: 2/2 isolated tasks passed at peak
  concurrency 2 in distinct `.sol-luna` worktrees; two disjoint edits integrated
  with 2 attempted, 2 applied, and 0 conflicts. Completed worktrees and leases
  were cleaned according to policy. Older committed benchmark evidence remains
  **STALE** where it predates lifecycle fixes.
- **Dependencies/retest triggers:** scheduler, worktree metadata, cancellation,
  overlap, integration, continuation, or verification changes. **Gap:** raw
  final-campaign artifacts are not committed; conflict and cancellation paths
  were not forced in this live run.
- **Confidence:** **Strong**.

### Worktree isolation and integration

- **Implementation/tests:** `src/worktree.ts`, `src/git.ts`, `src/overlap.ts`,
  `src/batch.ts`; `src/parallel.test.ts`, `src/security.test.ts`.
- **Authority/history:** `SECURITY.md`, `SOL_RULES.md`,
  `docs/TROUBLESHOOTING.md`; `5e388c3` and `da496df` (2026-08-14/23).
- **Evidence:** Coverage **PASS**. Targeted execution is **PARTIAL**: evidence
  reconciliation exercised retained-worktree behavior, but the full worktree,
  cleanup, conflict, and integration suite was not rerun for this ledger.
  Final live acceptance **DEEP PASS** covered distinct isolated worktrees, clean
  disjoint integration, policy cleanup of completed worktrees and leases, and a
  deliberately retained integration-disabled worktree used by continuation.
  Older committed evidence remains **STALE** after lifecycle/lease changes.
- **Dependencies/retest triggers:** git version/platform, junction/symlink
  handling, lease ownership, cleanup, or copy integration changes. **Gap:** raw
  final-campaign artifacts are not committed and no durable live platform matrix
  is established.
- **Confidence:** **Strong**.

### Bounded concurrency

- **Implementation/tests:** `src/batch.ts`, `src/config.ts`; `src/parallel.test.ts`,
  `src/bench.test.ts`.
- **Authority/history:** `docs/CONFIGURATION.md`, `SOL_RULES.md`; `a03a325`
  (2026-08-14) and `da496df` (2026-08-23).
- **Evidence:** Coverage **PASS**; tests measure peaks and verify the configured
  ceiling, but they were **NOT TESTED** in this ledger run. Historical scale
  evidence is **STALE**: committed records measured peak concurrency 4 and 6 in
  forced arms under the then-authorized setup, before latest lifecycle changes.
- **Dependencies/retest triggers:** semaphore/config ceiling, scheduler,
  worktree setup, cancellation, or lease changes. **Live evidence:** final
  acceptance observed peak concurrency 2, but did not saturate a larger configured
  ceiling; this remains **PARTIAL**, not a scale result.
- **Confidence:** **Basic**.

### Adaptive worker effort

- **Implementation/tests:** `src/contract.ts`, `src/prompt.ts`, `src/worker.ts`;
  `src/selftest.ts`, `src/parallel.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `SOL_RULES.md`, `docs/CONFIGURATION.md`, `README.md`;
  `a03a325` (2026-08-14).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24. Historical benchmark evidence is **STALE**: 2026-08-14 records show
  per-task medium/high/xhigh choices and no max selection, but later
  prompt/schema/evidence changes affect freshness. No current live
  effort-selection run is recorded.
- **Dependencies/retest triggers:** effort ladder/default, worker prompt/schema,
  continuation/repair attempt rules, or model support changes. **Live gap:** the
  final campaign used configured worker efforts but did not meaningfully test
  adaptive selection.
- **Confidence:** **Stale**.

### Independent verification

- **Implementation/tests:** `src/verify.ts`, `src/command.ts`, `src/worker.ts`;
  `src/security.test.ts`, `src/selftest.ts`, `src/evidence.test.ts`.
- **Authority/history:** `SECURITY.md`, `SOL_RULES.md`, `CONTRIBUTING.md`;
  initial implementation in `a03a325` (2026-08-14), hardening in `908c977`
  (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24, including real exit-code capture, timeout, refusal, authority
  ordering, and output handling. Final live acceptance **PASS**: single and
  sequential tasks ran configured authoritative verification successfully, and
  the final evidence agreed with Git state.
- **Dependencies/retest triggers:** verification policy/parser, command runner,
  worker output schema, or authoritative evidence rules. **Gap:** raw
  final-campaign verification rows are not committed; refusal and failure paths
  were not forced live.
- **Confidence:** **Strong**.

### Claimed-versus-observed reconciliation

- **Implementation/tests:** `src/worker.ts`, `src/batch.ts`, `src/worktree.ts`;
  `src/evidence.test.ts`, `src/parallel.test.ts`, `src/selftest.ts`.
- **Authority/history:** `README.md`, `SOL_RULES.md`, `SECURITY.md`; initial
  implementation `a03a325`, latest contradiction/evidence fixes `908c977` and
  `6d610b3` (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for claimed files, observed edits, forbidden edits, final Git
  snapshots, and discrepancies. Final live acceptance **DEEP PASS**: single and
  sequential authoritative results matched actual Git state; parallel
  integration matched two disjoint edits; and retained-worktree continuation
  reconciled both the original and follow-up files. Historical benchmark workers
  did not produce false passes, but that remains **STALE** context rather than
  current adversarial evidence.
- **Dependencies/retest triggers:** Git snapshot/reconciliation, change intent,
  worktree integration, worker schema, or final-verdict rules. **Gap:** raw
  final-campaign artifacts are not committed and no deceptive worker claim was
  forced live.
- **Confidence:** **Strong**.

### Context Capsule v2

- **Implementation/tests:** `src/contract.ts`, `src/prompt.ts`, `src/server.ts`;
  `src/prompt.test.ts`, `src/evidence.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `CHANGELOG.md` v0.7.0, `SOL_RULES.md`, `ROADMAP.md` P0.1;
  `debd8cb` (2026-08-19).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24; tests cover optional fields, omission of empty values, ordering,
  bounded rendering, malformed input, and activity privacy. The 2026-08-24
  session-local documentation run exercised Context Capsule v2, but its raw
  artifacts are not committed.
- **Dependencies/retest triggers:** capsule schema/prompt rendering, prompt
  boundaries, worker contract, or telemetry changes. **Gap:** no model-backed
  context-efficiency measurement is committed.
- **Confidence:** **Basic**.

### Compact Evidence Packets

- **Implementation/tests:** `src/evidence.test.ts`, `src/worker.ts`,
  `src/server.ts`, `src/contract.ts`.
- **Authority/history:** `CHANGELOG.md` v0.7.0, `SOL_RULES.md`, `ROADMAP.md` P0.2;
  `debd8cb` (2026-08-19).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24; tests verify compact/full defaults, removal of only passing output,
  retention of failures, discrepancies, scope evidence, and text parity. The
  2026-08-24 session-local documentation run exercised compact result packets,
  but its raw artifacts are not committed.
- **Dependencies/retest triggers:** result schema/detail projection, verification
  capture, failure handling, or batch result rendering changes.
- **Confidence:** **Basic**.

### CLI init/doctor/status/uninstall

- **Implementation/tests:** `src/cli.ts`, `src/cli/init.ts`, `src/cli/doctor.ts`,
  `src/cli/uninstall.ts`, `src/cli/settings.ts`, `src/cli/toml-edit.ts`;
  `src/cli.test.ts`, `src/activity-config.test.ts`, `src/smoke-cli.ts`.
- **Authority/history:** `README.md`, `docs/CONFIGURATION.md`,
  `docs/TROUBLESHOOTING.md`, `CHANGELOG.md` v0.5.0/v0.6.1/v0.8.0; `868726b`
  (2026-08-14), `c966365` (2026-08-22).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24. The CLI and CLI-activity configuration suites covered idempotent
  init, repair, doctor, status, uninstall, dry-run, migration, and discovery-hint
  behavior. Live model acceptance is **NOT TESTED**.
- **Dependencies/retest triggers:** Codex config format, Node/Codex versions,
  path resolution, discovery-hint ownership, or CLI writes. **Gap:** the real
  `smoke:cli` program was not rerun for this ledger.
- **Confidence:** **Strong**.

### Activity, observability, and privacy

- **Implementation/tests:** `src/events.ts`, `src/activity.test.ts`,
  `src/activity-watch.test.ts`, `src/activity-config.test.ts`,
  `src/cli/activity.ts`, `src/cli/activity-reducer.ts`, `docs/OBSERVABILITY.md`.
- **Authority/history:** `docs/OBSERVABILITY.md`, `SECURITY.md`, `CHANGELOG.md`
  v0.6.0/v0.8.0; `ce42a06` (2026-08-17), `deca34d` (2026-08-22), `da496df`
  (2026-08-23).
- **Evidence:** Coverage **PASS** and targeted deterministic execution **PARTIAL**
  on 2026-08-24: event-path configuration and prompt-to-activity privacy tests
  passed, but the reducer, watch, redaction, and latest-batch suites were not
  rerun for this ledger. Final live acceptance **DEEP PASS**: human and JSON
  activity views reflected actual sequential, parallel, integration,
  concurrency, and retained-worktree state. The private sentinel was absent from
  both views and appended telemetry, which contained neither objective nor
  context fields.
- **Dependencies/retest triggers:** event schema, reducer projection, path
  resolution, privacy fields, watch attachment, or CLI rendering changes.
  **Gap:** raw activity and telemetry artifacts are not committed; diagnostic
  logs remain more sensitive than activity events.
- **Confidence:** **Strong**.

### Natural discovery

- **Implementation/tests:** `src/cli/discovery-hint.ts`, `src/cli/init.ts`,
  `src/cli/doctor.ts`, `src/cli.test.ts`, `src/activity-config.test.ts`,
  `src/guidance.test.ts`.
- **Authority/history:** setup mechanics in `docs/CONFIGURATION.md`; routing
  policy in `SOL_RULES.md`; acceptance procedure in `CONTRIBUTING.md`;
  `CHANGELOG.md` v0.8.0; `c966365` (2026-08-22), then
  `deca34d` and `4118525` (2026-08-22).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for installation, opt-out, override, and guidance behavior. The
  committed live record reports one 2026-08-22 fresh-session run found the
  orchestrator unprompted, but its transcript and diagnostic evidence were not
  retained, so live acceptance is **PARTIAL**, not a reproducibility claim.
- **Dependencies/retest triggers:** global instruction-file selection, hint text,
  Codex startup/discovery behavior, parent guidance, or init/uninstall changes.
  **Gap:** one observation on one platform and no retained artifacts.
- **Confidence:** **Basic**.

### Explicit Change Intent

- **Implementation/tests:** `src/contract.ts`, `src/prompt.ts`, `src/worker.ts`,
  `src/server.ts`; `src/selftest.ts`, `src/prompt.test.ts`,
  `src/evidence.test.ts`, `src/parallel.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `ROADMAP.md` P0.2a (implemented, pending release),
  `SOL_RULES.md`, `README.md`; `d1be8d6` (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for `required`, `optional`, and `forbidden`, independent of
  `allowedFiles` and task category, including zero-change and forbidden-edit
  classification. Live acceptance is **PARTIAL**: the final single task made its
  required edit and the retained-worktree continuation preserved the original
  contract, but the campaign did not exercise `optional`, `forbidden`, or an
  intent violation.
- **Dependencies/retest triggers:** contract/schema, worker prompt, observed-file
  reconciliation, repair admission, or release of P0.2a. **Gap:** unreleased;
  only `required` intent has current live evidence.
- **Confidence:** **Basic**.

### Worker Continuation

- **Implementation/tests:** `src/continuation.ts`, `src/batch.ts`,
  `src/contract.ts`, `src/server.ts`; `src/selftest.ts`, `src/parallel.test.ts`,
  `src/evidence.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `ROADMAP.md` P0.3 (implemented on main; unreleased),
  `SOL_RULES.md`, `docs/OBSERVABILITY.md`; `cdaf9f5` and `da496df`
  (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for opaque single-use expiry, exact-thread resume, immutable
  contract, repeat verification, integrated/retained worktree binding, and lease
  protection. Live acceptance is **DEEP PASS**: an integration-disabled worktree
  was retained, the continuation resumed the same Luna thread, completed a real
  follow-up edit, and reconciled both retained files under the unchanged original
  contract. Replay was rejected and lease artifacts were released according to
  policy.
- **Dependencies/retest triggers:** continuation TTL/reference store, worktree
  leases, final Git reconciliation, contract fields, or worker lifecycle changes.
  **Gap:** unreleased and raw final-campaign artifacts are not committed; expiry
  was not exercised live.
- **Confidence:** **Strong**.

### Bounded Repair

- **Implementation/tests:** `src/worker.ts`, `src/batch.ts`, `src/contract.ts`,
  `src/events.ts`, `src/continuation.ts`; `src/evidence.test.ts`,
  `src/activity.test.ts`, `src/guidance.test.ts`, `src/selftest.ts`.
- **Authority/history:** `ROADMAP.md` P0.4 (implemented on main; unreleased),
  `SOL_RULES.md`, `docs/OBSERVABILITY.md`; `9d2ebe9` and `da496df`
  (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for the conservative classifier, exact failure evidence,
  same-thread one-turn repair, immutable change intent, re-verification, and
  exhaustion behavior. Live acceptance is **NOT TESTED**.
- **Dependencies/retest triggers:** verifier authority, failure classification,
  continuation, change intent, event lifecycle, or worker thread reuse changes.
  **Gap:** unreleased and no model-backed repair run.
- **Confidence:** **Basic**.

### P1.0 parent/pricing foundation

- **Implementation/tests:** `src/cost.ts`, `src/worker.ts`, `src/contract.ts`;
  `src/selftest.ts`, `src/guidance.test.ts`, `src/activity.test.ts`.
- **Authority/history:** `ROADMAP.md` P1.0 (foundation implemented on main;
  unreleased), `docs/CONFIGURATION.md`, `SOL_RULES.md`; `2d6e4c6` (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for explicit parent-identity provenance, distinct billing contexts,
  promotional cards, complete post-hoc eligibility, stable unavailable reasons,
  freshness/effective bounds, and no inferred prices. Live acceptance is **NOT
  TESTED**.
- **Dependencies/retest triggers:** cost-input schema, rate-card applicability,
  usage projection, identity provenance, or any future routing/policy consumer.
  **Gap:** no retrieval, account lookup, prediction, routing, or measured saving
  is implemented; the foundation is unreleased.
- **Confidence:** **Basic**.

### Worker `failureCauses` and authoritative-verification contradiction handling

- **Implementation/tests:** `src/contract.ts`, `src/prompt.ts`, `src/worker.ts`,
  `src/batch.ts`; `src/selftest.ts`, `src/prompt.test.ts`, `src/evidence.test.ts`,
  `src/parallel.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `CHANGELOG.md` Unreleased, `README.md`, `SOL_RULES.md`,
  `ROADMAP.md` P1.1 note; `908c977` and `6d610b3` (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for strict status-aligned causes, legacy normalization, malformed
  reports, complete one-to-one authoritative contradiction promotion only for a
  sole `verification` cause, terminal-evidence vetoes, and preserved worker claim
  / untrustworthy result. Live acceptance is **NOT TESTED**.
- **Dependencies/retest triggers:** external worker schema, verification
  authority/equivalence, final Git evidence, repair classifier, or failure
  rendering changes. **Gap:** unreleased; this is evidence for future P1.1
  classification, not the future classifier itself, and no model-backed run is
  retained.
- **Confidence:** **Basic**.

## Closure campaign boundary

P2.4 Mature Benchmark and Acceptance Pass is a future system-wide closure
campaign, dependent on the roadmap capstone. It is not the first time these
features were tested and it does not retroactively erase the deterministic,
historical benchmark, or documented session-local live evidence above. Until a
deliberate rerun at the relevant runtime baseline exists, historical live results
remain **STALE** where implementation changed, and unknown execution dates remain
unknown.
