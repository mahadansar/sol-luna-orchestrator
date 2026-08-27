import { z } from "zod";
import {
  DEFAULT_EFFORT,
  EFFORTS,
  MAX_BATCH_SIZE,
  MAX_PARALLEL,
  type Effort,
} from "./config.js";
import {
  CORE_OVERLAPS,
  INTEGRATIONS,
  MAX_SEAM_LABEL_LENGTH,
  SEAM_SIZES,
  SHARED_STATES,
  VERIFICATIONS,
  type RoutingPreflightCard,
} from "./routing.js";
import { computePolicyNarrowingShape, computePolicySchema } from "./policy.js";

/** Coarse shape of the delegated work. Helps the parent reason about effort. */
export const TASK_CATEGORIES = [
  "implementation",
  "tests",
  "bugfix",
  "refactor",
  "investigation",
  "chore",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** Explicit expectation for whether a delegated task may modify files. */
export const CHANGE_INTENTS = ["forbidden", "optional", "required"] as const;
export type ChangeIntent = (typeof CHANGE_INTENTS)[number];

/** Conservative outcomes from the bounded automatic-repair classifier. */
export const REPAIR_CLASSIFICATIONS = [
  "not-requested",
  "not-needed",
  "local-verification",
  "read-only",
  "contract-or-requirement",
  "scope-or-conflict",
  "environment-or-tooling",
  "security-or-trust-boundary",
  "wider-scope",
] as const;
export type RepairClassification = (typeof REPAIR_CLASSIFICATIONS)[number];

/** Bounded batch-recovery outcomes, kept separate from per-task repair. */
export const RECOVERY_CLASSIFICATIONS = [
  "disabled",
  "already-successful",
  "timeout-continuation",
  "worker-process-retry",
  "cancellation",
  "scope-or-conflict",
  "security-or-trust-boundary",
  "evidence-failure",
  "refused-verification",
  "contract-discrepancy",
  "integration-conflict",
  "no-owned-worktree",
  "no-trustworthy-thread",
  "not-eligible",
] as const;
export type RecoveryClassification = (typeof RECOVERY_CLASSIFICATIONS)[number];

/** Conservative P1.1 classifications derived from task execution evidence. */
export const FAILURE_CLASSIFICATIONS = [
  "success",
  "cancellation",
  "timeout",
  "runtime",
  "verification",
  "scope-or-conflict",
  "security-or-trust-boundary",
  "contract-or-requirement",
  "environment-or-tooling",
  "implementation",
  "effort",
  "capability",
  "evidence-failure",
  "unknown",
] as const;
export type FailureClassification = (typeof FAILURE_CLASSIFICATIONS)[number];

/** One next action selected by P1.1; executor selection remains P1.2-owned. */
export const FAILURE_ACTIONS = [
  "stop",
  "repair",
  "continuation",
  "retry",
  "effort-escalation",
  "stronger-executor-fallback",
  "parent-takeover",
] as const;
export type FailureAction = (typeof FAILURE_ACTIONS)[number];

export const AUTOMATIC_FAILURE_HANDLERS = [
  "automatic-repair",
  "automatic-recovery",
] as const;
export type AutomaticFailureHandler = (typeof AUTOMATIC_FAILURE_HANDLERS)[number];

/** Terminal states a worker may report, and that the orchestrator may assign. */
export const STATUSES = ["PASS", "BLOCKED", "FAILED"] as const;
export type Status = (typeof STATUSES)[number];

/** Low-trust reasons a worker declares for not returning PASS. */
export const WORKER_FAILURE_CAUSES = [
  "verification",
  "requirements",
  "implementation",
  "environment-tooling",
  "timeout",
  "blocked",
  "unclassified",
] as const;
export type WorkerFailureCause = (typeof WORKER_FAILURE_CAUSES)[number];

/** Factual role of one concrete worker execution within a logical task. */
export const ATTEMPT_ROLES = [
  "initial",
  "automatic-repair",
  "manual-continuation",
  "timeout-recovery",
  "process-retry",
] as const;
export type AttemptRole = (typeof ATTEMPT_ROLES)[number];

/** Runtime-observed termination facts. These are evidence, not P1.1 policy. */
export const ATTEMPT_TERMINATIONS = [
  "completed",
  "timed-out",
  "cancelled",
  "turn-failed",
  "stream-error",
  "process-exit",
  "runtime-error",
] as const;
export type AttemptTermination = (typeof ATTEMPT_TERMINATIONS)[number];

export const USAGE_UNAVAILABLE_REASONS = [
  "no-turn-completed",
  "timed-out",
  "cancelled",
  "turn-failed",
  "stream-error",
  "process-exit",
  "runtime-error",
] as const;
export type UsageUnavailableReason = (typeof USAGE_UNAVAILABLE_REASONS)[number];

export const CONTINUATION_STATES = [
  "issued",
  "not-eligible",
  "consumed",
  "unavailable",
] as const;
export type ContinuationState = (typeof CONTINUATION_STATES)[number];

export const HANDOFF_STATES = [
  "issued",
  "not-eligible",
  "consumed",
  "unavailable",
] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

const contextCapsuleShape = {
  relevantContext: z
    .string()
    .optional()
    .describe("Background unavailable from the repository."),
  interfaces: z
    .string()
    .optional()
    .describe("Stable signatures, contracts, or boundaries."),
  dependencies: z.string().optional().describe("Relevant dependencies."),
  invariants: z.string().optional().describe("Rules that must remain true."),
  upstreamDecisions: z.string().optional().describe("Settled parent decisions."),
  knownPitfalls: z
    .string()
    .optional()
    .describe("Pitfalls or failed approaches to avoid."),
};

const previousAttemptShape = {
  effort: z.enum(EFFORTS),
  verdict: z.enum(STATUSES),
  whatWentWrong: z
    .string()
    .describe("Why the earlier attempt did not succeed, in one sentence."),
};

/**
 * Optional cheap-routing declaration, one per delegation call.
 *
 * The runtime does not inspect task semantics itself; this is the parent stating
 * what it already knows about its own decomposition. Raw values feed hard
 * structural gates, conservatively resolved values feed advisory routing, and the
 * distinction is what keeps uncertainty from ever becoming a refusal.
 */
export const routingPreflightShape = {
  seams: z
    .array(z.string().min(1).max(MAX_SEAM_LABEL_LENGTH))
    .max(MAX_BATCH_SIZE)
    .describe(
      "Short non-sensitive labels for the independent ownership seams; never persisted in telemetry.",
    ),
  seamSize: z
    .enum(SEAM_SIZES)
    .default("unknown")
    .describe("Per-seam work volume, not difficulty; the one starting-effort input."),
  sharedState: z
    .enum(SHARED_STATES)
    .default("unknown")
    .describe(
      "State or invariants shared between a seam and another seam or the parent's remaining work.",
    ),
  coreOverlap: z
    .enum(CORE_OVERLAPS)
    .default("unknown")
    .describe(
      "Whether delegated work is isolated from files/modules siblings or the parent still reason about.",
    ),
  integration: z
    .enum(INTEGRATIONS)
    .default("unknown")
    .describe("Whether recombining the finished seams is mechanical or architectural."),
  verification: z
    .enum(VERIFICATIONS)
    .default("unknown")
    .describe("Whether each seam can be proven on its own or only together."),
};

export const routingPreflightSchema = z.object(routingPreflightShape);

/**
 * The parsed card is exactly the evaluator's input; every field has a default, so
 * an attached card is always complete before evaluation.
 */
export type RoutingPreflightInput = z.infer<typeof routingPreflightSchema>;

/**
 * The single conversion point from validated protocol input to evaluator input.
 * Identity at runtime; its value is the compile-time proof that the advertised
 * card and the pure evaluator cannot drift apart.
 */
export function asRoutingCard(input: RoutingPreflightInput): RoutingPreflightCard {
  return input;
}

/**
 * The task contract the parent orchestrator fills in when delegating.
 *
 * Exported as a raw Zod shape because `McpServer.registerTool` takes a shape,
 * not a `z.object`.
 */
export const delegateTaskInputShape = {
  objective: z
    .string()
    .min(20, "objective must be a concrete, self-contained brief")
    .describe("Self-contained bounded task; the worker cannot see the conversation."),

  activityLabel: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "Optional concise non-sensitive activity label; persisted locally; omit if sensitive.",
    ),

  effort: z
    .enum(EFFORTS)
    .default(DEFAULT_EFFORT)
    .describe("Worker effort for task difficulty: medium, high, xhigh, or max."),

  effortReason: z.string().min(10).describe("Brief reason for the selected effort."),

  taskCategory: z
    .enum(TASK_CATEGORIES)
    .optional()
    .describe("Optional work kind; does not determine effort."),

  changeIntent: z
    .enum(CHANGE_INTENTS)
    .default("required")
    .describe(
      "File-change expectation: forbidden, optional, or required; default required.",
    ),

  automaticRepair: z
    .boolean()
    .default(false)
    .describe(
      "Opt into at most one conservative same-thread repair; reuses the same worker thread and immutable task contract; default false.",
    ),

  allowedFiles: z
    .array(z.string())
    .default([])
    .describe(
      "Workspace-relative edit globs checked after the run; empty means no allowlist.",
    ),

  forbiddenFiles: z
    .array(z.string())
    .default([])
    .describe("Workspace-relative edit globs forbidden after the run; takes precedence."),

  acceptanceCriteria: z
    .array(z.string().min(1))
    .min(1, "at least one acceptance criterion is required")
    .describe("Observable conditions defining done."),

  verificationCommands: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Targeted deterministic checks; use a full suite only when the task genuinely requires it; the worker reports them and the orchestrator reruns them under configured policy. Executed orchestrator rows are authoritative; refused or skipped rows prove nothing.",
    ),

  workingDirectory: z
    .string()
    .optional()
    .describe("Absolute worker directory; defaults to the current directory."),

  context: z
    .string()
    .optional()
    .describe(
      "Legacy plain-text background; both are sent when contextCapsule is supplied.",
    ),

  contextCapsule: z
    .object(contextCapsuleShape)
    .optional()
    .describe(
      "Optional structured background; supplements legacy context, omit empty fields, never copy the parent transcript, and do not duplicate other fields.",
    ),

  resultDetail: z
    .enum(["handoff", "compact", "full"])
    .default("handoff")
    .describe(
      "handoff (default) omits structuredContent for a clean verified PASS but keeps rich failure evidence; compact keeps the compatibility structure without successful verification output; full keeps the complete structure.",
    ),

  previousAttempts: z
    .array(z.object(previousAttemptShape))
    .default([])
    .describe("Prior failed attempts so retries can avoid repeating them."),

  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(7200)
    .optional()
    .describe("Optional per-turn wall-clock budget; otherwise use configured default."),

  routingPreflight: z
    .object(routingPreflightShape)
    .optional()
    .describe(
      "Optional routing declaration for this call; advisory except that an empty seam list is refused.",
    ),

  /**
   * Optional server-issued handoff reference for an earned bounded retry,
   * effort escalation, or stronger-executor fallback. Restores the immutable
   * contract and authentic predecessor execution lineage.
   */
  handoffReference: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "Optional opaque single-use handoff reference from an earned bounded retry, effort escalation, or stronger-executor fallback; restores the immutable contract and authentic predecessor execution evidence.",
    ),

  /**
   * Compute envelope for this call.
   *
   * Any subset of the envelope, and narrowing only — the runtime intersects it
   * with the operator-owned baseline before anything runs. The advertised copy
   * exposes just the bounds a supervisor may declare (see
   * `computePolicyNarrowingShape`); the wider partial here is what the resolved
   * envelope the runtime attaches to the task validates against.
   */
  computePolicy: computePolicySchema.partial().optional(),
};

