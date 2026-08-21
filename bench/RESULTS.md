# Benchmark results

Three suites, all graded by the harness after the agent stops — never by the agent.

- **Micro** — four small single-file tasks. Tests whether delegation is worth it
  at small scale.
- **Parallel** — two projects, each with three independent modules specified by
  their own test files. Tests whether orchestration pays off when there is real,
  separable work.
- **Scale** — four- and six-stream projects at roughly twice the module depth,
  plus a deliberately coupled control. Built to locate the point where
  orchestration becomes competitive with a supervisor working alone, and
  reporting that it did not find one.

Everything below separates **measured** from **interpretation**. Raw records are
in `bench/results/*.json`.

---

## Headline

1. **On small tasks, delegating is worse.** ~2.3x slower, ~3.5x the tokens, no
   measurable quality difference. Unchanged from the previous release, and still
   the single most useful thing this project has measured.
2. **On three-module projects, parallel delegation beat sequential delegation in
   every task and every repetition** — median 155s vs 248s, and far more
   consistent (122–183s vs 193–565s).
3. **Neither beat a strong supervisor working alone** on fixtures this size:
   solo-high was ~63s.
4. **Left to its own judgement, the supervisor usually declines to delegate these
   tasks at all**, which is the policy working as intended.
5. **No arm ever failed.** Quality was identical everywhere: 24/24 runs passed.
6. **The crossover investigation found no crossover.** Four- and six-stream
   fixtures at roughly twice the module depth still favoured the supervisor
   alone, and going from four streams to six made orchestration relatively
   _worse_ (+46% → +108%). Stream count is not the road to break-even.
7. **The slow-worker tail is a strong candidate for the dominant remaining
   parallel-latency constraint.** Orchestrated wall-clock is
   `slowest worker + ~70s`; the slowest of six workers ran 3.5× the median in one
   Tier C repetition. Fixed orchestration cost is almost entirely the supervisor
   — worktree setup and integration together are ~1.2s.
8. **Free choice declined to delegate in 6 of 6 scale runs** and was the fastest
   arm on two of three fixtures.

---

## Micro suite — measured

**What this suite is for: showing when _not_ to delegate.** Four small
single-file tasks, sized so that delegation overhead should dominate. It answers
"is handing this off worth it?" and the answer here is no.

`2026-08-14T10-42-36-344Z.json` · 4 tasks × 2 arms × 2 reps = 16 runs ·
`gpt-5.6-sol` at high effort · Node v24.5.0 on win32 x64.

| Arm             | Passed  | Median wall-clock | Median output tokens | Median input tokens |
| --------------- | ------- | ----------------- | -------------------- | ------------------- |
| Sol high, solo  | **8/8** | **41s**           | **921**              | **67,805**          |
| Sol high + Luna | **8/8** | 96s               | 3,275                | 229,854             |

Effort selection across 8 delegations: `medium` ×3 (mechanical test writing),
`high` ×3 (bug fix, feature), `xhigh` ×2 (both on the one task whose cause was
not stated up front). `max` was never chosen.

---

## Parallel suite — measured

**What this suite is for: comparing parallel delegation against sequential
delegation**, on multi-module projects where the work genuinely splits. It does
not attempt to show delegation beating solo execution, and it does not.

`2026-08-14T12-38-48-852Z.parallel.json` · 2 tasks × 4 arms × 2 reps = 16 runs ·
Node v24.5.0 on win32 x64.

In this run the supervisor decided for itself whether to delegate.

| Arm                        | Sol effort | Passed | Delegated | Median wall-clock | Median output tokens | Median input tokens |
| -------------------------- | ---------- | ------ | --------- | ----------------- | -------------------- | ------------------- |
| Sol high, solo             | high       | 4/4    | 0/4       | **63s**           | 1,934                | 102,695             |
| Sol xhigh, solo            | xhigh      | 4/4    | 0/4       | 82s               | 2,339                | 82,665              |
| Sol high + sequential Luna | high       | 4/4    | 2/4       | 221s              | 5,087                | 256,118             |
| Sol high + parallel Luna   | high       | 4/4    | 1/4       | 94s               | 1,722                | 216,553             |

**The "Delegated" column matters more than the timings.** Despite being told to
supervise and delegate, the supervisor chose to implement the work itself in 5 of
8 runs across the two delegating arms. The medians for those arms therefore mix
"delegated" and "did it myself" runs and should not be read as the cost of
delegation.

### Runs that actually delegated

Taken from the individual records rather than the medians:

