import { appendFileSync } from "node:fs";
import { EVENTS_FILE } from "./config.js";
import type {
  AttemptEvidence,
  AttemptRole,
  AttemptTermination,
  DelegateTaskOutput,
  UsageUnavailableReason,
} from "./contract.js";
import { sanitizeForLog } from "./log.js";
import type { ComputePolicy } from "./policy.js";
import type {
  CoreOverlap,
  DeclaredRoutingFields,
  ExecutionMechanism,
  RoutingGate,
  RoutingRoute,
  RoutingSignal,
} from "./routing.js";
import type { Effort } from "./config.js";
import type { SelectionReason } from "./selection.js";

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
      automaticRecovery?: boolean;
      /**
       * The compute envelope this batch actually ran under, after the
       * operator baseline and any per-call narrowing were resolved. Recorded
       * so a reader can tell why an escalation was withheld, or why a run was
       * less concurrent than the installation's ceiling allows.
       */
      computePolicy?: ComputePolicy;
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
      type: "explore.started";
      batchId: string;
      activityLabel?: string;
      requestedModel: string;
      requestedEffort: string;
      selectedModel: string;
      selectedEffort: string;
      computePolicy?: ComputePolicy;
    }
  | {
      type: "explore.completed";
      batchId: string;
      verdict: string;
      claimed: string | null;
      durationSeconds: number;
      workerGroundedClaimsCount: number;
      runtimeFactsCount: number;
      inferencesCount: number;
      unknownsCount: number;
      executedModel: string;
      executedEffort: string;
      usage: DelegateTaskOutput["usage"];
    }
  | {
      type: "explore.rejected";
      batchId: string;
      reasonCode: "compute-policy" | "execution-setup";
    }
  | {
      type: "attempt.started";
      batchId: string;
      taskId: string;
      executionId: string;
      logicalAttempt: number;
      role: AttemptRole;
      predecessorExecutionId: string | null;
      model: string;
      effort: string;
      threadOperation: "start" | "resume";
      startedAt: string;
      timeoutMs: number;
    }
  | {
      type: "attempt.completed";
      batchId: string;
      taskId: string;
      executionId: string;
      logicalAttempt: number;
      role: AttemptRole;
      predecessorExecutionId: string | null;
      model: string;
      effort: string;
      threadId: string | null;
      threadOperation: "start" | "resume";
      threadIdentityMatched: boolean | null;
      startedAt: string;
      finishedAt: string;
      elapsedMs: number;
      workerElapsedMs: number;
      verificationElapsedMs: number;
      timeoutMs: number;
      termination: AttemptTermination;
      usageStatus: "reported" | "unavailable";
      usageUnavailableReason?: UsageUnavailableReason;
      usage: DelegateTaskOutput["usage"];
      claimed: string | null;
      claimedFailureCauses: string[];
      verificationPassed: number;
      verificationFailed: number;
      verificationRefused: number;
    }
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
      attempt?: number;
      recoveryClassification?: string;
      recoveryEvidence?: string;
    }
  | {
      type: "worker.started";
      batchId: string;
      taskId: string;
      effort: string;
      workingDirectory: string;
      model?: string;
      attempt?: number;
      recoveryClassification?: string;
      recoveryEvidence?: string;
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
        cacheWriteInputTokens?: number;
        outputTokens: number;
        reasoningOutputTokens: number;
      } | null;
      attempt?: number;
      recoveryClassification?: string;
      recoveryEvidence?: string;
    }
  | {
      type: "worker.failed";
      batchId: string;
      taskId: string;
      reason: string;
      attempt?: number;
      recoveryClassification?: string;
      recoveryEvidence?: string;
    }
  | {
      type: "worker.cancelled";
      batchId: string;
      taskId: string;
      attempt?: number;
      recoveryClassification?: string;
      recoveryEvidence?: string;
    }
  | {
      type: "worker.timedOut";
      batchId: string;
      taskId: string;
      timeoutSeconds: number;
      attempt?: number;
      recoveryClassification?: string;
      recoveryEvidence?: string;
    }
  | {
      type: "recovery.started";
      batchId: string;
      taskId: string;
      attempt: number;
      classification: string;
      evidence: string;
      executionId?: string;
      predecessorExecutionId?: string | null;
    }
  | {
      type: "recovery.skipped";
      batchId: string;
      taskId: string;
      attempt: number;
      classification: string;
      evidence: string;
      executionId?: string;
      predecessorExecutionId?: string | null;
    }
  | {
      type: "recovery.completed";
      batchId: string;
      taskId: string;
      attempt: number;
      classification: string;
      evidence: string;
      verdict: string;
      durationSeconds: number;
      threadId: string | null;
      usage: {
        inputTokens: number;
        cachedInputTokens: number;
        cacheWriteInputTokens?: number;
        outputTokens: number;
        reasoningOutputTokens: number;
      } | null;
      executionId?: string;
      predecessorExecutionId?: string | null;
    }
  | {
      type: "repair.started";
      batchId: string;
      taskId: string;
      classification: string;
      turn: 1;
      executionId?: string;
    }
  | {
      type: "repair.completed";
      batchId: string;
      taskId: string;
      verdict: string;
      turn: 1;
      executionId?: string;
    }
  | { type: "worktree.created"; batchId: string; taskId: string; path: string }
  | { type: "worktree.removed"; batchId: string; taskId: string; kept: boolean }
  | {
      type: "verification.started";
      batchId: string;
      taskId: string;
      commandCount: number;
      executionId?: string;
      attempt?: number;
      role?: AttemptRole;
    }
  | {
      type: "verification.completed";
      batchId: string;
      taskId: string;
      passed: number;
      failed: number;
      refused: number;
      executionId?: string;
      attempt?: number;
      role?: AttemptRole;
    }
  | { type: "scope.conflict"; batchId: string; detail: string }
  | { type: "integration.conflict"; batchId: string; path: string; tasks: string[] }
  | { type: "integration.applied"; batchId: string; taskId: string; fileCount: number }
  | { type: "integration.completed"; batchId: string }
  | {
      type: "integration.verification.started";
      batchId: string;
      commandCount: number;
    }
  | {
      type: "integration.verification.completed";
      batchId: string;
      passed: number;
      failed: number;
      refused: number;
    }
  | {
      type: "integration.notAttempted";
      batchId: string;
      reason: "evidence-failure";
    }
  | {
      type: "integration.partial";
      batchId: string;
      taskId: string;
      attemptedFiles: number;
      appliedFiles: number;
    }
  | {
      type: "integration.failed";
      batchId: string;
      taskId: string;
      attemptedFiles: number;
      appliedFiles: number;
    }
  | { type: "integration.disabled"; batchId: string }
  | ({
      /**
       * One advisory `routing_preflight` evaluation. No batch exists yet, so
       * there is deliberately no batchId to correlate it with.
       */
      type: "routing.preflight";
      /**
       * Explicitly absent rather than merely missing: this record predates any
       * batch, and saying so in the type keeps every batch-keyed reader — which
       * is all of them — valid without special-casing this event.
       */
      batchId?: undefined;
      preflightId: string;
      route: RoutingRoute;
      seamCount: number;
      unknownCount: number;
      gates: RoutingGate[];
      signals: RoutingSignal[];
      parallelEligible: boolean;
      recommendedMechanism?: ExecutionMechanism;
      recommendedWorkerCount?: number;
      recommendedConcurrency?: number;
      recommendedEffort?: Effort | null;
      selectedModel?: string | null;
      selectedEffort?: Effort | null;
      selectionReason?: SelectionReason;
    } & DeclaredRoutingFields)
  | ({
      /** What a real delegation call declared, and what routing did with it. */
      type: "routing.declared";
      batchId: string;
      declaration: "attached";
      mode: string;
      taskCount: number;
      seamCount: number;
      unknownCount: number;
      route: RoutingRoute;
      gates: RoutingGate[];
      signals: RoutingSignal[];
      refusedGate: RoutingGate | null;
      parallelEligible: boolean;
      recommendedMechanism?: ExecutionMechanism;
      recommendedWorkerCount?: number;
      recommendedConcurrency?: number;
      recommendedEffort?: Effort | null;
      selectedModel?: string | null;
      selectedEffort?: Effort | null;
      selectionReason?: SelectionReason;
    } & DeclaredRoutingFields)
  | {
      /**
       * A call that attached no card. Nothing was evaluated, so no route,
       * signal, or eligibility is recorded: an absent declaration must not be
       * reported as though routing had reached a conclusion about it.
       */
      type: "routing.declared";
      batchId: string;
      declaration: "absent";
      mode: string;
      taskCount: number;
    }
  | {
      /**
       * A declaration the runtime's own already-computed evidence contradicts.
       * Advisory: the existing scope and integration gates remain authoritative
       * for actual safety, and this only records that the card was wrong.
       */
      type: "routing.contradiction";
      batchId: string;
      kind:
        "declared-disjoint-core-scopes-overlap" | "declared-disjoint-core-files-collided";
      declaredCoreOverlap: CoreOverlap;
      observed: number;
    }
  | {
      type: "worktree.retained";
      batchId: string;
      taskId: string;
      reason:
        | "integration-conflict"
        | "integration-disabled"
        | "integration-not-attempted"
        | "integration-partial"
        | "integration-failed"
        | "evidence-failure"
        | "cleanup-failed"
        | "retention-policy";
    }
  | {
      type: "context.evaluated";
      batchId?: string;
      boundary: string;
      safeBoundary: boolean;
      decision: "trigger" | "block" | "noop";
      primaryReason: string;
      contributingReasons: readonly string[];
      totalSizeBytes: number;
      totalTurns: number;
      cleanTurns: number;
      diagnosticTurns: number;
      toolOverheadBytes: number;
      estimatedReclaimableBytes: number;
      reclaimableRatio: number;
      activeHandoffsCount: number;
      activeContinuationsCount: number;
      cooldownRemaining: number;
      lastCompactedTurnNumber?: number;
    }
  | {
      type: "context.compacted";
      batchId?: string;
      boundary: string;
      lastCompactedTurnNumber: number;
      originalSizeBytes: number;
      compactedSizeBytes: number;
      sizeDeltaBytes: number;
      reductionRatio: number;
      rulesApplied: readonly string[];
      discardedNarrationTurns: number;
      discardedToolProseTurns: number;
      compactedCleanTurns: number;
      retainedDiagnosticTurns: number;
      omittedCleanTurns: number;
      omittedCleanSummaries: number;
      scrubbedValuesCount: number;
    }
  | {
      type: "workflow.started";
      workflowId: string;
      batchId?: string;
      taskCount: number;
      requestedMode: string;
      requestedWorkerCount: number;
      requestedModels: string[];
      requestedEfforts: string[];
      maxSteps: number;
      maxEscalations: number;
      maxContinuations: number;
      importedContext: boolean;
      computePolicy?: ComputePolicy;
    }
  | {
      type: "workflow.transition";
      workflowId: string;
      batchId?: string;
      fromState: string;
      toState: string;
      reasonCode: string;
      stepNumber: number;
      recommendedMode?: string;
      recommendedWorkerCount?: number;
      recommendedConcurrency?: number;
      recommendedEffort?: string | null;
      selectedModel?: string | null;
      selectedEffort?: string | null;
    }
  | {
      type: "workflow.completed";
      workflowId: string;
      batchId?: string;
      finalState: string;
      status: string;
      durationMs: number;
      totalSteps: number;
      passed: boolean;
      delegated: boolean;
      explored: boolean;
      escalated: boolean;
      executionMode: string;
      executedModels: string[];
      executedEfforts: string[];
    };

