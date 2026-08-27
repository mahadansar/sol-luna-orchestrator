/**
 * Selection policy: which executor and which effort a next worker turn runs at.
 *
 * Three modules already answer everything around this one. Seam planning decides
 * whether work is one unit or several. Route planning (`routing.ts`) recommends a
 * bounded *shape*: solo or delegate, the mechanism, the worker and concurrency
 * counts, and a conservative starting effort. Failure classification
 * (`classifyFailureDecision`) reads canonical execution evidence and selects the
 * single next *action* a failed task has earned. None of them names the executor a
 * next turn would actually run under, and this module is that last step. It is
 * deliberately the smallest of the four.
 *
 * Four rules keep it honest.
 *
 * Authorised, never ranked. `ComputePolicy.allowedModels` is a membership set and
 * nothing more: `admitCompute` reads it with `includes`, `narrowPolicy` intersects
 * it against the parent's order and discards the caller's, and the operator
 * baseline is the one model `LUNA_MODEL`. No operator surface declares that one
 * authorised executor is stronger than another, so this module never reads list
 * position as strength. A `stronger-executor-fallback` is therefore *received and
 * reported*, not resolved: P1.1 may earn the recommendation and the envelope may
 * permit it, and P1.2 still declines to guess which permitted executor is the
 * stronger one. Should the operator contract ever declare an ordering, this is the
 * single module that would consume it.
 *
 * Continuity, never a ladder. The executor a next turn runs under is the executor
 * the last turn ran under, whenever the envelope still permits it — a fact about
 * what already executed rather than a judgement about capability. Absent that
 * evidence the envelope decides: one permitted executor is the selection, and
 * several equally authorised ones are the parent's choice, reported as an open
 * choice instead of resolved by picking an index.
 *
 * Two decisions, never one. Executor fallback and effort escalation stay separate.
 * Selecting a different executor never resets effort — P1.1 recommends a fallback
 * only once effort is exhausted, so resetting would discard the very evidence that
 * earned it — and escalating effort never changes the executor.
 *
 * One rung, never the ceiling. Escalation moves to the lowest permitted effort
 * strictly above the evidenced one, so `xhigh` and `max` are reachable only by
 * climbing to them or from an envelope that leaves no lower option at all. P1.1
 * computes its `nextEffort` by the same rule and so agrees by construction; the
 * clamp binds only on stale or hand-built evidence, and it can only ever lower
 * what P1.1 named, never raise it. Whatever remains above the selected rung is
 * what the P1.1 ladder escalates into next.
 *
 * Deliberately absent: filesystem access, environment reads, git, worktrees,
 * threads, workers, child processes, network, model calls, and every form of
 * hidden state. `ComputePolicy`, `Effort`, `FailureAction`, `FailureDecision` and
 * `ExecutionShape` are type-only imports and erase at compile time, so `config.ts`
 * — the one module that reads the process environment — is not on this module's
 * runtime import graph at all; the envelope is passed in, exactly as routing's is.
 * The one value import is from `routing.js`, which itself imports nothing at
 * runtime, and it is taken precisely so the effort ladder and the downward clamp
 * cannot drift from the ones route planning already uses. Identical inputs give
 * identical decisions.
 *
 * Also deliberately absent: worker count and concurrency. Those are
 * `ExecutionShape`'s answer, a consumer already holds the shape it passed in, and
 * restating them here would add a second place for them to disagree without adding
 * a single selection semantic.
 */
import { EFFORT_RANK, boundEffort } from "./routing.js";
import type { Effort } from "./config.js";
import type { FailureAction, FailureDecision } from "./contract.js";
import type { ComputePolicy } from "./policy.js";
import type { ExecutionShape } from "./routing.js";

/**
 * Why a selection came out the way it did, as a code rather than prose.
 *
 * Codes so tests and callers branch on the reason without matching sentences,
 * listed in the order `selectCompute` considers them. `detail` carries the
 * human-readable sentence.
 */
