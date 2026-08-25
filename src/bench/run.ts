/**
 * Benchmark harness.
 *
 * Benchmark V2 compares fixed-effort Sol Medium working alone with adaptive
 * orchestration and, on selected fixtures, a legitimate forced-delegation
 * counterfactual. Correctness is graded externally; credits and latency are
 * the primary measured trade-off.
 *
 * Every arm gets the same fixtures and the same objective text. Only the
 * supervisor's effort, and whether delegation is available, differ. Grading is
 * always performed by this harness after the agent stops.
 *
 * Usage:
 *   node dist/bench/run.js --arms solo-medium,adaptive-medium --reps 2 --confirm-standard-speed
 */
import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGit } from "../git.js";
import {
  assertCampaignCompatibility,
  collectCompletedCampaignCells,
  planCampaignCells,
  readCampaignShards,
  type CampaignCell,
  type CampaignCompatibility,
} from "./campaign.js";
import {
  BENCHMARK_V2_PRICING_PROFILE,
  calculateBenchmarkCredits,
  copyPricingProfile,
  type BenchmarkCreditSummary,
  type BenchmarkUsage,
  type CreditPricingProfile,
} from "./credits.js";
import type { BenchTask, GradeCommand } from "./tasks.js";
import { V2_TASKS, type V2BenchTask } from "./v2-tasks.js";
import {
  BENCHMARK_V3_FREEZE_SHA,
  BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
  V3_TASKS,
  type V3BenchTask,
} from "./v3-tasks.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(HERE, "..", "..", "bench", "results");

export const SUPERVISOR_MODEL = "gpt-5.6-sol" as const;
const ORCHESTRATOR_NAME = process.env.SOL_LUNA_SERVER_NAME ?? "sol-luna-orchestrator";
const TASK_TIMEOUT_SECONDS = Number(process.env.BENCH_TASK_TIMEOUT ?? 1500);

/**
 * Codex SDK 0.147.0 exposes no supported speed/service-tier thread option.
 * Live entry points therefore require an operator acknowledgement that Fast
 * mode is disabled for the ChatGPT/Codex account before any turn starts.
 */
export const BENCHMARK_V2_EXECUTION_PROFILE = Object.freeze({
  speedMode: "standard" as const,
  fastModeDisabled: true as const,
  serviceTier: null,
  serviceTierStatus: "not-exposed-by-codex-sdk" as const,
  sdkSpeedPinningSupported: false as const,
  enforcement: "operator-confirmed-pre-run" as const,
});
export const BENCHMARK_V3_EXECUTION_PROFILE = BENCHMARK_V2_EXECUTION_PROFILE;

export function currentCampaignCompatibility(
  suite: SuiteName = "v2",
): CampaignCompatibility {
  return {
    schema: 4,
    benchmarkVersion: suite === "v3" ? 3 : 2,
    suite,
    supervisorModel: SUPERVISOR_MODEL,
    supervisorEffort: "medium",
    pricingProfile: copyPricingProfile(BENCHMARK_V2_PRICING_PROFILE),
    executionProfile: { ...BENCHMARK_V2_EXECUTION_PROFILE },
    ...(suite === "v3"
      ? {
          holdoutFreezeSha: BENCHMARK_V3_FREEZE_SHA,
          productionBaseline: {
            version: "0.10.0",
            sha: BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
          },
        }
      : {}),
  };
}

export const SUITES = {
  v2: V2_TASKS,
  v3: V3_TASKS,
} as const;
export type SuiteName = keyof typeof SUITES;

/**
 * Benchmark V2 arms. Supervisor model and effort are intentionally identical.
 *
 * `delegation` decides whether the orchestrator MCP server is reachable at all,
 * so the solo arms genuinely cannot delegate rather than merely being asked not
 * to.
 */
