/**
 * Pure, post-hoc cost primitives. This module deliberately has no model,
 * account, environment, network, estimation, or routing discovery.
 */

export type ParentIdentitySource = "supported-runtime" | "controller" | "request";

export interface ParentIdentityEvidence {
  readonly model: string;
  readonly source: ParentIdentitySource;
  readonly detail: string;
  readonly observedAt: string;
}

export interface UnknownParentIdentity {
  readonly status: "unknown";
  readonly reason: "not-provided" | "invalid-evidence" | "conflicting-evidence";
}

export interface KnownParentIdentity {
  readonly status: "known";
  readonly model: string;
  readonly provenance: readonly ParentIdentityEvidence[];
}

export type ParentIdentity = UnknownParentIdentity | KnownParentIdentity;

export const UNKNOWN_PARENT_IDENTITY: UnknownParentIdentity = Object.freeze({
  status: "unknown",
  reason: "not-provided",
});

export function unknownParentIdentity(): UnknownParentIdentity {
  return UNKNOWN_PARENT_IDENTITY;
}

/** Resolve only explicit evidence, returning unknown on invalid or conflicting claims. */
export function resolveParentIdentity(
  evidence: readonly ParentIdentityEvidence[],
): ParentIdentity {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return UNKNOWN_PARENT_IDENTITY;
  }
  if (evidence.some((entry) => !isParentIdentityEvidence(entry))) {
    return { status: "unknown", reason: "invalid-evidence" };
  }
  const model = evidence[0]?.model;
  if (!model || evidence.some((entry) => entry.model !== model)) {
    return { status: "unknown", reason: "conflicting-evidence" };
  }
  return { status: "known", model, provenance: evidence.map((entry) => ({ ...entry })) };
}

export const KNOWN_BILLING_CONTEXT_KINDS = [
  "api",
  "purchased-codex-credits",
  "included-subscription",
  "legacy",
  "other",
] as const;

export const BILLING_CONTEXT_KINDS = [...KNOWN_BILLING_CONTEXT_KINDS, "unknown"] as const;

export type KnownBillingContextKind = (typeof KNOWN_BILLING_CONTEXT_KINDS)[number];
export type BillingContextKind = (typeof BILLING_CONTEXT_KINDS)[number];

export interface KnownBillingContext {
  readonly kind: KnownBillingContextKind;
  /** Caller-owned identifier for the underlying charging arrangement. */
  readonly contextId: string;
}

export interface UnknownBillingContext {
  readonly kind: "unknown";
  readonly reason: "not-provided";
}

export type BillingContext = KnownBillingContext | UnknownBillingContext;

export const UNKNOWN_BILLING_CONTEXT: UnknownBillingContext = Object.freeze({
  kind: "unknown",
  reason: "not-provided",
});

export function billingContext(
  kind: KnownBillingContextKind,
  contextId: string,
): BillingContext {
  return isKnownBillingContextKind(kind) && isNonEmptyString(contextId)
    ? { kind, contextId }
    : UNKNOWN_BILLING_CONTEXT;
}

export type UsageMeter =
  "uncachedInputTokens" | "cachedInputTokens" | "cacheWriteInputTokens" | "outputTokens";

export const USAGE_METERS: readonly UsageMeter[] = [
  "uncachedInputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
];

/**
 * Complete billing-ready quantities. This is intentionally not the raw Codex SDK
 * usage shape: callers must explicitly classify total input into compatible meters.
 */
export type MeteredUsage = Record<UsageMeter, number>;

export type RateBasis = "per-token" | "per-1k-tokens" | "per-1m-tokens";

export type ChargeUnit =
  | { readonly kind: "currency"; readonly code: string }
  | { readonly kind: "credits"; readonly system: string }
  | { readonly kind: "other"; readonly name: string };

export interface RateCardProvenance {
  readonly sourceUrl: string;
  readonly retrievedAt: string;
}

export interface RateCardApplicability {
  readonly model: string;
  readonly billingKind: KnownBillingContextKind;
  readonly billingContextId: string;
}

export interface RateCard {
  readonly provenance: RateCardProvenance;
  readonly applicability: RateCardApplicability;
  readonly effectiveFrom: string;
  /** Null means the effective period has no declared upper bound. */
  readonly effectiveUntil: string | null;
  readonly freshUntil: string;
  readonly rateBasis: RateBasis;
  readonly chargeUnit: ChargeUnit;
  readonly rates: Partial<Record<UsageMeter, number>>;
}

