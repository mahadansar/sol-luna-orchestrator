// P1.3A deterministic context-retention and compaction core.
// Callers retain the authoritative OrchestrationContext. Compaction returns a
// redacted, decision-safe projection and never mutates canonical evidence.
import type {
  AttemptEvidence,
  AttemptRole,
  AttemptTermination,
  BatchOutput,
  ChangeIntent,
  ContinuationState,
  DelegateTaskInput,
  DelegateTaskOutput,
  DelegateTasksInput,
  FailureAction,
  FailureClassification,
  FailureDecision,
  HandoffState,
  RecoveryClassification,
  RepairClassification,
  RoutingPreflightInput,
  Status,
  TaskCategory,
  WorkerFailureCause,
} from "./contract.js";
import {
  CONTEXT_COOLDOWN_TURNS,
  CONTEXT_MAX_BYTES,
  CONTEXT_MAX_CLEAN_TURNS,
  CONTEXT_MAX_TURNS,
  DEFAULT_CONTEXT_MAX_TOOL_OVERHEAD_BYTES,
  DEFAULT_CONTEXT_MAX_TOOL_OVERHEAD_TURNS,
  DEFAULT_CONTEXT_MIN_RECLAIMABLE_BYTES,
  DEFAULT_CONTEXT_RECLAIMABLE_RATIO_THRESHOLD,
} from "./config.js";

// Soft target for stale successful history. Protected turns may exceed it.
export const MAX_RETAINED_TURNS = 100;

const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|token|secret|password|passwd|credential)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_HEADER = /\bBearer\s+([A-Za-z0-9_.-]{8,})/gi;
const PREFIXED_SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9_-]{10,})\b/g;

// Redact compact-presentation secrets without changing unrelated prose.
export function scrubSensitiveText(text: string): { scrubbed: string; count: number } {
  if (!text) return { scrubbed: "", count: 0 };
  let count = 0;
  let scrubbed = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, () => {
    count++;
    return " ";
  });
  scrubbed = scrubbed.replace(
    SECRET_ASSIGNMENT,
    (_match, name: string, separator: string, value: string) => {
      count++;
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      return quote
        ? `${name}${separator}${quote}[REDACTED_SECRET]${quote}`
        : `${name}${separator}[REDACTED_SECRET]`;
    },
  );
  scrubbed = scrubbed.replace(BEARER_HEADER, () => {
    count++;
    return "Bearer [REDACTED_TOKEN]";
  });
  scrubbed = scrubbed.replace(PREFIXED_SECRET, () => {
    count++;
    return "[REDACTED_TOKEN]";
  });
  return { scrubbed, count };
}

export interface ContextDecision {
  readonly id: string;
  readonly kind: "architectural" | "user" | "policy" | "invariant";
  readonly summary: string;
  readonly details?: string;
  readonly settledAt?: string;
  readonly source?: string;
}

export interface ContextConstraint {
  readonly id: string;
  readonly kind: "scope" | "verification" | "policy" | "environment" | "contract";
  readonly description: string;
  readonly active: boolean;
}

export interface ContextBlocker {
  readonly id: string;
  readonly kind:
    | "worker-blocked"
    | "scope-violation"
    | "discrepancy"
    | "scope-conflict"
    | "integration-conflict"
    | "verification-failure"
    | "runtime-error"
    | "unmet-requirement"
    | "unclassified";
  readonly description: string;
  readonly resolved: boolean;
  readonly taskId?: string;
  readonly executionId?: string;
  readonly failureClassification?: FailureClassification;
}

// Immutable, per-execution lineage used by retry/escalation/handoff policy.
export interface ContextLineageEntry {
  readonly executionId: string;
  readonly logicalAttempt: number;
  readonly role: AttemptRole;
  readonly predecessorExecutionId: string | null;
  readonly model: string;
  readonly effort: string;
  readonly threadOperation?: string;
  readonly threadIdentityMatched?: boolean | null;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly elapsedMs?: number;
  readonly workerElapsedMs?: number | null;
  readonly verificationElapsedMs?: number | null;
  readonly timeoutMs?: number;
  readonly terminationKind?: AttemptTermination;
  readonly terminationMessage?: string | null;
  readonly workerClaimedStatus?: Status | null;
  readonly workerClaimedFailureCauses?: readonly WorkerFailureCause[];
  readonly usage?: unknown;
  readonly verification?: AttemptEvidence["verification"];
  readonly verdict?: Status;
  readonly failureDecision?: FailureDecision;
}

export type ContextTurnKind =
  | "single-delegation"
  | "batch-delegation"
  | "continuation"
  | "routing-preflight"
  | "status-narration"
  | "tool-prose";

export interface BaseContextTurn {
  readonly id: string;
  readonly turnNumber: number;
  readonly timestamp?: string;
  readonly kind: ContextTurnKind;
}

export interface SingleDelegationTurn extends BaseContextTurn {
  readonly kind: "single-delegation";
  readonly input: DelegateTaskInput;
  readonly output: DelegateTaskOutput;
  readonly taskId?: string;
}

export interface BatchDelegationTurn extends BaseContextTurn {
  readonly kind: "batch-delegation";
  readonly input: DelegateTasksInput;
  readonly output: BatchOutput;
}

export interface ContinuationTurn extends BaseContextTurn {
  readonly kind: "continuation";
  readonly continuationReference: string;
  readonly instruction: string;
  readonly output: DelegateTaskOutput;
  readonly taskId?: string;
}

export interface RoutingPreflightTurn extends BaseContextTurn {
  readonly kind: "routing-preflight";
  readonly card: RoutingPreflightInput;
  readonly route?: string;
  readonly signals?: readonly string[];
}

export interface StatusNarrationTurn extends BaseContextTurn {
  readonly kind: "status-narration";
  readonly text: string;
  readonly phase?: "waiting" | "polling" | "progress" | "info";
}

export interface ToolProseTurn extends BaseContextTurn {
  readonly kind: "tool-prose";
  readonly toolName: string;
  readonly prose: string;
}

export type ContextTurn =
  | SingleDelegationTurn
  | BatchDelegationTurn
  | ContinuationTurn
  | RoutingPreflightTurn
  | StatusNarrationTurn
  | ToolProseTurn;

export interface OrchestrationContext {
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly allowedFiles: readonly string[];
  readonly forbiddenFiles: readonly string[];
  readonly changeIntent: ChangeIntent;
  readonly taskCategory?: TaskCategory;
  readonly decisions: readonly ContextDecision[];
  readonly constraints: readonly ContextConstraint[];
  readonly blockers: readonly ContextBlocker[];
  readonly lineage: readonly ContextLineageEntry[];
  readonly turns: readonly ContextTurn[];
  /** Latest authoritative turn included in a compact projection, when any. */
  readonly lastCompactedTurnNumber?: number;
}

export interface CompactedVerificationItem {
  readonly command: string;
  readonly source: "orchestrator" | "worker";
  readonly execution: string;
  readonly exitCode: number | null;
  readonly passed: boolean;
  readonly output: string;
  readonly outputDisposition: "retained" | "omitted-clean-pass";
}

export interface VerificationCounts {
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly refused: number;
}

export type CompactedTaskContract = Omit<DelegateTaskInput, "handoffReference">;
export type CompactedBatchPolicy = Omit<DelegateTasksInput, "tasks">;

export interface CompactedBatchTask {
  readonly taskId: string;
  readonly state: string;
  readonly verdict: Status;
  readonly contract: CompactedTaskContract;
  readonly executionIds: readonly string[];
  readonly workerClaim: {
    readonly status: Status;
    readonly failureCauses: readonly WorkerFailureCause[];
    readonly summary?: string;
  };
  readonly failureDecision?: FailureDecision;
  readonly repair?: NonNullable<CompactedTurn["repair"]>;
  readonly recovery?: NonNullable<CompactedTurn["recovery"]>;
  readonly filesChanged: CompactedTurn["filesChanged"];
  readonly authoritativeVerification: VerificationCounts;
  readonly verificationDetails: readonly CompactedVerificationItem[];
  readonly scopeViolations: readonly string[];
  readonly discrepancies: readonly string[];
  readonly errors: readonly string[];
  readonly risks: readonly string[];
}

