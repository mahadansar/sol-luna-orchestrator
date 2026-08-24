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
  continueTaskInputShape,
  delegateTaskInputShape,
  inputMetadataSizeReport,
  INPUT_METADATA_SIZE_BUDGETS,
  delegateTasksInputShape,
  type BatchOutput,
  type ContinueTaskInput,
  type DelegateTaskInput,
  type DelegateTaskOutput,
  type DelegateTasksInput,
} from "./contract.js";
import { BatchRejectedError, runBatch } from "./batch.js";
import { ContinuationStore, type ContinuationConsumeResult } from "./continuation.js";
import {
  continueToLuna,
  delegateToLuna,
  reconcileParallelWorktreeEvidence,
  resultWasCancelled,
} from "./worker.js";
import { collectWorktreeChanges, type WorktreeChanges } from "./git.js";
import { WorkspaceError } from "./workspace.js";
import { activityFailureReason, emitEvent, type EventEmitter } from "./events.js";
import {
  filterOrchestratorOwnedSharedLinks,
  refreshWorktreeLease,
  releaseWorktreeLease,
  WORKTREE_LEASE_GRACE_MS,
  type WorktreeLease,
} from "./worktree.js";

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

function registerContinuation(
  input: DelegateTaskInput,
  result: DelegateTaskOutput,
  workingDirectory: string,
  reconcileFinalGit = false,
  worktreeLease: WorktreeLease | null = null,
): string | null {
  if (!result.workerThreadId || resultWasCancelled(result)) return null;
  return continuationStore.issue(
    input,
    result.workerThreadId,
    workingDirectory,
    reconcileFinalGit,
    worktreeLease,
  );
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
    emit({ type: "worker.cancelled", batchId, taskId });
    emit({
      type: "batch.cancelled",
      batchId,
      reason: "worker cancelled",
    });
  } else {
    const orchestratorRuns = result.verification.filter(
      (run) => run.source === "orchestrator",
    );
    if (orchestratorRuns.length > 0) {
      emit({
        type: "verification.completed",
        batchId,
        taskId,
        passed: orchestratorRuns.filter((run) => run.passed).length,
        failed: orchestratorRuns.filter(
          (run) => !run.passed && (run.execution === "argv" || run.execution === "shell"),
        ).length,
        refused: orchestratorRuns.filter(
          (run) => run.execution === "rejected" || run.execution === "skipped",
        ).length,
      });
    }
    if (timedOut) {
      emit({
        type: "worker.timedOut",
        batchId,
        taskId,
        timeoutSeconds,
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

export const TOOL_DESCRIPTION = `Delegate ONE substantial, bounded, well-specified executable task to an isolated ${LUNA_MODEL} worker.
Use it for implementation, tests, bug fixing, refactoring, investigation, or chores
when worker ownership beats fixed overhead. One task does not need a second independent seam.
Keep small, simple, tightly coupled work solo when overhead dominates. Provide a
concise activityLabel when safe.

The parent owns architecture, decomposition, unresolved design, sequencing, scope,
acceptance, and final judgement. Luna owns implementation and scoped verification. The
worker cannot see the conversation or delegate. Provide objective, allowed/forbidden
scope, changeIntent, acceptanceCriteria, and verificationCommands.

Balance credit cost, latency, context, overhead, verification, isolation, coordination risk,
and quality. Raw token count is not credit cost. The selected parent model is priced above
${LUNA_MODEL} on the current pricing schedule only conditionally; whether delegation
uses fewer total credits depends on which parent model is in use. It is not an architectural guarantee and not a measured saving.
More workers is not automatically
cheaper.

Use automaticRepair for at most one repair of a conservatively classified local defect.
An opaque continuationReference permits one bounded same-thread follow-up without
widening the contract. Use resultDetail=compact routinely; full remains the compatibility
default.

Judge the returned verdict, verification, observed files, discrepancies, scope violations,
and review checklist. Worker claims are not authoritative. Escalate FAILED/BLOCKED,
trustworthy: false, discrepant, scope-violating, refused/skipped-verification,
runtime-error, or conflict evidence. Choose review depth after seeing that evidence;
do not pre-commit to rereading every file. A clean verified PASS receives a compact handoff
and proportionate review. A verification-only worker FAILED can become PASS only when it
matches a distinct passing authoritative check.

When pending with no meaningful new state, remain silent; do not narrate waiting or
polling. Report only a result, error, cancellation, timeout, or actionable state change.`;

export const CONTINUE_TOOL_DESCRIPTION = `Continue ONE eligible delegated task in the same Luna Codex thread for one explicit follow-up turn.
Use an opaque single-use continuationReference plus one concise bounded instruction.
The original objective, allowedFiles, forbiddenFiles, changeIntent, acceptance, and verification
contract is retained; no widening fields are accepted. Luna still cannot delegate;
scoped verification, scope checks, evidence reconciliation, and verdict logic run again. Manual
continuation never starts an automatic repair. When pending with no meaningful new state,
remain silent; do not narrate waiting. Report only a result, error, cancellation, timeout,
or actionable state change.`;

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
  };
}

/** Apply {@link compactResult} to every task result in a batch. */
export function compactBatch(batch: BatchOutput): BatchOutput {
  return {
    ...batch,
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

function isCleanPass(result: DelegateTaskOutput): boolean {
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
    authoritative.length > 0 &&
    authoritative.every(
      (run) => (run.execution === "argv" || run.execution === "shell") && run.passed,
    )
  );
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
  const risks = [result.notes.trim(), ...result.followUps].filter(Boolean);
  lines.push(`RISKS: ${risks.length > 0 ? risks.join("; ") : "none"}`);
  return lines.join("\n");
}

/** The short general policy sent to the parent during MCP initialization. */
export const SERVER_INSTRUCTIONS =
  `Sol-Luna Orchestrator routing card: any compatible parent Codex model may use it; delegation is adaptive and zero workers is valid. The parent supervisor owns ` +
  `architecture, decomposition, unresolved design, sequencing, scope, changeIntent, acceptance, verification ` +
  `selection, integration, and final judgement; more workers are not automatically better or cheaper. ${LUNA_MODEL} Luna owns ` +
  `implementation and scoped verification; workers execute bounded tasks. The parent retains decomposition and strategy. Use delegate_task for one substantial ` +
  `task; use delegate_tasks sequentially for dependent/shared-state tasks or ` +
  `parallel for genuinely independent disjoint scopes. Worker claims are not ` +
  `authoritative; claims are not orchestrator evidence: escalate suspicious evidence, discrepancies, scope violations, ` +
  `failed/blocked or refused verification results. Review proportionately. Clean verified PASS results use ` +
  `the compact fast path; rich diagnostics remain for risks. automaticRepair is at ` +
  `most one bounded repair; same-thread automatic repair is bounded; continuationReference is one bounded follow-up with ` +
  `the immutable contract fixed. Raw tokens are not credit cost; cost/latency ` +
  `depend on parent model, task mix, coordination, isolation, and quality; the ` +
  `selected parent model is priced above ${LUNA_MODEL} on the current pricing schedule ` +
  `only conditionally, with no guaranteed or measured savings. While a pending call has no meaningful new ` +
  `state, remain silent: do not narrate polling, waiting, elapsed time, or that it is still running; report ` +
  `result, error, cancellation, timeout, or actionable state change.`;

export const METADATA_SIZE_BUDGETS = {
  serverInstructions: 1_700,
  delegateTaskDescription: 2_700,
  delegateTasksDescription: 2_500,
  continueTaskDescription: 1_000,
  combined: 19_000,
} as const;

export function metadataSizeReport(): {
  serverInstructions: number;
  delegateTaskDescription: number;
  delegateTasksDescription: number;
  continueTaskDescription: number;
  inputSchemas: ReturnType<typeof inputMetadataSizeReport>;
  combined: number;
} {
  const inputSchemas = inputMetadataSizeReport();
  const report = {
    serverInstructions: SERVER_INSTRUCTIONS.length,
    delegateTaskDescription: TOOL_DESCRIPTION.length,
    delegateTasksDescription: BATCH_TOOL_DESCRIPTION.length,
    continueTaskDescription: CONTINUE_TOOL_DESCRIPTION.length,
    inputSchemas,
    combined: 0,
  };
  report.combined =
    report.serverInstructions +
    report.delegateTaskDescription +
    report.delegateTasksDescription +
    report.continueTaskDescription +
    inputSchemas.combined;
  return report;
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
    metadataSizes.combined > METADATA_SIZE_BUDGETS.combined ||
    Object.entries(INPUT_METADATA_SIZE_BUDGETS).some(([key, budget]) =>
      key === "combined"
        ? metadataSizes.inputSchemas.combined > budget
        : metadataSizes.inputSchemas[key as keyof typeof metadataSizes.inputSchemas] >
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
function registerDelegateTask(): void {
  server.registerTool(
    "delegate_task",
    {
      title: "Delegate a bounded task to a Luna worker",
      description: TOOL_DESCRIPTION,
      inputSchema: delegateTaskInputShape,
    },
    async (input, extra) => {
      const task = input as DelegateTaskInput;
      const batchId = makeSingleBatchId();
      const taskId = "t1";
      const startedAt = Date.now();
      let workerStarted = false;
      let workerDirectory: string | null = null;
      log(
        `delegate_task: effort=${task.effort} cwd=${task.workingDirectory ?? process.cwd()} ` +
          `objective="${task.objective.slice(0, 80)}..."`,
      );

      emitEvent({
        type: "batch.started",
        batchId,
        mode: "single",
        taskCount: 1,
        maxParallel: 1,
      });
      emitEvent({
        type: "task.queued",
        batchId,
        taskId,
        effort: task.effort,
        category: task.taskCategory,
        activityLabel: task.activityLabel,
        model: LUNA_MODEL,
      });

      try {
        const result = await delegateToLuna(task, extra?.signal, {
          onStarted: (workingDirectory) => {
            workerStarted = true;
            workerDirectory = workingDirectory;
            emitEvent({
              type: "worker.started",
              batchId,
              taskId,
              effort: task.effort,
              workingDirectory,
              model: LUNA_MODEL,
            });
          },
          onVerificationStart: (commandCount) =>
            emitEvent({
              type: "verification.started",
              batchId,
              taskId,
              commandCount,
            }),
          onRepairStart: (classification) => {
            emitEvent({
              type: "verification.completed",
              batchId,
              taskId,
              passed: Math.max(0, task.verificationCommands.length - 1),
              failed: 1,
              refused: 0,
            });
            emitEvent({
              type: "repair.started",
              batchId,
              taskId,
              classification,
              turn: 1,
            });
          },
          onRepairComplete: (verdict) =>
            emitEvent({
              type: "repair.completed",
              batchId,
              taskId,
              verdict,
              turn: 1,
            }),
        });
        if (workerDirectory) {
          result.continuationReference = registerContinuation(
            task,
            result,
            workerDirectory,
          );
        }
        emitSingleCompletion(
          batchId,
          taskId,
          task.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
          result,
        );
        log(
          `done: verdict=${result.verdict} claimed=${result.workerClaimedStatus} ` +
            `thread=${result.workerThreadId ?? "?"} in ${result.durationSeconds}s`,
        );
        recordEvent(result);
        const detail = task.resultDetail ?? "full";
        const structuredContent = detail === "compact" ? compactResult(result) : result;

        return {
          content: [
            {
              type: "text" as const,
              text: renderResult(result, {
                batchId,
                taskId,
                integration: "single-task workspace",
              }),
            },
          ],
          structuredContent,
        };
      } catch (error) {
        const message =
          error instanceof WorkspaceError
            ? error.message
            : `Delegation failed: ${(error as Error).message}`;

        if (workerStarted) {
          const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
          if (extra?.signal?.aborted) {
            emitEvent({ type: "worker.cancelled", batchId, taskId });
            emitEvent({
              type: "batch.cancelled",
              batchId,
              reason: "worker cancelled",
            });
          } else {
            emitEvent({ type: "worker.failed", batchId, taskId, reason: message });
            emitEvent({
              type: "batch.completed",
              batchId,
              durationSeconds,
              passed: 0,
              failed: 1,
            });
          }
        } else if (extra?.signal?.aborted) {
          emitEvent({
            type: "batch.cancelled",
            batchId,
            reason: "cancelled before worker start",
          });
        } else {
          emitEvent({ type: "batch.rejected", batchId, reason: message });
        }

        log(`error: ${message}`);
        // Returned as a tool error (not a thrown protocol error) so the parent can read
        // the reason and adapt instead of seeing an opaque transport failure.
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );
}

interface ContinuationHandlerDependencies {
  store: ContinuationStore;
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
) {
  const dependencies: ContinuationHandlerDependencies = {
    store: continuationStore,
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
  const timeoutSeconds = entry.input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  if (entry.worktreeLease) {
    try {
      await dependencies.refreshLease(
        entry.worktreeLease,
        Date.now() + timeoutSeconds * 1000 + WORKTREE_LEASE_GRACE_MS,
        "executing-continuation",
      );
    } catch (error) {
      dependencies.store.release(request.continuationReference);
      await dependencies.releaseLease(entry.worktreeLease);
      const message =
        `Continuation could not start because its retained worktree lease ` +
        `could not be refreshed: ${(error as Error).message}`;
      log(`continue_task rejected: ${message}`);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  }
  const batchId = dependencies.makeBatchId();
  const taskId = "t1";
  const startedAt = Date.now();
  let workerStarted = false;
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
    model: LUNA_MODEL,
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
            model: LUNA_MODEL,
          });
        },
        onVerificationStart: (commandCount) =>
          dependencies.emit({
            type: "verification.started",
            batchId,
            taskId,
            commandCount,
          }),
      },
    });
    if (entry.reconcileFinalGit) {
      result = await dependencies.reconcile(entry.input, result, entry.workingDirectory);
    }
    emitSingleCompletion(batchId, taskId, timeoutSeconds, result, dependencies.emit);
    dependencies.record(result);
    return {
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
      structuredContent: result,
    };
  } catch (error) {
    const message =
      error instanceof WorkspaceError
        ? error.message
        : `Continuation failed: ${(error as Error).message}`;
    if (workerStarted) {
      const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
      if (signal?.aborted) {
        dependencies.emit({ type: "worker.cancelled", batchId, taskId });
        dependencies.emit({
          type: "batch.cancelled",
          batchId,
          reason: "worker cancelled",
        });
      } else {
        dependencies.emit({ type: "worker.failed", batchId, taskId, reason: message });
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
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  } finally {
    dependencies.store.release(request.continuationReference);
    if (entry.worktreeLease) await dependencies.releaseLease(entry.worktreeLease);
  }
}

function registerContinueTask(): void {
  server.registerTool(
    "continue_task",
    {
      title: "Continue an eligible Luna task",
      description: CONTINUE_TOOL_DESCRIPTION,
      inputSchema: continueTaskInputShape,
    },
    async (input, extra) => {
      return handleContinueTask(input as ContinueTaskInput, extra?.signal);
    },
  );
}

export const BATCH_TOOL_DESCRIPTION = `Delegate a batch to ${LUNA_MODEL}; this API is intended for two or more tasks, though a one-task batch remains accepted for compatibility (prefer delegate_task for a single task). Use sequential for dependent tasks that share workspace state; give each task a concise activityLabel when a safe label is available; parallel is only for genuinely independent tasks with disjoint declared scopes. Do not create artificial seams. Parallel execution may reduce latency but is not automatically cheaper than sequential and does not guarantee savings. Batch size is not the number of simultaneous workers: at most ${MAX_BATCH_SIZE} tasks are accepted, at most ${MAX_PARALLEL} at once run, and queues the rest; split the remainder as a second batch. Raw tokens are not credit cost: batch size and task mix affect the economics, and coordination and review increase overhead. When the selected parent model is priced above ${LUNA_MODEL} on the current pricing schedule, fewer total credits is parent-conditional; savings are not guaranteed or measured, and more workers are not automatically cheaper, not merely because tasks are parallel. Use allowOverlappingScopes:true only as a call-level escape hatch; it does not turn scopes into a write sandbox: same-file edits still prevent automatic parallel integration, and same-file edits by parallel workers prevent all automatic integration. integrationConflicts is a parallel-only result; sequential tasks share the workspace and may intentionally edit files. Each task owns its objective, scope, changeIntent, acceptanceCriteria, and verificationCommands; the parent owns integration and final judgement. Partial outcomes remain visible; FAILED or BLOCKED, untrustworthy (trustworthy: false), discrepancy, scope, refusal, and conflict results stay actionable. Parallel tasks are verified in isolation; run integration checks when changes can meaningfully interact. automaticRepair is bounded. automaticRecovery defaults true for parallel: before integration it permits one eligible same-thread timeout retry or one fresh-process retry in the same worktree; false opts out. Success, cancellation, scope/security/evidence, refused verification, contract discrepancy, and integration conflict are ineligible. While pending, when there is no meaningful new state, remain silent: do not narrate waiting or polling; report only results, errors, cancellations, timeouts, or actionable state changes. Retention follows the operator; the continuation reference is omitted when unavailable.`;

function registerDelegateTasks(): void {
  server.registerTool(
    "delegate_tasks",
    {
      title: "Delegate several tasks to Luna workers",
      description: BATCH_TOOL_DESCRIPTION,
      inputSchema: delegateTasksInputShape,
    },
    async (input, extra) => {
      const batch = input as DelegateTasksInput;
      log(
        `delegate_tasks: mode=${batch.mode} tasks=${batch.tasks.length} ` +
          `efforts=[${batch.tasks.map((task) => task.effort).join(",")}]`,
      );

      try {
        const result = await runBatch(batch.tasks as DelegateTaskInput[], {
          mode: batch.mode,
          workingDirectory: batch.workingDirectory,
          allowOverlappingScopes: batch.allowOverlappingScopes,
          integrate: batch.integrate,
          automaticRecovery: batch.automaticRecovery,
          signal: extra?.signal,
          continuationRegistrar: registerContinuation,
          protectedWorktreePaths: continuationStore.protectedWorkingDirectories(),
        });
        log(
          `batch done: ${result.passed}/${result.taskCount} passed in ` +
            `${result.durationSeconds}s, integrated=${result.integrated}`,
        );

        const detail = batch.resultDetail ?? "full";
        const structuredContent = detail === "compact" ? compactBatch(result) : result;

        return {
          content: [{ type: "text" as const, text: renderBatch(result) }],
          structuredContent,
        };
      } catch (error) {
        const message =
          error instanceof BatchRejectedError || error instanceof WorkspaceError
            ? error.message
            : `Batch delegation failed: ${(error as Error).message}`;
        log(`batch error: ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
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
  const clean =
    batch.integrationConflicts.length === 0 &&
    batch.scopeConflicts.length === 0 &&
    batch.warnings.length === 0 &&
    batch.integrated &&
    batch.tasks.every((task) => task.result && isCleanPass(task.result));
  if (!clean) return renderRichBatch(batch);

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
  }
  lines.push(`INTEGRATION: ${batch.integrationSummary}`);
  const hasRisks = batch.tasks.some((task) => {
    const result = task.result!;
    return result.notes.trim().length > 0 || result.followUps.length > 0;
  });
  if (!hasRisks) lines.push("RISKS: none");
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