export type EventEmitter = (event: OrchestratorEvent) => void;

export function emitAttemptStarted(
  emit: EventEmitter,
  batchId: string,
  taskId: string,
  evidence: {
    executionId: string;
    logicalAttempt: number;
    role: AttemptRole;
    predecessorExecutionId: string | null;
    requestedModel: string;
    requestedEffort: string;
    threadOperation: "start" | "resume";
    startedAt: string;
    timeoutMs: number;
  },
): void {
  emit({
    type: "attempt.started",
    batchId,
    taskId,
    executionId: evidence.executionId,
    logicalAttempt: evidence.logicalAttempt,
    role: evidence.role,
    predecessorExecutionId: evidence.predecessorExecutionId,
    model: evidence.requestedModel,
    effort: evidence.requestedEffort,
    threadOperation: evidence.threadOperation,
    startedAt: evidence.startedAt,
    timeoutMs: evidence.timeoutMs,
  });
}

export function emitAttemptCompleted(
  emit: EventEmitter,
  batchId: string,
  taskId: string,
  evidence: AttemptEvidence,
): void {
  const executed = evidence.verification.filter(
    (run) => run.execution === "argv" || run.execution === "shell",
  );
  const refused = evidence.verification.filter(
    (run) => run.execution === "rejected" || run.execution === "skipped",
  );
  emit({
    type: "attempt.completed",
    batchId,
    taskId,
    executionId: evidence.executionId,
    logicalAttempt: evidence.logicalAttempt,
    role: evidence.role,
    predecessorExecutionId: evidence.predecessorExecutionId,
    model: evidence.requestedModel,
    effort: evidence.requestedEffort,
    threadId: evidence.threadId,
    threadOperation: evidence.threadOperation,
    threadIdentityMatched: evidence.threadIdentityMatched,
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,
    elapsedMs: evidence.elapsedMs,
    workerElapsedMs: evidence.workerElapsedMs,
    verificationElapsedMs: evidence.verificationElapsedMs,
    timeoutMs: evidence.timeoutMs,
    termination: evidence.termination.kind,
    usageStatus: evidence.usage.status,
    ...(evidence.usage.status === "unavailable"
      ? { usageUnavailableReason: evidence.usage.reason }
      : {}),
    usage: evidence.usage.status === "reported" ? evidence.usage.value : null,
    claimed: evidence.workerClaimedStatus,
    claimedFailureCauses: evidence.workerClaimedFailureCauses,
    verificationPassed: executed.filter((run) => run.passed).length,
    verificationFailed: executed.filter((run) => !run.passed).length,
    verificationRefused: refused.length,
  });
}

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
