import test from "node:test";
import assert from "node:assert/strict";
import {
  reduceEvents,
  parseEventLine,
  TimestampedEvent,
} from "./cli/activity-reducer.js";
import { renderHumanLines } from "./cli/activity.js";
import { symbols } from "./cli/ui.js";
import { activityFailureReason, renderEvent } from "./events.js";
import { mergeUsage } from "./worker.js";

// ========================================================================
// parseEventLine
// ========================================================================

test("parseEventLine: valid event", () => {
  const line = JSON.stringify({
    timestamp: "2024-01-01T00:00:00Z",
    type: "batch.started",
    batchId: "b1",
    mode: "parallel",
    taskCount: 1,
    maxParallel: 3,
  });
  const ev = parseEventLine(line);
  assert.ok(ev);
  assert.equal(ev.type, "batch.started");
});

test("parseEventLine: empty string", () => {
  assert.equal(parseEventLine(""), null);
  assert.equal(parseEventLine("   "), null);
});

test("parseEventLine: genuinely malformed JSON", () => {
  assert.equal(parseEventLine("{not json"), null);
  assert.equal(parseEventLine("just text"), null);
});

test("parseEventLine: valid JSON but missing type", () => {
  assert.equal(parseEventLine(JSON.stringify({ timestamp: "x" })), null);
});

test("parseEventLine: valid JSON but missing timestamp", () => {
  assert.equal(parseEventLine(JSON.stringify({ type: "batch.started" })), null);
});

test("parseEventLine: partial/incomplete JSON line", () => {
  // This is what the watcher would see mid-write: the first half of a record
  assert.equal(parseEventLine('{"timestamp":"2024-01-01T00:00:00Z","type":"bat'), null);
});

test("parseEventLine validates optional field types without crashing activity", () => {
  const queued = parseEventLine(
    JSON.stringify({
      timestamp: "2024-01-01T00:00:00Z",
      type: "task.queued",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      activityLabel: { unexpected: true },
    }),
  );
  assert.ok(queued);

  const snapshot = reduceEvents([queued]);
  assert.equal(snapshot.workers[0]?.activityLabel, null);
  assert.doesNotThrow(() => renderHumanLines(snapshot));
});

test("parseEventLine sanitizes control characters in existing event logs", () => {
  const queued = parseEventLine(
    JSON.stringify({
      timestamp: "2024-01-01T00:00:00Z",
      type: "task.queued",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      activityLabel: "Update\u001b[2J\nauth retries",
    }),
  );
  assert.ok(queued);

  const snapshot = reduceEvents([queued]);
  assert.equal(snapshot.workers[0]?.activityLabel, "Update [2J auth retries");
  assert.doesNotMatch(renderHumanLines(snapshot).join("\n"), /\u001b\[2J/);
});

test("event rendering omits prompt objectives while sanitizing other strings", () => {
  const rendered = renderEvent({
    type: "task.queued",
    batchId: "b1\nforged",
    taskId: "t1",
    effort: "high",
    activityLabel: "Update\nauth retries",
    objective: "PROMPT_EVENT_LEAK_SENTINEL",
  });

  assert.doesNotMatch(rendered, /PROMPT_EVENT_LEAK_SENTINEL|objective/);
  assert.doesNotMatch(rendered, /\n/);
  assert.match(rendered, /b1 forged/);
  assert.match(rendered, /Update auth retries/);
});

test("labeled activity is reduced and exposed in JSON while legacy records stay readable", () => {
  const snapshot = reduceEvents([
    {
      timestamp: "2024-01-01T00:00:00Z",
      type: "batch.started",
      batchId: "b-label",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T00:00:01Z",
      type: "task.queued",
      batchId: "b-label",
      taskId: "opaque-id",
      effort: "high",
      activityLabel: "Update auth retries",
    },
  ]);

  assert.equal(snapshot.workers[0]?.activityLabel, "Update auth retries");
  const json = JSON.parse(JSON.stringify(snapshot)) as {
    workers: Array<{ activityLabel?: string | null }>;
  };
  assert.equal(json.workers[0]?.activityLabel, "Update auth retries");

  const legacy = reduceEvents([
    {
      timestamp: "2024-01-01T00:00:00Z",
      type: "batch.started",
      batchId: "b-legacy",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T00:00:01Z",
      type: "task.queued",
      batchId: "b-legacy",
      taskId: "legacy-id",
      effort: "high",
      objective: "old prompt text must not render",
    },
  ]);
  assert.equal(legacy.workers[0]?.activityLabel, null);
  assert.equal(legacy.workers[0]?.taskId, "legacy-id");
});

// ========================================================================
// reduceEvents: empty / no-batch
// ========================================================================

test("empty events yield empty snapshot", () => {
  const snapshot = reduceEvents([]);
  assert.equal(snapshot.batchId, null);
  assert.equal(snapshot.state, "unknown");
  assert.equal(snapshot.workers.length, 0);
  assert.equal(snapshot.supervisor.state, "not observable");
  assert.equal(snapshot.supervisor.usage, null);
});

// ========================================================================
// reduceEvents: single worker full lifecycle
// ========================================================================

test("single worker lifecycle", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b1",
      mode: "sequential",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "task.queued",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      category: "implementation",
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w1",
    },
    {
      timestamp: "2024-01-01T10:00:05Z",
      type: "verification.started",
      batchId: "b1",
      taskId: "t1",
      commandCount: 2,
    },
    {
      timestamp: "2024-01-01T10:00:10Z",
      type: "verification.completed",
      batchId: "b1",
      taskId: "t1",
      passed: 2,
      failed: 0,
      refused: 0,
    },
    {
      timestamp: "2024-01-01T10:00:11Z",
      type: "integration.applied",
      batchId: "b1",
      taskId: "t1",
      fileCount: 3,
    },
    {
      timestamp: "2024-01-01T10:00:12Z",
      type: "worker.completed",
      batchId: "b1",
      taskId: "t1",
      verdict: "PASS",
      claimed: "Did it",
      durationSeconds: 10,
      threadId: "th1",
      model: "gpt-5.6-luna",
      effort: "high",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 25,
        cacheWriteInputTokens: 7,
        outputTokens: 20,
        reasoningOutputTokens: 5,
      },
    },
    {
      timestamp: "2024-01-01T10:00:13Z",
      type: "batch.completed",
      batchId: "b1",
      durationSeconds: 13,
      passed: 1,
      failed: 0,
    },
  ];

  const snap = reduceEvents(events);
  assert.equal(snap.batchId, "b1");
  assert.equal(snap.mode, "sequential");
  assert.equal(snap.state, "completed");
  assert.equal(snap.taskCount, 1);
  assert.equal(snap.durationSeconds, 13);
  assert.equal(snap.concurrency.peak, 1);
  assert.equal(snap.concurrency.current, 0);

  assert.equal(snap.workers.length, 1);
  const w = snap.workers[0]!;
  assert.equal(w.taskId, "t1");
  assert.equal(w.objective, null);
  assert.equal(w.category, "implementation");
  assert.equal(w.state, "completed");
  assert.equal(w.verdict, "PASS");
  assert.equal(w.model, "gpt-5.6-luna");
  assert.equal(w.workingDirectory, "w1");
  assert.equal(w.claimed, "Did it");
  assert.equal(w.threadId, "th1");
  assert.equal(w.usage?.inputTokens, 100);
  assert.equal(w.usage?.cacheWriteInputTokens, 7);
  assert.equal(w.durationSeconds, 10);
  assert.equal(w.integration?.appliedFiles, 3);
  assert.equal(w.verification?.passed, 2);
});

