import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  exportSessionHandoff,
  exportSessionHandoffFromStore,
  importSessionHandoff,
  isSessionHandoffArtifact,
  parseSessionHandoff,
  restoreSessionHandoff,
  restoreSessionHandoffIntoStore,
  serializeSessionHandoff,
  SESSION_HANDOFF_PREFIX,
  SESSION_HANDOFF_MAX_BYTES,
  SESSION_HANDOFF_SCHEMA_VERSION,
  validateSessionHandoff,
  type SessionHandoffArtifact,
} from "./session-handoff.js";
import {
  compactContext,
  ContextLifecycleStore,
  createOrchestrationContext,
  ingestDelegationTurn,
  ingestExplorationTurn,
  ingestStatusNarrationTurn,
  ingestToolProseTurn,
  recordBlocker,
  recordConstraint,
  recordDecision,
  resolveBlocker,
  type OrchestrationContext,
} from "./context.js";
import type {
  DelegateTaskInput,
  DelegateTaskOutput,
  ExploreInput,
  ExploreOutput,
} from "./contract.js";
import { ContinuationStore } from "./continuation.js";
import { HandoffStore } from "./handoff.js";
import { admitCompute, DEFAULT_COMPUTE_POLICY } from "./policy.js";
import { ContextLifecycleRegistry } from "./server.js";

function mockCleanTaskInput(
  overrides: Partial<DelegateTaskInput> = {},
): DelegateTaskInput {
  return {
    objective: "Implement P2.2 Lightweight Cross-Session Handoff in Sol-Luna.",
    effort: "high",
    effortReason:
      "Core cross-session persistence primitive with strict security guarantees",
    changeIntent: "required",
    automaticRepair: false,
    allowedFiles: ["src/session-handoff.ts", "src/session-handoff.test.ts"],
    forbiddenFiles: ["dist/**", "node_modules/**"],
    acceptanceCriteria: [
      "Objective, acceptance criteria, scope, and decisions are retained intact.",
      "Claims vs runtime facts vs inferences vs unknowns remain cleanly separated.",
      "No live bearer capabilities (ctr_*, hdf_*) or credentials leak.",
      "Serialization is deterministic, bounded, and idempotent.",
      "Restored session enters normal admission and verification controls.",
    ],
    verificationCommands: ["npm run typecheck", "npm test"],
    previousAttempts: [],
    resultDetail: "handoff",
    ...overrides,
  };
}

function mockCleanTaskOutput(
  overrides: Partial<DelegateTaskOutput> = {},
): DelegateTaskOutput {
  return {
    changeIntent: "required",
    verdict: "PASS",
    workerClaimedStatus: "PASS",
    workerClaimedFailureCauses: [],
    trustworthy: true,
    workerThreadId: "thread_clean_123",
    continuationReference: "ctr_clean_12345678901234567890123456789012",
    continuationState: {
      status: "issued",
      reason: "One continuation turn available.",
    },
    handoffReference: null,
    handoffState: {
      status: "not-eligible",
      reason: "Successful results do not earn next-action handoffs.",
    },
    repair: null,
    recovery: null,
    model: "gpt-5.6-luna",
    effort: "high",
    effortReason: "Core feature",
    attempt: 1,
    attempts: [
      {
        executionId: "exec_clean_1",
        logicalAttempt: 1,
        role: "initial",
        predecessorExecutionId: null,
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "high",
        threadId: "thread_clean_123",
        threadOperation: "start",
        threadIdentityMatched: true,
        startedAt: "2026-08-28T10:00:00.000Z",
        finishedAt: "2026-08-28T10:01:00.000Z",
        elapsedMs: 60000,
        workerElapsedMs: 50000,
        verificationElapsedMs: 10000,
        timeoutMs: 1800000,
        termination: { kind: "completed", message: null },
        usage: {
          status: "reported",
          source: "codex-turn.completed",
          value: {
            inputTokens: 500,
            cachedInputTokens: 100,
            outputTokens: 200,
            reasoningOutputTokens: 50,
          },
        },
        workerClaimedStatus: "PASS",
        workerClaimedFailureCauses: [],
        verification: [
          {
            command: "npm run typecheck",
            source: "orchestrator",
            execution: "argv",
            exitCode: 0,
            passed: true,
            output: "All TypeScript types checked successfully with 0 errors.",
          },
          {
            command: "npm test",
            source: "orchestrator",
            execution: "argv",
            exitCode: 0,
            passed: true,
            output: "25/25 tests passed.",
          },
        ],
      },
    ],
    summary: "Implemented session handoff module with tests.",
    notes: "No breaking changes.",
    followUps: [],
    filesChanged: [
      {
        path: "src/session-handoff.ts",
        kind: "added",
        why: "Core session handoff module",
        observed: true,
      },
      {
        path: "src/session-handoff.test.ts",
        kind: "added",
        why: "Unit tests",
        observed: true,
      },
    ],
    verification: [
      {
        command: "npm run typecheck",
        source: "orchestrator",
        execution: "argv",
        exitCode: 0,
        passed: true,
        output: "All TypeScript types checked successfully with 0 errors.",
      },
      {
        command: "npm test",
        source: "orchestrator",
        execution: "argv",
        exitCode: 0,
        passed: true,
        output: "25/25 tests passed.",
      },
    ],
    verificationMode: "allowlist",
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: [],
    escalationAdvice: null,
    durationSeconds: 60,
    usage: {
      inputTokens: 500,
      cachedInputTokens: 100,
      outputTokens: 200,
      reasoningOutputTokens: 50,
    },
    errors: [],
    ...overrides,
  };
}

