/**
 * Deterministic, post-hoc Benchmark V3 routing analysis.
 *
 * This module only reads run records and separately supplied evaluator metadata.
 * Evaluator metadata is descriptive: it never changes the observed `passed`
 * value or any correctness aggregate.
 */
import type { RunRecord } from "./run.js";

export type RunRecordCompatible = Omit<
  Partial<RunRecord>,
  | "taskId"
  | "arm"
  | "passed"
  | "durationSeconds"
  | "workerCount"
  | "repetition"
  | "verificationFailed"
  | "integrationConflicts"
  | "delegations"
  | "agentError"
  | "creditAccounting"
> & {
  taskId: string;
  arm: string;
  passed?: boolean | null;
  durationSeconds?: number | null;
  workerCount?: number | null;
  repetition?: number | null;
  verificationFailed?: number | null;
  integrationConflicts?: number | null;
  delegations?: RunRecord["delegations"] | null;
  agentError?: string | null;
  creditAccounting?: RunRecord["creditAccounting"] | null;
};

export interface V3EvaluatorMetadata {
  routingCategory?: string | null;
  workload?: string | null;
  workloadClass?: string | null;
  coupled?: boolean;
  control?: boolean;
  obviousSolo?: boolean;
  delegationCandidate?: boolean;
}

export type V3EvaluatorMetadataByTaskId =
  | ReadonlyMap<string, V3EvaluatorMetadata>
  | Readonly<Record<string, V3EvaluatorMetadata>>;

export type V3RoutingOutcomeLabel =
  | "aligned with evaluator expectation"
  | "delegated despite Solo expectation"
  | "stayed Solo despite delegation candidacy"
  | "routing changed between repetitions"
  | "ambiguous routing observed"
  | "unknown routing expectation";

export type V3EconomicLabel =
  | "beneficial delegation"
  | "harmful delegation"
  | "correctness improvement"
  | "correctness regression"
  | "correctness-equivalent economic neutral"
  | "unknown";

export interface V3NumericSummary {
  count: number;
  known: number;
  median: number | null;
  min: number | null;
  max: number | null;
  relativeRange: number | null;
}

export interface V3CellSummary {
  taskId: string;
  arm: string;
  routingCategory: string | null;
  workload: string | null;
  repetitions: number;
  passed: number;
  failed: number;
  passRate: number | null;
  delegationRate: number | null;
  zeroWorkerRate: number | null;
  workerCounts: V3NumericSummary;
  workerCountStable: boolean | null;
  routingChanges: number | null;
  routingOutcome: V3RoutingOutcomeLabel;
  solCredits: V3NumericSummary;
  lunaCredits: V3NumericSummary;
  totalCredits: V3NumericSummary;
  totalCreditBasis: "actual" | "rate-card" | "unknown";
  endToEndLatencySeconds: V3NumericSummary;
  workerWindowSeconds: V3NumericSummary;
  slowestWorkerSeconds: V3NumericSummary;
  timeoutIncidence: number | null;
  recoveryIncidence: number | null;
  stragglerIncidence: number | null;
  verificationFailureIncidence: number | null;
  integrationConflictIncidence: number | null;
  coupledOrControl: boolean;
  obviousSolo: boolean;
  delegationCandidate: boolean;
  delegated: boolean | null;
}

export interface V3RoutingGroupSummary {
  key: string;
  cells: number;
  runs: number;
  delegationRate: number | null;
  zeroWorkerRate: number | null;
  workerCounts: V3NumericSummary;
}

export interface V3EconomicComparison {
  taskId: string;
  adaptiveArm: string;
  soloArm: string;
  correctness: "equivalent" | "improvement" | "regression" | "unknown";
  creditBasis: "actual" | "rate-card" | "unknown";
  soloMedianTotalCredits: number | null;
  adaptiveMedianTotalCredits: number | null;
  label: V3EconomicLabel;
}

