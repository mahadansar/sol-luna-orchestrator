/**
 * User-owned compute policy envelope.
 *
 * The envelope answers one question: what compute is this installation willing
 * to spend on a delegation? Its baseline is operator-owned — every bound comes
 * from `config.ts`, which reads the environment the server was launched with
 * and never the model. A supervisor may attach `computePolicy` to a call to
 * narrow that baseline further, and narrowing is the only direction available:
 * `narrowPolicy` intersects lists, takes the minimum of numbers, and ANDs
 * booleans, so no declaration can widen what the operator permitted.
 *
 * Models and efforts are deliberately not caller-declarable. Both are already
 * operator-owned (`LUNA_MODEL`, `SOL_LUNA_ALLOWED_EFFORTS`), a supervisor
 * restating them could only ever refuse its own call by guessing a name wrong,
 * and leaving them out of the advertised schema keeps supervisor metadata thin.
 */
import { z } from "zod";
import {
  ALLOW_EFFORT_ESCALATION,
  ALLOW_STRONGER_FALLBACK,
  ALLOWED_EFFORTS,
  ALLOWED_MODELS,
  EFFORTS,
  EXECUTOR_ORDER,
  LUNA_MODEL,
  MAX_BATCH_SIZE,
  MAX_PARALLEL,
  MAX_PARALLEL_LIMIT,
  MAX_WORKERS_PER_BATCH,
  type Effort,
} from "./config.js";

/** A fully resolved envelope. Every bound is present; nothing is implied. */
export const computePolicyShape = {
  allowedModels: z.array(z.string().min(1)).min(1),
  allowedEfforts: z.array(z.enum(EFFORTS)).min(1),
  maxConcurrency: z.number().int().min(1).max(MAX_PARALLEL_LIMIT),
  maxWorkersPerBatch: z.number().int().min(1).max(MAX_BATCH_SIZE),
  allowEffortEscalation: z.boolean(),
  allowStrongerFallback: z.boolean(),
  executorOrder: z.array(z.string().min(1)).optional(),
};

export const computePolicySchema = z.object(computePolicyShape);
export type ComputePolicy = z.infer<typeof computePolicySchema>;

/**
 * What a caller may declare: any subset of the caller-narrowable bounds.
 *
 * Every field is optional so a supervisor can cap one dimension without
 * restating the whole envelope, and the upper bounds are the protocol's own
 * hard ceilings so an over-limit declaration is a visible schema refusal
 * rather than a silent clamp.
 */
export const computePolicyNarrowingShape = {
  maxConcurrency: computePolicyShape.maxConcurrency.optional(),
  maxWorkersPerBatch: computePolicyShape.maxWorkersPerBatch.optional(),
  allowEffortEscalation: z.boolean().optional(),
  allowStrongerFallback: z.boolean().optional(),
};

export const computePolicyNarrowingSchema = z.object(computePolicyNarrowingShape);
export type ComputePolicyNarrowing = z.infer<typeof computePolicyNarrowingSchema>;

/**
 * Intersect a declaration with its parent envelope.
 *
 * Structurally incapable of widening: lists intersect, numbers take the
 * minimum, booleans AND. An empty intersection throws rather than resolving to
 * something permissive — callers that must not throw go through `admitCompute`.
 */
export function narrowPolicy(
  parent: ComputePolicy,
  narrowed: Partial<ComputePolicy>,
): ComputePolicy {
  const allowedModels = narrowed.allowedModels
    ? parent.allowedModels.filter((m) => narrowed.allowedModels!.includes(m))
    : parent.allowedModels;

  const allowedEfforts = narrowed.allowedEfforts
    ? parent.allowedEfforts.filter((e) => narrowed.allowedEfforts!.includes(e))
    : parent.allowedEfforts;

  if (allowedModels.length === 0) {
    throw new Error(
      "Narrowed policy must allow at least one model from the parent policy.",
    );
  }
  if (allowedEfforts.length === 0) {
    throw new Error(
      "Narrowed policy must allow at least one effort level from the parent policy.",
    );
  }

  const parentOrder = parent.executorOrder ?? [];
  const narrowedOrder = narrowed.executorOrder;
  const rawOrder = narrowedOrder
    ? parentOrder.filter((m) => narrowedOrder.includes(m))
    : parentOrder;
  const executorOrder = rawOrder.filter((m) => allowedModels.includes(m));

  return {
    allowedModels,
    allowedEfforts,
    maxConcurrency: Math.min(
      parent.maxConcurrency,
      narrowed.maxConcurrency ?? parent.maxConcurrency,
    ),
    maxWorkersPerBatch: Math.min(
      parent.maxWorkersPerBatch,
      narrowed.maxWorkersPerBatch ?? parent.maxWorkersPerBatch,
    ),
    allowEffortEscalation:
      parent.allowEffortEscalation &&
      (narrowed.allowEffortEscalation ?? parent.allowEffortEscalation),
    allowStrongerFallback:
      parent.allowStrongerFallback &&
      (narrowed.allowStrongerFallback ?? parent.allowStrongerFallback),
    ...(executorOrder.length > 0 ? { executorOrder } : {}),
  };
}