export interface PostHocCostInput {
  readonly usage: MeteredUsage;
  readonly parentIdentity: ParentIdentity;
  readonly billingContext: BillingContext;
  readonly rateCard: RateCard;
  /** When the supplied usage occurred, used for rate-card effectiveness. */
  readonly usageOccurredAt: string;
  /** When this calculation is performed, used for provenance freshness. */
  readonly calculatedAt: string;
}

export type CostUnavailableReason =
  | "missing-usage"
  | "invalid-usage"
  | "unknown-parent-identity"
  | "unknown-billing-context"
  | "missing-rate-card"
  | "invalid-rate-card"
  | "invalid-calculation-time"
  | "inapplicable-rate-card"
  | "rate-card-not-effective"
  | "rate-card-expired"
  | "rate-card-stale"
  | "missing-rate"
  | "non-finite-result";

export interface UnavailableCostResult {
  readonly status: "unavailable";
  readonly kind: "qualitative";
  readonly reason: CostUnavailableReason;
}

export interface CalculatedCostResult {
  readonly status: "calculated";
  readonly kind: "quantitative";
  /** Applying supplied rates to supplied observed usage; this is not an invoice. */
  readonly basis: "supplied-rates-and-observed-usage";
  readonly amount: number;
  readonly chargeUnit: ChargeUnit;
  readonly rateBasis: RateBasis;
  readonly usage: MeteredUsage;
  readonly parentModel: string;
  readonly billingContext: KnownBillingContext;
  readonly rateCardProvenance: RateCardProvenance;
  readonly usageOccurredAt: string;
  readonly calculatedAt: string;
}

export type PostHocCostResult = CalculatedCostResult | UnavailableCostResult;

export function calculatePostHocCost(input: PostHocCostInput): PostHocCostResult {
  if (!input || typeof input !== "object" || !input.usage) {
    return unavailable("missing-usage");
  }
  if (!isMeteredUsage(input.usage)) return unavailable("invalid-usage");
  if (!isKnownParentIdentity(input.parentIdentity)) {
    return unavailable("unknown-parent-identity");
  }
  if (!isKnownBillingContext(input.billingContext)) {
    return unavailable("unknown-billing-context");
  }
  if (!input.rateCard) return unavailable("missing-rate-card");
  if (!isValidRateCard(input.rateCard)) return unavailable("invalid-rate-card");

  const usageOccurredAt = timestamp(input.usageOccurredAt);
  const calculatedAt = timestamp(input.calculatedAt);
  if (usageOccurredAt === null || calculatedAt === null) {
    return unavailable("invalid-calculation-time");
  }
  if (calculatedAt < usageOccurredAt) {
    return unavailable("invalid-calculation-time");
  }
  const retrievedAt = timestamp(input.rateCard.provenance.retrievedAt);
  const effectiveFrom = timestamp(input.rateCard.effectiveFrom);
  const effectiveUntil =
    input.rateCard.effectiveUntil === null
      ? null
      : timestamp(input.rateCard.effectiveUntil);
  const freshUntil = timestamp(input.rateCard.freshUntil);
  if (retrievedAt === null || effectiveFrom === null || freshUntil === null) {
    return unavailable("invalid-rate-card");
  }
  if (retrievedAt > calculatedAt) return unavailable("invalid-rate-card");
  if (
    input.rateCard.applicability.model !== input.parentIdentity.model ||
    input.rateCard.applicability.billingKind !== input.billingContext.kind ||
    input.rateCard.applicability.billingContextId !== input.billingContext.contextId
  ) {
    return unavailable("inapplicable-rate-card");
  }
  if (usageOccurredAt < effectiveFrom) return unavailable("rate-card-not-effective");
  if (effectiveUntil !== null && usageOccurredAt > effectiveUntil) {
    return unavailable("rate-card-expired");
  }
  if (calculatedAt > freshUntil) return unavailable("rate-card-stale");

  const divisor = rateDivisor(input.rateCard.rateBasis);
  let amount = 0;
  for (const meter of USAGE_METERS) {
    const quantity = input.usage[meter];
    if (quantity === 0) continue;
    const rate = input.rateCard.rates[meter];
    if (rate === undefined) return unavailable("missing-rate");
    amount += (quantity * rate) / divisor;
  }
  if (!Number.isFinite(amount)) return unavailable("non-finite-result");

  return {
    status: "calculated",
    kind: "quantitative",
    basis: "supplied-rates-and-observed-usage",
    amount,
    chargeUnit: { ...input.rateCard.chargeUnit },
    rateBasis: input.rateCard.rateBasis,
    usage: { ...input.usage },
    parentModel: input.parentIdentity.model,
    billingContext: { ...input.billingContext },
    rateCardProvenance: { ...input.rateCard.provenance },
    usageOccurredAt: input.usageOccurredAt,
    calculatedAt: input.calculatedAt,
  };
}