export const delegateTaskInputSchema = z.object(delegateTaskInputShape);
export type DelegateTaskInput = z.infer<typeof delegateTaskInputSchema>;

/** Input for an explicit, bounded follow-up on an eligible worker result. */
export const continueTaskInputShape = {
  continuationReference: z
    .string()
    .min(1)
    .describe("Opaque single-use continuation reference; never send a raw thread id."),
  instruction: z
    .string()
    .min(1)
    .describe("One concise follow-up; the original immutable contract remains fixed."),
  resultDetail: delegateTaskInputShape.resultDetail,
};

export const continueTaskInputSchema = z.object(continueTaskInputShape);
export type ContinueTaskInput = z.input<typeof continueTaskInputSchema>;

/**
 * Deterministic budgets for the always-advertised input metadata.
 *
 * Every entry is checked against the schema the MCP server actually advertises,
 * so `delegateTask`, `delegateTasks` and `advertisedCombined` include the routing
 * card the parent is really sent. The `*Contract` and `routingCard*` entries are
 * diagnostics for the same bytes split by owner: they answer "did the delegation
 * contract itself grow?" and "what does routing cost?" without either of them
 * standing in for the advertised total. No ceiling here is reached by subtracting
 * one advertised surface from another.
 */
export const INPUT_METADATA_SIZE_BUDGETS = {
  delegateTask: 3_550,
  continueTask: 390,
  delegateTasks: 3_990,
  routingPreflightTool: 810,
  advertisedCombined: 8_740,
  delegateTaskContract: 2_500,
  delegateTasksContract: 2_940,
  contractCombined: 5_820,
  routingCardDelegateTask: 1_060,
  routingCardDelegateTasks: 1_060,
  routingCombined: 2_920,
} as const;