function mockCleanExploreInput(overrides: Partial<ExploreInput> = {}): ExploreInput {
  return {
    target: "Investigate repository architecture for session handoff integration",
    effort: "medium",
    effortReason: "Read-only architectural survey",
    scope: ["src/*.ts"],
    forbiddenFiles: ["dist/**"],
    questions: ["Where is context state stored?", "How are tokens scoped?"],
    resultDetail: "handoff",
    ...overrides,
  };
}

function mockCleanExploreOutput(overrides: Partial<ExploreOutput> = {}): ExploreOutput {
  return {
    target: "Investigate repository architecture for session handoff integration",
    verdict: "PASS",
    workerClaimedStatus: "PASS",
    trustworthy: true,
    model: "gpt-5.6-luna",
    effort: "medium",
    effortReason: "Read-only architectural survey",
    durationSeconds: 25,
    workerThreadId: "thread_exp_123",
    findings: {
      summary: "Found context lifecycle store and token stores.",
      observedFacts: [
        {
          statement: "ContextLifecycleStore manages execution leases in memory",
          sourceFile: "src/context.ts",
          sourceLine: 2440,
          evidence: "export class ContextLifecycleStore",
          provenance: "worker",
          grounding: "runtime-verified",
        },
      ],
      runtimeObservedFacts: [
        {
          kind: "source-grounding",
          statement: "Verified source grounding for src/context.ts:2440",
          sourceFile: "src/context.ts",
          sourceLine: 2440,
        },
      ],
      inferences: [
        {
          hypothesis: "Session handoff can restore into ContextLifecycleStore",
          rationale:
            "ContextLifecycleStore already has reset method and context properties",
        },
      ],
      unknowns: [
        {
          question: "Should handoff artifacts support custom metadata headers?",
          whyUnresolved: "Not specified in requirements",
        },
      ],
      relevantFiles: [
        {
          path: "src/context.ts",
          why: "Core context compaction and lifecycle store",
        },
      ],
      recommendedSeams: [
        {
          label: "session-handoff",
          description: "Independent module for export and restore",
          candidateFiles: ["src/session-handoff.ts", "src/session-handoff.test.ts"],
        },
      ],
      notes: "Clean exploration with zero mutations.",
    },
    observedFilesChanged: [],
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: [],
    usage: {
      inputTokens: 300,
      cachedInputTokens: 50,
      outputTokens: 150,
      reasoningOutputTokens: 30,
    },
    attempts: [],
    errors: [],
    ...overrides,
  };
}

// ============================================================================
// 1. Clean Handoff Creation and Restore
// ============================================================================

test("clean handoff creation and restore preserves all core fields with fidelity", () => {
  let ctx = createOrchestrationContext({
    objective: "Build session handoff feature",
    acceptanceCriteria: ["Criteria 1", "Criteria 2"],
    allowedFiles: ["src/session-handoff.ts"],
    forbiddenFiles: ["dist/**"],
    changeIntent: "required",
    taskCategory: "implementation",
  });

  ctx = recordDecision(ctx, {
    id: "dec_1",
    kind: "architectural",
    summary: "Use pure deterministic serialization",
  });

  ctx = recordConstraint(ctx, {
    id: "cst_1",
    kind: "policy",
    description: "No capability token leakage",
  });

  ctx = recordBlocker(ctx, {
    id: "blk_1",
    kind: "verification-failure",
    description: "Initial typecheck failed",
  });
  ctx = resolveBlocker(ctx, "blk_1");

  ctx = ingestDelegationTurn(ctx, {
    input: mockCleanTaskInput(),
    output: mockCleanTaskOutput(),
  });

  ctx = ingestExplorationTurn(ctx, {
    input: mockCleanExploreInput(),
    output: mockCleanExploreOutput(),
  });

  const artifact = exportSessionHandoff(ctx, {
    handoffId: "sho_test123",
    timestamp: "2026-08-28T12:00:00.000Z",
    sourceVersion: "0.10.0",
  });

  assert.ok(isSessionHandoffArtifact(artifact));
  assert.equal(artifact.metadata.schemaVersion, SESSION_HANDOFF_SCHEMA_VERSION);
  assert.equal(artifact.metadata.handoffId, "sho_test123");
  assert.equal(artifact.metadata.inMemoryContinuationsExpired, true);
  assert.equal(artifact.metadata.inMemoryHandoffsExpired, true);
  assert.match(artifact.metadata.authorityNotice, /INFORMATIONAL ONLY/i);

  assert.equal(artifact.task.objective, "Build session handoff feature");
  assert.deepEqual(artifact.task.acceptanceCriteria, ["Criteria 1", "Criteria 2"]);
  assert.deepEqual(artifact.task.scope.allowedFiles, ["src/session-handoff.ts"]);
  assert.deepEqual(artifact.task.scope.forbiddenFiles, ["dist/**"]);
  assert.equal(artifact.task.changeIntent, "required");
  assert.equal(artifact.task.taskCategory, "implementation");

  assert.equal(artifact.settledDecisions.length, 1);
  assert.equal(artifact.settledDecisions[0]?.id, "dec_1");
  assert.equal(
    artifact.settledDecisions[0]?.summary,
    "Use pure deterministic serialization",
  );

  assert.equal(artifact.activeConstraints.length, 1);
  assert.equal(artifact.activeConstraints[0]?.id, "cst_1");

  assert.equal(artifact.activeBlockers.length, 1);
  assert.equal(artifact.activeBlockers[0]?.id, "blk_1");
  assert.equal(artifact.activeBlockers[0]?.resolved, true);
  assert.deepEqual(artifact.usageSummary, {
    provenance: "caller-supplied-historical-context",
    status: "reported",
    totalTokens: 700,
    inputTokens: 500,
    cachedInputTokens: 100,
    outputTokens: 200,
    reasoningOutputTokens: 50,
    isAuthoritative: false,
  });

  // Restore
  const restored = importSessionHandoff(artifact);
  assert.equal(restored.objective, "Build session handoff feature");
  assert.deepEqual(restored.acceptanceCriteria, ["Criteria 1", "Criteria 2"]);
  assert.deepEqual(restored.allowedFiles, ["src/session-handoff.ts"]);
  assert.deepEqual(restored.forbiddenFiles, ["dist/**"]);
  assert.equal(restored.changeIntent, "required");
  assert.equal(restored.taskCategory, "implementation");

  assert.equal(restored.contextProvenance, "imported-informational");
  assert.equal(restored.decisions.length, 0);
  assert.equal(restored.constraints.length, 0);
  assert.equal(restored.blockers.length, 0);
  assert.equal(restored.lineage.length, 0);
  assert.equal(restored.turns.length, 0);
  assert.equal(restored.importedHistory?.handoffId, "sho_test123");
});