export interface CompactedTurn {
  readonly id: string;
  readonly turnNumber: number;
  readonly kind:
    "single-delegation" | "batch-delegation" | "continuation" | "routing-preflight";
  readonly verdict: Status | "NEEDS_SUPERVISOR" | "NOT_EXECUTED";
  readonly isClean: boolean;
  readonly taskId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly attempt?: number;
  readonly executionIds: readonly string[];
  readonly durationSeconds?: number;
  readonly changeIntent?: ChangeIntent;
  readonly contract?: CompactedTaskContract;
  readonly batchPolicy?: CompactedBatchPolicy;
  readonly batchOutcome?: {
    readonly completionState: BatchOutput["completionState"];
    readonly integrated: boolean;
    readonly integrationSummary: string;
    readonly taskCount: number;
    readonly passed: number;
    readonly failed: number;
  };
  readonly routing?: {
    readonly card: RoutingPreflightInput;
    readonly route?: string;
    readonly signals: readonly string[];
  };
  readonly filesChanged: readonly {
    readonly path: string;
    readonly kind: string;
    readonly observed: boolean;
    readonly why?: string;
  }[];
  readonly authoritativeVerification: VerificationCounts;
  readonly verificationDetails: readonly CompactedVerificationItem[];
  readonly workerClaim?: {
    readonly status: Status;
    readonly failureCauses: readonly WorkerFailureCause[];
    readonly summary?: string;
  };
  readonly failureDecision?: FailureDecision;
  readonly batchTasks?: readonly CompactedBatchTask[];
  readonly repair?: {
    readonly attempted: boolean;
    readonly classification: RepairClassification;
    readonly reason: string;
    readonly failureEvidence: readonly {
      readonly command: string;
      readonly exitCode: number | null;
      readonly output: string;
    }[];
  };
  readonly recovery?: {
    readonly attempted: boolean;
    readonly classification: RecoveryClassification;
    readonly evidence: string;
    readonly recoveryAttempt: number | null;
  };
  readonly scopeViolations: readonly string[];
  readonly discrepancies: readonly string[];
  readonly conflicts: readonly {
    readonly type: "scope" | "integration";
    readonly details: string;
  }[];
  readonly errors: readonly string[];
  readonly risks: readonly string[];
}

export interface CompactedHandoffRef {
  readonly reference: string;
  readonly status: HandoffState;
  readonly availabilityBasis: "recorded-issued-unconsumed";
  readonly reason: string;
  readonly action?: FailureAction;
}

export interface CompactedContinuationRef {
  readonly reference: string;
  readonly status: ContinuationState;
  readonly availabilityBasis: "recorded-issued-unconsumed";
  readonly reason: string;
}

export type CompactedLineageEntry = Omit<ContextLineageEntry, "verification"> & {
  readonly verification?: readonly CompactedVerificationItem[];
};

export interface CompactionStats {
  readonly originalSizeBytes: number;
  readonly compactedSizeBytes: number;
  readonly sizeDeltaBytes: number;
  readonly reductionRatio: number;
  readonly discardedNarrationTurns: number;
  readonly discardedToolProseTurns: number;
  readonly compactedCleanTurns: number;
  readonly retainedDiagnosticTurns: number;
  readonly omittedCleanTurns: number;
  readonly omittedCleanSummaries: number;
  readonly scrubbedValuesCount: number;
  readonly retainedDecisionsCount: number;
  readonly retainedConstraintsCount: number;
  readonly retainedBlockersCount: number;
  readonly retainedLineageCount: number;
  readonly requestedTurnLimit: number;
  readonly protectedTurnsOverLimit: boolean;
  readonly rulesApplied: readonly string[];
}

export interface CompactedContext {
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly allowedFiles: readonly string[];
  readonly forbiddenFiles: readonly string[];
  readonly changeIntent: ChangeIntent;
  readonly taskCategory?: TaskCategory;
  readonly decisions: readonly ContextDecision[];
  readonly constraints: readonly ContextConstraint[];
  readonly blockers: readonly ContextBlocker[];
  readonly lineage: readonly CompactedLineageEntry[];
  readonly turns: readonly CompactedTurn[];
  readonly activeHandoffs: readonly CompactedHandoffRef[];
  readonly activeContinuations: readonly CompactedContinuationRef[];
  readonly lastCompactedTurnNumber: number;
  readonly stats: CompactionStats;
}

export function createOrchestrationContext(params: {
  objective: string;
  acceptanceCriteria: string[];
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  changeIntent?: ChangeIntent;
  taskCategory?: TaskCategory;
  decisions?: ContextDecision[];
  constraints?: ContextConstraint[];
  blockers?: ContextBlocker[];
  lineage?: ContextLineageEntry[];
  turns?: ContextTurn[];
}): OrchestrationContext {
  return {
    objective: params.objective,
    acceptanceCriteria: [...params.acceptanceCriteria],
    allowedFiles: [...(params.allowedFiles ?? [])],
    forbiddenFiles: [...(params.forbiddenFiles ?? [])],
    changeIntent: params.changeIntent ?? "required",
    taskCategory: params.taskCategory,
    decisions: params.decisions ? structuredClone(params.decisions) : [],
    constraints: params.constraints ? structuredClone(params.constraints) : [],
    blockers: params.blockers ? structuredClone(params.blockers) : [],
    lineage: params.lineage ? structuredClone(params.lineage) : [],
    turns: params.turns ? structuredClone(params.turns) : [],
  };
}

export function recordDecision(
  context: OrchestrationContext,
  decision: Omit<ContextDecision, "id"> & { id?: string },
): OrchestrationContext {
  return {
    ...context,
    decisions: [
      ...context.decisions,
      { ...decision, id: decision.id ?? `dec_${context.decisions.length + 1}` },
    ],
  };
}

export function recordConstraint(
  context: OrchestrationContext,
  constraint: Omit<ContextConstraint, "id"> & { id?: string },
): OrchestrationContext {
  return {
    ...context,
    constraints: [
      ...context.constraints,
      { ...constraint, id: constraint.id ?? `cst_${context.constraints.length + 1}` },
    ],
  };
}

export function recordBlocker(
  context: OrchestrationContext,
  blocker: Omit<ContextBlocker, "id"> & { id?: string },
): OrchestrationContext {
  return {
    ...context,
    blockers: [
      ...context.blockers,
      { ...blocker, id: blocker.id ?? `blk_${context.blockers.length + 1}` },
    ],
  };
}

export function resolveBlocker(
  context: OrchestrationContext,
  blockerId: string,
): OrchestrationContext {
  return {
    ...context,
    blockers: context.blockers.map((blocker) =>
      blocker.id === blockerId ? { ...blocker, resolved: true } : blocker,
    ),
  };
}

function lineageFromOutput(output: DelegateTaskOutput): ContextLineageEntry[] {
  return (output.attempts ?? []).map((attempt) =>
    lineageFromAttempt(attempt, output.verdict, output.failureDecision),
  );
}

function lineageFromAttempt(
  attempt: AttemptEvidence,
  verdict: Status,
  failureDecision?: FailureDecision,
): ContextLineageEntry {
  return {
    executionId: attempt.executionId,
    logicalAttempt: attempt.logicalAttempt,
    role: attempt.role,
    predecessorExecutionId: attempt.predecessorExecutionId,
    model: attempt.requestedModel,
    effort: attempt.requestedEffort,
    threadOperation: attempt.threadOperation,
    threadIdentityMatched: attempt.threadIdentityMatched,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    elapsedMs: attempt.elapsedMs,
    workerElapsedMs: attempt.workerElapsedMs,
    verificationElapsedMs: attempt.verificationElapsedMs,
    timeoutMs: attempt.timeoutMs,
    terminationKind: attempt.termination.kind,
    terminationMessage: attempt.termination.message,
    workerClaimedStatus: attempt.workerClaimedStatus,
    workerClaimedFailureCauses: [...(attempt.workerClaimedFailureCauses ?? [])],
    usage: structuredClone(attempt.usage),
    verification: structuredClone(attempt.verification),
    verdict,
    failureDecision: failureDecision ? structuredClone(failureDecision) : undefined,
  };
}

function assertUniqueTurnId(context: OrchestrationContext, id: string): void {
  if (context.turns.some((turn) => turn.id === id)) {
    throw new Error(`Context turn id already exists: ${id}`);
  }
}

function appendNewLineage(
  existing: readonly ContextLineageEntry[],
  additions: readonly ContextLineageEntry[],
): ContextLineageEntry[] {
  const result = structuredClone(existing) as ContextLineageEntry[];
  for (const entry of additions) {
    const prior = result.find((candidate) => candidate.executionId === entry.executionId);
    if (!prior) {
      result.push(structuredClone(entry));
    } else if (JSON.stringify(prior) !== JSON.stringify(entry)) {
      throw new Error(`Conflicting lineage evidence for execution ${entry.executionId}`);
    }
  }
  return result;
}

function blockersFromOutput(
  output: DelegateTaskOutput,
  id: string,
  taskId: string,
): ContextBlocker[] {
  if (output.verdict === "PASS") return [];
  const description =
    output.failureDecision?.reason ??
    output.discrepancies[0] ??
    output.scopeViolations[0] ??
    output.errors[0] ??
    `Task returned ${output.verdict}`;
  return [
    {
      id: `blk_turn_${id}`,
      kind:
        output.scopeViolations.length > 0
          ? "scope-violation"
          : output.discrepancies.length > 0
            ? "discrepancy"
            : output.errors.length > 0
              ? "runtime-error"
              : "verification-failure",
      description,
      resolved: false,
      taskId,
      failureClassification: output.failureDecision?.classification,
    },
  ];
}