export interface V3RoutingAnalysis {
  cells: readonly V3CellSummary[];
  byRoutingCategory: readonly V3RoutingGroupSummary[];
  byWorkload: readonly V3RoutingGroupSummary[];
  economicComparisons: readonly V3EconomicComparison[];
  coupledOrControlDelegated: readonly string[];
  obviousSoloDelegated: readonly string[];
  adaptiveStayedSolo: readonly string[];
  routingChanges: readonly string[];
  verificationFailures: number;
  integrationConflicts: number;
  /** Runs the predeclared exclusion rules removed, kept visible not deleted. */
  quarantinedRuns: readonly V3QuarantinedRun[];
  includedRuns: number;
}

export interface V3QuarantinedRun {
  taskId: string;
  arm: string;
  repetition: number | null;
  runId: string | null;
  reasons: readonly string[];
}

export interface V3RepetitionRecommendation {
  taskId: string;
  arm: string;
  reasons: readonly string[];
}

const asFinite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const relativeRange = (values: readonly number[]): number | null => {
  const center = median(values);
  if (center === null) return null;
  if (center === 0) return values.every((value) => value === 0) ? 0 : null;
  return (Math.max(...values) - Math.min(...values)) / Math.abs(center);
};

const numericSummary = (
  values: readonly (number | null | undefined)[],
): V3NumericSummary => {
  const known = values.flatMap((value) => {
    const number = asFinite(value);
    return number === null ? [] : [number];
  });
  return {
    count: values.length,
    known: known.length,
    median: median(known),
    min: known.length > 0 ? Math.min(...known) : null,
    max: known.length > 0 ? Math.max(...known) : null,
    relativeRange: relativeRange(known),
  };
};

const rate = (known: readonly (boolean | null | undefined)[]): number | null => {
  const observed = known.filter((value): value is boolean => typeof value === "boolean");
  if (observed.length === 0) return null;
  return observed.filter(Boolean).length / observed.length;
};

const metadataFor = (
  metadata: V3EvaluatorMetadataByTaskId | undefined,
  taskId: string,
): V3EvaluatorMetadata => {
  if (!metadata) return {};
  return metadata instanceof Map
    ? (metadata.get(taskId) ?? {})
    : ((metadata as Readonly<Record<string, V3EvaluatorMetadata>>)[taskId] ?? {});
};

const categoryFor = (
  record: RunRecordCompatible,
  metadata: V3EvaluatorMetadata,
): string | null => metadata.routingCategory ?? record.routingCategory ?? null;

const workloadFor = (
  record: RunRecordCompatible,
  metadata: V3EvaluatorMetadata,
): string | null =>
  metadata.workload ?? metadata.workloadClass ?? record.workloadClass ?? null;

const passedOf = (record: RunRecordCompatible): boolean | null =>
  typeof record.passed === "boolean" ? record.passed : null;

const workerCountOf = (record: RunRecordCompatible): number | null => {
  const count = asFinite(record.workerCount);
  return count !== null && count >= 0 ? count : null;
};

const delegatedOf = (record: RunRecordCompatible): boolean | null => {
  const count = workerCountOf(record);
  return count === null ? null : count > 0;
};

const actualCreditsOf = (record: RunRecordCompatible): number | null =>
  asFinite(record.creditAccounting?.actualCredits);

const rateCardCreditsOf = (record: RunRecordCompatible): number | null =>
  asFinite(record.creditAccounting?.rateCardCredits.total);

const creditBasisFor = (
  records: readonly RunRecordCompatible[],
): "actual" | "rate-card" | "unknown" => {
  if (records.length > 0 && records.every((record) => actualCreditsOf(record) !== null)) {
    return "actual";
  }
  if (
    records.length > 0 &&
    records.every((record) => rateCardCreditsOf(record) !== null)
  ) {
    return "rate-card";
  }
  return "unknown";
};

const totalCreditValues = (
  records: readonly RunRecordCompatible[],
  basis: "actual" | "rate-card" | "unknown",
): (number | null)[] =>
  records.map((record) =>
    basis === "actual"
      ? actualCreditsOf(record)
      : basis === "rate-card"
        ? rateCardCreditsOf(record)
        : null,
  );

const solCreditOf = (record: RunRecordCompatible): number | null => {
  const value = asFinite(record.creditAccounting?.rateCardCredits.sol);
  return value;
};