| Task             | Arm        | Wall-clock | Workers | Efforts chosen         |
| ---------------- | ---------- | ---------- | ------- | ---------------------- |
| parallel-toolkit | sequential | 212s       | 3       | high, medium, high     |
| parallel-toolkit | parallel   | 151s       | 3       | high, high, xhigh      |
| parallel-httpkit | sequential | 245s       | 3       | medium, medium, medium |

Against the same-task solo-high medians (62s toolkit, 73s httpkit):

- Sequential delegation: **~3.4x slower** than solo.
- Parallel delegation: **~2.4x slower** than solo, and **~1.4x faster than
  sequential** on the same task.

### Variance worth noting

`solo-xhigh` on `parallel-httpkit` took 90s and 386s on its two repetitions. A
single arm varying 4x across two runs is a reminder that n=2 medians are weak
evidence. `solo-high` was the most consistent arm (58s / 60s / 65s / 85s).

---

## Parallel suite, mandated delegation — measured

`2026-08-14T13-14-10-688Z.parallel.json` · 2 tasks × 2 arms × 2 reps = 8 runs.

Because the supervisor kept declining to delegate above, these arms instruct it
that it **must** call `delegate_tasks` and implement nothing itself. All 8 runs
delegated three workers, so this is the clean like-for-like comparison of the two
delegation modes.

| Arm                                   | Passed | Delegated | Median wall-clock | Median output tokens | Median workers |
| ------------------------------------- | ------ | --------- | ----------------- | -------------------- | -------------- |
| Sol high + sequential Luna (mandated) | 4/4    | 4/4       | 248s              | 7,802                | 3              |
| Sol high + parallel Luna (mandated)   | 4/4    | 4/4       | **155s**          | 9,001                | 3              |

Per task, against the solo-high medians from the run above:

| Task             | Sequential | Parallel | Solo (high) |
| ---------------- | ---------- | -------- | ----------- |
| parallel-toolkit | 225s       | **164s** | 62s         |
| parallel-httpkit | 402s       | **144s** | 73s         |

Every individual run: sequential 257s / 193s / 239s / 565s; parallel
144s / 183s / 166s / 122s.

**Parallel was faster than sequential in every task, in both repetitions.** It is
also markedly more consistent — sequential spanned 193–565s, parallel 122–183s.
Sequential runs the same three workers one after another, so its total is the sum
of three worker times plus overhead, and a single slow worker moves the whole run.

Worker effort across 24 delegated tasks in this run: `high` ×17, `medium` ×4,
`xhigh` ×3. `max` was never selected anywhere in the parallel suite.

No integration conflicts occurred in any parallel run: the supervisor produced
disjoint scopes every time, and every batch merged cleanly.

---

## Scale suite — measured

**What this suite is for: testing whether orchestration becomes competitive with
a supervisor working alone in a larger measured regime.** The earlier suites
answered a narrower question and did not approach break-even. These fixtures are
roughly twice as deep per module and vary the number of independent workstreams,
which the earlier data suggested was an axis worth testing.

`2026-08-14T17-*.scale.json` and `2026-08-14T18-*.scale.json` · 19 runs ·
`gpt-5.6-sol` at high effort · Node v26.7.0 on win32 x64 ·
orchestrator v0.5.1 installed from npm.

### Design, fixed before running

Sizing came from the parallel suite's own numbers, not from guesswork.
Decomposing its mandated-parallel runs into "slowest worker" and "everything
else" gave a near-constant orchestration overhead of 65s, a Luna worker at 62s
per small module, and Sol at 21s per small module. Modelling a run of N
independent modules as `solo ≈ N × 21` against `parallel ≈ 62 + 65` predicted a
crossover near six streams. **That prediction turned out to be wrong, for
reasons the results make clear.**

| Tier    | Fixture         | Streams | Shape                                                                        |
| ------- | --------------- | ------- | ---------------------------------------------------------------------------- |
| B       | `scale-svckit`  | 4       | JSON Pointer, LRU+TTL cache, backoff/retry, semver                           |
| C       | `scale-datakit` | 6       | CSV, query strings, LCS diff, token bucket, glob, intervals                  |
| coupled | `scale-coupled` | 1       | One expression evaluator: tokenizer, parser and evaluator with no fixed seam |

Arms: `solo-high` (delegation disabled at the config level), `adaptive` (tools
available, guidance neither mandates nor forbids their use), `par-forced`
(delegation mandated). `seq-forced` was not re-run — the parallel suite already
established that parallel beats sequential once delegating.

