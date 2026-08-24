# v0.9.0 Confidence Hardening Findings

## Baseline metadata

- Tag: `v0.9.0`
- Baseline commit: `b38acae33ca8d52740af6e9a0fdc2cf376f08075`
- Campaign start time: `2026-08-23T21:06:10.3729002Z` (`2026-08-24` Asia/Karachi)
- OS/platform: Windows `10.0.26200`, `win32 x64`
- Node version: `v26.7.0`
- npm version: `11.19.0`
- Codex version: `codex-cli 0.149.0`
- Published MCP version/path: globally installed published `0.9.0`; active MCP server resolves to `C:\Users\mahad\AppData\Local\nvm\v26.7.0\node_modules\sol-luna-orchestrator\dist\server.js`, distinct from this checkout's `dist/server.js`
- Supervisor model: GPT-5 family (the exact deployment identifier is not exposed to this session)
- Package version: `0.9.0` in both `package.json` and the lockfile root
- Initial Git state: clean; branch `validation/v0.9.0-hardening`; `HEAD` exactly equals the `v0.9.0` tag commit

## Campaign goals

- Refresh deterministic coverage and acceptance evidence for every material v0.9.0 feature.
- Run published-runtime live/model-backed and end-to-end acceptance where meaningful and safe.
- Deepen failure-path, integration, adversarial, lifecycle, privacy, CLI, package, and protocol evidence without changing production runtime source.
- Promote ledger states only where the existing definitions and fresh evidence support them, while recording exact blockers and unresolved gaps.

## [2026-08-23T21:21:40.0629267Z] Test-addition batch used self-conflicting file scopes

Capability: Parallel batches; Explicit Change Intent; scope reconciliation
Attempted maturity transition: Wave 1 deterministic coverage expansion
Severity: low
Type: fixture problem
Status: resolved by supervisor review and independent rerun pending

### Observation

The supervisor gave each of three parallel test-addition tasks one exact allowed test file but also supplied `src/**/*.ts` in `forbiddenFiles`. The broad forbidden glob matched each allowed file and correctly won precedence. All workers therefore received final `FAILED` verdicts for scope violations even though the three disjoint test edits were integrated under the batch's documented partial-outcome behavior.

### Expected

The contracts should have forbidden only production paths without overlapping the exact allowed test files. Given the submitted contracts, fail-closed scope verdicts were expected.

### Evidence

- Published MCP batch: `bmt6b4fdea08f`, parallel, `maxParallel: 3`, integration enabled.
- Tasks: `t1` (`src/selftest.ts`, Luna medium), `t2` (`src/parallel.test.ts`, Luna high), `t3` (`src/cli.test.ts`, Luna medium).
- Orchestrator verdicts: 0/3 PASS; every task `FAILED` because its observed allowed test file also matched `forbiddenFiles`.
- Authoritative verification: two commands executed and passed for each task (`npm run build` and its targeted compiled test suite).
- Integration: three disjoint files copied, no integration conflicts.
- Worker claims: t1 and t3 claimed `PASS`; t2 claimed `FAILED` with `workerClaimedFailureCauses: ["environment-tooling"]` after its PowerShell-side exact `npm run build` attempt was blocked, despite authoritative verification succeeding.
- Git state after integration: only `src/selftest.ts`, `src/parallel.test.ts`, `src/cli.test.ts`, and the campaign's `findings.md` are changed/untracked; protected runtime files remain identical to `v0.9.0`.

### Impact

The batch cannot count as successful live change-intent or scope acceptance. The integrated test edits may still be retained if independent diff review and integrated validation pass.

### Confidence impact

Informational for product behavior; the fail-closed result supports scope precedence, while the malformed supervisor contract blocks treating this batch as a successful delegated-edit scenario.

### Classification

fixture-problem

### Reproduction

Submit a task whose exact `allowedFiles` entry also matches a broader `forbiddenFiles` glob, require an edit, and enable batch integration. Observe the scope-violation verdict and partial-outcome integration evidence.

### Recommended follow-up

Use non-overlapping contract globs for later delegated edits. Independently inspect and rerun the integrated test-only changes before retention.

### Resolution update — 2026-08-23T21:26:48.4923072Z

The supervisor inspected all three diffs. They contain meaningful assertions and no production or manifest edits. After formatting and a real rebuild, the affected compiled suites passed **196/196** and Prettier reported all three files clean. The test-only changes are retained; the malformed live batch remains recorded as failed and is not counted as a successful delegated-edit acceptance.

## [2026-08-23T21:26:48.4923072Z] Remaining coverage is concentrated in orchestration wiring and environment-specific paths

Capability: Whole-system deterministic coverage
Attempted maturity transition: Coverage established/refreshed across all v0.9.0 features
Severity: low
Type: test gap
Status: open; classified for later waves

### Observation

Native Node coverage improved from **90.56% lines / 84.24% branches / 87.93% functions** to **90.70% / 84.70% / 88.24%** after five focused test blocks. Important pure and lifecycle modules are broadly covered, but `server.js` callback wiring remains at 50.39% lines, the live benchmark runner at 59.35%, CLI init/uninstall presentation branches at 62.96%/77.78%, and several error/platform branches remain uncovered.

### Expected

Every important uncovered path should either receive meaningful execution or an explicit classification. Literal 100% is not required and should not be pursued through artificial assertions.

### Evidence

- Initial command: `node --experimental-test-coverage --test` with all 11 compiled package suites; 453 tests, 452 pass, 0 fail, 1 skipped.
- Final Wave 1 command: same full-suite coverage command; 458 tests, 457 pass, 0 fail, 1 skipped.
- Retained additions: cost missing-input/rate-basis/charge-unit/non-finite cases; Codex subprocess ENOENT and timeout; legacy path-only lease protection and expiry.
- The single skip is the real on-disk symlink escape case because this Windows host does not permit symlink creation. Synthetic and other realpath/symlink boundary cases passed.
- High-value later-wave targets: MCP handler/protocol callbacks, CLI packaged lifecycle, activity during live failure/concurrency, integration copy-error paths, and published-runtime continuation/repair/contradiction flows.
- Platform-specific remainder: POSIX process-group termination and POSIX directory-symlink behavior cannot execute on this Windows host.
- Live benchmark-runner branches require model quota and are not suitable for artificial deterministic line coverage.

### Impact

Coverage is broad enough for fresh deterministic PASS across the feature matrix, but uncovered handler, environment, and platform seams prevent a blanket Battle-tested claim.

### Confidence impact

Blocks Battle-tested promotion where the remaining seam is material; informational for already broad pure-function and deterministic state-machine evidence.

### Classification

test-gap

### Reproduction

Run the full compiled suite under Node's native `--experimental-test-coverage` flag and inspect the per-module uncovered-line report.

### Recommended follow-up

Use protocol/package smokes and safe disposable live fixtures for handler wiring; retain deterministic fault-injection tests only where they exercise a real boundary. Cover POSIX-only branches in Linux CI rather than emulating them on Windows.

## [2026-08-23T21:26:48.4923072Z] Wave 1 checkpoint

