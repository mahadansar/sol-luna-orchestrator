/**
 * Benchmark harness.
 *
 * Compares a supervisor working alone against a supervisor that delegates,
 * across two suites:
 *
 *   micro     - small single-file tasks, where delegation overhead is expected
 *               to hurt. Kept because that negative result is the point.
 *   parallel  - projects containing three independent modules, where
 *               orchestration has something to actually overlap.
 *
 * Every arm gets the same fixtures and the same objective text. Only the
 * supervisor's effort, and whether delegation is available, differ. Grading is
 * always performed by this harness after the agent stops.
 *
 * Usage:
 *   node dist/bench/run.js --suite parallel --arms solo-high,par --reps 2
 */
import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGit } from "../git.js";
import { PARALLEL_TASKS } from "./parallel-tasks.js";
import { SCALE_TASKS } from "./scale-tasks.js";
import { BENCH_TASKS, type BenchTask, type GradeCommand } from "./tasks.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(HERE, "..", "..", "bench", "results");

const SUPERVISOR_MODEL = process.env.BENCH_SUPERVISOR_MODEL ?? "gpt-5.6-sol";
const ORCHESTRATOR_NAME = process.env.SOL_LUNA_SERVER_NAME ?? "sol-luna-orchestrator";
const TASK_TIMEOUT_SECONDS = Number(process.env.BENCH_TASK_TIMEOUT ?? 1500);

export const SUITES = {
  micro: BENCH_TASKS,
  parallel: PARALLEL_TASKS,
  scale: SCALE_TASKS,
} as const;
export type SuiteName = keyof typeof SUITES;

/**
 * The four comparison arms.
 *
 * `delegation` decides whether the orchestrator MCP server is reachable at all,
 * so the solo arms genuinely cannot delegate rather than merely being asked not
 * to.
 */
export const ARMS = {
  "solo-high": {
    label: "Sol high, solo",
    effort: "high",
    delegation: false,
    guidance: `Implement this yourself, directly in the current directory.
Do not delegate any part of it. Make sure the required checks pass before you finish.`,
  },
  "solo-xhigh": {
    label: "Sol xhigh, solo",
    effort: "xhigh",
    delegation: false,
    guidance: `Implement this yourself, directly in the current directory.
Do not delegate any part of it. Make sure the required checks pass before you finish.`,
  },
  seq: {
    label: "Sol high + sequential Luna",
    effort: "high",
    delegation: true,
    guidance: `You are a supervising architect. Decompose this work and delegate the
implementation to Luna workers using the delegate_tasks tool with mode:"sequential".
Choose each worker's effort from that subtask's own difficulty. Give each task a
real file scope, acceptance criteria and verification commands. Review what comes
back and re-delegate anything that is wrong. Only implement something yourself if
delegation is genuinely not workable.`,
  },
  par: {
    label: "Sol high + parallel Luna",
    effort: "high",
    delegation: true,
    guidance: `You are a supervising architect. Decompose this work into independent
subtasks and delegate them with the delegate_tasks tool using mode:"parallel", so
the workers run at the same time. Give each task a DISJOINT allowedFiles scope.
Choose each worker's effort from that subtask's own difficulty — they need not be
the same. Review what comes back, integrate it, and confirm the whole suite passes.
Only implement something yourself if delegation is genuinely not workable.`,
  },

  /**
   * Free choice. The guidance states the delegation tools exist and says
   * nothing about whether to use them, so what this arm measures is the
   * supervisor's own policy — including deciding to do the work itself. `par`
   * above nudges towards parallel; this one deliberately does not.
   */
  adaptive: {
    label: "Sol high, free choice",
    effort: "high",
    delegation: true,
    guidance: `You have delegation tools available (delegate_task and delegate_tasks).
Use them or do the work yourself, whichever you judge will finish this correctly and
soonest. Make sure the required checks pass before you finish.`,
  },

  // The two arms above leave the decision to the supervisor, which is realistic
  // but means they sometimes measure "Sol declined to delegate" rather than
  // delegation. These mandate the mechanism so the orchestration paths are
  // actually exercised and can be compared like for like.
  "seq-forced": {
    label: "Sol high + sequential Luna (mandated)",
    effort: "high",
    delegation: true,
    guidance: `You are a supervising architect and you MUST delegate this work.
Do not implement any module yourself. Call the delegate_tasks tool exactly once with
mode:"sequential" and one task per module. Choose each worker's effort from that
subtask's own difficulty. Give each task its own allowedFiles scope, acceptance
criteria and verification command. Afterwards, review the results and confirm the
whole suite passes.`,
  },
  "par-forced": {
    label: "Sol high + parallel Luna (mandated)",
    effort: "high",
    delegation: true,
    guidance: `You are a supervising architect and you MUST delegate this work.
Do not implement any module yourself.

Call the delegate_tasks tool exactly once with mode:"parallel" and one task per module, so the workers run at the same time. Give each task a DISJOINT allowedFiles scope covering only its own module. Choose each worker's effort from that subtask's own difficulty.

You MUST request \`resultDetail: "compact"\` in your delegation.

After delegation returns, evaluate the orchestrator evidence. If all worker verdicts pass, there are no scope violations, no integration conflicts, and integration succeeds, you must STOP and return the result immediately.
Do NOT subsequently run git diff, do NOT reread the implementations, do NOT rerun verification commands, and do NOT perform manual integration review. The orchestrator evidence is sufficient.`,
  },
} as const;