test("usage projection keeps historical records without cache-write telemetry readable", () => {
  const snapshot = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-legacy-usage",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "worker.completed",
      batchId: "b-legacy-usage",
      taskId: "t1",
      verdict: "PASS",
      claimed: "Done",
      durationSeconds: 1,
      threadId: "thread-legacy",
      model: "gpt-5.6-luna",
      effort: "high",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
    },
  ]);

  assert.deepEqual(snapshot.workers[0]?.usage, {
    inputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 3,
    reasoningOutputTokens: 1,
  });
});

test("repair usage merge sums cache writes only when every turn reports them", () => {
  const base = {
    inputTokens: 10,
    cachedInputTokens: 2,
    outputTokens: 3,
    reasoningOutputTokens: 1,
  };

  assert.deepEqual(
    mergeUsage(
      { ...base, cacheWriteInputTokens: 4 },
      { ...base, cacheWriteInputTokens: 6 },
    ),
    {
      inputTokens: 20,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 10,
      outputTokens: 6,
      reasoningOutputTokens: 2,
    },
  );
  assert.deepEqual(mergeUsage({ ...base }, { ...base, cacheWriteInputTokens: 6 }), {
    inputTokens: 20,
    cachedInputTokens: 4,
    outputTokens: 6,
    reasoningOutputTokens: 2,
  });
  assert.deepEqual(mergeUsage({ ...base }, { ...base }), {
    inputTokens: 20,
    cachedInputTokens: 4,
    outputTokens: 6,
    reasoningOutputTokens: 2,
  });
});

test("repair activity is visible during the turn and after completion", () => {
  const base: TimestampedEvent[] = [
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-repair",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "worker.started",
      batchId: "b-repair",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "repair.started",
      batchId: "b-repair",
      taskId: "t1",
      classification: "local-verification",
      turn: 1,
    },
  ];
  const repairing = reduceEvents(base);
  assert.equal(repairing.workers[0]?.state, "repairing");
  assert.equal(repairing.workers[0]?.repair?.classification, "local-verification");
  assert.match(renderHumanLines(repairing).join("\n"), /Repair: running \(turn 1 of 1\)/);

  const completed = reduceEvents([
    ...base,
    {
      timestamp: "2024-01-01T10:00:03Z",
      type: "repair.completed",
      batchId: "b-repair",
      taskId: "t1",
      verdict: "PASS",
      turn: 1,
    },
    {
      timestamp: "2024-01-01T10:00:04Z",
      type: "worker.completed",
      batchId: "b-repair",
      taskId: "t1",
      verdict: "PASS",
      claimed: "PASS",
      durationSeconds: 3,
      threadId: "thread-repair",
      model: "gpt-5.6-luna",
      effort: "high",
      usage: null,
    },
  ]);
  assert.equal(completed.workers[0]?.repair?.verdict, "PASS");
  assert.match(renderHumanLines(completed).join("\n"), /repair passed \(1 turn\)/);
});

test("parallel recovery activity preserves attempts and separate usage", () => {
  const initialUsage = {
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 10,
    reasoningOutputTokens: 2,
  };
  const recoveryUsage = {
    inputTokens: 50,
    cachedInputTokens: 25,
    outputTokens: 6,
    reasoningOutputTokens: 1,
  };
  const base: TimestampedEvent[] = [
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-recovery",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 3,
      automaticRecovery: true,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "task.queued",
      batchId: "b-recovery",
      taskId: "t1",
      effort: "high",
      attempt: 1,
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "worker.started",
      batchId: "b-recovery",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
      attempt: 1,
    },
    {
      timestamp: "2024-01-01T10:00:03Z",
      type: "worker.timedOut",
      batchId: "b-recovery",
      taskId: "t1",
      timeoutSeconds: 10,
      attempt: 1,
    },
    {
      timestamp: "2024-01-01T10:00:04Z",
      type: "worker.completed",
      batchId: "b-recovery",
      taskId: "t1",
      verdict: "FAILED",
      claimed: "FAILED",
      durationSeconds: 10,
      threadId: "thread-initial",
      model: "gpt-5.6-luna",
      effort: "high",
      usage: initialUsage,
      attempt: 1,
    },
    {
      timestamp: "2024-01-01T10:00:05Z",
      type: "recovery.started",
      batchId: "b-recovery",
      taskId: "t1",
      attempt: 2,
      classification: "timeout-continuation",
      evidence: "Confined timeout evidence.",
    },
    {
      timestamp: "2024-01-01T10:00:06Z",
      type: "worker.started",
      batchId: "b-recovery",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
      attempt: 2,
      recoveryClassification: "timeout-continuation",
      recoveryEvidence: "Confined timeout evidence.",
    },
  ];

  const recovering = reduceEvents(base);
  assert.equal(recovering.automaticRecovery, true);
  assert.equal(recovering.workers[0]?.state, "recovering");
  assert.equal(recovering.workers[0]?.attempt, 2);
  assert.deepEqual(recovering.workers[0]?.recovery?.initialUsage, initialUsage);
  assert.match(
    renderHumanLines(recovering).join("\n"),
    /Recovery: running \(attempt 2, timeout-continuation\)/,
  );

  const completed = reduceEvents([
    ...base,
    {
      timestamp: "2024-01-01T10:00:07Z",
      type: "worker.completed",
      batchId: "b-recovery",
      taskId: "t1",
      verdict: "PASS",
      claimed: "PASS",
      durationSeconds: 4,
      threadId: "thread-recovery",
      model: "gpt-5.6-luna",
      effort: "high",
      usage: recoveryUsage,
      attempt: 2,
      recoveryClassification: "timeout-continuation",
      recoveryEvidence: "Confined timeout evidence.",
    },
    {
      timestamp: "2024-01-01T10:00:08Z",
      type: "recovery.completed",
      batchId: "b-recovery",
      taskId: "t1",
      attempt: 2,
      classification: "timeout-continuation",
      evidence: "Confined timeout evidence.",
      verdict: "PASS",
      durationSeconds: 4,
      threadId: "thread-recovery",
      usage: recoveryUsage,
    },
  ]);
  assert.equal(completed.workers[0]?.state, "completed");
  assert.equal(completed.workers[0]?.recovery?.verdict, "PASS");
  assert.equal(completed.workers[0]?.recovery?.recoveryDurationSeconds, 4);
  assert.deepEqual(completed.workers[0]?.recovery?.recoveryUsage, recoveryUsage);
  assert.match(renderHumanLines(completed).join("\n"), /recovery passed \(attempt 2\)/);

  assert.ok(
    parseEventLine(
      JSON.stringify({
        timestamp: "2024-01-01T10:00:08Z",
        type: "recovery.completed",
        batchId: "b-recovery",
        taskId: "t1",
        attempt: 2,
        classification: "timeout-continuation",
        evidence: "Confined timeout evidence.",
        verdict: "PASS",
        durationSeconds: 4,
        threadId: "thread-recovery",
        usage: recoveryUsage,
      }),
    ),
  );
});

