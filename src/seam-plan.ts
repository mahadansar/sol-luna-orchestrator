/**
 * Decomposition and seam planning.
 *
 * Routing (`routing.ts`) answers "given this decomposition, is delegating it worth
 * it, and in what shape". It cannot answer the question that comes *before* that:
 * is this one piece of work, or several? This module is that earlier step, and it
 * stops the moment the question is answered.
 *
 * Three rules keep it from becoming a second router.
 *
 * Evidence, never optimism. A split has to be earned by something the caller
 * actually declared, or by structure derivable from those declarations. Absence of
 * a stated hazard is not evidence of safety, so undeclared coupling keeps the work
 * whole. The planner may *add* a hazard it can derive — overlapping declared scopes
 * are a real collision whatever the caller believed — and may never derive the
 * absence of one. Nothing here writes `none`, `disjoint`, or `mechanical` into a
 * card that no declaration and no derivation supports; unknown stays unknown, all
 * the way through to routing, where the raw values feed hard structural gates.
 *
 * Semantics, never capacity. How many workers the operator's policy permits is an
 * execution bound, not a fact about the work. Five genuinely independent seams are
 * five seams under a three-worker policy; `recommendExecutionShape` already enlists
 * what it may and reports the remainder as `seamsOverCap`. Collapsing seams to fit
 * would launder a capacity limit into a claim about coupling, so no compute
 * envelope reaches this module at all.
 *
 * Decomposition, never mechanism. This module names no tool, no effort, no worker
 * count, and no concurrency. It emits one `RoutingPreflightCard`, which is exactly
 * `evaluateRouting`'s input; solo-versus-delegate and sequential-versus-parallel
 * stay where they already live. Seam planning saying "these two are independent"
 * and routing saying "and still not worth two workers" answer different questions
 * rather than disagreeing.
 *
 * Deliberately absent: filesystem access, git, worktrees, threads, workers, child
 * processes, network, model calls, compute policy, and every form of hidden state.
 * The one value import that does any work is `scopesOverlap`, the same detector the
 * parallel batch gate enforces with, so a plan can never call scopes disjoint that
 * the gate would later reject; it reads its arguments plus the platform's path
 * case-sensitivity and nothing else. Identical inputs give identical plans.
 */
import { scopesOverlap } from "./overlap.js";
import { MAX_SEAM_LABEL_LENGTH } from "./routing.js";
import type { ChangeIntent } from "./contract.js";
import type {
  CoreOverlap,
  Integration,
  RoutingPreflightCard,
  SeamSize,
  SharedState,
  Verification,
} from "./routing.js";

/** Whether the described work stays one unit or becomes several. */
export const SEAM_DECISIONS = ["keep-whole", "split"] as const;
export type SeamDecision = (typeof SEAM_DECISIONS)[number];

/**
 * How the planned seams relate to each other and to the parent's remaining work.
 *
 * `unknown` is a first-class answer rather than a pessimistic `dependent`: nothing
 * was declared and nothing was derivable, which is a different fact from a stated
 * coupling and is reported as such. Both keep the work whole.
 */
export const SEAM_DEPENDENCIES = ["independent", "dependent", "unknown"] as const;
export type SeamDependency = (typeof SEAM_DEPENDENCIES)[number];

/**
 * Why the plan came out the way it did, as a code rather than prose.
 *
 * Codes so tests and callers can branch on the reason without matching sentences,
 * listed in the order `planSeams` considers them.
 */
export const SEAM_PLAN_REASONS = [
  "no-declared-work",
  "single-seam",
  "overlapping-scopes",
  "declared-shared-mutable-state",
  "declared-shared-core",
  "architectural-integration",
  "undeclared-coupling",
  "independent-seams",
] as const;
export type SeamPlanReason = (typeof SEAM_PLAN_REASONS)[number];

/**
 * What the caller already knows about its own decomposition.
 *
 * Every field is optional and an omitted field means `unknown`. This is the same
 * five-field vocabulary the routing card uses, because it ends up in one.
 */
export interface DeclaredSeamEvidence {
  readonly seamSize?: SeamSize;
  readonly sharedState?: SharedState;
  readonly coreOverlap?: CoreOverlap;
  readonly integration?: Integration;
  readonly verification?: Verification;
}

