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
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EFFORTS } from "../config.js";
import { NO_CWD_IN_EXE_PATH_ENV, type ExecutableProbe } from "../executable.js";
import { groupCells } from "./analysis.js";
import type { CampaignCell } from "./campaign.js";
import {
  assertEnvironmentEvidence,
  buildCodexConfigRecord,
  buildEnvironmentRecord,
  captureEnvironmentRecord,
  classifyAmbientEnvironment,
  classifyAmbientName,
  classifyCodexAuth,
  EXCLUDED_ENVIRONMENT_KEYS,
  fingerprintFile,
  missingEnvironmentEvidence,
  readCodexSdkVersion,
  RECORDED_ENVIRONMENT_KEYS,
  redactCodexConfigToml,
  redactUrlValue,
  REPRODUCIBILITY_BOUNDARY,
  REQUIRED_ENVIRONMENT_FIELDS,
  resolveBenchExecutable,
  SECRET_SHAPED_ENVIRONMENT_NAME,
  UNINSPECTED_FILE,
  type EnvironmentProbe,
  type EnvironmentRecord,
} from "./environment.js";
import {
  assertBaselineCellRuntimeIdentity,
  assertProductionBaselineRuntime,
  baselineMcpServer,
  BASELINE_ARTIFACT_DIRECTORY,
  BASELINE_RUNTIME_MANIFEST_SCHEMA,
  BENCHMARK_V3_EXPECTED_RUNTIME_MANIFEST_SHA256,
  buildBaselineCellRuntimeIdentity,
  buildBaselineRuntimeManifest,
  buildProductionBaselineRuntime,
  type BaselineRuntimeProbe,
} from "./baseline.js";
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
  createV3LaunchMarker,
  readV3LaunchMarker,
  V3_LAUNCH_MARKER_SCHEMA,
  V3_LAUNCH_MARKER_SUFFIX,
  v3LaunchMarkerFilename,
} from "./launch.js";
import {
  assertOrderingCompatibility,
  assertOrderingSeed,
  orderCampaignCells,
} from "./ordering.js";
import {
  buildCheckpoint,
  defaultCampaignId,
  deriveV3ExecutionHistory,
  parsePrelaunchArgs,
  preserveSupersededCheckpointFiles,
  REVIEWED_PRE_V3_EVENT_STREAM_SHA256,
  renderCheckpoint,
  V3_CAMPAIGN_ARMS,
  V3_CAMPAIGN_REPETITIONS,
} from "./prelaunch.js";
import { renderReport } from "./report.js";
import {
  assertV3FreezePinned,
  buildResultsSnapshot,
  fixtureRevisionOf,
  prepareRunArmTiming,
  readTelemetry,
  type RunRecord,
} from "./run.js";
import {
  BENCHMARK_V3_FREEZE_REVISION,
  BENCHMARK_V3_FREEZE_SHA,
  BENCHMARK_V3_FREEZE_SHA_IS_CURRENT,
  BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
  BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
  V3_TASKS,
} from "./v3-tasks.js";

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
  // Which orchestrator served the run is part of a V3 snapshot's provenance;
  // `baselineProbe` below is the artifact that satisfies every binding check.
  baselineRuntime: buildProductionBaselineRuntime(baselineProbe()),
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

