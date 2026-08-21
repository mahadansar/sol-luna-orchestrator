import { Codex, type ThreadEvent } from "@openai/codex-sdk";
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

export class WorkerBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerBusyError";
  }
}

export interface ObservedRun {
  threadId: string | null;
  finalResponse: string;
  filesChanged: Array<{ path: string; kind: string }>;
  errors: string[];
  usage: DelegateTaskOutput["usage"];
  timedOut: boolean;
  cancelled: boolean;
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

  const codex = new Codex({
    env: workerEnv,
    config: {
      mcp_servers: { [ORCHESTRATOR_SERVER_NAME]: { enabled: false } },
    },
  });

  const thread = codex.startThread({
    model: LUNA_MODEL,
    modelReasoningEffort: asSdkEffort(input.effort),
    sandboxMode: WORKER_SANDBOX,
    workingDirectory,
    skipGitRepoCheck: true,
    networkAccessEnabled: WORKER_NETWORK_ACCESS,
    // The worker runs unattended: there is no human to answer a prompt.
    approvalPolicy: "never",
  });

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
      buildWorkerPrompt(input, workingDirectory),
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
  modified: "update",
  update: "update",
  deleted: "delete",
  delete: "delete",
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
  const touched = [...new Set([...observedRelative.keys(), ...claimedRelative])];
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

  if (workerClaimedStatus === "PASS" && filesChanged.length === 0) {
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
    // The code may be fine, but the contract was broken. Sol decides.
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
    verdict,
    workerClaimedStatus,
    trustworthy: discrepancies.length === 0 && errors.length === 0,
    workerThreadId: observed.threadId,
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
 * Execute a delegated task end to end: run the worker, independently verify,
 * then assemble the report.
 */
export interface ExecuteOptions {
  /** Directory the worker runs in. Already validated by the caller. */
  workingDirectory: string;
  signal?: AbortSignal;
  onVerificationStart?: (commandCount: number) => void;
}

/**
 * Run one task in an already-prepared directory.
 *
 * Owns no concurrency accounting and no workspace validation, so both the
 * single-task tool and the batch runner can share it.
 */
export async function executeTask(
  input: DelegateTaskInput,
  options: ExecuteOptions,
): Promise<DelegateTaskOutput> {
  const startedAt = Date.now();
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const { workingDirectory, signal } = options;

  const observed = await runWorkerThread(input, workingDirectory, timeoutSeconds, signal);

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

  return buildDelegationResult({
    input,
    workingDirectory,
    observed,
    orchestratorRuns,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
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
): Promise<DelegateTaskOutput> {
  // Validate and canonicalise before the worker gets write access to it.
  const workingDirectory = resolveWorkspace(input.workingDirectory);
  const release = await workerSlots.acquire();
  try {
    return await executeTask(input, { workingDirectory, signal });
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