export const ARMS = {
  "solo-medium": {
    label: "Solo Medium",
    effort: "medium",
    delegation: false,
    guidance: `Implement this yourself, directly in the current directory.
The orchestration server is disabled. Make sure the required checks pass before you finish.`,
  },
  "adaptive-medium": {
    label: "Adaptive Medium",
    effort: "medium",
    delegation: true,
    guidance: `You have delegation tools available (delegate_task and delegate_tasks).
Decide normally whether zero, one, or multiple workers are appropriate. Balance
correctness, credits, latency, and coordination risk. Zero workers is valid. Make
sure the required checks pass before you finish.`,
  },
  "forced-delegation": {
    label: "Forced Delegation",
    effort: "medium",
    delegation: true,
    guidance: "",
  },
} as const;

export type Arm = keyof typeof ARMS;

export const FORCED_CAMPAIGN_TASK_IDS = [
  "v2-frontmatter-parser",
  "v2-integration-toolkit",
  "v2-data-contracts",
  "v2-repository-tools",
] as const;

export interface GradeOutcome {
  label: string;
  exitCode: number | null;
  passed: boolean;
  output: string;
}

export interface DelegationRecord {
  taskId?: string | null;
  workerThreadId?: string | null;
  model: string;
  effort: string;
  verdict: string;
  attempt: number;
  recoveryClassification?: string;
  recoveryEvidence?: string;
  durationSeconds: number | null;
  usage: BenchmarkUsage | null;
}

export interface ParticipantAccounting {
  role: "supervisor" | "worker";
  taskId: string | null;
  workerThreadId: string | null;
  model: string;
  effort: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  cacheWriteInputTokens: number | null;
  rateCardCredits: number | null;
  durationSeconds: number | null;
}

export interface RunCreditAccounting {
  pricingProfileId: string;
  actualCredits: number | null;
  participants: ParticipantAccounting[];
  rateCardCredits: {
    total: number | null;
    sol: number | null;
    luna: number | null;
  };
}

/**
 * One half of a possible modern single-delegation pair, with the correlation
 * evidence needed to reconcile it — kept beside the record rather than inside
 * it, because `DelegationRecord` is serialized into committed results files.
 */
interface ReconcilableRow {
  record: DelegationRecord;
  /**
   * Worker thread id. Both representations have carried it since single-call
   * telemetry existed: the legacy row as `workerThreadId`, the lifecycle event
   * as `threadId`. It is the only field that identifies the same delegation
   * rather than merely describing an identical-looking one.
   */
  threadId: string | null;
  stamp: number | null;
}

/** Treat an absent, non-string, or empty thread id as "no identity available". */
const threadIdOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

const optionalSeconds = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

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
  benchmarkVersion?: 2 | 3;
  suite: SuiteName | string;
  taskId: string;
  taskCategory: string;
  workloadClass?: string;
  /** Evaluator-only V3 metadata. Never included in the model-facing prompt. */
  routingCategory?: V3BenchTask["routingCategory"];
  /** Per-run identity and deterministic fixture hash for V3 evidence. */
  runId?: string;
  fixtureRevision?: string;
  tier: string | null;
  streams: number | null;
  /** SOL_LUNA_MAX_PARALLEL given to the orchestrator, or null when solo. */
  maxParallelConfigured: number | null;
  arm: Arm | string;
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
  creditAccounting?: RunCreditAccounting;
}

export interface BenchmarkResultsSnapshot {
  schema: 4;
  benchmarkVersion: 2 | 3;
  suite: SuiteName;
  supervisorModel: typeof SUPERVISOR_MODEL;
  supervisorEffort: "medium";
  executionProfile: typeof BENCHMARK_V2_EXECUTION_PROFILE;
  pricingProfile: ReturnType<typeof copyPricingProfile>;
  campaignId: string;
  startedAt: string;
  platform: string;
  nodeVersion: string;
  reps: number;
  records: RunRecord[];
  holdoutFreezeSha?: string;
  productionBaseline?: { version: "0.10.0"; sha: string };
}

export function assertStandardSpeedConfirmed(confirmed: boolean): void {
  if (!confirmed) {
    throw new Error(
      "Benchmark V2 requires normal/standard Codex speed. Disable Fast mode for the ChatGPT/Codex account, then pass --confirm-standard-speed.",
    );
  }
}

export function assertV3PricingProfileConfirmed(confirmed: boolean): void {
  if (!confirmed) {
    throw new Error(
      "Benchmark V3 requires revalidating the applicable Codex credit-rate profile immediately before execution, then passing --confirm-pricing-profile.",
    );
  }
}