// ========================================================================
// Supervisor state
// ========================================================================

test("supervisor state transitions correctly", () => {
  // Before any batch
  let snap = reduceEvents([]);
  assert.equal(snap.supervisor.state, "not observable");
  assert.equal(snap.supervisor.usage, null);

  // While batch is running
  snap = reduceEvents([
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 3,
    },
  ]);
  assert.equal(snap.supervisor.state, "awaiting delegation");
  assert.equal(snap.supervisor.usage, null);

  // After batch completes
  snap = reduceEvents([
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "batch.completed",
      batchId: "b1",
      durationSeconds: 1,
      passed: 1,
      failed: 0,
    },
  ]);
  assert.equal(snap.supervisor.state, "not observable");
  assert.equal(snap.supervisor.usage, null);
});

// ========================================================================
// Parallel concurrency
// ========================================================================

test("parallel batch concurrency tracking", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 3,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "3",
      type: "worker.started",
      batchId: "b1",
      taskId: "t2",
      effort: "high",
      workingDirectory: "w",
    },
  ];
  let snap = reduceEvents(events);
  assert.equal(snap.concurrency.current, 2);
  assert.equal(snap.concurrency.peak, 2);

  events.push({
    timestamp: "4",
    type: "worker.started",
    batchId: "b1",
    taskId: "t3",
    effort: "high",
    workingDirectory: "w",
  });
  snap = reduceEvents(events);
  assert.equal(snap.concurrency.current, 3);
  assert.equal(snap.concurrency.peak, 3);

  events.push({
    timestamp: "5",
    type: "worker.completed",
    batchId: "b1",
    taskId: "t1",
    verdict: "PASS",
    claimed: "",
    durationSeconds: 1,
    threadId: null,
    model: "m",
    effort: "high",
    usage: null,
  });
  snap = reduceEvents(events);
  assert.equal(snap.concurrency.current, 2);
  assert.equal(snap.concurrency.peak, 3);
});

test("duplicate worker.started does not double-count concurrency", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    // Duplicate
    {
      timestamp: "3",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.concurrency.current, 1);
  assert.equal(snap.concurrency.peak, 1);
});

test("duplicate worker terminal event does not go negative", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "3",
      type: "worker.completed",
      batchId: "b1",
      taskId: "t1",
      verdict: "PASS",
      claimed: "",
      durationSeconds: 1,
      threadId: null,
      model: "m",
      effort: "high",
      usage: null,
    },
    // Duplicate terminal event
    {
      timestamp: "4",
      type: "worker.failed",
      batchId: "b1",
      taskId: "t1",
      reason: "late failure",
    },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.concurrency.current, 0);
  assert.equal(snap.concurrency.peak, 1);
});

// ========================================================================
// Multiple batches
// ========================================================================

test("multiple batches select the latest", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "old",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "old",
      taskId: "t_old",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "3",
      type: "batch.completed",
      batchId: "old",
      durationSeconds: 1,
      passed: 1,
      failed: 0,
    },
    {
      timestamp: "4",
      type: "batch.started",
      batchId: "new",
      mode: "sequential",
      taskCount: 2,
      maxParallel: 3,
    },
    {
      timestamp: "5",
      type: "worker.started",
      batchId: "new",
      taskId: "t_new",
      effort: "high",
      workingDirectory: "w",
    },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.batchId, "new");
  assert.equal(snap.workers.length, 1);
  assert.equal(snap.workers[0]!.taskId, "t_new");
  assert.equal(snap.state, "running");
});

test("old batch peak concurrency does not bleed into new batch", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "old",
      mode: "parallel",
      taskCount: 3,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "old",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "3",
      type: "worker.started",
      batchId: "old",
      taskId: "t2",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "4",
      type: "worker.started",
      batchId: "old",
      taskId: "t3",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "5",
      type: "batch.completed",
      batchId: "old",
      durationSeconds: 5,
      passed: 3,
      failed: 0,
    },
    // New batch with only 1 worker
    {
      timestamp: "6",
      type: "batch.started",
      batchId: "new",
      mode: "sequential",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "7",
      type: "worker.started",
      batchId: "new",
      taskId: "t_new",
      effort: "high",
      workingDirectory: "w",
    },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.batchId, "new");
  assert.equal(snap.concurrency.peak, 1);
  assert.equal(snap.concurrency.current, 1);
});

// ========================================================================
// Conflicts
// ========================================================================