- Completed wave: Wave 1 — whole-codebase coverage and deterministic maturity.
- Elapsed time: approximately 21 minutes.
- Features advanced: Sequential batches, Parallel batches, Worktree isolation/integration, Bounded concurrency, and Activity/observability/privacy moved from PARTIAL or NOT TESTED deterministic evidence to fresh PASS. Every other material feature received a fresh full-suite deterministic execution at released v0.9.0.
- Features blocked: no deterministic PASS is blocked. The real-symlink test is skipped by Windows privilege; POSIX-only branches remain platform-specific. Higher live/confidence levels remain blocked pending Waves 2–5 evidence.
- Defects found: no confirmed product defect in Wave 1.
- Test-only additions: `src/selftest.ts`, `src/parallel.test.ts`, and `src/cli.test.ts`; all pass after integrated rebuild.
- Production immutability: protected runtime, manifests, release configuration, and defaults match `v0.9.0`; only allowed tests, `docs/FEATURE_ACCEPTANCE.md`, and `findings.md` differ.
- Git state: three modified test files, modified acceptance ledger, and untracked `findings.md`; no unrelated tracked changes.
- Next planned wave: fresh published-runtime model/E2E baseline in disposable repositories, prioritizing change intent, context/compact evidence, continuation, repair, contradiction handling, concurrency, routing/effort, and isolated CLI lifecycle.

## [2026-08-23T21:39:00Z] Controlled repair attempt used a marker outside the worker workspace

Capability: Bounded Repair; failure-cause classification
Attempted maturity transition: live NOT TESTED to live PASS
Severity: low
Type: fixture problem
Status: first attempt failed; materially different in-workspace fixture planned

### Observation

The first controlled verifier stored its one-shot counter in a sibling campaign state directory. The Luna worker could read the verifier but could not write outside its workspace, so it reported `FAILED` with `workerClaimedFailureCauses` `verification` and `environment-tooling`. The authoritative verifier, running with operator permissions, then passed its first invocation. Automatic repair was correctly not admitted.

### Expected

The controlled verifier must be writable in both the worker sandbox and authoritative environment while remaining inside the disposable fixture. A repair candidate must present only a clear local authoritative verification failure, without environment/tooling evidence.

### Evidence

- Worker model/effort: `gpt-5.6-luna`, medium.
- Worker thread: `01a0308f-7114-7203-8b99-17e53ce68411`.
- Worker claim: `FAILED`; causes `["verification", "environment-tooling"]`.
- Worker verification: exit 1, `EPERM` opening the sibling `repair-count` marker.
- Authoritative verification: exit 0.
- Runtime repair result: not attempted; classification `contract-or-requirement`; reason states the worker did not claim completion.
- Git state: only the intended `repair.txt` was created in the disposable repository.

### Impact

This attempt does not provide live bounded-repair PASS evidence. It does provide useful fail-closed evidence that environment/tooling plus verification claims are not treated as a local repair candidate or promoted contradiction.

### Confidence impact

Blocks live PASS for Bounded Repair until a valid controlled fixture succeeds.

### Classification

fixture-problem

### Reproduction

Configure an automatic-repair task whose verification script attempts to write a state marker outside the worker workspace. Observe worker EPERM, mixed failure causes, authoritative/worker disagreement, and repair non-admission.

### Recommended follow-up

Move the state marker into the disposable repository, explicitly include it in allowed scope, establish a clean tracked baseline, and retry once.

### Attempt 2 update — 2026-08-23T21:40Z

The in-workspace counter produced the intended authoritative exit 1, but the worker claimed the verifier-mutated tracked counter while Codex runtime observation did not record command side effects. That claimed-only edit discrepancy correctly caused `contract-or-requirement` non-admission. This attempt remains failed evidence.

### Resolution update — 2026-08-23T21:42:51Z

The third materially different fixture ignored its internal counter so only the product artifact participated in Git evidence. Initial authoritative verification failed with `controlled second-invocation failure`; repair classification was `local-verification`; exactly one same-thread repair ran; final authoritative verification passed; activity recorded repair turn 1; and Git showed only `repair.txt`. Bounded Repair advanced to live DEEP PASS / Strong, while both conservative non-admissions remain part of the evidence.

## [2026-08-23T21:37:00Z] Windows checkout conversion invalidated one retained peer verifier

Capability: Worktree isolation; parallel partial outcomes; fixture portability
Attempted maturity transition: retained-worktree continuation live refresh
Severity: low
Type: fixture problem
Status: isolated; successful continuation task unaffected

### Observation

In an integration-disabled two-task parallel batch, the staged continuation task passed, while the read-only peer failed its verifier because a committed LF blob was checked out as CRLF in the isolated Windows worktree. The verifier compared exact LF bytes.

### Expected

The peer verifier should either assert semantic content or the fixture repository should pin LF checkout behavior with attributes. The runtime correctly preserved the failed worker and worktree instead of hiding the failure.

### Evidence

- Batch: `bmt6btzm69ef8`, parallel, integration disabled, 1/2 passed.
- Passing task: required staged continuation, authoritative verifier PASS, retained worktree `bmt6btzm69ef8-t1`.
- Failed task: forbidden/read-only, worker and authoritative verifier exit 1, sole worker cause `verification`; reported CRLF versus LF mismatch.
- The passing task continued on the same thread, added phase 2, passed authoritative verification, reconciled both files, rejected replay, and released its lease.

### Impact

The failed peer is not product evidence against worktree isolation. It demonstrates truthful partial outcomes and identifies a cross-platform fixture design pitfall.

### Confidence impact

Informational for runtime; blocks counting the peer as a successful read-only retained-worktree task.

### Classification

fixture-problem

### Reproduction

Commit an LF-only text fixture in a repository subject to Windows checkout conversion, then run an exact-LF verifier inside a new Git worktree.

### Recommended follow-up

Use `.gitattributes` or semantic verification in future cross-platform disposable fixtures.

## [2026-08-23T21:57:31.6713935Z] Fresh-parent routing did not naturally produce a batch or two worker effort levels

Capability: Natural discovery; adaptive routing; adaptive effort
Attempted maturity transition: live PASS/Strong and adaptive-effort closure
Severity: low
Type: evidence gap
Status: three-attempt limit reached

### Observation

Three genuinely fresh ephemeral Codex parents loaded the configured discovery hint without being told to use Sol-Luna. Two consulted guidance and deliberately chose zero workers for small tasks. The third discovered the MCP, selected one high-effort Luna worker for a broad lifecycle audit, and independently reviewed it. None naturally selected sequential or parallel batching, and only one naturally selected worker effort level was observed.

### Expected

Natural discovery should distinguish informed solo routing from non-discovery, and adaptive effort requires materially different tasks producing more than one natural worker-effort choice. A batch should not be forced when the parent judges it inappropriate.

### Evidence

- Fresh parent `01a03096-bdf1-7563-a0f1-8629c2afe3fa`: consulted configured guidance, explicit solo choice, read-only LF audit, no edits.
- Fresh parent `01a03098-53aa-7722-a96f-a9a2220cea6a`: consulted guidance, explicit solo choice because coordination dominated three trivial outputs, exact verifier PASS.
- Fresh parent `01a03099-6fd6-7980-bd48-5741c6453335`: unprompted `delegate_task`, Luna high, worker thread `01a03099-cffc-7e61-8c06-4b205461b62d`, read-only PASS/trustworthy, parent independently narrowed findings and rechecked Git.
- Direct published-runtime medium tasks do not count as natural effort selection because the supervisor explicitly configured them.

