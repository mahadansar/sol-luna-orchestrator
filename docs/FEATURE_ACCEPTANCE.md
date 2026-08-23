# Feature acceptance ledger

Living verification ledger for the material behavior released as `v0.9.0` at
`b38acae33ca8d52740af6e9a0fdc2cf376f08075` (2026-08-23). The executable
runtime is unchanged from `6d610b37c277f7c6875627572306585b8f219a45`; the
intervening commits are documentation and release preparation. `CHANGELOG.md` is the
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

Fresh deterministic evidence executed against the released v0.9.0 tree on
2026-08-24. `npm ci` and `npm run build` passed. An initial native Node coverage
run across every package test suite reported **453 tests: 452 pass, 0 fail, 1
skipped**; the skip was the real on-disk symlink case because symlink creation was
not permitted on this Windows host. It measured **90.56% lines, 84.24% branches,
and 87.93% functions**. Five focused test blocks were then retained for cost
foundation boundaries, Codex subprocess failure handling, and legacy path-only
worktree leases. After rebuild, the affected suites reported **196 pass, 0
fail**, and the final Wave 1 coverage run reported **458 tests: 457 pass, 0 fail,
1 skipped**, measuring **90.70% lines, 84.70% branches, and 88.24% functions**.
The full run covered schemas, prompts, guidance, evidence, CLI/config lifecycle,
activity/reducer/watch compatibility, benchmark invariants, command and
filesystem security, worker verdicts and repair, sequential/parallel scheduling,
worktrees, leases, cancellation, integration, continuation, reconciliation,
pricing primitives, and verification.

### v0.9.0 confidence-hardening campaign

Wave 1 completed on 2026-08-24. Every material matrix row now has a fresh
deterministic execution at the released baseline. The scheduler/worktree suite
included configured concurrency peaks, queue progress, disjoint integration,
same-file conflicts, partial failure, setup failure, cancellation, retained
worktrees, lease acquisition/refresh/loss/release, continuation binding, and
cleanup. The worker/evidence suites included strict report parsing, explicit
change intent, claimed-versus-observed reconciliation, authoritative verification,
verification-only contradiction promotion and negative controls, one-turn repair
admission/exhaustion, compact/full projection, and P1.0 cost/identity boundaries.
This deterministic refresh does not by itself refresh stale live routing or
effort evidence, and it does not convert a repeated happy path into DEEP PASS.

Wave 2 completed on 2026-08-24 against the globally installed published v0.9.0
server at
`C:\Users\mahad\AppData\Local\nvm\v26.7.0\node_modules\sol-luna-orchestrator\dist\server.js`.
All mutation scenarios used committed disposable Git repositories under the
campaign fixture root, not product source. Fresh live evidence included:

- a compact single required edit with authoritative verification and matching
  Git state;
- a Context Capsule task whose exact JSON output depended on structured service,
  numeric-port, and header invariants, with a private sentinel absent from human,
  JSON, and campaign-appended activity telemetry;
- a 4/4 sequential dependency batch: Task 2 consumed Task 1's file, followed by
  legitimate optional and forbidden zero-change tasks;
- a 3/3 parallel batch with distinct worktrees, observed activity peak 3 (the
  configured ceiling), 3 attempted/3 applied integrations, and complete cleanup;
- retained-worktree continuation on the same Luna thread, cumulative two-file
  reconciliation, repeated authoritative verification, single-use replay
  refusal, and lease release;
- bounded repair after one controlled authoritative failure, classified
  `local-verification`, with exactly one same-thread repair and final PASS;
- the exact verification-contradiction promotion: worker `FAILED`, sole
  `verification` cause and matching failed row, authoritative PASS, preserved
  discrepancy/claim provenance, final PASS, and untrustworthy review semantics;
- an isolated published-CLI lifecycle covering init, repeat init, dry runs,
  doctor, status, activity/human/JSON, owned-setting reconciliation, backup,
  uninstall, repeated uninstall, discovery-hint ownership, and unrelated byte
  preservation; hashes proved the real Codex config/instructions were unchanged;
- three genuinely fresh Codex parents without explicit Sol-Luna instructions:
  two consulted guidance and deliberately chose zero workers for small tasks;
  one discovered the server and naturally selected one high-effort Luna worker
  for a broad read-only lifecycle audit, then independently reviewed its claims;
- a controlled same-file parallel conflict where both isolated tasks passed,
  nothing integrated, both worktrees were retained, and activity/integration
  evidence named the conflict.

