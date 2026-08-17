import test from "node:test";
import assert from "node:assert/strict";
import {
  reduceEvents,
  parseEventLine,
  TimestampedEvent,
} from "./cli/activity-reducer.js";

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
      usage: null,
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
  assert.equal(w.state, "completed");
  assert.equal(w.verdict, "PASS");
  assert.equal(w.model, "gpt-5.6-luna");
  assert.equal(w.durationSeconds, 10);
  assert.equal(w.integration?.appliedFiles, 3);
  assert.equal(w.verification?.passed, 2);
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
