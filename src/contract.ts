import { z } from "zod";
import { DEFAULT_EFFORT, EFFORTS, type Effort } from "./config.js";

/** Coarse shape of the delegated work. Helps Sol reason about effort. */
export const TASK_CATEGORIES = [
  "implementation",
  "tests",
  "bugfix",
  "refactor",
  "investigation",
  "chore",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** Terminal states a worker may report, and that the orchestrator may assign. */
export const STATUSES = ["PASS", "BLOCKED", "FAILED"] as const;
export type Status = (typeof STATUSES)[number];

/**
 * The task contract Sol fills in when delegating.
 *
 * Exported as a raw Zod shape because `McpServer.registerTool` takes a shape,
 * not a `z.object`.
 */
export const delegateTaskInputShape = {
  objective: z
    .string()
    .min(20, "objective must be a concrete, self-contained brief")
    .describe(
      "Single bounded implementation task, written so a worker with no access " +
        "to your conversation can execute it. State the what and the why.",
    ),

  effort: z
    .enum(EFFORTS)
    .default(DEFAULT_EFFORT)
    .describe(
      "Reasoning effort for the worker. medium = mechanical, high = default for " +
        "real implementation work, xhigh = subtle or cross-cutting, max = " +
        "genuinely hard problems only. Rate the DELEGATED TASK's own difficulty, " +
        "never the parent project's importance.",
    ),

  effortReason: z
    .string()
    .min(10)
    .describe(
      "One sentence justifying the effort in terms of this task's difficulty. " +
        "Required so effort selection stays deliberate.",
    ),

  taskCategory: z
    .enum(TASK_CATEGORIES)
    .optional()
    .describe(
      "Shape of the work. 'investigation' and 'bugfix' more often justify xhigh; " +
        "'chore' and 'tests' rarely do.",
    ),

  allowedFiles: z
    .array(z.string())
    .default([])
    .describe(
      "Glob patterns the worker may create or modify (e.g. 'src/auth/**'). " +
        "Empty means unrestricted, which is discouraged. Checked after the run.",
    ),

  forbiddenFiles: z
    .array(z.string())
    .default([])
    .describe(
      "Glob patterns the worker must not touch (e.g. 'package.json'). Takes " +
        "precedence over allowedFiles. Forbid the test files when tests are the " +
        "verification.",
    ),

  acceptanceCriteria: z
    .array(z.string().min(1))
    .min(1, "at least one acceptance criterion is required")
    .describe(
      "Observable, checkable conditions that define done — something you can " +
        "confirm by reading the diff or running a command.",
    ),

  verificationCommands: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Shell-free commands proving the work (e.g. 'npm test', 'pytest -q'). The " +
        "worker runs them AND the orchestrator independently re-runs them after " +
        "the worker exits; the orchestrator's exit codes are authoritative. " +
        "Only allowlisted executables run, and pipes/redirects/&&/; are refused.",
    ),

  workingDirectory: z
    .string()
    .optional()
    .describe(
      "Absolute path the worker operates in. Defaults to the orchestrator's " +
        "current working directory.",
    ),

  context: z
    .string()
    .optional()
    .describe(
      "Background the worker cannot infer from the repo: prior decisions, " +
        "constraints, gotchas, relevant files.",
    ),

  contextCapsule: z
    .object({
      relevantContext: z
        .string()
        .optional()
        .describe(
          "Background the worker cannot infer from the repo: constraints, gotchas, relevant files.",
        ),
      interfaces: z
        .string()
        .optional()
        .describe("Signatures, contracts, or boundaries the worker must not break."),
      dependencies: z
        .string()
        .optional()
        .describe("Services, libraries, or internal modules this work depends on."),
      invariants: z
        .string()
        .optional()
        .describe("Rules that must remain true (e.g. 'auth must precede routing')."),
      upstreamDecisions: z
        .string()
        .optional()
        .describe("Architecture or design decisions already settled by the supervisor."),
      knownPitfalls: z
        .string()
        .optional()
        .describe("Mistakes to avoid, especially those seen in previous attempts."),
    })
    .optional()
    .describe(
      "Optional structured context giving the worker a richer brief: selected " +
        "relevant information rather than a dump of your whole session. Every " +
        "field is optional and empty fields are omitted from the worker's prompt.",
    ),

  resultDetail: z
    .enum(["full", "compact"])
    .default("full")
    .describe(
      "full (default) = every field, including the stdout/stderr of verification " +
        "commands that passed. compact = the same packet with the output of passed " +
        "commands dropped; verdicts, discrepancies, scope violations and the output " +
        "of failing or refused commands are always kept.",
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
      "Escalation history for this same objective. Supply it when re-delegating " +
        "after a FAILED or BLOCKED result: the worker sees what already failed, " +
        "and the orchestrator reports the attempt number back to you.",
    ),

  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(7200)
    .optional()
    .describe("Wall-clock budget for the worker turn. Defaults to 1800."),
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

/** Shape of what `delegate_task` returns to Sol. */
export const delegateTaskOutputShape = {
  verdict: z
    .enum(STATUSES)
    .describe(
      "Orchestrator's verdict, derived from independently re-run verification " +
        "and scope checks — NOT copied from the worker's claim.",
    ),
  workerClaimedStatus: z
    .enum(STATUSES)
    .describe("What the worker reported. Compare against `verdict`."),
  trustworthy: z
    .boolean()
    .describe(
      "False when the worker's claim conflicts with observed evidence. False " +
        "demands a careful diff review before accepting anything.",
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
      "Union of edits observed by the Codex runtime and edits the worker " +
        "claimed. `observed: false` means the runtime saw no such patch.",
    ),
  verification: z
    .array(
      z.object({
        command: z.string(),
        source: z
          .enum(["orchestrator", "worker"])
          .describe("`orchestrator` results are ground truth."),
        execution: z
          .enum(["argv", "shell", "rejected", "skipped", "reported"])
          .describe(
            "How the orchestrator ran it. `argv` = no shell (normal). " +
              "`rejected` = refused by policy and NOT run. `skipped` = " +
              "verification disabled. `reported` = the worker's own claim, not " +
              "executed here. Only argv/shell rows prove anything.",
          ),
        exitCode: z.number().nullable(),
        passed: z.boolean(),
        output: z.string(),
      }),
    )
    .describe("Verification outcomes. Prefer `source: orchestrator` rows."),
  verificationMode: z
    .string()
    .describe("Execution policy in force: allowlist, off, or shell."),
  scopeViolations: z
    .array(z.string())
    .describe(
      "Files touched outside allowedFiles, inside forbiddenFiles, or outside the workspace.",
    ),
  discrepancies: z
    .array(z.string())
    .describe(
      "Concrete mismatches between the worker's claims and observed reality. " +
        "Non-empty means do not accept the result as-is.",
    ),
  reviewChecklist: z
    .array(z.string())
    .describe("What you, Sol, must still check yourself before accepting."),
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
  effort: delegateTaskInputShape.effort,
  effortReason: delegateTaskInputShape.effortReason,
  taskCategory: delegateTaskInputShape.taskCategory,
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
      "parallel = tasks are independent; each runs in its own git worktree and " +
        "results are integrated afterwards. sequential = tasks may depend on each " +
        "other; they share the workspace and run one at a time, so a later task " +
        "sees the earlier one's changes.",
    ),

  resultDetail: delegateTaskInputShape.resultDetail,

  tasks: z
    .array(batchTaskShape)
    .min(1)
    .describe(
      "Task contracts. For parallel mode give each a disjoint allowedFiles scope; " +
        "overlapping scopes are rejected unless you opt in.",
    ),

  workingDirectory: z
    .string()
    .optional()
    .describe("Absolute path. Defaults to the orchestrator's working directory."),

  allowOverlappingScopes: z
    .boolean()
    .default(false)
    .describe(
      "Run in parallel even when two tasks could touch the same files. Off by " +
        "default because the result then depends on which worker finishes last.",
    ),

  integrate: z
    .boolean()
    .default(true)
    .describe(
      "Parallel mode only. Copy each worker's changes back into the workspace when " +
        "no two workers touched the same file. Set false to review the worktrees " +
        "yourself before anything moves.",
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
    .describe("Full single-task result, or null if the task never ran."),
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
    .describe("Whether worker changes are now present in the workspace."),
  integrationSummary: z.string(),
  warnings: z.array(z.string()),
  reviewChecklist: z.array(z.string()),
};

export type BatchOutput = z.infer<z.ZodObject<typeof delegateTasksOutputShape>>;
