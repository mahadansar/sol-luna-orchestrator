import fs from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import picomatch from "picomatch";
import {
  capturePinnedDirectoryAuthority,
  PinnedDirectoryMutationError,
  runPinnedDirectoryMutation,
  type PinnedDirectoryAuthority,
} from "./fs-authority.js";
import {
  DEFAULT_TIMEOUT_SECONDS,
  LUNA_MODEL,
  MAX_BATCH_SIZE,
  MAX_PARALLEL,
  WORKTREE_LINK_DIRS,
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
import { evaluateAdaptiveCard } from "./adaptive.js";
import {
  DEFAULT_COMPUTE_POLICY,
  cloneComputePolicy,
  narrowPolicy,
  resolveBaselineExecutor,
  unresolvedExecutorRefusal,
  type ComputePolicy,
} from "./policy.js";
import { declaredRoutingFields, describeRefusal } from "./routing.js";
import {
  HandoffStore,
  handoffError,
  registerHandoff,
  type HandoffReservation,
} from "./handoff.js";
import { selectCompute, type PriorExecution } from "./selection.js";
import {
  activityFailureReason,
  emitAttemptCompleted,
  emitAttemptStarted,
  emitEvent,
  isolateEventEmitter,
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
import {
  defaultRealPathResolver,
  findScopeViolations,
  PROTECTED_CONTROL_PATHS,
  PROTECTED_CONTROL_VIOLATION,
} from "./scope.js";
import {
  acquireRepositoryOperationAuthority,
  cleanupWorktree,
  assertSharedDirectoryFingerprint,
  captureSharedDirectoryFingerprint,
  assertConfinedDirectoryChain,
  continuationLeasePath,
  createTaskWorktree,
  maintainWorktreeLease,
  prepareWorktreeBase,
  pruneStaleWorktrees,
  readWorktreeOutcome,
  refreshWorktreeLease,
  releaseWorktreeLease,
  releaseWorktreeOwnership,
  withWorktreeMetadataAuthority,
  WORKTREE_LEASE_GRACE_MS,
  WorktreeUnavailableError,
  type CleanupReason,
  type SharedDirectoryFingerprint,
  type RepositoryOperationAuthority,
  type WorktreeLeaseMaintenance,
  type WorktreeLease,
  type WorktreeRetentionPolicy,
  type TaskWorktree,
} from "./worktree.js";
import { resolveWorkspace } from "./workspace.js";
import { CONTINUATION_TTL_MS } from "./continuation.js";
import {
  assertGitEvidenceAuthority,
  captureGitEvidenceAuthority,
  changedTrustedWorkspacePaths,
  snapshotFilesystemWorkspaceEvidence,
  snapshotTrustedWorkspaceEvidence,
  type GitEvidenceAuthority,
} from "./git.js";
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
  model: string;
  predecessorExecutionId?: string | null;
  logicalAttempt?: number;
  authoritativePrior: boolean;
  handoffReservation: HandoffReservation | null;
  sharedDependencyBaseline: SharedDirectoryFingerprint | null;
  state: TaskState;
  worktree: TaskWorktree | null;
  leaseRenewal: WorktreeLeaseMaintenance | null;
  worktreeOutcomeError: string | null;
  worktreeEvidenceDigest: string | null;
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
  options?: { signal?: AbortSignal },
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
      /**
       * Where a *fresh* attempt of this contract belongs, which differs from
       * `workingDirectory` only for a retained worktree: the resumed thread
       * continues inside the worktree, while anything that restarts the
       * contract must use the batch workspace instead.
       */
      authoritativeWorkspace: string,
      /** Pinned Git identity for a retained isolated worktree continuation. */
      gitEvidenceAuthority: GitEvidenceAuthority | null,
    ) => string | null | Promise<string | null>;
    /**
     * Register an eligible result for server-authoritative next-action handoff
     * (bounded retry, effort escalation, or stronger-executor fallback).
     */
    handoffRegistrar?: (
      input: DelegateTaskInput,
      result: DelegateTaskOutput,
    ) => string | null;
    /** In-memory store for resolving task handoff references. */
    handoffStore?: HandoffStore;
    /** Server-owned lifecycle key inherited by newly issued handoffs. */
    handoffContextKey?: string | null;
    /** Worktrees still referenced by unused or in-flight continuations. */
    protectedWorktreePaths?: Iterable<string>;
    /** Deterministic lifecycle seam for tests; production always generates one. */
    batchId?: string;
    /** Deterministic lease-maintenance seam; production uses persistent renewal. */
    leaseMaintainer?: typeof maintainWorktreeLease;
    /** Deterministic repository-operation authority seam; production uses persistent ownership. */
    operationAuthorityAcquirer?: typeof acquireRepositoryOperationAuthority;
    /** Deterministic retention seam; production uses configured policy. */
    keepWorktrees?: WorktreeRetentionPolicy;
    /** Deterministic dirty-base seam; production uses SOL_LUNA_ALLOW_DIRTY. */
    allowDirtyWorktreeBase?: boolean;
    /**
     * Deterministic integration race seam. Production leaves this unset; tests
     * use it to mutate/cancel after admission validation but before the final
     * write-boundary evidence check.
     */
    integrationBeforeWrite?: (context: {
      batchId: string;
      taskId: string;
      file: string;
      appliedFiles: number;
    }) => void | Promise<void>;
    /** Deterministic final parent-creation seam; production leaves this unset. */
    integrationBeforeParentCreate?: (context: {
      batchId: string;
      taskId: string;
      file: string;
      parent: string;
      candidate: string;
      segment: string;
      appliedFiles: number;
    }) => void | Promise<void>;
    /** Deterministic pinned-write fault/short-write seam; production leaves this unset. */
    integrationPinnedWriteTest?: {
      maxWriteBytes?: number;
      failAfterTruncate?: boolean;
      failAfterBytes?: number;
    };
    /** Deterministic pinned-deletion cleanup seam; production leaves this unset. */
    integrationPinnedDeleteTest?: {
      failQuarantineCleanup?: boolean;
    };
    /**
     * Deterministic deletion-boundary seam. Production leaves this unset; tests
     * use it after the final accepted snapshots and before the namespace move
     * that makes a proven deletion authoritative.
     */
    integrationBeforeDelete?: (context: {
      batchId: string;
      taskId: string;
      file: string;
      appliedFiles: number;
      phase: "validated" | "moved";
    }) => void | Promise<void>;
    /** Deterministic exceptional-cleanup seam. */
    worktreeCleaner?: typeof cleanupWorktree;
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
  const emit = isolateEventEmitter(options.eventEmitter ?? emitEvent);
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

  // --- Cheap routing: evaluate before running tasks are initialized --------
  const card = options.routingPreflight ? asRoutingCard(options.routingPreflight) : null;
  const adaptive = card
    ? evaluateAdaptiveCard({
        card,
        context: {
          mode,
          taskCount: tasks.length,
          allowOverlappingScopes: options.allowOverlappingScopes,
        },
        policy: computePolicy,
      })
    : null;
  const routing = adaptive?.evaluation ?? null;
  const selection = adaptive?.selection ?? null;

  // Earned per-task authority is reserved for the whole pre-execution admission
  // window and only spent once this batch is committed to starting workers.
  // Consuming inline made a batch gates collectively destructive: an invalid
  // sibling reference, an overlapping scope, a workspace mismatch, or a refused
  // routing gate destroyed every *valid* sibling handoff that had already been
  // read, even though not one worker ran. Reserving keeps the single-use bound
  // - a concurrent consumer of the same reference is refused as already used -
  // while leaving each sibling individually restorable.
  const handoffReservations: HandoffReservation[] = [];
  const releaseReservedHandoffs = (): void => {
    for (const reservation of handoffReservations) reservation.release();
    handoffReservations.length = 0;
  };
  /**
   * Refuse before any worker exists: hand every unspent reservation back.
   *
   * Explicitly annotated so its `never` return participates in control-flow
   * analysis at the call sites that assign `workspace`.
   */
  const rejectBeforeExecution: (reason: string) => never = (reason) => {
    releaseReservedHandoffs();
    emit({ type: "batch.rejected", batchId, reason });
    throw new BatchRejectedError(reason);
  };

  // One shared executor rule across every delegation surface. `allowedModels` is
  // a membership set whose order is an artefact of how the environment was
  // concatenated, so taking index 0 read a preference the operator never
  // declared - and named a different executor than single delegation did for the
  // same envelope. `resolveBaselineExecutor` reads only declarations, and
  // refuses rather than guessing when there are none.
  const baselineExecutor = selection?.model ?? resolveBaselineExecutor(computePolicy);
  if (!baselineExecutor) {
    rejectBeforeExecution(unresolvedExecutorRefusal(computePolicy));
  }

  const buildRunningTasks = (): RunningTask[] =>
    tasks.map((input, index) => {
      const taskId = makeTaskId(index);
      // The batch-level selection is computed with no prior execution evidence,
      // so its effort is routing's advisory *starting* effort for undeclared
      // work. Every task here declares its own `effort` with a mandatory
      // `effortReason`, and adopting the card's single recommendation both
      // overrode those declarations and flattened them to one value. Only the
      // per-task selection below — made against evidence restored from a
      // consumed server handoff — may replace a declared effort.
      let resolvedInput: DelegateTaskInput = { ...input };
      let model = baselineExecutor;
      let predecessorExecutionId: string | null = null;
      let logicalAttempt = input.previousAttempts.length + 1;
      let authoritativePrior = false;
      let handoffReservation: HandoffReservation | null = null;

      if (input.handoffReference && options.handoffStore) {
        const reserved = options.handoffStore.reserve(input.handoffReference);
        if (reserved.status !== "ready") {
          throw new BatchRejectedError(
            `Task ${taskId} handoff rejected: ${handoffError(reserved)}`,
          );
        }
        handoffReservations.push(reserved.reservation);
        handoffReservation = reserved.reservation;
        const consumed = { entry: reserved.reservation.entry };
        resolvedInput = {
          ...consumed.entry.input,
          computePolicy: consumed.entry.input.computePolicy
            ? narrowPolicy(computePolicy, consumed.entry.input.computePolicy)
            : cloneComputePolicy(computePolicy),
          previousAttempts: [
            ...consumed.entry.input.previousAttempts,
            {
              effort: consumed.entry.effort,
              verdict: "FAILED" as const,
              whatWentWrong: consumed.entry.failureDecision.reason,
            },
          ],
        };
        predecessorExecutionId = consumed.entry.predecessorExecutionId;
        logicalAttempt = consumed.entry.logicalAttempt;
        authoritativePrior = true;
        const priorEvidence: PriorExecution = {
          requestedModel: consumed.entry.model,
          requestedEffort: consumed.entry.effort,
          failureDecision: consumed.entry.failureDecision,
        };
        const shape = routing?.shape ?? {
          mechanism:
            mode === "parallel" ? "delegate_tasks_parallel" : "delegate_tasks_sequential",
          effort: resolvedInput.effort,
          workerCount: tasks.length,
          concurrency: maxParallel,
          conditional: false,
          seamsOverCap: 0,
        };
        const taskSelection = selectCompute({
          shape,
          policy: computePolicy,
          evidence: priorEvidence,
        });
        if (taskSelection.model) model = taskSelection.model;
        if (taskSelection.effort) resolvedInput.effort = taskSelection.effort;
      }

      return {
        taskId,
        input: resolvedInput,
        model,
        predecessorExecutionId,
        logicalAttempt,
        authoritativePrior,
        handoffReservation,
        sharedDependencyBaseline: null,
        state: "queued" as TaskState,
        worktree: null,
        leaseRenewal: null,
        worktreeOutcomeError: null,
        worktreeEvidenceDigest: null,
        result: {
          taskId,
          state: "queued",
          objective: resolvedInput.objective,
          effort: resolvedInput.effort,
          effortReason: resolvedInput.effortReason,
          result: null,
          changedFiles: [],
          worktreePath: null,
          error: null,
          warnings: [],
          attempt: logicalAttempt,
          attempts: [],
          recovery: null,
          failureDecision: undefined,
          handoffReference: null,
          handoffState: undefined,
        },
        recovery: null,
      };
    });

  let running: RunningTask[];
  try {
    running = buildRunningTasks();
  } catch (error) {
    // A malformed sibling reference refuses the batch, but the siblings whose
    // authority was already reserved never ran, so they are handed back intact.
    releaseReservedHandoffs();
    throw error;
  }

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
      model: task.model,
      attempt: task.result.attempt,
    });
  }

  let workspace: string;
  try {
    workspace = resolveWorkspace(options.workingDirectory);
  } catch (error) {
    rejectBeforeExecution((error as Error).message);
  }

  for (const task of running) {
    if (!task.authoritativePrior) continue;
    let authoritativeWorkspace: string;
    try {
      authoritativeWorkspace = resolveWorkspace(task.input.workingDirectory);
    } catch (error) {
      rejectBeforeExecution(
        `Task ${task.taskId} handoff rejected: ${(error as Error).message}`,
      );
    }
    if (path.relative(workspace, authoritativeWorkspace) !== "") {
      rejectBeforeExecution(
        `Task ${task.taskId} handoff rejected: the authoritative workspace ` +
          "does not match this batch workspace.",
      );
    }
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
      ruleId: routing.ruleId,
      cardProvenance: routing.cardProvenance,
      gates: routing.gates,
      signals: routing.signals,
      refusedGate: routing.refusedGate,
      parallelEligible: routing.parallelEligible,
      recommendedMechanism: routing.shape?.mechanism,
      recommendedWorkerCount: routing.shape?.workerCount,
      recommendedConcurrency: routing.shape?.concurrency,
      recommendedEffort: routing.shape?.effort,
      selectedModel: selection?.model,
      selectedEffort: selection?.effort,
      selectionReason: selection?.reason,
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
    releaseReservedHandoffs();
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
    rejectBeforeExecution(describeRefusal(routing.refusedGate));
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

  let operationAuthority: RepositoryOperationAuthority | null = null;
  const batchHasAuthoritativeCancellation = (): boolean =>
    running.some((task) => task.state === "cancelled");
  const describeOperationAuthorityFailure = (phase: string, error: unknown): string =>
    `Repository operation authority ${phase} failed after cancellation: ${(error as Error).message}. ` +
    "Cancellation remains authoritative and no later repository work was started because of this failure.";
  const assertOperationAuthorityAfterExecution = (phase: string): void => {
    if (!operationAuthority) return;
    try {
      operationAuthority.assertHealthy();
    } catch (error) {
      if (!batchHasAuthoritativeCancellation()) throw error;
      warnings.push(describeOperationAuthorityFailure(phase, error));
    }
  };
  const releaseOperationAuthorityBeforeTerminal = async (): Promise<void> => {
    if (!operationAuthority) return;
    const authority = operationAuthority;
    operationAuthority = null;
    let failure: unknown = null;
    try {
      authority.assertHealthy();
    } catch (error) {
      failure = error;
    }
    try {
      await authority.release();
    } catch (error) {
      failure ??= error;
    }
    if (!failure) return;
    if (!batchHasAuthoritativeCancellation()) throw failure;
    warnings.push(describeOperationAuthorityFailure("final release", failure));
  };

  // An already-cancelled batch is non-authoritative: it creates no worktree,
  // captures no execution evidence, and does not need to mutate repository
  // operation metadata merely to report that nothing ran. If cancellation
  // arrives while waiting for another same-repository operation, preserve that
  // same cancellation result instead of turning it into a BatchRejectedError.
  if (!options.signal?.aborted) {
    try {
      operationAuthority = await (
        options.operationAuthorityAcquirer ?? acquireRepositoryOperationAuthority
      )(workspace, options.signal);
      operationAuthority?.assertHealthy();
    } catch (error) {
      if (!(options.signal?.aborted && (error as Error).name === "AbortError")) {
        rejectBeforeExecution(
          `Could not acquire repository operation authority before execution: ${(error as Error).message}`,
        );
      }
    }
  }

  try {
    // Worker-visible dependency links may resolve to the authoritative workspace.
    // Pin their content before any worker starts so neither per-turn verification
    // nor final integrated verification can execute dependency code authored by a
    // delegated worker during this batch.
    let sharedDependencyBaseline: SharedDirectoryFingerprint | null = null;
    if (
      !options.signal?.aborted &&
      running.some((task) => task.input.verificationCommands.length > 0)
    ) {
      try {
        sharedDependencyBaseline = await captureSharedDirectoryFingerprint(workspace);
        for (const task of running)
          task.sharedDependencyBaseline = sharedDependencyBaseline;
      } catch (error) {
        rejectBeforeExecution(
          `Could not establish trusted shared-dependency state before execution: ${(error as Error).message}`,
        );
      }
    }

    // Last gate cleared.
    //
    // Cancellation that already arrived ran nothing, so earned authority goes
    // back rather than being spent on a batch that will only mark every task
    // cancelled. The run still proceeds into the ordinary cancellation path below
    // so its per-task telemetry is exactly what it always was.
    //
    // Otherwise setup may proceed, but each earned handoff remains reserved until
    // its own worker is actually about to enter execution. Parallel Git/worktree
    // setup can still fail after this point without spending a capability that ran
    // nothing.
    if (options.signal?.aborted) {
      releaseReservedHandoffs();
    }

    try {
      if (!options.signal?.aborted) operationAuthority?.assertHealthy();
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
            options.allowDirtyWorktreeBase,
          )),
        );
      }
      assertOperationAuthorityAfterExecution("post-execution health check");
      // Any reservation whose task never reached worker entry (setup failure,
      // cancellation, queue refusal) remains unspent and is restored here.
      releaseReservedHandoffs();
    } catch (error) {
      // Anything thrown out of the execution window skips the whole cleanup
      // section below, so the renewal timers keep firing and every created
      // worktree stays registered as owned by this process for the rest of its
      // life - which also makes `pruneStaleWorktrees` refuse to reclaim it. The
      // directories themselves are deliberately left on disk as evidence; only
      // the in-process ownership and the timers are surrendered here.
      for (const task of running) {
        try {
          await task.leaseRenewal?.stop();
        } catch {
          // Best effort: the batch is already failing with a more useful error.
        } finally {
          task.leaseRenewal = null;
        }
        if (!task.worktree) continue;
        if (task.worktree.lease) {
          // The persistent lease outlives this process by design, so leaving it
          // held reserved the identity for the task's whole timeout plus grace -
          // roughly half an hour by default - and made `pruneStaleWorktrees`
          // refuse to reclaim the directory. The directory itself stays as
          // evidence; only the reservation is surrendered.
          await releaseWorktreeLease(task.worktree.lease).catch(() => undefined);
        }
        releaseWorktreeOwnership(task.worktree);
      }
      releaseReservedHandoffs();
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
      assertOperationAuthorityAfterExecution("pre-recovery health check");
      const initialConflicts = findIntegrationConflicts(
        running
          .filter((task) => task.result.changedFiles.length > 0)
          .map((task) => ({
            taskId: task.taskId,
            changedFiles: task.result.changedFiles,
          })),
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
      assertOperationAuthorityAfterExecution("post-recovery health check");
    }

    // --- Integration ---------------------------------------------------------
    const completed = running.filter(
      (task) => task.state === "completed" && task.result.changedFiles.length > 0,
    );

    // A worker that edited outside its declared scope produced unauthorized
    // changes. "Completed" only says the turn ended; it says nothing about the
    // changes being ones the caller asked for, and copying them into the
    // authoritative workspace on the strength of the turn having finished is the
    // one outcome the scope contract exists to prevent. The worktree keeps every
    // byte, the violation is reported, and the parent decides.
    const scopeViolatingTasks = completed.filter(
      (task) => (task.result.result?.scopeViolations.length ?? 0) > 0,
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
      // Sequential tasks write into the workspace as they run, so there is no
      // integration step to withhold and nothing to un-apply. Say so plainly
      // rather than letting "already in place" imply the changes were authorized.
      if (scopeViolatingTasks.length > 0) {
        const violators = scopeViolatingTasks.map((task) => task.taskId).join(", ");
        warnings.push(
          `${violators} changed files outside declared scope. Sequential tasks write ` +
            `directly into the workspace, so those changes are already there and were ` +
            `not withheld the way a parallel task's would be. Review the per-task scope ` +
            `evidence and revert what you did not ask for.`,
        );
        // Deliberately no `integration.blocked` event here: nothing was blocked.
        // The changes are in the workspace, and telemetry saying otherwise would
        // be the opposite of the truth a reader needs.
      }
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
      integrationSummary =
        "No worker produced changes, so there was nothing to integrate.";
    } else if (scopeViolatingTasks.length > 0 && options.allowOverlappingScopes) {
      // Selective exclusion is only safe because parallel tasks are normally
      // required to declare disjoint scopes, which is what makes one task's
      // changes independent of another's. `allowOverlappingScopes` is the caller
      // withdrawing exactly that declaration, so integrating the clean siblings
      // of a violating task could leave the workspace holding one half of a set
      // of changes that were never independent. Refuse the whole batch instead of
      // choosing which half to apply.
      integrationIncomplete = true;
      const violators = scopeViolatingTasks.map((task) => task.taskId).join(", ");
      warnings.push(
        `Nothing was integrated: ${violators} violated declared file scope, and this ` +
          `batch set allowOverlappingScopes:true, so the remaining tasks are not ` +
          `declared independent of it. Every worktree is retained for review.`,
      );
      integrationSummary =
        `Nothing was integrated: ${scopeViolatingTasks.length} task(s) changed files ` +
        `outside their declared scope, and allowOverlappingScopes:true means the ` +
        `siblings cannot be integrated on their own. Scope evidence is per task; any ` +
        `worktree retained after cleanup is listed there too.`;
      for (const task of scopeViolatingTasks) {
        emit({
          type: "integration.blocked",
          batchId,
          taskId: task.taskId,
          reason: "scope-violation",
        });
      }
    } else {
      assertOperationAuthorityAfterExecution("pre-integration health check");
      const integrable = completed.filter((task) => !scopeViolatingTasks.includes(task));
      for (const task of scopeViolatingTasks) {
        warnings.push(
          `${task.taskId} was excluded from integration because it changed files ` +
            `outside its declared scope: ${task.result.result?.scopeViolations.join("; ")}. ` +
            `Its worktree keeps the full change for review.`,
        );
        emit({
          type: "integration.blocked",
          batchId,
          taskId: task.taskId,
          reason: "scope-violation",
        });
      }
      const applied = await integrateWorktrees(
        batchId,
        integrable,
        workspace,
        emit,
        options.signal,
        options.integrationBeforeWrite,
        options.integrationBeforeDelete,
        options.integrationBeforeParentCreate,
        options.integrationPinnedWriteTest,
        options.integrationPinnedDeleteTest,
      );
      integrationIncomplete = applied.warnings.length > 0;
      integrated = !integrationIncomplete;
      warnings.push(...applied.warnings);
      const excluded =
        scopeViolatingTasks.length > 0
          ? ` ${scopeViolatingTasks.length} task(s) were excluded for changing files ` +
            `outside their declared scope; their changes remain only in their own ` +
            `worktrees and were not copied into the workspace.`
          : "";
      integrationSummary = integrationIncomplete
        ? `Integration was incomplete after copying ${applied.fileCount} file(s). ` +
          `Any worktree that remains after cleanup is listed per task.${excluded}`
        : `Copied ${applied.fileCount} file(s) from ${integrable.length} worker(s) into ` +
          `the workspace. No two workers touched the same file.${excluded}`;
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
    let finalVerificationEvidenceError: string | null = null;
    if (integrated && finalCommands.length > 0 && !options.signal?.aborted) {
      assertOperationAuthorityAfterExecution("pre-final-verification health check");
      let finalVerificationAuthority: GitEvidenceAuthority | null = null;
      let finalVerificationBaseline: ReadonlyMap<string, string> | null = null;
      const liveLeaseExclusions = running.flatMap((task) => {
        const lease = task.worktree?.lease;
        if (!lease) return [];
        const relative = path.relative(
          workspace,
          continuationLeasePath(lease.worktreePath),
        );
        return [relative.split(path.sep).join("/")];
      });
      try {
        if (sharedDependencyBaseline) {
          await assertSharedDirectoryFingerprint(sharedDependencyBaseline);
        }
        finalVerificationAuthority = await captureGitEvidenceAuthority(workspace);
        finalVerificationBaseline = finalVerificationAuthority
          ? await snapshotTrustedWorkspaceEvidence(
              finalVerificationAuthority,
              workspace,
              [...WORKTREE_LINK_DIRS, ...liveLeaseExclusions],
            )
          : await snapshotFilesystemWorkspaceEvidence(workspace);
      } catch (error) {
        finalVerificationEvidenceError =
          `Final verification evidence could not be sealed before execution: ` +
          `${(error as Error).message}`;
        warnings.push(finalVerificationEvidenceError);
        for (const task of running)
          task.result.warnings.push(finalVerificationEvidenceError);
      }

      if (!finalVerificationEvidenceError && finalVerificationBaseline) {
        emit({
          type: "integration.verification.started",
          batchId,
          commandCount: finalCommands.length,
        });
        try {
          const runs = await (options.integrationVerifier ?? runVerifications)(
            finalCommands,
            workspace,
            { signal: options.signal },
          );
          integrationVerification.push(
            ...runs.map((run) => ({ ...run, source: "orchestrator" as const })),
          );
        } catch (error) {
          const detail =
            `Final verification evidence is incomplete because the integrated verifier ` +
            `could not run: ${(error as Error).message}`;
          warnings.push(detail);
          for (const task of running) task.result.warnings.push(detail);
        }

        try {
          assertOperationAuthorityAfterExecution("post-final-verification health check");
          const afterVerification = finalVerificationAuthority
            ? await snapshotTrustedWorkspaceEvidence(
                finalVerificationAuthority,
                workspace,
                [...WORKTREE_LINK_DIRS, ...liveLeaseExclusions],
              )
            : await snapshotFilesystemWorkspaceEvidence(workspace);
          const verifierChanges = changedTrustedWorkspacePaths(
            finalVerificationBaseline,
            afterVerification,
          );
          if (verifierChanges.length > 0) {
            throw new Error(
              `the verifier changed authoritative workspace paths: ${verifierChanges
                .slice(0, 10)
                .join(", ")}${verifierChanges.length > 10 ? ", ..." : ""}`,
            );
          }
          if (sharedDependencyBaseline) {
            await assertSharedDirectoryFingerprint(sharedDependencyBaseline);
          }
        } catch (error) {
          finalVerificationEvidenceError = `Final verification evidence changed after execution: ${(error as Error).message}`;
          warnings.push(finalVerificationEvidenceError);
          for (const task of running)
            task.result.warnings.push(finalVerificationEvidenceError);
        }
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
      !finalVerificationEvidenceError &&
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
    assertOperationAuthorityAfterExecution("post-cleanup health check");
    let lifecycleError: unknown = null;
    for (const task of running) {
      if (!task.worktree) {
        if (task.result.result && options.continuationRegistrar) {
          try {
            task.result.result.continuationReference =
              await options.continuationRegistrar(
                task.input,
                task.result.result,
                workspace,
                false,
                null,
                workspace,
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
        const cleanup = await (options.worktreeCleaner ?? cleanupWorktree)(
          task.worktree,
          reason,
          options.keepWorktrees,
          // Cancellation stops workers and prevents new integration, but
          // already-created worktrees still need deterministic settlement.
          // Renewal is stopped immediately above; passing an already-aborted
          // signal here would strand completed sibling evidence and skip
          // continuation settlement rather than making shutdown safer.
          undefined,
        );
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
              : (task.worktree.workingDirectory ?? task.worktree.path);
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
                  workspace,
                  continuationInWorkspace
                    ? null
                    : (task.worktree.gitEvidenceAuthority ?? null),
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
        task.result.worktreePath = task.worktree.path;
        if (task.worktree.lease && !renewalError) {
          await releaseWorktreeLease(task.worktree.lease).catch((leaseError) => {
            task.result.warnings.push(
              `Persistent worktree lease release also failed: ${(leaseError as Error).message}`,
            );
          });
        }
      } finally {
        releaseWorktreeOwnership(task.worktree);
      }
    }
    assertOperationAuthorityAfterExecution("post-lifecycle health check");

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

    // Issue next-action authority only from the final task classification. Final
    // integration, verification, or lifecycle evidence can conservatively replace
    // an earlier provisional retry/escalation with parent takeover.
    if (options.handoffStore || options.handoffRegistrar) {
      for (const task of running) {
        if (task.result.result) {
          if (options.handoffRegistrar) {
            const ref = options.handoffRegistrar(task.input, task.result.result);
            task.result.handoffReference = ref;
            task.result.handoffState = task.result.result.handoffState;
          } else if (options.handoffStore) {
            const ref = registerHandoff(
              task.input,
              task.result.result,
              options.handoffStore,
              {
                authoritativePrior: task.authoritativePrior,
                workingDirectory: workspace,
                contextKey: options.handoffContextKey ?? null,
              },
            );
            task.result.handoffReference = ref;
            task.result.handoffState = task.result.result.handoffState;
          }
        }
      }
    }

    // The repository authority covers every parent mutation that could otherwise
    // appear in sibling evidence, including retained-worktree lease settlement.
    // Settle it before publishing terminal success so renewal/ownership loss is a
    // real pre-terminal failure rather than contradictory post-completion telemetry.
    await releaseOperationAuthorityBeforeTerminal();

    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
    const passed = running.filter(
      (task) => task.result.result?.verdict === "PASS",
    ).length;
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
  } finally {
    if (operationAuthority) {
      await operationAuthority.release().catch(() => undefined);
      operationAuthority = null;
    }
  }
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
      task.handoffReservation?.release();
      task.handoffReservation = null;
      markCancelled(batchId, task, emit);
      continue;
    }
    const authority = await captureGitEvidenceAuthority(workspace);
    const before = await snapshotSequentialEvidence(workspace, authority);
    const dependencyBaseline = await captureSharedDirectoryFingerprint(workspace);
    task.sharedDependencyBaseline = dependencyBaseline;
    let release: (() => void) | null = null;
    try {
      release = await workerSlots.acquire(signal);
      if (signal?.aborted) {
        task.handoffReservation?.release();
        task.handoffReservation = null;
        markCancelled(batchId, task, emit);
        continue;
      }
      task.handoffReservation?.commit();
      task.handoffReservation = null;
      await runOne(batchId, task, workspace, run, emit, signal, false, {
        attempt: task.result.attempt ?? 1,
        predecessorExecutionId: task.predecessorExecutionId ?? null,
        gitEvidenceAuthority: authority,
      });
      if (before && task.result.result) {
        const after = await snapshotSequentialEvidence(workspace, authority);
        if (!after) {
          const detail = "Sequential Git evidence scan failed after worker execution.";
          // Cancellation is an authoritative terminal outcome. Evidence still
          // gets scanned so cleanup/diagnosis is not skipped, but a secondary
          // scan failure cannot rewrite cancellation into an ordinary failure
          // and make finalization publish batch.completed.
          if (isCancelled(task)) {
            task.result.warnings.push(detail);
            if (!task.result.result.errors.includes(detail)) {
              task.result.result.errors.push(detail);
            }
          } else {
            task.result.result.verdict = "FAILED";
            task.result.result.trustworthy = false;
            task.result.result.errors.push(detail);
            task.result.error = detail;
            task.state = "failed";
            task.result.state = "failed";
            emit({
              type: "worker.failed",
              batchId,
              taskId: task.taskId,
              reason: detail,
              attempt: task.result.attempt ?? 1,
            });
          }
        } else {
          const changed = changedSequentialPaths(before, after).map((file) => ({
            path: file,
            kind: "sequential-git",
          }));
          task.result.result = reconcileParallelWorktreeEvidence(
            task.input,
            task.result.result,
            workspace,
            changed,
          );
          task.result.changedFiles = task.result.result.filesChanged
            .filter((file) => file.observed)
            .map((file) => file.path);
        }
      }
      if (task.result.result) {
        try {
          await assertSharedDirectoryFingerprint(dependencyBaseline);
        } catch (error) {
          const detail = `Sequential dependency evidence failed: ${(error as Error).message}`;
          task.result.result.verdict = "FAILED";
          task.result.result.trustworthy = false;
          if (!task.result.result.errors.includes(detail)) {
            task.result.result.errors.push(detail);
          }
          if (!task.result.result.discrepancies.includes(detail)) {
            task.result.result.discrepancies.push(detail);
          }
          task.result.warnings.push(detail);
        }
      }
      if (!isCancelled(task) && !isFailed(task) && task.result.result) {
        emitWorkerCompleted(batchId, task, emit, {
          attempt: task.result.attempt ?? 1,
          predecessorExecutionId: task.predecessorExecutionId ?? null,
        });
      }
    } catch (error) {
      if (isCancelled(task)) {
        const detail =
          `Sequential post-cancellation evidence lifecycle failed: ` +
          `${(error as Error).message}`;
        task.result.warnings.push(detail);
        if (task.result.result && !task.result.result.errors.includes(detail)) {
          task.result.result.errors.push(detail);
        }
        continue;
      }
      if (signal?.aborted) {
        markCancelled(batchId, task, emit);
        continue;
      }
      throw error;
    } finally {
      release?.();
    }
  }
}

async function snapshotSequentialEvidence(
  workspace: string,
  authority: GitEvidenceAuthority | null,
): Promise<Map<string, string> | null> {
  try {
    return authority
      ? await snapshotTrustedWorkspaceEvidence(authority, workspace, WORKTREE_LINK_DIRS)
      : await snapshotFilesystemWorkspaceEvidence(workspace);
  } catch {
    // Evidence failure is handled fail-closed by the caller.
    return null;
  }
}

function changedSequentialPaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return changedTrustedWorkspacePaths(before, after);
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
  allowDirtyWorktreeBase?: boolean,
): Promise<string[]> {
  const warnings: string[] = [];
  if (signal?.aborted) {
    for (const task of running) markCancelled(batchId, task, emit);
    return warnings;
  }

  const base = await prepareWorktreeBase(
    workspace,
    running.map((task) => task.input.allowedFiles),
    allowDirtyWorktreeBase,
  );

  const pruned = await pruneStaleWorktrees(base.repoRoot, protectedWorktreePaths, signal);
  if (pruned.length > 0) {
    warnings.push(`Removed ${pruned.length} stale worktree(s) from an earlier run.`);
  }
  if (base.dirtyPaths.length > 0) {
    const inScopeDirty = base.workspaceDirtyPaths.filter((dirty) =>
      running.some((task) => {
        if (task.input.allowedFiles.length === 0) return true;
        return picomatch(task.input.allowedFiles, {
          dot: true,
          nocase: process.platform === "win32" || process.platform === "darwin",
        })(dirty);
      }),
    );
    if (inScopeDirty.length > 0) {
      warnings.push(
        `Dirty-base override accepted ${inScopeDirty.length} uncommitted in-scope path(s) ` +
          `(${inScopeDirty.slice(0, 10).join(", ")}${inScopeDirty.length > 10 ? ", ..." : ""}). ` +
          "Workers branched from HEAD and did not see those edits; integrating a worker change to the same path can overwrite them.",
      );
    }
    const otherDirtyCount = base.dirtyPaths.length - inScopeDirty.length;
    if (otherDirtyCount > 0) {
      warnings.push(
        `The repository also has ${otherDirtyCount} uncommitted path(s) outside the active ` +
          "task scopes or requested workspace. Workers branched from HEAD and did not see them.",
      );
    }
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
        signal,
      );
      if (task.worktree.lease) {
        task.leaseRenewal = leaseMaintainer(
          task.worktree.lease,
          taskLeaseLifetimeMs(task.input),
          "running",
          signal,
        );
      }
      task.sharedDependencyBaseline =
        task.worktree.sharedDirectoryBaseline ?? task.sharedDependencyBaseline;
      task.result.warnings.push(...task.worktree.warnings);
    } catch (error) {
      task.handoffReservation?.release();
      task.handoffReservation = null;
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

  const integrationAuthority = await captureGitEvidenceAuthority(
    base.repoRoot,
    base.baseCommit,
  );
  if (!integrationAuthority) {
    throw new WorktreeUnavailableError(
      "Could not pin authoritative repository state for parallel integration.",
      "Retry the batch; integration is refused without a stable Git authority.",
    );
  }
  const integrationBaseline = await snapshotTrustedWorkspaceEvidence(
    integrationAuthority,
    workspace,
    WORKTREE_LINK_DIRS,
  );
  for (const task of running) {
    if (task.worktree) {
      task.worktree.integrationAuthority = integrationAuthority;
      task.worktree.integrationBaseline = integrationBaseline;
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
        task.handoffReservation?.release();
        task.handoffReservation = null;
        markCancelled(batchId, task, emit);
        return;
      }
      let policyRelease: (() => void) | null = null;
      let release: (() => void) | null = null;
      try {
        policyRelease = await policySlots.acquire(signal);
        release = await workerSlots.acquire(signal);
        if (signal?.aborted) {
          task.handoffReservation?.release();
          task.handoffReservation = null;
          markCancelled(batchId, task, emit);
          return;
        }

        task.handoffReservation?.commit();
        task.handoffReservation = null;
        await runOne(
          batchId,
          task,
          worktree.workingDirectory ?? worktree.path,
          run,
          emit,
          signal,
          false,
          {
            attempt: task.result.attempt ?? 1,
            predecessorExecutionId: task.predecessorExecutionId ?? null,
          },
        );

        const outcome = await readWorktreeOutcome(worktree);
        task.result.warnings.push(...outcome.warnings);
        task.result.diff = truncateDiff(outcome.changes.diff);
        task.worktreeEvidenceDigest = outcome.error
          ? null
          : await digestWorktreeEvidence(
              outcome.changes,
              worktree.workingDirectory ?? worktree.path,
            );

        const mutationFiles = outcome.changes.files.filter(
          (file) => file.status !== "C-source",
        );
        const changes = mutationFiles.map((file) => ({
          path: file.path,
          kind: file.status,
        }));
        if (task.result.result) {
          task.result.result = reconcileParallelWorktreeEvidence(
            task.input,
            task.result.result,
            worktree.workingDirectory ?? worktree.path,
            changes,
            outcome.error,
          );
          task.result.changedFiles = task.result.result.filesChanged
            .filter((file) => file.observed)
            .map((file) => file.path);
        } else {
          task.result.changedFiles = mutationFiles.map((file) => file.path);
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
        if (isCancelled(task)) {
          const detail = `Post-cancellation evidence lifecycle failed: ${(error as Error).message}`;
          task.result.error ??= detail;
          task.result.warnings.push(detail);
          if (task.result.result && !task.result.result.errors.includes(detail)) {
            task.result.result.errors.push(detail);
          }
          return;
        }
        if (signal?.aborted) {
          markCancelled(batchId, task, emit);
          return;
        }
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
        release?.();
        policyRelease?.();
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
    task.worktree.workingDirectory ?? task.worktree.path,
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
      let policyRelease: (() => void) | null = null;
      let release: (() => void) | null = null;
      try {
        policyRelease = await policySlots.acquire(signal);
        release = await workerSlots.acquire(signal);
        if (!task.worktree?.lease || !task.leaseRenewal) {
          const evidence =
            "Bounded recovery was refused because the owned worktree has no active persistent lease maintenance.";
          task.recovery = {
            ...decision,
            attempted: false,
            classification: "security-or-trust-boundary",
            evidence,
          };
          setRecoveryMetadata(task, task.recovery);
          task.result.warnings.push(evidence);
          emit({
            type: "recovery.skipped",
            batchId,
            taskId: task.taskId,
            attempt: decision.initialAttempt,
            classification: task.recovery.classification,
            evidence,
          });
          return;
        }
        try {
          task.leaseRenewal.assertHealthy();
          const recoveryHorizon = taskLeaseLifetimeMs(task.input);
          await refreshWorktreeLease(
            task.worktree.lease,
            Date.now() + recoveryHorizon,
            "running",
          );
          task.leaseRenewal.assertHealthy(Math.max(0, recoveryHorizon - 1_000));
        } catch (error) {
          const evidence =
            `Bounded recovery was refused because persistent worktree protection ` +
            `could not cover the recovery window: ${(error as Error).message}`;
          task.recovery = {
            ...decision,
            attempted: false,
            classification: "security-or-trust-boundary",
            evidence,
          };
          setRecoveryMetadata(task, task.recovery);
          task.result.warnings.push(evidence);
          emit({
            type: "recovery.skipped",
            batchId,
            taskId: task.taskId,
            attempt: decision.initialAttempt,
            classification: task.recovery.classification,
            evidence,
          });
          return;
        }
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

        await runOne(
          batchId,
          task,
          task.worktree.workingDirectory ?? task.worktree.path,
          run,
          emit,
          signal,
          false,
          {
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
          },
        );

        const outcome = await readWorktreeOutcome(task.worktree!);
        task.result.warnings.push(...outcome.warnings);
        task.result.diff = truncateDiff(outcome.changes.diff);
        task.worktreeEvidenceDigest = outcome.error
          ? null
          : await digestWorktreeEvidence(
              outcome.changes,
              task.worktree!.workingDirectory ?? task.worktree!.path,
            );
        const mutationFiles = outcome.changes.files.filter(
          (file) => file.status !== "C-source",
        );
        const changes = mutationFiles.map((file) => ({
          path: file.path,
          kind: file.status,
        }));
        if (task.result.result) {
          task.result.result = reconcileParallelWorktreeEvidence(
            task.input,
            task.result.result,
            task.worktree.workingDirectory ?? task.worktree.path,
            changes,
            outcome.error,
          );
          task.result.changedFiles = task.result.result.filesChanged
            .filter((file) => file.observed)
            .map((file) => file.path);
        } else {
          task.result.changedFiles = mutationFiles.map((file) => file.path);
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
          const detail = `Could not read worktree evidence: ${outcome.error}`;
          task.result.error = detail;
          if (isCancelled(task)) {
            task.result.warnings.push(detail);
            if (task.result.result && !task.result.result.errors.includes(detail)) {
              task.result.result.errors.push(detail);
            }
          } else {
            task.state = "failed";
            task.result.state = "failed";
          }
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
        if (isCancelled(task)) return;
        if (signal?.aborted) {
          const recoveryStarted = typeof task.recovery?.recoveryAttempt === "number";
          task.recovery = {
            ...(task.recovery ?? decision),
            attempted: recoveryStarted,
            classification: "cancellation",
            evidence: recoveryStarted
              ? "Batch cancellation interrupted the bounded recovery lifecycle."
              : "Batch cancellation arrived while the bounded recovery turn waited for execution capacity.",
          };
          setRecoveryMetadata(task, task.recovery);
          if (!recoveryStarted) {
            emit({
              type: "recovery.skipped",
              batchId,
              taskId: task.taskId,
              attempt: decision.initialAttempt,
              classification: "cancellation",
              evidence: task.recovery.evidence,
            });
          }
          markCancelled(batchId, task, emit);
          return;
        }
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
        release?.();
        policyRelease?.();
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
  signal?: AbortSignal,
): Promise<TaskWorktree> {
  const worktree = await createTaskWorktree(
    base,
    `${batchId}-${task.taskId}`,
    workspace,
    taskLeaseLifetimeMs(task.input),
    signal,
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
  gitEvidenceAuthority?: GitEvidenceAuthority | null;
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
  const taskModel = task.model ?? LUNA_MODEL;
  const startedAt = new Date();
  const startedMs = Date.now();
  const emittedAttemptStarts = new Set<string>();
  const gitEvidenceAuthority =
    attemptOptions.gitEvidenceAuthority ?? task.worktree?.gitEvidenceAuthority ?? null;
  emitAttemptStarted(emit, batchId, task.taskId, {
    executionId,
    logicalAttempt: attemptOptions.attempt,
    role,
    predecessorExecutionId: attemptOptions.predecessorExecutionId ?? null,
    requestedModel: taskModel,
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
    model: taskModel,
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
      model: taskModel,
      signal,
      gitEvidenceAuthority,
      beforeVerification: async () => {
        if (gitEvidenceAuthority) await assertGitEvidenceAuthority(gitEvidenceAuthority);
        if (task.sharedDependencyBaseline) {
          await assertSharedDirectoryFingerprint(task.sharedDependencyBaseline);
        }
      },
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

    // Parallel worktrees carry private dependency snapshots. The executor's
    // beforeVerification hook proves that snapshot immediately before checks,
    // but a check itself still runs with filesystem access and can mutate the
    // snapshot after that proof. Revalidate after the complete worker+verifier
    // turn, before worktree evidence is accepted or a retained continuation can
    // inherit the poisoned dependency state.
    if (task.worktree && task.sharedDependencyBaseline) {
      try {
        await assertSharedDirectoryFingerprint(task.sharedDependencyBaseline);
      } catch (error) {
        const detail = `Post-verification dependency evidence failed: ${(error as Error).message}`;
        task.worktreeOutcomeError = detail;
        task.result.warnings.push(detail);
        if (!resultWasCancelled(result)) {
          result.verdict = "FAILED";
          result.trustworthy = false;
          if (!result.errors.includes(detail)) result.errors.push(detail);
          if (!result.discrepancies.includes(detail)) result.discrepancies.push(detail);
        } else if (!result.errors.includes(detail)) {
          result.errors.push(detail);
        }
      }
    }

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
        requestedModel: taskModel,
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
  if (isCancelled(task)) return;
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
interface IntegrationPathSnapshot {
  signature: string;
  bytes: Buffer | null;
  kind: "missing" | "file" | "link" | "directory" | "other";
  identity: string | null;
  linkTarget?: string;
}

const integrationFileSignature = (bytes: Uint8Array): string =>
  `file:${createHash("sha256").update(bytes).digest("hex")}`;

const integrationStatIdentity = (entry: {
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number;
}): string => `${entry.dev}:${entry.ino}:${entry.birthtimeMs}`;

async function snapshotIntegrationPath(target: string): Promise<IntegrationPathSnapshot> {
  const entry = await fs.lstat(target).catch(() => null);
  if (!entry) {
    return { signature: "missing", bytes: null, kind: "missing", identity: null };
  }
  if (entry.isSymbolicLink()) {
    const linkTarget = await fs.readlink(target);
    return {
      signature: `link:${linkTarget}`,
      bytes: null,
      kind: "link",
      identity: integrationStatIdentity(entry),
      linkTarget,
    };
  }
  if (entry.isFile()) {
    const expectedIdentity = integrationStatIdentity(entry);
    const handle = await fs.open(target, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || integrationStatIdentity(opened) !== expectedIdentity) {
        throw new Error(`Integration path changed identity while opening ${target}.`);
      }
      const bytes = await readAllIntegrationBytes(handle);
      const after = await handle.stat();
      if (!after.isFile() || integrationStatIdentity(after) !== expectedIdentity) {
        throw new Error(`Integration path changed identity while reading ${target}.`);
      }
      return {
        signature: integrationFileSignature(bytes),
        bytes,
        kind: "file",
        identity: expectedIdentity,
      };
    } finally {
      await handle.close();
    }
  }
  if (entry.isDirectory()) {
    return {
      signature: `dir:${entry.mode}:${entry.size}`,
      bytes: null,
      kind: "directory",
      identity: integrationStatIdentity(entry),
    };
  }
  return {
    signature: `other:${entry.mode}:${entry.size}`,
    bytes: null,
    kind: "other",
    identity: integrationStatIdentity(entry),
  };
}

async function readAllIntegrationBytes(
  handle: Awaited<ReturnType<typeof fs.open>>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let position = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return Buffer.concat(chunks);
}

async function writeAllIntegrationBytes(
  handle: Awaited<ReturnType<typeof fs.open>>,
  bytes: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (bytesWritten <= 0) {
      throw new Error(
        "Destination write made no progress before all bytes were written.",
      );
    }
    offset += bytesWritten;
  }
}

async function restoreQuarantinedIntegrationPath(
  quarantine: string,
  destination: string,
  quarantined: IntegrationPathSnapshot,
): Promise<boolean> {
  if ((await snapshotIntegrationPath(destination)).kind !== "missing") return false;
  try {
    if (quarantined.kind === "file") {
      // link(2) is exclusive at the destination name, so a concurrent operator
      // replacement wins rather than being overwritten by rollback.
      await fs.link(quarantine, destination);
    } else if (quarantined.kind === "link") {
      // symlink creation is likewise exclusive when the destination appears in
      // the rollback window. Preserve the exact link target we quarantined.
      await fs.symlink(await fs.readlink(quarantine), destination);
    } else {
      return false;
    }
    await fs.unlink(quarantine);
    await fs.rmdir(path.dirname(quarantine)).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function pinnedDirectoryAuthorityStillMatches(
  authority: PinnedDirectoryAuthority,
  confinedRoot: string,
): Promise<boolean> {
  const current = await capturePinnedDirectoryAuthority(
    authority.directory,
    confinedRoot,
  ).catch(() => null);
  return (
    current?.identity === authority.identity &&
    path.resolve(current.canonical) === path.resolve(authority.canonical)
  );
}

async function restoreAcceptedIntegrationPath(
  authority: PinnedDirectoryAuthority,
  confinedRoot: string,
  name: string,
  expected: IntegrationPathSnapshot,
): Promise<boolean> {
  if (!(await pinnedDirectoryAuthorityStillMatches(authority, confinedRoot)))
    return false;
  try {
    if (expected.kind === "file" && expected.bytes) {
      await runPinnedDirectoryMutation(authority, {
        op: "write-file",
        name,
        mode: "exclusive",
        bytesBase64: expected.bytes.toString("base64"),
      });
    } else if (expected.kind === "link" && expected.linkTarget !== undefined) {
      await runPinnedDirectoryMutation(authority, {
        op: "symlink",
        name,
        target: expected.linkTarget,
        type: process.platform === "win32" ? "file" : "file",
      });
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function integrationPathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function ensureIntegrationDeleteQuarantineRoot(repoRoot: string): Promise<string> {
  const canonicalRepo = await fs.realpath(repoRoot);
  let current = repoRoot;
  for (const segment of [".sol-luna", "integration-delete"]) {
    current = path.join(current, segment);
    const existing = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
      throw new Error(`Refusing redirected integration quarantine path: ${current}.`);
    }
    if (!existing) await fs.mkdir(current);
    const created = await fs.lstat(current);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error(`Refusing redirected integration quarantine path: ${current}.`);
    }
    const canonical = await fs.realpath(current);
    if (!integrationPathIsWithin(canonicalRepo, canonical)) {
      throw new Error(
        `Integration quarantine path resolves outside its repository: ${current}.`,
      );
    }
  }
  return current;
}

interface PinnedDeletionResult {
  status: "applied" | "blocked" | "cancelled";
  authoritativeMutation: boolean;
  restored: boolean;
  warning?: string;
  reason?: "source-drift" | "workspace-drift";
}

async function performPinnedIntegrationDeletion(options: {
  repoRoot: string;
  workspace: string;
  destination: string;
  source: string;
  expectedDestination: IntegrationPathSnapshot;
  expectedSourceSignature: string;
  signal?: AbortSignal;
  beforeDelete?: (phase: "validated" | "moved") => void | Promise<void>;
  failQuarantineCleanup?: boolean;
}): Promise<PinnedDeletionResult> {
  const {
    repoRoot,
    workspace,
    destination,
    source,
    expectedDestination,
    expectedSourceSignature,
    signal,
    beforeDelete,
    failQuarantineCleanup,
  } = options;
  if (
    (expectedDestination.kind !== "file" || expectedDestination.bytes === null) &&
    (expectedDestination.kind !== "link" || expectedDestination.linkTarget === undefined)
  ) {
    return {
      status: "blocked",
      authoritativeMutation: false,
      restored: false,
      warning: "the accepted deletion target is not a stable file or symbolic link",
      reason: "workspace-drift",
    };
  }

  const quarantineRoot = await ensureIntegrationDeleteQuarantineRoot(repoRoot);
  const quarantineAuthority = await capturePinnedDirectoryAuthority(
    quarantineRoot,
    repoRoot,
  );
  const quarantineName = `delete-${randomBytes(24).toString("hex")}`;
  const backupResult =
    expectedDestination.kind === "file"
      ? await runPinnedDirectoryMutation(quarantineAuthority, {
          op: "write-file",
          name: quarantineName,
          bytesBase64: expectedDestination.bytes!.toString("base64"),
          mode: "exclusive",
        })
      : await runPinnedDirectoryMutation(quarantineAuthority, {
          op: "symlink",
          name: quarantineName,
          target: expectedDestination.linkTarget!,
          type: "file",
        });

  const cleanupBackup = async (injectFailure = false): Promise<boolean> => {
    if (!backupResult.snapshot) return false;
    try {
      await runPinnedDirectoryMutation(quarantineAuthority, {
        op: "unlink",
        name: quarantineName,
        expectedIdentity: backupResult.snapshot.identity ?? undefined,
        expectedSignature: backupResult.snapshot.signature,
        testFailBeforeUnlink: injectFailure,
      });
      const rootStat = await fs.lstat(quarantineRoot).catch(() => null);
      if (rootStat?.isDirectory() && !rootStat.isSymbolicLink()) {
        const rootParent = path.dirname(quarantineRoot);
        const rootParentAuthority = await capturePinnedDirectoryAuthority(
          rootParent,
          repoRoot,
        ).catch(() => null);
        if (rootParentAuthority) {
          await runPinnedDirectoryMutation(rootParentAuthority, {
            op: "rmdir",
            name: path.basename(quarantineRoot),
            expectedIdentity: integrationStatIdentity(rootStat),
          }).catch(() => undefined);
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  const destinationParent = path.dirname(destination);
  const destinationName = path.basename(destination);
  const destinationParentAuthority = await capturePinnedDirectoryAuthority(
    destinationParent,
    workspace,
  );
  const tombstoneName = `.sol-luna-delete-${randomBytes(24).toString("hex")}.tmp`;

  let moved:
    Awaited<ReturnType<typeof runPinnedDirectoryMutation>>["snapshot"] | undefined;
  try {
    const result = await runPinnedDirectoryMutation(
      destinationParentAuthority,
      {
        op: "rename-verified",
        sourceName: destinationName,
        destinationName: tombstoneName,
        expectedIdentity: expectedDestination.identity ?? undefined,
        expectedSignature: expectedDestination.signature,
      },
      {
        beforeExecute: async () => {
          await beforeDelete?.("validated");
          if (signal?.aborted) {
            const error = new Error(
              "Integration deletion was cancelled before namespace move.",
            );
            error.name = "AbortError";
            throw error;
          }
        },
      },
    );
    moved = result.snapshot;
  } catch (error) {
    await cleanupBackup();
    return {
      status: signal?.aborted ? "cancelled" : "blocked",
      authoritativeMutation:
        error instanceof PinnedDirectoryMutationError ? error.mutated : false,
      restored: false,
      warning: (error as Error).message,
      reason: "workspace-drift",
    };
  }

  const restoreMoved = async (expected: NonNullable<typeof moved>): Promise<boolean> => {
    if (
      !(await pinnedDirectoryAuthorityStillMatches(destinationParentAuthority, workspace))
    ) {
      return false;
    }
    try {
      await runPinnedDirectoryMutation(destinationParentAuthority, {
        op: "rename-verified",
        sourceName: tombstoneName,
        destinationName,
        expectedIdentity: expected.identity ?? undefined,
        expectedSignature: expected.signature,
      });
      await cleanupBackup();
      return true;
    } catch {
      return false;
    }
  };

  if (
    !moved ||
    moved.signature !== expectedDestination.signature ||
    moved.identity !== expectedDestination.identity
  ) {
    const restored = moved ? await restoreMoved(moved) : false;
    return {
      status: "blocked",
      authoritativeMutation: !restored,
      restored,
      warning: restored
        ? "the deletion target changed during the pinned namespace move; the raced entry was restored"
        : "the deletion target changed during the pinned namespace move; recoverable quarantine state was retained",
      reason: "workspace-drift",
    };
  }

  await beforeDelete?.("moved");
  const parentStillAuthoritative = await pinnedDirectoryAuthorityStillMatches(
    destinationParentAuthority,
    workspace,
  );
  const boundarySource = await snapshotIntegrationPath(source);
  const boundaryDestination = parentStillAuthoritative
    ? await snapshotIntegrationPath(destination)
    : null;
  const sourceDrifted =
    boundarySource.kind !== "missing" ||
    boundarySource.signature !== expectedSourceSignature;
  const destinationDrifted =
    !parentStillAuthoritative || boundaryDestination?.kind !== "missing";
  if (signal?.aborted || sourceDrifted || destinationDrifted) {
    const restored = await restoreMoved(moved);
    return {
      status: signal?.aborted ? "cancelled" : "blocked",
      authoritativeMutation: !restored,
      restored,
      warning: signal?.aborted
        ? restored
          ? "cancellation was observed after the deletion boundary and the namespace move was rolled back safely"
          : "cancellation was observed after the deletion boundary; rollback could not safely replace newer destination state"
        : restored
          ? `${sourceDrifted ? "the deletion source" : "the authoritative destination"} changed at the deletion boundary; the namespace move was rolled back safely`
          : `${sourceDrifted ? "the deletion source" : "the authoritative destination"} changed at the deletion boundary; recoverable quarantine state was retained`,
      reason: sourceDrifted ? "source-drift" : "workspace-drift",
    };
  }

  try {
    await runPinnedDirectoryMutation(destinationParentAuthority, {
      op: "unlink",
      name: tombstoneName,
      expectedIdentity: moved.identity ?? undefined,
      expectedSignature: moved.signature,
    });
  } catch (error) {
    const mutated = error instanceof PinnedDirectoryMutationError && error.mutated;
    const restored = mutated
      ? await restoreAcceptedIntegrationPath(
          destinationParentAuthority,
          workspace,
          destinationName,
          expectedDestination,
        )
      : await restoreMoved(moved);
    return {
      status: "blocked",
      authoritativeMutation: !restored,
      restored,
      warning: `pinned deletion cleanup failed (${(error as Error).message})`,
      reason: "workspace-drift",
    };
  }

  const quarantineCleaned = await cleanupBackup(failQuarantineCleanup);
  if (!quarantineCleaned) {
    const restored = await restoreAcceptedIntegrationPath(
      destinationParentAuthority,
      workspace,
      destinationName,
      expectedDestination,
    );
    return {
      status: "blocked",
      authoritativeMutation: !restored,
      restored,
      warning: "pinned quarantine cleanup failed after the authoritative deletion",
      reason: "workspace-drift",
    };
  }

  return {
    status: "applied",
    authoritativeMutation: true,
    restored: false,
  };
}

async function summarizeWorktreeEvidence(
  changes: {
    files: Array<{ path: string; status: string }>;
    diff: string;
  },
  workingDirectory: string,
): Promise<{ digest: string; pathSignatures: Map<string, string> }> {
  const pathSignatures: Array<[string, string]> = [];
  for (const file of changes.files.filter((entry) => entry.status !== "C-source")) {
    const target = path.join(workingDirectory, ...file.path.split("/"));
    pathSignatures.push([file.path, (await snapshotIntegrationPath(target)).signature]);
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        files: [...changes.files].sort(
          (a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status),
        ),
        diff: changes.diff,
        pathSignatures,
      }),
    )
    .digest("hex");
  return { digest, pathSignatures: new Map(pathSignatures) };
}

async function digestWorktreeEvidence(
  changes: {
    files: Array<{ path: string; status: string }>;
    diff: string;
  },
  workingDirectory: string,
): Promise<string> {
  return (await summarizeWorktreeEvidence(changes, workingDirectory)).digest;
}
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
  signal?: AbortSignal,
  beforeWrite?: (context: {
    batchId: string;
    taskId: string;
    file: string;
    appliedFiles: number;
  }) => void | Promise<void>,
  beforeDelete?: (context: {
    batchId: string;
    taskId: string;
    file: string;
    appliedFiles: number;
    phase: "validated" | "moved";
  }) => void | Promise<void>,
  beforeParentCreate?: (context: {
    batchId: string;
    taskId: string;
    file: string;
    parent: string;
    candidate: string;
    segment: string;
    appliedFiles: number;
  }) => void | Promise<void>,
  pinnedWriteTest?: {
    maxWriteBytes?: number;
    failAfterTruncate?: boolean;
    failAfterBytes?: number;
  },
  pinnedDeleteTest?: {
    failQuarantineCleanup?: boolean;
  },
): Promise<{ fileCount: number; warnings: string[] }> {
  const warnings: string[] = [];
  if (signal?.aborted) {
    warnings.push(
      "Integration was refused because the batch was cancelled before any write.",
    );
    return { fileCount: 0, warnings };
  }
  const owner = tasks.find(
    (task) => task.worktree?.integrationAuthority && task.worktree.integrationBaseline,
  )?.worktree;
  if (!owner?.integrationAuthority || !owner.integrationBaseline) {
    warnings.push(
      "Integration was refused because the pre-worker authoritative workspace baseline is unavailable.",
    );
    return { fileCount: 0, warnings };
  }

  const conflicts = (left: string, right: string): boolean =>
    left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  const plannedPaths = tasks.flatMap((task) => task.result.changedFiles);

  return await withWorktreeMetadataAuthority(
    owner.integrationAuthority.repoRoot,
    async (assertLeaseHealthy) => {
      if (signal?.aborted) {
        warnings.push(
          "Integration was refused because the batch was cancelled before any write.",
        );
        return { fileCount: 0, warnings };
      }

      assertLeaseHealthy();
      await assertGitEvidenceAuthority(owner.integrationAuthority!);
      const current = await snapshotTrustedWorkspaceEvidence(
        owner.integrationAuthority!,
        workspace,
        WORKTREE_LINK_DIRS,
      );
      const drift = changedTrustedWorkspacePaths(owner.integrationBaseline!, current);
      const conflictingDrift = drift.filter((changed) =>
        plannedPaths.some((planned) => conflicts(changed, planned)),
      );
      if (conflictingDrift.length > 0) {
        const detail =
          `Integration was refused because the authoritative workspace changed after ` +
          `parallel admission at: ${conflictingDrift.slice(0, 10).join(", ")}` +
          (conflictingDrift.length > 10 ? ", ..." : "");
        warnings.push(detail);
        for (const task of tasks) {
          if (
            task.result.changedFiles.some((file) =>
              conflictingDrift.some((changed) => conflicts(changed, file)),
            )
          ) {
            emit({
              type: "integration.blocked",
              batchId,
              taskId: task.taskId,
              reason: "workspace-drift",
            });
          }
        }
        return { fileCount: 0, warnings };
      }

      // Re-read every isolated worktree while integration authority is held and
      // retain the exact per-path signatures that contributed to the accepted
      // digest. The write boundary compares against these signatures again and
      // writes the exact bytes from that final comparison instead of re-opening
      // the source through fs.copyFile.
      const acceptedSourceSignatures = new Map<string, Map<string, string>>();
      for (const task of tasks) {
        if (!task.worktree || !task.worktreeEvidenceDigest) {
          warnings.push(
            `Integration was refused for ${task.taskId}: stable worktree evidence is unavailable.`,
          );
          emit({
            type: "integration.blocked",
            batchId,
            taskId: task.taskId,
            reason: "source-drift",
          });
          return { fileCount: 0, warnings };
        }
        const fresh = await readWorktreeOutcome(task.worktree);
        const summary = fresh.error
          ? null
          : await summarizeWorktreeEvidence(
              fresh.changes,
              task.worktree.workingDirectory ?? task.worktree.path,
            );
        if (!summary || summary.digest !== task.worktreeEvidenceDigest) {
          warnings.push(
            `Integration was refused for ${task.taskId}: its isolated worktree changed after evidence collection.`,
          );
          emit({
            type: "integration.blocked",
            batchId,
            taskId: task.taskId,
            reason: "source-drift",
          });
          return { fileCount: 0, warnings };
        }
        acceptedSourceSignatures.set(task.taskId, summary.pathSignatures);
      }

      if (signal?.aborted) {
        warnings.push(
          "Integration was refused because the batch was cancelled before any write.",
        );
        return { fileCount: 0, warnings };
      }

      let fileCount = 0;
      let stopIntegration = false;
      const isProtectedControlPath = picomatch([...PROTECTED_CONTROL_PATHS], {
        dot: true,
        nocase: process.platform === "win32" || process.platform === "darwin",
      });
      const cancellationWarning = (
        taskId: string,
        file: string,
        appliedFiles: number,
      ): string =>
        appliedFiles === 0
          ? "Integration was refused because the batch was cancelled before any write."
          : `Integration stopped after copying ${appliedFiles} file(s); cancellation was observed before writing ${file} from ${taskId}.`;

      taskLoop: for (const task of tasks) {
        if (!task.worktree) continue;
        let applied = 0;
        const sourceRoot = task.worktree.workingDirectory ?? task.worktree.path;
        const canonicalSourceRoot = defaultRealPathResolver(sourceRoot);
        const sourceSignatures = acceptedSourceSignatures.get(task.taskId);

        for (const file of task.result.changedFiles) {
          assertLeaseHealthy();
          const appliedFiles = fileCount + applied;
          if (signal?.aborted) {
            warnings.push(cancellationWarning(task.taskId, file, appliedFiles));
            stopIntegration = true;
            break;
          }
          // Unreachable in normal flow: `changedFiles` is a subset of the paths
          // `findScopeViolations` already judged. Keep an independent write gate
          // anyway because this is the boundary that mutates operator-owned bytes.
          if (isProtectedControlPath(file)) {
            warnings.push(
              `Refused to integrate ${file} from ${task.taskId}: ` +
                `${PROTECTED_CONTROL_VIOLATION} is never copied into the workspace.`,
            );
            emit({
              type: "integration.blocked",
              batchId,
              taskId: task.taskId,
              reason: "protected-control-path",
            });
            continue;
          }

          const source = path.join(sourceRoot, ...file.split("/"));
          const destination = path.join(workspace, ...file.split("/"));
          let authoritativeMutation = false;
          let mutationCounted = false;
          let rollbackAuthoritativeMutation: (() => Promise<boolean>) | null = null;
          const countAuthoritativeMutation = (): void => {
            if (mutationCounted) return;
            applied += 1;
            mutationCounted = true;
          };

          try {
            const expectedSourceSignature = sourceSignatures?.get(file);
            if (!expectedSourceSignature) {
              warnings.push(
                `Refused to integrate ${file} from ${task.taskId}: accepted source evidence is unavailable at the write boundary.`,
              );
              emit({
                type: "integration.blocked",
                batchId,
                taskId: task.taskId,
                reason: "source-drift",
              });
              stopIntegration = true;
              break;
            }

            // This state has already been proven equivalent to the admission
            // baseline by the global drift check above. Capture its exact path
            // identity/content now so a deterministic or external mutation in
            // the validation-to-write window cannot be overwritten invisibly.
            const validatedDestination = defaultRealPathResolver(destination);
            const destinationScopeViolations = findScopeViolations(
              [validatedDestination],
              task.input.allowedFiles,
              task.input.forbiddenFiles,
              workspace,
            );
            if (destinationScopeViolations.length > 0) {
              warnings.push(
                `Refused to integrate ${file} from ${task.taskId}: the destination resolves ` +
                  `outside its authorised workspace scope (${destinationScopeViolations.join("; ")}).`,
              );
              emit({
                type: "integration.blocked",
                batchId,
                taskId: task.taskId,
                reason: "scope-violation",
              });
              continue;
            }
            const expectedDestination =
              await snapshotIntegrationPath(validatedDestination);

            await beforeWrite?.({
              batchId,
              taskId: task.taskId,
              file,
              appliedFiles,
            });
            if (signal?.aborted) {
              warnings.push(cancellationWarning(task.taskId, file, appliedFiles));
              stopIntegration = true;
              break;
            }

            const resolvedDestination = defaultRealPathResolver(destination);
            const finalDestinationScopeViolations = findScopeViolations(
              [resolvedDestination],
              task.input.allowedFiles,
              task.input.forbiddenFiles,
              workspace,
            );
            const currentDestination = await snapshotIntegrationPath(resolvedDestination);
            if (
              finalDestinationScopeViolations.length > 0 ||
              path.resolve(resolvedDestination) !== path.resolve(validatedDestination) ||
              currentDestination.signature !== expectedDestination.signature
            ) {
              warnings.push(
                `Refused to integrate ${file} from ${task.taskId}: the authoritative destination changed after integration validation.`,
              );
              emit({
                type: "integration.blocked",
                batchId,
                taskId: task.taskId,
                reason: "workspace-drift",
              });
              stopIntegration = true;
              break;
            }

            const resolvedSource = defaultRealPathResolver(source);
            const sourceRelative = path.relative(canonicalSourceRoot, resolvedSource);
            const currentSource = await snapshotIntegrationPath(source);
            if (
              sourceRelative === ".." ||
              sourceRelative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(sourceRelative) ||
              currentSource.signature !== expectedSourceSignature
            ) {
              warnings.push(
                `Refused to integrate ${file} from ${task.taskId}: its source changed after integration validation.`,
              );
              emit({
                type: "integration.blocked",
                batchId,
                taskId: task.taskId,
                reason: "source-drift",
              });
              stopIntegration = true;
              break;
            }
            if (currentSource.kind !== "missing" && currentSource.kind !== "file") {
              warnings.push(
                `Refused to integrate ${file} from ${task.taskId}: source is not a stable regular file.`,
              );
              emit({
                type: "integration.blocked",
                batchId,
                taskId: task.taskId,
                reason: "source-drift",
              });
              stopIntegration = true;
              break;
            }

            assertLeaseHealthy();
            if (signal?.aborted) {
              warnings.push(cancellationWarning(task.taskId, file, appliedFiles));
              stopIntegration = true;
              break;
            }

            if (currentSource.kind === "missing") {
              // Deletion cannot safely use unlink(destination): even a final
              // snapshot leaves a path race where an operator replacement can
              // land before unlink resolves that name. Move the destination to
              // a private quarantine name first, then prove the moved object is
              // exactly the accepted destination before unlinking that object.
              // A race therefore moves recoverable bytes instead of deleting
              // them, and cancellation can still roll the namespace move back.
              let quarantineRoot: string;
              try {
                quarantineRoot = await ensureIntegrationDeleteQuarantineRoot(
                  owner.integrationAuthority!.repoRoot,
                );
              } catch (error) {
                warnings.push(
                  `Refused to integrate ${file} from ${task.taskId}: integration deletion quarantine is not trustworthy (${(error as Error).message}).`,
                );
                emit({
                  type: "integration.blocked",
                  batchId,
                  taskId: task.taskId,
                  reason: "workspace-drift",
                });
                stopIntegration = true;
                break;
              }
              const quarantine = path.join(
                quarantineRoot,
                `${batchId}-${task.taskId}-${randomBytes(24).toString("hex")}`,
              );
              const finalDestination = defaultRealPathResolver(destination);
              const finalSnapshot = await snapshotIntegrationPath(finalDestination);
              const finalSourceSnapshot = await snapshotIntegrationPath(source);
              if (
                path.resolve(finalDestination) !== path.resolve(validatedDestination) ||
                finalSnapshot.signature !== expectedDestination.signature ||
                finalSourceSnapshot.kind !== "missing" ||
                finalSourceSnapshot.signature !== expectedSourceSignature
              ) {
                const sourceDrift =
                  finalSourceSnapshot.kind !== "missing" ||
                  finalSourceSnapshot.signature !== expectedSourceSignature;
                warnings.push(
                  sourceDrift
                    ? `Refused to integrate ${file} from ${task.taskId}: its deletion source changed at the write boundary.`
                    : `Refused to integrate ${file} from ${task.taskId}: the authoritative destination changed at the write boundary.`,
                );
                emit({
                  type: "integration.blocked",
                  batchId,
                  taskId: task.taskId,
                  reason: sourceDrift ? "source-drift" : "workspace-drift",
                });
                stopIntegration = true;
                break;
              }

              await beforeDelete?.({
                batchId,
                taskId: task.taskId,
                file,
                appliedFiles,
                phase: "validated",
              });
              if (signal?.aborted) {
                warnings.push(cancellationWarning(task.taskId, file, appliedFiles));
                stopIntegration = true;
                break;
              }

              try {
                await fs.rename(finalDestination, quarantine);
              } catch (error) {
                warnings.push(
                  `Refused to integrate ${file} from ${task.taskId}: the authoritative destination changed while entering the deletion boundary (${(error as Error).message}).`,
                );
                emit({
                  type: "integration.blocked",
                  batchId,
                  taskId: task.taskId,
                  reason: "workspace-drift",
                });
                stopIntegration = true;
                break;
              }
              authoritativeMutation = true;
              rollbackAuthoritativeMutation = async () => {
                const rollbackSnapshot = await snapshotIntegrationPath(quarantine);
                if (rollbackSnapshot.signature !== expectedDestination.signature)
                  return false;
                return restoreQuarantinedIntegrationPath(
                  quarantine,
                  destination,
                  rollbackSnapshot,
                );
              };

              await beforeDelete?.({
                batchId,
                taskId: task.taskId,
                file,
                appliedFiles,
                phase: "moved",
              });

              const quarantined = await snapshotIntegrationPath(quarantine);
              const boundarySource = await snapshotIntegrationPath(source);
              const boundaryDestination = await snapshotIntegrationPath(destination);
              const destinationDrifted =
                quarantined.signature !== expectedDestination.signature ||
                boundaryDestination.kind !== "missing";
              const sourceDrifted =
                boundarySource.kind !== "missing" ||
                boundarySource.signature !== expectedSourceSignature;

              if (destinationDrifted || sourceDrifted || signal?.aborted) {
                const restored = await restoreQuarantinedIntegrationPath(
                  quarantine,
                  destination,
                  quarantined,
                );
                if (!restored) {
                  // The destination was already moved out of the authoritative
                  // namespace. Preserve the quarantined bytes and count that
                  // mutation so partial reporting can never claim zero writes.
                  countAuthoritativeMutation();
                } else {
                  authoritativeMutation = false;
                  rollbackAuthoritativeMutation = null;
                }

                if (signal?.aborted) {
                  warnings.push(
                    restored
                      ? cancellationWarning(task.taskId, file, appliedFiles)
                      : `Integration stopped after applying ${appliedFiles + 1} file(s); cancellation was observed after the deletion boundary for ${file} from ${task.taskId}, and rollback could not safely replace newer destination state.`,
                  );
                } else {
                  warnings.push(
                    `Refused to integrate ${file} from ${task.taskId}: ${
                      sourceDrifted
                        ? "its source changed at the deletion boundary"
                        : "the authoritative destination changed at the deletion boundary"
                    }.${
                      restored
                        ? " The raced destination state was restored."
                        : " The raced bytes were preserved in orchestrator quarantine because newer destination state prevented safe rollback."
                    }`,
                  );
                  emit({
                    type: "integration.blocked",
                    batchId,
                    taskId: task.taskId,
                    reason: sourceDrifted ? "source-drift" : "workspace-drift",
                  });
                }
                stopIntegration = true;
                break;
              }

              // The random quarantine name is the only name we unlink. It holds
              // the exact object proven above, so a later operator replacement at
              // the authoritative path is never the object this unlink targets.
              const unlinkSource = await snapshotIntegrationPath(source);
              const unlinkTarget = await snapshotIntegrationPath(quarantine);
              if (
                unlinkSource.kind !== "missing" ||
                unlinkSource.signature !== expectedSourceSignature ||
                unlinkTarget.signature !== expectedDestination.signature
              ) {
                const restored = await restoreQuarantinedIntegrationPath(
                  quarantine,
                  destination,
                  unlinkTarget,
                );
                if (!restored) countAuthoritativeMutation();
                else {
                  authoritativeMutation = false;
                  rollbackAuthoritativeMutation = null;
                }
                warnings.push(
                  `Refused to integrate ${file} from ${task.taskId}: accepted deletion evidence changed at the unlink boundary.${
                    restored
                      ? " The authoritative destination was restored."
                      : " The raced bytes were preserved in orchestrator quarantine because rollback could not safely replace newer destination state."
                  }`,
                );
                emit({
                  type: "integration.blocked",
                  batchId,
                  taskId: task.taskId,
                  reason:
                    unlinkSource.kind !== "missing" ||
                    unlinkSource.signature !== expectedSourceSignature
                      ? "source-drift"
                      : "workspace-drift",
                });
                stopIntegration = true;
                break;
              }
              await fs.unlink(quarantine);
              await fs.rmdir(quarantineRoot).catch(() => undefined);
              countAuthoritativeMutation();
              rollbackAuthoritativeMutation = null;
            } else {
              try {
                await assertConfinedDirectoryChain(
                  workspace,
                  path.dirname(resolvedDestination),
                );
              } catch (error) {
                warnings.push(
                  `Refused to integrate ${file} from ${task.taskId}: destination parent ancestry is not an existing confined directory (${(error as Error).message}).`,
                );
                emit({
                  type: "integration.blocked",
                  batchId,
                  taskId: task.taskId,
                  reason: "workspace-drift",
                });
                stopIntegration = true;
                break;
              }
              const finalDestination = defaultRealPathResolver(destination);
              const finalSnapshot = await snapshotIntegrationPath(finalDestination);
              if (
                path.resolve(finalDestination) !== path.resolve(validatedDestination) ||
                finalSnapshot.signature !== expectedDestination.signature
              ) {
                warnings.push(
                  `Refused to integrate ${file} from ${task.taskId}: the authoritative destination changed at the write boundary.`,
                );
                emit({
                  type: "integration.blocked",
                  batchId,
                  taskId: task.taskId,
                  reason: "workspace-drift",
                });
                stopIntegration = true;
                break;
              }
              if (signal?.aborted) {
                warnings.push(cancellationWarning(task.taskId, file, appliedFiles));
                stopIntegration = true;
                break;
              }
              if (expectedDestination.kind === "missing") {
                try {
                  const destinationParent = path.dirname(finalDestination);
                  const destinationParentAuthority =
                    await capturePinnedDirectoryAuthority(destinationParent, workspace);
                  const result = await runPinnedDirectoryMutation(
                    destinationParentAuthority,
                    {
                      op: "write-file",
                      name: path.basename(finalDestination),
                      bytesBase64: currentSource.bytes!.toString("base64"),
                      mode: "exclusive",
                      testMaxWriteBytes: pinnedWriteTest?.maxWriteBytes,
                      testFailAfterBytes: pinnedWriteTest?.failAfterBytes,
                    },
                  );
                  authoritativeMutation = result.mutated;
                  const currentParentAuthority = await capturePinnedDirectoryAuthority(
                    destinationParent,
                    workspace,
                  ).catch(() => null);
                  const parentStillAuthoritative =
                    currentParentAuthority?.identity ===
                      destinationParentAuthority.identity &&
                    path.resolve(currentParentAuthority.canonical) ===
                      path.resolve(destinationParentAuthority.canonical);
                  if (
                    !parentStillAuthoritative ||
                    result.snapshot?.kind !== "file" ||
                    result.snapshot.signature !==
                      integrationFileSignature(currentSource.bytes!)
                  ) {
                    countAuthoritativeMutation();
                    warnings.push(
                      `Integration of ${file} from ${task.taskId} did not remain authoritative at the pinned destination write boundary.`,
                    );
                    emit({
                      type: "integration.blocked",
                      batchId,
                      taskId: task.taskId,
                      reason: "workspace-drift",
                    });
                    stopIntegration = true;
                    break;
                  }
                  countAuthoritativeMutation();
                } catch (error) {
                  if (error instanceof PinnedDirectoryMutationError && error.mutated) {
                    authoritativeMutation = true;
                  }
                  throw error;
                }
              } else if (expectedDestination.kind === "file") {
                try {
                  const destinationParent = path.dirname(finalDestination);
                  const destinationParentAuthority =
                    await capturePinnedDirectoryAuthority(destinationParent, workspace);
                  const result = await runPinnedDirectoryMutation(
                    destinationParentAuthority,
                    {
                      op: "write-file",
                      name: path.basename(finalDestination),
                      bytesBase64: currentSource.bytes!.toString("base64"),
                      mode: "replace",
                      expectedIdentity: expectedDestination.identity ?? undefined,
                      expectedSignature: expectedDestination.signature,
                      testMaxWriteBytes: pinnedWriteTest?.maxWriteBytes,
                      testFailAfterTruncate: pinnedWriteTest?.failAfterTruncate,
                      testFailAfterBytes: pinnedWriteTest?.failAfterBytes,
                    },
                  );
                  authoritativeMutation = result.mutated;
                  const currentParentAuthority = await capturePinnedDirectoryAuthority(
                    destinationParent,
                    workspace,
                  ).catch(() => null);
                  const parentStillAuthoritative =
                    currentParentAuthority?.identity ===
                      destinationParentAuthority.identity &&
                    path.resolve(currentParentAuthority.canonical) ===
                      path.resolve(destinationParentAuthority.canonical);
                  if (
                    !parentStillAuthoritative ||
                    result.snapshot?.kind !== "file" ||
                    result.snapshot.signature !==
                      integrationFileSignature(currentSource.bytes!)
                  ) {
                    countAuthoritativeMutation();
                    warnings.push(
                      `Integration of ${file} from ${task.taskId} did not remain authoritative at the pinned destination write boundary.`,
                    );
                    emit({
                      type: "integration.blocked",
                      batchId,
                      taskId: task.taskId,
                      reason: "workspace-drift",
                    });
                    stopIntegration = true;
                    break;
                  }
                  countAuthoritativeMutation();
                } catch (error) {
                  if (error instanceof PinnedDirectoryMutationError && error.mutated) {
                    authoritativeMutation = true;
                  }
                  throw error;
                }
              } else {
                warnings.push(
                  `Refused to integrate ${file} from ${task.taskId}: the authoritative destination is not a stable regular file.`,
                );
                emit({
                  type: "integration.blocked",
                  batchId,
                  taskId: task.taskId,
                  reason: "workspace-drift",
                });
                stopIntegration = true;
                break;
              }
            }
          } catch (error) {
            let restored = false;
            if (authoritativeMutation && rollbackAuthoritativeMutation) {
              try {
                restored = await rollbackAuthoritativeMutation();
              } catch {
                restored = false;
              }
            }
            if (authoritativeMutation && !restored) countAuthoritativeMutation();
            if (authoritativeMutation) {
              warnings.push(
                `Could not integrate ${file} from ${task.taskId} after an authoritative mutation: ${(error as Error).message}. ` +
                  (restored
                    ? "The mutation was rolled back safely; integration stopped."
                    : "The mutation is counted as applied because rollback could not be proven safe; integration stopped."),
              );
              stopIntegration = true;
              break;
            }
            warnings.push(
              `Could not integrate ${file} from ${task.taskId}: ${(error as Error).message}`,
            );
          }
        }

        fileCount += applied;
        if (applied < task.result.changedFiles.length || stopIntegration) {
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
        if (stopIntegration) break taskLoop;
      }

      return { fileCount, warnings };
    },
    // Cancellation is checked explicitly at every pre-write boundary above.
    // Do not wire it into the metadata lease itself: an AbortError after an
    // earlier file applied would erase the truthful partial-write count.
    undefined,
  );
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
