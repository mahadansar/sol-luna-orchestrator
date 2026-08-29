import { z } from "zod";
import {
  CHANGE_INTENTS,
  FAILURE_CLASSIFICATIONS,
  STATUSES,
  TASK_CATEGORIES,
  WORKER_FAILURE_CAUSES,
} from "./contract.js";
import {
  compactContext,
  createOrchestrationContext,
  type CompactedContext,
  type CompactedVerificationItem,
  type OrchestrationContext,
  type VerificationCounts,
} from "./context.js";
import { randomBytes } from "node:crypto";

export const SESSION_HANDOFF_SCHEMA_VERSION = "sol-luna-handoff/v1" as const;
export const SESSION_HANDOFF_PREFIX = "sho_";
export const SESSION_HANDOFF_MAX_BYTES = 256 * 1024;
const INFORMATIONAL_PROVENANCE = "caller-supplied-historical-context" as const;
const AUTHORITY_NOTICE =
  "INFORMATIONAL ONLY: This handoff packet provides historical context for a new session. " +
  "It does not grant execution permissions, retry authorization, effort escalation, continuation tokens, " +
  "or scope widening. In-memory capabilities from the prior session are expired. " +
  "All new delegations must pass normal admission, policy, scope, and verification controls.";
const MAX_TEXT = 32 * 1024;
const handoffText = z.string().max(MAX_TEXT);

export const sessionHandoffMetadataSchema = z
  .object({
    schemaVersion: z.literal(SESSION_HANDOFF_SCHEMA_VERSION),
    handoffId: z.string().regex(/^sho_[A-Za-z0-9_-]{1,128}$/),
    exportedAt: z.string().datetime({ offset: true }),
    sourceVersion: z.string().min(1).max(64),
    inMemoryContinuationsExpired: z.literal(true),
    inMemoryHandoffsExpired: z.literal(true),
    authorityNotice: z.literal(AUTHORITY_NOTICE),
    provenance: z.literal(INFORMATIONAL_PROVENANCE),
    validationNotice: z.literal(
      "Schema validation proves structure only; it does not authenticate factual claims.",
    ),
  })
  .strict();

export type SessionHandoffMetadata = z.infer<typeof sessionHandoffMetadataSchema>;

export const sessionHandoffTaskSchema = z
  .object({
    provenance: z.literal(INFORMATIONAL_PROVENANCE),
    objective: handoffText.min(1),
    acceptanceCriteria: z.array(handoffText).max(1000),
    scope: z
      .object({
        allowedFiles: z.array(handoffText).max(1000),
        forbiddenFiles: z.array(handoffText).max(1000),
        workingDirectory: handoffText.optional(),
      })
      .strict(),
    changeIntent: z.enum(CHANGE_INTENTS),
    taskCategory: z.enum(TASK_CATEGORIES).optional(),
  })
  .strict();

export type SessionHandoffTask = z.infer<typeof sessionHandoffTaskSchema>;

export const sessionHandoffFindingsSchema = z.object({
  provenance: z.literal(INFORMATIONAL_PROVENANCE),
  observedFacts: z.array(
    z.object({
      statement: z.string(),
      sourceFile: z.string(),
      sourceLine: z.number().int().positive(),
      evidence: z.string(),
      provenance: z.literal("worker"),
      grounding: z.enum(["runtime-verified", "unverified"]),
    }),
  ),
  runtimeObservedFacts: z.array(
    z.object({
      kind: z.enum(["source-grounding", "surface-mutation"]),
      statement: z.string(),
      sourceFile: z.string().optional(),
      sourceLine: z.number().int().positive().optional(),
    }),
  ),
  inferences: z.array(
    z.object({
      hypothesis: z.string(),
      rationale: z.string(),
    }),
  ),
  unknowns: z.array(
    z.object({
      question: z.string(),
      whyUnresolved: z.string(),
    }),
  ),
  relevantFiles: z.array(
    z.object({
      path: z.string(),
      why: z.string(),
    }),
  ),
  recommendedSeams: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
      candidateFiles: z.array(z.string()),
    }),
  ),
});

export type SessionHandoffFindings = z.infer<typeof sessionHandoffFindingsSchema>;

