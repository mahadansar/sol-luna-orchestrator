import fs from "node:fs/promises";
import path from "node:path";
import { MAX_BATCH_SIZE, MAX_PARALLEL } from "./config.js";
import type {
  BatchOutput,
  BatchTaskResult,
  DelegateTaskInput,
  TaskState,
} from "./contract.js";
import { emitEvent } from "./events.js";
import {
  findIntegrationConflicts,
  findScopeConflicts,
  type IntegrationConflict,
} from "./overlap.js";
import { executeTask, workerSlots } from "./worker.js";
import {
  cleanupWorktree,
  createTaskWorktree,
  prepareWorktreeBase,
  pruneStaleWorktrees,
  readWorktreeOutcome,
  WorktreeUnavailableError,
  type TaskWorktree,
} from "./worktree.js";
import { resolveWorkspace } from "./workspace.js";

export class BatchRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchRejectedError";
  }
}

/** Short, filesystem-safe identifier for a task's worktree directory. */
function makeTaskId(index: number, seed: string): string {
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `t${index + 1}${slug ? `-${slug}` : ""}`;
}

function makeBatchId(): string {
  return `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

interface RunningTask {
  taskId: string;
  input: DelegateTaskInput;
  state: TaskState;
  worktree: TaskWorktree | null;
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
    /** Overridable for testing concurrency limits. */
    semaphore?: typeof workerSlots;
  },
): Promise<BatchOutput> {
  const batchId = makeBatchId();
  const startedAt = Date.now();
  const mode = options.mode;

  if (tasks.length === 0) {
    throw new BatchRejectedError("A batch needs at least one task.");
  }
  if (tasks.length > MAX_BATCH_SIZE) {
    throw new BatchRejectedError(
      `A batch may contain at most ${MAX_BATCH_SIZE} tasks; ${tasks.length} were supplied. ` +
        `Split the work, or run the remainder as a second batch.`,
    );
  }

  const workspace = resolveWorkspace(options.workingDirectory);
  const run = options.executor ?? executeTask;

  const running: RunningTask[] = tasks.map((input, index) => {
    const taskId = makeTaskId(index, input.objective.split(/\s+/).slice(0, 4).join("-"));
    return {
      taskId,
      input,
      state: "queued" as TaskState,
      worktree: null,
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

  emitEvent({
    type: "batch.started",
    batchId,
    mode,
    taskCount: tasks.length,
    maxParallel: mode === "parallel" ? MAX_PARALLEL : 1,
  });
  for (const task of running) {
    emitEvent({
      type: "task.queued",
      batchId,
      taskId: task.taskId,
      effort: task.input.effort,
      category: task.input.taskCategory,
    });
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
    emitEvent({ type: "scope.conflict", batchId, detail: conflict.detail });
  }

  if (scopeConflicts.length > 0 && !options.allowOverlappingScopes) {
    emitEvent({ type: "batch.rejected", batchId, reason: "overlapping scopes" });
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
    const sem = options.semaphore ?? workerSlots;
    if (mode === "sequential") {
      await runSequential(batchId, running, workspace, run, sem, options.signal);
    } else {
      warnings.push(
        ...(await runParallel(batchId, running, workspace, run, sem, options.signal)),
      );
    }
  } catch (error) {
    if (error instanceof WorktreeUnavailableError) {
      emitEvent({ type: "batch.rejected", batchId, reason: error.message });
      throw new BatchRejectedError(error.message);
    }
    throw error;
  }

  // --- Integration ---------------------------------------------------------
  const completed = running.filter(
    (task) => task.state === "completed" && task.result.changedFiles.length > 0,
  );
  const integrationConflicts = findIntegrationConflicts(
    completed.map((task) => ({
      taskId: task.taskId,
      changedFiles: task.result.changedFiles,
    })),
  );
  for (const conflict of integrationConflicts) {
    emitEvent({
      type: "integration.conflict",
      batchId,
      path: conflict.path,
      tasks: conflict.tasks,
    });
  }

  let integrated = false;
  let integrationSummary: string;

  if (mode === "sequential") {
    integrated = true;
    integrationSummary =
      "Sequential tasks worked directly in the workspace, so their changes are already in place.";
  } else if (options.integrate === false) {
    integrationSummary =
      "Integration was disabled. Each worker's changes remain in its worktree; " +
      "paths are listed per task.";
  } else if (integrationConflicts.length > 0) {
    integrationSummary =
      `Nothing was integrated: ${integrationConflicts.length} file(s) were changed by ` +
      `more than one worker. Their worktrees were kept so you can inspect and merge ` +
      `them yourself.`;
  } else if (completed.length === 0) {
    integrationSummary = "No worker produced changes, so there was nothing to integrate.";
  } else {
    const applied = await integrateWorktrees(batchId, completed, workspace);
    integrated = true;
    warnings.push(...applied.warnings);
    integrationSummary =
      `Copied ${applied.fileCount} file(s) from ${completed.length} worker(s) into ` +
      `the workspace. No two workers touched the same file.`;
  }

  // --- Cleanup -------------------------------------------------------------
  for (const task of running) {
    if (!task.worktree) continue;
    const keepForConflict =
      integrationConflicts.length > 0 || options.integrate === false;
    const reason =
      task.state === "cancelled"
        ? "cancelled"
        : task.state === "completed" && !keepForConflict
          ? "success"
          : "failure";

    const cleanup = await cleanupWorktree(task.worktree, reason);
    emitEvent({
      type: "worktree.removed",
      batchId,
      taskId: task.taskId,
      kept: !cleanup.removed,
    });
    task.result.worktreePath = cleanup.removed ? null : (cleanup.keptAt ?? null);
    if (cleanup.error) {
      task.result.warnings.push(`Worktree cleanup incomplete: ${cleanup.error}`);
    }
  }

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  const passed = running.filter((task) => task.result.result?.verdict === "PASS").length;
  const failed = running.length - passed;

  emitEvent({ type: "batch.completed", batchId, durationSeconds, passed, failed });

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
  semaphore: typeof workerSlots,
  signal?: AbortSignal,
): Promise<void> {
  for (const task of running) {
    if (signal?.aborted) {
      markCancelled(batchId, task);
      continue;
    }
    const release = await semaphore.acquire();
    try {
      await runOne(batchId, task, workspace, run, signal);
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
  semaphore: typeof workerSlots,
  signal?: AbortSignal,
): Promise<string[]> {
  const warnings: string[] = [];

  const base = await prepareWorktreeBase(
    workspace,
    running.map((task) => task.input.allowedFiles),
  );

  const pruned = await pruneStaleWorktrees(base.repoRoot);
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
      markCancelled(batchId, task);
      continue;
    }
    try {
      task.worktree = await createTaskWorktreeTracked(batchId, base, task, workspace);
      task.result.warnings.push(...task.worktree.warnings);
    } catch (error) {
      // Partial failure is preserved: this task is marked failed and the rest
      // of the batch still runs.
      task.state = "failed";
      task.result.state = "failed";
      task.result.error = `Could not create an isolated worktree: ${(error as Error).message}`;
      emitEvent({
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
        markCancelled(batchId, task);
        return;
      }
      const release = await semaphore.acquire();
      try {
        if (signal?.aborted) {
          markCancelled(batchId, task);
          return;
        }

        await runOne(batchId, task, worktree.path, run, signal);

        const outcome = await readWorktreeOutcome(worktree);
        task.result.warnings.push(...outcome.warnings);
        task.result.changedFiles = outcome.changes.files.map((file) => file.path);
        task.result.diff = truncateDiff(outcome.changes.diff);
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
): Promise<TaskWorktree> {
  const worktree = await createTaskWorktree(base, task.taskId, workspace);
  emitEvent({
    type: "worktree.created",
    batchId,
    taskId: task.taskId,
    path: worktree.path,
  });
  return worktree;
}

/** Run one task and fold its outcome into the batch record. */
async function runOne(
  batchId: string,
  task: RunningTask,
  workingDirectory: string,
  run: TaskExecutor,
  signal?: AbortSignal,
): Promise<void> {
  task.state = "running";
  task.result.state = "running";
  emitEvent({
    type: "worker.started",
    batchId,
    taskId: task.taskId,
    effort: task.input.effort,
    workingDirectory,
  });

  try {
    const result = await run(task.input, {
      workingDirectory,
      signal,
      onVerificationStart: (commandCount) =>
        emitEvent({
          type: "verification.started",
          batchId,
          taskId: task.taskId,
          commandCount,
        }),
    });

    task.result.result = result;

    const orchestratorRuns = result.verification.filter(
      (run) => run.source === "orchestrator",
    );
    if (orchestratorRuns.length > 0) {
      emitEvent({
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
      emitEvent({ type: "worker.cancelled", batchId, taskId: task.taskId });
      return;
    }

    const timedOut = result.errors.some((error) => /exceeded its .* budget/.test(error));
    task.state = timedOut ? "timedOut" : "completed";
    task.result.state = task.state;

    if (timedOut) {
      emitEvent({
        type: "worker.timedOut",
        batchId,
        taskId: task.taskId,
        timeoutSeconds: task.input.timeoutSeconds ?? 0,
      });
    }

    // In sequential mode there is no worktree to read, so take the file list
    // the analysis already established.
    if (task.result.changedFiles.length === 0) {
      task.result.changedFiles = result.filesChanged
        .filter((file) => file.observed)
        .map((file) => file.path);
    }

    emitEvent({
      type: "worker.completed",
      batchId,
      taskId: task.taskId,
      verdict: result.verdict,
      claimed: result.workerClaimedStatus,
      durationSeconds: result.durationSeconds,
      threadId: result.workerThreadId,
      model: result.model,
      effort: result.effort,
      usage: result.usage,
    });
  } catch (error) {
    task.state = "failed";
    task.result.state = "failed";
    task.result.error = (error as Error).message;
    emitEvent({
      type: "worker.failed",
      batchId,
      taskId: task.taskId,
      reason: task.result.error,
    });
  }
}

function markCancelled(batchId: string, task: RunningTask): void {
  task.state = "cancelled";
  task.result.state = "cancelled";
  task.result.error = "Cancelled before this task started.";
  emitEvent({ type: "worker.cancelled", batchId, taskId: task.taskId });
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
    emitEvent({
      type: "integration.applied",
      batchId,
      taskId: task.taskId,
      fileCount: applied,
    });
  }

  return { fileCount, warnings };
}

function buildBatchChecklist(
  running: RunningTask[],
  integrationConflicts: IntegrationConflict[],
  integrated: boolean,
  mode: string,
): string[] {
  const checklist: string[] = [];

  if (integrationConflicts.length > 0) {
    checklist.push(
      `Resolve ${integrationConflicts.length} integration conflict(s) yourself — ` +
        `nothing was merged automatically, and each worker's version is in its worktree.`,
    );
  }
  if (integrated && mode === "parallel") {
    checklist.push(
      "Workers were verified in isolation. Run the full test suite once now that " +
        "their changes are combined — passing separately does not mean passing together.",
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

  checklist.push("Read the diff of every changed file before accepting this batch.");
  return checklist;
}