test("a V3 snapshot rejects an Adaptive record without both sealed observations", () => {
  const adaptive = runRecord({
    arm: "adaptive-medium",
    armLabel: "Adaptive Medium",
    delegationEnabled: true,
  });
  assert.throws(
    () => buildResultsSnapshot(v3Snapshot({ records: [adaptive] })),
    /verified pre\/post sealed baseline runtime identity/,
  );
  const sealed = buildBaselineCellRuntimeIdentity(
    buildProductionBaselineRuntime(baselineProbe()),
    buildProductionBaselineRuntime(baselineProbe()),
  );
  assert.doesNotThrow(() =>
    buildResultsSnapshot(
      v3Snapshot({
        records: [runRecord({ ...adaptive, baselineRuntimeIdentity: sealed })],
      }),
    ),
  );
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
// --- Refused delegation calls -----------------------------------------------

/**
 * The runtime opens a batch identity before its pre-execution gates run, so
 * `batch.started` is published by calls that are then refused with zero worker
 * attempts. These fix the two refusal shapes the delegation surfaces actually
 * produce, so a fold can never report a refusal as an opened worker batch.
 */

test("a call refused straight after admission is not a delegation call", () => {
  const metrics = foldOrchestrationMetrics([
    { type: "batch.started", mode: "single", batchId: "b1" },
    { type: "batch.rejected", batchId: "b1", reason: "compute policy refused" },
  ]);

  assert.equal(metrics.delegationCalls, 0);
  assert.deepEqual(metrics.batchesByMode, {});
  assert.equal(metrics.delegationCallsRefused, 1);
  assert.deepEqual(metrics.refusedBatchesByMode, { single: 1 });
  assert.equal(metrics.attemptsStarted, 0);
  assert.equal(metrics.attemptsCompleted, 0);
});

test("a call refused after declaring its routing card is not a delegation call", () => {
  const metrics = foldOrchestrationMetrics([
    { type: "batch.started", mode: "single", batchId: "b1" },
    { type: "routing.declared", declaration: "attached", batchId: "b1" },
    { type: "batch.rejected", batchId: "b1", reason: "no declared seam" },
  ]);

  assert.equal(metrics.delegationCalls, 0);
  assert.deepEqual(metrics.batchesByMode, {});
  assert.equal(metrics.delegationCallsRefused, 1);
  // The declaration itself still happened and stays counted: the refusal is
  // about what executed, not about what the supervisor claimed.
  assert.equal(metrics.routingDeclarationsAttached, 1);
  assert.equal(metrics.attemptsStarted, 0);
});

test("a refused batch never masks the opened batches in the same run", () => {
  const metrics = foldOrchestrationMetrics([
    // Refused before the identity even reached batch.started.
    { type: "batch.rejected", batchId: "b0", reason: "handoff already used" },
    // Refused after opening an identity, mid-flight.
    { type: "batch.started", mode: "parallel", batchId: "b1" },
    { type: "batch.rejected", batchId: "b1", reason: "overlapping scopes" },
    // A real delegation.
    { type: "batch.started", mode: "single", batchId: "b2" },
    {
      type: "attempt.started",
      batchId: "b2",
      executionId: "e1",
      predecessorExecutionId: null,
      model: "gpt-5.6-luna",
      effort: "medium",
    },
    {
      type: "attempt.completed",
      batchId: "b2",
      executionId: "e1",
      role: "initial",
      termination: "completed",
      usageStatus: "reported",
      verificationFailed: 0,
    },
    { type: "batch.completed", batchId: "b2" },
  ]);

  assert.equal(metrics.delegationCalls, 1);
  assert.deepEqual(metrics.batchesByMode, { single: 1 });
  assert.equal(metrics.delegationCallsRefused, 2);
  assert.deepEqual(metrics.refusedBatchesByMode, { parallel: 1 });
  assert.equal(metrics.attemptsStarted, 1);
});

test("a cancelled batch opened a worker batch and is reported as its own outcome", () => {
  const metrics = foldOrchestrationMetrics([
    { type: "batch.started", mode: "single", batchId: "b1" },
    { type: "batch.cancelled", batchId: "b1", reason: "cancelled before worker start" },
  ]);

  // Cancellation is an execution-time outcome, not an admission refusal: the
  // call passed every gate, so it counts as an opened call and says so.
  assert.equal(metrics.delegationCalls, 1);
  assert.equal(metrics.delegationCallsRefused, 0);
  assert.equal(metrics.delegationCallsCancelled, 1);
});

test("a refused call anchors no phase boundary and queues no worker effort", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bench-refusal-"));
  const file = path.join(directory, "events.jsonl");
  const at = (ms: number): string => new Date(ms).toISOString();
  try {
    fs.writeFileSync(
      file,
      [
        // Refused single call: opened an identity, declared, then refused.
        { timestamp: at(1_000), type: "batch.started", batchId: "b1", mode: "single" },
        {
          timestamp: at(1_100),
          type: "routing.declared",
          batchId: "b1",
          declaration: "attached",
        },
        { timestamp: at(1_200), type: "batch.rejected", batchId: "b1", reason: "gate" },
        // Refused parallel call: its tasks were queued before the scope gate.
        {
          timestamp: at(1_300),
          type: "batch.started",
          batchId: "b2",
          mode: "parallel",
          taskCount: 2,
          maxParallel: 2,
        },
        {
          timestamp: at(1_310),
          type: "task.queued",
          batchId: "b2",
          taskId: "t1",
          effort: "xhigh",
        },
        {
          timestamp: at(1_320),
          type: "task.queued",
          batchId: "b2",
          taskId: "t2",
          effort: "xhigh",
        },
        {
          timestamp: at(1_400),
          type: "batch.rejected",
          batchId: "b2",
          reason: "overlapping scopes",
        },
        // The delegation that actually ran.
        { timestamp: at(3_000), type: "batch.started", batchId: "b3", mode: "single" },
        {
          timestamp: at(3_010),
          type: "task.queued",
          batchId: "b3",
          taskId: "t1",
          effort: "medium",
        },
        {
          timestamp: at(3_020),
          type: "worktree.created",
          batchId: "b3",
          taskId: "t1",
          path: "wt",
        },
        {
          timestamp: at(3_100),
          type: "worker.started",
          batchId: "b3",
          taskId: "t1",
          effort: "medium",
        },
        {
          timestamp: at(5_100),
          type: "worker.completed",
          batchId: "b3",
          taskId: "t1",
          verdict: "PASS",
          effort: "medium",
          threadId: "thr_1",
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
          },
        },
        { timestamp: at(5_200), type: "batch.completed", batchId: "b3" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
      "utf8",
    );

    const telemetry = readTelemetry(file, 0, 0, 6_000);

    assert.equal(telemetry.available, true);
    // One opened batch, not three.
    assert.equal(telemetry.batches.length, 1);
    assert.equal(telemetry.batches[0]?.mode, "single");
    assert.equal(telemetry.orchestration.delegationCalls, 1);
    assert.equal(telemetry.orchestration.delegationCallsRefused, 2);
    // Only the worker that ran contributes an effort; the refused parallel
    // batch queued two that no worker ever executed.
    assert.deepEqual(telemetry.efforts, ["medium"]);
    assert.equal(telemetry.delegations.length, 1);
    // Supervisor-before is measured to the first *opened* batch, so a refusal
    // cannot make supervisor work look instantaneous.
    assert.equal(telemetry.breakdown.supervisorBeforeSeconds, 3);
    assert.equal(telemetry.breakdown.worktreeSetupSeconds, 0);
    assert.equal(telemetry.breakdown.workerWindowSeconds, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// --- Executable resolution in the capture probe ------------------------------

/**
 * The probe shells out to `git`, `npm`, and `codex` from a working directory
 * that is not necessarily trustworthy, so it resolves through the production
 * resolver rather than handing a launcher a bare name.
 */

const executableProbe = (present: readonly string[]): ExecutableProbe => ({
  isExecutableFile: (candidate) => present.includes(candidate),
});

test("the capture probe resolves tools from PATH and never from the working directory", () => {
  const resolved = resolveBenchExecutable("git", {
    platform: "win32",
    delimiter: ";",
    // `.`, an empty entry, and a relative entry all mean "whatever directory
    // the probe happens to be running in".
    env: { PATH: ".;;tools\\bin;C:\\tools", PATHEXT: ".com;.exe;.cmd" },
    probe: executableProbe([
      "git.cmd",
      ".\\git.cmd",
      "tools\\bin\\git.cmd",
      "C:\\tools\\git.exe",
    ]),
  });
  // Those entries are dropped rather than searched, so a shim written into the
  // working directory never answers for the real tool.
  assert.equal(resolved, "C:\\tools\\git.exe");
});

test("the capture probe reads a tool as unavailable rather than falling back to a bare name", () => {
  assert.equal(
    resolveBenchExecutable("codex", {
      platform: "win32",
      delimiter: ";",
      env: { PATH: ".;", PATHEXT: ".com;.exe;.cmd" },
      probe: executableProbe(["C:\\workspace\\codex.cmd"]),
    }),
    null,
  );
  assert.equal(
    resolveBenchExecutable("git", {
      platform: "linux",
      delimiter: ":",
      env: { PATH: ".::relative/bin" },
      probe: executableProbe(["/workspace/git", "relative/bin/git"]),
    }),
    null,
  );
});

test("the capture probe resolves Windows shims through PATHEXT, not a hardcoded suffix", () => {
  assert.equal(
    resolveBenchExecutable("npm", {
      platform: "win32",
      delimiter: ";",
      env: { PATH: "C:\\nodejs", PATHEXT: ".com;.exe;.cmd" },
      probe: executableProbe(["C:\\nodejs\\npm.cmd"]),
    }),
    "C:\\nodejs\\npm.cmd",
  );
});

test("the production resolver keeps its own guarantees for the benchmark", () => {
  // The benchmark reuses the production module rather than a relaxed copy, so
  // the marker it relies on is the production marker.
  assert.equal(NO_CWD_IN_EXE_PATH_ENV, "NoDefaultCurrentDirectoryInExePath");
  // An absolute or path-spelling name is honoured verbatim on both surfaces.
  assert.equal(
    resolveBenchExecutable("/usr/bin/git", { platform: "linux", delimiter: ":" }),
    "/usr/bin/git",
  );
});

// --- Reproducibility capture cannot drift from production --------------------

const PRODUCTION_SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
);

/** Source files a V3 cell can actually execute through. */
const productionSourceFiles = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionSourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    // Tests, the self-test, and the smoke scripts are development tooling; no
    // benchmark cell runs through them.
    if (entry.name.endsWith(".test.ts")) continue;
    if (entry.name === "selftest.ts") continue;
    if (entry.name.startsWith("smoke-")) continue;
    files.push(full);
  }
  return files;
};

/**
 * Environment variable names detected in explicitly supported source forms.
 *
 * `process.env.NAME`, `process.env["NAME"]`, and `process.env[CONST]` where the
 * constant is a string literal in the same tree. A constant that cannot be
 * resolved fails the scan loudly rather than silently shrinking the set.
 */
const readEnvironmentNames = (): Set<string> => {
  const files = productionSourceFiles(PRODUCTION_SOURCE_ROOT);
  const sources = files.map((file) => fs.readFileSync(file, "utf8"));
  const literals = new Map<string, string>();
  for (const source of sources) {
    for (const match of source.matchAll(
      /const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
    )) {
      literals.set(match[1]!, match[2]!);
    }
  }

  const names = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(
      /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*"([^"]+)"\s*\]|\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\])/g,
    )) {
      const direct = match[1] ?? match[2];
      if (direct !== undefined) {
        names.add(direct);
        continue;
      }
      const identifier = match[3]!;
      // A lower-cased identifier is a loop variable over a list this module
      // already owns, not a new variable name.
      if (!/^[A-Z][A-Z0-9_]*$/.test(identifier)) continue;
      const resolved = literals.get(identifier);
      assert.ok(
        resolved !== undefined,
        `process.env[${identifier}] could not be resolved to a name; the ` +
          "reproducibility drift scan must not silently skip it",
      );
      names.add(resolved);
    }
  }
  return names;
};

test("the environment scan actually finds production variables", () => {
  const names = readEnvironmentNames();
  // A scan that quietly returned nothing would make every check below vacuous.
  assert.ok(names.size >= 20, `only found ${names.size} environment reads`);
  for (const expected of ["LUNA_MODEL", "CODEX_HOME", "SOL_LUNA_WORKER"]) {
    assert.ok(names.has(expected), `scan missed ${expected}`);
  }
});

test("every detected supported-form environment read is recorded or reasoned", () => {
  const recorded = new Set<string>(RECORDED_ENVIRONMENT_KEYS);
  const excluded = new Set(Object.keys(EXCLUDED_ENVIRONMENT_KEYS));
  const unclassified = [...readEnvironmentNames()].filter(
    (name) => !recorded.has(name) && !excluded.has(name),
  );
  assert.deepEqual(
    unclassified.sort(),
    [],
    "a supported-form production environment read escaped benchmark capture; " +
      "add it to RECORDED_ENVIRONMENT_KEYS, or to EXCLUDED_ENVIRONMENT_KEYS with " +
      "the argument that it cannot affect a measured run",
  );
});

test("the recorded and excluded inventories stay disjoint and reasoned", () => {
  const recorded = new Set<string>(RECORDED_ENVIRONMENT_KEYS);
  for (const [name, reason] of Object.entries(EXCLUDED_ENVIRONMENT_KEYS)) {
    assert.ok(!recorded.has(name), `${name} is both recorded and excluded`);
    assert.ok(reason.trim().length >= 40, `${name} has no substantive exclusion reason`);
  }
  assert.equal(new Set(RECORDED_ENVIRONMENT_KEYS).size, RECORDED_ENVIRONMENT_KEYS.length);
});

test("no credential-shaped variable may be recorded", () => {
  for (const key of RECORDED_ENVIRONMENT_KEYS) {
    assert.ok(
      !SECRET_SHAPED_ENVIRONMENT_NAME.test(key),
      `${key} looks like a credential and its value would be committed verbatim`,
    );
  }
  for (const candidate of ["OPENAI_API_KEY", "GITHUB_TOKEN", "NPM_AUTH_TOKEN"]) {
    assert.ok(SECRET_SHAPED_ENVIRONMENT_NAME.test(candidate));
    assert.ok(!(RECORDED_ENVIRONMENT_KEYS as readonly string[]).includes(candidate));
  }
});