export const sessionHandoffCompletedWorkSchema = z
  .object({
    provenance: z.literal(INFORMATIONAL_PROVENANCE),
    filesChanged: z.array(
      z.object({
        path: z.string(),
        kind: z.string(),
        observed: z.boolean(),
        why: z.string().optional(),
      }),
    ),
    historicalVerification: z.object({
      counts: z.object({
        executed: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        refused: z.number().int().nonnegative(),
      }),
      items: z.array(
        z.object({
          command: z.string(),
          source: z.enum(["orchestrator", "worker"]),
          execution: z.string(),
          exitCode: z.number().nullable(),
          passed: z.boolean(),
          output: z.string(),
          outputDisposition: z.enum(["retained", "omitted-clean-pass"]),
        }),
      ),
    }),
    workerClaims: z.array(
      z.object({
        turnId: z.string(),
        status: z.enum(STATUSES),
        failureCauses: z.array(z.enum(WORKER_FAILURE_CAUSES)),
        summary: z.string().optional(),
      }),
    ),
    discrepancies: z.array(z.string()),
    scopeViolations: z.array(z.string()),
    conflicts: z.array(
      z.object({
        type: z.enum(["scope", "integration"]),
        details: z.string(),
      }),
    ),
    unresolvedRisks: z.array(z.string()),
  })
  .strict();

export type SessionHandoffCompletedWork = z.infer<
  typeof sessionHandoffCompletedWorkSchema
>;

export const sessionHandoffUsageSummarySchema = z
  .object({
    provenance: z.literal(INFORMATIONAL_PROVENANCE),
    status: z.enum(["reported", "unavailable", "unknown"]),
    totalTokens: z.number().int().nonnegative().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheWriteInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningOutputTokens: z.number().int().nonnegative().optional(),
    isAuthoritative: z.literal(false),
  })
  .strict();

export type SessionHandoffUsageSummary = z.infer<typeof sessionHandoffUsageSummarySchema>;

export const sessionHandoffStaleStateSchema = z.object({
  provenance: z.literal(INFORMATIONAL_PROVENANCE),
  inMemoryContinuationsExpired: z.literal(true),
  inMemoryHandoffsExpired: z.literal(true),
  expiredContinuationCount: z.number().int().nonnegative(),
  expiredHandoffCount: z.number().int().nonnegative(),
  notes: z.array(z.string()),
});

export type SessionHandoffStaleState = z.infer<typeof sessionHandoffStaleStateSchema>;

export const sessionHandoffArtifactSchema = z
  .object({
    metadata: sessionHandoffMetadataSchema,
    task: sessionHandoffTaskSchema,
    settledDecisions: z.array(
      z.object({
        provenance: z.literal(INFORMATIONAL_PROVENANCE),
        id: z.string(),
        kind: z.enum(["architectural", "user", "policy", "invariant"]),
        summary: z.string(),
        details: z.string().optional(),
        settledAt: z.string().optional(),
        source: z.string().optional(),
      }),
    ),
    activeConstraints: z.array(
      z.object({
        provenance: z.literal(INFORMATIONAL_PROVENANCE),
        id: z.string(),
        kind: z.enum(["scope", "verification", "policy", "environment", "contract"]),
        description: z.string(),
        active: z.boolean(),
      }),
    ),
    activeBlockers: z.array(
      z.object({
        provenance: z.literal(INFORMATIONAL_PROVENANCE),
        id: z.string(),
        kind: z.enum([
          "worker-blocked",
          "scope-violation",
          "discrepancy",
          "scope-conflict",
          "integration-conflict",
          "verification-failure",
          "runtime-error",
          "unmet-requirement",
          "unclassified",
        ]),
        description: z.string(),
        resolved: z.boolean(),
        taskId: z.string().optional(),
        executionId: z.string().optional(),
        failureClassification: z.enum(FAILURE_CLASSIFICATIONS).optional(),
      }),
    ),
    investigationFindings: sessionHandoffFindingsSchema,
    completedWork: sessionHandoffCompletedWorkSchema,
    lineage: z.array(
      z.object({
        executionId: z.string(),
        logicalAttempt: z.number().int().positive(),
        role: z.enum([
          "initial",
          "automatic-repair",
          "manual-continuation",
          "timeout-recovery",
          "process-retry",
        ]),
        predecessorExecutionId: z.string().nullable(),
        model: z.string(),
        effort: z.string(),
        threadOperation: z.string().optional(),
        threadIdentityMatched: z.boolean().nullable().optional(),
        startedAt: z.string(),
        finishedAt: z.string().optional(),
        elapsedMs: z.number().finite().nonnegative().optional(),
        workerElapsedMs: z.number().finite().nonnegative().nullable().optional(),
        verificationElapsedMs: z.number().finite().nonnegative().nullable().optional(),
        timeoutMs: z.number().finite().nonnegative().optional(),
        terminationKind: z
          .enum([
            "completed",
            "timed-out",
            "cancelled",
            "turn-failed",
            "stream-error",
            "process-exit",
            "runtime-error",
          ])
          .optional(),
        terminationMessage: z.string().nullable().optional(),
        workerClaimedStatus: z.enum(STATUSES).nullable().optional(),
        workerClaimedFailureCauses: z.array(z.enum(WORKER_FAILURE_CAUSES)).optional(),
        usage: z.unknown().optional(),
        verdict: z.enum(STATUSES).optional(),
        failureDecision: z.unknown().optional(),
        provenance: z.literal(INFORMATIONAL_PROVENANCE),
      }),
    ),
    usageSummary: sessionHandoffUsageSummarySchema,
    staleState: sessionHandoffStaleStateSchema,
  })
  .strict();