**Stopping rule, written down before results were read:** two repetitions per
cell; stop at two when the two arms' medians differ by more than 40%, since a
third cannot change the direction; add a third only when they are within 25%,
and add it to both arms rather than one. Every tier hit the >40% condition, so
every cell has exactly two repetitions. Tier D was defined as conditional on
tier C sitting just below the crossover; it did not, so it was not run.

**Concurrency.** Orchestrated arms were given `SOL_LUNA_MAX_PARALLEL` equal to
the fixture's stream count (4 and 6), above the shipped default of 3, so that
stream count rather than the default cap was the variable under test. The value
is recorded per run as `maxParallelConfigured`. The solo arms have no workers
and are unaffected.

### Results

| Fixture       | Streams | Arm        | Runs | Passed | Median wall-clock | Range    | Sol tokens | Luna tokens | Total known | Peak concurrency |
| ------------- | ------- | ---------- | ---- | ------ | ----------------- | -------- | ---------- | ----------- | ----------- | ---------------- |
| scale-svckit  | 4       | solo-high  | 2    | 2/2    | **171.5s**        | 163–180s | 192,219    | 0           | 192,219     | n/a              |
| scale-svckit  | 4       | adaptive   | 2    | 2/2    | **120s**          | 116–124s | 295,129    | 0           | 295,129     | n/a              |
| scale-svckit  | 4       | par-forced | 3    | 3/3    | 250s              | 234–273s | 333,778    | 632,134     | 986,741     | 4                |
| scale-datakit | 6       | solo-high  | 2    | 2/2    | **189.5s**        | 177–202s | 243,388    | 0           | 243,388     | n/a              |
| scale-datakit | 6       | adaptive   | 2    | 2/2    | **186.5s**        | 184–189s | 404,697    | 0           | 404,697     | n/a              |
| scale-datakit | 6       | par-forced | 2    | 2/2    | 394.5s            | 388–401s | 243,541    | 922,626     | 1,166,167   | 6                |
| scale-coupled | 1       | solo-high  | 2    | 2/2    | 113.5s            | 110–117s | 126,579    | 0           | 126,579     | n/a              |
| scale-coupled | 1       | adaptive   | 2    | 2/2    | **87.5s**         | 77–98s   | 90,748     | 0           | 90,748      | n/a              |
| scale-coupled | 1       | par-forced | 2    | 2/2    | 347s              | 240–454s | 141,061    | 73,501      | 214,561     | 1                |

Every arm passed every run: 19/19. The `par-forced` row for `scale-svckit` has
three runs because a pilot run of that exact cell was made first to prove the
harness plumbing, and it is reported rather than discarded.

There was **no token crossover**. Against `solo-high`, `par-forced` used about
5.1× the known tokens on Tier B and 4.8× on Tier C. The ratios were not uniform:
`adaptive` used about 1.5× and 1.7× on those tiers, while the coupled fixture was
about 1.7× for `par-forced` and 0.7× for `adaptive`.

### Crossover verdict

| Fixture       | Streams | Solo median | Forced-parallel median | Delta     | Latency crossover | Token crossover |
| ------------- | ------- | ----------- | ---------------------- | --------- | ----------------- | --------------- |
| scale-svckit  | 4       | 171.5s      | 250s                   | **+46%**  | NO                | NO              |
| scale-datakit | 6       | 189.5s      | 394.5s                 | **+108%** | NO                | NO              |
| scale-coupled | 1       | 113.5s      | 347s                   | **+206%** | NO                | NO              |

**No latency crossover, and no token crossover, at any size tested.** Going from
four streams to six moved orchestration _further_ from the baseline, not closer.

### Where the time went

Measured from event timestamps, not added instrumentation. Median across the six
orchestrated scale runs:

| Phase                          | Median    |
| ------------------------------ | --------- |
| Supervisor before the batch    | 37.1s     |
| Worktree setup                 | 0.8s      |
| Slowest worker                 | 187.1s    |
| Integration                    | 0.4s      |
| Supervisor review after        | 32.4s     |
| **Total minus slowest worker** | **70.9s** |

Two things follow. **The mechanical orchestration cost is negligible** — worktree
creation and integration together are ~1.2s, so the serialized worktree setup
introduced in 0.5.1 costs nothing measurable. Essentially all fixed overhead is
the supervisor: ~37s writing contracts and ~32s reviewing results.