test("the execution-affecting variables the freeze-3 audit found are captured", () => {
  // Named individually because each was absent from the freeze-2 inventory and
  // each changes what a measured run does.
  for (const key of [
    "CODEX_HOME",
    "LUNA_MODEL",
    "LUNA_NETWORK_ACCESS",
    "LUNA_TIMEOUT_SECONDS",
    "LUNA_VERIFY_TIMEOUT_SECONDS",
    "SOL_LUNA_ALLOWED_ROOTS",
    "SOL_LUNA_VERIFY_ALLOW",
    "SOL_LUNA_VERIFY_ENV_PASSTHROUGH",
    "SOL_LUNA_WORKER",
    "SOL_LUNA_WORKTREE_LINK",
  ]) {
    assert.ok(
      (RECORDED_ENVIRONMENT_KEYS as readonly string[]).includes(key),
      `${key} is execution-affecting and must be recorded`,
    );
  }
});

// --- Freeze pin --------------------------------------------------------------

test("the live V3 freeze pin names the current review", () => {
  assert.equal(BENCHMARK_V3_FREEZE_REVISION, 3);
  assert.equal(BENCHMARK_V3_FREEZE_SHA_IS_CURRENT, true);
  assert.doesNotThrow(() => assertV3FreezePinned());
  assert.doesNotThrow(() =>
    assertV3FreezePinned({ revision: 3, sha: "f".repeat(40), shaIsCurrent: true }),
  );
});
// --- Pre-launch checkpoint ---------------------------------------------------

/**
 * The checkpoint is generated, never transcribed. These pin what it must derive
 * from the code that will actually run, and that generating one cannot quietly
 * broaden the frozen experiment.
 */

test("the pre-launch checkpoint derives the current freeze, digest, and baseline", () => {
  const checkpoint = buildCheckpoint({ campaignId: "v3-checkpoint-test" });
  const freeze = checkpoint.freezeIntegrity as Record<string, unknown>;
  const baseline = freeze.productionBaseline as Record<string, unknown>;

  assert.equal(freeze.expectedDigest, V3_METHODOLOGY_DIGEST);
  assert.equal(freeze.workingTreeDigest, V3_METHODOLOGY_DIGEST);
  assert.equal(freeze.digestGate, "pass");
  // The two commit identities stay distinct and correctly labelled.
  assert.equal(freeze.pinnedFreezeSha, BENCHMARK_V3_FREEZE_SHA);
  assert.equal(freeze.pinnedFreezeShaIsCurrentReview, BENCHMARK_V3_FREEZE_SHA_IS_CURRENT);
  assert.equal(baseline.version, "0.11.0");
  assert.notEqual(baseline.sha, BENCHMARK_V3_FREEZE_SHA);
  assert.match(defaultCampaignId(new Date("2026-08-29T12:00:00Z")), /^v3-freeze3-\d{8}$/);
});

test("checkpoint generation never creates live-launch evidence", () => {
  const results = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "bench",
    "results",
  );
  const markers = (): string[] =>
    fs.existsSync(results)
      ? fs.readdirSync(results).filter((name) => name.endsWith(V3_LAUNCH_MARKER_SUFFIX))
      : [];
  const before = markers();
  buildCheckpoint({ campaignId: "v3-checkpoint-no-launch-marker" });
  assert.deepEqual(markers(), before);
});

test("the pre-launch checkpoint leaves pricing explicitly unresolved", () => {
  const checkpoint = buildCheckpoint({ campaignId: "v3-checkpoint-test" });
  const pricing = checkpoint.pricing as Record<string, unknown>;
  assert.equal(pricing.status, "unverified-launch-blocked");
  assert.equal(pricing.revalidatedDuringThisCheckpoint, false);
  assert.equal(pricing.newProfileCreated, false);
  assert.equal((pricing.externalValidation as { performed: boolean }).performed, false);
  // Generating a checkpoint can never clear the pricing gate by itself.
  const blockers = checkpoint.blockers as Array<{ id: string }>;
  assert.ok(blockers.some((blocker) => blocker.id === "pricing-profile-unverified"));
  assert.equal(checkpoint.launchReadiness, "blocked");
});

test("the pre-launch checkpoint preserves the frozen experiment", () => {
  const checkpoint = buildCheckpoint({ campaignId: "v3-checkpoint-test" });
  const fixtures = checkpoint.fixtures as Record<string, unknown>;
  const ordering = checkpoint.ordering as Record<string, unknown>;
  const profile = checkpoint.executionProfile as Record<string, unknown>;

  assert.equal(fixtures.taskCount, 9);
  assert.deepEqual(fixtures.frozenTaskIds, NINE);
  assert.deepEqual(V3_CAMPAIGN_ARMS, ["solo-medium", "adaptive-medium"]);
  assert.equal(V3_CAMPAIGN_REPETITIONS, 2);
  assert.equal(ordering.plannedCellCount, 36);
  assert.equal(profile.forcedDelegationExcluded, true);
  assert.equal(
    (profile.harnessConfigurationBoundary as Record<string, unknown>)
      .everyV3TaskResolvesToProductionDefault,
    true,
  );
  // Fixture revisions come from the runner's own function, so a checkpoint
  // cannot agree with itself while disagreeing with the campaign.
  const tasks = fixtures.tasks as Array<{ taskId: string; fixtureRevision: string }>;
  for (const task of tasks) {
    const source = V3_TASKS.find((candidate) => candidate.id === task.taskId);
    assert.ok(source);
    assert.equal(task.fixtureRevision, fixtureRevisionOf(source));
  }
  assert.equal(new Set(tasks.map((task) => task.fixtureRevision)).size, tasks.length);
});

test("the pre-launch checkpoint records the layered reproducibility inventory", () => {
  const checkpoint = buildCheckpoint({ campaignId: "v3-checkpoint-test" });
  const environment = checkpoint.environment as Record<string, unknown>;
  const inventory = environment.reproducibilityInventory as Record<string, unknown>;

  const production = inventory.productionOwned as Record<string, unknown>;
  assert.deepEqual(production.recordedKeys, [...RECORDED_ENVIRONMENT_KEYS]);
  assert.equal(production.recordedKeyCount, RECORDED_ENVIRONMENT_KEYS.length);
  assert.deepEqual(
    Object.keys(production.excludedKeys as Record<string, string>).sort(),
    Object.keys(EXCLUDED_ENVIRONMENT_KEYS).sort(),
  );
  // The drift claim is scoped to this repository's own reads and says so.
  assert.match(String(production.driftPrevention), /defense-in-depth syntactic scan/);
  assert.match(String(production.driftPrevention), /not a semantic proof/);

  // The ambient layer is present and non-empty: a checkpoint generated by a
  // real process always inherited something.
  const ambient = inventory.ambient as Record<string, unknown>;
  assert.ok((ambient.nameCount as number) > 0);
  assert.match(String(ambient.namesSha256), /^[0-9a-f]{64}$/);

  const codex = inventory.codex as Record<string, unknown>;
  assert.equal(codex.authRepresentation, "presence-and-mode-only");

  assert.equal(inventory.boundary, REPRODUCIBILITY_BOUNDARY);
});

// --- Ambient inherited environment ------------------------------------------

/**
 * The ambient layer's contract: every inherited name is visible, and a value
 * appears only where it was explicitly classified as safe to persist.
 */

test("every inherited name is inventoried, sorted, and digested", () => {
  const record = classifyAmbientEnvironment({
    ZED: "1",
    ALPHA: "2",
    middle: "3",
    LUNA_MODEL: "gpt-5.6-luna",
  });
  assert.deepEqual(record.names, ["ALPHA", "LUNA_MODEL", "ZED", "middle"]);
  assert.equal(record.nameCount, 4);
  assert.match(record.namesSha256, /^[0-9a-f]{64}$/);
  // A production-owned name is still inventoried; its value lives in the
  // production layer rather than being duplicated here.
  const production = record.entries.find((entry) => entry.name === "LUNA_MODEL");
  assert.equal(production?.representation, "production-owned");
  assert.equal(production?.value, undefined);
});

test("an ambient variable nobody classified is present-and-opaque, never absent", () => {
  const record = classifyAmbientEnvironment({
    SOME_VENDOR_TOGGLE: "vendor-value-do-not-commit",
  });
  const entry = record.entries[0];
  assert.equal(entry?.name, "SOME_VENDOR_TOGGLE");
  assert.equal(entry?.representation, "presence-only");
  assert.equal(entry?.value, undefined);
  // The name being listed is the point: unclassified state stays visible.
  assert.deepEqual(record.names, ["SOME_VENDOR_TOGGLE"]);
  assert.equal(record.opaqueValueCount, 1);
  assert.ok(!JSON.stringify(record).includes("vendor-value-do-not-commit"));
});