// ============================================================================
// 2. Contract, Decision, and Blocker Preservation
// ============================================================================

test("preserves distinct decision kinds, active constraints, and unresolved blocker failure classifications", () => {
  let ctx = createOrchestrationContext({
    objective: "Multi-decision contract",
    acceptanceCriteria: ["AC 1", "AC 2", "AC 3"],
    allowedFiles: ["src/a.ts", "src/b.ts"],
    forbiddenFiles: ["src/secret/**"],
    changeIntent: "optional",
    taskCategory: "refactor",
  });

  ctx = recordDecision(ctx, {
    id: "d_arch",
    kind: "architectural",
    summary: "Arch decision",
  });
  ctx = recordDecision(ctx, { id: "d_user", kind: "user", summary: "User decision" });
  ctx = recordDecision(ctx, { id: "d_pol", kind: "policy", summary: "Policy decision" });
  ctx = recordDecision(ctx, {
    id: "d_inv",
    kind: "invariant",
    summary: "Invariant rule",
  });

  ctx = recordConstraint(ctx, {
    id: "c_scope",
    kind: "scope",
    description: "Scope constraint",
  });
  ctx = recordConstraint(ctx, {
    id: "c_ver",
    kind: "verification",
    description: "Ver constraint",
  });

  ctx = recordBlocker(ctx, {
    id: "b_unres",
    kind: "verification-failure",
    description: "Tests timed out",
    resolved: false,
    failureClassification: "timeout",
  });

  const artifact = exportSessionHandoff(ctx, { handoffId: "sho_decisions" });

  assert.equal(artifact.settledDecisions.length, 4);
  assert.deepEqual(
    artifact.settledDecisions.map((d) => d.kind),
    ["architectural", "user", "policy", "invariant"],
  );

  assert.equal(artifact.activeConstraints.length, 2);
  assert.equal(artifact.activeBlockers.length, 1);
  assert.equal(artifact.activeBlockers[0]?.failureClassification, "timeout");
  assert.equal(artifact.activeBlockers[0]?.resolved, false);

  const restored = importSessionHandoff(artifact);
  assert.equal(restored.decisions.length, 0);
  assert.equal(restored.constraints.length, 0);
  assert.equal(restored.blockers.length, 0);
  const imported = restored.importedHistory?.artifact as SessionHandoffArtifact;
  assert.equal(imported.settledDecisions.length, 4);
  assert.equal(imported.activeConstraints.length, 2);
  assert.equal(imported.activeBlockers[0]?.failureClassification, "timeout");
});

// ============================================================================
// 3. Claims vs Runtime Observed Facts vs Inferences vs Unknowns
// ============================================================================

