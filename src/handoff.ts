import { randomBytes } from "node:crypto";
import type {
  AttemptEvidence,
  DelegateTaskInput,
  DelegateTaskOutput,
  Effort,
  FailureDecision,
  HandoffState,
} from "./contract.js";
import { EFFORTS, LUNA_MODEL } from "./config.js";
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

/**
 * A handoff taken out of circulation but not yet spent.
 *
 * Reserving removes the reference from the issued set and retires it as `used`
 * for every concurrent consumer, so the single-use bound holds for the whole
 * reservation window and two consumers can never both execute. Exactly one of
 * `commit` and `release` settles it; later calls are no-ops.
 *
 * `commit` is called at the moment authoritative execution begins and makes
 * consumption permanent. `release` is called when a pre-execution gate refuses,
 * and returns the still-unspent authority to the issued set with its original
 * expiry. Authority that expired while reserved is retired as `expired` rather
 * than restored, so a reservation can never extend a TTL.
 */
export interface HandoffReservation {
  readonly reference: string;
  readonly entry: HandoffEntry;
  /** Make consumption permanent. Called once authoritative execution begins. */
  commit(): void;
  /** Return unspent authority after a refusal that ran nothing. */
  release(): void;
}

export type HandoffReserveResult =
  | { status: "ready"; reservation: HandoffReservation }
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
  /** Reserved but not yet spent: out of circulation, still restorable. */
  private readonly reserved = new Map<string, HandoffRecord>();
  private readonly retired = new Map<
    string,
    { status: "expired" | "used"; until: number }
  >();
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private disposed = false;

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
    if (this.disposed) throw new Error("Handoff store is shut down.");
    const now = this.now();
    this.prune(now);

    let reference = this.tokenFactory();
    while (
      this.active.has(reference) ||
      this.reserved.has(reference) ||
      this.retired.has(reference)
    ) {
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
    // `requestedEffort` on attempt evidence and `effort` on a result are both
    // plain strings: they record what a turn was *asked* to run at, including
    // values this runtime does not know. Casting the first non-null one to
    // `Effort` wrote an unvalidated string into the restored contract's
    // `previousAttempts[].effort`, which the schema declares as one of `EFFORTS`.
    // Take the first candidate this runtime actually recognises instead, and
    // fall back to the contract's own validated effort.
    const effort =
      [latestAttempt?.requestedEffort, result.effort].find(isEffort) ?? input.effort;
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

  /**
   * Take a reference out of circulation without spending it yet.
   *
   * Synchronous and indivisible: the reference leaves the issued set and is
   * retired as `used` in the same step, so any concurrent consumer is refused
   * for the whole reservation window. The caller settles the reservation with
   * exactly one of `commit` (authoritative execution began) or `release` (a
   * pre-execution gate refused and nothing ran).
   */
  reserve(reference: string): HandoffReserveResult {
    if (this.disposed) return { status: "unknown" };
    const taken = this.take(reference);
    if (taken.status !== "ready") return taken;
    const { record, entry } = taken;

    let settled = false;
    const reservation: HandoffReservation = {
      reference,
      entry,
      commit: () => {
        if (settled) return;
        settled = true;
        // The record is already retired as `used`; dropping the reserved copy
        // is what makes consumption permanent.
        this.reserved.delete(reference);
      },
      release: () => {
        if (settled) return;
        settled = true;
        this.reserved.delete(reference);
        const now = this.now();
        if (now >= record.expiresAt) {
          // A reservation never extends a TTL. Authority that expired while it
          // was held is retired, not handed back.
          this.retired.set(reference, {
            status: "expired",
            until: now + HANDOFF_TTL_MS,
          });
          return;
        }
        this.retired.delete(reference);
        this.active.set(reference, record);
      },
    };
    this.reserved.set(reference, record);
    return { status: "ready", reservation };
  }

  /**
   * Consume a reference atomically, enforcing expiry and single-use bound.
   *
   * Equivalent to reserving and immediately committing. Retained for callers
   * that have no pre-execution gate left to run between the two.
   */
  consume(reference: string): HandoffConsumeResult {
    if (this.disposed) return { status: "unknown" };
    const taken = this.take(reference);
    if (taken.status !== "ready") return taken;
    return { status: "ready", entry: taken.entry };
  }

  /** The one place a reference leaves the issued set. */
  private take(
    reference: string,
  ):
    | { status: "ready"; record: HandoffRecord; entry: HandoffEntry }
    | { status: "invalid" | "unknown" | "expired" | "used" } {
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
        record,
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

    if (this.reserved.has(reference)) return { status: "used" };

    const retired = this.retired.get(reference);
    if (retired && now < retired.until) return { status: retired.status };
    if (retired) this.retired.delete(reference);
    return { status: "unknown" };
  }

  /**
   * Check live status of a handoff reference without consuming it.
   *
   * A reserved reference reads as `consumed`: it is out of circulation and no
   * other consumer may act on it. If the reservation is later released the
   * reference returns to `issued`, which is the conservative direction - a
   * reader is never told authority is available while someone holds it.
   */
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
    if (this.reserved.has(reference)) return "consumed";
    const retired = this.retired.get(reference);
    if (retired && now < retired.until) {
      return retired.status === "used" ? "consumed" : "unavailable";
    }
    return "unavailable";
  }

  /** Invalidate all process-local authority during server shutdown. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active.clear();
    this.reserved.clear();
    this.retired.clear();
  }

  /**
   * Whether an unspent reference still owns a lifecycle context.
   *
   * Reserved records count: a reservation still holds live authority bound to
   * that context, so reclaiming it while the reservation is open would strand a
   * capability that may yet be released back into circulation.
   */
  hasContextKey(contextKey: string): boolean {
    this.prune(this.now());
    return [...this.active.values(), ...this.reserved.values()].some(
      (record) => record.contextKey === contextKey,
    );
  }

  /** Reserved records are deliberately not pruned; their holder settles them. */
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
      if (this.reserved.has(reference)) continue;
      if (now >= retired.until) this.retired.delete(reference);
    }
  }
}

/** Whether a recorded effort string names a level this runtime knows. */
function isEffort(value: string | undefined): value is Effort {
  return value !== undefined && (EFFORTS as readonly string[]).includes(value);
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
