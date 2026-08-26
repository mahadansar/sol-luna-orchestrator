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
 * repo-wide analysis, weighted scores, and benchmark-tuned thresholds. The single
 * import is type-only, so at runtime this module still depends on nothing at all
 * and still reads nothing but its arguments: the compute envelope a recommended
 * shape is bounded by is passed in, never read from the process. This file must
 * stay trivially cheap to run and trivially easy to reason about, and it must
 * never import benchmark code.
 */
import type { Effort } from "./config.js";

/** Per-seam work volume. Not difficulty; the one input to a starting effort. */
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
 * The policy facts a recommended shape is bounded by.
 *
 * Declared structurally rather than imported, which is what lets this module keep
 * its runtime independence: `ComputePolicy` satisfies it as it stands, and the
 * caller passes the envelope it has already resolved. Routing therefore cannot
 * reach for a process-wide baseline and recommend a shape against an envelope the
 * call was never going to run under.
 */
export interface ComputeEnvelope {
  readonly allowedEfforts: readonly Effort[];
  readonly maxConcurrency: number;
  readonly maxWorkersPerBatch: number;
}

/**
 * The mechanism a recommendation names, in the runtime's own tool vocabulary.
 *
 * `solo` is a real member rather than an absence, so a solo recommendation says
 * "no mechanism" in the very field the delegated shapes use. No consumer can read
 * a delegation tool out of a recommendation against delegating.
 */
export const EXECUTION_MECHANISMS = [
  "solo",
  "delegate_task",
  "delegate_tasks_sequential",
  "delegate_tasks_parallel",
] as const;
export type ExecutionMechanism = (typeof EXECUTION_MECHANISMS)[number];

/**
 * One bounded recommendation. Never a permission, and never above the envelope.
 *
 * `effort` is a *starting* effort rather than a ceiling to aim for: raising effort
 * on failure evidence is the retry ladder's decision, and a five-field card
 * declared before any exploration is not evidence. `workerCount` is what the
 * envelope actually permits, so a card declaring more seams than one call may
 * enlist reports the remainder in `seamsOverCap` instead of quietly shrinking the
 * work to fit.
 */
export interface ExecutionShape {
  mechanism: ExecutionMechanism;
  /** Starting effort inside the envelope; null when nothing is delegated. */
  effort: Effort | null;
  /** Workers this shape enlists. Zero exactly when the mechanism is solo. */
  workerCount: number;
  /** How many of those run at once. One when staggered, zero when solo. */
  concurrency: number;
  /** Declared seams beyond what one call may enlist here. Usually zero. */
  seamsOverCap: number;
}

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
  /**
   * The bounded shape recommendation, or null when no envelope was supplied.
   *
   * Null rather than a guess: every number in a shape belongs to the operator, so
   * a caller that names no envelope gets no shape rather than one silently
   * measured against whatever this process happens to permit.
   */
  shape: ExecutionShape | null;
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
  /**
   * Envelope to bound a shape recommendation by. Omit it and `shape` is null;
   * routing never substitutes an envelope of its own.
   */
  envelope?: ComputeEnvelope;
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
 * would silently classify a future declarable value as safe.
 *
 * One table, read twice. `evaluateParallelEligibility` feeds it raw declarations,
 * where `unknown` is deliberately *not* a stated hazard — absence of a stated
 * hazard is not a stated hazard. `recommendExecutionShape` feeds it resolved
 * values, where `unknown` has already become the hazard. The raw/resolved
 * distinction therefore lives entirely in what is fed to the table, rather than in
 * a second copy of it that could drift.
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

/**
 * Whether one seam can be proven on its own, which is what makes concurrent
 * workers worth their coordination rather than merely structurally legal.
 *
 * Read with resolved values only. Shared-only proof does not make parallel work
 * unsound — nothing races — so it is not a gate; it means N seams would come back
 * at once with no way to say which of them holds, and staggering them costs
 * nothing a batch was not paying already.
 */