test("strictly segregates worker claims, runtime-observed facts, inferences, and open unknowns", () => {
  let ctx = createOrchestrationContext({
    objective: "Fact and claim segregation",
    acceptanceCriteria: ["Separate facts from claims"],
  });

  const exploreOutput = mockCleanExploreOutput({
    findings: {
      summary: "Exploration summary claim",
      observedFacts: [
        {
          statement: "Worker observed fact in code",
          sourceFile: "src/context.ts",
          sourceLine: 10,
          evidence: "import type",
          provenance: "worker",
          grounding: "runtime-verified",
        },
        {
          statement: "Worker unverified claim",
          sourceFile: "src/unverified.ts",
          sourceLine: 99,
          evidence: "unverified line",
          provenance: "worker",
          grounding: "unverified",
        },
      ],
      runtimeObservedFacts: [
        {
          kind: "source-grounding",
          statement: "Runtime confirmed grounding at src/context.ts:10",
          sourceFile: "src/context.ts",
          sourceLine: 10,
        },
      ],
      inferences: [
        {
          hypothesis: "The module is loosely coupled",
          rationale: "Only two external imports are present",
        },
      ],
      unknowns: [
        {
          question: "Is there a hidden dependency on environment variables?",
          whyUnresolved: "Could not inspect external deployment configuration",
        },
      ],
      relevantFiles: [{ path: "src/context.ts", why: "Core logic" }],
      recommendedSeams: [
        { label: "seam1", description: "Seam 1", candidateFiles: ["src/a.ts"] },
      ],
      notes: "Exploration notes",
    },
  });

  ctx = ingestExplorationTurn(ctx, {
    input: mockCleanExploreInput(),
    output: exploreOutput,
  });

  const artifact = exportSessionHandoff(ctx);
  const findings = artifact.investigationFindings;

  // Grounded worker claims
  assert.equal(findings.observedFacts.length, 2);
  assert.equal(findings.observedFacts[0]?.grounding, "runtime-verified");
  assert.equal(findings.observedFacts[1]?.grounding, "unverified");

  // Runtime facts
  assert.equal(findings.runtimeObservedFacts.length, 1);
  assert.equal(findings.runtimeObservedFacts[0]?.kind, "source-grounding");

  // Inferences
  assert.equal(findings.inferences.length, 1);
  assert.equal(findings.inferences[0]?.hypothesis, "The module is loosely coupled");

  // Unknowns (explicitly preserved!)
  assert.equal(findings.unknowns.length, 1);
  assert.equal(
    findings.unknowns[0]?.question,
    "Is there a hidden dependency on environment variables?",
  );
  assert.equal(
    findings.unknowns[0]?.whyUnresolved,
    "Could not inspect external deployment configuration",
  );
});

// ============================================================================
// 4. Unresolved Failure and Verification State
// ============================================================================