const lunaCreditOf = (record: RunRecordCompatible): number | null =>
  asFinite(record.creditAccounting?.rateCardCredits.luna);

const timeoutOf = (record: RunRecordCompatible): boolean | null => {
  const evidence = [
    typeof record.agentError === "string" ? record.agentError : null,
    ...(record.workerFailures ?? []),
    ...(record.delegations ?? []).flatMap((delegation) => [
      delegation.verdict,
      delegation.recoveryClassification ?? "",
      delegation.recoveryEvidence ?? "",
    ]),
  ].filter((value): value is string => typeof value === "string");
  if (evidence.length > 0)
    return evidence.some((value) => /timeout|timed out|aborted/i.test(value));
  return record.agentError === null && Array.isArray(record.workerFailures)
    ? false
    : null;
};

const recoveryOf = (record: RunRecordCompatible): boolean | null => {
  const delegations = record.delegations;
  if (!Array.isArray(delegations)) return null;
  return delegations.some((delegation) =>
    Boolean(delegation.recoveryClassification || delegation.recoveryEvidence),
  );
};

const stragglerOf = (record: RunRecordCompatible): boolean | null => {
  const workers = workerCountOf(record);
  const slowest = asFinite(record.breakdown?.slowestWorkerSeconds);
  const window = asFinite(record.breakdown?.workerWindowSeconds);
  if (
    workers === null ||
    workers < 2 ||
    slowest === null ||
    window === null ||
    window <= 0
  ) {
    return null;
  }
  return slowest >= window * 0.75;
};

const routingOutcomeLabel = (
  records: readonly RunRecordCompatible[],
  metadata: V3EvaluatorMetadata,
): V3RoutingOutcomeLabel => {
  const routes = records.map(delegatedOf);
  if (routes.some((value) => value === null) || routes.length === 0) {
    return "unknown routing expectation";
  }
  if (new Set(routes).size > 1) return "routing changed between repetitions";
  const delegated = routes[0] === true;
  const category = metadata.routingCategory;
  if (category === "ambiguous") return "ambiguous routing observed";
  if (category === "expected-solo" || category === "likely-solo") {
    return delegated
      ? "delegated despite Solo expectation"
      : "aligned with evaluator expectation";
  }
  if (category === "delegation-candidate" || category === "strong-delegation-candidate") {
    return delegated
      ? "aligned with evaluator expectation"
      : "stayed Solo despite delegation candidacy";
  }
  return "unknown routing expectation";
};

const groupSummary = (
  key: string,
  cells: readonly V3CellSummary[],
): V3RoutingGroupSummary => {
  const runs = cells.reduce((total, cell) => total + cell.repetitions, 0);
  const weightedRate = (values: readonly (number | null)[]): number | null => {
    const observed = values.flatMap((value, index) => {
      const cell = cells[index]!;
      return value === null ? [] : [{ value, weight: cell.repetitions }];
    });
    const weight = observed.reduce((total, item) => total + item.weight, 0);
    return weight === 0
      ? null
      : observed.reduce((total, item) => total + item.value * item.weight, 0) / weight;
  };
  const workers = cells.flatMap((cell) =>
    cell.workerCounts.median === null ? [] : [cell.workerCounts.median],
  );
  return {
    key,
    cells: cells.length,
    runs,
    delegationRate: weightedRate(cells.map((cell) => cell.delegationRate)),
    zeroWorkerRate: weightedRate(cells.map((cell) => cell.zeroWorkerRate)),
    workerCounts: numericSummary(workers),
  };
};

const isAdaptive = (arm: string): boolean => /adaptive/i.test(arm);
const isSolo = (arm: string): boolean => /^solo(?:-|$)/i.test(arm);