test("credential-shaped values are never serialized, only their presence", () => {
  const record = classifyAmbientEnvironment({
    OPENAI_API_KEY: "sk-live-do-not-commit",
    GITHUB_TOKEN: "ghp_do_not_commit",
    AWS_SECRET_ACCESS_KEY: "do-not-commit",
    SOME_SESSION_ID: "do-not-commit",
    PROXY_AUTH_TOKEN: "http://user:pw@proxy.example",
  });
  const serialized = JSON.stringify(record);
  for (const secret of [
    "sk-live-do-not-commit",
    "ghp_do_not_commit",
    "do-not-commit",
    "user:pw",
  ]) {
    assert.ok(!serialized.includes(secret), `${secret} reached the record`);
  }
  assert.deepEqual(record.credentialShapedNames, [
    "AWS_SECRET_ACCESS_KEY",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "PROXY_AUTH_TOKEN",
    "SOME_SESSION_ID",
  ]);
  for (const entry of record.entries) {
    assert.equal(entry.representation, "credential-opaque");
    assert.equal(entry.value, undefined);
    assert.equal(entry.url, undefined);
  }
  // A credential-shaped name must not be rescued by a safe-value list.
  assert.equal(classifyAmbientName("PROXY_AUTH_TOKEN"), "credential-opaque");
});

test("proxy state is represented without its embedded credentials", () => {
  const record = classifyAmbientEnvironment({
    HTTPS_PROXY: "http://corp-user:s3cret@proxy.corp.example:3128/path?x=1",
    http_proxy: "http://plain.example:8080",
    NO_PROXY: "localhost,127.0.0.1",
    ALL_PROXY: "not a url at all",
  });
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes("s3cret"));
  assert.ok(!serialized.includes("corp-user"));

  const https = record.entries.find((entry) => entry.name === "HTTPS_PROXY");
  assert.equal(https?.representation, "url-redacted");
  assert.equal(https?.url?.hostname, "proxy.corp.example");
  assert.equal(https?.url?.port, "3128");
  assert.equal(https?.url?.embeddedCredentials, true);
  assert.equal(https?.url?.hasQuery, true);

  // The lowercase spelling is the same variable and is classified the same way.
  const lower = record.entries.find((entry) => entry.name === "http_proxy");
  assert.equal(lower?.representation, "url-redacted");
  assert.equal(lower?.url?.embeddedCredentials, false);

  // A bypass list holds no credential and is recorded as it stands.
  const bypass = record.entries.find((entry) => entry.name === "NO_PROXY");
  assert.equal(bypass?.representation, "verbatim");
  assert.equal(bypass?.value, "localhost,127.0.0.1");

  // An unparseable value is reported as unparseable, never echoed.
  const broken = record.entries.find((entry) => entry.name === "ALL_PROXY");
  assert.equal(broken?.url?.parsed, false);
  assert.ok(!serialized.includes("not a url at all"));
  assert.deepEqual(redactUrlValue("://nonsense").parsed, false);
});

test("trust material is fingerprinted without retaining any path metadata", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bench-certs-"));
  const bundle = path.join(directory, "corp-root-ca.pem");
  fs.writeFileSync(bundle, "-----BEGIN CERTIFICATE-----\n");

  const record = classifyAmbientEnvironment(
    { NODE_EXTRA_CA_CERTS: bundle, SSL_CERT_FILE: path.join(directory, "absent.pem") },
    fingerprintFile,
  );
  const extra = record.entries.find((entry) => entry.name === "NODE_EXTRA_CA_CERTS");
  assert.equal(extra?.representation, "trust-material-fingerprint");
  assert.equal(extra?.trustMaterial?.configured, true);
  assert.equal(extra?.trustMaterial?.file.exists, true);
  assert.equal(extra?.trustMaterial?.file.readable, true);
  assert.equal(extra?.trustMaterial?.file.fileType, "file");
  assert.equal(extra?.trustMaterial?.file.byteLength, 28);
  assert.match(String(extra?.trustMaterial?.file.sha256), /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes(directory.replace(/\\/g, "\\\\")));
  assert.ok(!serialized.includes("corp-root-ca.pem"));
  assert.ok(!serialized.includes("pathSha256"));

  // A configured but missing file is a fact, and distinct from never looking.
  const missing = record.entries.find((entry) => entry.name === "SSL_CERT_FILE");
  assert.equal(missing?.trustMaterial?.file.inspected, true);
  assert.equal(missing?.trustMaterial?.file.exists, false);
  assert.equal(UNINSPECTED_FILE.exists, null);

  const credentialPath = classifyAmbientEnvironment({
    CLIENT_KEY_PATH: path.join(directory, "client.key"),
  });
  assert.equal(credentialPath.entries[0]?.representation, "credential-opaque");
  assert.ok(!JSON.stringify(credentialPath).includes("client.key"));

  fs.rmSync(directory, { recursive: true, force: true });
});

test("the ambient inventory is canonical and order-independent", () => {
  const forward = classifyAmbientEnvironment({ A: "1", B: "2", C: "3" });
  const reversed = classifyAmbientEnvironment({ C: "3", B: "2", A: "1" });
  assert.deepEqual(forward, reversed);
  assert.equal(forward.namesSha256, reversed.namesSha256);
  // A name appearing or disappearing changes the digest, which is what makes it
  // usable as a single-field ambient drift comparison.
  assert.notEqual(
    forward.namesSha256,
    classifyAmbientEnvironment({ A: "1", B: "2" }).namesSha256,
  );
});

// --- Effective Codex configuration ------------------------------------------

test("the Codex config fingerprint redacts secrets and survives formatting", () => {
  const config = [
    "# a comment that cannot change execution",
    'model = "gpt-5.6-sol"',
    "",
    "[mcp_servers.sol-luna-orchestrator]",
    'command = "node"',
    'api_key = "sk-live-do-not-commit"',
    'bearer_token = "do-not-commit"',
  ].join("\n");

  const redacted = redactCodexConfigToml(config);
  assert.ok(!redacted.canonical.includes("sk-live-do-not-commit"));
  assert.ok(!redacted.canonical.includes("do-not-commit"));
  assert.equal(redacted.redactedAssignments, 2);
  assert.deepEqual(redacted.mcpServerNames, ["sol-luna-orchestrator"]);

  // A server's sub-tables name the same server, not additional ones.
  assert.deepEqual(
    redactCodexConfigToml(
      [
        "[mcp_servers.sol-luna-orchestrator]",
        "[mcp_servers.sol-luna-orchestrator.env]",
        '[mcp_servers."vendor.tool"]',
        "[mcp_servers.node_repl.env]",
      ].join("\n"),
    ).mcpServerNames,
    ["node_repl", "sol-luna-orchestrator", "vendor.tool"],
  );

  // Comments, blank lines, trailing whitespace, and CRLF cannot change the
  // digest; an effective setting can.
  const reformatted = redactCodexConfigToml(
    config
      .replace(/\n/g, "\r\n")
      .replace("# a comment that cannot change execution\r\n", "") + "   \r\n\r\n",
  );
  assert.equal(reformatted.canonical, redacted.canonical);
  const changed = redactCodexConfigToml(config.replace("gpt-5.6-sol", "gpt-5.6-luna"));
  assert.notEqual(changed.canonical, redacted.canonical);
});

test("nested inline, array-table, header, and multiline secrets cannot change the config digest", () => {
  const config = (credential: string): string =>
    [
      'model = "gpt-5.6-sol"',
      "[mcp_servers.vendor]",
      'command = "node"',
      `headers = { Authorization = "${credential}", nested = { cookie = "${credential}" } }`,
      "[[profiles]]",
      'name = "primary"',
      `token = "${credential}"`,
      `password = """line one`,
      `${credential}`,
      `line three"""`,
      "[[profiles]]",
      'name = "secondary"',
      `settings = { nested = { bearer_token = "${credential}" } }`,
    ].join("\n");

  const first = buildCodexConfigRecord({
    home: "D:\\Users\\operator\\.codex",
    homeSource: "default",
    homeIsDefaultLocation: true,
    configToml: config("credential-alpha-do-not-commit"),
    authJson: null,
  });
  const second = buildCodexConfigRecord({
    home: "D:\\Users\\operator\\.codex",
    homeSource: "default",
    homeIsDefaultLocation: true,
    configToml: config("credential-beta-with-a-different-length-do-not-commit"),
    authJson: null,
  });
  assert.equal(first.config.parsed, true);
  assert.equal(
    first.config.redactedCanonicalSha256,
    second.config.redactedCanonicalSha256,
  );
  assert.deepEqual(first.config.mcpServerNames, ["vendor"]);
  const serialized = JSON.stringify({ first, second });
  for (const secret of [
    "credential-alpha-do-not-commit",
    "credential-beta-with-a-different-length-do-not-commit",
  ]) {
    assert.ok(!serialized.includes(secret));
  }
  assert.ok(!Object.hasOwn(first.config, "byteLength"));
  assert.ok(!Object.hasOwn(first.config, "lineCount"));
});

test("an unparseable Codex config is presence-only and never hashed raw", () => {
  const secret = "unparseable-secret-do-not-commit";
  const record = buildCodexConfigRecord({
    home: null,
    homeSource: "unknown",
    homeIsDefaultLocation: null,
    configToml: `headers = { Authorization = "${secret}"`,
    authJson: null,
  });
  assert.equal(record.config.present, true);
  assert.equal(record.config.parsed, false);
  assert.equal(record.config.redactedCanonicalSha256, null);
  assert.ok(!JSON.stringify(record).includes(secret));
});

