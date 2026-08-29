import { randomBytes } from "node:crypto";
import type { ContinuationState, DelegateTaskInput } from "./contract.js";
import { LUNA_MODEL } from "./config.js";
import type { WorktreeLease } from "./worktree.js";

/** How long an unused continuation remains valid in one server process. */
export const CONTINUATION_TTL_MS = 15 * 60 * 1000;

const CONTINUATION_PREFIX = "ctr_";

interface ContinuationRecord {
  input: DelegateTaskInput;
  threadId: string;
  workingDirectory: string;
  /**
   * Where a *fresh* attempt of this contract belongs.
   *
   * Identical to `workingDirectory` for work that already runs in the shared
   * workspace. For a retained parallel worktree the two differ: the resumed
   * thread must continue inside the worktree, but a next-action handoff issued
   * after that turn restarts the contract and must not be bound to a directory
   * whose lease this turn releases on the way out.
   */
  authoritativeWorkspace: string;
  reconcileFinalGit: boolean;
  worktreeLease: WorktreeLease | null;
  predecessorExecutionId: string | null;
  logicalAttempt: number;
  model: string;
  /** Internal lifecycle owner; never exposed as a capability or accepted from callers. */
  contextKey: string | null;
  expiresAt: number;
}

interface RetiredReference {
  status: "expired" | "used";
  until: number;
}

export interface ContinuationEntry {
  input: DelegateTaskInput;
  threadId: string;
  workingDirectory: string;
  /** Where a fresh attempt belongs; never a lease-protected retained worktree. */
  authoritativeWorkspace: string;
  /** Retained parallel worktrees need a fresh final Git snapshot after continuation. */
  reconcileFinalGit: boolean;
  /** Exact persistent owner for a retained parallel worktree, when applicable. */
  worktreeLease: WorktreeLease | null;
  /** Factual in-process lineage; never persisted across server sessions. */
  predecessorExecutionId: string | null;
  logicalAttempt: number;
  /** Executor that owns the thread and must be used when resuming it. */
  model: string;
  /** Internal lifecycle owner restored only from this server-issued reference. */
  contextKey: string | null;
}

export type ContinuationConsumeResult =
  | { status: "ready"; entry: ContinuationEntry }
  | { status: "invalid" | "unknown" | "expired" | "used" };

export interface ContinuationStoreOptions {
  /** Injected clock keeps expiry tests deterministic. */
  now?: () => number;
  /** Injected only for deterministic tests; production references remain opaque. */
  tokenFactory?: () => string;
  /**
   * Surrender a persistent worktree lease an expiring continuation still owns.
   *
   * An expiring reference is the last in-process owner of the retained worktree
   * it protected. Without this the reservation outlived the capability that
   * justified it and kept `pruneStaleWorktrees` from reclaiming the identity
   * until the lease-s own, unrelated filesystem TTL ran out. Called at most
   * once per record, on the single transition out of the issued set, and never
   * for a record that was consumed: the consuming turn owns the lease then.
   */
  releaseLease?: (lease: WorktreeLease) => void | Promise<void>;
}

/**
 * Server-lifetime, single-use continuation references.
 *
 * The store deliberately keeps the original parsed contract rather than any
 * caller-provided continuation fields. A continuation can add an instruction,
 * but it cannot replace the objective, scope, change intent, or verification.
 */