export type Arm = keyof typeof ARMS;

export interface GradeOutcome {
  label: string;
  exitCode: number | null;
  passed: boolean;
  output: string;
}

export interface DelegationRecord {
  effort: string;
  verdict: string;
  attempt: number;
  durationSeconds: number;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  } | null;
}

/**
 * Where a run's wall-clock went.
 *
 * Derived from event timestamps rather than new instrumentation, so measuring
 * it cannot change what is measured. `supervisorBefore` is the supervisor
 * reading the repository and writing contracts; `supervisorAfter` is its review
 * and final verification. Everything between is the batch itself.
 */
export interface Breakdown {
  supervisorBeforeSeconds: number | null;
  worktreeSetupSeconds: number | null;
  workerWindowSeconds: number | null;
  slowestWorkerSeconds: number | null;
  integrationSeconds: number | null;
  supervisorAfterSeconds: number | null;
  /** Highest number of workers running at the same instant. */
  peakConcurrency: number | null;
}

export interface RunRecord {
  suite: SuiteName;
  taskId: string;
  taskCategory: string;
  tier: string | null;
  streams: number | null;
  /** SOL_LUNA_MAX_PARALLEL given to the orchestrator, or null when solo. */
  maxParallelConfigured: number | null;
  arm: Arm;
  armLabel: string;
  supervisorEffort: string;
  repetition: number;
  startedAt: string;
  durationSeconds: number;
  passed: boolean;
  grades: GradeOutcome[];
  immutableViolations: string[];
  mutationCaught: boolean | null;
  supervisorUsage: DelegationRecord["usage"];
  delegations: DelegationRecord[];
  workerCount: number;
  workerEfforts: string[];
  batches: Array<{ mode: string; taskCount: number; maxParallel: number }>;
  integrationConflicts: number;
  breakdown: Breakdown;
  verificationFailed: number;
  verificationRefused: number;
  workerFailures: string[];
  agentError: string | null;
}

const sha256 = (data: Buffer): string =>
  crypto.createHash("sha256").update(data).digest("hex");

function runCommand(
  command: GradeCommand,
  cwd: string,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(
      command.file,
      command.args,
      { cwd, timeout: 180_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim().slice(-4000);
        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? null
              : 0;
        resolve({ exitCode, output });
      },
    );
  });
}