test("the exported TOML sanitizer replaces parser diagnostics with an opaque error", () => {
  const secret = "malformed-parser-secret-do-not-commit";
  let caught: Error | null = null;
  try {
    redactCodexConfigToml(`headers = { Authorization = "${secret}"`);
  } catch (error) {
    caught = error as Error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "Codex config TOML could not be parsed");
  assert.ok(!String(caught.stack).includes(secret));
  assert.ok(!String(caught.stack).includes("Authorization"));
});

test("both V3 arms scan the baseline before the measured timing anchor", () => {
  for (const delegationEnabled of [false, true]) {
    const order: string[] = [];
    const baseline = { verified: true } as never;
    const prepared = prepareRunArmTiming("v3", delegationEnabled, {
      captureBaseline: () => {
        order.push("manifest-scan");
        return baseline;
      },
      now: () => {
        order.push("timing-anchor");
        return 1_788_048_000_000;
      },
    });
    assert.deepEqual(order, ["manifest-scan", "timing-anchor"]);
    assert.equal(prepared.startMs, 1_788_048_000_000);
    assert.equal(prepared.baselinePre, delegationEnabled ? baseline : null);
  }
});

test("Codex authentication is recorded as a mode, never as a credential", () => {
  const apiKey = classifyCodexAuth(
    JSON.stringify({ OPENAI_API_KEY: "sk-live-do-not-commit" }),
  );
  assert.equal(apiKey.mode, "api-key");
  assert.equal(apiKey.containsSecretMaterial, true);
  assert.ok(!JSON.stringify(apiKey).includes("sk-live-do-not-commit"));

  const chatgpt = classifyCodexAuth(
    JSON.stringify({ tokens: { access_token: "do-not-commit" } }),
  );
  assert.equal(chatgpt.mode, "chatgpt");
  assert.ok(!JSON.stringify(chatgpt).includes("do-not-commit"));

  // Unreadable auth state is still state; it is never optimistically cleared.
  const broken = classifyCodexAuth("{not json");
  assert.equal(broken.present, true);
  assert.equal(broken.mode, "unknown");
  assert.equal(broken.containsSecretMaterial, true);

  assert.deepEqual(classifyCodexAuth(null), {
    present: false,
    mode: "absent",
    containsSecretMaterial: null,
    representation: "presence-and-mode-only",
  });
});

test("a Codex config record identifies configuration without publishing it", () => {
  const record = buildCodexConfigRecord({
    home: "D:\\Users\\someone\\.codex",
    homeSource: "CODEX_HOME",
    homeIsDefaultLocation: false,
    configToml: '[mcp_servers.sol-luna-orchestrator]\ncommand = "node"\n',
    authJson: JSON.stringify({ OPENAI_API_KEY: "sk-live-do-not-commit" }),
  });
  assert.equal(record.config.present, true);
  assert.match(String(record.config.redactedCanonicalSha256), /^[0-9a-f]{64}$/);
  assert.deepEqual(record.config.mcpServerNames, ["sol-luna-orchestrator"]);
  assert.equal(record.auth.mode, "api-key");
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes("sk-live-do-not-commit"));
  // The home path is neither published nor dictionary-hashed by this layer.
  assert.ok(!serialized.includes("someone"));
  assert.ok(!Object.hasOwn(record, "homePathSha256"));
  assert.ok(!Object.hasOwn(record.config, "byteLength"));
});

test("the reproducibility boundary refuses the allowlist-proves-everything claim", () => {
  assert.match(REPRODUCIBILITY_BOUNDARY.statement, /does not prove/i);
  assert.ok(
    REPRODUCIBILITY_BOUNDARY.notCaptured.some((item) =>
      /Codex SDK, the Codex CLI, Node, or the/.test(item),
    ),
    "the boundary must say the source scan proves nothing about inherited consumers",
  );
  assert.ok(
    REPRODUCIBILITY_BOUNDARY.notCaptured.some((item) => /credential/i.test(item)),
    "the boundary must state that credential state is not reproducible",
  );
});

test("a live capture carries the ambient and Codex layers, and a gate requires them", () => {
  const record = captureEnvironmentRecord({ argv: [] });
  assert.ok(record.ambient.nameCount > 0);
  assert.deepEqual([...record.ambient.names].sort(), [...record.ambient.names]);
  assert.equal(record.boundary, REPRODUCIBILITY_BOUNDARY);
  // A record built without a capture layer must not read as an empty machine.
  const uncaptured = buildEnvironmentRecord(probe());
  assert.equal(uncaptured.ambient.nameCount, 0);
  assert.throws(
    () => assertEnvironmentEvidence(uncaptured, { requireAmbientInventory: true }),
    /ambient environment inventory/,
  );
});

// --- Shared Codex SDK version derivation ------------------------------------

test("the installed Codex SDK version is derived once and never silently null", () => {
  const installed = readCodexSdkVersion();
  assert.ok(installed !== null, "the Codex SDK is a runtime dependency of this package");
  assert.match(installed, /^\d+\.\d+\.\d+/);

  // The probe, the runner, and the checkpoint all read the same derivation.
  assert.equal(
    captureEnvironmentRecord({ argv: [] }).toolchain.codexSdkVersion,
    installed,
  );
  const checkpoint = buildCheckpoint({ campaignId: "v3-checkpoint-test" });
  const environment = checkpoint.environment as EnvironmentRecord;
  assert.equal(environment.toolchain.codexSdkVersion, installed);

  // And a launch may not proceed without it.
  assert.ok(
    (REQUIRED_ENVIRONMENT_FIELDS as readonly string[]).includes(
      "toolchain.codexSdkVersion",
    ),
  );
  assert.deepEqual(
    missingEnvironmentEvidence(buildEnvironmentRecord(probe({ codexSdkVersion: null }))),
    ["toolchain.codexSdkVersion"],
  );
});

// --- Production baseline binding --------------------------------------------

/**
 * A baseline artifact that satisfies every binding check, expressed as raw
 * readings so the rules are exercised without provisioning a worktree.
 */
const baselineProbe = (
  overrides: Partial<BaselineRuntimeProbe> = {},
): BaselineRuntimeProbe => ({
  directory: "D:\\repo\\bench\\baseline\\v0.11.0",
  directoryExists: true,
  isolatedFromDevelopmentTree: true,
  headCommit: BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
  headTree: "d".repeat(40),
  statusPorcelain: "",
  expectedTree: "d".repeat(40),
  packageName: "sol-luna-orchestrator",
  packageVersion: BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
  packageVersionAtBaselineCommit: BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
  declaredBinPath: "dist/server.js",
  entryPoint: "D:\\repo\\bench\\baseline\\v0.11.0\\dist\\server.js",
  entryPointExists: true,
  entryPointFileType: "file",
  entryPointRealPath: "D:\\repo\\bench\\baseline\\v0.11.0\\dist\\server.js",
  entryPointContained: true,
  entryPointSha256: "e".repeat(64),
  launcher: "C:\\Program Files\\nodejs\\node.exe",
  declaredDependencies: ["@openai/codex-sdk"],
  installedDependencyVersions: { "@openai/codex-sdk": "0.147.0" },
  runtimeManifest: {
    schema: BASELINE_RUNTIME_MANIFEST_SCHEMA,
    entries: [],
    aggregateSha256: BENCHMARK_V3_EXPECTED_RUNTIME_MANIFEST_SHA256,
    fileCount: 1,
    totalBytes: 4096,
    symlinkCount: 0,
  },
  ...overrides,
});

test("a verified baseline artifact authorizes the server command the arms launch", () => {
  const runtime = buildProductionBaselineRuntime(baselineProbe());
  assert.equal(runtime.verified, true);
  assert.deepEqual(runtime.failedChecks, []);
  assert.doesNotThrow(() => assertProductionBaselineRuntime(runtime));

  const server = baselineMcpServer(runtime);
  assert.equal(server.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(server.args, ["D:\\repo\\bench\\baseline\\v0.11.0\\dist\\server.js"]);
  assert.equal(server.entryPointSha256, "e".repeat(64));
  // The binding does not consult the operator's MCP registration.
  assert.match(runtime.bindingMechanism, /does not depend on the operator/);
  assert.equal(runtime.expected.artifactDirectory, BASELINE_ARTIFACT_DIRECTORY);
});

test("the documented provisioning command is the one the gate expects", () => {
  // A gate whose remedy is written down twice drifts. The npm script and the
  // commands the checkpoint prints come from the same declaration.
  const manifest = JSON.parse(
    fs.readFileSync(
      path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "package.json"),
      "utf8",
    ),
  ) as { scripts: Record<string, string> };
  const runtime = buildProductionBaselineRuntime(baselineProbe());
  assert.equal(
    manifest.scripts["bench:v3:baseline"],
    runtime.provisionCommands.join(" && "),
  );
  assert.match(runtime.provisionCommands.join(" "), /baseline\.js --provision/);
  assert.equal(runtime.expected.artifactDirectory, BASELINE_ARTIFACT_DIRECTORY);
});

