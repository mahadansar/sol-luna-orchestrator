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
import type { Arm, RunRecord, SuiteName } from "./run.js";

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
    "| Arm | Sol effort | Runs | Passed | Delegated | Median wall-clock | Median output tokens | Median input tokens | Median workers |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");

  for (const arm of armsPresent) {
    const records = data.records.filter((record) => record.arm === arm);
    if (records.length === 0) continue;
    const stats = summarize(records);
    // How often the supervisor actually delegated. In the non-mandated arms it
    // sometimes decides the work is not worth handing off, which makes the arm
    // measure something other than delegation — worth stating, not hiding.
    const delegated = records.filter((record) => (record.workerCount ?? 0) > 0).length;

    lines.push(
      `| ${labelFor(arm)} | ${records[0]!.supervisorEffort ?? "-"} | ${stats.runs} | ` +
        `${stats.passed}/${stats.runs} | ${delegated}/${stats.runs} | ` +
        `${round(median(stats.durations))}s | ` +
        `${round(median(stats.totalOutput))} | ${round(median(stats.totalInput))} | ` +
        `${round(median(stats.workerCounts))} |`,
    );
  }
  lines.push("");

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

  lines.push("## Measurement notes");
  lines.push("");
  lines.push(
    "- Wall-clock is measured by the harness around the whole supervisor turn, so " +
      "it includes delegation and integration overhead.",
  );
  lines.push(
    "- Supervisor tokens come from the Codex SDK's `turn.completed` event. Worker " +
      "tokens come from the orchestrator's own delegation telemetry.",
  );
  lines.push(
    "- For batch (`delegate_tasks`) runs only worker OUTPUT tokens are recorded, so " +
      "the input-token column understates the orchestrated arms. It is reported as " +
      "measured rather than estimated.",
  );
  lines.push(
    "- Pass/fail is decided by the harness after the agent stops: task checks must " +
      "exit 0 and files marked immutable must be byte-identical. The agent never " +
      "grades itself.",
  );
  lines.push(
    "- **Cost in currency is not measurable here.** The API exposes token counts, " +
      "not prices, and the arms use different models at different efforts.",
  );
  lines.push(
    "- Sample sizes are small. Treat these as directional, not statistically " +
      "significant.",
  );

  const report = lines.join("\n");
  console.log(report);

  const outputPath = file.replace(/\.json$/, ".md");
  fs.writeFileSync(outputPath, `${report}\n`, "utf8");
  console.error(`\nWrote ${outputPath}`);
}

main();