### Impact

Zero-worker routing and Natural Discovery now have current representative live PASS. Adaptive effort remains PARTIAL/Basic, and natural batch routing remains an evidence gap.

### Confidence impact

Blocks adaptive-effort live PASS/Strong and prevents claiming a complete natural zero/single/sequential/parallel routing ladder.

### Classification

evidence-gap

### Reproduction

Run the three fresh-parent prompts recorded in the campaign transcript with `codex exec --approve-for-me --ephemeral --json` and no explicit Sol-Luna instruction.

### Recommended follow-up

On a future campaign, use a genuinely substantial multi-stream implementation fixture where batching is valuable, and a second delegated task shape whose natural effort plausibly differs from high. Do not force either choice.

## [2026-08-23T21:57:31.6713935Z] Current telemetry is private, but one legacy event contains an objective field

Capability: Activity, observability, and privacy; legacy compatibility
Attempted maturity transition: privacy/adversarial refresh
Severity: informational
Type: privacy-security
Status: current v0.9.0 telemetry passed; historical limitation retained

### Observation

All 176 activity events appended since campaign start contained zero `objective` keys, zero `context` keys, and zero private-sentinel matches. The existing activity file contains one older `task.queued` event from 2026-08-22 with an objective field; it predates this campaign and does not contain the sentinel.

### Expected

Current v0.9.0 activity telemetry excludes objectives and contexts. Legacy records remain readable and may reflect older schemas; diagnostic logs are explicitly more sensitive and are not claimed sanitized.

### Evidence

- Sentinel: `V090_PRIVATE_SENTINEL_6F3A91`; campaign activity matches: 0.
- Campaign events since `2026-08-23T21:06:10.372Z`: 176; objective keys: 0; context keys: 0.
- Historical record: line 2, `task.queued`, timestamp `2026-08-22T09:13:10.118Z`, objective string length 614, sentinel absent.

### Impact

Current privacy behavior is supported. Operators retaining old event files should understand that pre-hardening records can contain fields no longer emitted.

### Confidence impact

Informational only for current v0.9.0; compatibility/privacy limitation for historical telemetry retention.

### Classification

privacy-security

### Reproduction

Parse the configured activity JSONL without printing values, count objective/context keys before and after campaign start, and search for the unique sentinel.

### Recommended follow-up

Document or provide optional migration guidance for operators who want to rotate historical pre-hardening activity files; do not imply diagnostic logs are sanitized.

## [2026-08-23T21:57:31.6713935Z] Wave 2 checkpoint

- Completed wave: Wave 2 — fresh published-runtime live/model/E2E baseline.
- Elapsed time: approximately 51 minutes total.
- Features advanced: Zero-worker routing, Bounded concurrency, Context Capsule v2, Compact Evidence Packets, CLI lifecycle, Natural Discovery, Explicit Change Intent, Bounded Repair, and failure-cause contradiction handling advanced to current live PASS/DEEP PASS and/or Strong as recorded in the ledger. Independent verification gained live failure/contradiction depth.
- Features blocked: Adaptive effort remains PARTIAL/Basic after three natural-routing attempts; no fresh parent naturally selected a batch. P1.0 live is N/A because the shipped surface is pure post-hoc primitives with no production pricing consumer. Live cancellation and timeout injection remain unavailable without unsafe/artificial control.
- Defects found: no confirmed product defect in Wave 2.
- Integration/E2E evidence: successful single, sequential dependency, peak-3 parallel integration, retained continuation/replay refusal, one-turn repair, exact contradiction promotion, same-file conflict retention, and isolated CLI lifecycle.
- Production immutability: protected runtime, manifests, release configuration, and defaults still match `v0.9.0`; versions remain `0.9.0`.
- Git state: only allowed test files, `docs/FEATURE_ACCEPTANCE.md`, `findings.md`, and disposable untracked fixtures differ.
- User/global safety: real Codex config and AGENTS SHA-256 hashes remained `DA64CF6F...9E4D2` and `28868FEF...9DA8`; no global configuration write occurred.
- Next planned wave: deterministic/package/protocol/CLI smokes, cross-feature adversarial review, remaining high-value safe failure paths, then final validation and cleanup.

## [2026-08-23T22:01:38.9338965Z] Three cross-module failure handoffs remain without end-to-end fault injection

Capability: Parallel integration, cancellation/timeout cleanup, retained continuation finalization
Attempted maturity transition: Strong to Battle-tested
Severity: medium
Type: test gap
Status: open; Battle-tested promotion withheld

### Observation

Independent fresh-parent plus high-effort Luna audit found that component tests are broad, but three important cross-module failure handoffs lack one end-to-end deterministic case: partial main-workspace mutation after one integration copy/delete fails; an already-running parallel worker cancellation/timeout flowing through evidence scan and cleanup alongside a sibling; and a consumed retained continuation failing/cancelling after lease refresh.

### Expected

Battle-tested confidence should include the actual handoff across worker, batch, worktree, continuation/server finalization, events, and cleanup—not only separately tested components or pre-start cancellation.

### Evidence

- Fresh parent: `01a03099-6fd6-7980-bd48-5741c6453335`.
- Natural delegated audit: `gpt-5.6-luna` high, thread `01a03099-cffc-7e61-8c06-4b205461b62d`, PASS/trustworthy/read-only.
- Partial integration seam: `integrateWorktrees` per-file error handling in `src/batch.ts`; tests cover clean integration, pre-copy conflict, failed-result successful copy, and evidence-scan failure, but not a copy failure after another file already applied.
- In-flight cancellation seam: worker abort classification plus `runParallel` evidence/cleanup; tests cover pre-abort parallel and injected sequential cancellation, not an already-running parallel worker with a completing sibling.
- Continuation seam: `ContinuationStore.consume`, persistent lease refresh, `continueToLuna`, and server `finally`; tests cover these components and successful live continuation, not failed/cancelled consumed continuation cleanup together.
- Current production source remained clean before and after the audit.

### Impact

No defect is confirmed, but these are exactly the abnormal lifecycle paths where leaked worktrees/leases or partially mutated integration state would matter. They block Battle-tested claims for parallel integration, worktree lifecycle, cancellation/timeout, and continuation.

### Confidence impact

Blocks Battle-tested.

### Classification

test-gap

### Reproduction

Trace the cited lifecycle functions and compare against current `src/parallel.test.ts`, `src/selftest.ts`, and `src/evidence.test.ts` cases; the missing combined transitions are not invoked.

### Recommended follow-up

Add narrow deterministic dependency-injection seams or existing-seam fixtures for per-file integration copy failure, actual in-flight parallel abort, and continuation-handler failure finalization. Do not alter v0.9.0 runtime in this campaign.

## [2026-08-23T22:01:38.9338965Z] Waves 3–4 checkpoint

- Completed waves: Wave 3 deep failure/integration evidence and Wave 4 Battle-tested assessment.
- Elapsed time: approximately 55 minutes total.
- Features deepened: Independent verification, Compact Evidence Packets, Explicit Change Intent, Bounded Repair, Worktree isolation/integration, Worker Continuation, reconciliation, activity/privacy, and parallel conflict behavior gained varied live failure or adversarial evidence.
- Battle-tested promotions: none. Existing broad Strong features remain Strong because the three cross-module abnormal handoffs above and platform limits remain material.
- Features blocked: Adaptive effort remains Basic/PARTIAL; natural batch routing absent; POSIX-only paths and real symlink creation unavailable on this host; live cancellation/timeout lacks safe control; partial-copy and consumed-continuation failure need deterministic seams.
- Defects found: no confirmed product defect through Waves 3–4.
- Production immutability: protected runtime and release files remain identical to `v0.9.0`.
- Next planned wave: package/protocol/CLI smoke, fixture validation, whole-system reconciliation, cleanup, and final release-style validation.