The campaign did not naturally elicit a sequential or parallel batch from a
fresh parent after three materially different discovery attempts. Adaptive
effort has one natural high-effort selection but no second naturally selected
worker effort level, so it remains PARTIAL rather than PASS.

### Earlier pre-release live acceptance campaign

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
| Zero-worker/adaptive delegation                         | shipped; guidance refined 2026-08-23 | PASS     | PASS (2026-08-24)        | PASS (2026-08-24)      | Strong     |
| Single delegation                                       | shipped                              | PASS     | PASS (2026-08-24)        | PASS (2026-08-24)      | Strong     |
| Sequential batches                                      | shipped                              | PASS     | PASS (2026-08-24)        | PASS (2026-08-24)      | Strong     |
| Parallel batches                                        | shipped                              | PASS     | PASS (2026-08-24)        | DEEP PASS (2026-08-24) | Strong     |
| Worktree isolation/integration                          | shipped                              | PASS     | PASS (2026-08-24)        | DEEP PASS (2026-08-24) | Strong     |
| Bounded concurrency                                     | shipped                              | PASS     | PASS (2026-08-24)        | PASS (2026-08-24)      | Strong     |
| Adaptive effort                                         | shipped                              | PASS     | PASS (2026-08-24)        | PARTIAL (2026-08-24)   | Basic      |
| Independent verification                                | shipped                              | PASS     | PASS (2026-08-24)        | DEEP PASS (2026-08-24) | Strong     |
| Claimed-vs-observed reconciliation                      | shipped                              | PASS     | PASS (2026-08-24)        | DEEP PASS (2026-08-24) | Strong     |
| Context Capsule v2                                      | shipped v0.7.0                       | PASS     | PASS (2026-08-24)        | PASS (2026-08-24)      | Strong     |
| Compact Evidence Packets                                | shipped v0.7.0                       | PASS     | PASS (2026-08-24)        | DEEP PASS (2026-08-24) | Strong     |
| CLI init/doctor/status/uninstall                        | shipped                              | PASS     | PASS (2026-08-24)        | PASS (2026-08-24)      | Strong     |
| Activity, observability, privacy                        | shipped                              | PASS     | PASS (2026-08-24)        | DEEP PASS (2026-08-24) | Strong     |
| Natural discovery                                       | shipped v0.8.0                       | PASS     | PASS (2026-08-24)        | PASS (2026-08-24)      | Strong     |
| Explicit Change Intent                                  | shipped v0.9.0                       | PASS     | PASS (2026-08-24)        | DEEP PASS (2026-08-24) | Strong     |
| Worker Continuation                                     | shipped v0.9.0                       | PASS     | PASS (2026-08-24)        | DEEP PASS (2026-08-24) | Strong     |
| Bounded Repair                                          | shipped v0.9.0                       | PASS     | PASS (2026-08-24)        | DEEP PASS (2026-08-24) | Strong     |
| P1.0 parent/pricing foundation                          | shipped v0.9.0                       | PASS     | PASS (2026-08-24)        | N/A                    | Strong     |
| `failureCauses` and verification contradiction handling | shipped v0.9.0                       | PASS     | PASS (2026-08-24)        | PASS (2026-08-24)      | Strong     |

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
  closure result. Fresh live **PASS** now records two genuinely fresh parents
  consulting guidance and deliberately choosing zero workers, plus a third
  fresh parent choosing one worker for a broader task; this distinguishes
  informed solo routing from MCP non-discovery.
- **Dependencies/retest triggers:** parent guidance, tool descriptions, cost
  semantics, batch semantics, or routing changes; rerun a fresh-session
  acceptance and the scale/adaptive benchmark. **Gap:** no natural batch choice
  was observed within three materially different fresh-parent attempts.
- **Confidence:** **Strong**.

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
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24. The
  full batch suite refreshed shared-workspace dependency, cancellation,
  terminal-state, evidence, and event behavior.
  Current live acceptance **PASS**: 4/4 tasks passed in the shared workspace;
  Task 2 consumed Task 1's file, then optional and forbidden tasks legitimately
  made no change. Authoritative verification and Git state matched,
  `integrationConflicts` was empty, `integrated` was true, and `worktreePath`
  was null. Historical benchmark records remain **STALE** where they predate
  lifecycle and reconciliation hardening.
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
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24. The
  full parallel suite refreshed setup serialization, bounded scheduling,
  cancellation, worker/setup failures, overlap rejection/override, same-file
  conflicts, partial integration, cleanup, and risk-review behavior.
  Current live acceptance **DEEP PASS**: 3/3 isolated tasks passed at peak
  concurrency 3 in distinct `.sol-luna` worktrees; three disjoint edits
  integrated with 3 attempted, 3 applied, and 0 conflicts. A materially
  different same-file batch then produced two isolated PASS results, correctly
  withheld all integration, retained both worktrees, and exposed the conflict.
  Completed non-retained worktrees and leases were cleaned according to policy.
  Older committed benchmark evidence remains **STALE** where it predates
  lifecycle fixes.
