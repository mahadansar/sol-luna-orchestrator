/**
 * Benchmark harness tests.
 *
 * The harness produces the numbers this project makes claims from, so its
 * measurement logic is worth testing as carefully as the runtime. All offline:
 * no model calls, no benchmark execution.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyTradeoff,
  percentageDelta,
  recommendThirdRepetition,
  summarizeCell,
} from "./bench/analysis.js";
import { loadV2Campaign, loadV3Campaign } from "./bench/analyze.js";
import {
  assertCampaignCompatibility,
  collectCompletedCampaignCells,
  planCampaignCells,
  readCampaignShards,
  type CampaignCell,
  type LoadedCampaignShard,
} from "./bench/campaign.js";
import {
  ARMS,
  FORCED_CAMPAIGN_TASK_IDS,
  SUITES,
  assertStandardSpeedConfirmed,
  assertV3CampaignPolicy,
  assertV3PricingProfileConfirmed,
  buildRunCreditAccounting,
  buildResultsSnapshot,
  checkpointResultsShard,
  currentCampaignCompatibility,
  parseArgs,
  peakOverlap,
  readTelemetry,
  type RunRecord,
} from "./bench/run.js";
import { SCALE_SOLUTIONS } from "./bench/scale-solutions.js";
import { SCALE_TASKS } from "./bench/scale-tasks.js";
import type { BenchTask } from "./bench/tasks.js";
import { V2_SOLUTIONS } from "./bench/v2-solutions.js";
import { V2_TASKS } from "./bench/v2-tasks.js";
import { V3_SOLUTIONS } from "./bench/v3-solutions.js";
import {
  BENCHMARK_V3_FREEZE_SHA,
  BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
  BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
  V3_TASKS,
} from "./bench/v3-tasks.js";
import { buildEnvironmentRecord } from "./bench/environment.js";
import {
  BASELINE_RUNTIME_MANIFEST_SCHEMA,
  BENCHMARK_V3_EXPECTED_RUNTIME_MANIFEST_SHA256,
  buildBaselineCellRuntimeIdentity,
  buildProductionBaselineRuntime,
  type BaselineRuntimeProbe,
} from "./bench/baseline.js";
import { repriceHistoricalRecord, renderReport } from "./bench/report.js";

// --- Concurrency measurement ------------------------------------------------

test("workers that never overlap peak at one", () => {
  assert.equal(
    peakOverlap([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]),
    1,
  );
});

test("a worker starting exactly as another ends is not concurrent", () => {
  assert.equal(
    peakOverlap([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ]),
    1,
  );
});

test("overlapping workers are counted together", () => {
  assert.equal(
    peakOverlap([
      { start: 0, end: 10 },
      { start: 5, end: 15 },
    ]),
    2,
  );
});

test("peak reflects the busiest instant, not the total", () => {
  assert.equal(
    peakOverlap([
      { start: 0, end: 100 },
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]),
    2,
  );
});

test("a fully parallel batch peaks at its worker count", () => {
  assert.equal(
    peakOverlap([
      { start: 0, end: 90 },
      { start: 1, end: 88 },
      { start: 2, end: 95 },
      { start: 1, end: 70 },
    ]),
    4,
  );
});

test("no workers means no measurable peak", () => {
  assert.equal(peakOverlap([]), 0);
});

// --- Overhead decomposition -------------------------------------------------

const at = (seconds: number): string =>
  new Date(1_000_000 + seconds * 1000).toISOString();

function writeEvents(lines: object[]): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bench-events-")),
    "events.jsonl",
  );
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

const USAGE = {
  inputTokens: 20,
  cachedInputTokens: 2,
  outputTokens: 4,
  reasoningOutputTokens: 1,
};

/**
 * The two rows a modern `delegate_task` writes for one delegation, in the order
 * the server writes them and carrying the thread id both representations have
 * always recorded. `thread: null` reproduces a worker that died before its
 * Codex thread started, which is the only case with no identity to match on.
 */