export function assertV3CampaignPolicy(options: {
  reps: number;
  arms: readonly Arm[];
  resume: boolean;
}): void {
  if (options.arms.includes("forced-delegation")) {
    throw new Error("Forced Delegation is not a Benchmark V3 campaign arm");
  }
  if (options.reps !== 2 && options.reps !== 3) {
    throw new Error("Benchmark V3 campaigns require exactly 2 initial repetitions");
  }
  if (options.reps === 3 && !options.resume) {
    throw new Error(
      "A Benchmark V3 third repetition requires a reviewed recommendation and --resume",
    );
  }
}

export function buildResultsSnapshot(options: {
  startedAt: string;
  campaignId?: string;
  reps: number;
  records: RunRecord[];
  standardSpeedConfirmed: boolean;
  suite?: SuiteName;
  pricingProfileConfirmed?: boolean;
}): BenchmarkResultsSnapshot {
  assertStandardSpeedConfirmed(options.standardSpeedConfirmed);
  const suite = options.suite ?? "v2";
  if (suite === "v3") {
    assertV3PricingProfileConfirmed(options.pricingProfileConfirmed === true);
  }
  return {
    schema: 4,
    benchmarkVersion: suite === "v3" ? 3 : 2,
    suite,
    supervisorModel: SUPERVISOR_MODEL,
    supervisorEffort: "medium",
    executionProfile: { ...BENCHMARK_V2_EXECUTION_PROFILE },
    pricingProfile: copyPricingProfile(BENCHMARK_V2_PRICING_PROFILE),
    campaignId: options.campaignId ?? options.startedAt,
    startedAt: options.startedAt,
    platform: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
    reps: options.reps,
    records: options.records,
    ...(suite === "v3"
      ? {
          holdoutFreezeSha: BENCHMARK_V3_FREEZE_SHA,
          productionBaseline: {
            version: "0.10.0" as const,
            sha: BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
          },
        }
      : {}),
  };
}

/**
 * Atomically replace only the current invocation's shard after a completed run.
 * The sibling temp file keeps the move on one filesystem. On Windows, Node's
 * libuv rename uses MoveFileExW with MOVEFILE_REPLACE_EXISTING; never unlink the
 * destination first, because a failed replacement must preserve the last good
 * checkpoint.
 */
export function checkpointResultsShard(
  file: string,
  snapshot: BenchmarkResultsSnapshot,
  options: { beforeReplace?: (temporaryFile: string) => void } = {},
): void {
  // Serialize before creating a temp file so serialization failure cannot leave
  // an artifact or affect the previous checkpoint.
  const serialized = JSON.stringify(snapshot, null, 2);
  const temporaryFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryFile, serialized, {
      encoding: "utf8",
      flag: "wx",
      flush: true,
    });
    options.beforeReplace?.(temporaryFile);
    fs.renameSync(temporaryFile, file);
  } finally {
    // After a successful rename the temp path no longer exists. On any handled
    // failure, remove a partial or complete temp without masking the real error.
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // Best effort: a crash or external file lock can leave an ignored .tmp.
    }
  }
}

const participantUsage = (
  usage: Partial<BenchmarkUsage> | null | undefined,
): Pick<
  ParticipantAccounting,
  | "inputTokens"
  | "cachedInputTokens"
  | "outputTokens"
  | "reasoningOutputTokens"
  | "cacheWriteInputTokens"
> => ({
  inputTokens: usage?.inputTokens ?? null,
  cachedInputTokens: usage?.cachedInputTokens ?? null,
  outputTokens: usage?.outputTokens ?? null,
  reasoningOutputTokens: usage?.reasoningOutputTokens ?? null,
  cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
});

