/** Generate a correctness -> credits -> latency Benchmark V2 report. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_V2_PRICING_PROFILE,
  type BenchmarkUsage,
  type CreditPricingProfile,
} from "./credits.js";
import {
  compareWithBaseline,
  groupCells,
  recommendThirdRepetition,
  type CellSummary,
} from "./analysis.js";
import {
  buildRunCreditAccounting,
  type BenchmarkResultsSnapshot,
  type ParticipantAccounting,
  type RunRecord,
} from "./run.js";
import {
  analyzeV3,
  recommendV3ThirdRepetition,
  type V3EvaluatorMetadata,
} from "./v3-analysis.js";
import { V3_TASKS } from "./v3-tasks.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(HERE, "..", "..", "bench", "results");

export interface ResultsFile {
  schema?: number;
  benchmarkVersion?: number;
  suite?: string;
  supervisorModel?: string;
  supervisorEffort?: string;
  executionProfile?: BenchmarkResultsSnapshot["executionProfile"];
  startedAt?: string;
  platform?: string;
  nodeVersion?: string;
  reps?: number;
  pricingProfile?: CreditPricingProfile;
  campaignId?: string;
  holdoutFreezeSha?: string;
  productionBaseline?: { version: string; sha: string };
  environment?: BenchmarkResultsSnapshot["environment"];
  ordering?: BenchmarkResultsSnapshot["ordering"];
  methodologyDigest?: string;
  retryPolicy?: BenchmarkResultsSnapshot["retryPolicy"];
  records: RunRecord[];
}

/** Old worker rows with output-only data used zero sentinels for unknown fields. */
export const legacyIncompleteUsage = (
  usage: BenchmarkUsage | null | undefined,
): boolean =>
  usage !== null &&
  usage !== undefined &&
  usage.inputTokens === 0 &&
  usage.cachedInputTokens === 0 &&
  (usage.reasoningOutputTokens ?? 0) === 0 &&
  usage.outputTokens > 0;

/** Explicit opt-in repricing for old immutable JSON; the source file is never changed. */
export function repriceHistoricalRecord(
  record: RunRecord,
  profile: CreditPricingProfile = BENCHMARK_V2_PRICING_PROFILE,
): RunRecord {
  if (record.creditAccounting) return record;
  const delegations = (record.delegations ?? []).map((delegation) => ({
    ...delegation,
    usage: legacyIncompleteUsage(delegation.usage) ? null : delegation.usage,
  }));
  return {
    ...record,
    creditAccounting: buildRunCreditAccounting({
      supervisorUsage: record.supervisorUsage,
      supervisorEffort: record.supervisorEffort,
      delegations,
      pricingProfile: profile,
    }),
  };
}

const number = (value: number | null, suffix = ""): string =>
  value === null ? "unknown" : `${Math.round(value * 100) / 100}${suffix}`;
const percent = (value: number | null): string =>
  value === null ? "unknown" : `${value >= 0 ? "+" : ""}${Math.round(value)}%`;

function baselineFor(cells: readonly CellSummary[], taskId: string): CellSummary | null {
  return (
    cells.find((cell) => cell.taskId === taskId && cell.arm === "solo-medium") ?? null
  );
}

const participantLabel = (participant: ParticipantAccounting): string => {
  if (participant.role === "supervisor") return "Supervisor";
  const identifiers = [
    participant.taskId ? `task ${participant.taskId}` : null,
    participant.workerThreadId ? `thread ${participant.workerThreadId}` : null,
  ].filter((value): value is string => value !== null);
  return identifiers.length > 0
    ? `Worker (${identifiers.join(", ")})`
    : "Worker (identifier unavailable)";
};

