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
- A delegation call counts as an opened worker batch only when its batch identity
  published `batch.started` and did not publish `batch.rejected`. The runtime opens a
  batch identity before its pre-execution gates run, so a refused call emits
  `batch.started` with zero worker attempts; it belongs in `delegationCallsRefused`,
  contributes no mode, no queued worker effort, and no phase boundary.
- Benchmark subprocesses resolve executables through the production resolver in
  `src/executable.ts` — `PATH` only, current directory never searched. Do not relax the
  production resolver to suit the benchmark, and do not hand a launcher a bare name.
- `RECORDED_ENVIRONMENT_KEYS` is the maintained inventory of repository-owned
  execution settings; anything deliberately left out goes in
  `EXCLUDED_ENVIRONMENT_KEYS` with the argument that it cannot affect a measured run.
  A deterministic syntactic test scans the explicit direct `process.env` forms it
  supports. Treat it as defense in depth, never as proof of every possible repository,
  SDK, CLI, Node, or OS environment read. Record names, never credentials: a listed
  key's value is committed verbatim.
- The ambient layer inventories every inherited variable _name_ and records a value only
  under an explicit classification: safe scalars verbatim, URLs as scheme/host/port with
  an embedded-credential flag, and explicitly safe trust-material variables as
  presence/readability/type plus a content digest where safe. Persist no trust path,
  basename, or path hash. Everything else, credential-shaped names included, is
  present-and-opaque. Never add a
  raw-value classification for a name whose value could be credential material, and never
  serialize a secret, a digest of a secret, or proxy userinfo.
- Codex configuration is structurally parsed and recursively sanitized before
  canonicalization or hashing. Redact any credential-, secret-, auth-, token-, password-,
  cookie-, bearer-, key-, or header-sensitive path, including nested/inline/array/multiline
  values; never record raw config length. `auth.json` contributes a presence marker and a
  mode; nothing else from it may reach a record.
- `REPRODUCIBILITY_BOUNDARY` is the single place the capture claim is stated. Keep it
  accurate: if a layer stops establishing something, the boundary changes with it.
- `BENCHMARK_V3_FREEZE_SHA` and `BENCHMARK_V3_PRODUCTION_BASELINE_SHA` answer different
  questions — which methodology was reviewed, and which released product is under
  evaluation. Never point one at the other.
- A V3 campaign launches the orchestrator from the verified baseline artifact in
  `bench/baseline/v0.11.0`, passing its absolute entry point as the Codex `mcp_servers`
  command. Its commit/tree and frozen byte-manifest digest are distinct identities. Every
  Adaptive cell must match the frozen manifest immediately before launch and after
  completion before a result is accepted. Do not make a V3 arm depend on the operator's
  MCP registration, and do not relax the fail-closed checks.
- The pre-launch checkpoint derives execution history from `bench/results/`. Never
  hard-code a run count, a campaign-collision flag, or a fresh-launch claim, and never
  count V2 or older-suite files as V3 history. Only the live runner may create a V3 launch
  marker, immediately before its first SDK call; malformed shards, invalid markers, and
  ambiguous non-empty streams block freshness.
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