export class ContinuationStore {
  private readonly active = new Map<string, ContinuationRecord>();
  /** Consumed references stay leased until their one continuation turn exits. */
  private readonly leased = new Map<string, ContinuationRecord>();
  private readonly retired = new Map<string, RetiredReference>();
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly releaseLease?: (lease: WorktreeLease) => void | Promise<void>;
  /** Settles when every lease surrendered by expiry so far has been released. */
  private leaseReleases: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: ContinuationStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenFactory =
      options.tokenFactory ??
      (() => `${CONTINUATION_PREFIX}${randomBytes(24).toString("base64url")}`);
    this.releaseLease = options.releaseLease;
  }

  /** Issue one opaque reference for an observed worker thread. */
  issue(
    input: DelegateTaskInput,
    threadId: string,
    workingDirectory: string,
    reconcileFinalGit = false,
    worktreeLease: WorktreeLease | null = null,
    predecessorExecutionId: string | null = null,
    logicalAttempt = input.previousAttempts.length + 2,
    model = LUNA_MODEL,
    contextKey: string | null = null,
    authoritativeWorkspace: string = workingDirectory,
  ): string {
    if (this.disposed) throw new Error("Continuation store is shut down.");
    const now = this.now();
    this.prune(now);

    let reference = this.tokenFactory();
    while (
      this.active.has(reference) ||
      this.leased.has(reference) ||
      this.retired.has(reference)
    ) {
      reference = `${reference}_`;
    }

    this.active.set(reference, {
      input: cloneTaskInput(input),
      threadId,
      workingDirectory,
      authoritativeWorkspace,
      reconcileFinalGit,
      worktreeLease: worktreeLease ? { ...worktreeLease } : null,
      predecessorExecutionId,
      logicalAttempt,
      model,
      contextKey,
      expiresAt: now + CONTINUATION_TTL_MS,
    });
    return reference;
  }

  /** Consume a reference atomically, enforcing expiry and the one-turn bound. */
  consume(reference: string): ContinuationConsumeResult {
    if (this.disposed) return { status: "unknown" };
    if (!isContinuationReference(reference)) return { status: "invalid" };

    const now = this.now();
    const record = this.active.get(reference);
    if (record) {
      if (now >= record.expiresAt) {
        this.expire(reference, record, now);
        return { status: "expired" };
      }

      this.active.delete(reference);
      this.leased.set(reference, record);
      this.retired.set(reference, { status: "used", until: now + CONTINUATION_TTL_MS });
      return {
        status: "ready",
        entry: {
          input: cloneTaskInput(record.input),
          threadId: record.threadId,
          workingDirectory: record.workingDirectory,
          authoritativeWorkspace: record.authoritativeWorkspace,
          reconcileFinalGit: record.reconcileFinalGit,
          worktreeLease: record.worktreeLease ? { ...record.worktreeLease } : null,
          predecessorExecutionId: record.predecessorExecutionId,
          logicalAttempt: record.logicalAttempt,
          model: record.model,
          contextKey: record.contextKey,
        },
      };
    }

    const retired = this.retired.get(reference);
    if (retired && now < retired.until) return { status: retired.status };
    if (retired) this.retired.delete(reference);
    return { status: "unknown" };
  }

  /** Release the filesystem lease after the consumed continuation turn exits. */
  release(reference: string): void {
    this.leased.delete(reference);
  }

  /** Check live status of a continuation reference without consuming it. */
  status(reference: string): ContinuationState {
    if (!isContinuationReference(reference)) return "unavailable";
    const now = this.now();
    this.prune(now);
    const record = this.active.get(reference);
    if (record) {
      if (now >= record.expiresAt) {
        return "unavailable";
      }
      return "issued";
    }
    const leased = this.leased.get(reference);
    if (leased) {
      return "consumed";
    }
    const retired = this.retired.get(reference);
    if (retired && now < retired.until) {
      return retired.status === "used" ? "consumed" : "unavailable";
    }
    return "unavailable";
  }

  /** Whether an active or executing reference still owns a lifecycle context. */
  hasContextKey(contextKey: string): boolean {
    this.prune(this.now());
    return [...this.active.values(), ...this.leased.values()].some(
      (record) => record.contextKey === contextKey,
    );
  }

  /** Directories that must not be pruned while a reference can still use them. */
  protectedWorkingDirectories(): string[] {
    this.prune(this.now());
    return [
      ...new Set(
        [...this.active.values(), ...this.leased.values()].map(
          (record) => record.workingDirectory,
        ),
      ),
    ];
  }

  /**
   * Resolves once every lease surrendered by expiry so far has been released.
   *
   * Expiry is reached from synchronous call sites, so the release itself cannot
   * be awaited there. Tests await this instead of racing the filesystem.
   */
  whenExpiredLeasesReleased(): Promise<void> {
    return this.leaseReleases;
  }

  /** Expire every process-local capability and surrender retained leases once. */
  async dispose(): Promise<void> {
    if (this.disposed) return this.leaseReleases;
    this.disposed = true;
    const records = [...this.active.values(), ...this.leased.values()];
    this.active.clear();
    this.leased.clear();
    this.retired.clear();
    if (this.releaseLease) {
      const release = this.releaseLease;
      for (const record of records) {
        const lease = record.worktreeLease;
        if (!lease) continue;
        record.worktreeLease = null;
        this.leaseReleases = this.leaseReleases.then(async () => {
          await Promise.resolve(release(lease));
        });
      }
    }
    await this.leaseReleases;
  }

  /**
   * The one transition out of the issued set that nobody is left to settle.
   *
   * Whatever the record still owns is surrendered here, exactly once: the
   * record is removed from `active` first, so a concurrent expiry, consume, or
   * prune of the same reference cannot reach it a second time.
   */
  private expire(reference: string, record: ContinuationRecord, now: number): void {
    this.active.delete(reference);
    this.retired.set(reference, {
      status: "expired",
      until: now + CONTINUATION_TTL_MS,
    });
    const lease = record.worktreeLease;
    if (!lease || !this.releaseLease) return;
    record.worktreeLease = null;
    const release = this.releaseLease;
    this.leaseReleases = this.leaseReleases.then(async () => {
      // Best effort by construction: the reference is already gone, and a
      // failed release leaves only the lease own bounded filesystem TTL.
      await Promise.resolve(release(lease)).catch(() => undefined);
    });
  }

  private prune(now: number): void {
    for (const [reference, record] of this.active) {
      if (now >= record.expiresAt) this.expire(reference, record, now);
    }
    for (const [reference, retired] of this.retired) {
      if (this.leased.has(reference)) continue;
      if (now >= retired.until) this.retired.delete(reference);
    }
  }
}

