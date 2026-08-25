import type { RunRecord } from "./run.js";

export type TradeoffClassification =
  | "cheaper + faster"
  | "cheaper + slower"
  | "more expensive + faster"
  | "more expensive + slower / dominated"
  | "equal cost + faster"
  | "equal cost + slower"
  | "cheaper + equal latency"
  | "more expensive + equal latency"
  | "equal cost + equal latency"
  | "correctness improvement"
  | "correctness regression"
  | "unknown";

export interface CellSummary {
  taskId: string;
  arm: string;
  runs: number;
  passed: number;
  passRate: number;
  medianCredits: number | null;
  creditBasis: "actual" | "rate-card" | "unknown";
  medianDurationSeconds: number | null;
  delegationRate: number;
  medianWorkers: number;
  workerCounts: number[];
  workerEfforts: string[];
  peakConcurrency: number | null;
}

export interface Comparison {
  taskId: string;
  arm: string;
  baselineArm: string;
  creditDeltaPercent: number | null;
  latencyDeltaPercent: number | null;
  classification: TradeoffClassification;
}

export interface RepetitionRecommendation {
  taskId: string;
  arm: string;
  reasons: string[];
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function percentageDelta(
  baseline: number | null,
  comparison: number | null,
): number | null {
  if (baseline === null || comparison === null || baseline === 0) return null;
  return ((comparison - baseline) / baseline) * 100;
}

const knownMedian = (values: readonly (number | null)[]): number | null =>
  values.length > 0 && values.every((value): value is number => value !== null)
    ? median(values)
    : null;

export function summarizeCell(records: readonly RunRecord[]): CellSummary {
  if (records.length === 0) throw new Error("Cannot summarize an empty benchmark cell");
  const actual = records.map((record) => record.creditAccounting?.actualCredits ?? null);
  const estimates = records.map(
    (record) => record.creditAccounting?.rateCardCredits.total ?? null,
  );
  const actualComplete = actual.every((value): value is number => value !== null);
  const estimateComplete = estimates.every((value): value is number => value !== null);
  const credits = actualComplete ? actual : estimates;
  const peaks = records.map((record) => record.breakdown?.peakConcurrency ?? null);
  return {
    taskId: records[0]!.taskId,
    arm: records[0]!.arm,
    runs: records.length,
    passed: records.filter((record) => record.passed).length,
    passRate: records.filter((record) => record.passed).length / records.length,
    medianCredits: actualComplete || estimateComplete ? knownMedian(credits) : null,
    creditBasis: actualComplete ? "actual" : estimateComplete ? "rate-card" : "unknown",
    medianDurationSeconds: median(records.map((record) => record.durationSeconds)),
    delegationRate:
      records.filter((record) => (record.workerCount ?? 0) > 0).length / records.length,
    medianWorkers: median(records.map((record) => record.workerCount ?? 0)) ?? 0,
    workerCounts: records.map((record) => record.workerCount ?? 0),
    workerEfforts: records.flatMap((record) => record.workerEfforts ?? []),
    peakConcurrency: knownMedian(peaks),
  };
}

export function classifyTradeoff(
  baseline: CellSummary,
  comparison: CellSummary,
): TradeoffClassification {
  if (comparison.passRate > baseline.passRate) return "correctness improvement";
  if (comparison.passRate < baseline.passRate) return "correctness regression";
  if (
    baseline.creditBasis !== comparison.creditBasis ||
    baseline.medianCredits === null ||
    comparison.medianCredits === null ||
    baseline.medianDurationSeconds === null ||
    comparison.medianDurationSeconds === null
  ) {
    return "unknown";
  }
  const credit = Math.sign(comparison.medianCredits - baseline.medianCredits);
  const latency = Math.sign(
    comparison.medianDurationSeconds - baseline.medianDurationSeconds,
  );
  if (credit < 0 && latency < 0) return "cheaper + faster";
  if (credit < 0 && latency > 0) return "cheaper + slower";
  if (credit > 0 && latency < 0) return "more expensive + faster";
  if (credit > 0 && latency > 0) return "more expensive + slower / dominated";
  if (credit === 0 && latency < 0) return "equal cost + faster";
  if (credit === 0 && latency > 0) return "equal cost + slower";
  if (credit < 0) return "cheaper + equal latency";
  if (credit > 0) return "more expensive + equal latency";
  return "equal cost + equal latency";
}

export function compareWithBaseline(
  baseline: CellSummary,
  comparison: CellSummary,
): Comparison {
  return {
    taskId: comparison.taskId,
    arm: comparison.arm,
    baselineArm: baseline.arm,
    creditDeltaPercent:
      baseline.creditBasis === comparison.creditBasis
        ? percentageDelta(baseline.medianCredits, comparison.medianCredits)
        : null,
    latencyDeltaPercent: percentageDelta(
      baseline.medianDurationSeconds,
      comparison.medianDurationSeconds,
    ),
    classification: classifyTradeoff(baseline, comparison),
  };
}

const relativeRange = (values: readonly number[]): number => {
  const center = median(values);
  if (center === null || center === 0) return 0;
  return (Math.max(...values) - Math.min(...values)) / center;
};

/** Predeclared diagnostic rules for deciding whether a third repetition is useful. */
export function recommendThirdRepetition(
  records: readonly RunRecord[],
  baselineRecords: readonly RunRecord[] = [],
): RepetitionRecommendation | null {
  if (records.length !== 2) return null;
  const reasons: string[] = [];
  if (records[0]!.passed !== records[1]!.passed) {
    reasons.push("inconsistent pass/fail");
  }
  const durations = records.map((record) => record.durationSeconds);
  if (relativeRange(durations) >= 0.25) reasons.push("latency range is at least 25%");

  const delegated = records.map((record) => (record.workerCount ?? 0) > 0);
  if (delegated[0] !== delegated[1]) reasons.push("routing changed between repetitions");
  if (Math.abs((records[0]!.workerCount ?? 0) - (records[1]!.workerCount ?? 0)) >= 2) {
    reasons.push("worker count changed materially");
  }

  const cellCredits = records.map(
    (record) => record.creditAccounting?.rateCardCredits.total ?? null,
  );
  if (cellCredits.every((value): value is number => value !== null)) {
    if (relativeRange(cellCredits) >= 0.25) reasons.push("credit range is at least 25%");
    const isSoloArm = records[0]!.arm.startsWith("solo-");
    if (!isSoloArm && baselineRecords.length === 2) {
      const cell = knownMedian(cellCredits);
      const base = knownMedian(
        baselineRecords.map(
          (record) => record.creditAccounting?.rateCardCredits.total ?? null,
        ),
      );
      const delta = percentageDelta(base, cell);
      if (delta !== null && Math.abs(delta) <= 10) {
        reasons.push("credit delta versus Solo is within 10%");
      }
    }
  }

  return reasons.length > 0
    ? { taskId: records[0]!.taskId, arm: records[0]!.arm, reasons }
    : null;
}

export function groupCells(records: readonly RunRecord[]): CellSummary[] {
  const cells = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = `${record.taskId}\0${record.arm}`;
    const rows = cells.get(key) ?? [];
    rows.push(record);
    cells.set(key, rows);
  }
  return [...cells.values()].map(summarizeCell);
}