test("integration conflict adds batch level and worker level conflicts", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 2,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "3",
      type: "worker.started",
      batchId: "b1",
      taskId: "t2",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "4",
      type: "integration.conflict",
      batchId: "b1",
      path: "src/main.ts",
      tasks: ["t1", "t2"],
    },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.conflicts.integration.length, 1);
  assert.equal(snap.conflicts.integration[0], "src/main.ts");

  const w1 = snap.workers.find((w) => w.taskId === "t1")!;
  const w2 = snap.workers.find((w) => w.taskId === "t2")!;
  assert.equal(w1.integration?.conflicted, true);
  assert.equal(w2.integration?.conflicted, true);
});

test("scope conflict is recorded", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 2,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "scope.conflict",
      batchId: "b1",
      detail: "t1 and t2 overlap on src/**",
    },
    {
      timestamp: "3",
      type: "batch.rejected",
      batchId: "b1",
      reason: "overlapping scopes",
    },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.state, "rejected");
  assert.equal(snap.conflicts.scope.length, 1);
});

test("workspace rejection remains visible after startup and queue events", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b-invalid-workspace",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "task.queued",
      batchId: "b-invalid-workspace",
      taskId: "t1",
      effort: "high",
    },
    {
      timestamp: "3",
      type: "batch.rejected",
      batchId: "b-invalid-workspace",
      reason: "workingDirectory does not exist",
    },
  ];

  const snapshot = reduceEvents(events);
  assert.equal(snapshot.state, "rejected");
  assert.equal(snapshot.workers[0]?.state, "queued");
  assert.equal(snapshot.supervisor.state, "not observable");
});

// ========================================================================
// Worker failure / timeout / cancellation
// ========================================================================

test("worker failure is captured", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "sequential",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "3",
      type: "worker.failed",
      batchId: "b1",
      taskId: "t1",
      reason: "Codex SDK error",
    },
  ];
  const snap = reduceEvents(events);
  const w = snap.workers[0]!;
  assert.equal(w.state, "failed");
  assert.equal(w.failReason, "Codex SDK error");
  assert.equal(snap.concurrency.current, 0);
});

test("worker timeout is captured", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "sequential",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "3",
      type: "worker.timedOut",
      batchId: "b1",
      taskId: "t1",
      timeoutSeconds: 600,
    },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.workers[0]!.state, "timedOut");
  assert.equal(snap.concurrency.current, 0);
  const rendered = renderHumanLines(snap, Date.now(), 100).join("\n");
  assert.match(rendered, /Exceeded the 10m 0s timeout/);
  assert.doesNotMatch(rendered, /Exceeded the 0s timeout/);
});

test("a completion record after timeout does not erase the timeout", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "2024-01-01T00:00:00Z",
      type: "batch.started",
      batchId: "b1",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T00:00:01Z",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "2024-01-01T00:00:02Z",
      type: "worker.timedOut",
      batchId: "b1",
      taskId: "t1",
      timeoutSeconds: 1,
    },
    {
      timestamp: "2024-01-01T00:00:03Z",
      type: "worker.completed",
      batchId: "b1",
      taskId: "t1",
      verdict: "FAILED",
      claimed: "FAILED",
      durationSeconds: 2,
      threadId: null,
      model: "m",
      effort: "high",
      usage: null,
    },
  ];

  const snap = reduceEvents(events);
  assert.equal(snap.workers[0]!.state, "timedOut");
  assert.equal(snap.concurrency.current, 0);
});

test("worker cancellation is captured", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "sequential",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    { timestamp: "3", type: "worker.cancelled", batchId: "b1", taskId: "t1" },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.workers[0]!.state, "cancelled");
});

// ========================================================================
// Batch cancellation
// ========================================================================

test("batch cancellation forces current concurrency to 0", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 2,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "3",
      type: "worker.started",
      batchId: "b1",
      taskId: "t2",
      effort: "high",
      workingDirectory: "w",
    },
    { timestamp: "4", type: "batch.cancelled", batchId: "b1", reason: "Ctrl-C" },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.state, "cancelled");
  assert.equal(snap.concurrency.current, 0);
  assert.equal(snap.concurrency.peak, 2);
});

// ========================================================================
// Worktree lifecycle
// ========================================================================

test("worktree lifecycle is captured", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "worktree.created",
      batchId: "b1",
      taskId: "t1",
      path: "/tmp/wt/t1",
    },
    {
      timestamp: "3",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "/tmp/wt/t1",
    },
    {
      timestamp: "4",
      type: "worktree.removed",
      batchId: "b1",
      taskId: "t1",
      kept: false,
    },
  ];
  const snap = reduceEvents(events);
  const w = snap.workers[0]!;
  assert.equal(w.worktreePath, "/tmp/wt/t1");
  assert.equal(w.worktreeKept, false);
});

// ========================================================================
// Incomplete / interrupted batch
// ========================================================================

test("incomplete batch without terminal event shows running", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 2,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    // Log ends here — process crashed
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.state, "running");
  assert.equal(snap.concurrency.current, 1);
  assert.equal(snap.supervisor.state, "awaiting delegation");
});

// ========================================================================
// Missing/old fields
// ========================================================================

test("missing optional fields do not crash reducer", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 3,
    },
    // Older event missing workingDirectory
    { timestamp: "2", type: "worker.started", batchId: "b1", taskId: "t1" } as any,
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.workers.length, 1);
  assert.equal(snap.workers[0]!.state, "running");
});

test("legacy completion records keep unavailable fields null", () => {
  const snap = reduceEvents([
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "sequential",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2",
      type: "worker.completed",
      batchId: "b1",
      taskId: "t1",
      verdict: "FAILED",
    } as any,
  ]);

  const worker = snap.workers[0]!;
  assert.equal(worker.claimed, null);
  assert.equal(worker.threadId, null);
  assert.equal(worker.model, null);
  assert.equal(worker.effort, "unknown");
  assert.equal(worker.durationSeconds, null);
  assert.equal(worker.usage, null);
});

// ========================================================================
// Mixed efforts
// ========================================================================

test("mixed worker efforts are preserved", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 3,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "task.queued",
      batchId: "b1",
      taskId: "t1",
      effort: "medium",
    },
    { timestamp: "3", type: "task.queued", batchId: "b1", taskId: "t2", effort: "high" },
    {
      timestamp: "4",
      type: "task.queued",
      batchId: "b1",
      taskId: "t3",
      effort: "xhigh",
    },
  ];
  const snap = reduceEvents(events);
  assert.deepEqual(
    snap.workers.map((w) => w.effort),
    ["medium", "high", "xhigh"],
  );
});