test("preserves failed verification output, discrepancies, scope violations, and conflicts", () => {
  let ctx = createOrchestrationContext({
    objective: "Failure preservation",
    acceptanceCriteria: ["Detect and preserve failure state"],
  });

  const failedOutput = mockCleanTaskOutput({
    verdict: "FAILED",
    workerClaimedStatus: "PASS", // Discrepant claim!
    trustworthy: false,
    discrepancies: ["Worker claimed PASS but test suite failed with exit code 1."],
    scopeViolations: ["Edited unauthorized file src/secret.ts outside allowedFiles."],
    reviewChecklist: [
      "Review unauthorized file modifications",
      "Investigate assertion failure in test suite",
    ],
    verification: [
      {
        command: "npm test",
        source: "orchestrator",
        execution: "argv",
        exitCode: 1,
        passed: false,
        output: "AssertionError: expected true to be false at test.js:42",
      },
    ],
    failureDecision: {
      classification: "verification",
      action: "repair",
      reason: "Local test failure is repairable",
      evidenceExecutionIds: ["exec_fail_1"],
      nextEffort: null,
      automaticHandler: "automatic-repair",
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  });

  ctx = ingestDelegationTurn(ctx, {
    input: mockCleanTaskInput(),
    output: failedOutput,
  });

  const artifact = exportSessionHandoff(ctx);
  const work = artifact.completedWork;

  assert.equal(work.historicalVerification.counts.executed, 1);
  assert.equal(work.historicalVerification.counts.passed, 0);
  assert.equal(work.historicalVerification.counts.failed, 1);
  assert.equal(work.historicalVerification.items[0]?.passed, false);
  assert.equal(work.historicalVerification.items[0]?.exitCode, 1);
  assert.match(work.historicalVerification.items[0]?.output ?? "", /AssertionError/);

  assert.deepEqual(work.discrepancies, [
    "Worker claimed PASS but test suite failed with exit code 1.",
  ]);
  assert.deepEqual(work.scopeViolations, [
    "Edited unauthorized file src/secret.ts outside allowedFiles.",
  ]);
  assert.equal(work.unresolvedRisks.length, 3);

  // Imported blocker remains historical and is not installed as a live blocker.
  const restored = importSessionHandoff(artifact);
  assert.equal(restored.blockers.length, 0);
  assert.ok(
    (restored.importedHistory?.artifact as SessionHandoffArtifact).activeBlockers.some(
      (b) => !b.resolved && b.kind === "scope-violation",
    ),
  );
});

// ============================================================================
// 5. No Capability-Token or Secret Leakage
// ============================================================================

test("scrubs capability tokens (ctr_*, hdf_*), api keys, and bearer tokens from exported handoff", () => {
  let ctx = createOrchestrationContext({
    objective:
      "Handle sk-abcdef12345678901234567890 and Bearer secret_bearer_token_12345",
    acceptanceCriteria: [
      "Do not leak ctr_test1234567890123456789012345678 or hdf_test1234567890123456789012345678",
    ],
  });

  ctx = recordDecision(ctx, {
    id: "dec_sec",
    kind: "architectural",
    summary: "api_key=sk-live_98765432109876543210 must never be stored",
  });

  ctx = ingestDelegationTurn(ctx, {
    input: mockCleanTaskInput({
      handoffReference: "hdf_prior_attempt_1234567890123456789012345678",
    }),
    output: mockCleanTaskOutput({
      continuationReference: "ctr_active_1234567890123456789012345678",
      handoffReference: "hdf_next_1234567890123456789012345678",
      handoffState: { status: "issued", reason: "Earned retry" },
    }),
  });

  const artifact = exportSessionHandoff(ctx);
  const serialized = serializeSessionHandoff(artifact);

  // Check no raw tokens or keys exist in the serialized string
  assert.ok(!serialized.includes("sk-abcdef12345678901234567890"));
  assert.ok(!serialized.includes("secret_bearer_token_12345"));
  assert.ok(!serialized.includes("sk-live_98765432109876543210"));
  assert.ok(!serialized.includes("ctr_test1234567890123456789012345678"));
  assert.ok(!serialized.includes("hdf_test1234567890123456789012345678"));
  assert.ok(!serialized.includes("ctr_active_1234567890123456789012345678"));
  assert.ok(!serialized.includes("hdf_next_1234567890123456789012345678"));

  // Check explicit expiration markers
  assert.equal(artifact.staleState.inMemoryContinuationsExpired, true);
  assert.equal(artifact.staleState.inMemoryHandoffsExpired, true);
});

// ============================================================================
// 6. Restart and Fail-Closed Semantics
// ============================================================================

test("restart/new process fails closed: in-memory stores reject prior session references", () => {
  // Session 1: issued handoff and continuation
  const session1HandoffStore = new HandoffStore();
  const session1ContinuationStore = new ContinuationStore();

  const taskInput = mockCleanTaskInput();
  const taskOutput = mockCleanTaskOutput({
    verdict: "FAILED",
    failureDecision: {
      classification: "verification",
      action: "retry",
      reason: "Retry attempt earned",
      evidenceExecutionIds: ["exec_1"],
      nextEffort: null,
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  });

  const hdfRef = session1HandoffStore.issue(taskInput, taskOutput);
  const ctrRef = session1ContinuationStore.issue(taskInput, "thread_123", "/tmp/repo");

  assert.ok(hdfRef.startsWith("hdf_"));
  assert.ok(ctrRef.startsWith("ctr_"));

  let ctx = createOrchestrationContext({
    objective: "Session 1 work",
    acceptanceCriteria: ["AC 1"],
  });
  ctx = ingestDelegationTurn(ctx, { input: taskInput, output: taskOutput });

  const handoffArtifact = exportSessionHandoff(ctx, {
    continuationStore: session1ContinuationStore,
    handoffStore: session1HandoffStore,
  } as any);

  // --- SERVER RESTART / SESSION 2 ---
  const session2HandoffStore = new HandoffStore();
  const session2ContinuationStore = new ContinuationStore();
  const session2Registry = new ContextLifecycleRegistry({
    continuationStore: session2ContinuationStore,
    handoffStore: session2HandoffStore,
  });

  // Restore into session 2 lifecycle store
  const { store: session2Store } = session2Registry.restoreSessionHandoff(
    "ctx_new_session",
    handoffArtifact,
  );

  assert.equal(session2Store.getAuthoritativeContext()?.objective, "Session 1 work");

  // Attempting to consume old handoff or continuation token fails closed!
  const consumeHandoffResult = session2HandoffStore.consume(hdfRef);
  assert.equal(consumeHandoffResult.status, "unknown");

  const consumeContinuationResult = session2ContinuationStore.consume(ctrRef);
  assert.equal(consumeContinuationResult.status, "unknown");

  // New session cannot escalate based on old token
  const computeAdmit = admitCompute({
    model: "gpt-5.6-luna",
    efforts: ["high"],
    workerCount: 1,
    baseline: DEFAULT_COMPUTE_POLICY,
  });
  // Normal compute policy applies without auto-escalation
  assert.equal(computeAdmit.refusal, null);
});

// ============================================================================
// 7. Tampered and Malformed Handoff Input
// ============================================================================

test("fails closed on tampered schemaVersion, invalid types, or malformed JSON", () => {
  // Empty string
  assert.throws(() => parseSessionHandoff(""), /Cannot parse empty/);
  assert.throws(() => parseSessionHandoff("   "), /Cannot parse empty/);

  // Invalid JSON
  assert.throws(
    () => parseSessionHandoff("{ invalid: json"),
    /Malformed session handoff JSON/,
  );

  // Tampered schemaVersion
  const tamperedVersion = {
    metadata: {
      schemaVersion: "sol-luna-handoff/v999", // Invalid version!
      handoffId: "sho_bad",
      exportedAt: "2026-08-28T00:00:00.000Z",
      sourceVersion: "0.10.0",
      inMemoryContinuationsExpired: true,
      inMemoryHandoffsExpired: true,
      authorityNotice: "Notice",
      provenance: "caller-supplied-historical-context",
      validationNotice:
        "Schema validation proves structure only; it does not authenticate factual claims.",
    },
    task: {
      provenance: "caller-supplied-historical-context",
      objective: "Test",
      acceptanceCriteria: [],
      scope: { allowedFiles: [], forbiddenFiles: [] },
      changeIntent: "required",
    },
    settledDecisions: [],
    activeConstraints: [],
    activeBlockers: [],
    investigationFindings: {
      provenance: "caller-supplied-historical-context",
      observedFacts: [],
      runtimeObservedFacts: [],
      inferences: [],
      unknowns: [],
      relevantFiles: [],
      recommendedSeams: [],
    },
    completedWork: {
      provenance: "caller-supplied-historical-context",
      filesChanged: [],
      historicalVerification: {
        counts: { executed: 0, passed: 0, failed: 0, refused: 0 },
        items: [],
      },
      workerClaims: [],
      discrepancies: [],
      scopeViolations: [],
      conflicts: [],
      unresolvedRisks: [],
    },
    lineage: [],
    usageSummary: {
      provenance: "caller-supplied-historical-context",
      status: "unavailable",
      isAuthoritative: false,
    },
    staleState: {
      provenance: "caller-supplied-historical-context",
      inMemoryContinuationsExpired: true,
      inMemoryHandoffsExpired: true,
      expiredContinuationCount: 0,
      expiredHandoffCount: 0,
      notes: [],
    },
  };

  const validation = validateSessionHandoff(tamperedVersion);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes("schemaVersion")));

  assert.throws(
    () => parseSessionHandoff(JSON.stringify(tamperedVersion)),
    /Session handoff validation failed/,
  );

  // Missing task objective
  const missingObjective = structuredClone(tamperedVersion);
  (missingObjective.metadata as any).schemaVersion = SESSION_HANDOFF_SCHEMA_VERSION;
  (missingObjective.task as any).objective = ""; // Empty string violates min(1)

  const validation2 = validateSessionHandoff(missingObjective);
  assert.equal(validation2.valid, false);
  assert.ok(validation2.errors.some((e) => e.includes("objective")));
});