function modernSingle(options: {
  batchId: string;
  second: number;
  effort: string;
  thread: string | null;
  verdict?: string;
  durationSeconds?: number;
  attempt?: number;
  completed?: boolean;
}): object[] {
  const { batchId, second, effort, thread } = options;
  const verdict = options.verdict ?? "PASS";
  const durationSeconds = options.durationSeconds ?? 12;
  const lifecycle: object[] = [
    {
      timestamp: at(second),
      type: "batch.started",
      batchId,
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    { timestamp: at(second), type: "task.queued", batchId, taskId: "t1", effort },
    {
      timestamp: at(second + 1),
      type: "worker.started",
      batchId,
      taskId: "t1",
      effort,
    },
  ];

  if (options.completed === false) {
    lifecycle.push(
      { timestamp: at(second + 2), type: "worker.cancelled", batchId, taskId: "t1" },
      {
        timestamp: at(second + 2),
        type: "batch.cancelled",
        batchId,
        reason: "worker cancelled",
      },
    );
  } else {
    lifecycle.push({
      timestamp: at(second + 2),
      type: "worker.completed",
      batchId,
      taskId: "t1",
      model: "gpt-5.6-luna",
      effort,
      verdict,
      durationSeconds,
      threadId: thread,
      usage: USAGE,
    });
  }

  lifecycle.push({
    timestamp: at(second + 3),
    model: "gpt-5.6-luna",
    effort,
    attempt: options.attempt ?? 1,
    verdict,
    workerThreadId: thread,
    durationSeconds,
    usage: USAGE,
  });
  return lifecycle;
}

test("modern single lifecycle telemetry supersedes its legacy completion row", () => {
  const file = writeEvents(
    modernSingle({ batchId: "single-1", second: 1, effort: "high", thread: "thread_1" }),
  );

  const telemetry = readTelemetry(file, 0, 1_000_000, 1_100_000);
  assert.equal(telemetry.delegations.length, 1);
  assert.deepEqual(telemetry.efforts, ["high"]);
  assert.equal(telemetry.delegations[0]?.taskId, "t1");
  assert.equal(telemetry.delegations[0]?.workerThreadId, "thread_1");
  assert.equal(telemetry.delegations[0]?.usage?.outputTokens, 4);
});

test("a separate historical delegation is kept even when its fields collide", () => {
  // Same effort, verdict, duration and usage as the modern pair below, from a
  // different worker thread. Attribute equality is not identity.
  const file = writeEvents([
    {
      timestamp: at(1),
      model: "gpt-5.6-luna",
      effort: "high",
      attempt: 3,
      verdict: "PASS",
      workerThreadId: "thread_historical",
      durationSeconds: 12,
      usage: USAGE,
    },
    ...modernSingle({
      batchId: "single-2",
      second: 10,
      effort: "high",
      thread: "thread_modern",
    }),
  ]);

  const telemetry = readTelemetry(file, 0, 1_000_000, 1_100_000);
  assert.equal(telemetry.delegations.length, 2);
  assert.deepEqual(telemetry.efforts, ["high", "high"]);
  assert.ok(
    telemetry.delegations.some((record) => record.attempt === 3),
    "the historical row itself must survive, not merely its count",
  );
});

test("a modern single with no completion is counted once, effort included", () => {
  const file = writeEvents(
    modernSingle({
      batchId: "single-3",
      second: 1,
      effort: "xhigh",
      thread: "thread_cancelled",
      verdict: "FAILED",
      completed: false,
    }),
  );

  const telemetry = readTelemetry(file, 0, 1_000_000, 1_100_000);
  assert.equal(telemetry.delegations.length, 1);
  assert.deepEqual(telemetry.efforts, ["xhigh"]);
});

test("a pair with no thread id on either side still reconciles", () => {
  const file = writeEvents(
    modernSingle({ batchId: "single-4", second: 1, effort: "medium", thread: null }),
  );

  const telemetry = readTelemetry(file, 0, 1_000_000, 1_100_000);
  assert.equal(telemetry.delegations.length, 1);
  assert.deepEqual(telemetry.efforts, ["medium"]);
});

test("an identity-less legacy row before a completion is not folded into it", () => {
  const file = writeEvents([
    {
      timestamp: at(1),
      model: "gpt-5.6-luna",
      effort: "medium",
      attempt: 1,
      verdict: "PASS",
      durationSeconds: 12,
      usage: USAGE,
    },
    ...modernSingle({ batchId: "single-5", second: 10, effort: "medium", thread: null }),
  ]);

  const telemetry = readTelemetry(file, 0, 1_000_000, 1_100_000);
  assert.equal(telemetry.delegations.length, 2);
  assert.deepEqual(telemetry.efforts, ["medium", "medium"]);
});

test("legacy typeless-only single telemetry remains readable", () => {
  const file = writeEvents([
    {
      timestamp: at(1),
      model: "gpt-5.6-luna",
      effort: "medium",
      attempt: 2,
      verdict: "FAILED",
      durationSeconds: 9,
      usage: USAGE,
    },
  ]);

  const telemetry = readTelemetry(file, 0, 1_000_000, 1_100_000);
  assert.equal(telemetry.delegations.length, 1);
  assert.deepEqual(telemetry.efforts, ["medium"]);
  assert.equal(telemetry.delegations[0]?.attempt, 2);
  assert.equal(telemetry.delegations[0]?.usage?.outputTokens, 4);
});

test("typed batch telemetry is not reconciled with a legacy single row", () => {
  const file = writeEvents([
    {
      timestamp: at(1),
      type: "batch.started",
      batchId: "batch-1",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: at(2),
      type: "task.queued",
      batchId: "batch-1",
      taskId: "t1",
      effort: "high",
    },
    {
      timestamp: at(3),
      type: "worker.completed",
      batchId: "batch-1",
      taskId: "t1",
      effort: "high",
      verdict: "PASS",
      durationSeconds: 12,
      usage: USAGE,
    },
    {
      timestamp: at(4),
      effort: "high",
      attempt: 1,
      verdict: "PASS",
      durationSeconds: 12,
      usage: USAGE,
    },
  ]);

  const telemetry = readTelemetry(file, 0, 1_000_000, 1_100_000);
  assert.equal(telemetry.delegations.length, 2);
  assert.deepEqual(telemetry.efforts, ["high", "high"]);
});

test("the breakdown splits a run into supervisor, setup, workers and integration", () => {
  const file = writeEvents([
    {
      timestamp: at(10),
      type: "batch.started",
      mode: "parallel",
      taskCount: 2,
      maxParallel: 2,
    },
    { timestamp: at(11), type: "task.queued", taskId: "t1", effort: "high" },
    { timestamp: at(11), type: "task.queued", taskId: "t2", effort: "medium" },
    { timestamp: at(12), type: "worktree.created", taskId: "t1", path: "/a" },
    { timestamp: at(14), type: "worktree.created", taskId: "t2", path: "/b" },
    { timestamp: at(15), type: "worker.started", taskId: "t1", effort: "high" },
    { timestamp: at(15), type: "worker.started", taskId: "t2", effort: "medium" },
    {
      timestamp: at(70),
      type: "worker.completed",
      taskId: "t2",
      verdict: "PASS",
      effort: "medium",
      durationSeconds: 55,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 2,
        reasoningOutputTokens: 1,
      },
    },
    {
      timestamp: at(95),
      type: "worker.completed",
      taskId: "t1",
      verdict: "PASS",
      effort: "high",
      durationSeconds: 80,
      usage: {
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 4,
        reasoningOutputTokens: 2,
      },
    },
    {
      timestamp: at(99),
      type: "batch.completed",
      durationSeconds: 89,
      passed: 2,
      failed: 0,
    },
  ]);

  // Run started 10s before the batch and ended 21s after it.
  const telemetry = readTelemetry(file, 0, 1_000_000, 1_000_000 + 120_000);
  const b = telemetry.breakdown;

  assert.equal(
    b.supervisorBeforeSeconds,
    10,
    "time before the batch is the supervisor's",
  );
  assert.equal(b.worktreeSetupSeconds, 4, "batch start to the last worktree");
  assert.equal(b.workerWindowSeconds, 80, "first worker start to last completion");
  assert.equal(b.slowestWorkerSeconds, 80);
  assert.equal(b.integrationSeconds, 4, "last worker to batch completion");
  assert.equal(b.supervisorAfterSeconds, 21, "review after the batch");
  assert.equal(b.peakConcurrency, 2);

  assert.deepEqual(telemetry.efforts, ["high", "medium"]);
  assert.equal(telemetry.delegations.length, 2);
  assert.equal(telemetry.delegations[0]?.usage?.inputTokens, 10);
});

