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
  DelegateTaskInput,
  DelegateTaskOutput,
  TaskState,
} from "./contract.js";
import { activityFailureReason, emitEvent, type EventEmitter } from "./events.js";
import {
  findIntegrationConflicts,
  findScopeConflicts,
  type IntegrationConflict,
} from "./overlap.js";
import {
  executeTask,
  reconcileParallelWorktreeEvidence,
  UNCLAIMED_FILE,
  workerSlots,
} from "./worker.js";
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
  type WorktreeLease,
  type TaskWorktree,
} from "./worktree.js";
import { resolveWorkspace } from "./workspace.js";
import { CONTINUATION_TTL_MS } from "./continuation.js";

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

export async function runBatch(
  tasks: DelegateTaskInput[],
  options: {
    mode: "parallel" | "sequential";
    workingDirectory?: string;
    allowOverlappingScopes?: boolean;
    integrate?: boolean;
    signal?: AbortSignal;
    /**
     * Overridable so the scheduling, isolation and integration logic can be
     * tested without spending model calls. Production always uses the default.
     */
    executor?: TaskExecutor;
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
  },
): Promise<BatchOutput> {
  const batchId = options.batchId ?? makeBatchId();
  const startedAt = Date.now();
  const mode = options.mode;
  const emit = options.eventEmitter ?? emitEvent;

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
      },
    };
  });

  emit({
    type: "batch.started",
    batchId,
    mode,
    taskCount: tasks.length,
    maxParallel: mode === "parallel" ? MAX_PARALLEL : 1,
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

  const warnings: string[] = [];

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
      "Integration was disabled. Each worker's changes remain in its worktree; " +
      "paths are listed per task.";
  } else if (outcomeFailures.length > 0) {
    integrationIncomplete = true;
    warnings.push(
      `Integration was not attempted because worktree evidence could not be read ` +
        `for ${outcomeFailures.map((task) => task.taskId).join(", ")}.`,
    );
    integrationSummary =
      "Integration was not attempted because at least one worker's final worktree " +
      "evidence scan failed. The affected worktrees were kept for diagnosis.";
    emit({ type: "integration.notAttempted", batchId, reason: "evidence-failure" });
  } else if (integrationConflicts.length > 0) {
    integrationSummary =
      `Nothing was integrated: ${integrationConflicts.length} file(s) were changed by ` +
      `more than one worker. Their worktrees were kept so you can inspect and merge ` +
      `them yourself.`;
  } else if (completed.length === 0) {
    integrationSummary = "No worker produced changes, so there was nothing to integrate.";
  } else {
    const applied = await integrateWorktrees(batchId, completed, workspace, emit);
    integrationIncomplete = applied.warnings.length > 0;
    integrated = !integrationIncomplete;
    warnings.push(...applied.warnings);
    integrationSummary = integrationIncomplete
      ? `Integration was incomplete after copying ${applied.fileCount} file(s). ` +
        `Worker worktrees were kept for inspection and continuation.`
      : `Copied ${applied.fileCount} file(s) from ${completed.length} worker(s) into ` +
        `the workspace. No two workers touched the same file.`;
    if (!integrationIncomplete) emit({ type: "integration.completed", batchId });
  }

  // --- Cleanup -------------------------------------------------------------
  let lifecycleError: unknown = null;
  for (const task of running) {
    if (!task.worktree) {
      if (task.result.result && options.continuationRegistrar) {
        task.result.result.continuationReference = await options.continuationRegistrar(
          task.input,
          task.result.result,
          workspace,
          false,
          null,
        );
      }
      continue;
    }
    const keepForConflict =
      integrationConflicts.length > 0 ||
      options.integrate === false ||
      integrationIncomplete;
    const reason = task.worktreeOutcomeError
      ? "evidence-failure"
      : task.state === "cancelled"
        ? "cancelled"
        : task.state === "completed" && !keepForConflict
          ? "success"
          : "failure";

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
      const cleanup = await cleanupWorktree(task.worktree, reason);
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
      }

      let retainedLease = false;
      if (!renewalError && task.result.result && options.continuationRegistrar) {
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
              task.result.warnings.push(
                `Continuation registration failed: ${(error as Error).message}`,
              );
            }
          }
        }
      }
      if (!cleanup.removed && task.worktree.lease && !retainedLease && !renewalError) {
        await releaseWorktreeLease(task.worktree.lease);
      }
    } catch (error) {
      lifecycleError ??= error;
    } finally {
      releaseWorktreeOwnership(task.worktree);
    }
  }

  if (lifecycleError) throw lifecycleError;

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
    maxParallel: mode === "parallel" ? MAX_PARALLEL : 1,
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
    warnings,
    reviewChecklist: buildBatchChecklist(running, integrationConflicts, integrated, mode),
  };
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
      await runOne(batchId, task, workspace, run, emit, signal);
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
  // Each task takes a slot from the shared semaphore, so this respects
  // SOL_LUNA_MAX_PARALLEL without a second scheduler. Every workspace already
  // exists, so workers start together instead of queueing behind each other's
  // setup.
  await Promise.all(
    running.map(async (task) => {
      const worktree = task.worktree;
      if (!worktree || task.state === "failed" || task.state === "cancelled") return;

      if (signal?.aborted) {
        markCancelled(batchId, task, emit);
        return;
      }
      const release = await workerSlots.acquire();
      try {
        if (signal?.aborted) {
          markCancelled(batchId, task, emit);
          return;
        }

        await runOne(batchId, task, worktree.path, run, emit, signal, false);

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
            });
          }
        } else if (!isCancelled(task) && !isFailed(task)) {
          emitWorkerCompleted(batchId, task, emit);
        }
      } finally {
        release();
      }
    }),
  );

  return warnings;
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
async function runOne(
  batchId: string,
  task: RunningTask,
  workingDirectory: string,
  run: TaskExecutor,
  emit: EventEmitter,
  signal?: AbortSignal,
  emitCompletion = true,
): Promise<void> {
  task.state = "running";
  task.result.state = "running";
  emit({
    type: "worker.started",
    batchId,
    taskId: task.taskId,
    effort: task.input.effort,
    workingDirectory,
    model: LUNA_MODEL,
  });

  try {
    const result = await run(task.input, {
      workingDirectory,
      signal,
      onVerificationStart: (commandCount) =>
        emit({
          type: "verification.started",
          batchId,
          taskId: task.taskId,
          commandCount,
        }),
      onRepairStart: (classification) => {
        emit({
          type: "verification.completed",
          batchId,
          taskId: task.taskId,
          passed: Math.max(0, task.input.verificationCommands.length - 1),
          failed: 1,
          refused: 0,
        });
        emit({
          type: "repair.started",
          batchId,
          taskId: task.taskId,
          classification,
          turn: 1,
        });
      },
      onRepairComplete: (verdict) =>
        emit({
          type: "repair.completed",
          batchId,
          taskId: task.taskId,
          verdict,
          turn: 1,
        }),
    });

    task.result.result = result;

    const orchestratorRuns = result.verification.filter(
      (run) => run.source === "orchestrator",
    );
    if (orchestratorRuns.length > 0) {
      emit({
        type: "verification.completed",
        batchId,
        taskId: task.taskId,
        passed: orchestratorRuns.filter((run) => run.passed).length,
        failed: orchestratorRuns.filter(
          (run) => !run.passed && (run.execution === "argv" || run.execution === "shell"),
        ).length,
        refused: orchestratorRuns.filter(
          (run) => run.execution === "rejected" || run.execution === "skipped",
        ).length,
      });
    }

    // Cancellation only applies when the worker was actually interrupted. A
    // task that ran to completion keeps its result even if the batch was
    // cancelled afterwards — finished work is never thrown away.
    if (result.errors.some((error) => /was cancelled before it finished/i.test(error))) {
      task.state = "cancelled";
      task.result.state = "cancelled";
      emit({ type: "worker.cancelled", batchId, taskId: task.taskId });
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
      });
    }

    // In sequential mode there is no worktree to read, so take the file list
    // the analysis already established.
    if (task.result.changedFiles.length === 0) {
      task.result.changedFiles = result.filesChanged
        .filter((file) => file.observed)
        .map((file) => file.path);
    }

    if (emitCompletion) emitWorkerCompleted(batchId, task, emit);
  } catch (error) {
    task.state = "failed";
    task.result.state = "failed";
    task.result.error = (error as Error).message;
    emit({
      type: "worker.failed",
      batchId,
      taskId: task.taskId,
      reason: task.result.error,
    });
  }
}

function emitWorkerCompleted(
  batchId: string,
  task: RunningTask,
  emit: EventEmitter,
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
  });
}

const isCancelled = (task: RunningTask): boolean => task.state === "cancelled";
const isFailed = (task: RunningTask): boolean => task.state === "failed";

function markCancelled(batchId: string, task: RunningTask, emit: EventEmitter): void {
  task.state = "cancelled";
  task.result.state = "cancelled";
  task.result.error = "Cancelled before this task started.";
  emit({ type: "worker.cancelled", batchId, taskId: task.taskId });
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
): string[] {
  const checklist: string[] = [];

  if (mode === "parallel" && integrationConflicts.length > 0) {
    checklist.push(
      `Resolve ${integrationConflicts.length} integration conflict(s) yourself — ` +
        `nothing was merged automatically, and each worker's version is in its worktree.`,
    );
  }
  if (integrated && mode === "parallel") {
    checklist.push(
      "Workers were verified in isolation. Run an integration or full-suite check " +
        "if the changes can interact (shared contracts, types, or runtime behavior) — " +
        "passing separately does not mean passing together.",
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
    integrationConflicts.length === 0 && running.length > 0 && running.every(isCleanTask);

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
