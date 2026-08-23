import { appendFileSync } from "node:fs";
import { EVENTS_FILE } from "./config.js";
import type { DelegateTaskOutput } from "./contract.js";
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
      /** Optional concise local activity label; omitted from legacy records. */
      activityLabel?: string;
      /** Legacy field accepted for reading old records, never written or rendered. */
      objective?: string;
      /** Configured worker model, known before the worker starts. */
      model?: string;
    }
  | {
      type: "worker.started";
      batchId: string;
      taskId: string;
      effort: string;
      workingDirectory: string;
      model?: string;
    }
  | {
      type: "worker.completed";
      batchId: string;
      taskId: string;
      verdict: string;
      claimed: string;
      durationSeconds: number;
      threadId: string | null;
      model: string;
      effort: string;
      changedFiles?: number;
      failureReason?: string;
      /**
       * Full usage as reported by the Codex SDK's `turn.completed` event, or
       * null when the turn produced none (a cancelled or crashed worker).
       * Recorded in full rather than output-only so a parallel batch can be
       * costed the same way a single delegation can.
       */
      usage: {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        reasoningOutputTokens: number;
      } | null;
    }
  | { type: "worker.failed"; batchId: string; taskId: string; reason: string }
  | { type: "worker.cancelled"; batchId: string; taskId: string }
  | { type: "worker.timedOut"; batchId: string; taskId: string; timeoutSeconds: number }
  | {
      type: "repair.started";
      batchId: string;
      taskId: string;
      classification: string;
      turn: 1;
    }
  | {
      type: "repair.completed";
      batchId: string;
      taskId: string;
      verdict: string;
      turn: 1;
    }
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

export type EventEmitter = (event: OrchestratorEvent) => void;

/** Strip control characters from every string so events cannot forge log lines. */
function sanitizeEvent(event: OrchestratorEvent): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    // Objectives are the worker prompt's first-class task field. Keep the
    // optional property in the type so old JSONL remains readable, but never
    // copy it into new telemetry (or re-emit it through renderEvent).
    if (key === "objective") continue;
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

export function createEventEmitter(file = EVENTS_FILE): EventEmitter {
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
export const emitEvent: EventEmitter = createEventEmitter();

/** Select concise, already-known failure context for the human activity view. */
export function activityFailureReason(
  result: Pick<
    DelegateTaskOutput,
    "verdict" | "errors" | "verification" | "scopeViolations" | "discrepancies"
  >,
): string | undefined {
  if (result.verdict === "PASS") return undefined;

  const runtimeError = result.errors.find((error) => error.trim().length > 0);
  if (runtimeError) return runtimeError;

  const failedCheck = result.verification.find(
    (run) =>
      run.source === "orchestrator" &&
      !run.passed &&
      (run.execution === "argv" || run.execution === "shell"),
  );
  if (failedCheck) {
    const exit = failedCheck.exitCode === null ? "" : ` (exit ${failedCheck.exitCode})`;
    return `${failedCheck.command} failed${exit}`;
  }

  const scopeViolation = result.scopeViolations[0];
  if (scopeViolation) return `Scope violation: ${scopeViolation}`;

  return result.discrepancies.find((detail) => detail.trim().length > 0);
}

/** Serialise an event without writing it, for tests and inspection. */
export const renderEvent = (event: OrchestratorEvent): string =>
  JSON.stringify(sanitizeEvent(event));