/** Build participant rows and aggregates from one shared rate-card calculation. */
export function buildRunCreditAccounting(options: {
  supervisorUsage: BenchmarkUsage | null;
  supervisorEffort: string;
  delegations: readonly DelegationRecord[];
  actualCredits?: number | null;
  pricingProfile?: CreditPricingProfile;
}): RunCreditAccounting {
  const pricingProfile = options.pricingProfile ?? BENCHMARK_V2_PRICING_PROFILE;
  const credits: BenchmarkCreditSummary = calculateBenchmarkCredits(
    [
      { model: SUPERVISOR_MODEL, usage: options.supervisorUsage },
      ...options.delegations.map((delegation) => ({
        model: delegation.model,
        usage: delegation.usage,
      })),
    ],
    { actualCredits: options.actualCredits ?? null, pricingProfile },
  );
  const supervisorCredit = credits.records[0]?.rateCardCredits ?? null;
  const workerCredits = credits.records.slice(1).map((record) => record.rateCardCredits);
  const lunaCredits =
    workerCredits.length === 0
      ? 0
      : (credits.perModel.find((entry) => entry.model === "gpt-5.6-luna")
          ?.rateCardCredits ?? null);
  const participants: ParticipantAccounting[] = [
    {
      role: "supervisor",
      taskId: null,
      workerThreadId: null,
      model: SUPERVISOR_MODEL,
      effort: options.supervisorEffort,
      ...participantUsage(options.supervisorUsage),
      rateCardCredits: supervisorCredit,
      // End-to-end duration includes grading and cannot be attributed to Sol alone.
      durationSeconds: null,
    },
    ...options.delegations.map((delegation, index) => ({
      role: "worker" as const,
      taskId: delegation.taskId ?? null,
      workerThreadId: delegation.workerThreadId ?? null,
      model: delegation.model,
      effort: delegation.effort,
      ...participantUsage(delegation.usage),
      rateCardCredits: workerCredits[index] ?? null,
      durationSeconds: delegation.durationSeconds,
    })),
  ];

  return {
    pricingProfileId: pricingProfile.profileId,
    actualCredits: credits.actualCredits,
    participants,
    rateCardCredits: {
      total: credits.totalRateCardCredits,
      sol: supervisorCredit,
      luna: lunaCredits,
    },
  };
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

function forcedGuidance(task: V2BenchTask): string {
  const forced = task.forcedDelegation;
  if (forced.mode === "single") {
    return `You MUST delegate one substantial bounded unit with delegate_task. Do not
implement it yourself. Use this natural contract, choosing the worker effort from the
subtask's difficulty, then review and grade the result:\n${JSON.stringify(forced.task, null, 2)}`;
  }
  if (forced.mode === "parallel") {
    return `You MUST call delegate_tasks exactly once with mode:"parallel" for these
genuinely independent, disjoint workstreams. Do not implement them yourself. Choose
each worker effort from its subtask difficulty, review the integrated result, and run
the whole-project checks:\n${JSON.stringify(forced.tasks, null, 2)}`;
  }
  throw new Error(
    `Forced delegation is not appropriate for ${task.id}: ${forced.reason}`,
  );
}

const buildPrompt = (task: BenchTask, arm: Arm): string =>
  `${task.objective}\n\n${
    arm === "forced-delegation" ? forcedGuidance(task as V2BenchTask) : ARMS[arm].guidance
  }`;

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

/** Lifecycle and legacy delegation telemetry appended during this run. */
export function readTelemetry(
  eventsFile: string,
  offset: number,
  runStartMs: number,
  runEndMs: number,
): Telemetry {
  const delegations: DelegationRecord[] = [];
  const batches: RunRecord["batches"] = [];
  const efforts: string[] = [];
  const legacyRows: ReconcilableRow[] = [];
  const singleCompletions: ReconcilableRow[] = [];
  const singleBatchIds = new Set<string>();
  /** Effort each single-mode batch queued, so it is never counted twice. */
  const singleQueuedEfforts = new Map<string, string>();
  const singleCompletedBatchIds = new Set<string>();
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

    // Older single `delegate_task` telemetry has no `type`. Modern single calls
    // also emit lifecycle events, so defer these rows until they can be
    // reconciled instead of counting both representations.
    if (parsed.type === undefined && typeof parsed.effort === "string") {
      legacyRows.push({
        record: {
          taskId: threadIdOf(parsed.taskId),
          workerThreadId: threadIdOf(parsed.workerThreadId),
          model: String(parsed.model ?? "gpt-5.6-luna"),
          effort: parsed.effort,
          verdict: String(parsed.verdict ?? ""),
          attempt: Number(parsed.attempt ?? 1),
          durationSeconds: optionalSeconds(parsed.durationSeconds),
          usage: (parsed.usage as DelegationRecord["usage"]) ?? null,
        },
        threadId: threadIdOf(parsed.workerThreadId),
        stamp,
      });
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
        if (parsed.mode === "single") singleBatchIds.add(String(parsed.batchId));
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
        if (stamp !== null) {
          workerStarts.set(
            `${String(parsed.taskId)}:${Number(parsed.attempt ?? 1)}`,
            stamp,
          );
        }
        break;

      case "worker.failed":
        workerFailures.push(String(parsed.reason ?? "unknown"));
        break;

      case "verification.completed":
        verificationFailed += Number(parsed.failed ?? 0);
        verificationRefused += Number(parsed.refused ?? 0);
        break;

      case "task.queued": {
        // Effort is chosen per task and is only stated when it is queued.
        const queuedEffort = String(parsed.effort ?? "");
        efforts.push(queuedEffort);
        if (singleBatchIds.has(String(parsed.batchId))) {
          singleQueuedEfforts.set(String(parsed.batchId), queuedEffort);
        }
        break;
      }

      case "worker.completed": {
        const attempt = Number(parsed.attempt ?? 1);
        const started = workerStarts.get(`${String(parsed.taskId)}:${attempt}`);
        if (stamp !== null && started !== undefined) {
          spans.push({ start: started, end: stamp });
        }
        const record: DelegationRecord = {
          taskId: threadIdOf(parsed.taskId),
          workerThreadId: threadIdOf(parsed.threadId),
          model: String(parsed.model ?? "gpt-5.6-luna"),
          effort: String(parsed.effort ?? ""),
          verdict: String(parsed.verdict ?? ""),
          attempt,
          recoveryClassification:
            typeof parsed.recoveryClassification === "string"
              ? parsed.recoveryClassification
              : undefined,
          recoveryEvidence:
            typeof parsed.recoveryEvidence === "string"
              ? parsed.recoveryEvidence
              : undefined,
          durationSeconds: optionalSeconds(parsed.durationSeconds),
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
        };
        delegations.push(record);
        if (singleBatchIds.has(String(parsed.batchId))) {
          singleCompletions.push({
            record,
            threadId: threadIdOf(parsed.threadId),
            stamp,
          });
          singleCompletedBatchIds.add(String(parsed.batchId));
        }
        break;
      }

      case "integration.conflict":
        integrationConflicts += 1;
        break;

      default:
        break;
    }
  }

  const sameUsage = (
    left: DelegationRecord["usage"],
    right: DelegationRecord["usage"],
  ): boolean => JSON.stringify(left) === JSON.stringify(right);

  /**
   * Decide whether a legacy row is the second half of a modern pair.
   *
   * A modern `delegate_task` writes one delegation twice: as lifecycle events
   * and as the legacy typeless record. Thread identity links those two exactly,
   * and both representations have always carried it, so it is preferred over
   * comparing attributes that two distinct delegations can legitimately share.
   *
   * The attribute comparison survives only as a fallback for a pair where
   * neither side recorded a thread — a worker that died before its thread
   * started. It additionally requires the legacy row not to predate the
   * completion, because the writer always appends it afterwards; without that,
   * a genuinely separate historical delegation that happened to share effort,
   * verdict, duration and usage could be silently dropped.
   *
   * Only single-mode completions are ever candidates, so typed batch telemetry
   * is never mistaken for a duplicate of a legacy single.
   */
  const claimsSingleCompletion = (legacy: ReconcilableRow): boolean => {
    if (legacy.threadId !== null) {
      const byThread = singleCompletions.findIndex(
        (candidate) => candidate.threadId === legacy.threadId,
      );
      if (byThread < 0) return false;
      singleCompletions.splice(byThread, 1);
      return true;
    }

    const byAttributes = singleCompletions.findIndex(
      (candidate) =>
        candidate.threadId === null &&
        candidate.record.effort === legacy.record.effort &&
        candidate.record.verdict === legacy.record.verdict &&
        candidate.record.durationSeconds === legacy.record.durationSeconds &&
        sameUsage(candidate.record.usage, legacy.record.usage) &&
        (candidate.stamp === null ||
          legacy.stamp === null ||
          legacy.stamp >= candidate.stamp),
    );
    if (byAttributes < 0) return false;
    singleCompletions.splice(byAttributes, 1);
    return true;
  };

  // Single-mode batches whose worker never reported a completion — cancelled
  // before it finished, for instance. That delegation survives only as its
  // legacy row, but `task.queued` already counted the effort, so counting it
  // again from the row would double-count one modern delegation.
  const effortsAlreadyCounted = [...singleQueuedEfforts.entries()]
    .filter(([batchId]) => !singleCompletedBatchIds.has(batchId))
    .map(([, effort]) => effort);

  for (const legacy of legacyRows) {
    if (claimsSingleCompletion(legacy)) continue;

    delegations.push(legacy.record);
    const counted = effortsAlreadyCounted.indexOf(legacy.record.effort);
    if (counted >= 0) {
      effortsAlreadyCounted.splice(counted, 1);
      continue;
    }
    efforts.push(legacy.record.effort);
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
  task: V2BenchTask | V3BenchTask,
  arm: Arm,
  repetition: number,
  eventsFile: string,
): Promise<RunRecord> {
  const workspace = await materialize(task);
  const runId = crypto.randomUUID();
  const fixtureRevision = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        id: task.id,
        objective: task.objective,
        files: task.files,
        immutable: task.immutable,
        grade: task.grade.map(({ args, label }) => ({ args, label })),
        mutation: task.mutation
          ? {
              file: task.mutation.file,
              content: task.mutation.content,
              command: {
                args: task.mutation.command.args,
                label: task.mutation.command.label,
              },
            }
          : null,
      }),
    )
    .digest("hex");
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
    ? Math.min(Math.max(task.streams ?? 1, 1), 8)
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
    modelReasoningEffort: "medium",
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
  const creditAccounting = buildRunCreditAccounting({
    supervisorUsage,
    supervisorEffort: armSpec.effort,
    delegations: telemetry.delegations,
  });

  await fs.promises
    .rm(workspace, { recursive: true, force: true, maxRetries: 3 })
    .catch(() => undefined);

  return {
    benchmarkVersion: suite === "v3" ? 3 : 2,
    suite,
    taskId: task.id,
    taskCategory: task.category,
    workloadClass: task.workloadClass,
    ...(suite === "v3" ? { routingCategory: (task as V3BenchTask).routingCategory } : {}),
    ...(suite === "v3" ? { runId, fixtureRevision } : {}),
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
    creditAccounting,
  };
}

