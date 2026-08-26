import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_TIMEOUT_SECONDS,
  LUNA_MODEL,
  MAX_BATCH_SIZE,
  MAX_PARALLEL,
} from "./config.js";
import type {
  BatchOutput,
  BatchTaskResult,
  AttemptEvidence,
  AttemptRole,
  DelegateTaskInput,
  DelegateTaskOutput,
  RecoveryClassification,
  RoutingPreflightInput,
  TaskState,
} from "./contract.js";
import { asRoutingCard } from "./contract.js";
import { DEFAULT_COMPUTE_POLICY, type ComputePolicy } from "./policy.js";
import { declaredRoutingFields, describeRefusal, evaluateRouting } from "./routing.js";
import {
  activityFailureReason,
  emitAttemptCompleted,
  emitAttemptStarted,
  emitEvent,
  type EventEmitter,
} from "./events.js";
import {
  findIntegrationConflicts,
  findScopeConflicts,
  type IntegrationConflict,
} from "./overlap.js";
import {
  executeTask,
  applyFailureDecision,
  classifyFailureDecision,
  createExecutionId,
  reconcileParallelWorktreeEvidence,
  resultWasCancelled,
  UNCLAIMED_FILE,
  mergeUsage,
  workerSlots,
  Semaphore,
} from "./worker.js";
import { findScopeViolations } from "./scope.js";
import {
  cleanupWorktree,
  createTaskWorktree,
  maintainWorktreeLease,
  prepareWorktreeBase,
  pruneStaleWorktrees,
  readWorktreeOutcome,
  refreshWorktreeLease,
  releaseWorktreeLease,
  releaseWorktreeOwnership,
  WORKTREE_LEASE_GRACE_MS,
  WorktreeUnavailableError,
  type CleanupReason,
  type WorktreeLease,
  type WorktreeRetentionPolicy,
  type TaskWorktree,
} from "./worktree.js";
import { resolveWorkspace } from "./workspace.js";
import { CONTINUATION_TTL_MS } from "./continuation.js";
import {
  runVerifications,
  type VerificationRun as FinalVerificationRun,
} from "./verify.js";

export class BatchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchRejectedError";
  }
}

/** Stable, non-sensitive identifier for a task's worktree directory. */
function makeTaskId(index: number): string {
  return `t${index + 1}`;
}

