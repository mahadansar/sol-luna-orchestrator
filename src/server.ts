#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./log.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DEFAULT_EFFORT,
  DEFAULT_TIMEOUT_SECONDS,
  EVENTS_FILE,
  IS_WORKER_PROCESS,
  LUNA_MODEL,
  MAX_BATCH_SIZE,
  MAX_PARALLEL,
  VERIFY_MODE,
  VERIFY_MODE_INVALID,
  WORKTREE_DIR,
  WORKER_MARKER_ENV,
} from "./config.js";
import {
  asRoutingCard,
  continueTaskMcpInputShape,
  delegateTaskMcpInputShape,
  exploreInputSchema,
  exploreMcpInputShape,
  inputMetadataSizeReport,
  INPUT_METADATA_SIZE_BUDGETS,
  delegateTasksMcpInputShape,
  routingPreflightMcpInputShape,
  type BatchOutput,
  type AttemptEvidence,
  type ContinueTaskInput,
  type DelegateTaskInput,
  type DelegateTaskOutput,
  type DelegateTasksInput,
  type ExploreInput,
  type ExploreOutput,
  type RoutingPreflightInput,
} from "./contract.js";
import { BatchRejectedError, runBatch } from "./batch.js";
import { ContinuationStore, type ContinuationConsumeResult } from "./continuation.js";
import {
  applyFailureDecision,
  continueToLuna,
  delegateToLuna,
  exploreWithLuna,
  reconcileParallelWorktreeEvidence,
  resultWasCancelled,
} from "./worker.js";
import { collectWorktreeChanges, type WorktreeChanges } from "./git.js";
import { WorkspaceError } from "./workspace.js";
import {
  activityFailureReason,
  emitAttemptCompleted,
  emitAttemptStarted,
  emitEvent,
  type EventEmitter,
} from "./events.js";
import {
  admitCompute,
  cloneComputePolicy,
  DEFAULT_COMPUTE_POLICY,
  type ComputePolicy,
} from "./policy.js";
import { evaluateAdaptiveCard, routeLiveTask } from "./adaptive.js";
import { HandoffStore, handoffError, registerHandoff } from "./handoff.js";
import { type PriorExecution } from "./selection.js";
import {
  declaredRoutingFields,
  describeRefusal,
  renderRoutingAdvisory,
  renderRoutingPreflight,
} from "./routing.js";
import {
  filterOrchestratorOwnedSharedLinks,
  refreshWorktreeLease,
  releaseWorktreeLease,
  WORKTREE_LEASE_GRACE_MS,
  type WorktreeLease,
} from "./worktree.js";
import { ContextLifecycleStore } from "./context.js";
import {
  restoreSessionHandoffIntoStore,
  type ImportSessionHandoffOptions,
  type SessionHandoffArtifact,
} from "./session-handoff.js";

/**
 * stdout is the MCP transport. Anything written there that is not a JSON-RPC
 * frame corrupts the session, so all diagnostics go to stderr.
 *
 * Codex swallows a server's stderr, so set SOL_LUNA_LOG=<path> to also tee
 * diagnostics to a file. That log is the only way to tell "Codex never started
 * the server" apart from "the server started but the model ignored the tool".
 */
const LOG_FILE = process.env.SOL_LUNA_LOG;

const manifest = JSON.parse(
  readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
) as { version?: unknown };
export const SERVER_VERSION =
  typeof manifest.version === "string" ? manifest.version : "unknown";

const log = createLogger(LOG_FILE);

/** Deliberately in-memory: references die with this server process. */
const continuationStore = new ContinuationStore();
const handoffStore = new HandoffStore();

/** Process-local lifecycle contexts, isolated by server-owned execution lineage. */
export class ContextLifecycleRegistry {
  private readonly stores = new Map<string, ContextLifecycleStore>();
  private readonly continuationStore: ContinuationStore;
  private readonly handoffStore: HandoffStore;
  private readonly emit: EventEmitter;

  constructor(
    options: {
      continuationStore?: ContinuationStore;
      handoffStore?: HandoffStore;
      emit?: EventEmitter;
    } = {},
  ) {
    this.continuationStore = options.continuationStore ?? continuationStore;
    this.handoffStore = options.handoffStore ?? handoffStore;
    this.emit = options.emit ?? emitEvent;
  }

  getOrCreate(contextKey: string): ContextLifecycleStore {
    this.sweep(contextKey);
    let store = this.stores.get(contextKey);
    if (!store) {
      store = new ContextLifecycleStore({
        continuationStore: this.continuationStore,
        handoffStore: this.handoffStore,
        emit: this.emit,
      });
      this.stores.set(contextKey, store);
    }
    return store;
  }

  releaseIfUnreferenced(contextKey: string): void {
    const store = this.stores.get(contextKey);
    if (
      store &&
      !store.isInFlight() &&
      !this.continuationStore.hasContextKey(contextKey) &&
      !this.handoffStore.hasContextKey(contextKey)
    ) {
      this.stores.delete(contextKey);
    }
  }

  restoreSessionHandoff(
    contextKey: string,
    input: string | unknown,
    options?: ImportSessionHandoffOptions,
  ): { store: ContextLifecycleStore; artifact: SessionHandoffArtifact } {
    const store = this.getOrCreate(contextKey);
    const artifact = restoreSessionHandoffIntoStore(store, input, options);
    return { store, artifact };
  }

  private sweep(exceptContextKey?: string): void {
    for (const contextKey of this.stores.keys()) {
      if (contextKey === exceptContextKey) continue;
      this.releaseIfUnreferenced(contextKey);
    }
  }
}

const contextRegistry = new ContextLifecycleRegistry();

function registerContinuation(
  input: DelegateTaskInput,
  result: DelegateTaskOutput,
  workingDirectory: string,
  reconcileFinalGit = false,
  worktreeLease: WorktreeLease | null = null,
  store: ContinuationStore = continuationStore,
  contextKey: string | null = null,
): string | null {
  if (!result.workerThreadId) {
    result.continuationState = {
      status: "not-eligible",
      reason: "No worker thread identity was observed.",
    };
    applyFailureDecision(input, result);
    return null;
  }
  if (resultWasCancelled(result)) {
    result.continuationState = {
      status: "not-eligible",
      reason: "Cancellation is terminal for bounded continuation.",
    };
    applyFailureDecision(input, result);
    return null;
  }
  const predecessorExecutionId = result.attempts?.at(-1)?.executionId ?? null;
  const reference = store.issue(
    input,
    result.workerThreadId,
    workingDirectory,
    reconcileFinalGit,
    worktreeLease,
    predecessorExecutionId,
    result.attempt + 1,
    result.model,
    contextKey,
  );
  result.continuationState = {
    status: "issued",
    reason: "One bounded continuation reference was issued for this worker thread.",
  };
  applyFailureDecision(input, result);
  return reference;
}

function continuationError(result: ContinuationConsumeResult): string {
  switch (result.status) {
    case "invalid":
      return "Invalid continuation reference. Use the opaque reference returned by an eligible result.";
    case "expired":
      return "Continuation reference expired. Delegate a fresh task if more work is needed.";
    case "used":
      return "Continuation reference already consumed. Only one continuation is allowed per task.";
    case "unknown":
      return "Unknown continuation reference. It may belong to another server process or was never issued.";
    case "ready":
      return "";
  }
}

/** Reconcile a continuation that ran inside a retained parallel worktree. */
export async function reconcileRetainedContinuationEvidence(
  input: DelegateTaskInput,
  result: DelegateTaskOutput,
  workingDirectory: string,
  collect: (
    workingDirectory: string,
  ) => Promise<WorktreeChanges> = collectWorktreeChanges,
): Promise<DelegateTaskOutput> {
  try {
    const changes = await collect(workingDirectory);
    const repoRoot = path.resolve(
      workingDirectory,
      ...Array.from({ length: WORKTREE_DIR.split("/").length + 1 }, () => ".."),
    );
    const files = await filterOrchestratorOwnedSharedLinks(
      repoRoot,
      workingDirectory,
      changes.files,
    );
    return reconcileParallelWorktreeEvidence(
      input,
      result,
      workingDirectory,
      files.map((file) => ({ path: file.path, kind: file.status })),
    );
  } catch (error) {
    return reconcileParallelWorktreeEvidence(
      input,
      result,
      workingDirectory,
      [],
      `Could not read retained worktree changes: ${(error as Error).message}`,
    );
  }
}