function unavailable(reason: CostUnavailableReason): UnavailableCostResult {
  return { status: "unavailable", kind: "qualitative", reason };
}

function isMeteredUsage(value: unknown): value is MeteredUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<Record<UsageMeter, unknown>>;
  const keys = Object.keys(usage);
  if (
    keys.length !== USAGE_METERS.length ||
    keys.some((key) => !USAGE_METERS.includes(key as UsageMeter))
  ) {
    return false;
  }
  return USAGE_METERS.every((meter) => isTokenCount(usage[meter]));
}

function isKnownParentIdentity(value: unknown): value is KnownParentIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as KnownParentIdentity;
  return (
    identity.status === "known" &&
    isNonEmptyString(identity.model) &&
    Array.isArray(identity.provenance) &&
    identity.provenance.length > 0 &&
    identity.provenance.every(
      (entry) => isParentIdentityEvidence(entry) && entry.model === identity.model,
    )
  );
}

function isParentIdentityEvidence(value: unknown): value is ParentIdentityEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as ParentIdentityEvidence;
  return (
    isNonEmptyString(evidence.model) &&
    isParentIdentitySource(evidence.source) &&
    isNonEmptyString(evidence.detail) &&
    isDateString(evidence.observedAt)
  );
}

function isKnownBillingContext(value: unknown): value is KnownBillingContext {
  if (!value || typeof value !== "object") return false;
  const context = value as KnownBillingContext;
  return isKnownBillingContextKind(context.kind) && isNonEmptyString(context.contextId);
}

function isValidRateCard(rateCard: RateCard): boolean {
  if (!rateCard || typeof rateCard !== "object") return false;
  if (
    !isHttpUrl(rateCard.provenance?.sourceUrl) ||
    !isDateString(rateCard.provenance?.retrievedAt)
  ) {
    return false;
  }
  if (
    !isNonEmptyString(rateCard.applicability?.model) ||
    !isKnownBillingContextKind(rateCard.applicability?.billingKind) ||
    !isNonEmptyString(rateCard.applicability?.billingContextId)
  ) {
    return false;
  }
  const retrievedAt = timestamp(rateCard.provenance.retrievedAt);
  const effectiveFrom = timestamp(rateCard.effectiveFrom);
  const effectiveUntil =
    rateCard.effectiveUntil === null ? null : timestamp(rateCard.effectiveUntil);
  const freshUntil = timestamp(rateCard.freshUntil);
  if (
    retrievedAt === null ||
    effectiveFrom === null ||
    freshUntil === null ||
    freshUntil < retrievedAt ||
    freshUntil < effectiveFrom ||
    (rateCard.effectiveUntil !== null &&
      (effectiveUntil === null || effectiveUntil < effectiveFrom))
  ) {
    return false;
  }
  if (!isRateBasis(rateCard.rateBasis) || !isChargeUnit(rateCard.chargeUnit)) {
    return false;
  }
  if (!rateCard.rates || typeof rateCard.rates !== "object") return false;
  for (const key of Object.keys(rateCard.rates)) {
    if (!USAGE_METERS.includes(key as UsageMeter)) return false;
    const rate = rateCard.rates[key as UsageMeter];
    if (rate === undefined || !Number.isFinite(rate) || rate < 0) return false;
  }
  return true;
}

function rateDivisor(rateBasis: RateBasis): number {
  if (rateBasis === "per-1k-tokens") return 1_000;
  if (rateBasis === "per-1m-tokens") return 1_000_000;
  return 1;
}

function isParentIdentitySource(value: unknown): value is ParentIdentitySource {
  return value === "supported-runtime" || value === "controller" || value === "request";
}

function isKnownBillingContextKind(value: unknown): value is KnownBillingContextKind {
  return (
    typeof value === "string" &&
    (KNOWN_BILLING_CONTEXT_KINDS as readonly string[]).includes(value)
  );
}

function isRateBasis(value: unknown): value is RateBasis {
  return value === "per-token" || value === "per-1k-tokens" || value === "per-1m-tokens";
}

function isChargeUnit(value: unknown): value is ChargeUnit {
  if (!value || typeof value !== "object") return false;
  const unit = value as ChargeUnit;
  if (unit.kind === "currency") return isNonEmptyString(unit.code);
  if (unit.kind === "credits") return isNonEmptyString(unit.system);
  return unit.kind === "other" && isNonEmptyString(unit.name);
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && timestamp(value) !== null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