**The observed critical path runs through the slowest worker.** Parallel
wall-clock is `slowest worker + ~70s` in these runs, making the slow-worker tail
a strong candidate for the dominant remaining parallel-latency constraint.

### The straggler effect

| Fixture       | Rep | Total | Worker durations (sorted)      | Median | Max | Max/median |
| ------------- | --- | ----- | ------------------------------ | ------ | --- | ---------- |
| scale-svckit  | p   | 250s  | 112, 133, 136, 179             | 134.5  | 179 | 1.3        |
| scale-svckit  | 1   | 234s  | 61, 67, 115, 164               | 91     | 164 | 1.8        |
| scale-svckit  | 2   | 273s  | 99, 117, 147, 196              | 132    | 196 | 1.5        |
| scale-datakit | 1   | 401s  | 81, 83, 94, 95, **181, 333**   | 94.5   | 333 | **3.5**    |
| scale-datakit | 2   | 388s  | 52, 79, 108, 122, **229, 315** | 115    | 315 | **2.7**    |

The observed dispersion widens with worker count: median max/median ratio is 1.5
at four workers and 3.1 at six. That is consistent with the expected shape of a
maximum over more draws, and helps explain why adding streams hurt in these
runs. Solo cost grew sublinearly (171.5s at four modules, 189.5s at six), while
parallel cost followed the slowest worker. Two Tier C repetitions are not enough
to characterize the tail distribution.

> **Counterfactual, clearly labelled as such.** Had every worker in the six-stream
> runs finished at that run's _median_ worker time, parallel would have completed
> in about 163s and 188s — median ~176s, against a solo median of 189.5s. That is
> faster than the solo median. It did not happen, and this is arithmetic on
> measured numbers rather than an observed result. It suggests that the
> slow-worker tail may dominate the remaining parallel-latency gap on this
> fixture; it does not establish a crossover or identify a sole blocker.

### The coupled control

Work with no natural seam behaved as the control predicted it would, and worse
than the tiers above:

- **Free choice declined to delegate, both times**, and was the fastest arm on
  this fixture (87.5s median against 113.5s for mandated-solo).
- **Mandated delegation cost 3.1× solo** (347s vs 113.5s). In one repetition the
  supervisor emitted **no delegation events at all** despite being told it must
  delegate; in the other it delegated the whole module to a single worker at
  `xhigh`. Neither is a decomposition, because the fixture does not admit one:
  any split of a tokenizer, parser and evaluator would need two workers writing
  the same file, which the orchestrator refuses by design.

### Free-choice behaviour

**0 of 6 free-choice runs delegated** — at one, four and six streams alike. In
every case the free-choice arm passed, and on two of the three fixtures it was
the fastest arm measured:

| Fixture       | Free choice | Mandated solo | Mandated parallel |
| ------------- | ----------- | ------------- | ----------------- |
| scale-svckit  | **120s**    | 171.5s        | 250s              |
| scale-datakit | 186.5s      | 189.5s        | 394.5s            |
| scale-coupled | **87.5s**   | 113.5s        | 347s              |

Sol chose zero workers in all six measured free-choice runs, while forced
delegation was slower on the corresponding fixtures. None of these workloads
provided evidence that declining delegation was the wrong choice; the runs do
not establish why Sol made each decision.

### Reliability

Across the 17 runs in the parallel and scale suites that actually delegated,
including five runs with four or six concurrent workers:

- integration conflicts: **0**
- worker failures: **0**
- verification failures: **0**
- verification refusals: **0**
- runs with an agent error: **0**
- worktree metadata races: **0** (the 0.5.1 fix held under 4- and 6-way
  concurrent batches)

Worker effort across the whole scale suite: `high` ×34, `xhigh` ×16, `medium` ×8,
`max` ×0.

---

## Interpretation

Kept deliberately separate from the numbers above.

**The earlier parallel suite exercised parallelism successfully.** In its five
batches that actually used parallel mode, 15 workers ran in isolated worktrees,
chose efforts independently, produced zero integration conflicts, and merged
cleanly every time.

**Parallel clearly beats sequential once you are delegating.** ~1.6x faster at the
median, faster in every single task-repetition pair, and much tighter spread. That
is the expected shape: sequential pays the sum of three worker times, so one slow
worker drags the whole run (the 565s outlier), while parallel pays roughly the
slowest worker plus overhead.

**Neither beat a strong supervisor working alone on these fixtures.** Parallel was
still ~2.3x solo. The reason is visible in the data: each module here is 15–30
lines against a fixed test file. Splitting that costs a contract per task, a
thread spin-up per worker, a verification pass per worker and an integration step
— overhead the modules are too small to amortise.