// ========================================================================
// Verification with failure
// ========================================================================

test("verification failure is captured", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "sequential",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "3",
      type: "verification.started",
      batchId: "b1",
      taskId: "t1",
      commandCount: 3,
    },
    {
      timestamp: "4",
      type: "verification.completed",
      batchId: "b1",
      taskId: "t1",
      passed: 1,
      failed: 2,
      refused: 0,
    },
  ];
  const snap = reduceEvents(events);
  const w = snap.workers[0]!;
  assert.equal(w.state, "verifying");
  assert.equal(w.verification?.passed, 1);
  assert.equal(w.verification?.failed, 2);
});

// ========================================================================
// JSON output contract
// ========================================================================

test("snapshot has expected JSON shape", () => {
  const snap = reduceEvents([]);
  // Every required key exists
  assert.ok("batchId" in snap);
  assert.ok("mode" in snap);
  assert.ok("state" in snap);
  assert.ok("taskCount" in snap);
  assert.ok("maxParallel" in snap);
  assert.ok("durationSeconds" in snap);
  assert.ok("workers" in snap);
  assert.ok("supervisor" in snap);
  assert.ok("concurrency" in snap);
  assert.ok("conflicts" in snap);
  assert.ok("updatedAt" in snap);

  // Supervisor shape
  assert.ok("state" in snap.supervisor);
  assert.ok("usage" in snap.supervisor);
  assert.equal(snap.supervisor.usage, null);

  // JSON.stringify round-trips cleanly
  const json = JSON.stringify(snap);
  const parsed = JSON.parse(json);
  assert.equal(parsed.supervisor.usage, null);
  assert.equal(parsed.batchId, null);
});

// ========================================================================
// Events from wrong batch are ignored
// ========================================================================

test("events from a non-matching batch are ignored", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 3,
    },
    // Event from a different batch
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b_other",
      taskId: "t_other",
      effort: "high",
      workingDirectory: "w",
    },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.workers.length, 0);
});

// ========================================================================
// Sequential multi-worker
// ========================================================================

test("sequential batch tracks workers one at a time", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "sequential",
      taskCount: 2,
      maxParallel: 1,
    },
    {
      timestamp: "2",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "medium",
      workingDirectory: "w",
    },
    {
      timestamp: "3",
      type: "worker.completed",
      batchId: "b1",
      taskId: "t1",
      verdict: "PASS",
      claimed: "",
      durationSeconds: 5,
      threadId: null,
      model: "m",
      effort: "medium",
      usage: null,
    },
    {
      timestamp: "4",
      type: "worker.started",
      batchId: "b1",
      taskId: "t2",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "5",
      type: "worker.completed",
      batchId: "b1",
      taskId: "t2",
      verdict: "PASS",
      claimed: "",
      durationSeconds: 8,
      threadId: null,
      model: "m",
      effort: "high",
      usage: null,
    },
    {
      timestamp: "6",
      type: "batch.completed",
      batchId: "b1",
      durationSeconds: 13,
      passed: 2,
      failed: 0,
    },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.workers.length, 2);
  assert.equal(snap.concurrency.peak, 1);
  assert.equal(snap.concurrency.current, 0);
});

// ========================================================================
// Batch rejected before workers start
// ========================================================================

test("batch rejected before workers start has no workers", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "1",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 2,
      maxParallel: 3,
    },
    {
      timestamp: "2",
      type: "scope.conflict",
      batchId: "b1",
      detail: "t1 and t2 overlap",
    },
    {
      timestamp: "3",
      type: "batch.rejected",
      batchId: "b1",
      reason: "overlapping scopes",
    },
  ];
  const snap = reduceEvents(events);
  assert.equal(snap.state, "rejected");
  assert.equal(snap.workers.length, 0);
  assert.equal(snap.concurrency.peak, 0);
  assert.equal(snap.supervisor.state, "not observable");
});

test("a stale batch appended after the latest run cannot replace it", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "2024-01-01T00:00:00Z",
      type: "batch.started",
      batchId: "old",
      mode: "parallel",
      taskCount: 3,
      maxParallel: 3,
    },
    {
      timestamp: "2024-01-01T00:00:01Z",
      type: "worker.started",
      batchId: "old",
      taskId: "old-task",
      effort: "high",
      workingDirectory: "w",
    },
    {
      timestamp: "2024-01-01T00:00:02Z",
      type: "batch.started",
      batchId: "new",
      mode: "sequential",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T00:00:03Z",
      type: "worker.started",
      batchId: "new",
      taskId: "new-task",
      effort: "medium",
      workingDirectory: "w",
    },
    // Simulate a delayed stale writer. It is physically last but older by time.
    {
      timestamp: "2024-01-01T00:00:01Z",
      type: "batch.started",
      batchId: "old-delayed",
      mode: "parallel",
      taskCount: 2,
      maxParallel: 2,
    },
  ];

  const snap = reduceEvents(events);
  assert.equal(snap.batchId, "new");
  assert.deepEqual(
    snap.workers.map((worker) => worker.taskId),
    ["new-task"],
  );
  assert.equal(snap.concurrency.current, 1);
  assert.equal(snap.concurrency.peak, 1);
});

// ========================================================================
// Human rendering
// ========================================================================

const human = (events: TimestampedEvent[], now = Date.parse("2024-01-01T10:01:42Z")) =>
  renderHumanLines(reduceEvents(events), now, 100).join("\n");
const details = (...parts: string[]): string => parts.join(` ${symbols.divider} `);

