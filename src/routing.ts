/**
 * Cheap routing eligibility / preflight.
 *
 * A delegation costs a fixed amount of supervisor and worker overhead before it
 * produces anything. The expensive way to discover that a seam was not worth
 * delegating is to delegate it. This module is the cheap way: a pure, synchronous
 * evaluation of a small structured declaration the parent already knows, decided
 * before any repository exploration, worktree, thread, or worker exists.
 *
 * Two ideas keep it honest.
 *
 * Raw vs resolved. Hard structural gates read only what the caller explicitly
 * declared, so uncertainty can never manufacture a refusal. Advisory routing
 * reads conservatively resolved values, so uncertainty does bias the
 * recommendation toward staying Solo. The two never mix.
 *
 * Refuse vs recommend. The runtime refuses only when an explicit declaration
 * makes the requested execution *mechanism* structurally unsound — parallel
 * workers over mutable shared state, say. Economic and coupling judgements
 * recommend Solo and nothing more; the parent keeps the decision.
 *
 * Deliberately absent: filesystem access, child processes, network, model calls,
 * repo-wide analysis, weighted scores, numeric thresholds, effort, and worker
 * counts. This file must stay trivially cheap to run and trivially easy to
 * reason about, and it must never import benchmark code.
 */

/** Per-seam work volume. Not difficulty, and never an effort input. */
export const SEAM_SIZES = ["small", "substantial", "unknown"] as const;
export type SeamSize = (typeof SEAM_SIZES)[number];

/**
 * State or invariants shared between a seam and either another seam or the
 * parent's remaining work.
 */
export const SHARED_STATES = ["none", "read-only", "mutable", "unknown"] as const;
export type SharedState = (typeof SHARED_STATES)[number];

/**
 * Whether delegated work is isolated from files/modules the sibling seams or the
 * parent still need to reason about.
 */
export const CORE_OVERLAPS = ["disjoint", "shared-core", "unknown"] as const;
export type CoreOverlap = (typeof CORE_OVERLAPS)[number];

/** How the finished seams come back together. */
export const INTEGRATIONS = ["mechanical", "architectural", "unknown"] as const;
export type Integration = (typeof INTEGRATIONS)[number];

/** Whether each seam can be proven on its own. */
export const VERIFICATIONS = ["per-seam", "shared-only", "unknown"] as const;
export type Verification = (typeof VERIFICATIONS)[number];

/** Advisory outcomes. Only `solo` is a recommendation against delegating. */
export const ROUTING_ROUTES = ["solo", "either", "delegation-plausible"] as const;
export type RoutingRoute = (typeof ROUTING_ROUTES)[number];

/**
 * Surface the card is being evaluated against.
 *
 * `preflight` is the mode-agnostic advisory surface: it refuses nothing, and the
 * parallel-mechanism gates simply do not apply to it.
 */