export const SELECTION_REASONS = [
  "solo-no-execution",
  "no-authorised-next-execution",
  "conservative-baseline",
  "evidence-outside-envelope",
  "same-contract-retry",
  "effort-escalated",
  "effort-escalation-not-permitted",
  "effort-escalation-exhausted",
  "stronger-executor-selected",
  "stronger-executor-not-permitted",
  "stronger-executor-exhausted",
  "stronger-executor-unresolvable",
] as const;
export type SelectionReason = (typeof SELECTION_REASONS)[number];

/**
 * The one prior execution a selection reads.
 *
 * Field names are the canonical evidence record's own, so an `AttemptEvidence`
 * satisfies the execution half as it stands and no second vocabulary for "what
 * ran" comes into being. `requestedEffort` is a plain string there, and is treated
 * here as an unvalidated claim: an unreadable value is insufficient evidence, not
 * a licence to guess.
 *
 * Exactly one execution, and the latest. Nothing is derived from how many attempts
 * preceded it, from aggregate counts, or from any cross-call trend:
 * `automaticRetryCount` and `automaticRetryLimit` bound the ladder and stay
 * P1.1's, and history P1.1 has already weighed does not get a second, larger vote
 * here.
 */
export interface PriorExecution {
  readonly requestedModel: string;
  readonly requestedEffort: string;
  readonly failureDecision: FailureDecision;
}

/** Everything a selection reads. There is no other input, declared or implied. */
export interface SelectionInput {
  /** Route planning's recommendation. Read for its mechanism and starting effort. */
  readonly shape: ExecutionShape;
  /** The active envelope, already resolved by the caller. Never widened here. */
  readonly policy: ComputePolicy;
  /** The latest execution and its P1.1 decision. Absent on a first attempt. */
  readonly evidence?: PriorExecution;
}

/**
 * One bounded selection. Never a permission, and never outside the envelope.
 *
 * `effort` is null exactly when no next worker execution is authorised at all —
 * the shape is solo, the P1.1 action authorises none, or the envelope permits no
 * effort to run at. `model` is null in each of those cases too, and in one more:
 * when the envelope authorises several executors and declares no ordering among
 * them, the choice is open, and saying so is more honest than resolving it by
 * index.
 */
export interface SelectionDecision {
  model: string | null;
  effort: Effort | null;
  reason: SelectionReason;
  detail: string;
}

/**
 * Whether one P1.1 action authorises another worker execution at all.
 *
 * Total, so a newly declarable action is a compile error here rather than an
 * unlisted value that silently falls through to "select an executor for it".
 */
const ACTION_AUTHORISES_EXECUTION = {
  stop: false,
  "parent-takeover": false,
  repair: true,
  continuation: true,
  retry: true,
  "effort-escalation": true,
  "stronger-executor-fallback": true,
} as const satisfies Record<FailureAction, boolean>;

/** The least compute the envelope leaves available. Null only for an empty set. */
function lowestPermitted(allowed: readonly Effort[]): Effort | null {
  let floor: Effort | null = null;
  for (const effort of allowed) {
    if (floor === null || EFFORT_RANK[effort] < EFFORT_RANK[floor]) floor = effort;
  }
  return floor;
}

/**
 * The lowest permitted effort strictly above one level.
 *
 * One rung, so escalation climbs rather than jumps, and so every level above the
 * one selected stays available to the escalation after it.
 */
function nextRungAbove(current: Effort, allowed: readonly Effort[]): Effort | null {
  let rung: Effort | null = null;
  for (const effort of allowed) {
    if (EFFORT_RANK[effort] <= EFFORT_RANK[current]) continue;
    if (rung === null || EFFORT_RANK[effort] < EFFORT_RANK[rung]) rung = effort;
  }
  return rung;
}

/** Whether an evidence string names an effort this runtime knows. */
function isEffort(value: string): value is Effort {
  return Object.hasOwn(EFFORT_RANK, value);
}

/** Return a usable operator ladder only when it completely orders authorization. */
function validExecutorOrder(policy: ComputePolicy): readonly string[] {
  const order = policy.executorOrder ?? [];
  if (
    order.length !== policy.allowedModels.length ||
    new Set(order).size !== order.length ||
    !order.every((model) => policy.allowedModels.includes(model))
  ) {
    return [];
  }
  return order;
}

