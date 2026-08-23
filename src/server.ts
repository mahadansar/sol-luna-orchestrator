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
  WORKER_MARKER_ENV,
} from "./config.js";
import {
  continueTaskInputShape,
  delegateTaskInputShape,
  delegateTaskOutputShape,
  delegateTasksInputShape,
  delegateTasksOutputShape,
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
} from "./worker.js";
import { collectWorktreeChanges, type WorktreeChanges } from "./git.js";
import { WorkspaceError } from "./workspace.js";
import { activityFailureReason, emitEvent } from "./events.js";
import {
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
  if (!result.workerThreadId) return null;
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
    return reconcileParallelWorktreeEvidence(
      input,
      result,
      workingDirectory,
      changes.files.map((file) => ({ path: file.path, kind: file.status })),
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
): void {
  const cancelled = result.errors.some((error) =>
    /was cancelled before it finished/i.test(error),
  );
  const timedOut = result.errors.some((error) => /exceeded its .* budget/.test(error));

  if (cancelled) {
    emitEvent({ type: "worker.cancelled", batchId, taskId });
    emitEvent({
      type: "batch.cancelled",
      batchId,
      reason: "worker cancelled",
    });
  } else {
    const orchestratorRuns = result.verification.filter(
      (run) => run.source === "orchestrator",
    );
    if (orchestratorRuns.length > 0) {
      emitEvent({
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
      emitEvent({
        type: "worker.timedOut",
        batchId,
        taskId,
        timeoutSeconds,
      });
    }
    // Keep the existing completion record for compatibility. The activity
    // reducer preserves timedOut when this record follows it.
    emitEvent({
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
    emitEvent({
      type: "batch.completed",
      batchId,
      durationSeconds: result.durationSeconds,
      passed: result.verdict === "PASS" ? 1 : 0,
      failed: result.verdict === "PASS" ? 0 : 1,
    });
  }
}

export const TOOL_DESCRIPTION = `Delegate ONE substantial, bounded, well-specified executable task to an isolated ${LUNA_MODEL} worker.

Use this for implementation, tests, bug fixing, refactoring, investigation, or
chores when the objective, scope, acceptance criteria, and verification can be
stated clearly and moving execution out of the parent orchestrator's context is
worthwhile. One task does not need a second independent seam to justify
delegation. Keep small, simple, tightly coupled, or already-obvious work solo
when fixed coordination overhead would dominate.

When delegating, optionally provide a useful concise activityLabel (for example,
"Update auth retries") for the local activity view. It is not required, and it
should not copy the full objective or include sensitive details.

While this call is pending and has no meaningful new state, remain silent: do not
narrate waiting, polling, or elapsed time. Report the result, an error, a
cancellation, a timeout, or an actionable state change.

Be cost-aware, not raw-token-minimal: raw token count is not credit cost. When
the selected parent model is priced above ${LUNA_MODEL} on the current pricing
schedule, a delegated approach can use substantially more aggregate raw tokens
and still cost fewer total credits, which is a legitimate input to the decision.
Whether that applies depends on which parent model is in use and on current
pricing; it is not an architectural guarantee and not a measured saving. Balance
expected credit cost, latency, context use, fixed overhead, verification or
isolation benefits, coordination risk, and quality. More workers is not
automatically cheaper.

The parent orchestrator retains architecture, decomposition, unresolved design
and sequencing decisions, and final judgement. The worker cannot see the
conversation or delegate further.

Set automaticRepair only when one conservative same-thread repair is useful.
The runtime classifies the initial failure first and permits at most one repair
for a clear local verification defect. Read-only, contract, scope/conflict,
environment/tooling, trust-boundary, and wider-scope failures return unchanged
for parent review.

Use the returned evidence. Worker claims are not authoritative; judge the
orchestrator's verdict, verification, observed files, discrepancies, scope
violations, and review checklist. workerClaimedFailureCauses is structured claim
evidence, not the runtime's repair or retry classification. A verification-only
worker FAILED can become PASS only
when every failed worker verification row matches a distinct passing authoritative
run, every configured command passed authoritatively, and no other terminal
evidence exists. Such a contradiction remains visible and trustworthy is false.
Choose review depth after seeing that evidence; do not pre-commit to rereading
every file or rerunning every check. A clean
verified PASS with expected changes deserves proportionate review, not automatic
re-derivation. Inspect more deeply for risk, weak coverage, unexpected changes,
FAILED or BLOCKED results, trustworthy: false, discrepancies, or scope
violations. Set each task's explicit changeIntent to forbidden, optional, or
required; omitted intent defaults to required for compatibility. It is independent
of allowedFiles and taskCategory. A forbidden runtime-observed edit is a contract
violation, while a claimed-only edit remains a claims-versus-observations
discrepancy for the parent to judge.`;

export const CONTINUE_TOOL_DESCRIPTION = `Continue ONE eligible delegated task in the same Luna Codex thread for one explicit follow-up turn.

Use only when the returned result includes a continuationReference and the parent
has a concise, bounded instruction for that same task. The reference is opaque,
server-lifetime and single-use; it is not a raw thread id and cannot be replayed.
The original objective, allowedFiles, forbiddenFiles, changeIntent, acceptance
criteria and verificationCommands are retained exactly. This tool accepts no
scope, intent, effort, or verification widening fields. The worker still cannot
delegate, and independent verification, scope checks, evidence reconciliation
and verdict classification run again for the continuation turn. Manual
continuation never starts an automatic repair turn.

While this call is pending and has no meaningful new state, remain silent: do not
narrate waiting, polling, elapsed time, or that it is still running. Report only
a result, error, cancellation, timeout, or actionable state change.`;

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
export function renderResult(result: DelegateTaskOutput): string {
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

/** The short general policy sent to the parent during MCP initialization. */
export const SERVER_INSTRUCTIONS =
  `Any compatible parent Codex model may use the Sol-Luna Orchestrator. The parent ` +
  `supervisor owns architecture, delegation, and final judgement; ${LUNA_MODEL} ` +
  `workers execute bounded tasks. ` +
  `Delegation is adaptive: zero workers is valid. Raw tokens are not credit cost; ` +
  `cheaper-worker economics apply only when the selected parent model is priced ` +
  `above ${LUNA_MODEL} on the current pricing schedule, and no saving is guaranteed ` +
  `or measured. Balance expected credit cost, latency, context, fixed overhead, ` +
  `verification, coordination risk, and quality; more workers are not automatically ` +
  `better or cheaper. ` +
  `Worker claims are not orchestrator evidence. Judge returned verdicts and checks, ` +
  `and use an eligible opaque continuation reference only for one explicit follow-up ` +
  `without widening the original contract. ` +
  `Fresh contracts may opt into one conservatively classified same-thread automatic ` +
  `repair; all other failures return to the parent. ` +
  `reviewing in proportion to their risk and evidence. While an active Sol-Luna ` +
  `tool call has no meaningful new state, remain silent: do not narrate polling, ` +
  `waiting, elapsed time, or that it is still running. Report only a result, error, ` +
  `cancellation, timeout, or actionable state change.`;

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
      outputSchema: delegateTaskOutputShape,
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
          content: [{ type: "text" as const, text: renderResult(result) }],
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

function registerContinueTask(): void {
  server.registerTool(
    "continue_task",
    {
      title: "Continue an eligible Luna task",
      description: CONTINUE_TOOL_DESCRIPTION,
      inputSchema: continueTaskInputShape,
      outputSchema: delegateTaskOutputShape,
    },
    async (input, extra) => {
      const request = input as ContinueTaskInput;
      const reserved = continuationStore.consume(request.continuationReference);
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
          await refreshWorktreeLease(
            entry.worktreeLease,
            Date.now() + timeoutSeconds * 1000 + WORKTREE_LEASE_GRACE_MS,
            "executing-continuation",
          );
        } catch (error) {
          continuationStore.release(request.continuationReference);
          await releaseWorktreeLease(entry.worktreeLease);
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
      const batchId = makeSingleBatchId();
      const taskId = "t1";
      const startedAt = Date.now();
      let workerStarted = false;
      log(
        `continue_task: thread=${entry.threadId} instruction="${request.instruction.slice(0, 80)}..."`,
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
        effort: entry.input.effort,
        category: entry.input.taskCategory,
        activityLabel: entry.input.activityLabel,
        model: LUNA_MODEL,
      });

      try {
        let result = await continueToLuna(entry.input, {
          workingDirectory: entry.workingDirectory,
          threadId: entry.threadId,
          instruction: request.instruction,
          signal: extra?.signal,
          hooks: {
            onStarted: (workingDirectory) => {
              workerStarted = true;
              emitEvent({
                type: "worker.started",
                batchId,
                taskId,
                effort: entry.input.effort,
                workingDirectory,
                model: LUNA_MODEL,
              });
            },
            onVerificationStart: (commandCount) =>
              emitEvent({ type: "verification.started", batchId, taskId, commandCount }),
          },
        });
        if (entry.reconcileFinalGit) {
          result = await reconcileRetainedContinuationEvidence(
            entry.input,
            result,
            entry.workingDirectory,
          );
        }
        emitSingleCompletion(batchId, taskId, timeoutSeconds, result);
        recordEvent(result);
        return {
          content: [{ type: "text" as const, text: renderResult(result) }],
          structuredContent: result,
        };
      } catch (error) {
        const message =
          error instanceof WorkspaceError
            ? error.message
            : `Continuation failed: ${(error as Error).message}`;
        if (workerStarted) {
          const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
          if (extra?.signal?.aborted) {
            emitEvent({ type: "worker.cancelled", batchId, taskId });
            emitEvent({ type: "batch.cancelled", batchId, reason: "worker cancelled" });
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
        log(`continue_task error: ${message}`);
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      } finally {
        continuationStore.release(request.continuationReference);
        if (entry.worktreeLease) await releaseWorktreeLease(entry.worktreeLease);
      }
    },
  );
}

export const BATCH_TOOL_DESCRIPTION = `Delegate a batch of meaningful bounded tasks to ${LUNA_MODEL} workers. This API is
intended for two or more tasks, but a one-task batch remains accepted for
compatibility; prefer delegate_task for a single task.

Choose sequential mode when tasks depend on earlier changes, share workspace
state, or may touch the same files; they run one at a time in the shared
workspace. Parallel mode is normally for genuinely independent tasks with
disjoint declared scopes. Parallel tasks run in separate git worktrees from
HEAD, require a repository with a commit and no uncommitted in-scope changes,
and are integrated only when their observed changed-file sets do not collide.
Parallelism may reduce latency but does not guarantee it.

Do not create artificial seams or split work so finely that coordination
dominates. Whether to delegate and whether to run in parallel are separate
decisions.

Be cost-aware, not raw-token-minimal: raw tokens are not credit cost. When the
selected parent model is priced above ${LUNA_MODEL} on the current pricing
schedule, a delegated batch can use more aggregate raw tokens and still cost
fewer total credits. That is parent-conditional, not guaranteed or measured.
Batch size and task mix affect the economics, and coordination and review
overhead increase with additional workers. Balance expected credit cost,
latency, context use, fixed batch overhead, verification or isolation benefits,
coordination risk, and quality. Parallel execution may reduce latency, but it is
not automatically cheaper than sequential execution. More workers are not
automatically cheaper.

Give each task a concise, non-sensitive activityLabel for the local activity view
whenever a safe label is available. The field remains optional for compatibility:
omit it when the work description is sensitive. Labels must be supplied
explicitly and must never be derived from, or copy, objective text.

Each fresh task may opt into automaticRepair. The runtime permits at most one
same-thread repair and only after classifying one authoritative verification
failure as a clear local defect; other failures return for parent review.

Set each task's explicit changeIntent to forbidden (read-only), optional, or
required. Omitted intent defaults to required for compatibility. This expectation
is independent of allowedFiles and taskCategory and is carried in each task's
result evidence.

While this batch is pending and has no meaningful new state, remain silent: do not
narrate waiting, polling, elapsed time, or which task is still running. Report
results, errors, cancellations, timeouts, or actionable state changes.

A batch accepts at most ${MAX_BATCH_SIZE} tasks. Batch size is not the number of
simultaneous workers: sequential mode runs one at a time, and parallel mode runs
at most ${MAX_PARALLEL} at once and queues the rest. Split larger work, or run the
remainder as a second batch.

Parallel declared scopes should be disjoint. \`allowOverlappingScopes:true\` is a
call-level escape hatch that permits starting despite declared scope conflicts;
it does not turn scopes into a write sandbox, and actual same-file edits still
prevent automatic parallel integration. integrationConflicts is a parallel-only
result; sequential tasks share the workspace and may intentionally edit files
changed by earlier sequential tasks.

Partial outcomes remain visible for the parent orchestrator to judge. A completed
worker's edits may be integrated even when its verdict is FAILED or BLOCKED. Declared scope
conflicts can reject a batch; actual same-file edits by parallel workers prevent
automatic integration and retain worktrees for manual resolution.

Parallel workers are verified in isolation. After integration, run additional
integration or full-suite verification when changes can meaningfully interact
through shared contracts, types, or runtime behavior. Disjoint tasks with
adequate isolated verification do not require a full-suite rerun merely because
they ran in parallel.`;

function registerDelegateTasks(): void {
  server.registerTool(
    "delegate_tasks",
    {
      title: "Delegate several tasks to Luna workers",
      description: BATCH_TOOL_DESCRIPTION,
      inputSchema: delegateTasksInputShape,
      outputSchema: delegateTasksOutputShape,
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
export function renderBatch(batch: BatchOutput): string {
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
        `duration: ${result ? `${result.durationSeconds}s` : "unknown"}`,
    );
    if (result) lines.push(`    verification: ${verificationSummary(result)}`);
    if (result) lines.push(`    change intent: ${result.changeIntent}`);
    if (result?.repair) {
      lines.push(
        `    repair: ${result.repair.attempted ? "attempted" : "not attempted"} | ` +
          `${result.repair.classification} | ${compact(result.repair.reason)}`,
      );
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

async function main(): Promise<void> {
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
