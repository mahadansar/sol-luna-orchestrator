/**
 * Orchestration and context metrics folded from one run's telemetry.
 *
 * Pure and total: it takes already-parsed event objects and returns counts. It
 * adds no instrumentation to the product, so measuring cannot change what is
 * measured, and it invents nothing — a quantity the events never carried stays
 * `null` rather than becoming zero.
 */

/** Effort ladder used only to decide whether an attempt escalated. */
export const BENCHMARK_EFFORT_LADDER = ["medium", "high", "xhigh", "max"] as const;

const effortRank = (effort: unknown): number =>
  typeof effort === "string"
    ? (BENCHMARK_EFFORT_LADDER as readonly string[]).indexOf(effort)
    : -1;

export interface IntegrationMetrics {
  readonly applied: number;
  readonly completed: number;
  readonly conflicts: number;
  readonly partial: number;
  readonly failed: number;
  readonly notAttempted: number;
  readonly disabled: number;
}

export interface VerificationMetrics {
  readonly passed: number;
  readonly failed: number;
  readonly refused: number;
}

export interface OrchestrationMetrics {
  /** `delegate_task` and `delegate_tasks` calls that actually opened a batch. */
  readonly delegationCalls: number;
  readonly batchesByMode: Readonly<Record<string, number>>;
  readonly explorations: number;
  readonly explorationsRejected: number;
  readonly attemptsStarted: number;
  readonly attemptsCompleted: number;
  readonly attemptsByRole: Readonly<Record<string, number>>;
  readonly attemptsByTermination: Readonly<Record<string, number>>;
  /** Attempts whose provider usage never arrived; their credits stay unknown. */
  readonly usageUnavailableAttempts: number;
  /**
   * Attempts that ended abnormally or left a failing verification behind.
   * Diagnostic: an attempt can be wasted work and still be correctly bounded.
   */
  readonly wastedAttempts: number;
  readonly repairsStarted: number;
  readonly repairsCompleted: number;
  readonly recoveriesStarted: number;
  readonly recoveriesSkipped: number;
  readonly recoveriesCompleted: number;
  readonly continuations: number;
  readonly processRetries: number;
  /** Attempts that resumed a predecessor at a higher effort or another model. */
  readonly effortEscalations: number;
  readonly executorChanges: number;
  readonly routingPreflights: number;
  readonly routingDeclarationsAttached: number;
  readonly routingDeclarationsAbsent: number;
  readonly routingContradictions: number;
  readonly scopeConflicts: number;
  readonly worktreesCreated: number;
  readonly worktreesRetained: number;
  readonly workerTimeouts: number;
  readonly workerCancellations: number;
  readonly integration: IntegrationMetrics;
  /** Null when no integration verification ran in this run. */
  readonly integrationVerification: VerificationMetrics | null;
}

export interface ContextMetrics {
  readonly evaluations: number;
  readonly triggers: number;
  readonly blocks: number;
  readonly noops: number;
  readonly compactions: number;
  readonly maxTotalSizeBytes: number | null;
  readonly maxTotalTurns: number | null;
  readonly lastTotalSizeBytes: number | null;
  readonly reclaimedBytes: number | null;
  readonly compactionBoundaries: readonly string[];
}

export const EMPTY_ORCHESTRATION_METRICS: OrchestrationMetrics = Object.freeze({
  delegationCalls: 0,
  batchesByMode: Object.freeze({}),
  explorations: 0,
  explorationsRejected: 0,
  attemptsStarted: 0,
  attemptsCompleted: 0,
  attemptsByRole: Object.freeze({}),
  attemptsByTermination: Object.freeze({}),
  usageUnavailableAttempts: 0,
  wastedAttempts: 0,
  repairsStarted: 0,
  repairsCompleted: 0,
  recoveriesStarted: 0,
  recoveriesSkipped: 0,
  recoveriesCompleted: 0,
  continuations: 0,
  processRetries: 0,
  effortEscalations: 0,
  executorChanges: 0,
  routingPreflights: 0,
  routingDeclarationsAttached: 0,
  routingDeclarationsAbsent: 0,
  routingContradictions: 0,
  scopeConflicts: 0,
  worktreesCreated: 0,
  worktreesRetained: 0,
  workerTimeouts: 0,
  workerCancellations: 0,
  integration: Object.freeze({
    applied: 0,
    completed: 0,
    conflicts: 0,
    partial: 0,
    failed: 0,
    notAttempted: 0,
    disabled: 0,
  }),
  integrationVerification: null,
});

