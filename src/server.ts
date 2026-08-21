#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./log.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DEFAULT_EFFORT,
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

/**
 * stdout is the MCP transport. Anything written there that is not a JSON-RPC
 * frame corrupts the session, so all diagnostics go to stderr.
 *
 * Codex swallows a server's stderr, so set SOL_LUNA_LOG=<path> to also tee
 * diagnostics to a file. That log is the only way to tell "Codex never started
 * the server" apart from "the server started but the model ignored the tool".
 */
const LOG_FILE = process.env.SOL_LUNA_LOG;

const log = createLogger(LOG_FILE);

/** Append one machine-readable record per delegation, for measurement. */
const recordEvent = (result: DelegateTaskOutput): void => {
  if (!EVENTS_FILE) return;
  try {
    appendFileSync(
      EVENTS_FILE,
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

export const TOOL_DESCRIPTION = `Delegate ONE bounded, well-specified executable task to an isolated ${LUNA_MODEL} worker thread.

Use this when a task is well-specified enough to hand off: you can state the
objective, what "done" looks like, and which files may change. Keep architecture,
sequencing, unresolved design decisions, and final judgement for yourself.

Choosing \`effort\` — rate THIS TASK's intrinsic difficulty, never the parent
project's importance:
  medium  Mechanical and fully specified. Rename, move, boilerplate, obvious
          test cases, applying a pattern that already exists in the codebase.
  high    DEFAULT. Real execution work needing judgement within one area:
          a new endpoint, a bug fix with a known repro, a focused refactor.
  xhigh   Subtle or cross-cutting. Concurrency, tricky state, non-obvious
          performance work, changes rippling across several modules, or a bug
          whose cause is not yet identified.
  max     Genuinely hard problems only. Reserve for tasks where a strong
          engineer would expect to be stuck for a while: intricate algorithms,
          deep debugging with no clear lead, or a task that already came back
          FAILED at xhigh. An important task that is straightforward is still
          "high" — importance is not difficulty.

Prefer escalating over starting high: run at \`high\`, and if it comes back FAILED
because the task was genuinely hard, re-delegate at \`xhigh\` with
\`previousAttempts\` filled in. If it failed because your brief was vague, fix the
brief instead — the same objective at higher effort usually fails again, slower.

BEFORE delegating at all, decide whether it is worth it. Delegation has a fixed
overhead — writing the contract, spawning a thread, re-verifying the result — and
on small/simple/tightly coupled work that overhead exceeds the work itself. Measured
on this project's own micro-benchmark, delegating a one-file task was ~2.3x slower
and ~3.5x the raw tokens of just doing it, with no quality difference.

However, do NOT optimize delegation decisions for raw token count alone.
Under the current credit schedule, Luna compute is roughly 25x cheaper than Sol compute.
A delegated solution may use substantially more aggregate raw tokens and still cost
fewer total credits, because the heavy work runs on cheaper instances. This 25x
relationship is based on the current schedule, not an immutable architectural guarantee.

The decision should balance expected total credit cost, latency, coordination
overhead/risk, and quality. More workers is not automatically cheaper — worker count
and parallelism should remain driven by useful task seams, latency, coordination risk,
and verification boundaries. Substantial bounded implementation, investigation, or
repetitive work can be worth moving out of your expensive context when the savings
outweigh delegation overhead.

Do it yourself when:
  - the change is small, mechanical, or confined to one file
  - you already know the exact edit
  - explaining the task would take longer than making the change

Delegate a single task when the work is substantial and bounded, and moving the
work out of your context is worthwhile given cost, context, verification, or isolation
benefits. A task does NOT need a second independent seam to justify delegate_task.

For two or more independent pieces of work, use \`delegate_tasks\` instead. Parallel
delegation may reduce latency when useful independent work is large enough, but it
is not guaranteed.

The worker cannot delegate further and cannot see this conversation.

The result is evidence, not a conclusion. The orchestrator independently re-runs
your \`verificationCommands\` after the worker exits and checks which files were
actually touched, then returns \`verdict\`, \`discrepancies\`, and
\`reviewChecklist\`.

Apply risk-based review:
If the result is a clean PASS (\`verdict: PASS\`, \`trustworthy: true\`, no discrepancies,
no scope violations, orchestrator verification passed, expected changed files, and
nothing in notes/evidence indicates risk):
- Do NOT automatically reread every implementation file or request the full diff.
- Do NOT repeat expensive inspection or verification solely to reproduce evidence
  the orchestrator has already established. Spend additional supervisor context
  only when it can change the acceptance decision.

Deep diff/code inspection SHOULD happen when justified: high-risk or architecturally
significant changes, unexpected files/behavior, acceptance criteria cannot be judged
from returned evidence, insufficient verification coverage, suspicious paths (FAILED,
BLOCKED, trustworthy: false, discrepancies, scope violations), tests weakened, or
types loosened.

\`resultDetail\` controls how much of the result you get back. Choose it explicitly.
Default supervisor behavior for routine delegation is \`"compact"\` (drops stdout/stderr
of passed commands, keeping all verdicts, discrepancies, scope violations, and failed
command output). Use \`"full"\` only when successful verification stdout/stderr is
genuinely needed for your next decision. The schema default remains \`"full"\` solely
for backwards compatibility.

\`verificationCommands\` run without a shell: one allowlisted executable per
command, no pipes, redirects, \`&&\` or \`;\`. Use \`npm test\` or \`pytest -q\`,
not \`npm run build && npm test\` (pass those as two commands).`;

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

/**
 * Sent to the client at initialize, so this is the first and most general
 * statement of policy the supervisor sees. It must not contradict the
 * per-tool descriptions below: it used to end "Never accept a worker's PASS
 * without reading the diff", which is exactly the unconditional ritual the
 * tool descriptions now replace with risk-based review.
 */
export const SERVER_INSTRUCTIONS =
  `Delegation bridge from a supervising Codex agent (Sol) to isolated ` +
  `${LUNA_MODEL} workers. Use \`delegate_task\` for bounded, ` +
  `well-specified executable work; keep architecture and review for ` +
  `yourself. Default worker effort is ${DEFAULT_EFFORT}; reserve \`max\` for ` +
  `genuinely hard tasks. A worker's PASS is a claim; the orchestrator's ` +
  `\`verdict\` is the evidence. Review in proportion to the evidence: a clean ` +
  `verified PASS needs no diff re-read, anything doubtful does.`;

const server = new McpServer(
  { name: "sol-luna-orchestrator", version: "1.0.0" },
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
      log(
        `delegate_task: effort=${task.effort} cwd=${task.workingDirectory ?? process.cwd()} ` +
          `objective="${task.objective.slice(0, 80)}..."`,
      );

      try {
        const result = await delegateToLuna(task, extra?.signal);
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

export const BATCH_TOOL_DESCRIPTION = `Delegate SEVERAL bounded tasks to ${LUNA_MODEL} workers, in parallel or in sequence.

This is where delegation can pay for itself across multiple seams. A single small
task is faster done yourself; several substantial, independent tasks may reduce
overall latency if the work is large enough, though wall-clock savings are not guaranteed.

Pick the mode deliberately:

  parallel    Two or more tasks that do NOT depend on each other. Each worker
              gets its own git worktree branched from HEAD, so they cannot see
              or clobber each other. Afterwards their changes are integrated
              only if no two workers touched the same file.
              Requires: a git repository with at least one commit, and no
              uncommitted changes inside the declared task scopes.

  sequential  Tasks that build on each other, or that must touch the same
              files. They share the workspace and run one at a time, so a later
              task sees the earlier one's work. No git requirement.

Give every parallel task a DISJOINT \`allowedFiles\` scope — e.g. \`src/auth/**\`
and \`src/payments/**\`, never \`src/auth/**\` and \`src/**\`. Overlapping scopes are
rejected up front, because the outcome would depend on which worker finished
last. Choose sequential mode instead when the work genuinely shares files.

Each task carries its own \`effort\`. Rate each task separately: a batch may mix
\`medium\`, \`high\` and \`xhigh\` workers, and usually should.

Do NOT use this to fan out work that is really one task, and do not split a
change so finely that coordinating the pieces costs more than writing them.

Partial failure is normal and is reported, not hidden: successful tasks are kept
and you decide per task whether to retry, re-scope, or accept. Nothing is merged
automatically when workers collide.

Each worker was verified alone in its own worktree, which is not the same as
being verified together. Run an integration or full-suite check yourself when
the integrated changes can actually interact — shared contracts, shared types,
shared runtime behaviour, or anything the isolated verification could not have
exercised. Genuinely disjoint scopes that each passed their own required
verification, with no integration conflict, do not need one merely because the
batch ran in parallel.`;

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
