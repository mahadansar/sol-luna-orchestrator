import { z } from "zod";
import {
  DEFAULT_EFFORT,
  EFFORTS,
  MAX_BATCH_SIZE,
  MAX_PARALLEL,
  type Effort,
} from "./config.js";

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

/** Terminal states a worker may report, and that the orchestrator may assign. */
export const STATUSES = ["PASS", "BLOCKED", "FAILED"] as const;
export type Status = (typeof STATUSES)[number];

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
    .describe(
      "One bounded executable task. Make the what, why, and expected outcome " +
        "self-contained because the worker cannot see the conversation.",
    ),

  activityLabel: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "Optional concise label for local activity views; keep it short and useful " +
        "(for example, 'Update auth retries'). It is persisted locally and may " +
        "reveal this brief work description; omit it when that is not appropriate.",
    ),

  effort: z
    .enum(EFFORTS)
    .default(DEFAULT_EFFORT)
    .describe(
      "Worker reasoning effort: medium = mechanical; high = bounded work needing " +
        "judgement (routine default); xhigh = subtle, cross-cutting, or unclear cause; " +
        "max = genuinely hard. Rate this task's difficulty, not project importance.",
    ),

  effortReason: z
    .string()
    .min(10)
    .describe("One sentence justifying the effort from this task's difficulty."),

  taskCategory: z
    .enum(TASK_CATEGORIES)
    .optional()
    .describe("Kind of executable work; it does not determine effort."),

  changeIntent: z
    .enum(CHANGE_INTENTS)
    .default("required")
    .describe(
      "Explicit file-change expectation: forbidden means read-only and any " +
        "runtime-observed edit violates the contract; optional means edits may " +
        "be useful but are not required; required means the task is expected to " +
        "produce an edit. Omitted defaults to required for compatibility. This " +
        "is independent of allowedFiles and taskCategory.",
    ),

  allowedFiles: z
    .array(z.string())
    .default([])
    .describe(
      "Declared workspace-relative glob scope, checked against observed edits after " +
        "the run. Empty declares no in-workspace allowlist and does not declare read-only " +
        "intent; workspace confinement remains.",
    ),

  forbiddenFiles: z
    .array(z.string())
    .default([])
    .describe(
      "Workspace-relative globs observed edits must not match. Checked after the " +
        "run and takes precedence over allowedFiles.",
    ),

  acceptanceCriteria: z
    .array(z.string().min(1))
    .min(1, "at least one acceptance criterion is required")
    .describe("Observable conditions that define done and can be judged from evidence."),

  verificationCommands: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Targeted deterministic checks that prove the bounded task; use a full suite " +
        "only when the task genuinely requires it. The worker runs and reports them, " +
        "and the orchestrator independently processes each under the configured " +
        "policy. Executed orchestrator rows are authoritative, while refused or " +
        "skipped rows prove nothing. Default allowlist mode refuses shell syntax.",
    ),

  workingDirectory: z
    .string()
    .optional()
    .describe(
      "Absolute worker directory; defaults to the orchestrator's current directory.",
    ),

  context: z
    .string()
    .optional()
    .describe(
      "Legacy plain-text task background. If contextCapsule is also supplied, both " +
        "are sent; avoid duplication.",
    ),

  contextCapsule: z
    .object({
      relevantContext: z
        .string()
        .optional()
        .describe("Task background the worker cannot infer from the repository."),
      interfaces: z
        .string()
        .optional()
        .describe("Signatures, contracts, or boundaries that must remain stable."),
      dependencies: z
        .string()
        .optional()
        .describe("Services, libraries, or internal modules the task depends on."),
      invariants: z.string().optional().describe("Rules that must remain true."),
      upstreamDecisions: z
        .string()
        .optional()
        .describe(
          "Architecture or design decisions already settled by the parent orchestrator.",
        ),
      knownPitfalls: z
        .string()
        .optional()
        .describe("Task-specific mistakes or failed approaches to avoid."),
    })
    .optional()
    .describe(
      "Optional structured task background the worker cannot infer. It supplements " +
        "the contract and legacy context; include only useful fields, omit empty fields, " +
        "never copy the parent transcript, and do not duplicate other fields.",
    ),

  resultDetail: z
    .enum(["full", "compact"])
    .default("full")
    .describe(
      "Choose compact routinely; it removes only successful verification output. " +
        "Use full when that output is needed. The schema default remains full for " +
        "backwards compatibility; failed, refused, and skipped output is retained.",
    ),

  previousAttempts: z
    .array(
      z.object({
        effort: z.enum(EFFORTS),
        verdict: z.enum(STATUSES),
        whatWentWrong: z
          .string()
          .describe("Why the earlier attempt did not succeed, in one sentence."),
      }),
    )
    .default([])
    .describe(
      "Prior FAILED or BLOCKED attempts at this objective, so a retry can avoid " +
        "repeating them and the result can report its attempt number.",
    ),

  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(7200)
    .optional()
    .describe(
      "Optional per-turn wall-clock budget; otherwise uses the configured default " +
        "(normally 1800 seconds).",
    ),
};