- **Dependencies/retest triggers:** scheduler, worktree metadata, cancellation,
  overlap, integration, continuation, or verification changes. **Gap:** raw
  final-campaign artifacts are not committed; an actual in-flight cancellation
  with a completing sibling was not forced in this live run.
- **Confidence:** **Strong**.

### Worktree isolation and integration

- **Implementation/tests:** `src/worktree.ts`, `src/git.ts`, `src/overlap.ts`,
  `src/batch.ts`; `src/parallel.test.ts`, `src/security.test.ts`.
- **Authority/history:** `SECURITY.md`, `SOL_RULES.md`,
  `docs/TROUBLESHOOTING.md`; `5e388c3` and `da496df` (2026-08-14/23).
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24. The
  full worktree suite refreshed isolation, dependency linking, cleanup, stale
  pruning, integration/conflicts, retained continuations, cross-process lease
  ownership, acquisition/refresh failure, expiry, sweep, and legacy path-only
  lease compatibility.
  Current live acceptance **DEEP PASS** covered distinct isolated worktrees,
  clean disjoint integration, same-file conflict retention, policy cleanup of
  completed worktrees and leases, and a deliberately retained
  integration-disabled worktree used by continuation.
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
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24;
  tests measured peaks, queue progression, setup-before-run ordering, and the
  configured ceiling. Historical scale
  evidence is **STALE**: committed records measured peak concurrency 4 and 6 in
  forced arms under the then-authorized setup, before latest lifecycle changes.
- **Dependencies/retest triggers:** semaphore/config ceiling, scheduler,
  worktree setup, cancellation, or lease changes. **Live evidence:** final
  acceptance observed peak 3 at the published configured ceiling, with 3/3
  isolated checks, queued progress, 3 attempted/3 applied integrations, and
  complete worktree cleanup. Live state is **PASS**, not a broader scale claim.
- **Confidence:** **Strong**. A second live configured limit remains untested.

### Adaptive worker effort