export function ingestDelegationTurn(
  context: OrchestrationContext,
  turn: {
    input: DelegateTaskInput;
    output: DelegateTaskOutput;
    taskId?: string;
    id?: string;
    timestamp?: string;
  },
): OrchestrationContext {
  const id = turn.id ?? `turn_${context.turns.length + 1}`;
  assertUniqueTurnId(context, id);
  const taskId = turn.taskId ?? "t1";
  const capsule = turn.input.contextCapsule;
  const decisions = [...context.decisions];
  if (capsule?.upstreamDecisions) {
    decisions.push({
      id: `dec_cap_${decisions.length + 1}`,
      kind: "architectural",
      summary: capsule.upstreamDecisions,
      source: "context-capsule",
    });
  }
  if (capsule?.invariants) {
    decisions.push({
      id: `inv_cap_${decisions.length + 1}`,
      kind: "invariant",
      summary: capsule.invariants,
      source: "context-capsule",
    });
  }
  const blockers = [...context.blockers];
  for (const blocker of blockersFromOutput(turn.output, id, taskId)) {
    if (!blockers.some((candidate) => candidate.id === blocker.id))
      blockers.push(blocker);
  }
  return {
    ...context,
    decisions,
    blockers,
    lineage: appendNewLineage(context.lineage, lineageFromOutput(turn.output)),
    turns: [
      ...context.turns,
      {
        id,
        turnNumber: context.turns.length + 1,
        timestamp: turn.timestamp,
        kind: "single-delegation",
        input: structuredClone(turn.input),
        output: structuredClone(turn.output),
        taskId,
      },
    ],
  };
}

export function ingestBatchTurn(
  context: OrchestrationContext,
  turn: {
    input: DelegateTasksInput;
    output: BatchOutput;
    id?: string;
    timestamp?: string;
  },
): OrchestrationContext {
  const id = turn.id ?? `batch_turn_${context.turns.length + 1}`;
  assertUniqueTurnId(context, id);
  const additions = turn.output.tasks.flatMap((task) => {
    const attempts = task.attempts ?? task.result?.attempts ?? [];
    const verdict = task.result?.verdict ?? "FAILED";
    const decision = task.failureDecision ?? task.result?.failureDecision;
    return attempts.map((attempt) => lineageFromAttempt(attempt, verdict, decision));
  });
  const blockers = [...context.blockers];
  for (const task of turn.output.tasks) {
    if (!task.result) continue;
    for (const blocker of blockersFromOutput(
      task.result,
      `${id}_${task.taskId}`,
      task.taskId,
    )) {
      if (!blockers.some((candidate) => candidate.id === blocker.id))
        blockers.push(blocker);
    }
  }
  for (const conflict of turn.output.integrationConflicts) {
    const blocker: ContextBlocker = {
      id: `blk_int_${id}_${conflict.path}`,
      kind: "integration-conflict",
      description: `Integration conflict in ${conflict.path} across tasks: ${conflict.tasks.join(", ")}`,
      resolved: false,
    };
    if (!blockers.some((candidate) => candidate.id === blocker.id))
      blockers.push(blocker);
  }
  return {
    ...context,
    blockers,
    lineage: appendNewLineage(context.lineage, additions),
    turns: [
      ...context.turns,
      {
        id,
        turnNumber: context.turns.length + 1,
        timestamp: turn.timestamp,
        kind: "batch-delegation",
        input: structuredClone(turn.input),
        output: structuredClone(turn.output),
      },
    ],
  };
}

export function ingestContinuationTurn(
  context: OrchestrationContext,
  turn: {
    continuationReference: string;
    instruction: string;
    output: DelegateTaskOutput;
    taskId?: string;
    id?: string;
    timestamp?: string;
  },
): OrchestrationContext {
  const id = turn.id ?? `ctr_turn_${context.turns.length + 1}`;
  assertUniqueTurnId(context, id);
  const blockers = [...context.blockers];
  for (const blocker of blockersFromOutput(turn.output, id, turn.taskId ?? "t1")) {
    if (!blockers.some((candidate) => candidate.id === blocker.id))
      blockers.push(blocker);
  }
  return {
    ...context,
    blockers,
    lineage: appendNewLineage(context.lineage, lineageFromOutput(turn.output)),
    turns: [
      ...context.turns,
      {
        id,
        turnNumber: context.turns.length + 1,
        timestamp: turn.timestamp,
        kind: "continuation",
        continuationReference: turn.continuationReference,
        instruction: turn.instruction,
        output: structuredClone(turn.output),
        taskId: turn.taskId ?? "t1",
      },
    ],
  };
}

export function ingestRoutingPreflightTurn(
  context: OrchestrationContext,
  turn: {
    card: RoutingPreflightInput;
    route?: string;
    signals?: readonly string[];
    id?: string;
    timestamp?: string;
  },
): OrchestrationContext {
  const id = turn.id ?? `route_turn_${context.turns.length + 1}`;
  assertUniqueTurnId(context, id);
  return {
    ...context,
    turns: [
      ...context.turns,
      {
        id,
        turnNumber: context.turns.length + 1,
        timestamp: turn.timestamp,
        kind: "routing-preflight",
        card: structuredClone(turn.card),
        route: turn.route,
        signals: turn.signals ? [...turn.signals] : undefined,
      },
    ],
  };
}

export function ingestStatusNarrationTurn(
  context: OrchestrationContext,
  text: string,
  phase: "waiting" | "polling" | "progress" | "info" = "progress",
  timestamp?: string,
): OrchestrationContext {
  const id = `narr_${context.turns.length + 1}`;
  assertUniqueTurnId(context, id);
  return {
    ...context,
    turns: [
      ...context.turns,
      {
        id,
        turnNumber: context.turns.length + 1,
        timestamp,
        kind: "status-narration",
        text,
        phase,
      },
    ],
  };
}

export function ingestToolProseTurn(
  context: OrchestrationContext,
  toolName: string,
  prose: string,
  timestamp?: string,
): OrchestrationContext {
  const id = `tool_${context.turns.length + 1}`;
  assertUniqueTurnId(context, id);
  return {
    ...context,
    turns: [
      ...context.turns,
      {
        id,
        turnNumber: context.turns.length + 1,
        timestamp,
        kind: "tool-prose",
        toolName,
        prose,
      },
    ],
  };
}

export function isCleanPassResult(result: DelegateTaskOutput): boolean {
  const authoritative = result.verification.filter(
    (run) => run.source === "orchestrator",
  );
  return (
    result.verdict === "PASS" &&
    result.workerClaimedStatus === "PASS" &&
    result.trustworthy &&
    result.scopeViolations.length === 0 &&
    result.discrepancies.length === 0 &&
    result.errors.length === 0 &&
    result.filesChanged.every((file) => file.observed) &&
    !result.repair?.attempted &&
    !result.recovery?.attempted &&
    !result.failureDecision &&
    result.followUps.length === 0 &&
    result.reviewChecklist.length === 0 &&
    authoritative.length > 0 &&
    authoritative.every(
      (run) => (run.execution === "argv" || run.execution === "shell") && run.passed,
    )
  );
}

export function isCleanBatchResult(batch: BatchOutput): boolean {
  return (
    batch.completionState === "verified-complete" &&
    batch.passed === batch.taskCount &&
    batch.failed === 0 &&
    batch.integrationConflicts.length === 0 &&
    batch.scopeConflicts.length === 0 &&
    batch.warnings.length === 0 &&
    batch.reviewChecklist.length === 0 &&
    batch.integrated &&
    batch.integrationVerification.length > 0 &&
    batch.integrationVerification.every(
      (run) => (run.execution === "argv" || run.execution === "shell") && run.passed,
    ) &&
    batch.tasks.every(
      (task) =>
        task.state === "completed" &&
        task.error === null &&
        task.warnings.length === 0 &&
        task.result !== null &&
        isCleanPassResult(task.result),
    )
  );
}

export interface CompactContextOptions {
  // Soft target. Protected evidence is retained even when this is exceeded.
  readonly maxTurnsCount?: number;
}

function redact(text: string, stats: { count: number }): string {
  const result = scrubSensitiveText(text);
  stats.count += result.count;
  return result.scrubbed;
}

function compactFailureDecision(
  decision: FailureDecision | undefined,
  redactions: { count: number },
): FailureDecision | undefined {
  return decision
    ? { ...structuredClone(decision), reason: redact(decision.reason, redactions) }
    : undefined;
}

function redactUnknown(value: unknown, redactions: { count: number }): unknown {
  if (typeof value === "string") return redact(value, redactions);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, redactions));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactUnknown(item, redactions)]),
    );
  }
  return value;
}