const VERIFICATION_ALLOWS_CONCURRENCY = {
  "per-seam": true,
  "shared-only": false,
  unknown: false,
} as const satisfies Record<Verification, boolean>;

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
 * Ascending effort order, as a total map over the whole vocabulary.
 *
 * A new effort level is a compile error here rather than an unranked value that
 * silently compares as `undefined` and sorts to the bottom.
 */
export const EFFORT_RANK = {
  medium: 0,
  high: 1,
  xhigh: 2,
  max: 3,
} as const satisfies Record<Effort, number>;

/**
 * The starting effort a resolved seam size asks for, before the envelope.
 *
 * Deliberately not "the most the policy allows". A preflight has read a
 * five-field card and nothing else, which is not evidence for spending a ceiling,
 * and recommending the ceiling for every substantial seam would leave the failure
 * ladder nothing to escalate to. The preference tops out at `high`, so `xhigh` and
 * `max` are never selected here; they stay where they already live, behind real
 * failure evidence and the operator's escalation permission.
 */
const SEAM_SIZE_EFFORT = {
  small: "medium",
  substantial: "high",
} as const satisfies Record<Exclude<SeamSize, "unknown">, Effort>;

/**
 * The nearest permitted effort at or below a preference.
 *
 * Clamps downward, so an envelope can only ever lower what routing asks for. An
 * envelope whose every level sits above the preference is not widened to meet it:
 * its own floor is taken, because that is the least compute the operator left
 * available. Returns null only for an empty list, which the policy schema forbids
 * and which this function still declines to invent a value for.
 */
export function boundEffort(
  preferred: Effort,
  allowed: readonly Effort[],
): Effort | null {
  let atOrBelow: Effort | null = null;
  let floor: Effort | null = null;
  for (const effort of allowed) {
    if (floor === null || EFFORT_RANK[effort] < EFFORT_RANK[floor]) floor = effort;
    if (EFFORT_RANK[effort] > EFFORT_RANK[preferred]) continue;
    if (atOrBelow === null || EFFORT_RANK[effort] > EFFORT_RANK[atOrBelow]) {
      atOrBelow = effort;
    }
  }
  return atOrBelow ?? floor;
}