export const delegateTaskInputSchema = z.object(delegateTaskInputShape);
export type DelegateTaskInput = z.infer<typeof delegateTaskInputSchema>;

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
  required: ["status", "summary", "filesChanged", "verification", "notes", "followUps"],
  properties: {
    status: {
      type: "string",
      enum: STATUSES,
      description:
        "PASS = every acceptance criterion met and verification passed. " +
        "BLOCKED = could not proceed. FAILED = attempted but criteria not met.",
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
  trustworthy: z
    .boolean()
    .describe(
      "False when claims conflict with observed evidence or runtime errors occurred; " +
        "scrutinize the result before accepting.",
    ),
  workerThreadId: z
    .string()
    .nullable()
    .describe("Codex thread id of the worker, for inspecting or resuming it."),
  model: z.string(),
  effort: z.string(),
  effortReason: z.string(),
  attempt: z
    .number()
    .describe("Attempt number for this objective, from `previousAttempts`."),
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
    .array(
      z.object({
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
      }),
    )
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
      "When the task did not pass, what to change before retrying — including " +
        "whether raising effort is actually justified.",
    ),
  durationSeconds: z.number(),
  usage: z
    .object({
      inputTokens: z.number(),
      cachedInputTokens: z.number(),
      outputTokens: z.number(),
      reasoningOutputTokens: z.number(),
    })
    .nullable(),
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
  allowedFiles: delegateTaskInputShape.allowedFiles,
  forbiddenFiles: delegateTaskInputShape.forbiddenFiles,
  acceptanceCriteria: delegateTaskInputShape.acceptanceCriteria,
  verificationCommands: delegateTaskInputShape.verificationCommands,
  context: delegateTaskInputShape.context,
  contextCapsule: delegateTaskInputShape.contextCapsule,
  previousAttempts: delegateTaskInputShape.previousAttempts,
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
    "Batch-level result detail applied uniformly to every returned task result; " +
      "it is not a per-task field. Compact removes only successful verification " +
      "output, while the schema default remains full for backwards compatibility.",
  ),

  tasks: z
    .array(batchTaskShape)
    .min(1)
    .max(MAX_BATCH_SIZE)
    .describe(
      `Task contracts; this API is intended for multiple meaningful tasks but accepts ` +
        `one or more and at most ${MAX_BATCH_SIZE} tasks. A one-task batch remains ` +
        "accepted for compatibility; prefer delegate_task for a single task. Batch size " +
        `is not concurrency: sequential mode runs one at a time, while parallel ` +
        `mode runs at most ${MAX_PARALLEL} workers at once and queues the rest. ` +
        "Parallel tasks need disjoint scopes unless this call sets " +
        "allowOverlappingScopes:true; actual same-file edits still prevent " +
        "automatic integration.",
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
        "do not collide. Set false to leave changes in worktrees for review.",
    ),
};

export const delegateTasksInputSchema = z.object(delegateTasksInputShape);
export type DelegateTasksInput = z.infer<typeof delegateTasksInputSchema>;

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
    .describe("Set when the worktree was kept for inspection; null when cleaned up."),
  error: z.string().nullable(),
  warnings: z.array(z.string()),
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
      "Files more than one worker actually changed. Non-empty means nothing was " +
        "integrated and you must merge them yourself.",
    ),
  integrated: z
    .boolean()
    .describe(
      "Whether completed worker edits are now present in the requested workspace.",
    ),
  integrationSummary: z.string(),
  warnings: z.array(z.string()),
  reviewChecklist: z
    .array(z.string())
    .describe(
      "Batch-level integration and risk checks the parent orchestrator must still make.",
    ),
};

export type BatchOutput = z.infer<z.ZodObject<typeof delegateTasksOutputShape>>;