**Free-choice runs often used zero workers.** On the earlier parallel fixtures,
Sol declined delegation in 5 of 8 runs; on the scale fixtures, it declined in all
six. Forced delegation was slower on the corresponding measured fixtures, so
none of these workloads provided evidence that declining delegation was the
wrong choice. These stochastic runs do not prove why Sol made each decision.

**Where this leaves the break-even point.** The data does not support a numeric
threshold, and inventing one would be dishonest. What it supports is a qualitative
rule, which is what the README and `SOL_RULES.md` state:

- Tiny or single-file work → do it yourself.
- Substantial bounded work where declared worker scope, post-execution
  scope-violation detection, and independent verification matter → delegate one
  task, accepting that it costs time.
- Several genuinely independent, substantial workstreams → parallel, because
  parallel is reliably faster than sequential when delegating at all.

The parallel suite alone cannot establish whether a latency crossover exists
beyond its measured fixtures.

**The scale suite went looking for that answer and did not find it either**, which
changes the shape of the conclusion rather than merely extending it:

- In V6, moving from four to six independent streams did not improve
  forced-parallel relative performance. No latency crossover was observed in the
  tested regime; substantially different or larger workloads remain unmeasured.
- The slow-worker tail is a strong candidate for the dominant remaining
  parallel-latency constraint. The six-stream counterfactual would beat the
  baseline if every worker matched its run's median, but that is not an observed
  crossover and does not identify a sole blocker.
- This raises a specific open question alongside workload sizing: **can the
  slowest worker be bounded?** It is a scheduling question worth measuring, and
  it is what the roadmap now names.

---

## Method

```bash
npm run bench:validate                  # no model calls, proves fixtures discriminate
npm run bench -- --suite micro --reps 2
npm run bench -- --suite parallel --reps 2
npm run bench -- --suite scale --reps 2  # tiers B, C and the coupled control
npm run bench:report                     # summarise one results file
npm run bench:analyze                    # crossover verdict across every results file
```

The three `npm run bench -- --suite ...` commands above invoke live Codex turns.
`bench:validate`, `bench:report`, and `bench:analyze` are deterministic and make
no model calls.

- **Same fixtures per arm.** Each run starts from a freshly materialised temp
  workspace; parallel fixtures are `git init`-ed and committed so worktrees have a
  base.
- **Solo arms genuinely cannot delegate.** They run with
  `mcp_servers.<name>.enabled=false`, not merely instructed to abstain.
- **Grading is done by the harness after the agent stops.** Checks must exit 0 and
  files marked immutable must be byte-identical (SHA-256). The agent never grades
  itself.
- **`bench:validate`** proves each fixture fails in its starting state and passes
  with a committed reference solution, so a green score cannot come from a broken
  grader.
- **Delegating arms wait under one fixed protocol.** `gpt-5.6-sol` is
  `tool_mode: "code_mode_only"` in Codex's model catalog, so an MCP tool is only
  reachable from inside a `functions.exec` code cell. A cell still running when
  its `yield_time_ms` elapses yields, and resuming it costs a model-visible
  `wait` turn — with the whole transcript as input. Left to the supervisor, that
  interval is arbitrary: a width-6 run polled 4 times at 55,000 ms and a
  width-12 run 34 times at mostly 10,000 ms, which moved parent input by 4.5x on
  a 1.6x change in the result being read. Every delegating arm is now given one
  interval and one output budget, told to do nothing else until the call returns,
  and checked against the Codex rollout afterwards. See
  `src/bench/parent-wait.ts`.
- **Two verdicts per run, flagged and never adjusted.**
  `comparability.waitProtocolCompliant` says the supervisor did what the protocol
  asked. `comparability.parentCostComparable` additionally requires that **no
  `wait` turn happened at all** — the reference behaviour is one blocking call
  and one complete result with no supervisor inference in between, so even a
  compliant poll forced by a clamped yield is cost a directly exposed tool would
  not have produced. It also requires exactly one `delegate_tasks` call,
  `resultDetail: "compact"`, the canonical result consumed exactly once, full
  ingestion proven against what the server returned, and the canonical protocol
  in force. Both verdicts carry the observed numbers, and no token count is ever
  netted off to compensate.