/**
 * One unit of work the caller is considering owning separately.
 *
 * A candidate is a *unit*, not a file. Treating each glob in one task's
 * `allowedFiles` as its own seam would manufacture a decomposition out of a scope
 * list: `["src/**", "docs/**"]` is one task with two patterns, not two owners.
 */
export interface SeamCandidate {
  /** Short non-sensitive label. Never persisted in telemetry; see `routing.ts`. */
  readonly label: string;
  /** Declared edit scope. Empty or omitted means unrestricted, which overlaps all. */
  readonly allowedFiles?: readonly string[];
  /** Declared file-change expectation. Omitted takes the schema default, `required`. */
  readonly changeIntent?: ChangeIntent;
  /** Declared checks for this unit. Read only to locate the verification boundary. */
  readonly verificationCommands?: readonly string[];
}

export interface SeamPlanningInput {
  readonly candidates: readonly SeamCandidate[];
  /**
   * Optional caller declarations. Derived structure may add hazards to these and
   * may never clear one.
   */
  readonly declared?: DeclaredSeamEvidence;
}

export interface SeamPlan {
  decision: SeamDecision;
  /** Always equal to `preflightCard.seams.length`. Zero when nothing was declared. */
  proposedSeamCount: number;
  dependency: SeamDependency;
  reason: SeamPlanReason;
  /**
   * The decomposition as routing's own input. Feed it straight to `evaluateRouting`;
   * this module deliberately recommends no mechanism, effort, or worker count.
   */
  preflightCard: RoutingPreflightCard;
}

/**
 * Conservative ordering per field; the higher value wins when a declaration and a
 * derivation disagree.
 *
 * Total maps for the same reason routing uses them: a newly declarable value is a
 * compile error here rather than an unranked one that silently sorts as safest.
 * `unknown` sits above every non-hazard, so a declaration of safety never survives
 * contact with a derived hazard. A *derived* `unknown` is handled separately in
 * `combine` — it means "nothing derived", not "derived that it is uncertain".
 */
const SHARED_STATE_CAUTION = {
  none: 0,
  "read-only": 1,
  unknown: 2,
  mutable: 3,
} as const satisfies Record<SharedState, number>;

const CORE_OVERLAP_CAUTION = {
  disjoint: 0,
  unknown: 1,
  "shared-core": 2,
} as const satisfies Record<CoreOverlap, number>;

const INTEGRATION_CAUTION = {
  mechanical: 0,
  unknown: 1,
  architectural: 2,
} as const satisfies Record<Integration, number>;

const VERIFICATION_CAUTION = {
  "per-seam": 0,
  unknown: 1,
  "shared-only": 2,
} as const satisfies Record<Verification, number>;

/**
 * Combine what the caller declared with what the candidates imply.
 *
 * A derived `unknown` is an absence of derivation and must never overwrite a real
 * declaration; anything else takes whichever value is more cautious. That
 * asymmetry is the whole evidence rule in one function: derivation can raise a
 * hazard the caller missed, and can never talk one away.
 */
function combine<T extends string>(
  declared: T | undefined,
  derived: T,
  caution: Record<T, number>,
  unknownValue: T,
): T {
  if (derived === unknownValue) return declared ?? unknownValue;
  if (declared === undefined || declared === unknownValue) return derived;
  return caution[declared] >= caution[derived] ? declared : derived;
}

/** Omitted intent is the schema's own default: the work is expected to change files. */
function intentOf(candidate: SeamCandidate): ChangeIntent {
  return candidate.changeIntent ?? "required";
}

function commandsOf(candidate: SeamCandidate): string[] {
  return (candidate.verificationCommands ?? [])
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
}

/**
 * Whether any two candidates declare scopes that can select the same path.
 *
 * Delegated to the detector the parallel batch gate uses, so seam planning cannot
 * bless a decomposition that gate would refuse. An unrestricted scope overlaps
 * everything, which is why an undeclared scope keeps change-capable work whole.
 *
 * Note what is *not* here: neither shared directories nor path proximity are read
 * as coupling. Two files in one directory are two files; adjacency is not evidence
 * of a shared invariant, and treating it as evidence would keep genuinely separable
 * work whole for the sole reason that a repository is organised by folder.
 */