/** Append one machine-readable record per delegation, for measurement. */
export const recordEvent = (
  result: DelegateTaskOutput,
  eventsFile = EVENTS_FILE,
): void => {
  if (!eventsFile) return;
  try {
    appendFileSync(
      eventsFile,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        model: result.model,
        effort: result.effort,
        attempt: result.attempt,
        verdict: result.verdict,
        workerClaimedStatus: result.workerClaimedStatus,
        trustworthy: result.trustworthy,
        workerThreadId: result.workerThreadId,
        durationSeconds: result.durationSeconds,
        filesChanged: result.filesChanged.length,
        scopeViolations: result.scopeViolations.length,
        discrepancies: result.discrepancies.length,
        ...(result.repair
          ? {
              repair: {
                attempted: result.repair.attempted,
                classification: result.repair.classification,
              },
            }
          : {}),
        ...(result.recovery
          ? {
              recovery: {
                attempted: result.recovery.attempted,
                classification: result.recovery.classification,
                evidence: result.recovery.evidence,
                initialAttempt: result.recovery.initialAttempt,
                recoveryAttempt: result.recovery.recoveryAttempt,
                initialDurationSeconds: result.recovery.initialDurationSeconds,
                recoveryDurationSeconds: result.recovery.recoveryDurationSeconds,
              },
            }
          : {}),
        usage: result.usage,
      })}\n`,
    );
  } catch {
    // Telemetry must never break a delegation.
  }
};

/**
 * Evaluate an optional routing card for a delegation call that is about to run.
 *
 * The batch path evaluates the card again inside `runBatch`, where the gates must
 * sit before worktree creation; this evaluation exists only to render the compact
 * advisory line. Both call the same pure function with the same inputs, so the
 * two can neither disagree nor cost anything but a few comparisons — which is
 * cheaper than widening the batch result schema to carry the evaluation back out.
 */
export function routingAdvisoryLine(
  card: RoutingPreflightInput | undefined,
  context: {
    mode: "single" | "sequential" | "parallel";
    taskCount: number;
    allowOverlappingScopes?: boolean;
  },
  policy: ComputePolicy = DEFAULT_COMPUTE_POLICY,
): string | null {
  if (!card) return null;
  return renderRoutingAdvisory(
    evaluateAdaptiveCard({ card: asRoutingCard(card), context, policy }).evaluation,
  );
}

/**
 * Enforce the universal structural gate for a single delegation.
 *
 * `delegate_task` requests no execution mechanism that a declaration can make
 * unsound, so only the seam-count gate can refuse here. Everything else the card
 * says is advice, and unknown values cannot reach this path at all.
 */
export function refuseSingleDelegation(
  card: RoutingPreflightInput | undefined,
  batchId: string,
  emit: EventEmitter = emitEvent,
  policy: ComputePolicy = DEFAULT_COMPUTE_POLICY,
): string | null {
  if (!card) {
    emit({
      type: "routing.declared",
      batchId,
      declaration: "absent",
      mode: "single",
      taskCount: 1,
    });
    return null;
  }
  const routingCard = asRoutingCard(card);
  const { evaluation: routing, selection } = evaluateAdaptiveCard({
    card: routingCard,
    context: { mode: "single", taskCount: 1 },
    policy,
  });
  emit({
    type: "routing.declared",
    batchId,
    declaration: "attached",
    mode: "single",
    taskCount: 1,
    seamCount: routing.seamCount,
    unknownCount: routing.unknownCount,
    route: routing.route,
    gates: routing.gates,
    signals: routing.signals,
    refusedGate: routing.refusedGate,
    parallelEligible: routing.parallelEligible,
    recommendedMechanism: routing.shape?.mechanism,
    recommendedWorkerCount: routing.shape?.workerCount,
    recommendedConcurrency: routing.shape?.concurrency,
    recommendedEffort: routing.shape?.effort,
    selectedModel: selection.model,
    selectedEffort: selection.effort,
    selectionReason: selection.reason,
    ...declaredRoutingFields(routingCard),
  });
  return routing.refusedGate ? describeRefusal(routing.refusedGate) : null;
}

function makeSingleBatchId(): string {
  return `b${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function emitSingleCompletion(
  batchId: string,
  taskId: string,
  timeoutSeconds: number,
  result: DelegateTaskOutput,
  emit: EventEmitter = emitEvent,
): void {
  const cancelled = result.errors.some((error) =>
    /was cancelled before it finished/i.test(error),
  );
  const timedOut = result.errors.some((error) => /exceeded its .* budget/.test(error));

  if (cancelled) {
    emit({ type: "worker.cancelled", batchId, taskId, attempt: result.attempt });
    emit({
      type: "batch.cancelled",
      batchId,
      reason: "worker cancelled",
    });
  } else {
    if (timedOut) {
      emit({
        type: "worker.timedOut",
        batchId,
        taskId,
        timeoutSeconds,
        attempt: result.attempt,
      });
    }
    // Keep the existing completion record for compatibility. The activity
    // reducer preserves timedOut when this record follows it.
    emit({
      type: "worker.completed",
      batchId,
      taskId,
      verdict: result.verdict,
      claimed: result.workerClaimedStatus,
      durationSeconds: result.durationSeconds,
      threadId: result.workerThreadId,
      model: result.model,
      effort: result.effort,
      changedFiles: result.filesChanged.filter((file) => file.observed).length,
      failureReason: activityFailureReason(result),
      usage: result.usage,
      attempt: result.attempt,
    });
    emit({
      type: "batch.completed",
      batchId,
      durationSeconds: result.durationSeconds,
      passed: result.verdict === "PASS" ? 1 : 0,
      failed: result.verdict === "PASS" ? 0 : 1,
    });
  }
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

export const TOOL_DESCRIPTION = `Delegate ONE substantial, bounded executable seam to ${LUNA_MODEL}; no second seam is required. Keep small, simple, or tightly coupled work solo. Tasks may be implementation, tests, bug fixing, refactoring, investigation, or chores. The parent owns architecture, decomposition, unresolved design, sequencing, interfaces, scope, acceptance, and final judgement. Luna owns scoped exploration, implementation, verification, and bounded repair; it cannot see the conversation or delegate.

Provide a self-contained objective, effortReason, acceptanceCriteria, verificationCommands, changeIntent, and honest scopes; add a concise activityLabel when safe and only repository-unavailable context. automaticRepair permits at most one conservative same-thread repair. Results include one evidence-derived failureDecision; parent owns nonautomatic actions. resultDetail=handoff is the default.

The runtime reruns declared checks and reconciles observed edits. A clean PASS returns a text-only VERIFIED_COMPLETE handoff: finish without rereading worker-owned files or rerunning passed checks unless a listed risk changes architecture. FAILED/BLOCKED, untrustworthy, discrepant, scope-violating, refused/skipped, or runtime-error results expand with evidence. Worker claims are not authoritative.

Delegate only when ownership, isolation, context, verification, latency, coordination risk, quality, and current parent-conditional credit economics beat fixed overhead; raw tokens are not credit cost and no saving is guaranteed. While pending with no meaningful new state, remain silent; do not narrate waiting or polling. Report only a result, error, cancellation, timeout, or actionable state change.`;

export const CONTINUE_TOOL_DESCRIPTION = `Continue ONE eligible task once in the same Luna Codex thread with an opaque single-use continuationReference and one bounded instruction. The original objective, allowedFiles, forbiddenFiles, changeIntent, acceptance, and verification contract remain immutable; no widening fields exist. Luna cannot delegate, and continuation never starts automatic repair. Verification, scope checks, and evidence reconciliation run again. handoff is default; compact/full are compatibility modes. While pending with no meaningful new state, remain silent; do not narrate waiting or polling. Report only a result, error, cancellation, timeout, or actionable state change.`;

/**
 * Strip the output of verification commands that passed.
 *
 * This is the whole of compact mode. A command that passed is fully described
 * by its verdict and exit code, so its stdout is the largest thing in a routine
 * result and the least informative. Everything else is kept, including the
 * output of anything that failed or was refused.
 *
 * Exported and pure so tests can prove the removal actually happens. The text
 * block never carried this output in the first place, so `structuredContent` is
 * the only surface compact changes, and passed-command output is the only thing
 * it removes. Everything else is identical to a full result.
 */
export function compactResult(result: DelegateTaskOutput): DelegateTaskOutput {
  return {
    ...result,
    verification: result.verification.map((run) =>
      run.passed ? { ...run, output: "" } : run,
    ),
    ...(result.attempts
      ? {
          attempts: result.attempts.map((attempt) => ({
            ...attempt,
            verification: attempt.verification.map((run) =>
              run.passed ? { ...run, output: "" } : run,
            ),
          })),
        }
      : {}),
  };
}

/** Apply {@link compactResult} to every task result in a batch. */
export function compactBatch(batch: BatchOutput): BatchOutput {
  return {
    ...batch,
    integrationVerification: batch.integrationVerification.map((run) =>
      run.passed ? { ...run, output: "" } : run,
    ),
    tasks: batch.tasks.map((task) =>
      task.result ? { ...task, result: compactResult(task.result) } : task,
    ),
  };
}

/** Render the structured result as readable text for the model's transcript. */
function renderRichResult(result: DelegateTaskOutput): string {
  const lines: string[] = [];
  const flag = result.trustworthy ? "" : "  ⚠ NEEDS SCRUTINY";

  lines.push(
    `VERDICT: ${result.verdict} (worker claimed ${result.workerClaimedStatus})${flag}`,
  );
  if ((result.workerClaimedFailureCauses?.length ?? 0) > 0) {
    lines.push(
      `WORKER-CLAIMED FAILURE CAUSES: ${result.workerClaimedFailureCauses!.join(", ")}`,
    );
  }
  lines.push(
    `worker: ${result.model} @ ${result.effort} | attempt ${result.attempt} | ` +
      `thread ${result.workerThreadId ?? "unknown"} | ${result.durationSeconds}s`,
  );
  lines.push(`CHANGE INTENT: ${result.changeIntent ?? "required"}`);
  if (result.continuationReference) {
    lines.push(`CONTINUATION REFERENCE: ${result.continuationReference}`);
  }
  if (result.handoffReference) {
    lines.push(`HANDOFF REFERENCE: ${result.handoffReference}`);
  }
  if (result.repair) {
    lines.push(
      `REPAIR: ${result.repair.attempted ? "attempted" : "not attempted"} | ` +
        `${result.repair.classification} | ${result.repair.reason}`,
    );
    for (const evidence of result.repair.failureEvidence) {
      lines.push(
        `  [INITIAL FAILURE] ${evidence.command} (exit ${evidence.exitCode ?? "n/a"}, ${evidence.execution})`,
      );
      if (evidence.output) {
        lines.push(
          evidence.output
            .split("\n")
            .slice(-12)
            .map((line) => `         ${line}`)
            .join("\n"),
        );
      }
    }
  }
  if (result.recovery) {
    lines.push(
      `RECOVERY: ${result.recovery.attempted ? "attempted" : "not attempted"} | ` +
        `${result.recovery.classification} | ${result.recovery.evidence}`,
    );
  }
  if (result.failureDecision) {
    lines.push(
      `FAILURE DECISION: ${result.failureDecision.classification} -> ` +
        `${result.failureDecision.action}${result.failureDecision.nextEffort ? ` (${result.failureDecision.nextEffort})` : ""} | ` +
        `${result.failureDecision.reason}`,
    );
  }
  lines.push("");
  lines.push(`WORKER SUMMARY (claim)\n${result.summary || "(none)"}`);

  if (result.discrepancies.length > 0) {
    lines.push("");
    lines.push("DISCREPANCIES (claims contradicted by evidence)");
    for (const item of result.discrepancies) lines.push(`  ! ${item}`);
  }

  if (result.scopeViolations.length > 0) {
    lines.push("");
    lines.push("SCOPE VIOLATIONS");
    for (const item of result.scopeViolations) lines.push(`  ! ${item}`);
  }

  lines.push("");
  lines.push("FILES CHANGED");
  if (result.filesChanged.length === 0) {
    lines.push("  (none recorded)");
  } else {
    for (const file of result.filesChanged) {
      const mark = file.observed ? "" : "  [CLAIMED ONLY — not observed by runtime]";
      lines.push(`  ${file.kind.padEnd(6)} ${file.path}${mark}`);
      // Kept whatever the detail setting. It is small next to command output,
      // and for a file the worker never mentioned it carries the runtime's own
      // "(not mentioned in the worker's report)" marker, which nothing else
      // records.
      if (file.why) lines.push(`         ${file.why}`);
    }
  }

  lines.push("");
  lines.push(`VERIFICATION (policy: ${result.verificationMode})`);
  if (result.verification.length === 0) {
    lines.push("  (none run)");
  } else {
    for (const run of result.verification) {
      const status =
        run.execution === "rejected"
          ? "REFUSED"
          : run.execution === "skipped"
            ? "SKIPPED"
            : run.passed
              ? "PASS"
              : "FAIL";
      const authority =
        run.source === "orchestrator" ? "authoritative" : "worker-reported";
      lines.push(
        `  [${status}] ${run.command}  (exit ${run.exitCode ?? "n/a"}, ${authority})`,
      );
      if (!run.passed && run.output) {
        lines.push(
          run.output
            .split("\n")
            .slice(-25)
            .map((line) => `         ${line}`)
            .join("\n"),
        );
      }
    }
  }

  if (result.notes) lines.push(`\nWORKER NOTES\n${result.notes}`);

  if (result.followUps.length > 0) {
    lines.push("\nFOLLOW-UPS LEFT UNDONE");
    for (const item of result.followUps) lines.push(`  - ${item}`);
  }

  if (result.errors.length > 0) {
    lines.push("\nERRORS");
    for (const item of result.errors) lines.push(`  ! ${item}`);
  }

  if (result.escalationAdvice) {
    lines.push(`\nBEFORE RETRYING\n${result.escalationAdvice}`);
  }

  lines.push("\nYOUR REVIEW BEFORE ACCEPTING");
  for (const item of result.reviewChecklist) lines.push(`  [ ] ${item}`);

  if (result.usage) {
    lines.push(
      `\ntokens: ${result.usage.inputTokens} in (${result.usage.cachedInputTokens} cached) · ` +
        `${result.usage.outputTokens} out (${result.usage.reasoningOutputTokens} reasoning)`,
    );
  }

  return lines.join("\n");
}

export interface RenderIdentity {
  batchId?: string;
  taskId?: string;
  integration?: string;
}

function authoritativeVerificationCounts(result: DelegateTaskOutput): string {
  const runs = result.verification.filter((run) => run.source === "orchestrator");
  const executed = runs.filter(
    (run) => run.execution === "argv" || run.execution === "shell",
  );
  const refused = runs.filter(
    (run) => run.execution === "rejected" || run.execution === "skipped",
  );
  return (
    `${executed.length} executed (${executed.filter((run) => run.passed).length} passed, ` +
    `${executed.filter((run) => !run.passed).length} failed), ${refused.length} refused`
  );
}

/** Current authoritative single-task completion evidence, independent of display mode. */
export function isAuthoritativelyVerifiedPass(result: DelegateTaskOutput): boolean {
  const authoritative = result.verification.filter(
    (run) => run.source === "orchestrator",
  );
  return (
    result.verdict === "PASS" &&
    result.trustworthy &&
    result.scopeViolations.length === 0 &&
    result.discrepancies.length === 0 &&
    result.errors.length === 0 &&
    result.filesChanged.every((file) => file.observed) &&
    authoritative.length > 0 &&
    authoritative.every(
      (run) => (run.execution === "argv" || run.execution === "shell") && run.passed,
    )
  );
}

function isCleanPass(result: DelegateTaskOutput): boolean {
  return (
    isAuthoritativelyVerifiedPass(result) &&
    result.workerClaimedStatus === "PASS" &&
    !result.repair?.attempted
  );
}

export function structuredResultForDetail(
  result: DelegateTaskOutput,
  detail: DelegateTaskInput["resultDetail"],
): DelegateTaskOutput | undefined {
  if (detail === "full") return result;
  if (detail === "compact") return compactResult(result);
  return isCleanPass(result) ? undefined : result;
}

function isCleanBatch(batch: BatchOutput): boolean {
  return (
    batch.completionState === "verified-complete" &&
    batch.passed === batch.taskCount &&
    batch.failed === 0 &&
    batch.integrationConflicts.length === 0 &&
    batch.scopeConflicts.length === 0 &&
    batch.warnings.length === 0 &&
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
        task.result &&
        isCleanPass(task.result),
    )
  );
}

export function structuredBatchForDetail(
  batch: BatchOutput,
  detail: DelegateTaskInput["resultDetail"],
): BatchOutput | undefined {
  if (detail === "full") return batch;
  if (detail === "compact") return compactBatch(batch);
  return isCleanBatch(batch) ? undefined : batch;
}

/** Compact model-facing handoff for the routine verified success path. */
export function renderResult(
  result: DelegateTaskOutput,
  identity: RenderIdentity = {},
): string {
  if (!isCleanPass(result)) return renderRichResult(result);
  const paths = result.filesChanged
    .filter((file) => file.observed)
    .map((file) => file.path);
  const lines = [
    `VERDICT: PASS | BATCH: ${identity.batchId ?? "single"} | TASK: ${identity.taskId ?? "t1"}`,
    `WORKER: ${result.model} @ ${result.effort} | attempt ${result.attempt} | ` +
      `thread ${result.workerThreadId ?? "unknown"} | ${result.durationSeconds}s`,
    `CHANGED: ${paths.length > 0 ? paths.join(", ") : "(none)"}`,
    `VERIFICATION: authoritative ${authoritativeVerificationCounts(result)}`,
    `INTEGRATION: ${identity.integration ?? "single-task workspace"}`,
  ];
  if (result.recovery?.attempted) {
    lines.push(
      `RECOVERY: ${result.recovery.classification} | attempt ${result.recovery.recoveryAttempt} | ${result.recovery.evidence}`,
    );
  }
  if (result.continuationReference)
    lines.push(`CONTINUATION: ${result.continuationReference}`);
  if (result.handoffReference) lines.push(`HANDOFF: ${result.handoffReference}`);
  const risks = [result.notes.trim(), ...result.followUps].filter(Boolean);
  lines.push(`RISKS: ${risks.length > 0 ? risks.join("; ") : "none"}`);
  lines.push("TERMINAL: VERIFIED_COMPLETE");
  lines.push(
    "NEXT: finish without rereading worker-owned files or rerunning passed scoped checks unless a listed risk changes architecture.",
  );
  return lines.join("\n");
}

/** The short general policy sent to the parent during MCP initialization. */
export const SERVER_INSTRUCTIONS = `Sol-Luna Orchestrator routes bounded ownership from any compatible parent Codex model to ${LUNA_MODEL}; adaptive zero-worker use is valid. The parent owns architecture, decomposition, interfaces, scope, acceptance, and final judgement. Luna owns scoped exploration, implementation, verification, and repair. Use delegate_task for one substantial seam; delegate_tasks sequentially for dependent/shared state or parallel for independent disjoint scopes. More workers are not automatically better or cheaper; raw tokens are not credit cost and savings are parent-conditional. Runtime evidence outranks worker claims. VERIFIED_COMPLETE already passed scoped and final workspace checks: finish without rereading worker files or rerunning checks unless a listed risk changes architecture. Failures, conflicts, scope/trust discrepancies, and refused checks expand for targeted diagnosis. While a call has no meaningful new state, remain silent; do not narrate waiting or polling. Report only a result, error, cancellation, timeout, or actionable state change.`;

export const ROUTING_PREFLIGHT_TOOL_DESCRIPTION = `Cheap deterministic check of whether delegating is structurally sound and economically sensible, before any repository exploration. Declare the ownership seams you are considering and what they share; leave a field "unknown" when you do not know, which biases the advice toward solo without ever refusing. Creates no worker, batch, worktree, or thread, refuses nothing, and returns route (solo | either | delegation-plausible), the deciding signals, and structural parallel eligibility. Advisory only and never required: the parent owns sequential vs parallel, worker count, effort, and the final decision, and choosing zero workers afterwards is a normal successful outcome. either means fixed delegation overhead needs explicit justification, otherwise stay solo.`;

export const EXPLORE_TOOL_DESCRIPTION = `Explicitly explore an admitted repository, API, or documentation scope with ${LUNA_MODEL}; fixed read-only disposable execution returns provenance-marked worker claims, runtime facts, inferences, and unknowns. Implements nothing, cannot delegate, and is never automatic.`;

/**
 * Deterministic ceilings for everything the server always advertises.
 *
 * `advertisedTotal` is the honest one: instructions, every tool description, and
 * every registered input schema, with nothing excluded. `delegationContract` and
 * `routingCombined` split that same total by owner so a regression can be
 * attributed, but neither is presented as the session's metadata cost.
 */
export const METADATA_SIZE_BUDGETS = {
  serverInstructions: 1_100,
  delegateTaskDescription: 1_700,
  delegateTasksDescription: 2_150,
  continueTaskDescription: 690,
  routingPreflightDescription: 800,
  exploreDescription: 275,
  advertisedTotal: 17_000,
  delegationContract: 13_400,
  routingCombined: 3_700,
} as const;

/**
 * Measure the always-advertised metadata.
 *
 * `advertisedTotal` is what the parent is actually sent. `delegationContract`
 * measures the pre-routing protocol surface — the same quantity the old
 * `combined` entry guarded — so the delegation contract still cannot grow
 * unnoticed, and `routingCombined` accounts for every byte routing preflight
 * adds. The two diagnostics sum to the total by construction rather than by
 * excluding anything from it.
 */
export function metadataSizeReport(): {
  serverInstructions: number;
  delegateTaskDescription: number;
  delegateTasksDescription: number;
  continueTaskDescription: number;
  routingPreflightDescription: number;
  exploreDescription: number;
  inputSchemas: ReturnType<typeof inputMetadataSizeReport>;
  advertisedTotal: number;
  delegationContract: number;
  routingCombined: number;
} {
  const inputSchemas = inputMetadataSizeReport();
  const serverInstructions = SERVER_INSTRUCTIONS.length;
  const delegateTaskDescription = TOOL_DESCRIPTION.length;
  const delegateTasksDescription = BATCH_TOOL_DESCRIPTION.length;
  const continueTaskDescription = CONTINUE_TOOL_DESCRIPTION.length;
  const routingPreflightDescription = ROUTING_PREFLIGHT_TOOL_DESCRIPTION.length;
  const exploreDescription = EXPLORE_TOOL_DESCRIPTION.length;
  const delegationContract =
    serverInstructions +
    delegateTaskDescription +
    delegateTasksDescription +
    continueTaskDescription +
    exploreDescription +
    inputSchemas.contractCombined;
  const routingCombined = routingPreflightDescription + inputSchemas.routingCombined;
  return {
    serverInstructions,
    delegateTaskDescription,
    delegateTasksDescription,
    continueTaskDescription,
    routingPreflightDescription,
    exploreDescription,
    inputSchemas,
    // Summed from the advertised figures directly, not from the two diagnostics:
    // the total must stay correct even if their attribution ever changes.
    advertisedTotal:
      serverInstructions +
      delegateTaskDescription +
      delegateTasksDescription +
      continueTaskDescription +
      routingPreflightDescription +
      exploreDescription +
      inputSchemas.advertisedCombined,
    delegationContract,
    routingCombined,
  };
}

export function assertMetadataBudgets(): void {
  const metadataSizes = metadataSizeReport();
  if (
    metadataSizes.serverInstructions > METADATA_SIZE_BUDGETS.serverInstructions ||
    metadataSizes.delegateTaskDescription >
      METADATA_SIZE_BUDGETS.delegateTaskDescription ||
    metadataSizes.delegateTasksDescription >
      METADATA_SIZE_BUDGETS.delegateTasksDescription ||
    metadataSizes.continueTaskDescription >
      METADATA_SIZE_BUDGETS.continueTaskDescription ||
    metadataSizes.routingPreflightDescription >
      METADATA_SIZE_BUDGETS.routingPreflightDescription ||
    metadataSizes.exploreDescription > METADATA_SIZE_BUDGETS.exploreDescription ||
    metadataSizes.advertisedTotal > METADATA_SIZE_BUDGETS.advertisedTotal ||
    metadataSizes.delegationContract > METADATA_SIZE_BUDGETS.delegationContract ||
    metadataSizes.routingCombined > METADATA_SIZE_BUDGETS.routingCombined ||
    // Every input-schema budget names a field of the report, so there is no
    // special case here and no advertised surface without a ceiling.
    Object.entries(INPUT_METADATA_SIZE_BUDGETS).some(
      ([key, budget]) =>
        metadataSizes.inputSchemas[key as keyof typeof metadataSizes.inputSchemas] >
        budget,
    )
  ) {
    throw new Error(
      `MCP metadata exceeds deterministic budget: ${JSON.stringify(metadataSizes)}`,
    );
  }
}

const server = new McpServer(
  { name: "sol-luna-orchestrator", version: SERVER_VERSION },
  { instructions: SERVER_INSTRUCTIONS },
);

// Backstop against recursive delegation: if this process was launched from
// inside a Luna worker, do not advertise the delegation tool at all. Workers
// are already isolated via config, but that depends on the registered server
// name matching; this check does not.
export interface DelegateTaskHandlerDependencies {
  handoffStore: HandoffStore;
  continuationStore: ContinuationStore;
  contextStore?: ContextLifecycleStore;
  contextRegistry: ContextLifecycleRegistry;
  delegateToLuna: typeof delegateToLuna;
  emit: EventEmitter;
  record: typeof recordEvent;
  makeBatchId: () => string;
}

export async function handleDelegateTask(
  rawTask: DelegateTaskInput,
  signal?: AbortSignal,
  overrides: Partial<DelegateTaskHandlerDependencies> = {},
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: DelegateTaskOutput;
  isError?: boolean;
}> {
  const dependencies: DelegateTaskHandlerDependencies = {
    handoffStore,
    continuationStore,
    contextRegistry,
    delegateToLuna,
    emit: emitEvent,
    record: recordEvent,
    makeBatchId: makeSingleBatchId,
    ...overrides,
  };
  const batchId = dependencies.makeBatchId();
  const taskId = "t1";

  let predecessorExecutionId: string | null = null;
  let logicalAttempt = rawTask.previousAttempts.length + 1;
  let priorEvidence: PriorExecution | undefined = undefined;
  let resolvedTask = rawTask;
  let contextKey = batchId;

  if (rawTask.handoffReference) {
    const consumed = dependencies.handoffStore.consume(rawTask.handoffReference);
    if (consumed.status !== "ready") {
      const message = handoffError(consumed);
      dependencies.emit({ type: "batch.rejected", batchId, reason: message });
      log(`delegate_task handoff rejected: ${message}`);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
    resolvedTask = {
      ...consumed.entry.input,
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
    priorEvidence = {
      requestedModel: consumed.entry.model,
      requestedEffort: consumed.entry.effort,
      failureDecision: consumed.entry.failureDecision,
    };
    contextKey = consumed.entry.contextKey ?? batchId;
  }

  const initialAdmission = admitCompute({
    requested: resolvedTask.computePolicy,
    model: LUNA_MODEL,
    efforts: [resolvedTask.effort],
    workerCount: 1,
  });

  const liveRouting = routeLiveTask(resolvedTask, {
    policy: initialAdmission.policy,
    evidence: priorEvidence,
  });

  if (
    liveRouting.selection.reason === "no-authorised-next-execution" ||
    (priorEvidence && liveRouting.selectedModel === null)
  ) {
    dependencies.emit({
      type: "batch.rejected",
      batchId,
      reason: liveRouting.selection.detail,
    });
    log(`delegate_task selection refused: ${liveRouting.selection.detail}`);
    return {
      content: [{ type: "text" as const, text: liveRouting.selection.detail }],
      isError: true,
    };
  }

  let targetModel = liveRouting.selectedModel;
  if (!targetModel) {
    if (initialAdmission.policy.allowedModels.length === 1) {
      targetModel = initialAdmission.policy.allowedModels[0]!;
    } else if (initialAdmission.policy.allowedModels.includes(LUNA_MODEL)) {
      targetModel = LUNA_MODEL;
    } else {
      targetModel = initialAdmission.policy.allowedModels[0]!;
    }
  }

  const targetEffort = liveRouting.selectedEffort ?? resolvedTask.effort;

  const admission = admitCompute({
    requested: resolvedTask.computePolicy,
    model: targetModel,
    efforts: [targetEffort],
    workerCount: 1,
  });

  const task: DelegateTaskInput = {
    ...resolvedTask,
    effort: targetEffort,
    computePolicy: cloneComputePolicy(admission.policy),
  };
  const startedAt = Date.now();
  let workerStarted = false;
  let workerDirectory: string | null = null;
  log(
    `delegate_task: model=${targetModel} effort=${task.effort} cwd=${task.workingDirectory ?? process.cwd()} ` +
      `objective="${task.objective.slice(0, 80)}..."`,
  );

  dependencies.emit({
    type: "batch.started",
    batchId,
    mode: "single",
    taskCount: 1,
    maxParallel: 1,
    computePolicy: admission.policy,
  });

  // Structural routing gates come first on both delegation surfaces: a call
  // that declared no seam is malformed, and admitting compute for it would
  // be answering the wrong question. Compute policy is the second gate.
  const routingRefusal = refuseSingleDelegation(
    task.routingPreflight,
    batchId,
    dependencies.emit,
    admission.policy,
  );
  if (routingRefusal) {
    dependencies.emit({ type: "batch.rejected", batchId, reason: routingRefusal });
    log(`delegate_task refused: ${routingRefusal}`);
    return {
      content: [{ type: "text" as const, text: routingRefusal }],
      isError: true,
    };
  }

  if (admission.refusal) {
    dependencies.emit({ type: "batch.rejected", batchId, reason: admission.refusal });
    log(`delegate_task refused: ${admission.refusal}`);
    return {
      content: [{ type: "text" as const, text: admission.refusal }],
      isError: true,
    };
  }

  const routingAdvisory = routingAdvisoryLine(
    task.routingPreflight,
    {
      mode: "single",
      taskCount: 1,
    },
    admission.policy,
  );

  dependencies.emit({
    type: "task.queued",
    batchId,
    taskId,
    effort: task.effort,
    category: task.taskCategory,
    activityLabel: task.activityLabel,
    model: targetModel,
    attempt: logicalAttempt,
  });

  const lifecycleStore =
    dependencies.contextStore ?? dependencies.contextRegistry.getOrCreate(contextKey);
  const persistedContextKey = dependencies.contextStore ? null : contextKey;
  const releaseExecutionLease = lifecycleStore.acquireExecutionLease();
  let executionLeaseActive = true;
  const releaseExecution = (): void => {
    if (!executionLeaseActive) return;
    executionLeaseActive = false;
    releaseExecutionLease();
  };

  try {
    const result = await dependencies.delegateToLuna(
      task,
      signal,
      {
        onStarted: (workingDirectory) => {
          workerStarted = true;
          workerDirectory = workingDirectory;
          dependencies.emit({
            type: "worker.started",
            batchId,
            taskId,
            effort: task.effort,
            workingDirectory,
            model: targetModel,
            attempt: logicalAttempt,
          });
        },
        onVerificationStart: (commandCount, attribution) =>
          dependencies.emit({
            type: "verification.started",
            batchId,
            taskId,
            commandCount,
            executionId: attribution.executionId,
            attempt: attribution.logicalAttempt,
            role: attribution.role,
          }),
        onRepairStart: (classification, executionId) => {
          dependencies.emit({
            type: "repair.started",
            batchId,
            taskId,
            classification,
            turn: 1,
            executionId,
          });
        },
        onRepairComplete: (verdict, executionId) =>
          dependencies.emit({
            type: "repair.completed",
            batchId,
            taskId,
            verdict,
            turn: 1,
            executionId,
          }),
        onAttemptStart: (evidence) =>
          emitAttemptStarted(dependencies.emit, batchId, taskId, evidence),
        onAttemptComplete: (evidence) =>
          emitCanonicalAttemptCompletion(dependencies.emit, batchId, taskId, evidence),
      },
      targetModel,
      predecessorExecutionId,
      logicalAttempt,
    );
    if (workerDirectory) {
      try {
        result.continuationReference = registerContinuation(
          task,
          result,
          workerDirectory,
          false,
          null,
          dependencies.continuationStore,
          persistedContextKey,
        );
      } catch (error) {
        const detail = `Continuation registration failed after execution: ${(error as Error).message}`;
        result.verdict = "FAILED";
        result.trustworthy = false;
        result.errors.push(detail);
        result.continuationReference = null;
        result.continuationState = { status: "unavailable", reason: detail };
        applyFailureDecision(task, result);
      }
    }
    result.handoffReference = registerHandoff(task, result, dependencies.handoffStore, {
      authoritativePrior: priorEvidence !== undefined,
      workingDirectory: workerDirectory ?? undefined,
      contextKey: persistedContextKey,
    });
    emitSingleCompletion(
      batchId,
      taskId,
      task.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      result,
      dependencies.emit,
    );
    log(
      `done: verdict=${result.verdict} claimed=${result.workerClaimedStatus} ` +
        `thread=${result.workerThreadId ?? "?"} in ${result.durationSeconds}s`,
    );
    dependencies.record(result);

    lifecycleStore.recordDelegationTurn(task, result, {
      batchId,
      taskId,
    });
    releaseExecution();
    lifecycleStore.evaluateAndMaybeCompact("post-delegation", {
      batchId,
      emit: dependencies.emit,
    });

    const structuredContent = structuredResultForDetail(
      result,
      task.resultDetail ?? "handoff",
    );

    const rendered = renderResult(result, {
      batchId,
      taskId,
      integration: "single-task workspace",
    });
    const response = {
      content: [
        {
          type: "text" as const,
          text: routingAdvisory ? `${routingAdvisory}\n${rendered}` : rendered,
        },
      ],
    };
    return structuredContent ? { ...response, structuredContent } : response;
  } catch (error) {
    const message =
      error instanceof WorkspaceError
        ? error.message
        : `Delegation failed: ${(error as Error).message}`;

    if (workerStarted) {
      const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
      if (signal?.aborted) {
        dependencies.emit({
          type: "worker.cancelled",
          batchId,
          taskId,
          attempt: logicalAttempt,
        });
        dependencies.emit({
          type: "batch.cancelled",
          batchId,
          reason: "worker cancelled",
        });
      } else {
        dependencies.emit({
          type: "worker.failed",
          batchId,
          taskId,
          reason: message,
          attempt: logicalAttempt,
        });
        dependencies.emit({
          type: "batch.completed",
          batchId,
          durationSeconds,
          passed: 0,
          failed: 1,
        });
      }
    } else if (signal?.aborted) {
      dependencies.emit({
        type: "batch.cancelled",
        batchId,
        reason: "cancelled before worker start",
      });
    } else {
      dependencies.emit({ type: "batch.rejected", batchId, reason: message });
    }

    log(`error: ${message}`);
    lifecycleStore.recordRuntimeFailure({
      id: `blk_runtime_${batchId}_${taskId}`,
      description: message,
      objective: task.objective,
      acceptanceCriteria: task.acceptanceCriteria,
      allowedFiles: task.allowedFiles,
      forbiddenFiles: task.forbiddenFiles,
      changeIntent: task.changeIntent,
      taskCategory: task.taskCategory,
      taskId,
    });
    releaseExecution();
    lifecycleStore.evaluateAndMaybeCompact("post-delegation", {
      batchId,
      emit: dependencies.emit,
    });
    // Returned as a tool error (not a thrown protocol error) so the parent can read
    // the reason and adapt instead of seeing an opaque transport failure.
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  } finally {
    releaseExecution();
    if (persistedContextKey) {
      dependencies.contextRegistry.releaseIfUnreferenced(persistedContextKey);
    }
  }
}

function registerDelegateTask(): void {
  server.registerTool(
    "delegate_task",
    {
      title: "Delegate a bounded task to a Luna worker",
      description: TOOL_DESCRIPTION,
      inputSchema: delegateTaskMcpInputShape,
    },
    async (input, extra) => {
      return handleDelegateTask(input as DelegateTaskInput, extra?.signal);
    },
  );
}

export interface ContinuationHandlerDependencies {
  store: ContinuationStore;
  handoffStore: HandoffStore;
  contextStore?: ContextLifecycleStore;
  contextRegistry: ContextLifecycleRegistry;
  continueTask: typeof continueToLuna;
  reconcile: typeof reconcileRetainedContinuationEvidence;
  refreshLease: typeof refreshWorktreeLease;
  releaseLease: typeof releaseWorktreeLease;
  emit: EventEmitter;
  record: typeof recordEvent;
  makeBatchId: () => string;
}

/** Internal dependency seam for deterministic continuation lifecycle tests. */
export async function handleContinueTask(
  request: ContinueTaskInput,
  signal?: AbortSignal,
  overrides: Partial<ContinuationHandlerDependencies> = {},
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: DelegateTaskOutput;
  isError?: boolean;
}> {
  const dependencies: ContinuationHandlerDependencies = {
    store: continuationStore,
    handoffStore,
    contextRegistry,
    continueTask: continueToLuna,
    reconcile: reconcileRetainedContinuationEvidence,
    refreshLease: refreshWorktreeLease,
    releaseLease: releaseWorktreeLease,
    emit: emitEvent,
    record: recordEvent,
    makeBatchId: makeSingleBatchId,
    ...overrides,
  };
  const reserved = dependencies.store.consume(request.continuationReference);
  if (reserved.status !== "ready") {
    const message = continuationError(reserved);
    log(`continue_task rejected: ${message}`);
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  }

  const { entry } = reserved;
  const batchId = dependencies.makeBatchId();
  const taskId = "t1";
  const contextKey = entry.contextKey ?? batchId;
  const lifecycleStore =
    dependencies.contextStore ?? dependencies.contextRegistry.getOrCreate(contextKey);
  const persistedContextKey = dependencies.contextStore ? null : contextKey;
  const releaseExecutionLease = lifecycleStore.acquireExecutionLease();
  let executionLeaseActive = true;
  const releaseExecution = (): void => {
    if (!executionLeaseActive) return;
    executionLeaseActive = false;
    releaseExecutionLease();
  };
  const timeoutSeconds = entry.input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (entry.worktreeLease) {
    try {
      await dependencies.refreshLease(
        entry.worktreeLease,
        Date.now() + timeoutSeconds * 1000 + WORKTREE_LEASE_GRACE_MS,
        "executing-continuation",
      );
    } catch (error) {
      let message =
        `Continuation could not start because its retained worktree lease ` +
        `could not be refreshed: ${(error as Error).message}`;
      try {
        await dependencies.releaseLease(entry.worktreeLease);
      } catch (cleanupError) {
        message += ` Worktree lease cleanup also failed: ${(cleanupError as Error).message}`;
      }
      log(`continue_task rejected: ${message}`);
      lifecycleStore.recordRuntimeFailure({
        id: `blk_runtime_${batchId}_${taskId}`,
        description: message,
        objective: entry.input.objective,
        acceptanceCriteria: entry.input.acceptanceCriteria,
        allowedFiles: entry.input.allowedFiles,
        forbiddenFiles: entry.input.forbiddenFiles,
        changeIntent: entry.input.changeIntent,
        taskCategory: entry.input.taskCategory,
        taskId,
      });
      releaseExecution();
      dependencies.store.release(request.continuationReference);
      lifecycleStore.evaluateAndMaybeCompact("post-continuation", {
        batchId,
        emit: dependencies.emit,
      });
      if (persistedContextKey) {
        dependencies.contextRegistry.releaseIfUnreferenced(persistedContextKey);
      }
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  }
  const startedAt = Date.now();
  let workerStarted = false;
  let worktreeLeaseFinalized = false;
  log(
    `continue_task: thread=${entry.threadId} instruction="${request.instruction.slice(0, 80)}..."`,
  );

  dependencies.emit({
    type: "batch.started",
    batchId,
    mode: "single",
    taskCount: 1,
    maxParallel: 1,
  });
  dependencies.emit({
    type: "task.queued",
    batchId,
    taskId,
    effort: entry.input.effort,
    category: entry.input.taskCategory,
    activityLabel: entry.input.activityLabel,
    model: entry.model,
    attempt: entry.logicalAttempt,
  });

  try {
    let result = await dependencies.continueTask(entry.input, {
      workingDirectory: entry.workingDirectory,
      threadId: entry.threadId,
      instruction: request.instruction,
      signal,
      hooks: {
        onStarted: (workingDirectory) => {
          workerStarted = true;
          dependencies.emit({
            type: "worker.started",
            batchId,
            taskId,
            effort: entry.input.effort,
            workingDirectory,
            model: entry.model,
            attempt: entry.logicalAttempt,
          });
        },
        onVerificationStart: (commandCount, attribution) =>
          dependencies.emit({
            type: "verification.started",
            batchId,
            taskId,
            commandCount,
            executionId: attribution.executionId,
            attempt: attribution.logicalAttempt,
            role: attribution.role,
          }),
        onAttemptStart: (evidence) =>
          emitAttemptStarted(dependencies.emit, batchId, taskId, evidence),
        onAttemptComplete: (evidence) =>
          emitCanonicalAttemptCompletion(dependencies.emit, batchId, taskId, evidence),
      },
      predecessorExecutionId: entry.predecessorExecutionId,
      logicalAttempt: entry.logicalAttempt,
      model: entry.model,
    });
    if (entry.reconcileFinalGit) {
      try {
        result = await dependencies.reconcile(
          entry.input,
          result,
          entry.workingDirectory,
        );
      } catch (error) {
        const detail = `Continuation evidence reconciliation failed after execution: ${(error as Error).message}`;
        result.verdict = "FAILED";
        result.trustworthy = false;
        result.errors.push(detail);
        result.discrepancies.push(detail);
      }
    }
    if (entry.worktreeLease) {
      try {
        await dependencies.releaseLease(entry.worktreeLease);
      } catch (error) {
        const detail = `Continuation worktree lease cleanup failed after execution: ${(error as Error).message}`;
        result.verdict = "FAILED";
        result.trustworthy = false;
        result.errors.push(detail);
      } finally {
        worktreeLeaseFinalized = true;
      }
    }
    result.continuationReference = null;
    result.continuationState = {
      status: "consumed",
      reason: "The single-use continuation bound was consumed by this execution.",
    };
    applyFailureDecision(entry.input, result);
    result.handoffReference = registerHandoff(
      entry.input,
      result,
      dependencies.handoffStore,
      {
        workingDirectory: entry.workingDirectory,
        contextKey: persistedContextKey,
      },
    );
    emitSingleCompletion(batchId, taskId, timeoutSeconds, result, dependencies.emit);
    dependencies.record(result);

    lifecycleStore.recordContinuationTurn(
      {
        continuationReference: request.continuationReference,
        instruction: request.instruction,
        taskId,
      },
      result,
      { id: batchId },
    );
    releaseExecution();
    lifecycleStore.evaluateAndMaybeCompact("post-continuation", {
      batchId,
      emit: dependencies.emit,
    });

    const structuredContent = structuredResultForDetail(
      result,
      request.resultDetail ?? "handoff",
    );
    const response = {
      content: [
        {
          type: "text" as const,
          text: renderResult(result, {
            batchId,
            taskId,
            integration: entry.reconcileFinalGit
              ? "retained workspace reconciled"
              : "single-task workspace",
          }),
        },
      ],
    };
    return structuredContent ? { ...response, structuredContent } : response;
  } catch (error) {
    const message =
      error instanceof WorkspaceError
        ? error.message
        : `Continuation failed: ${(error as Error).message}`;
    if (workerStarted) {
      const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
      if (signal?.aborted) {
        dependencies.emit({
          type: "worker.cancelled",
          batchId,
          taskId,
          attempt: entry.logicalAttempt,
        });
        dependencies.emit({
          type: "batch.cancelled",
          batchId,
          reason: "worker cancelled",
        });
      } else {
        dependencies.emit({
          type: "worker.failed",
          batchId,
          taskId,
          reason: message,
          attempt: entry.logicalAttempt,
        });
        dependencies.emit({
          type: "batch.completed",
          batchId,
          durationSeconds,
          passed: 0,
          failed: 1,
        });
      }
    } else if (signal?.aborted) {
      dependencies.emit({
        type: "batch.cancelled",
        batchId,
        reason: "cancelled before worker start",
      });
    } else {
      dependencies.emit({ type: "batch.rejected", batchId, reason: message });
    }
    log(`continue_task error: ${message}`);
    if (entry.worktreeLease && !worktreeLeaseFinalized) {
      try {
        await dependencies.releaseLease(entry.worktreeLease);
      } catch (cleanupError) {
        log(
          `Continuation worktree lease cleanup failed: ${(cleanupError as Error).message}`,
        );
      } finally {
        worktreeLeaseFinalized = true;
      }
    }
    lifecycleStore.recordRuntimeFailure({
      id: `blk_runtime_${batchId}_${taskId}`,
      description: message,
      objective: entry.input.objective,
      acceptanceCriteria: entry.input.acceptanceCriteria,
      allowedFiles: entry.input.allowedFiles,
      forbiddenFiles: entry.input.forbiddenFiles,
      changeIntent: entry.input.changeIntent,
      taskCategory: entry.input.taskCategory,
      taskId,
    });
    releaseExecution();
    lifecycleStore.evaluateAndMaybeCompact("post-continuation", {
      batchId,
      emit: dependencies.emit,
    });
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  } finally {
    releaseExecution();
    dependencies.store.release(request.continuationReference);
    if (entry.worktreeLease && !worktreeLeaseFinalized) {
      try {
        await dependencies.releaseLease(entry.worktreeLease);
      } catch (error) {
        log(`Continuation worktree lease cleanup failed: ${(error as Error).message}`);
      }
    }
    if (persistedContextKey) {
      dependencies.contextRegistry.releaseIfUnreferenced(persistedContextKey);
    }
  }
}

function registerContinueTask(): void {
  server.registerTool(
    "continue_task",
    {
      title: "Continue an eligible Luna task",
      description: CONTINUE_TOOL_DESCRIPTION,
      inputSchema: continueTaskMcpInputShape,
    },
    async (input, extra) => {
      return handleContinueTask(input as ContinueTaskInput, extra?.signal);
    },
  );
}

export const BATCH_TOOL_DESCRIPTION = `Delegate a batch intended for two or more owned seams to ${LUNA_MODEL}; one task remains accepted for compatibility, but prefer delegate_task when no scheduling is needed. Use sequential for dependencies/shared workspace state and parallel only for genuinely independent disjoint declared scopes. Do not create artificial seams. At most ${MAX_BATCH_SIZE} tasks are accepted and at most ${MAX_PARALLEL} run concurrently; the rest queue. Each task needs a self-contained contract and a concise activityLabel when a safe label exists. The parent owns architecture/interfaces and exceptional judgement; Luna owns exploration, implementation, verification, and repair. automaticRepair is one bounded task-local turn.

Parallel same-file edits prevent automatic integration. allowOverlappingScopes:true only accepts the declared overlap; it is not a write sandbox and does not permit same-file integration. integrate=false skips copying and retention follows operator policy. Partial outcomes remain visible. automaticRecovery defaults true: at most one evidence-eligible timeout continuation or exact process-exit retry; a counter alone never authorizes retry. Repair precedes recovery and neither nests. Successes, cancellation, scope/security/evidence failures, refused checks, discrepancies, and conflicts are never retried. Successful streams survive sibling failure.

After integration, deterministic code reruns the deduplicated union of declared checks in the final workspace. completionState=verified-complete means all seams, integration, and final checks passed; the default text-only handoff then tells the parent to finish without rereading files or rerunning checks. Any failure/refusal/conflict returns rich evidence for targeted diagnosis. resultDetail is one batch-level compatibility choice. More workers are not automatically cheaper; raw tokens are not credit cost and savings depend on the parent and task mix. While pending with no meaningful new state, remain silent; do not narrate waiting or polling. Report only a result, error, cancellation, timeout, or actionable state change.`;

export interface DelegateTasksHandlerDependencies {
  handoffStore: HandoffStore;
  continuationStore: ContinuationStore;
  contextStore?: ContextLifecycleStore;
  contextRegistry: ContextLifecycleRegistry;
  runBatch: typeof runBatch;
  emit: EventEmitter;
  makeBatchId: () => string;
}

export async function handleDelegateTasks(
  batch: DelegateTasksInput,
  signal?: AbortSignal,
  overrides: Partial<DelegateTasksHandlerDependencies> = {},
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: BatchOutput;
  isError?: boolean;
}> {
  const dependencies: DelegateTasksHandlerDependencies = {
    handoffStore,
    continuationStore,
    contextRegistry,
    runBatch,
    emit: emitEvent,
    makeBatchId: makeSingleBatchId,
    ...overrides,
  };
  log(
    `delegate_tasks: mode=${batch.mode} tasks=${batch.tasks.length} ` +
      `efforts=[${batch.tasks.map((task) => task.effort).join(",")}]`,
  );

  const admission = admitCompute({
    requested: batch.computePolicy,
    model: LUNA_MODEL,
    efforts: batch.tasks.map((task) => task.effort),
    workerCount: batch.tasks.length,
  });
  if (admission.refusal) {
    const refusedBatchId = dependencies.makeBatchId();
    dependencies.emit({
      type: "batch.started",
      batchId: refusedBatchId,
      mode: batch.mode,
      taskCount: batch.tasks.length,
      maxParallel: batch.mode === "parallel" ? admission.policy.maxConcurrency : 1,
      computePolicy: admission.policy,
    });
    dependencies.emit({
      type: "batch.rejected",
      batchId: refusedBatchId,
      reason: admission.refusal,
    });
    log(`delegate_tasks refused: ${admission.refusal}`);
    return {
      content: [{ type: "text" as const, text: admission.refusal }],
      isError: true,
    };
  }

  const routingAdvisory = routingAdvisoryLine(
    batch.routingPreflight,
    {
      mode: batch.mode,
      taskCount: batch.tasks.length,
      allowOverlappingScopes: batch.allowOverlappingScopes,
    },
    admission.policy,
  );

  const admittedTasks = (batch.tasks as DelegateTaskInput[]).map((task) => ({
    ...task,
    computePolicy: cloneComputePolicy(admission.policy),
  }));

  const contextKey = dependencies.makeBatchId();
  const lifecycleStore =
    dependencies.contextStore ?? dependencies.contextRegistry.getOrCreate(contextKey);
  const persistedContextKey = dependencies.contextStore ? null : contextKey;
  const releaseExecutionLease = lifecycleStore.acquireExecutionLease();
  let executionLeaseActive = true;
  const releaseExecution = (): void => {
    if (!executionLeaseActive) return;
    executionLeaseActive = false;
    releaseExecutionLease();
  };

  try {
    const result = await dependencies.runBatch(admittedTasks, {
      mode: batch.mode,
      workingDirectory: batch.workingDirectory,
      allowOverlappingScopes: batch.allowOverlappingScopes,
      integrate: batch.integrate,
      automaticRecovery: batch.automaticRecovery,
      signal,
      batchId: contextKey,
      continuationRegistrar: (input, res, cwd, reconcile, lease) =>
        registerContinuation(
          input,
          res,
          cwd,
          reconcile,
          lease,
          dependencies.continuationStore,
          persistedContextKey,
        ),
      handoffStore: dependencies.handoffStore,
      handoffContextKey: persistedContextKey,
      protectedWorktreePaths:
        dependencies.continuationStore.protectedWorkingDirectories(),
      routingPreflight: batch.routingPreflight,
      computePolicy: admission.policy,
      eventEmitter: dependencies.emit,
    });
    log(
      `batch done: ${result.passed}/${result.taskCount} passed in ` +
        `${result.durationSeconds}s, integrated=${result.integrated}`,
    );

    lifecycleStore.recordBatchTurn(batch, result, { id: result.batchId });
    releaseExecution();
    lifecycleStore.evaluateAndMaybeCompact("post-batch", {
      batchId: result.batchId,
      emit: dependencies.emit,
    });

    const structuredContent = structuredBatchForDetail(
      result,
      batch.resultDetail ?? "handoff",
    );

    const rendered = renderBatch(result);
    const response = {
      content: [
        {
          type: "text" as const,
          text: routingAdvisory ? `${routingAdvisory}\n${rendered}` : rendered,
        },
      ],
    };
    return structuredContent ? { ...response, structuredContent } : response;
  } catch (error) {
    const message =
      error instanceof BatchRejectedError || error instanceof WorkspaceError
        ? error.message
        : `Batch delegation failed: ${(error as Error).message}`;
    log(`batch error: ${message}`);
    lifecycleStore.recordRuntimeFailure({
      id: `blk_runtime_${contextKey}`,
      description: message,
      objective: batch.tasks[0]?.objective ?? "Batch delegation",
      acceptanceCriteria: batch.tasks.flatMap((task) => task.acceptanceCriteria),
      allowedFiles: [...new Set(batch.tasks.flatMap((task) => task.allowedFiles))],
      forbiddenFiles: [...new Set(batch.tasks.flatMap((task) => task.forbiddenFiles))],
      changeIntent: batch.tasks[0]?.changeIntent ?? "required",
    });
    releaseExecution();
    lifecycleStore.evaluateAndMaybeCompact("post-batch", {
      batchId: contextKey,
      emit: dependencies.emit,
    });
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  } finally {
    releaseExecution();
    if (persistedContextKey) {
      dependencies.contextRegistry.releaseIfUnreferenced(persistedContextKey);
    }
  }
}

function registerDelegateTasks(): void {
  server.registerTool(
    "delegate_tasks",
    {
      title: "Delegate several tasks to Luna workers",
      description: BATCH_TOOL_DESCRIPTION,
      inputSchema: delegateTasksMcpInputShape,
    },
    async (input, extra) => {
      return handleDelegateTasks(input as DelegateTasksInput, extra?.signal);
    },
  );
}

function makePreflightId(): string {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export interface RoutingPreflightHandlerDependencies {
  emit: EventEmitter;
  makePreflightId: () => string;
}

export function handleRoutingPreflight(
  input: RoutingPreflightInput,
  overrides: Partial<RoutingPreflightHandlerDependencies> = {},
): { content: Array<{ type: "text"; text: string }> } {
  const dependencies: RoutingPreflightHandlerDependencies = {
    emit: emitEvent,
    makePreflightId,
    ...overrides,
  };
  const card = asRoutingCard(input);
  const { evaluation, selection } = evaluateAdaptiveCard({
    card,
    context: { mode: "preflight" },
    policy: DEFAULT_COMPUTE_POLICY,
  });
  const preflightId = dependencies.makePreflightId();
  dependencies.emit({
    type: "routing.preflight",
    preflightId,
    route: evaluation.route,
    seamCount: evaluation.seamCount,
    unknownCount: evaluation.unknownCount,
    gates: evaluation.gates,
    signals: evaluation.signals,
    parallelEligible: evaluation.parallelEligible,
    recommendedMechanism: evaluation.shape?.mechanism,
    recommendedWorkerCount: evaluation.shape?.workerCount,
    recommendedConcurrency: evaluation.shape?.concurrency,
    recommendedEffort: evaluation.shape?.effort,
    selectedModel: selection.model,
    selectedEffort: selection.effort,
    selectionReason: selection.reason,
    ...declaredRoutingFields(card),
  });
  log(
    `routing_preflight: route=${evaluation.route} seams=${evaluation.seamCount} ` +
      `unknown=${evaluation.unknownCount} parallelEligible=${evaluation.parallelEligible} ` +
      `shape=${evaluation.shape?.mechanism ?? "none"}`,
  );
  return {
    content: [{ type: "text" as const, text: renderRoutingPreflight(evaluation) }],
  };
}

function registerRoutingPreflight(): void {
  server.registerTool(
    "routing_preflight",
    {
      title: "Check cheaply whether delegating is worth it",
      description: ROUTING_PREFLIGHT_TOOL_DESCRIPTION,
      inputSchema: routingPreflightMcpInputShape,
    },
    (input) => {
      return handleRoutingPreflight(input as RoutingPreflightInput);
    },
  );
}

export function isCleanExplore(result: ExploreOutput): boolean {
  return (
    result.verdict === "PASS" &&
    result.workerClaimedStatus === "PASS" &&
    result.trustworthy &&
    result.observedFilesChanged.length === 0 &&
    result.scopeViolations.length === 0 &&
    result.discrepancies.length === 0 &&
    result.errors.length === 0 &&
    result.findings.observedFacts.every(
      (fact) => fact.provenance === "worker" && fact.grounding === "runtime-verified",
    )
  );
}

export function renderExploreResult(
  result: ExploreOutput,
  detail: ExploreInput["resultDetail"] = "handoff",
): string {
  if (detail === "full") {
    return JSON.stringify(result, null, 2);
  }
  if (detail === "compact") {
    return JSON.stringify(compactExploreResult(result), null, 2);
  }

  const lines: string[] = [];
  lines.push(
    `EXPLORATION VERDICT: ${result.verdict} | TRUSTWORTHY: ${result.trustworthy}`,
  );
  lines.push(
    `WORKER: ${result.model} @ ${result.effort} | thread ${result.workerThreadId ?? "unknown"} | ${result.durationSeconds}s`,
  );
  lines.push(`TARGET: ${result.target}`);
  if (result.findings.summary) {
    lines.push(`SUMMARY: ${result.findings.summary}`);
  }

  if (result.findings.observedFacts.length > 0) {
    lines.push(`WORKER-GROUNDED CLAIMS (${result.findings.observedFacts.length}):`);
    for (const f of result.findings.observedFacts) {
      const src = f.sourceFile ? ` [${f.sourceFile}:${f.sourceLine}]` : "";
      const ev = f.evidence ? ` (evidence: ${f.evidence})` : "";
      lines.push(`- ${f.statement}${src}${ev} [${f.provenance}; ${f.grounding}]`);
    }
  }

  if (result.findings.runtimeObservedFacts.length > 0) {
    lines.push(
      `RUNTIME-OBSERVED FACTS (${result.findings.runtimeObservedFacts.length}):`,
    );
    for (const fact of result.findings.runtimeObservedFacts) {
      const source = fact.sourceFile
        ? ` [${fact.sourceFile}${fact.sourceLine ? `:${fact.sourceLine}` : ""}]`
        : "";
      lines.push(`- ${fact.statement}${source}`);
    }
  }

  if (result.findings.inferences.length > 0) {
    lines.push(`INFERENCES (${result.findings.inferences.length}):`);
    for (const inf of result.findings.inferences) {
      lines.push(`- ${inf.hypothesis} (rationale: ${inf.rationale})`);
    }
  }

  if (result.findings.unknowns.length > 0) {
    lines.push(`UNKNOWNS (${result.findings.unknowns.length}):`);
    for (const u of result.findings.unknowns) {
      lines.push(`- ${u.question} (unresolved: ${u.whyUnresolved})`);
    }
  }

  if (result.findings.relevantFiles.length > 0) {
    lines.push(
      `RELEVANT FILES: ${result.findings.relevantFiles.map((rf) => `${rf.path} (${rf.why})`).join(", ")}`,
    );
  }

  if (result.findings.recommendedSeams.length > 0) {
    lines.push(`CANDIDATE SEAMS:`);
    for (const s of result.findings.recommendedSeams) {
      const files =
        s.candidateFiles.length > 0 ? ` [${s.candidateFiles.join(", ")}]` : "";
      lines.push(`- ${s.label}: ${s.description}${files}`);
    }
  }

  if (result.discrepancies.length > 0) {
    lines.push(`DISCREPANCIES: ${result.discrepancies.join("; ")}`);
  }
  if (result.scopeViolations.length > 0) {
    lines.push(`SCOPE VIOLATIONS: ${result.scopeViolations.join("; ")}`);
  }
  if (result.errors.length > 0) {
    lines.push(`ERRORS: ${result.errors.join("; ")}`);
  }

  if (result.reviewChecklist.length > 0) {
    lines.push(`REVIEW CHECKLIST: ${result.reviewChecklist.join("; ")}`);
  }

  lines.push(
    result.verdict === "PASS"
      ? "NEXT: Treat worker-grounded claims and advisory seams as supervisor input, or stay solo."
      : "NEXT: Resolve discrepancies or errors before delegating implementation.",
  );

  return lines.join("\n");
}

export function compactExploreResult(result: ExploreOutput): Record<string, unknown> {
  return {
    target: result.target,
    verdict: result.verdict,
    workerClaimedStatus: result.workerClaimedStatus,
    trustworthy: result.trustworthy,
    model: result.model,
    effort: result.effort,
    durationSeconds: result.durationSeconds,
    findings: result.findings,
    observedFilesChanged: result.observedFilesChanged,
    scopeViolations: result.scopeViolations,
    discrepancies: result.discrepancies,
    reviewChecklist: result.reviewChecklist,
    errors: result.errors,
  };
}

export interface ExploreHandlerDependencies {
  exploreWithLuna: typeof exploreWithLuna;
  emit: EventEmitter;
  contextStore?: ContextLifecycleStore;
  contextRegistry: ContextLifecycleRegistry;
  admitCompute: typeof admitCompute;
}

export async function handleExplore(
  input: ExploreInput,
  signal?: AbortSignal,
  overrides?: Partial<ExploreHandlerDependencies>,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  const deps: ExploreHandlerDependencies = {
    exploreWithLuna: overrides?.exploreWithLuna ?? exploreWithLuna,
    emit: overrides?.emit ?? emitEvent,
    contextRegistry: overrides?.contextRegistry ?? contextRegistry,
    contextStore: overrides?.contextStore,
    admitCompute: overrides?.admitCompute ?? admitCompute,
  };

  const batchId = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const contextKey = batchId;
  const lifecycleStore =
    deps.contextStore ?? deps.contextRegistry.getOrCreate(contextKey);
  const releaseLease = lifecycleStore.acquireExecutionLease();

  const admission = deps.admitCompute({
    requested: input.computePolicy,
    model: LUNA_MODEL,
    efforts: [input.effort],
    workerCount: 1,
  });

  if (admission.refusal) {
    releaseLease();
    deps.emit({
      type: "explore.rejected",
      batchId,
      reasonCode: "compute-policy",
    });
    deps.contextRegistry.releaseIfUnreferenced(contextKey);
    return {
      content: [{ type: "text", text: `EXPLORATION REFUSED: ${admission.refusal}` }],
      isError: true,
    };
  }

  // Admission authorizes the fixed explorer executor; the policy list is an
  // envelope, not an instruction to silently substitute its first entry.
  const model = LUNA_MODEL;
  const effort = input.effort;

  let executionStarted = false;
  try {
    const result = await deps.exploreWithLuna(
      { ...input, effort },
      signal,
      {
        onStarted: () => {
          executionStarted = true;
          deps.emit({
            type: "explore.started",
            batchId,
            activityLabel: input.activityLabel,
            requestedModel: LUNA_MODEL,
            requestedEffort: input.effort,
            selectedModel: model,
            selectedEffort: effort,
            computePolicy: admission.policy,
          });
        },
        onAttemptStart: (evidence) =>
          emitAttemptStarted(deps.emit, batchId, "explorer", evidence),
        onAttemptComplete: (evidence) =>
          emitAttemptCompleted(deps.emit, batchId, "explorer", evidence),
      },
      model,
    );

    lifecycleStore.recordExplorationTurn(input, result, { id: batchId });

    deps.emit({
      type: "explore.completed",
      batchId,
      verdict: result.verdict,
      claimed: result.workerClaimedStatus,
      durationSeconds: result.durationSeconds,
      workerGroundedClaimsCount: result.findings.observedFacts.length,
      runtimeFactsCount: result.findings.runtimeObservedFacts.length,
      inferencesCount: result.findings.inferences.length,
      unknownsCount: result.findings.unknowns.length,
      executedModel: result.model,
      executedEffort: result.effort,
      usage: result.usage,
    });

    const rendered = renderExploreResult(result, input.resultDetail);
    const structuredContent =
      input.resultDetail === "compact"
        ? compactExploreResult(result)
        : input.resultDetail === "full" || !isCleanExplore(result)
          ? (result as unknown as Record<string, unknown>)
          : undefined;

    return {
      content: [{ type: "text", text: rendered }],
      ...(structuredContent ? { structuredContent } : {}),
      isError: result.verdict !== "PASS",
    };
  } catch (error) {
    const errMessage = (error as Error).message;
    lifecycleStore.recordRuntimeFailure({
      id: `err_${batchId}`,
      description: errMessage,
      objective: input.target,
      acceptanceCriteria: input.questions ?? [],
      changeIntent: "forbidden",
      taskCategory: "investigation",
    });
    if (executionStarted) {
      deps.emit({
        type: "explore.completed",
        batchId,
        verdict: "FAILED",
        claimed: null,
        durationSeconds: 0,
        workerGroundedClaimsCount: 0,
        runtimeFactsCount: 0,
        inferencesCount: 0,
        unknownsCount: 0,
        executedModel: model,
        executedEffort: effort,
        usage: null,
      });
    } else {
      deps.emit({
        type: "explore.rejected",
        batchId,
        reasonCode: "execution-setup",
      });
    }
    return {
      content: [{ type: "text", text: `EXPLORATION FAILED: ${errMessage}` }],
      isError: true,
    };
  } finally {
    releaseLease();
    lifecycleStore.evaluateAndMaybeCompact("post-exploration", {
      batchId,
      emit: deps.emit,
    });
    deps.contextRegistry.releaseIfUnreferenced(contextKey);
  }
}

export function registerExplore(targetServer: McpServer = server): void {
  targetServer.registerTool(
    "explore",
    {
      title: "Explore repository, API, or documentation with Luna",
      description: EXPLORE_TOOL_DESCRIPTION,
      inputSchema: exploreMcpInputShape,
    },
    async (input, extra) => {
      const parsed = exploreInputSchema.parse(input);
      return await handleExplore(parsed, extra?.signal);
    },
  );
}

/** Render a batch result as readable text for the model's transcript. */
function renderRichBatch(batch: BatchOutput): string {
  const lines: string[] = [];
  const compact = (value: string): string => value.replace(/\s+/g, " ").trim();
  const verificationSummary = (result: DelegateTaskOutput): string => {
    const authoritative = result.verification.filter(
      (run) => run.source === "orchestrator",
    );
    const executed = authoritative.filter(
      (run) => run.execution === "argv" || run.execution === "shell",
    );
    const refused = authoritative.filter(
      (run) => run.execution === "rejected" || run.execution === "skipped",
    );
    const reported = result.verification.filter((run) => run.source === "worker");
    const authoritativeCounts =
      `${executed.length} executed (${executed.filter((run) => run.passed).length} passed, ` +
      `${executed.filter((run) => !run.passed).length} failed), ${refused.length} refused`;
    const reportedCounts =
      `${reported.filter((run) => run.passed).length} passed, ` +
      `${reported.filter((run) => !run.passed).length} failed`;
    return `authoritative ${authoritativeCounts}; worker-reported ${reportedCounts}`;
  };

  lines.push(
    `BATCH ${batch.batchId} | ${batch.mode} | ${batch.passed}/${batch.taskCount} passed | ` +
      `${batch.durationSeconds}s | max parallel ${batch.maxParallel}`,
  );
  lines.push("");

  for (const task of batch.tasks) {
    const verdict = task.result?.verdict ?? task.state.toUpperCase();
    const claimed = task.result
      ? ` (worker claimed ${task.result.workerClaimedStatus})`
      : "";
    const flag = task.result && !task.result.trustworthy ? "  ! NEEDS SCRUTINY" : "";
    lines.push(`[${task.taskId}] ${verdict}${claimed}${flag}`);
    const result = task.result;
    if ((result?.workerClaimedFailureCauses?.length ?? 0) > 0) {
      lines.push(
        `    worker-claimed failure causes: ${result!.workerClaimedFailureCauses!.join(", ")}`,
      );
    }
    lines.push(
      `    model: ${result?.model ?? "unknown"} | effort: ${task.effort} | ` +
        `attempt: ${task.attempt ?? result?.attempt ?? 1} | duration: ${result ? `${result.durationSeconds}s` : "unknown"}`,
    );
    if (result) lines.push(`    verification: ${verificationSummary(result)}`);
    if (result) lines.push(`    change intent: ${result.changeIntent}`);
    if (result?.repair) {
      lines.push(
        `    repair: ${result.repair.attempted ? "attempted" : "not attempted"} | ` +
          `${result.repair.classification} | ${compact(result.repair.reason)}`,
      );
    }
    if (task.recovery ?? result?.recovery) {
      const recovery = task.recovery ?? result?.recovery;
      lines.push(
        `    recovery: ${recovery!.attempted ? "attempted" : "not attempted"} | ` +
          `${recovery!.classification} | ${compact(recovery!.evidence)}`,
      );
      if (recovery!.attempted) {
        lines.push(
          `    recovery usage/duration: ${recovery!.recoveryUsage ? `${recovery!.recoveryUsage.inputTokens} in / ${recovery!.recoveryUsage.outputTokens} out` : "unknown usage"} / ${recovery!.recoveryDurationSeconds ?? "unknown"}s`,
        );
      }
    }
    if (result?.continuationReference) {
      lines.push(`    continuation: ${result.continuationReference}`);
    }
    if (result?.handoffReference) {
      lines.push(`    handoff: ${result.handoffReference}`);
    }
    const failureDecision = task.failureDecision ?? result?.failureDecision;
    if (failureDecision) {
      lines.push(
        `    failure decision: ${failureDecision.classification} -> ` +
          `${failureDecision.action}${failureDecision.nextEffort ? ` (${failureDecision.nextEffort})` : ""} | ` +
          `${compact(failureDecision.reason)}`,
      );
    }

    if (result?.summary)
      lines.push(`    worker summary (claim): ${compact(result.summary)}`);
    if (task.error) lines.push(`    error: ${task.error}`);
    for (const error of result?.errors ?? [])
      lines.push(`    runtime error: ${compact(error)}`);

    if (task.changedFiles.length > 0) {
      lines.push(`    changed: ${task.changedFiles.join(", ")}`);
    }
    for (const discrepancy of result?.discrepancies ?? []) {
      lines.push(`    ! ${discrepancy}`);
    }
    for (const violation of result?.scopeViolations ?? []) {
      lines.push(`    ! scope: ${violation}`);
    }
    for (const item of result?.reviewChecklist ?? []) {
      lines.push(`    review: ${compact(item)}`);
    }
    if (result?.usage) {
      lines.push(
        `    usage: ${result.usage.inputTokens} in (${result.usage.cachedInputTokens} cached) ` +
          `| ${result.usage.outputTokens} out (${result.usage.reasoningOutputTokens} reasoning)`,
      );
    }
    if (task.worktreePath) {
      lines.push(`    worktree kept: ${task.worktreePath}`);
    }
    for (const warning of task.warnings) lines.push(`    note: ${warning}`);
    lines.push("");
  }

  if (batch.scopeConflicts.length > 0) {
    lines.push("SCOPE CONFLICTS");
    for (const conflict of batch.scopeConflicts) lines.push(`  ! ${conflict}`);
    lines.push("");
  }

  if (batch.mode === "parallel" && batch.integrationConflicts.length > 0) {
    lines.push("INTEGRATION CONFLICTS (same file changed by several workers)");
    for (const conflict of batch.integrationConflicts) {
      lines.push(`  ! ${conflict.path} <- ${conflict.tasks.join(", ")}`);
    }
    lines.push("");
  }

  lines.push(`INTEGRATION: ${batch.integrationSummary}`);

  lines.push("\nFINAL WORKSPACE VERIFICATION");
  if (batch.integrationVerification.length === 0) {
    lines.push("  (not run)");
  } else {
    for (const run of batch.integrationVerification) {
      lines.push(
        `  ${run.passed ? "PASS" : "FAIL"} ${run.command} ` +
          `(exit ${run.exitCode ?? "n/a"}, ${run.execution})`,
      );
      if (!run.passed && run.output) {
        lines.push(
          run.output
            .split("\n")
            .slice(-12)
            .map((line) => `       ${line}`)
            .join("\n"),
        );
      }
    }
  }
  lines.push(`COMPLETION STATE: ${batch.completionState}`);

  if (batch.warnings.length > 0) {
    lines.push("\nWARNINGS");
    for (const warning of batch.warnings) lines.push(`  - ${warning}`);
  }

  lines.push("\nYOUR REVIEW BEFORE ACCEPTING");
  for (const item of batch.reviewChecklist) lines.push(`  [ ] ${item}`);

  return lines.join("\n");
}

/** Compact batch handoff; retain the rich renderer for every actionable result. */
export function renderBatch(batch: BatchOutput): string {
  if (!isCleanBatch(batch)) return renderRichBatch(batch);

  const lines = [
    `BATCH ${batch.batchId} | ${batch.mode} | ${batch.passed}/${batch.taskCount} passed`,
  ];
  for (const task of batch.tasks) {
    const result = task.result!;
    const paths = result.filesChanged
      .filter((file) => file.observed)
      .map((file) => file.path);
    lines.push(`[${task.taskId}] PASS`);
    lines.push(`  attempt: ${task.attempt ?? result.attempt}`);
    if (task.recovery?.attempted || result.recovery?.attempted) {
      const recovery = task.recovery ?? result.recovery!;
      lines.push(
        `  recovery: ${recovery.classification} (attempt ${recovery.recoveryAttempt})`,
      );
    }
    lines.push(`  changed: ${paths.length > 0 ? paths.join(", ") : "(none)"}`);
    lines.push(
      `  verification: authoritative ${authoritativeVerificationCounts(result)}`,
    );
    const risks = [result.notes.trim(), ...result.followUps].filter(Boolean);
    if (risks.length > 0) lines.push(`  risks: ${risks.join("; ")}`);
    if (result.continuationReference)
      lines.push(`  continuation: ${result.continuationReference}`);
    if (result.handoffReference) lines.push(`  handoff: ${result.handoffReference}`);
  }
  lines.push(`INTEGRATION: ${batch.integrationSummary}`);
  const finalPassed = batch.integrationVerification.filter((run) => run.passed).length;
  const finalExecuted = batch.integrationVerification.filter(
    (run) => run.execution === "argv" || run.execution === "shell",
  ).length;
  const finalRefused = batch.integrationVerification.filter(
    (run) => run.execution === "rejected" || run.execution === "skipped",
  ).length;
  lines.push(
    `FINAL VERIFICATION: ${finalExecuted} executed ` +
      `(${finalPassed} passed, ${finalExecuted - finalPassed} failed), ` +
      `${finalRefused} refused`,
  );
  const hasRisks = batch.tasks.some((task) => {
    const result = task.result!;
    return result.notes.trim().length > 0 || result.followUps.length > 0;
  });
  if (!hasRisks) lines.push("RISKS: none");
  lines.push("TERMINAL: VERIFIED_COMPLETE");
  lines.push(
    "NEXT: finish without rereading worker-owned files or rerunning passed checks unless a listed risk changes architecture.",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  assertMetadataBudgets();
  if (IS_WORKER_PROCESS) {
    log(
      `${WORKER_MARKER_ENV}=1 detected - running inside a Luna worker. ` +
        `No delegation tools will be registered; workers cannot delegate.`,
    );
  } else {
    registerDelegateTask();
    registerDelegateTasks();
    registerContinueTask();
    registerRoutingPreflight();
    registerExplore();
  }

  const transport = new StdioServerTransport();

  // Proves the client actually completed a handshake with us, which is what
  // distinguishes a startup timeout from a model that simply chose not to call.
  server.server.oninitialized = (): void => {
    const client = server.server.getClientVersion();
    log(`client connected: ${client?.name ?? "unknown"} ${client?.version ?? ""}`);
  };

  if (VERIFY_MODE_INVALID) {
    log(
      `WARNING: SOL_LUNA_VERIFY_MODE="${process.env.SOL_LUNA_VERIFY_MODE}" is not ` +
        `recognised. Falling back to "allowlist".`,
    );
  }
  if (VERIFY_MODE === "shell") {
    log(
      `WARNING: verification mode is "shell". Model-supplied verificationCommands ` +
        `will be passed to a system shell and run with your full user permissions. ` +
        `Use "allowlist" unless you specifically need this.`,
    );
  }

  await server.connect(transport);
  log(
    `ready in ${Math.round(process.uptime() * 1000)}ms | worker model ${LUNA_MODEL} | ` +
      `default effort ${DEFAULT_EFFORT} | verification ${VERIFY_MODE}`,
  );
}

// Only start the server when this file is the entry point. Importing it — which
// the render and compaction tests do — must not connect the stdio transport,
// because that holds stdin open and the process never exits. Same guard, and
// same reason, as `src/bench/run.ts`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    log(`fatal: ${(error as Error).stack ?? String(error)}`);
    process.exit(1);
  });
}