- **The protocol numbers are part of the study's definition.**
  `BENCH_WAIT_YIELD_MS` and `BENCH_WAIT_OUTPUT_TOKENS` exist to probe the
  mechanism — to find a clamp, or to reproduce the old polling deliberately. The
  effective values are recorded per results file and per run, and a run made
  under an override is marked `canonicalProtocol: false` and is never parent-cost
  comparable with the study, however well it complied.

## What was measured, and what was not

**Measured directly**

- Wall-clock per run, around the whole supervisor turn — so it includes
  delegation, worktree setup, verification and integration overhead.
- Supervisor tokens from the Codex SDK's `turn.completed` event.
- Worker efforts, worker counts, and current input, cached-input, output, and
  reasoning usage from the orchestrator's own telemetry. Batch records before
  v0.4.0 captured worker output only; missing historical fields remain unknown.
- Pass/fail, file immutability and mutation detection, by the harness.
- **How the parent waited**, from the Codex rollout of its own turn: the
  delegating cell's `yield_time_ms` and output budget, every `wait` and its
  numbers, anything else the supervisor did while the batch was outstanding, and
  the characters it actually ingested against the characters the server returned.
- **Parent cost split three ways**, per delegated run: worker latency (time the
  parent was blocked inside the delegation call), supervisor active reasoning
  (time and tokens on inferences that were not polls), and host waiting overhead
  (the poll turns — their seconds and their input tokens). The buckets sum to the
  totals; the totals are still reported as the run's cost.

**Not measurable from this integration**

- **A wait that costs the parent nothing.** The Codex SDK writes the prompt to
  `codex exec` and reads events back; it has no channel through which a host
  could answer a `wait` on the model's behalf, and there is no CLI setting for
  the cell's default yield. The waiting protocol is therefore an instruction plus
  a check, not an enforced mechanism.

- **Cost in currency.** The API exposes token counts, not prices, and the arms use
  different models at different efforts. No cost figure is given; do not derive
  one from the token counts.
- **Billing treatment of cached input tokens**, a large share of the input totals.
- **Quality beyond the objective checks.** Every arm scored 100%, so this suite
  cannot separate them on quality at all.

## Limitations

- Two tasks and two repetitions per cell in the parallel suite; four and two in
  the micro suite; three fixtures and two repetitions per cell in the scale suite.
  Directional, not statistically significant — and one arm showed 4x variance
  across two runs.
- **Two Tier C repetitions cannot characterise the worker-latency tail
  distribution.** Both six-worker runs had a long tail, but its frequency and
  magnitude cannot be estimated from these samples.
- Fixtures are bounded by construction, because they must grade deterministically
  and re-run cheaply. The scale suite pushed depth and stream count up but stays
  within work a single supervisor session can hold, which biases every suite
  against delegation.
- Single machine, single platform, with normal network variance. Wall-clock
  includes model latency, which is not under this project's control.
- No adversarial tasks: no worker produced a false `PASS`, so the claim-checking
  machinery is exercised by unit tests rather than by this benchmark.
- The counterfactual in the scale suite is arithmetic on measured worker times,
  not an observed run. It bounds where the obstacle lies; it does not demonstrate
  a crossover.
- **Every delegated `Sol tokens` figure in this document predates the waiting
  protocol**, so each includes an unrecorded number of poll turns. Those runs
  cannot be compared with each other or with later ones on parent cost, and the
  token ratios quoted for the parallel and scale suites (`5.1x`, `4.8x`, and the
  rest) are ratios of totals that include it. Wall-clock, pass/fail, worker
  counts, worker durations and peak concurrency are unaffected: the polling
  happened while the workers were already running. Delegated parent cost needs
  re-measuring under the protocol before any token claim about it is repeated.
- **The protocol removes the supervisor's choice of interval, not its ability to
  ignore the instruction, and not Codex's ability to clamp the yield.** A run
  that ignores it is recorded as off-protocol rather than silently averaged in,
  and the compliance rate is worth watching: the mandated yield deliberately
  contradicts Codex's own advice to avoid blocking for more than 60 seconds,
  which is the advice that produced the 55,000 ms polls. **If the yield turns out
  to be clamped, delegated parent cost is not measurable under this integration
  at all** — every run would carry at least one poll turn, and every run would
  therefore be reported and not compared. That would be a finding about the
  runtime, not a reason to loosen the rule.
- **What a directly exposed tool would have cost is not measured here.** Every
  arm reaches the tool through a code cell, because the supervisor model supports
  no other tool surface. The protocol reproduces a blocking host's _shape_ — one
  call, one result, nothing in between — not a run made against one.
