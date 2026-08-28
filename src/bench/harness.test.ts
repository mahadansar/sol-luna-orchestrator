/**
 * Acceptance-harness tests.
 *
 * These cover the rules that decide what a Benchmark V3 result is allowed to
 * mean: reproducibility evidence, execution ordering, exclusion and retry
 * treatment, the frozen methodology gate, the configuration the harness may
 * give the orchestrator, and the metrics folded from telemetry. All offline:
 * no model calls, no benchmark execution.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EFFORTS } from "../config.js";
import { groupCells } from "./analysis.js";
import type { CampaignCell } from "./campaign.js";
import {
  assertEnvironmentEvidence,
  buildEnvironmentRecord,
  missingEnvironmentEvidence,
  RECORDED_ENVIRONMENT_KEYS,
  type EnvironmentProbe,
  type EnvironmentRecord,
} from "./environment.js";
import {
  assertMethodologyFrozen,
  CAMPAIGN_RETRY_POLICY,
  classifyRunValidity,
  methodologyDigest,
  resolveWorkerConcurrency,
  V3_METHODOLOGY_DIGEST,
  V3_METHODOLOGY_PATH,
} from "./integrity.js";
import {
  BENCHMARK_EFFORT_LADDER,
  foldContextMetrics,
  foldOrchestrationMetrics,
} from "./metrics.js";
import {
  assertOrderingCompatibility,
  assertOrderingSeed,
  orderCampaignCells,
} from "./ordering.js";
import { renderReport } from "./report.js";
import { buildResultsSnapshot, type RunRecord } from "./run.js";
import { V3_TASKS } from "./v3-tasks.js";

// --- Reproducibility evidence ----------------------------------------------

const probe = (overrides: Partial<EnvironmentProbe> = {}): EnvironmentProbe => ({
  capturedAt: "2026-08-29T00:00:00.000Z",
  gitCommit: "a".repeat(40),
  gitBranch: "main",
  gitStatusPorcelain: "",
  gitDescribe: "v0.10.0",
  nodeVersion: "v22.12.0",
  npmVersion: "11.12.1",
  codexCliVersion: "codex-cli 0.149.1",
  codexSdkVersion: "0.147.0",
  packageVersion: "0.10.0",
  platform: "win32",
  arch: "x64",
  osRelease: "10.0.26200",
  cpuCount: 16,
  totalMemoryBytes: 34_359_738_368,
  timezone: "UTC",
  argv: ["--suite", "v3"],
  cwd: "D:\\repo",
  environment: {},
  ...overrides,
});

test("a captured environment records facts and keeps unread values unknown", () => {
  const record = buildEnvironmentRecord(
    probe({
      gitDescribe: null,
      npmVersion: "  ",
      codexCliVersion: null,
      cpuCount: -1,
    }),
  );
  assert.equal(record.git.commit, "a".repeat(40));
  assert.equal(record.git.branch, "main");
  assert.equal(record.git.workingTreeClean, true);
  assert.equal(record.git.dirtyPathCount, 0);
  assert.equal(record.git.describe, null);
  // Blank and nonsensical readings become unknown rather than empty or zero.
  assert.equal(record.toolchain.npmVersion, null);
  assert.equal(record.toolchain.codexCliVersion, null);
  assert.equal(record.runtime.cpuCount, null);
  assert.deepEqual(record.invocation.argv, ["--suite", "v3"]);
});

test("an unreadable git status stays unknown instead of claiming a clean tree", () => {
  const record = buildEnvironmentRecord(probe({ gitStatusPorcelain: null }));
  assert.equal(record.git.workingTreeClean, null);
  assert.equal(record.git.dirtyPathCount, null);
  assert.deepEqual(missingEnvironmentEvidence(record), ["git.workingTreeClean"]);
  assert.throws(() => assertEnvironmentEvidence(record), /git\.workingTreeClean/);
});

test("a dirty working tree is counted and refused for a holdout launch", () => {
  const record = buildEnvironmentRecord(
    probe({ gitStatusPorcelain: " M src/a.ts\n?? note.txt\n" }),
  );
  assert.equal(record.git.workingTreeClean, false);
  assert.equal(record.git.dirtyPathCount, 2);
  assert.deepEqual(missingEnvironmentEvidence(record), []);
  assert.doesNotThrow(() => assertEnvironmentEvidence(record));
  assert.throws(
    () => assertEnvironmentEvidence(record, { requireCleanWorkingTree: true }),
    /clean working tree/,
  );
});

test("only allowlisted environment overrides reach the committed record", () => {
  const record = buildEnvironmentRecord(
    probe({
      environment: {
        SOL_LUNA_MAX_PARALLEL: "6",
        SOL_LUNA_SERVER_NAME: "",
        // Not on the allowlist; a benchmark record must not publish it.
        OPENAI_API_KEY: "sk-secret",
      } as EnvironmentProbe["environment"],
    }),
  );
  assert.deepEqual(record.environment, { SOL_LUNA_MAX_PARALLEL: "6" });
  assert.ok(!Object.keys(record.environment).includes("OPENAI_API_KEY"));
  assert.ok(!(RECORDED_ENVIRONMENT_KEYS as readonly string[]).includes("OPENAI_API_KEY"));
});

// --- Execution ordering -----------------------------------------------------

const cells = (tasks: readonly string[], reps: number): CampaignCell[] => {
  const planned: CampaignCell[] = [];
  for (let repetition = 1; repetition <= reps; repetition += 1) {
    for (const taskId of tasks) {
      for (const arm of ["solo-medium", "adaptive-medium"]) {
        planned.push({ campaignId: "c", taskId, arm, repetition });
      }
    }
  }
  return planned;
};

const NINE = V3_TASKS.map((task) => task.id);

test("declared ordering preserves the frozen fixture order and carries no seed", () => {
  const planned = cells(["b", "a"], 2);
  const { cells: ordered, ordering } = orderCampaignCells(planned, { mode: "declared" });
  assert.deepEqual(ordered, planned);
  assert.equal(ordering.mode, "declared");
  assert.equal(ordering.seed, null);
  assert.equal(ordering.sequence.length, planned.length);
});

test("seeded ordering is reproducible, seed-sensitive, and loses no cell", () => {
  const planned = cells(NINE, 2);
  const first = orderCampaignCells(planned, { mode: "seeded", seed: "v3-launch" });
  const again = orderCampaignCells(planned, { mode: "seeded", seed: "v3-launch" });
  const other = orderCampaignCells(planned, { mode: "seeded", seed: "other" });

  assert.deepEqual(first.ordering.sequence, again.ordering.sequence);
  assert.notDeepEqual(first.ordering.sequence, other.ordering.sequence);
  assert.notDeepEqual(first.ordering.sequence, [
    ...orderCampaignCells(planned, { mode: "declared" }).ordering.sequence,
  ]);
  assert.equal(first.cells.length, planned.length);
  assert.equal(new Set(first.ordering.sequence).size, planned.length);
  assert.deepEqual(
    [...first.cells]
      .sort((a, b) => a.taskId.localeCompare(b.taskId))
      .map((c) => c.taskId),
    [...planned].sort((a, b) => a.taskId.localeCompare(b.taskId)).map((c) => c.taskId),
  );
});

test("seeded ordering keeps repetition blocks whole and varies arm position", () => {
  const planned = cells(NINE, 2);
  const { cells: ordered } = orderCampaignCells(planned, {
    mode: "seeded",
    seed: "v3-launch",
  });
  const repetitions = ordered.map((cell) => cell.repetition);
  // Every repetition-1 cell precedes every repetition-2 cell.
  assert.equal(repetitions.indexOf(2), repetitions.lastIndexOf(1) + 1);

  const firstArmPerTask = new Map<string, string>();
  for (const cell of ordered.filter((cell) => cell.repetition === 1)) {
    if (!firstArmPerTask.has(cell.taskId)) firstArmPerTask.set(cell.taskId, cell.arm);
  }
  // Arm order is drawn per task, so the same arm cannot always run first.
  assert.equal(new Set(firstArmPerTask.values()).size, 2);
});

test("an ordering mode and its seed must agree, and a resume cannot reorder", () => {
  assert.throws(() => assertOrderingSeed("seeded", undefined), /--order-seed/);
  assert.throws(() => assertOrderingSeed("seeded", "   "), /--order-seed/);
  assert.throws(() => assertOrderingSeed("declared", "abc"), /must not carry/);
  assert.equal(assertOrderingSeed("declared", undefined), null);
  assert.equal(assertOrderingSeed("seeded", " abc "), "abc");

  const { ordering } = orderCampaignCells(cells(["a"], 1), {
    mode: "seeded",
    seed: "abc",
  });
  assert.doesNotThrow(() =>
    assertOrderingCompatibility([{ file: "shard.json", ordering }], ordering),
  );
  assert.doesNotThrow(() =>
    assertOrderingCompatibility([{ file: "historical.json" }], ordering),
  );
  assert.throws(
    () =>
      assertOrderingCompatibility([{ file: "shard.json", ordering }], {
        ...ordering,
        seed: "different",
      }),
    /shard\.json was ordered as seeded\/abc/,
  );
});

// --- Frozen methodology gate ------------------------------------------------

test("the methodology digest ignores line endings and its own digest line", () => {
  const body = "# Methodology\n\nArms are fixed.\n";
  const withDigest =
    "# Methodology\r\n\r\n- Methodology content digest: `abc`\r\nArms are fixed.\r\n";
  assert.equal(methodologyDigest(body), methodologyDigest(withDigest));
  assert.notEqual(
    methodologyDigest(body),
    methodologyDigest("# Methodology\n\nArms differ.\n"),
  );
});

test("the committed methodology document matches its recorded freeze digest", () => {
  const file = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    V3_METHODOLOGY_PATH,
  );
  assert.equal(
    assertMethodologyFrozen(fs.readFileSync(file, "utf8")),
    V3_METHODOLOGY_DIGEST,
  );
});

test("a methodology that drifted from its freeze refuses to launch", () => {
  const frozen = "# Methodology\n\nTwo repetitions per cell.\n";
  const digest = methodologyDigest(frozen);
  assert.equal(assertMethodologyFrozen(frozen, digest), digest);
  assert.throws(
    () =>
      assertMethodologyFrozen("# Methodology\n\nThree repetitions per cell.\n", digest),
    /does not match its recorded freeze digest/,
  );
});

// --- Exclusion and retry treatment ------------------------------------------

const validityInput = (
  overrides: Partial<Parameters<typeof classifyRunValidity>[0]> = {},
): Parameters<typeof classifyRunValidity>[0] => ({
  benchmarkVersion: 3,
  delegationEnabled: true,
  grades: [{ exitCode: 0 }],
  terminationReason: "completed",
  telemetryAvailable: true,
  runId: "run-1",
  fixtureRevision: "rev-1",
  ...overrides,
});

test("a complete run with full evidence is valid", () => {
  assert.deepEqual(classifyRunValidity(validityInput()), {
    status: "valid",
    reasons: [],
  });
});

test("a failing, timed-out, or specification-breaking run is a result, not an exclusion", () => {
  // A non-zero grade is a real outcome.
  assert.equal(
    classifyRunValidity(validityInput({ grades: [{ exitCode: 1 }] })).status,
    "valid",
  );
  // The harness time bound is part of the contract, so exhausting it is a failure.
  assert.equal(
    classifyRunValidity(validityInput({ terminationReason: "harness-timeout" })).status,
    "valid",
  );
});

test("missing or untrustworthy evidence quarantines a run", () => {
  assert.deepEqual(
    classifyRunValidity(validityInput({ grades: [{ exitCode: null }] })).reasons,
    ["grader-did-not-execute"],
  );
  assert.deepEqual(classifyRunValidity(validityInput({ grades: [] })).reasons, [
    "grader-did-not-execute",
  ]);
  assert.deepEqual(
    classifyRunValidity(validityInput({ terminationReason: "agent-error" })).reasons,
    ["agent-transport-error"],
  );
  assert.deepEqual(
    classifyRunValidity(validityInput({ telemetryAvailable: false })).reasons,
    ["delegation-telemetry-unavailable"],
  );
  assert.deepEqual(classifyRunValidity(validityInput({ runId: undefined })).reasons, [
    "fixture-identity-missing",
  ]);
  assert.deepEqual(
    classifyRunValidity(validityInput(), { expectedFixtureRevision: "rev-2" }).reasons,
    ["fixture-revision-drift"],
  );
});

test("a solo arm without telemetry is not missing evidence", () => {
  const solo = classifyRunValidity(
    validityInput({ delegationEnabled: false, telemetryAvailable: null }),
  );
  assert.equal(solo.status, "valid");
  // The same absence does count against an arm that had an orchestrator.
  assert.equal(
    classifyRunValidity(validityInput({ telemetryAvailable: false })).status,
    "quarantined",
  );
});

test("V2 records are not judged by V3 fixture-identity rules", () => {
  const historical = classifyRunValidity({
    benchmarkVersion: 2,
    delegationEnabled: true,
    grades: [{ exitCode: 0 }],
    telemetryAvailable: true,
  });
  assert.deepEqual(historical, { status: "valid", reasons: [] });
});

test("failure treatment is fixed before execution and performs no automatic retry", () => {
  assert.equal(CAMPAIGN_RETRY_POLICY.automaticRunRetries, 0);
  assert.equal(CAMPAIGN_RETRY_POLICY.automaticGradingRetries, 0);
  assert.equal(CAMPAIGN_RETRY_POLICY.failedRunsRetained, true);
  assert.equal(CAMPAIGN_RETRY_POLICY.quarantinedRunsRetained, true);
  assert.equal(CAMPAIGN_RETRY_POLICY.completedCellsAreImmutable, true);
  assert.equal(
    CAMPAIGN_RETRY_POLICY.quarantinedCellReexecution,
    "review-approved-new-run-identity",
  );
});

// --- Configuration the harness may give the orchestrator --------------------

test("V3 configures no concurrency and measures the shipped production default", () => {
  for (const task of V3_TASKS) {
    const resolved = resolveWorkerConcurrency({
      suite: "v3",
      delegationEnabled: true,
      streams: task.streams,
    });
    assert.equal(resolved.policy, "production-default");
    assert.equal(resolved.maxParallel, null);
  }
});

test("no V3 task can produce a task-specific harness configuration", () => {
  const configured = new Set(
    V3_TASKS.map(
      (task) =>
        resolveWorkerConcurrency({
          suite: "v3",
          delegationEnabled: true,
          streams: task.streams,
        }).maxParallel,
    ),
  );
  // A stream count correlates with the evaluator-only routing category, so a
  // per-task value would hand the orchestrator the answer V3 is asking for.
  assert.deepEqual([...configured], [null]);
  assert.ok(new Set(V3_TASKS.map((task) => task.streams)).size > 1);
});

test("V2 keeps its historical per-fixture ceiling and solo arms configure nothing", () => {
  assert.deepEqual(
    resolveWorkerConcurrency({ suite: "v2", delegationEnabled: true, streams: 4 }),
    { policy: "fixture-stream-count", maxParallel: 4 },
  );
  assert.deepEqual(
    resolveWorkerConcurrency({ suite: "v2", delegationEnabled: true, streams: 99 }),
    { policy: "fixture-stream-count", maxParallel: 8 },
  );
  assert.deepEqual(
    resolveWorkerConcurrency({ suite: "v2", delegationEnabled: true, streams: null }),
    { policy: "fixture-stream-count", maxParallel: 1 },
  );
  assert.deepEqual(
    resolveWorkerConcurrency({ suite: "v3", delegationEnabled: false, streams: 4 }),
    { policy: "not-applicable", maxParallel: null },
  );
});

// --- Metrics folded from telemetry ------------------------------------------

test("an empty event stream folds to zeros and no invented aggregates", () => {
  const orchestration = foldOrchestrationMetrics([]);
  assert.equal(orchestration.delegationCalls, 0);
  assert.equal(orchestration.attemptsCompleted, 0);
  assert.equal(orchestration.integrationVerification, null);
  const context = foldContextMetrics([]);
  assert.equal(context.evaluations, 0);
  assert.equal(context.maxTotalSizeBytes, null);
  assert.equal(context.reclaimedBytes, null);
});

test("delegation, repair, recovery, continuation, and escalation counts are folded", () => {
  const metrics = foldOrchestrationMetrics([
    { type: "routing.preflight", route: "delegate" },
    { type: "routing.declared", declaration: "attached", mode: "parallel" },
    { type: "routing.declared", declaration: "absent", mode: "single" },
    { type: "batch.started", mode: "parallel", batchId: "b1" },
    { type: "batch.started", mode: "single", batchId: "b2" },
    { type: "explore.started" },
    { type: "explore.rejected" },
    {
      type: "attempt.started",
      executionId: "e1",
      predecessorExecutionId: null,
      model: "gpt-5.6-luna",
      effort: "medium",
    },
    {
      type: "attempt.completed",
      executionId: "e1",
      role: "initial",
      termination: "timed-out",
      usageStatus: "unavailable",
      verificationFailed: 0,
    },
    {
      type: "attempt.started",
      executionId: "e2",
      predecessorExecutionId: "e1",
      model: "gpt-5.6-luna",
      effort: "high",
    },
    {
      type: "attempt.completed",
      executionId: "e2",
      role: "timeout-recovery",
      termination: "completed",
      usageStatus: "reported",
      verificationFailed: 1,
    },
    {
      type: "attempt.started",
      executionId: "e3",
      predecessorExecutionId: "e2",
      model: "gpt-5.6-sol",
      effort: "high",
    },
    {
      type: "attempt.completed",
      executionId: "e3",
      role: "manual-continuation",
      termination: "completed",
      usageStatus: "reported",
      verificationFailed: 0,
    },
    { type: "repair.started" },
    { type: "repair.completed" },
    { type: "recovery.started" },
    { type: "recovery.completed" },
    { type: "recovery.skipped" },
    { type: "scope.conflict" },
    { type: "routing.contradiction" },
    { type: "worktree.created" },
    { type: "worktree.retained" },
    { type: "worker.timedOut" },
    { type: "worker.cancelled" },
    { type: "integration.applied" },
    { type: "integration.conflict" },
    { type: "integration.completed" },
    {
      type: "integration.verification.completed",
      passed: 3,
      failed: 1,
      refused: 0,
    },
  ]);

  assert.equal(metrics.delegationCalls, 2);
  assert.deepEqual(metrics.batchesByMode, { parallel: 1, single: 1 });
  assert.equal(metrics.routingPreflights, 1);
  assert.equal(metrics.routingDeclarationsAttached, 1);
  assert.equal(metrics.routingDeclarationsAbsent, 1);
  assert.equal(metrics.explorations, 1);
  assert.equal(metrics.explorationsRejected, 1);
  assert.equal(metrics.attemptsStarted, 3);
  assert.equal(metrics.attemptsCompleted, 3);
  assert.deepEqual(metrics.attemptsByRole, {
    initial: 1,
    "timeout-recovery": 1,
    "manual-continuation": 1,
  });
  assert.deepEqual(metrics.attemptsByTermination, { "timed-out": 1, completed: 2 });
  assert.equal(metrics.usageUnavailableAttempts, 1);
  // The timed-out attempt and the attempt that left a failing check behind.
  assert.equal(metrics.wastedAttempts, 2);
  assert.equal(metrics.continuations, 1);
  assert.equal(metrics.effortEscalations, 1);
  assert.equal(metrics.executorChanges, 1);
  assert.equal(metrics.repairsStarted, 1);
  assert.equal(metrics.repairsCompleted, 1);
  assert.equal(metrics.recoveriesStarted, 1);
  assert.equal(metrics.recoveriesCompleted, 1);
  assert.equal(metrics.recoveriesSkipped, 1);
  assert.equal(metrics.scopeConflicts, 1);
  assert.equal(metrics.routingContradictions, 1);
  assert.equal(metrics.worktreesCreated, 1);
  assert.equal(metrics.worktreesRetained, 1);
  assert.equal(metrics.workerTimeouts, 1);
  assert.equal(metrics.workerCancellations, 1);
  assert.deepEqual(metrics.integration, {
    applied: 1,
    completed: 1,
    conflicts: 1,
    partial: 0,
    failed: 0,
    notAttempted: 0,
    disabled: 0,
  });
  assert.deepEqual(metrics.integrationVerification, {
    passed: 3,
    failed: 1,
    refused: 0,
  });
});

test("an attempt that keeps its predecessor's compute is not an escalation", () => {
  const metrics = foldOrchestrationMetrics([
    {
      type: "attempt.started",
      executionId: "e1",
      predecessorExecutionId: null,
      model: "gpt-5.6-luna",
      effort: "high",
    },
    {
      type: "attempt.started",
      executionId: "e2",
      predecessorExecutionId: "e1",
      model: "gpt-5.6-luna",
      effort: "high",
    },
    {
      // A lower rung is a de-escalation, which is also not an escalation.
      type: "attempt.started",
      executionId: "e3",
      predecessorExecutionId: "e2",
      model: "gpt-5.6-luna",
      effort: "medium",
    },
  ]);
  assert.equal(metrics.effortEscalations, 0);
  assert.equal(metrics.executorChanges, 0);
});

test("the benchmark effort ladder matches the runtime's own effort levels", () => {
  assert.deepEqual([...BENCHMARK_EFFORT_LADDER], [...EFFORTS]);
});

test("context pressure and compaction behaviour is folded without invention", () => {
  const metrics = foldContextMetrics([
    {
      type: "context.evaluated",
      decision: "noop",
      totalSizeBytes: 1_000,
      totalTurns: 4,
    },
    {
      type: "context.evaluated",
      decision: "trigger",
      totalSizeBytes: 9_000,
      totalTurns: 12,
    },
    {
      type: "context.compacted",
      boundary: "post-delegation",
      sizeDeltaBytes: -4_000,
    },
    {
      type: "context.evaluated",
      decision: "block",
      totalSizeBytes: 5_000,
      totalTurns: 12,
    },
    // A malformed row contributes nothing rather than a zero.
    { type: "context.evaluated", decision: "noop" },
  ]);
  assert.equal(metrics.evaluations, 4);
  assert.equal(metrics.triggers, 1);
  assert.equal(metrics.blocks, 1);
  assert.equal(metrics.noops, 2);
  assert.equal(metrics.compactions, 1);
  assert.equal(metrics.maxTotalSizeBytes, 9_000);
  assert.equal(metrics.lastTotalSizeBytes, 5_000);
  assert.equal(metrics.maxTotalTurns, 12);
  assert.equal(metrics.reclaimedBytes, 4_000);
  assert.deepEqual(metrics.compactionBoundaries, ["post-delegation"]);
});

// --- Snapshot and report integration ---------------------------------------

const environmentRecord = (
  overrides: Partial<EnvironmentProbe> = {},
): EnvironmentRecord => buildEnvironmentRecord(probe(overrides));

const runRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  benchmarkVersion: 3,
  suite: "v3",
  taskId: "v3-csv-dialect",
  taskCategory: "small",
  workloadClass: "obvious-solo",
  routingCategory: "expected-solo",
  runId: "run-1",
  fixtureRevision: "rev-1",
  tier: "A",
  streams: 1,
  maxParallelConfigured: null,
  concurrencyPolicy: "production-default",
  arm: "solo-medium",
  armLabel: "Solo Medium",
  delegationEnabled: false,
  supervisorEffort: "medium",
  repetition: 1,
  startedAt: "2026-08-29T00:00:00.000Z",
  durationSeconds: 100,
  terminationReason: "completed",
  telemetryAvailable: null,
  passed: true,
  grades: [{ label: "test", exitCode: 0, passed: true, output: "" }],
  immutableViolations: [],
  mutationCaught: true,
  supervisorUsage: null,
  delegations: [],
  workerCount: 0,
  workerEfforts: [],
  batches: [],
  integrationConflicts: 0,
  breakdown: {
    supervisorBeforeSeconds: null,
    worktreeSetupSeconds: null,
    workerWindowSeconds: null,
    slowestWorkerSeconds: null,
    integrationSeconds: null,
    supervisorAfterSeconds: null,
    peakConcurrency: null,
  },
  verificationFailed: 0,
  verificationRefused: 0,
  workerFailures: [],
  agentError: null,
  validity: { status: "valid", reasons: [] },
  ...overrides,
});

const v3Snapshot = (
  extra: Partial<Parameters<typeof buildResultsSnapshot>[0]> = {},
): Parameters<typeof buildResultsSnapshot>[0] => ({
  startedAt: "2026-08-29T00-00-00-000Z",
  campaignId: "benchmark-v3-test",
  reps: 2,
  records: [runRecord()],
  standardSpeedConfirmed: true,
  suite: "v3",
  pricingProfileConfirmed: true,
  environment: environmentRecord(),
  ordering: orderCampaignCells(cells(["a"], 1), { mode: "seeded", seed: "s" }).ordering,
  methodologyDigest: "d".repeat(64),
  ...extra,
});

test("a V3 snapshot cannot be written without reproducibility, ordering, and a digest", () => {
  assert.throws(
    () => buildResultsSnapshot(v3Snapshot({ environment: undefined })),
    /reproducibility evidence/,
  );
  assert.throws(
    () => buildResultsSnapshot(v3Snapshot({ ordering: undefined })),
    /execution ordering/,
  );
  assert.throws(
    () => buildResultsSnapshot(v3Snapshot({ methodologyDigest: undefined })),
    /V3_METHODOLOGY\.md digest/,
  );
  assert.throws(
    () =>
      buildResultsSnapshot(
        v3Snapshot({ environment: environmentRecord({ gitCommit: null }) }),
      ),
    /git\.commit/,
  );
});

test("a V3 snapshot carries its commit, order, digest, and retry treatment", () => {
  const snapshot = buildResultsSnapshot(v3Snapshot());
  assert.equal(snapshot.environment?.git.commit, "a".repeat(40));
  assert.equal(snapshot.environment?.git.branch, "main");
  assert.equal(snapshot.ordering?.mode, "seeded");
  assert.equal(snapshot.ordering?.seed, "s");
  assert.equal(snapshot.methodologyDigest, "d".repeat(64));
  assert.deepEqual(snapshot.retryPolicy, CAMPAIGN_RETRY_POLICY);
});

test("a V2 snapshot stays writable without the V3 launch evidence", () => {
  const snapshot = buildResultsSnapshot({
    startedAt: "2026-08-24T00-00-00-000Z",
    reps: 2,
    records: [],
    standardSpeedConfirmed: true,
  });
  assert.equal(snapshot.benchmarkVersion, 2);
  assert.equal(snapshot.environment, undefined);
  assert.deepEqual(snapshot.retryPolicy, CAMPAIGN_RETRY_POLICY);
});

test("quarantined runs leave the aggregates but stay listed in the report", () => {
  const valid = runRecord({ repetition: 1, passed: true });
  const excluded = runRecord({
    repetition: 2,
    passed: false,
    runId: "run-2",
    terminationReason: "agent-error",
    agentError: "stream closed",
    validity: { status: "quarantined", reasons: ["agent-transport-error"] },
  });

  const summarized = groupCells([valid, excluded]);
  assert.equal(summarized.length, 1);
  assert.equal(summarized[0]?.runs, 1);
  assert.equal(summarized[0]?.passed, 1);

  const report = renderReport(
    buildResultsSnapshot(v3Snapshot({ records: [valid, excluded] })),
  );
  assert.match(report, /Included in aggregates: 1 of 2 run\(s\)/);
  assert.match(report, /agent-transport-error/);
  assert.match(report, /Quarantined runs are retained as evidence/);
});

test("the report states the commit, order, digest, and retry treatment it ran under", () => {
  const report = renderReport(buildResultsSnapshot(v3Snapshot()));
  assert.match(report, /## Reproducibility/);
  assert.match(report, new RegExp(`Commit: \`${"a".repeat(40)}\` on branch \`main\``));
  assert.match(report, /clean working tree/);
  assert.match(report, /Execution ordering: seeded \(seed `s`\)/);
  assert.match(report, /Methodology digest: `d{64}`/);
  assert.match(report, /0 automatic run retries/);
});

test("a historical shard without the new fields reports unknown, never zero", () => {
  const historical = runRecord({
    benchmarkVersion: 2,
    suite: "v2",
    orchestration: undefined,
    context: undefined,
    terminationReason: undefined,
  });
  const report = renderReport({ schema: 4, records: [historical] });
  assert.match(report, /this shard predates reproducibility capture/);
  assert.match(report, /Methodology digest: `unknown`/);
  assert.match(report, /## Orchestration behaviour by run/);
  assert.match(report, /\| v3-csv-dialect \| solo-medium \| 1 \| unknown \|/);
});