/**
 * The executor an envelope selects on its own, with no execution to continue.
 *
 * One permitted executor is a selection the envelope itself makes. Several are
 * equally authorised, and choosing among them would need an ordering no operator
 * surface declares, so the choice is left open unless an explicit operator ordering exists.
 */
function unambiguousModel(policy: ComputePolicy): string | null {
  const order = validExecutorOrder(policy);
  if (order.length > 0) return order[0] ?? null;
  return policy.allowedModels.length === 1 ? (policy.allowedModels[0] ?? null) : null;
}

/** Sentence naming the selected executor, or explaining an open choice. */
function describeModel(model: string | null, policy: ComputePolicy): string {
  if (model !== null) {
    if (validExecutorOrder(policy).length > 1) {
      return `Selected baseline executor '${model}' from operator-declared ordering.`;
    }
    return `Selected the permitted executor '${model}'.`;
  }
  return (
    `The envelope authorises ${policy.allowedModels.length} executors and declares no ` +
    `ordering among them, so the parent names which one runs.`
  );
}

function decide(
  model: string | null,
  effort: Effort | null,
  reason: SelectionReason,
  detail: string,
): SelectionDecision {
  return { model, effort, reason, detail };
}

/**
 * Select the executor and effort for one next worker turn, or report that none is
 * authorised.
 *
 * Pure and synchronous by contract: same inputs, same decision, no observation of
 * anything outside its arguments.
 */