export function parseArgs(argv: string[]): {
  reps: number;
  suite: SuiteName;
  tasks: string[];
  arms: Arm[];
  campaignId: string | undefined;
  standardSpeedConfirmed: boolean;
  pricingProfileConfirmed: boolean;
  resume: boolean;
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

  const suite = (get("--suite") ?? "v2") as SuiteName;
  const arms = list(get("--arms")) as Arm[];

  return {
    reps: Number(get("--reps") ?? 2),
    suite,
    campaignId: get("--campaign"),
    standardSpeedConfirmed: argv.includes("--confirm-standard-speed"),
    pricingProfileConfirmed: argv.includes("--confirm-pricing-profile"),
    resume: argv.includes("--resume"),
    tasks: list(get("--tasks")),
    arms: arms.length > 0 ? arms : ["solo-medium", "adaptive-medium"],
  };
}

async function main(): Promise<void> {
  const {
    reps,
    suite,
    tasks: taskIds,
    arms,
    campaignId: requestedCampaignId,
    standardSpeedConfirmed,
    pricingProfileConfirmed,
    resume,
  } = parseArgs(process.argv.slice(2));

  assertStandardSpeedConfirmed(standardSpeedConfirmed);
  if (suite === "v3") {
    assertV3PricingProfileConfirmed(pricingProfileConfirmed);
    assertV3CampaignPolicy({ reps, arms, resume });
  }

  const available = SUITES[suite];
  if (!available) {
    console.error(
      `Unknown suite "${suite}". Available: ${Object.keys(SUITES).join(", ")}`,
    );
    process.exit(1);
  }
  const selectedTaskIds =
    taskIds.length === 0 && arms.length === 1 && arms[0] === "forced-delegation"
      ? [...FORCED_CAMPAIGN_TASK_IDS]
      : taskIds;
  const tasks =
    selectedTaskIds.length === 0
      ? [...available]
      : available.filter((task) => selectedTaskIds.includes(task.id));
  if (tasks.length === 0) {
    console.error(
      `No matching tasks in ${suite}: ${available.map((t) => t.id).join(", ")}`,
    );
    process.exit(1);
  }
  const unknownArms = arms.filter((arm) => !Object.hasOwn(ARMS, arm));
  if (unknownArms.length > 0) {
    throw new Error(`Unknown arm(s): ${unknownArms.join(", ")}`);
  }
  if (suite === "v2" && arms.includes("forced-delegation")) {
    const invalid = (tasks as V2BenchTask[]).filter(
      (task) => task.forcedDelegation.mode === "none",
    );
    if (invalid.length > 0) {
      throw new Error(
        `Forced delegation is not appropriate for: ${invalid.map((task) => task.id).join(", ")}`,
      );
    }
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const campaignId = requestedCampaignId ?? stamp;
  const plannedCells: CampaignCell[] = [];
  for (let repetition = 1; repetition <= reps; repetition += 1) {
    for (const task of tasks) {
      for (const arm of arms) {
        plannedCells.push({ campaignId, taskId: task.id, arm, repetition });
      }
    }
  }
  const existingShards = readCampaignShards(RESULTS_DIR, campaignId);
  assertCampaignCompatibility(existingShards, currentCampaignCompatibility(suite));
  const completedCells = collectCompletedCampaignCells(existingShards, campaignId);
  const plan = planCampaignCells({
    planned: plannedCells,
    completed: completedCells,
    resume,
  });

  console.log(`Campaign: ${campaignId}`);
  console.log(`Planned cells: ${plan.planned.length}`);
  console.log(`Already completed: ${plan.completed.length}`);
  console.log(`Remaining: ${plan.remaining.length}`);
  console.log(`Resume mode: ${plan.resume ? "yes" : "no"}`);
  if (plan.remaining.length === 0) {
    console.log("All requested cells are already complete; no model calls are needed.");
    return;
  }

  const eventsFile = path.join(RESULTS_DIR, `${stamp}.events.jsonl`);
  const resultsFile = path.join(RESULTS_DIR, `${stamp}.${suite}.json`);
  if (fs.existsSync(resultsFile)) {
    throw new Error(`Refusing to overwrite existing result shard ${resultsFile}`);
  }

  const total = plan.remaining.length;
  console.log(`Suite: ${suite} | executing ${total} missing run(s)`);
  console.log(`Supervisor model: ${SUPERVISOR_MODEL}`);
  console.log("Codex speed: standard (Fast mode disabled; operator confirmed)");
  console.log(`Results: ${resultsFile}\n`);

  const records: RunRecord[] = [];
  let index = 0;

  for (const cell of plan.remaining) {
    const task = tasks.find((candidate) => candidate.id === cell.taskId)!;
    const arm = cell.arm as Arm;
    index += 1;
    process.stdout.write(
      `[${index}/${total}] ${task.id} / ${arm} / rep ${cell.repetition} ... `,
    );
    const record = await runArm(suite, task, arm, cell.repetition, eventsFile);
    records.push(record);

    const detail =
      record.workerCount > 0
        ? ` (${record.workerCount} worker(s): ${record.workerEfforts.join(", ") || "?"})`
        : "";
    console.log(
      `${record.passed ? "PASS" : "FAIL"} in ${record.durationSeconds}s${detail}`,
    );

    checkpointResultsShard(
      resultsFile,
      buildResultsSnapshot({
        startedAt: stamp,
        campaignId,
        reps,
        records,
        standardSpeedConfirmed: true,
        suite,
        pricingProfileConfirmed,
      }),
    );
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