test("the breakdown is null rather than zero when a phase was never observed", () => {
  const file = writeEvents([
    { timestamp: at(1), type: "batch.rejected", reason: "nope" },
  ]);
  const b = readTelemetry(file, 0, 1_000_000, 1_000_000 + 5000).breakdown;
  assert.equal(b.workerWindowSeconds, null);
  assert.equal(b.peakConcurrency, null);
  assert.equal(b.slowestWorkerSeconds, null);
});

test("verification failures and worker failures are counted, not lost", () => {
  const file = writeEvents([
    {
      timestamp: at(1),
      type: "batch.started",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: at(2),
      type: "verification.completed",
      taskId: "t1",
      passed: 1,
      failed: 2,
      refused: 1,
    },
    {
      timestamp: at(3),
      type: "worker.failed",
      taskId: "t2",
      reason: "Could not create an isolated worktree: boom",
    },
    {
      timestamp: at(4),
      type: "integration.conflict",
      path: "src/a.ts",
      tasks: ["t1", "t2"],
    },
  ]);
  const t = readTelemetry(file, 0, 1_000_000, 1_000_000 + 5000);
  assert.equal(t.verificationFailed, 2);
  assert.equal(t.verificationRefused, 1);
  assert.equal(t.integrationConflicts, 1);
  assert.equal(t.workerFailures.length, 1);
  assert.match(t.workerFailures[0]!, /isolated worktree/);
});

test("only events after the offset are read, so runs do not bleed into each other", () => {
  const first = { timestamp: at(1), type: "task.queued", taskId: "old", effort: "max" };
  const second = {
    timestamp: at(2),
    type: "task.queued",
    taskId: "new",
    effort: "medium",
  };
  const file = writeEvents([first, second]);
  const offset = Buffer.byteLength(JSON.stringify(first) + "\n");
  assert.deepEqual(readTelemetry(file, offset, 1_000_000, 1_000_000 + 1000).efforts, [
    "medium",
  ]);
});

// --- Fixture integrity ------------------------------------------------------

const allTasks: BenchTask[] = Object.values(SUITES).flat();

test("every fixture protects its own specification", () => {
  for (const task of allTasks) {
    const specs = Object.keys(task.files).filter((name) => /test/.test(name));
    for (const spec of specs) {
      assert.ok(
        task.immutable.includes(spec),
        `${task.id}: ${spec} is the specification but is not immutable, so a run could edit it`,
      );
    }
  }
});

test("every fixture has at least one grading command", () => {
  for (const task of allTasks) {
    assert.ok(task.grade.length > 0, `${task.id} has no grade command`);
  }
});

test("scale fixtures declare their tier and stream count", () => {
  for (const task of SCALE_TASKS) {
    assert.ok(task.tier, `${task.id} has no tier`);
    assert.ok(
      typeof task.streams === "number" && task.streams >= 1,
      `${task.id} has no stream count`,
    );
  }
});

test("every scale fixture has a reference solution for each module it ships", () => {
  for (const task of SCALE_TASKS) {
    const solution = SCALE_SOLUTIONS[task.id];
    assert.ok(solution, `${task.id} has no reference solution`);
    const stubs = Object.keys(task.files).filter((name) => name.startsWith("src/"));
    assert.deepEqual(
      Object.keys(solution).sort(),
      stubs.sort(),
      `${task.id}: reference solution and shipped modules disagree`,
    );
  }
});

test("a fixture's stream count matches the modules it asks for", () => {
  for (const task of SCALE_TASKS) {
    const modules = Object.keys(task.files).filter((name) => name.startsWith("src/"));
    assert.equal(
      modules.length,
      task.streams,
      `${task.id} declares ${task.streams} streams but ships ${modules.length} modules`,
    );
  }
});

test("every module a fixture ships is named in its objective", () => {
  for (const task of SCALE_TASKS) {
    for (const name of Object.keys(task.files).filter((f) => f.startsWith("src/"))) {
      assert.ok(
        task.objective.includes(name),
        `${task.id}: ${name} is never mentioned in the objective`,
      );
    }
  }
});

test("V2 has the predeclared workload mix and reference solutions", () => {
  assert.equal(V2_TASKS.length, 8);
  const counts = new Map<string, number>();
  for (const task of V2_TASKS) {
    counts.set(task.workloadClass, (counts.get(task.workloadClass) ?? 0) + 1);
    assert.ok(V2_SOLUTIONS[task.id], `${task.id} has no V2 reference solution`);
  }
  assert.deepEqual(Object.fromEntries(counts), {
    small: 2,
    medium: 2,
    "delegation-friendly": 3,
    coupled: 1,
  });
});

test("V3 has the frozen routing mix, hidden references, and no model-facing routing hints", () => {
  assert.equal(V3_TASKS.length, 9);
  const counts = new Map<string, number>();
  for (const task of V3_TASKS) {
    counts.set(task.routingCategory, (counts.get(task.routingCategory) ?? 0) + 1);
    assert.ok(V3_SOLUTIONS[task.id], `${task.id} has no V3 reference solution`);
    assert.doesNotMatch(
      task.objective,
      /expected-solo|likely-solo|delegation-candidate|routing category|\bworkers?\b|\bdelegat/i,
      `${task.id} leaks evaluator routing guidance into its objective`,
    );
  }
  assert.deepEqual(Object.fromEntries(counts), {
    "expected-solo": 2,
    "likely-solo": 2,
    "strong-delegation-candidate": 2,
    "delegation-candidate": 1,
    ambiguous: 2,
  });
});

