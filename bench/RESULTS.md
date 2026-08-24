# Benchmark V2

Benchmark V2 is ready for a live campaign, but that campaign has not been run.
This document defines the question, method, workload, and reporting rules without
pre-writing a result.

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
or a credit delta within 10% of Solo. A recommendation is review input, not an
automatic model call.

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
