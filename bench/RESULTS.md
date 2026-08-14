# Benchmark results

Two suites, both graded by the harness after the agent stops — never by the agent.

- **Micro** — four small single-file tasks. Tests whether delegation is worth it
  at small scale.
- **Parallel** — two projects, each with three independent modules specified by
  their own test files. Tests whether orchestration pays off when there is real,
  separable work.

Everything below separates **measured** from **interpretation**. Raw records are
in `bench/results/*.json`.

---

## Headline

1. **On small tasks, delegating is worse.** ~2.3x slower, ~3.5x the tokens, no
   quality difference. Unchanged from the previous release, and still the single
   most useful thing this project has measured.
2. **On three-module projects, parallel delegation beat sequential delegation in
   every task and every repetition** — median 155s vs 248s, and far more
   consistent (122–183s vs 193–565s).
3. **Neither beat a strong supervisor working alone** on fixtures this size:
   solo-high was ~63s.
4. **Left to its own judgement, the supervisor usually declines to delegate these
   tasks at all**, which is the policy working as intended.
5. **No arm ever failed.** Quality was identical everywhere: 24/24 runs passed.

---

## Micro suite — measured

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
`xhigh` ×3. `max` was never selected, in any run of either suite.

No integration conflicts occurred in any parallel run: the supervisor produced
disjoint scopes every time, and every batch merged cleanly.

---

## Interpretation

Kept deliberately separate from the numbers above.

**Parallelism works, and it does what it is supposed to do.** In 12 delegated
parallel runs, three workers ran concurrently in three isolated worktrees, chose
efforts independently, produced zero integration conflicts, and merged cleanly
every time. The mechanism is sound.

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

**The supervisor's own judgement was right.** Given the choice, it mostly refused
to delegate these tasks, and the runs where it refused were the fastest
delegating-arm runs. That is the `delegate_task` policy text working: it was told
that delegation has a fixed cost and that small work should be done directly, and
it applied that to a task the benchmark was nudging it to delegate.

**Where this leaves the break-even point.** The data does not support a numeric
threshold, and inventing one would be dishonest. What it supports is a qualitative
rule, which is what the README and `SOL_RULES.md` state:

- Tiny or single-file work → do it yourself.
- Substantial bounded work where an enforced scope and independent verification
  matter → delegate one task, accepting that it costs time.
- Several genuinely independent, substantial workstreams → parallel, because
  parallel is reliably faster than sequential when delegating at all.

The suite cannot answer "how big must a module be before parallel beats solo?"
because every fixture here is below that size. Finding it would need fixtures
large enough that a single supervisor session starts to struggle — which is also
the regime where a deterministic grader becomes hard to write. That is honest
future work, not a claim.

---

## Method

```bash
npm run bench:validate                  # no model calls
npm run bench -- --suite micro --reps 2
npm run bench -- --suite parallel --reps 2
npm run bench:report
```

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

## What was measured, and what was not

**Measured directly**

- Wall-clock per run, around the whole supervisor turn — so it includes
  delegation, worktree setup, verification and integration overhead.
- Supervisor tokens from the Codex SDK's `turn.completed` event.
- Worker efforts and worker counts from the orchestrator's own telemetry.
- Pass/fail, file immutability and mutation detection, by the harness.

**Not measurable from this integration**

- **Cost in currency.** The API exposes token counts, not prices, and the arms use
  different models at different efforts. No cost figure is given; do not derive
  one from the token counts.
- **Worker input tokens in batch runs.** Single delegations record full usage;
  batch workers currently record output tokens only, so the input-token column
  understates the delegating arms. Reported as measured rather than estimated.
- **Billing treatment of cached input tokens**, a large share of the input totals.
- **Quality beyond the objective checks.** Every arm scored 100%, so this suite
  cannot separate them on quality at all.

## Limitations

- Two tasks and two repetitions per cell in the parallel suite; four and two in
  the micro suite. Directional, not statistically significant — and one arm showed
  4x variance across two runs.
- Fixtures are small by construction, because they must grade deterministically
  and re-run cheaply. That biases both suites against delegation.
- Single machine, single platform, with normal network variance.
- No adversarial tasks: no worker produced a false `PASS`, so the claim-checking
  machinery is exercised by unit tests rather than by this benchmark.