/**
 * JSON Schema handed to Codex via `--output-schema`, forcing the worker's final
 * message to be machine-readable rather than prose.
 *
 * Written by hand (not generated from Zod) because OpenAI structured outputs run
 * in strict mode: every property must be listed in `required` and every object
 * needs `additionalProperties: false`.
 */
export const workerOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "failureCauses",
    "summary",
    "filesChanged",
    "verification",
    "notes",
    "followUps",
  ],
  properties: {
    status: {
      type: "string",
      enum: STATUSES,
      description:
        "PASS = every acceptance criterion met and verification passed. " +
        "BLOCKED = could not proceed. FAILED = attempted but criteria not met.",
    },
    failureCauses: {
      type: "array",
      items: { type: "string", enum: WORKER_FAILURE_CAUSES },
      description:
        "Structured worker-declared reasons status is not PASS. PASS uses []; " +
        "FAILED uses one or more causes except blocked; BLOCKED includes blocked. " +
        "Use verification when concrete failed verification rows are the only reason.",
    },
    summary: { type: "string", description: "What you did and why." },
    filesChanged: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "change", "why"],
        properties: {
          path: { type: "string" },
          change: { type: "string", enum: ["added", "modified", "deleted"] },
          why: { type: "string" },
        },
      },
    },
    verification: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "exitCode", "passed", "evidence"],
        properties: {
          command: { type: "string" },
          exitCode: { type: ["integer", "null"] },
          passed: { type: "boolean" },
          evidence: {
            type: "string",
            description: "Real output excerpt. Never invent this.",
          },
        },
      },
    },
    notes: {
      type: "string",
      description:
        "Anything the supervisor must know: assumptions, shortcuts, risks. " +
        "Empty string if none.",
    },
    followUps: {
      type: "array",
      items: { type: "string" },
      description: "Work deliberately left undone.",
    },
  },
} as const;