## [2026-08-23T22:01:38.9338965Z] Wave 5 checkpoint

- Completed wave: Wave 5 — cross-feature and whole-system adversarial/E2E acceptance.
- Elapsed time: approximately 55 minutes total.
- Cross-feature evidence: change intent + authoritative verification + Git reconciliation; sequential dependency; peak-3 parallel + leases + integration; retained continuation + replay; repair + verification; contradiction + Git state; compact packets + conflict/failure; Context Capsule + privacy; activity during concurrency/repair/contradiction; isolated repeated CLI lifecycle; fresh parent discovery -> routing -> Luna -> parent review.
- Published MCP protocol: all handshake, identity/version, instructions, three tools, schema, result-contract, invalid-input, and isolated-log checks passed against the exact global v0.9.0 server path.
- Packaged/local CLI smoke: all 11 lifecycle groups passed against isolated Codex homes with no model calls.
- Benchmark fixture validation: all nine fixtures failed initially and passed reference solutions; mutation detection passed.
- Features blocked: packaged artifact dry-run/content inspection and final release-style commands remain for final validation; live local `smoke:parallel`/`smoke:isolation` were not used as released-runtime evidence because they execute this checkout's local build and spend model quota.
- Defects found: no confirmed product defect in Wave 5.
- Production immutability and Git state: protected source remains identical to `v0.9.0`; only legitimate campaign docs/tests plus disposable fixtures are present.
- Next planned step: safely remove exact campaign fixtures/worktrees, rerun full final validation and coverage, reconcile summary, and commit if green.

## [2026-08-23T22:03:54.9530234Z] Manual Git worktree removal damaged shared dependency junction contents

Capability: Campaign lifecycle cleanup; Windows worktree dependency linking
Attempted maturity transition: final cleanup and validation
Severity: medium
Type: lifecycle-cleanup
Status: dependency restoration in progress; tracked source unaffected

### Observation

After exact retained worktrees were removed with `git worktree remove --force`, final `npm run build` failed because `node_modules/.bin/tsc` was no longer available even though the `node_modules` directory still existed. The retained worktrees can contain dependency junctions to the source checkout; manual Git removal bypassed the runtime's unlink-before-recursive-cleanup protection and likely damaged the shared dependency target.

### Expected

Orchestrator-managed cleanup unlinks junctions before recursive worktree removal. Campaign cleanup should use that lifecycle rather than raw Git removal whenever retained worktrees contain shared dependencies.

### Evidence

- Command: final `npm run build`.
- Exit: 1; `'tsc' is not recognized as an internal or external command`.
- `node_modules` directory still exists, but required installed binaries are missing.
- Protected runtime/manifests/release files remain byte-identical to `v0.9.0`; Git status contains only expected campaign docs/tests/findings.
- The exact disposable fixture root and campaign lease directories were removed successfully; no global/user config path was targeted.

### Impact

Final validation was interrupted and dependencies must be restored with `npm ci`. No tracked product file or user/global configuration was changed.

### Confidence impact

Informational for released orchestrator cleanup (whose unlink-first behavior is tested); blocks final green validation until dependencies are restored.

### Classification

lifecycle-cleanup

### Reproduction

On Windows, retain an orchestrator worktree with linked `node_modules`, then remove it directly with `git worktree remove --force` instead of `cleanupWorktree`; inspect the shared dependency target.

### Recommended follow-up

Campaign tooling should expose/use an orchestrator-owned retained-worktree cleanup command or explicitly unlink shared dependency junctions before raw Git worktree removal. Avoid manual Git removal for such worktrees.

### Resolution update — 2026-08-23T22:14:13.7748357Z

`npm ci` restored the checkout dependencies without changing either manifest.
The final coverage run, `npm run verify`, format check, benchmark validation,
build, protocol smoke, and package dry run all passed. The incident did not
affect tracked runtime source, the released package baseline, or user/global
configuration.

# Campaign Summary

- Baseline: tag `v0.9.0` and campaign-start commit
  `b38acae33ca8d52740af6e9a0fdc2cf376f08075`.
- Campaign start: `2026-08-23T21:06:10.3729002Z`.
- Campaign end: `2026-08-23T22:14:13.7748357Z`.
- Elapsed duration: approximately 1 hour 8 minutes.
- Supervisor: GPT-5 family; the exact deployment identifier was not exposed.
- Workers: real `gpt-5.6-luna` at medium and high effort. No xhigh or max worker
  was needed. Published-runtime live tasks, batches, continuation, repair, and
  contradiction evidence used the globally installed v0.9.0 MCP.

## Initial and final acceptance matrix

Coverage was **PASS** for every row at both endpoints. The table shows
deterministic / live / confidence transitions; dated ledger entries use the
campaign's 2026-08-24 local date.

| Capability                                 | Initial                      | Final                     |
| ------------------------------------------ | ---------------------------- | ------------------------- |
| Zero-worker/adaptive delegation            | PASS / STALE / Stale         | PASS / PASS / Strong      |
| Single delegation                          | PASS / PASS / Strong         | PASS / PASS / Strong      |
| Sequential batches                         | PARTIAL / PASS / Strong      | PASS / PASS / Strong      |
| Parallel batches                           | PARTIAL / DEEP PASS / Strong | PASS / DEEP PASS / Strong |
| Worktree isolation/integration             | PARTIAL / DEEP PASS / Strong | PASS / DEEP PASS / Strong |
| Bounded concurrency                        | NOT TESTED / PARTIAL / Basic | PASS / PASS / Strong      |
| Adaptive effort                            | PASS / STALE / Stale         | PASS / PARTIAL / Basic    |
| Independent verification                   | PASS / PASS / Strong         | PASS / DEEP PASS / Strong |
| Claimed-vs-observed reconciliation         | PASS / DEEP PASS / Strong    | PASS / DEEP PASS / Strong |
| Context Capsule v2                         | PASS / PARTIAL / Basic       | PASS / PASS / Strong      |
| Compact Evidence Packets                   | PASS / PARTIAL / Basic       | PASS / DEEP PASS / Strong |
| CLI init/doctor/status/uninstall           | PASS / NOT TESTED / Strong   | PASS / PASS / Strong      |
| Activity/observability/privacy             | PARTIAL / DEEP PASS / Strong | PASS / DEEP PASS / Strong |
| Natural discovery                          | PASS / PARTIAL / Basic       | PASS / PASS / Strong      |
| Explicit Change Intent                     | PASS / PARTIAL / Basic       | PASS / DEEP PASS / Strong |
| Worker Continuation                        | PASS / DEEP PASS / Strong    | PASS / DEEP PASS / Strong |
| Bounded Repair                             | PASS / NOT TESTED / Basic    | PASS / DEEP PASS / Strong |
| P1.0 parent/pricing foundation             | PASS / NOT TESTED / Basic    | PASS / N/A / Strong       |
| `failureCauses` and contradiction handling | PASS / NOT TESTED / Basic    | PASS / PASS / Strong      |

