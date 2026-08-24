/**
 * Standalone Benchmark V2 credit accounting.
 *
 * This module is deliberately post-hoc: it never contacts a pricing service
 * and it never turns unavailable usage into a zero or an estimate.
 */

export const BENCHMARK_V2_PRICING_SOURCE_URL =
  "https://help.openai.com/en/articles/20001106" as const;
export const BENCHMARK_V2_PRICING_SNAPSHOT_DATE = "2026-08-24" as const;
export const BENCHMARK_V2_PRICING_PROFILE_ID =
  "benchmark-v2-chatgpt-plus-codex-credits-2026-08-24" as const;
export const BENCHMARK_V2_PRICING_UNITS = "credits-per-1m-tokens" as const;

export const BENCHMARK_V2_MODELS = ["gpt-5.6-sol", "gpt-5.6-luna"] as const;
export type BenchmarkModel = (typeof BENCHMARK_V2_MODELS)[number];

export interface ModelCreditRates {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
  /** Cache writes are represented explicitly to prevent accidental charging. */
  readonly cacheWrite: 0;
}

export interface CreditPricingProfile {
  readonly profileId: string;
  readonly sourceUrl: string;
  readonly snapshotDate: string;
  readonly units: typeof BENCHMARK_V2_PRICING_UNITS;
  readonly applicability: string;
  readonly promotionalTerms: string | null;
  readonly rates: Readonly<Record<BenchmarkModel, ModelCreditRates>>;
}

const freezeRates = (
  rates: Record<BenchmarkModel, ModelCreditRates>,
): Readonly<Record<BenchmarkModel, ModelCreditRates>> =>
  Object.freeze(
    Object.fromEntries(
      BENCHMARK_V2_MODELS.map((model) => [model, Object.freeze({ ...rates[model] })]),
    ) as Record<BenchmarkModel, ModelCreditRates>,
  );

/** Immutable official rate-card snapshot used by Benchmark V2. */
export const BENCHMARK_V2_PRICING_PROFILE: CreditPricingProfile = Object.freeze({
  profileId: BENCHMARK_V2_PRICING_PROFILE_ID,
  sourceUrl: BENCHMARK_V2_PRICING_SOURCE_URL,
  snapshotDate: BENCHMARK_V2_PRICING_SNAPSHOT_DATE,
  units: BENCHMARK_V2_PRICING_UNITS,
  applicability:
    "Token-based Codex credit rates for the ChatGPT Plus account used by Benchmark V2",
  promotionalTerms: null,
  rates: freezeRates({
    "gpt-5.6-sol": { input: 125, cachedInput: 12.5, output: 750, cacheWrite: 0 },
    "gpt-5.6-luna": { input: 5, cachedInput: 0.5, output: 30, cacheWrite: 0 },
  }),
});

/** Convenient aliases for callers that name the default profile differently. */
export const DEFAULT_BENCHMARK_V2_PRICING_PROFILE = BENCHMARK_V2_PRICING_PROFILE;
export const BENCHMARK_V2_PRICING = BENCHMARK_V2_PRICING_PROFILE;

export interface BenchmarkUsage {
  /** Total input tokens, including cachedInputTokens. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  /** Output tokens already include reasoningOutputTokens. */
  readonly outputTokens: number;
  /** Diagnostic only; never added to outputTokens for billing. */
  readonly reasoningOutputTokens?: number;
  /** Optional diagnostic meter; always uncharged. */
  readonly cacheWriteInputTokens?: number;
}

export interface BenchmarkCreditRecordInput {
  readonly model: string;
  readonly usage: Partial<BenchmarkUsage> | null | undefined;
  readonly actualCredits?: number | null;
}

export interface BenchmarkCreditRecord {
  readonly model: string;
  readonly usage: Partial<BenchmarkUsage> | null | undefined;
  /** Copied at record creation so later profile changes cannot rewrite history. */
  readonly pricingProfile: CreditPricingProfile;
  readonly rateCardCredits: number | null;
  readonly estimatedCredits: number | null;
  /** Supplied external accounting only; this module never derives it. */
  readonly actualCredits: number | null;
}

export interface ModelCreditTotal {
  readonly model: string;
  readonly rateCardCredits: number | null;
  readonly estimatedCredits: number | null;
}

export interface BenchmarkCreditSummary {
  readonly records: readonly BenchmarkCreditRecord[];
  readonly perModel: readonly ModelCreditTotal[];
  readonly totalRateCardCredits: number | null;
  readonly totalEstimatedCredits: number | null;
  /** Supplied external accounting only; never a sum of record actualCredits. */
  readonly actualCredits: number | null;
}

export interface BenchmarkCreditCalculationOptions {
  readonly pricingProfile?: CreditPricingProfile;
  readonly actualCredits?: number | null;
}

/** Copy a profile, including its nested rate table, into an immutable snapshot. */
export function copyPricingProfile(
  profile: CreditPricingProfile = BENCHMARK_V2_PRICING_PROFILE,
): CreditPricingProfile {
  return Object.freeze({
    profileId: profile.profileId,
    sourceUrl: profile.sourceUrl,
    snapshotDate: profile.snapshotDate,
    units: profile.units,
    applicability: profile.applicability,
    promotionalTerms: profile.promotionalTerms,
    rates: freezeRates({
      "gpt-5.6-sol": { ...profile.rates["gpt-5.6-sol"] },
      "gpt-5.6-luna": { ...profile.rates["gpt-5.6-luna"] },
    }),
  });
}

