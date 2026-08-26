import {
  Codex,
  type Input,
  type ThreadEvent,
  type ThreadOptions,
  type TurnOptions,
} from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
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
  AttemptEvidence,
  AttemptRole,
  AttemptTermination,
  DelegateTaskInput,
  DelegateTaskOutput,
  Effort,
  FailureDecision,
  Status,
  TaskState,
  UsageUnavailableReason,
  WorkerFailureCause,
  WorkerReport,
} from "./contract.js";
import { STATUSES, WORKER_FAILURE_CAUSES, workerOutputJsonSchema } from "./contract.js";
import { verificationCommandsEquivalent } from "./command.js";
import { buildWorkerPrompt } from "./prompt.js";
import { findScopeViolations, toRelativePosix } from "./scope.js";
import {
  runVerifications,
  truncate,
  verificationPolicy,
  type VerificationRun,
} from "./verify.js";

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
  termination: AttemptTermination;
  terminationMessage: string | null;
}

export interface AttemptStartEvidence {
  executionId: string;
  logicalAttempt: number;
  role: AttemptRole;
  predecessorExecutionId: string | null;
  requestedModel: string;
  requestedEffort: string;
  threadOperation: "start" | "resume";
  startedAt: string;
  timeoutMs: number;
}

export const createExecutionId = (): string => `exec_${randomUUID()}`;

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
  const observed: ObservedRun = {
    threadId: null,
    finalResponse: "",
    filesChanged: [],
    errors: [],
    usage: null,
    timedOut: false,
    cancelled: false,
    termination: "completed",
    terminationMessage: null,
  };

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

  let thread: WorkerThread | null = null;
  try {
    const codex: WorkerCodex =
      options.codex ??
      new Codex({
        env: workerEnv,
        config: {
          mcp_servers: { [ORCHESTRATOR_SERVER_NAME]: { enabled: false } },
        },
      });
    thread = options.resumeThreadId
      ? codex.resumeThread(options.resumeThreadId, threadOptions)
      : codex.startThread(threadOptions);

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
          observed.termination = "turn-failed";
          observed.terminationMessage = event.error.message;
          observed.errors.push(`Turn failed: ${event.error.message}`);
          break;

        case "error":
          observed.termination = "stream-error";
          observed.terminationMessage = event.message;
          observed.errors.push(event.message);
          break;

        default:
          break;
      }
    }
  } catch (error) {
    const message = (error as Error).message;
    if (observed.timedOut) {
      observed.termination = "timed-out";
      observed.terminationMessage = `Worker exceeded its ${timeoutSeconds}s budget and was aborted.`;
      observed.errors.push(observed.terminationMessage);
    } else if (observed.cancelled) {
      observed.termination = "cancelled";
      observed.terminationMessage = "Worker was cancelled before it finished.";
      observed.errors.push("Worker was cancelled before it finished.");
    } else if (/^Codex Exec exited with (?:signal|code)\b/i.test(message)) {
      observed.termination = "process-exit";
      observed.terminationMessage = message;
      observed.errors.push(`Worker process error: ${message}`);
    } else {
      observed.termination = "runtime-error";
      observed.terminationMessage = message;
      observed.errors.push(`Worker thread error: ${message}`);
    }
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    observed.threadId ??= thread?.id ?? null;
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
      const parsed = JSON.parse(candidate) as Partial<WorkerReport> & {
        failureCauses?: unknown;
      };
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !STATUSES.includes(parsed.status as Status)
      ) {
        continue;
      }
      const status = parsed.status as Status;
      const failureCauses = parseFailureCauses(parsed, status);
      if (!failureCauses) continue;
      return {
        status,
        failureCauses,
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

function parseFailureCauses(
  parsed: { failureCauses?: unknown },
  status: Status,
): WorkerFailureCause[] | null {
  if (!Object.prototype.hasOwnProperty.call(parsed, "failureCauses")) {
    if (status === "PASS") return [];
    if (status === "BLOCKED") return ["blocked", "unclassified"];
    return ["unclassified"];
  }

  if (!Array.isArray(parsed.failureCauses)) return null;
  const causes = parsed.failureCauses;
  if (
    causes.some(
      (cause) =>
        typeof cause !== "string" ||
        !WORKER_FAILURE_CAUSES.includes(cause as WorkerFailureCause),
    )
  ) {
    return null;
  }

  const normalized = causes as WorkerFailureCause[];
  if (new Set(normalized).size !== normalized.length) return null;
  if (status === "PASS") return normalized.length === 0 ? normalized : null;
  if (status === "FAILED") {
    return normalized.length > 0 && !normalized.includes("blocked") ? normalized : null;
  }
  return normalized.includes("blocked") ? normalized : null;
}

function verificationFailureIsAuthoritativelyContradicted(
  input: DelegateTaskInput,
  report: WorkerReport,
  orchestratorRuns: VerificationRun[],
): boolean {
  if (
    report.status !== "FAILED" ||
    report.failureCauses.length !== 1 ||
    report.failureCauses[0] !== "verification" ||
    input.verificationCommands.length === 0 ||
    orchestratorRuns.length !== input.verificationCommands.length
  ) {
    return false;
  }

  for (let index = 0; index < input.verificationCommands.length; index += 1) {
    const configured = input.verificationCommands[index]!;
    const authoritative = orchestratorRuns[index]!;
    if (
      authoritative.command.trim() !== configured.trim() ||
      (authoritative.execution !== "argv" && authoritative.execution !== "shell") ||
      !authoritative.passed ||
      authoritative.exitCode !== 0
    ) {
      return false;
    }
  }

  if (
    report.verification.some(
      (claim) => typeof claim.command !== "string" || typeof claim.passed !== "boolean",
    )
  ) {
    return false;
  }
  const failedClaims = report.verification.filter((claim) => claim.passed === false);
  if (failedClaims.length === 0) return false;

  const unmatched = new Set(orchestratorRuns.map((_, index) => index));
  for (const claim of failedClaims) {
    const match = [...unmatched].find((index) => {
      const configured = input.verificationCommands[index]!;
      const authoritative = orchestratorRuns[index]!;
      return (
        verificationCommandsEquivalent(claim.command, configured, verificationPolicy) &&
        verificationCommandsEquivalent(
          claim.command,
          authoritative.command,
          verificationPolicy,
        )
      );
    });
    if (match === undefined) return false;
    unmatched.delete(match);
  }

  return true;
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
  logicalAttempt?: number;
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
  logicalAttempt,
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
  const workerClaimedFailureCauses: WorkerFailureCause[] = report?.failureCauses ?? [
    "unclassified",
  ];

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

  const verificationContradiction =
    report !== null &&
    verificationFailureIsAuthoritativelyContradicted(input, report, orchestratorRuns) &&
    errors.length === 0 &&
    !observed.timedOut &&
    !observed.cancelled &&
    scopeViolations.length === 0 &&
    !changeIntentViolation &&
    (changeIntent !== "required" || observedChanges.length > 0);

  if (verificationContradiction) {
    const failedCommands = report.verification
      .filter((claim) => !claim.passed)
      .map((claim) => `\`${claim.command}\``)
      .join(", ");
    discrepancies.push(
      `Worker claimed FAILED because verification ${failedCommands} failed, but ` +
        "matching authoritative verification executed successfully.",
    );
  }

  // --- Verdict -------------------------------------------------------------
  // Ordering matters: a real execution failure outranks a policy refusal.
  let verdict: Status = verificationContradiction ? "PASS" : workerClaimedStatus;
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
    workerClaimedFailureCauses,
    discrepancies,
    orchestratorRuns,
    filesChanged,
  );

  const result: DelegateTaskOutput = {
    changeIntent,
    verdict,
    workerClaimedStatus,
    workerClaimedFailureCauses,
    trustworthy: discrepancies.length === 0 && errors.length === 0,
    workerThreadId: observed.threadId,
    continuationReference: null,
    continuationState: {
      status: "unavailable",
      reason: "Continuation availability has not yet been evaluated.",
    },
    repair: null,
    model: LUNA_MODEL,
    effort: input.effort,
    effortReason: input.effortReason,
    attempt: logicalAttempt ?? input.previousAttempts.length + 1,
    attempts: [],
    summary: report?.summary ?? truncate(observed.finalResponse) ?? "",
    notes: report?.notes ?? "",
    followUps: report?.followUps ?? [],
    filesChanged,
    verification,
    verificationMode: VERIFY_MODE,
    scopeViolations,
    discrepancies,
    reviewChecklist,
    escalationAdvice: null,
    durationSeconds,
    usage: observed.usage,
    errors,
  };
  applyFailureDecision(input, result);
  return result;
}