function anyScopesOverlap(candidates: readonly SeamCandidate[]): boolean {
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const first = [...(candidates[i]?.allowedFiles ?? [])];
      const second = [...(candidates[j]?.allowedFiles ?? [])];
      if (scopesOverlap(first, second)) return true;
    }
  }
  return false;
}

/**
 * Where the proof boundary sits, from the declared checks alone.
 *
 * A command naming two candidates proves them together, which is a *verification*
 * boundary and nothing more: it says the seams come back provable only as a set,
 * not that they share state or that one depends on the other. Routing already
 * reads `shared-only` correctly — as a reason to stagger and a Tier-2 economic
 * signal, never a refusal — so the honest thing here is to report the boundary and
 * stop. Turning a shared `npm test` into a dependency would invent a coupling that
 * the declarations do not contain.
 *
 * Every candidate carrying its own distinct checks is real evidence of per-seam
 * proof. A candidate with no checks leaves the question open, so the answer is
 * `unknown` rather than an optimistic `per-seam`.
 */
function deriveSplitVerification(candidates: readonly SeamCandidate[]): Verification {
  const owners = new Map<string, number>();
  let everyCandidateHasChecks = true;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const commands = commandsOf(candidate);
    if (commands.length === 0) everyCandidateHasChecks = false;
    for (const command of new Set(commands)) {
      const owner = owners.get(command);
      if (owner !== undefined && owner !== index) return "shared-only";
      owners.set(command, index);
    }
  }

  return everyCandidateHasChecks ? "per-seam" : "unknown";
}

/**
 * Proof boundary for work that stays whole.
 *
 * One owner means one seam, so whatever checks were declared prove that seam on its
 * own by definition. No declared check leaves it `unknown`.
 */
function deriveWholeVerification(candidates: readonly SeamCandidate[]): Verification {
  return candidates.some((candidate) => commandsOf(candidate).length > 0)
    ? "per-seam"
    : "unknown";
}

/** Labels stay short because the card's schema caps them; an empty label gets an index. */
function seamLabel(candidate: SeamCandidate | undefined, index: number): string {
  const trimmed = (candidate?.label ?? "").trim();
  const label = trimmed.length > 0 ? trimmed : `seam-${index + 1}`;
  return label.slice(0, MAX_SEAM_LABEL_LENGTH);
}

/**
 * The single label for work kept whole.
 *
 * Derived from the candidates rather than a fixed string, so the card still shows
 * the parent which units were folded together.
 */
function wholeSeamLabel(candidates: readonly SeamCandidate[]): string {
  const first = seamLabel(candidates[0], 0);
  const remainder = candidates.length - 1;
  if (remainder < 1) return first;
  const suffix = ` +${remainder} more`;
  const room = Math.max(1, MAX_SEAM_LABEL_LENGTH - suffix.length);
  return `${first.slice(0, room)}${suffix}`;
}

/** Dependency is read back off the finished card, so the two can never disagree. */
function dependencyOf(card: RoutingPreflightCard): SeamDependency {
  if (card.sharedState === "mutable" || card.coreOverlap === "shared-core") {
    return "dependent";
  }
  if (card.sharedState === "unknown" || card.coreOverlap === "unknown") return "unknown";
  return "independent";
}

/**
 * Decide whether described work stays whole or splits, and say so in routing's own
 * vocabulary.
 *
 * Pure and synchronous by contract: same inputs, same plan, no observation of
 * anything outside its arguments.
 */