/** The worker's self-reported result, as parsed from its final message. */
export interface WorkerReport {
  status: Status;
  failureCauses: WorkerFailureCause[];
  summary: string;
  filesChanged: Array<{ path: string; change: string; why: string }>;
  verification: Array<{
    command: string;
    exitCode: number | null;
    passed: boolean;
    evidence: string;
  }>;
  notes: string;
  followUps: string[];
}

/** Shape of what `delegate_task` returns to the parent orchestrator. */
const usageShape = {
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number().optional(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
};

const verificationEvidenceShape = {
  command: z.string(),
  source: z
    .enum(["orchestrator", "worker"])
    .describe(
      "Result provenance. Orchestrator rows authoritatively record execution, " +
        "refusal, or skipping; worker rows are self-reported.",
    ),
  execution: z
    .enum(["argv", "shell", "rejected", "skipped", "reported"])
    .describe(
      "argv or shell = executed here; rejected = refused; skipped = disabled; " +
        "reported = worker-only. Only successful executed rows prove a command.",
    ),
  exitCode: z.number().nullable(),
  passed: z.boolean(),
  output: z.string(),
};

export const attemptEvidenceSchema = z.object({
  executionId: z.string(),
  logicalAttempt: z.number(),
  role: z.enum(ATTEMPT_ROLES),
  predecessorExecutionId: z.string().nullable(),
  requestedModel: z.string(),
  requestedEffort: z.string(),
  threadId: z.string().nullable(),
  threadOperation: z.enum(["start", "resume"]),
  threadIdentityMatched: z.boolean().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
  elapsedMs: z.number(),
  workerElapsedMs: z.number(),
  verificationElapsedMs: z.number(),
  timeoutMs: z.number(),
  termination: z.object({
    kind: z.enum(ATTEMPT_TERMINATIONS),
    message: z.string().nullable(),
  }),
  usage: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("reported"),
      source: z.literal("codex-turn.completed"),
      value: z.object(usageShape),
    }),
    z.object({
      status: z.literal("unavailable"),
      reason: z.enum(USAGE_UNAVAILABLE_REASONS),
    }),
  ]),
  workerClaimedStatus: z.enum(STATUSES).nullable(),
  workerClaimedFailureCauses: z.array(z.enum(WORKER_FAILURE_CAUSES)),
  verification: z.array(z.object(verificationEvidenceShape)),
});
export type AttemptEvidence = z.infer<typeof attemptEvidenceSchema>;

const failureDecisionShape = z.object({
  classification: z.enum(FAILURE_CLASSIFICATIONS),
  action: z.enum(FAILURE_ACTIONS),
  reason: z.string(),
  evidenceExecutionIds: z.array(z.string()),
  nextEffort: z.enum(EFFORTS).nullable(),
  automaticHandler: z.enum(AUTOMATIC_FAILURE_HANDLERS).nullable(),
  automaticRetryCount: z.number().int().nonnegative(),
  automaticRetryLimit: z.literal(1),
});
export type FailureDecision = z.infer<typeof failureDecisionShape>;