// ============================================================================
// 8. Stale Handoff Handling
// ============================================================================

test("stale handoffs are safely imported with explicit timestamps and expired capabilities", () => {
  const staleTimestamp = "2025-01-01T00:00:00.000Z";
  const ctx = createOrchestrationContext({
    objective: "Old project state",
    acceptanceCriteria: ["AC"],
  });

  const artifact = exportSessionHandoff(ctx, {
    handoffId: "sho_old123",
    timestamp: staleTimestamp,
  });

  assert.equal(artifact.metadata.exportedAt, staleTimestamp);

  const restored = importSessionHandoff(artifact);
  assert.equal(restored.objective, "Old project state");

  assert.equal(restored.importedHistory?.exportedAt, staleTimestamp);
});

// ============================================================================
// 9. Deterministic and Idempotent Serialization
// ============================================================================

test("serialization is deterministic and idempotent across export-import-export cycles", () => {
  let ctx = createOrchestrationContext({
    objective: "Deterministic idempotence test",
    acceptanceCriteria: ["AC 1", "AC 2"],
    allowedFiles: ["src/a.ts"],
    forbiddenFiles: ["dist/**"],
    changeIntent: "required",
    taskCategory: "chore",
  });

  ctx = recordDecision(ctx, { id: "dec_1", summary: "Decision 1" });
  ctx = recordConstraint(ctx, {
    id: "cst_1",
    kind: "policy",
    description: "Constraint 1",
  });
  ctx = recordBlocker(ctx, {
    id: "blk_1",
    kind: "verification-failure",
    description: "Blocker 1",
  });

  ctx = ingestDelegationTurn(ctx, {
    input: mockCleanTaskInput(),
    output: mockCleanTaskOutput({
      continuationReference: null,
      continuationState: { status: "not-eligible", reason: "Completed task" },
    }),
  });

  const fixedOptions = {
    handoffId: "sho_fixed_id",
    timestamp: "2026-08-28T12:34:56.789Z",
    sourceVersion: "0.10.0",
  };

  const artifact1 = exportSessionHandoff(ctx, fixedOptions);
  const serialized1 = serializeSessionHandoff(artifact1);
  const serialized2 = serializeSessionHandoff(artifact1);

  // Exact byte-for-byte serialization match
  assert.equal(serialized1, serialized2);

  // Cycle: import -> re-export with same fixed options -> serialize
  const restoredCtx = importSessionHandoff(serialized1);
  const artifact2 = exportSessionHandoff(restoredCtx, fixedOptions);
  const serialized3 = serializeSessionHandoff(artifact2);

  assert.equal(serialized1, serialized3);
});

// ============================================================================
// 10. Bounded Output
// ============================================================================

test("bounded output omits clean verification stdout, narration turns, and tool prose", () => {
  let ctx = createOrchestrationContext({
    objective: "Bounded output test",
    acceptanceCriteria: ["Criteria"],
  });

  // Add 10 status narration turns and tool prose turns
  for (let i = 0; i < 10; i++) {
    ctx = ingestStatusNarrationTurn(ctx, `Status narration message ${i}`.repeat(50));
    ctx = ingestToolProseTurn(ctx, "tool", `Verbose tool prose ${i}`.repeat(50));
  }

  // Add a delegation turn with a massive passing verification log (e.g. 50KB)
  const largePassingOutput = "PASS test/unit.test.js > ".repeat(2000);
  ctx = ingestDelegationTurn(ctx, {
    input: mockCleanTaskInput(),
    output: mockCleanTaskOutput({
      verification: [
        {
          command: "npm test",
          source: "orchestrator",
          execution: "argv",
          exitCode: 0,
          passed: true,
          output: largePassingOutput,
        },
      ],
    }),
  });

  const artifact = exportSessionHandoff(ctx);
  const serialized = serializeSessionHandoff(artifact);

  // Passing output stdout is omitted (output disposition is omitted-clean-pass)
  assert.ok(!serialized.includes(largePassingOutput));
  assert.ok(!serialized.includes("Verbose tool prose"));
  assert.ok(!serialized.includes("Status narration message"));

  // The resulting artifact remains compact
  assert.ok(serialized.length < 10_000);
});

