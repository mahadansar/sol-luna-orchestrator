import { appendFileSync } from "node:fs";
import { EVENTS_FILE } from "./config.js";
import { sanitizeForLog } from "./log.js";

/**
 * Structured run telemetry.
 *
 * The human log answers "did this start?". This answers "what did the batch
 * actually do, and where did the time go?" — which is the only way to reason
 * about a parallel run after the fact.
 */

export type OrchestratorEvent =
  | {
      type: "batch.started";
      batchId: string;
      mode: string;
      taskCount: number;
      maxParallel: number;
    }
  | {
      type: "batch.completed";
      batchId: string;
      durationSeconds: number;
      passed: number;
      failed: number;
    }
  | { type: "batch.cancelled"; batchId: string; reason: string }
  | { type: "batch.rejected"; batchId: string; reason: string }
  | {
      type: "task.queued";
      batchId: string;
      taskId: string;
      effort: string;
      category?: string;
    }
  | {
      type: "worker.started";
      batchId: string;
      taskId: string;
      effort: string;
      workingDirectory: string;
    }
  | {
      type: "worker.completed";
      batchId: string;
      taskId: string;
      verdict: string;
      claimed: string;
      durationSeconds: number;
      threadId: string | null;
      outputTokens: number | null;
    }
  | { type: "worker.failed"; batchId: string; taskId: string; reason: string }
  | { type: "worker.cancelled"; batchId: string; taskId: string }
  | { type: "worker.timedOut"; batchId: string; taskId: string; timeoutSeconds: number }
  | { type: "worktree.created"; batchId: string; taskId: string; path: string }
  | { type: "worktree.removed"; batchId: string; taskId: string; kept: boolean }
  | {
      type: "verification.started";
      batchId: string;
      taskId: string;
      commandCount: number;
    }
  | {
      type: "verification.completed";
      batchId: string;
      taskId: string;
      passed: number;
      failed: number;
      refused: number;
    }
  | { type: "scope.conflict"; batchId: string; detail: string }
  | { type: "integration.conflict"; batchId: string; path: string; tasks: string[] }
  | { type: "integration.applied"; batchId: string; taskId: string; fileCount: number };

type Emitter = (event: OrchestratorEvent) => void;

/** Strip control characters from every string so events cannot forge log lines. */
function sanitizeEvent(event: OrchestratorEvent): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === "string") {
      output[key] = sanitizeForLog(value);
    } else if (Array.isArray(value)) {
      output[key] = value.map((entry) =>
        typeof entry === "string" ? sanitizeForLog(entry) : entry,
      );
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function createEventEmitter(file = EVENTS_FILE): Emitter {
  return (event: OrchestratorEvent): void => {
    if (!file) return;
    try {
      appendFileSync(
        file,
        `${JSON.stringify({ timestamp: new Date().toISOString(), ...sanitizeEvent(event) })}\n`,
      );
    } catch {
      // Telemetry must never break a run.
    }
  };
}

/** Shared emitter used by the orchestrator. */
export const emitEvent: Emitter = createEventEmitter();

/** Serialise an event without writing it, for tests and inspection. */
export const renderEvent = (event: OrchestratorEvent): string =>
  JSON.stringify(sanitizeEvent(event));
