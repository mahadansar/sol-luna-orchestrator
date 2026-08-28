# Benchmark harness and fixture instructions

This directory contains the executable benchmark harness, inlined fixtures, graders,
reference solutions, reports, and cross-run analysis. It is research infrastructure,
not production orchestration behavior.

## Experimental integrity

- Every run materializes a fresh temporary workspace. Keep fixtures self-contained,
  deterministic, offline, and free of sleeps, padding, subjective grading, and leftovers
  from previous runs.
- The harness grades after the agent stops. Never use an agent's self-report as the
  score. A grading command must exit zero, and immutable specification files must remain
  byte-identical.
- All arms receive the same fixture and objective. V2 fixes GPT-5.6 Sol at Medium;
  differences belong only in delegation availability/policy. Solo arms must
  disable the orchestrator at the Codex config level, not merely ask the model not to
  delegate.
- Keep negative results. Do not tune fixtures, production defaults, prompts, stopping
  rules, or concurrency after seeing outcomes to make delegation look better.
- Configured maximum parallelism matches the V2 fixture's declared natural stream count
  and is recorded. Do not change the shipped concurrency default to improve a result.
- V3 configures no orchestrator policy at all and measures the shipped defaults.
  It deliberately does not pass `SOL_LUNA_MAX_PARALLEL`, because a V3 fixture's
  stream count is derived from the same structure as its evaluator-only routing
  category. `resolveWorkerConcurrency` owns this rule; a deterministic test proves
  no V3 task can produce a per-task value.
- No harness control flow may key on a task identity: no per-task prompt, guidance,
  timeout, grading tolerance, routing hint, or special case.
- Missing measurements are `null`/unknown, never zero. V2 may calculate credits only
  from its embedded official rate-card snapshot and complete usage; calculated
  `rateCardCredits` must never be labelled actual billing.

## Fixture changes

- `v2-tasks.ts` and `v2-solutions.ts` preserve the frozen historical
  architecture suite. `v3-tasks.ts` defines the fresh nine-task routing holdout
  and `v3-solutions.ts` its hidden references. Older fixture files remain for
  historical validation only.
- Keep each fixture's tests/specification immutable and include at least one grading
  command. Scale fixture metadata, objective, module list, stream count, and reference
  solution must agree.
- Add or update the matching suite reference solution. Reference solutions exist only to
  validate graders and must never
  be shown to the model.
- Run `npm run bench:validate` after fixture or grader changes; use
  `npm run bench:v3:validate` for the isolated V3 gate. Validation must prove that every
  starting state fails, every reference solution passes, and mutation detection works.
  Run `npm test` as well; `src/bench.test.ts` pins harness and fixture invariants and
  `src/bench/harness.test.ts` pins the acceptance rules — reproducibility evidence,
  ordering, exclusion and retry treatment, the frozen methodology digest, the harness
  configuration boundary, and metric folding.
- `bench/V3_METHODOLOGY.md` is content-addressed. Editing it changes its digest and a
  V3 launch will refuse until `V3_METHODOLOGY_DIGEST` in `src/bench/integrity.ts` is
  updated through the document's own correction/freeze-review policy. That refusal is
  the point: do not silence it to get a campaign started.

## Running and reporting

`npm run bench` invokes live Codex turns and can consume quota or billing; do not run it
casually. `bench:validate`, `bench:report`, and `bench:analyze` are deterministic and
make no model calls. The report script summarizes raw measurements without adding human
interpretation. Human interpretation and limitations belong in `bench/RESULTS.md` and
must remain traceable to committed records under `bench/results/`.