export const delegateTaskOutputShape = {
  changeIntent: z
    .enum(CHANGE_INTENTS)
    .describe("Selected change intent carried into the review evidence."),
  verdict: z
    .enum(STATUSES)
    .describe(
      "Orchestrator verdict from observed scope and configured verification; not " +
        "copied from the worker's claim.",
    ),
  workerClaimedStatus: z
    .enum(STATUSES)
    .describe("What the worker reported. Compare against `verdict`."),
  workerClaimedFailureCauses: z
    .array(z.enum(WORKER_FAILURE_CAUSES))
    .optional()
    .describe(
      "Normalized worker-declared failure causes. This is claim evidence, not an " +
        "orchestrator repair or retry classification. Current results always include it; " +
        "the field is optional only for backwards-compatible consumers.",
    ),
  trustworthy: z
    .boolean()
    .describe(
      "False when claims conflict with observed evidence or runtime errors occurred; " +
        "scrutinize the result before accepting.",
    ),
  workerThreadId: z
    .string()
    .nullable()
    .describe(
      "Codex thread id of the worker, for inspection; continuation uses an opaque reference.",
    ),
  continuationReference: z
    .string()
    .nullable()
    .describe(
      "Opaque, single-use, server-lifetime reference for one explicit continuation; " +
        "null when this result cannot be continued or the bound was consumed.",
    ),
  continuationState: z
    .object({
      status: z.enum(CONTINUATION_STATES),
      reason: z.string(),
    })
    .optional()
    .describe(
      "Factual bounded-continuation availability. Optional only for historical compatibility.",
    ),
  handoffReference: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Opaque, single-use, server-lifetime handoff reference for an earned bounded retry, effort escalation, or stronger-executor fallback; null when no handoff is earned or available.",
    ),
  handoffState: z
    .object({
      status: z.enum(HANDOFF_STATES),
      reason: z.string(),
    })
    .optional()
    .describe(
      "Factual bounded next-action handoff availability. Optional only for historical compatibility.",
    ),
  repair: z
    .object({
      requested: z.boolean(),
      attempted: z.boolean(),
      classification: z.enum(REPAIR_CLASSIFICATIONS),
      reason: z.string(),
      failureEvidence: z.array(
        z.object({
          command: z.string(),
          execution: z.enum(["argv", "shell"]),
          exitCode: z.number().nullable(),
          output: z.string(),
        }),
      ),
    })
    .nullable()
    .optional()
    .describe(
      "Bounded automatic-repair decision and the concise authoritative failure " +
        "evidence supplied to the resumed worker. Null or omitted when not requested.",
    ),
  recovery: z
    .object({
      attempted: z.boolean(),
      classification: z.enum(RECOVERY_CLASSIFICATIONS),
      evidence: z.string(),
      initialAttempt: z.number(),
      recoveryAttempt: z.number().nullable(),
      initialDurationSeconds: z.number().nullable(),
      recoveryDurationSeconds: z.number().nullable(),
      initialUsage: z
        .object({
          inputTokens: z.number(),
          cachedInputTokens: z.number(),
          cacheWriteInputTokens: z.number().optional(),
          outputTokens: z.number(),
          reasoningOutputTokens: z.number(),
        })
        .nullable(),
      recoveryUsage: z
        .object({
          inputTokens: z.number(),
          cachedInputTokens: z.number(),
          cacheWriteInputTokens: z.number().optional(),
          outputTokens: z.number(),
          reasoningOutputTokens: z.number(),
        })
        .nullable(),
    })
    .nullable()
    .optional()
    .describe(
      "At most one internal parallel-batch recovery decision; records classification, evidence, and separate initial/recovery usage and duration.",
    ),
  failureDecision: failureDecisionShape
    .optional()
    .describe(
      "P1.1 evidence-derived classification and single next action. Current runtime " +
        "results populate it; omission denotes a historical result. Repair and recovery " +
        "remain the only automatic handlers, and stronger-executor fallback is only a recommendation.",
    ),
  model: z.string(),
  effort: z.string(),
  effortReason: z.string(),
  attempt: z
    .number()
    .describe("Attempt number for this objective, from `previousAttempts`."),
  attempts: z
    .array(attemptEvidenceSchema)
    .optional()
    .describe(
      "Immutable per-execution evidence. Current runtime results populate it; omission denotes a historical result.",
    ),
  summary: z.string().describe("Worker's summary of what it did."),
  notes: z.string(),
  followUps: z.array(z.string()),
  filesChanged: z
    .array(
      z.object({
        path: z.string(),
        kind: z.string(),
        why: z.string(),
        observed: z
          .boolean()
          .describe("True if the Codex runtime itself recorded this edit."),
      }),
    )
    .describe(
      "Union of runtime-observed and worker-claimed edits. observed: false means " +
        "the runtime recorded no matching patch.",
    ),
  verification: z
    .array(z.object(verificationEvidenceShape))
    .describe(
      "Verification outcomes with provenance and execution status; use orchestrator " +
        "rows to determine what actually ran.",
    ),
  verificationMode: z
    .string()
    .describe("Execution policy in force: allowlist, off, or shell."),
  scopeViolations: z
    .array(z.string())
    .describe(
      "Observed edits outside allowedFiles, matching forbiddenFiles, or escaping " +
        "the workspace. Non-empty requires deeper review.",
    ),
  discrepancies: z
    .array(z.string())
    .describe(
      "Concrete mismatches between claims and observed evidence. Non-empty means " +
        "do not accept the result as-is.",
    ),
  reviewChecklist: z
    .array(z.string())
    .describe(
      "Risk-based checks the parent orchestrator must still make before accepting.",
    ),
  escalationAdvice: z
    .string()
    .nullable()
    .describe(
      "Backward-compatible text projection of failureDecision; null when its action is stop.",
    ),
  durationSeconds: z.number(),
  usage: z.object(usageShape).nullable(),
  errors: z.array(z.string()).describe("Runtime errors surfaced during the turn."),
};