test("V3 coupled controls stay architecturally central and candidates expose real seams", () => {
  const coupled = V3_TASKS.filter((task) => task.workloadClass === "coupled-control");
  assert.equal(coupled.length, 2);
  assert.ok(coupled.every((task) => task.streams === 1));
  const candidates = V3_TASKS.filter(
    (task) => task.workloadClass === "delegation-candidate",
  );
  assert.equal(candidates.length, 3);
  for (const task of candidates) {
    const modules = Object.keys(task.files).filter((name) => name.startsWith("src/"));
    assert.ok(task.requiresGit, `${task.id} must support isolated worker worktrees`);
    assert.ok(
      modules.length >= 3,
      `${task.id} lacks substantial independent module seams`,
    );
    assert.equal(task.streams, modules.length);
  }
});

test("the initial forced campaign contains one natural single and three parallel tasks", () => {
  assert.equal(FORCED_CAMPAIGN_TASK_IDS.length, 4);
  const tasks = FORCED_CAMPAIGN_TASK_IDS.map((id) =>
    V2_TASKS.find((task) => task.id === id),
  );
  assert.ok(tasks.every(Boolean));
  assert.deepEqual(
    tasks.map((task) => task!.forcedDelegation.mode),
    ["single", "parallel", "parallel", "parallel"],
  );
  assert.equal(
    V2_TASKS.find((task) => task.workloadClass === "coupled")!.forcedDelegation.mode,
    "none",
  );
});

const metricRecord = (options: {
  arm: RunRecord["arm"];
  repetition: number;
  passed?: boolean;
  credits?: number | null;
  duration?: number;
  workers?: number;
}): RunRecord => ({
  benchmarkVersion: 2,
  suite: "v2",
  taskId: "fixture",
  taskCategory: "medium",
  workloadClass: "medium",
  tier: "B",
  streams: 1,
  maxParallelConfigured: options.workers ? 1 : null,
  arm: options.arm,
  armLabel: String(options.arm),
  supervisorEffort: "medium",
  repetition: options.repetition,
  startedAt: at(options.repetition),
  durationSeconds: options.duration ?? 100,
  passed: options.passed ?? true,
  grades: [],
  immutableViolations: [],
  mutationCaught: null,
  supervisorUsage: {
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 10,
    reasoningOutputTokens: 2,
  },
  delegations: [],
  workerCount: options.workers ?? 0,
  workerEfforts: options.workers ? ["medium"] : [],
  batches: [],
  integrationConflicts: 0,
  breakdown: { ...EMPTY_METRIC_BREAKDOWN },
  verificationFailed: 0,
  verificationRefused: 0,
  workerFailures: [],
  agentError: null,
  creditAccounting: {
    pricingProfileId: "benchmark-v2-chatgpt-plus-codex-credits-2026-08-24",
    actualCredits: null,
    participants: [
      {
        role: "supervisor",
        taskId: null,
        workerThreadId: null,
        model: "gpt-5.6-sol",
        effort: "medium",
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 10,
        reasoningOutputTokens: 2,
        cacheWriteInputTokens: null,
        rateCardCredits: options.credits === undefined ? 10 : options.credits,
        durationSeconds: null,
      },
    ],
    rateCardCredits: {
      total: options.credits === undefined ? 10 : options.credits,
      sol: options.credits === undefined ? 10 : options.credits,
      luna: 0,
    },
  },
});

const EMPTY_METRIC_BREAKDOWN = {
  supervisorBeforeSeconds: null,
  worktreeSetupSeconds: null,
  workerWindowSeconds: null,
  slowestWorkerSeconds: null,
  integrationSeconds: null,
  supervisorAfterSeconds: null,
  peakConcurrency: null,
};

test("percentage deltas preserve direction and reject a zero baseline", () => {
  assert.equal(percentageDelta(10, 7), -30);
  assert.equal(percentageDelta(10, 12), 20);
  assert.equal(percentageDelta(0, 1), null);
  assert.equal(percentageDelta(null, 1), null);
});

test("supervisor-only accounting persists one participant and zero Luna credits", () => {
  const accounting = buildRunCreditAccounting({
    supervisorUsage: {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      cacheWriteInputTokens: 40_000,
    },
    supervisorEffort: "medium",
    delegations: [],
  });
  assert.equal(accounting.participants.length, 1);
  assert.deepEqual(accounting.participants[0], {
    role: "supervisor",
    taskId: null,
    workerThreadId: null,
    model: "gpt-5.6-sol",
    effort: "medium",
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    cacheWriteInputTokens: 40_000,
    rateCardCredits: 125,
    durationSeconds: null,
  });
  assert.deepEqual(accounting.rateCardCredits, { total: 125, sol: 125, luna: 0 });
});

test("individual Luna workers retain effort, identity, credits, and duration", () => {
  const accounting = buildRunCreditAccounting({
    supervisorUsage: {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    },
    supervisorEffort: "medium",
    delegations: [
      {
        taskId: "t1",
        workerThreadId: "thread-medium",
        model: "gpt-5.6-luna",
        effort: "medium",
        verdict: "PASS",
        attempt: 1,
        durationSeconds: 70,
        usage: {
          inputTokens: 1_000_000,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        },
      },
      {
        taskId: "t2",
        workerThreadId: "thread-high",
        model: "gpt-5.6-luna",
        effort: "high",
        verdict: "PASS",
        attempt: 1,
        durationSeconds: 90,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 300_000,
        },
      },
    ],
  });
  const [, medium, high] = accounting.participants;
  assert.equal(medium?.effort, "medium");
  assert.equal(medium?.taskId, "t1");
  assert.equal(medium?.workerThreadId, "thread-medium");
  assert.equal(medium?.rateCardCredits, 5);
  assert.equal(medium?.durationSeconds, 70);
  assert.equal(high?.effort, "high");
  assert.equal(high?.rateCardCredits, 30);
  assert.equal(high?.durationSeconds, 90);
  assert.deepEqual(accounting.rateCardCredits, { total: 160, sol: 125, luna: 35 });
  assert.equal(
    accounting.participants.reduce(
      (total, participant) => total + (participant.rateCardCredits ?? 0),
      0,
    ),
    accounting.rateCardCredits.total,
  );
});