/** The operator-owned inputs that define one installation's baseline. */
export interface ComputePolicyEnvironment {
  model: string;
  allowedModels?: readonly string[];
  allowedEfforts: readonly Effort[];
  maxConcurrency: number;
  maxWorkersPerBatch: number;
  allowEffortEscalation: boolean;
  allowStrongerFallback: boolean;
  executorOrder?: readonly string[];
}

/**
 * Whether a declared ladder completely and unambiguously orders authorisation.
 *
 * A partial ladder is not a weaker ladder, it is an unusable one: selection
 * resolves a stronger executor by index, so a list that omits an authorised
 * model, repeats one, names one that is not authorised, or does not start at the
 * baseline worker cannot answer "what comes after this rung". Exported because
 * dropping such a ladder must be *reported* rather than merely done - see
 * `executorOrderDeclaredButUnusable`.
 */
export function executorOrderIsUsable(
  requestedOrder: readonly string[],
  allowedModels: readonly string[],
  baselineModel: string,
): boolean {
  return (
    requestedOrder.length === allowedModels.length &&
    new Set(requestedOrder).size === requestedOrder.length &&
    requestedOrder[0] === baselineModel &&
    requestedOrder.every((model) => allowedModels.includes(model))
  );
}

/**
 * An operator declared an executor ladder that this envelope cannot use.
 *
 * The ladder was silently discarded, which left `stronger-executor-fallback`
 * permanently `stronger-executor-unresolvable` with nothing in the log, the
 * status table, or `doctor` to say why. Callers surface this the same way they
 * surface an unrecognised verify mode or a clamped concurrency.
 */
export function executorOrderDeclaredButUnusable(env: ComputePolicyEnvironment): boolean {
  const requestedOrder = env.executorOrder ?? [];
  if (requestedOrder.length === 0) return false;
  const allowedModels = [...new Set(env.allowedModels ?? [env.model])];
  return !executorOrderIsUsable(requestedOrder, allowedModels, env.model);
}

/**
 * Build a baseline from operator settings, through the same narrowing gate a
 * caller's declaration goes through.
 *
 * The protocol's hard ceilings are the parent here, so an operator cannot raise
 * concurrency or batch size above what the runtime will ever run — the
 * environment narrows, exactly like everything else. Pure, so the CLI can
 * report the baseline of a *registered* server rather than of its own shell.
 */
export function buildComputePolicy(env: ComputePolicyEnvironment): ComputePolicy {
  const allowedModels = [...new Set(env.allowedModels ?? [env.model])];
  const requestedOrder = env.executorOrder ? [...env.executorOrder] : [];
  const orderIsComplete = executorOrderIsUsable(requestedOrder, allowedModels, env.model);
  const executorOrder = orderIsComplete ? requestedOrder : [];
  return narrowPolicy(
    {
      allowedModels,
      allowedEfforts: [...EFFORTS],
      maxConcurrency: MAX_PARALLEL_LIMIT,
      maxWorkersPerBatch: MAX_BATCH_SIZE,
      allowEffortEscalation: true,
      allowStrongerFallback: true,
      ...(executorOrder.length > 0 ? { executorOrder } : {}),
    },
    {
      allowedEfforts: [...env.allowedEfforts],
      maxConcurrency: env.maxConcurrency,
      maxWorkersPerBatch: env.maxWorkersPerBatch,
      allowEffortEscalation: env.allowEffortEscalation,
      allowStrongerFallback: env.allowStrongerFallback,
    },
  );
}

/**
 * This process's operator-owned baseline.
 *
 * Every default preserves pre-policy behaviour, so an installation that sets
 * none of the variables resolves exactly the envelope the runtime had before
 * the policy existed.
 */
export const DEFAULT_COMPUTE_POLICY_ENVIRONMENT: ComputePolicyEnvironment = {
  model: LUNA_MODEL,
  allowedModels: ALLOWED_MODELS,
  allowedEfforts: ALLOWED_EFFORTS,
  maxConcurrency: MAX_PARALLEL,
  maxWorkersPerBatch: MAX_WORKERS_PER_BATCH,
  allowEffortEscalation: ALLOW_EFFORT_ESCALATION,
  allowStrongerFallback: ALLOW_STRONGER_FALLBACK,
  executorOrder: EXECUTOR_ORDER,
};