No feature was promoted to **Battle-tested**. The existing definition requires
varied failure evidence across the remaining cross-module abnormal lifecycle
handoffs; raw test count and repeated happy paths were not treated as sufficient.

## Coverage and deterministic validation

- Initial native coverage: 453 tests, 452 pass, 0 fail, 1 skipped; 90.56% lines,
  84.24% branches, and 87.93% functions.
- Final native coverage: 458 tests, 457 pass, 0 fail, 1 skipped; 90.70% lines,
  84.70% branches, and 88.24% functions.
- The retained additions are five focused test blocks in `src/selftest.ts`,
  `src/parallel.test.ts`, and `src/cli.test.ts`, covering cost-calculation
  boundaries, legacy path-only lease lifecycle, and Codex subprocess ENOENT and
  timeout behavior.
- The only skip is real on-disk symlink creation, unavailable under this Windows
  host's permissions. Synthetic/canonical path cases passed. POSIX process-group
  and directory-symlink paths remain platform-specific.
- Final `npm run verify`: typecheck PASS; 458 tests with 457 pass, 0 fail, 1
  skip; deterministic MCP protocol smoke PASS.

## Live, integration, E2E, and adversarial evidence

- Published MCP identity was established as global v0.9.0 at
  `C:\Users\mahad\AppData\Local\nvm\v26.7.0\node_modules\sol-luna-orchestrator\dist\server.js`,
  not this checkout's local server.
- Live flows covered required single delegation, a four-task true sequential
  dependency plus optional/forbidden zero-change behavior, peak-3 parallel
  integration, retained continuation and replay refusal, one-turn bounded
  repair, exact verification contradiction promotion, same-file integration
  conflict, Context Capsule-dependent output, compact evidence, activity during
  concurrency/repair/contradiction, and privacy-sentinel exclusion.
- Fresh-parent runs: three materially different ephemeral parents without an
  explicit Sol-Luna instruction. Two consulted guidance and deliberately chose
  zero workers; one naturally selected a high-effort Luna worker and then
  independently reviewed it.
- Isolated CLI lifecycle covered dry-run, repeated init/uninstall, doctor,
  status, activity human/JSON, owned-setting reconciliation, backup, hint
  ownership, and unrelated-byte preservation. Packaged CLI smoke passed all 11
  lifecycle groups.
- Published MCP protocol smoke passed handshake, identity/version,
  instructions, all three tools, schemas/result contracts, invalid input, and
  isolated diagnostic logging.
- Benchmark validation passed all nine discriminating fixtures and mutation
  detection. `npm pack --dry-run` produced the expected v0.9.0 package manifest:
  76 files, tests/selftests/smokes excluded from the tarball.

## Promotions and blockers

- Promoted to Strong: Zero-worker/adaptive delegation, Bounded concurrency,
  Context Capsule v2, Compact Evidence Packets, Natural discovery, Explicit
  Change Intent, Bounded Repair, P1.0 parent/pricing foundation, and
  `failureCauses` contradiction handling. CLI lifecycle also gained fresh live
  PASS while retaining Strong; other existing Strong rows were refreshed or
  deepened.
- Promoted to live DEEP PASS: Parallel batches, Worktree
  isolation/integration, Independent verification, Claimed-vs-observed
  reconciliation, Compact Evidence Packets, Activity/observability/privacy,
  Explicit Change Intent, Worker Continuation, and Bounded Repair.
- Battle-tested promotions: none.
- Adaptive effort failed to advance beyond PARTIAL/Basic after three materially
  different fresh-parent attempts: only one naturally selected worker effort
  (high) was observed. Caller-selected medium runs do not prove adaptation.
- A complete natural zero/single/sequential/parallel routing ladder was not
  established after the same three fresh-parent attempts because no parent
  naturally selected a batch.
- Battle-tested confidence remains blocked by one audit of three unexercised
  cross-module handoffs: partial integration after an earlier file applies,
  actual in-flight parallel cancellation/timeout with a sibling, and failure or
  cancellation after consuming a retained continuation and refreshing its
  lease. No unsafe or artificial live injection was attempted.
- POSIX-only branches and the real-symlink case received one platform-capability
  assessment and remain blocked by the Windows environment.
- P1.0 live evidence is N/A, not blocked: the shipped surface is pure post-hoc
  identity/cost primitives without a production rate-card, account, routing, or
  billing consumer.

## Findings and recommendations

No confirmed product defects were discovered during this campaign.

- Test gaps: the three abnormal cross-module handoffs above, POSIX-only paths,
  and the unavailable Windows real-symlink case.
- Evidence gaps: natural batching and a second naturally selected effort level.
- Model behavior: fresh parents made defensible zero/single choices but did not
  naturally choose a batch within the attempt limit.
- Fixture problems: one self-conflicting delegated test contract, two controlled
  repair-marker designs, and one CRLF-sensitive verifier. Each remains recorded
  even though later evidence resolved or bypassed it.
- Flaky tests: none confirmed.
- Environment/tooling: Windows prevented real symlink creation and POSIX branch
  execution. Raw Git removal of retained worktrees damaged shared dependency
  junction contents; `npm ci` restored them and all final validation passed.
- Privacy/security: all 176 campaign-appended events excluded objective/context
  fields and the private sentinel. One pre-campaign legacy event contains an
  objective field; diagnostic logs are not claimed sanitized.
- Host-safety limitations: no real/global lifecycle mutation, account billing
  access, remote mutation, destructive host operation, or unsafe live
  cancellation injection was attempted.
- Compatibility: no live POSIX lifecycle matrix was available; Windows CRLF
  conversion must be considered when designing exact-byte fixtures.
- Recommended next-day work: add narrow deterministic seams/tests for the three
  abnormal lifecycle handoffs; run the suite on Linux for POSIX and real-symlink
  evidence; design a substantial fresh-parent batch fixture and a second natural
  effort shape; and provide an orchestrator-owned retained-worktree cleanup
  command or documented unlink-first procedure.

Nothing found should block P1.1. A v0.9.1 patch release is not indicated by the
current evidence; revisit that judgment if the missing abnormal-lifecycle tests
expose a product defect.

## Final validation and safety result

- `npm run verify`: PASS.
- `npm run format:check`: PASS.
- `npm run bench:validate`: PASS.
- `git diff --check`: PASS.
- `npm run build`: PASS.
- `npm pack --dry-run`: PASS; version 0.9.0 and expected package contents.
- Package and lockfile root versions remain 0.9.0.
- Protected production/runtime source, manifests, release configuration, and
  defaults remain identical to `v0.9.0`.
- The fixture root is absent; Git lists only the primary worktree; no campaign
  lease content remains; no fixture file is tracked.
- Real Codex config and AGENTS hashes remain unchanged at
  `DA64CF6FB0F8AF5E61871F6AA3024159341A3F33E65C3F3026122A546BB9E4D2` and
  `28868FEFAE7EB76F97F06A6A5D3BB9D00C68DD3E11EDABDC09778C1E84DF9DA8`.
- No push, tag, publish, global configuration write, or remote mutation occurred.

Final recommendation: **PROCEED TO P1.1**. This campaign does not begin P1.1.