test("missing worker usage makes worker, Luna, and run credits unknown", () => {
  const accounting = buildRunCreditAccounting({
    supervisorUsage: {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    },
    supervisorEffort: "medium",
    delegations: [
      {
        taskId: "t1",
        workerThreadId: null,
        model: "gpt-5.6-luna",
        effort: "high",
        verdict: "FAILED",
        attempt: 1,
        durationSeconds: null,
        usage: null,
      },
    ],
  });
  assert.equal(accounting.participants[0]?.rateCardCredits, 125);
  assert.equal(accounting.participants[1]?.rateCardCredits, null);
  assert.equal(accounting.rateCardCredits.sol, 125);
  assert.equal(accounting.rateCardCredits.luna, null);
  assert.equal(accounting.rateCardCredits.total, null);
});

test("participant report exposes model, effort, credits, and separate durations", () => {
  const record = metricRecord({
    arm: "adaptive-medium",
    repetition: 1,
    duration: 100,
    workers: 2,
  });
  record.delegations = [
    {
      taskId: "t1",
      workerThreadId: "thread-1",
      model: "gpt-5.6-luna",
      effort: "medium",
      verdict: "PASS",
      attempt: 1,
      durationSeconds: 70,
      usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
    },
    {
      taskId: "t2",
      workerThreadId: "thread-2",
      model: "gpt-5.6-luna",
      effort: "high",
      verdict: "PASS",
      attempt: 1,
      durationSeconds: 90,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 },
    },
  ];
  record.creditAccounting = buildRunCreditAccounting({
    supervisorUsage: {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    },
    supervisorEffort: "medium",
    delegations: record.delegations,
  });
  const report = renderReport({ schema: 4, records: [record] });
  assert.match(report, /gpt-5\.6-sol \/ medium[^\n]*125/);
  assert.match(report, /task t1[^\n]*gpt-5\.6-luna \/ medium[^\n]*5[^\n]*70s/);
  assert.match(report, /task t2[^\n]*gpt-5\.6-luna \/ high[^\n]*30[^\n]*90s/);
  assert.match(report, /Run total[^\n]*160[^\n]*100s/);
  assert.doesNotMatch(report, /Run total[^\n]*160s/);
});

test("schema 4 snapshots embed the versioned pricing profile", () => {
  const record = metricRecord({ arm: "solo-medium", repetition: 1 });
  const snapshot = buildResultsSnapshot({
    startedAt: "2026-08-24T00-00-00-000Z",
    reps: 2,
    records: [record],
    standardSpeedConfirmed: true,
  });
  assert.equal(snapshot.schema, 4);
  assert.equal(snapshot.benchmarkVersion, 2);
  assert.equal(snapshot.supervisorModel, "gpt-5.6-sol");
  assert.equal(snapshot.supervisorEffort, "medium");
  assert.deepEqual(snapshot.executionProfile, {
    speedMode: "standard",
    fastModeDisabled: true,
    serviceTier: null,
    serviceTierStatus: "not-exposed-by-codex-sdk",
    sdkSpeedPinningSupported: false,
    enforcement: "operator-confirmed-pre-run",
  });
  assert.equal(
    snapshot.pricingProfile.profileId,
    record.creditAccounting?.pricingProfileId,
  );
  assert.notEqual(snapshot.pricingProfile, snapshot.records[0]?.creditAccounting);
  assert.match(renderReport(snapshot), /Codex speed: standard/);
  assert.match(renderReport(snapshot), /SDK pinning: unsupported/);
});

test("Benchmark V2 refuses to start or snapshot without standard-speed confirmation", () => {
  assert.throws(() => assertStandardSpeedConfirmed(false), /Disable Fast mode/);
  assert.doesNotThrow(() => assertStandardSpeedConfirmed(true));
  assert.throws(
    () =>
      buildResultsSnapshot({
        startedAt: "unconfirmed",
        reps: 2,
        records: [],
        standardSpeedConfirmed: false,
      }),
    /confirm-standard-speed/,
  );
});

/**
 * A baseline artifact that passes every binding check.
 *
 * Written as raw readings rather than by touching a real worktree, so the
 * verification rules are exercised without provisioning one. The mismatch cases
 * live in `src/bench/harness.test.ts`.
 */
