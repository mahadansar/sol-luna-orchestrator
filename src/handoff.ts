import { randomBytes } from "node:crypto";
import type {
  AttemptEvidence,
  DelegateTaskInput,
  DelegateTaskOutput,
  Effort,
  FailureDecision,
  HandoffState,
} from "./contract.js";
import { LUNA_MODEL } from "./config.js";
import { resultWasCancelled } from "./worker.js";

/** How long an unused next-action handoff remains valid in one server process. */
export const HANDOFF_TTL_MS = 15 * 60 * 1000;

export const HANDOFF_PREFIX = "hdf_";

export interface HandoffRecord {
  input: DelegateTaskInput;
  predecessorExecutionId: string | null;
  logicalAttempt: number;
  model: string;
  effort: Effort;
  failureDecision: FailureDecision;
  attemptEvidence: readonly AttemptEvidence[];
  /** Internal lifecycle owner; never exposed as a capability or accepted from callers. */
  contextKey: string | null;
  expiresAt: number;
}

export interface HandoffEntry {
  input: DelegateTaskInput;
  predecessorExecutionId: string | null;
  logicalAttempt: number;
  model: string;
  effort: Effort;
  failureDecision: FailureDecision;
  attemptEvidence: readonly AttemptEvidence[];
  /** Internal lifecycle owner restored only from this server-issued reference. */
  contextKey: string | null;
}

export type HandoffConsumeResult =
  | { status: "ready"; entry: HandoffEntry }
  | { status: "invalid" | "unknown" | "expired" | "used" };

export interface HandoffStoreOptions {
  now?: () => number;
  tokenFactory?: () => string;
}

/**
 * Server-lifetime, single-use next-action handoff references.
 *
 * Stores the immutable original task contract, authoritative completed attempt
 * evidence, and truthful predecessor lineage. Caller-supplied previousAttempts
 * or modified contracts cannot authorize escalation or stronger executors; only a
 * valid server-issued reference bound to prior execution evidence can.
 */
export class HandoffStore {
  private readonly active = new Map<string, HandoffRecord>();
  private readonly retired = new Map<
    string,
    { status: "expired" | "used"; until: number }
  >();
  private readonly now: () => number;
  private readonly tokenFactory: () => string;

  constructor(options: HandoffStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenFactory =
      options.tokenFactory ??
      (() => `${HANDOFF_PREFIX}${randomBytes(24).toString("base64url")}`);
  }

  /** Issue one opaque reference for an earned P1.1 failure decision. */
  issue(
    input: DelegateTaskInput,
    result: DelegateTaskOutput,
    predecessorExecutionId: string | null = null,
    contextKey: string | null = null,
  ): string {
    const now = this.now();
    this.prune(now);

    let reference = this.tokenFactory();
    while (this.active.has(reference) || this.retired.has(reference)) {
      reference = `${reference}_`;
    }

    const decision = result.failureDecision ?? {
      classification: "unknown" as const,
      action: "parent-takeover" as const,
      reason: "No failure decision provided",
      evidenceExecutionIds: [],
      nextEffort: null,
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1 as const,
    };

    const latestAttempt = result.attempts?.at(-1);
    const executionId = latestAttempt?.executionId ?? predecessorExecutionId ?? null;
    const model = latestAttempt?.requestedModel ?? result.model ?? LUNA_MODEL;
    const effort = (latestAttempt?.requestedEffort ??
      result.effort ??
      input.effort) as Effort;
    const logicalAttempt =
      (latestAttempt?.logicalAttempt ??
        result.attempt ??
        input.previousAttempts.length + 1) + 1;
    const attempts = structuredClone(result.attempts ?? []);

    this.active.set(reference, {
      input: cloneTaskInput(input),
      predecessorExecutionId: executionId,
      logicalAttempt,
      model,
      effort,
      failureDecision: structuredClone(decision),
      attemptEvidence: attempts,
      contextKey,
      expiresAt: now + HANDOFF_TTL_MS,
    });
    return reference;
  }