async function materialize(task: BenchTask): Promise<string> {
  const workspace = await fs.promises.realpath(
    fs.mkdtempSync(path.join(os.tmpdir(), `bench-${task.id}-`)),
  );

  for (const [name, content] of Object.entries(task.files)) {
    const target = path.join(workspace, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }

  if (task.requiresGit) {
    // The parallel arm needs a commit to branch worktrees from. Identity is set
    // locally so the harness never depends on the machine's git config.
    await runGit(["init"], workspace);
    await runGit(["config", "user.email", "bench@example.invalid"], workspace);
    await runGit(["config", "user.name", "Benchmark"], workspace);
    await runGit(["config", "commit.gpgsign", "false"], workspace);
    await runGit(["config", "core.autocrlf", "false"], workspace);
    await runGit(["add", "."], workspace);
    await runGit(["commit", "-m", "fixture"], workspace);
  }

  return workspace;
}

const buildPrompt = (task: BenchTask, arm: Arm): string =>
  `${task.objective}\n\n${ARMS[arm].guidance}`;

interface Telemetry {
  delegations: DelegationRecord[];
  batches: RunRecord["batches"];
  integrationConflicts: number;
  /** Efforts the supervisor chose, from `task.queued` and single delegations. */
  efforts: string[];
  breakdown: Breakdown;
  verificationFailed: number;
  verificationRefused: number;
  workerFailures: string[];
}

const EMPTY_BREAKDOWN: Breakdown = {
  supervisorBeforeSeconds: null,
  worktreeSetupSeconds: null,
  workerWindowSeconds: null,
  slowestWorkerSeconds: null,
  integrationSeconds: null,
  supervisorAfterSeconds: null,
  peakConcurrency: null,
};

const EMPTY_TELEMETRY: Telemetry = {
  delegations: [],
  batches: [],
  integrationConflicts: 0,
  efforts: [],
  breakdown: EMPTY_BREAKDOWN,
  verificationFailed: 0,
  verificationRefused: 0,
  workerFailures: [],
};

/**
 * Highest number of workers alive at once, from start/completion timestamps.
 *
 * A sweep over +1/-1 boundary events. Ties are resolved by processing
 * completions first, so two adjacent-but-not-overlapping workers never read as
 * concurrent.
 */
export function peakOverlap(spans: Array<{ start: number; end: number }>): number {
  const points: Array<[number, number]> = [];
  for (const span of spans) {
    points.push([span.start, 1]);
    points.push([span.end, -1]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let live = 0;
  let peak = 0;
  for (const [, delta] of points) {
    live += delta;
    peak = Math.max(peak, live);
  }
  return peak;
}

/** Delegation and batch telemetry appended while this run was executing. */
export function readTelemetry(
  eventsFile: string,
  offset: number,
  runStartMs: number,
  runEndMs: number,
): Telemetry {
  const delegations: DelegationRecord[] = [];
  const batches: RunRecord["batches"] = [];
  const efforts: string[] = [];
  const workerFailures: string[] = [];
  let integrationConflicts = 0;
  let verificationFailed = 0;
  let verificationRefused = 0;

  // Timestamps, for the overhead decomposition.
  let batchStarted: number | null = null;
  let batchCompleted: number | null = null;
  let lastWorktreeCreated: number | null = null;
  const workerStarts = new Map<string, number>();
  const spans: Array<{ start: number; end: number }> = [];

  if (!fs.existsSync(eventsFile)) return EMPTY_TELEMETRY;

  const content = fs.readFileSync(eventsFile, "utf8").slice(offset);
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = Date.parse(String(parsed.timestamp ?? ""));
    const stamp = Number.isNaN(at) ? null : at;

    // A single `delegate_task` call is recorded without a `type` field and
    // carries full usage; batch workers are recorded as typed events instead.
    if (parsed.type === undefined && typeof parsed.effort === "string") {
      delegations.push({
        effort: parsed.effort,
        verdict: String(parsed.verdict ?? ""),
        attempt: Number(parsed.attempt ?? 1),
        durationSeconds: Number(parsed.durationSeconds ?? 0),
        usage: (parsed.usage as DelegationRecord["usage"]) ?? null,
      });
      efforts.push(parsed.effort);
      continue;
    }

    switch (parsed.type) {
      case "batch.started":
        batches.push({
          mode: String(parsed.mode),
          taskCount: Number(parsed.taskCount ?? 0),
          maxParallel: Number(parsed.maxParallel ?? 1),
        });
        if (stamp !== null && batchStarted === null) batchStarted = stamp;
        break;

      case "batch.completed":
        if (stamp !== null) batchCompleted = stamp;
        break;

      case "worktree.created":
        if (stamp !== null) {
          lastWorktreeCreated = Math.max(lastWorktreeCreated ?? stamp, stamp);
        }
        break;

      case "worker.started":
        if (stamp !== null) workerStarts.set(String(parsed.taskId), stamp);
        break;

      case "worker.failed":
        workerFailures.push(String(parsed.reason ?? "unknown"));
        break;

      case "verification.completed":
        verificationFailed += Number(parsed.failed ?? 0);
        verificationRefused += Number(parsed.refused ?? 0);
        break;

      case "task.queued":
        // Effort is chosen per task and is only stated when it is queued.
        efforts.push(String(parsed.effort ?? ""));
        break;

      case "worker.completed": {
        const started = workerStarts.get(String(parsed.taskId));
        if (stamp !== null && started !== undefined) {
          spans.push({ start: started, end: stamp });
        }
        delegations.push({
          effort: String(parsed.effort ?? ""),
          verdict: String(parsed.verdict ?? ""),
          attempt: 1,
          durationSeconds: Number(parsed.durationSeconds ?? 0),
          // Batch workers now report full usage. Older event files only carried
          // `outputTokens`, so fall back rather than dropping historical runs.
          usage:
            (parsed.usage as DelegationRecord["usage"] | undefined) ??
            (typeof parsed.outputTokens === "number"
              ? {
                  inputTokens: 0,
                  cachedInputTokens: 0,
                  outputTokens: parsed.outputTokens,
                  reasoningOutputTokens: 0,
                }
              : null),
        });
        break;
      }

      case "integration.conflict":
        integrationConflicts += 1;
        break;

      default:
        break;
    }
  }

  const seconds = (from: number | null, to: number | null): number | null =>
    from === null || to === null ? null : Math.round(((to - from) / 1000) * 10) / 10;

  const firstWorkerStart =
    spans.length > 0 ? Math.min(...spans.map((s) => s.start)) : null;
  const lastWorkerEnd = spans.length > 0 ? Math.max(...spans.map((s) => s.end)) : null;

  const breakdown: Breakdown = {
    supervisorBeforeSeconds: seconds(runStartMs, batchStarted),
    worktreeSetupSeconds: seconds(batchStarted, lastWorktreeCreated),
    workerWindowSeconds: seconds(firstWorkerStart, lastWorkerEnd),
    slowestWorkerSeconds:
      spans.length > 0
        ? Math.round(Math.max(...spans.map((s) => (s.end - s.start) / 1000)) * 10) / 10
        : null,
    integrationSeconds: seconds(lastWorkerEnd, batchCompleted),
    supervisorAfterSeconds: seconds(batchCompleted, runEndMs),
    peakConcurrency: spans.length > 0 ? peakOverlap(spans) : null,
  };

  return {
    delegations,
    batches,
    integrationConflicts,
    efforts: efforts.filter(Boolean),
    breakdown,
    verificationFailed,
    verificationRefused,
    workerFailures,
  };
}

async function runArm(
  suite: SuiteName,
  task: BenchTask,
  arm: Arm,
  repetition: number,
  eventsFile: string,
): Promise<RunRecord> {
  const workspace = await materialize(task);
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const armSpec = ARMS[arm];

  const before = new Map<string, string>();
  for (const name of task.immutable) {
    before.set(name, sha256(fs.readFileSync(path.join(workspace, ...name.split("/")))));
  }

  const eventsOffset = fs.existsSync(eventsFile) ? fs.statSync(eventsFile).size : 0;

  // A fixture with N independent streams needs N concurrent workers before
  // parallel execution can show what it is worth; the shipped default of 3
  // would otherwise queue the rest and cap the speedup at 3x regardless of
  // fixture size. This is a non-default configuration and is recorded in the
  // results file so no reader has to assume otherwise. It changes nothing for
  // the solo arms, which have no workers.
  const maxParallel = armSpec.delegation
    ? Math.min(Math.max(task.streams ?? 3, 1), 8)
    : null;

  const config = armSpec.delegation
    ? {
        mcp_servers: {
          [ORCHESTRATOR_NAME]: {
            env: {
              SOL_LUNA_EVENTS: eventsFile,
              SOL_LUNA_MAX_PARALLEL: String(maxParallel),
            },
          },
        },
      }
    : { mcp_servers: { [ORCHESTRATOR_NAME]: { enabled: false } } };

  const codex = new Codex({ config });
  const thread = codex.startThread({
    model: SUPERVISOR_MODEL,
    modelReasoningEffort: armSpec.effort as "high",
    sandboxMode: "workspace-write",
    workingDirectory: workspace,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
  });

  let supervisorUsage: RunRecord["supervisorUsage"] = null;
  let agentError: string | null = null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TASK_TIMEOUT_SECONDS * 1000);

  try {
    const { events } = await thread.runStreamed(buildPrompt(task, arm), {
      signal: controller.signal,
    });
    for await (const event of events as AsyncGenerator<ThreadEvent>) {
      if (event.type === "turn.completed") {
        supervisorUsage = {
          inputTokens: event.usage.input_tokens,
          cachedInputTokens: event.usage.cached_input_tokens,
          outputTokens: event.usage.output_tokens,
          reasoningOutputTokens: event.usage.reasoning_output_tokens,
        };
      } else if (event.type === "turn.failed") {
        agentError = event.error.message;
      } else if (event.type === "error") {
        agentError = event.message;
      }
    }
  } catch (error) {
    agentError = (error as Error).message;
  } finally {
    clearTimeout(timer);
  }

  const runEndMs = Date.now();
  const durationSeconds = Math.round((runEndMs - start) / 1000);

  // --- Objective grading, performed by the harness --------------------------
  const grades: GradeOutcome[] = [];
  for (const command of task.grade) {
    const { exitCode, output } = await runCommand(command, workspace);
    grades.push({ label: command.label, exitCode, passed: exitCode === 0, output });
  }

  const immutableViolations: string[] = [];
  for (const [name, hash] of before) {
    const target = path.join(workspace, ...name.split("/"));
    const current = fs.existsSync(target) ? sha256(fs.readFileSync(target)) : "<deleted>";
    if (current !== hash) immutableViolations.push(name);
  }

  let mutationCaught: boolean | null = null;
  if (task.mutation && grades.every((grade) => grade.passed)) {
    const target = path.join(workspace, task.mutation.file);
    const original = fs.readFileSync(target, "utf8");
    try {
      fs.writeFileSync(target, task.mutation.content, "utf8");
      const { exitCode } = await runCommand(task.mutation.command, workspace);
      mutationCaught = exitCode !== 0;
    } finally {
      fs.writeFileSync(target, original, "utf8");
    }
  }

  const passed =
    grades.length > 0 &&
    grades.every((grade) => grade.passed) &&
    immutableViolations.length === 0 &&
    (task.mutation ? mutationCaught === true : true);

  const telemetry: Telemetry = armSpec.delegation
    ? readTelemetry(eventsFile, eventsOffset, start, runEndMs)
    : EMPTY_TELEMETRY;

  const workerEfforts = telemetry.efforts;

  await fs.promises
    .rm(workspace, { recursive: true, force: true, maxRetries: 3 })
    .catch(() => undefined);

  return {
    suite,
    taskId: task.id,
    taskCategory: task.category,
    tier: task.tier ?? null,
    streams: task.streams ?? null,
    maxParallelConfigured: maxParallel,
    arm,
    armLabel: armSpec.label,
    supervisorEffort: armSpec.effort,
    repetition,
    startedAt,
    durationSeconds,
    passed,
    grades,
    immutableViolations,
    mutationCaught,
    supervisorUsage,
    delegations: telemetry.delegations,
    workerCount: Math.max(telemetry.delegations.length, workerEfforts.length),
    workerEfforts,
    batches: telemetry.batches,
    integrationConflicts: telemetry.integrationConflicts,
    breakdown: telemetry.breakdown,
    verificationFailed: telemetry.verificationFailed,
    verificationRefused: telemetry.verificationRefused,
    workerFailures: telemetry.workerFailures,
    agentError,
  };
}

export function parseArgs(argv: string[]): {
  reps: number;
  suite: SuiteName;
  tasks: string[];
  arms: Arm[];
} {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const list = (value: string | undefined): string[] =>
    value
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];

  const suiteRaw = get("--suite");
  if (!suiteRaw) {
    throw new Error("A --suite must be specified to avoid accidentally invoking a live benchmark.");
  }
  const suite = suiteRaw as SuiteName;
  const arms = list(get("--arms")) as Arm[];

  return {
    reps: Number(get("--reps") ?? 2),
    suite,
    tasks: list(get("--tasks")),
    arms:
      arms.length > 0
        ? arms
        : suite === "parallel"
          ? ["solo-high", "solo-xhigh", "seq", "par"]
          : suite === "scale"
            ? ["solo-high", "adaptive", "par-forced"]
            : ["solo-high", "seq"],
  };
}