/** Cancellation is terminal and therefore ineligible for continuation. */
export const resultWasCancelled = (result: DelegateTaskOutput): boolean =>
  result.errors.some((error) => /was cancelled before it finished/i.test(error));

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
      result.workerClaimedFailureCauses ??
        (result.workerClaimedStatus === "PASS"
          ? []
          : result.workerClaimedStatus === "BLOCKED"
            ? ["blocked", "unclassified"]
            : ["unclassified"]),
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
  onVerificationStart?: (
    commandCount: number,
    attribution: Pick<AttemptStartEvidence, "executionId" | "logicalAttempt" | "role">,
  ) => void;
  /** Existing Codex thread to resume; omitted for a fresh delegation. */
  resumeThreadId?: string;
  /** Explicit follow-up instruction for a resumed thread. */
  continuationInstruction?: string;
  /** Stable execution identity and lineage supplied by an enclosing runner. */
  executionId?: string;
  logicalAttempt?: number;
  role?: AttemptRole;
  predecessorExecutionId?: string | null;
  /** Test seam for the worker lifecycle; production creates the SDK client. */
  codex?: WorkerCodex;
  /** Manual continuation disables this even when the original contract opted in. */
  allowAutomaticRepair?: boolean;
  onRepairStart?: (classification: string, executionId: string) => void;
  onRepairComplete?: (verdict: Status, executionId: string) => void;
  onAttemptStart?: (evidence: AttemptStartEvidence) => void;
  onAttemptComplete?: (evidence: AttemptEvidence) => void;
}

