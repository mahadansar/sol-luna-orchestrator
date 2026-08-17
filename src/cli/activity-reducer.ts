import { OrchestratorEvent } from "../events.js";

export type TimestampedEvent = OrchestratorEvent & { timestamp: string };

export type WorkerState =
  "queued" | "running" | "verifying" | "completed" | "failed" | "cancelled" | "timedOut";

export interface WorkerActivity {
  taskId: string;
  effort: string;
  model: string | null;
  state: WorkerState;
  startTime: string | null;
  endTime: string | null;
  durationSeconds: number | null;
  verdict: string | null;
  failReason: string | null;
  worktreePath: string | null;
  worktreeKept: boolean | null;
  verification: {
    started: boolean;
    passed: number;
    failed: number;
    refused: number;
  } | null;
  integration: {
    appliedFiles: number | null;
    conflicted: boolean;
  } | null;
}

export interface ActivitySnapshot {
  batchId: string | null;
  mode: string | null;
  state: "running" | "completed" | "cancelled" | "rejected" | "unknown";
  taskCount: number;
  maxParallel: number | null;
  durationSeconds: number | null;
  workers: WorkerActivity[];
  supervisor: {
    /** What can truthfully be inferred about Sol's state from the event stream. */
    state: "awaiting delegation" | "not observable";
    /** Parent Sol token usage is not visible to MCP servers. Always null. */
    usage: null;
  };
  concurrency: {
    current: number;
    peak: number;
  };
  conflicts: {
    scope: string[];
    integration: string[];
  };
  updatedAt: string;
}

export function createEmptySnapshot(
  updatedAt: string = new Date().toISOString(),
): ActivitySnapshot {
  return {
    batchId: null,
    mode: null,
    state: "unknown",
    taskCount: 0,
    maxParallel: null,
    durationSeconds: null,
    workers: [],
    supervisor: {
      state: "not observable",
      usage: null,
    },
    concurrency: {
      current: 0,
      peak: 0,
    },
    conflicts: {
      scope: [],
      integration: [],
    },
    updatedAt,
  };
}

/**
 * Parse a single JSONL line into a TimestampedEvent, or return null for
 * genuinely malformed lines. Tolerates missing optional fields from older
 * event-schema versions.
 */