## [2026-08-24T05:59:47Z] Linux platform acceptance gaps closed at the v0.9.0 baseline

Capability: Filesystem scope security; POSIX verification cleanup; worktree and
lease lifecycle; CLI lifecycle
Attempted maturity transition: focused Linux evidence closure
Severity: informational
Type: evidence closure
Status: resolved for the Windows-blocked deterministic paths; remaining
cross-module and platform-matrix gaps retained

### Observation

The completed Windows campaign could not create real symlinks or execute POSIX
process-group and directory-symlink paths. A focused Ubuntu run executed the
previously skipped file-symlink case, added only the two missing behavior-focused
tests, strengthened the existing dependency-link assertion, and reran the
relevant worktree, lease, cancellation, and isolated CLI lifecycle evidence.

### Evidence

- Host: Ubuntu 24.04.4 LTS, Linux 7.0.0-28-generic x86_64; Node v24.15.0;
  npm 11.12.1; Codex CLI 0.149.1.
- Initial unchanged Linux suite: **458 tests, 458 pass, 0 fail, 0 skipped**.
  The exact existing test 'real symlink escape is caught on disk' executed and
  passed instead of taking the historical Windows skip.
- Security suite: **45/45 pass**. Real on-disk file and directory symlinks
  resolving outside the workspace were rejected under a broad all-files
  allowlist. The directory case used a nonexistent child beneath the symlink,
  exercising deepest-existing-ancestor realpath resolution.
- POSIX process cleanup: 'POSIX verification timeout kills a spawned
  process-group descendant' passed. The authoritative result was failed with
  exitCode: null and the expected one-second timeout text; the descendant no
  longer existed and its heartbeat stopped after the process-group kill.
- Parallel/worktree suite: **73/73 pass**. The native Linux dependency link was
  an actual directory symlink resolving to the source node_modules; managed
  cleanup removed the worktree/link while the source dependency survived. Stale
  pruning removed only orchestrator-owned worktrees and preserved a user
  worktree. Lease acquisition, refresh, renewal loss, expiry, release, orphan
  sweep, legacy compatibility, continuation protection, and pre-start
  cancellation cleanup all passed.
- CLI plus activity-configuration suites: **97/97 pass**. npm run smoke:cli
  also passed all 11 real lifecycle groups using temporary isolated CODEX_HOME
  directories and the installed Codex CLI, with no model calls or real
  user-home mutation.
- Final Linux deterministic suite after the two retained tests: **460 tests,
  460 pass, 0 fail, 0 skipped**.

### Resolution update

The prior Windows limitation remains historically accurate, but it no longer
blocks deterministic product evidence for real symlink escape, POSIX
directory-symlink handling, POSIX verification process-group cleanup, Linux
worktree/dependency-link/lease cleanup, or Linux CLI lifecycle. No production or
runtime implementation changed, and no product defect was found.

### Remaining gaps and confidence impact

- The three previously recorded cross-module abnormal lifecycle handoffs remain
  open and were not changed: partial integration after an earlier file applies,
  actual in-flight parallel cancellation with a completing sibling, and
  failed/cancelled consumed-continuation finalization after lease refresh.
- The Linux process test covers authoritative verification timeout and descendant
  cleanup; it does not claim the still-missing cross-module worker/batch
  cancellation handoff.
- A durable model-backed live OS matrix and macOS-specific execution are still
  absent. The historical Windows CRLF and junction evidence remains intact.
- Adaptive Effort and P1.1 were not exercised or modified.
- Strong and existing live DEEP PASS statuses remain unchanged. No feature is
  promoted to Battle-tested from this focused platform pass.
- Nothing new should block a later deep-hardening campaign; that campaign should
  retain the three known lifecycle handoffs as explicit targets.

### Final validation

- `npm run verify`: PASS; typecheck, **460/460** deterministic tests, and
  protocol smoke all passed.
- `npm run format:check`: PASS.
- `npm run bench:validate`: PASS; all nine fixtures discriminated and mutation
  detection passed.
- `git diff --check`: PASS.
- `npm run build`: PASS.
- Production/runtime source, manifests, configuration defaults, and release
  files remain identical to v0.9.0. Only legitimate documentation and test-only
  differences exist, and Git lists only the primary worktree.

## [2026-08-24T06:28:39Z] Resolution update — partial integration after an earlier application

Capability: Parallel integration; evidence; worktree cleanup
Original finding: Three cross-module failure handoffs remain without end-to-end
fault injection — target 1
Status: resolved by deterministic end-to-end evidence

### New regression

`src/parallel.test.ts` now runs `partial integration retains truthful evidence
after an earlier file applies` through the real `runBatch` parallel lifecycle,
real Git worktree evidence scan, private `integrateWorktrees`, event emission,
batch finalization, and managed cleanup. The fixture leaves a main-workspace
parent file dirty but outside the two exact allowed file paths. The worker
worktree can therefore create both intended files; integration copies the
lexically earlier file, then real `mkdir`/copy processing fails when the later
path encounters the main-workspace parent file.

### Exact evidence

- The worker attempted two observed paths and remained `completed`, `PASS`, and
  `trustworthy:true` with no discrepancies.
- `src/integration-applied.txt` was present in the main workspace with exact
  worker content; `src/integration-blocker` retained its original file content;
  the blocked child did not exist in the main workspace.
- `integration.partial` reported 2 attempted / 1 applied;
  `integration.applied` reported one; no `integration.completed` was emitted.
- The batch returned 1 passed / 0 failed and `integrated:false`; its summary and
  warning named the incomplete count and exact failed operation.
- The retained worktree contained both worker files, proving there was no atomic
  rollback claim or hidden data loss. Its lease was released, and managed
  `cleanupWorktree` removed the diagnostic worktree after inspection.

### Product judgment and confidence impact

No product defect was found. Current intended semantics are intentionally
non-atomic partial integration plus truthful batch-level evidence. Integration
failure does not retroactively rewrite independently established worker verdict
or trust evidence. This durable abnormal-path regression removes target 1's
Battle-tested blocker for Parallel batches and Worktree isolation/integration.

## [2026-08-24T06:28:39Z] Resolution update — already-running parallel cancellation

Capability: Parallel execution; cancellation; evidence; events; worktrees and leases
Original finding: Three cross-module failure handoffs remain without end-to-end
fault injection — target 2
Status: resolved by deterministic end-to-end evidence

### New regression

`src/parallel.test.ts` now runs `an already-running parallel worker cancels while
its sibling completes`. Promise barriers prove both workers entered real
`executeTask`/worker event-stream lifecycles before either can finish. The first
worker writes and reports its file, then signals completion. Only after that
signal does the test abort the batch while the second worker remains blocked in
its event stream. No wall-clock sleep or scheduling-order assumption controls
the transition.

### Exact evidence

- Exactly two workers started concurrently. The successful sibling completed
  `PASS`/trustworthy, its real Git evidence was scanned, and its one file was
  integrated into the main workspace with exact content.
- The in-flight sibling observed the propagated abort, exited its event stream,
  and returned state `cancelled`, verdict/claim `FAILED`,
  `trustworthy:false`, no changed files, and the cancellation runtime error.
- The batch returned 1 passed / 1 failed, emitted truthful started, completed,
  cancelled, integration, and `batch.cancelled` events, and did not emit
  `batch.completed`.
