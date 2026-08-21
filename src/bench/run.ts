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
import { clampParallel } from "../config.js";
import { runGit } from "../git.js";
import {
  type BenchMcpProvenance,
  benchCodexHome,
  prepareBenchCodexHome,
  requiredSettingSummary,
  resolveBenchMcpServer,
} from "./codex-home.js";
import { PARALLEL_TASKS } from "./parallel-tasks.js";
import { SCALE_TASKS } from "./scale-tasks.js";
import { BENCH_TASKS, type BenchTask, type GradeCommand } from "./tasks.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * Where run artifacts are written. Resolved from this module's location rather
 * than the cwd, and deliberately outside the OS temp tree: the per-arm reset
 * removes a temp workspace, so the two must never be able to nest.
 */
export const RESULTS_DIR = path.resolve(HERE, "..", "..", "bench", "results");

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
 * How a delegated result must be read back into the supervisor's transcript.
 *
 * This exists because the first width-12 run was not comparable to the width-6
 * one for a reason that had nothing to do with width. The two supervisors chose
 * different ways to print the same tool result: width 6 printed only
 * `result.content`'s text (~3.6k chars), width 12 printed the whole object
 * including `structuredContent` (~42.8k chars). Parent cost then differed by
 * roughly 12x on a 2x change in task count, and none of that was measurement.
 *
 * The canonical representation is both surfaces, text first. That is what the
 * server returns — `{ content: [{ type: "text", ... }], structuredContent }`,
 * see `renderBatch` and the handlers in `server.ts` — and both cross the wire
 * to the client, which is why the SDK types an MCP result as
 * `{ content, structured_content }`. It is deliberately the *larger* of the two
 * behaviours observed: the cheaper one silently discarded a surface a real host
 * delivers, and picking a representation because it is cheap is how a benchmark
 * ends up measuring its own prompt.
 *
 * Limitation: in this harness Codex reaches the tool through a code-execution
 * cell, so the supervisor decides what its own transcript receives. A host that
 * exposes the tool directly injects both surfaces itself and never asks. This
 * text removes the *choice*; it cannot remove the supervisor's ability to
 * ignore it, which is why `readMcpCall` below records what actually crossed the
 * boundary so a reader can tell whether a run is comparable.
 */
export const CANONICAL_RESULT_CONSUMPTION = `Print the returned result exactly like this, and print it no other way:

    for (const block of result.content ?? []) {
      if (block.type === "text") text(block.text);
    }
    text(JSON.stringify(result.structuredContent ?? result.structured_content ?? null));

Those are the two surfaces an MCP host puts in front of you when you call the
tool directly. Print both, in that order, once, unsummarised and unfiltered.`;

/**
 * The delegation policy every delegating arm runs under.
 *
 * It restates what the product's own guidance already says, so the benchmark
 * measures the shipped policy rather than a benchmark-only one. The lead-in is
 * conditional so that attaching it to the free-choice arm does not read as an
 * instruction to delegate.
 */
export const DELEGATION_POLICY = `When you delegate, apply the same policy the orchestrator's own guidance states:

- Request \`resultDetail: "compact"\` for every delegated task. Output from
  verification that failed, was refused or was skipped is retained either way.
- Consider \`contextCapsule\`, and include it only where it carries something the
  worker cannot infer from its objective and the files in its scope. Omit it
  otherwise, and never restate the objective, acceptance criteria, file scope or
  verification commands in it.
- Review the returned evidence in proportion to the evidence. A clean PASS —
  every verdict PASS, trustworthy true, no discrepancies, no scope violations,
  no integration conflict, integration applied — is accepted as it stands: no
  \`git diff\`, no rereading the implementations, no rerunning verification the
  orchestrator already ran, no manual integration review. Anything else is
  investigated properly.

${CANONICAL_RESULT_CONSUMPTION}`;

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
the same. Review what comes back and integrate it.
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
criteria and verification command. Afterwards, review the results.`,
  },
  "par-forced": {
    label: "Sol high + parallel Luna (mandated)",
    effort: "high",
    delegation: true,
    guidance: `You are a supervising architect and you MUST delegate this work.
Do not implement any module yourself.

Call the delegate_tasks tool exactly once with mode:"parallel" and one task per
module, so the workers run at the same time. Give each task a DISJOINT
allowedFiles scope covering only its own module. Choose each worker's effort
from that subtask's own difficulty.`,
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

