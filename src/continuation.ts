import { randomBytes } from "node:crypto";
import type { DelegateTaskInput } from "./contract.js";
import { LUNA_MODEL } from "./config.js";
import type { WorktreeLease } from "./worktree.js";

/** How long an unused continuation remains valid in one server process. */
export const CONTINUATION_TTL_MS = 15 * 60 * 1000;

const CONTINUATION_PREFIX = "ctr_";

interface ContinuationRecord {
  input: DelegateTaskInput;
  threadId: string;
  workingDirectory: string;
  reconcileFinalGit: boolean;
  worktreeLease: WorktreeLease | null;
  predecessorExecutionId: string | null;
  logicalAttempt: number;
  model: string;
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
  /** Retained parallel worktrees need a fresh final Git snapshot after continuation. */
  reconcileFinalGit: boolean;
  /** Exact persistent owner for a retained parallel worktree, when applicable. */
  worktreeLease: WorktreeLease | null;
  /** Factual in-process lineage; never persisted across server sessions. */
  predecessorExecutionId: string | null;
  logicalAttempt: number;
  /** Executor that owns the thread and must be used when resuming it. */
  model: string;
}

export type ContinuationConsumeResult =
  | { status: "ready"; entry: ContinuationEntry }
  | { status: "invalid" | "unknown" | "expired" | "used" };

export interface ContinuationStoreOptions {
  /** Injected clock keeps expiry tests deterministic. */
  now?: () => number;
  /** Injected only for deterministic tests; production references remain opaque. */
  tokenFactory?: () => string;
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

  constructor(options: ContinuationStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenFactory =
      options.tokenFactory ??
      (() => `${CONTINUATION_PREFIX}${randomBytes(24).toString("base64url")}`);
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
  ): string {
    const now = this.now();
    this.prune(now);

    let reference = this.tokenFactory();
    while (this.active.has(reference) || this.retired.has(reference)) {
      reference = `${reference}_`;
    }

    this.active.set(reference, {
      input: cloneTaskInput(input),
      threadId,
      workingDirectory,
      reconcileFinalGit,
      worktreeLease: worktreeLease ? { ...worktreeLease } : null,
      predecessorExecutionId,
      logicalAttempt,
      model,
      expiresAt: now + CONTINUATION_TTL_MS,
    });
    return reference;
  }

  /** Consume a reference atomically, enforcing expiry and the one-turn bound. */
  consume(reference: string): ContinuationConsumeResult {
    if (!isContinuationReference(reference)) return { status: "invalid" };

    const now = this.now();
    const record = this.active.get(reference);
    if (record) {
      if (now >= record.expiresAt) {
        this.active.delete(reference);
        this.retired.set(reference, {
          status: "expired",
          until: now + CONTINUATION_TTL_MS,
        });
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
          reconcileFinalGit: record.reconcileFinalGit,
          worktreeLease: record.worktreeLease ? { ...record.worktreeLease } : null,
          predecessorExecutionId: record.predecessorExecutionId,
          logicalAttempt: record.logicalAttempt,
          model: record.model,
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

  private prune(now: number): void {
    for (const [reference, record] of this.active) {
      if (now >= record.expiresAt) {
        this.active.delete(reference);
        this.retired.set(reference, {
          status: "expired",
          until: now + CONTINUATION_TTL_MS,
        });
      }
    }
    for (const [reference, retired] of this.retired) {
      if (now >= retired.until) this.retired.delete(reference);
    }
  }
}

export function isContinuationReference(value: string): boolean {
  return /^ctr_[A-Za-z0-9_-]{32,}$/.test(value);
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