test("a server that is not the v0.11.0 baseline cannot produce a v0.11.0 run", () => {
  const cases: Array<[Partial<BaselineRuntimeProbe>, string]> = [
    // A different build of the same package.
    [{ packageVersion: "0.12.0" }, "artifact-package-version-matches"],
    // A different package entirely.
    [{ packageName: "some-other-orchestrator" }, "artifact-package-name-matches"],
    // The right version string on the wrong commit.
    [{ headCommit: "f".repeat(40) }, "artifact-head-is-baseline-commit"],
    // The right commit id with edited content checked out.
    [{ headTree: "a".repeat(40) }, "artifact-tree-matches-baseline-commit"],
    // Locally modified after the build.
    [{ statusPorcelain: " M src/server.ts\n" }, "artifact-working-tree-clean"],
    // The development tree, which would execute current benchmark code.
    [{ isolatedFromDevelopmentTree: false }, "artifact-isolated-from-development-tree"],
    // Never provisioned.
    [{ directoryExists: false }, "artifact-present"],
    // Provisioned but not built.
    [{ entryPointExists: false, entryPointSha256: null }, "artifact-entry-point-present"],
    // A symlink or substituted entry point is not the sealed regular file.
    [{ entryPointFileType: "symlink" }, "artifact-entry-point-regular-file"],
    // Even a regular entry point may not escape the artifact directory.
    [{ entryPointContained: false }, "artifact-entry-point-contained"],
    // Built but with no dependencies installed.
    [{ installedDependencyVersions: {} }, "artifact-dependencies-installed"],
    // A newly observed but unfrozen aggregate is not accepted.
    [
      {
        runtimeManifest: {
          ...baselineProbe().runtimeManifest!,
          aggregateSha256: "f".repeat(64),
        },
      },
      "artifact-runtime-manifest-matches-freeze",
    ],
    // A version string that does not match what the baseline commit recorded.
    [
      { packageVersionAtBaselineCommit: "0.10.0" },
      "artifact-version-matches-baseline-commit",
    ],
  ];

  for (const [overrides, expected] of cases) {
    const runtime = buildProductionBaselineRuntime(baselineProbe(overrides));
    assert.equal(runtime.verified, false, `${expected} should not verify`);
    assert.ok(
      runtime.failedChecks.includes(expected as never),
      `expected ${expected} in ${runtime.failedChecks.join(", ")}`,
    );
    assert.throws(
      () => assertProductionBaselineRuntime(runtime),
      new RegExp(expected),
      expected,
    );
    assert.throws(() => baselineMcpServer(runtime), new RegExp(expected));
  }
});

test("an unreadable baseline reading fails the gate rather than passing it", () => {
  // A gate that treats "could not tell" as "fine" is not a gate.
  const runtime = buildProductionBaselineRuntime(
    baselineProbe({ headCommit: null, statusPorcelain: null, expectedTree: null }),
  );
  assert.equal(runtime.checks["artifact-head-is-baseline-commit"], null);
  assert.equal(runtime.verified, false);
  assert.ok(runtime.failedChecks.includes("artifact-head-is-baseline-commit"));
  assert.ok(runtime.failedChecks.includes("artifact-working-tree-clean"));
  const manifest = buildProductionBaselineRuntime(
    baselineProbe({ runtimeManifest: null }),
  );
  assert.equal(manifest.checks["artifact-runtime-manifest-readable"], false);
  assert.equal(manifest.verified, false);
});

test("the runtime manifest binds dist and dependency bytes, not dependency versions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-runtime-manifest-"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.mkdirSync(path.join(root, "node_modules", "dependency"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { dependency: "1.0.0" } }),
  );
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(root, "dist", "server.js"), "export const value = 1;\n");
  fs.writeFileSync(
    path.join(root, "node_modules", "dependency", "package.json"),
    JSON.stringify({ name: "dependency", version: "1.0.0" }),
  );
  const dependencyFile = path.join(root, "node_modules", "dependency", "index.js");
  fs.writeFileSync(dependencyFile, "export const dependency = 1;\n");

  const clean = buildBaselineRuntimeManifest(root);
  assert.ok(clean !== null);
  fs.writeFileSync(path.join(root, "dist", "server.js"), "export const value = 2;\n");
  const modifiedDist = buildBaselineRuntimeManifest(root);
  assert.ok(modifiedDist !== null);
  assert.notEqual(modifiedDist.aggregateSha256, clean.aggregateSha256);

  fs.writeFileSync(path.join(root, "dist", "server.js"), "export const value = 1;\n");
  fs.writeFileSync(dependencyFile, "export const dependency = 2;\n");
  const modifiedDependency = buildBaselineRuntimeManifest(root);
  assert.ok(modifiedDependency !== null);
  assert.notEqual(modifiedDependency.aggregateSha256, clean.aggregateSha256);
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(root, "node_modules", "dependency", "package.json"),
        "utf8",
      ),
    ).version,
    "1.0.0",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("a post-preflight runtime modification prevents result acceptance", () => {
  const pre = buildProductionBaselineRuntime(baselineProbe());
  const post = buildProductionBaselineRuntime(
    baselineProbe({
      runtimeManifest: {
        ...baselineProbe().runtimeManifest!,
        aggregateSha256: "f".repeat(64),
      },
    }),
  );
  const identity = buildBaselineCellRuntimeIdentity(pre, post);
  assert.equal(pre.verified, true);
  assert.equal(post.verified, false);
  assert.equal(identity.verified, false);
  assert.throws(() => assertBaselineCellRuntimeIdentity(identity), /failed closed/);
  assert.doesNotThrow(() =>
    assertBaselineCellRuntimeIdentity(buildBaselineCellRuntimeIdentity(pre, pre)),
  );
});

test("a V3 snapshot refuses to claim a baseline it cannot show it executed", () => {
  const snapshot = () =>
    buildResultsSnapshot({
      startedAt: "v3-baseline-test",
      reps: 2,
      records: [],
      suite: "v3",
      standardSpeedConfirmed: true,
      pricingProfileConfirmed: true,
      environment: buildEnvironmentRecord(probe()),
      ordering: { mode: "declared", seed: null, sequence: [] },
      methodologyDigest: "c".repeat(64),
    });
  assert.throws(snapshot, /verified production baseline runtime/);
  assert.throws(
    () =>
      buildResultsSnapshot({
        startedAt: "v3-baseline-test",
        reps: 2,
        records: [],
        suite: "v3",
        standardSpeedConfirmed: true,
        pricingProfileConfirmed: true,
        environment: buildEnvironmentRecord(probe()),
        ordering: { mode: "declared", seed: null, sequence: [] },
        methodologyDigest: "c".repeat(64),
        baselineRuntime: buildProductionBaselineRuntime(
          baselineProbe({ packageVersion: "0.12.0" }),
        ),
      }),
    /artifact-package-version-matches/,
  );

  const accepted = buildResultsSnapshot({
    startedAt: "v3-baseline-test",
    reps: 2,
    records: [],
    suite: "v3",
    standardSpeedConfirmed: true,
    pricingProfileConfirmed: true,
    environment: buildEnvironmentRecord(probe()),
    ordering: { mode: "declared", seed: null, sequence: [] },
    methodologyDigest: "c".repeat(64),
    baselineRuntime: buildProductionBaselineRuntime(baselineProbe()),
  });
  assert.equal(accepted.productionBaselineRuntime?.verified, true);
  assert.equal(
    accepted.productionBaselineRuntime?.observed.entryPointSha256,
    "e".repeat(64),
  );
  assert.deepEqual(accepted.productionBaseline, {
    version: BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
    sha: BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
  });
});

// --- Live execution history --------------------------------------------------

const historyFixture = (
  files: Record<string, unknown>,
  checkpoints: Record<string, unknown> = {},
): { resultsDir: string; checkpointsDir: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-history-"));
  const resultsDir = path.join(root, "results");
  const checkpointsDir = path.join(root, "checkpoints");
  fs.mkdirSync(resultsDir);
  fs.mkdirSync(checkpointsDir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(resultsDir, name),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  }
  for (const [name, body] of Object.entries(checkpoints)) {
    fs.writeFileSync(path.join(checkpointsDir, name), JSON.stringify(body));
  }
  return { resultsDir, checkpointsDir };
};

const v3Shard = (campaignId: string, runs: number): Record<string, unknown> => ({
  schema: 4,
  benchmarkVersion: 3,
  suite: "v3",
  campaignId,
  records: Array.from({ length: runs }, (_, index) => ({ taskId: `t${index}` })),
});

