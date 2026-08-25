import { z } from "zod";
import { OrchestratorEvent } from "../events.js";
import { sanitizeForLog } from "../log.js";

export type TimestampedEvent = OrchestratorEvent & { timestamp: string };

const eventString = z.string().transform(sanitizeForLog);
const optionalEventString = eventString.optional().catch(undefined);
const optionalEventNumber = z.number().finite().optional().catch(undefined);
const optionalEventBoolean = z.boolean().optional().catch(undefined);
const eventBase = { timestamp: eventString, batchId: eventString };

/**
 * JSONL is local but still untrusted: it may be hand-edited, truncated, or
 * produced by an older version. Validate fields used by the reducer while
 * dropping unknown properties and malformed optional legacy fields.
 */
const timestampedEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventBase,
    type: z.literal("batch.started"),
    mode: eventString,
    taskCount: z.number().finite(),
    maxParallel: z.number().finite(),
    automaticRecovery: optionalEventBoolean,
  }),
  z.object({
    ...eventBase,
    type: z.literal("batch.completed"),
    durationSeconds: optionalEventNumber,
    passed: optionalEventNumber,
    failed: optionalEventNumber,
  }),
  z.object({ ...eventBase, type: z.literal("batch.cancelled"), reason: eventString }),
  z.object({ ...eventBase, type: z.literal("batch.rejected"), reason: eventString }),
  z.object({
    ...eventBase,
    type: z.literal("task.queued"),
    taskId: eventString,
    effort: optionalEventString,
    category: optionalEventString,
    activityLabel: optionalEventString,
    objective: optionalEventString,
    model: optionalEventString,
    attempt: optionalEventNumber,
  }),
  z.object({
    ...eventBase,
    type: z.literal("worker.started"),
    taskId: eventString,
    effort: optionalEventString,
    workingDirectory: optionalEventString,
    model: optionalEventString,
    attempt: optionalEventNumber,
    recoveryClassification: optionalEventString,
    recoveryEvidence: optionalEventString,
  }),
  z.object({
    ...eventBase,
    type: z.literal("worker.completed"),
    taskId: eventString,
    verdict: optionalEventString,
    claimed: optionalEventString,
    durationSeconds: optionalEventNumber,
    threadId: optionalEventString.nullable().catch(undefined),
    model: optionalEventString,
    effort: optionalEventString,
    changedFiles: optionalEventNumber,
    failureReason: optionalEventString,
    attempt: optionalEventNumber,
    recoveryClassification: optionalEventString,
    recoveryEvidence: optionalEventString,
    usage: z
      .object({
        inputTokens: z.number().finite(),
        cachedInputTokens: z.number().finite(),
        cacheWriteInputTokens: z.number().finite().optional(),
        outputTokens: z.number().finite(),
        reasoningOutputTokens: z.number().finite(),
      })
      .nullable()
      .optional()
      .catch(undefined),
  }),
  z.object({
    ...eventBase,
    type: z.literal("worker.failed"),
    taskId: eventString,
    reason: optionalEventString,
    attempt: optionalEventNumber,
    recoveryClassification: optionalEventString,
    recoveryEvidence: optionalEventString,
  }),
  z.object({
    ...eventBase,
    type: z.literal("worker.cancelled"),
    taskId: eventString,
    attempt: optionalEventNumber,
    recoveryClassification: optionalEventString,
    recoveryEvidence: optionalEventString,
  }),
  z.object({
    ...eventBase,
    type: z.literal("worker.timedOut"),
    taskId: eventString,
    timeoutSeconds: optionalEventNumber,
    attempt: optionalEventNumber,
    recoveryClassification: optionalEventString,
    recoveryEvidence: optionalEventString,
  }),
  z.object({
    ...eventBase,
    type: z.literal("recovery.started"),
    taskId: eventString,
    attempt: z.number().finite(),
    classification: eventString,
    evidence: eventString,
  }),
  z.object({
    ...eventBase,
    type: z.literal("recovery.skipped"),
    taskId: eventString,
    attempt: z.number().finite(),
    classification: eventString,
    evidence: eventString,
  }),
  z.object({
    ...eventBase,
    type: z.literal("recovery.completed"),
    taskId: eventString,
    attempt: z.number().finite(),
    classification: eventString,
    evidence: eventString,
    verdict: eventString,
    durationSeconds: z.number().finite(),
    threadId: optionalEventString.nullable().catch(undefined),
    usage: z
      .object({
        inputTokens: z.number().finite(),
        cachedInputTokens: z.number().finite(),
        cacheWriteInputTokens: z.number().finite().optional(),
        outputTokens: z.number().finite(),
        reasoningOutputTokens: z.number().finite(),
      })
      .nullable()
      .catch(null),
  }),
  z.object({
    ...eventBase,
    type: z.literal("repair.started"),
    taskId: eventString,
    classification: eventString,
    turn: z.literal(1),
  }),
  z.object({
    ...eventBase,
    type: z.literal("repair.completed"),
    taskId: eventString,
    verdict: eventString,
    turn: z.literal(1),
  }),
  z.object({
    ...eventBase,
    type: z.literal("worktree.created"),
    taskId: eventString,
    path: optionalEventString,
  }),
  z.object({
    ...eventBase,
    type: z.literal("worktree.removed"),
    taskId: eventString,
    kept: optionalEventBoolean,
  }),
  z.object({
    ...eventBase,
    type: z.literal("verification.started"),
    taskId: eventString,
    commandCount: optionalEventNumber,
  }),
  z.object({
    ...eventBase,
    type: z.literal("verification.completed"),
    taskId: eventString,
    passed: z.number().finite().catch(0),
    failed: z.number().finite().catch(0),
    refused: z.number().finite().catch(0),
  }),
  z.object({ ...eventBase, type: z.literal("scope.conflict"), detail: eventString }),
  z.object({
    ...eventBase,
    type: z.literal("integration.conflict"),
    path: eventString,
    tasks: z.array(eventString),
  }),
  z.object({
    ...eventBase,
    type: z.literal("integration.applied"),
    taskId: eventString,
    fileCount: optionalEventNumber,
  }),
  z.object({ ...eventBase, type: z.literal("integration.completed") }),
  z.object({
    ...eventBase,
    type: z.literal("integration.verification.started"),
    commandCount: optionalEventNumber,
  }),
  z.object({
    ...eventBase,
    type: z.literal("integration.verification.completed"),
    passed: z.number().finite().catch(0),
    failed: z.number().finite().catch(0),
    refused: z.number().finite().catch(0),
  }),
  z.object({
    ...eventBase,
    type: z.literal("integration.notAttempted"),
    reason: z.literal("evidence-failure"),
  }),
  z.object({
    ...eventBase,
    type: z.literal("integration.partial"),
    taskId: eventString,
    attemptedFiles: optionalEventNumber,
    appliedFiles: optionalEventNumber,
  }),
  z.object({
    ...eventBase,
    type: z.literal("integration.failed"),
    taskId: eventString,
    attemptedFiles: optionalEventNumber,
    appliedFiles: optionalEventNumber,
  }),
  z.object({ ...eventBase, type: z.literal("integration.disabled") }),
  z.object({
    ...eventBase,
    type: z.literal("worktree.retained"),
    taskId: eventString,
    reason: z
      .enum([
        "integration-conflict",
        "integration-disabled",
        "integration-not-attempted",
        "integration-partial",
        "integration-failed",
        "evidence-failure",
        "cleanup-failed",
        "retention-policy",
      ])
      .catch("cleanup-failed"),
  }),
]);

