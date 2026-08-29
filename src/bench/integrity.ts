/**
 * Predeclared campaign integrity rules.
 *
 * Everything in this module is decided before a live run exists: what makes a
 * run valid, what quarantines it, how failures and retries are treated, and
 * what configuration the harness is allowed to give the orchestrator. Deciding
 * these after seeing results is the failure mode the module exists to prevent,
 * so the rules are code and are covered by deterministic tests.
 */
import crypto from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Frozen methodology document                                                 */
/* -------------------------------------------------------------------------- */

/** Repository-relative path of the frozen Benchmark V3 methodology. */
export const V3_METHODOLOGY_PATH = "bench/V3_METHODOLOGY.md" as const;

/**
 * Digest of the frozen methodology text, currently freeze 3.
 *
 * A git SHA identifies a commit; this identifies the reviewed content, so the
 * gate works in a working tree, a tarball, or a checkout whose history was
 * rewritten. It is the authoritative freeze identity;
 * `BENCHMARK_V3_FREEZE_SHA` is its commit-addressed companion. Update it only
 * through the document's own correction and freeze-review policy, and never by
 * transcribing a value — recompute it with `methodologyDigest`.
 */
export const V3_METHODOLOGY_DIGEST =
  "0994a7090ffacaa4f59641f36501430047a8215626e87de4f810e254fd8aea4c" as const;

/**
 * Normalize before hashing.
 *
 * Line endings differ between platforms and Git checkouts, and the digest line
 * inside the document cannot contribute to its own value, so both are removed.
 */
export function normalizeMethodologyText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(?:-\s*)?Methodology content digest:/i.test(line))
    .join("\n")
    .replace(/\s+$/, "");
}

export const methodologyDigest = (text: string): string =>
  crypto
    .createHash("sha256")
    .update(normalizeMethodologyText(text), "utf8")
    .digest("hex");

/**
 * Refuse to launch against a methodology that no longer matches its freeze.
 *
 * A silent edit to the frozen document — arms, graders, stopping rules — would
 * otherwise be indistinguishable from the reviewed text at analysis time.
 */
export function assertMethodologyFrozen(
  text: string,
  expected: string = V3_METHODOLOGY_DIGEST,
): string {
  const actual = methodologyDigest(text);
  if (actual !== expected) {
    throw new Error(
      `${V3_METHODOLOGY_PATH} does not match its recorded freeze digest (expected ${expected}, found ${actual}). ` +
        "Follow the document's post-freeze correction policy and re-freeze before launching.",
    );
  }
  return actual;
}

/* -------------------------------------------------------------------------- */
/* Retry and failure treatment                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How failures are treated, fixed before any result exists.
 *
 * The harness performs no automatic re-execution of a live cell. A failing run
 * is a result and is retained; only a quarantined run — one whose evidence is
 * missing, not one whose outcome is unwelcome — may be re-executed, and only
 * under a recorded review and a new run identity.
 */
export const CAMPAIGN_RETRY_POLICY = Object.freeze({
  automaticRunRetries: 0,
  automaticGradingRetries: 0,
  completedCellsAreImmutable: true,
  failedRunsRetained: true,
  quarantinedRunsRetained: true,
  quarantinedRunsExcludedFromAggregates: true,
  quarantinedCellReexecution: "review-approved-new-run-identity" as const,
  thirdRepetition: "predeclared-review-conditions-only" as const,
  /** In-run recovery belongs to the product under test, not to the harness. */
  harnessLevelWorkerRetries: "none-harness-side" as const,
});

/* -------------------------------------------------------------------------- */
/* Run validity and exclusion                                                  */
/* -------------------------------------------------------------------------- */

/** How the supervisor turn ended, as a runtime fact rather than a judgement. */
export const RUN_TERMINATION_REASONS = [
  "completed",
  "harness-timeout",
  "agent-error",
] as const;
export type RunTerminationReason = (typeof RUN_TERMINATION_REASONS)[number];