export const EMPTY_CONTEXT_METRICS: ContextMetrics = Object.freeze({
  evaluations: 0,
  triggers: 0,
  blocks: 0,
  noops: 0,
  compactions: 0,
  maxTotalSizeBytes: null,
  maxTotalTurns: null,
  lastTotalSizeBytes: null,
  reclaimedBytes: null,
  compactionBoundaries: Object.freeze([]),
});

type Event = Readonly<Record<string, unknown>>;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const whole = (value: unknown): number => finite(value) ?? 0;

const bump = (counts: Record<string, number>, key: unknown): void => {
  if (typeof key !== "string" || key === "") return;
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Fold one run's events into orchestration counts. */
export function foldOrchestrationMetrics(events: readonly Event[]): OrchestrationMetrics {
  const batchesByMode: Record<string, number> = {};
  const attemptsByRole: Record<string, number> = {};
  const attemptsByTermination: Record<string, number> = {};
  /** executionId -> the model and effort that execution requested. */
  const attemptCompute = new Map<string, { model: unknown; effort: unknown }>();

  let delegationCalls = 0;
  let explorations = 0;
  let explorationsRejected = 0;
  let attemptsStarted = 0;
  let attemptsCompleted = 0;
  let usageUnavailableAttempts = 0;
  let wastedAttempts = 0;
  let repairsStarted = 0;
  let repairsCompleted = 0;
  let recoveriesStarted = 0;
  let recoveriesSkipped = 0;
  let recoveriesCompleted = 0;
  let continuations = 0;
  let processRetries = 0;
  let effortEscalations = 0;
  let executorChanges = 0;
  let routingPreflights = 0;
  let routingDeclarationsAttached = 0;
  let routingDeclarationsAbsent = 0;
  let routingContradictions = 0;
  let scopeConflicts = 0;
  let worktreesCreated = 0;
  let worktreesRetained = 0;
  let workerTimeouts = 0;
  let workerCancellations = 0;
  let applied = 0;
  let integrationCompleted = 0;
  let conflicts = 0;
  let partial = 0;
  let integrationFailed = 0;
  let notAttempted = 0;
  let disabled = 0;
  let verificationSeen = false;
  let verificationPassed = 0;
  let verificationFailed = 0;
  let verificationRefused = 0;

  // Lineage first: an escalation is only visible once its predecessor is known,
  // and events are appended in start order, so one forward pass records every
  // predecessor before any successor needs it.
  for (const event of events) {
    if (event.type !== "attempt.started") continue;
    if (typeof event.executionId === "string") {
      attemptCompute.set(event.executionId, {
        model: event.model,
        effort: event.effort,
      });
    }
  }

  for (const event of events) {
    switch (event.type) {
      case "batch.started":
        delegationCalls += 1;
        bump(batchesByMode, event.mode);
        break;
      case "explore.started":
        explorations += 1;
        break;
      case "explore.rejected":
        explorationsRejected += 1;
        break;
      case "attempt.started": {
        attemptsStarted += 1;
        const predecessor =
          typeof event.predecessorExecutionId === "string"
            ? attemptCompute.get(event.predecessorExecutionId)
            : undefined;
        if (predecessor) {
          const from = effortRank(predecessor.effort);
          const to = effortRank(event.effort);
          if (from >= 0 && to > from) effortEscalations += 1;
          if (
            typeof predecessor.model === "string" &&
            typeof event.model === "string" &&
            predecessor.model !== event.model
          ) {
            executorChanges += 1;
          }
        }
        break;
      }
      case "attempt.completed": {
        attemptsCompleted += 1;
        bump(attemptsByRole, event.role);
        bump(attemptsByTermination, event.termination);
        if (event.usageStatus === "unavailable") usageUnavailableAttempts += 1;
        if (event.role === "manual-continuation") continuations += 1;
        if (event.role === "process-retry") processRetries += 1;
        if (event.termination !== "completed" || whole(event.verificationFailed) > 0) {
          wastedAttempts += 1;
        }
        break;
      }
      case "repair.started":
        repairsStarted += 1;
        break;
      case "repair.completed":
        repairsCompleted += 1;
        break;
      case "recovery.started":
        recoveriesStarted += 1;
        break;
      case "recovery.skipped":
        recoveriesSkipped += 1;
        break;
      case "recovery.completed":
        recoveriesCompleted += 1;
        break;
      case "routing.preflight":
        routingPreflights += 1;
        break;
      case "routing.declared":
        if (event.declaration === "absent") routingDeclarationsAbsent += 1;
        else routingDeclarationsAttached += 1;
        break;
      case "routing.contradiction":
        routingContradictions += 1;
        break;
      case "scope.conflict":
        scopeConflicts += 1;
        break;
      case "worktree.created":
        worktreesCreated += 1;
        break;
      case "worktree.retained":
        worktreesRetained += 1;
        break;
      case "worker.timedOut":
        workerTimeouts += 1;
        break;
      case "worker.cancelled":
        workerCancellations += 1;
        break;
      case "integration.applied":
        applied += 1;
        break;
      case "integration.completed":
        integrationCompleted += 1;
        break;
      case "integration.conflict":
        conflicts += 1;
        break;
      case "integration.partial":
        partial += 1;
        break;
      case "integration.failed":
        integrationFailed += 1;
        break;
      case "integration.notAttempted":
        notAttempted += 1;
        break;
      case "integration.disabled":
        disabled += 1;
        break;
      case "integration.verification.completed":
        verificationSeen = true;
        verificationPassed += whole(event.passed);
        verificationFailed += whole(event.failed);
        verificationRefused += whole(event.refused);
        break;
      default:
        break;
    }
  }

  return {
    delegationCalls,
    batchesByMode,
    explorations,
    explorationsRejected,
    attemptsStarted,
    attemptsCompleted,
    attemptsByRole,
    attemptsByTermination,
    usageUnavailableAttempts,
    wastedAttempts,
    repairsStarted,
    repairsCompleted,
    recoveriesStarted,
    recoveriesSkipped,
    recoveriesCompleted,
    continuations,
    processRetries,
    effortEscalations,
    executorChanges,
    routingPreflights,
    routingDeclarationsAttached,
    routingDeclarationsAbsent,
    routingContradictions,
    scopeConflicts,
    worktreesCreated,
    worktreesRetained,
    workerTimeouts,
    workerCancellations,
    integration: {
      applied,
      completed: integrationCompleted,
      conflicts,
      partial,
      failed: integrationFailed,
      notAttempted,
      disabled,
    },
    integrationVerification: verificationSeen
      ? {
          passed: verificationPassed,
          failed: verificationFailed,
          refused: verificationRefused,
        }
      : null,
  };
}

/** Fold one run's context lifecycle events into size and compaction counts. */
export function foldContextMetrics(events: readonly Event[]): ContextMetrics {
  let evaluations = 0;
  let triggers = 0;
  let blocks = 0;
  let noops = 0;
  let compactions = 0;
  let maxTotalSizeBytes: number | null = null;
  let maxTotalTurns: number | null = null;
  let lastTotalSizeBytes: number | null = null;
  let reclaimedBytes: number | null = null;
  const compactionBoundaries: string[] = [];

  for (const event of events) {
    if (event.type === "context.evaluated") {
      evaluations += 1;
      if (event.decision === "trigger") triggers += 1;
      else if (event.decision === "block") blocks += 1;
      else if (event.decision === "noop") noops += 1;
      const size = finite(event.totalSizeBytes);
      if (size !== null) {
        lastTotalSizeBytes = size;
        maxTotalSizeBytes = Math.max(maxTotalSizeBytes ?? size, size);
      }
      const turns = finite(event.totalTurns);
      if (turns !== null) maxTotalTurns = Math.max(maxTotalTurns ?? turns, turns);
    } else if (event.type === "context.compacted") {
      compactions += 1;
      if (typeof event.boundary === "string") compactionBoundaries.push(event.boundary);
      const delta = finite(event.sizeDeltaBytes);
      if (delta !== null) reclaimedBytes = (reclaimedBytes ?? 0) + Math.abs(delta);
    }
  }

  return {
    evaluations,
    triggers,
    blocks,
    noops,
    compactions,
    maxTotalSizeBytes,
    maxTotalTurns,
    lastTotalSizeBytes,
    reclaimedBytes,
    compactionBoundaries,
  };
}