test("human rendering: running parallel work answers the at-a-glance questions", () => {
  const output = human([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "batch-internal-uuid",
      mode: "parallel",
      taskCount: 3,
      maxParallel: 3,
    },
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "task.queued",
      batchId: "batch-internal-uuid",
      taskId: "internal-task-1",
      objective: "Implement persistent Codex discovery hint",
      effort: "high",
      model: "gpt-5.6-luna",
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "worker.started",
      batchId: "batch-internal-uuid",
      taskId: "internal-task-1",
      effort: "high",
      model: "gpt-5.6-luna",
      workingDirectory: "w1",
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "task.queued",
      batchId: "batch-internal-uuid",
      taskId: "internal-task-2",
      objective: "Update model-agnostic guidance",
      effort: "medium",
      model: "gpt-5.6-luna",
    },
    {
      timestamp: "2024-01-01T10:00:03Z",
      type: "worker.started",
      batchId: "batch-internal-uuid",
      taskId: "internal-task-2",
      effort: "medium",
      model: "gpt-5.6-luna",
      workingDirectory: "w2",
    },
  ]);

  assert.match(
    output,
    /RUNNING  \|  parallel  \|  2 active \/ 3 total  \|  elapsed 1m 42s  \|  peak 2/,
  );
  assert.match(output, /1  Delegated task 1/);
  assert.ok(output.includes(details("Luna", "high", "RUNNING", "1m 41s")));
  assert.match(output, /2  Delegated task 2/);
  assert.ok(output.includes(details("Luna", "medium", "RUNNING", "1m 39s")));
  assert.equal((output.match(/Verification: pending/g) ?? []).length, 2);
  assert.doesNotMatch(
    output,
    /batch-internal-uuid|internal-task-[12]|Implement persistent|Update model-agnostic|SUPERVISOR|Usage/,
  );
});

test("human rendering: verifying state is explicit", () => {
  const output = human([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b1",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "task.queued",
      batchId: "b1",
      taskId: "t1",
      objective: "Verify the focused activity renderer",
      effort: "high",
      model: "gpt-5.6-luna",
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      model: "gpt-5.6-luna",
      workingDirectory: "w",
    },
    {
      timestamp: "2024-01-01T10:01:00Z",
      type: "verification.started",
      batchId: "b1",
      taskId: "t1",
      commandCount: 2,
    },
  ]);

  assert.ok(output.includes(details("Luna", "high", "VERIFYING", "1m 40s")));
  assert.match(output, /Verification: running/);
});

test("human rendering: successful parallel completion prioritizes outcomes", () => {
  const output = human([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b1",
      mode: "parallel",
      taskCount: 2,
      maxParallel: 2,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "task.queued",
      batchId: "b1",
      taskId: "t1",
      objective: "Implement persistent Codex discovery hint",
      effort: "high",
      model: "gpt-5.6-luna",
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      model: "gpt-5.6-luna",
      workingDirectory: "w1",
    },
    {
      timestamp: "2024-01-01T10:01:50Z",
      type: "verification.completed",
      batchId: "b1",
      taskId: "t1",
      passed: 3,
      failed: 0,
      refused: 0,
    },
    {
      timestamp: "2024-01-01T10:01:55Z",
      type: "worker.completed",
      batchId: "b1",
      taskId: "t1",
      verdict: "PASS",
      claimed: "PASS",
      durationSeconds: 114,
      threadId: "thread-private",
      model: "gpt-5.6-luna",
      effort: "high",
      changedFiles: 4,
      usage: null,
    },
    {
      timestamp: "2024-01-01T10:00:03Z",
      type: "worker.started",
      batchId: "b1",
      taskId: "t2",
      effort: "medium",
      model: "gpt-5.6-luna",
      workingDirectory: "w2",
    },
    {
      timestamp: "2024-01-01T10:02:00Z",
      type: "worker.completed",
      batchId: "b1",
      taskId: "t2",
      verdict: "PASS",
      claimed: "PASS",
      durationSeconds: 117,
      threadId: null,
      model: "gpt-5.6-luna",
      effort: "medium",
      changedFiles: 1,
      usage: null,
    },
    {
      timestamp: "2024-01-01T10:02:31Z",
      type: "batch.completed",
      batchId: "b1",
      durationSeconds: 151,
      passed: 2,
      failed: 0,
    },
  ]);

  assert.match(
    output,
    /COMPLETED  \|  parallel  \|  2\/2 passed  \|  2m 31s  \|  peak 2/,
  );
  assert.match(output, /PASS  Delegated task 1/);
  assert.ok(output.includes(details("Luna", "high", "1m 54s")));
  assert.ok(output.includes(details("4 files changed", "3 checks passed")));
  assert.doesNotMatch(output, /thread-private/);
});

test("human rendering: failed sequential completion shows verification and reason", () => {
  const output = human([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b1",
      mode: "sequential",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "task.queued",
      batchId: "b1",
      taskId: "t1",
      objective: "Update model-agnostic guidance",
      effort: "high",
      model: "gpt-5.6-luna",
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "high",
      model: "gpt-5.6-luna",
      workingDirectory: "w",
    },
    {
      timestamp: "2024-01-01T10:01:10Z",
      type: "verification.completed",
      batchId: "b1",
      taskId: "t1",
      passed: 0,
      failed: 1,
      refused: 0,
    },
    {
      timestamp: "2024-01-01T10:01:14Z",
      type: "worker.completed",
      batchId: "b1",
      taskId: "t1",
      verdict: "FAILED",
      claimed: "PASS",
      durationSeconds: 72,
      threadId: null,
      model: "gpt-5.6-luna",
      effort: "high",
      changedFiles: 2,
      failureReason: "npm test failed in guidance.test.ts",
      usage: null,
    },
    {
      timestamp: "2024-01-01T10:01:15Z",
      type: "batch.completed",
      batchId: "b1",
      durationSeconds: 75,
      passed: 0,
      failed: 1,
    },
  ]);

  assert.match(output, /COMPLETED  \|  sequential  \|  0\/1 passed  \|  1m 15s/);
  assert.match(output, /FAIL  Delegated task 1/);
  assert.ok(output.includes(details("Luna", "high", "FAILED", "1m 12s")));
  assert.match(output, /Verification: 1 failed/);
  assert.match(output, /2 files changed/);
  assert.match(output, /Reason: npm test failed in guidance\.test\.ts/);
});

test("human rendering: blocked verdict is a visible terminal status", () => {
  const output = human([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b1",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "worker.completed",
      batchId: "b1",
      taskId: "t1",
      verdict: "BLOCKED",
      claimed: "BLOCKED",
      durationSeconds: 1,
      threadId: null,
      model: "gpt-5.6-luna",
      effort: "high",
      usage: null,
    },
  ]);

  assert.match(output, /BLOCKED  Delegated task 1/);
  assert.doesNotMatch(output, /(?:BLOCKED|1)  t1/);
});

