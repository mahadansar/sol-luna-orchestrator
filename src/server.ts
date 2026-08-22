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
  VERIFY_MODE,
  VERIFY_MODE_INVALID,
  WORKER_MARKER_ENV,
} from "./config.js";
import {
  delegateTaskInputShape,
  delegateTaskOutputShape,
  delegateTasksInputShape,
  delegateTasksOutputShape,
  type BatchOutput,
  type DelegateTaskInput,
  type DelegateTaskOutput,
  type DelegateTasksInput,
} from "./contract.js";
import { BatchRejectedError, runBatch } from "./batch.js";
import { WorkerBusyError, delegateToLuna } from "./worker.js";
import { WorkspaceError } from "./workspace.js";
import { emitEvent } from "./events.js";

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
stated clearly and moving execution out of Sol's context is worthwhile. One task
does not need a second independent seam to justify delegation. Keep small,
simple, tightly coupled, or already-obvious work solo when fixed coordination
overhead would dominate.

Be cost-aware, not raw-token-minimal: under the current pricing schedule,
equivalent Luna tokens are roughly 25x cheaper than Sol tokens, so substantially
more aggregate raw tokens can still cost fewer total credits. This ratio is
current pricing, not an architectural guarantee. Balance expected credit cost,
latency, context use, fixed overhead, verification or isolation benefits,
coordination risk, and quality. More workers is not automatically cheaper.

Sol retains architecture, decomposition, unresolved design and sequencing
decisions, and final judgement. The worker cannot see the conversation or
delegate further.

Use the returned evidence. Worker claims are not authoritative; judge the
orchestrator's verdict, verification, observed files, discrepancies, scope
violations, and review checklist. A clean verified PASS with expected changes
deserves proportionate review, not automatic re-derivation. Inspect more deeply
for risk, weak coverage, unexpected changes, FAILED or BLOCKED results,
trustworthy: false, discrepancies, or scope violations.`;

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
  lines.push(
    `worker: ${result.model} @ ${result.effort} | attempt ${result.attempt} | ` +
      `thread ${result.workerThreadId ?? "unknown"} | ${result.durationSeconds}s`,
  );
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

/** The short general policy sent to the supervisor during MCP initialization. */
export const SERVER_INSTRUCTIONS =
  `Sol supervises architecture, delegation, and final judgement; ${LUNA_MODEL} ` +
  `workers execute bounded tasks. Worker claims are not orchestrator evidence. ` +
  `Judge returned verdicts and checks, reviewing in proportion to their risk and evidence.`;

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
      });

      try {
        const result = await delegateToLuna(task, extra?.signal, {
          onStarted: (workingDirectory) => {
            workerStarted = true;
            emitEvent({
              type: "worker.started",
              batchId,
              taskId,
              effort: task.effort,
              workingDirectory,
            });
          },
          onVerificationStart: (commandCount) =>
            emitEvent({
              type: "verification.started",
              batchId,
              taskId,
              commandCount,
            }),
        });
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
          error instanceof WorkerBusyError || error instanceof WorkspaceError
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
        // Returned as a tool error (not a thrown protocol error) so Sol can read
        // the reason and adapt instead of seeing an opaque transport failure.
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );
}

export const BATCH_TOOL_DESCRIPTION = `Delegate two or more meaningful bounded tasks to ${LUNA_MODEL} workers.

Choose sequential mode when tasks depend on earlier changes, share workspace
state, or may touch the same files; they run one at a time in the shared
workspace. Choose parallel mode only for genuinely independent tasks with
disjoint declared scopes. Parallel tasks run in separate git worktrees from
HEAD, require a repository with a commit and no uncommitted in-scope changes,
and are integrated only when their observed changed-file sets do not collide.
Parallelism may reduce latency but does not guarantee it.

Do not create artificial seams or split work so finely that coordination
dominates. Whether to delegate and whether to run in parallel are separate
decisions.

Partial outcomes remain visible for Sol to judge. A completed worker's edits may
be integrated even when its verdict is FAILED or BLOCKED. Declared scope
conflicts can reject a batch; actual same-file edits prevent automatic
integration and retain worktrees for manual resolution.

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
          error instanceof BatchRejectedError ||
          error instanceof WorkerBusyError ||
          error instanceof WorkspaceError
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
    lines.push(`    effort: ${task.effort} - ${task.effortReason}`);
    lines.push(`    objective: ${task.objective.slice(0, 140)}`);

    if (task.result?.summary)
      lines.push(`    worker summary (claim): ${task.result.summary}`);
    if (task.error) lines.push(`    error: ${task.error}`);

    if (task.changedFiles.length > 0) {
      lines.push(`    changed: ${task.changedFiles.join(", ")}`);
    }
    for (const discrepancy of task.result?.discrepancies ?? []) {
      lines.push(`    ! ${discrepancy}`);
    }
    for (const violation of task.result?.scopeViolations ?? []) {
      lines.push(`    ! scope: ${violation}`);
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

  if (batch.integrationConflicts.length > 0) {
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
