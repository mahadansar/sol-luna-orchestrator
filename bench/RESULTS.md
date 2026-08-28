# Benchmark V2

Benchmark V2 now has a frozen initial campaign and a post-redesign acceptance
campaign. This document preserves the question, method, workload, reporting
rules, measured evidence, and the limits on interpreting those results.

V2 is frozen historical architecture evidence. Its BEFORE/AFTER campaigns
directly informed the Thin Supervisor design, so it is no longer the primary
unbiased optimization target for routing work. The fresh routing holdout is
[Benchmark V3](V3_METHODOLOGY.md), frozen under its freeze 2 (P2.4A) review. No
model-backed V3 campaign has been run under any freeze.

V2 and V3 are not two samples of one experiment. They measure different
architectures on different suites, under different prompt histories, different
harness configuration — V2 sets a per-fixture worker-concurrency ceiling and V3
sets none — and different telemetry schemas. A V2 number and a V3 number may be
discussed together only alongside those differences, and may never be
differenced, pooled, or presented as a larger sample.

Historical V1 JSON and generated reports remain in `bench/results/` as evidence.
They are not the primary product story for V2; Git history preserves the old
curated interpretation.

## Product question

> When should a user run Sol alone, and when should they allow Sol-Luna
> orchestration, based on correctness, credits consumed, and wall-clock latency?

The evaluation order is deliberately lexicographic:

1. deterministic correctness/pass rate;
2. credits consumed;
3. end-to-end wall-clock latency;
4. raw usage and orchestration diagnostics.

Raw tokens remain essential for diagnosing input, cache, output, and reasoning
behaviour. They are not the headline cost measure because Sol and Luna consume
credits at different rates.

## Arms

Every arm fixes the supervisor at `gpt-5.6-sol`, Medium effort. There is no Solo
High or Solo XHigh: changing supervisor effort would confound the effect of
orchestration.

| Arm               | Delegation configuration                            | Policy                                                                                            |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Solo Medium       | MCP disabled in Codex configuration                 | Baseline; Sol implements directly.                                                                |
| Adaptive Medium   | MCP normally available                              | Sol chooses zero, one, or multiple workers. Zero is a valid routing outcome.                      |
| Forced Delegation | MCP available on four predeclared suitable fixtures | One substantial unit uses `delegate_task`; independent workstreams use parallel `delegate_tasks`. |

There is no intentionally sequential counterfactual. Forced splitting is not
run on the small fixtures or coupled control.

## Workload suite

Each fixture is materialised into a fresh temporary workspace, starts failing or
incomplete, is graded after the model stops, protects specification files, and
has a hidden known-good reference solution validated by `bench:validate`.

| Class               | Fixture                  | Engineering task                                                                      | Forced campaign                                                         |
| ------------------- | ------------------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Small               | `v2-config-overlay`      | Deep configuration merge plus typed environment overrides                             | No; one compact module.                                                 |
| Small               | `v2-rate-limiter-tests`  | Author deterministic contract tests for an existing fixed-window limiter              | No; one focused test file, mutation-graded.                             |
| Medium              | `v2-frontmatter-parser`  | Implement a multi-file Markdown front-matter parser from behavioural tests            | One bounded `delegate_task`.                                            |
| Medium              | `v2-worker-pool`         | Diagnose and complete an order-preserving async worker pool                           | Not in the initial forced campaign; routing is intentionally ambiguous. |
| Delegation-friendly | `v2-integration-toolkit` | Four substantial service-integration utilities: route keys, money, retry, and headers | Four parallel disjoint tasks. This is the largest crossover candidate.  |
| Delegation-friendly | `v2-data-contracts`      | Three independent data-contract utilities: JSON Patch, ETags, and circuit breaking    | Three parallel disjoint tasks.                                          |
| Delegation-friendly | `v2-repository-tools`    | Three repository-policy utilities: manifest validation, path policy, and change sets  | Three parallel disjoint tasks.                                          |
| Coupled control     | `v2-checkout-engine`     | One inventory-aware, idempotent checkout engine with shared pricing/state invariants  | No; a safe split would revolve around the same state and file.          |

The suite is not a synthetic module-count ladder and was not designed to make
delegation win. The coupled control and small tasks are expected to provide real
opportunities for Adaptive to stay at zero workers.

## Credit accounting

The result file embeds the complete pricing profile used for its estimate:

- profile: `benchmark-v2-chatgpt-plus-codex-credits-2026-08-24`;
- source: [official Codex rate card](https://help.openai.com/en/articles/20001106);
- units: credits per 1M tokens;
- GPT-5.6 Sol: 125 input, 12.5 cached input, 750 output;
- GPT-5.6 Luna: 5 input, 0.5 cached input, 30 output;
- cache writes: uncharged;
- snapshot date: 2026-08-24;
- applicability: the ChatGPT Plus account used for Benchmark V2.

The Codex SDK's total input includes cached input. The calculator therefore
charges `(input - cached)` at the input rate, cached input once at the cached
rate, and output at the output rate. Reasoning output is already included in
output and is not charged twice.

Calculated values are named `rateCardCredits`/`estimatedCredits`, never actual
credits. `actualCredits` is separately nullable and may only be populated from
an authoritative per-run source. Missing required usage or an unknown model
makes the affected credit total `null`; unknown is never converted to zero.

The V2 snapshot is benchmark evidence, not a production runtime price service.
Before a live campaign, confirm the profile still applies to the account. After
live records exist, any rate change requires a new profile so those records keep
their original snapshot. This pre-launch correction replaced the unused
Business/Enterprise promotional profile; no V2 live result used that profile.

## Result schema and diagnostics

Schema 4 records the V2 arm and task identity, external grade outcome, full Sol
and Luna usage, nullable actual and rate-card credits, duration, whether
delegation occurred, worker count/efforts/durations, batch modes, configured and
observed concurrency, slowest-worker timing, integration/verification failures,
and immutable/mutation grading results. The root embeds the full pricing profile
and the campaign execution profile.

Each run's `creditAccounting.participants` persists one supervisor row followed
by one row per observed delegation. Every row contains `role`, nullable `taskId`
and `workerThreadId`, model, actual selected effort, flat input/cached/output/
reasoning/cache-write token fields, nullable `rateCardCredits`, and nullable
`durationSeconds`. Supervisor identifiers and duration are null because the
harness observes neither a supervisor worker identity nor an authoritative
supervisor-only duration. Worker task/thread identifiers and individual
durations are copied only when telemetry exposes them. A missing participant
usage value makes that participant's credits, the affected model aggregate, and
the run total unknown; it is never replaced with zero. A zero-worker run has one
supervisor participant and a Luna aggregate of zero.

Benchmark V2 requires normal/standard Codex speed with Fast mode disabled. The
installed `@openai/codex-sdk` 0.147.0 exposes neither a supported speed option
nor a service-tier option for supervisor or worker threads, so the harness does
not invent one. Each live command requires `--confirm-standard-speed`; this is
an operator acknowledgement that Fast mode was disabled before launch. Schema 4
records `speedMode: standard`, `fastModeDisabled: true`, a nullable service tier,
the SDK-pinning limitation, and `operator-confirmed-pre-run` enforcement. The
analyzer refuses to combine missing or different execution profiles.

Historical schema-3 files are never mutated or silently repriced. An explicit
`bench:report -- --reprice-current` analysis can calculate a V2-snapshot estimate
when all required fields exist and labels it as a backfill, not historical
billing.

The current audit covers 59 old records. Sol usage is complete in all 59. Total
V2-profile credits are technically recalculable for 48 records: 34 have no
workers (Luna is genuinely zero) and 14 contain complete Luna input/cache/output
usage. Eleven delegated records use legacy output-only sentinel rows and must
remain unknown. By file:

| Historical JSON                          | Recalculable | Unknown |
| ---------------------------------------- | -----------: | ------: |
| `2026-08-14T10-42-36-344Z.json`          |           16 |       0 |
| `2026-08-14T12-38-48-852Z.parallel.json` |           13 |       3 |
| `2026-08-14T13-14-10-688Z.parallel.json` |            0 |       8 |
| `2026-08-14T17-34-04-390Z.scale.json`    |            1 |       0 |
| `2026-08-14T17-38-51-964Z.scale.json`    |            6 |       0 |
| `2026-08-14T17-57-16-992Z.scale.json`    |            6 |       0 |
| `2026-08-14T18-23-37-381Z.scale.json`    |            6 |       0 |

These are estimates under the V2 profile, not evidence of the credit rate that
applied on 2026-08-14.

## Campaign and repetition policy

The initial campaign is 40 model-backed runs:

```text
8 tasks x (Solo Medium + Adaptive Medium) x 2 repetitions = 32
4 suitable tasks x Forced Delegation x 2 repetitions = 8
```

Start with two repetitions. The analyzer recommends a third only when it could
materially clarify a cell: inconsistent pass/fail, at least 25% latency or
credit range, Adaptive routing changes, a worker-count change of at least two,
or a non-Solo arm's credit delta within 10% of Solo. A recommendation is review
input, not an automatic model call.

## Reporting

The primary table is `PASS/FAIL -> Credits -> Time` and compares each strategy
with Solo Medium for the same task. It reports absolute credits/time, percentage
deltas, pass rate, delegation rate, and workers. Equal-correctness comparisons
are classified as cheaper+faster, cheaper+slower, more-expensive+faster, or
more-expensive+slower/dominated (with explicit equality variants). A pass-rate
change takes precedence over that Pareto label.

Worker effort, peak concurrency, worker durations/stragglers, and the full Sol
and Luna input/cache/output/reasoning/cache-write usage remain in diagnostic
sections. The participant table shows every model/effort/credit attribution,
then separate Sol, Luna, and run totals. Individual parallel worker durations
remain separate; only the run-total row shows end-to-end wall-clock.

No V2 conclusions should be added until committed schema-4 records support them.

## Commands

Deterministic preparation and reporting make no model calls:

```bash
npm run bench:validate
npm run typecheck
npm test
npm run bench:report -- bench/results/<v2-result>.json
npm run bench:analyze -- bench/results --campaign benchmark-v2-initial
```

The reviewed live campaign is deliberately two commands:

```bash
npm run bench:v2 -- --confirm-standard-speed
npm run bench:v2:forced -- --confirm-standard-speed
```

The first command runs 32 Solo/Adaptive turns. The second uses the four
predeclared legitimate forced fixtures and runs eight turns. Do not run either
casually: both invoke live Codex models.

Each completed task/arm/repetition cell is checkpointed into the current
timestamped shard. Before any model call, the harness scans every schema-4 shard
with the selected campaign ID, validates the schema/benchmark version, Sol model
and effort, full pricing profile, and execution profile, and rejects duplicate
existing cells. Cell identity is `campaignId + taskId + arm + repetition`.
Because Forced cells do not overlap Solo/Adaptive cells, the normal second phase
is accepted under the same campaign ID.

An interrupted ordinary invocation refuses to rerun any already-recorded
selected cell. After inspecting the preserved shard, resume only the missing
cells with the same command plus `--resume`:

```bash
npm run bench:v2 -- --confirm-standard-speed --resume
npm run bench:v2:forced -- --confirm-standard-speed --resume
```

Both PASS and FAIL records count as completed evidence. Resume never rewrites an
older shard; new completions are checkpointed after every run into a new
timestamped shard. If every requested cell already exists, resume exits
successfully without creating a shard or making a model call. The pre-run output
states planned, already completed, remaining, and resume-mode counts.

Each checkpoint is serialized to a uniquely named `.tmp` sibling, written and
flushed completely, and only then renamed over the current `.v2.json` shard.
Same-directory placement keeps replacement on one filesystem. A handled write,
flush, or rename failure leaves the previous valid shard intact and removes the
temporary file where possible; leftover `.tmp` files from a process or machine
crash are ignored by campaign shard discovery.

After reviewing the two raw files, generate the combined final narrative/table
artifact with:

```bash
npm run bench:analyze -- bench/results --campaign benchmark-v2-initial --output bench/RESULTS.md
```

## Methodology risks to resolve before launch

- Re-check that the Plus rate-card snapshot still applies immediately before
  launch; do not substitute a Business/Enterprise purchased-credit schedule.
- Disable Fast mode in ChatGPT/Codex before both campaign commands. The CLI flag
  records the operator confirmation but cannot inspect the account setting, and
  the installed SDK cannot pin or observe a service tier.
- Two repetitions are directional, not statistically significant. Preserve all
  failures and routing variance and follow the selective third-run policy.
- Deterministic graders establish the specified behaviour, not general software
  quality or maintainability outside that contract.
- Wall-clock includes network/model variance on one machine. Pareto labels
  describe this campaign, not universal model performance.
- Inspect an interrupted shard before resuming. Duplicate cells, malformed V2
  shards, or incompatible campaign metadata fail closed rather than being
  silently ignored or deduplicated.
- Historical backfills use the V2 snapshot and are not comparable to actual
  historical billing unless the same rate card is independently established.

## Thin-supervisor architecture experiment

### Decision and evidence boundary

The 2026-08-25 experiment selected **Candidate 3: terminal verification state
machine** as the best of three materially different runtime candidates. It is a
real architectural improvement: successful Adaptive delegations now return to
Sol through a deterministic verified terminal state, and the median-task Sol
credit sum fell by about 25% from the frozen initial campaign. It is not a
universal economic win. The final campaign did not establish the requested
25% Adaptive saving versus contemporaneous Solo on any delegated workload, and
one valid recovered timeout makes the overall Adaptive credit total unknown.

The evidence uses these immutable conditions:

- BEFORE campaign: `benchmark-v2-initial`, 50 preserved records after ten
  legitimate stopping-rule third repetitions;
- AFTER campaign:
  `benchmark-v2-final-terminal-verification-62d9e00-20260825`, 48 preserved
  records after eight legitimate stopping-rule third repetitions;
- supervisor: `gpt-5.6-sol`, Medium effort;
- workers: `gpt-5.6-luna`, task-selected Medium or High effort;
- standard Codex speed, Fast disabled and operator-confirmed before every live
  command;
- identical frozen V2 fixtures, prompts, graders, hidden references, pricing
  profile, task selection, and comparison method;
- runtime measured by fresh Codex sessions registered to the local
  `D:\code\gpt-test\sol-luna-orchestrator\dist\server.js`, never the global
  npm package.

All 50 BEFORE records and all 48 AFTER records passed deterministic grading.
A PASS does not erase failed worker attempts, missing usage, or latency; those
remain part of the raw evidence.

### BEFORE findings and causal diagnosis

The frozen initial campaign showed that Adaptive usually cost more and took
longer than Solo. Values below are medians after the frozen stopping rule;
credits are rate-card estimates and time is end-to-end wall-clock.

| Task                | Solo credits / time | Adaptive credits / time | Adaptive versus Solo | Adaptive workers | Forced credits / time |
| ------------------- | ------------------: | ----------------------: | -------------------: | ---------------: | --------------------: |
| checkout-engine     |         6.75 / 101s |            10.73 / 107s |           +59% / +6% |                0 |          not selected |
| config-overlay      |        6.19 / 83.5s |              6.53 / 81s |            +6% / -3% |                0 |          not selected |
| data-contracts      |        10.97 / 168s |            15.32 / 267s |          +40% / +59% |           0 or 3 |          10.04 / 203s |
| frontmatter-parser  |         8.15 / 109s |             9.59 / 159s |          +18% / +46% |           0 or 1 |          11.17 / 283s |
| integration-toolkit |         9.81 / 145s |            13.25 / 295s |         +35% / +103% |                4 |        unknown / 609s |
| rate-limiter-tests  |        5.12 / 88.5s |              6.57 / 72s |          +28% / -19% |                0 |          not selected |
| repository-tools    |         7.34 / 139s |            11.29 / 204s |          +54% / +47% |                3 |           9.90 / 178s |
| worker-pool         |        3.87 / 54.5s |              5.39 / 61s |          +39% / +12% |                0 |          not selected |

Across the eight median task cells, BEFORE Adaptive cost 78.67 credits versus
58.21 Solo, a 35% premium. Sol contributed 75.41 of the Adaptive credits and
Luna only 3.18. On the four final-campaign zero-worker fixtures, the
corresponding BEFORE Adaptive sum was 28.08 versus 23.33 Solo, a 20% gating
tax despite no Luna execution.

The causal investigation found four reinforcing costs:

1. The advertised MCP metadata was 37,839 characters and repeated verbose
   descriptions and schemas in the expensive supervisor context.
2. Clean worker successes returned overlapping human text and structured
   evidence. Continuation/review guidance invited the parent to reconstruct the
   implementation, inspect files, and repeat checks.
3. The runtime ended integration without a single explicit final-workspace
   terminal state, so Sol remained responsible for deciding whether worker
   evidence was enough and commonly reactivated its implementation/review loop.
4. Parallel timeout recovery was supervisor-shaped. In the worst Forced
   integration run, two 300-second worker failures were followed by replacement
   work; the run still passed but took 921 seconds and had unknown total
   credits. A third repetition took 609 seconds after another 300-second failed
   attempt.

Worker transcripts and reasoning were already isolated from Sol, Luna was
cheap, and worktree/scope/verification enforcement was already strong. The
dominant controllable problem was therefore Sol-facing protocol and lifecycle
overhead, plus untargeted failure recovery, not Luna's price.

### Architecture before and after

The old effective lifecycle was conversational:

```text
Sol explores and plans
  -> delegates
  -> runtime returns detailed evidence
  -> Sol interprets, rereads, rechecks, and may replace work
  -> Sol decides whether the batch is globally complete
```

The selected lifecycle is a deterministic state machine around a still
architectural Sol:

```text
Sol understands and architects
  -> cheap routing decision
  -> immutable ownership contracts
  -> Luna explores, implements, verifies, and repairs its owned seam
  -> runtime preserves successes and recovers only one eligible failed seam
  -> runtime integrates
  -> runtime deduplicates and reruns declared checks in the final workspace
  -> VERIFIED_COMPLETE: compact terminal handoff and finish
     or needs-supervisor: expanded evidence for targeted diagnosis
```

The runtime cannot force a parent model to stop reasoning, but it now makes the
successful path unambiguous and makes failure the only path that expands.

### Candidate-to-evidence map

Every live candidate was committed first, rebuilt, locally re-registered,
checked with `status`, `doctor`, and `codex mcp get`, and measured from fresh
Codex sessions. Evidence commits were created only after the associated live
runs.

#### Candidate 1: `thin-supervisor-recovery-v1`

- exact measured architecture SHA:
  `87ea54096d8f3ffeff8796f2b6d6250347e24146`;
- evidence commit: `6c5517a08cb14febf70a448158801b66cf4318f3`;
- campaign: `benchmark-v2-thin-supervisor-recovery-v1-20260825`;
- architecture: removed redundant output-schema advertising, compacted
  metadata/results/continuation guidance, expanded only failures, and added one
  bounded automatic recovery attempt for an eligible parallel failure while
  preserving successful streams;
- result shards:
  `bench/results/2026-08-24T22-19-09-889Z.v2.json`,
  `bench/results/2026-08-24T22-19-09-889Z.v2.md`,
  `bench/results/2026-08-24T22-40-55-465Z.v2.json`, and
  `bench/results/2026-08-24T22-40-55-465Z.v2.md`.

#### Candidate 2: `minimal-protocol-handoff-c2`

- exact measured architecture SHA:
  `76a7b935cb53bcd4077a36400b6f8ce92cce6e42`;
- evidence commit: `7e9c7ba35e292fdaaed50483bd41d0bb0095501c`;
- campaign:
  `benchmark-v2-minimal-protocol-handoff-c2-76a7b93-20260825`;
- architecture: made `handoff` the default result mode, omitted
  `structuredContent` for a clean verified PASS, retained compact/full
  compatibility modes, and removed descriptive prose from advertised schemas
  without weakening validators or defaults;
- result shards:
  `bench/results/2026-08-24T23-03-32-785Z.v2.json`,
  `bench/results/2026-08-24T23-03-32-785Z.v2.md`,
  `bench/results/2026-08-24T23-22-14-757Z.v2.json`,
  `bench/results/2026-08-24T23-22-14-757Z.v2.md`, and
  `bench/results/benchmark-v2-minimal-protocol-handoff-c2-76a7b93-20260825.analysis.md`.

#### Candidate 3: `terminal-verification-state-machine-c3`

- exact targeted-probe architecture SHA:
  `187f962be18998a6a4e0b5d9e717d62001ffbe41`;
- exact final-acceptance premeasurement SHA:
  `62d9e00f9e44b51ca9bae4941c50f332bfe93585`;
- targeted campaign:
  `benchmark-v2-terminal-verification-c3-187f962-20260825`;
- final campaign:
  `benchmark-v2-final-terminal-verification-62d9e00-20260825`;
- architecture: retained Candidates 1 and 2, then made the runtime rerun the
  deduplicated union of completed tasks' declared verification commands in the
  integrated workspace. Only a completely clean batch reaches
  `completionState: verified-complete` and the text-only
  `TERMINAL: VERIFIED_COMPLETE` handoff. Missing, refused, failed, conflicted,
  or incomplete final checks produce `needs-supervisor` with expanded evidence;
- targeted shards:
  `bench/results/2026-08-25T03-03-00-164Z.v2.json`,
  `bench/results/2026-08-25T03-03-00-164Z.v2.md`,
  `bench/results/2026-08-25T03-18-30-270Z.v2.json`,
  `bench/results/2026-08-25T03-18-30-270Z.v2.md`, and
  `bench/results/benchmark-v2-terminal-verification-c3-187f962-20260825.analysis.md`;
- final shards:
  `bench/results/2026-08-25T03-26-06-648Z.v2.json`,
  `bench/results/2026-08-25T03-26-06-648Z.v2.md`,
  `bench/results/2026-08-25T04-40-36-356Z.v2.json`,
  `bench/results/2026-08-25T04-40-36-356Z.v2.md`,
  `bench/results/2026-08-25T05-09-20-440Z.v2.json`,
  `bench/results/2026-08-25T05-09-20-440Z.v2.md`,
  `bench/results/2026-08-25T05-11-18-503Z.v2.json`,
  `bench/results/2026-08-25T05-11-18-503Z.v2.md`,
  `bench/results/2026-08-25T05-24-19-654Z.v2.json`,
  `bench/results/2026-08-25T05-24-19-654Z.v2.md`, and
  `bench/results/benchmark-v2-final-terminal-verification-62d9e00-20260825.analysis.md`.

### What changed and how the eight priorities were addressed

| Priority                                     | Implemented behavior                                                                                                                                                                           | Evidence and limit                                                                                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Reduce supervisor work after delegation   | Clean PASS returns a terminal text-only handoff; successful batch finalization is runtime code.                                                                                                | Final Adaptive delegated runs spent 5.5-8.9s in observed supervisor-after time, versus 26.8-113.1s in delegated BEFORE Adaptive runs.                                                                                           |
| 2. Stop duplicate understanding/verification | The runtime, not Sol, reruns the final command union and tells Sol to finish without rereading files or rerunning passed checks.                                                               | Deterministic tests cover terminal closure, final PASS, failure expansion, and partial streams. A parent can still ignore guidance.                                                                                             |
| 3. Make gating cheap                         | Tool descriptions became routing cards; validators/defaults remain while redundant prose and output schemas are absent. Metadata fell from 37,839 to 10,218 characters.                        | Aggregate zero-worker overhead fell from 20% to 3%; config-overlay alone remained +13%.                                                                                                                                         |
| 4. Strengthen ownership                      | Existing required/optional/forbidden change intent, allowed/forbidden files, immutable contracts, context capsules, isolated worktrees, and overlap/conflict rules remain authoritative.       | No scope, immutable-file, or integration-conflict failure occurred in the final campaign. File scopes remain detective, not a write sandbox.                                                                                    |
| 5. Directly consumable handoffs              | `handoff` is the default. Clean verified PASS is text-only; compact/full are explicit compatibility modes; failures progressively disclose evidence.                                           | Final fresh sessions exercised real handoff mode; all delegated externally graded tasks passed.                                                                                                                                 |
| 6. Reduce repeated ingestion                 | Clean successes omit structured evidence and worker reasoning; schema descriptions and repeated guidance were removed; narrow context capsules and ownership contracts remain worker-specific. | Metadata is 73% smaller. Sol's final median-task credit sum is 25% below BEFORE Adaptive, although initial Sol exploration remains.                                                                                             |
| 7. Target failure recovery                   | One eligible timeout continues the same thread/worktree; a no-result process failure gets one fresh-process attempt in the same owned worktree. Successful siblings and identities survive.    | Final Adaptive data rep 2 preserved two successes, retried only `t2` after a 300s failure, and passed. Missing failed-attempt usage makes credits unknown.                                                                      |
| 8. Change the execution pattern              | Batch execution now has explicit integration verification and `verified-complete`/`needs-supervisor` states, with typed activity events.                                                       | Final Forced integration-toolkit runs were clean at about 199s and 202s; they did not reproduce the prior 921s worker failure, so they do not prove recovery reduced 921s to 202s. Worker stragglers still dominate some tasks. |

The implementation is concentrated in `src/batch.ts`, `src/server.ts`,
`src/contract.ts`, and `src/events.ts`; the CLI reducer/rendering projects the
new integration-verification state. `src/bench/run.ts` learned attempt-aware
telemetry so a recovery is recorded instead of conflated with the original
attempt; it did not change fixtures, prompts, grading, pricing, or arm policy.
Tests in `src/parallel.test.ts`, `src/evidence.test.ts`,
`src/guidance.test.ts`, `src/activity.test.ts`, and the protocol smoke cover
deduplication, no-command refusal, final failure expansion, completed-only
command union, partial-stream preservation, attempt identity, compact results,
metadata, and truthful activity.

### Deterministic validation

At Candidate 3 architecture commit `187f962` and again immediately before the
final campaign at `62d9e00`, the broad gate passed:

- `npm run verify`: 516 tests discovered, 513 passed, 0 failed, and 3 expected
  Windows platform skips, plus typecheck and deterministic protocol smoke;
- `npm run bench:validate`: every frozen V2 fixture and hidden reference
  discriminated correctly;
- `npm run format:check`: passed;
- `npm run build`: passed;
- local `init --allow-ephemeral`, `status`, `doctor`, and `codex mcp get`:
  passed, with Doctor reporting Ready and every command resolving the local
  `dist/server.js`.

No runtime architecture changed after that gate.

### Targeted live probes

These are one-repetition directional probes, not final estimates. Every listed
run passed deterministic grading. Deltas compare Adaptive or Forced with the
same candidate's Solo run.

| Candidate                |                     config Adaptive |                         data Adaptive |                   integration Adaptive |          integration Forced |
| ------------------------ | ----------------------------------: | ------------------------------------: | -------------------------------------: | --------------------------: |
| C1 recovery              | 7.69 / 99s (+54% / +48%), 0 workers |  10.10 / 266s (+4% / +65%), 3 workers | 14.15 / 534s (+15% / +240%), 4 workers |                12.39 / 217s |
| C2 minimal handoff       | 6.15 / 99s (+35% / +52%), 0 workers | 14.43 / 290s (+30% / +59%), 3 workers | 13.37 / 334s (+43% / +144%), 4 workers |   8.30 / 220s (-11% / +61%) |
| C3 terminal verification | 6.75 / 107s (-9% / -33%), 0 workers |   7.55 / 229s (-5% / +44%), 3 workers |    5.80 / 135s (-32% / +5%), 4 workers | 12.92 / 268s (+51% / +109%) |

C1 and C2 compressed the protocol but did not reduce the parent's successful
post-delegation lifecycle enough. C3 was selected because its targeted
Adaptive integration run reached the minimum 25% credit-saving threshold while
holding latency near Solo and because its terminal state addressed the measured
cause rather than tuning a fixture. The unfavorable C3 Forced result was
preserved and was not rerun.

### Final BEFORE versus AFTER benchmark

The table uses each campaign's stopping-rule median. `unknown` is deliberate:
AFTER data Adaptive rep 2 contains a real 300-second failed `t2` attempt whose
usage was unavailable, followed by a successful 120-second targeted retry.

| Task                |  BEFORE Solo | BEFORE Adaptive |    AFTER Solo | AFTER Adaptive | AFTER Adaptive versus Solo |          Route after |
| ------------------- | -----------: | --------------: | ------------: | -------------: | -------------------------: | -------------------: |
| checkout-engine     |  6.75 / 101s |    10.73 / 107s | 6.85 / 110.5s |    9.62 / 206s |                +40% / +86% |               1 High |
| config-overlay      | 6.19 / 83.5s |      6.53 / 81s |   6.78 / 108s |    7.68 / 107s |                 +13% / -1% |                    0 |
| data-contracts      | 10.97 / 168s |    15.32 / 267s |   9.33 / 159s | unknown / 287s |             unknown / +81% | 3, one rep recovered |
| frontmatter-parser  |  8.15 / 109s |     9.59 / 159s |   8.47 / 125s |    8.64 / 134s |                  +2% / +7% |                    0 |
| integration-toolkit |  9.81 / 145s |    13.25 / 295s |   7.70 / 110s |    6.69 / 155s |                -13% / +41% |            4, peak 4 |
| rate-limiter-tests  | 5.12 / 88.5s |      6.57 / 72s |  5.05 / 61.5s |     4.72 / 61s |                  -6% / -1% |                    0 |
| repository-tools    |  7.34 / 139s |    11.29 / 204s | 7.97 / 130.5s |  6.26 / 148.5s |                -21% / +14% |            3, peak 3 |
| worker-pool         | 3.87 / 54.5s |      5.39 / 61s |    4.54 / 51s |     4.61 / 59s |                 +1% / +16% |                    0 |

All AFTER cells passed: 17/17 Solo, 22/22 Adaptive, and 9/9 Forced.
Forced AFTER medians were:

| Task                | Forced credits / time | Forced versus AFTER Solo | Workers |
| ------------------- | --------------------: | -----------------------: | ------: |
| frontmatter-parser  |         5.28 / 205.5s |              -38% / +64% |  1 High |
| integration-toolkit |        10.15 / 200.5s |              +32% / +82% |       4 |
| data-contracts      |           9.21 / 238s |               -1% / +50% |       3 |
| repository-tools    |         9.10 / 195.5s |              +14% / +50% |       3 |

### Economics, latency, and threshold decisions

- **Zero-worker overhead:** BEFORE the four comparable zero-worker Adaptive
  medians summed to 28.08 credits versus 23.33 Solo (+20%). AFTER they summed
  to 25.64 versus 24.85 Solo (+3%). The aggregate `<=5%` target was reached;
  it was not uniform because config-overlay remained +13%.
- **Sol credits:** the eight-task Adaptive median Sol sum fell from 75.41 to
  56.22 credits (-25%). AFTER Adaptive Sol was 1% below AFTER Solo's 56.69,
  versus a 30% Sol premium BEFORE. This is the clearest successful architecture
  outcome.
- **Luna credits:** BEFORE Adaptive's median Luna sum was 3.18. AFTER has 2.31
  known credits across seven complete task medians. Final data-contracts
  repetition 2 has 1.62 known credits from the successful siblings and retry,
  but its 300-second failed attempt is unpriced, so the exact total remains
  unknown.
- **Overall Adaptive:** the exact AFTER total is unknown because of that
  unpriced failed 300-second Luna attempt. Direct recalculation from the raw
  shards gives a lower bound of 60.375 credits: 48.2036 from the seven
  complete Adaptive task medians plus a minimum 12.17164 data-contracts median.
  Data-contracts repetition 2 is at least 12.17164 (10.551325 Sol + 1.620315
  priced Luna work); with repetitions 1 and 3 at 13.370561 and 7.655893, its
  three-repetition stopping-rule median is therefore at least 12.17164. Solo
  sums to 56.6879 credits. Thus Adaptive is already at least approximately 6.5%
  more expensive (60.375 / 56.6879 - 1), proving it did not beat Solo overall;
  the unknown failed-attempt usage can only increase the exact total.
- **Delegated savings:** final Adaptive saved 13% on integration-toolkit and
  21% on repository-tools, cost 40% more on checkout-engine, and is unknown on
  data-contracts. No final Adaptive median reached the 25%, 35%, or roughly 50%
  delegated-workload threshold. The targeted 32% integration saving did not
  reproduce at that magnitude in the final median.
- **Forced savings:** forced frontmatter reached 38% savings but was 64% slower.
  Forced delegation-friendly tasks did not reach 25% savings. Forced execution
  is not evidence for overall Adaptive routing economics.
- **Latency:** BEFORE Adaptive median task times summed to 1,246s versus 888.5s
  Solo (+40%). AFTER they summed to 1,157.5s versus 855.5s (+35%). The
  lifecycle is thinner, but workers and stragglers still make Adaptive slower
  overall.

These repetitions are directional. No statistical significance or universal
superiority is claimed.

### Failure recovery and the 921-second mode

The specific catastrophic Forced integration pattern was not reproduced in the
final campaign. Its BEFORE attempts were 213s, 921s, and 609s; the latter two
each contained one or two 300-second failed workers and replacement work. Final
Forced integration-toolkit runs passed in about 199s and 202s with four
workers, no failed attempt, peak concurrency 4, and final integration
verification. These clean runs do not prove that recovery reduced the prior
921s failure to 202s.

The broader timeout problem is mitigated, not eliminated. Final Adaptive
data-contracts rep 2 preserved two successful siblings, timed out `t2` at
300s, then continued and retried only that task in the same owned worktree.
The retry passed in 120s, final integration verification passed, and the
overall run passed in 475s. This proves targeted recovery and successful-stream
preservation, while also proving that one retry can still be slow and
economically unmeasurable when the failed attempt exposes no usage.

### Remaining bottlenecks and ideas not worth pursuing

The largest remaining cost is Sol's initial request/repository understanding
and its probabilistic choice of decomposition and effort. The MCP runtime can
shrink metadata, compact results, and make completion deterministic after a
tool call; it cannot prevent Sol from exploring too much before the call or
from ignoring a terminal instruction afterward. Forced runs also show 30-57s
of post-worker supervisor time in some cases, even though natural Adaptive
delegated runs stayed below 9s.

Luna worker price is no longer the main economic problem, but worker latency
and 300-second stragglers remain. Timeout attempts need authoritative usage
capture so a valid run does not make a whole arm economically unknown.

The following did not justify further architecture iterations:

- metadata/result compression alone (Candidates 1 and 2);
- always forcing delegation;
- adding workers or concurrency to chase a favorable sample;
- returning rich success evidence for Sol to review;
- unbounded replacement workers or complete batch restarts;
- more tiny schema/prompt variations after three coherent candidates.

### Engineering recommendations

#### KEEP

Keep the terminal integration-verification state machine, default text-only
handoff, immutable ownership contracts, worker-owned scoped verification,
isolated worktrees, progressive failure disclosure, typed activity evidence,
and one bounded task-local recovery. They materially reduced Sol duplication
without weakening correctness or security.

#### FIX

Capture usage for timed-out/failed worker attempts; fix the analyzer's
Solo-vs-Solo third-repetition self-recommendation; investigate config-overlay's
remaining +13% zero-worker variance; and make terminal completion easier for
parents to honor consistently. Any change to the frozen analyzer should apply
only to future methodology, never historical shards.

#### REDESIGN

For another generation, separate deterministic eligibility from expensive
architecture: a tiny preflight should decide obvious zero-worker cases before
repository exploration. Consider a runtime-owned completion primitive that can
close a verified batch without another open-ended supervisor reasoning phase.
The design must retain Sol for genuine interfaces, ambiguity, conflicts,
security review, and final architectural judgment.

#### DEFER

Defer predictive cost routing, deeper effort optimization, more retry classes,
and context-cache schemes until timeout usage and parent before/after telemetry
are complete enough to evaluate them. Do not infer savings from raw tokens or
cache hit rates.

#### STOP

Stop treating forced delegation, maximum parallelism, or protocol compression
alone as the product strategy. Stop after this third candidate rather than
live-benchmarking tiny variations. Do not claim overall Adaptive savings from
this campaign: the priced subset is slightly more expensive and the full total
is unknown.

### Exact independent rerun sequence

The following reproduces the winning runtime, local registration checks, and
benchmark method on Windows PowerShell. Use new campaign IDs; never reuse the
recorded IDs.

```powershell
git switch --detach 62d9e00f9e44b51ca9bae4941c50f332bfe93585
git rev-parse HEAD
npm run build
node ./dist/cli.js init --allow-ephemeral
node ./dist/cli.js status
node ./dist/cli.js doctor
codex mcp get sol-luna-orchestrator
```

`status`, `doctor`, and `codex mcp get` must all resolve exactly:

```text
D:\code\gpt-test\sol-luna-orchestrator\dist\server.js
```

Before live commands, disable Fast mode in Codex. The SDK cannot observe or pin
service tier, so this remains an operator check; the harness records it only
when `--confirm-standard-speed` is present. On the measured host,
`service_tier = "default"` corroborated standard mode. The harness explicitly
starts every fresh supervisor thread as `gpt-5.6-sol` Medium regardless of the
development session's effort, and every worker is `gpt-5.6-luna`.

A discriminating probe equivalent to Candidate 3 is:

```powershell
$probeCampaign = 'manual-terminal-verification-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
npm run bench -- --suite v2 --tasks v2-config-overlay,v2-data-contracts,v2-integration-toolkit --arms solo-medium,adaptive-medium --reps 1 --campaign $probeCampaign --confirm-standard-speed
npm run bench -- --suite v2 --tasks v2-integration-toolkit --arms forced-delegation --reps 1 --campaign $probeCampaign --confirm-standard-speed
npm run bench:analyze -- bench/results --campaign $probeCampaign --output "bench/results/$probeCampaign.analysis.md"
```

The full acceptance campaign is:

```powershell
$finalCampaign = 'manual-benchmark-v2-terminal-verification-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
npm run bench -- --suite v2 --arms solo-medium,adaptive-medium --reps 2 --campaign $finalCampaign --confirm-standard-speed
npm run bench -- --suite v2 --arms forced-delegation --reps 2 --campaign $finalCampaign --confirm-standard-speed
npm run bench:analyze -- bench/results --campaign $finalCampaign --output "bench/results/$finalCampaign.analysis.md"
```

Review the analyzer after two repetitions. For every pass mismatch, routing or
worker-count change, >=25% latency/credit range, or non-Solo near-tie, run
exactly rep 3 for that task/arm with the same campaign, `--reps 3 --resume`, and
`--confirm-standard-speed`; then regenerate per-shard reports and the combined
analysis. The frozen final-campaign analysis predates the analyzer fix and
retains its historical Solo-vs-Solo recommendations; future analysis no longer
emits those meaningless self-comparisons. Preserve passes, failures, timeouts,
missing usage, JSON shards, and matching ignored event/diagnostic logs.

The measured final campaign used these exact selective commands after analyzer
review:

```powershell
npm run bench -- --suite v2 --tasks v2-config-overlay --arms solo-medium --reps 3 --campaign benchmark-v2-final-terminal-verification-62d9e00-20260825 --confirm-standard-speed --resume
npm run bench -- --suite v2 --tasks v2-config-overlay,v2-data-contracts,v2-frontmatter-parser,v2-integration-toolkit,v2-rate-limiter-tests,v2-worker-pool --arms adaptive-medium --reps 3 --campaign benchmark-v2-final-terminal-verification-62d9e00-20260825 --confirm-standard-speed --resume
npm run bench -- --suite v2 --tasks v2-data-contracts --arms forced-delegation --reps 3 --campaign benchmark-v2-final-terminal-verification-62d9e00-20260825 --confirm-standard-speed --resume
npm run bench:analyze -- bench/results --campaign benchmark-v2-final-terminal-verification-62d9e00-20260825 --output bench/results/benchmark-v2-final-terminal-verification-62d9e00-20260825.analysis.md
```

Those recorded campaign IDs should now be used only for analysis, never new
measurements.