const historicalShard = (
  suite: "v2" | "parallel" | "scale" | "legacy",
): Record<string, unknown> => {
  const identity =
    suite === "v2"
      ? { schema: 4, benchmarkVersion: 2, suite: "v2" }
      : suite === "parallel"
        ? { schema: 2, suite: "parallel" }
        : suite === "scale"
          ? { schema: 3, suite: "scale" }
          : { schema: 1 };
  const recordIdentity = suite === "legacy" ? {} : { suite };
  return {
    ...identity,
    ...(suite === "v2" ? { campaignId: "benchmark-v2-regression" } : {}),
    supervisorModel: "gpt-test",
    startedAt: "2026-08-24T00:00:00.000Z",
    reps: 1,
    records: [
      {
        ...recordIdentity,
        ...(suite === "v2" ? { benchmarkVersion: 2 } : {}),
        taskId: `${suite}-task`,
        arm: "solo",
        repetition: 1,
      },
    ],
  };
};

const v3LaunchMarker = (
  campaignId: string,
  completedCells = 0,
): Record<string, unknown> => ({
  schema: V3_LAUNCH_MARKER_SCHEMA,
  benchmarkVersion: 3,
  suite: "v3",
  campaignId,
  methodologyDigest: "a".repeat(64),
  holdoutFreezeSha: "b".repeat(40),
  productionBaseline: {
    version: BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
    sha: BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
    runtimeManifestSha256: BENCHMARK_V3_EXPECTED_RUNTIME_MANIFEST_SHA256,
  },
  startedAt: "2026-08-29T00:00:00.000Z",
  state: "started",
  completedCells: Array.from({ length: completedCells }, (_, index) => ({
    campaignId,
    taskId: `t${index}`,
    arm: "solo-medium",
    repetition: 1,
    completedAt: "2026-08-29T00:01:00.000Z",
  })),
});

test("execution history reports no runs when no V3 evidence exists", () => {
  const history = deriveV3ExecutionHistory("v3-freeze3-20260829", historyFixture({}));
  assert.equal(history.liveV3RunsExecutedToDate, 0);
  assert.equal(history.liveV3RunsForThisCampaign, 0);
  assert.deepEqual(history.campaignIdsWithV3Results, []);
  assert.equal(history.freshLaunch, true);
});

test("the live runner marker exists before cell one and survives abort-before-first-cell", () => {
  const fixture = historyFixture({});
  const campaignId = "v3-freeze3-abort";
  const marker = createV3LaunchMarker(
    fixture.resultsDir,
    {
      campaignId,
      methodologyDigest: "a".repeat(64),
      holdoutFreezeSha: "b".repeat(40),
      productionBaseline: {
        version: BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
        sha: BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
        runtimeManifestSha256: BENCHMARK_V3_EXPECTED_RUNTIME_MANIFEST_SHA256,
      },
    },
    { resume: false, now: new Date("2026-08-29T00:00:00.000Z") },
  );
  assert.equal(marker.completedCells.length, 0);
  const markerFile = path.join(fixture.resultsDir, v3LaunchMarkerFilename(campaignId));
  assert.equal(readV3LaunchMarker(markerFile)?.state, "started");

  // Simulate process death now: no shard and no completed cell ever appears.
  const history = deriveV3ExecutionHistory(campaignId, fixture);
  assert.equal(history.liveV3RunsExecutedToDate, 0);
  assert.equal(history.launchMarkerExistsForThisCampaign, true);
  assert.equal(history.launchMarkers[0]?.completedCellCount, 0);
  assert.equal(history.freshLaunch, false);
  assert.throws(
    () =>
      createV3LaunchMarker(
        fixture.resultsDir,
        {
          campaignId,
          methodologyDigest: "a".repeat(64),
          holdoutFreezeSha: "b".repeat(40),
          productionBaseline: {
            version: BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
            sha: BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
            runtimeManifestSha256: BENCHMARK_V3_EXPECTED_RUNTIME_MANIFEST_SHA256,
          },
        },
        { resume: false },
      ),
    /already launched/,
  );
});

test("current and other campaign launch markers are separate history", () => {
  const current = "v3-freeze3-current";
  const other = "v3-freeze3-other";
  const history = deriveV3ExecutionHistory(
    current,
    historyFixture({
      [`one${V3_LAUNCH_MARKER_SUFFIX}`]: v3LaunchMarker(current),
      [`two${V3_LAUNCH_MARKER_SUFFIX}`]: v3LaunchMarker(other),
    }),
  );
  assert.deepEqual(history.launchMarkerCampaignIds, [current, other]);
  assert.equal(history.launchMarkerExistsForThisCampaign, true);
  assert.equal(history.collidesWithPriorResultCampaignId, false);
  assert.equal(history.freshLaunch, false);
});

test("execution history never reports zero once a V3 result exists", () => {
  const history = deriveV3ExecutionHistory(
    "v3-freeze3-20260829",
    historyFixture({ "2026-09-01T00-00-00-000Z.v3.json": v3Shard("v3-freeze2-x", 36) }),
  );
  assert.equal(history.liveV3RunsExecutedToDate, 36);
  assert.equal(history.liveV3RunsForThisCampaign, 0);
  assert.deepEqual(history.campaignIdsWithV3Results, ["v3-freeze2-x"]);
  assert.deepEqual(history.otherCampaignIdsWithV3Results, ["v3-freeze2-x"]);
  // Another campaign's results are history, not an identity collision.
  assert.equal(history.collidesWithPriorResultCampaignId, false);
  assert.equal(history.freshLaunch, false);
});

test("execution history separates this campaign's own runs and flags reuse", () => {
  const history = deriveV3ExecutionHistory(
    "v3-freeze3-20260829",
    historyFixture({
      "2026-09-01T00-00-00-000Z.v3.json": v3Shard("v3-freeze3-20260829", 12),
    }),
  );
  assert.equal(history.liveV3RunsForThisCampaign, 12);
  assert.equal(history.collidesWithPriorResultCampaignId, true);
  // Twelve of thirty-six is a partial shard and is named as one.
  assert.deepEqual(history.incompleteV3Shards, ["2026-09-01T00-00-00-000Z.v3.json"]);
});

test("an unreadable shard is evidence, not an absence", () => {
  const history = deriveV3ExecutionHistory(
    "v3-freeze3-20260829",
    historyFixture({ "2026-09-01T00-00-00-000Z.v3.json": "{ truncated" }),
  );
  assert.deepEqual(history.unreadableV3Shards, ["2026-09-01T00-00-00-000Z.v3.json"]);
  assert.equal(history.freshLaunch, false);
  assert.equal(history.shards[0]?.runCount, null);
});

test("a readable but malformed V3-named shard is invalid evidence", () => {
  const history = deriveV3ExecutionHistory(
    "v3-freeze3-20260829",
    historyFixture({ "2026-09-01T00-00-00-000Z.v3.json": {} }),
  );
  assert.deepEqual(history.invalidV3Shards, ["2026-09-01T00-00-00-000Z.v3.json"]);
  assert.equal(history.shards[0]?.classification, "invalid");
  assert.equal(history.freshLaunch, false);
});

test("an unreadable V3-named filesystem artifact blocks freshness", () => {
  const fixture = historyFixture({});
  fs.mkdirSync(path.join(fixture.resultsDir, "unreadable.v3.json"));
  const history = deriveV3ExecutionHistory("v3-freeze3-20260829", fixture);
  assert.deepEqual(history.unreadableV3Shards, ["unreadable.v3.json"]);
  assert.equal(history.freshLaunch, false);
});

test("V3 event telemetry counts, and unrelated benchmark files do not", () => {
  const fixture = historyFixture({
    // V2 and older-suite evidence in the same directory must not be counted.
    "2026-08-24T00-00-00-000Z.v2.json": historicalShard("v2"),
    "2026-08-24T00-00-00-000Z.events.jsonl": "{}\n",
    "2026-08-14T00-00-00-000Z.scale.json": historicalShard("scale"),
    "2026-08-14T00-00-00-000Z.events.jsonl": "{}\n",
    // An orphan stream cannot be safely attributed and is ambiguous evidence.
    "2026-08-20T00-00-00-000Z.events.jsonl": "{}\n",
    // A V3 stream beside its shard is V3 execution evidence.
    "2026-09-01T00-00-00-000Z.v3.json": v3Shard("v3-freeze2-x", 1),
    "2026-09-01T00-00-00-000Z.events.jsonl": "{}\n",
  });
  const history = deriveV3ExecutionHistory("v3-freeze3-20260829", fixture);
  assert.equal(history.liveV3RunsExecutedToDate, 1);
  assert.deepEqual(history.v3EventStreamsWithTelemetry, [
    "2026-09-01T00-00-00-000Z.events.jsonl",
  ]);
  const attribution = Object.fromEntries(
    history.eventStreams.map((stream) => [stream.file, stream.attribution]),
  );
  assert.equal(attribution["2026-08-24T00-00-00-000Z.events.jsonl"], "v2");
  assert.equal(attribution["2026-08-14T00-00-00-000Z.events.jsonl"], "other-suite");
  assert.equal(attribution["2026-08-20T00-00-00-000Z.events.jsonl"], "ambiguous");
  assert.deepEqual(history.ambiguousEventStreams, [
    "2026-08-20T00-00-00-000Z.events.jsonl",
  ]);
  assert.equal(history.freshLaunch, false);
  assert.match(history.limitation, /blocks freshness/);
});

