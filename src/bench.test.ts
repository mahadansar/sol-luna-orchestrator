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
import { ARMS, SUITES, peakOverlap, readTelemetry } from "./bench/run.js";
import { SCALE_SOLUTIONS } from "./bench/scale-solutions.js";
import { SCALE_TASKS } from "./bench/scale-tasks.js";
import type { BenchTask } from "./bench/tasks.js";

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

// --- Arm fairness -----------------------------------------------------------

test("solo arms genuinely cannot delegate", () => {
  for (const arm of ["solo-high", "solo-xhigh"] as const) {
    assert.equal(ARMS[arm].delegation, false);
  }
});

test("the free-choice arm neither mandates nor forbids delegation", () => {
  const guidance = ARMS.adaptive.guidance;
  assert.equal(ARMS.adaptive.delegation, true);
  assert.ok(!/MUST delegate/i.test(guidance));
  assert.ok(!/do not delegate/i.test(guidance));
});

test("every arm runs the supervisor at a stated effort", () => {
  for (const [name, spec] of Object.entries(ARMS)) {
    assert.ok(
      ["medium", "high", "xhigh", "max"].includes(spec.effort),
      `${name} has an unexpected effort`,
    );
  }
});