/** Treat only the runtime's ISO timestamps as sortable wall-clock values. */
function eventTime(timestamp: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp)) return Number.NaN;
  return Date.parse(timestamp);
}

export type WorkerState =
  | "queued"
  | "running"
  | "verifying"
  | "repairing"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled"
  | "timedOut";

export interface WorkerActivity {
  taskId: string;
  activityLabel: string | null;
  /** Privacy-preserving legacy shape: objectives are never persisted and this stays null. */
  objective: string | null;
  category: string | null;
  effort: string;
  attempt: number;
  model: string | null;
  workingDirectory: string | null;
  state: WorkerState;
  startTime: string | null;
  endTime: string | null;
  durationSeconds: number | null;
  verdict: string | null;
  claimed: string | null;
  threadId: string | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens?: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  } | null;
  failReason: string | null;
  changedFiles: number | null;
  timeoutSeconds: number | null;
  worktreePath: string | null;
  worktreeKept: boolean | null;
  verification: {
    started: boolean;
    total: number | null;
    passed: number;
    failed: number;
    refused: number;
  } | null;
  repair: {
    attempted: boolean;
    classification: string;
    verdict: string | null;
    turn: 1;
  } | null;
  recovery: {
    attempted: boolean;
    classification: string;
    evidence: string;
    attempt: number;
    verdict: string | null;
    initialDurationSeconds: number | null;
    recoveryDurationSeconds: number | null;
    initialUsage: WorkerActivity["usage"];
    recoveryUsage: WorkerActivity["usage"];
    threadId: string | null;
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
  automaticRecovery: boolean | null;
  startTime: string | null;
  durationSeconds: number | null;
  passed: number | null;
  failed: number | null;
  reason: string | null;
  workers: WorkerActivity[];
  supervisor: {
    /** What can truthfully be inferred about the parent from the event stream. */
    state: "awaiting delegation" | "not observable";
    /** Parent token usage is not visible to MCP servers. Always null. */
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
  integration: {
    status:
      | "unknown"
      | "completed"
      | "conflicted"
      | "partial"
      | "failed"
      | "disabled"
      | "notAttempted";
    attemptedFiles: number | null;
    appliedFiles: number | null;
    verification: {
      started: boolean;
      completed: boolean;
      total: number | null;
      passed: number;
      failed: number;
      refused: number;
    } | null;
  };
  retainedWorktrees: number;
  warnings: string[];
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
    automaticRecovery: null,
    startTime: null,
    durationSeconds: null,
    passed: null,
    failed: null,
    reason: null,
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
    integration: {
      status: "unknown",
      attemptedFiles: null,
      appliedFiles: null,
      verification: null,
    },
    retainedWorktrees: 0,
    warnings: [],
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
    const parsed = timestampedEventSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? (parsed.data as TimestampedEvent) : null;
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
  const diagnosedIntegrationIds = new Set<string>();
  const addWarning = (warning: string): void => {
    if (!snapshot.warnings.includes(warning)) snapshot.warnings.push(warning);
  };

  // A shared append-only log can contain records from more than one process.
  // Select the newest batch by its event timestamp before reducing, so a stale
  // batch appended late cannot make the operational view jump backwards.
  const batchStarts = events.filter((event) => event.type === "batch.started");
  const latestBatch = batchStarts.reduce<TimestampedEvent | null>((latest, event) => {
    if (!latest) return event;
    const latestTimestamp = eventTime(latest.timestamp);
    const currentTimestamp = eventTime(event.timestamp);
    if (Number.isFinite(latestTimestamp) && Number.isFinite(currentTimestamp)) {
      return currentTimestamp >= latestTimestamp ? event : latest;
    }
    if (Number.isFinite(latestTimestamp)) return latest;
    if (Number.isFinite(currentTimestamp)) return event;
    return event;
  }, null);
  const selectedEvents = latestBatch
    ? events.filter((event) => event.batchId === latestBatch.batchId)
    : events;

  // Timestamps are normally ISO strings. Keep the physical append order for
  // legacy/non-date timestamps, while making reconstruction deterministic when
  // valid records arrive out of order.
  const orderedEvents = selectedEvents
    .map((event, index) => ({ event, index, time: eventTime(event.timestamp) }))
    .sort((a, b) => {
      if (Number.isFinite(a.time) && Number.isFinite(b.time)) return a.time - b.time;
      if (Number.isFinite(a.time)) return -1;
      if (Number.isFinite(b.time)) return 1;
      return a.index - b.index;
    })
    .map(({ event }) => event);

  for (const event of orderedEvents) {
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
      snapshot.automaticRecovery = event.automaticRecovery ?? null;
      snapshot.startTime = event.timestamp;
      snapshot.supervisor = { state: "awaiting delegation", usage: null };
    } else if (event.type === "batch.completed") {
      if (snapshot.batchId === event.batchId) {
        snapshot.state = "completed";
        snapshot.durationSeconds = event.durationSeconds ?? null;
        snapshot.passed = event.passed ?? null;
        snapshot.failed = event.failed ?? null;
        snapshot.supervisor = { state: "not observable", usage: null };
      }
    } else if (event.type === "batch.cancelled") {
      if (snapshot.batchId === event.batchId) {
        snapshot.state = "cancelled";
        snapshot.reason = event.reason;
        snapshot.supervisor = { state: "not observable", usage: null };
      }
    } else if (event.type === "batch.rejected") {
      if (snapshot.batchId === event.batchId) {
        snapshot.state = "rejected";
        snapshot.reason = event.reason;
        snapshot.supervisor = { state: "not observable", usage: null };
      }
    } else if (event.type === "scope.conflict") {
      if (snapshot.batchId === event.batchId) {
        snapshot.conflicts.scope.push(event.detail);
      }
    } else if (event.type === "integration.conflict") {
      if (snapshot.batchId === event.batchId) {
        snapshot.integration.status = "conflicted";
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
    } else if (event.type === "integration.partial") {
      if (snapshot.batchId === event.batchId) {
        if (snapshot.integration.status !== "failed")
          snapshot.integration.status = "partial";
        if (!diagnosedIntegrationIds.has(event.taskId)) {
          snapshot.integration.attemptedFiles =
            (snapshot.integration.attemptedFiles ?? 0) + (event.attemptedFiles ?? 0);
          snapshot.integration.appliedFiles =
            (snapshot.integration.appliedFiles ?? 0) + (event.appliedFiles ?? 0);
          diagnosedIntegrationIds.add(event.taskId);
        }
        addWarning(
          "Integration was partial; only the reported applied changes reached the workspace.",
        );
      }
    } else if (event.type === "integration.failed") {
      if (snapshot.batchId === event.batchId) {
        snapshot.integration.status = "failed";
        if (!diagnosedIntegrationIds.has(event.taskId)) {
          snapshot.integration.attemptedFiles =
            (snapshot.integration.attemptedFiles ?? 0) + (event.attemptedFiles ?? 0);
          snapshot.integration.appliedFiles =
            (snapshot.integration.appliedFiles ?? 0) + (event.appliedFiles ?? 0);
          diagnosedIntegrationIds.add(event.taskId);
        }
        addWarning("Integration failed for a worker; its changes were not copied.");
      }
    } else if (event.type === "integration.disabled") {
      if (snapshot.batchId === event.batchId) {
        snapshot.integration = {
          status: "disabled",
          attemptedFiles: null,
          appliedFiles: null,
          verification: snapshot.integration.verification,
        };
        addWarning("Integration was disabled; worker changes were not copied.");
      }
    } else if (event.type === "integration.completed") {
      if (
        snapshot.batchId === event.batchId &&
        snapshot.integration.status === "unknown"
      ) {
        snapshot.integration.status = "completed";
      }
    } else if (event.type === "integration.verification.started") {
      if (snapshot.batchId === event.batchId) {
        snapshot.integration.verification = {
          started: true,
          completed: false,
          total: event.commandCount ?? null,
          passed: 0,
          failed: 0,
          refused: 0,
        };
      }
    } else if (event.type === "integration.verification.completed") {
      if (snapshot.batchId === event.batchId) {
        snapshot.integration.verification ??= {
          started: true,
          completed: false,
          total: event.passed + event.failed + event.refused,
          passed: 0,
          failed: 0,
          refused: 0,
        };
        snapshot.integration.verification.passed = event.passed;
        snapshot.integration.verification.failed = event.failed;
        snapshot.integration.verification.refused = event.refused;
        const observed = event.passed + event.failed + event.refused;
        snapshot.integration.verification.completed =
          snapshot.integration.verification.total !== null &&
          observed === snapshot.integration.verification.total;
        if (
          !snapshot.integration.verification.completed ||
          event.failed > 0 ||
          event.refused > 0
        ) {
          addWarning(
            "Final workspace verification did not pass completely; targeted diagnosis is required.",
          );
        }
      }
    } else if (event.type === "integration.notAttempted") {
      if (snapshot.batchId === event.batchId) {
        snapshot.integration = {
          status: "notAttempted",
          attemptedFiles: null,
          appliedFiles: null,
          verification: snapshot.integration.verification,
        };
        addWarning(
          "Integration was not attempted because final worker evidence was unavailable.",
        );
      }
    } else if (event.type === "worktree.retained") {
      if (snapshot.batchId === event.batchId) {
        snapshot.retainedWorktrees += 1;
        const warning =
          event.reason === "integration-conflict"
            ? "A worktree was retained after an integration conflict."
            : event.reason === "integration-disabled"
              ? "A worktree was retained because integration was disabled."
              : event.reason === "evidence-failure"
                ? "A worktree was retained because final evidence could not be read."
                : event.reason === "integration-not-attempted"
                  ? "A worktree was retained because integration was not attempted."
                  : event.reason === "integration-partial"
                    ? "A worktree was retained after partial integration."
                    : event.reason === "cleanup-failed"
                      ? "A worktree was retained because cleanup was incomplete."
                      : event.reason === "retention-policy"
                        ? null
                        : "A worktree was retained after incomplete integration.";
        if (warning) addWarning(warning);
      }
    }

    // Worker-level events require a taskId
    if (!("taskId" in event)) continue;
    if (snapshot.batchId && event.batchId !== snapshot.batchId) continue;

    let worker = workerMap.get(event.taskId);
    if (!worker) {
      worker = {
        taskId: event.taskId,
        activityLabel: null,
        objective: null,
        category: null,
        effort: "unknown",
        attempt: 1,
        model: null,
        workingDirectory: null,
        state: "queued",
        startTime: null,
        endTime: null,
        durationSeconds: null,
        verdict: null,
        claimed: null,
        threadId: null,
        usage: null,
        failReason: null,
        changedFiles: null,
        timeoutSeconds: null,
        worktreePath: null,
        worktreeKept: null,
        verification: null,
        repair: null,
        recovery: null,
        integration: null,
      };
      workerMap.set(event.taskId, worker);
    }

    switch (event.type) {
      case "task.queued":
        worker.effort = event.effort ?? worker.effort;
        worker.category = event.category ?? worker.category;
        worker.activityLabel = event.activityLabel ?? worker.activityLabel;
        worker.model = event.model ?? worker.model;
        worker.attempt = event.attempt ?? worker.attempt;
        break;
      case "worker.started":
        worker.state = event.recoveryClassification ? "recovering" : "running";
        worker.startTime = event.timestamp;
        worker.attempt = event.attempt ?? worker.attempt;
        worker.effort = event.effort ?? worker.effort;
        worker.model = event.model ?? worker.model;
        worker.workingDirectory = event.workingDirectory ?? worker.workingDirectory;
        if (event.recoveryClassification) {
          worker.recovery ??= {
            attempted: true,
            classification: event.recoveryClassification,
            evidence: event.recoveryEvidence ?? "Recovery attempt in progress.",
            attempt: worker.attempt,
            verdict: null,
            initialDurationSeconds: worker.durationSeconds,
            recoveryDurationSeconds: null,
            initialUsage: worker.usage,
            recoveryUsage: null,
            threadId: null,
          };
        }
        activeWorkerIds.add(event.taskId);
        break;
      case "worker.completed":
        // Older/runtime paths may emit timedOut followed by the normal
        // completion record. Keep the timeout visible rather than rewriting it
        // as a successful-looking completion.
        if (worker.state !== "timedOut") worker.state = "completed";
        worker.endTime = event.timestamp;
        worker.attempt = event.attempt ?? worker.attempt;
        worker.verdict = event.verdict ?? null;
        worker.claimed = event.claimed ?? null;
        worker.threadId = event.threadId ?? null;
        worker.usage = event.usage ?? null;
        worker.model = event.model ?? worker.model;
        worker.effort = event.effort ?? worker.effort;
        worker.durationSeconds = event.durationSeconds ?? null;
        worker.changedFiles = event.changedFiles ?? worker.changedFiles;
        worker.failReason = event.failureReason ?? worker.failReason;
        activeWorkerIds.delete(event.taskId);
        break;
      case "worker.failed":
        worker.state = "failed";
        worker.endTime = event.timestamp;
        worker.attempt = event.attempt ?? worker.attempt;
        worker.failReason = event.reason ?? null;
        activeWorkerIds.delete(event.taskId);
        break;
      case "worker.cancelled":
        worker.state = "cancelled";
        worker.endTime = event.timestamp;
        worker.attempt = event.attempt ?? worker.attempt;
        activeWorkerIds.delete(event.taskId);
        break;
      case "worker.timedOut":
        worker.state = "timedOut";
        worker.endTime = event.timestamp;
        worker.attempt = event.attempt ?? worker.attempt;
        worker.timeoutSeconds = event.timeoutSeconds ?? null;
        activeWorkerIds.delete(event.taskId);
        break;
      case "recovery.started":
        worker.state = "recovering";
        worker.attempt = event.attempt;
        worker.recovery = {
          attempted: true,
          classification: event.classification,
          evidence: event.evidence,
          attempt: event.attempt,
          verdict: null,
          initialDurationSeconds: worker.durationSeconds,
          recoveryDurationSeconds: null,
          initialUsage: worker.usage,
          recoveryUsage: null,
          threadId: null,
        };
        break;
      case "recovery.skipped":
        worker.recovery = {
          attempted: false,
          classification: event.classification,
          evidence: event.evidence,
          attempt: event.attempt,
          verdict: null,
          initialDurationSeconds: worker.durationSeconds,
          recoveryDurationSeconds: null,
          initialUsage: worker.usage,
          recoveryUsage: null,
          threadId: null,
        };
        break;
      case "recovery.completed":
        worker.attempt = event.attempt;
        worker.state = event.verdict === "PASS" ? "completed" : "failed";
        worker.verdict = event.verdict;
        worker.recovery ??= {
          attempted: true,
          classification: event.classification,
          evidence: event.evidence,
          attempt: event.attempt,
          verdict: null,
          initialDurationSeconds: null,
          recoveryDurationSeconds: null,
          initialUsage: null,
          recoveryUsage: null,
          threadId: null,
        };
        worker.recovery.verdict = event.verdict;
        worker.recovery.recoveryDurationSeconds = event.durationSeconds;
        worker.recovery.recoveryUsage = event.usage;
        worker.recovery.threadId = event.threadId ?? null;
        activeWorkerIds.delete(event.taskId);
        break;
      case "repair.started":
        worker.state = "repairing";
        worker.repair = {
          attempted: true,
          classification: event.classification,
          verdict: null,
          turn: event.turn,
        };
        break;
      case "repair.completed":
        worker.state = "running";
        worker.repair ??= {
          attempted: true,
          classification: "unknown",
          verdict: null,
          turn: event.turn,
        };
        worker.repair.verdict = event.verdict;
        break;
      case "worktree.created":
        worker.worktreePath = event.path ?? null;
        break;
      case "worktree.removed":
        worker.worktreeKept = event.kept ?? null;
        break;
      case "verification.started":
        worker.state = "verifying";
        worker.verification = {
          started: true,
          total: event.commandCount ?? null,
          passed: 0,
          failed: 0,
          refused: 0,
        };
        break;
      case "verification.completed":
        worker.verification ??= {
          started: true,
          total: event.passed + event.failed + event.refused,
          passed: 0,
          failed: 0,
          refused: 0,
        };
        worker.verification.passed = event.passed;
        worker.verification.failed = event.failed;
        worker.verification.refused = event.refused;
        break;
      case "integration.applied":
        worker.integration = {
          appliedFiles: event.fileCount ?? null,
          conflicted: snapshot.integration.status === "conflicted",
        };
        if (!diagnosedIntegrationIds.has(event.taskId)) {
          snapshot.integration.attemptedFiles =
            (snapshot.integration.attemptedFiles ?? 0) + (event.fileCount ?? 0);
          snapshot.integration.appliedFiles =
            (snapshot.integration.appliedFiles ?? 0) + (event.fileCount ?? 0);
          diagnosedIntegrationIds.add(event.taskId);
        }
        break;
      case "integration.partial":
        worker.integration = {
          appliedFiles: event.appliedFiles ?? null,
          conflicted: false,
        };
        break;
      case "integration.failed":
        worker.integration = {
          appliedFiles: event.appliedFiles ?? null,
          conflicted: false,
        };
        break;
      case "worktree.retained":
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
  if (
    snapshot.workers.some(
      (worker) => !worker.activityLabel?.trim() && !worker.category?.trim(),
    )
  ) {
    addWarning(
      "Some tasks have no semantic activity label; using a positional fallback.",
    );
  }
  return snapshot;
}