const verifiedBaselineProbe = (
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

/**
 * The launch evidence every V3 snapshot now carries. The rules that produce and
 * enforce it are covered in `src/bench/harness.test.ts`; tests below supply it
 * so they can keep asserting what they were written to assert.
 */
const V3_LAUNCH_EVIDENCE = {
  environment: buildEnvironmentRecord({
    capturedAt: "2026-08-29T00:00:00.000Z",
    gitCommit: "b".repeat(40),
    gitBranch: "main",
    gitStatusPorcelain: "",
    gitDescribe: "v0.10.0",
    nodeVersion: "v22.12.0",
    npmVersion: "11.12.1",
    codexCliVersion: "0.149.1",
    codexSdkVersion: "0.147.0",
    packageVersion: "0.10.0",
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.26200",
    cpuCount: 8,
    totalMemoryBytes: 1,
    timezone: "UTC",
    argv: [],
    cwd: "D:\\repo",
    environment: {},
  }),
  ordering: { mode: "declared" as const, seed: null, sequence: [] },
  methodologyDigest: "c".repeat(64),
  baselineRuntime: buildProductionBaselineRuntime(verifiedBaselineProbe()),
};

const V3_SEALED_CELL_IDENTITY = buildBaselineCellRuntimeIdentity(
  buildProductionBaselineRuntime(verifiedBaselineProbe()),
  buildProductionBaselineRuntime(verifiedBaselineProbe()),
);

test("Benchmark V3 requires an explicit pre-campaign pricing revalidation", () => {
  assert.throws(() => assertV3PricingProfileConfirmed(false), /credit-rate profile/);
  assert.doesNotThrow(() => assertV3PricingProfileConfirmed(true));
  assert.throws(
    () =>
      buildResultsSnapshot({
        startedAt: "v3-unconfirmed",
        reps: 2,
        records: [],
        suite: "v3",
        standardSpeedConfirmed: true,
      }),
    /confirm-pricing-profile/,
  );
  const snapshot = buildResultsSnapshot({
    startedAt: "v3-confirmed",
    reps: 2,
    records: [],
    suite: "v3",
    standardSpeedConfirmed: true,
    pricingProfileConfirmed: true,
    ...V3_LAUNCH_EVIDENCE,
  });
  assert.equal(snapshot.benchmarkVersion, 3);
  assert.equal(snapshot.suite, "v3");
  assert.equal(snapshot.holdoutFreezeSha, BENCHMARK_V3_FREEZE_SHA);
  assert.deepEqual(snapshot.productionBaseline, {
    version: BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
    sha: BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
  });
});

test("the V3 production baseline is the released tag commit, not the freeze commit", () => {
  // The two pins answer different questions: which methodology was reviewed,
  // and which released product the campaign evaluates. Equal values would mean
  // one of them had been repointed at the other.
  assert.equal(BENCHMARK_V3_PRODUCTION_BASELINE_VERSION, "0.11.0");
  assert.match(BENCHMARK_V3_PRODUCTION_BASELINE_SHA, /^[0-9a-f]{40}$/);
  assert.notEqual(BENCHMARK_V3_PRODUCTION_BASELINE_SHA, BENCHMARK_V3_FREEZE_SHA);
});

test("Benchmark V3 enforces the frozen normal-arm repetition policy", () => {
  assert.doesNotThrow(() =>
    assertV3CampaignPolicy({
      reps: 2,
      arms: ["solo-medium", "adaptive-medium"],
      resume: false,
    }),
  );
  assert.doesNotThrow(() =>
    assertV3CampaignPolicy({ reps: 3, arms: ["adaptive-medium"], resume: true }),
  );
  assert.throws(
    () => assertV3CampaignPolicy({ reps: 1, arms: ["solo-medium"], resume: false }),
    /exactly 2 initial repetitions/,
  );
  assert.throws(
    () => assertV3CampaignPolicy({ reps: 3, arms: ["adaptive-medium"], resume: false }),
    /reviewed recommendation.*--resume/,
  );
  assert.throws(
    () => assertV3CampaignPolicy({ reps: 2, arms: ["forced-delegation"], resume: false }),
    /not a Benchmark V3 campaign arm/,
  );
});

test("campaign arguments default to the 32-run baseline and preserve campaign IDs", () => {
  assert.deepEqual(parseArgs([]).arms, ["solo-medium", "adaptive-medium"]);
  assert.equal(parseArgs([]).reps, 2);
  assert.equal(parseArgs([]).standardSpeedConfirmed, false);
  assert.equal(parseArgs(["--confirm-standard-speed"]).standardSpeedConfirmed, true);
  assert.equal(parseArgs([]).pricingProfileConfirmed, false);
  assert.equal(parseArgs(["--confirm-pricing-profile"]).pricingProfileConfirmed, true);
  assert.equal(parseArgs([]).resume, false);
  assert.equal(parseArgs(["--resume"]).resume, true);
  assert.equal(
    parseArgs(["--campaign", "benchmark-v2-initial"]).campaignId,
    "benchmark-v2-initial",
  );
  assert.deepEqual(parseArgs(["--arms", "forced-delegation"]).arms, [
    "forced-delegation",
  ]);
});

const campaignCell = (taskId: string, arm: string, repetition: number): CampaignCell => ({
  campaignId: "campaign-a",
  taskId,
  arm,
  repetition,
});

const loadedShard = (file: string, records: RunRecord[]): LoadedCampaignShard => ({
  file,
  data: JSON.parse(
    JSON.stringify(
      buildResultsSnapshot({
        startedAt: file,
        campaignId: "campaign-a",
        reps: 2,
        records,
        standardSpeedConfirmed: true,
      }),
    ),
  ) as LoadedCampaignShard["data"],
});

test("fresh and non-overlapping campaign phases proceed without resume", () => {
  const freshPlanned = [campaignCell("fixture", "solo-medium", 1)];
  const fresh = planCampaignCells({
    planned: freshPlanned,
    completed: [],
    resume: false,
  });
  assert.equal(fresh.completed.length, 0);
  assert.deepEqual(fresh.remaining, freshPlanned);

  const existing = [
    campaignCell("fixture", "solo-medium", 1),
    campaignCell("fixture", "adaptive-medium", 1),
  ];
  const forced = [campaignCell("fixture", "forced-delegation", 1)];
  const secondPhase = planCampaignCells({
    planned: forced,
    completed: existing,
    resume: false,
  });
  assert.deepEqual(secondPhase.remaining, forced);
  assert.equal(secondPhase.completed.length, 0);
});

test("ordinary reruns refuse overlap while resume selects only missing cells", () => {
  const planned = [
    campaignCell("fixture", "solo-medium", 1),
    campaignCell("fixture", "solo-medium", 2),
  ];
  const completed = [planned[0]!];
  assert.throws(
    () => planCampaignCells({ planned, completed, resume: false }),
    /Re-run with --resume/,
  );
  const resumed = planCampaignCells({ planned, completed, resume: true });
  assert.deepEqual(resumed.completed, [planned[0]]);
  assert.deepEqual(resumed.remaining, [planned[1]]);
});

test("failed records are completed evidence and a complete resume is a no-op", () => {
  const failed = metricRecord({
    arm: "solo-medium",
    repetition: 1,
    passed: false,
  });
  const shards = [loadedShard("failed.v2.json", [failed])];
  const completed = collectCompletedCampaignCells(shards, "campaign-a");
  assert.deepEqual(completed, [campaignCell("fixture", "solo-medium", 1)]);
  const resumed = planCampaignCells({
    planned: completed,
    completed,
    resume: true,
  });
  assert.equal(resumed.completed.length, 1);
  assert.equal(resumed.remaining.length, 0);
});

test("duplicate existing campaign cells are rejected across shards", () => {
  const record = metricRecord({ arm: "solo-medium", repetition: 1 });
  const shards = [
    loadedShard("first.v2.json", [record]),
    loadedShard("second.v2.json", [record]),
  ];
  assert.throws(
    () => collectCompletedCampaignCells(shards, "campaign-a"),
    /Duplicate existing benchmark cell/,
  );
});

test("campaign startup rejects incompatible pricing and execution profiles", () => {
  const record = metricRecord({ arm: "solo-medium", repetition: 1 });
  const pricingMismatch = loadedShard("pricing.v2.json", [record]);
  (pricingMismatch.data.pricingProfile as { profileId: string }).profileId = "wrong";
  assert.throws(
    () => assertCampaignCompatibility([pricingMismatch], currentCampaignCompatibility()),
    /pricingProfile/,
  );

  const executionMismatch = loadedShard("execution.v2.json", [record]);
  (executionMismatch.data.executionProfile as { speedMode: string }).speedMode = "fast";
  assert.throws(
    () =>
      assertCampaignCompatibility([executionMismatch], currentCampaignCompatibility()),
    /executionProfile/,
  );
});

test("checkpointing atomically replaces only the current shard", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bench-checkpoint-"));
  try {
    const historical = path.join(directory, "historical.json");
    const current = path.join(directory, "current.v2.json");
    fs.writeFileSync(historical, "historical evidence", "utf8");
    const first = metricRecord({ arm: "solo-medium", repetition: 1 });
    const second = metricRecord({ arm: "solo-medium", repetition: 2 });
    checkpointResultsShard(
      current,
      buildResultsSnapshot({
        startedAt: "checkpoint",
        campaignId: "campaign-a",
        reps: 2,
        records: [first],
        standardSpeedConfirmed: true,
      }),
    );
    assert.equal(JSON.parse(fs.readFileSync(current, "utf8")).records.length, 1);
    checkpointResultsShard(
      current,
      buildResultsSnapshot({
        startedAt: "checkpoint",
        campaignId: "campaign-a",
        reps: 2,
        records: [first, second],
        standardSpeedConfirmed: true,
      }),
    );
    const secondCheckpoint = fs.readFileSync(current, "utf8");
    assert.equal(JSON.parse(secondCheckpoint).records.length, 2);
    assert.equal(fs.readFileSync(historical, "utf8"), "historical evidence");

    assert.throws(
      () =>
        checkpointResultsShard(
          current,
          buildResultsSnapshot({
            startedAt: "failed-checkpoint",
            campaignId: "campaign-a",
            reps: 2,
            records: [first],
            standardSpeedConfirmed: true,
          }),
          {
            beforeReplace: () => {
              throw new Error("simulated failure before replacement");
            },
          },
        ),
      /simulated failure/,
    );
    assert.equal(fs.readFileSync(current, "utf8"), secondCheckpoint);
    assert.equal(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")).length,
      0,
    );

    const unserializable = buildResultsSnapshot({
      startedAt: "unserializable",
      campaignId: "campaign-a",
      reps: 2,
      records: [first],
      standardSpeedConfirmed: true,
    }) as ReturnType<typeof buildResultsSnapshot> & { circular?: unknown };
    unserializable.circular = unserializable;
    assert.throws(() => checkpointResultsShard(current, unserializable), /circular/i);
    assert.equal(fs.readFileSync(current, "utf8"), secondCheckpoint);

    fs.writeFileSync(
      path.join(directory, ".interrupted.v2.json.123.deadbeef.tmp"),
      "{partial",
      "utf8",
    );
    const discovered = readCampaignShards(directory, "campaign-a");
    assert.deepEqual(
      discovered.map(({ file }) => path.basename(file)),
      ["current.v2.json"],
    );
    assert.equal(fs.readFileSync(historical, "utf8"), "historical evidence");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("campaign analysis combines only matching campaign and pricing profiles", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bench-v2-campaign-"));
  try {
    const first = buildResultsSnapshot({
      startedAt: "first",
      campaignId: "campaign-a",
      reps: 2,
      records: [metricRecord({ arm: "solo-medium", repetition: 1 })],
      standardSpeedConfirmed: true,
    });
    const second = buildResultsSnapshot({
      startedAt: "second",
      campaignId: "campaign-a",
      reps: 2,
      records: [metricRecord({ arm: "adaptive-medium", repetition: 1 })],
      standardSpeedConfirmed: true,
    });
    fs.writeFileSync(path.join(directory, "a.json"), JSON.stringify(first));
    fs.writeFileSync(path.join(directory, "b.json"), JSON.stringify(second));
    assert.equal(loadV2Campaign(directory, "campaign-a").records.length, 2);

    const mismatched = JSON.parse(JSON.stringify(second));
    mismatched.pricingProfile.profileId = "different-profile";
    fs.writeFileSync(path.join(directory, "b.json"), JSON.stringify(mismatched));
    assert.throws(() => loadV2Campaign(directory, "campaign-a"), /pricingProfile/);

    mismatched.pricingProfile.profileId = first.pricingProfile.profileId;
    mismatched.executionProfile.speedMode = "fast";
    fs.writeFileSync(path.join(directory, "b.json"), JSON.stringify(mismatched));
    assert.throws(() => loadV2Campaign(directory, "campaign-a"), /executionProfile/);

    mismatched.executionProfile = first.executionProfile;
    mismatched.records = first.records;
    fs.writeFileSync(path.join(directory, "b.json"), JSON.stringify(mismatched));
    assert.throws(
      () => loadV2Campaign(directory, "campaign-a"),
      /Duplicate existing benchmark cell/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("V3 campaign analysis and report generation work with synthetic evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bench-v3-campaign-"));
  try {
    const solo = {
      ...metricRecord({ arm: "solo-medium", repetition: 1, credits: 12, workers: 0 }),
      benchmarkVersion: 3 as const,
      suite: "v3",
      taskId: "v3-static-site-pipeline",
      routingCategory: "strong-delegation-candidate" as const,
      workloadClass: "delegation-candidate",
    };
    const adaptive = {
      ...metricRecord({ arm: "adaptive-medium", repetition: 1, credits: 10, workers: 2 }),
      benchmarkVersion: 3 as const,
      suite: "v3",
      taskId: "v3-static-site-pipeline",
      routingCategory: "strong-delegation-candidate" as const,
      workloadClass: "delegation-candidate",
      baselineRuntimeIdentity: V3_SEALED_CELL_IDENTITY,
    };
    const snapshot = buildResultsSnapshot({
      startedAt: "synthetic",
      campaignId: "v3-synthetic",
      reps: 2,
      records: [solo, adaptive],
      suite: "v3",
      standardSpeedConfirmed: true,
      pricingProfileConfirmed: true,
      ...V3_LAUNCH_EVIDENCE,
    });
    fs.writeFileSync(path.join(directory, "synthetic.v3.json"), JSON.stringify(snapshot));
    const loaded = loadV3Campaign(directory, "v3-synthetic");
    const report = renderReport(loaded);
    assert.equal(loaded.records.length, 2);
    assert.match(report, /V3 routing analysis/);
    assert.match(report, /strong-delegation-candidate/);
    assert.match(report, /Delegation rate by workload shape/);
    assert.match(report, /beneficial delegation/);
    assert.match(report, /Operational incidence/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("trade-off classification covers all four Pareto quadrants", () => {
  const baseline = summarizeCell([
    metricRecord({ arm: "solo-medium", repetition: 1, credits: 10, duration: 100 }),
  ]);
  const classify = (credits: number, duration: number) =>
    classifyTradeoff(
      baseline,
      summarizeCell([
        metricRecord({ arm: "adaptive-medium", repetition: 1, credits, duration }),
      ]),
    );
  assert.equal(classify(9, 90), "cheaper + faster");
  assert.equal(classify(9, 110), "cheaper + slower");
  assert.equal(classify(11, 90), "more expensive + faster");
  assert.equal(classify(11, 110), "more expensive + slower / dominated");
});

test("correctness outranks cost and latency in classification", () => {
  const baseline = summarizeCell([
    metricRecord({ arm: "solo-medium", repetition: 1, passed: true }),
  ]);
  const failedCheapFast = summarizeCell([
    metricRecord({
      arm: "adaptive-medium",
      repetition: 1,
      passed: false,
      credits: 1,
      duration: 1,
    }),
  ]);
  assert.equal(classifyTradeoff(baseline, failedCheapFast), "correctness regression");
});

test("third-repetition rules flag inconsistent routing and close credit deltas", () => {
  const baseline = [
    metricRecord({ arm: "solo-medium", repetition: 1, credits: 10 }),
    metricRecord({ arm: "solo-medium", repetition: 2, credits: 10 }),
  ];
  const adaptive = [
    metricRecord({ arm: "adaptive-medium", repetition: 1, credits: 9.5, workers: 0 }),
    metricRecord({ arm: "adaptive-medium", repetition: 2, credits: 10, workers: 2 }),
  ];
  const result = recommendThirdRepetition(adaptive, baseline);
  assert.ok(result?.reasons.includes("routing changed between repetitions"));
  assert.ok(result?.reasons.includes("worker count changed materially"));
  assert.ok(result?.reasons.includes("credit delta versus Solo is within 10%"));
});

test("Solo third-repetition rules do not compare credits against themselves", () => {
  const solo = [
    metricRecord({ arm: "solo-medium", repetition: 1, credits: 10 }),
    metricRecord({ arm: "solo-medium", repetition: 2, credits: 10 }),
  ];

  assert.equal(recommendThirdRepetition(solo, solo), null);
});

test("Solo third-repetition rules preserve pass/fail and variance signals", () => {
  const solo = [
    metricRecord({
      arm: "solo-medium",
      repetition: 1,
      credits: 10,
      duration: 100,
      passed: true,
    }),
    metricRecord({
      arm: "solo-medium",
      repetition: 2,
      credits: 13,
      duration: 130,
      passed: false,
    }),
  ];

  assert.deepEqual(recommendThirdRepetition(solo, solo)?.reasons, [
    "inconsistent pass/fail",
    "latency range is at least 25%",
    "credit range is at least 25%",
  ]);
});

test("historical repricing preserves unknown Luna usage and report compatibility", () => {
  const historical = metricRecord({ arm: "solo-high", repetition: 1 });
  delete historical.creditAccounting;
  historical.delegations = [
    {
      model: "gpt-5.6-luna",
      effort: "high",
      verdict: "PASS",
      attempt: 1,
      durationSeconds: 1,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 12,
        reasoningOutputTokens: 0,
      },
    },
  ];
  const repriced = repriceHistoricalRecord(historical);
  assert.equal(repriced.creditAccounting?.rateCardCredits.sol !== null, true);
  assert.equal(repriced.creditAccounting?.rateCardCredits.luna, null);
  assert.equal(repriced.creditAccounting?.rateCardCredits.total, null);
  assert.match(
    renderReport({ schema: 3, records: [historical] }, { repriceHistorical: true }),
    /Historical backfill/,
  );
});

// --- Arm fairness -----------------------------------------------------------

test("solo arms genuinely cannot delegate", () => {
  assert.equal(ARMS["solo-medium"].delegation, false);
  assert.equal(ARMS["solo-medium"].effort, "medium");
});

test("the free-choice arm neither mandates nor forbids delegation", () => {
  const guidance = ARMS["adaptive-medium"].guidance;
  assert.equal(ARMS["adaptive-medium"].delegation, true);
  assert.ok(!/MUST delegate/i.test(guidance));
  assert.ok(!/do not delegate/i.test(guidance));
  assert.match(guidance, /Zero workers is valid/i);
});

test("every arm runs the supervisor at a stated effort", () => {
  for (const [name, spec] of Object.entries(ARMS)) {
    assert.equal(spec.effort, "medium", `${name} must fix Sol at Medium`);
  }
});