export function parseEventLine(line: string): TimestampedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const ev = JSON.parse(trimmed) as Record<string, unknown>;
    if (ev && typeof ev.type === "string" && typeof ev.timestamp === "string") {
      return ev as unknown as TimestampedEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Deterministic reducer: feeds a flat array of timestamped lifecycle events
 * into an ActivitySnapshot representing the latest batch.
 *
 * Invariants:
 * - Only the most recently started batch is represented.
 * - Workers from earlier batches are discarded when a new batch.started arrives.
 * - Concurrency is tracked via an active-worker set, never going negative.
 * - Peak concurrency is a high-water mark across the latest batch only.
 * - Unknown supervisor state is never fabricated.
 */
export function reduceEvents(events: TimestampedEvent[]): ActivitySnapshot {
  let snapshot = createEmptySnapshot();
  const workerMap = new Map<string, WorkerActivity>();
  const activeWorkerIds = new Set<string>();

  for (const event of events) {
    if (!event.timestamp) continue;
    snapshot.updatedAt = event.timestamp;

    if (event.type === "batch.started") {
      // A new batch resets everything — the MCP server processes one delegation
      // call at a time (sequential tool calls from one supervisor), so batches
      // do not interleave. If the same event file is shared across Codex
      // sessions, "latest batch wins" is still the most useful default.
      if (snapshot.batchId && snapshot.batchId !== event.batchId) {
        snapshot = createEmptySnapshot(event.timestamp);
        workerMap.clear();
        activeWorkerIds.clear();
      }
      snapshot.batchId = event.batchId;
      snapshot.mode = event.mode;
      snapshot.state = "running";
      snapshot.taskCount = event.taskCount;
      snapshot.maxParallel = event.maxParallel;
      snapshot.supervisor = { state: "awaiting delegation", usage: null };
    } else if (event.type === "batch.completed") {
      if (snapshot.batchId === event.batchId) {
        snapshot.state = "completed";
        snapshot.durationSeconds = event.durationSeconds;
        snapshot.supervisor = { state: "not observable", usage: null };
      }
    } else if (event.type === "batch.cancelled") {
      if (snapshot.batchId === event.batchId) {
        snapshot.state = "cancelled";
        snapshot.supervisor = { state: "not observable", usage: null };
      }
    } else if (event.type === "batch.rejected") {
      if (snapshot.batchId === event.batchId) {
        snapshot.state = "rejected";
        snapshot.supervisor = { state: "not observable", usage: null };
      }
    } else if (event.type === "scope.conflict") {
      if (snapshot.batchId === event.batchId) {
        snapshot.conflicts.scope.push(event.detail);
      }
    } else if (event.type === "integration.conflict") {
      if (snapshot.batchId === event.batchId) {
        snapshot.conflicts.integration.push(event.path);
        // Mark involved workers as conflicted
        for (const tid of event.tasks) {
          const worker = workerMap.get(tid);
          if (worker) {
            if (!worker.integration) {
              worker.integration = { appliedFiles: null, conflicted: true };
            } else {
              worker.integration.conflicted = true;
            }
          }
        }
      }
    }

    // Worker-level events require a taskId
    if (!("taskId" in event)) continue;
    if (snapshot.batchId && event.batchId !== snapshot.batchId) continue;

    let worker = workerMap.get(event.taskId);
    if (!worker) {
      worker = {
        taskId: event.taskId,
        effort: "unknown",
        model: null,
        state: "queued",
        startTime: null,
        endTime: null,
        durationSeconds: null,
        verdict: null,
        failReason: null,
        worktreePath: null,
        worktreeKept: null,
        verification: null,
        integration: null,
      };
      workerMap.set(event.taskId, worker);
    }

    switch (event.type) {
      case "task.queued":
        worker.effort = event.effort;
        break;
      case "worker.started":
        worker.state = "running";
        worker.startTime = event.timestamp;
        worker.effort = event.effort;
        activeWorkerIds.add(event.taskId);
        break;
      case "worker.completed":
        worker.state = "completed";
        worker.endTime = event.timestamp;
        worker.verdict = event.verdict;
        worker.model = event.model;
        worker.durationSeconds = event.durationSeconds;
        activeWorkerIds.delete(event.taskId);
        break;
      case "worker.failed":
        worker.state = "failed";
        worker.endTime = event.timestamp;
        worker.failReason = event.reason;
        activeWorkerIds.delete(event.taskId);
        break;
      case "worker.cancelled":
        worker.state = "cancelled";
        worker.endTime = event.timestamp;
        activeWorkerIds.delete(event.taskId);
        break;
      case "worker.timedOut":
        worker.state = "timedOut";
        worker.endTime = event.timestamp;
        activeWorkerIds.delete(event.taskId);
        break;
      case "worktree.created":
        worker.worktreePath = event.path;
        break;
      case "worktree.removed":
        worker.worktreeKept = event.kept;
        break;
      case "verification.started":
        worker.state = "verifying";
        worker.verification = {
          started: true,
          passed: 0,
          failed: 0,
          refused: 0,
        };
        break;
      case "verification.completed":
        if (worker.verification) {
          worker.verification.passed = event.passed;
          worker.verification.failed = event.failed;
          worker.verification.refused = event.refused;
        }
        break;
      case "integration.applied":
        worker.integration = {
          appliedFiles: event.fileCount,
          conflicted: false,
        };
        break;
    }

    snapshot.concurrency.current = activeWorkerIds.size;
    if (snapshot.concurrency.current > snapshot.concurrency.peak) {
      snapshot.concurrency.peak = snapshot.concurrency.current;
    }
  }

  // If the batch reached a terminal state, no workers can still be running
  // — the runtime guarantees all workers are terminated before batch.completed
  // is emitted. Force current to 0 to avoid stale state from interrupted logs.
  if (snapshot.state !== "running") {
    snapshot.concurrency.current = 0;
  }

  snapshot.workers = Array.from(workerMap.values());
  return snapshot;
}