test("reviewed historical orphan streams use content identity, not filenames", () => {
  const repositoryHistory = deriveV3ExecutionHistory("v3-freeze3-20260829");
  const reviewed = repositoryHistory.eventStreams.filter(
    (stream) => stream.attribution === "historical-non-v3",
  );
  assert.equal(reviewed.length, 9);
  assert.ok(
    reviewed.every(
      (stream) =>
        stream.contentSha256 !== null &&
        REVIEWED_PRE_V3_EVENT_STREAM_SHA256.has(stream.contentSha256) &&
        stream.attributionEvidence === "reviewed-pre-v3-content-sha256",
    ),
  );
  assert.deepEqual(repositoryHistory.ambiguousEventStreams, []);

  const source = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "bench",
    "results",
    reviewed[0]!.file,
  );
  const content = fs.readFileSync(source, "utf8");
  const renamed = deriveV3ExecutionHistory(
    "v3-freeze3-20260829",
    historyFixture({ "renamed.events.jsonl": content }),
  );
  assert.equal(renamed.eventStreams[0]?.attribution, "historical-non-v3");

  const mutated = deriveV3ExecutionHistory(
    "v3-freeze3-20260829",
    historyFixture({ "renamed.events.jsonl": `${content} ` }),
  );
  assert.equal(mutated.eventStreams[0]?.attribution, "ambiguous");
  assert.equal(mutated.freshLaunch, false);
});

test("misleading historical sibling filenames fail closed", () => {
  const cases = [
    { sibling: "empty.v2.json", body: "", stream: "empty.events.jsonl" },
    {
      sibling: "malformed.scale.json",
      body: "{ truncated",
      stream: "malformed.events.jsonl",
    },
    {
      sibling: "invalid.parallel.json",
      body: { schema: 2, suite: "parallel", records: [1] },
      stream: "invalid.events.jsonl",
    },
  ];

  for (const probe of cases) {
    const history = deriveV3ExecutionHistory(
      "v3-freeze3-20260829",
      historyFixture({ [probe.sibling]: probe.body, [probe.stream]: "{}\n" }),
    );
    assert.equal(history.eventStreams[0]?.attribution, "ambiguous", probe.sibling);
    assert.deepEqual(history.ambiguousEventStreams, [probe.stream], probe.sibling);
    assert.equal(history.freshLaunch, false, probe.sibling);
  }

  const unreadable = historyFixture({ "unreadable.events.jsonl": "{}\n" });
  fs.mkdirSync(path.join(unreadable.resultsDir, "unreadable.scale.json"));
  const unreadableHistory = deriveV3ExecutionHistory("v3-freeze3-20260829", unreadable);
  assert.equal(unreadableHistory.eventStreams[0]?.attribution, "ambiguous");
  assert.equal(unreadableHistory.freshLaunch, false);
});

test("validated historical result contents classify matching streams", () => {
  const history = deriveV3ExecutionHistory(
    "v3-freeze3-20260829",
    historyFixture({
      "v2.v2.json": historicalShard("v2"),
      "v2.events.jsonl": "{}\n",
      "legacy.json": historicalShard("legacy"),
      "legacy.events.jsonl": "{}\n",
      "scale.scale.json": historicalShard("scale"),
      "scale.events.jsonl": "{}\n",
      "parallel.parallel.json": historicalShard("parallel"),
      "parallel.events.jsonl": "{}\n",
    }),
  );
  assert.deepEqual(
    Object.fromEntries(
      history.eventStreams.map((stream) => [stream.file, stream.attribution]),
    ),
    {
      "legacy.events.jsonl": "other-suite",
      "parallel.events.jsonl": "other-suite",
      "scale.events.jsonl": "other-suite",
      "v2.events.jsonl": "v2",
    },
  );
  assert.deepEqual(history.ambiguousEventStreams, []);
  assert.equal(history.freshLaunch, true);
});

test("historical sibling metadata must be internally consistent", () => {
  const inconsistent = historicalShard("v2");
  (inconsistent["records"] as Array<Record<string, unknown>>)[0]!["suite"] = "scale";
  const history = deriveV3ExecutionHistory(
    "v3-freeze3-20260829",
    historyFixture({
      "mismatch.v2.json": inconsistent,
      "mismatch.events.jsonl": "{}\n",
    }),
  );
  assert.equal(history.eventStreams[0]?.attribution, "ambiguous");
  assert.equal(history.freshLaunch, false);
});

test("unrelated V2, parallel, and scale history does not block V3 freshness", () => {
  const history = deriveV3ExecutionHistory(
    "v3-freeze3-20260829",
    historyFixture({
      "v2.v2.json": historicalShard("v2"),
      "v2.events.jsonl": "{}\n",
      "scale.scale.json": historicalShard("scale"),
      "scale.events.jsonl": "{}\n",
      "parallel.parallel.json": historicalShard("parallel"),
      "parallel.events.jsonl": "{}\n",
    }),
  );
  assert.equal(history.freshLaunch, true);
  assert.deepEqual(history.ambiguousEventStreams, []);
});

test("a campaign's own retained checkpoint is not a prior campaign", () => {
  // The self-collision: this generator writes a checkpoint carrying the current
  // campaign ID, so reading checkpoints back as prior campaigns made every
  // checkpoint collide with itself.
  const history = deriveV3ExecutionHistory(
    "v3-freeze3-20260829",
    historyFixture(
      {},
      {
        "v3-freeze3-20260829.prelaunch.json": {
          campaign: { campaignId: "v3-freeze3-20260829" },
        },
        "v3-freeze2-20260829.prelaunch.json": {
          campaign: { campaignId: "v3-freeze2-20260829" },
        },
      },
    ),
  );
  assert.equal(history.collidesWithPriorResultCampaignId, false);
  assert.equal(history.retainedCheckpointExistsForThisCampaign, true);
  assert.deepEqual(history.retainedCheckpointCampaignIds, [
    "v3-freeze2-20260829",
    "v3-freeze3-20260829",
  ]);
  assert.equal(history.freshLaunch, true);
});

test("the checkpoint derives execution history and does not claim it", () => {
  const checkpoint = buildCheckpoint({ campaignId: "v3-checkpoint-test" });
  const campaign = checkpoint.campaign as Record<string, unknown>;
  const history = checkpoint.executionHistory as ReturnType<
    typeof deriveV3ExecutionHistory
  >;
  // The two surfaces read one derivation, so they cannot disagree.
  assert.equal(campaign.liveV3RunsExecutedToDate, history.liveV3RunsExecutedToDate);
  assert.equal(campaign.freshLaunch, history.freshLaunch);
  assert.equal(campaign.collidesWithPriorResultCampaignId, false);
  assert.ok(!Object.hasOwn(campaign, "collidesWithPriorCampaignId"));

  const markdown = renderCheckpoint(checkpoint);
  assert.match(markdown, /## Live execution history/);
  assert.match(
    markdown,
    new RegExp(`Live V3 runs recorded to date \\| ${history.liveV3RunsExecutedToDate}`),
  );
  assert.match(markdown, /Baseline runtime verified/);
});

test("the checkpoint blocks a launch it cannot bind to the baseline", () => {
  const checkpoint = buildCheckpoint({ campaignId: "v3-checkpoint-test" });
  const blockers = checkpoint.blockers as Array<{ id: string }>;
  const runtime = checkpoint.productionBaselineRuntime as Record<string, unknown>;
  assert.equal(runtime.dependsOnExternalMcpRegistration, false);
  // Whether the artifact happens to be provisioned on this machine or not, the
  // checkpoint's blocker set and its verified flag must agree.
  assert.equal(
    blockers.some((blocker) => blocker.id === "production-baseline-runtime-unverified"),
    runtime.verified !== true,
  );
  assert.equal(checkpoint.launchReadiness, "blocked");
});

test("checkpoint arguments are parsed strictly", () => {
  assert.deepEqual(parsePrelaunchArgs(["--campaign", "c1", "--verify-exit", "0"]), {
    campaignId: "c1",
    verifyExit: 0,
    force: false,
  });
  assert.deepEqual(parsePrelaunchArgs([]), { force: false });
  assert.throws(() => parsePrelaunchArgs(["--verify-exit", "passed"]), /--verify-exit/);
});

test("forced checkpoint replacement preserves the superseded JSON and Markdown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-checkpoint-ledger-"));
  const json = path.join(root, "campaign.prelaunch.json");
  const markdown = path.join(root, "campaign.prelaunch.md");
  fs.writeFileSync(json, "old-json");
  fs.writeFileSync(markdown, "old-markdown");
  const moved = preserveSupersededCheckpointFiles(
    [json, markdown],
    root,
    new Date("2026-08-29T12:34:56.789Z"),
  );
  assert.equal(moved.length, 2);
  assert.equal(fs.existsSync(json), false);
  assert.equal(fs.existsSync(markdown), false);
  assert.deepEqual(moved.map((file) => fs.readFileSync(file, "utf8")).sort(), [
    "old-json",
    "old-markdown",
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});
