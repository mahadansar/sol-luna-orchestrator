import {
  Codex,
  type Input,
  type ThreadEvent,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import {
  DEFAULT_TIMEOUT_SECONDS,
  LUNA_MODEL,
  MAX_PARALLEL,
  ORCHESTRATOR_SERVER_NAME,
  VERIFY_MODE,
  WORKER_MARKER_ENV,
  WORKER_NETWORK_ACCESS,
  WORKER_SANDBOX,
  asSdkEffort,
} from "./config.js";
import { resolveWorkspace } from "./workspace.js";
import type {
  DelegateTaskInput,
  DelegateTaskOutput,
  Status,
  WorkerReport,
} from "./contract.js";
import { workerOutputJsonSchema } from "./contract.js";
import { buildWorkerPrompt } from "./prompt.js";
import { findScopeViolations, toRelativePosix } from "./scope.js";
import { runVerifications, truncate, type VerificationRun } from "./verify.js";

/**
 * Global cap on concurrently running workers.
 *
 * Shared by both tools so a single delegation and a parallel batch cannot
 * together exceed the configured limit. Callers wait for a slot rather than
 * failing: a queued task is far less annoying than a spurious error, and the
 * MCP tool timeout still bounds the wait.
 */
class Semaphore {
  private available: number;
  private readonly waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.createRelease();
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    return this.createRelease();
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.available += 1;
      }
    };
  }
}

export const workerSlots = new Semaphore(MAX_PARALLEL);

export interface ObservedRun {
  threadId: string | null;
  finalResponse: string;
  filesChanged: Array<{ path: string; kind: string }>;
  errors: string[];
  usage: DelegateTaskOutput["usage"];
  timedOut: boolean;
  cancelled: boolean;
}

interface WorkerThread {
  readonly id: string | null;
  runStreamed(
    input: Input,
    options?: TurnOptions,
  ): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

/** Small seam for deterministic lifecycle tests; production uses the SDK Codex client. */
export interface WorkerCodex {
  startThread(options: ThreadOptions): WorkerThread;
  resumeThread(id: string, options: ThreadOptions): WorkerThread;
}

/**
 * Drive one Luna thread to completion, recording what the Codex runtime
 * actually observed rather than only what the model says it did.
 */
async function runWorkerThread(
  input: DelegateTaskInput,
  workingDirectory: string,
  timeoutSeconds: number,
  externalSignal?: AbortSignal,
  options: {
    resumeThreadId?: string;
    continuationInstruction?: string;
    codex?: WorkerCodex;
  } = {},
): Promise<ObservedRun> {
  // Two independent guards stop a worker from delegating recursively:
  //
  //  1. Disable this orchestrator for the worker's Codex process. The SDK
  //     flattens this to `--config mcp_servers.<name>.enabled=false`, which
  //     prevents Codex from even spawning the server. (An `mcp_servers={}`
  //     override does NOT work — Codex merges it into the existing table and
  //     every server still starts.)
  //  2. Mark the worker's environment. A server instance that starts with the
  //     marker set refuses to serve `delegate_task`, so isolation survives the
  //     server being registered under an unexpected name.
  const workerEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) workerEnv[key] = value;
  }
  workerEnv[WORKER_MARKER_ENV] = "1";

  const codex: WorkerCodex =
    options.codex ??
    new Codex({
      env: workerEnv,
      config: {
        mcp_servers: { [ORCHESTRATOR_SERVER_NAME]: { enabled: false } },
      },
    });

  const threadOptions: ThreadOptions = {
    model: LUNA_MODEL,
    modelReasoningEffort: asSdkEffort(input.effort),
    sandboxMode: WORKER_SANDBOX,
    workingDirectory,
    skipGitRepoCheck: true,
    networkAccessEnabled: WORKER_NETWORK_ACCESS,
    // The worker runs unattended: there is no human to answer a prompt.
    approvalPolicy: "never",
  };
  const thread = options.resumeThreadId
    ? codex.resumeThread(options.resumeThreadId, threadOptions)
    : codex.startThread(threadOptions);

  const observed: ObservedRun = {
    threadId: null,
    finalResponse: "",
    filesChanged: [],
    errors: [],
    usage: null,
    timedOut: false,
    cancelled: false,
  };

  const seenPaths = new Set<string>();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    observed.timedOut = true;
    controller.abort();
  }, timeoutSeconds * 1000);

  // A cancelled batch, or a client that hung up, must stop the worker too. The
  // SDK forwards this signal to `spawn`, which kills the codex child process.
  const onExternalAbort = (): void => {
    observed.cancelled = true;
    controller.abort();
  };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const { events } = await thread.runStreamed(
      buildWorkerPrompt(input, workingDirectory, options.continuationInstruction),
      { outputSchema: workerOutputJsonSchema, signal: controller.signal },
    );

    for await (const event of events as AsyncGenerator<ThreadEvent>) {
      switch (event.type) {
        case "thread.started":
          observed.threadId = event.thread_id;
          break;

        case "item.completed": {
          const item = event.item;
          if (item.type === "file_change") {
            for (const change of item.changes) {
              const key = `${change.kind}:${change.path}`;
              if (seenPaths.has(key)) continue;
              seenPaths.add(key);
              observed.filesChanged.push({ path: change.path, kind: change.kind });
            }
          } else if (item.type === "agent_message") {
            observed.finalResponse = item.text;
          } else if (item.type === "error") {
            observed.errors.push(item.message);
          }
          break;
        }

        case "turn.completed":
          observed.usage = {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            ...(event.usage.cache_write_input_tokens === undefined
              ? {}
              : { cacheWriteInputTokens: event.usage.cache_write_input_tokens }),
            outputTokens: event.usage.output_tokens,
            reasoningOutputTokens: event.usage.reasoning_output_tokens,
          };
          break;

        case "turn.failed":
          observed.errors.push(`Turn failed: ${event.error.message}`);
          break;

        case "error":
          observed.errors.push(event.message);
          break;

        default:
          break;
      }
    }
  } catch (error) {
    if (observed.timedOut) {
      observed.errors.push(
        `Worker exceeded its ${timeoutSeconds}s budget and was aborted.`,
      );
    } else if (observed.cancelled) {
      observed.errors.push("Worker was cancelled before it finished.");
    } else {
      observed.errors.push(`Worker thread error: ${(error as Error).message}`);
    }
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    observed.threadId ??= thread.id;
  }

  return observed;
}