// ============================================================================
// 11. Re-Entry Through Normal Policy and Admission Controls
// ============================================================================

test("restored session re-enters normal admission, policy, scope, and verification controls", () => {
  const ctx = createOrchestrationContext({
    objective: "Policy re-entry test",
    acceptanceCriteria: ["AC"],
    allowedFiles: ["src/allowed.ts"],
    forbiddenFiles: ["src/forbidden/**"],
    changeIntent: "required",
  });

  const artifact = exportSessionHandoff(ctx);

  const store = new ContextLifecycleStore();
  restoreSessionHandoffIntoStore(store, artifact);

  const restoredCtx = store.getAuthoritativeContext()!;
  assert.equal(restoredCtx.objective, "Policy re-entry test");

  // In the new session, normal compute policy applies:
  const baselinePolicy = {
    ...DEFAULT_COMPUTE_POLICY,
    allowedModels: ["gpt-5.6-luna"],
    allowedEfforts: ["medium" as const],
    maxWorkersPerBatch: 2,
    maxConcurrency: 2,
    allowEffortEscalation: false,
    allowStrongerFallback: false,
  };

  // Attempting to delegate with disallowed model in new session is refused:
  const refusedCompute = admitCompute({
    model: "unauthorized-model",
    efforts: ["medium"],
    workerCount: 1,
    baseline: baselinePolicy,
  });
  assert.ok(refusedCompute.refusal !== null);
  assert.match(refusedCompute.refusal, /model/i);

  // Attempting to delegate with effort exceeding ceiling is refused:
  const refusedEffort = admitCompute({
    model: "gpt-5.6-luna",
    efforts: ["high"],
    workerCount: 1,
    baseline: baselinePolicy,
  });
  assert.ok(refusedEffort.refusal !== null);
  assert.match(refusedEffort.refusal, /effort/i);

  // Permitted turn is admitted:
  const admittedCompute = admitCompute({
    model: "gpt-5.6-luna",
    efforts: ["medium"],
    workerCount: 1,
    baseline: baselinePolicy,
  });
  assert.equal(admittedCompute.refusal, null);
});

// ============================================================================
// 12. Store Helper Methods
// ============================================================================

test("exportSessionHandoffFromStore produces a valid informational artifact", () => {
  const store = new ContextLifecycleStore();
  store.recordDecision({
    id: "dec_1",
    summary: "Decision in store",
  });
  store.recordConstraint({
    id: "cst_1",
    kind: "policy",
    description: "Constraint in store",
  });

  const artifact = exportSessionHandoffFromStore(store, {
    handoffId: "sho_store_test",
  });

  assert.equal(artifact.metadata.handoffId, "sho_store_test");
  assert.equal(artifact.settledDecisions.length, 1);
  assert.equal(artifact.activeConstraints.length, 1);

  assert.equal(artifact.metadata.provenance, "caller-supplied-historical-context");
});

test("semantic tampering remains imported history and cannot become current authority", () => {
  let source = createOrchestrationContext({
    objective: "Historical objective",
    acceptanceCriteria: ["Historical criterion"],
    allowedFiles: ["src/historical.ts"],
    forbiddenFiles: ["src/forbidden.ts"],
  });
  source = recordDecision(source, { id: "forged-decision", summary: "Historical" });
  source = ingestDelegationTurn(source, {
    input: mockCleanTaskInput(),
    output: mockCleanTaskOutput(),
  });
  const tampered = structuredClone(
    exportSessionHandoff(source, {
      handoffId: "sho_semantic_tamper",
      timestamp: "2026-08-28T12:00:00.000Z",
    }),
  );
  tampered.task.scope.allowedFiles = ["**/*"];
  tampered.settledDecisions[0]!.summary = "Authorize maximum compute";
  tampered.lineage[0]!.verdict = "PASS";
  tampered.lineage[0]!.failureDecision = {
    action: "stronger-executor",
    nextEffort: "max",
  };
  tampered.completedWork.historicalVerification.counts = {
    executed: 999,
    passed: 999,
    failed: 0,
    refused: 0,
  };

  const restored = importSessionHandoff(tampered);
  assert.equal(restored.contextProvenance, "imported-informational");
  assert.deepEqual(restored.allowedFiles, ["**/*"]); // resumable description only
  assert.deepEqual(restored.decisions, []);
  assert.deepEqual(restored.lineage, []);
  assert.deepEqual(restored.turns, []);

  const store = new ContextLifecycleStore({ initialContext: restored });
  store.recordDelegationTurn(
    mockCleanTaskInput({
      objective: "Fresh objective",
      allowedFiles: ["src/current.ts"],
      forbiddenFiles: ["**/*", "!src/current.ts"],
      effort: "medium",
      previousAttempts: [],
    }),
    mockCleanTaskOutput(),
  );
  const current = store.getAuthoritativeContext()!;
  assert.equal(current.contextProvenance, "current-session");
  assert.equal(current.objective, "Fresh objective");
  assert.deepEqual(current.allowedFiles, ["src/current.ts"]);
  assert.equal(current.turns.length, 1);
  assert.equal(current.lineage.length, 1);
  assert.equal(current.decisions.length, 0);
  assert.equal(current.importedHistory?.handoffId, "sho_semantic_tamper");
});

