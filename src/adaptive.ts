/**
 * Unified adaptive routing and execution pipeline.
 *
 * Connects the four P1.2 primitives into a single deterministic flow:
 * 1. Decomposition and Seam Planning (`planSeams`): Task contracts / candidates -> SeamPlan & RoutingPreflightCard.
 * 2. Cheap Routing Evaluation (`evaluateRouting`): PreflightCard & ComputeEnvelope -> RoutingEvaluation.
 * 3. Execution Shape Recommendation (`ExecutionShape`): mechanism, effort, workerCount, concurrency.
 * 4. Compute Selection Policy (`selectCompute`): shape, envelope & prior execution evidence -> SelectionDecision.
 * Execution remains owned by the existing server and batch admission/lifecycle
 * paths. This module does not start workers or consume failure handoffs.
 */
import {
  planSeams,
  type DeclaredSeamEvidence,
  type SeamCandidate,
  type SeamPlan,
} from "./seam-plan.js";
import {
  evaluateRouting,
  type ExecutionShape,
  type RoutingEvaluation,
  type RoutingMode,
  type RoutingPreflightCard,
  type RoutingRoute,
} from "./routing.js";
import {
  selectCompute,
  type PriorExecution,
  type SelectionDecision,
} from "./selection.js";
import { DEFAULT_COMPUTE_POLICY, type ComputePolicy } from "./policy.js";
import type { Effort } from "./config.js";
import type { DelegateTaskInput, RoutingPreflightInput } from "./contract.js";

/** Input to the unified candidate-based adaptive routing flow. */
export interface AdaptiveRoutingInput {
  /** The candidate units of work or tasks to plan and route. */
  readonly candidates: readonly SeamCandidate[];
  /** Optional operator/supervisor declared seam coupling evidence. */
  readonly declared?: DeclaredSeamEvidence;
  /** Optional execution context. */
  readonly context?: {
    mode?: RoutingMode;
    taskCount?: number;
    allowOverlappingScopes?: boolean;
  };
  /** Active compute policy / envelope. */
  readonly policy: ComputePolicy;
  /** Optional prior execution / failure decision evidence. */
  readonly evidence?: PriorExecution;
}

/** Complete result of the adaptive routing flow. */
export interface AdaptiveRoutingResult {
  /** The derived seam plan and preflight card. */
  readonly plan: SeamPlan;
  /** The cheap routing evaluation and signals. */
  readonly evaluation: RoutingEvaluation;
  /** The compute selection decision (model & effort). */
  readonly selection: SelectionDecision;
  /** The recommended route: solo, either, or delegation-plausible. */
  readonly recommendedRoute: RoutingRoute;
  /** The recommended execution shape. */
  readonly recommendedShape: ExecutionShape;
  /** The selected model, or null for solo / open choice. */
  readonly selectedModel: string | null;
  /** The selected effort, or null for solo. */
  readonly selectedEffort: Effort | null;
}

/** Input when routing a preflight card directly without separate candidate units. */
export interface AdaptiveRoutingCardInput {
  /** The preflight card to evaluate. */
  readonly card: RoutingPreflightCard;
  /** Optional execution context. */
  readonly context?: {
    mode?: RoutingMode;
    taskCount?: number;
    allowOverlappingScopes?: boolean;
  };
  /** Active compute policy / envelope. */
  readonly policy: ComputePolicy;
  /** Optional prior execution / failure decision evidence. */
  readonly evidence?: PriorExecution;
}

/**
 * Plan seams, evaluate routing, determine execution shape, and select compute in one flow.
 *
 * Pure and synchronous: executes deterministically in sub-millisecond time.
 */
export function routeAdaptiveTask(input: AdaptiveRoutingInput): AdaptiveRoutingResult {
  const plan = planSeams({
    candidates: input.candidates,
    declared: input.declared,
  });

  const mode =
    input.context?.mode ?? (plan.proposedSeamCount > 1 ? "parallel" : "single");
  const taskCount = input.context?.taskCount ?? plan.proposedSeamCount;

  const { evaluation, selection } = evaluateAdaptiveCard({
    card: plan.preflightCard,
    context: {
      mode,
      taskCount,
      allowOverlappingScopes: input.context?.allowOverlappingScopes,
    },
    policy: input.policy,
    evidence: input.evidence,
  });

  const shape: ExecutionShape = evaluation.shape ?? {
    mechanism: "solo",
    effort: null,
    workerCount: 0,
    concurrency: 0,
    seamsOverCap: 0,
  };

  return {
    plan,
    evaluation,
    selection,
    recommendedRoute: evaluation.route,
    recommendedShape: shape,
    selectedModel: selection.model,
    selectedEffort: selection.effort,
  };
}