/** Parse Luna's final message, tolerating stray prose around the JSON object. */
export function parseWorkerReport(finalResponse: string): WorkerReport | null {
  const text = finalResponse.trim();
  if (!text) return null;

  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const braced = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (braced.startsWith("{")) candidates.push(braced);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<WorkerReport>;
      if (!parsed || typeof parsed !== "object" || !parsed.status) continue;
      return {
        status: parsed.status,
        summary: parsed.summary ?? "",
        filesChanged: parsed.filesChanged ?? [],
        verification: parsed.verification ?? [],
        notes: parsed.notes ?? "",
        followUps: parsed.followUps ?? [],
      };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const CHANGE_KIND_ALIASES: Record<string, string> = {
  added: "add",
  add: "add",
  a: "add",
  "??": "add",
  "?": "add",
  modified: "update",
  update: "update",
  m: "update",
  r: "update",
  c: "update",
  deleted: "delete",
  delete: "delete",
  d: "delete",
};

const normalizeKind = (kind: string): string =>
  CHANGE_KIND_ALIASES[kind.toLowerCase()] ?? kind.toLowerCase();

export interface AnalysisParams {
  input: DelegateTaskInput;
  workingDirectory: string;
  observed: ObservedRun;
  /** Results of the orchestrator re-running the verification commands. */
  orchestratorRuns: VerificationRun[];
  durationSeconds: number;
}

/**
 * Turn raw observations into the supervisor-facing report.
 *
 * Pure and side-effect free: everything it needs has already been measured.
 * This is where a worker's claims get checked against evidence, so it is the
 * part most worth testing directly.
 */
export function buildDelegationResult({
  input,
  workingDirectory,
  observed,
  orchestratorRuns,
  durationSeconds,
}: AnalysisParams): DelegateTaskOutput {
  const report = parseWorkerReport(observed.finalResponse);
  // The schema default keeps legacy callers safe even if they construct an
  // input object without parsing it first.
  const changeIntent = input.changeIntent ?? "required";

  const errors = [...observed.errors];
  if (!report && observed.finalResponse) {
    errors.push(
      "Worker's final message was not valid JSON matching the required schema.",
    );
  }
  if (!report && !observed.finalResponse) {
    errors.push("Worker produced no final message.");
  }

  const workerClaimedStatus: Status = report?.status ?? "FAILED";

  // --- Merge observed edits with claimed edits -----------------------------
  const observedRelative = new Map<string, string>();
  for (const change of observed.filesChanged) {
    observedRelative.set(
      toRelativePosix(change.path, workingDirectory),
      normalizeKind(change.kind),
    );
  }

  const filesChanged: DelegateTaskOutput["filesChanged"] = [];
  const claimedRelative = new Set<string>();
  for (const claim of report?.filesChanged ?? []) {
    const relative = toRelativePosix(claim.path, workingDirectory);
    claimedRelative.add(relative);
    filesChanged.push({
      path: relative,
      kind: observedRelative.get(relative) ?? normalizeKind(claim.change),
      why: claim.why,
      observed: observedRelative.has(relative),
    });
  }
  for (const [relative, kind] of observedRelative) {
    if (claimedRelative.has(relative)) continue;
    filesChanged.push({
      path: relative,
      kind,
      why: UNCLAIMED_FILE,
      observed: true,
    });
  }

  // --- Verification results ------------------------------------------------
  // Orchestrator-run rows come first: they are the authoritative ones.
  const verification: DelegateTaskOutput["verification"] = [];
  for (const run of orchestratorRuns) {
    verification.push({ ...run, source: "orchestrator" });
  }
  for (const claim of report?.verification ?? []) {
    verification.push({
      command: claim.command,
      source: "worker",
      execution: "reported",
      exitCode: claim.exitCode ?? null,
      passed: claim.passed,
      output: truncate(claim.evidence ?? ""),
    });
  }

  // --- Scope enforcement ---------------------------------------------------
  // Scope is an observation-backed contract. A claimed-only path is already a
  // discrepancy, but it cannot prove that the worker actually crossed the
  // boundary or make the authoritative verdict fail by itself.
  const touched = [...observedRelative.keys()];
  const scopeViolations = findScopeViolations(
    touched,
    input.allowedFiles,
    input.forbiddenFiles,
    workingDirectory,
  );

  // --- Cross-check claims against evidence ---------------------------------
  const discrepancies: string[] = [];

  const failedRuns = orchestratorRuns.filter((run) => !run.passed);
  if (workerClaimedStatus === "PASS" && failedRuns.length > 0) {
    discrepancies.push(
      `Worker claimed PASS but the orchestrator re-ran verification and ` +
        `${failedRuns.length} command(s) failed: ` +
        failedRuns.map((run) => `\`${run.command}\` (exit ${run.exitCode})`).join(", "),
    );
  }

  for (const run of orchestratorRuns) {
    const claim = report?.verification.find(
      (v) => v.command.trim() === run.command.trim(),
    );
    if (claim && claim.passed && !run.passed) {
      discrepancies.push(
        `Worker reported \`${run.command}\` as passing, but it exits ${run.exitCode} here.`,
      );
    }
  }

  const unobservedClaims = filesChanged.filter((file) => !file.observed);
  if (unobservedClaims.length > 0) {
    discrepancies.push(
      `Worker claimed edits the Codex runtime never recorded: ` +
        unobservedClaims.map((file) => file.path).join(", "),
    );
  }

  const observedChanges = filesChanged.filter((file) => file.observed);
  const changeIntentViolation =
    changeIntent === "forbidden" && observedChanges.length > 0;
  if (changeIntentViolation) {
    discrepancies.push(
      `Change intent contract violated: intent is forbidden, but the runtime ` +
        `observed edits in ${observedChanges.map((file) => file.path).join(", ")}.`,
    );
  }

  if (
    workerClaimedStatus === "PASS" &&
    filesChanged.length === 0 &&
    changeIntent === "required"
  ) {
    discrepancies.push(
      "Worker claimed PASS but no file changes were recorded. Confirm the task " +
        "genuinely required no edits.",
    );
  }

  if (scopeViolations.length > 0) {
    discrepancies.push(`File scope was violated: ${scopeViolations.join("; ")}`);
  }

  // A command the policy refused proves nothing, so a PASS resting on it is
  // unsupported rather than merely unverified.
  const refusedRuns = orchestratorRuns.filter(
    (run) => run.execution === "rejected" || run.execution === "skipped",
  );
  if (workerClaimedStatus === "PASS" && refusedRuns.length > 0) {
    discrepancies.push(
      `Verification did not actually run for ${refusedRuns.length} command(s): ` +
        refusedRuns.map((run) => `\`${run.command}\` (${run.execution})`).join(", ") +
        `. The worker's PASS is unverified for those.`,
    );
  }

  if (
    workerClaimedStatus === "PASS" &&
    input.verificationCommands.length > 0 &&
    orchestratorRuns.length === 0 &&
    (report?.verification.length ?? 0) === 0
  ) {
    discrepancies.push(
      "Worker claimed PASS but reported no verification results for the " +
        "commands it was given.",
    );
  }

  // --- Verdict -------------------------------------------------------------
  // Ordering matters: a real execution failure outranks a policy refusal.
  let verdict: Status = workerClaimedStatus;
  if (errors.length > 0 || observed.timedOut) {
    verdict = "FAILED";
  } else if (
    failedRuns.some((run) => run.execution === "argv" || run.execution === "shell")
  ) {
    verdict = "FAILED";
  } else if (scopeViolations.length > 0) {
    // The code may be fine, but the contract was broken. The parent decides.
    verdict = "FAILED";
  } else if (changeIntentViolation) {
    // A forbidden edit is a contract violation even when it stayed in scope.
    verdict = "FAILED";
  }

  const reviewChecklist = buildReviewChecklist(
    input,
    verdict,
    workerClaimedStatus,
    discrepancies,
    orchestratorRuns,
    filesChanged,
  );

  return {
    changeIntent,
    verdict,
    workerClaimedStatus,
    trustworthy: discrepancies.length === 0 && errors.length === 0,
    workerThreadId: observed.threadId,
    continuationReference: null,
    repair: null,
    model: LUNA_MODEL,
    effort: input.effort,
    effortReason: input.effortReason,
    attempt: input.previousAttempts.length + 1,
    summary: report?.summary ?? truncate(observed.finalResponse) ?? "",
    notes: report?.notes ?? "",
    followUps: report?.followUps ?? [],
    filesChanged,
    verification,
    verificationMode: VERIFY_MODE,
    scopeViolations,
    discrepancies,
    reviewChecklist,
    escalationAdvice: buildEscalationAdvice(input, verdict, observed, scopeViolations),
    durationSeconds,
    usage: observed.usage,
    errors,
  };
}

/**
 * Reconcile the final git view of an isolated worktree with the worker result.
 *
 * A parallel worker has two evidence sources: the Codex runtime's file-change
 * items and the worktree's final git status. Git is authoritative for what can
 * be integrated, so runtime-only changes are downgraded to unexplained claims
 * and every git-observed path is represented in the nested result before the
 * batch decides conflicts, cleanup, or review guidance.
 */
export function reconcileParallelWorktreeEvidence(
  input: DelegateTaskInput,
  result: DelegateTaskOutput,
  workingDirectory: string,
  changes: Array<{ path: string; kind: string }>,
  evidenceError?: string,
): DelegateTaskOutput {
  const changeIntent = input.changeIntent ?? "required";
  const runtimeObserved = new Set(
    result.filesChanged
      .filter((file) => file.observed)
      .map((file) => toRelativePosix(file.path, workingDirectory)),
  );
  const gitChanges = new Map<string, string>();
  for (const change of changes) {
    gitChanges.set(
      toRelativePosix(change.path, workingDirectory),
      normalizeKind(change.kind),
    );
  }

  const runtimeOnly = evidenceError
    ? new Set<string>()
    : new Set(
        result.filesChanged
          .filter((file) => file.observed)
          .map((file) => toRelativePosix(file.path, workingDirectory))
          .filter((file) => !gitChanges.has(file)),
      );

  const filesChanged = result.filesChanged.map((file) => {
    const relative = toRelativePosix(file.path, workingDirectory);
    const gitKind = gitChanges.get(relative);
    if (evidenceError || gitKind === undefined) {
      if (!evidenceError && runtimeOnly.has(relative) && file.observed) {
        return { ...file, path: relative, observed: false };
      }
      return { ...file, path: relative };
    }
    return { ...file, path: relative, kind: gitKind, observed: true };
  });

  if (!evidenceError) {
    for (const [relative, kind] of gitChanges) {
      if (filesChanged.some((file) => file.path === relative)) continue;
      filesChanged.push({
        path: relative,
        kind,
        why: UNCLAIMED_FILE,
        observed: true,
      });
    }
  }

  const evidenceDiscrepancy =
    /^(Worker claimed edits the Codex runtime never recorded:|Runtime-observed edits were not present in the final worktree:|Change intent contract violated:|Worker claimed PASS but no file changes were recorded\.|File scope was violated:|Worktree evidence scan failed:)/;
  const discrepancies = result.discrepancies.filter(
    (detail) => !evidenceDiscrepancy.test(detail),
  );
  const errors = [...result.errors];

  if (evidenceError) {
    const detail = `Worktree evidence scan failed: ${evidenceError}`;
    errors.push(detail);
    discrepancies.push(detail);
  }

  const unobservedClaims = filesChanged.filter(
    (file) => !file.observed && !runtimeOnly.has(file.path),
  );
  if (unobservedClaims.length > 0) {
    discrepancies.push(
      `Worker claimed edits the Codex runtime never recorded: ${unobservedClaims
        .map((file) => file.path)
        .join(", ")}`,
    );
  }
  if (runtimeOnly.size > 0) {
    discrepancies.push(
      `Runtime-observed edits were not present in the final worktree: ${[...runtimeOnly].join(", ")}`,
    );
  }

  // Final Git state decides what can be integrated, but it must not erase the
  // fact that the runtime saw an edit. In particular, read-only intent is
  // immutable even when a worker later reverts the file before exiting.
  const observedChangePaths = new Set(
    filesChanged.filter((file) => file.observed).map((file) => file.path),
  );
  for (const file of runtimeObserved) observedChangePaths.add(file);
  const changeIntentViolation =
    changeIntent === "forbidden" && observedChangePaths.size > 0;
  if (changeIntentViolation) {
    discrepancies.push(
      `Change intent contract violated: intent is forbidden, but the runtime ` +
        `observed edits in ${[...observedChangePaths].join(", ")}.`,
    );
  }

  if (
    result.workerClaimedStatus === "PASS" &&
    filesChanged.length === 0 &&
    changeIntent === "required"
  ) {
    discrepancies.push(
      "Worker claimed PASS but no file changes were recorded. Confirm the task " +
        "genuinely required no edits.",
    );
  }

  const scopeViolations = findScopeViolations(
    [...observedChangePaths],
    input.allowedFiles,
    input.forbiddenFiles,
    workingDirectory,
  );
  if (scopeViolations.length > 0) {
    discrepancies.push(`File scope was violated: ${scopeViolations.join("; ")}`);
  }

  let verdict = result.verdict;
  const failedRuns = result.verification.filter(
    (run) =>
      run.source === "orchestrator" &&
      !run.passed &&
      (run.execution === "argv" || run.execution === "shell"),
  );
  if (
    errors.length > 0 ||
    failedRuns.length > 0 ||
    scopeViolations.length > 0 ||
    changeIntentViolation
  ) {
    verdict = "FAILED";
  }

  const escalationAdvice =
    scopeViolations.length > 0
      ? "The worker went outside its file scope. Effort is not the problem. Either widen allowedFiles deliberately, or restate the objective so the work fits the scope you intended."
      : evidenceError
        ? "Final worktree evidence could not be read. Preserve and inspect the retained worktree, then repair the environment or Git state before retrying."
        : changeIntentViolation
          ? "The worker violated the immutable read-only change intent. Inspect the retained evidence and restate or re-scope the task rather than raising effort."
          : result.escalationAdvice;

  const repair =
    result.repair && !result.repair.attempted && scopeViolations.length > 0
      ? {
          ...result.repair,
          classification: "scope-or-conflict" as const,
          reason:
            "Final Git worktree evidence revealed a scope violation, so automatic repair is not permitted.",
        }
      : result.repair && !result.repair.attempted && evidenceError
        ? {
            ...result.repair,
            classification: "environment-or-tooling" as const,
            reason:
              "Final Git worktree evidence could not be read, so automatic repair is not permitted.",
          }
        : result.repair?.attempted && result.verdict === "PASS" && verdict !== "PASS"
          ? {
              ...result.repair,
              reason:
                "The automatic repair turn completed, but final Git evidence overturned its provisional PASS; control returns to the parent.",
            }
          : result.repair;

  return {
    ...result,
    changeIntent,
    verdict,
    trustworthy: discrepancies.length === 0 && errors.length === 0,
    filesChanged,
    scopeViolations,
    discrepancies,
    errors,
    repair,
    escalationAdvice,
    reviewChecklist: buildReviewChecklist(
      input,
      verdict,
      result.workerClaimedStatus,
      discrepancies,
      result.verification.filter(
        (run) => run.source === "orchestrator" && run.execution !== "reported",
      ) as VerificationRun[],
      filesChanged,
    ),
  };
}

/**
 * Execute a delegated task end to end: run the worker, independently verify,
 * then assemble the report.
 */
export interface ExecuteOptions {
  /** Directory the worker runs in. Already validated by the caller. */
  workingDirectory: string;
  signal?: AbortSignal;
  onVerificationStart?: (commandCount: number) => void;
  /** Existing Codex thread to resume; omitted for a fresh delegation. */
  resumeThreadId?: string;
  /** Explicit follow-up instruction for a resumed thread. */
  continuationInstruction?: string;
  /** Test seam for the worker lifecycle; production creates the SDK client. */
  codex?: WorkerCodex;
  /** Manual continuation disables this even when the original contract opted in. */
  allowAutomaticRepair?: boolean;
  onRepairStart?: (classification: string) => void;
  onRepairComplete?: (verdict: Status) => void;
}

/** Optional lifecycle hooks used by the single-task MCP surface. */
export interface DelegateHooks {
  onStarted?: (workingDirectory: string) => void;
  onVerificationStart?: (commandCount: number) => void;
  onRepairStart?: (classification: string) => void;
  onRepairComplete?: (verdict: Status) => void;
}

/**
 * Run one task in an already-prepared directory.
 *
 * Owns no concurrency accounting and no workspace validation, so both the
 * single-task tool and the batch runner can share it.
 */
interface TaskTurn {
  observed: ObservedRun;
  orchestratorRuns: VerificationRun[];
  durationSeconds: number;
}

async function executeTaskTurn(
  input: DelegateTaskInput,
  options: ExecuteOptions,
): Promise<TaskTurn> {
  const startedAt = Date.now();
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const { workingDirectory, signal } = options;

  const observed = await runWorkerThread(
    input,
    workingDirectory,
    timeoutSeconds,
    signal,
    {
      resumeThreadId: options.resumeThreadId,
      continuationInstruction: options.continuationInstruction,
      codex: options.codex,
    },
  );

  // Re-run the checks ourselves, after the worker has exited, so a PASS is
  // falsifiable rather than self-certified. Skipped when the run was cancelled:
  // there is nothing meaningful to verify and the caller is shutting down.
  let orchestratorRuns: VerificationRun[] = [];
  if (input.verificationCommands.length > 0 && !observed.cancelled) {
    options.onVerificationStart?.(input.verificationCommands.length);
    orchestratorRuns = await runVerifications(
      input.verificationCommands,
      workingDirectory,
    );
  }

  return {
    observed,
    orchestratorRuns,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

type RepairDecision = NonNullable<DelegateTaskOutput["repair"]>;

const repairDecision = (
  classification: RepairDecision["classification"],
  reason: string,
  failureEvidence: RepairDecision["failureEvidence"] = [],
): RepairDecision => ({
  requested: true,
  attempted: false,
  classification,
  reason,
  failureEvidence,
});

const ENVIRONMENT_FAILURE =
  /(?:failed to launch|command not found|not recognized as an internal|ENOENT|is not installed|timed out|module not found|cannot find module|could not resolve host|network|permission denied|access is denied)/i;
const TRUST_BOUNDARY_FAILURE =
  /(?:refused by verification policy|outside (?:the )?workspace|sandbox violation|unsafe command|not in the verification allowlist)/i;

/** Decide conservatively whether one automatic same-thread repair is safe. */
export function classifyRepairEligibility(
  input: DelegateTaskInput,
  result: DelegateTaskOutput,
): RepairDecision {
  if (!input.automaticRepair) {
    return {
      requested: false,
      attempted: false,
      classification: "not-requested",
      reason: "Automatic repair was not requested.",
      failureEvidence: [],
    };
  }
  if (input.changeIntent === "forbidden") {
    return repairDecision(
      "read-only",
      "The immutable change intent forbids edits, so repair cannot convert this task into editing work.",
    );
  }
  if (result.scopeViolations.length > 0) {
    return repairDecision(
      "scope-or-conflict",
      "Scope violations require parent review and cannot be repaired automatically.",
    );
  }
  if (result.errors.length > 0) {
    return repairDecision(
      "environment-or-tooling",
      "Runtime, timeout, cancellation, or worker-tool errors require parent review.",
    );
  }
  if (!result.workerThreadId) {
    return repairDecision(
      "environment-or-tooling",
      "No resumable worker thread was observed, so same-thread repair is unavailable.",
    );
  }

  const authoritative = result.verification.filter(
    (run) => run.source === "orchestrator",
  );
  if (
    authoritative.some(
      (run) => run.execution === "rejected" || run.execution === "skipped",
    )
  ) {
    return repairDecision(
      "security-or-trust-boundary",
      "Verification was refused or disabled, so the trust boundary does not permit an automatic repair decision.",
    );
  }
  if (result.verdict === "PASS") {
    return repairDecision("not-needed", "The initial result passed.");
  }
  if (result.workerClaimedStatus !== "PASS") {
    return repairDecision(
      "contract-or-requirement",
      "The worker did not claim completion; the parent must resolve the implementation or requirement failure.",
    );
  }

  const failed = authoritative.filter(
    (run) => !run.passed && (run.execution === "argv" || run.execution === "shell"),
  );
  if (failed.length !== 1) {
    return repairDecision(
      "contract-or-requirement",
      "Automatic repair requires exactly one concrete authoritative verification failure.",
    );
  }

  const failure = failed[0]!;
  const failureText = `${failure.command}\n${failure.output}`;
  if (TRUST_BOUNDARY_FAILURE.test(failureText)) {
    return repairDecision(
      "security-or-trust-boundary",
      "The verification evidence touches a security or trust boundary.",
    );
  }
  if (failure.exitCode === null || ENVIRONMENT_FAILURE.test(failureText)) {
    return repairDecision(
      "environment-or-tooling",
      "The verification evidence indicates an environment or tooling failure.",
    );
  }

  const observedEdits = result.filesChanged.filter((file) => file.observed);
  if (observedEdits.length === 0) {
    return repairDecision(
      "wider-scope",
      "No implementation edit was observed, so locality is not established.",
    );
  }
  const unrelatedDiscrepancy = result.discrepancies.some(
    (item) =>
      !item.startsWith("Worker claimed PASS but the orchestrator re-ran verification") &&
      !item.startsWith("Worker reported `"),
  );
  if (unrelatedDiscrepancy) {
    return repairDecision(
      "contract-or-requirement",
      "Claims, observed edits, or the contract disagree beyond the verification failure.",
    );
  }

  return repairDecision(
    "local-verification",
    "One authoritative verification failure followed an in-scope implementation edit.",
    [
      {
        command: failure.command,
        execution: failure.execution === "shell" ? "shell" : "argv",
        exitCode: failure.exitCode,
        output: truncate(failure.output, 4_000),
      },
    ],
  );
}

/** Build the only extra context supplied to an automatic repair turn. */
export function buildRepairInstruction(decision: RepairDecision): string {
  return [
    "Repair the local defect caught by independent verification.",
    "This is the only automatic repair turn. Keep the original objective, scope, change intent, acceptance criteria, and verification commands unchanged.",
    "Use only the authoritative failure evidence below; do not widen the task:",
    JSON.stringify(decision.failureEvidence),
  ].join("\n");
}

export function mergeUsage(
  first: DelegateTaskOutput["usage"],
  second: DelegateTaskOutput["usage"],
): DelegateTaskOutput["usage"] {
  if (!first) return second;
  if (!second) return first;
  const cacheWriteInputTokens =
    first.cacheWriteInputTokens === undefined ||
    second.cacheWriteInputTokens === undefined
      ? undefined
      : first.cacheWriteInputTokens + second.cacheWriteInputTokens;
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    cachedInputTokens: first.cachedInputTokens + second.cachedInputTokens,
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    outputTokens: first.outputTokens + second.outputTokens,
    reasoningOutputTokens: first.reasoningOutputTokens + second.reasoningOutputTokens,
  };
}

function mergeRepairReport(firstResponse: string, repairResponse: string): string {
  const first = parseWorkerReport(firstResponse);
  const repair = parseWorkerReport(repairResponse);
  if (!first || !repair) return repairResponse;

  const files = new Map(first.filesChanged.map((file) => [file.path, file]));
  for (const file of repair.filesChanged) files.set(file.path, file);
  return JSON.stringify({ ...repair, filesChanged: [...files.values()] });
}

/** Execute a fresh or resumed task, with at most one opted-in automatic repair. */
export async function executeTask(
  input: DelegateTaskInput,
  options: ExecuteOptions,
): Promise<DelegateTaskOutput> {
  const initialTurn = await executeTaskTurn(input, options);
  const initial = buildDelegationResult({
    input,
    workingDirectory: options.workingDirectory,
    ...initialTurn,
  });
  const allowRepair = options.allowAutomaticRepair ?? input.automaticRepair ?? false;
  if (!allowRepair) return initial;

  const decision = classifyRepairEligibility(input, initial);
  initial.repair = decision;
  if (decision.classification !== "local-verification" || !initial.workerThreadId) {
    return initial;
  }

  options.onRepairStart?.(decision.classification);
  const repairTurn = await executeTaskTurn(input, {
    ...options,
    allowAutomaticRepair: false,
    resumeThreadId: initial.workerThreadId,
    continuationInstruction: buildRepairInstruction(decision),
  });
  const observed: ObservedRun = {
    ...repairTurn.observed,
    finalResponse: mergeRepairReport(
      initialTurn.observed.finalResponse,
      repairTurn.observed.finalResponse,
    ),
    filesChanged: [
      ...initialTurn.observed.filesChanged,
      ...repairTurn.observed.filesChanged,
    ],
    errors: [...initialTurn.observed.errors, ...repairTurn.observed.errors],
    usage: mergeUsage(initialTurn.observed.usage, repairTurn.observed.usage),
  };
  if (repairTurn.observed.threadId !== initial.workerThreadId) {
    observed.errors.push(
      "Automatic repair did not preserve the original worker thread identity.",
    );
  }
  const repaired = buildDelegationResult({
    input,
    workingDirectory: options.workingDirectory,
    observed,
    orchestratorRuns: repairTurn.orchestratorRuns,
    durationSeconds: initialTurn.durationSeconds + repairTurn.durationSeconds,
  });
  repaired.repair = {
    ...decision,
    attempted: true,
    reason:
      repaired.verdict === "PASS"
        ? "The one automatic repair turn completed and normal classification passed."
        : "The one automatic repair turn completed without passing; the repair limit is exhausted and control returns to the parent.",
  };
  options.onRepairComplete?.(repaired.verdict);
  return repaired;
}

/**
 * Execute a single delegated task end to end, taking one concurrency slot.
 *
 * Runs directly in the workspace, as it always has: a lone worker has nothing
 * to collide with, so the cost and git requirements of a worktree buy nothing.
 */
export async function delegateToLuna(
  input: DelegateTaskInput,
  signal?: AbortSignal,
  hooks?: DelegateHooks,
): Promise<DelegateTaskOutput> {
  // Validate and canonicalise before the worker gets write access to it.
  const workingDirectory = resolveWorkspace(input.workingDirectory);
  const release = await workerSlots.acquire();
  try {
    hooks?.onStarted?.(workingDirectory);
    return await executeTask(input, {
      workingDirectory,
      signal,
      onVerificationStart: hooks?.onVerificationStart,
      onRepairStart: hooks?.onRepairStart,
      onRepairComplete: hooks?.onRepairComplete,
    });
  } finally {
    release();
  }
}

/** Resume one eligible worker thread for exactly one explicit follow-up turn. */
export async function continueToLuna(
  input: DelegateTaskInput,
  options: {
    workingDirectory: string;
    threadId: string;
    instruction: string;
    signal?: AbortSignal;
    hooks?: DelegateHooks;
    codex?: WorkerCodex;
  },
): Promise<DelegateTaskOutput> {
  const workingDirectory = resolveWorkspace(options.workingDirectory);
  const release = await workerSlots.acquire();
  try {
    options.hooks?.onStarted?.(workingDirectory);
    return await executeTask(input, {
      workingDirectory,
      signal: options.signal,
      onVerificationStart: options.hooks?.onVerificationStart,
      resumeThreadId: options.threadId,
      continuationInstruction: options.instruction,
      codex: options.codex,
      allowAutomaticRepair: false,
    });
  } finally {
    release();
  }
}

const NEXT_EFFORT: Record<string, string | null> = {
  medium: "high",
  high: "xhigh",
  xhigh: "max",
  max: null,
};

/**
 * Say what to change before retrying.
 *
 * Raising effort is the last resort, not the first: a vague brief re-run at a
 * higher level usually fails again and costs more.
 */
function buildEscalationAdvice(
  input: DelegateTaskInput,
  verdict: Status,
  observed: ObservedRun,
  scopeViolations: string[],
): string | null {
  if (verdict === "PASS") return null;

  const attempt = input.previousAttempts.length + 1;
  const next = NEXT_EFFORT[input.effort];

  if (scopeViolations.length > 0) {
    return (
      "The worker went outside its file scope. Effort is not the problem. " +
      "Either widen allowedFiles deliberately, or restate the objective so the " +
      "work fits the scope you intended."
    );
  }

  if (observed.timedOut) {
    return (
      "The worker ran out of time rather than out of capability. Split the " +
      "objective into smaller tasks, or raise timeoutSeconds. Do not raise effort " +
      "for this — higher effort takes longer, not less."
    );
  }

  if (verdict === "BLOCKED") {
    return (
      "BLOCKED usually means the brief was incomplete, not that the task was too " +
      "hard. Read `notes`, supply what the worker was missing, and re-delegate at " +
      `the same effort (${input.effort}).`
    );
  }

  if (!next) {
    return (
      "This already ran at max effort. Higher effort is not available: decompose " +
      "the objective into smaller bounded tasks, or take it on yourself."
    );
  }

  return (
    `Attempt ${attempt} at ${input.effort} did not pass. First ask whether the ` +
    `brief was the problem — vague objectives fail again at higher effort, more ` +
    `expensively. If the brief was sound and the task was genuinely hard, ` +
    `re-delegate at ${next} and pass previousAttempts so the worker knows what ` +
    `already failed.`
  );
}

/**
 * Marks a file the orchestrator saw change that the worker never mentioned.
 * No discrepancy rule covers this, so the marker is the only carrier of the
 * signal — and an unexplained edit is a reason to look at the diff.
 */
export const UNCLAIMED_FILE = "(not mentioned in the worker's report)";

function buildReviewChecklist(
  input: DelegateTaskInput,
  verdict: Status,
  claimed: Status,
  discrepancies: string[],
  orchestratorRuns: VerificationRun[],
  filesChanged: DelegateTaskOutput["filesChanged"],
): string[] {
  const checklist: string[] = [];

  if (discrepancies.length > 0) {
    checklist.push(
      "Resolve every entry in `discrepancies` before accepting any part of this result.",
    );
  }
  if (discrepancies.some((item) => /change intent contract violated/i.test(item))) {
    checklist.push(
      "The forbidden change intent was violated by a runtime-observed edit; inspect the diff before accepting the result.",
    );
  }
  if (verdict !== claimed) {
    checklist.push(
      `The worker claimed ${claimed} but the orchestrator's verdict is ${verdict}. Read the diff before deciding.`,
    );
  }

  for (const criterion of input.acceptanceCriteria) {
    checklist.push(`Confirm acceptance criterion holds: ${criterion}`);
  }

  const executed = orchestratorRuns.filter(
    (run) => run.execution === "argv" || run.execution === "shell",
  );
  const notExecuted = orchestratorRuns.filter(
    (run) => run.execution === "rejected" || run.execution === "skipped",
  );

  if (input.verificationCommands.length > 0 && executed.length === 0) {
    checklist.push(
      "No verification command actually executed — re-run them yourself before trusting this.",
    );
  }
  for (const run of notExecuted) {
    checklist.push(
      `Verification \`${run.command}\` was ${run.execution === "rejected" ? "refused by policy" : "skipped"} and proves nothing.`,
    );
  }
  if (input.verificationCommands.length === 0) {
    checklist.push(
      "No verification commands were supplied, so nothing was proven mechanically. Verify by inspection or delegate a follow-up with commands.",
    );
  }

  const unclaimed = filesChanged.filter((file) => file.why === UNCLAIMED_FILE);
  for (const file of unclaimed) {
    checklist.push(
      `\`${file.path}\` changed but the worker never mentioned it — read that diff.`,
    );
  }

  // Whether to re-read the diff is the expensive part of accepting a result,
  // so it is asked for when something actually warrants it rather than every
  // time. A result that is PASS on the orchestrator's own re-run, with no
  // discrepancy, no refused or skipped command and no unexplained edit, has
  // already produced the evidence a diff re-read would be reconstructing.
  const clean =
    verdict === "PASS" &&
    claimed === "PASS" &&
    discrepancies.length === 0 &&
    notExecuted.length === 0 &&
    unclaimed.length === 0 &&
    (input.verificationCommands.length === 0 || executed.length > 0);

  if (clean) {
    checklist.push(
      "Judge whether the change is high-risk or architecturally significant, " +
        "and read the diff if it is. Verified mechanical checks do not make it good.",
    );
  } else {
    checklist.push(
      "Read the actual diff of every file in `filesChanged` — the worker's summary is a claim, not evidence.",
    );
    checklist.push(
      "Check the worker did not weaken tests, loosen types, or silence errors to reach PASS.",
    );
  }

  return checklist;
}