/** Whole non-negative bound, so a structurally typed envelope stays total. */
function wholeBound(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * The shape of a recommendation against delegating.
 *
 * A fresh object per call rather than a shared constant: an evaluation is a value
 * its caller owns, and one consumer mutating a shared solo shape would reach
 * every other.
 */
function soloShape(): ExecutionShape {
  return {
    mechanism: "solo",
    effort: null,
    workerCount: 0,
    concurrency: 0,
    seamsOverCap: 0,
  };
}

/**
 * Recommend how the declared work would run, if the parent chooses to delegate.
 *
 * Three rules keep this a consequence of the route rather than a second opinion
 * on it.
 *
 * A `solo` route yields the `solo` mechanism and zero workers, so one evaluation
 * can never advise against delegating and name a delegation tool in the same
 * breath. Seam count alone therefore decides nothing: it only sizes a shape the
 * route has already admitted.
 *
 * Sequential versus parallel reads *resolved* values, so an undeclared hazard
 * biases toward staggering. That is the mirror image of `parallelEligible`, which
 * reads raw declarations because it answers a structural question instead of
 * making a recommendation, and it is why a card that declares nothing can never be
 * recommended for concurrent workers.
 *
 * Every number is the envelope's. Nothing here widens a bound, reads the process,
 * or consults the escalation and stronger-fallback permissions that belong to the
 * failure ladder.
 */
export function recommendExecutionShape(
  route: RoutingRoute,
  seamCount: number,
  resolved: ResolvedRoutingValues,
  envelope: ComputeEnvelope,
): ExecutionShape {
  // Empty seam lists arrive here as `solo` through R0, so this covers them too.
  if (route === "solo" || seamCount < 1) return soloShape();

  const workerCount = Math.min(seamCount, wholeBound(envelope.maxWorkersPerBatch));
  // An envelope permitting no worker at all leaves solo as the only shape it can
  // honestly name.
  if (workerCount < 1) return soloShape();

  const permittedConcurrency = Math.min(workerCount, wholeBound(envelope.maxConcurrency));
  // Parallel has to be worth naming: two workers the operator will really run at
  // once, no resolved hazard between them, and per-seam proof of each. An envelope
  // narrowed to one concurrent worker *is* sequential execution, so calling it
  // parallel would advertise a shape the runtime cannot deliver.
  const parallel =
    workerCount >= 2 &&
    permittedConcurrency >= 2 &&
    !SHARED_STATE_BLOCKS_PARALLEL[resolved.sharedState] &&
    !CORE_OVERLAP_BLOCKS_PARALLEL[resolved.coreOverlap] &&
    VERIFICATION_ALLOWS_CONCURRENCY[resolved.verification];

  return {
    mechanism:
      workerCount === 1
        ? "delegate_task"
        : parallel
          ? "delegate_tasks_parallel"
          : "delegate_tasks_sequential",
    effort: boundEffort(SEAM_SIZE_EFFORT[resolved.seamSize], envelope.allowedEfforts),
    workerCount,
    concurrency: parallel ? permittedConcurrency : 1,
    seamsOverCap: seamCount - workerCount,
  };
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

  const parallelEligible = evaluateParallelEligibility(card);
  const shape = context.envelope
    ? recommendExecutionShape(route, card.seams.length, resolved, context.envelope)
    : null;

  return {
    route,
    seamCount: card.seams.length,
    unknownCount: countUnknowns(card),
    gates,
    signals,
    parallelEligible,
    shape,
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
 * The shape line, or null when no envelope was supplied to bound one.
 *
 * Says "solo" exactly as flatly as the route does, and marks an `either` shape as
 * the conditional it is, so the line cannot be read as an instruction to delegate
 * a parent has not yet decided to accept. The effort is named as a starting
 * effort, because the failure ladder — not this line — owns raising it.
 */
function describeShape(evaluation: RoutingEvaluation): string | null {
  const shape = evaluation.shape;
  if (shape === null) return null;
  if (shape.mechanism === "solo") return "solo; zero workers";
  const pacing =
    shape.mechanism === "delegate_tasks_parallel"
      ? `${shape.workerCount} workers, up to ${shape.concurrency} at once`
      : shape.mechanism === "delegate_tasks_sequential"
        ? `${shape.workerCount} workers, one at a time`
        : "1 worker";
  const parts = [
    shape.mechanism,
    `start at ${shape.effort ?? "no permitted effort"}`,
    pacing,
  ];
  // A capped batch must say so: advertising fewer workers than declared seams
  // without naming the remainder would read as though the work had shrunk.
  if (shape.seamsOverCap > 0) parts.push(`${shape.seamsOverCap} seams stay with you`);
  const line = parts.join(" | ");
  return evaluation.route === "either" ? `${line}; only if justified` : line;
}

/**
 * Render an evaluation as compact advisory text.
 *
 * Budgeted, and deliberately free of seam labels: the parent already knows its
 * own decomposition, so echoing it back would spend metadata to say nothing. The
 * caller's own judgement is named explicitly so the advice cannot read as an
 * instruction.
 *
 * The shape line appears only when the caller supplied an envelope to bound one,
 * so a surface that names no envelope renders byte-for-byte what it always did.
 */
export function renderRoutingPreflight(evaluation: RoutingEvaluation): string {
  const listed = evaluation.signals.length > 0 ? evaluation.signals.join(",") : "none";
  const shape = describeShape(evaluation);
  const lines = [
    `ROUTE: ${evaluation.route} | seams ${evaluation.seamCount} | unknown ${evaluation.unknownCount}`,
    `SIGNALS: ${listed}`,
    `PARALLEL-ELIGIBLE: ${evaluation.parallelEligible} (structural only; not a worker count)`,
    ...(shape === null ? [] : [`SHAPE: ${shape}`]),
    `ADVISORY: ${describeRoute(evaluation.route)}. Nothing was created; no delegation is required.`,
  ];
  if (evaluation.gates.length > 0) {
    lines.splice(2, 0, `GATES: ${evaluation.gates.join(",")} (advisory here)`);
  }
  return lines.join("\n");
}