export function selectCompute(input: SelectionInput): SelectionDecision {
  const { shape, policy, evidence } = input;

  // A shape that enlists nobody is answered before anything else is read, so a
  // solo recommendation can never come back naming an executor to run it with.
  if (shape.mechanism === "solo" || shape.workerCount < 1) {
    return decide(
      null,
      null,
      "solo-no-execution",
      "The recommended shape enlists no worker, so no executor and no effort are selected.",
    );
  }

  const action = evidence?.failureDecision.action;
  if (action !== undefined && !ACTION_AUTHORISES_EXECUTION[action]) {
    return decide(
      null,
      null,
      "no-authorised-next-execution",
      `The classified next action '${action}' authorises no further worker execution; ` +
        `the parent owns what happens next.`,
    );
  }

  // An envelope permitting no effort, or no executor, authorises no execution. The
  // policy schema forbids both, and neither is invented a value for here.
  const floor = lowestPermitted(policy.allowedEfforts);
  if (floor === null || policy.allowedModels.length === 0) {
    return decide(
      null,
      null,
      "no-authorised-next-execution",
      "The envelope permits no executor or no effort level, so nothing can be selected.",
    );
  }

  // Routing already capped this at `high` and bound it to the envelope it ran
  // against. Re-clamping costs nothing and covers a policy narrowed since.
  const startingEffort =
    boundEffort(shape.effort ?? floor, policy.allowedEfforts) ?? floor;

  // Continuity is evidence for *this* envelope only. An execution the envelope no
  // longer permits is not something to continue, and neither its executor nor its
  // effort carries forward from it.
  const continuedModel =
    evidence && policy.allowedModels.includes(evidence.requestedModel)
      ? evidence.requestedModel
      : null;

  if (!evidence || continuedModel === null) {
    const model = unambiguousModel(policy);
    const baseline = `${describeModel(model, policy)} Starting effort '${startingEffort}'.`;
    return evidence
      ? decide(
          model,
          startingEffort,
          "evidence-outside-envelope",
          `The prior execution ran under executor '${evidence.requestedModel}', which this ` +
            `envelope does not permit, so it is not continued. ${baseline}`,
        )
      : decide(
          model,
          startingEffort,
          "conservative-baseline",
          `No prior execution evidence. ${baseline}`,
        );
  }

  // Insufficient effort evidence falls back to the conservative starting effort
  // rather than to a guess, and a readable level is clamped down into the envelope
  // so a narrowing since the last turn is honoured.
  const evidencedEffort = isEffort(evidence.requestedEffort)
    ? (boundEffort(evidence.requestedEffort, policy.allowedEfforts) ?? floor)
    : startingEffort;

  const decision = evidence.failureDecision;
  switch (decision.action) {
    case "repair":
    case "continuation":
    case "retry":
      return decide(
        continuedModel,
        evidencedEffort,
        "same-contract-retry",
        `Action '${decision.action}' runs under the immutable contract: retaining executor ` +
          `'${continuedModel}' at effort '${evidencedEffort}' without escalating either.`,
      );

    case "effort-escalation": {
      if (!policy.allowEffortEscalation) {
        return decide(
          continuedModel,
          evidencedEffort,
          "effort-escalation-not-permitted",
          `Effort escalation was recommended, but this envelope withholds it. Retaining ` +
            `executor '${continuedModel}' at effort '${evidencedEffort}'.`,
        );
      }
      const rung = nextRungAbove(evidencedEffort, policy.allowedEfforts);
      // P1.1 owns whether to escalate and how far. Escalating with no named next
      // effort would originate the decision here; selecting a rung above the named
      // one would widen it. Both are refusals instead.
      if (
        decision.nextEffort === null ||
        rung === null ||
        EFFORT_RANK[rung] > EFFORT_RANK[decision.nextEffort]
      ) {
        return decide(
          continuedModel,
          evidencedEffort,
          "effort-escalation-exhausted",
          `Effort escalation was recommended, but the envelope offers no permitted level ` +
            `above '${evidencedEffort}' at or below the recommended one. Retaining effort ` +
            `'${evidencedEffort}' on executor '${continuedModel}'.`,
        );
      }
      return decide(
        continuedModel,
        rung,
        "effort-escalated",
        `Escalated one rung from '${evidencedEffort}' to '${rung}' on the same executor ` +
          `'${continuedModel}'; the executor is unchanged by this decision.`,
      );
    }

    case "stronger-executor-fallback": {
      if (!policy.allowStrongerFallback) {
        return decide(
          continuedModel,
          evidencedEffort,
          "stronger-executor-not-permitted",
          `A stronger-executor fallback was recommended, but this envelope withholds it. ` +
            `Retaining executor '${continuedModel}' at effort '${evidencedEffort}'.`,
        );
      }

      const order = validExecutorOrder(policy);

      if (order.length <= 1 || !order.includes(continuedModel)) {
        return decide(
          continuedModel,
          evidencedEffort,
          "stronger-executor-unresolvable",
          (policy.allowedModels.length === 1
            ? `A stronger-executor fallback was recommended and is permitted, but the envelope ` +
              `authorises only executor '${continuedModel}'. `
            : `A stronger-executor fallback was recommended and is permitted, but the envelope ` +
              `authorises ${policy.allowedModels.length} executors as a set and declares no ` +
              `strength ordering among them, so none of them is known to be the stronger one. `) +
            `Retaining executor '${continuedModel}' at effort '${evidencedEffort}'; the parent ` +
            `selects any stronger executor.`,
        );
      }

      const currentIndex = order.indexOf(continuedModel);
      const nextModel = order[currentIndex + 1];
      if (!nextModel) {
        return decide(
          continuedModel,
          evidencedEffort,
          "stronger-executor-exhausted",
          `A stronger-executor fallback was recommended, but the operator-declared executor ordering ` +
            `offers no stronger permitted executor above '${continuedModel}'. Retaining executor ` +
            `'${continuedModel}' at effort '${evidencedEffort}'.`,
        );
      }

      return decide(
        nextModel,
        evidencedEffort,
        "stronger-executor-selected",
        `Escalated to stronger executor '${nextModel}' from operator-declared ordering while retaining ` +
          `effort '${evidencedEffort}'.`,
      );
    }

    // Unreachable: `ACTION_AUTHORISES_EXECUTION` returned above for both. Kept so
    // the switch stays total and a new action cannot slip through it silently.
    case "stop":
    case "parent-takeover":
      return decide(
        null,
        null,
        "no-authorised-next-execution",
        `The classified next action '${decision.action}' authorises no further worker execution.`,
      );
  }
}