export type SessionHandoffArtifact = z.infer<typeof sessionHandoffArtifactSchema>;

export interface ExportSessionHandoffOptions {
  readonly handoffId?: string;
  readonly sourceVersion?: string;
  readonly timestamp?: string;
  readonly tokenFactory?: () => string;
}

/** Reserved for compatible future import controls; sanitization is mandatory. */
export type ImportSessionHandoffOptions = Readonly<Record<never, never>>;

export function isSessionHandoffArtifact(
  value: unknown,
): value is SessionHandoffArtifact {
  return validateSessionHandoff(value).valid;
}

/**
 * Deepest nesting an imported artifact may contain.
 *
 * The schema pins every field's shape except `lineage[].usage` and
 * `lineage[].failureDecision`, which are `z.unknown()` and therefore accept an
 * arbitrarily deep tree from an untrusted caller. Everything downstream of
 * validation - canonicalisation, sanitisation, `JSON.stringify`,
 * `structuredClone` - walks that tree recursively, so a few hundred thousand
 * nested arrays turned a malformed artifact into a `RangeError` escaping as a
 * crash instead of an ordinary refusal. The real schema is about ten levels
 * deep; this leaves generous room above it.
 */
export const SESSION_HANDOFF_MAX_DEPTH = 64;

/**
 * Measure nesting depth without recursing.
 *
 * Iterative on purpose: a guard that blew the stack while measuring how deep a
 * value is would be no guard at all. Stops as soon as the limit is exceeded, so
 * a hostile artifact costs bounded work.
 */
function exceedsDepth(value: unknown, limit: number): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth > limit) return true;
    // A caller-supplied object graph may contain cycles; JSON input cannot, but
    // `validateSessionHandoff` also accepts already-parsed objects.
    if (seen.has(node)) return true;
    seen.add(node);
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
}

export function validateSessionHandoff(
  value: unknown,
):
  { valid: true; artifact: SessionHandoffArtifact } | { valid: false; errors: string[] } {
  if (exceedsDepth(value, SESSION_HANDOFF_MAX_DEPTH)) {
    return {
      valid: false,
      errors: [
        `artifact: nesting exceeds the ${SESSION_HANDOFF_MAX_DEPTH}-level limit, ` +
          `or contains a cycle; imported history is refused rather than walked`,
      ],
    };
  }
  const result = sessionHandoffArtifactSchema.safeParse(value);
  if (result.success) {
    const bytes = Buffer.byteLength(
      JSON.stringify(canonicalizeObject(result.data)),
      "utf8",
    );
    if (bytes > SESSION_HANDOFF_MAX_BYTES) {
      return {
        valid: false,
        errors: [
          `artifact: ${bytes} bytes exceeds the ${SESSION_HANDOFF_MAX_BYTES}-byte limit; diagnostic semantics are not truncated`,
        ],
      };
    }
    return { valid: true, artifact: result.data as SessionHandoffArtifact };
  }
  return {
    valid: false,
    errors: result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
  };
}

/** Redact concrete bearer capabilities and credential-shaped values only. */
function sanitizeHandoffString(text: string): string {
  if (!text) return "";
  // Strip capability tokens sk-*, hdf_*, ctr_*
  let sanitized = text.replace(
    /\b(?:ctr_|hdf_)[A-Za-z0-9_-]{20,128}\b/g,
    "[EXPIRED_CAPABILITY_TOKEN]",
  );
  sanitized = sanitized.replace(
    /\bBearer\s+[A-Za-z0-9_.-]{8,}\b/gi,
    "Bearer [REDACTED_TOKEN]",
  );
  sanitized = sanitized.replace(
    /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9_-]{10,})\b/g,
    "[REDACTED_TOKEN]",
  );
  sanitized = sanitized.replace(
    /\b(api[_-]?key|access[_-]?token|secret|password|passwd|credential)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, name: string, separator: string, value: string) => {
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      return quote
        ? `${name}${separator}${quote}[REDACTED_SECRET]${quote}`
        : `${name}${separator}[REDACTED_SECRET]`;
    },
  );
  sanitized = sanitized.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  return sanitized;
}