const summarizeCell = (
  records: readonly RunRecordCompatible[],
  metadata: V3EvaluatorMetadata,
): V3CellSummary => {
  const basis = creditBasisFor(records);
  const workers = records.map(workerCountOf);
  const routes = records.map(delegatedOf);
  const knownRoutes = routes.filter((value): value is boolean => value !== null);
  const routeChanges =
    knownRoutes.length === records.length && records.length > 1
      ? routes.slice(1).filter((value, index) => value !== routes[index]).length
      : null;
  const passed = records.filter((record) => passedOf(record) === true).length;
  const knownPassed = records.filter((record) => passedOf(record) !== null).length;
  return {
    taskId: records[0]!.taskId,
    arm: records[0]!.arm,
    routingCategory: categoryFor(records[0]!, metadata),
    workload: workloadFor(records[0]!, metadata),
    repetitions: records.length,
    passed,
    failed: records.filter((record) => passedOf(record) === false).length,
    passRate:
      knownPassed === records.length && records.length > 0
        ? passed / records.length
        : null,
    delegationRate: rate(routes),
    zeroWorkerRate: rate(routes.map((value) => (value === null ? null : !value))),
    workerCounts: numericSummary(workers),
    workerCountStable:
      workers.every((value) => value !== null) && workers.length > 0
        ? new Set(workers).size === 1
        : null,
    routingChanges: routeChanges,
    routingOutcome: routingOutcomeLabel(records, metadata),
    solCredits: numericSummary(records.map(solCreditOf)),
    lunaCredits: numericSummary(records.map(lunaCreditOf)),
    totalCredits: numericSummary(totalCreditValues(records, basis)),
    totalCreditBasis: basis,
    endToEndLatencySeconds: numericSummary(
      records.map((record) => asFinite(record.durationSeconds)),
    ),
    workerWindowSeconds: numericSummary(
      records.map((record) => asFinite(record.breakdown?.workerWindowSeconds)),
    ),
    slowestWorkerSeconds: numericSummary(
      records.map((record) => asFinite(record.breakdown?.slowestWorkerSeconds)),
    ),
    timeoutIncidence: rate(records.map(timeoutOf)),
    recoveryIncidence: rate(records.map(recoveryOf)),
    stragglerIncidence: rate(records.map(stragglerOf)),
    verificationFailureIncidence: rate(
      records.map((record) => {
        const failed = asFinite(record.verificationFailed);
        return failed === null ? null : failed > 0;
      }),
    ),
    integrationConflictIncidence: rate(
      records.map((record) => {
        const conflicts = asFinite(record.integrationConflicts);
        return conflicts === null ? null : conflicts > 0;
      }),
    ),
    coupledOrControl: Boolean(metadata.coupled || metadata.control),
    obviousSolo: Boolean(metadata.obviousSolo),
    delegationCandidate: Boolean(metadata.delegationCandidate),
    delegated:
      knownRoutes.length === records.length && knownRoutes.length > 0
        ? knownRoutes.some(Boolean)
        : null,
  };
};

const matchingCreditBasis = (
  left: V3CellSummary,
  right: V3CellSummary,
): "actual" | "rate-card" | "unknown" =>
  left.totalCreditBasis === right.totalCreditBasis && left.totalCreditBasis !== "unknown"
    ? left.totalCreditBasis
    : "unknown";

const economicLabel = (
  correctness: V3EconomicComparison["correctness"],
  basis: V3EconomicComparison["creditBasis"],
  solo: number | null,
  adaptive: number | null,
): V3EconomicLabel => {
  if (correctness === "improvement") return "correctness improvement";
  if (correctness === "regression") return "correctness regression";
  if (
    correctness !== "equivalent" ||
    basis === "unknown" ||
    solo === null ||
    adaptive === null
  ) {
    return "unknown";
  }
  if (adaptive < solo) return "beneficial delegation";
  if (adaptive > solo) return "harmful delegation";
  return "correctness-equivalent economic neutral";
};

const economicComparison = (
  adaptive: V3CellSummary,
  solo: V3CellSummary,
): V3EconomicComparison => {
  const correctness: V3EconomicComparison["correctness"] =
    adaptive.passRate === null || solo.passRate === null
      ? "unknown"
      : adaptive.passRate === solo.passRate
        ? "equivalent"
        : adaptive.passRate > solo.passRate
          ? "improvement"
          : "regression";
  const basis = matchingCreditBasis(adaptive, solo);
  const adaptiveMedian = basis === "unknown" ? null : adaptive.totalCredits.median;
  const soloMedian = basis === "unknown" ? null : solo.totalCredits.median;
  return {
    taskId: adaptive.taskId,
    adaptiveArm: adaptive.arm,
    soloArm: solo.arm,
    correctness,
    creditBasis: basis,
    soloMedianTotalCredits: soloMedian,
    adaptiveMedianTotalCredits: adaptiveMedian,
    label: economicLabel(correctness, basis, soloMedian, adaptiveMedian),
  };
};