/** One MCP tool call the supervisor made, as observed on the event stream. */
export interface McpCallRecord {
  tool: string;
  /** Tasks in the call, for `delegate_tasks`; null for a single delegation. */
  taskCount: number | null;
  /** `resultDetail` the supervisor actually asked for, or null if it omitted it. */
  resultDetail: string | null;
  /** Whether any task in the call carried a context capsule. */
  contextCapsule: boolean;
  /** Characters in the readable text surface the server returned. */
  contentChars: number;
  /** Characters in `structuredContent`, serialised as it crosses the wire. */
  structuredChars: number;
  /**
   * Characters in the canonical representation: both surfaces, text first.
   * See {@link CANONICAL_RESULT_CONSUMPTION}. This is what the supervisor was
   * told to ingest, so two runs whose parent costs differ can be checked
   * against it before the difference is attributed to anything else.
   */
  canonicalChars: number;
}

/**
 * Read one `mcp_tool_call` item into a record.
 *
 * Deliberately total: a call that failed, returned nothing, or arrived in a
 * shape this harness did not expect still produces a record with zeroes rather
 * than throwing, because losing a whole benchmark run to a telemetry surprise
 * is worse than an incomplete row.
 */
export function readMcpCall(item: {
  tool?: unknown;
  arguments?: unknown;
  result?: { content?: unknown; structured_content?: unknown } | undefined;
}): McpCallRecord {
  const args = (item.arguments ?? {}) as Record<string, unknown>;
  const tasks = Array.isArray(args.tasks)
    ? (args.tasks as Record<string, unknown>[])
    : null;

  const content = Array.isArray(item.result?.content) ? item.result.content : [];
  const contentChars = content.reduce(
    (total: number, block: unknown) =>
      total + String((block as { text?: unknown })?.text ?? "").length,
    0,
  );
  const structured = item.result?.structured_content;
  const structuredChars =
    structured === undefined ? 0 : JSON.stringify(structured ?? null).length;

  const capsuleOn = (task: Record<string, unknown>): boolean =>
    task.contextCapsule !== undefined && task.contextCapsule !== null;

  return {
    tool: typeof item.tool === "string" ? item.tool : "unknown",
    taskCount: tasks ? tasks.length : null,
    resultDetail: typeof args.resultDetail === "string" ? args.resultDetail : null,
    contextCapsule: tasks ? tasks.some(capsuleOn) : capsuleOn(args),
    contentChars,
    structuredChars,
    canonicalChars: contentChars + structuredChars,
  };
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
  /**
   * What actually crossed the MCP boundary, one entry per delegation call.
   * Empty when the supervisor never called a delegation tool, and empty for
   * every solo arm. Makes the canonical ingestion volume a recorded number
   * rather than something a reader has to infer from the parent's token count.
   */
  mcpCalls: McpCallRecord[];
  /**
   * Which MCP server this run actually had in front of it.
   *
   * Recorded because `maxParallelConfigured` alone cannot be trusted: a run once
   * reported 12 while a globally installed v0.7.0 build clamped the batch to 8.
   * The server path, its content hash and the `MAX_PARALLEL_LIMIT` compiled into
   * it make that class of mismatch visible in the results rather than only in a
   * batch's telemetry. Present on solo arms too, where it records that the same
   * isolated configuration was in effect with the server switched off.
   */
  mcpServer: BenchMcpProvenance;
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

/**
 * The exact text sent to a supervisor.
 *
 * Every delegating arm gets {@link DELEGATION_POLICY} appended here rather than
 * in its own `guidance`, so the policy — and in particular the canonical
 * result-consumption path — is byte-identical across arms and across fixture
 * widths, and a new arm cannot be added without it.
 */
export const buildPrompt = (task: BenchTask, arm: Arm): string => {
  const spec = ARMS[arm];
  const parts = [task.objective, spec.guidance];
  if (spec.delegation) parts.push(DELEGATION_POLICY);
  return parts.join("\n\n");
};

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

/**
 * How many workers the orchestrator is allowed to run at once for one arm.
 *
 * A fixture with N independent streams needs N concurrent workers before
 * parallel execution can show what it is worth. The shipped default of 3 would
 * queue the rest and cap the speedup regardless of fixture size, which is what
 * made the first width-12 run measure a peak of 8 and therefore measure waves
 * rather than 12-way concurrency.
 *
 * The value is clamped by the runtime's own {@link clampParallel}, so a
 * benchmark can never ask the orchestrator for more than it will honour and
 * then record a number it did not actually run at. `BENCH_MAX_PARALLEL` is an
 * explicit operator override; a value that is not a usable number is an error
 * rather than something silently coerced to 1, because a silently-1 run looks
 * like a valid measurement afterwards.
 *
 * This changes nothing for the solo arms, which have no workers, and nothing
 * for the production default — that still comes from `SOL_LUNA_MAX_PARALLEL`
 * in `config.ts` and is still 3 when unset.
 */
export function getConfiguredConcurrency(
  armSpec: { delegation: boolean },
  task: { streams?: number | null },
): number | null {
  if (!armSpec.delegation) return null;

  const override = process.env.BENCH_MAX_PARALLEL;
  if (override !== undefined) {
    const parsed = Number(override);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(
        `BENCH_MAX_PARALLEL must be a number >= 1, got "${override}". ` +
          `Unset it to derive concurrency from the fixture's stream count.`,
      );
    }
    return clampParallel(parsed);
  }

  return clampParallel(Math.max(task.streams ?? 3, 1));
}