- No controlled worker remained active. Default `onFailure` policy retained the
  cancelled worktree for diagnosis while releasing its persistent lease; the
  test then removed it through managed cleanup.
- The case passed 10/10 repeated executions after its initial targeted PASS.

### Product judgment and confidence impact

No product defect was found. The retained cancelled worktree is explicit policy,
not a leak; it is returned in evidence and has no live lease. This removes target
2's cross-module blocker. Bounded concurrency remains Strong because its
separate second-live-configured-limit gap is unchanged.

## [2026-08-24T06:28:39Z] Resolution update — consumed continuation failure after lease refresh

Capability: Worker Continuation; server finalization; persistent leases; cleanup
Original finding: Three cross-module failure handoffs remain without end-to-end
fault injection — target 3
Status: resolved by deterministic end-to-end evidence

### New regression and narrow production seam

`src/parallel.test.ts` now runs `a consumed retained continuation failure
finalizes its refreshed lease`. A real integration-disabled parallel batch
creates the retained worktree, live persistent lease, and opaque reference in a
dedicated `ContinuationStore`. The test then invokes the same continuation
handler used by MCP registration. The handler has one new internal dependency
seam whose defaults are the existing production store, continuation executor,
lease functions, event sink, reconciliation, event recorder, and batch-id
factory. Normal behavior, schema, tool contract, security, reconciliation, and
cleanup defaults are unchanged. Only the post-start worker failure, event sink,
and deterministic identity are injected.

### Exact evidence

- Before consumption, the lease artifact contained a
  `retained-continuation` generation. Consumption preserved the exact original
  contract, working directory, and `thread-retained-failure` binding.
- The real lease refresh ran once and the continuation callback observed an
  `executing-continuation` generation before throwing the controlled failure.
- The handler returned a tool error, emitted `worker.started`, `worker.failed`,
  and a 0 passed / 1 failed `batch.completed`, then its real `finally` released
  the consumed store lease and the persistent worktree lease exactly once.
- Replay returned `used`; the store exposed no protected directory; the lease
  artifact was absent; the unintegrated retained worktree remained available
  until orchestrator pruning removed it and its Git registration.

### Product judgment and confidence impact

No product defect was found. Single-use consumption is terminal even when the
continuation fails after refresh; the worktree becomes unprotected and eligible
for normal stale pruning after finalization. This removes target 3's
cross-module blocker and, together with the existing successful live retained
continuation, supports Battle-tested confidence for Worker Continuation.

## Findings-closure acceptance update

All three targets are resolved. Parallel batches, Worktree isolation/integration,
and Worker Continuation now satisfy the existing Battle-tested definition by
combining prior live DEEP PASS happy/failure evidence with varied deterministic
abnormal lifecycle handoffs. No other feature is promoted. Adaptive Effort and
P1.1 were not started, and no broad hardening campaign was begun.

## [2026-08-24T06:28:39Z] Findings-closure final validation update

- Targeted partial-integration test: PASS.
- Targeted in-flight parallel cancellation test: initial PASS plus **10/10**
  repeated executions, with no sleeps or scheduling-luck dependency.
- Targeted consumed-continuation finalization test: PASS.
- Full parallel/worktree suite: **76/76 pass**, 0 fail, 0 skip.
- `npm run verify`: PASS; typecheck, **463/463 tests**, 0 fail, 0 skip, and all
  deterministic MCP protocol checks passed.
- `npm run format:check`: PASS.
- `npm run bench:validate`: PASS; all nine fixtures discriminated and mutation
  detection passed.
- `git diff --check`: PASS.
- `npm run build`: PASS.
- No package or lockfile version changed. No push, tag, publish, release, remote
  mutation, global Git/configuration change, credential operation, P1.1 work,
  Adaptive Effort work, or broad hardening campaign was performed.

## [2026-08-24T07:29:49Z] Resolution update — second live configured concurrency limit

Capability: Bounded Concurrency; live scheduler and activity evidence
Original evidence gap: a second distinct live configured limit remained
untested
Status: resolved by live configured-limit evidence

### Exact evidence

- A fresh local MCP process started from this checkout's rebuilt
  `dist/server.js` with `SOL_LUNA_MAX_PARALLEL=2`, distinct from the prior live
  ceiling of 3. The Ubuntu/Linux run preserved the deliberate repo-local
  `LUNA_SANDBOX=danger-full-access` host workaround and did not change global
  Codex configuration.
- Batch `bmt6wx6ibe3aq` queued four independent read-only tasks for four real
  `gpt-5.6-luna` medium-effort workers. All four queued before execution; `t1`
  and `t2` started first, then `t3` started exactly when `t2` completed and `t4`
  exactly when `t1` completed. The later tasks waited 44.018 and 49.016 seconds
  from queue to start.
- Orchestrator-owned lifecycle events produced active counts 1, 2, 1, 2, 1, 0.
  Peak concurrency reached configured 2 and never exceeded it. Every expected
  task had queued, worktree-created, started, completed, and worktree-removed
  evidence; no task disappeared.
- The batch and reduced activity snapshot agreed on `maxParallel:2`, four tasks,
  4 passed / 0 failed, peak 2, terminal current 0, four completed Luna workers,
  no conflicts, and zero retained worktrees. All runtime-observed changed-file
  sets were empty; only the main Git worktree remained, and no lease artifact or
  worker process leaked.
- The configured `git status --short` verification was refused because `git`
  was not allowlisted. The results preserved that refusal and its discrepancies
  and therefore reported `trustworthy:false`; semantic worker audit claims were
  not used to prove scheduling. Scheduler acceptance rests on the typed event
  stream, batch result, worktree lifecycle, and activity projection. An earlier
  overlapping-scope submission was rejected before batch creation or worker
  start and is not counted.

### Product judgment and confidence impact

No concurrency defect was observed and no runtime source changed. Combined with
the prior live ceiling-3 run and broad current deterministic queue,
cancellation, setup, and failure evidence, the distinct live ceiling-2 run
closes the recorded second-limit gap and satisfies the existing Battle-tested
definition for Bounded Concurrency. No unrelated feature is promoted; Adaptive
Effort, P1.1, and the broader hardening campaign remain untouched.

## [2026-08-24T08:30:17Z] Resolution update — natural batching and adaptive effort

Capability: Natural discovery; adaptive routing; adaptive effort
Original evidence gap: no natural batch and only one naturally selected worker
effort level
Status: resolved by six fresh-parent attempts

### Exact evidence

- Six materially different ordinary read-only repository prompts ran in
  genuinely fresh ephemeral GPT-5.6 Sol / medium parent sessions. The prompts did
  not name Sol-Luna, Luna, delegation, workers, routing, effort, or MCP discovery.
  Each parent naturally consulted the configured guidance; dedicated MCP logs
  prove a checkout-local server connection for every attempt.
- Parents `01a032bd-8184-7be0-b8b7-443aae398e63`,
  `01a032bf-1f8d-7612-8137-c50b146623c8`, and
  `01a032c2-39a7-7d63-be0c-714ad91c89ed` chose zero workers for respectively a
  small CLI/README parity check, one tightly coupled contradiction path, and one
  cancellation state-machine audit. All three choices were defensible and all
  three completed read-only reports without task events.
