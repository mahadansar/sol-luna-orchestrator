import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  calculateContextPressureMetrics,
  compactContext,
  createOrchestrationContext,
  evaluateContextPressure,
  ingestBatchTurn,
  ingestContinuationTurn,
  ingestDelegationTurn,
  ingestRoutingPreflightTurn,
  ingestStatusNarrationTurn,
  ingestToolProseTurn,
  isSafeLifecycleBoundary,
  maybeCompactContext,
  recordBlocker,
  recordConstraint,
  recordDecision,
  resolveBlocker,
  resolveContextPressureConfig,
  scrubSensitiveText,
  type ContextBlocker,
  type ContextConstraint,
  type ContextDecision,
  type ContextPressurePolicyConfig,
  type OrchestrationContext,
} from "./context.js";
import type {
  BatchOutput,
  DelegateTaskInput,
  DelegateTaskOutput,
  DelegateTasksInput,
} from "./contract.js";
import { parseContextNonNegativeInteger, parseContextPositiveInteger } from "./config.js";

function mockCleanTaskInput(
  overrides: Partial<DelegateTaskInput> = {},
): DelegateTaskInput {
  return {
    objective:
      "Implement a reliable deterministic context compaction core primitive for Sol-Luna.",
    effort: "high",
    effortReason:
      "Core algorithmic lifecycle primitive with security and retention guarantees",
    changeIntent: "required",
    automaticRepair: false,
    allowedFiles: ["src/context.ts", "src/context.test.ts"],
    forbiddenFiles: ["dist/**", "node_modules/**"],
    acceptanceCriteria: [
      "Objective, acceptance criteria, scope, and decisions are retained intact.",
      "Clean PASS turns strip passed verification stdout.",
      "Failure decisions, conflicts, and verification failures are strictly preserved.",
      "Compaction is deterministic and idempotent.",
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
    failureDecision: {
      classification: "success",
      action: "stop",
      reason: "The task passed; successful work is never retried.",
      evidenceExecutionIds: ["exec_clean_1"],
      nextEffort: null,
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
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
        startedAt: "2026-08-27T10:00:00.000Z",
        finishedAt: "2026-08-27T10:01:00.000Z",
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
            output: "15/15 tests passed.",
          },
        ],
      },
    ],
    summary: "Implemented context compaction module with tests.",
    notes: "No breaking changes.",
    followUps: [],
    filesChanged: [
      {
        path: "src/context.ts",
        kind: "added",
        why: "Core compaction logic",
        observed: true,
      },
      { path: "src/context.test.ts", kind: "added", why: "Unit tests", observed: true },
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
        output: "15/15 tests passed.",
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

function mockFailedTaskOutput(
  overrides: Partial<DelegateTaskOutput> = {},
): DelegateTaskOutput {
  return {
    changeIntent: "required",
    verdict: "FAILED",
    workerClaimedStatus: "FAILED",
    workerClaimedFailureCauses: ["verification"],
    trustworthy: true,
    workerThreadId: "thread_fail_456",
    continuationReference: null,
    continuationState: {
      status: "not-eligible",
      reason: "Failed turn",
    },
    handoffReference: "hdf_fixture_retry_12345678901234567890123456789012",
    handoffState: {
      status: "issued",
      reason: "One bounded next-action handoff issued for retry.",
    },
    repair: {
      requested: true,
      attempted: true,
      classification: "local-verification",
      reason: "Verification failed with exit code 1",
      failureEvidence: [
        {
          command: "npm test",
          execution: "argv",
          exitCode: 1,
          output: "AssertionError: expected true but got false in compaction.test.ts:42",
        },
      ],
    },
    recovery: null,
    failureDecision: {
      classification: "verification",
      action: "retry",
      reason: "Targeted verification check failed deterministically",
      evidenceExecutionIds: ["exec_fail_1"],
      nextEffort: null,
      automaticHandler: "automatic-repair",
      automaticRetryCount: 1,
      automaticRetryLimit: 1,
    },
    model: "gpt-5.6-luna",
    effort: "high",
    effortReason: "Core feature retry",
    attempt: 1,
    attempts: [
      {
        executionId: "exec_fail_1",
        logicalAttempt: 1,
        role: "initial",
        predecessorExecutionId: null,
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "high",
        threadId: "thread_fail_456",
        threadOperation: "start",
        threadIdentityMatched: true,
        startedAt: "2026-08-27T11:00:00.000Z",
        finishedAt: "2026-08-27T11:01:00.000Z",
        elapsedMs: 60000,
        workerElapsedMs: 50000,
        verificationElapsedMs: 10000,
        timeoutMs: 1800000,
        termination: { kind: "completed", message: null },
        usage: {
          status: "reported",
          source: "codex-turn.completed",
          value: {
            inputTokens: 600,
            cachedInputTokens: 100,
            outputTokens: 250,
            reasoningOutputTokens: 60,
          },
        },
        workerClaimedStatus: "FAILED",
        workerClaimedFailureCauses: ["verification"],
        verification: [
          {
            command: "npm test",
            source: "orchestrator",
            execution: "argv",
            exitCode: 1,
            passed: false,
            output:
              "AssertionError: expected true but got false in compaction.test.ts:42",
          },
        ],
      },
    ],
    summary: "Attempted implementation but verification failed.",
    notes: "Failed on assertion in compaction.test.ts.",
    followUps: ["Fix assertion mismatch."],
    filesChanged: [
      { path: "src/context.ts", kind: "modified", why: "Partial edit", observed: true },
    ],
    verification: [
      {
        command: "npm test",
        source: "orchestrator",
        execution: "argv",
        exitCode: 1,
        passed: false,
        output: "AssertionError: expected true but got false in compaction.test.ts:42",
      },
    ],
    verificationMode: "allowlist",
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: ["[ ] Review verification failure output before retrying"],
    escalationAdvice: "Rerun with fix for assertion mismatch.",
    durationSeconds: 60,
    usage: {
      inputTokens: 600,
      cachedInputTokens: 100,
      outputTokens: 250,
      reasoningOutputTokens: 60,
    },
    errors: [],
    ...overrides,
  };
}

// --- Test Suite -------------------------------------------------------------

test("context core - clean successful history compaction reduces size and strips passed output", () => {
  let ctx = createOrchestrationContext({
    objective:
      "Implement a reliable deterministic context compaction core primitive for Sol-Luna.",
    acceptanceCriteria: ["All tests pass.", "TypeScript compiles with zero errors."],
    allowedFiles: ["src/context.ts"],
    forbiddenFiles: ["dist/**"],
    changeIntent: "required",
  });

  // Ingest status narration turns (which should be discarded)
  ctx = ingestStatusNarrationTurn(ctx, "Starting worker thread...", "waiting");
  ctx = ingestStatusNarrationTurn(ctx, "Polling worker status turn 1...", "polling");
  ctx = ingestToolProseTurn(
    ctx,
    "delegate_task",
    "Detailed tool description prose with schema info...",
  );

  // Ingest clean PASS delegation turn
  const input = mockCleanTaskInput();
  const output = mockCleanTaskOutput();
  ctx = ingestDelegationTurn(ctx, { input, output });
  const canonicalSnapshot = structuredClone(ctx);

  const compacted = compactContext(ctx);

  // Assertions
  assert.equal(compacted.turns.length, 1);
  assert.equal(compacted.turns[0]?.isClean, true);
  assert.equal(compacted.turns[0]?.verdict, "PASS");
  assert.equal(compacted.turns[0]?.authoritativeVerification.executed, 2);
  assert.equal(compacted.turns[0]?.authoritativeVerification.passed, 2);
  assert.equal(compacted.turns[0]?.authoritativeVerification.failed, 0);

  // Passed verification output must be stripped to empty string
  for (const v of compacted.turns[0]?.verificationDetails ?? []) {
    assert.equal(v.output, "");
    assert.equal(v.outputDisposition, "omitted-clean-pass");
  }
  assert.deepEqual(
    compacted.turns[0]?.filesChanged.map((file) => file.path),
    ["src/context.ts", "src/context.test.ts"],
  );
  assert.deepEqual(compacted.turns[0]?.risks, ["No breaking changes."]);
  assert.equal(compacted.turns[0]?.contract?.objective, input.objective);
  assert.deepEqual(
    compacted.turns[0]?.contract?.acceptanceCriteria,
    input.acceptanceCriteria,
  );
  assert.deepEqual(ctx, canonicalSnapshot);
  assert.equal(compacted.lineage[0]?.verification?.[0]?.output, "");
  assert.equal(
    compacted.lineage[0]?.verification?.[0]?.outputDisposition,
    "omitted-clean-pass",
  );
  assert.doesNotMatch(JSON.stringify(compacted), /thread_clean_123/);

  // Stats confirm discards and compaction reduction
  assert.equal(compacted.stats.discardedNarrationTurns, 2);
  assert.equal(compacted.stats.discardedToolProseTurns, 1);
  assert.equal(compacted.stats.compactedCleanTurns, 1);
  assert.ok(compacted.stats.reductionRatio > 0);
  assert.ok(compacted.stats.compactedSizeBytes < compacted.stats.originalSizeBytes);
  assert.equal(
    compacted.stats.sizeDeltaBytes,
    compacted.stats.compactedSizeBytes - compacted.stats.originalSizeBytes,
  );
  assert.equal(
    compacted.stats.compactedSizeBytes,
    new TextEncoder().encode(
      JSON.stringify({
        ...compacted,
        stats: {
          ...compacted.stats,
          compactedSizeBytes: 0,
          sizeDeltaBytes: 0,
          reductionRatio: 0,
        },
      }),
    ).byteLength,
  );
});

test("context core - similar decisions and constraints remain distinct records", () => {
  let ctx = createOrchestrationContext({
    objective:
      "Implement a reliable deterministic context compaction core primitive for Sol-Luna.",
    acceptanceCriteria: ["Criteria 1"],
  });

  // Record same decision twice
  ctx = recordDecision(ctx, {
    kind: "architectural",
    summary: "Use pure synchronous compaction without model calls.",
  });
  ctx = recordDecision(ctx, {
    kind: "architectural",
    summary: "Use pure synchronous compaction without model calls.", // Duplicate
  });

  // Record same constraint twice
  ctx = recordConstraint(ctx, {
    kind: "verification",
    description: "Verification policy must remain allowlist.",
    active: true,
  });
  ctx = recordConstraint(ctx, {
    kind: "verification",
    description: "Verification policy must remain allowlist.", // Duplicate
    active: true,
  });

  const compacted = compactContext(ctx);

  assert.equal(compacted.decisions.length, 2);
  assert.equal(
    compacted.decisions[0]?.summary,
    "Use pure synchronous compaction without model calls.",
  );
  assert.equal(compacted.constraints.length, 2);
  assert.equal(
    compacted.constraints[0]?.description,
    "Verification policy must remain allowlist.",
  );
  assert.notEqual(compacted.decisions[0]?.id, compacted.decisions[1]?.id);
  assert.notEqual(compacted.constraints[0]?.id, compacted.constraints[1]?.id);
});

test("context core - failure/conflict retention preserves rich diagnostic evidence", () => {
  let ctx = createOrchestrationContext({
    objective:
      "Implement a reliable deterministic context compaction core primitive for Sol-Luna.",
    acceptanceCriteria: ["Criteria 1"],
  });

  const failedInput = mockCleanTaskInput();
  const failedOutput = mockFailedTaskOutput({
    scopeViolations: ["Edited outside scope: src/unauthorized.ts"],
    discrepancies: ["Worker claimed PASS but test failed."],
    errors: ["Runtime error during post-execution hook"],
  });

  ctx = ingestDelegationTurn(ctx, { input: failedInput, output: failedOutput });

  const compacted = compactContext(ctx);

  assert.equal(compacted.turns.length, 1);
  const turn = compacted.turns[0]!;
  assert.equal(turn.isClean, false);
  assert.equal(turn.verdict, "FAILED");
  assert.equal(turn.workerClaim!.status, "FAILED");
  assert.deepEqual(turn.workerClaim!.failureCauses, ["verification"]);

  // Failure decision preserved
  assert.equal(turn.failureDecision?.classification, "verification");
  assert.equal(turn.failureDecision?.action, "retry");

  // Scope violations, discrepancies, errors preserved
  assert.deepEqual(turn.scopeViolations, ["Edited outside scope: src/unauthorized.ts"]);
  assert.deepEqual(turn.discrepancies, ["Worker claimed PASS but test failed."]);
  assert.deepEqual(turn.errors, ["Runtime error during post-execution hook"]);

  // Failed verification output preserved
  assert.equal(turn.verificationDetails.length, 1);
  assert.equal(turn.verificationDetails[0]?.passed, false);
  assert.ok(
    turn.verificationDetails[0]?.output.includes(
      "AssertionError: expected true but got false in compaction.test.ts:42",
    ),
  );

  // Active handoff authority is preserved without exposing the capability.
  assert.equal(compacted.activeHandoffs.length, 1);
  assert.equal(compacted.activeHandoffs[0]?.action, "retry");
  assert.ok(!JSON.stringify(compacted).includes("hdf_fixture_retry"));
});

test("context core - batch delegation preserves integration conflicts and scope conflicts", () => {
  let ctx = createOrchestrationContext({
    objective: "Implement multi-task parallel batch.",
    acceptanceCriteria: ["Criteria 1"],
  });

  const batchInput: DelegateTasksInput = {
    mode: "parallel",
    resultDetail: "handoff",
    tasks: [
      {
        objective: "Task 1",
        effort: "high",
        effortReason: "High",
        changeIntent: "required",
        automaticRepair: false,
        allowedFiles: ["src/a.ts"],
        forbiddenFiles: [],
        acceptanceCriteria: ["Done"],
        verificationCommands: ["npm test"],
        previousAttempts: [],
      },
      {
        objective: "Task 2",
        effort: "high",
        effortReason: "High",
        changeIntent: "required",
        automaticRepair: false,
        allowedFiles: ["src/b.ts"],
        forbiddenFiles: [],
        acceptanceCriteria: ["Done"],
        verificationCommands: ["npm test"],
        previousAttempts: [],
      },
    ],
    allowOverlappingScopes: false,
    integrate: true,
    automaticRecovery: true,
  };

  const batchOutput: BatchOutput = {
    batchId: "batch_conflict_1",
    mode: "parallel",
    maxParallel: 2,
    taskCount: 2,
    passed: 1,
    failed: 1,
    durationSeconds: 45,
    tasks: [
      {
        taskId: "t1",
        state: "completed",
        objective: "Task 1",
        effort: "high",
        effortReason: "High",
        result: mockCleanTaskOutput(),
        changedFiles: ["src/shared.ts"],
        worktreePath: null,
        error: null,
        warnings: [],
      },
      {
        taskId: "t2",
        state: "failed",
        objective: "Task 2",
        effort: "high",
        effortReason: "High",
        result: mockFailedTaskOutput(),
        changedFiles: ["src/shared.ts"],
        worktreePath: null,
        error: "Integration conflict",
        warnings: ["Conflict in shared.ts"],
      },
    ],
    scopeConflicts: ["src/shared.ts overlap"],
    integrationConflicts: [{ path: "src/shared.ts", tasks: ["t1", "t2"] }],
    integrated: false,
    integrationSummary: "Integration failed due to collision in src/shared.ts",
    integrationVerification: [
      {
        command: "npm test",
        source: "orchestrator",
        execution: "argv",
        exitCode: 1,
        passed: false,
        output: "Integration test failed",
      },
    ],
    completionState: "needs-supervisor",
    warnings: ["Unintegrated changes"],
    reviewChecklist: ["[ ] Manual merge required"],
  };

  ctx = ingestBatchTurn(ctx, { input: batchInput, output: batchOutput });

  const compacted = compactContext(ctx);

  assert.equal(compacted.turns.length, 1);
  const turn = compacted.turns[0]!;
  assert.equal(turn.verdict, "NEEDS_SUPERVISOR");
  assert.equal(turn.conflicts.length, 2);
  assert.equal(turn.conflicts[0]?.type, "scope");
  assert.equal(turn.conflicts[1]?.type, "integration");
  assert.ok(
    turn.conflicts[1]?.details.includes(
      "Collision in src/shared.ts across tasks: t1, t2",
    ),
  );

  // Blockers extracted from integration conflicts
  assert.ok(compacted.blockers.some((b) => b.kind === "integration-conflict"));

  assert.ok(
    turn.verificationDetails.some((item) => item.output === "Integration test failed"),
  );
  assert.ok(
    turn.batchTasks?.some((task) =>
      task.verificationDetails.some((item) => item.output.includes("AssertionError")),
    ),
  );
  assert.deepEqual(turn.authoritativeVerification, {
    executed: 4,
    passed: 2,
    failed: 2,
    refused: 0,
  });
  assert.equal(turn.batchOutcome?.completionState, "needs-supervisor");
  assert.equal(turn.batchOutcome?.integrated, false);
  assert.match(turn.batchOutcome?.integrationSummary ?? "", /collision/);
});

test("context core - acceptance, scope, decisions, and constraints retention", () => {
  const ctx = createOrchestrationContext({
    objective: "Implement strict context retention and compaction.",
    acceptanceCriteria: [
      "Criterion A: Retain invariant rules.",
      "Criterion B: Retain scope boundaries.",
    ],
    allowedFiles: ["src/context.ts"],
    forbiddenFiles: ["dist/**", "node_modules/**"],
    changeIntent: "required",
    taskCategory: "implementation",
    decisions: [
      {
        id: "dec_1",
        kind: "architectural",
        summary: "Context compaction must be purely deterministic.",
        details: "No LLM calls or network I/O in the compaction path.",
        source: "ROADMAP.md",
      },
      {
        id: "dec_2",
        kind: "invariant",
        summary: "Never drop unresolved blockers.",
        source: "SOL_RULES.md",
      },
    ],
    constraints: [
      {
        id: "cst_1",
        kind: "scope",
        description: "Must stay within allowedFiles glob.",
        active: true,
      },
    ],
    blockers: [
      {
        id: "blk_1",
        kind: "unmet-requirement",
        description: "Missing verification command definition.",
        resolved: false,
      },
    ],
  });

  const compacted = compactContext(ctx);

  assert.equal(compacted.objective, "Implement strict context retention and compaction.");
  assert.deepEqual(compacted.allowedFiles, ["src/context.ts"]);
  assert.deepEqual(compacted.forbiddenFiles, ["dist/**", "node_modules/**"]);
  assert.equal(compacted.changeIntent, "required");
  assert.equal(compacted.taskCategory, "implementation");
  assert.equal(compacted.acceptanceCriteria.length, 2);
  assert.equal(compacted.decisions.length, 2);
  assert.equal(compacted.constraints.length, 1);
  assert.equal(compacted.blockers.length, 1);
  assert.equal(compacted.blockers[0]?.resolved, false);
});

test("context core - claim vs verified evidence distinction is strictly preserved", () => {
  let ctx = createOrchestrationContext({
    objective: "Verify claim vs verified evidence distinction.",
    acceptanceCriteria: ["Claim vs fact integrity."],
  });

  // A deceitful worker claim where worker claimed PASS but runtime verdict is FAILED
  const output = mockFailedTaskOutput({
    verdict: "FAILED",
    workerClaimedStatus: "PASS", // Worker claimed PASS!
    workerClaimedFailureCauses: [],
    trustworthy: false,
    filesChanged: [
      {
        path: "src/claimed_only.ts",
        kind: "added",
        why: "Worker claimed this",
        observed: false, // NOT observed by runtime!
      },
      {
        path: "src/real.ts",
        kind: "modified",
        why: "Observed edit",
        observed: true, // Observed by runtime!
      },
    ],
    verification: [
      {
        command: "npm test",
        source: "orchestrator",
        execution: "argv",
        exitCode: 1,
        passed: false,
        output: "Test failed",
      },
      {
        command: "npm run lint",
        source: "worker", // Worker self-reported!
        execution: "reported",
        exitCode: 0,
        passed: true,
        output: "Worker says lint passed",
      },
    ],
    discrepancies: ["Worker claimed PASS but authoritative verification failed."],
  });

  ctx = ingestDelegationTurn(ctx, { input: mockCleanTaskInput(), output });

  const compacted = compactContext(ctx);

  const turn = compacted.turns[0]!;
  assert.equal(turn.verdict, "FAILED");
  assert.equal(turn.workerClaim!.status, "PASS"); // Worker claim recorded faithfully
  assert.equal(
    turn.filesChanged.find((f) => f.path === "src/claimed_only.ts")?.observed,
    false,
  );
  assert.equal(turn.filesChanged.find((f) => f.path === "src/real.ts")?.observed, true);

  // Authoritative vs worker-reported verification preserved
  const authRuns = turn.verificationDetails.filter((v) => v.source === "orchestrator");
  const workerRuns = turn.verificationDetails.filter((v) => v.source === "worker");
  assert.equal(authRuns.length, 1);
  assert.equal(authRuns[0]?.passed, false);
  assert.equal(workerRuns.length, 1);
  assert.equal(workerRuns[0]?.passed, true);
});

test("context core - retry, continuation, and handoff lineage retention", () => {
  let ctx = createOrchestrationContext({
    objective: "Chain multiple execution attempts with lineage.",
    acceptanceCriteria: ["Lineage intact."],
  });

  // Turn 1: initial attempt fails
  const out1 = mockFailedTaskOutput({
    attempt: 1,
    attempts: [
      {
        executionId: "exec_1",
        logicalAttempt: 1,
        role: "initial",
        predecessorExecutionId: null,
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "high",
        threadId: "thread_1",
        threadOperation: "start",
        threadIdentityMatched: true,
        startedAt: "2026-08-27T12:00:00.000Z",
        finishedAt: "2026-08-27T12:01:00.000Z",
        elapsedMs: 60000,
        workerElapsedMs: 50000,
        verificationElapsedMs: 10000,
        timeoutMs: 1800000,
        termination: { kind: "completed", message: null },
        usage: { status: "unavailable", reason: "turn-failed" },
        workerClaimedStatus: "FAILED",
        workerClaimedFailureCauses: ["verification"],
        verification: [],
      },
    ],
    handoffReference: "hdf_fixture_token_retry_001_12345678901234567890",
    handoffState: { status: "issued", reason: "Earned retry handoff." },
  });
  ctx = ingestDelegationTurn(ctx, { input: mockCleanTaskInput(), output: out1 });

  // Turn 2: continuation turn succeeds
  const out2 = mockCleanTaskOutput({
    attempt: 2,
    attempts: [
      {
        executionId: "exec_2",
        logicalAttempt: 2,
        role: "manual-continuation",
        predecessorExecutionId: "exec_1",
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "high",
        threadId: "thread_1",
        threadOperation: "resume",
        threadIdentityMatched: true,
        startedAt: "2026-08-27T12:05:00.000Z",
        finishedAt: "2026-08-27T12:06:00.000Z",
        elapsedMs: 60000,
        workerElapsedMs: 50000,
        verificationElapsedMs: 10000,
        timeoutMs: 1800000,
        termination: { kind: "completed", message: null },
        usage: {
          status: "reported",
          source: "codex-turn.completed",
          value: {
            inputTokens: 400,
            cachedInputTokens: 200,
            outputTokens: 100,
            reasoningOutputTokens: 20,
          },
        },
        workerClaimedStatus: "PASS",
        workerClaimedFailureCauses: [],
        verification: [
          {
            command: "npm test",
            source: "orchestrator",
            execution: "argv",
            exitCode: 0,
            passed: true,
            output: "Passed",
          },
        ],
      },
    ],
    continuationReference: "ctr_followup_token_002_12345678901234567890",
    continuationState: { status: "issued", reason: "Continuation available." },
  });
  ctx = ingestContinuationTurn(ctx, {
    continuationReference: "ctr_initial_token_001_12345678901234567890",
    instruction: "Fix the assertion",
    output: out2,
  });

  const compacted = compactContext(ctx);

  // Lineage chain verification
  assert.equal(compacted.lineage.length, 2);
  assert.equal(compacted.lineage[0]?.executionId, "exec_1");
  assert.equal(compacted.lineage[0]?.predecessorExecutionId, null);
  assert.equal(compacted.lineage[0]?.role, "initial");
  assert.equal(compacted.lineage[0]?.logicalAttempt, 1);

  assert.equal(compacted.lineage[1]?.executionId, "exec_2");
  assert.equal(compacted.lineage[1]?.predecessorExecutionId, "exec_1");
  assert.equal(compacted.lineage[1]?.role, "manual-continuation");
  assert.equal(compacted.lineage[1]?.logicalAttempt, 2);

  // Reference authority is tracked without exposing capability values.
  assert.equal(compacted.activeHandoffs.length, 1);
  assert.equal(
    compacted.activeHandoffs[0]?.availabilityBasis,
    "recorded-issued-unconsumed",
  );
  assert.equal(compacted.activeContinuations.length, 1);
  assert.equal(
    compacted.activeContinuations[0]?.availabilityBasis,
    "recorded-issued-unconsumed",
  );
  assert.ok(!JSON.stringify(compacted).includes("hdf_fixture_token_retry_001"));
  assert.ok(!JSON.stringify(compacted).includes("ctr_followup_token_002"));
});

test("context core - blocker resolution lifecycle", () => {
  let ctx = createOrchestrationContext({
    objective: "Blocker lifecycle tracking.",
    acceptanceCriteria: ["Blocker resolved."],
  });

  ctx = recordBlocker(ctx, {
    id: "blk_scope_1",
    kind: "scope-conflict",
    description: "Overlap in src/config.ts",
    resolved: false,
  });

  let compacted = compactContext(ctx);
  assert.equal(compacted.blockers.filter((b) => !b.resolved).length, 1);

  // Resolve blocker
  ctx = resolveBlocker(ctx, "blk_scope_1");
  compacted = compactContext(ctx);
  assert.equal(compacted.blockers.filter((b) => !b.resolved).length, 0);
  assert.equal(compacted.blockers.find((b) => b.id === "blk_scope_1")?.resolved, true);
});

test("context core - imported provenance becomes current when continuation evidence or blocker state changes", () => {
  let imported = createOrchestrationContext({
    objective: "Imported historical context",
    acceptanceCriteria: [],
    contextProvenance: "imported-informational",
  });
  imported = recordBlocker(imported, {
    id: "blk_imported",
    kind: "unmet-requirement",
    description: "Resolve in the current session.",
  });
  imported = { ...imported, contextProvenance: "imported-informational" };

  const resolved = resolveBlocker(imported, "blk_imported");
  assert.equal(resolved.contextProvenance, "current-session");

  const continued = ingestContinuationTurn(imported, {
    continuationReference: "ctr_imported_fixture",
    instruction: "Continue with current evidence.",
    output: mockCleanTaskOutput(),
  });
  assert.equal(continued.contextProvenance, "current-session");
});

test("context core - compaction is strictly idempotent", () => {
  let ctx = createOrchestrationContext({
    objective: "Idempotent compaction proof.",
    acceptanceCriteria: ["Criteria 1", "Criteria 2"],
    allowedFiles: ["src/a.ts"],
    forbiddenFiles: ["dist/**"],
    changeIntent: "required",
    decisions: [
      { id: "d1", kind: "architectural", summary: "Pure functions only." },
      { id: "d2", kind: "architectural", summary: "Pure functions only." }, // duplicate
    ],
  });

  ctx = ingestStatusNarrationTurn(ctx, "Narration 1", "waiting");
  ctx = ingestDelegationTurn(ctx, {
    input: mockCleanTaskInput(),
    output: mockCleanTaskOutput(),
  });

  const pass1 = compactContext(ctx);
  const pass2 = compactContext(pass1);

  assert.deepEqual(pass2, pass1);
  assert.notEqual(pass2, pass1);
});

test("context core - authoritative contract semantics are never length truncated", () => {
  const hugeObjective = "X".repeat(5000);
  const hugeCriterion = "Y".repeat(2000);
  const hugeDecision = "Z".repeat(3000);

  const ctx = createOrchestrationContext({
    objective: hugeObjective,
    acceptanceCriteria: [hugeCriterion],
    decisions: [
      {
        id: "d_huge",
        kind: "architectural",
        summary: hugeDecision,
      },
    ],
  });

  const compacted = compactContext(ctx);

  assert.equal(compacted.objective, hugeObjective);
  assert.equal(compacted.acceptanceCriteria[0], hugeCriterion);
  assert.equal(compacted.decisions[0]?.summary, hugeDecision);
});

test("context core - privacy and sensitive output exclusion", () => {
  const rawTextWithSecrets =
    "Error occurred when connecting to https://api.openai.com with Authorization: Bearer sk-proj1234567890abcdef1234567890 and token=ghp_1234567890abcdef1234567890abcdef12 and password='SuperSecretPassword123!'";

  const { scrubbed, count } = scrubSensitiveText(rawTextWithSecrets);

  assert.ok(count >= 2);
  assert.doesNotMatch(scrubbed, /sk-proj1234567890abcdef1234567890/);
  assert.doesNotMatch(scrubbed, /ghp_1234567890abcdef1234567890abcdef12/);
  assert.doesNotMatch(scrubbed, /SuperSecretPassword123!/);
  assert.ok(
    scrubbed.includes("[REDACTED_SECRET]") || scrubbed.includes("[REDACTED_TOKEN]"),
  );

  // Verify that compactContext scrubs all fields
  const ctx = createOrchestrationContext({
    objective:
      "Test with API key sk-proj1234567890abcdef1234567890 included in objective.",
    acceptanceCriteria: ["Do not leak password=MySecretPassword99!"],
  });

  const compacted = compactContext(ctx);
  assert.doesNotMatch(compacted.objective, /sk-proj1234567890abcdef1234567890/);
  assert.doesNotMatch(compacted.acceptanceCriteria[0]!, /MySecretPassword99!/);
  assert.ok(compacted.stats.scrubbedValuesCount >= 2);
  assert.match(ctx.objective, /sk-proj1234567890abcdef1234567890/);
  assert.equal(
    scrubSensitiveText("token budget, auth failure, key decision, secret sauce").scrubbed,
    "token budget, auth failure, key decision, secret sauce",
  );
  assert.equal(
    scrubSensitiveText('password="line one\nline two"').scrubbed,
    'password="[REDACTED_SECRET]"',
  );
  assert.deepEqual(scrubSensitiveText("left\u0000right"), {
    scrubbed: "left right",
    count: 1,
  });
});

test("context core - turn bounding is soft and preserves failures and all lineage", () => {
  let ctx = createOrchestrationContext({
    objective: "Retain protected history.",
    acceptanceCriteria: Array.from({ length: 75 }, (_, index) => `criterion-${index}`),
  });

  for (let index = 0; index < 3; index++) {
    const base = mockCleanTaskOutput();
    ctx = ingestDelegationTurn(ctx, {
      id: `clean-${index}`,
      input: mockCleanTaskInput(),
      output: mockCleanTaskOutput({
        continuationReference: null,
        continuationState: { status: "unavailable", reason: "No continuation." },
        attempts: [
          {
            ...base.attempts![0]!,
            executionId: `exec-clean-${index}`,
            logicalAttempt: index + 1,
          },
        ],
      }),
    });
  }
  for (let index = 0; index < 3; index++) {
    const base = mockFailedTaskOutput();
    ctx = ingestDelegationTurn(ctx, {
      id: `failed-${index}`,
      input: mockCleanTaskInput(),
      output: mockFailedTaskOutput({
        handoffReference: null,
        handoffState: { status: "unavailable", reason: "No handoff." },
        attempts: [
          {
            ...base.attempts![0]!,
            executionId: `exec-failed-${index}`,
            logicalAttempt: index + 4,
          },
        ],
      }),
    });
  }

  const compacted = compactContext(ctx, { maxTurnsCount: 2 });
  assert.deepEqual(
    compacted.turns.map((turn) => turn.id),
    ["failed-0", "failed-1", "failed-2"],
  );
  assert.equal(compacted.lineage.length, 6);
  assert.equal(compacted.acceptanceCriteria.length, 75);
  assert.equal(compacted.stats.omittedCleanTurns, 3);
  assert.equal(compacted.stats.protectedTurnsOverLimit, true);
  assert.ok(
    compacted.stats.rulesApplied.includes(
      "rule:exceed-soft-limit-for-protected-evidence",
    ),
  );
});

test("context core - consumed capability references are no longer active", () => {
  const continuationReference = "ctr_consumed_12345678901234567890123456789012";
  const handoffReference = "hdf_consumed_12345678901234567890123456789012";
  let ctx = createOrchestrationContext({
    objective: "Track usable references only.",
    acceptanceCriteria: ["Consumed references are inactive."],
  });
  ctx = ingestDelegationTurn(ctx, {
    input: mockCleanTaskInput(),
    output: mockCleanTaskOutput({
      continuationReference,
      continuationState: { status: "issued", reason: "Usable once." },
    }),
  });
  ctx = ingestContinuationTurn(ctx, {
    continuationReference,
    instruction: "Use it.",
    output: mockCleanTaskOutput({
      continuationReference: null,
      continuationState: { status: "consumed", reason: "Consumed." },
    }),
  });
  ctx = ingestDelegationTurn(ctx, {
    input: mockCleanTaskInput(),
    output: mockFailedTaskOutput({
      handoffReference,
      handoffState: { status: "issued", reason: "Usable once." },
    }),
  });
  ctx = ingestDelegationTurn(ctx, {
    input: mockCleanTaskInput({ handoffReference }),
    output: mockCleanTaskOutput({
      continuationReference: null,
      continuationState: { status: "unavailable", reason: "None." },
      handoffReference: null,
      handoffState: { status: "consumed", reason: "Consumed." },
    }),
  });

  const compacted = compactContext(ctx);
  assert.equal(compacted.activeContinuations.length, 0);
  assert.equal(compacted.activeHandoffs.length, 0);
  assert.doesNotMatch(JSON.stringify(compacted.turns), /ctr_consumed|hdf_consumed/);
});

test("context core - ingestion is deterministic and does not read the clock", () => {
  const initial = createOrchestrationContext({
    objective: "Pure ingestion.",
    acceptanceCriteria: ["No hidden timestamps."],
  });
  const args = { input: mockCleanTaskInput(), output: mockCleanTaskOutput() };
  const first = ingestDelegationTurn(initial, args);
  const second = ingestDelegationTurn(initial, args);
  assert.deepEqual(first, second);
  assert.equal(first.turns[0]?.timestamp, undefined);
});

test("context core - failed continuations create blockers and duplicate ids fail closed", () => {
  let ctx = createOrchestrationContext({
    objective: "Continuation evidence.",
    acceptanceCriteria: ["Retain the blocker."],
  });
  ctx = ingestContinuationTurn(ctx, {
    id: "continuation-failure",
    continuationReference: "ctr_failure_12345678901234567890123456789012",
    instruction: "Try the repair.",
    output: mockFailedTaskOutput(),
  });
  assert.ok(
    ctx.blockers.some((blocker) => blocker.id === "blk_turn_continuation-failure"),
  );
  assert.throws(
    () =>
      ingestContinuationTurn(ctx, {
        id: "continuation-failure",
        continuationReference: "ctr_other_12345678901234567890123456789012",
        instruction: "A distinct event must not be merged.",
        output: mockFailedTaskOutput(),
      }),
    /turn id already exists/,
  );
});

test("context core - lineage and refused/security evidence exceed soft limits intact", () => {
  const lineage = Array.from({ length: 125 }, (_, index) => ({
    executionId: `exec-${index}`,
    logicalAttempt: index + 1,
    role: "initial" as const,
    predecessorExecutionId: index === 0 ? null : `exec-${index - 1}`,
    model: "gpt-5.6-luna",
    effort: "high",
    startedAt: `2026-08-27T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    terminationKind: "completed" as const,
    verdict: "FAILED" as const,
  }));
  const longEvidence = `SECURITY_REFUSAL:${"E".repeat(10_000)}`;
  let ctx = createOrchestrationContext({
    objective: "Keep every lineage entry and refusal.",
    acceptanceCriteria: ["No protected evidence is capped."],
    lineage,
  });
  ctx = ingestDelegationTurn(ctx, {
    input: mockCleanTaskInput(),
    output: mockFailedTaskOutput({
      attempts: [],
      verification: [
        {
          command: "unsafe verifier",
          source: "orchestrator",
          execution: "rejected",
          exitCode: null,
          passed: false,
          output: longEvidence,
        },
      ],
      scopeViolations: ["Security boundary refused an escaped path."],
    }),
  });

  const compacted = compactContext(ctx, { maxTurnsCount: 0 });
  assert.equal(compacted.lineage.length, 125);
  assert.equal(compacted.turns.length, 1);
  assert.equal(compacted.turns[0]?.authoritativeVerification.refused, 1);
  assert.equal(compacted.turns[0]?.verificationDetails[0]?.output, longEvidence);
  assert.equal(compacted.stats.protectedTurnsOverLimit, true);
});

test("context core - latest routing decision is retained without fabricating PASS", () => {
  let ctx = createOrchestrationContext({
    objective: "Retain routing state.",
    acceptanceCriteria: ["Routing is not execution."],
  });
  ctx = ingestRoutingPreflightTurn(ctx, {
    card: {
      seams: ["context core"],
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
    route: "delegation-plausible",
    signals: ["one isolated seam"],
  });

  const compacted = compactContext(ctx, { maxTurnsCount: 0 });
  assert.equal(compacted.turns.length, 1);
  assert.equal(compacted.turns[0]?.verdict, "NOT_EXECUTED");
  assert.equal(compacted.turns[0]?.routing?.route, "delegation-plausible");
  assert.deepEqual(compacted.turns[0]?.routing?.card.seams, ["context core"]);
});

test("context core - clean batch retains review facts while omitting only passed output", () => {
  const taskInput = mockCleanTaskInput();
  const taskOutput = mockCleanTaskOutput({
    continuationReference: null,
    continuationState: { status: "unavailable", reason: "None." },
  });
  const input: DelegateTasksInput = {
    mode: "sequential",
    resultDetail: "handoff",
    tasks: [taskInput],
    allowOverlappingScopes: false,
    integrate: true,
    automaticRecovery: true,
  };
  const output: BatchOutput = {
    batchId: "batch-clean",
    mode: "sequential",
    maxParallel: 1,
    taskCount: 1,
    passed: 1,
    failed: 0,
    durationSeconds: 65,
    tasks: [
      {
        taskId: "t1",
        state: "completed",
        objective: taskInput.objective,
        effort: taskInput.effort,
        effortReason: taskInput.effortReason,
        result: taskOutput,
        changedFiles: taskOutput.filesChanged.map((file) => file.path),
        worktreePath: null,
        error: null,
        warnings: [],
      },
    ],
    scopeConflicts: [],
    integrationConflicts: [],
    integrated: true,
    integrationSummary: "Integrated one verified task.",
    integrationVerification: [
      {
        command: "npm test",
        source: "orchestrator",
        execution: "argv",
        exitCode: 0,
        passed: true,
        output: "all tests passed",
      },
    ],
    completionState: "verified-complete",
    warnings: [],
    reviewChecklist: [
      "Final workspace verification passed 1 declared check(s). Do not routinely reread worker-owned files or rerun those checks; reopen reasoning only for an architectural or listed risk.",
      "Judge whether the changes are high-risk or architecturally significant, and read the diff if they are. Verified mechanical checks do not make them good.",
    ],
  };
  let ctx = createOrchestrationContext({
    objective: "Compact a clean batch.",
    acceptanceCriteria: ["Retain review facts."],
  });
  ctx = ingestBatchTurn(ctx, { input, output });

  const turn = compactContext(ctx).turns[0]!;
  assert.equal(turn.isClean, true);
  assert.equal(turn.verdict, "PASS");
  assert.deepEqual(turn.authoritativeVerification, {
    executed: 3,
    passed: 3,
    failed: 0,
    refused: 0,
  });
  assert.deepEqual(
    turn.filesChanged.map((file) => file.path),
    ["src/context.ts", "src/context.test.ts"],
  );
  assert.ok(
    turn.verificationDetails.every(
      (item) => item.output === "" && item.outputDisposition === "omitted-clean-pass",
    ),
  );
  assert.deepEqual(turn.batchTasks?.[0]?.risks, ["No breaking changes."]);
  assert.equal(turn.batchOutcome?.completionState, "verified-complete");
});

// ============================================================================
// P1.3B Context Pressure and Trigger Policy Tests
// ============================================================================

function mockCleanCompletedOutput(
  overrides: Partial<DelegateTaskOutput> = {},
): DelegateTaskOutput {
  return mockCleanTaskOutput({
    continuationReference: null,
    continuationState: {
      status: "not-eligible",
      reason: "Completed task has no active continuation.",
    },
    ...overrides,
  });
}

const DEFAULT_PRESSURE_CONFIG = resolveContextPressureConfig();

const pressureOptions = (
  config: ContextPressurePolicyConfig = {},
  boundary: "manual" | "post-delegation" | "in-flight" = "manual",
  force = false,
) => ({
  boundary,
  config: resolveContextPressureConfig(config),
  ...(force ? { force: true } : {}),
});

test("context pressure - below-threshold no-op", () => {
  const input = mockCleanTaskInput();
  const output = mockCleanCompletedOutput();
  let ctx = createOrchestrationContext({
    objective: "Implement a small feature.",
    acceptanceCriteria: ["Feature works."],
  });
  ctx = ingestDelegationTurn(ctx, { input, output, taskId: "t1" });

  const evalPost = evaluateContextPressure(ctx, pressureOptions({}, "post-delegation"));
  assert.equal(evalPost.decision, "noop");
  assert.equal(evalPost.primaryReason, "noop:below-thresholds");
  assert.equal(evalPost.safeBoundary, true);
  assert.equal(evalPost.boundary, "post-delegation");
  assert.equal(evalPost.cooldownRemaining, 0);
  assert.ok(evalPost.reasonDetails.includes("below all pressure thresholds"));

  const emptyCtx = createOrchestrationContext({
    objective: "Empty context.",
    acceptanceCriteria: [],
  });
  const evalEmpty = evaluateContextPressure(emptyCtx, pressureOptions());
  assert.equal(evalEmpty.decision, "noop");
  assert.equal(evalEmpty.primaryReason, "noop:empty-context");
  assert.ok(evalEmpty.reasonDetails.includes("contains no turns"));

  const maybeResult = maybeCompactContext(ctx, pressureOptions({}, "post-delegation"));
  assert.equal(maybeResult.compacted, false);
  assert.equal(maybeResult.context, ctx);
  assert.equal(maybeResult.evaluation.decision, "noop");
});

test("context pressure - above-threshold trigger for size and turns", () => {
  const input = mockCleanTaskInput();
  const output = mockCleanCompletedOutput();
  let ctx = createOrchestrationContext({
    objective: "Large feature context.",
    acceptanceCriteria: ["Criteria 1", "Criteria 2"],
  });
  ctx = ingestDelegationTurn(ctx, { input, output, taskId: "t1" });
  ctx = ingestDelegationTurn(ctx, { input, output, taskId: "t2" });

  const metrics = calculateContextPressureMetrics(ctx);
  assert.ok(metrics.totalSizeBytes > 2000);
  assert.ok(metrics.estimatedReclaimableBytes > 500);

  // Trigger on size pressure
  const evalSize = evaluateContextPressure(ctx, {
    boundary: "manual",
    config: { ...DEFAULT_PRESSURE_CONFIG, maxSizeBytes: 2000, minReclaimableBytes: 500 },
  });
  assert.equal(evalSize.decision, "trigger");
  assert.equal(evalSize.primaryReason, "trigger:size-pressure-exceeded");
  assert.ok(evalSize.contributingReasons.includes("trigger:size-pressure-exceeded"));
  assert.ok(evalSize.reasonDetails.includes("reached threshold"));

  // Trigger on total turns count
  const evalTurns = evaluateContextPressure(ctx, {
    boundary: "manual",
    config: {
      ...DEFAULT_PRESSURE_CONFIG,
      maxTotalTurns: 2,
      maxSizeBytes: 1_000_000,
      minReclaimableBytes: 500,
    },
  });
  assert.equal(evalTurns.decision, "trigger");
  assert.equal(evalTurns.primaryReason, "trigger:total-turns-exceeded");

  // Trigger on reclaimable ratio
  const evalRatio = evaluateContextPressure(ctx, {
    boundary: "manual",
    config: {
      ...DEFAULT_PRESSURE_CONFIG,
      reclaimableRatioThreshold: 0.05,
      maxSizeBytes: 1_000_000,
      maxTotalTurns: 100,
      minReclaimableBytes: 500,
    },
  });
  assert.equal(evalRatio.decision, "trigger");
  assert.equal(evalRatio.primaryReason, "trigger:high-reclaimable-ratio");

  // maybeCompactContext executes compaction on trigger
  const maybeCompacted = maybeCompactContext(ctx, {
    boundary: "manual",
    config: { ...DEFAULT_PRESSURE_CONFIG, maxSizeBytes: 2000, minReclaimableBytes: 500 },
  });
  assert.equal(maybeCompacted.compacted, true);
  assert.ok("stats" in maybeCompacted.context);
  assert.ok(maybeCompacted.context.stats.compactedSizeBytes < metrics.totalSizeBytes);
});

test("context pressure - stale clean-history accumulation trigger", () => {
  const input = mockCleanTaskInput();
  const output = mockCleanCompletedOutput();
  let ctx = createOrchestrationContext({
    objective: "Multi-step clean progression.",
    acceptanceCriteria: ["Step 1", "Step 2", "Step 3", "Step 4", "Step 5"],
  });

  for (let i = 1; i <= 5; i++) {
    ctx = ingestDelegationTurn(ctx, { input, output, taskId: `task_${i}` });
  }

  const metrics = calculateContextPressureMetrics(ctx);
  assert.equal(metrics.cleanTurns, 5);
  assert.equal(metrics.totalTurns, 5);

  const evalStale = evaluateContextPressure(ctx, {
    boundary: "manual",
    config: {
      ...DEFAULT_PRESSURE_CONFIG,
      maxCleanTurns: 4,
      maxSizeBytes: 1_000_000,
      maxTotalTurns: 100,
      minReclaimableBytes: 500,
    },
  });
  assert.equal(evalStale.decision, "trigger");
  assert.equal(evalStale.primaryReason, "trigger:stale-clean-history-accumulated");
  assert.ok(
    evalStale.contributingReasons.includes("trigger:stale-clean-history-accumulated"),
  );
  assert.ok(evalStale.reasonDetails.includes("accumulated 5 clean turns"));
});

test("context pressure - repeated tool and result overhead trigger", () => {
  const input = mockCleanTaskInput();
  const output = mockCleanCompletedOutput();
  let ctx = createOrchestrationContext({
    objective: "Handle polling and tool activity.",
    acceptanceCriteria: ["Polled appropriately."],
  });
  ctx = ingestDelegationTurn(ctx, { input, output, taskId: "t1" });
  ctx = ingestStatusNarrationTurn(ctx, "Worker started background processing...");
  ctx = ingestStatusNarrationTurn(ctx, "Still running test suite (30s elapsed)...");
  ctx = ingestStatusNarrationTurn(ctx, "Still running test suite (60s elapsed)...");
  ctx = ingestToolProseTurn(ctx, "mcp_runner", "Tool invocation output verbose prose...");

  const metrics = calculateContextPressureMetrics(ctx);
  assert.equal(metrics.statusNarrationTurns, 3);
  assert.equal(metrics.toolProseTurns, 1);
  assert.equal(metrics.repeatedToolTurns, 4);
  assert.ok(metrics.toolOverheadBytes > 0);
  const withoutRepeatedTurns = {
    ...ctx,
    turns: ctx.turns.filter(
      (turn) => turn.kind !== "status-narration" && turn.kind !== "tool-prose",
    ),
  };
  assert.equal(
    metrics.toolOverheadBytes,
    new TextEncoder().encode(JSON.stringify(ctx)).byteLength -
      new TextEncoder().encode(JSON.stringify(withoutRepeatedTurns)).byteLength,
  );

  // Trigger when repeated tool turns exceed threshold
  const evalOverheadTurns = evaluateContextPressure(ctx, {
    boundary: "manual",
    config: {
      ...DEFAULT_PRESSURE_CONFIG,
      maxToolOverheadTurns: 3,
      maxSizeBytes: 1_000_000,
      maxTotalTurns: 100,
      maxCleanTurns: 100,
      minReclaimableBytes: 100,
    },
  });
  assert.equal(evalOverheadTurns.decision, "trigger");
  assert.equal(
    evalOverheadTurns.primaryReason,
    "trigger:repeated-tool-overhead-exceeded",
  );

  // Trigger when tool overhead bytes exceed threshold
  const evalOverheadBytes = evaluateContextPressure(ctx, {
    boundary: "manual",
    config: {
      ...DEFAULT_PRESSURE_CONFIG,
      maxToolOverheadBytes: 200,
      maxToolOverheadTurns: 100,
      maxSizeBytes: 1_000_000,
      maxTotalTurns: 100,
      maxCleanTurns: 100,
      minReclaimableBytes: 100,
    },
  });
  assert.equal(evalOverheadBytes.decision, "trigger");
  assert.equal(
    evalOverheadBytes.primaryReason,
    "trigger:repeated-tool-overhead-exceeded",
  );
});

test("context pressure - active references and protected evidence survive compaction", () => {
  // Scenario A: Active issued next-action handoff reference
  const failedHandoffOutput = mockFailedTaskOutput({
    handoffReference: "hdf_active_retry_12345678901234567890123456789012",
    handoffState: {
      status: "issued",
      reason: "One bounded next-action handoff issued for retry.",
    },
  });
  let ctxA = createOrchestrationContext({
    objective: "Task with pending retry handoff.",
    acceptanceCriteria: ["Criteria"],
  });
  ctxA = ingestDelegationTurn(ctxA, {
    input: mockCleanTaskInput(),
    output: failedHandoffOutput,
    taskId: "t1",
  });

  const evalA = evaluateContextPressure(
    ctxA,
    pressureOptions({ maxSizeBytes: 100, minReclaimableBytes: 50 }),
  );
  assert.equal(evalA.decision, "trigger");
  assert.ok(evalA.metrics.activeHandoffsCount > 0);
  assert.doesNotMatch(JSON.stringify(evalA), /hdf_active_retry_/);
  const compactedA = compactContext(ctxA);
  assert.equal(compactedA.activeHandoffs.length, 1);
  assert.equal(
    compactedA.turns[0]?.contract?.objective,
    ctxA.turns[0]?.kind === "single-delegation"
      ? ctxA.turns[0].input.objective
      : undefined,
  );

  // Scenario B: Active issued continuation reference
  const continuationOutput = mockCleanTaskOutput({
    continuationReference: "ctr_active_12345678901234567890123456789012",
    continuationState: {
      status: "issued",
      reason: "One continuation turn available.",
    },
  });
  let ctxB = createOrchestrationContext({
    objective: "Task with pending continuation.",
    acceptanceCriteria: ["Criteria"],
  });
  ctxB = ingestDelegationTurn(ctxB, {
    input: mockCleanTaskInput(),
    output: continuationOutput,
    taskId: "t1",
  });

  const evalB = evaluateContextPressure(
    ctxB,
    pressureOptions({ maxSizeBytes: 100, minReclaimableBytes: 50 }),
  );
  assert.equal(evalB.decision, "trigger");
  assert.ok(evalB.metrics.activeContinuationsCount > 0);
  assert.doesNotMatch(JSON.stringify(evalB), /ctr_active_/);
  assert.equal(compactContext(ctxB).activeContinuations.length, 1);

  // Scenario B2: Consumed continuation reference unblocks compaction
  ctxB = ingestContinuationTurn(ctxB, {
    continuationReference: "ctr_active_12345678901234567890123456789012",
    instruction: "Follow up.",
    output: mockCleanCompletedOutput(),
    taskId: "t1",
  });
  const evalBConsumed = evaluateContextPressure(
    ctxB,
    pressureOptions({ maxSizeBytes: 100, minReclaimableBytes: 50 }),
  );
  assert.equal(evalBConsumed.decision, "trigger");
  assert.equal(evalBConsumed.primaryReason, "trigger:size-pressure-exceeded");
  assert.equal(evalBConsumed.metrics.activeContinuationsCount, 0);

  // Scenario C: Active unresolved security / scope violation blocker
  let ctxC = createOrchestrationContext({
    objective: "Task with security violation.",
    acceptanceCriteria: ["Criteria"],
  });
  ctxC = ingestDelegationTurn(ctxC, {
    input: mockCleanTaskInput(),
    output: mockCleanCompletedOutput(),
    taskId: "t1",
  });
  ctxC = recordBlocker(ctxC, {
    kind: "scope-violation",
    description: "Observed edit outside allowedFiles in src/secret.ts",
    resolved: false,
    failureClassification: "security-or-trust-boundary",
  });

  const evalC = evaluateContextPressure(
    ctxC,
    pressureOptions({ maxSizeBytes: 100, minReclaimableBytes: 50 }),
  );
  assert.equal(evalC.decision, "trigger");
  assert.ok(evalC.metrics.activeSecurityBlockersCount > 0);
  assert.equal(
    compactContext(ctxC).blockers[0]?.description,
    ctxC.blockers[0]?.description,
  );

  // Resolve blocker -> security block clears
  const blockerId = ctxC.blockers[ctxC.blockers.length - 1]!.id;
  const ctxCResolved = resolveBlocker(ctxC, blockerId);
  const evalCResolved = evaluateContextPressure(
    ctxCResolved,
    pressureOptions({ maxSizeBytes: 100, minReclaimableBytes: 50 }),
  );
  assert.equal(evalCResolved.decision, "trigger");
  assert.equal(evalCResolved.primaryReason, "trigger:size-pressure-exceeded");

  // Scenario D: Unsafe lifecycle boundary
  const evalUnsafe = evaluateContextPressure(
    ctxA,
    pressureOptions({ maxSizeBytes: 100, minReclaimableBytes: 50 }, "in-flight"),
  );
  assert.equal(evalUnsafe.decision, "block");
  assert.equal(evalUnsafe.primaryReason, "block:unsafe-lifecycle-boundary");
  assert.equal(evalUnsafe.safeBoundary, false);
  assert.equal(isSafeLifecycleBoundary("in-flight"), false);
  assert.equal(isSafeLifecycleBoundary("post-delegation"), true);
});

test("context pressure - hysteresis and cooldown prevent thrashing", () => {
  const input = mockCleanTaskInput();
  const output = mockCleanCompletedOutput();
  let ctx = createOrchestrationContext({
    objective: "Cooldown test.",
    acceptanceCriteria: ["Tested."],
  });
  for (let i = 1; i <= 5; i++) {
    ctx = ingestDelegationTurn(ctx, { input, output, taskId: `t${i}` });
  }

  const first = maybeCompactContext(
    ctx,
    pressureOptions({ cooldownTurns: 3, maxSizeBytes: 100, minReclaimableBytes: 50 }),
  );
  assert.equal(first.compacted, true);
  ctx = ingestDelegationTurn(first.authoritativeContext, {
    input,
    output,
    taskId: "t6",
  });

  // One authoritative turn after compaction leaves two cooldown turns.
  const evalCooldown = evaluateContextPressure(
    ctx,
    pressureOptions({ cooldownTurns: 3, maxSizeBytes: 100, minReclaimableBytes: 50 }),
  );
  assert.equal(evalCooldown.decision, "block");
  assert.equal(evalCooldown.primaryReason, "block:cooldown-active");
  assert.equal(evalCooldown.cooldownRemaining, 2);
  assert.ok(evalCooldown.reasonDetails.includes("2 turn(s) remaining"));

  ctx = ingestDelegationTurn(ctx, { input, output, taskId: "t7" });
  ctx = ingestDelegationTurn(ctx, { input, output, taskId: "t8" });
  const evalExpired = evaluateContextPressure(
    ctx,
    pressureOptions({ cooldownTurns: 3, maxSizeBytes: 100, minReclaimableBytes: 50 }),
  );
  assert.equal(evalExpired.decision, "trigger");
  assert.equal(evalExpired.primaryReason, "trigger:size-pressure-exceeded");
  assert.equal(evalExpired.cooldownRemaining, 0);

  // Manual force cannot bypass authoritative cooldown state.
  const evalForced = evaluateContextPressure(
    ingestDelegationTurn(first.authoritativeContext, {
      input,
      output,
      taskId: "forced-t6",
    }),
    pressureOptions({ cooldownTurns: 3 }, "manual", true),
  );
  assert.equal(evalForced.decision, "block");
  assert.equal(evalForced.primaryReason, "block:cooldown-active");
});

test("context pressure - idempotent handling of already-compacted context", () => {
  const input = mockCleanTaskInput();
  const output = mockCleanCompletedOutput();
  let ctx = createOrchestrationContext({
    objective: "Compacted context idempotence.",
    acceptanceCriteria: ["Criterion 1"],
  });
  ctx = ingestDelegationTurn(ctx, { input, output, taskId: "t1" });
  ctx = ingestDelegationTurn(ctx, { input, output, taskId: "t2" });

  const first = maybeCompactContext(
    ctx,
    pressureOptions({ maxSizeBytes: 10, minReclaimableBytes: 1 }),
  );
  assert.equal(first.compacted, true);
  const evalCompacted = evaluateContextPressure(
    first.authoritativeContext,
    pressureOptions({ maxSizeBytes: 10, minReclaimableBytes: 1 }),
  );
  assert.equal(evalCompacted.decision, "block");
  assert.equal(evalCompacted.primaryReason, "block:already-compacted");
  assert.ok(evalCompacted.reasonDetails.includes("no authoritative turns"));

  const evalCompactedForced = evaluateContextPressure(
    first.authoritativeContext,
    pressureOptions({}, "manual", true),
  );
  assert.equal(evalCompactedForced.decision, "block");
  assert.equal(evalCompactedForced.primaryReason, "block:already-compacted");

  // New authoritative context makes the context eligible again; the cooldown,
  // rather than structural compacted detection, governs when it may run.
  const accumulated = ingestDelegationTurn(first.authoritativeContext, {
    input,
    output,
    taskId: "t3",
  });
  const afterNewTurn = evaluateContextPressure(
    accumulated,
    pressureOptions({ cooldownTurns: 0, maxSizeBytes: 10, minReclaimableBytes: 1 }),
  );
  assert.equal(afterNewTurn.decision, "trigger");
});

test("context pressure - explicit reason codes and descriptive details", () => {
  // Test config resolver defaults and overrides
  const defaultConfig = resolveContextPressureConfig();
  assert.equal(defaultConfig.maxTotalTurns, 20);
  assert.equal(defaultConfig.maxCleanTurns, 5);
  assert.equal(defaultConfig.cooldownTurns, 2);

  const customConfig = resolveContextPressureConfig({
    maxSizeBytes: 80_000,
    maxTotalTurns: 40,
    maxCleanTurns: 10,
    cooldownTurns: 5,
  });
  assert.equal(customConfig.maxSizeBytes, 80_000);
  assert.equal(customConfig.maxTotalTurns, 40);
  assert.equal(customConfig.maxCleanTurns, 10);
  assert.equal(customConfig.cooldownTurns, 5);
  assert.throws(
    () => resolveContextPressureConfig({ maxSizeBytes: Number.NaN }),
    /maxSizeBytes/,
  );
  assert.throws(
    () => resolveContextPressureConfig({ maxTotalTurns: 1.5 }),
    /maxTotalTurns/,
  );
  assert.throws(
    () => resolveContextPressureConfig({ reclaimableRatioThreshold: 0 }),
    /reclaimableRatioThreshold/,
  );
  assert.throws(
    () =>
      evaluateContextPressure(
        createOrchestrationContext({
          objective: "Invalid config.",
          acceptanceCriteria: [],
        }),
        {
          boundary: "manual",
          config: {
            ...DEFAULT_PRESSURE_CONFIG,
            maxSizeBytes: Number.NaN,
          },
        },
      ),
    /maxSizeBytes/,
  );
  assert.throws(
    () => parseContextPositiveInteger("SOL_LUNA_CONTEXT_MAX_BYTES", "NaN", 50_000),
    /SOL_LUNA_CONTEXT_MAX_BYTES/,
  );
  assert.throws(
    () => parseContextNonNegativeInteger("SOL_LUNA_CONTEXT_COOLDOWN_TURNS", "-1", 2),
    /SOL_LUNA_CONTEXT_COOLDOWN_TURNS/,
  );

  // Insufficient reclaimable gain
  let ctx = createOrchestrationContext({
    objective: "Small gain context.",
    acceptanceCriteria: ["Small"],
  });
  ctx = ingestRoutingPreflightTurn(ctx, {
    card: {
      seams: ["s1"],
      seamSize: "small",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
    route: "solo",
  });
  const evalSmallGain = evaluateContextPressure(
    ctx,
    pressureOptions({ maxSizeBytes: 10, minReclaimableBytes: 50_000 }),
  );
  assert.equal(evalSmallGain.decision, "block");
  assert.equal(evalSmallGain.primaryReason, "block:insufficient-reclaimable-gain");
  assert.ok(evalSmallGain.reasonDetails.includes("below minimum threshold"));
});

test("context pressure - deterministic size accounting and factual token reporting", () => {
  const input = mockCleanTaskInput();
  const output = mockCleanCompletedOutput();
  let ctx = createOrchestrationContext({
    objective: "Deterministic size accounting test.",
    acceptanceCriteria: ["Accurate metrics."],
    decisions: [{ id: "dec_1", kind: "architectural", summary: "Use pure functions." }],
    constraints: [
      { id: "cst_1", kind: "scope", description: "Stay in src/", active: true },
    ],
  });
  ctx = ingestDelegationTurn(ctx, { input, output, taskId: "t1" });

  const metrics = calculateContextPressureMetrics(ctx);
  assert.equal(metrics.decisionsCount, 1);
  assert.equal(metrics.constraintsCount, 1);
  assert.equal(metrics.totalTurns, 1);
  assert.equal(metrics.cleanTurns, 1);
  assert.equal(metrics.diagnosticTurns, 0);
  assert.ok(metrics.totalSizeBytes > 0);
  assert.ok(metrics.estimatedReclaimableBytes >= 0);
  const projection = compactContext(ctx);
  assert.equal(
    metrics.estimatedReclaimableBytes,
    Math.max(0, metrics.totalSizeBytes - projection.stats.compactedSizeBytes),
  );

  // Factual token usage accounting
  assert.ok(metrics.reportedTokens !== undefined);
  assert.equal(metrics.reportedTokens?.isAuthoritative, true);
  assert.equal(metrics.reportedTokens?.inputTokens, 500);
  assert.equal(metrics.reportedTokens?.cachedInputTokens, 100);
  assert.equal(metrics.reportedTokens?.outputTokens, 200);
  assert.equal(metrics.reportedTokens?.reasoningOutputTokens, 50);
  assert.equal(metrics.reportedTokens?.totalTokens, 700);

  // Exact provider semantics: cached input is included in input, reasoning is
  // included in output, and neither is added again to the total.
  assert.equal(
    metrics.reportedTokens?.totalTokens,
    metrics.reportedTokens!.inputTokens + metrics.reportedTokens!.outputTokens,
  );

  const unavailableOutput = mockCleanCompletedOutput({
    usage: null,
    attempts: [
      ...output.attempts!,
      {
        ...output.attempts![0]!,
        executionId: "exec_unknown_2",
        logicalAttempt: 2,
        usage: { status: "unavailable", reason: "turn-failed" },
      },
    ],
  });
  const unknownMetrics = calculateContextPressureMetrics(
    ingestDelegationTurn(
      createOrchestrationContext({ objective: "Unknown usage.", acceptanceCriteria: [] }),
      { input, output: unavailableOutput },
    ),
  );
  assert.equal(unknownMetrics.reportedTokens, undefined);

  const historicalOutput = mockCleanCompletedOutput({
    attempts: undefined,
    usage: {
      inputTokens: 10,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 3,
      outputTokens: 6,
      reasoningOutputTokens: 2,
    },
  });
  const historicalMetrics = calculateContextPressureMetrics(
    ingestDelegationTurn(
      createOrchestrationContext({
        objective: "Historical usage.",
        acceptanceCriteria: [],
      }),
      { input, output: historicalOutput },
    ),
  );
  assert.equal(historicalMetrics.reportedTokens?.totalTokens, 16);
  assert.equal(historicalMetrics.reportedTokens?.cacheWriteInputTokens, 3);

  // Context without usage reports undefined tokens rather than guessing
  const ctxNoUsage = createOrchestrationContext({
    objective: "No usage data.",
    acceptanceCriteria: [],
  });
  const metricsNoUsage = calculateContextPressureMetrics(ctxNoUsage);
  assert.equal(metricsNoUsage.reportedTokens, undefined);
});

test("context pressure - exact thresholds and simultaneous signals are deterministic", () => {
  let ctx = createOrchestrationContext({
    objective: "Boundary behavior.",
    acceptanceCriteria: ["Exact thresholds trigger."],
  });
  for (let index = 0; index < 10; index++) {
    ctx = ingestStatusNarrationTurn(ctx, `discard me ${index} ${"x".repeat(2_000)}`);
  }
  const metrics = calculateContextPressureMetrics(ctx);
  const evaluation = evaluateContextPressure(ctx, {
    boundary: "manual",
    config: resolveContextPressureConfig({
      maxSizeBytes: metrics.totalSizeBytes,
      maxTotalTurns: metrics.totalTurns,
      maxCleanTurns: 100,
      maxToolOverheadTurns: metrics.repeatedToolTurns,
      maxToolOverheadBytes: metrics.toolOverheadBytes,
      reclaimableRatioThreshold: metrics.reclaimableRatio,
      minReclaimableBytes: 1,
    }),
  });
  assert.equal(evaluation.decision, "trigger");
  assert.equal(evaluation.primaryReason, "trigger:size-pressure-exceeded");
  assert.deepEqual(evaluation.contributingReasons.slice(0, 3), [
    "trigger:size-pressure-exceeded",
    "trigger:total-turns-exceeded",
    "trigger:repeated-tool-overhead-exceeded",
  ]);

  const forcedUnsafe = evaluateContextPressure(ctx, {
    boundary: "in-flight",
    force: true,
    config: resolveContextPressureConfig({ minReclaimableBytes: 1_000_000 }),
  });
  assert.equal(forcedUnsafe.decision, "block");
  assert.equal(forcedUnsafe.primaryReason, "block:unsafe-lifecycle-boundary");
  assert.deepEqual(forcedUnsafe.contributingReasons, [
    "block:unsafe-lifecycle-boundary",
    "block:insufficient-reclaimable-gain",
  ]);
});