/** Sanitize an object tree deeply to remove capability tokens and credentials */
function sanitizeObjectTree<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeHandoffString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObjectTree(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => [k, sanitizeObjectTree(v)]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

/** Summarize historical provider accounting without conferring current authority. */
function buildUsageSummary(
  lineage: readonly { readonly usage?: unknown }[],
): SessionHandoffUsageSummary {
  if (lineage.length === 0) {
    return {
      provenance: INFORMATIONAL_PROVENANCE,
      status: "unavailable",
      isAuthoritative: false,
    };
  }

  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let cacheWriteComplete = true;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let reportedCount = 0;

  for (const entry of lineage) {
    const usage = entry.usage;
    if (!usage || typeof usage !== "object") {
      continue;
    }
    const val =
      "status" in usage && usage.status === "reported" && "value" in usage && usage.value
        ? (usage.value as Record<string, unknown>)
        : "inputTokens" in usage
          ? (usage as Record<string, unknown>)
          : null;

    if (!val) {
      continue;
    }

    const fields = [
      val.inputTokens,
      val.cachedInputTokens,
      val.outputTokens,
      val.reasoningOutputTokens,
    ];
    if (
      fields.some(
        (field) => typeof field !== "number" || !Number.isSafeInteger(field) || field < 0,
      ) ||
      (val.cachedInputTokens as number) > (val.inputTokens as number) ||
      (val.reasoningOutputTokens as number) > (val.outputTokens as number)
    ) {
      return {
        provenance: INFORMATIONAL_PROVENANCE,
        status: "unknown",
        isAuthoritative: false,
      };
    }
    reportedCount++;
    inputTokens += val.inputTokens as number;
    cachedInputTokens += val.cachedInputTokens as number;
    outputTokens += val.outputTokens as number;
    reasoningOutputTokens += val.reasoningOutputTokens as number;
    if (val.cacheWriteInputTokens === undefined) {
      cacheWriteComplete = false;
    } else if (
      typeof val.cacheWriteInputTokens === "number" &&
      Number.isSafeInteger(val.cacheWriteInputTokens) &&
      val.cacheWriteInputTokens >= 0
    ) {
      cacheWriteInputTokens += val.cacheWriteInputTokens;
    } else {
      return {
        provenance: INFORMATIONAL_PROVENANCE,
        status: "unknown",
        isAuthoritative: false,
      };
    }
  }

  if (reportedCount === 0) {
    return {
      provenance: INFORMATIONAL_PROVENANCE,
      status: "unavailable",
      isAuthoritative: false,
    };
  }
  if (reportedCount !== lineage.length) {
    return {
      provenance: INFORMATIONAL_PROVENANCE,
      status: "unknown",
      isAuthoritative: false,
    };
  }

  return {
    provenance: INFORMATIONAL_PROVENANCE,
    status: "reported",
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    ...(cacheWriteComplete ? { cacheWriteInputTokens } : {}),
    outputTokens,
    reasoningOutputTokens,
    isAuthoritative: false,
  };
}

/**
 * Export a compact, deterministic cross-session handoff artifact from an
 * authoritative OrchestrationContext or a CompactedContext projection.
 *
 * Guaranteed properties:
 * 1. Compact & decision-safe: reuses P1.3 compaction primitives.
 * 2. Complete boundary preservation: objective, criteria, scope, change intent,
 *    decisions, constraints, blockers, grounded facts, unknowns, risks, lineage.
 * 3. Strict capability exclusion: no bearer tokens (ctr_*, hdf_*), secrets, or raw prompts.
 * 4. Informational only: explicit authority notice and expired capability assertions.
 * 5. Deterministic serialization: idempotent and canonically structured.
 */
export function exportSessionHandoff(
  context: OrchestrationContext | CompactedContext,
  options: ExportSessionHandoffOptions = {},
): SessionHandoffArtifact {
  const importedArtifact =
    "importedHistory" in context && context.importedHistory
      ? sessionHandoffArtifactSchema.safeParse(context.importedHistory.artifact)
      : null;
  const prior = importedArtifact?.success ? importedArtifact.data : undefined;
  const hasFreshEvidence =
    !("contextProvenance" in context) ||
    context.contextProvenance !== "imported-informational" ||
    context.turns.length > 0 ||
    context.decisions.length > 0 ||
    context.constraints.length > 0 ||
    context.blockers.length > 0 ||
    context.lineage.length > 0;

  // A pure parse/restore/re-export preserves snapshot identity and timestamp.
  // Once fresh current-session evidence exists, export creates a new snapshot.
  if (prior && !hasFreshEvidence) {
    const preserved = structuredClone(prior);
    if (options.handoffId) preserved.metadata.handoffId = options.handoffId;
    else if (options.tokenFactory) preserved.metadata.handoffId = options.tokenFactory();
    if (options.timestamp) preserved.metadata.exportedAt = options.timestamp;
    if (options.sourceVersion) preserved.metadata.sourceVersion = options.sourceVersion;
    const validated = validateSessionHandoff(sanitizeObjectTree(preserved));
    if (!validated.valid) {
      throw new Error(
        `Session handoff export failed:\n  ${validated.errors.join("\n  ")}`,
      );
    }
    return validated.artifact;
  }

  const compacted: CompactedContext =
    "stats" in context && "activeHandoffs" in context
      ? (context as CompactedContext)
      : compactContext(context);

  const handoffId =
    options.handoffId ??
    (options.tokenFactory
      ? options.tokenFactory()
      : `${SESSION_HANDOFF_PREFIX}${randomBytes(16).toString("hex")}`);

  const exportedAt = options.timestamp ?? new Date().toISOString();
  const sourceVersion = options.sourceVersion ?? "0.11.0";

  // Aggregate exploration findings across all exploration turns
  const observedFactsMap = new Map<
    string,
    SessionHandoffFindings["observedFacts"][number]
  >();
  const runtimeObservedFactsMap = new Map<
    string,
    SessionHandoffFindings["runtimeObservedFacts"][number]
  >();
  const inferencesMap = new Map<string, SessionHandoffFindings["inferences"][number]>();
  const unknownsMap = new Map<string, SessionHandoffFindings["unknowns"][number]>();
  const relevantFilesMap = new Map<
    string,
    SessionHandoffFindings["relevantFiles"][number]
  >();
  const recommendedSeamsMap = new Map<
    string,
    SessionHandoffFindings["recommendedSeams"][number]
  >();

  // Aggregate completed work across all turns
  const filesChangedMap = new Map<
    string,
    SessionHandoffCompletedWork["filesChanged"][number]
  >();
  const verificationItems: CompactedVerificationItem[] = [];
  const workerClaims: SessionHandoffCompletedWork["workerClaims"] = [];
  const discrepanciesSet = new Set<string>();
  const scopeViolationsSet = new Set<string>();
  const conflictsMap = new Map<
    string,
    SessionHandoffCompletedWork["conflicts"][number]
  >();
  const unresolvedRisksSet = new Set<string>();

  for (const fact of prior?.investigationFindings.observedFacts ?? []) {
    observedFactsMap.set(JSON.stringify(fact), fact);
  }
  for (const fact of prior?.investigationFindings.runtimeObservedFacts ?? []) {
    runtimeObservedFactsMap.set(JSON.stringify(fact), fact);
  }
  for (const item of prior?.investigationFindings.inferences ?? []) {
    inferencesMap.set(JSON.stringify(item), item);
  }
  for (const item of prior?.investigationFindings.unknowns ?? []) {
    unknownsMap.set(JSON.stringify(item), item);
  }
  for (const item of prior?.investigationFindings.relevantFiles ?? []) {
    relevantFilesMap.set(JSON.stringify(item), item);
  }
  for (const item of prior?.investigationFindings.recommendedSeams ?? []) {
    recommendedSeamsMap.set(JSON.stringify(item), item);
  }
  for (const file of prior?.completedWork.filesChanged ?? []) {
    filesChangedMap.set(JSON.stringify(file), file);
  }
  verificationItems.push(...(prior?.completedWork.historicalVerification.items ?? []));
  workerClaims.push(...(prior?.completedWork.workerClaims ?? []));
  for (const item of prior?.completedWork.discrepancies ?? []) discrepanciesSet.add(item);
  for (const item of prior?.completedWork.scopeViolations ?? [])
    scopeViolationsSet.add(item);
  for (const item of prior?.completedWork.conflicts ?? []) {
    conflictsMap.set(`${item.type}:${item.details}`, item);
  }
  for (const item of prior?.completedWork.unresolvedRisks ?? [])
    unresolvedRisksSet.add(item);

  for (const turn of compacted.turns) {
    if (turn.kind === "exploration" && turn.explorationFindings) {
      const findings = turn.explorationFindings;
      for (const fact of findings.observedFacts) {
        const value = {
          statement: fact.statement,
          sourceFile: fact.sourceFile,
          sourceLine: fact.sourceLine,
          evidence: fact.evidence,
          provenance: "worker" as const,
          grounding: fact.grounding,
        };
        const key = JSON.stringify(value);
        if (!observedFactsMap.has(key)) {
          observedFactsMap.set(key, value);
        }
      }
      for (const fact of findings.runtimeObservedFacts) {
        const value = {
          kind: fact.kind,
          statement: fact.statement,
          ...(fact.sourceFile ? { sourceFile: fact.sourceFile } : {}),
          ...(fact.sourceLine ? { sourceLine: fact.sourceLine } : {}),
        };
        const key = JSON.stringify(value);
        if (!runtimeObservedFactsMap.has(key)) {
          runtimeObservedFactsMap.set(key, value);
        }
      }
      for (const inf of findings.inferences) {
        const value = { hypothesis: inf.hypothesis, rationale: inf.rationale };
        const key = JSON.stringify(value);
        if (!inferencesMap.has(key)) {
          inferencesMap.set(key, value);
        }
      }
      for (const u of findings.unknowns) {
        const value = { question: u.question, whyUnresolved: u.whyUnresolved };
        const key = JSON.stringify(value);
        if (!unknownsMap.has(key)) {
          unknownsMap.set(key, value);
        }
      }
      for (const rf of findings.relevantFiles) {
        const value = { path: rf.path, why: rf.why };
        const key = JSON.stringify(value);
        if (!relevantFilesMap.has(key)) {
          relevantFilesMap.set(key, value);
        }
      }
      for (const seam of findings.recommendedSeams) {
        const value = {
          label: seam.label,
          description: seam.description,
          candidateFiles: [...seam.candidateFiles],
        };
        const key = JSON.stringify(value);
        if (!recommendedSeamsMap.has(key)) {
          recommendedSeamsMap.set(key, value);
        }
      }
    }

    // Changed files
    for (const file of turn.filesChanged) {
      const value = {
        path: file.path,
        kind: file.kind,
        observed: file.observed,
        ...(file.why ? { why: file.why } : {}),
      };
      const key = JSON.stringify(value);
      if (!filesChangedMap.has(key)) {
        filesChangedMap.set(key, value);
      }
    }

    // Verification
    for (const item of turn.verificationDetails) {
      verificationItems.push(item);
    }

    // Worker claims
    if (turn.workerClaim) {
      workerClaims.push({
        turnId: turn.id,
        status: turn.workerClaim.status,
        failureCauses: [...turn.workerClaim.failureCauses],
        ...(turn.workerClaim.summary ? { summary: turn.workerClaim.summary } : {}),
      });
    }

    // Discrepancies & Violations
    for (const d of turn.discrepancies) discrepanciesSet.add(d);
    for (const v of turn.scopeViolations) scopeViolationsSet.add(v);

    // Conflicts
    for (const c of turn.conflicts) {
      const key = `${c.type}:${c.details}`;
      if (!conflictsMap.has(key)) {
        conflictsMap.set(key, { type: c.type, details: c.details });
      }
    }

    // Risks
    for (const r of turn.risks) unresolvedRisksSet.add(r);
  }

  const authoritativeVerificationCounts: VerificationCounts = {
    executed: verificationItems.filter(
      (item) =>
        item.source === "orchestrator" &&
        (item.execution === "argv" || item.execution === "shell"),
    ).length,
    passed: verificationItems.filter(
      (item) =>
        item.source === "orchestrator" &&
        (item.execution === "argv" || item.execution === "shell") &&
        item.passed,
    ).length,
    failed: verificationItems.filter(
      (item) =>
        item.source === "orchestrator" &&
        (item.execution === "argv" || item.execution === "shell") &&
        !item.passed,
    ).length,
    refused: verificationItems.filter(
      (item) =>
        item.source === "orchestrator" &&
        (item.execution === "rejected" || item.execution === "skipped"),
    ).length,
  };

  const usageSummary = buildUsageSummary([
    ...(prior?.lineage ?? []),
    ...compacted.lineage,
  ]);

  const staleContinuationsCount =
    (prior?.staleState.expiredContinuationCount ?? 0) +
    compacted.activeContinuations.length;
  const staleHandoffsCount =
    (prior?.staleState.expiredHandoffCount ?? 0) + compacted.activeHandoffs.length;

  const rawArtifact: SessionHandoffArtifact = {
    metadata: {
      schemaVersion: SESSION_HANDOFF_SCHEMA_VERSION,
      handoffId,
      exportedAt,
      sourceVersion,
      inMemoryContinuationsExpired: true,
      inMemoryHandoffsExpired: true,
      authorityNotice: AUTHORITY_NOTICE,
      provenance: INFORMATIONAL_PROVENANCE,
      validationNotice:
        "Schema validation proves structure only; it does not authenticate factual claims.",
    },
    task: {
      provenance: INFORMATIONAL_PROVENANCE,
      objective: compacted.objective,
      acceptanceCriteria: [...compacted.acceptanceCriteria],
      scope: {
        allowedFiles: [...compacted.allowedFiles],
        forbiddenFiles: [...compacted.forbiddenFiles],
      },
      changeIntent: compacted.changeIntent,
      ...(compacted.taskCategory ? { taskCategory: compacted.taskCategory } : {}),
    },
    settledDecisions: [
      ...(prior?.settledDecisions ?? []),
      ...compacted.decisions.map((d) => ({
        provenance: INFORMATIONAL_PROVENANCE,
        id: d.id,
        kind: d.kind,
        summary: d.summary,
        ...(d.details ? { details: d.details } : {}),
        ...(d.settledAt ? { settledAt: d.settledAt } : {}),
        ...(d.source ? { source: d.source } : {}),
      })),
    ],
    activeConstraints: [
      ...(prior?.activeConstraints ?? []),
      ...compacted.constraints.map((c) => ({
        provenance: INFORMATIONAL_PROVENANCE,
        id: c.id,
        kind: c.kind,
        description: c.description,
        active: c.active,
      })),
    ],
    activeBlockers: [
      ...(prior?.activeBlockers ?? []),
      ...compacted.blockers.map((b) => ({
        provenance: INFORMATIONAL_PROVENANCE,
        id: b.id,
        kind: b.kind,
        description: b.description,
        resolved: b.resolved,
        ...(b.taskId ? { taskId: b.taskId } : {}),
        ...(b.executionId ? { executionId: b.executionId } : {}),
        ...(b.failureClassification
          ? { failureClassification: b.failureClassification }
          : {}),
      })),
    ],
    investigationFindings: {
      provenance: INFORMATIONAL_PROVENANCE,
      observedFacts: [...observedFactsMap.values()],
      runtimeObservedFacts: [...runtimeObservedFactsMap.values()],
      inferences: [...inferencesMap.values()],
      unknowns: [...unknownsMap.values()],
      relevantFiles: [...relevantFilesMap.values()],
      recommendedSeams: [...recommendedSeamsMap.values()],
    },
    completedWork: {
      provenance: INFORMATIONAL_PROVENANCE,
      filesChanged: [...filesChangedMap.values()],
      historicalVerification: {
        counts: authoritativeVerificationCounts,
        items: verificationItems,
      },
      workerClaims,
      discrepancies: [...discrepanciesSet],
      scopeViolations: [...scopeViolationsSet],
      conflicts: [...conflictsMap.values()],
      unresolvedRisks: [...unresolvedRisksSet],
    },
    lineage: [
      ...(prior?.lineage ?? []),
      ...compacted.lineage.map((l) => ({
        executionId: l.executionId,
        logicalAttempt: l.logicalAttempt,
        role: l.role,
        predecessorExecutionId: l.predecessorExecutionId ?? null,
        model: l.model,
        effort: l.effort,
        startedAt: l.startedAt,
        ...(l.finishedAt ? { finishedAt: l.finishedAt } : {}),
        ...(l.elapsedMs !== undefined ? { elapsedMs: l.elapsedMs } : {}),
        workerElapsedMs: l.workerElapsedMs ?? null,
        verificationElapsedMs: l.verificationElapsedMs ?? null,
        ...(l.timeoutMs !== undefined ? { timeoutMs: l.timeoutMs } : {}),
        ...(l.terminationKind ? { terminationKind: l.terminationKind } : {}),
        terminationMessage: l.terminationMessage
          ? sanitizeHandoffString(l.terminationMessage)
          : (l.terminationMessage ?? null),
        workerClaimedStatus: l.workerClaimedStatus ?? null,
        workerClaimedFailureCauses: l.workerClaimedFailureCauses
          ? [...l.workerClaimedFailureCauses]
          : [],
        ...(l.usage ? { usage: l.usage } : {}),
        ...(l.verdict ? { verdict: l.verdict } : {}),
        ...(l.failureDecision ? { failureDecision: l.failureDecision } : {}),
        provenance: INFORMATIONAL_PROVENANCE,
      })),
    ],
    usageSummary,
    staleState: {
      provenance: INFORMATIONAL_PROVENANCE,
      inMemoryContinuationsExpired: true,
      inMemoryHandoffsExpired: true,
      expiredContinuationCount: staleContinuationsCount,
      expiredHandoffCount: staleHandoffsCount,
      notes: [
        "In-memory continuation references (ctr_*) and next-action handoffs (hdf_*) do not survive server restarts.",
        "Prior session execution tokens are invalidated and cannot be consumed in the new session.",
      ],
    },
  };

  // Deep sanitize to guarantee no capability tokens or unscrubbed credentials
  const sanitized = sanitizeObjectTree(rawArtifact);
  const validated = validateSessionHandoff(sanitized);
  if (!validated.valid) {
    throw new Error(`Session handoff export failed:\n  ${validated.errors.join("\n  ")}`);
  }
  return validated.artifact;
}

function canonicalizeObject(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeObject);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue;
    // `result[key] = ...` invoked the `Object.prototype.__proto__` setter for a
    // `__proto__` key, which `JSON.parse` does create as an own property. The
    // assignment silently retargeted the result's prototype instead of storing
    // the value, so the subtree vanished from `JSON.stringify` - and with it
    // from the byte count that enforces SESSION_HANDOFF_MAX_BYTES. An artifact
    // hiding megabytes under `lineage[].usage.__proto__` measured as nothing
    // and was admitted. Define the property instead of setting it.
    Object.defineProperty(result, key, {
      value: canonicalizeObject(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/**
 * Deterministically serialize a SessionHandoffArtifact into a canonical JSON string.
 */
export function serializeSessionHandoff(
  artifact: SessionHandoffArtifact,
  options: { pretty?: boolean } = {},
): string {
  const validation = validateSessionHandoff(artifact);
  if (!validation.valid) {
    throw new Error(
      `Session handoff validation failed:\n  ${validation.errors.join("\n  ")}`,
    );
  }
  const canonical = canonicalizeObject(validation.artifact);
  const serialized = JSON.stringify(canonical, null, options.pretty ? 2 : undefined);
  if (Buffer.byteLength(serialized, "utf8") > SESSION_HANDOFF_MAX_BYTES) {
    throw new Error(
      `Session handoff exceeds the ${SESSION_HANDOFF_MAX_BYTES}-byte limit`,
    );
  }
  return serialized;
}

/**
 * Parse and validate a serialized JSON handoff artifact, failing closed on
 * malformed or tampered structures.
 */
export function parseSessionHandoff(serialized: string): SessionHandoffArtifact {
  if (typeof serialized !== "string" || !serialized.trim()) {
    throw new Error("Cannot parse empty or non-string session handoff");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Malformed session handoff JSON: ${(error as Error).message}`);
  }
  const validation = validateSessionHandoff(parsed);
  if (!validation.valid) {
    throw new Error(
      `Session handoff validation failed:\n  ${validation.errors.join("\n  ")}`,
    );
  }
  return validation.artifact;
}

/**
 * Restore caller-supplied historical context from a SessionHandoffArtifact or
 * serialized JSON string. Schema validity is structural, not authentication.
 *
 * Security & Trust Guarantees:
 * - All text is sanitized and checked.
 * - Restored context enters normal admission, scope, and verification controls.
 * - No live in-memory capability tokens or escalation authorizations are created.
 */
export function restoreSessionHandoff(
  input: string | unknown,
  _options: ImportSessionHandoffOptions = {},
): {
  readonly context: OrchestrationContext;
  readonly artifact: SessionHandoffArtifact;
} {
  const parsed: SessionHandoffArtifact = (() => {
    if (typeof input === "string") return parseSessionHandoff(input);
    const validation = validateSessionHandoff(input);
    if (!validation.valid) {
      throw new Error(
        `Session handoff validation failed:\n  ${validation.errors.join("\n  ")}`,
      );
    }
    return validation.artifact;
  })();
  const artifact = sessionHandoffArtifactSchema.parse(sanitizeObjectTree(parsed));

  const context = createOrchestrationContext({
    objective: sanitizeHandoffString(artifact.task.objective),
    acceptanceCriteria: artifact.task.acceptanceCriteria.map(sanitizeHandoffString),
    allowedFiles: [...artifact.task.scope.allowedFiles],
    forbiddenFiles: [...artifact.task.scope.forbiddenFiles],
    changeIntent: artifact.task.changeIntent,
    taskCategory: artifact.task.taskCategory,
    // Imported claims remain only in importedHistory. These canonical arrays
    // begin empty and can accumulate fresh, server-owned evidence independently.
    decisions: [],
    constraints: [],
    blockers: [],
    lineage: [],
    turns: [],
    contextProvenance: "imported-informational",
    importedHistory: {
      provenance: "imported-informational",
      schemaVersion: artifact.metadata.schemaVersion,
      handoffId: artifact.metadata.handoffId,
      exportedAt: artifact.metadata.exportedAt,
      artifact,
    },
  });
  return { context, artifact };
}

export function importSessionHandoff(
  input: string | unknown,
  options: ImportSessionHandoffOptions = {},
): OrchestrationContext {
  return restoreSessionHandoff(input, options).context;
}

export interface ContextLifecycleStoreLike {
  getAuthoritativeContext(): OrchestrationContext | null;
  reset(initialContext?: OrchestrationContext): void;
  isInFlight?(): boolean;
}

export function exportSessionHandoffFromStore(
  store: ContextLifecycleStoreLike,
  options: ExportSessionHandoffOptions = {},
): SessionHandoffArtifact {
  const context = store.getAuthoritativeContext();
  if (!context) {
    throw new Error("Cannot export session handoff from an empty context store");
  }
  return exportSessionHandoff(context, options);
}

export function restoreSessionHandoffIntoStore(
  store: ContextLifecycleStoreLike,
  input: string | unknown,
  options: ImportSessionHandoffOptions = {},
): SessionHandoffArtifact {
  if (store.isInFlight?.()) {
    throw new Error("Cannot restore a session handoff while executions are in flight");
  }
  if (store.getAuthoritativeContext()) {
    throw new Error(
      "Cannot restore a session handoff into a non-empty context store; choose a fresh context key",
    );
  }
  const { context, artifact } = restoreSessionHandoff(input, options);
  store.reset(context);
  return artifact;
}