/**
 * Predeclared exclusion reasons.
 *
 * Each one describes missing or untrustworthy *evidence*. None of them
 * describes a disappointing outcome: a model that fails the grader, changes a
 * protected specification, or exhausts the time bound has produced a result.
 */
export const RUN_QUARANTINE_REASONS = [
  "grader-did-not-execute",
  "agent-transport-error",
  "delegation-telemetry-unavailable",
  "fixture-identity-missing",
  "fixture-revision-drift",
] as const;
export type RunQuarantineReason = (typeof RUN_QUARANTINE_REASONS)[number];

export interface RunValidity {
  readonly status: "valid" | "quarantined";
  readonly reasons: readonly RunQuarantineReason[];
}

/** The subset of a run record the exclusion rules are allowed to look at. */
export interface RunValidityInput {
  readonly benchmarkVersion?: number;
  readonly delegationEnabled: boolean;
  readonly grades: readonly { readonly exitCode: number | null }[];
  readonly terminationReason?: RunTerminationReason;
  readonly telemetryAvailable?: boolean | null;
  readonly runId?: string;
  readonly fixtureRevision?: string;
}

/**
 * Decide whether a run counts, from evidence alone.
 *
 * Deliberately blind to `passed`, credits, latency, worker count, and arm, so
 * the rule cannot be applied selectively to a result someone dislikes.
 */
export function classifyRunValidity(
  record: RunValidityInput,
  options: { expectedFixtureRevision?: string } = {},
): RunValidity {
  const reasons: RunQuarantineReason[] = [];

  if (
    record.grades.length === 0 ||
    record.grades.some((grade) => grade.exitCode === null)
  ) {
    reasons.push("grader-did-not-execute");
  }
  if (record.terminationReason === "agent-error") {
    reasons.push("agent-transport-error");
  }
  if (record.delegationEnabled && record.telemetryAvailable === false) {
    reasons.push("delegation-telemetry-unavailable");
  }
  if (record.benchmarkVersion === 3 && (!record.runId || !record.fixtureRevision)) {
    reasons.push("fixture-identity-missing");
  }
  if (
    options.expectedFixtureRevision !== undefined &&
    record.fixtureRevision !== undefined &&
    record.fixtureRevision !== options.expectedFixtureRevision
  ) {
    reasons.push("fixture-revision-drift");
  }

  return {
    status: reasons.length === 0 ? "valid" : "quarantined",
    reasons,
  };
}

export const isQuarantined = (validity: RunValidity | undefined): boolean =>
  validity?.status === "quarantined";

/* -------------------------------------------------------------------------- */
/* Worker concurrency configuration                                            */
/* -------------------------------------------------------------------------- */

export const CONCURRENCY_POLICIES = [
  "not-applicable",
  "production-default",
  "fixture-stream-count",
] as const;
export type ConcurrencyPolicy = (typeof CONCURRENCY_POLICIES)[number];

export interface ResolvedConcurrency {
  readonly policy: ConcurrencyPolicy;
  /** Null means the harness sets nothing and the shipped default applies. */
  readonly maxParallel: number | null;
}

/**
 * Decide what concurrency, if any, the harness configures for an arm.
 *
 * V2 kept a per-fixture ceiling equal to the fixture's declared natural stream
 * count, and its committed records depend on that. V3 must not: its stream
 * counts correlate with the evaluator-only routing category, so passing them
 * through would hand the orchestrator a task-specific hint about the very
 * question V3 asks. V3 therefore configures nothing and measures the shipped
 * production default.
 */
export function resolveWorkerConcurrency(options: {
  suite: string;
  delegationEnabled: boolean;
  streams?: number | null;
}): ResolvedConcurrency {
  if (!options.delegationEnabled) {
    return { policy: "not-applicable", maxParallel: null };
  }
  if (options.suite === "v3") {
    return { policy: "production-default", maxParallel: null };
  }
  const streams = options.streams ?? 1;
  return {
    policy: "fixture-stream-count",
    maxParallel: Math.min(Math.max(Number.isFinite(streams) ? streams : 1, 1), 8),
  };
}