export function isContinuationReference(value: string): boolean {
  // Upper bound matches `isHandoffReference`: a reference this store could
  // have issued is 36 characters, and only collision suffixes make it longer.
  return /^ctr_[A-Za-z0-9_-]{32,124}$/.test(value);
}

function cloneTaskInput(input: DelegateTaskInput): DelegateTaskInput {
  return {
    ...input,
    allowedFiles: [...input.allowedFiles],
    forbiddenFiles: [...input.forbiddenFiles],
    acceptanceCriteria: [...input.acceptanceCriteria],
    verificationCommands: [...input.verificationCommands],
    previousAttempts: input.previousAttempts.map((attempt) => ({ ...attempt })),
    contextCapsule: input.contextCapsule ? { ...input.contextCapsule } : undefined,
    // A continuation runs under the envelope its original delegation was
    // admitted under, so the resolved policy is retained rather than re-derived.
    // Spread conditionally: adding a `computePolicy: undefined` key to a
    // contract that never carried one would break contract-identity checks.
    ...(input.computePolicy
      ? {
          computePolicy: {
            ...input.computePolicy,
            ...(input.computePolicy.allowedModels
              ? { allowedModels: [...input.computePolicy.allowedModels] }
              : {}),
            ...(input.computePolicy.allowedEfforts
              ? { allowedEfforts: [...input.computePolicy.allowedEfforts] }
              : {}),
            ...(input.computePolicy.executorOrder
              ? { executorOrder: [...input.computePolicy.executorOrder] }
              : {}),
          },
        }
      : {}),
  };
}