/** Analyze records without performing any I/O, grading, or model calls. */
export function analyzeV3(
  all: readonly RunRecordCompatible[],
  evaluatorMetadata?: V3EvaluatorMetadataByTaskId,
): V3RoutingAnalysis {
  // Quarantined runs are excluded from every aggregate and listed separately.
  // Removing them silently would let a missing-evidence run look like a result;
  // averaging them in would let it look like a model outcome.
  const quarantinedRuns: V3QuarantinedRun[] = all
    .filter((record) => record.validity?.status === "quarantined")
    .map((record) => ({
      taskId: record.taskId,
      arm: record.arm,
      repetition: asFinite(record.repetition),
      runId: typeof record.runId === "string" ? record.runId : null,
      reasons: record.validity?.reasons ?? [],
    }));
  const records = all.filter((record) => record.validity?.status !== "quarantined");

  const grouped = new Map<string, RunRecordCompatible[]>();
  for (const record of records) {
    const key = `${record.taskId}\0${record.arm}`;
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }
  const cells = [...grouped.values()].map((group) =>
    summarizeCell(group, metadataFor(evaluatorMetadata, group[0]!.taskId)),
  );
  const byCategory = new Map<string, V3CellSummary[]>();
  const byWorkload = new Map<string, V3CellSummary[]>();
  for (const cell of cells) {
    const category = cell.routingCategory ?? "unknown";
    const workload = cell.workload ?? "unknown";
    byCategory.set(category, [...(byCategory.get(category) ?? []), cell]);
    byWorkload.set(workload, [...(byWorkload.get(workload) ?? []), cell]);
  }
  const comparisons: V3EconomicComparison[] = [];
  for (const adaptive of cells.filter(
    (cell) =>
      isAdaptive(cell.arm) && cell.delegationRate !== null && cell.delegationRate > 0,
  )) {
    const solos = cells.filter(
      (cell) => cell.taskId === adaptive.taskId && isSolo(cell.arm),
    );
    for (const solo of solos) comparisons.push(economicComparison(adaptive, solo));
  }
  const delegated = (cell: V3CellSummary): boolean =>
    cell.delegationRate !== null && cell.delegationRate > 0;
  return {
    cells,
    byRoutingCategory: [...byCategory.entries()].map(([key, values]) =>
      groupSummary(key, values),
    ),
    byWorkload: [...byWorkload.entries()].map(([key, values]) =>
      groupSummary(key, values),
    ),
    economicComparisons: comparisons,
    coupledOrControlDelegated: cells
      .filter((cell) => cell.coupledOrControl && delegated(cell))
      .map((cell) => `${cell.taskId}\0${cell.arm}`),
    obviousSoloDelegated: cells
      .filter((cell) => cell.obviousSolo && delegated(cell))
      .map((cell) => `${cell.taskId}\0${cell.arm}`),
    adaptiveStayedSolo: cells
      .filter(
        (cell) =>
          isAdaptive(cell.arm) && cell.delegationCandidate && cell.delegationRate === 0,
      )
      .map((cell) => cell.taskId),
    routingChanges: cells
      .filter((cell) => cell.routingChanges !== null && cell.routingChanges > 0)
      .map((cell) => `${cell.taskId}\0${cell.arm}`),
    verificationFailures: records.reduce(
      (total, record) => total + (asFinite(record.verificationFailed) ?? 0),
      0,
    ),
    integrationConflicts: records.reduce(
      (total, record) => total + (asFinite(record.integrationConflicts) ?? 0),
      0,
    ),
    quarantinedRuns,
    includedRuns: records.length,
  };
}

/**
 * Apply the exact V3 third-repetition rules. This function only returns data;
 * it never schedules or initiates a repetition.
 */