test("failure context prefers an authoritative failed check without command output", () => {
  const reason = activityFailureReason({
    verdict: "FAILED",
    errors: [],
    verification: [
      {
        command: "npm test -- guidance.test.ts",
        source: "orchestrator",
        execution: "argv",
        exitCode: 1,
        passed: false,
        output: "sensitive command output is deliberately not copied",
      },
    ],
    scopeViolations: [],
    discrepancies: [],
  });

  assert.equal(reason, "npm test -- guidance.test.ts failed (exit 1)");
  assert.doesNotMatch(reason ?? "", /sensitive command output/);
});

test("human rendering: sequential work uses compact non-prompt fallbacks", () => {
  const output = human([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b1",
      mode: "sequential",
      taskCount: 2,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "task.queued",
      batchId: "b1",
      taskId: "t1",
      objective: "Complete the first dependent change",
      effort: "medium",
      model: "gpt-5.6-luna",
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "task.queued",
      batchId: "b1",
      taskId: "t2",
      objective: "Apply the dependent follow-up change",
      effort: "high",
      model: "gpt-5.6-luna",
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "worker.started",
      batchId: "b1",
      taskId: "t1",
      effort: "medium",
      model: "gpt-5.6-luna",
      workingDirectory: "w",
    },
  ]);

  assert.match(output, /RUNNING  \|  sequential  \|  1 active \/ 2 total/);
  assert.match(output, /1  Delegated task 1/);
  assert.match(output, /2  Delegated task 2/);
  assert.doesNotMatch(
    output,
    /t1|t2|Complete the first dependent change|Apply the dependent follow-up change/,
  );
  assert.ok(output.includes(details("Luna", "high", "QUEUED")));
});

test("human rendering: missing optional metadata stays compact and truthful", () => {
  const output = human([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-old",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "worker.started",
      batchId: "b-old",
      taskId: "legacy-task-id",
      effort: "high",
      workingDirectory: "w",
    },
  ]);

  assert.match(output, /1  Delegated task 1/);
  assert.doesNotMatch(output, /legacy-task-id/);
  assert.ok(output.includes(details("high", "RUNNING", "1m 40s")));
  assert.doesNotMatch(
    output,
    /unknown|undefined|files changed|checks passed|SUPERVISOR|Usage/,
  );
});

test("human rendering prefers the concise activity label", () => {
  const output = human([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-label",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "task.queued",
      batchId: "b-label",
      taskId: "opaque-task-id",
      effort: "high",
      activityLabel: "Update auth retries",
    },
  ]);

  assert.match(output, /Update auth retries/);
  assert.doesNotMatch(output, /opaque-task-id/);
});

test("human rendering falls back to task category and warns only when neither label exists", () => {
  const categorized = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-category",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "task.queued",
      batchId: "b-category",
      taskId: "opaque-category-task",
      effort: "high",
      category: "implementation",
      objective: "OBJECTIVE MUST NEVER BE USED",
    },
  ]);
  const categorizedOutput = renderHumanLines(categorized).join("\n");
  assert.match(categorizedOutput, /Implementation task/);
  assert.doesNotMatch(
    categorizedOutput,
    /OBJECTIVE MUST NEVER BE USED|opaque-category-task/,
  );
  assert.deepEqual(categorized.warnings, []);

  const legacy = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-legacy-label",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "worker.started",
      batchId: "b-legacy-label",
      taskId: "opaque-legacy-task",
      effort: "medium",
      workingDirectory: "w",
    },
  ]);
  const legacyOutput = renderHumanLines(legacy).join("\n");
  assert.match(legacyOutput, /Delegated task 1/);
  assert.match(legacyOutput, /Some tasks have no semantic activity label/);
  assert.doesNotMatch(legacyOutput, /opaque-legacy-task/);
});

test("human failure diagnostics redact absolute and worktree paths while JSON keeps them", () => {
  const snapshot = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-redaction",
      mode: "single",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "worker.completed",
      batchId: "b-redaction",
      taskId: "opaque-redaction-task",
      verdict: "FAILED",
      claimed: "FAILED",
      durationSeconds: 1,
      threadId: null,
      model: "gpt-5.6-luna",
      effort: "high",
      failureReason:
        "Could not read D:\\private\\worktree\\secret.ts, /home/user/project/file.ts, or .sol-luna/worktrees/b-private-t1/file.ts",
      usage: null,
    },
  ]);
  const rendered = renderHumanLines(snapshot).join("\n");
  assert.equal(
    snapshot.workers[0]?.failReason,
    "Could not read D:\\private\\worktree\\secret.ts, /home/user/project/file.ts, or .sol-luna/worktrees/b-private-t1/file.ts",
  );
  assert.doesNotMatch(
    rendered,
    /D:\\private\\worktree|\/home\/user\/project|\.sol-luna[\\/]worktrees/,
  );
  assert.match(rendered, /Reason: Could not read .*<path>/);
});

test("explicit labels project consistently for single, sequential, and parallel batches", () => {
  for (const [mode, batchId] of [
    ["single", "b-single"],
    ["sequential", "b-sequential"],
    ["parallel", "b-parallel"],
  ] as const) {
    const snapshot = reduceEvents([
      {
        timestamp: "2024-01-01T10:00:00Z",
        type: "batch.started",
        batchId,
        mode,
        taskCount: 1,
        maxParallel: 1,
      },
      {
        timestamp: "2024-01-01T10:00:01Z",
        type: "task.queued",
        batchId,
        taskId: `${mode}-opaque-id`,
        effort: "high",
        activityLabel: `${mode} safe label`,
        objective: "OBJECTIVE MUST NOT BECOME A LABEL",
      },
    ]);
    assert.equal(snapshot.workers[0]?.activityLabel, `${mode} safe label`);
    const rendered = renderHumanLines(snapshot).join("\n");
    assert.match(rendered, new RegExp(`${mode} safe label`));
    assert.doesNotMatch(rendered, /OBJECTIVE MUST NOT BECOME A LABEL|opaque-id/);
  }
});

