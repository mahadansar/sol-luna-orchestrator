import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunRecord, DelegationRecord } from "./run.js";

const SOL_RATES = {
  inputUncached: 125,
  inputCached: 12.5,
  output: 750,
};

const LUNA_RATES = {
  inputUncached: 5,
  inputCached: 0.5,
  output: 30,
};

// Rates are credits per 1M tokens.
function computeTokens(usage: DelegationRecord["usage"]) {
  if (!usage) return { inputUncached: 0, inputCached: 0, output: 0, rawTotal: 0 };
  const inputCached = usage.cachedInputTokens || 0;
  const inputUncached = Math.max(0, usage.inputTokens - inputCached);
  const output = usage.outputTokens || 0;
  // reasoningOutputTokens is a subset of outputTokens, do not double-count.
  const rawTotal = inputUncached + inputCached + output;
  return { inputUncached, inputCached, output, rawTotal };
}

function computeCredits(
  tokens: ReturnType<typeof computeTokens>,
  rates: typeof SOL_RATES,
) {
  return (
    (tokens.inputUncached * rates.inputUncached +
      tokens.inputCached * rates.inputCached +
      tokens.output * rates.output) /
    1_000_000
  );
}

export function analyzeCosts(records: RunRecord[]) {
  const results = records.map((record) => {
    const solTokens = computeTokens(record.supervisorUsage);
    const solCredits = computeCredits(solTokens, SOL_RATES);

    const workersTokens = record.delegations.map((d) => computeTokens(d.usage));
    const lunaTokens = workersTokens.reduce(
      (acc, t) => ({
        inputUncached: acc.inputUncached + t.inputUncached,
        inputCached: acc.inputCached + t.inputCached,
        output: acc.output + t.output,
        rawTotal: acc.rawTotal + t.rawTotal,
      }),
      { inputUncached: 0, inputCached: 0, output: 0, rawTotal: 0 },
    );
    const lunaCredits = computeCredits(lunaTokens, LUNA_RATES);

    const totalRawTokens = solTokens.rawTotal + lunaTokens.rawTotal;
    const totalCredits = solCredits + lunaCredits;

    return {
      taskId: record.taskId,
      arm: record.armLabel,
      passed: record.passed,
      latency: record.durationSeconds,
      workerCount: record.workerCount,
      configuredMaxConcurrency: record.maxParallelConfigured,
      actualPeakConcurrency: record.breakdown.peakConcurrency || 0,
      tokens: {
        sol: solTokens,
        luna: lunaTokens,
        total: totalRawTokens,
      },
      credits: {
        sol: solCredits,
        luna: lunaCredits,
        total: totalCredits,
      },
      delegations: record.delegations,
    };
  });

  // Calculate relative to solo
  const soloRuns = new Map<string, (typeof results)[0]>();
  for (const r of results) {
    if (r.arm.toLowerCase().includes("solo")) {
      soloRuns.set(r.taskId, r);
    }
  }

  return results.map((r) => {
    let relativeCredits = null;
    let retryScenarios = null;

    if (!r.arm.toLowerCase().includes("solo") && soloRuns.has(r.taskId)) {
      const solo = soloRuns.get(r.taskId)!;
      if (solo.credits.total > 0) {
        relativeCredits = r.credits.total / solo.credits.total;
      }

      const wCost = r.credits.luna;
      const sCost = r.credits.sol;

      const scenarioCost = (extraLuna: number) => sCost + wCost + extraLuna;
      const avgWorkerCost = r.workerCount > 0 ? wCost / r.workerCount : 0;

      retryScenarios = {
        plus25Percent: {
          credits: scenarioCost(wCost * 0.25),
          beatsSolo: scenarioCost(wCost * 0.25) < solo.credits.total,
        },
        plus50Percent: {
          credits: scenarioCost(wCost * 0.5),
          beatsSolo: scenarioCost(wCost * 0.5) < solo.credits.total,
        },
        plus100Percent: {
          credits: scenarioCost(wCost * 1.0),
          beatsSolo: scenarioCost(wCost * 1.0) < solo.credits.total,
        },
        oneWorkerRepeated: {
          credits: scenarioCost(avgWorkerCost),
          beatsSolo: scenarioCost(avgWorkerCost) < solo.credits.total,
        },
        twoWorkersRepeated: {
          credits: scenarioCost(avgWorkerCost * 2),
          beatsSolo: scenarioCost(avgWorkerCost * 2) < solo.credits.total,
        },
      };
    }

    return {
      ...r,
      relativeCredits,
      retryScenarios,
    };
  });
}

function main(): void {
  const DEFAULT_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "bench",
    "results",
  );
  const dir = path.resolve(process.argv[2] ?? DEFAULT_DIR);
  if (!fs.existsSync(dir)) {
    console.error("No results directory found at", dir);
    return;
  }

  const all = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap(
      (f) =>
        JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).records as RunRecord[],
    );

  const analyzed = analyzeCosts(all);

  console.log("Cost Analysis:");
  console.log("taskId | arm | credits | solo | workers | max | peak");
  console.log("---|---|---|---|---|---|---");
  for (const r of analyzed) {
    console.log(
      `${r.taskId} | ${r.arm} | $${r.credits.total.toFixed(4)} | ` +
        `${r.relativeCredits ? (r.relativeCredits * 100).toFixed(1) + "%" : "-"} | ` +
        `${r.workerCount} | ${r.configuredMaxConcurrency || "-"} | ${r.actualPeakConcurrency}`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