- Parent `01a032c8-927d-7602-8301-4d49e83f9329` naturally chose a three-task
  parallel release-readiness batch. Batch `bmt6y5ebj4olo` recorded three
  concurrent real `gpt-5.6-luna` high-effort starts, 2 PASS / 1 FAILED, zero
  observed edits, integration disabled, and retained review evidence. The parent
  independently scrutinized the mixed results. Its initial overlapping-scope
  contract was rejected before execution; a read-only overlap override was then
  explicit and sensible. A later same-thread continuation preserved high effort
  and failed closed on a scope violation.
- Parent `01a032d6-56ae-7d51-b6a7-281ac86ba7de` naturally chose one high-effort
  Luna task for a cross-surface privacy audit. Batch `bmt6yo0fp5mqy` recorded one
  PASS/trustworthy completion, no discrepancies or scope violations, and zero
  edits before independent parent review.
- Parent `01a032dd-2aa0-7a52-af37-aff8b77a2736` naturally split an
  environment-variable traceability inventory into two parallel tasks. Batch
  `bmt6yy5l0cjtb` selected medium for the mechanical documentation mapping and
  high for cross-file test-coverage judgment. Typed queued/started/completed
  events recorded both real Luna tasks, 2 PASS / 0 FAILED, zero edits, and
  integration disabled. Both selections plausibly matched intrinsic task
  difficulty.
- The portfolio stopped at attempt 6 under the predeclared anti-gaming rule:
  natural medium/high variation and a meaningful natural batch were both
  established. Four additional materially different prompts had been fixed in
  advance but were not executed.
- Raw parent JSONL, final responses, per-attempt diagnostic logs, structured MCP
  results, and event streams are retained locally under ignored
  `.sol-luna/acceptance/adaptive-routing-2026-08-24/`.

### Product judgment and confidence impact

No routing-policy or runtime source change was needed. Natural routing now has
current representative zero-worker, single, and parallel-batch behavior; no
fresh sequential batch was observed, so a complete natural routing ladder is not
claimed. Adaptive Effort now has genuinely natural, task-plausible medium and
high selections and advances from PARTIAL/Basic to PASS/Strong under the existing
ledger definition. The natural-batch evidence gap is closed. No xhigh or max
selection, unrelated capability promotion, P1.1 work, or broad hardening campaign
is claimed.

## [2026-08-24T09:14:58Z] Adaptive-routing incidental findings triage

Scope: exact findings raised by retained adaptive-routing attempts 1–4 only. This
was not P1.1, did not change routing policy, and did not rerun the portfolio.

### A — README omitted the shipped `version` command

- **Source / exact claim:** attempt 1 final response and parent transcript said
  README's normal-use command list omitted `sol-luna-orchestrator version` while
  current CLI help exposed it.
- **Reproduction:** confirmed against `README.md`, `package.json` bins, and
  current CLI help; the CLI implementation was correct.
- **Classification:** **CONFIRMED DOCUMENTATION DEFECT**; low severity, high
  confidence. Canonical owner: `README.md` normal-use commands.
- **Resolution:** added the one missing command. No CLI/product behavior changed.

### B — multi-command verification contradiction lacked direct coverage

- **Source / exact claim:** attempt 2 final response and parent transcript said
  the distinct-match `unmatched` set in
  `verificationFailureIsAuthoritativelyContradicted` was covered only by
  single-command fixtures, not multiple configured commands or multiple failed
  worker rows.
- **Reproduction:** confirmed. Current behavior correctly requires complete,
  ordered, passing authoritative runs and one distinct authoritative match per
  failed worker claim; no implementation defect was found.
- **Classification:** **CONFIRMED COVERAGE GAP**; low severity, high confidence.
- **Resolution:** added one deterministic two-command regression proving both
  successful distinct reconciliation and rejection when duplicate worker claims
  try to consume the same authoritative command.

### C — cancelled parallel tasks could receive production continuations

- **Source / exact claim:** attempt 3 final response and parent transcript said
  the in-flight cancellation regression omitted the production continuation
  registrar, asserted the retained cancelled worktree's lease was released, but
  the MCP path registered any result with a worker thread id and therefore could
  refresh and retain that lease.
- **Reproduction:** statically confirmed across `batch.ts`, `server.ts`, the
  focused cancellation regression, and the acceptance record. The documented
  intended behavior is terminal cancellation: retain the worktree under default
  `onFailure` for diagnosis, do not issue a continuation, and release its lease.
- **Classification:** **CONFIRMED PRODUCT DEFECT** with a residual coverage gap;
  medium severity, high confidence.
- **Resolution:** cancellation is now a shared terminal-result predicate used by
  batch and single-task continuation registration. The existing real in-flight
  regression now supplies a registrar, proves only the completed sibling is
  registered, proves the cancelled result has no reference, and retains its
  lease-release assertion. Integration and terminal event order are unchanged.

### D — retained continuation attributed the shared dependency link to the worker

- **Source / exact claim:** attempt 4 tool result `item_16` for continuation
  `ctr_lZut4cmEm_2eyLqtnYvxM9ZQg-CytVFB` observed
  `/home/mahad-ansar/mahad/sol-luna-orchestrator/node_modules` as an unclaimed
  `add`, then failed forbidden change intent and outside-workspace scope checks.
- **Reproduction:** confirmed in retained worktree evidence. Normal parallel
  setup created an untracked worktree `node_modules` symlink to the main checkout.
  Initial batch evidence removed configured dependency-link entries, while
  retained-continuation reconciliation passed the raw Git entry directly to
  scope reconciliation.
- **Classification:** **CONFIRMED PRODUCT DEFECT**; medium severity and high
  confidence because a valid continuation failed closed on orchestrator-owned
  state. This was not an actual worker edit.
- **Resolution:** initial and retained evidence now exclude a configured link
  only when it is still a symlink/junction whose canonical target equals the
  expected source directory. A focused regression proves the untouched link is
  ignored and a retargeted link remains visible and fails scope checks. Genuine
  directories or changed link targets are not allowlisted.

### E — parallel lifecycle tests inherited `SOL_LUNA_KEEP_WORKTREES=never`

- **Source / exact claim:** attempt 4 parent transcript ran
  `SOL_LUNA_KEEP_WORKTREES=never node --test --test-name-pattern="batch continuations bind|workers that touch the same file" dist/parallel.test.js`.
  It got 0/2: the expected retained continuation reference was `null`, and the
  expected retained conflict worktree paths were absent.
- **Reproduction:** confirmed exactly. Both tests passed without the ambient
  override. A full suite run under `never` exposed five more default-retention
  fixtures with the same implicit dependency. The runtime correctly applied the
  configured `never` cleanup policy; these were not tests of that policy.
- **Classification:** **CONFIRMED TEST-HERMITICITY DEFECT**; medium confidence
  impact, high diagnostic confidence.
- **Resolution:** `runBatch` gained an internal per-run retention seam and all
  fixtures that assert default `onFailure` retention now request it explicitly.
  The full 76-case parallel suite passes with ambient
  `SOL_LUNA_KEEP_WORKTREES=never`; production defaults and operator behavior are
  unchanged.
- **Separate decision:** unconditional conflict/integration-disabled retention
  wording versus the supported `never` policy remains a policy/documentation
  precedence question. It was not guessed or changed in this triage and needs a
  focused decision before relying on those promises under `never`.