export function recommendV3ThirdRepetition(
  records: readonly RunRecordCompatible[],
  matchingSoloRecords: readonly RunRecordCompatible[] = [],
): V3RepetitionRecommendation | null {
  if (records.length !== 2) return null;
  const repetitions = records
    .map((record) => record.repetition)
    .filter((value): value is number => typeof value === "number");
  if (
    repetitions.length > 0 &&
    (new Set(repetitions).size !== 2 ||
      !repetitions.includes(1) ||
      !repetitions.includes(2))
  ) {
    return null;
  }
  const reasons: string[] = [];
  const outcomes = records.map(passedOf);
  if (outcomes[0] !== null && outcomes[1] !== null && outcomes[0] !== outcomes[1]) {
    reasons.push("inconsistent PASS/FAIL");
  }
  const latency = records.map((record) => asFinite(record.durationSeconds));
  if (
    latency.every((value): value is number => value !== null) &&
    (relativeRange(latency) ?? 0) >= 0.25
  ) {
    reasons.push("end-to-end latency relative range >=25%");
  }
  const basis = creditBasisFor(records);
  const credits = totalCreditValues(records, basis);
  if (
    credits.every((value): value is number => value !== null) &&
    (relativeRange(credits) ?? 0) >= 0.2
  ) {
    reasons.push("total-credit relative range >=20%");
  }
  const routes = records.map(delegatedOf);
  if (
    isAdaptive(records[0]!.arm) &&
    routes[0] !== null &&
    routes[1] !== null &&
    routes[0] !== routes[1]
  ) {
    reasons.push("Adaptive routing changed between repetitions");
  }
  const workers = records.map(workerCountOf);
  if (
    workers[0] !== null &&
    workers[0] !== undefined &&
    workers[1] !== null &&
    workers[1] !== undefined &&
    Math.abs(workers[0] - workers[1]) >= 2
  ) {
    reasons.push("worker-count absolute difference >=2");
  }
  if (
    !isSolo(records[0]!.arm) &&
    matchingSoloRecords.length === 2 &&
    matchingSoloRecords.every(
      (record) => record.taskId === records[0]!.taskId && isSolo(record.arm),
    )
  ) {
    const matchingRepetitions = matchingSoloRecords
      .map((record) => record.repetition)
      .filter((value): value is number => typeof value === "number");
    const validSoloPair =
      matchingRepetitions.length === 0 ||
      (new Set(matchingRepetitions).size === 2 &&
        matchingRepetitions.includes(1) &&
        matchingRepetitions.includes(2));
    const soloBasis = creditBasisFor(matchingSoloRecords);
    const comparableBasis = basis === soloBasis && basis !== "unknown";
    const observed = records.map(passedOf).concat(matchingSoloRecords.map(passedOf));
    const correctnessEquivalent =
      observed.every((value): value is boolean => value !== null) &&
      records.every((record) => passedOf(record) === passedOf(matchingSoloRecords[0]!)) &&
      matchingSoloRecords.every((record) => passedOf(record) === passedOf(records[0]!));
    const adaptiveMedian = comparableBasis
      ? median(totalCreditValues(records, basis) as number[])
      : null;
    const soloMedian = comparableBasis
      ? median(totalCreditValues(matchingSoloRecords, soloBasis) as number[])
      : null;
    const nearTie =
      adaptiveMedian !== null &&
      soloMedian !== null &&
      (soloMedian === 0
        ? adaptiveMedian === 0
        : Math.abs(adaptiveMedian - soloMedian) / Math.abs(soloMedian) <= 0.1);
    if (validSoloPair && comparableBasis && correctnessEquivalent && nearTie) {
      reasons.push(
        "non-Solo correctness-equivalent economic near-tie (median total credits within 10% of Solo)",
      );
    }
  }
  return reasons.length > 0
    ? { taskId: records[0]!.taskId, arm: records[0]!.arm, reasons }
    : null;
}

export const summarizeV3 = analyzeV3;
export const analyzeRoutingV3 = analyzeV3;
export const recommendThirdRepetitionV3 = recommendV3ThirdRepetition;
export { median, relativeRange };