- **Implementation/tests:** `src/contract.ts`, `src/prompt.ts`, `src/worker.ts`;
  `src/selftest.ts`, `src/parallel.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `SOL_RULES.md`, `docs/CONFIGURATION.md`, `README.md`;
  `a03a325` (2026-08-14).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24. Historical benchmark evidence is **STALE**: 2026-08-14 records show
  per-task medium/high/xhigh choices and no max selection, but later
  prompt/schema/evidence changes affect freshness. A current fresh parent
  naturally selected high effort for a broad cross-module audit.
- **Dependencies/retest triggers:** effort ladder/default, worker prompt/schema,
  continuation/repair attempt rules, or model support changes. **Live gap:** the
  other current medium-effort live tasks were caller-selected, so they do not
  prove natural adaptation across two worker effort levels. Live is **PARTIAL**.
- **Confidence:** **Basic**.

### Independent verification

- **Implementation/tests:** `src/verify.ts`, `src/command.ts`, `src/worker.ts`;
  `src/security.test.ts`, `src/selftest.ts`, `src/evidence.test.ts`.
- **Authority/history:** `SECURITY.md`, `SOL_RULES.md`, `CONTRIBUTING.md`;
  initial implementation in `a03a325` (2026-08-14), hardening in `908c977`
  (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24, including real exit-code capture, timeout, refusal, authority
  ordering, and output handling. Current live acceptance **DEEP PASS**: single,
  sequential, parallel, continuation, and repaired tasks ran configured
  authoritative verification; controlled repair exercised an initial
  authoritative failure and successful rerun; and the exact contradiction case
  preserved a failed worker row beside a passing authoritative row.
- **Dependencies/retest triggers:** verification policy/parser, command runner,
  worker output schema, or authoritative evidence rules. **Gap:** raw
  final-campaign verification rows are not committed; command refusal and
  timeout paths remain deterministic-only.
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
  artifacts are not committed. Current live **PASS** produced an exact verified
  JSON artifact whose service, numeric port, and trace-header values materially
  depended on the structured capsule; the private sentinel did not enter
  campaign activity telemetry.
- **Dependencies/retest triggers:** capsule schema/prompt rendering, prompt
  boundaries, worker contract, or telemetry changes. **Gap:** no model-backed
  context-efficiency measurement is committed.
- **Confidence:** **Strong**.

### Compact Evidence Packets

- **Implementation/tests:** `src/evidence.test.ts`, `src/worker.ts`,
  `src/server.ts`, `src/contract.ts`.
- **Authority/history:** `CHANGELOG.md` v0.7.0, `SOL_RULES.md`, `ROADMAP.md` P0.2;
  `debd8cb` (2026-08-19).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24; tests verify compact/full defaults, removal of only passing output,
  retention of failures, discrepancies, scope evidence, and text parity. The
  2026-08-24 session-local documentation run exercised compact result packets,
  but its raw artifacts are not committed. Current live **DEEP PASS** includes
  compact verified success plus compact scope-failure and same-file-conflict
  results that retained discrepancies, terminal evidence, conflicts, files,
  and review guidance while removing only passing verbosity.
- **Dependencies/retest triggers:** result schema/detail projection, verification
  capture, failure handling, or batch result rendering changes.
- **Confidence:** **Strong**.

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
  behavior. Current published-CLI acceptance **PASS** used an isolated campaign
  `CODEX_HOME` for init/repeat/dry-run/doctor/status/activity/reconciliation/
  backup/uninstall, preserving unrelated TOML and user instruction bytes.
- **Dependencies/retest triggers:** Codex config format, Node/Codex versions,
  path resolution, discovery-hint ownership, or CLI writes. The packaged/local
  `smoke:cli` program was also rerun and all 11 lifecycle groups passed in
  isolated homes. **Gap:** no POSIX lifecycle run was available on this host.
- **Confidence:** **Strong**.

### Activity, observability, and privacy

- **Implementation/tests:** `src/events.ts`, `src/activity.test.ts`,
  `src/activity-watch.test.ts`, `src/activity-config.test.ts`,
  `src/cli/activity.ts`, `src/cli/activity-reducer.ts`, `docs/OBSERVABILITY.md`.
- **Authority/history:** `docs/OBSERVABILITY.md`, `SECURITY.md`, `CHANGELOG.md`
  v0.6.0/v0.8.0; `ce42a06` (2026-08-17), `deca34d` (2026-08-22), `da496df`
  (2026-08-23).
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24:
  event-path configuration, prompt-to-activity privacy, reducer, watch,
  redaction, legacy compatibility, and latest-batch suites all passed. Final
  live acceptance **DEEP PASS**: human and JSON
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
  retained, so it was previously **PARTIAL**. Current live **PASS** records three
  fresh-parent run and worker identifiers: two informed solo choices and one
  unprompted high-effort Luna delegation with independent parent review. Raw
  JSONL transcripts were session-local and are not committed.
- **Dependencies/retest triggers:** global instruction-file selection, hint text,
  Codex startup/discovery behavior, parent guidance, or init/uninstall changes.
  **Gap:** no fresh parent naturally selected sequential or parallel batching
  within the three-attempt limit.
- **Confidence:** **Strong**.

### Explicit Change Intent

- **Implementation/tests:** `src/contract.ts`, `src/prompt.ts`, `src/worker.ts`,
  `src/server.ts`; `src/selftest.ts`, `src/prompt.test.ts`,
  `src/evidence.test.ts`, `src/parallel.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `ROADMAP.md` P0.2a (implemented for v0.9.0),
  `SOL_RULES.md`, `README.md`; `d1be8d6` (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for `required`, `optional`, and `forbidden`, independent of
  `allowedFiles` and task category, including zero-change and forbidden-edit
  classification. Current live **DEEP PASS** covers required edits across single,
  sequential, parallel, repair, contradiction, and continuation; legitimate
  optional and forbidden zero-change tasks; and fail-closed scope precedence
  from a malformed supervisor contract.
- **Dependencies/retest triggers:** contract/schema, worker prompt, observed-file
  reconciliation, repair admission, or release of P0.2a.
- **Confidence:** **Strong**.

### Worker Continuation

- **Implementation/tests:** `src/continuation.ts`, `src/batch.ts`,
  `src/contract.ts`, `src/server.ts`; `src/selftest.ts`, `src/parallel.test.ts`,
  `src/evidence.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `ROADMAP.md` P0.3 (implemented for v0.9.0),
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
  **Gap:** raw final-campaign artifacts are not committed; expiry was not
  exercised live.
- **Confidence:** **Strong**.

### Bounded Repair

- **Implementation/tests:** `src/worker.ts`, `src/batch.ts`, `src/contract.ts`,
  `src/events.ts`, `src/continuation.ts`; `src/evidence.test.ts`,
  `src/activity.test.ts`, `src/guidance.test.ts`, `src/selftest.ts`.
- **Authority/history:** `ROADMAP.md` P0.4 (implemented for v0.9.0),
  `SOL_RULES.md`, `docs/OBSERVABILITY.md`; `9d2ebe9` and `da496df`
  (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for the conservative classifier, exact failure evidence,
  same-thread one-turn repair, immutable change intent, re-verification, and
  exhaustion behavior. Current live **DEEP PASS** includes two conservative
  non-admissions with distinct environment/claims discrepancies and one clean
  `local-verification` admission with exactly one same-thread repair and final
  authoritative PASS.
- **Dependencies/retest triggers:** verifier authority, failure classification,
  continuation, change intent, event lifecycle, or worker thread reuse changes.
  **Gap:** recursive repair is proven only deterministically, by design.
- **Confidence:** **Strong**.

### P1.0 parent/pricing foundation

- **Implementation/tests:** `src/cost.ts`, `src/worker.ts`, `src/contract.ts`;
  `src/selftest.ts`, `src/guidance.test.ts`, `src/activity.test.ts`.
- **Authority/history:** `ROADMAP.md` P1.0 (foundation implemented for v0.9.0),
  `docs/CONFIGURATION.md`, `SOL_RULES.md`; `2d6e4c6` (2026-08-23).
- **Evidence:** Coverage and deterministic execution **PASS** on 2026-08-24 for
  explicit parent-identity provenance, distinct billing contexts, promotional
  cards, all rate bases and charge-unit shapes, observed usage meters, complete
  post-hoc eligibility, stable unavailable reasons (including missing input and
  non-finite totals), freshness/effective bounds, and no inferred prices. Live
  acceptance is **N/A** for these pure post-hoc primitives: real campaign usage
  was observed, but no production rate-card lookup, billing-account consumer,
  routing consumer, or cost-calculation API exists.
- **Dependencies/retest triggers:** cost-input schema, rate-card applicability,
  usage projection, identity provenance, or any future routing/policy consumer.
  **Gap:** no retrieval, account lookup, prediction, routing, or measured saving
  is implemented; the foundation remains limited to post-hoc evidence.
- **Confidence:** **Strong** for the shipped bounded foundation, not future P1.1
  policy or pricing services.

### Worker `failureCauses` and authoritative-verification contradiction handling

- **Implementation/tests:** `src/contract.ts`, `src/prompt.ts`, `src/worker.ts`,
  `src/batch.ts`; `src/selftest.ts`, `src/prompt.test.ts`, `src/evidence.test.ts`,
  `src/parallel.test.ts`, `src/guidance.test.ts`.
- **Authority/history:** `CHANGELOG.md` v0.9.0, `README.md`, `SOL_RULES.md`,
  `ROADMAP.md` P1.1 note; `908c977` and `6d610b3` (2026-08-23).
- **Evidence:** Coverage and targeted deterministic execution **PASS** on
  2026-08-24 for strict status-aligned causes, legacy normalization, malformed
  reports, complete one-to-one authoritative contradiction promotion only for a
  sole `verification` cause, terminal-evidence vetoes, and preserved worker claim
  / untrustworthy result. Current live **PASS** exercised the exact narrow
  promotion with a required observed edit, worker `FAILED`, sole `verification`
  cause, matching failed worker row, passing authoritative rerun, preserved
  discrepancy/provenance, and activity `claimed: FAILED` versus `verdict: PASS`.
- **Dependencies/retest triggers:** external worker schema, verification
  authority/equivalence, final Git evidence, repair classifier, or failure
  rendering changes. **Gap:** this is evidence for future P1.1 classification,
  not the future classifier itself; deterministic negative controls remain the
  authority for malformed and veto cases.
- **Confidence:** **Strong**.

## Closure campaign boundary

P2.4 Mature Benchmark and Acceptance Pass is a future system-wide closure
campaign, dependent on the roadmap capstone. It is not the first time these
features were tested and it does not retroactively erase the deterministic,
historical benchmark, or documented session-local live evidence above. Until a
deliberate rerun at the relevant runtime baseline exists, historical live results
remain **STALE** where implementation changed, and unknown execution dates remain
unknown.