/** Canonical card evaluation used by preflight and both live delegation surfaces. */
export function evaluateAdaptiveCard(input: AdaptiveRoutingCardInput): {
  evaluation: RoutingEvaluation;
  selection: SelectionDecision;
} {
  const evaluation = evaluateRouting(input.card, {
    mode: input.context?.mode ?? (input.card.seams.length > 1 ? "parallel" : "single"),
    taskCount: input.context?.taskCount ?? input.card.seams.length,
    allowOverlappingScopes: input.context?.allowOverlappingScopes,
    envelope: input.policy,
  });
  const shape = evaluation.shape ?? {
    mechanism: "solo" as const,
    effort: null,
    workerCount: 0,
    concurrency: 0,
    seamsOverCap: 0,
  };
  return {
    evaluation,
    selection: selectCompute({ shape, policy: input.policy, evidence: input.evidence }),
  };
}

/**
 * Route a preflight card directly, determine execution shape, and select compute.
 *
 * Pure and synchronous: executes deterministically in sub-millisecond time.
 */
export function routeAdaptiveCard(
  input: AdaptiveRoutingCardInput,
): Omit<AdaptiveRoutingResult, "plan"> & { plan: null } {
  const { evaluation, selection } = evaluateAdaptiveCard(input);

  const shape: ExecutionShape = evaluation.shape ?? {
    mechanism: "solo",
    effort: null,
    workerCount: 0,
    concurrency: 0,
    seamsOverCap: 0,
  };

  return {
    plan: null,
    evaluation,
    selection,
    recommendedRoute: evaluation.route,
    recommendedShape: shape,
    selectedModel: selection.model,
    selectedEffort: selection.effort,
  };
}

/**
 * Derive one real SeamCandidate unit from an actual task contract.
 *
 * Rules:
 * - A candidate represents one unit of work / task ownership, not a single file or glob.
 * - `allowedFiles` are preserved as the unit's declared scope without splitting into artificial seams.
 * - Non-sensitive label is derived from `activityLabel` or task index.
 */
export function deriveSeamCandidate(task: DelegateTaskInput, index = 0): SeamCandidate {
  const label = task.activityLabel?.trim() || `seam-${index + 1}`;
  return {
    label,
    allowedFiles: task.allowedFiles,
    changeIntent: task.changeIntent,
    verificationCommands: task.verificationCommands,
  };
}

/**
 * Derive real SeamCandidate units from an array of task contracts.
 */
export function deriveSeamCandidates(
  tasks: readonly DelegateTaskInput[],
): readonly SeamCandidate[] {
  return tasks.map((task, index) => deriveSeamCandidate(task, index));
}

/**
 * Extract declared seam evidence from an optional routing preflight input card.
 */
export function deriveDeclaredEvidence(
  preflight?: RoutingPreflightInput | null,
): DeclaredSeamEvidence | undefined {
  if (!preflight) return undefined;
  return {
    seamSize: preflight.seamSize,
    sharedState: preflight.sharedState,
    coreOverlap: preflight.coreOverlap,
    integration: preflight.integration,
    verification: preflight.verification,
  };
}

/**
 * Route a live single task contract through the adaptive pipeline.
 */
export function routeLiveTask(
  task: DelegateTaskInput,
  options: {
    policy?: ComputePolicy;
    evidence?: PriorExecution;
  } = {},
): AdaptiveRoutingResult {
  const policy = options.policy ?? DEFAULT_COMPUTE_POLICY;
  const candidate = deriveSeamCandidate(task, 0);
  const declared = deriveDeclaredEvidence(task.routingPreflight);
  return routeAdaptiveTask({
    candidates: [candidate],
    declared,
    context: {
      mode: "single",
      taskCount: 1,
    },
    policy,
    evidence: options.evidence,
  });
}

/**
 * Route live batch task contracts through the adaptive pipeline.
 */
export function routeLiveTasks(
  tasks: readonly DelegateTaskInput[],
  options: {
    mode?: RoutingMode;
    preflight?: RoutingPreflightInput;
    allowOverlappingScopes?: boolean;
    policy?: ComputePolicy;
    evidence?: PriorExecution;
  } = {},
): AdaptiveRoutingResult {
  const policy = options.policy ?? DEFAULT_COMPUTE_POLICY;
  const candidates = deriveSeamCandidates(tasks);
  const declared = deriveDeclaredEvidence(options.preflight);
  return routeAdaptiveTask({
    candidates,
    declared,
    context: {
      mode: options.mode,
      taskCount: tasks.length,
      allowOverlappingScopes: options.allowOverlappingScopes,
    },
    policy,
    evidence: options.evidence,
  });
}
