import { randomBytes } from "node:crypto";
import type { DelegateTaskInput } from "./contract.js";

/** How long an unused continuation remains valid in one server process. */
export const CONTINUATION_TTL_MS = 15 * 60 * 1000;

const CONTINUATION_PREFIX = "ctr_";

interface ContinuationRecord {
  input: DelegateTaskInput;
  threadId: string;
  workingDirectory: string;
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
  issue(input: DelegateTaskInput, threadId: string, workingDirectory: string): string {
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
      this.retired.set(reference, { status: "used", until: now + CONTINUATION_TTL_MS });
      return {
        status: "ready",
        entry: {
          input: cloneTaskInput(record.input),
          threadId: record.threadId,
          workingDirectory: record.workingDirectory,
        },
      };
    }

    const retired = this.retired.get(reference);
    if (retired && now < retired.until) return { status: retired.status };
    if (retired) this.retired.delete(reference);
    return { status: "unknown" };
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
  };
}