export type DelegateTaskOutput = z.infer<z.ZodObject<typeof delegateTaskOutputShape>>;
export type { Effort };

// --- Batch delegation -------------------------------------------------------

/** Lifecycle state of one task inside a batch. */
export const TASK_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "timedOut",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** One task's contract inside a batch. Same fields as a single delegation. */
const batchTaskShape = z.object({
  objective: delegateTaskInputShape.objective,
  activityLabel: delegateTaskInputShape.activityLabel,
  effort: delegateTaskInputShape.effort,
  effortReason: delegateTaskInputShape.effortReason,
  taskCategory: delegateTaskInputShape.taskCategory,
  changeIntent: delegateTaskInputShape.changeIntent,
  automaticRepair: delegateTaskInputShape.automaticRepair,
  allowedFiles: delegateTaskInputShape.allowedFiles,
  forbiddenFiles: delegateTaskInputShape.forbiddenFiles,
  acceptanceCriteria: delegateTaskInputShape.acceptanceCriteria,
  verificationCommands: delegateTaskInputShape.verificationCommands,
  context: delegateTaskInputShape.context,
  contextCapsule: delegateTaskInputShape.contextCapsule,
  previousAttempts: delegateTaskInputShape.previousAttempts,
  handoffReference: delegateTaskInputShape.handoffReference,
  timeoutSeconds: delegateTaskInputShape.timeoutSeconds,
});

export const delegateTasksInputShape = {
  mode: z
    .enum(["parallel", "sequential"])
    .describe(
      "sequential = dependent or shared-workspace tasks run in order; parallel = " +
        "independent tasks run in isolated git worktrees and may be copied back only " +
        "when integration is enabled and observed changed files do not collide.",
    ),

  resultDetail: delegateTaskInputShape.resultDetail.describe(
    "Batch-level detail applied to every result; handoff is the economical default, compact and full preserve structured compatibility.",
  ),

  tasks: z
    .array(batchTaskShape)
    .min(1)
    .max(MAX_BATCH_SIZE)
    .describe(
      `Task contracts; this API is intended for multiple meaningful tasks but accepts ` +
        `one or more and at most ${MAX_BATCH_SIZE} tasks. A one-task batch remains ` +
        "accepted for compatibility. Batch size " +
        `is not concurrency: sequential mode runs one at a time, while parallel ` +
        `mode runs at most ${MAX_PARALLEL} workers at once and queues the rest. ` +
        "Parallel tasks need disjoint scopes unless this call sets " +
        "allowOverlappingScopes:true; actual same-file edits still prevent " +
        "automatic integration. Provide each task an optional concise, non-sensitive " +
        "activityLabel when one is safe; labels are explicit only and never derived " +
        "from objective text.",
    ),

  workingDirectory: z
    .string()
    .optional()
    .describe("Absolute path. Defaults to the orchestrator's working directory."),

  allowOverlappingScopes: z
    .boolean()
    .default(false)
    .describe(
      "Parallel only: this call-level escape hatch permits potentially overlapping " +
        "declared scopes. Actual same-file edits still prevent automatic integration.",
    ),

  integrate: z
    .boolean()
    .default(true)
    .describe(
      "Parallel only: copy completed worker edits back when observed changed files " +
        "do not collide. Set false to skip copying; worktree retention then follows " +
        "the operator's SOL_LUNA_KEEP_WORKTREES policy.",
    ),

  automaticRecovery: z
    .boolean()
    .default(true)
    .describe(
      "Parallel only: automatically recover each eligible failed task once after the initial worker window; default true. Set false to return initial failures unchanged.",
    ),

  routingPreflight: delegateTaskInputShape.routingPreflight.describe(
    "Optional call-level routing declaration; advisory except for the structural gates, which parallel mode enforces before any worktree exists.",
  ),

  computePolicy: delegateTaskInputShape.computePolicy,
};

export const delegateTasksInputSchema = z.object(delegateTasksInputShape);
export type DelegateTasksInput = z.infer<typeof delegateTasksInputSchema>;