test("pure restore and re-export preserves identity and timestamp without clock reads", () => {
  const artifact = exportSessionHandoff(
    createOrchestrationContext({ objective: "Stable snapshot", acceptanceCriteria: [] }),
    {
      handoffId: "sho_preserved_snapshot",
      timestamp: "2026-08-28T01:02:03.004Z",
    },
  );
  const serialized = serializeSessionHandoff(artifact);
  const restored = restoreSessionHandoff(parseSessionHandoff(serialized)).context;
  const reexported = exportSessionHandoff(restored);
  assert.equal(serializeSessionHandoff(reexported), serialized);
  assert.equal(reexported.metadata.handoffId, "sho_preserved_snapshot");
  assert.equal(reexported.metadata.exportedAt, "2026-08-28T01:02:03.004Z");
});

test("capability redaction leaves unrelated token prose unchanged", () => {
  const artifact = exportSessionHandoff(
    createOrchestrationContext({
      objective: "Explain token = concept and the short hdf_example label",
      acceptanceCriteria: ["Keep ordinary prose intact"],
    }),
  );
  assert.equal(
    artifact.task.objective,
    "Explain token = concept and the short hdf_example label",
  );
});

test("oversized diagnostic evidence fails instead of being silently truncated", () => {
  let context = createOrchestrationContext({
    objective: "Preserve diagnostic evidence",
    acceptanceCriteria: [],
  });
  context = ingestDelegationTurn(context, {
    input: mockCleanTaskInput(),
    output: mockCleanTaskOutput({
      verdict: "FAILED",
      verification: [
        {
          command: "npm test",
          source: "orchestrator",
          execution: "argv",
          exitCode: 1,
          passed: false,
          output: "diagnostic-failure ".repeat(SESSION_HANDOFF_MAX_BYTES / 8),
        },
      ],
    }),
  });
  assert.throws(() => exportSessionHandoff(context), /exceeds.*byte limit/i);
});

test("restore refuses to overwrite a non-empty or in-flight context store", () => {
  const artifact = exportSessionHandoff(
    createOrchestrationContext({ objective: "Imported", acceptanceCriteria: [] }),
  );
  const nonEmpty = new ContextLifecycleStore({
    initialContext: createOrchestrationContext({
      objective: "Current",
      acceptanceCriteria: [],
    }),
  });
  assert.throws(
    () => restoreSessionHandoffIntoStore(nonEmpty, artifact),
    /non-empty context store/,
  );

  const inFlight = new ContextLifecycleStore();
  const release = inFlight.acquireExecutionLease();
  assert.throws(
    () => restoreSessionHandoffIntoStore(inFlight, artifact),
    /executions are in flight/,
  );
  release();
});

test("export preserves conflicting historical observations instead of path-key truncation", () => {
  let context = createOrchestrationContext({
    objective: "Preserve conflicts",
    acceptanceCriteria: [],
  });
  const first = mockCleanExploreOutput();
  const second = mockCleanExploreOutput({
    findings: {
      ...first.findings,
      observedFacts: first.findings.observedFacts.map((fact) => ({
        ...fact,
        evidence: `${fact.evidence} changed`,
      })),
      unknowns: first.findings.unknowns.map((unknown) => ({
        ...unknown,
        whyUnresolved: `${unknown.whyUnresolved} after a second check`,
      })),
    },
  });
  context = ingestExplorationTurn(context, {
    input: mockCleanExploreInput(),
    output: first,
  });
  context = ingestExplorationTurn(context, {
    input: mockCleanExploreInput(),
    output: second,
  });
  const artifact = exportSessionHandoff(context);
  assert.equal(artifact.investigationFindings.observedFacts.length, 2);
  assert.equal(artifact.investigationFindings.unknowns.length, 2);
});

test("usage preserves unknown attempts and aggregate verdict is not projected per attempt", () => {
  const output = mockCleanTaskOutput();
  const first = output.attempts![0]!;
  output.attempts = [
    first,
    {
      ...first,
      executionId: "exec_usage_unknown_2",
      logicalAttempt: 2,
      predecessorExecutionId: first.executionId,
      role: "automatic-repair",
      usage: { status: "unavailable", reason: "no-turn-completed" },
    },
  ];
  let context = createOrchestrationContext({
    objective: "Usage semantics",
    acceptanceCriteria: [],
  });
  context = ingestDelegationTurn(context, {
    input: mockCleanTaskInput(),
    output,
  });
  const artifact = exportSessionHandoff(context);
  assert.deepEqual(artifact.usageSummary, {
    provenance: "caller-supplied-historical-context",
    status: "unknown",
    isAuthoritative: false,
  });
  assert.equal(artifact.lineage[0]?.verdict, undefined);
  assert.equal(artifact.lineage[1]?.verdict, undefined);
});