export const DEFAULT_COMPUTE_POLICY: ComputePolicy = buildComputePolicy(
  DEFAULT_COMPUTE_POLICY_ENVIRONMENT,
);

/** Whether SOL_LUNA_EXECUTOR_ORDER named a ladder this installation cannot use. */
export const EXECUTOR_ORDER_UNUSABLE = executorOrderDeclaredButUnusable(
  DEFAULT_COMPUTE_POLICY_ENVIRONMENT,
);

/** Deep copy, so a resolved envelope attached to a task cannot be aliased. */
export function cloneComputePolicy(policy: ComputePolicy): ComputePolicy {
  return {
    ...policy,
    allowedModels: [...policy.allowedModels],
    allowedEfforts: [...policy.allowedEfforts],
    ...(policy.executorOrder ? { executorOrder: [...policy.executorOrder] } : {}),
  };
}

/**
 * Resolve a declaration against the baseline without ever throwing.
 *
 * Used wherever a policy is read on a path that must stay total — notably
 * failure classification, which runs while handling a failure and must not
 * turn a FAILED result into an exception.
 */
export function resolveComputePolicy(
  requested: Partial<ComputePolicy> | undefined,
  baseline: ComputePolicy = DEFAULT_COMPUTE_POLICY,
): ComputePolicy {
  if (!requested) return baseline;
  try {
    return narrowPolicy(baseline, requested);
  } catch {
    return baseline;
  }
}

export interface ComputeAdmission {
  /** The resolved envelope. Present even when the call is refused. */
  policy: ComputePolicy;
  /** Human-readable refusal, or null when the request is admitted. */
  refusal: string | null;
}

/**
 * The single admission gate both delegation surfaces use.
 *
 * One function so the two tools cannot drift on precedence, wording, or which
 * bounds they bother to check. Never throws: an unsatisfiable declaration is a
 * refusal, which is a normal outcome rather than an error.
 */
export function admitCompute(request: {
  requested?: Partial<ComputePolicy>;
  model: string;
  efforts: readonly Effort[];
  workerCount: number;
  baseline?: ComputePolicy;
}): ComputeAdmission {
  const baseline = request.baseline ?? DEFAULT_COMPUTE_POLICY;

  let policy: ComputePolicy;
  try {
    policy = request.requested ? narrowPolicy(baseline, request.requested) : baseline;
  } catch (error) {
    return {
      policy: baseline,
      refusal: `Compute policy refusal: ${(error as Error).message}`,
    };
  }

  if (!policy.allowedModels.includes(request.model)) {
    return {
      policy,
      refusal:
        `Compute policy refusal: worker model '${request.model}' is not permitted. ` +
        `Allowed: ${policy.allowedModels.join(", ")}.`,
    };
  }

  const disallowedEffort = request.efforts.find(
    (effort) => !policy.allowedEfforts.includes(effort),
  );
  if (disallowedEffort) {
    return {
      policy,
      refusal:
        `Compute policy refusal: effort '${disallowedEffort}' is not permitted. ` +
        `Allowed: ${policy.allowedEfforts.join(", ")}. Resubmit at a permitted ` +
        `effort, or complete the work solo.`,
    };
  }

  // Sequential batches enlist as many workers as parallel ones; they only
  // stagger them. The worker-count bound applies to both.
  if (request.workerCount > policy.maxWorkersPerBatch) {
    return {
      policy,
      refusal:
        `Compute policy refusal: ${request.workerCount} workers exceeds the ` +
        `permitted ${policy.maxWorkersPerBatch} per batch. Split the work across ` +
        `calls, or complete part of it solo.`,
    };
  }

  return { policy, refusal: null };
}

/** Compact one-line rendering for status output and diagnostics. */
export function describeComputePolicy(policy: ComputePolicy): string {
  const parts = [
    `efforts ${policy.allowedEfforts.join("/")}`,
    `max ${policy.maxConcurrency} concurrent`,
    `${policy.maxWorkersPerBatch} per batch`,
    `escalation ${policy.allowEffortEscalation ? "on" : "off"}`,
    `fallback ${policy.allowStrongerFallback ? "on" : "off"}`,
  ];
  if (policy.executorOrder && policy.executorOrder.length > 0) {
    parts.push(`order ${policy.executorOrder.join("->")}`);
  }
  return parts.join(", ");
}