/**
 * MCP metadata reuses the exact validators/defaults while centralizing semantic
 * guidance in the routing cards. Removing per-field prose from the advertised
 * copies avoids replaying the same contract explanation on every supervisor turn.
 */
function withoutFieldDescriptions<T extends z.ZodRawShape>(shape: T): T {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [
      key,
      (schema as z.ZodType).meta({ description: undefined }),
    ]),
  ) as unknown as T;
}

/**
 * The one thing the advertised card must say for itself.
 *
 * Per-field prose is stripped like every other advertised field, but the card as
 * a whole cannot be: it is the only optional input in this protocol that can turn
 * an otherwise valid delegation into a refusal, so a parent choosing whether to
 * attach it has to be able to see that from the schema alone.
 */
export const ROUTING_CARD_DESCRIPTION =
  "Optional advisory routing declaration. Solo advice never blocks execution; declarations " +
  "gate: every surface refuses empty seams, parallel also refuses mutable sharedState, " +
  'shared-core coreOverlap, or tasks > seams. "unknown" biases advice solo, never refuses.';

/** Nested card copy with per-field prose removed; semantics live in the card. */
const routingPreflightMcpSchema = z
  .object(withoutFieldDescriptions(routingPreflightShape))
  .optional()
  .describe(ROUTING_CARD_DESCRIPTION);

/**
 * The one thing the advertised compute card must say for itself.
 *
 * Per-field prose is stripped like everywhere else, but a supervisor that
 * cannot see the direction of travel might read this field as a grant. It is
 * the opposite, and that has to be legible from the schema alone.
 */
export const COMPUTE_POLICY_DESCRIPTION =
  "Optional per-call compute envelope. Narrows this installation's operator-owned " +
  "baseline only and can never widen it. Omit to use the baseline.";

const computePolicyMcpSchema = z
  .object(computePolicyNarrowingShape)
  .optional()
  .describe(COMPUTE_POLICY_DESCRIPTION);

export const delegateTaskMcpInputShape = {
  ...withoutFieldDescriptions(delegateTaskInputShape),
  contextCapsule: z.object(withoutFieldDescriptions(contextCapsuleShape)).optional(),
  previousAttempts: z
    .array(z.object(withoutFieldDescriptions(previousAttemptShape)))
    .default([]),
  routingPreflight: routingPreflightMcpSchema,
  computePolicy: computePolicyMcpSchema,
};
export const continueTaskMcpInputShape = withoutFieldDescriptions(continueTaskInputShape);
const batchTaskMcpSchema = z.object({
  objective: delegateTaskMcpInputShape.objective,
  activityLabel: delegateTaskMcpInputShape.activityLabel,
  effort: delegateTaskMcpInputShape.effort,
  effortReason: delegateTaskMcpInputShape.effortReason,
  taskCategory: delegateTaskMcpInputShape.taskCategory,
  changeIntent: delegateTaskMcpInputShape.changeIntent,
  automaticRepair: delegateTaskMcpInputShape.automaticRepair,
  allowedFiles: delegateTaskMcpInputShape.allowedFiles,
  forbiddenFiles: delegateTaskMcpInputShape.forbiddenFiles,
  acceptanceCriteria: delegateTaskMcpInputShape.acceptanceCriteria,
  verificationCommands: delegateTaskMcpInputShape.verificationCommands,
  context: delegateTaskMcpInputShape.context,
  contextCapsule: delegateTaskMcpInputShape.contextCapsule,
  previousAttempts: delegateTaskMcpInputShape.previousAttempts,
  handoffReference: delegateTaskMcpInputShape.handoffReference,
  timeoutSeconds: delegateTaskMcpInputShape.timeoutSeconds,
});
export const delegateTasksMcpInputShape = {
  ...withoutFieldDescriptions(delegateTasksInputShape),
  tasks: z.array(batchTaskMcpSchema).min(1).max(MAX_BATCH_SIZE),
  routingPreflight: routingPreflightMcpSchema,
  computePolicy: computePolicyMcpSchema,
};

/** The advisory tool takes the card and nothing else. */
export const routingPreflightMcpInputShape =
  withoutFieldDescriptions(routingPreflightShape);

/**
 * Measure the advertised input metadata.
 *
 * `delegateTask`, `delegateTasks`, `continueTask` and `routingPreflightTool` are
 * the schemas the server really registers, and `advertisedCombined` is their sum
 * — the whole input-schema cost of a session, with nothing excluded. The
 * `*Contract` and `routingCard*` fields attribute those same bytes to the
 * delegation contract and to routing respectively, so a regression can be
 * located; they are diagnostics, never the total.
 */