test("partial integration and retained worktrees reduce to concise redacted warnings", () => {
  const events: TimestampedEvent[] = [
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-diagnostics",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "integration.partial",
      batchId: "b-diagnostics",
      taskId: "opaque-task-id",
      attemptedFiles: 3,
      appliedFiles: 2,
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "worktree.retained",
      batchId: "b-diagnostics",
      taskId: "opaque-task-id",
      reason: "integration-failed",
    },
  ];
  const snapshot = reduceEvents(events);
  assert.equal(snapshot.integration.status, "partial");
  assert.equal(snapshot.integration.attemptedFiles, 3);
  assert.equal(snapshot.integration.appliedFiles, 2);
  assert.equal(snapshot.retainedWorktrees, 1);
  assert.match(snapshot.warnings.join("\n"), /partial|retained/i);

  const rendered = renderHumanLines(snapshot).join("\n");
  assert.match(rendered, /WARNINGS|Integration was partial|worktree was retained/);
  assert.doesNotMatch(
    rendered,
    /opaque-task-id|thread-private|OBJECTIVE|npm test|D:\\secret|src\\private/,
  );
});

test("failed integration and disabled integration retain distinct truthful statuses", () => {
  const failed = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-failed",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "integration.failed",
      batchId: "b-failed",
      taskId: "t1",
      attemptedFiles: 1,
      appliedFiles: 0,
    },
  ]);
  assert.equal(failed.integration.status, "failed");
  assert.equal(failed.integration.appliedFiles, 0);
  assert.match(failed.warnings.join("\n"), /changes were not copied/i);
  assert.doesNotMatch(failed.warnings.join("\n"), /retained/i);

  const disabled = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-disabled",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "integration.disabled",
      batchId: "b-disabled",
    },
  ]);
  assert.equal(disabled.integration.status, "disabled");
  assert.equal(disabled.integration.attemptedFiles, null);
  assert.match(disabled.warnings.join("\n"), /changes were not copied/i);
  assert.doesNotMatch(disabled.warnings.join("\n"), /retained/i);
});

test("integration totals accumulate across workers without double-counting diagnostics", () => {
  const snapshot = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-totals",
      mode: "parallel",
      taskCount: 2,
      maxParallel: 2,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "integration.applied",
      batchId: "b-totals",
      taskId: "t1",
      fileCount: 2,
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "integration.partial",
      batchId: "b-totals",
      taskId: "t2",
      attemptedFiles: 3,
      appliedFiles: 1,
    },
    {
      timestamp: "2024-01-01T10:00:03Z",
      type: "integration.applied",
      batchId: "b-totals",
      taskId: "t2",
      fileCount: 1,
    },
  ]);

  assert.equal(snapshot.integration.status, "partial");
  assert.equal(snapshot.integration.attemptedFiles, 5);
  assert.equal(snapshot.integration.appliedFiles, 3);
});

test("legacy applied-only integration evidence remains unknown", () => {
  const legacy = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-legacy-integration",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "integration.applied",
      batchId: "b-legacy-integration",
      taskId: "t1",
      fileCount: 1,
    },
  ]);
  assert.equal(legacy.integration.status, "unknown");
  assert.equal(legacy.integration.appliedFiles, 1);

  const current = reduceEvents([
    ...[
      {
        timestamp: "2024-01-01T10:00:00Z",
        type: "batch.started" as const,
        batchId: "b-current-integration",
        mode: "parallel",
        taskCount: 1,
        maxParallel: 1,
      },
      {
        timestamp: "2024-01-01T10:00:01Z",
        type: "integration.applied" as const,
        batchId: "b-current-integration",
        taskId: "t1",
        fileCount: 1,
      },
      {
        timestamp: "2024-01-01T10:00:02Z",
        type: "integration.completed" as const,
        batchId: "b-current-integration",
      },
    ],
  ]);
  assert.equal(current.integration.status, "completed");
  assert.equal(current.integration.appliedFiles, 1);
});

test("final workspace verification is visible without fabricating a worker", () => {
  const snapshot = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-final-verification",
      mode: "parallel",
      taskCount: 0,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "integration.verification.started",
      batchId: "b-final-verification",
      commandCount: 2,
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "integration.verification.completed",
      batchId: "b-final-verification",
      passed: 1,
      failed: 1,
      refused: 0,
    },
  ]);

  assert.deepEqual(snapshot.integration.verification, {
    started: true,
    completed: true,
    total: 2,
    passed: 1,
    failed: 1,
    refused: 0,
  });
  assert.equal(snapshot.workers.length, 0);
  assert.match(snapshot.warnings.join("\n"), /targeted diagnosis/i);
  assert.match(renderHumanLines(snapshot).join("\n"), /FINAL WORKSPACE VERIFICATION/);
});

test("incomplete final workspace verification never renders as PASS", () => {
  const snapshot = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-incomplete-final-verification",
      mode: "parallel",
      taskCount: 0,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "integration.verification.started",
      batchId: "b-incomplete-final-verification",
      commandCount: 2,
    },
    {
      timestamp: "2024-01-01T10:00:02Z",
      type: "integration.verification.completed",
      batchId: "b-incomplete-final-verification",
      passed: 0,
      failed: 0,
      refused: 0,
    },
  ]);

  assert.equal(snapshot.integration.verification?.completed, false);
  assert.match(snapshot.warnings.join("\n"), /targeted diagnosis/i);
  const rendered = renderHumanLines(snapshot).join("\n");
  assert.match(rendered, /NEEDS SUPERVISOR/);
  assert.doesNotMatch(rendered, /PASS/);
});

test("evidence failure records integration as not attempted without fabricated counts", () => {
  const snapshot = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-not-attempted",
      mode: "parallel",
      taskCount: 2,
      maxParallel: 2,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "integration.notAttempted",
      batchId: "b-not-attempted",
      reason: "evidence-failure",
    },
  ]);
  assert.equal(snapshot.integration.status, "notAttempted");
  assert.equal(snapshot.integration.attemptedFiles, null);
  assert.equal(snapshot.integration.appliedFiles, null);
  assert.match(snapshot.warnings.join("\n"), /not attempted/i);
});

test("policy-retained worktrees are counted without a false cleanup warning", () => {
  const snapshot = reduceEvents([
    {
      timestamp: "2024-01-01T10:00:00Z",
      type: "batch.started",
      batchId: "b-policy-retained",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-01-01T10:00:01Z",
      type: "worktree.retained",
      batchId: "b-policy-retained",
      taskId: "t1",
      reason: "retention-policy",
    },
  ]);

  assert.equal(snapshot.retainedWorktrees, 1);
  assert.deepEqual(snapshot.warnings, [
    "Some tasks have no semantic activity label; using a positional fallback.",
  ]);
});