export const ROUTING_MODES = ["preflight", "single", "sequential", "parallel"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/** Hard structural gates. Every one of these reads raw declarations only. */
export const ROUTING_GATES = [
  "seam-count-zero",
  "parallel-shared-mutable",
  "parallel-shared-core",
  "parallel-tasks-exceed-seams",
] as const;
export type RoutingGate = (typeof ROUTING_GATES)[number];

/** Decisive coupling signals. Any one of them recommends Solo, in every mode. */
export const TIER_1_SIGNALS = [
  "shared-mutable-state",
  "shared-core",
  "architectural-integration",
] as const;
export type Tier1Signal = (typeof TIER_1_SIGNALS)[number];

/** Overhead / weak-independence signals. Two recommend Solo; one is ambiguous. */
export const TIER_2_SIGNALS = ["small-seam", "shared-verification-only"] as const;
export type Tier2Signal = (typeof TIER_2_SIGNALS)[number];

/** Shape advisories that never affect the route. */
export const ROUTE_NEUTRAL_ADVISORIES = [
  "single-seam-batch",
  "steps-exceed-seams",
] as const;
export type RouteNeutralAdvisory = (typeof ROUTE_NEUTRAL_ADVISORIES)[number];

export type RoutingSignal = Tier1Signal | Tier2Signal | RouteNeutralAdvisory;

/** Longest accepted seam label. Labels stay short because they are never needed. */
export const MAX_SEAM_LABEL_LENGTH = 48;

/**
 * One declaration per delegation call, not per task.
 *
 * Seam labels exist only to make the parent's own decomposition legible in the
 * returned text. They are never persisted in telemetry, so they must stay short
 * and non-sensitive.
 */
export interface RoutingPreflightCard {
  seams: string[];
  seamSize: SeamSize;
  sharedState: SharedState;
  coreOverlap: CoreOverlap;
  integration: Integration;
  verification: Verification;
}

/**
 * The raw declared card values, and nothing else, in telemetry field names.
 *
 * This is the only projection of a card that is allowed to be persisted, which is
 * what makes "seam labels are never stored" a property of the code rather than a
 * promise: the labels are dropped here, at the single boundary every writer goes
 * through.
 */
export type DeclaredRoutingFields = {
  declaredSeamSize: SeamSize;
  declaredSharedState: SharedState;
  declaredCoreOverlap: CoreOverlap;
  declaredIntegration: Integration;
  declaredVerification: Verification;
};

export function declaredRoutingFields(card: RoutingPreflightCard): DeclaredRoutingFields {
  return {
    declaredSeamSize: card.seamSize,
    declaredSharedState: card.sharedState,
    declaredCoreOverlap: card.coreOverlap,
    declaredIntegration: card.integration,
    declaredVerification: card.verification,
  };
}

/** Conservatively resolved values. Advisory routing reads only these. */
export interface ResolvedRoutingValues {
  seamSize: Exclude<SeamSize, "unknown">;
  sharedState: Exclude<SharedState, "unknown">;
  coreOverlap: Exclude<CoreOverlap, "unknown">;
  integration: Exclude<Integration, "unknown">;
  verification: Exclude<Verification, "unknown">;
}

export interface RoutingEvaluation {
  route: RoutingRoute;
  seamCount: number;
  /** How many of the five declared fields were left `unknown` by the caller. */
  unknownCount: number;
  /** Hard gates that fired for this mode, in declaration order. */
  gates: RoutingGate[];
  /** Advisory signals and route-neutral advisories, in declaration order. */
  signals: RoutingSignal[];
  /**
   * Structural plausibility of a parallel decomposition, from raw declarations
   * only. Not a recommendation, not a worker count, not a concurrency input.
   * May be true while `route` is `"solo"`.
   */
  parallelEligible: boolean;
  /** Conservatively resolved advisory inputs, exposed for rendering and tests. */
  resolved: ResolvedRoutingValues;
  /** The single gate a refusing surface should refuse on, or null. */
  refusedGate: RoutingGate | null;
}

/**
 * Which surface is asking, which decides whether a fired gate refuses.
 *
 * `routing_preflight` refuses nothing at all; `single` and `sequential` refuse
 * only on an empty seam list; `parallel` refuses on every parallel gate, with
 * `allowOverlappingScopes` downgrading shared-core to a warning.
 */
export interface RoutingContext {
  mode: RoutingMode;
  /** Tasks in the requested call. Only the batch modes use it. */
  taskCount?: number;
  /** Parallel-only escape hatch. Downgrades G3 only; G2 still refuses. */
  allowOverlappingScopes?: boolean;
}

/**
 * Advisory resolution, stated exhaustively rather than as a fallback.
 *
 * Written as total maps keyed by the whole vocabulary, so adding a declarable
 * value is a compile error until someone decides what it means for advice. A
 * `x === "unknown" ? cautious : x` expression would instead have accepted the new
 * value silently and treated it as a non-hazard — fail-open, in the one place
 * whose entire purpose is to fail toward Solo.
 */
const SEAM_SIZE_RESOLUTION = {
  small: "small",
  substantial: "substantial",
  unknown: "small",
} as const satisfies Record<SeamSize, Exclude<SeamSize, "unknown">>;

const SHARED_STATE_RESOLUTION = {
  none: "none",
  "read-only": "read-only",
  mutable: "mutable",
  unknown: "mutable",
} as const satisfies Record<SharedState, Exclude<SharedState, "unknown">>;

const CORE_OVERLAP_RESOLUTION = {
  disjoint: "disjoint",
  "shared-core": "shared-core",
  unknown: "shared-core",
} as const satisfies Record<CoreOverlap, Exclude<CoreOverlap, "unknown">>;

const INTEGRATION_RESOLUTION = {
  mechanical: "mechanical",
  architectural: "architectural",
  unknown: "architectural",
} as const satisfies Record<Integration, Exclude<Integration, "unknown">>;

const VERIFICATION_RESOLUTION = {
  "per-seam": "per-seam",
  "shared-only": "shared-only",
  unknown: "shared-only",
} as const satisfies Record<Verification, Exclude<Verification, "unknown">>;

/**
 * Unknown resolves to whichever value most favours staying Solo.
 *
 * This is the only place uncertainty is interpreted, and it feeds advisory
 * routing exclusively. A caller who declares nothing gets a Solo recommendation
 * and no refusal, which is the intended asymmetry.
 */
export function resolveRoutingValues(card: RoutingPreflightCard): ResolvedRoutingValues {
  return {
    seamSize: SEAM_SIZE_RESOLUTION[card.seamSize],
    sharedState: SHARED_STATE_RESOLUTION[card.sharedState],
    coreOverlap: CORE_OVERLAP_RESOLUTION[card.coreOverlap],
    integration: INTEGRATION_RESOLUTION[card.integration],
    verification: VERIFICATION_RESOLUTION[card.verification],
  };
}

/**
 * Which declared values are a stated hazard for a parallel decomposition.
 *
 * Total maps for the same reason as resolution: an inequality test (`!== "mutable"`)
 * would silently classify a future declarable value as safe. These read raw
 * declarations, so `unknown` is deliberately *not* a stated hazard — absence of a
 * stated hazard is not a stated hazard.
 */
const SHARED_STATE_BLOCKS_PARALLEL = {
  none: false,
  "read-only": false,
  mutable: true,
  unknown: false,
} as const satisfies Record<SharedState, boolean>;

const CORE_OVERLAP_BLOCKS_PARALLEL = {
  disjoint: false,
  "shared-core": true,
  unknown: false,
} as const satisfies Record<CoreOverlap, boolean>;

/** How many of the five declared fields the caller left `unknown`. */
export function countUnknowns(card: RoutingPreflightCard): number {
  return [
    card.seamSize,
    card.sharedState,
    card.coreOverlap,
    card.integration,
    card.verification,
  ].filter((value) => value === "unknown").length;
}

/**
 * Structural plausibility of splitting this work across parallel workers.
 *
 * Reads raw declarations only, so `unknown` does not force `false`: absence of a
 * stated hazard is not a stated hazard. Two or more seams with no explicitly
 * declared mutable shared state and no explicitly declared shared core are
 * structurally separable, whatever the advisory route says about whether that
 * separation is worth paying for.
 */
export function evaluateParallelEligibility(card: RoutingPreflightCard): boolean {
  return (
    card.seams.length >= 2 &&
    !SHARED_STATE_BLOCKS_PARALLEL[card.sharedState] &&
    !CORE_OVERLAP_BLOCKS_PARALLEL[card.coreOverlap]
  );
}

/** Hard gates, from raw declarations only, for the requested mechanism. */
function evaluateGates(
  card: RoutingPreflightCard,
  context: RoutingContext,
): RoutingGate[] {
  const gates: RoutingGate[] = [];
  if (card.seams.length === 0) gates.push("seam-count-zero");
  if (context.mode === "parallel") {
    if (SHARED_STATE_BLOCKS_PARALLEL[card.sharedState]) {
      gates.push("parallel-shared-mutable");
    }
    if (CORE_OVERLAP_BLOCKS_PARALLEL[card.coreOverlap]) {
      gates.push("parallel-shared-core");
    }
    if ((context.taskCount ?? 0) > card.seams.length) {
      gates.push("parallel-tasks-exceed-seams");
    }
  }
  return gates;
}

/**
 * The one gate this surface refuses on, or null.
 *
 * Gate order is the refusal order, so a batch that trips several gates always
 * reports the same one. An advisory surface never refuses; `single` and
 * `sequential` refuse only the universal structural gate; `parallel` refuses the
 * rest too, except shared-core once the caller has explicitly accepted overlap.
 */
function selectRefusedGate(
  gates: RoutingGate[],
  context: RoutingContext,
): RoutingGate | null {
  if (context.mode === "preflight") return null;
  for (const gate of gates) {
    if (gate === "seam-count-zero") return gate;
    if (context.mode !== "parallel") continue;
    if (gate === "parallel-shared-core" && context.allowOverlappingScopes) continue;
    return gate;
  }
  return null;
}

/** Decisive coupling signals, from resolved values, in every mode. */
function tier1Signals(resolved: ResolvedRoutingValues): Tier1Signal[] {
  const signals: Tier1Signal[] = [];
  // read-only shared state is deliberately absent: it is compatible with
  // independent delegated work and is not a coupling signal.
  if (resolved.sharedState === "mutable") signals.push("shared-mutable-state");
  if (resolved.coreOverlap === "shared-core") signals.push("shared-core");
  if (resolved.integration === "architectural") signals.push("architectural-integration");
  return signals;
}

/** Overhead / weak-independence signals, from resolved values. */
function tier2Signals(resolved: ResolvedRoutingValues): Tier2Signal[] {
  const signals: Tier2Signal[] = [];
  if (resolved.seamSize === "small") signals.push("small-seam");
  if (resolved.verification === "shared-only") signals.push("shared-verification-only");
  return signals;
}

/** Shape advisories that describe the call, without moving the route. */
function routeNeutralAdvisories(
  card: RoutingPreflightCard,
  context: RoutingContext,
): RouteNeutralAdvisory[] {
  const advisories: RouteNeutralAdvisory[] = [];
  const isBatch = context.mode === "sequential" || context.mode === "parallel";
  if (isBatch && card.seams.length === 1) advisories.push("single-seam-batch");
  if (context.mode === "sequential" && (context.taskCount ?? 0) > card.seams.length) {
    advisories.push("steps-exceed-seams");
  }
  return advisories;
}

/**
 * Evaluate one card against one requested mechanism.
 *
 * Pure and synchronous by contract: same inputs, same output, no observation of
 * anything outside its arguments.
 */
export function evaluateRouting(
  card: RoutingPreflightCard,
  context: RoutingContext,
): RoutingEvaluation {
  const resolved = resolveRoutingValues(card);
  const gates = evaluateGates(card, context);
  const tier1 = tier1Signals(resolved);
  const tier2 = tier2Signals(resolved);
  const signals: RoutingSignal[] = [
    ...tier1,
    ...tier2,
    ...routeNeutralAdvisories(card, context),
  ];

  // Ordered route table, first match wins. No weighted score, no numeric
  // economic score, no benchmark-tuned threshold.
  let route: RoutingRoute;
  if (card.seams.length === 0) {
    route = "solo"; // R0
  } else if (tier1.length > 0) {
    route = "solo"; // R1
  } else if (tier2.includes("small-seam") && card.seams.length <= 1) {
    route = "solo"; // R2
  } else if (tier2.length === 2) {
    route = "solo"; // R3
  } else if (tier2.length === 1) {
    route = "either"; // R4
  } else {
    route = "delegation-plausible"; // R5
  }

  return {
    route,
    seamCount: card.seams.length,
    unknownCount: countUnknowns(card),
    gates,
    signals,
    parallelEligible: evaluateParallelEligibility(card),
    resolved,
    refusedGate: selectRefusedGate(gates, context),
  };
}

/** Compact reason for a refusal, for the tool result and the rejection message. */
export function describeRefusal(gate: RoutingGate): string {
  switch (gate) {
    case "seam-count-zero":
      return (
        "The routing card declares no ownership seams, so there is nothing to own. " +
        "Handle the work solo, or declare the seams you intend to delegate."
      );
    case "parallel-shared-mutable":
      return (
        "The routing card declares mutable shared state, so parallel workers would " +
        'race over it. Use mode:"sequential", or handle the work solo.'
      );
    case "parallel-shared-core":
      return (
        "The routing card declares a shared core, so parallel seams would both need " +
        'to reason about it. Use mode:"sequential", handle the work solo, or set ' +
        "allowOverlappingScopes:true to accept the overlap deliberately."
      );
    case "parallel-tasks-exceed-seams":
      return (
        "This parallel call requests more tasks than the routing card declares seams, " +
        "so at least two tasks would share one seam. Declare every seam, reduce the " +
        'tasks, or use mode:"sequential".'
      );
  }
}

/** Compact per-route guidance. `either` must not read as "delegate by default". */
function describeRoute(route: RoutingRoute): string {
  switch (route) {
    case "solo":
      return "stay solo unless you judge otherwise";
    case "either":
      return "fixed delegation overhead needs explicit justification, else stay solo";
    case "delegation-plausible":
      return "delegation is plausible; you still own the decision";
  }
}

/**
 * One compact advisory line for a delegation that actually ran.
 *
 * Returns null when routing has nothing useful to add, so the ordinary
 * delegation path stays byte-for-byte what it was. Nothing here is a refusal:
 * the call already executed, and the line exists so the parent can see the
 * recommendation it overrode rather than discovering it in telemetry later.
 */
export function renderRoutingAdvisory(evaluation: RoutingEvaluation): string | null {
  const neutral = evaluation.signals.filter((signal): signal is RouteNeutralAdvisory =>
    (ROUTE_NEUTRAL_ADVISORIES as readonly string[]).includes(signal),
  );
  const deciding = evaluation.signals.filter(
    (signal) => !(ROUTE_NEUTRAL_ADVISORIES as readonly string[]).includes(signal),
  );
  if (evaluation.route === "delegation-plausible" && neutral.length === 0) return null;

  // Deciding signals are resolved values, so some of them may be the cautious
  // reading of an `unknown` the caller never declared. Naming the unknown count
  // beside them is what keeps the line from reading as a claim about what the
  // caller said. An empty seam list reaches solo with no deciding signal at all,
  // so the parenthetical has to be able to disappear rather than render as "()".
  const assumed = evaluation.unknownCount > 0 ? `unknown ${evaluation.unknownCount}` : "";
  const reasons = [...deciding, assumed].filter(Boolean);
  const because = reasons.length > 0 ? ` (${reasons.join(",")})` : "";
  const parts: string[] = [];
  if (evaluation.route === "solo") {
    parts.push(
      `solo advised${because}; executed as requested, the parent owns this judgement`,
    );
  } else if (evaluation.route === "either") {
    parts.push(
      `either${because}; fixed delegation overhead needs explicit justification, else solo`,
    );
  }
  for (const advisory of neutral) {
    parts.push(
      advisory === "single-seam-batch"
        ? "one declared seam; delegate_task needs no scheduling"
        : "more tasks than declared seams; consider delegate_task plus continue_task",
    );
  }
  return `ROUTING: ${parts.join(" | ")}`;
}

/**
 * Render an evaluation as compact advisory text.
 *
 * Budgeted, and deliberately free of seam labels: the parent already knows its
 * own decomposition, so echoing it back would spend metadata to say nothing. The
 * caller's own judgement is named explicitly so the advice cannot read as an
 * instruction.
 */
export function renderRoutingPreflight(evaluation: RoutingEvaluation): string {
  const listed = evaluation.signals.length > 0 ? evaluation.signals.join(",") : "none";
  const lines = [
    `ROUTE: ${evaluation.route} | seams ${evaluation.seamCount} | unknown ${evaluation.unknownCount}`,
    `SIGNALS: ${listed}`,
    `PARALLEL-ELIGIBLE: ${evaluation.parallelEligible} (structural only; not a worker count)`,
    `ADVISORY: ${describeRoute(evaluation.route)}. Nothing was created; no delegation is required.`,
  ];
  if (evaluation.gates.length > 0) {
    lines.splice(2, 0, `GATES: ${evaluation.gates.join(",")} (advisory here)`);
  }
  return lines.join("\n");
}