/** Optional lifecycle hooks used by the single-task MCP surface. */
export interface DelegateHooks {
  onStarted?: (workingDirectory: string) => void;
  onVerificationStart?: ExecuteOptions["onVerificationStart"];
  onRepairStart?: ExecuteOptions["onRepairStart"];
  onRepairComplete?: ExecuteOptions["onRepairComplete"];
  onAttemptStart?: ExecuteOptions["onAttemptStart"];
  onAttemptComplete?: ExecuteOptions["onAttemptComplete"];
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
  evidence: AttemptEvidence;
}

function unavailableUsageReason(observed: ObservedRun): UsageUnavailableReason {
  return observed.termination === "completed"
    ? "no-turn-completed"
    : observed.termination;
}

async function executeTaskTurn(
  input: DelegateTaskInput,
  options: ExecuteOptions,
): Promise<TaskTurn> {
  const startedAt = new Date();
  const startedTick = performance.now();
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const { workingDirectory, signal } = options;
  const executionId = options.executionId ?? createExecutionId();
  const logicalAttempt = options.logicalAttempt ?? input.previousAttempts.length + 1;
  const role = options.role ?? "initial";
  const startEvidence: AttemptStartEvidence = {
    executionId,
    logicalAttempt,
    role,
    predecessorExecutionId: options.predecessorExecutionId ?? null,
    requestedModel: LUNA_MODEL,
    requestedEffort: input.effort,
    threadOperation: options.resumeThreadId ? "resume" : "start",
    startedAt: startedAt.toISOString(),
    timeoutMs: timeoutSeconds * 1000,
  };
  options.onAttemptStart?.(startEvidence);

  const workerStartedTick = performance.now();
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
  const workerElapsedMs = Math.max(0, performance.now() - workerStartedTick);

  // Re-run the checks ourselves, after the worker has exited, so a PASS is
  // falsifiable rather than self-certified. Skipped when the run was cancelled:
  // there is nothing meaningful to verify and the caller is shutting down.
  let orchestratorRuns: VerificationRun[] = [];
  let verificationElapsedMs = 0;
  if (input.verificationCommands.length > 0 && !observed.cancelled) {
    const verificationStartedTick = performance.now();
    options.onVerificationStart?.(input.verificationCommands.length, {
      executionId,
      logicalAttempt,
      role,
    });
    try {
      orchestratorRuns = await runVerifications(
        input.verificationCommands,
        workingDirectory,
      );
    } catch (error) {
      const message = `Independent verification failed unexpectedly: ${(error as Error).message}`;
      observed.errors.push(message);
      observed.termination = "runtime-error";
      observed.terminationMessage = message;
    } finally {
      verificationElapsedMs = Math.max(0, performance.now() - verificationStartedTick);
    }
  }
  const elapsedMs = Math.max(0, performance.now() - startedTick);
  const report = parseWorkerReport(observed.finalResponse);
  const evidence: AttemptEvidence = {
    ...startEvidence,
    threadId: observed.threadId,
    threadIdentityMatched: options.resumeThreadId
      ? observed.threadId === null
        ? null
        : observed.threadId === options.resumeThreadId
      : null,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(elapsedMs),
    workerElapsedMs: Math.round(workerElapsedMs),
    verificationElapsedMs: Math.round(verificationElapsedMs),
    termination: {
      kind: observed.termination,
      message: observed.terminationMessage
        ? truncate(observed.terminationMessage, 4_000)
        : null,
    },
    usage: observed.usage
      ? {
          status: "reported",
          source: "codex-turn.completed",
          value: { ...observed.usage },
        }
      : { status: "unavailable", reason: unavailableUsageReason(observed) },
    workerClaimedStatus: report?.status ?? null,
    workerClaimedFailureCauses: [...(report?.failureCauses ?? [])],
    verification: orchestratorRuns.map((run) => ({
      ...run,
      source: "orchestrator" as const,
    })),
  };
  options.onAttemptComplete?.(evidence);

  return {
    observed,
    orchestratorRuns,
    durationSeconds: Math.round(elapsedMs / 1000),
    evidence,
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
  if (
    result.verdict === "PASS" &&
    result.workerClaimedStatus === "FAILED" &&
    result.workerClaimedFailureCauses?.length === 1 &&
    result.workerClaimedFailureCauses[0] === "verification"
  ) {
    return repairDecision("not-needed", "The initial result passed.");
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

export interface FailureDecisionContext {
  state?: TaskState;
  attempts?: AttemptEvidence[];
  error?: string | null;
  integrationConflict?: boolean;
  evidenceFailure?: boolean;
  finalVerificationFailure?: boolean;
  finalVerificationRefused?: boolean;
  recovery?: DelegateTaskOutput["recovery"];
}

const AUTOMATIC_RETRY_LIMIT = 1;

/**
 * Classify one task outcome and select exactly one conservative next action.
 *
 * This function never starts work. Existing automatic repair and parallel
 * recovery remain the only automatic handlers; every unresolved non-stop
 * action is advice to the parent. P1.2 owns any actual executor/model change.
 */
export function classifyFailureDecision(
  input: DelegateTaskInput,
  result: DelegateTaskOutput | null,
  context: FailureDecisionContext = {},
): FailureDecision {
  const attempts = context.attempts ?? result?.attempts ?? [];
  const latest = attempts.at(-1);
  const evidenceExecutionIds = attempts.map((attempt) => attempt.executionId);
  const automaticRetryCount = attempts.filter(
    (attempt) => attempt.role === "timeout-recovery" || attempt.role === "process-retry",
  ).length;
  const recovery = context.recovery ?? result?.recovery ?? null;
  const automaticHandler = recovery?.attempted
    ? ("automatic-recovery" as const)
    : result?.repair?.attempted
      ? ("automatic-repair" as const)
      : null;
  const decide = (
    classification: FailureDecision["classification"],
    action: FailureDecision["action"],
    reason: string,
    nextEffort: Effort | null = null,
  ): FailureDecision => ({
    classification,
    action,
    reason,
    evidenceExecutionIds,
    nextEffort,
    automaticHandler,
    automaticRetryCount,
    automaticRetryLimit: AUTOMATIC_RETRY_LIMIT,
  });
  const parentAfterBound = (
    classification: FailureDecision["classification"],
    reason: string,
  ): FailureDecision =>
    decide(
      classification,
      "parent-takeover",
      `${reason} The ${automaticHandler === "automatic-repair" ? "repair" : "recovery"} bound is exhausted; no automatic action may chain from it.`,
    );

  const cancelled =
    context.state === "cancelled" ||
    latest?.termination.kind === "cancelled" ||
    (result !== null && resultWasCancelled(result));
  if (cancelled) {
    return decide(
      "cancellation",
      "stop",
      "Cancellation is terminal; preserve completed evidence and do not retry, repair, continue, or escalate effort.",
    );
  }
  if (context.integrationConflict) {
    return decide(
      "scope-or-conflict",
      "parent-takeover",
      "Observed sibling edits conflict during integration; preserve every sibling result and let the parent resolve ownership.",
    );
  }
  if (context.finalVerificationRefused) {
    return decide(
      "security-or-trust-boundary",
      "parent-takeover",
      "A declared final-workspace verification command was refused or skipped; the batch trust boundary requires parent review.",
    );
  }
  if (context.finalVerificationFailure) {
    return decide(
      "verification",
      "parent-takeover",
      "A declared command passed in the task workspace but failed in the final workspace; the parent must diagnose the integrated state without rerunning successful siblings.",
    );
  }
  if (
    context.evidenceFailure ||
    /(?:evidence|continuation registration|worktree|lifecycle|lease)/i.test(
      context.error ?? "",
    )
  ) {
    return decide(
      "evidence-failure",
      "parent-takeover",
      "Authoritative worktree or lifecycle evidence could not be read; retrying would compound an untrusted state.",
    );
  }
  if (!result) {
    if (
      latest?.termination.kind === "process-exit" &&
      automaticRetryCount < AUTOMATIC_RETRY_LIMIT
    ) {
      return decide(
        "runtime",
        "retry",
        "The worker process exited before a result, and authoritative attempt evidence identifies the exact process-exit class. One fresh-process retry may be considered if owned-worktree evidence is confined and readable.",
      );
    }
    return decide(
      latest?.termination.kind === "process-exit" ? "runtime" : "unknown",
      "parent-takeover",
      "No reconciled task result exists and the evidence does not prove an eligible bounded process retry.",
    );
  }
  if (result.scopeViolations.length > 0) {
    return decide(
      "scope-or-conflict",
      "parent-takeover",
      "The worker went outside its file scope or violated immutable change intent; parent review and re-scoping are required, not another worker turn.",
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
    return decide(
      "security-or-trust-boundary",
      "parent-takeover",
      "Verification was refused or skipped, so the trust boundary does not permit repair, retry, continuation, or effort escalation.",
    );
  }
  const terminalDiscrepancies = result.discrepancies.filter(
    (item) =>
      !item.startsWith("Worker claimed PASS but the orchestrator re-ran verification") &&
      !item.startsWith("Worker reported `"),
  );
  if (terminalDiscrepancies.length > 0) {
    return decide(
      "contract-or-requirement",
      "parent-takeover",
      "Claims and authoritative observations disagree; the parent must resolve the contract discrepancy before any retry.",
    );
  }
  if (result.verdict === "PASS") {
    return decide(
      "success",
      "stop",
      automaticHandler
        ? `The bounded ${automaticHandler === "automatic-repair" ? "repair" : "recovery"} completed successfully; preserve its lineage and stop.`
        : "The task passed; successful work is never retried.",
    );
  }

  const timedOut =
    latest?.termination.kind === "timed-out" ||
    result.errors.some((error) => /exceeded its .* budget/.test(error));
  if (timedOut) {
    if (
      result.errors.some(
        (error) =>
          !/exceeded its .* budget/.test(error) &&
          error !== "Worker produced no final message.",
      )
    ) {
      return decide(
        "security-or-trust-boundary",
        "parent-takeover",
        "The timeout also carries another runtime error, so its thread and partial state are not trustworthy enough to continue automatically.",
      );
    }
    if (automaticHandler) {
      return parentAfterBound(
        "timeout",
        "The bounded recovery or repair execution timed out.",
      );
    }
    if (
      result.workerThreadId &&
      result.continuationState?.status !== "consumed" &&
      automaticRetryCount < AUTOMATIC_RETRY_LIMIT
    ) {
      return decide(
        "timeout",
        "continuation",
        "Authoritative evidence records a timeout with a resumable thread; continue once under the immutable contract rather than raising effort.",
      );
    }
    return decide(
      "timeout",
      "parent-takeover",
      "The task timed out without an eligible bounded continuation; split the task or repair the deadline policy instead of raising effort.",
    );
  }

  const evidenceFailure = result.errors.some((error) =>
    /(?:evidence (?:scan|reconciliation)|could not read worktree|lifecycle|lease)/i.test(
      error,
    ),
  );
  if (evidenceFailure) {
    return decide(
      "evidence-failure",
      "parent-takeover",
      "Execution evidence or lifecycle reconciliation failed; preserve the evidence and repair the runtime path before considering another worker.",
    );
  }

  const environmentFailure =
    result.workerClaimedFailureCauses?.includes("environment-tooling") ||
    result.errors.some((error) => ENVIRONMENT_FAILURE.test(error));
  if (environmentFailure) {
    return decide(
      "environment-or-tooling",
      "parent-takeover",
      "Environment or tooling evidence requires repairing the environment; more worker effort would not address it.",
    );
  }

  if (latest && latest.termination.kind !== "completed") {
    if (
      latest.termination.kind === "process-exit" &&
      automaticRetryCount < AUTOMATIC_RETRY_LIMIT
    ) {
      return decide(
        "runtime",
        "retry",
        "Authoritative evidence identifies a worker process exit. One fresh-process retry may be considered only with confined, readable owned-worktree evidence.",
      );
    }
    return decide(
      "runtime",
      "parent-takeover",
      `The worker terminated as ${latest.termination.kind}; that class is not safe for an automatic or same-contract retry.`,
    );
  }

  if (
    input.changeIntent === "forbidden" ||
    result.verdict === "BLOCKED" ||
    result.workerClaimedFailureCauses?.some(
      (cause) => cause === "requirements" || cause === "blocked",
    )
  ) {
    return decide(
      "contract-or-requirement",
      "parent-takeover",
      "The contract, requirements, or read-only intent must be corrected or completed by the parent before another execution.",
    );
  }

  const failedVerification = authoritative.filter(
    (run) => !run.passed && (run.execution === "argv" || run.execution === "shell"),
  );
  if (failedVerification.length > 0) {
    const repairInput = input.automaticRepair
      ? input
      : { ...input, automaticRepair: true };
    const repair = classifyRepairEligibility(repairInput, result);
    if (repair.classification === "local-verification" && !automaticHandler) {
      return decide(
        "verification",
        "repair",
        "Exactly one authoritative verification failure followed observed in-scope edits; one same-thread repair is the narrowest eligible response.",
      );
    }
    if (automaticHandler) {
      return parentAfterBound(
        "verification",
        "Authoritative verification still fails after the bounded automatic handler.",
      );
    }
    return decide(
      "verification",
      "parent-takeover",
      "The verification failure is not a single local defect eligible for bounded repair; the parent must diagnose it before retrying.",
    );
  }

  const implementationFailure =
    result.workerClaimedFailureCauses?.includes("implementation") === true;
  if (
    implementationFailure &&
    result.trustworthy &&
    latest?.termination.kind === "completed"
  ) {
    if (automaticHandler) {
      return parentAfterBound(
        "implementation",
        "The implementation still failed after the bounded automatic handler.",
      );
    }
    const priorFailed = input.previousAttempts.some(
      (attempt) => attempt.verdict === "FAILED",
    );
    if (!priorFailed) {
      return decide(
        "implementation",
        "retry",
        "The completed, trustworthy result identifies an implementation failure. A same-effort retry is warranted only after the parent confirms the immutable contract is sound.",
      );
    }
    const nextEffort = NEXT_EFFORT[input.effort] as Effort | null;
    if (nextEffort) {
      return decide(
        "effort",
        "effort-escalation",
        "A prior failed execution is declared and the current completed evidence again identifies intrinsic implementation difficulty; escalate one effort step without changing the executor or contract.",
        nextEffort,
      );
    }
    return decide(
      "capability",
      "stronger-executor-fallback",
      "Repeated trustworthy implementation failure at max effort warrants a stronger-executor fallback recommendation; P1.2 must authorize and select any executor.",
    );
  }

  return decide(
    "unknown",
    "parent-takeover",
    "The available evidence does not prove a safe repair, continuation, retry, or effort escalation; the parent must diagnose or re-scope the task.",
  );
}

/** Keep the legacy advice field as a projection of the canonical P1.1 decision. */
export function applyFailureDecision(
  input: DelegateTaskInput,
  result: DelegateTaskOutput,
  context: FailureDecisionContext = {},
): FailureDecision {
  const decision = classifyFailureDecision(input, result, context);
  result.failureDecision = decision;
  result.escalationAdvice =
    decision.action === "stop"
      ? null
      : `${decision.reason} Recommended next action: ${decision.action}${
          decision.nextEffort ? ` at ${decision.nextEffort}` : ""
        }.`;
  return decision;
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
  // This is a complete aggregate, not a known-minimum subtotal. If either
  // constituent turn has no authoritative `turn.completed` usage, the total is
  // unknown; each known constituent remains available in attempt evidence.
  if (!first || !second) return null;
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

/** Preserve completed execution evidence if result reconciliation itself fails. */
function buildRuntimeFailureResult(
  input: DelegateTaskInput,
  turn: TaskTurn,
  error: unknown,
): DelegateTaskOutput {
  const report = parseWorkerReport(turn.observed.finalResponse);
  const detail = `Result evidence reconciliation failed: ${(error as Error).message}`;
  return {
    changeIntent: input.changeIntent ?? "required",
    verdict: "FAILED",
    workerClaimedStatus: report?.status ?? "FAILED",
    workerClaimedFailureCauses: report?.failureCauses ?? ["unclassified"],
    trustworthy: false,
    workerThreadId: turn.observed.threadId,
    continuationReference: null,
    continuationState: {
      status: "unavailable",
      reason:
        "Continuation availability was not evaluated after result reconciliation failed.",
    },
    repair: null,
    recovery: null,
    model: LUNA_MODEL,
    effort: input.effort,
    effortReason: input.effortReason,
    attempt: turn.evidence.logicalAttempt,
    attempts: [turn.evidence],
    summary: report?.summary ?? truncate(turn.observed.finalResponse),
    notes: report?.notes ?? "",
    followUps: report?.followUps ?? [],
    filesChanged: turn.observed.filesChanged.map((file) => ({
      path: file.path,
      kind: normalizeKind(file.kind),
      why: UNCLAIMED_FILE,
      observed: true,
    })),
    verification: [
      ...turn.orchestratorRuns.map((run) => ({
        ...run,
        source: "orchestrator" as const,
      })),
      ...(report?.verification ?? []).map((run) => ({
        command: run.command,
        source: "worker" as const,
        execution: "reported" as const,
        exitCode: run.exitCode ?? null,
        passed: run.passed,
        output: truncate(run.evidence ?? ""),
      })),
    ],
    verificationMode: VERIFY_MODE,
    scopeViolations: [],
    discrepancies: [detail],
    reviewChecklist: [
      "Treat this result as failed: runtime evidence exists, but normal reconciliation did not complete.",
      "Inspect the retained execution and verification evidence before deciding any follow-up.",
    ],
    escalationAdvice:
      "Result evidence reconciliation failed after worker execution. Preserve the evidence and repair the runtime path before retrying.",
    durationSeconds: turn.durationSeconds,
    usage: turn.observed.usage,
    errors: [...turn.observed.errors, detail],
  };
}

function buildTurnResult(
  input: DelegateTaskInput,
  workingDirectory: string,
  turn: TaskTurn,
): DelegateTaskOutput {
  let result: DelegateTaskOutput;
  try {
    result = buildDelegationResult({
      input,
      workingDirectory,
      ...turn,
      logicalAttempt: turn.evidence.logicalAttempt,
    });
  } catch (error) {
    result = buildRuntimeFailureResult(input, turn, error);
  }
  result.attempts = [turn.evidence];
  applyFailureDecision(input, result);
  return result;
}

/** Execute a fresh or resumed task, with at most one opted-in automatic repair. */
export async function executeTask(
  input: DelegateTaskInput,
  options: ExecuteOptions,
): Promise<DelegateTaskOutput> {
  const initialTurn = await executeTaskTurn(input, options);
  const initial = buildTurnResult(input, options.workingDirectory, initialTurn);
  const allowRepair = options.allowAutomaticRepair ?? input.automaticRepair ?? false;
  if (!allowRepair) return initial;

  const decision = classifyRepairEligibility(input, initial);
  initial.repair = decision;
  if (decision.classification !== "local-verification" || !initial.workerThreadId) {
    applyFailureDecision(input, initial);
    return initial;
  }

  const repairExecutionId = createExecutionId();
  options.onRepairStart?.(decision.classification, repairExecutionId);
  const repairTurn = await executeTaskTurn(input, {
    ...options,
    allowAutomaticRepair: false,
    resumeThreadId: initial.workerThreadId,
    continuationInstruction: buildRepairInstruction(decision),
    executionId: repairExecutionId,
    logicalAttempt: initial.attempt,
    role: "automatic-repair",
    predecessorExecutionId: initialTurn.evidence.executionId,
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
  const repairedTurn: TaskTurn = {
    observed,
    orchestratorRuns: repairTurn.orchestratorRuns,
    durationSeconds: initialTurn.durationSeconds + repairTurn.durationSeconds,
    evidence: repairTurn.evidence,
  };
  const repaired = buildTurnResult(input, options.workingDirectory, repairedTurn);
  repaired.attempts = [initialTurn.evidence, repairTurn.evidence];
  repaired.repair = {
    ...decision,
    attempted: true,
    reason:
      repaired.verdict === "PASS"
        ? "The one automatic repair turn completed and normal classification passed."
        : "The one automatic repair turn completed without passing; the repair limit is exhausted and control returns to the parent.",
  };
  applyFailureDecision(input, repaired);
  options.onRepairComplete?.(repaired.verdict, repairExecutionId);
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
      onAttemptStart: hooks?.onAttemptStart,
      onAttemptComplete: hooks?.onAttemptComplete,
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
    predecessorExecutionId?: string | null;
    logicalAttempt?: number;
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
      onAttemptStart: options.hooks?.onAttemptStart,
      onAttemptComplete: options.hooks?.onAttemptComplete,
      resumeThreadId: options.threadId,
      continuationInstruction: options.instruction,
      logicalAttempt: options.logicalAttempt,
      role: "manual-continuation",
      predecessorExecutionId: options.predecessorExecutionId ?? null,
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
 * Marks a file the orchestrator saw change that the worker never mentioned.
 * No discrepancy rule covers this, so the marker is the only carrier of the
 * signal — and an unexplained edit is a reason to look at the diff.
 */
export const UNCLAIMED_FILE = "(not mentioned in the worker's report)";

function buildReviewChecklist(
  input: DelegateTaskInput,
  verdict: Status,
  claimed: Status,
  claimedFailureCauses: WorkerFailureCause[],
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
  if (
    claimed === "FAILED" &&
    claimedFailureCauses.length === 1 &&
    claimedFailureCauses[0] === "verification" &&
    verdict === "PASS"
  ) {
    checklist.push(
      "The worker's verification failed while matching authoritative verification passed. " +
        "Compare both verification evidence sources before accepting the result.",
    );
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

  if (!clean) {
    checklist.push(
      "Read the actual diff of every file in `filesChanged` — the worker's summary is a claim, not evidence.",
    );
    checklist.push(
      "Check the worker did not weaken tests, loosen types, or silence errors to reach PASS.",
    );
  }

  return checklist;
}