  /** Consume a reference atomically, enforcing expiry and single-use bound. */
  consume(reference: string): HandoffConsumeResult {
    if (!isHandoffReference(reference)) return { status: "invalid" };

    const now = this.now();
    const record = this.active.get(reference);
    if (record) {
      if (now >= record.expiresAt) {
        this.active.delete(reference);
        this.retired.set(reference, {
          status: "expired",
          until: now + HANDOFF_TTL_MS,
        });
        return { status: "expired" };
      }

      this.active.delete(reference);
      this.retired.set(reference, { status: "used", until: now + HANDOFF_TTL_MS });
      return {
        status: "ready",
        entry: {
          input: cloneTaskInput(record.input),
          predecessorExecutionId: record.predecessorExecutionId,
          logicalAttempt: record.logicalAttempt,
          model: record.model,
          effort: record.effort,
          failureDecision: structuredClone(record.failureDecision),
          attemptEvidence: structuredClone(record.attemptEvidence),
          contextKey: record.contextKey,
        },
      };
    }

    const retired = this.retired.get(reference);
    if (retired && now < retired.until) return { status: retired.status };
    if (retired) this.retired.delete(reference);
    return { status: "unknown" };
  }

  /** Check live status of a handoff reference without consuming it. */
  status(reference: string): HandoffState {
    if (!isHandoffReference(reference)) return "unavailable";
    const now = this.now();
    this.prune(now);
    const record = this.active.get(reference);
    if (record) {
      if (now >= record.expiresAt) {
        return "unavailable";
      }
      return "issued";
    }
    const retired = this.retired.get(reference);
    if (retired && now < retired.until) {
      return retired.status === "used" ? "consumed" : "unavailable";
    }
    return "unavailable";
  }

  /** Whether an unused reference still owns a lifecycle context. */
  hasContextKey(contextKey: string): boolean {
    this.prune(this.now());
    return [...this.active.values()].some((record) => record.contextKey === contextKey);
  }

  private prune(now: number): void {
    for (const [reference, record] of this.active) {
      if (now >= record.expiresAt) {
        this.active.delete(reference);
        this.retired.set(reference, {
          status: "expired",
          until: now + HANDOFF_TTL_MS,
        });
      }
    }
    for (const [reference, retired] of this.retired) {
      if (now >= retired.until) this.retired.delete(reference);
    }
  }
}

export function isHandoffReference(value: string): boolean {
  return /^hdf_[A-Za-z0-9_-]{32,124}$/.test(value);
}

export function handoffError(result: HandoffConsumeResult): string {
  switch (result.status) {
    case "invalid":
      return "Invalid handoff reference. Use the opaque reference returned by an eligible result.";
    case "expired":
      return "Handoff reference expired. Delegate a fresh task if more work is needed.";
    case "used":
      return "Handoff reference already consumed. Only one execution is allowed per earned next-action handoff.";
    case "unknown":
      return "Unknown handoff reference. It may belong to another server process or was never issued.";
    case "ready":
      return "";
  }
}

export function registerHandoff(
  input: DelegateTaskInput,
  result: DelegateTaskOutput,
  handoffStore: HandoffStore,
  options: {
    authoritativePrior?: boolean;
    workingDirectory?: string;
    contextKey?: string | null;
  } = {},
): string | null {
  if (resultWasCancelled(result) || result.verdict === "PASS") {
    result.handoffState = {
      status: "not-eligible",
      reason: "Successful or cancelled results are not eligible for next-action handoff.",
    };
    result.handoffReference = null;
    return null;
  }
  const decision = result.failureDecision;
  if (!decision) {
    result.handoffState = {
      status: "not-eligible",
      reason: "No failure decision was classified.",
    };
    result.handoffReference = null;
    return null;
  }
  if (
    decision.action !== "effort-escalation" &&
    decision.action !== "stronger-executor-fallback" &&
    decision.action !== "retry"
  ) {
    result.handoffState = {
      status: "not-eligible",
      reason: `Action '${decision.action}' is not eligible for next-action handoff.`,
    };
    result.handoffReference = null;
    return null;
  }
  if (decision.action !== "retry" && !options.authoritativePrior) {
    result.handoffState = {
      status: "not-eligible",
      reason:
        "Escalation requires predecessor authority from a consumed server-issued handoff; caller history alone is insufficient.",
    };
    result.handoffReference = null;
    return null;
  }
  const predecessorExecutionId = result.attempts?.at(-1)?.executionId ?? null;
  const authoritativeInput = options.workingDirectory
    ? { ...input, workingDirectory: options.workingDirectory }
    : input;
  const reference = handoffStore.issue(
    authoritativeInput,
    result,
    predecessorExecutionId,
    options.contextKey ?? null,
  );
  result.handoffReference = reference;
  result.handoffState = {
    status: "issued",
    reason: `One bounded next-action handoff reference was issued for earned action '${decision.action}'.`,
  };
  return reference;
}

function cloneTaskInput(input: DelegateTaskInput): DelegateTaskInput {
  return structuredClone(input);
}