async function main(): Promise<void> {
  const { reps, suite, tasks: taskIds, arms } = parseArgs(process.argv.slice(2));

  const available = SUITES[suite];
  if (!available) {
    console.error(
      `Unknown suite "${suite}". Available: ${Object.keys(SUITES).join(", ")}`,
    );
    process.exit(1);
  }
  const tasks =
    taskIds.length === 0
      ? available
      : available.filter((task) => taskIds.includes(task.id));
  if (tasks.length === 0) {
    console.error(
      `No matching tasks in ${suite}: ${available.map((t) => t.id).join(", ")}`,
    );
    process.exit(1);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const eventsFile = path.join(RESULTS_DIR, `${stamp}.events.jsonl`);
  const resultsFile = path.join(RESULTS_DIR, `${stamp}.${suite}.json`);

  const total = tasks.length * arms.length * reps;
  console.log(
    `Suite: ${suite} | ${tasks.length} task(s) x ${arms.length} arm(s) x ${reps} rep(s) = ${total} runs`,
  );
  console.log(`Supervisor model: ${SUPERVISOR_MODEL}`);
  console.log(`Results: ${resultsFile}\n`);

  const records: RunRecord[] = [];
  let index = 0;

  for (let repetition = 1; repetition <= reps; repetition += 1) {
    for (const task of tasks) {
      for (const arm of arms) {
        index += 1;
        process.stdout.write(
          `[${index}/${total}] ${task.id} / ${arm} / rep ${repetition} ... `,
        );
        const record = await runArm(suite, task, arm, repetition, eventsFile);
        records.push(record);

        const detail =
          record.workerCount > 0
            ? ` (${record.workerCount} worker(s): ${record.workerEfforts.join(", ") || "?"})`
            : "";
        console.log(
          `${record.passed ? "PASS" : "FAIL"} in ${record.durationSeconds}s${detail}`,
        );

        fs.writeFileSync(
          resultsFile,
          JSON.stringify(
            {
              schema: 3,
              suite,
              supervisorModel: SUPERVISOR_MODEL,
              startedAt: stamp,
              platform: `${process.platform} ${process.arch}`,
              nodeVersion: process.version,
              reps,
              records,
            },
            null,
            2,
          ),
          "utf8",
        );
      }
    }
  }

  console.log(`\nWrote ${records.length} records to ${resultsFile}`);
}

// Only run when invoked as a script; the telemetry helpers above are imported
// by tests, which must not start a benchmark.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error("Benchmark failed:", error);
    process.exit(1);
  });
}