function makeBatchId(): string {
  return `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

interface RunningTask {
  taskId: string;
  input: DelegateTaskInput;
  state: TaskState;
  worktree: TaskWorktree | null;
  leaseRenewal: { stop: () => Promise<void> } | null;
  worktreeOutcomeError: string | null;
  result: BatchTaskResult;
  recovery: RecoveryDecision | null;
}

interface RecoveryDecision {
  attempted: boolean;
  classification: RecoveryClassification;
  evidence: string;
  initialAttempt: number;
  recoveryAttempt: number | null;
  initialDurationSeconds: number | null;
  recoveryDurationSeconds: number | null;
  initialUsage: DelegateTaskOutput["usage"];
  recoveryUsage: DelegateTaskOutput["usage"];
}

/**
 * Run a set of task contracts, either in parallel with isolated worktrees or
 * sequentially in the shared workspace.
 *
 * The two modes are genuinely different tools, not a speed knob:
 *
 *   parallel   - tasks must be independent. Each gets its own git worktree, so
 *                no two workers can see or clobber each other's edits, and the
 *                results are integrated afterwards only if nothing collided.
 *   sequential - tasks may depend on each other. They share the workspace and
 *                run one at a time, so a later task sees the earlier one's work.
 */
export type TaskExecutor = typeof executeTask;
export type IntegrationVerifier = (
  commands: string[],
  workingDirectory: string,
) => Promise<FinalVerificationRun[]>;

export async function runBatch(
  tasks: DelegateTaskInput[],
  options: {
    mode: "parallel" | "sequential";
    workingDirectory?: string;
    allowOverlappingScopes?: boolean;
    integrate?: boolean;
    /** Parallel-only bounded recovery; schema default is true. */
    automaticRecovery?: boolean;
    signal?: AbortSignal;
    /**
     * Overridable so the scheduling, isolation and integration logic can be
     * tested without spending model calls. Production always uses the default.
     */
    executor?: TaskExecutor;
    /** Final verifier for the integrated/shared workspace. */
    integrationVerifier?: IntegrationVerifier;
    /**
     * Per-run event sink. Production uses the append-only configured emitter;
     * deterministic callers inject an isolated sink without mutating process env.
     */
    eventEmitter?: EventEmitter;
    /**
     * Register an eligible result after integration and cleanup have chosen the
     * directory in which its resumed thread can safely continue.
     */
    continuationRegistrar?: (
      input: DelegateTaskInput,
      result: DelegateTaskOutput,
      workingDirectory: string,
      reconcileFinalGit: boolean,
      worktreeLease: WorktreeLease | null,
    ) => string | null | Promise<string | null>;
    /** Worktrees still referenced by unused or in-flight continuations. */
    protectedWorktreePaths?: Iterable<string>;
    /** Deterministic lifecycle seam for tests; production always generates one. */
    batchId?: string;
    /** Deterministic lease-maintenance seam; production uses persistent renewal. */
    leaseMaintainer?: typeof maintainWorktreeLease;
    /** Deterministic retention seam; production uses configured policy. */
    keepWorktrees?: WorktreeRetentionPolicy;
    /**
     * Optional call-level routing declaration. Absent means no routing is
     * evaluated and behavior is exactly what it was before preflight existed.
     */
    routingPreflight?: RoutingPreflightInput;
    /**
     * The already-resolved compute envelope for this batch.
     *
     * Resolved once at the delegation boundary, never re-derived here: this is
     * the narrowed policy, so every bound below is safe to use directly.
     * Omitted only by internal callers, which get the operator baseline.
     */
    computePolicy?: ComputePolicy;
  },
): Promise<BatchOutput> {
  const batchId = options.batchId ?? makeBatchId();
  const startedAt = Date.now();
  const mode = options.mode;
  const emit = options.eventEmitter ?? emitEvent;
  const computePolicy = options.computePolicy ?? DEFAULT_COMPUTE_POLICY;
  // Parallel mode is the only mode with concurrency to bound; sequential runs
  // one task at a time whatever the policy says.
  const maxParallel = mode === "parallel" ? computePolicy.maxConcurrency : 1;
  // One semaphore for the batch, not one per worker window: the bounded
  // recovery pass has to queue behind the same limit the initial wave did.
  const policySlots = new Semaphore(maxParallel);

  if (tasks.length === 0) {
    throw new BatchRejectedError("A batch needs at least one task.");
  }
  if (tasks.length > MAX_BATCH_SIZE) {
    throw new BatchRejectedError(
      `A batch may contain at most ${MAX_BATCH_SIZE} tasks; ${tasks.length} were supplied. ` +
        `Split the work, or run the remainder as a second batch.`,
    );
  }

  const run = options.executor ?? executeTask;

  const running: RunningTask[] = tasks.map((input, index) => {
    const taskId = makeTaskId(index);
    return {
      taskId,
      input,
      state: "queued" as TaskState,
      worktree: null,
      leaseRenewal: null,
      worktreeOutcomeError: null,
      result: {
        taskId,
        state: "queued",
        objective: input.objective,
        effort: input.effort,
        effortReason: input.effortReason,
        result: null,
        changedFiles: [],
        worktreePath: null,
        error: null,
        warnings: [],
        attempt: input.previousAttempts.length + 1,
        attempts: [],
        recovery: null,
      },
      recovery: null,
    };
  });

  emit({
    type: "batch.started",
    batchId,
    mode,
    taskCount: tasks.length,
    maxParallel,
    computePolicy,
    automaticRecovery: options.automaticRecovery ?? true,
  });
  for (const task of running) {
    emit({
      type: "task.queued",
      batchId,
      taskId: task.taskId,
      effort: task.input.effort,
      category: task.input.taskCategory,
      activityLabel: task.input.activityLabel,
      model: LUNA_MODEL,
      attempt: task.result.attempt,
    });
  }

  let workspace: string;
  try {
    workspace = resolveWorkspace(options.workingDirectory);
  } catch (error) {
    const reason = (error as Error).message;
    emit({ type: "batch.rejected", batchId, reason });
    throw new BatchRejectedError(reason);
  }

  // --- Scope conflicts, before anything is created -------------------------
  const scopeConflicts =
    mode === "parallel"
      ? findScopeConflicts(
          running.map((task) => ({
            allowedFiles: task.input.allowedFiles,
            label: task.taskId,
          })),
        )
      : [];

  for (const conflict of scopeConflicts) {
    emit({ type: "scope.conflict", batchId, detail: conflict.detail });
  }

  // --- Cheap routing: evaluate and record, before anything is created ------
  //
  // Evaluation is separated from enforcement. Recording happens here, so an
  // attached card is always in telemetry even when a different gate rejects the
  // batch first; refusal happens below, after the observed scope gate, so a real
  // same-file race keeps precedence over a claim about the caller's own
  // decomposition. Both sit before any worktree, thread, or worker exists.
  const card = options.routingPreflight ? asRoutingCard(options.routingPreflight) : null;
  const routing = card
    ? evaluateRouting(card, {
        mode,
        taskCount: tasks.length,
        allowOverlappingScopes: options.allowOverlappingScopes,
      })
    : null;
  if (!card || !routing) {
    emit({
      type: "routing.declared",
      batchId,
      declaration: "absent",
      mode,
      taskCount: tasks.length,
    });
  } else {
    emit({
      type: "routing.declared",
      batchId,
      declaration: "attached",
      mode,
      taskCount: tasks.length,
      seamCount: routing.seamCount,
      unknownCount: routing.unknownCount,
      route: routing.route,
      gates: routing.gates,
      signals: routing.signals,
      refusedGate: routing.refusedGate,
      parallelEligible: routing.parallelEligible,
      ...declaredRoutingFields(card),
    });

    // The card claimed disjoint cores while the runtime's own already-computed
    // scope comparison disagrees. Recorded, not enforced: the scope gate below
    // decides what happens about the overlap itself.
    if (card.coreOverlap === "disjoint" && scopeConflicts.length > 0) {
      emit({
        type: "routing.contradiction",
        batchId,
        kind: "declared-disjoint-core-scopes-overlap",
        declaredCoreOverlap: card.coreOverlap,
        observed: scopeConflicts.length,
      });
    }
  }

  if (scopeConflicts.length > 0 && !options.allowOverlappingScopes) {
    emit({ type: "batch.rejected", batchId, reason: "overlapping scopes" });
    throw new BatchRejectedError(
      `These tasks declare overlapping file scopes, so running them in parallel ` +
        `would make the outcome depend on which worker finishes last:\n` +
        scopeConflicts.map((conflict) => `  - ${conflict.detail}`).join("\n") +
        `\n\nGive each task a disjoint scope, run them with mode:"sequential", or ` +
        `set allowOverlappingScopes:true if you have a specific reason to accept ` +
        `the race.`,
    );
  }

  // --- Cheap routing: enforce -----------------------------------------------
  //
  // Still before any worktree: the only thing spent so far is the caller's own
  // declaration. The scope and integration gates remain authoritative for actual
  // safety; routing never replaces them, and now never speaks ahead of them.
  const routingWarnings: string[] = [];
  if (routing?.refusedGate) {
    const reason = describeRefusal(routing.refusedGate);
    emit({ type: "batch.rejected", batchId, reason });
    throw new BatchRejectedError(reason);
  }
  // An accepted overlap downgrades the shared-core gate to a warning, exactly as
  // it already does for declared scope overlap. Mutable shared state is not
  // downgradable and has already refused above.
  if (routing?.gates.includes("parallel-shared-core")) {
    routingWarnings.push(
      "The routing card declares a shared core and allowOverlappingScopes:true " +
        "accepted it; parallel seams both reasoning about one core remain the " +
        "caller's risk.",
    );
  }
  // Advisory routing deliberately adds nothing to batch warnings. A soft Solo
  // recommendation is not an operational problem with the run, and a warning
  // would cost the caller the thin verified handoff for taking the advice's
  // subject matter seriously. Advisories are rendered as one compact line on the
  // tool result instead; telemetry above keeps the full evaluation.

  const warnings: string[] = [...routingWarnings];

  try {
    if (mode === "sequential") {
      await runSequential(batchId, running, workspace, run, emit, options.signal);
    } else {
      warnings.push(
        ...(await runParallel(
          batchId,
          running,
          workspace,
          run,
          emit,
          options.signal,
          options.protectedWorktreePaths,
          options.leaseMaintainer,
          policySlots,
        )),
      );
    }
  } catch (error) {
    if (error instanceof WorktreeUnavailableError) {
      emit({ type: "batch.rejected", batchId, reason: error.message });
      throw new BatchRejectedError(error.message);
    }
    throw error;
  }

  // Recovery is deliberately decided only after every initial parallel worker
  // has finished and its owned worktree evidence has been reconciled. This
  // keeps integration/cleanup out of the recovery window and preserves sibling
  // successes while failed streams get at most one extra turn.
  if (mode === "parallel") {
    const initialConflicts = findIntegrationConflicts(
      running
        .filter((task) => task.result.changedFiles.length > 0)
        .map((task) => ({ taskId: task.taskId, changedFiles: task.result.changedFiles })),
    );
    await recoverParallel(
      batchId,
      running,
      workspace,
      run,
      emit,
      options.signal,
      options.automaticRecovery ?? true,
      initialConflicts,
      policySlots,
    );
  }

  // --- Integration ---------------------------------------------------------
  const completed = running.filter(
    (task) => task.state === "completed" && task.result.changedFiles.length > 0,
  );
  const integrationConflicts =
    mode === "parallel"
      ? findIntegrationConflicts(
          completed.map((task) => ({
            taskId: task.taskId,
            changedFiles: task.result.changedFiles,
          })),
        )
      : [];
  for (const conflict of integrationConflicts) {
    emit({
      type: "integration.conflict",
      batchId,
      path: conflict.path,
      tasks: conflict.tasks,
    });
  }
  // Declared disjoint cores, but the workers demonstrably wrote the same file.
  // Measured from what was written, so it is worth recording even though the
  // integration gate has already prevented the collision from being applied.
  if (card?.coreOverlap === "disjoint" && integrationConflicts.length > 0) {
    emit({
      type: "routing.contradiction",
      batchId,
      kind: "declared-disjoint-core-files-collided",
      declaredCoreOverlap: card.coreOverlap,
      observed: integrationConflicts.length,
    });
  }

  let integrated = false;
  let integrationIncomplete = false;
  let integrationSummary: string;
  const outcomeFailures = running.filter((task) => task.worktreeOutcomeError !== null);

  if (mode === "sequential") {
    integrated = true;
    integrationSummary =
      "Sequential tasks worked directly in the workspace, so their changes are already in place.";
  } else if (options.integrate === false) {
    emit({ type: "integration.disabled", batchId });
    integrationSummary =
      "Integration was disabled, so worker changes were not copied into the requested " +
      "workspace. Any worktree that remains after cleanup is listed per task.";
  } else if (outcomeFailures.length > 0) {
    integrationIncomplete = true;
    warnings.push(
      `Integration was not attempted because worktree evidence could not be read ` +
        `for ${outcomeFailures.map((task) => task.taskId).join(", ")}.`,
    );
    integrationSummary =
      "Integration was not attempted because at least one worker's final worktree " +
      "evidence scan failed. Structured failure evidence remains available; any " +
      "worktree that remains after cleanup is listed per task.";
    emit({ type: "integration.notAttempted", batchId, reason: "evidence-failure" });
  } else if (integrationConflicts.length > 0) {
    integrationSummary =
      `Nothing was integrated: ${integrationConflicts.length} file(s) were changed by ` +
      `more than one worker. Conflict evidence is listed above; any worktree retained ` +
      `after cleanup is listed per task.`;
  } else if (completed.length === 0) {
    integrationSummary = "No worker produced changes, so there was nothing to integrate.";
  } else {
    const applied = await integrateWorktrees(batchId, completed, workspace, emit);
    integrationIncomplete = applied.warnings.length > 0;
    integrated = !integrationIncomplete;
    warnings.push(...applied.warnings);
    integrationSummary = integrationIncomplete
      ? `Integration was incomplete after copying ${applied.fileCount} file(s). ` +
        `Any worktree that remains after cleanup is listed per task.`
      : `Copied ${applied.fileCount} file(s) from ${completed.length} worker(s) into ` +
        `the workspace. No two workers touched the same file.`;
    if (!integrationIncomplete) emit({ type: "integration.completed", batchId });
  }

  // Workers prove their owned seams in isolation. Once those seams share the
  // requested workspace, deterministic code (not another Sol reasoning loop)
  // reruns the union of their declared checks exactly once.
  const declaredFinalCommands = [
    ...new Set(
      running
        .filter((task) => task.state === "completed")
        .flatMap((task) => task.input.verificationCommands),
    ),
  ];
  const finalCommands = declaredFinalCommands;
  const integrationVerification: BatchOutput["integrationVerification"] = [];
  if (integrated && finalCommands.length > 0 && !options.signal?.aborted) {
    emit({
      type: "integration.verification.started",
      batchId,
      commandCount: finalCommands.length,
    });
    try {
      const runs = await (options.integrationVerifier ?? runVerifications)(
        finalCommands,
        workspace,
      );
      integrationVerification.push(
        ...runs.map((run) => ({ ...run, source: "orchestrator" as const })),
      );
    } catch (error) {
      warnings.push(
        `Final integrated verification could not run: ${(error as Error).message}`,
      );
    }
    const passed = integrationVerification.filter((run) => run.passed).length;
    const refused = integrationVerification.filter(
      (run) => run.execution === "rejected" || run.execution === "skipped",
    ).length;
    emit({
      type: "integration.verification.completed",
      batchId,
      passed,
      failed: integrationVerification.length - passed - refused,
      refused,
    });
  }

  const finalVerificationPassed =
    finalCommands.length > 0 &&
    integrationVerification.length === finalCommands.length &&
    integrationVerification.every(
      (run) => (run.execution === "argv" || run.execution === "shell") && run.passed,
    );
  let completionState: BatchOutput["completionState"] =
    integrated && running.every(isCleanTask) && finalVerificationPassed
      ? "verified-complete"
      : "needs-supervisor";
  if (integrated && finalCommands.length === 0) {
    warnings.push(
      "No final workspace verification commands were declared; the batch cannot use the terminal verified fast path.",
    );
  } else if (integrated && finalCommands.length > 0 && !finalVerificationPassed) {
    warnings.push(
      "Final integrated verification did not pass completely; use the returned evidence for targeted diagnosis.",
    );
  } else if (completionState === "verified-complete") {
    integrationSummary +=
      ` Final workspace verification passed ` +
      `${integrationVerification.length}/${integrationVerification.length} declared check(s).`;
  }

  // --- Cleanup -------------------------------------------------------------
  let lifecycleError: unknown = null;
  for (const task of running) {
    if (!task.worktree) {
      if (task.result.result && options.continuationRegistrar) {
        try {
          task.result.result.continuationReference = await options.continuationRegistrar(
            task.input,
            task.result.result,
            workspace,
            false,
            null,
          );
        } catch (error) {
          const detail = `Continuation registration failed after execution: ${(error as Error).message}`;
          task.result.error ??= detail;
          task.result.warnings.push(detail);
          task.result.result.continuationState = {
            status: "unavailable",
            reason: detail,
          };
          lifecycleError ??= error;
        }
      }
      continue;
    }
    const keepForConflict =
      integrationConflicts.length > 0 ||
      options.integrate === false ||
      integrationIncomplete;
    const reason = worktreeCleanupReason(task, keepForConflict);

    let renewalError: unknown = null;
    try {
      await task.leaseRenewal?.stop();
    } catch (error) {
      renewalError = error;
      lifecycleError ??= error;
      task.result.warnings.push(
        `Persistent worktree lease renewal failed: ${(error as Error).message}`,
      );
    } finally {
      task.leaseRenewal = null;
    }

    try {
      const cleanup = await cleanupWorktree(task.worktree, reason, options.keepWorktrees);
      emit({
        type: "worktree.removed",
        batchId,
        taskId: task.taskId,
        kept: !cleanup.removed,
      });
      task.result.worktreePath = cleanup.removed ? null : (cleanup.keptAt ?? null);
      if (!cleanup.removed) {
        const retainedReason = cleanup.error
          ? "cleanup-failed"
          : task.worktreeOutcomeError
            ? "evidence-failure"
            : integrationConflicts.length > 0
              ? "integration-conflict"
              : options.integrate === false
                ? "integration-disabled"
                : integrationIncomplete
                  ? outcomeFailures.length > 0
                    ? "integration-not-attempted"
                    : "integration-partial"
                  : "retention-policy";
        emit({
          type: "worktree.retained",
          batchId,
          taskId: task.taskId,
          reason: retainedReason,
        });
      }
      if (cleanup.error) {
        task.result.warnings.push(`Worktree cleanup incomplete: ${cleanup.error}`);
        lifecycleError ??= new Error(cleanup.error);
      }

      let retainedLease = false;
      if (
        !renewalError &&
        task.result.result &&
        !resultWasCancelled(task.result.result) &&
        options.continuationRegistrar
      ) {
        // Integrated parallel work can safely continue in the requested
        // workspace after its temporary worktree is removed. When integration
        // was disabled or conflicted, the kept worktree is the only honest
        // continuation directory and must remain available until expiry.
        const continuationInWorkspace =
          mode === "sequential" || (task.state === "completed" && !keepForConflict);
        const continuationDirectory = continuationInWorkspace
          ? workspace
          : cleanup.removed
            ? null
            : (cleanup.keptAt ?? null);
        if (continuationDirectory && !task.worktreeOutcomeError) {
          let continuationProtected = true;
          const worktreeLease = continuationInWorkspace
            ? null
            : (task.worktree.lease ?? null);
          if (!continuationInWorkspace) {
            if (!worktreeLease) {
              continuationProtected = false;
              task.result.warnings.push(
                "Continuation was not issued because its retained worktree has no persistent lease.",
              );
            } else {
              try {
                await refreshWorktreeLease(
                  worktreeLease,
                  Date.now() + CONTINUATION_TTL_MS + WORKTREE_LEASE_GRACE_MS,
                  "retained-continuation",
                );
              } catch (error) {
                continuationProtected = false;
                task.result.warnings.push(
                  `Continuation was not issued because its retained worktree could not be protected: ${(error as Error).message}`,
                );
              }
            }
          }
          if (continuationProtected) {
            try {
              const reference = await options.continuationRegistrar(
                task.input,
                task.result.result,
                continuationDirectory,
                !continuationInWorkspace,
                worktreeLease,
              );
              task.result.result.continuationReference = reference;
              retainedLease = Boolean(reference && worktreeLease);
            } catch (error) {
              lifecycleError ??= error;
              task.result.warnings.push(
                `Continuation registration failed: ${(error as Error).message}`,
              );
              task.result.result.continuationState = {
                status: "unavailable",
                reason: `Continuation registration failed: ${(error as Error).message}`,
              };
            }
          }
        }
      }
      if (!cleanup.removed && task.worktree.lease && !retainedLease && !renewalError) {
        await releaseWorktreeLease(task.worktree.lease);
      }
    } catch (error) {
      lifecycleError ??= error;
      const detail = `Worktree lifecycle cleanup failed after execution: ${(error as Error).message}`;
      task.result.error ??= detail;
      task.result.warnings.push(detail);
    } finally {
      releaseWorktreeOwnership(task.worktree);
    }
  }

  if (lifecycleError) {
    completionState = "needs-supervisor";
    warnings.push(
      `Post-execution lifecycle cleanup was incomplete: ${(lifecycleError as Error).message}. ` +
        "Completed worker and sibling evidence has been retained.",
    );
  }

  for (const task of running) {
    const taskFinalVerification = integrationVerification.filter((run) =>
      task.input.verificationCommands.includes(run.command),
    );
    setFailureDecision(
      task,
      integrationConflicts.some((conflict) => conflict.tasks.includes(task.taskId)),
      taskFinalVerification,
    );
  }

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  const passed = running.filter((task) => task.result.result?.verdict === "PASS").length;
  const failed = running.length - passed;

  if (running.some((task) => task.state === "cancelled")) {
    emit({
      type: "batch.cancelled",
      batchId,
      reason: "Batch cancellation was requested before the batch completed.",
    });
  } else {
    emit({ type: "batch.completed", batchId, durationSeconds, passed, failed });
  }

  return {
    batchId,
    mode,
    maxParallel,
    taskCount: running.length,
    passed,
    failed,
    durationSeconds,
    tasks: running.map((task) => task.result),
    scopeConflicts: scopeConflicts.map((conflict) => conflict.detail),
    integrationConflicts: integrationConflicts.map((conflict) => ({
      path: conflict.path,
      tasks: conflict.tasks,
    })),
    integrated,
    integrationSummary,
    integrationVerification,
    completionState,
    warnings,
    automaticRecovery: options.automaticRecovery ?? true,
    reviewChecklist: buildBatchChecklist(
      running,
      integrationConflicts,
      integrated,
      mode,
      integrationVerification,
      completionState,
    ),
  };
}

/** Convert task, verdict, evidence, and integration state into one cleanup decision. */
function worktreeCleanupReason(
  task: RunningTask,
  isolatedStateRequired: boolean,
): CleanupReason {
  if (task.worktreeOutcomeError) return "evidence-failure";
  if (task.state === "cancelled") return "cancelled";
  if (
    task.state !== "completed" ||
    task.result.result?.verdict !== "PASS" ||
    isolatedStateRequired
  ) {
    return "failure";
  }
  return "success";
}

/** Tasks share the workspace and run one at a time, so each sees the last one's work. */
async function runSequential(
  batchId: string,
  running: RunningTask[],
  workspace: string,
  run: TaskExecutor,
  emit: EventEmitter,
  signal?: AbortSignal,
): Promise<void> {
  for (const task of running) {
    if (signal?.aborted) {
      markCancelled(batchId, task, emit);
      continue;
    }
    const release = await workerSlots.acquire();
    try {
      await runOne(batchId, task, workspace, run, emit, signal, true, {
        attempt: task.result.attempt ?? 1,
      });
    } finally {
      release();
    }
  }
}

/** Tasks run concurrently, each in its own worktree. */
async function runParallel(
  batchId: string,
  running: RunningTask[],
  workspace: string,
  run: TaskExecutor,
  emit: EventEmitter,
  signal?: AbortSignal,
  protectedWorktreePaths: Iterable<string> = [],
  leaseMaintainer: typeof maintainWorktreeLease = maintainWorktreeLease,
  policySlots: Semaphore = new Semaphore(MAX_PARALLEL),
): Promise<string[]> {
  const warnings: string[] = [];

  const base = await prepareWorktreeBase(
    workspace,
    running.map((task) => task.input.allowedFiles),
  );

  const pruned = await pruneStaleWorktrees(base.repoRoot, protectedWorktreePaths);
  if (pruned.length > 0) {
    warnings.push(`Removed ${pruned.length} stale worktree(s) from an earlier run.`);
  }
  if (base.dirtyPaths.length > 0) {
    warnings.push(
      `The repository has ${base.dirtyPaths.length} uncommitted path(s) outside the ` +
        `task scopes. Workers branched from HEAD and did not see them.`,
    );
  }

  // --- Setup: build every isolated workspace before any worker starts ------
  //
  // Deliberately a plain sequential loop. `git worktree add` mutates metadata
  // shared by the whole repository, and running two at once makes one of them
  // abort reading the other's half-written `commondir`. The operations are
  // milliseconds each, so serializing them costs nothing measurable, and doing
  // it here means a worktree that cannot be created is discovered before any
  // model tokens are spent on the rest of the batch.
  //
  // `createTaskWorktree` is independently serialized, so this ordering is a
  // scheduling choice rather than the safety mechanism.
  for (const task of running) {
    if (signal?.aborted) {
      markCancelled(batchId, task, emit);
      continue;
    }
    try {
      task.worktree = await createTaskWorktreeTracked(
        batchId,
        base,
        task,
        workspace,
        emit,
      );
      if (task.worktree.lease) {
        task.leaseRenewal = leaseMaintainer(
          task.worktree.lease,
          taskLeaseLifetimeMs(task.input),
          "running",
        );
      }
      task.result.warnings.push(...task.worktree.warnings);
    } catch (error) {
      // Partial failure is preserved: this task is marked failed and the rest
      // of the batch still runs.
      task.state = "failed";
      task.result.state = "failed";
      task.result.error = `Could not create an isolated worktree: ${(error as Error).message}`;
      emit({
        type: "worker.failed",
        batchId,
        taskId: task.taskId,
        reason: task.result.error,
      });
    }
  }

  // --- Execution: the expensive part, genuinely concurrent -----------------
  //
  // Two bounds, always acquired in the same order: this batch's compute-policy
  // limit, then the process-wide worker limit. A consistent order is what keeps
  // nesting two semaphores deadlock-free, and the policy semaphore is owned by
  // the batch rather than this window so the bounded recovery pass queues
  // behind the same limit. Every workspace already exists, so workers start
  // together instead of queueing behind each other's setup.
  await Promise.all(
    running.map(async (task) => {
      const worktree = task.worktree;
      if (!worktree || task.state === "failed" || task.state === "cancelled") return;

      if (signal?.aborted) {
        markCancelled(batchId, task, emit);
        return;
      }
      const policyRelease = await policySlots.acquire();
      const release = await workerSlots.acquire();
      try {
        if (signal?.aborted) {
          markCancelled(batchId, task, emit);
          return;
        }

        await runOne(batchId, task, worktree.path, run, emit, signal, false, {
          attempt: task.result.attempt ?? 1,
        });

        const outcome = await readWorktreeOutcome(worktree);
        task.result.warnings.push(...outcome.warnings);
        task.result.diff = truncateDiff(outcome.changes.diff);

        const changes = outcome.changes.files.map((file) => ({
          path: file.path,
          kind: file.status,
        }));
        if (task.result.result) {
          task.result.result = reconcileParallelWorktreeEvidence(
            task.input,
            task.result.result,
            worktree.path,
            changes,
            outcome.error,
          );
          task.result.changedFiles = task.result.result.filesChanged
            .filter((file) => file.observed)
            .map((file) => file.path);
        } else {
          task.result.changedFiles = outcome.changes.files.map((file) => file.path);
        }

        if (outcome.error) {
          task.worktreeOutcomeError = outcome.error;
          task.result.error = `Could not read worktree evidence: ${outcome.error}`;
          if (!isCancelled(task)) {
            task.state = "failed";
            task.result.state = "failed";
            emit({
              type: "worker.failed",
              batchId,
              taskId: task.taskId,
              reason: task.result.error,
              attempt: task.result.attempt ?? 1,
            });
          }
        } else if (!isCancelled(task) && !isFailed(task)) {
          emitWorkerCompleted(batchId, task, emit, {
            attempt: task.result.attempt ?? 1,
          });
        }
      } catch (error) {
        const detail = `Post-execution evidence lifecycle failed: ${(error as Error).message}`;
        task.state = "failed";
        task.result.state = "failed";
        task.result.error ??= detail;
        task.result.warnings.push(detail);
        if (task.result.result) {
          task.result.result.verdict = "FAILED";
          task.result.result.trustworthy = false;
          if (!task.result.result.errors.includes(detail)) {
            task.result.result.errors.push(detail);
          }
          task.result.result.continuationReference = null;
          task.result.result.continuationState = {
            status: "unavailable",
            reason: detail,
          };
        }
        emit({
          type: "worker.failed",
          batchId,
          taskId: task.taskId,
          reason: detail,
          attempt: task.result.attempt ?? 1,
        });
      } finally {
        release();
        policyRelease();
      }
    }),
  );

  return warnings;
}

function hasRefusedVerification(result: DelegateTaskOutput): boolean {
  return result.verification.some(
    (run) =>
      run.source === "orchestrator" &&
      (run.execution === "rejected" || run.execution === "skipped"),
  );
}

function confinedWorktreeEvidence(task: RunningTask): boolean {
  if (!task.worktree || task.worktreeOutcomeError) return false;
  const violations = findScopeViolations(
    task.result.changedFiles,
    task.input.allowedFiles,
    task.input.forbiddenFiles,
    task.worktree.path,
  );
  return violations.length === 0;
}

function recoveryDecision(
  task: RunningTask,
  enabled: boolean,
  integrationConflicts: IntegrationConflict[],
): RecoveryDecision {
  const result = task.result.result;
  const initialAttempt = task.result.attempt ?? result?.attempt ?? 1;
  const base = (
    attempted: boolean,
    classification: RecoveryClassification,
    evidence: string,
    recoveryAttempt: number | null = null,
    recoveryDurationSeconds: number | null = null,
    recoveryUsage: DelegateTaskOutput["usage"] = null,
  ): RecoveryDecision => ({
    attempted,
    classification,
    evidence,
    initialAttempt,
    recoveryAttempt,
    initialDurationSeconds: result?.durationSeconds ?? null,
    recoveryDurationSeconds,
    initialUsage: result?.usage ?? null,
    recoveryUsage,
  });

  if (!enabled) return base(false, "disabled", "Batch automatic recovery was opted out.");
  if (task.state === "completed" && result?.verdict === "PASS") {
    return base(
      false,
      "already-successful",
      "The initial task passed; successful streams are never rerun.",
    );
  }
  if (task.state === "cancelled" || (result && resultWasCancelled(result))) {
    return base(
      false,
      "cancellation",
      "Cancellation is terminal and cannot trigger automatic recovery.",
    );
  }
  if (integrationConflicts.some((conflict) => conflict.tasks.includes(task.taskId))) {
    return base(
      false,
      "integration-conflict",
      "Initial changed-file evidence already conflicts with another stream.",
    );
  }
  if (!task.worktree) {
    return base(
      false,
      "no-owned-worktree",
      "No owned worktree remained after the initial parallel window.",
    );
  }
  if (task.worktreeOutcomeError) {
    return base(false, "evidence-failure", "Final worktree evidence could not be read.");
  }
  if (!confinedWorktreeEvidence(task)) {
    return base(
      false,
      "scope-or-conflict",
      "The owned worktree evidence is not confined to the immutable task scope.",
    );
  }

  if (result) {
    if (result.scopeViolations.length > 0) {
      return base(false, "scope-or-conflict", "Scope violations require parent review.");
    }
    if (result.discrepancies.length > 0) {
      return base(
        false,
        "contract-discrepancy",
        "Claims and observed evidence disagree; recovery cannot repair that contract discrepancy.",
      );
    }
    if (hasRefusedVerification(result)) {
      return base(
        false,
        "refused-verification",
        "Refused or skipped verification is not trustworthy recovery evidence.",
      );
    }
    const failure = classifyFailureDecision(task.input, result, {
      state: task.state,
      attempts: task.result.attempts,
      error: task.result.error,
      recovery: task.recovery,
    });
    if (failure.classification === "timeout" && !result.workerThreadId) {
      return base(
        false,
        "no-trustworthy-thread",
        "The timeout produced no trustworthy Luna thread id to resume.",
      );
    }
    if (failure.classification === "security-or-trust-boundary") {
      return base(false, "security-or-trust-boundary", failure.reason);
    }
    if (failure.classification === "timeout" && failure.action === "continuation") {
      return base(
        true,
        "timeout-continuation",
        "Timeout with a thread id and confined, readable worktree evidence; resume once in place.",
      );
    }
    if (
      failure.classification === "runtime" &&
      failure.action === "retry" &&
      task.result.attempts?.at(-1)?.termination.kind === "process-exit"
    ) {
      return base(
        true,
        "worker-process-retry",
        "Authoritative attempt evidence records a worker process exit and the owned worktree evidence is confined and readable; retry once in a fresh process.",
      );
    }
    return base(
      false,
      "not-eligible",
      `P1.1 selected ${failure.action} (${failure.classification}), which is outside bounded parallel automatic recovery: ${failure.reason}`,
    );
  }

  if (task.state === "failed") {
    const failure = classifyFailureDecision(task.input, null, {
      state: task.state,
      attempts: task.result.attempts,
      error: task.result.error,
      recovery: task.recovery,
    });
    if (
      failure.classification === "runtime" &&
      failure.action === "retry" &&
      task.result.attempts?.at(-1)?.termination.kind === "process-exit"
    ) {
      return base(
        true,
        "worker-process-retry",
        "Authoritative attempt evidence records a worker process exit without a result, and the owned worktree evidence is confined and readable; retry once in a fresh process.",
      );
    }
    return base(
      false,
      "not-eligible",
      `P1.1 selected ${failure.action} (${failure.classification}); an unused retry allowance alone cannot authorize another process: ${failure.reason}`,
    );
  }
  return base(
    false,
    "not-eligible",
    "The task did not produce an eligible failed parallel stream.",
  );
}

function setRecoveryMetadata(task: RunningTask, metadata: RecoveryDecision): void {
  task.recovery = metadata;
  task.result.recovery = metadata;
  if (task.result.result) task.result.result.recovery = metadata;
}

function setFailureDecision(
  task: RunningTask,
  integrationConflict = false,
  finalVerification: BatchOutput["integrationVerification"] = [],
): void {
  const context = {
    state: task.state,
    attempts: task.result.attempts,
    error: task.result.error,
    integrationConflict,
    evidenceFailure:
      task.worktreeOutcomeError !== null ||
      task.result.warnings.some((warning) =>
        /(?:evidence|continuation registration|worktree lifecycle|lease renewal|cleanup incomplete)/i.test(
          warning,
        ),
      ),
    finalVerificationFailure: finalVerification.some(
      (run) => !run.passed && (run.execution === "argv" || run.execution === "shell"),
    ),
    finalVerificationRefused: finalVerification.some(
      (run) => run.execution === "rejected" || run.execution === "skipped",
    ),
    recovery: task.recovery,
  };
  const decision = task.result.result
    ? applyFailureDecision(task.input, task.result.result, context)
    : classifyFailureDecision(task.input, null, context);
  task.result.failureDecision = decision;
}

function recoveryInstruction(decision: RecoveryDecision): string {
  return [
    "Recover this failed parallel task in one bounded additional turn.",
    "Preserve the original objective, scope, change intent, acceptance criteria, verification commands, effort, and task identity exactly; do not widen or delegate.",
    `Recovery classification: ${decision.classification}`,
    `Authoritative recovery evidence: ${decision.evidence}`,
  ].join("\n");
}

function mergeRecoveredResult(
  initial: DelegateTaskOutput | null,
  recovered: DelegateTaskOutput,
  metadata: RecoveryDecision,
  attempts: AttemptEvidence[],
): void {
  const attempt = (initial?.attempt ?? 1) + 1;
  recovered.attempt = attempt;
  recovered.durationSeconds = (initial?.durationSeconds ?? 0) + recovered.durationSeconds;
  recovered.usage = mergeUsage(initial?.usage ?? null, recovered.usage);
  recovered.attempts = [...attempts];
  recovered.recovery = metadata;
}

async function recoverParallel(
  batchId: string,
  running: RunningTask[],
  workspace: string,
  run: TaskExecutor,
  emit: EventEmitter,
  signal: AbortSignal | undefined,
  enabled: boolean,
  integrationConflicts: IntegrationConflict[],
  policySlots: Semaphore,
): Promise<void> {
  const candidates: Array<{ task: RunningTask; decision: RecoveryDecision }> = [];
  for (const task of running) {
    const decision = recoveryDecision(task, enabled, integrationConflicts);
    setRecoveryMetadata(task, decision);
    task.result.attempt = decision.initialAttempt;
    if (decision.attempted) {
      candidates.push({ task, decision });
    } else {
      emit({
        type: "recovery.skipped",
        batchId,
        taskId: task.taskId,
        attempt: decision.initialAttempt,
        classification: decision.classification,
        evidence: decision.evidence,
      });
    }
  }

  await Promise.all(
    candidates.map(async ({ task, decision }) => {
      if (signal?.aborted) {
        task.recovery = {
          ...decision,
          attempted: false,
          classification: "cancellation",
          evidence:
            "Batch cancellation arrived before the bounded recovery turn started.",
        };
        setRecoveryMetadata(task, task.recovery);
        emit({
          type: "recovery.skipped",
          batchId,
          taskId: task.taskId,
          attempt: decision.initialAttempt,
          classification: "cancellation",
          evidence: task.recovery.evidence,
        });
        return;
      }

      const initial = task.result.result;
      const attempt = decision.initialAttempt + 1;
      const predecessorExecutionId = task.result.attempts?.at(-1)?.executionId ?? null;
      const executionId = createExecutionId();
      const startedAt = Date.now();
      const policyRelease = await policySlots.acquire();
      const release = await workerSlots.acquire();
      try {
        task.recovery = { ...decision, recoveryAttempt: attempt };
        setRecoveryMetadata(task, task.recovery);
        task.result.attempt = attempt;
        task.result.result = null;
        task.result.error = null;
        task.worktreeOutcomeError = null;
        emit({
          type: "recovery.started",
          batchId,
          taskId: task.taskId,
          attempt,
          classification: decision.classification,
          evidence: decision.evidence,
          executionId,
          predecessorExecutionId,
        });

        await runOne(batchId, task, task.worktree!.path, run, emit, signal, false, {
          attempt,
          resumeThreadId:
            decision.classification === "timeout-continuation"
              ? (initial?.workerThreadId ?? undefined)
              : undefined,
          continuationInstruction: recoveryInstruction(decision),
          allowAutomaticRepair: false,
          executionId,
          role:
            decision.classification === "timeout-continuation"
              ? "timeout-recovery"
              : "process-retry",
          predecessorExecutionId,
        });

        const outcome = await readWorktreeOutcome(task.worktree!);
        task.result.warnings.push(...outcome.warnings);
        task.result.diff = truncateDiff(outcome.changes.diff);
        const changes = outcome.changes.files.map((file) => ({
          path: file.path,
          kind: file.status,
        }));
        if (task.result.result) {
          task.result.result = reconcileParallelWorktreeEvidence(
            task.input,
            task.result.result,
            task.worktree!.path,
            changes,
            outcome.error,
          );
          task.result.changedFiles = task.result.result.filesChanged
            .filter((file) => file.observed)
            .map((file) => file.path);
        } else {
          task.result.changedFiles = outcome.changes.files.map((file) => file.path);
        }

        const recoveryDurationSeconds = Math.round((Date.now() - startedAt) / 1000);
        const recoveryEvidence = task.result.attempts?.find(
          (entry) => entry.executionId === executionId,
        );
        task.recovery = {
          ...task.recovery!,
          recoveryDurationSeconds,
          recoveryUsage:
            recoveryEvidence?.usage.status === "reported"
              ? recoveryEvidence.usage.value
              : null,
        };
        if (outcome.error) {
          task.worktreeOutcomeError = outcome.error;
          task.result.error = `Could not read worktree evidence: ${outcome.error}`;
          task.state = "failed";
          task.result.state = "failed";
        } else if (task.result.result) {
          emitWorkerCompleted(batchId, task, emit, { attempt });
          if (task.state !== "cancelled") task.result.state = task.state;
          mergeRecoveredResult(
            initial,
            task.result.result,
            task.recovery,
            task.result.attempts ?? [],
          );
        } else if (initial) {
          // A failed recovery must not erase the trustworthy initial timeout
          // result. The batch-level error and recovery metadata describe the
          // second attempt while the original result preserves its evidence.
          const recoveryErrors = task.result.error
            ? initial.errors.includes(task.result.error)
              ? initial.errors
              : [...initial.errors, task.result.error]
            : initial.errors;
          task.result.result = {
            ...initial,
            attempts: [...(task.result.attempts ?? initial.attempts ?? [])],
            recovery: task.recovery,
            errors: recoveryErrors,
            durationSeconds: initial.durationSeconds + recoveryDurationSeconds,
            usage: mergeUsage(initial.usage, task.recovery.recoveryUsage),
          };
        }
        task.result.recovery = task.recovery;
        if (task.result.result) task.result.result.recovery = task.recovery;
        emit({
          type: "recovery.completed",
          batchId,
          taskId: task.taskId,
          attempt,
          classification: task.recovery.classification,
          evidence: task.recovery.evidence,
          verdict: task.result.result?.verdict ?? "FAILED",
          durationSeconds: recoveryDurationSeconds,
          threadId: recoveryEvidence?.threadId ?? null,
          usage: task.recovery.recoveryUsage,
          executionId,
          predecessorExecutionId,
        });
      } catch (error) {
        const detail = `Post-recovery evidence lifecycle failed: ${(error as Error).message}`;
        const recoveryDurationSeconds = Math.round((Date.now() - startedAt) / 1000);
        const recoveryEvidence = task.result.attempts?.find(
          (entry) => entry.executionId === executionId,
        );
        task.recovery = {
          ...(task.recovery ?? decision),
          attempted: true,
          recoveryAttempt: attempt,
          recoveryDurationSeconds,
          recoveryUsage:
            recoveryEvidence?.usage.status === "reported"
              ? recoveryEvidence.usage.value
              : null,
        };
        task.state = "failed";
        task.result.state = "failed";
        task.result.error = detail;
        task.result.warnings.push(detail);
        if (task.result.result) {
          task.result.result.verdict = "FAILED";
          task.result.result.trustworthy = false;
          if (!task.result.result.errors.includes(detail)) {
            task.result.result.errors.push(detail);
          }
          mergeRecoveredResult(
            initial,
            task.result.result,
            task.recovery,
            task.result.attempts ?? [],
          );
        } else if (initial) {
          task.result.result = {
            ...initial,
            attempts: [...(task.result.attempts ?? initial.attempts ?? [])],
            recovery: task.recovery,
            errors: initial.errors.includes(detail)
              ? initial.errors
              : [...initial.errors, detail],
            durationSeconds: initial.durationSeconds + recoveryDurationSeconds,
            usage: mergeUsage(initial.usage, task.recovery.recoveryUsage),
          };
        }
        task.result.recovery = task.recovery;
        emit({
          type: "worker.failed",
          batchId,
          taskId: task.taskId,
          reason: detail,
          attempt,
        });
        emit({
          type: "recovery.completed",
          batchId,
          taskId: task.taskId,
          attempt,
          classification: task.recovery.classification,
          evidence: task.recovery.evidence,
          verdict: "FAILED",
          durationSeconds: recoveryDurationSeconds,
          threadId: recoveryEvidence?.threadId ?? null,
          usage: task.recovery.recoveryUsage,
          executionId,
          predecessorExecutionId,
        });
      } finally {
        release();
        policyRelease();
      }
    }),
  );
}

async function createTaskWorktreeTracked(
  batchId: string,
  base: Awaited<ReturnType<typeof prepareWorktreeBase>>,
  task: RunningTask,
  workspace: string,
  emit: EventEmitter,
): Promise<TaskWorktree> {
  const worktree = await createTaskWorktree(
    base,
    `${batchId}-${task.taskId}`,
    workspace,
    taskLeaseLifetimeMs(task.input),
  );
  emit({
    type: "worktree.created",
    batchId,
    taskId: task.taskId,
    path: worktree.path,
  });
  return worktree;
}

function taskLeaseLifetimeMs(input: DelegateTaskInput): number {
  return (
    Math.max(1, input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000 +
    WORKTREE_LEASE_GRACE_MS
  );
}

/** Run one task and fold its outcome into the batch record. */
interface RunAttemptOptions {
  attempt: number;
  resumeThreadId?: string;
  continuationInstruction?: string;
  allowAutomaticRepair?: boolean;
  executionId?: string;
  role?: AttemptRole;
  predecessorExecutionId?: string | null;
}

function emitCanonicalAttemptCompletion(
  emit: EventEmitter,
  batchId: string,
  taskId: string,
  evidence: AttemptEvidence,
): void {
  emitAttemptCompleted(emit, batchId, taskId, evidence);
  if (evidence.verification.length === 0) return;
  const executed = evidence.verification.filter(
    (run) => run.execution === "argv" || run.execution === "shell",
  );
  emit({
    type: "verification.completed",
    batchId,
    taskId,
    passed: executed.filter((run) => run.passed).length,
    failed: executed.filter((run) => !run.passed).length,
    refused: evidence.verification.filter(
      (run) => run.execution === "rejected" || run.execution === "skipped",
    ).length,
    executionId: evidence.executionId,
    attempt: evidence.logicalAttempt,
    role: evidence.role,
  });
}

async function runOne(
  batchId: string,
  task: RunningTask,
  workingDirectory: string,
  run: TaskExecutor,
  emit: EventEmitter,
  signal?: AbortSignal,
  emitCompletion = true,
  attemptOptions: RunAttemptOptions = { attempt: 1 },
): Promise<void> {
  const executionId = attemptOptions.executionId ?? createExecutionId();
  const role = attemptOptions.role ?? "initial";
  const startedAt = new Date();
  const startedMs = Date.now();
  const emittedAttemptStarts = new Set<string>();
  emitAttemptStarted(emit, batchId, task.taskId, {
    executionId,
    logicalAttempt: attemptOptions.attempt,
    role,
    predecessorExecutionId: attemptOptions.predecessorExecutionId ?? null,
    requestedModel: LUNA_MODEL,
    requestedEffort: task.input.effort,
    threadOperation: attemptOptions.resumeThreadId ? "resume" : "start",
    startedAt: startedAt.toISOString(),
    timeoutMs: (task.input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
  });
  emittedAttemptStarts.add(executionId);
  task.state = "running";
  task.result.state = "running";
  emit({
    type: "worker.started",
    batchId,
    taskId: task.taskId,
    effort: task.input.effort,
    workingDirectory,
    model: LUNA_MODEL,
    attempt: attemptOptions.attempt,
    ...(task.recovery
      ? {
          recoveryClassification: task.recovery.classification,
          recoveryEvidence: task.recovery.evidence,
        }
      : {}),
  });

  try {
    const result = await run(task.input, {
      workingDirectory,
      signal,
      resumeThreadId: attemptOptions.resumeThreadId,
      continuationInstruction: attemptOptions.continuationInstruction,
      executionId,
      logicalAttempt: attemptOptions.attempt,
      role,
      predecessorExecutionId: attemptOptions.predecessorExecutionId ?? null,
      ...(attemptOptions.allowAutomaticRepair === undefined
        ? {}
        : { allowAutomaticRepair: attemptOptions.allowAutomaticRepair }),
      onVerificationStart: (commandCount, attribution) =>
        emit({
          type: "verification.started",
          batchId,
          taskId: task.taskId,
          commandCount,
          executionId: attribution.executionId,
          attempt: attribution.logicalAttempt,
          role: attribution.role,
        }),
      onRepairStart: (classification, repairExecutionId) => {
        emit({
          type: "repair.started",
          batchId,
          taskId: task.taskId,
          classification,
          turn: 1,
          executionId: repairExecutionId,
        });
      },
      onRepairComplete: (verdict, repairExecutionId) =>
        emit({
          type: "repair.completed",
          batchId,
          taskId: task.taskId,
          verdict,
          turn: 1,
          executionId: repairExecutionId,
        }),
      onAttemptStart: (evidence) => {
        if (emittedAttemptStarts.has(evidence.executionId)) return;
        emittedAttemptStarts.add(evidence.executionId);
        emitAttemptStarted(emit, batchId, task.taskId, evidence);
      },
      onAttemptComplete: (evidence) => {
        task.result.attempts ??= [];
        task.result.attempts.push(evidence);
        emitCanonicalAttemptCompletion(emit, batchId, task.taskId, evidence);
      },
    });

    if (!task.result.attempts?.some((entry) => entry.executionId === executionId)) {
      const timedOut = result.errors.some((error) =>
        /exceeded its .* budget/.test(error),
      );
      const cancelled = resultWasCancelled(result);
      const runtimeError = result.errors[0] ?? null;
      const termination = timedOut
        ? "timed-out"
        : cancelled
          ? "cancelled"
          : runtimeError
            ? "runtime-error"
            : "completed";
      const authoritative = result.verification.filter(
        (run) => run.source === "orchestrator",
      );
      const evidence: AttemptEvidence = {
        executionId,
        logicalAttempt: attemptOptions.attempt,
        role,
        predecessorExecutionId: attemptOptions.predecessorExecutionId ?? null,
        requestedModel: result.model,
        requestedEffort: result.effort,
        threadId: result.workerThreadId,
        threadOperation: attemptOptions.resumeThreadId ? "resume" : "start",
        threadIdentityMatched: attemptOptions.resumeThreadId
          ? result.workerThreadId === null
            ? null
            : result.workerThreadId === attemptOptions.resumeThreadId
          : null,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: Math.max(0, Date.now() - startedMs),
        workerElapsedMs: Math.max(0, Date.now() - startedMs),
        verificationElapsedMs: 0,
        timeoutMs: (task.input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        termination: { kind: termination, message: runtimeError },
        usage: result.usage
          ? {
              status: "reported",
              source: "codex-turn.completed",
              value: { ...result.usage },
            }
          : {
              status: "unavailable",
              reason: termination === "completed" ? "no-turn-completed" : termination,
            },
        workerClaimedStatus: result.workerClaimedStatus,
        workerClaimedFailureCauses: [...(result.workerClaimedFailureCauses ?? [])],
        verification: authoritative.map((run) => ({ ...run })),
      };
      task.result.attempts ??= [];
      task.result.attempts.push(evidence);
      emitCanonicalAttemptCompletion(emit, batchId, task.taskId, evidence);
    }
    result.attempts = [...(task.result.attempts ?? result.attempts ?? [])];
    task.result.result = result;

    // Cancellation only applies when the worker was actually interrupted. A
    // task that ran to completion keeps its result even if the batch was
    // cancelled afterwards — finished work is never thrown away.
    if (resultWasCancelled(result)) {
      task.state = "cancelled";
      task.result.state = "cancelled";
      emit({
        type: "worker.cancelled",
        batchId,
        taskId: task.taskId,
        attempt: attemptOptions.attempt,
      });
      return;
    }

    const timedOut = result.errors.some((error) => /exceeded its .* budget/.test(error));
    task.state = timedOut ? "timedOut" : "completed";
    task.result.state = task.state;

    if (timedOut) {
      emit({
        type: "worker.timedOut",
        batchId,
        taskId: task.taskId,
        timeoutSeconds: task.input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        attempt: attemptOptions.attempt,
        ...(task.recovery
          ? {
              recoveryClassification: task.recovery.classification,
              recoveryEvidence: task.recovery.evidence,
            }
          : {}),
      });
    }

    // In sequential mode there is no worktree to read, so take the file list
    // the analysis already established.
    if (task.result.changedFiles.length === 0) {
      task.result.changedFiles = result.filesChanged
        .filter((file) => file.observed)
        .map((file) => file.path);
    }

    if (emitCompletion) emitWorkerCompleted(batchId, task, emit, attemptOptions);
  } catch (error) {
    if (!task.result.attempts?.some((entry) => entry.executionId === executionId)) {
      const message = (error as Error).message;
      const termination = /^Codex Exec exited with (?:signal|code)\b/i.test(message)
        ? "process-exit"
        : "runtime-error";
      const evidence: AttemptEvidence = {
        executionId,
        logicalAttempt: attemptOptions.attempt,
        role,
        predecessorExecutionId: attemptOptions.predecessorExecutionId ?? null,
        requestedModel: LUNA_MODEL,
        requestedEffort: task.input.effort,
        threadId: null,
        threadOperation: attemptOptions.resumeThreadId ? "resume" : "start",
        threadIdentityMatched: null,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: Math.max(0, Date.now() - startedMs),
        workerElapsedMs: Math.max(0, Date.now() - startedMs),
        verificationElapsedMs: 0,
        timeoutMs: (task.input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
        termination: { kind: termination, message },
        usage: { status: "unavailable", reason: termination },
        workerClaimedStatus: null,
        workerClaimedFailureCauses: [],
        verification: [],
      };
      task.result.attempts ??= [];
      task.result.attempts.push(evidence);
      emitCanonicalAttemptCompletion(emit, batchId, task.taskId, evidence);
    }
    task.state = "failed";
    task.result.state = "failed";
    task.result.error = (error as Error).message;
    emit({
      type: "worker.failed",
      batchId,
      taskId: task.taskId,
      reason: task.result.error,
      attempt: attemptOptions.attempt,
      ...(task.recovery
        ? {
            recoveryClassification: task.recovery.classification,
            recoveryEvidence: task.recovery.evidence,
          }
        : {}),
    });
  }
}

function emitWorkerCompleted(
  batchId: string,
  task: RunningTask,
  emit: EventEmitter,
  attemptOptions: RunAttemptOptions = { attempt: 1 },
): void {
  const result = task.result.result;
  if (!result) return;
  emit({
    type: "worker.completed",
    batchId,
    taskId: task.taskId,
    verdict: result.verdict,
    claimed: result.workerClaimedStatus,
    durationSeconds: result.durationSeconds,
    threadId: result.workerThreadId,
    model: result.model,
    effort: result.effort,
    changedFiles: result.filesChanged.filter((file) => file.observed).length,
    failureReason: activityFailureReason(result),
    usage: result.usage,
    attempt: attemptOptions.attempt,
    ...(task.recovery
      ? {
          recoveryClassification: task.recovery.classification,
          recoveryEvidence: task.recovery.evidence,
        }
      : {}),
  });
}

const isCancelled = (task: RunningTask): boolean => task.state === "cancelled";
const isFailed = (task: RunningTask): boolean => task.state === "failed";

function markCancelled(batchId: string, task: RunningTask, emit: EventEmitter): void {
  task.state = "cancelled";
  task.result.state = "cancelled";
  task.result.error = "Cancelled before this task started.";
  emit({
    type: "worker.cancelled",
    batchId,
    taskId: task.taskId,
    attempt: task.result.attempt ?? 1,
  });
}

const MAX_DIFF_CHARS = 20_000;
const truncateDiff = (diff: string): string =>
  diff.length <= MAX_DIFF_CHARS
    ? diff
    : `${diff.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated, ${diff.length - MAX_DIFF_CHARS} chars omitted]`;

/**
 * Copy each worker's changed files from its worktree into the workspace.
 *
 * A plain file copy rather than a git merge: the callers are separate detached
 * worktrees off the same base with provably disjoint file sets, so there is
 * nothing to merge, and a copy has behaviour that is obvious under review.
 */
async function integrateWorktrees(
  batchId: string,
  tasks: RunningTask[],
  workspace: string,
  emit: EventEmitter,
): Promise<{ fileCount: number; warnings: string[] }> {
  const warnings: string[] = [];
  let fileCount = 0;

  for (const task of tasks) {
    if (!task.worktree) continue;
    let applied = 0;

    for (const file of task.result.changedFiles) {
      const source = path.join(task.worktree.path, ...file.split("/"));
      const destination = path.join(workspace, ...file.split("/"));

      try {
        const stat = await fs.lstat(source).catch(() => null);
        if (!stat) {
          // The worker deleted it; mirror that.
          await fs.rm(destination, { force: true });
          applied += 1;
          continue;
        }
        if (stat.isDirectory()) continue;

        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
        applied += 1;
      } catch (error) {
        warnings.push(
          `Could not integrate ${file} from ${task.taskId}: ${(error as Error).message}`,
        );
      }
    }

    fileCount += applied;
    if (applied < task.result.changedFiles.length) {
      emit({
        type: applied > 0 ? "integration.partial" : "integration.failed",
        batchId,
        taskId: task.taskId,
        attemptedFiles: task.result.changedFiles.length,
        appliedFiles: applied,
      });
    }
    emit({
      type: "integration.applied",
      batchId,
      taskId: task.taskId,
      fileCount: applied,
    });
  }

  return { fileCount, warnings };
}

function isCleanTask(task: RunningTask): boolean {
  if (task.state !== "completed" || !task.result.result) {
    return false;
  }
  const res = task.result.result;
  if (res.verdict !== "PASS" || res.workerClaimedStatus !== "PASS" || !res.trustworthy) {
    return false;
  }
  if (res.discrepancies.length > 0 || res.scopeViolations.length > 0) {
    return false;
  }
  if (task.result.error) {
    return false;
  }
  const orchestratorRuns = res.verification.filter(
    (run) => run.source === "orchestrator",
  );
  const notExecuted = orchestratorRuns.filter(
    (run) => run.execution === "rejected" || run.execution === "skipped",
  );
  if (notExecuted.length > 0) {
    return false;
  }
  const unclaimed = res.filesChanged.filter((file) => file.why === UNCLAIMED_FILE);
  if (unclaimed.length > 0) {
    return false;
  }
  const executed = orchestratorRuns.filter(
    (run) => run.execution === "argv" || run.execution === "shell",
  );
  if ((task.input.verificationCommands?.length ?? 0) > 0 && executed.length === 0) {
    return false;
  }
  return true;
}

function buildBatchChecklist(
  running: RunningTask[],
  integrationConflicts: IntegrationConflict[],
  integrated: boolean,
  mode: string,
  integrationVerification: BatchOutput["integrationVerification"],
  completionState: BatchOutput["completionState"],
): string[] {
  const checklist: string[] = [];

  if (mode === "parallel" && integrationConflicts.length > 0) {
    checklist.push(
      `Resolve ${integrationConflicts.length} integration conflict(s) yourself — ` +
        `nothing was merged automatically. Inspect each task's worktreePath for any ` +
        `version that remains after cleanup.`,
    );
  }
  if (integrated && completionState === "verified-complete") {
    checklist.push(
      `Final workspace verification passed ${integrationVerification.length} declared check(s). ` +
        "Do not routinely reread worker-owned files or rerun those checks; reopen reasoning only for an architectural or listed risk.",
    );
  } else if (integrated && mode === "parallel") {
    checklist.push(
      "Worker seams were checked in isolation, but final workspace verification is not complete. " +
        "Use the returned failure/refusal evidence for targeted diagnosis before accepting.",
    );
  }

  const untrusted = running.filter((task) => task.result.result?.trustworthy === false);
  if (untrusted.length > 0) {
    checklist.push(
      `Scrutinise ${untrusted.map((task) => task.taskId).join(", ")}: their claims ` +
        `conflict with observed evidence.`,
    );
  }

  const failures = running.filter(
    (task) => task.state !== "completed" || task.result.result?.verdict !== "PASS",
  );
  if (failures.length > 0 && failures.length < running.length) {
    checklist.push(
      `Partial success: ${running.length - failures.length} of ${running.length} tasks ` +
        `passed. Decide per task whether to keep, retry, or re-scope — do not discard ` +
        `the successful work.`,
    );
  }

  const isCleanBatch =
    completionState === "verified-complete" &&
    integrationConflicts.length === 0 &&
    running.length > 0 &&
    running.every(isCleanTask);

  if (isCleanBatch) {
    checklist.push(
      "Judge whether the changes are high-risk or architecturally significant, " +
        "and read the diff if they are. Verified mechanical checks do not make them good.",
    );
  } else {
    checklist.push(
      "Read the actual diff of every changed file — worker summaries are claims, not evidence.",
    );
    checklist.push(
      "Check workers did not weaken tests, loosen types, or silence errors to reach PASS.",
    );
  }

  return checklist;
}