export function planSeams(input: SeamPlanningInput): SeamPlan {
  const { candidates, declared } = input;
  const seamSize = declared?.seamSize ?? "unknown";

  // Nothing declared is not an empty decomposition to route around; it is the
  // absence of one. Routing's own R0 and `seam-count-zero` gate take it from here,
  // and a zero seam count is reported rather than rounded up to one.
  if (candidates.length === 0) {
    return {
      decision: "keep-whole",
      proposedSeamCount: 0,
      dependency: "unknown",
      reason: "no-declared-work",
      preflightCard: {
        seams: [],
        seamSize,
        sharedState: declared?.sharedState ?? "unknown",
        coreOverlap: declared?.coreOverlap ?? "unknown",
        integration: declared?.integration ?? "unknown",
        verification: declared?.verification ?? "unknown",
      },
    };
  }

  // Read-only work writes nothing, so there is no state to race over, nothing a
  // sibling or the parent could find modified underneath it, and nothing to
  // recombine. That is a derivation from the declared change intent, not an
  // assumption about the repository, and it is what makes disjoint read-only work
  // safely separable by default instead of by assertion.
  const readOnly = candidates.every((candidate) => intentOf(candidate) === "forbidden");
  const overlapping = !readOnly && anyScopesOverlap(candidates);

  const derivedSharedState: SharedState = readOnly ? "read-only" : "unknown";
  const derivedIntegration: Integration = readOnly ? "mechanical" : "unknown";
  const derivedCoreOverlap: CoreOverlap = readOnly
    ? "disjoint"
    : overlapping
      ? "shared-core"
      : "unknown";

  const sharedState = combine(
    declared?.sharedState,
    derivedSharedState,
    SHARED_STATE_CAUTION,
    "unknown",
  );
  const coreOverlap = combine(
    declared?.coreOverlap,
    derivedCoreOverlap,
    CORE_OVERLAP_CAUTION,
    "unknown",
  );
  const integration = combine(
    declared?.integration,
    derivedIntegration,
    INTEGRATION_CAUTION,
    "unknown",
  );

  const keepWhole = (reason: SeamPlanReason): SeamPlan => {
    const card: RoutingPreflightCard = {
      seams: [wholeSeamLabel(candidates)],
      seamSize,
      sharedState,
      coreOverlap,
      integration,
      verification: combine(
        declared?.verification,
        deriveWholeVerification(candidates),
        VERIFICATION_CAUTION,
        "unknown",
      ),
    };
    return {
      decision: "keep-whole",
      proposedSeamCount: 1,
      dependency: dependencyOf(card),
      reason,
      preflightCard: card,
    };
  };

  // One unit is already whole. There is no second owner for it to be independent
  // of, so the coupling fields stay exactly as declared or derived.
  if (candidates.length === 1) return keepWhole("single-seam");

  // Derived structure first, so a caller who declared `disjoint` over scopes that
  // demonstrably collide gets the collision rather than the declaration.
  if (overlapping) return keepWhole("overlapping-scopes");
  if (sharedState === "mutable") return keepWhole("declared-shared-mutable-state");
  if (coreOverlap === "shared-core") return keepWhole("declared-shared-core");
  if (integration === "architectural") return keepWhole("architectural-integration");

  // Everything past this point is a stated or derived non-hazard. Anything still
  // `unknown` is undeclared coupling, and undeclared coupling keeps the work whole:
  // a split has to be earned, and silence earns nothing.
  if (
    sharedState === "unknown" ||
    coreOverlap === "unknown" ||
    integration === "unknown"
  ) {
    return keepWhole("undeclared-coupling");
  }

  const card: RoutingPreflightCard = {
    seams: candidates.map((candidate, index) => seamLabel(candidate, index)),
    seamSize,
    sharedState,
    coreOverlap,
    integration,
    verification: combine(
      declared?.verification,
      deriveSplitVerification(candidates),
      VERIFICATION_CAUTION,
      "unknown",
    ),
  };

  return {
    decision: "split",
    proposedSeamCount: card.seams.length,
    dependency: dependencyOf(card),
    reason: "independent-seams",
    preflightCard: card,
  };
}

/** One-line prose for a plan reason, for rendering and tool text. */
export function describeSeamPlanReason(reason: SeamPlanReason): string {
  switch (reason) {
    case "no-declared-work":
      return "No units of work were declared, so there is no decomposition to plan.";
    case "single-seam":
      return "One unit of work was declared; it is already a single seam.";
    case "overlapping-scopes":
      return (
        "The declared scopes can select the same files, so separate owners would " +
        "collide. Keeping the work whole."
      );
    case "declared-shared-mutable-state":
      return "Mutable state is shared across the units, so they are one seam.";
    case "declared-shared-core":
      return "The units share a core that the siblings or the parent still reason about.";
    case "architectural-integration":
      return (
        "Recombining the units is architectural rather than mechanical, so splitting " +
        "them would move the hard part rather than divide it."
      );
    case "undeclared-coupling":
      return (
        "Coupling between the units was neither declared nor derivable. Unknown " +
        "evidence keeps work whole; declare sharedState, coreOverlap, and integration " +
        "to earn a split."
      );
    case "independent-seams":
      return "The units are independently owned seams with mechanical integration.";
  }
}