/**
 * The `--config` overlay handed to the Codex CLI for one arm.
 *
 * Deliberately redundant with the isolated config file written by
 * {@link prepareBenchCodexHome}: the file is what decides *which* server binary
 * Codex launches, and this overlay is what has always carried the per-arm
 * values. Keeping both means the two can only agree — a change in how Codex
 * merges `--config` into a table cannot silently drop the concurrency, and
 * cannot resurrect a globally registered server either, because the file no
 * longer names one.
 *
 * `maxParallel: null` is a solo arm: the server is disabled on both surfaces, so
 * those arms genuinely cannot delegate.
 */
export function mcpConfigOverlay(
  eventsFile: string,
  maxParallel: number | null,
): { mcp_servers: Record<string, Record<string, boolean | Record<string, string>>> } {
  if (maxParallel === null) {
    return { mcp_servers: { [ORCHESTRATOR_NAME]: { enabled: false } } };
  }
  return {
    mcp_servers: {
      [ORCHESTRATOR_NAME]: {
        env: {
          SOL_LUNA_EVENTS: eventsFile,
          SOL_LUNA_MAX_PARALLEL: String(maxParallel),
        },
      },
    },
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

  // A non-default configuration, recorded per run as `maxParallelConfigured`
  // so no reader has to assume otherwise. See getConfiguredConcurrency above.
  const maxParallel = getConfiguredConcurrency(armSpec, task);

  // The isolated benchmark CODEX_HOME, established fresh for this arm. This is
  // what makes the server Codex launches this repository's own `dist/server.js`
  // instead of whatever the user happens to have registered globally, and it
  // throws rather than falling back if that build is missing. `maxParallel` is
  // null exactly for the solo arms, which is what disables the server there.
  const mcp = prepareBenchCodexHome({ eventsPath: eventsFile, maxParallel });

  const codex = new Codex({
    config: mcpConfigOverlay(eventsFile, maxParallel),
    env: mcp.env,
  });
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
  const mcpCalls: McpCallRecord[] = [];

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
      } else if (event.type === "item.completed" && event.item.type === "mcp_tool_call") {
        mcpCalls.push(readMcpCall(event.item));
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
    mcpCalls,
    mcpServer: mcp.provenance,
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
    throw new Error(
      "A --suite must be specified to avoid accidentally invoking a live benchmark.",
    );
  }
  if (!Object.prototype.hasOwnProperty.call(SUITES, suiteRaw)) {
    // Catches both a typo and `--suite --reps 1`, where the next flag would
    // otherwise be taken as the suite name and fall through to a default arm
    // list. Either way the operator asked for something that does not exist,
    // and a live benchmark is too expensive to start on a guess.
    throw new Error(
      `Unknown --suite "${suiteRaw}". Available: ${Object.keys(SUITES).join(", ")}.`,
    );
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

  // Before anything is spent: the harness must be able to point Codex at this
  // repository's own build. A missing or non-local `dist/server.js` ends the run
  // here rather than being quietly replaced by the globally installed package,
  // which is how a width-12 run came to be measured at a ceiling of 8.
  const mcpServer = resolveBenchMcpServer();

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const eventsFile = path.join(RESULTS_DIR, `${stamp}.events.jsonl`);
  const resultsFile = path.join(RESULTS_DIR, `${stamp}.${suite}.json`);

  const total = tasks.length * arms.length * reps;
  console.log(
    `Suite: ${suite} | ${tasks.length} task(s) x ${arms.length} arm(s) x ${reps} rep(s) = ${total} runs`,
  );
  console.log(`Supervisor model: ${SUPERVISOR_MODEL}`);
  console.log(
    `MCP server: ${mcpServer.entry} (v${mcpServer.packageVersion}, ` +
      `sha256 ${mcpServer.sha256.slice(0, 12)}, ` +
      `MAX_PARALLEL_LIMIT ${mcpServer.maxParallelLimit})`,
  );
  console.log(`Isolated CODEX_HOME: ${benchCodexHome()} (${requiredSettingSummary()})`);
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
              schema: 4,
              suite,
              supervisorModel: SUPERVISOR_MODEL,
              startedAt: stamp,
              platform: `${process.platform} ${process.arch}`,
              nodeVersion: process.version,
              // Which build every record in this file was measured against, and
              // the isolated Codex home it was registered in. Schema 4 exists
              // for these two fields and the per-record `mcpServer`.
              mcpServer,
              benchCodexHome: benchCodexHome(),
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