export function inputMetadataSizeReport(): {
  delegateTask: number;
  continueTask: number;
  delegateTasks: number;
  routingPreflightTool: number;
  advertisedCombined: number;
  delegateTaskContract: number;
  delegateTasksContract: number;
  contractCombined: number;
  routingCardDelegateTask: number;
  routingCardDelegateTasks: number;
  routingCombined: number;
} {
  const size = (shape: z.ZodRawShape): number =>
    JSON.stringify(z.toJSONSchema(z.object(shape))).length;
  const withoutCard = (shape: z.ZodRawShape): z.ZodRawShape => {
    const { routingPreflight: _routingPreflight, ...rest } = shape;
    return rest;
  };
  const delegateTask = size(delegateTaskMcpInputShape);
  const delegateTasks = size(delegateTasksMcpInputShape);
  const continueTask = size(continueTaskMcpInputShape);
  const routingPreflightTool = size(routingPreflightMcpInputShape);
  const delegateTaskContract = size(withoutCard(delegateTaskMcpInputShape));
  const delegateTasksContract = size(withoutCard(delegateTasksMcpInputShape));
  return {
    delegateTask,
    continueTask,
    delegateTasks,
    routingPreflightTool,
    advertisedCombined:
      delegateTask + continueTask + delegateTasks + routingPreflightTool,
    delegateTaskContract,
    delegateTasksContract,
    contractCombined: delegateTaskContract + continueTask + delegateTasksContract,
    routingCardDelegateTask: delegateTask - delegateTaskContract,
    routingCardDelegateTasks: delegateTasks - delegateTasksContract,
    routingCombined:
      delegateTask -
      delegateTaskContract +
      (delegateTasks - delegateTasksContract) +
      routingPreflightTool,
  };
}

const delegateTaskOutputObject = z.object(delegateTaskOutputShape);

export const batchTaskResultSchema = z.object({
  taskId: z.string().describe("Identifier used in logs, worktree paths, and conflicts."),
  state: z.enum(TASK_STATES),
  objective: z.string(),
  effort: z.string(),
  effortReason: z.string(),
  result: delegateTaskOutputObject
    .nullable()
    .describe(
      "Single-task result at the batch's requested resultDetail, or null if the task " +
        "never ran.",
    ),
  changedFiles: z
    .array(z.string())
    .describe("Workspace-relative paths this task changed."),
  diff: z.string().optional().describe("Unified diff from the task's worktree."),
  worktreePath: z
    .string()
    .nullable()
    .describe(
      "Set only when the worktree remains after configured cleanup; null when cleaned up.",
    ),
  error: z.string().nullable(),
  warnings: z.array(z.string()),
  attempt: z
    .number()
    .optional()
    .describe(
      "Stable task attempt ordinal; recovery uses the same taskId and increments this once.",
    ),
  attempts: z
    .array(attemptEvidenceSchema)
    .optional()
    .describe(
      "Per-execution evidence retained even when no final task result was built.",
    ),
  recovery: delegateTaskOutputShape.recovery,
  failureDecision: delegateTaskOutputShape.failureDecision,
  handoffReference: delegateTaskOutputShape.handoffReference,
  handoffState: delegateTaskOutputShape.handoffState,
});

export type BatchTaskResult = z.infer<typeof batchTaskResultSchema>;

export const delegateTasksOutputShape = {
  batchId: z.string(),
  mode: z.enum(["parallel", "sequential"]),
  maxParallel: z.number(),
  taskCount: z.number(),
  passed: z.number(),
  failed: z.number(),
  durationSeconds: z.number(),
  tasks: z.array(batchTaskResultSchema),
  scopeConflicts: z
    .array(z.string())
    .describe("Declared scopes that could match the same files."),
  integrationConflicts: z
    .array(z.object({ path: z.string(), tasks: z.array(z.string()) }))
    .describe(
      "Parallel integration only: files more than one worker actually changed. " +
        "Non-empty means nothing was integrated and you must merge them yourself. " +
        "Sequential shared-workspace batches return an empty array.",
    ),
  integrated: z
    .boolean()
    .describe(
      "Whether completed worker edits are now present in the requested workspace.",
    ),
  integrationSummary: z.string(),
  integrationVerification: delegateTaskOutputShape.verification.describe(
    "Final authoritative verification rerun in the integrated/shared workspace. " +
      "This is distinct from each worker's isolated scoped verification.",
  ),
  completionState: z
    .enum(["verified-complete", "needs-supervisor"])
    .describe(
      "verified-complete only when ownership evidence, integration, and final " +
        "workspace verification all pass; otherwise the parent must inspect the rich evidence.",
    ),
  warnings: z.array(z.string()),
  automaticRecovery: z
    .boolean()
    .optional()
    .describe("Whether bounded parallel recovery was enabled for this batch."),
  reviewChecklist: z
    .array(z.string())
    .describe(
      "Batch-level integration and risk checks the parent orchestrator must still make.",
    ),
};

export type BatchOutput = z.infer<z.ZodObject<typeof delegateTasksOutputShape>>;