function compactContract(
  input: DelegateTaskInput,
  redactions: { count: number },
): CompactedTaskContract {
  const { handoffReference: _capability, ...withoutCapability } = input;
  const compacted = redactUnknown(
    structuredClone(withoutCapability),
    redactions,
  ) as CompactedTaskContract;
  // Scope strings are executable semantics, so presentation redaction must not alter them.
  return {
    ...compacted,
    allowedFiles: [...input.allowedFiles],
    forbiddenFiles: [...input.forbiddenFiles],
    workingDirectory: input.workingDirectory,
  };
}

function compactVerification(
  runs: DelegateTaskOutput["verification"],
  clean: boolean,
  redactions: { count: number },
): CompactedVerificationItem[] {
  return runs.map((run) => ({
    command: redact(run.command, redactions),
    source: run.source,
    execution: run.execution,
    exitCode: run.exitCode,
    passed: run.passed,
    output: clean && run.passed ? "" : redact(run.output, redactions),
    outputDisposition: clean && run.passed ? "omitted-clean-pass" : "retained",
  }));
}

function verificationCounts(
  items: readonly CompactedVerificationItem[],
): VerificationCounts {
  const authoritative = items.filter((item) => item.source === "orchestrator");
  const executed = authoritative.filter(
    (item) => item.execution === "argv" || item.execution === "shell",
  );
  return {
    executed: executed.length,
    passed: executed.filter((item) => item.passed).length,
    failed: executed.filter((item) => !item.passed).length,
    refused: authoritative.filter(
      (item) => item.execution === "rejected" || item.execution === "skipped",
    ).length,
  };
}

function compactTaskOutput(
  output: DelegateTaskOutput,
  redactions: { count: number },
): Omit<
  CompactedTurn,
  "id" | "turnNumber" | "kind" | "taskId" | "conflicts" | "batchTasks"
> {
  const clean = isCleanPassResult(output);
  const details = compactVerification(output.verification, clean, redactions);
  const risks = [output.notes, ...output.followUps, ...output.reviewChecklist]
    .filter((value) => value.trim().length > 0)
    .map((value) => redact(value, redactions));
  return {
    verdict: output.verdict,
    isClean: clean,
    model: output.model,
    effort: output.effort,
    attempt: output.attempt,
    executionIds: (output.attempts ?? []).map((attempt) => attempt.executionId),
    durationSeconds: output.durationSeconds,
    changeIntent: output.changeIntent,
    filesChanged: output.filesChanged.map((file) => ({
      path: file.path,
      kind: file.kind,
      observed: file.observed,
      why: file.why ? redact(file.why, redactions) : undefined,
    })),
    authoritativeVerification: verificationCounts(details),
    verificationDetails: details,
    workerClaim: {
      status: output.workerClaimedStatus,
      failureCauses: [...(output.workerClaimedFailureCauses ?? [])],
      summary: clean ? undefined : redact(output.summary, redactions),
    },
    failureDecision: compactFailureDecision(output.failureDecision, redactions),
    repair: output.repair
      ? {
          attempted: output.repair.attempted,
          classification: output.repair.classification,
          reason: redact(output.repair.reason, redactions),
          failureEvidence: output.repair.failureEvidence.map((evidence) => ({
            command: redact(evidence.command, redactions),
            exitCode: evidence.exitCode,
            output: redact(evidence.output, redactions),
          })),
        }
      : undefined,
    recovery: output.recovery
      ? {
          attempted: output.recovery.attempted,
          classification: output.recovery.classification,
          evidence: redact(output.recovery.evidence, redactions),
          recoveryAttempt: output.recovery.recoveryAttempt,
        }
      : undefined,
    scopeViolations: output.scopeViolations.map((value) => redact(value, redactions)),
    discrepancies: output.discrepancies.map((value) => redact(value, redactions)),
    errors: output.errors.map((value) => redact(value, redactions)),
    risks,
  };
}