export function renderReport(
  input: ResultsFile,
  options: { repriceHistorical?: boolean; sourceName?: string } = {},
): string {
  const isV2 = input.benchmarkVersion === 2;
  const isV3 = input.benchmarkVersion === 3;
  const isVersioned = isV2 || isV3;
  const records = options.repriceHistorical
    ? input.records.map((record) => repriceHistoricalRecord(record))
    : input.records;
  const cells = groupCells(records);
  const profile =
    input.pricingProfile ??
    (options.repriceHistorical ? BENCHMARK_V2_PRICING_PROFILE : undefined);
  const lines: string[] = ["# Benchmark results", ""];
  if (options.sourceName) lines.push(`Source: \`${options.sourceName}\``, "");
  lines.push(
    `Schema: ${input.schema ?? "historical"} | suite: ${input.suite ?? "historical"} | ` +
      `campaign: ${input.campaignId ?? "historical"} | supervisor: ` +
      `\`${input.supervisorModel ?? "unknown"}\` / ${input.supervisorEffort ?? "historical"}`,
    "",
  );
  if (isV3) {
    lines.push(
      `Holdout freeze: \`${input.holdoutFreezeSha ?? "unknown"}\` | production baseline: ` +
        `\`${input.productionBaseline ? `${input.productionBaseline.version}@${input.productionBaseline.sha}` : "unknown"}\``,
      "",
    );
  }
  if (input.executionProfile) {
    const execution = input.executionProfile;
    lines.push(
      `Codex speed: ${execution.speedMode} (Fast mode disabled: ${execution.fastModeDisabled ? "yes" : "no"}; ` +
        `service tier: ${execution.serviceTier ?? "unavailable"} (${execution.serviceTierStatus}); ` +
        `SDK pinning: ${execution.sdkSpeedPinningSupported ? "supported" : "unsupported"}; enforcement: ${execution.enforcement}).`,
      "",
    );
  } else if (isVersioned) {
    lines.push("Codex speed: unknown (execution profile missing).", "");
  }
  if (profile) {
    lines.push(
      `Credit profile: \`${profile.profileId}\` (snapshot ${profile.snapshotDate}; ` +
        `[official rate card](${profile.sourceUrl})).`,
      "",
    );
  } else {
    lines.push(
      "Credit profile: unknown. Historical rows are not silently repriced; pass `--reprice-current` for an explicitly labelled V2-profile estimate.",
      "",
    );
  }
  if (!isV2 && options.repriceHistorical) {
    lines.push(
      "> Historical backfill: credits below are estimates under the displayed V2 snapshot, not actual billed credits and not the rate necessarily applicable when the run occurred.",
      "",
    );
  }

  lines.push("## Reproducibility", "");
  const environment = input.environment;
  if (environment) {
    lines.push(
      `- Commit: \`${environment.git.commit ?? "unknown"}\` on branch \`${environment.git.branch ?? "unknown"}\`` +
        ` (${
          environment.git.workingTreeClean === null
            ? "working tree unknown"
            : environment.git.workingTreeClean
              ? "clean working tree"
              : `${environment.git.dirtyPathCount ?? "unknown"} dirty path(s)`
        }; describe \`${environment.git.describe ?? "unknown"}\`)`,
      `- Runtime: Node ${environment.runtime.nodeVersion ?? "unknown"} on ${environment.runtime.platform ?? "unknown"} ${environment.runtime.arch ?? ""}`.trimEnd() +
        ` (release ${environment.runtime.osRelease ?? "unknown"}, ${number(environment.runtime.cpuCount)} CPU(s), timezone ${environment.runtime.timezone ?? "unknown"})`,
      `- Toolchain: package ${environment.toolchain.packageVersion ?? "unknown"}, npm ${environment.toolchain.npmVersion ?? "unknown"}, Codex CLI ${environment.toolchain.codexCliVersion ?? "unknown"}, Codex SDK ${environment.toolchain.codexSdkVersion ?? "unknown"}`,
      `- Invocation: \`${environment.invocation.argv.join(" ") || "(none)"}\` in \`${environment.invocation.cwd ?? "unknown"}\``,
      `- Recorded environment overrides: ${
        Object.keys(environment.environment).length === 0
          ? "none"
          : Object.entries(environment.environment)
              .map(([key, value]) => `\`${key}=${value}\``)
              .join(", ")
      }`,
    );
  } else {
    lines.push("- Environment: unknown (this shard predates reproducibility capture).");
  }
  lines.push(
    `- Execution ordering: ${
      input.ordering
        ? `${input.ordering.mode}${input.ordering.seed === null ? "" : ` (seed \`${input.ordering.seed}\`)`}, ${input.ordering.sequence.length} planned cell(s) fixed before execution`
        : "unknown"
    }`,
    `- Methodology digest: \`${input.methodologyDigest ?? "unknown"}\``,
    `- Retry treatment: ${
      input.retryPolicy
        ? `${input.retryPolicy.automaticRunRetries} automatic run retries; quarantined cells re-run only as ${input.retryPolicy.quarantinedCellReexecution}`
        : "unknown"
    }`,
    "",
  );

  const quarantined = records.filter(
    (record) => record.validity?.status === "quarantined",
  );
  lines.push("## Run validity", "");
  lines.push(
    `Included in aggregates: ${records.length - quarantined.length} of ${records.length} run(s).`,
    "",
  );
  if (quarantined.length === 0) {
    lines.push("No run met a predeclared exclusion condition.", "");
  } else {
    lines.push(
      "| Task | Strategy | Rep | Run | Exclusion reasons |",
      "|---|---|---:|---|---|",
    );
    for (const record of quarantined) {
      lines.push(
        `| ${record.taskId} | ${record.arm} | ${record.repetition} | \`${record.runId ?? "unknown"}\` | ` +
          `${(record.validity?.reasons ?? []).join(", ")} |`,
      );
    }
    lines.push(
      "",
      "Quarantined runs are retained as evidence and excluded from every aggregate above and below.",
      "",
    );
  }

  lines.push("## Primary comparison", "");
  lines.push(
    "| Task | Strategy | Pass | Credits | Basis | Time | Credit Δ | Time Δ | Trade-off | Delegated | Workers |",
    "|---|---|---:|---:|---|---:|---:|---:|---|---:|---:|",
  );
  const armOrder = ["solo-medium", "adaptive-medium", "forced-delegation"];
  const ordered = [...cells].sort(
    (a, b) =>
      a.taskId.localeCompare(b.taskId) ||
      armOrder.indexOf(a.arm) - armOrder.indexOf(b.arm),
  );
  for (const cell of ordered) {
    const baseline = baselineFor(cells, cell.taskId);
    const comparison =
      baseline && cell.arm !== "solo-medium" ? compareWithBaseline(baseline, cell) : null;
    lines.push(
      `| ${cell.taskId} | ${cell.arm} | ${cell.passed}/${cell.runs} | ` +
        `${number(cell.medianCredits)} | ${cell.creditBasis} | ${number(cell.medianDurationSeconds, "s")} | ` +
        `${comparison ? percent(comparison.creditDeltaPercent) : "baseline"} | ` +
        `${comparison ? percent(comparison.latencyDeltaPercent) : "baseline"} | ` +
        `${comparison?.classification ?? "baseline"} | ` +
        `${Math.round(cell.delegationRate * 100)}% | ${number(cell.medianWorkers)} |`,
    );
  }
  lines.push("");

  lines.push("## Credits by run", "");
  lines.push(
    "| Task | Strategy | Rep | Actual | Rate-card total | Sol | Luna | Profile |",
    "|---|---|---:|---:|---:|---:|---:|---|",
  );
  for (const record of records) {
    const accounting = record.creditAccounting;
    lines.push(
      `| ${record.taskId} | ${record.arm} | ${record.repetition} | ` +
        `${number(accounting?.actualCredits ?? null)} | ` +
        `${number(accounting?.rateCardCredits.total ?? null)} | ` +
        `${number(accounting?.rateCardCredits.sol ?? null)} | ` +
        `${number(accounting?.rateCardCredits.luna ?? null)} | ` +
        `${accounting?.pricingProfileId ?? "unknown"} |`,
    );
  }
  lines.push("");

  lines.push("## Routing and stragglers", "");
  lines.push(
    "| Task | Strategy | Worker counts | Efforts | Peak concurrency | Slowest workers |",
    "|---|---|---|---|---:|---|",
  );
  for (const cell of ordered) {
    const rows = records.filter(
      (record) => record.taskId === cell.taskId && record.arm === cell.arm,
    );
    const slowest = rows.map((record) => record.breakdown?.slowestWorkerSeconds ?? null);
    lines.push(
      `| ${cell.taskId} | ${cell.arm} | ${cell.workerCounts.join(", ")} | ` +
        `${cell.workerEfforts.length ? cell.workerEfforts.join(", ") : "-"} | ` +
        `${number(cell.peakConcurrency)} | ${slowest.map((value) => number(value, "s")).join(", ")} |`,
    );
  }
  lines.push("");

  if (isV3) {
    const evaluatorMetadata = Object.fromEntries(
      V3_TASKS.map((task) => [
        task.id,
        {
          routingCategory: task.routingCategory,
          workloadClass: task.workloadClass,
          coupled: task.workloadClass === "coupled-control",
          control:
            task.routingCategory === "expected-solo" ||
            task.routingCategory === "likely-solo",
          obviousSolo: task.routingCategory === "expected-solo",
          delegationCandidate:
            task.routingCategory === "delegation-candidate" ||
            task.routingCategory === "strong-delegation-candidate",
        } satisfies V3EvaluatorMetadata,
      ]),
    );
    const routing = analyzeV3(records, evaluatorMetadata);
    lines.push("## V3 routing analysis", "");
    lines.push(
      "Evaluator routing categories below are descriptive and never affect correctness.",
      "",
      "| Task | Strategy | Routing category | Delegated | Zero-worker | Worker counts | Stable | Routing changes | Routing outcome | Sol | Luna | Total | End-to-end | Worker window | Slowest worker |",
      "|---|---|---|---:|---:|---|---|---:|---|---:|---:|---:|---:|---:|---:|",
    );
    for (const cell of routing.cells) {
      lines.push(
        `| ${cell.taskId} | ${cell.arm} | ${cell.routingCategory ?? "unknown"} | ` +
          `${number(cell.delegationRate === null ? null : cell.delegationRate * 100, "%")} | ` +
          `${number(cell.zeroWorkerRate === null ? null : cell.zeroWorkerRate * 100, "%")} | ` +
          `${number(cell.workerCounts.min)}-${number(cell.workerCounts.max)} (median ${number(cell.workerCounts.median)}) | ` +
          `${cell.workerCountStable === null ? "unknown" : cell.workerCountStable ? "yes" : "no"} | ` +
          `${number(cell.routingChanges)} | ${cell.routingOutcome} | ` +
          `${number(cell.solCredits.median)} | ${number(cell.lunaCredits.median)} | ${number(cell.totalCredits.median)} | ` +
          `${number(cell.endToEndLatencySeconds.median, "s")} | ${number(cell.workerWindowSeconds.median, "s")} | ` +
          `${number(cell.slowestWorkerSeconds.median, "s")} |`,
      );
    }
    lines.push("", "### Delegation rate by evaluator category", "");
    lines.push(
      "| Routing category | Runs | Delegation rate | Zero-worker rate |",
      "|---|---:|---:|---:|",
    );
    for (const group of routing.byRoutingCategory) {
      lines.push(
        `| ${group.key} | ${group.runs} | ${number(group.delegationRate === null ? null : group.delegationRate * 100, "%")} | ` +
          `${number(group.zeroWorkerRate === null ? null : group.zeroWorkerRate * 100, "%")} |`,
      );
    }
    lines.push("", "### Delegation rate by workload shape", "");
    lines.push(
      "| Workload shape | Runs | Delegation rate | Zero-worker rate |",
      "|---|---:|---:|---:|",
    );
    for (const group of routing.byWorkload) {
      lines.push(
        `| ${group.key} | ${group.runs} | ${number(group.delegationRate === null ? null : group.delegationRate * 100, "%")} | ` +
          `${number(group.zeroWorkerRate === null ? null : group.zeroWorkerRate * 100, "%")} |`,
      );
    }
    lines.push("", "### Routing review flags", "");
    const flag = (label: string, values: readonly string[]): void => {
      lines.push(
        `- ${label}: ${values.length > 0 ? values.map((value) => `\`${value.replace("\0", " / ")}\``).join(", ") : "none"}`,
      );
    };
    flag("Coupled/control tasks delegated", routing.coupledOrControlDelegated);
    flag("Obvious-Solo tasks delegated", routing.obviousSoloDelegated);
    flag("Delegation candidates where Adaptive stayed Solo", routing.adaptiveStayedSolo);
    flag("Cells whose routing changed between repetitions", routing.routingChanges);
    lines.push("", "### Delegation economics", "");
    if (routing.economicComparisons.length === 0) {
      lines.push(
        "No Adaptive cell with observed delegation and a matching Solo cell.",
        "",
      );
    } else {
      lines.push(
        "| Task | Correctness | Credit basis | Solo median | Adaptive median | Interpretation |",
        "|---|---|---|---:|---:|---|",
      );
      for (const comparison of routing.economicComparisons) {
        lines.push(
          `| ${comparison.taskId} | ${comparison.correctness} | ${comparison.creditBasis} | ` +
            `${number(comparison.soloMedianTotalCredits)} | ${number(comparison.adaptiveMedianTotalCredits)} | ${comparison.label} |`,
        );
      }
      lines.push("");
    }
    lines.push("### Operational incidence", "");
    lines.push(
      "| Task | Strategy | Timeout | Recovery | Straggler | Verification failure | Integration conflict |",
      "|---|---|---:|---:|---:|---:|---:|",
    );
    for (const cell of routing.cells) {
      const pct = (value: number | null): string =>
        number(value === null ? null : value * 100, "%");
      lines.push(
        `| ${cell.taskId} | ${cell.arm} | ${pct(cell.timeoutIncidence)} | ${pct(cell.recoveryIncidence)} | ` +
          `${pct(cell.stragglerIncidence)} | ${pct(cell.verificationFailureIncidence)} | ${pct(cell.integrationConflictIncidence)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Participant accounting by run", "");
  lines.push(
    "| Task | Strategy | Rep | Participant | Role | Model / effort | Input | Cached | Output | Reasoning | Cache write | Credits | Worker duration | End-to-end |",
    "|---|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const record of records) {
    const accounting = record.creditAccounting;
    for (const participant of accounting?.participants ?? []) {
      lines.push(
        `| ${record.taskId} | ${record.arm} | ${record.repetition} | ${participantLabel(participant)} | ` +
          `${participant.role} | ${participant.model} / ${participant.effort} | ` +
          `${number(participant.inputTokens)} | ${number(participant.cachedInputTokens)} | ` +
          `${number(participant.outputTokens)} | ${number(participant.reasoningOutputTokens)} | ` +
          `${number(participant.cacheWriteInputTokens)} | ${number(participant.rateCardCredits)} | ` +
          `${number(participant.durationSeconds, "s")} | - |`,
      );
    }
    lines.push(
      `| ${record.taskId} | ${record.arm} | ${record.repetition} | Sol total | total | - | - | - | - | - | - | ` +
        `${number(accounting?.rateCardCredits.sol ?? null)} | - | - |`,
      `| ${record.taskId} | ${record.arm} | ${record.repetition} | Luna total | total | - | - | - | - | - | - | ` +
        `${number(accounting?.rateCardCredits.luna ?? null)} | - | - |`,
      `| ${record.taskId} | ${record.arm} | ${record.repetition} | Run total | total | - | - | - | - | - | - | ` +
        `${number(accounting?.rateCardCredits.total ?? null)} | - | ${number(record.durationSeconds, "s")} |`,
    );
  }
  lines.push("");

  lines.push("## Supervisor overhead by run", "");
  lines.push(
    "| Task | Strategy | Rep | Before | Worktree setup | Worker window | Integration | After | Peak | End-to-end | Termination |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  );
  for (const record of records) {
    const breakdown = record.breakdown;
    lines.push(
      `| ${record.taskId} | ${record.arm} | ${record.repetition} | ` +
        `${number(breakdown?.supervisorBeforeSeconds ?? null, "s")} | ` +
        `${number(breakdown?.worktreeSetupSeconds ?? null, "s")} | ` +
        `${number(breakdown?.workerWindowSeconds ?? null, "s")} | ` +
        `${number(breakdown?.integrationSeconds ?? null, "s")} | ` +
        `${number(breakdown?.supervisorAfterSeconds ?? null, "s")} | ` +
        `${number(breakdown?.peakConcurrency ?? null)} | ` +
        `${number(record.durationSeconds, "s")} | ${record.terminationReason ?? "unknown"} |`,
    );
  }
  lines.push("");

  lines.push("## Orchestration behaviour by run", "");
  lines.push(
    "| Task | Strategy | Rep | Delegation calls | Refused calls | Explorations | Attempts | Repairs | Recoveries | Continuations | Effort escalations | Executor changes | Wasted attempts | Usage unavailable | Scope conflicts |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const record of records) {
    const orchestration = record.orchestration;
    const cell = (value: number | undefined): string =>
      value === undefined ? "unknown" : String(value);
    lines.push(
      `| ${record.taskId} | ${record.arm} | ${record.repetition} | ` +
        `${cell(orchestration?.delegationCalls)} | ` +
        `${cell(orchestration?.delegationCallsRefused)} | ` +
        `${cell(orchestration?.explorations)} | ` +
        `${cell(orchestration?.attemptsCompleted)} | ${cell(orchestration?.repairsCompleted)} | ` +
        `${cell(orchestration?.recoveriesCompleted)} | ${cell(orchestration?.continuations)} | ` +
        `${cell(orchestration?.effortEscalations)} | ${cell(orchestration?.executorChanges)} | ` +
        `${cell(orchestration?.wastedAttempts)} | ${cell(orchestration?.usageUnavailableAttempts)} | ` +
        `${cell(orchestration?.scopeConflicts)} |`,
    );
  }
  lines.push("");

  lines.push("## Context lifecycle by run", "");
  lines.push(
    "| Task | Strategy | Rep | Evaluations | Triggers | Blocks | Compactions | Max size | Max turns | Reclaimed |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const record of records) {
    const context = record.context;
    const cell = (value: number | undefined): string =>
      value === undefined ? "unknown" : String(value);
    lines.push(
      `| ${record.taskId} | ${record.arm} | ${record.repetition} | ` +
        `${cell(context?.evaluations)} | ${cell(context?.triggers)} | ${cell(context?.blocks)} | ` +
        `${cell(context?.compactions)} | ${number(context?.maxTotalSizeBytes ?? null, "B")} | ` +
        `${number(context?.maxTotalTurns ?? null)} | ${number(context?.reclaimedBytes ?? null, "B")} |`,
    );
  }
  lines.push("");

  lines.push("## Third-repetition recommendations", "");
  const recommendations = ordered
    .map((cell) => {
      const rows = records.filter(
        (record) => record.taskId === cell.taskId && record.arm === cell.arm,
      );
      const baseline = records.filter(
        (record) => record.taskId === cell.taskId && record.arm === "solo-medium",
      );
      return isV3
        ? recommendV3ThirdRepetition(rows, baseline)
        : recommendThirdRepetition(rows, baseline);
    })
    .filter((value) => value !== null);
  if (recommendations.length === 0) {
    lines.push("None under the predeclared rules.", "");
  } else {
    for (const recommendation of recommendations) {
      lines.push(
        `- \`${recommendation.taskId}\` / ${recommendation.arm}: ${recommendation.reasons.join("; ")}`,
      );
    }
    lines.push("");
  }

  lines.push("## Measurement notes", "");
  lines.push(
    "- Correctness is determined after the model turn by deterministic grade commands, immutable-file checks, and mutation checks where applicable.",
    "- `rateCardCredits` is calculated from the snapshotted official rate card. `actualCredits` remains null unless an authoritative per-run value becomes available.",
    "- Codex SDK `inputTokens` includes cached input, so cached tokens are removed from the full-rate input portion and charged once at the cached-input rate. Cache writes are uncharged.",
    "- Output tokens already include reasoning output; reasoning tokens are retained as diagnostics and are not charged twice.",
    "- Wall-clock covers the full supervisor turn, including delegation setup, workers, integration, review, and verification.",
    "- Participant worker durations remain individual execution times. They are never summed or substituted for end-to-end wall-clock; supervisor participant duration stays unavailable because the harness does not observe a single authoritative supervisor-only duration.",
    "- Raw tokens, worker effort, concurrency, duration, and straggler fields are supporting diagnostics rather than the headline economic metric.",
    "- Two repetitions are directional evidence. A third is recommended only for the conditions listed above; no statistical significance is claimed.",
    "- Per-run rows are the primary record. Cell medians, ranges, and rates are summaries of those rows and never replace them; failures and quarantined runs stay listed individually.",
    "- Orchestration and context counts are folded from the orchestrator's own event stream. A count of `unknown` means the run predates that field; it is never a zero.",
    "- `wastedAttempts` counts attempts that ended abnormally or left a failing verification behind. It is a diagnostic, not a cost: bounded recovery work is expected behaviour.",
    "- Supervisor overhead columns are derived from event timestamps rather than added instrumentation, so measuring does not change what is measured.",
  );
  return lines.join("\n");
}

function findLatestResults(): string {
  const latest = fs
    .readdirSync(RESULTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .at(-1);
  if (!latest) throw new Error(`No results found in ${RESULTS_DIR}`);
  return path.join(RESULTS_DIR, latest);
}

function main(): void {
  const argv = process.argv.slice(2);
  const explicit = argv.find((argument) => !argument.startsWith("--"));
  const file = explicit ? path.resolve(explicit) : findLatestResults();
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as ResultsFile;
  const report = renderReport(data, {
    repriceHistorical: argv.includes("--reprice-current"),
    sourceName: path.basename(file),
  });
  console.log(report);
  const output = file.replace(/\.json$/, ".md");
  fs.writeFileSync(output, `${report}\n`, "utf8");
  console.error(`\nWrote ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
