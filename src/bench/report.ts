/**
 * Summarise raw benchmark records into a human-readable report.
 *
 * Reports only what was measured. Anything the integration cannot observe is
 * stated as not measurable rather than estimated. Interpretation is kept out of
 * the generated tables entirely — it belongs in `bench/RESULTS.md`, written by a
 * human who can be held to it.
 *
 * Usage: node dist/bench/report.js [results.json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Arm, Breakdown, RunRecord, SuiteName } from "./run.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(HERE, "..", "..", "bench", "results");

interface ResultsFile {
  schema: number;
  suite?: SuiteName;
  supervisorModel: string;
  supervisorEffort?: string;
  startedAt: string;
  platform: string;
  nodeVersion: string;
  reps: number;
  records: RunRecord[];
}

const median = (values: number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const round = (value: number): string =>
  Number.isNaN(value) ? "-" : String(Math.round(value));

interface ArmSummary {
  runs: number;
  passed: number;
  durations: number[];
  supervisorOutput: number[];
  workerOutput: number[];
  totalOutput: number[];
  totalInput: number[];
  workerCounts: number[];
  efforts: string[];
  conflicts: number;
}

function summarize(records: RunRecord[]): ArmSummary {
  return {
    runs: records.length,
    passed: records.filter((record) => record.passed).length,
    durations: records.map((record) => record.durationSeconds),
    supervisorOutput: records.map((record) => record.supervisorUsage?.outputTokens ?? 0),
    workerOutput: records.map((record) =>
      sum(record.delegations.map((delegation) => delegation.usage?.outputTokens ?? 0)),
    ),
    totalOutput: records.map(
      (record) =>
        (record.supervisorUsage?.outputTokens ?? 0) +
        sum(record.delegations.map((delegation) => delegation.usage?.outputTokens ?? 0)),
    ),
    totalInput: records.map(
      (record) =>
        (record.supervisorUsage?.inputTokens ?? 0) +
        sum(record.delegations.map((delegation) => delegation.usage?.inputTokens ?? 0)),
    ),
    workerCounts: records.map((record) => record.workerCount ?? 0),
    efforts: records.flatMap((record) => record.workerEfforts ?? []),
    conflicts: sum(records.map((record) => record.integrationConflicts ?? 0)),
  };
}

function findLatestResults(): string {
  const files = fs
    .readdirSync(RESULTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const latest = files.at(-1);
  if (!latest) throw new Error(`No results found in ${RESULTS_DIR}`);
  return path.join(RESULTS_DIR, latest);
}

function main(): void {
  const argv = process.argv.slice(2);
  const explicit = argv.find((arg) => !arg.startsWith("--"));
  const file = explicit ? path.resolve(explicit) : findLatestResults();
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as ResultsFile;

  // Arm order is fixed so tables stay comparable between runs.
  const armOrder = [
    "solo-high",
    "solo-xhigh",
    "adaptive",
    "seq",
    "par",
    "seq-forced",
    "par-forced",
    "solo",
    "orchestrated",
  ];
  const armsPresent = [
    ...new Set(data.records.map((record) => record.arm as string)),
  ].sort((a, b) => armOrder.indexOf(a) - armOrder.indexOf(b));

  const labelFor = (arm: string): string =>
    data.records.find((record) => record.arm === arm)?.armLabel ?? arm;

  const lines: string[] = [];
  lines.push("# Benchmark results");
  lines.push("");
  lines.push(`Source: \`${path.basename(file)}\``);
  lines.push(
    `Suite: ${data.suite ?? "micro"} | supervisor \`${data.supervisorModel}\` | ` +
      `${data.reps} repetition(s) per cell | Node ${data.nodeVersion} on ${data.platform}`,
  );
  lines.push("");

  lines.push("## Overall");
  lines.push("");
  lines.push(
    "| Arm | Sol effort | Runs | Passed | Delegated | Median wall-clock | Range | Median output tokens | Median input tokens | Median workers | Peak concurrency |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");

  for (const arm of armsPresent) {
    const records = data.records.filter((record) => record.arm === arm);
    if (records.length === 0) continue;
    const stats = summarize(records);
    // How often the supervisor actually delegated. In the non-mandated arms it
    // sometimes decides the work is not worth handing off, which makes the arm
    // measure something other than delegation — worth stating, not hiding.
    const delegated = records.filter((record) => (record.workerCount ?? 0) > 0).length;
    const peaks = records
      .map((record) => record.breakdown?.peakConcurrency)
      .filter((value): value is number => typeof value === "number");

    lines.push(
      `| ${labelFor(arm)} | ${records[0]!.supervisorEffort ?? "-"} | ${stats.runs} | ` +
        `${stats.passed}/${stats.runs} | ${delegated}/${stats.runs} | ` +
        `${round(median(stats.durations))}s | ` +
        `${Math.min(...stats.durations)}-${Math.max(...stats.durations)}s | ` +
        `${round(median(stats.totalOutput))} | ${round(median(stats.totalInput))} | ` +
        `${round(median(stats.workerCounts))} | ` +
        `${peaks.length > 0 ? round(median(peaks)) : "n/a"} |`,
    );
  }
  lines.push("");

  // --- Where the wall-clock went -------------------------------------------
  const withBreakdown = data.records.filter(
    (record) =>
      record.breakdown?.workerWindowSeconds !== null &&
      record.breakdown?.workerWindowSeconds !== undefined,
  );
  if (withBreakdown.length > 0) {
    lines.push("## Where orchestrated time went");
    lines.push("");
    lines.push(
      "| Task | Arm | Rep | Total | Sol before | Worktree setup | Worker window | Slowest worker | Integration | Sol after | Peak |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
    const cell = (value: number | null | undefined): string =>
      value === null || value === undefined ? "unknown" : `${value}s`;
    for (const record of withBreakdown) {
      const b: Breakdown = record.breakdown;
      lines.push(
        `| ${record.taskId} | ${record.arm} | ${record.repetition} | ${record.durationSeconds}s | ` +
          `${cell(b.supervisorBeforeSeconds)} | ${cell(b.worktreeSetupSeconds)} | ` +
          `${cell(b.workerWindowSeconds)} | ${cell(b.slowestWorkerSeconds)} | ` +
          `${cell(b.integrationSeconds)} | ${cell(b.supervisorAfterSeconds)} | ` +
          `${b.peakConcurrency ?? "unknown"} |`,
      );
    }
    lines.push("");
  }

  // --- How the parent waited, and whether the run is comparable -------------
  //
  // Kept separate from the wall-clock breakdown above because it answers a
  // different question: that table says where the run's time went, this one says
  // how much of the *parent's* cost was the supervisor waking itself up while a
  // single delegation call was outstanding. Reported, never netted off.
  // A free-choice run that stayed solo has a rollout but nothing to wait for, so
  // it is not a row here. It is still counted as delegating-or-not elsewhere.
  const waited = data.records.filter(
    (record) => record.parentWait && record.comparability?.delegated,
  );
  if (waited.length > 0) {
    lines.push("## How the parent waited");
    lines.push("");
    lines.push(
      "| Task | Arm | Rep | Cell yield | Waits | Poll turns | Blocked | Active | " +
        "Wait-turn input | Total input | Ingested/canonical | Protocol | Parent cost comparable |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const record of waited) {
      const wait = record.parentWait!;
      const batch = record.mcpCalls.find((call) => call.tool === "delegate_tasks");
      const secs = (value: number | null): string =>
        value === null ? "unknown" : `${value}s`;
      lines.push(
        `| ${record.taskId} | ${record.arm} | ${record.repetition} | ` +
          `${wait.pragma?.yieldTimeMs ?? "unset"} | ${wait.waitTurns} | ` +
          `${secs(wait.seconds.waitTurns)} | ${secs(wait.seconds.blockedOnDelegation)} | ` +
          `${secs(wait.seconds.supervisorActive)} | ${wait.usage.wait.inputTokens} | ` +
          `${wait.usage.total.inputTokens} | ` +
          `${wait.resultIngestChars ?? "unknown"}/${batch?.canonicalChars ?? "unknown"} | ` +
          `${record.comparability.waitProtocolCompliant ? "followed" : "**broken**"} | ` +
          `${record.comparability.parentCostComparable ? "yes" : "**NO**"} |`,
      );
    }
    lines.push("");

    // Two lists, because the two verdicts call for different responses: a broken
    // protocol is the supervisor to look at, while a compliant run that still
    // polled is the runtime clamping a yield it was given.
    const offProtocol = data.records.filter(
      (record) => record.comparability && !record.comparability.waitProtocolCompliant,
    );
    if (offProtocol.length > 0) {
      lines.push("Runs that did not follow the waiting protocol:");
      lines.push("");
      for (const record of offProtocol) {
        lines.push(
          `- \`${record.taskId}\` / ${record.arm} / rep ${record.repetition}: ` +
            record.comparability.protocolViolations.join("; "),
        );
      }
      lines.push("");
    }

    const flagged = data.records.filter(
      (record) => record.comparability && !record.comparability.parentCostComparable,
    );
    if (flagged.length > 0) {
      lines.push("Runs whose parent cost is not comparable, and why:");
      lines.push("");
      for (const record of flagged) {
        lines.push(
          `- \`${record.taskId}\` / ${record.arm} / rep ${record.repetition}: ` +
            record.comparability.reasons.join("; "),
        );
      }
      lines.push("");
    }

    const overridden = waited.filter(
      (record) => record.comparability.canonicalProtocol === false,
    );
    if (overridden.length > 0) {
      lines.push(
        `**${overridden.length} run(s) ran under an overridden waiting protocol** ` +
          `(\`BENCH_WAIT_YIELD_MS\` / \`BENCH_WAIT_OUTPUT_TOKENS\`). Those are probes ` +
          `of the mechanism, not members of the study, and none of their parent ` +
          `costs may be compared with a canonical run.`,
      );
      lines.push("");
    }
  }

  lines.push("## By task");
  lines.push("");
  lines.push(
    "| Task | Arm | Passed | Median wall-clock | Workers | Efforts chosen | Conflicts |",
  );
  lines.push("|---|---|---|---|---|---|---|");

  for (const taskId of [...new Set(data.records.map((record) => record.taskId))]) {
    for (const arm of armsPresent) {
      const records = data.records.filter(
        (record) => record.taskId === taskId && record.arm === arm,
      );
      if (records.length === 0) continue;
      const stats = summarize(records);
      const efforts =
        stats.efforts.length > 0 ? [...new Set(stats.efforts)].join(", ") : "-";
      lines.push(
        `| ${taskId} | ${arm} | ${stats.passed}/${stats.runs} | ` +
          `${round(median(stats.durations))}s | ${round(median(stats.workerCounts))} | ` +
          `${efforts} | ${stats.conflicts} |`,
      );
    }
  }
  lines.push("");

  const failures = data.records.filter((record) => !record.passed);
  lines.push("## Failures");
  lines.push("");
  if (failures.length === 0) {
    lines.push("None.");
  } else {
    for (const failure of failures) {
      const reasons: string[] = [];
      for (const grade of failure.grades) {
        if (!grade.passed) reasons.push(`${grade.label} (exit ${grade.exitCode})`);
      }
      if (failure.immutableViolations.length > 0) {
        reasons.push(
          `modified protected file(s): ${failure.immutableViolations.join(", ")}`,
        );
      }
      if (failure.mutationCaught === false) {
        reasons.push("tests did not catch a broken implementation");
      }
      if (failure.agentError) reasons.push(`agent error: ${failure.agentError}`);
      lines.push(
        `- \`${failure.taskId}\` / ${failure.arm} / rep ${failure.repetition}: ` +
          (reasons.join("; ") || "unknown"),
      );
    }
  }
  lines.push("");

  const allEfforts = data.records.flatMap((record) => record.workerEfforts ?? []);
  lines.push("## Worker effort selection");
  lines.push("");
  if (allEfforts.length === 0) {
    lines.push("No delegations recorded.");
  } else {
    const counts = new Map<string, number>();
    for (const effort of allEfforts) counts.set(effort, (counts.get(effort) ?? 0) + 1);
    lines.push("| Effort | Times chosen |");
    lines.push("|---|---|");
    for (const effort of ["medium", "high", "xhigh", "max"]) {
      if (counts.has(effort)) lines.push(`| ${effort} | ${counts.get(effort)} |`);
    }
  }
  lines.push("");

  // --- Per-run usage breakdown ---------------------------------------------
  lines.push("## Usage by run");
  lines.push("");
  lines.push(
    "| Task | Arm | Rep | Wall-clock | Sol in | Sol cached | Sol out | Luna in | Luna out | Workers |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");

  for (const record of data.records) {
    const sol = record.supervisorUsage;
    const lunaIn = sum(
      record.delegations.map((delegation) => delegation.usage?.inputTokens ?? 0),
    );
    const lunaOut = sum(
      record.delegations.map((delegation) => delegation.usage?.outputTokens ?? 0),
    );
    const cell = (value: number | undefined): string =>
      value === undefined ? "n/a" : String(value);

    lines.push(
      `| ${record.taskId} | ${record.arm} | ${record.repetition} | ` +
        `${record.durationSeconds}s | ${cell(sol?.inputTokens)} | ` +
        `${cell(sol?.cachedInputTokens)} | ${cell(sol?.outputTokens)} | ` +
        `${lunaIn || "-"} | ${lunaOut || "-"} | ${record.workerCount ?? 0} |`,
    );
  }
  lines.push("");

  lines.push("## Measurement notes");
  lines.push("");
  lines.push(
    "- Wall-clock is measured by the harness around the whole supervisor turn, so " +
      "it includes delegation and integration overhead.",
  );
  lines.push(
    "- All token counts come from the Codex SDK's `turn.completed` event: the " +
      "supervisor's directly, each worker's via the orchestrator's telemetry. " +
      "Input, cached input, output and reasoning tokens are recorded for both.",
  );
  lines.push(
    "- Rows showing `n/a` had no usage reported for that turn (a cancelled or " +
      "failed run). Runs recorded before v0.4.0 captured worker output tokens " +
      "only, so their Luna input column reads `-`.",
  );
  lines.push(
    "- Pass/fail is decided by the harness after the agent stops: task checks must " +
      "exit 0 and files marked immutable must be byte-identical. The agent never " +
      "grades itself.",
  );
  lines.push(
    "- **Cost in currency is not reported.** Token counts are measured; prices are " +
      "not exposed by the API, and these models are used through a Codex " +
      "subscription whose billing is not a function of token counts. Multiplying " +
      "these numbers by a price list would produce a figure that looks precise and " +
      "means nothing.",
  );
  lines.push(
    "- Sample sizes are small. Treat these as directional, not statistically " +
      "significant.",
  );
  lines.push(
    "- `Peak concurrency` is the highest number of workers alive at one instant, " +
      "computed from worker start and completion timestamps rather than assumed " +
      "from the worker count.",
  );
  lines.push(
    "- Orchestrated arms are given `SOL_LUNA_MAX_PARALLEL` equal to the fixture's " +
      "independent stream count, which is above the shipped default of 3. That " +
      "value is recorded per run as `maxParallelConfigured`. The solo arms have " +
      "no workers, so the setting does not affect them.",
  );
  lines.push(
    "- Delegating arms wait for the delegation call under one fixed protocol: a " +
      "single code cell with a stated `yield_time_ms` and output budget, resumed " +
      "only by `wait` calls carrying the same numbers, with nothing else done " +
      "until the result arrives. This exists because the supervisor otherwise " +
      "picks the poll interval itself, and a width-6 run that polled 4 times is " +
      "not comparable with a width-12 run that polled 34. What actually happened " +
      "is recorded per run as `parentWait`, and a run that broke the protocol is " +
      "flagged rather than adjusted.",
  );
  lines.push(
    "- **Following the protocol and being comparable are two verdicts.** " +
      "`comparability.waitProtocolCompliant` says the supervisor did what it was " +
      "asked. `comparability.parentCostComparable` additionally requires that " +
      "**no `wait` turn happened at all** — the behaviour being approximated is " +
      "one blocking call and one complete result, with no supervisor inference in " +
      "between, so a clamped yield that forces even one compliant poll leaves the " +
      "run reportable but not comparable. It also requires exactly one " +
      '`delegate_tasks` call, `resultDetail: "compact"`, the canonical result ' +
      "consumed exactly once, full ingestion proven against what the server " +
      "returned, and the canonical protocol in force.",
  );
  lines.push(
    "- `comparability.canonicalProtocol` is false when `BENCH_WAIT_YIELD_MS` or " +
      "`BENCH_WAIT_OUTPUT_TOKENS` changed the protocol. Such a run is a probe of " +
      "the mechanism and is never parent-cost comparable with the study, however " +
      "well it complied.",
  );
  lines.push(
    "- `Wait-turn input` is the input tokens of the inferences that produced a " +
      "`wait`, i.e. the cost of polling. It is reported beside the total and " +
      "never subtracted from it: the total is what the run cost.",
  );
  lines.push(
    "- `Blocked` is time the parent spent inside the delegation call — real worker " +
      "latency. `Active` is time it spent being sampled. `Poll turns` is the part " +
      "of `Active` that went on issuing waits, which is the only part a directly " +
      "exposed tool would not have.",
  );
  lines.push(
    "- Delegating arms are told to read a tool result as both of the surfaces the " +
      "server returns — the `content` text, then `structuredContent` — so parent " +
      "cost is comparable between arms and between fixture widths. What actually " +
      "crossed the boundary is recorded per run as `mcpCalls[].canonicalChars`; a " +
      "parent cost out of proportion to it means that run was not read the " +
      "canonical way and is not comparable.",
  );

  const report = lines.join("\n");
  console.log(report);

  const outputPath = file.replace(/\.json$/, ".md");
  fs.writeFileSync(outputPath, `${report}\n`, "utf8");
  console.error(`\nWrote ${outputPath}`);
}

main();