/** Return one historical record with a copied pricing snapshot. */
export function createBenchmarkCreditRecord(
  input: BenchmarkCreditRecordInput,
  pricingProfile: CreditPricingProfile = BENCHMARK_V2_PRICING_PROFILE,
): BenchmarkCreditRecord {
  const profile = copyPricingProfile(pricingProfile);
  const credits = calculateModelCredits(input.model, input.usage, profile);
  return {
    model: input.model,
    usage: input.usage,
    pricingProfile: profile,
    rateCardCredits: credits,
    estimatedCredits: credits,
    actualCredits: input.actualCredits ?? null,
  };
}

/**
 * Calculate one model's rate-card estimate. Null means the model, profile, or
 * one of the required input/cached-input/output fields is unavailable.
 */
export function calculateModelCredits(
  model: string,
  usage: Partial<BenchmarkUsage> | null | undefined,
  pricingProfile: CreditPricingProfile = BENCHMARK_V2_PRICING_PROFILE,
): number | null {
  if (
    !isKnownModel(model) ||
    !isValidProfile(pricingProfile) ||
    !isCompleteUsage(usage)
  ) {
    return null;
  }
  const rates = pricingProfile.rates[model];
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens;
  const credits =
    (uncachedInputTokens * rates.input) / 1_000_000 +
    (usage.cachedInputTokens * rates.cachedInput) / 1_000_000 +
    (usage.outputTokens * rates.output) / 1_000_000;
  return Number.isFinite(credits) ? credits : null;
}

/** Alias emphasizing that this is an estimate from the supplied rate card. */
export const calculateEstimatedCredits = calculateModelCredits;

/**
 * Calculate each record, aggregate by model, and calculate a total only when
 * every record has complete known usage. `actualCredits` is caller-supplied.
 */
export function calculateBenchmarkCredits(
  inputs: readonly BenchmarkCreditRecordInput[],
  options: BenchmarkCreditCalculationOptions = {},
): BenchmarkCreditSummary {
  const profile = options.pricingProfile ?? BENCHMARK_V2_PRICING_PROFILE;
  const records = Array.isArray(inputs)
    ? inputs.map((input) => createBenchmarkCreditRecord(input, profile))
    : [];
  return summarizeBenchmarkCredits(records, options.actualCredits ?? null);
}

/** Summarize already-created historical records without resolving a global profile. */
export function summarizeBenchmarkCredits(
  records: readonly BenchmarkCreditRecord[],
  actualCredits: number | null = null,
): BenchmarkCreditSummary {
  const safeRecords = Array.isArray(records) ? records.slice() : [];
  const models = [...new Set(safeRecords.map((record) => record.model))];
  const perModel = models.map((model): ModelCreditTotal => {
    const modelRecords = safeRecords.filter((record) => record.model === model);
    const complete = modelRecords.every((record) => record.rateCardCredits !== null);
    const total = complete
      ? sum(modelRecords.map((record) => record.rateCardCredits as number))
      : null;
    return { model, rateCardCredits: total, estimatedCredits: total };
  });
  const complete =
    safeRecords.length > 0 &&
    safeRecords.every((record) => record.rateCardCredits !== null);
  const total = complete
    ? sum(safeRecords.map((record) => record.rateCardCredits as number))
    : null;
  return {
    records: safeRecords,
    perModel,
    totalRateCardCredits: total,
    totalEstimatedCredits: total,
    actualCredits,
  };
}

function isKnownModel(value: unknown): value is BenchmarkModel {
  return (
    typeof value === "string" &&
    (BENCHMARK_V2_MODELS as readonly string[]).includes(value)
  );
}

function isCompleteUsage(value: unknown): value is BenchmarkUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<BenchmarkUsage>;
  if (
    !hasFiniteTokenCount(usage.inputTokens) ||
    !hasFiniteTokenCount(usage.cachedInputTokens) ||
    !hasFiniteTokenCount(usage.outputTokens) ||
    usage.cachedInputTokens > usage.inputTokens
  ) {
    return false;
  }
  return (
    (usage.reasoningOutputTokens === undefined ||
      hasFiniteTokenCount(usage.reasoningOutputTokens)) &&
    (usage.cacheWriteInputTokens === undefined ||
      hasFiniteTokenCount(usage.cacheWriteInputTokens))
  );
}

function hasFiniteTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidProfile(value: unknown): value is CreditPricingProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as CreditPricingProfile;
  if (
    typeof profile.profileId !== "string" ||
    typeof profile.sourceUrl !== "string" ||
    typeof profile.snapshotDate !== "string" ||
    profile.units !== BENCHMARK_V2_PRICING_UNITS ||
    typeof profile.applicability !== "string" ||
    (profile.promotionalTerms !== null && typeof profile.promotionalTerms !== "string") ||
    !profile.rates ||
    typeof profile.rates !== "object"
  ) {
    return false;
  }
  return BENCHMARK_V2_MODELS.every((model) => {
    const rates = profile.rates[model];
    return (
      rates !== undefined &&
      hasFiniteTokenCount(rates.input) &&
      hasFiniteTokenCount(rates.cachedInput) &&
      hasFiniteTokenCount(rates.output) &&
      rates.cacheWrite === 0
    );
  });
}

function sum(values: readonly number[]): number | null {
  const total = values.reduce((current, value) => current + value, 0);
  return Number.isFinite(total) ? total : null;
}