function emptyCounts(): VerificationCounts {
  return { executed: 0, passed: 0, failed: 0, refused: 0 };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isCompacted(
  value: OrchestrationContext | CompactedContext,
): value is CompactedContext {
  return "stats" in value && "activeHandoffs" in value && "activeContinuations" in value;
}

export function compactContext(
  context: OrchestrationContext | CompactedContext,
  options: CompactContextOptions = {},
): CompactedContext {
  // Structural idempotence: an existing compact projection is already canonical.
  if (isCompacted(context)) return structuredClone(context);
  const seenTurnIds = new Set<string>();
  for (const turn of context.turns) {
    if (seenTurnIds.has(turn.id)) {
      throw new Error(`Context turn id already exists: ${turn.id}`);
    }
    seenTurnIds.add(turn.id);
  }

  const redactions = { count: 0 };
  const rulesApplied: string[] = ["rule:preserve-authoritative-state"];
  let discardedNarrationTurns = 0;
  let discardedToolProseTurns = 0;
  let compactedCleanTurns = 0;
  let retainedDiagnosticTurns = 0;
  let omittedCleanSummaries = 0;
  const allTurns: CompactedTurn[] = [];
  const protectedTurnIds = new Set<string>();
  const handoffs = new Map<string, CompactedHandoffRef>();
  const continuations = new Map<string, CompactedContinuationRef>();
  let latestRoutingTurnId: string | undefined;

  for (const turn of context.turns) {
    if (turn.kind === "status-narration") {
      discardedNarrationTurns++;
      continue;
    }
    if (turn.kind === "tool-prose") {
      discardedToolProseTurns++;
      continue;
    }

    if (turn.kind === "single-delegation") {
      if (turn.input.handoffReference) handoffs.delete(turn.input.handoffReference);
    } else if (turn.kind === "batch-delegation") {
      for (const task of turn.input.tasks) {
        if (task.handoffReference) handoffs.delete(task.handoffReference);
      }
    } else if (turn.kind === "continuation") {
      continuations.delete(turn.continuationReference);
    }

    if (turn.kind === "single-delegation" || turn.kind === "continuation") {
      const output = turn.output;
      const compactedOutput = compactTaskOutput(output, redactions);
      if (compactedOutput.isClean) {
        compactedCleanTurns++;
        if (output.summary.trim()) omittedCleanSummaries++;
      } else {
        retainedDiagnosticTurns++;
        protectedTurnIds.add(turn.id);
      }
      if (output.handoffReference) {
        if (output.handoffState?.status === "issued") {
          handoffs.set(output.handoffReference, {
            reference: output.handoffReference,
            status: "issued",
            availabilityBasis: "recorded-issued-unconsumed",
            reason: redact(output.handoffState.reason, redactions),
            action: output.failureDecision?.action,
          });
          protectedTurnIds.add(turn.id);
        } else {
          handoffs.delete(output.handoffReference);
        }
      }
      if (output.continuationReference) {
        if (output.continuationState?.status === "issued") {
          continuations.set(output.continuationReference, {
            reference: output.continuationReference,
            status: "issued",
            availabilityBasis: "recorded-issued-unconsumed",
            reason: redact(output.continuationState.reason, redactions),
          });
          protectedTurnIds.add(turn.id);
        } else {
          continuations.delete(output.continuationReference);
        }
      }
      allTurns.push({
        id: turn.id,
        turnNumber: turn.turnNumber,
        kind: turn.kind,
        taskId: turn.taskId,
        contract:
          turn.kind === "single-delegation"
            ? compactContract(turn.input, redactions)
            : undefined,
        ...compactedOutput,
        conflicts: [],
      });
      continue;
    }

    if (turn.kind === "batch-delegation") {
      const clean = isCleanBatchResult(turn.output);
      if (clean) compactedCleanTurns++;
      else {
        retainedDiagnosticTurns++;
        protectedTurnIds.add(turn.id);
      }
      for (const task of turn.output.tasks) {
        const handoffReference = task.handoffReference ?? task.result?.handoffReference;
        const handoffState = task.handoffState ?? task.result?.handoffState;
        if (handoffReference) {
          if (handoffState?.status === "issued") {
            handoffs.set(handoffReference, {
              reference: handoffReference,
              status: "issued",
              availabilityBasis: "recorded-issued-unconsumed",
              reason: redact(handoffState.reason, redactions),
              action:
                task.failureDecision?.action ?? task.result?.failureDecision?.action,
            });
            protectedTurnIds.add(turn.id);
          } else {
            handoffs.delete(handoffReference);
          }
        }
        const continuationReference = task.result?.continuationReference;
        const continuationState = task.result?.continuationState;
        if (continuationReference) {
          if (continuationState?.status === "issued") {
            continuations.set(continuationReference, {
              reference: continuationReference,
              status: "issued",
              availabilityBasis: "recorded-issued-unconsumed",
              reason: redact(continuationState.reason, redactions),
            });
            protectedTurnIds.add(turn.id);
          } else {
            continuations.delete(continuationReference);
          }
        }
      }
      const batchTasks: CompactedBatchTask[] = turn.output.tasks.map((task, index) => {
        const inputTask = turn.input.tasks[index];
        if (!inputTask) {
          throw new Error(`Batch output task ${task.taskId} has no input contract`);
        }
        const contract = compactContract(
          {
            ...inputTask,
            resultDetail: turn.input.resultDetail,
            workingDirectory: turn.input.workingDirectory,
            routingPreflight: turn.input.routingPreflight,
            computePolicy: turn.input.computePolicy,
          },
          redactions,
        );
        if (!task.result) {
          const recovery = task.recovery
            ? {
                attempted: task.recovery.attempted,
                classification: task.recovery.classification,
                evidence: redact(task.recovery.evidence, redactions),
                recoveryAttempt: task.recovery.recoveryAttempt,
              }
            : undefined;
          return {
            taskId: task.taskId,
            state: task.state,
            verdict: "FAILED",
            contract,
            executionIds: (task.attempts ?? []).map((attempt) => attempt.executionId),
            workerClaim: { status: "FAILED", failureCauses: [] },
            failureDecision: compactFailureDecision(task.failureDecision, redactions),
            recovery,
            filesChanged: task.changedFiles.map((path) => ({
              path,
              kind: "unknown",
              observed: true,
            })),
            authoritativeVerification: emptyCounts(),
            verificationDetails: [],
            scopeViolations: [],
            discrepancies: [],
            errors: [task.error, ...task.warnings]
              .filter((value): value is string => Boolean(value))
              .map((value) => redact(value, redactions)),
            risks: [],
          };
        }
        const compactedTask = compactTaskOutput(task.result, redactions);
        if (compactedTask.isClean && task.result.summary.trim()) omittedCleanSummaries++;
        return {
          taskId: task.taskId,
          state: task.state,
          verdict: compactedTask.verdict as Status,
          contract,
          executionIds: (task.attempts ?? task.result.attempts ?? []).map(
            (attempt) => attempt.executionId,
          ),
          workerClaim: compactedTask.workerClaim!,
          failureDecision:
            compactFailureDecision(task.failureDecision, redactions) ??
            compactedTask.failureDecision,
          repair: compactedTask.repair,
          recovery: task.recovery
            ? {
                attempted: task.recovery.attempted,
                classification: task.recovery.classification,
                evidence: redact(task.recovery.evidence, redactions),
                recoveryAttempt: task.recovery.recoveryAttempt,
              }
            : compactedTask.recovery,
          filesChanged: compactedTask.filesChanged,
          authoritativeVerification: compactedTask.authoritativeVerification,
          verificationDetails: compactedTask.verificationDetails,
          scopeViolations: compactedTask.scopeViolations,
          discrepancies: compactedTask.discrepancies,
          errors: [task.error, ...task.warnings, ...compactedTask.errors]
            .filter((value): value is string => Boolean(value))
            .map((value) => redact(value, redactions)),
          risks: compactedTask.risks,
        };
      });
      const integrationDetails = compactVerification(
        turn.output.integrationVerification,
        clean,
        redactions,
      );
      const allDetails = [
        ...batchTasks.flatMap((task) => task.verificationDetails),
        ...integrationDetails,
      ];
      const conflicts = [
        ...turn.output.scopeConflicts.map((details) => ({
          type: "scope" as const,
          details: redact(details, redactions),
        })),
        ...turn.output.integrationConflicts.map((conflict) => ({
          type: "integration" as const,
          details: redact(
            `Collision in ${conflict.path} across tasks: ${conflict.tasks.join(", ")}`,
            redactions,
          ),
        })),
      ];
      allTurns.push({
        id: turn.id,
        turnNumber: turn.turnNumber,
        kind: "batch-delegation",
        verdict:
          turn.output.completionState === "verified-complete"
            ? "PASS"
            : "NEEDS_SUPERVISOR",
        isClean: clean,
        executionIds: batchTasks.flatMap((task) => task.executionIds),
        durationSeconds: turn.output.durationSeconds,
        batchPolicy: {
          ...(redactUnknown(
            {
              mode: turn.input.mode,
              resultDetail: turn.input.resultDetail,
              workingDirectory: turn.input.workingDirectory,
              allowOverlappingScopes: turn.input.allowOverlappingScopes,
              integrate: turn.input.integrate,
              automaticRecovery: turn.input.automaticRecovery,
              routingPreflight: turn.input.routingPreflight,
              computePolicy: turn.input.computePolicy,
            },
            redactions,
          ) as CompactedBatchPolicy),
          workingDirectory: turn.input.workingDirectory,
        },
        batchOutcome: {
          completionState: turn.output.completionState,
          integrated: turn.output.integrated,
          integrationSummary: redact(turn.output.integrationSummary, redactions),
          taskCount: turn.output.taskCount,
          passed: turn.output.passed,
          failed: turn.output.failed,
        },
        filesChanged: batchTasks.flatMap((task) => task.filesChanged),
        authoritativeVerification: verificationCounts(allDetails),
        verificationDetails: allDetails,
        batchTasks,
        scopeViolations: batchTasks.flatMap((task) => task.scopeViolations),
        discrepancies: batchTasks.flatMap((task) => task.discrepancies),
        conflicts,
        errors: [
          ...turn.output.warnings,
          ...batchTasks.flatMap((task) => task.errors),
        ].map((value) => redact(value, redactions)),
        risks: turn.output.reviewChecklist.map((value) => redact(value, redactions)),
      });
      continue;
    }

    allTurns.push({
      id: turn.id,
      turnNumber: turn.turnNumber,
      kind: "routing-preflight",
      verdict: "NOT_EXECUTED",
      isClean: true,
      executionIds: [],
      routing: {
        card: redactUnknown(
          structuredClone(turn.card),
          redactions,
        ) as RoutingPreflightInput,
        route: turn.route ? redact(turn.route, redactions) : undefined,
        signals: (turn.signals ?? []).map((value) => redact(value, redactions)),
      },
      filesChanged: [],
      authoritativeVerification: emptyCounts(),
      verificationDetails: [],
      scopeViolations: [],
      discrepancies: [],
      conflicts: [],
      errors: [],
      risks: (turn.signals ?? []).map((value) => redact(value, redactions)),
    });
    latestRoutingTurnId = turn.id;
  }

  if (latestRoutingTurnId) protectedTurnIds.add(latestRoutingTurnId);

  const turnLimit = Math.max(0, Math.floor(options.maxTurnsCount ?? MAX_RETAINED_TURNS));
  const protectedTurns = allTurns.filter((turn) => protectedTurnIds.has(turn.id));
  const available = Math.max(0, turnLimit - protectedTurns.length);
  const optionalTurns = allTurns.filter((turn) => !protectedTurnIds.has(turn.id));
  const retainedOptionalIds = new Set(
    (available === 0 ? [] : optionalTurns.slice(-available)).map((turn) => turn.id),
  );
  const retainedTurns = allTurns.filter(
    (turn) => protectedTurnIds.has(turn.id) || retainedOptionalIds.has(turn.id),
  );
  const omittedCleanTurns = allTurns.length - retainedTurns.length;
  const protectedTurnsOverLimit = protectedTurns.length > turnLimit;
  if (discardedNarrationTurns > 0) rulesApplied.push("rule:discard-status-narration");
  if (discardedToolProseTurns > 0) rulesApplied.push("rule:discard-tool-prose");
  if (omittedCleanSummaries > 0) rulesApplied.push("rule:omit-clean-worker-summaries");
  if (omittedCleanTurns > 0) rulesApplied.push("rule:bound-stale-clean-history");
  if (protectedTurnsOverLimit) {
    rulesApplied.push("rule:exceed-soft-limit-for-protected-evidence");
  }

  const objective = redact(context.objective, redactions);
  const acceptanceCriteria = context.acceptanceCriteria.map((value) =>
    redact(value, redactions),
  );
  const decisions = context.decisions.map((decision) => ({
    ...decision,
    summary: redact(decision.summary, redactions),
    details: decision.details ? redact(decision.details, redactions) : undefined,
  }));
  const constraints = context.constraints.map((constraint) => ({
    ...constraint,
    description: redact(constraint.description, redactions),
  }));
  const blockers = context.blockers.map((blocker) => ({
    ...blocker,
    description: redact(blocker.description, redactions),
  }));
  const lineage: CompactedLineageEntry[] = context.lineage.map((entry) => {
    const { verification, ...facts } = structuredClone(entry);
    return {
      ...facts,
      terminationMessage: entry.terminationMessage
        ? redact(entry.terminationMessage, redactions)
        : entry.terminationMessage,
      verification: verification
        ? compactVerification(verification, true, redactions)
        : undefined,
      failureDecision: compactFailureDecision(entry.failureDecision, redactions),
    };
  });
  if (redactions.count > 0) rulesApplied.push("rule:redact-compact-presentation");
  const originalSizeBytes = byteLength(context);
  const preliminary: CompactedContext = {
    objective,
    acceptanceCriteria,
    allowedFiles: [...context.allowedFiles],
    forbiddenFiles: [...context.forbiddenFiles],
    changeIntent: context.changeIntent,
    taskCategory: context.taskCategory,
    decisions,
    constraints,
    blockers,
    lineage,
    turns: retainedTurns,
    activeHandoffs: [...handoffs.values()],
    activeContinuations: [...continuations.values()],
    lastCompactedTurnNumber: context.turns.reduce(
      (latest, turn) => Math.max(latest, turn.turnNumber),
      context.lastCompactedTurnNumber ?? 0,
    ),
    stats: {
      originalSizeBytes,
      compactedSizeBytes: 0,
      sizeDeltaBytes: 0,
      reductionRatio: 0,
      discardedNarrationTurns,
      discardedToolProseTurns,
      compactedCleanTurns,
      retainedDiagnosticTurns,
      omittedCleanTurns,
      omittedCleanSummaries,
      scrubbedValuesCount: redactions.count,
      retainedDecisionsCount: decisions.length,
      retainedConstraintsCount: constraints.length,
      retainedBlockersCount: blockers.length,
      retainedLineageCount: lineage.length,
      requestedTurnLimit: turnLimit,
      protectedTurnsOverLimit,
      rulesApplied,
    },
  };
  let result = preliminary;
  for (let iteration = 0; iteration < 10; iteration++) {
    const compactedSizeBytes = byteLength(result);
    const reductionRatio =
      originalSizeBytes === 0
        ? 0
        : Math.max(0, (originalSizeBytes - compactedSizeBytes) / originalSizeBytes);
    const next: CompactedContext = {
      ...result,
      stats: {
        ...result.stats,
        compactedSizeBytes,
        sizeDeltaBytes: compactedSizeBytes - originalSizeBytes,
        reductionRatio: Number(reductionRatio.toFixed(4)),
      },
    };
    if (
      next.stats.compactedSizeBytes === result.stats.compactedSizeBytes &&
      next.stats.sizeDeltaBytes === result.stats.sizeDeltaBytes &&
      next.stats.reductionRatio === result.stats.reductionRatio
    ) {
      return next;
    }
    result = next;
  }
  return result;
}

// ============================================================================
// P1.3B Context Pressure and Trigger Policy
// ============================================================================

export const SAFE_LIFECYCLE_BOUNDARIES = [
  "pre-delegation",
  "post-delegation",
  "pre-continuation",
  "post-continuation",
  "pre-batch",
  "post-batch",
  "routing-preflight",
  "review-handoff",
  "session-idle",
  "manual",
] as const;

export type SafeLifecycleBoundary = (typeof SAFE_LIFECYCLE_BOUNDARIES)[number];

export const UNSAFE_LIFECYCLE_BOUNDARIES = [
  "in-flight",
  "atomic-repair",
  "recovery-running",
  "unknown",
] as const;

export type UnsafeLifecycleBoundary = (typeof UNSAFE_LIFECYCLE_BOUNDARIES)[number];

export type ContextLifecycleBoundary =
  SafeLifecycleBoundary | UnsafeLifecycleBoundary | (string & {});

export function isSafeLifecycleBoundary(
  boundary: string,
): boundary is SafeLifecycleBoundary {
  return (SAFE_LIFECYCLE_BOUNDARIES as readonly string[]).includes(boundary);
}

export const CONTEXT_TRIGGER_REASON_CODES = [
  "trigger:size-pressure-exceeded",
  "trigger:total-turns-exceeded",
  "trigger:stale-clean-history-accumulated",
  "trigger:repeated-tool-overhead-exceeded",
  "trigger:high-reclaimable-ratio",
  "trigger:manual-request",
] as const;
export type ContextTriggerReasonCode = (typeof CONTEXT_TRIGGER_REASON_CODES)[number];

export const CONTEXT_BLOCK_REASON_CODES = [
  "block:unsafe-lifecycle-boundary",
  "block:already-compacted",
  "block:cooldown-active",
  "block:insufficient-reclaimable-gain",
] as const;
export type ContextBlockReasonCode = (typeof CONTEXT_BLOCK_REASON_CODES)[number];

export const CONTEXT_NOOP_REASON_CODES = [
  "noop:below-thresholds",
  "noop:empty-context",
] as const;
export type ContextNoopReasonCode = (typeof CONTEXT_NOOP_REASON_CODES)[number];

export type ContextCompactionReasonCode =
  ContextTriggerReasonCode | ContextBlockReasonCode | ContextNoopReasonCode;

export const CONTEXT_COMPACTION_DECISIONS = ["trigger", "block", "noop"] as const;
export type ContextCompactionDecision = (typeof CONTEXT_COMPACTION_DECISIONS)[number];

export interface ContextReportedTokens {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens?: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly isAuthoritative: boolean;
}

export interface ContextPressureMetrics {
  readonly totalSizeBytes: number;
  readonly totalTurns: number;
  readonly cleanTurns: number;
  readonly diagnosticTurns: number;
  readonly statusNarrationTurns: number;
  readonly toolProseTurns: number;
  readonly routingTurns: number;
  readonly repeatedToolTurns: number;
  readonly toolOverheadBytes: number;
  readonly estimatedReclaimableBytes: number;
  readonly reclaimableRatio: number;
  readonly decisionsCount: number;
  readonly constraintsCount: number;
  readonly activeBlockersCount: number;
  readonly activeSecurityBlockersCount: number;
  readonly activeHandoffsCount: number;
  readonly activeContinuationsCount: number;
  readonly lineageCount: number;
  readonly reportedTokens?: ContextReportedTokens;
}

export interface ContextPressurePolicyConfig {
  readonly maxSizeBytes?: number;
  readonly maxTotalTurns?: number;
  readonly maxCleanTurns?: number;
  readonly maxToolOverheadTurns?: number;
  readonly maxToolOverheadBytes?: number;
  readonly reclaimableRatioThreshold?: number;
  readonly minReclaimableBytes?: number;
  readonly cooldownTurns?: number;
}

export interface ResolvedContextPressureConfig {
  readonly maxSizeBytes: number;
  readonly maxTotalTurns: number;
  readonly maxCleanTurns: number;
  readonly maxToolOverheadTurns: number;
  readonly maxToolOverheadBytes: number;
  readonly reclaimableRatioThreshold: number;
  readonly minReclaimableBytes: number;
  readonly cooldownTurns: number;
}

function requireSafeInteger(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function requireRatio(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be finite and > 0 and <= 1`);
  }
  return value;
}

export function validateResolvedContextPressureConfig(
  config: ResolvedContextPressureConfig,
): ResolvedContextPressureConfig {
  return {
    maxSizeBytes: requireSafeInteger("maxSizeBytes", config.maxSizeBytes, 1),
    maxTotalTurns: requireSafeInteger("maxTotalTurns", config.maxTotalTurns, 1),
    maxCleanTurns: requireSafeInteger("maxCleanTurns", config.maxCleanTurns, 1),
    maxToolOverheadTurns: requireSafeInteger(
      "maxToolOverheadTurns",
      config.maxToolOverheadTurns,
      1,
    ),
    maxToolOverheadBytes: requireSafeInteger(
      "maxToolOverheadBytes",
      config.maxToolOverheadBytes,
      1,
    ),
    reclaimableRatioThreshold: requireRatio(
      "reclaimableRatioThreshold",
      config.reclaimableRatioThreshold,
    ),
    minReclaimableBytes: requireSafeInteger(
      "minReclaimableBytes",
      config.minReclaimableBytes,
      1,
    ),
    cooldownTurns: requireSafeInteger("cooldownTurns", config.cooldownTurns, 0),
  };
}

export function resolveContextPressureConfig(
  overrides: ContextPressurePolicyConfig = {},
): ResolvedContextPressureConfig {
  return validateResolvedContextPressureConfig({
    maxSizeBytes: requireSafeInteger(
      "maxSizeBytes",
      overrides.maxSizeBytes ?? CONTEXT_MAX_BYTES,
      1,
    ),
    maxTotalTurns: requireSafeInteger(
      "maxTotalTurns",
      overrides.maxTotalTurns ?? CONTEXT_MAX_TURNS,
      1,
    ),
    maxCleanTurns: requireSafeInteger(
      "maxCleanTurns",
      overrides.maxCleanTurns ?? CONTEXT_MAX_CLEAN_TURNS,
      1,
    ),
    maxToolOverheadTurns: requireSafeInteger(
      "maxToolOverheadTurns",
      overrides.maxToolOverheadTurns ?? DEFAULT_CONTEXT_MAX_TOOL_OVERHEAD_TURNS,
      1,
    ),
    maxToolOverheadBytes: requireSafeInteger(
      "maxToolOverheadBytes",
      overrides.maxToolOverheadBytes ?? DEFAULT_CONTEXT_MAX_TOOL_OVERHEAD_BYTES,
      1,
    ),
    reclaimableRatioThreshold: requireRatio(
      "reclaimableRatioThreshold",
      overrides.reclaimableRatioThreshold ?? DEFAULT_CONTEXT_RECLAIMABLE_RATIO_THRESHOLD,
    ),
    minReclaimableBytes: requireSafeInteger(
      "minReclaimableBytes",
      overrides.minReclaimableBytes ?? DEFAULT_CONTEXT_MIN_RECLAIMABLE_BYTES,
      1,
    ),
    cooldownTurns: requireSafeInteger(
      "cooldownTurns",
      overrides.cooldownTurns ?? CONTEXT_COOLDOWN_TURNS,
      0,
    ),
  });
}

function extractReportedTokens(
  context: OrchestrationContext,
): ContextReportedTokens | undefined {
  const usageSamples: unknown[] = context.lineage.map((entry) => entry.usage);

  const collectOutputUsage = (output: DelegateTaskOutput): void => {
    // Current results have immutable per-execution lineage. Historical results
    // may lack attempts, in which case the top-level aggregate is the only fact.
    if (!output.attempts || output.attempts.length === 0) {
      usageSamples.push(output.usage);
    }
  };

  for (const turn of context.turns) {
    if (turn.kind === "single-delegation" || turn.kind === "continuation") {
      collectOutputUsage(turn.output);
    } else if (turn.kind === "batch-delegation") {
      for (const task of turn.output.tasks) {
        const attempts = task.attempts ?? task.result?.attempts;
        if (!attempts || attempts.length === 0) {
          usageSamples.push(task.result?.usage ?? null);
        }
      }
    }
  }

  if (usageSamples.length === 0) return undefined;

  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let cacheWriteComplete = true;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;

  for (const usage of usageSamples) {
    if (!usage || typeof usage !== "object") return undefined;
    const val =
      "value" in usage && usage.value && typeof usage.value === "object"
        ? (usage.value as Record<string, unknown>)
        : (usage as Record<string, unknown>);
    const fields = [
      val.inputTokens,
      val.cachedInputTokens,
      val.outputTokens,
      val.reasoningOutputTokens,
    ];
    if (
      fields.some(
        (value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0,
      )
    ) {
      return undefined;
    }
    const sampleInput = val.inputTokens as number;
    const sampleCached = val.cachedInputTokens as number;
    const sampleOutput = val.outputTokens as number;
    const sampleReasoning = val.reasoningOutputTokens as number;
    if (sampleCached > sampleInput || sampleReasoning > sampleOutput) return undefined;

    inputTokens += sampleInput;
    cachedInputTokens += sampleCached;
    outputTokens += sampleOutput;
    reasoningOutputTokens += sampleReasoning;
    if (val.cacheWriteInputTokens === undefined) {
      cacheWriteComplete = false;
    } else if (
      typeof val.cacheWriteInputTokens === "number" &&
      Number.isSafeInteger(val.cacheWriteInputTokens) &&
      val.cacheWriteInputTokens >= 0
    ) {
      cacheWriteInputTokens += val.cacheWriteInputTokens;
    } else {
      return undefined;
    }
  }

  return {
    inputTokens,
    cachedInputTokens,
    ...(cacheWriteComplete ? { cacheWriteInputTokens } : {}),
    outputTokens,
    reasoningOutputTokens,
    // Provider input already includes cached input, and provider output already
    // includes reasoning output. Neither subtype is added a second time.
    totalTokens: inputTokens + outputTokens,
    isAuthoritative: true,
  };
}

export function calculateContextPressureMetrics(
  context: OrchestrationContext,
): ContextPressureMetrics {
  const totalSizeBytes = byteLength(context);
  const totalTurns = context.turns.length;
  const decisionsCount = context.decisions.length;
  const constraintsCount = context.constraints.length;
  const lineageCount = context.lineage.length;
  const activeBlockers = context.blockers.filter((b) => !b.resolved);
  const activeBlockersCount = activeBlockers.length;
  const activeSecurityBlockersCount = activeBlockers.filter((b) => {
    return (
      b.kind === "scope-violation" ||
      b.kind === "scope-conflict" ||
      b.kind === "integration-conflict" ||
      b.failureClassification === "security-or-trust-boundary" ||
      b.failureClassification === "scope-or-conflict"
    );
  }).length;
  const reportedTokens = extractReportedTokens(context);

  let cleanTurns = 0;
  let diagnosticTurns = 0;
  let statusNarrationTurns = 0;
  let toolProseTurns = 0;
  let routingTurns = 0;

  const handoffs = new Map<string, CompactedHandoffRef>();
  const continuations = new Map<string, CompactedContinuationRef>();

  for (const turn of context.turns) {
    if (turn.kind === "status-narration") {
      statusNarrationTurns++;
      continue;
    }
    if (turn.kind === "tool-prose") {
      toolProseTurns++;
      continue;
    }
    if (turn.kind === "routing-preflight") {
      routingTurns++;
      continue;
    }

    if (turn.kind === "single-delegation") {
      if (turn.input.handoffReference) handoffs.delete(turn.input.handoffReference);
      if (turn.output.handoffReference && turn.output.handoffState?.status === "issued") {
        handoffs.set(turn.output.handoffReference, {
          reference: turn.output.handoffReference,
          status: "issued",
          availabilityBasis: "recorded-issued-unconsumed",
          reason: turn.output.handoffState.reason,
          action: turn.output.failureDecision?.action,
        });
      } else if (turn.output.handoffReference) {
        handoffs.delete(turn.output.handoffReference);
      }
      if (
        turn.output.continuationReference &&
        turn.output.continuationState?.status === "issued"
      ) {
        continuations.set(turn.output.continuationReference, {
          reference: turn.output.continuationReference,
          status: "issued",
          availabilityBasis: "recorded-issued-unconsumed",
          reason: turn.output.continuationState.reason,
        });
      } else if (turn.output.continuationReference) {
        continuations.delete(turn.output.continuationReference);
      }

      if (isCleanPassResult(turn.output)) {
        cleanTurns++;
      } else {
        diagnosticTurns++;
      }
      continue;
    }

    if (turn.kind === "continuation") {
      continuations.delete(turn.continuationReference);
      if (turn.output.handoffReference && turn.output.handoffState?.status === "issued") {
        handoffs.set(turn.output.handoffReference, {
          reference: turn.output.handoffReference,
          status: "issued",
          availabilityBasis: "recorded-issued-unconsumed",
          reason: turn.output.handoffState.reason,
          action: turn.output.failureDecision?.action,
        });
      } else if (turn.output.handoffReference) {
        handoffs.delete(turn.output.handoffReference);
      }
      if (
        turn.output.continuationReference &&
        turn.output.continuationState?.status === "issued"
      ) {
        continuations.set(turn.output.continuationReference, {
          reference: turn.output.continuationReference,
          status: "issued",
          availabilityBasis: "recorded-issued-unconsumed",
          reason: turn.output.continuationState.reason,
        });
      } else if (turn.output.continuationReference) {
        continuations.delete(turn.output.continuationReference);
      }

      if (isCleanPassResult(turn.output)) {
        cleanTurns++;
      } else {
        diagnosticTurns++;
      }
      continue;
    }

    if (turn.kind === "batch-delegation") {
      for (const task of turn.input.tasks) {
        if (task.handoffReference) handoffs.delete(task.handoffReference);
      }
      for (const task of turn.output.tasks) {
        const href = task.handoffReference ?? task.result?.handoffReference;
        const hstate = task.handoffState ?? task.result?.handoffState;
        if (href && hstate?.status === "issued") {
          handoffs.set(href, {
            reference: href,
            status: "issued",
            availabilityBasis: "recorded-issued-unconsumed",
            reason: hstate.reason,
            action: task.failureDecision?.action ?? task.result?.failureDecision?.action,
          });
        } else if (href) {
          handoffs.delete(href);
        }
        const cref = task.result?.continuationReference;
        const cstate = task.result?.continuationState;
        if (cref && cstate?.status === "issued") {
          continuations.set(cref, {
            reference: cref,
            status: "issued",
            availabilityBasis: "recorded-issued-unconsumed",
            reason: cstate.reason,
          });
        } else if (cref) {
          continuations.delete(cref);
        }
      }

      if (isCleanBatchResult(turn.output)) {
        cleanTurns++;
      } else {
        diagnosticTurns++;
      }
    }
  }

  const repeatedToolTurns = statusNarrationTurns + toolProseTurns;
  const contextWithoutRepeatedToolTurns: OrchestrationContext = {
    ...context,
    turns: context.turns.filter(
      (turn) => turn.kind !== "status-narration" && turn.kind !== "tool-prose",
    ),
  };
  const toolOverheadBytes = Math.max(
    0,
    totalSizeBytes - byteLength(contextWithoutRepeatedToolTurns),
  );
  const compacted = compactContext(context);
  const estimatedReclaimableBytes = Math.max(
    0,
    totalSizeBytes - compacted.stats.compactedSizeBytes,
  );
  const reclaimableRatio =
    totalSizeBytes === 0
      ? 0
      : Number((estimatedReclaimableBytes / totalSizeBytes).toFixed(4));

  return {
    totalSizeBytes,
    totalTurns,
    cleanTurns,
    diagnosticTurns,
    statusNarrationTurns,
    toolProseTurns,
    routingTurns,
    repeatedToolTurns,
    toolOverheadBytes,
    estimatedReclaimableBytes,
    reclaimableRatio,
    decisionsCount,
    constraintsCount,
    activeBlockersCount,
    activeSecurityBlockersCount,
    activeHandoffsCount: handoffs.size,
    activeContinuationsCount: continuations.size,
    lineageCount,
    reportedTokens,
  };
}

export interface EvaluateContextPressureOptions {
  readonly boundary: ContextLifecycleBoundary;
  /** Fully resolved operator policy; the evaluator performs no environment reads. */
  readonly config: ResolvedContextPressureConfig;
  readonly force?: boolean;
}

export interface ContextPressureEvaluation {
  readonly decision: ContextCompactionDecision;
  readonly primaryReason: ContextCompactionReasonCode;
  readonly reasonDetails: string;
  readonly contributingReasons: readonly ContextCompactionReasonCode[];
  readonly metrics: ContextPressureMetrics;
  readonly safeBoundary: boolean;
  readonly boundary: ContextLifecycleBoundary;
  readonly cooldownRemaining: number;
}

export function evaluateContextPressure(
  context: OrchestrationContext,
  options: EvaluateContextPressureOptions,
): ContextPressureEvaluation {
  const boundary = options.boundary;
  const safeBoundary = isSafeLifecycleBoundary(boundary);
  const resolvedConfig = validateResolvedContextPressureConfig(options.config);
  const force = Boolean(options.force);
  const currentTurn = context.turns.reduce(
    (latest, turn) => Math.max(latest, turn.turnNumber),
    0,
  );
  const lastCompactedTurnNumber = context.lastCompactedTurnNumber;
  if (
    lastCompactedTurnNumber !== undefined &&
    (!Number.isSafeInteger(lastCompactedTurnNumber) ||
      lastCompactedTurnNumber < 0 ||
      lastCompactedTurnNumber > currentTurn)
  ) {
    throw new Error(
      "lastCompactedTurnNumber must identify an authoritative turn in this context",
    );
  }

  const metrics = calculateContextPressureMetrics(context);

  const cooldownRemaining =
    lastCompactedTurnNumber !== undefined
      ? Math.max(
          0,
          resolvedConfig.cooldownTurns - (currentTurn - lastCompactedTurnNumber),
        )
      : 0;

  const triggerReasons: ContextTriggerReasonCode[] = [];
  if (metrics.totalSizeBytes >= resolvedConfig.maxSizeBytes) {
    triggerReasons.push("trigger:size-pressure-exceeded");
  }
  if (metrics.totalTurns >= resolvedConfig.maxTotalTurns) {
    triggerReasons.push("trigger:total-turns-exceeded");
  }
  if (metrics.cleanTurns >= resolvedConfig.maxCleanTurns) {
    triggerReasons.push("trigger:stale-clean-history-accumulated");
  }
  if (
    metrics.repeatedToolTurns >= resolvedConfig.maxToolOverheadTurns ||
    metrics.toolOverheadBytes >= resolvedConfig.maxToolOverheadBytes
  ) {
    triggerReasons.push("trigger:repeated-tool-overhead-exceeded");
  }
  if (metrics.reclaimableRatio >= resolvedConfig.reclaimableRatioThreshold) {
    triggerReasons.push("trigger:high-reclaimable-ratio");
  }
  if (force) triggerReasons.push("trigger:manual-request");

  const blockReasons: ContextBlockReasonCode[] = [];
  if (triggerReasons.length > 0) {
    if (!safeBoundary) blockReasons.push("block:unsafe-lifecycle-boundary");
    if (
      lastCompactedTurnNumber !== undefined &&
      lastCompactedTurnNumber === currentTurn
    ) {
      blockReasons.push("block:already-compacted");
    }
    if (cooldownRemaining > 0) blockReasons.push("block:cooldown-active");
    if (metrics.estimatedReclaimableBytes < resolvedConfig.minReclaimableBytes) {
      blockReasons.push("block:insufficient-reclaimable-gain");
    }
  }

  let decision: ContextCompactionDecision;
  let primaryReason: ContextCompactionReasonCode;
  let contributingReasons: ContextCompactionReasonCode[];

  if (blockReasons.length > 0) {
    decision = "block";
    primaryReason = blockReasons[0]!;
    contributingReasons = blockReasons;
  } else if (triggerReasons.length > 0) {
    decision = "trigger";
    primaryReason = triggerReasons[0]!;
    contributingReasons = triggerReasons;
  } else {
    decision = "noop";
    if (metrics.totalTurns === 0) {
      primaryReason = "noop:empty-context";
    } else {
      primaryReason = "noop:below-thresholds";
    }
    contributingReasons = [primaryReason];
  }

  let reasonDetails: string;
  switch (primaryReason) {
    case "block:already-compacted":
      reasonDetails =
        "Context compaction blocked: no authoritative turns have accumulated since the last compaction.";
      break;
    case "block:unsafe-lifecycle-boundary":
      reasonDetails = `Context compaction blocked: lifecycle boundary '${boundary}' is not a safe compaction boundary.`;
      break;
    case "block:cooldown-active":
      reasonDetails = `Context compaction blocked: cooldown active (${cooldownRemaining} turn(s) remaining since authoritative compaction at turn ${lastCompactedTurnNumber}).`;
      break;
    case "block:insufficient-reclaimable-gain":
      reasonDetails = `Context compaction blocked: estimated reclaimable bytes (${metrics.estimatedReclaimableBytes} B) below minimum threshold (${resolvedConfig.minReclaimableBytes} B).`;
      break;
    case "trigger:size-pressure-exceeded":
      reasonDetails = `Context compaction triggered: total context size (${metrics.totalSizeBytes} B) reached threshold (${resolvedConfig.maxSizeBytes} B) with ${metrics.estimatedReclaimableBytes} B reclaimable.`;
      break;
    case "trigger:total-turns-exceeded":
      reasonDetails = `Context compaction triggered: total turns (${metrics.totalTurns}) reached threshold (${resolvedConfig.maxTotalTurns}) with ${metrics.estimatedReclaimableBytes} B reclaimable.`;
      break;
    case "trigger:stale-clean-history-accumulated":
      reasonDetails = `Context compaction triggered: accumulated ${metrics.cleanTurns} clean turns (threshold: ${resolvedConfig.maxCleanTurns}) with ${metrics.estimatedReclaimableBytes} B reclaimable.`;
      break;
    case "trigger:repeated-tool-overhead-exceeded":
      reasonDetails = `Context compaction triggered: repeated tool turns (${metrics.repeatedToolTurns}) or exactly removable repeated-turn bytes (${metrics.toolOverheadBytes} B) reached a threshold with ${metrics.estimatedReclaimableBytes} B reclaimable.`;
      break;
    case "trigger:high-reclaimable-ratio":
      reasonDetails = `Context compaction triggered: reclaimable ratio (${(metrics.reclaimableRatio * 100).toFixed(1)}%) reached threshold (${(resolvedConfig.reclaimableRatioThreshold * 100).toFixed(1)}%) with ${metrics.estimatedReclaimableBytes} B reclaimable.`;
      break;
    case "trigger:manual-request":
      reasonDetails = `Context compaction triggered: manually requested at safe boundary '${boundary}'.`;
      break;
    case "noop:empty-context":
      reasonDetails = `Context compaction no-op: context contains no turns.`;
      break;
    case "noop:below-thresholds":
      reasonDetails = `Context compaction no-op: context size (${metrics.totalSizeBytes} B, ${metrics.totalTurns} turns) is below all pressure thresholds.`;
      break;
    default:
      reasonDetails = `Context compaction evaluated with outcome: ${primaryReason}.`;
      break;
  }

  return {
    decision,
    primaryReason,
    reasonDetails,
    contributingReasons,
    metrics,
    safeBoundary,
    boundary,
    cooldownRemaining,
  };
}

export function maybeCompactContext(
  context: OrchestrationContext,
  options: EvaluateContextPressureOptions,
): {
  readonly context: OrchestrationContext | CompactedContext;
  readonly authoritativeContext: OrchestrationContext;
  readonly evaluation: ContextPressureEvaluation;
  readonly compacted: boolean;
} {
  const evaluation = evaluateContextPressure(context, options);
  if (evaluation.decision === "trigger") {
    const compactedContext = compactContext(context);
    return {
      context: compactedContext,
      authoritativeContext: {
        ...context,
        lastCompactedTurnNumber: compactedContext.lastCompactedTurnNumber,
      },
      evaluation,
      compacted: true,
    };
  }
  return {
    context,
    authoritativeContext: context,
    evaluation,
    compacted: false,
  };
}
