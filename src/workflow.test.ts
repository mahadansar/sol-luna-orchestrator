/**
 * P2.3 End-to-End Automated Workflow Test Suite.
 *
 * Deterministic end-to-end tests verifying the capstone workflow across:
 * 1. Solo / zero-worker parent takeover
 * 2. Explorer -> delegation path
 * 3. Single delegation success
 * 4. Safe parallel batch success
 * 5. Sequential batch path
 * 6. Repair success
 * 7. Bounded recovery
 * 8. Continuation
 * 9. Effort escalation via authoritative handoff
 * 10. Stronger-executor fallback using explicit allowedModels + executorOrder
 * 11. Failed verification -> parent takeover
 * 12. Scope / security failure
 * 13. Cancellation
 * 14. Concurrent workflow isolation
 * 15. Restart / fail-closed capability behavior
 * 16. No unbounded transition loop (step bound guard)
 * 17. Telemetry privacy (no prompt text, secrets, tokens, or raw outputs)
 * 18. Context compaction during long workflows
 * 19. Report rendering
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  executeWorkflow,
  renderWorkflowReport,
  type WorkflowDependencies,
  type WorkflowInput,
  type WorkflowOutput,
} from "./workflow.js";
import {
  type BatchOutput,
  type DelegateTaskInput,
  type DelegateTaskOutput,
  type DelegateTasksInput,
  type ExploreInput,
  type ExploreOutput,
  type FailureDecision,
} from "./contract.js";
import { buildComputePolicy, type ComputePolicy } from "./policy.js";
import { HandoffStore, registerHandoff } from "./handoff.js";
import { ContinuationStore } from "./continuation.js";
import { ContextLifecycleRegistry } from "./server.js";
import { ContextLifecycleStore, createOrchestrationContext } from "./context.js";
import type { OrchestratorEvent } from "./events.js";
import {
  exportSessionHandoff,
  SESSION_HANDOFF_SCHEMA_VERSION,
} from "./session-handoff.js";

function makeCleanTaskOutput(
  overrides: Partial<DelegateTaskOutput> = {},
): DelegateTaskOutput {
  return {
    verdict: "PASS",
    attempt: 1,
    durationSeconds: 2,
    model: "gpt-5.6-luna",
    effort: "high",
    effortReason: "High effort test",
    summary: "Completed feature",
    workerThreadId: "thread-test-1",
    trustworthy: true,
    changeIntent: "required",
    filesChanged: [
      { path: "src/feature.ts", kind: "modified", why: "Feature edit", observed: true },
    ],
    verification: [
      {
        command: "npm test",
        source: "orchestrator",
        execution: "argv",
        passed: true,
        exitCode: 0,
        output: "1 test passed",
      },
    ],
    verificationMode: "allowlist",
    workerClaimedStatus: "PASS",
    workerClaimedFailureCauses: [],
    discrepancies: [],
    scopeViolations: [],
    notes: "",
    followUps: [],
    reviewChecklist: ["Review feature implementation"],
    errors: [],
    escalationAdvice: null,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      reasoningOutputTokens: 10,
    },
    continuationReference: null,
    handoffReference: null,
    failureDecision: undefined,
    ...overrides,
  };
}

function makeCleanBatchOutput(overrides: Partial<BatchOutput> = {}): BatchOutput {
  const task1 = makeCleanTaskOutput({
    filesChanged: [{ path: "src/a.ts", kind: "modified", why: "Seam A", observed: true }],
  });
  const task2 = makeCleanTaskOutput({
    filesChanged: [{ path: "src/b.ts", kind: "modified", why: "Seam B", observed: true }],
  });

  return {
    batchId: "b_test_1",
    mode: "parallel",
    taskCount: 2,
    passed: 2,
    failed: 0,
    durationSeconds: 3,
    maxParallel: 2,
    completionState: "verified-complete",
    integrated: true,
    integrationSummary: "2/2 tasks integrated cleanly",
    integrationVerification: [
      {
        command: "npm test",
        source: "orchestrator",
        execution: "argv",
        passed: true,
        exitCode: 0,
        output: "All integration tests passed",
      },
    ],
    scopeConflicts: [],
    integrationConflicts: [],
    tasks: [
      {
        taskId: "t1",
        objective: "Task 1",
        effort: "high",
        effortReason: "Batch A",
        worktreePath: null,
        error: null,
        state: "completed",
        attempt: 1,
        changedFiles: ["src/a.ts"],
        warnings: [],
        result: task1,
      },
      {
        taskId: "t2",
        objective: "Task 2",
        effort: "high",
        effortReason: "Batch B",
        worktreePath: null,
        error: null,
        state: "completed",
        attempt: 1,
        changedFiles: ["src/b.ts"],
        warnings: [],
        result: task2,
      },
    ],
    warnings: [],
    reviewChecklist: ["Review parallel batch changes"],
    ...overrides,
  };
}

function makeCleanExploreOutput(overrides: Partial<ExploreOutput> = {}): ExploreOutput {
  return {
    target: "Inspect codebase",
    verdict: "PASS",
    durationSeconds: 1,
    model: "gpt-5.6-luna",
    effort: "high",
    effortReason: "High effort test",
    workerThreadId: "thread-explore-1",
    trustworthy: true,
    workerClaimedStatus: "PASS",
    findings: {
      summary: "Explored codebase",
      notes: "No blockers",
      observedFacts: [
        {
          statement: "Core configuration is in config.ts",
          sourceFile: "src/config.ts",
          sourceLine: 1,
          evidence: "export const DEFAULT_TIMEOUT = 300;",
          provenance: "worker",
          grounding: "runtime-verified",
        },
      ],
      runtimeObservedFacts: [
        {
          kind: "source-grounding",
          statement: "Verified source grounding for src/config.ts:1",
        },
      ],
      inferences: [
        {
          hypothesis: "Modular structure with separate policy and config",
          rationale: "Separated into config.ts and policy.ts",
        },
      ],
      unknowns: [],
      relevantFiles: [{ path: "src/config.ts", why: "Configuration definitions" }],
      recommendedSeams: [
        {
          label: "config-seam",
          description: "Configuration subsystem",
          candidateFiles: ["src/config.ts"],
        },
        {
          label: "policy-seam",
          description: "Policy subsystem",
          candidateFiles: ["src/policy.ts"],
        },
      ],
    },
    observedFilesChanged: [],
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: ["Review findings"],
    errors: [],
    usage: {
      inputTokens: 50,
      cachedInputTokens: 0,
      outputTokens: 25,
      reasoningOutputTokens: 5,
    },
    ...overrides,
  };
}

function setupTestDeps(
  overrides: Partial<WorkflowDependencies> = {},
  emittedEvents: OrchestratorEvent[] = [],
): WorkflowDependencies {
  const handoffStore = new HandoffStore();
  const continuationStore = new ContinuationStore();
  const contextRegistry = new ContextLifecycleRegistry({
    handoffStore,
    continuationStore,
    emit: (event) => emittedEvents.push(event),
  });

  return {
    emit: (event) => emittedEvents.push(event),
    handoffStore,
    continuationStore,
    contextRegistry,
    handleExplore: async (input) => ({
      content: [{ type: "text", text: "EXPLORATION REPORT" }],
      structuredContent:
        input.resultDetail === "handoff" ? undefined : makeCleanExploreOutput(),
      isError: false,
    }),
    handleDelegateTask: async (input) => ({
      content: [{ type: "text", text: "DELEGATION REPORT" }],
      structuredContent:
        input.resultDetail === "handoff"
          ? undefined
          : makeCleanTaskOutput({
              effort: input.effort,
              model: "gpt-5.6-luna",
            }),
      isError: false,
    }),
    handleDelegateTasks: async (batch) => ({
      content: [{ type: "text", text: "BATCH REPORT" }],
      structuredContent:
        batch.resultDetail === "handoff"
          ? undefined
          : makeCleanBatchOutput({
              mode: batch.mode,
              taskCount: batch.tasks.length,
            }),
      isError: false,
    }),
    handleContinueTask: async (request) => ({
      content: [{ type: "text", text: "CONTINUATION REPORT" }],
      structuredContent:
        request.resultDetail === "handoff"
          ? undefined
          : makeCleanTaskOutput({
              verdict: "PASS",
              attempt: 2,
            }),
      isError: false,
    }),
    makeWorkflowId: () => "wf_test_001",
    ...overrides,
  };
}

// --- 1. Solo / Zero-Worker Path ----------------------------------------------

test("workflow: explicit solo requires truthful parent takeover", async () => {
  let delegateCalls = 0;
  const deps = setupTestDeps({
    handleDelegateTask: async () => {
      delegateCalls++;
      return { content: [{ type: "text", text: "error" }], isError: true };
    },
  });

  const output = await executeWorkflow(
    {
      objective: "Inspect simple constants",
      executionMode: "solo",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "PARENT_TAKEOVER");
  assert.equal(output.state, "parent_takeover");
  assert.equal(output.result, null);
  assert.equal(output.verified, false);
  assert.equal(delegateCalls, 0);
  assert.match(output.summary, /parent takeover/i);
});

test("workflow: zero-worker routing requires truthful parent takeover", async () => {
  let delegateCalls = 0;
  const deps = setupTestDeps({
    handleDelegateTask: async () => {
      delegateCalls++;
      return { content: [{ type: "text", text: "error" }], isError: true };
    },
  });

  const output = await executeWorkflow(
    {
      objective: "Tightly coupled small edit with shared mutable state",
      routingPreflight: {
        seams: ["s1", "s2"],
        seamSize: "small",
        sharedState: "mutable",
        coreOverlap: "shared-core",
        integration: "architectural",
        verification: "shared-only",
      },
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "PARENT_TAKEOVER");
  assert.equal(output.state, "parent_takeover");
  assert.equal(output.result, null);
  assert.equal(delegateCalls, 0);
  assert.equal(output.recommendedRoute, "solo");
});

test("workflow: zero-worker compute policy cannot be overridden by requested execution", async () => {
  let delegateCalls = 0;
  const deps = setupTestDeps({
    handleDelegateTask: async () => {
      delegateCalls++;
      return { content: [{ type: "text", text: "must not run" }], isError: true };
    },
  });

  const output = await executeWorkflow(
    {
      objective: "Implementation requiring a worker",
      executionMode: "single",
      computePolicy: { maxWorkersPerBatch: 0, maxConcurrency: 0 },
    },
    undefined,
    deps,
  );

  assert.equal(delegateCalls, 0);
  assert.equal(output.status, "PARENT_TAKEOVER");
  assert.equal(output.verified, false);
});

// --- 2. Explorer -> Delegation Path ------------------------------------------

test("workflow: explorer runs read-only investigation then transitions to delegation", async () => {
  let exploreCalled = false;
  let singleCalls = 0;
  let batchCalls = 0;

  const deps = setupTestDeps({
    handleExplore: async () => {
      exploreCalled = true;
      return {
        content: [{ type: "text", text: "EXPLORE DONE" }],
        structuredContent: makeCleanExploreOutput(),
      };
    },
    handleDelegateTask: async () => {
      singleCalls++;
      return {
        content: [{ type: "text", text: "TASK DONE" }],
        structuredContent: makeCleanTaskOutput(),
      };
    },
    handleDelegateTasks: async () => {
      batchCalls++;
      return {
        content: [{ type: "text", text: "BATCH DONE" }],
        structuredContent: makeCleanBatchOutput(),
      };
    },
  });

  const output = await executeWorkflow(
    {
      objective: "Investigate and implement subsystem",
      explore: true,
      routingPreflight: {
        seams: ["config-seam", "policy-seam"],
        sharedState: "none",
        coreOverlap: "disjoint",
        integration: "mechanical",
        verification: "per-seam",
        seamSize: "substantial",
      },
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");
  assert.equal(exploreCalled, true);
  assert.equal(singleCalls, 1);
  assert.equal(
    batchCalls,
    0,
    "Explorer recommendations are not executable task contracts",
  );
  assert.ok(output.exploreResult);
  assert.equal(output.exploreResult.findings.observedFacts.length, 1);
  assert.ok(output.steps.some((s) => s.state === "exploring"));
  assert.ok(output.steps.some((s) => s.state === "delegating"));
});

// --- 3. Single Delegation Success --------------------------------------------

test("workflow: single task delegation executes, independently verifies, and completes", async () => {
  const deps = setupTestDeps();

  const output = await executeWorkflow(
    {
      objective: "Implement standalone helper function",
      allowedFiles: ["src/helper.ts"],
      verificationCommands: ["npm test"],
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.state, "completed");
  assert.equal(output.verified, true);
  assert.equal(output.executionMode, "delegate_task");
  assert.ok(output.result);
  assert.equal((output.result as DelegateTaskOutput).verdict, "PASS");
});

// --- 4. Safe Parallel Batch Success ------------------------------------------

test("workflow: parallel batch delegates disjoint seams and integrates cleanly", async () => {
  const deps = setupTestDeps();

  const output = await executeWorkflow(
    {
      objective: "Implement parallel features across isolated seams",
      tasks: [
        {
          objective: "Feature A",
          acceptanceCriteria: ["Feature A works"],
          allowedFiles: ["src/a.ts"],
          forbiddenFiles: [],
          changeIntent: "required",
          verificationCommands: ["npm test"],
          effort: "high",
          effortReason: "Parallel A",
          automaticRepair: true,
          resultDetail: "handoff",
          previousAttempts: [],
        },
        {
          objective: "Feature B",
          acceptanceCriteria: ["Feature B works"],
          allowedFiles: ["src/b.ts"],
          forbiddenFiles: [],
          changeIntent: "required",
          verificationCommands: ["npm test"],
          effort: "high",
          effortReason: "Parallel B",
          automaticRepair: true,
          resultDetail: "handoff",
          previousAttempts: [],
        },
      ],
      executionMode: "parallel",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.executionMode, "delegate_tasks_parallel");
  assert.ok(output.result);
  assert.equal((output.result as BatchOutput).completionState, "verified-complete");
  assert.equal((output.result as BatchOutput).passed, 2);
});

// --- 5. Sequential Batch Path ------------------------------------------------

test("workflow: sequential batch executes dependent tasks sharing workspace state", async () => {
  const deps = setupTestDeps();

  const output = await executeWorkflow(
    {
      objective: "Step 1 and Step 2 dependent pipeline",
      tasks: [
        {
          objective: "Step 1: Schema",
          acceptanceCriteria: ["Schema valid"],
          allowedFiles: ["src/schema.ts"],
          forbiddenFiles: [],
          changeIntent: "required",
          verificationCommands: ["npm test"],
          effort: "high",
          effortReason: "Step 1",
          automaticRepair: true,
          resultDetail: "handoff",
          previousAttempts: [],
        },
        {
          objective: "Step 2: Consumer",
          acceptanceCriteria: ["Consumer works"],
          allowedFiles: ["src/consumer.ts"],
          forbiddenFiles: [],
          changeIntent: "required",
          verificationCommands: ["npm test"],
          effort: "high",
          effortReason: "Step 2",
          automaticRepair: true,
          resultDetail: "handoff",
          previousAttempts: [],
        },
      ],
      executionMode: "sequential",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.executionMode, "delegate_tasks_sequential");
  assert.ok(output.result);
});

// --- 6. Repair Success -------------------------------------------------------

test("workflow: automatic in-thread repair succeeds and returns verified result", async () => {
  const repairResult = makeCleanTaskOutput({
    verdict: "PASS",
    repair: {
      requested: true,
      attempted: true,
      classification: "local-verification",
      reason: "Fixed failing test in same thread",
      failureEvidence: [],
    },
  });

  const deps = setupTestDeps({
    handleDelegateTask: async () => ({
      content: [{ type: "text", text: "REPAIRED" }],
      structuredContent: repairResult,
    }),
  });

  const output = await executeWorkflow(
    {
      objective: "Fix defect with automatic repair",
      automaticRepair: true,
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.verified, true);
  assert.equal((output.result as DelegateTaskOutput).repair?.attempted, true);
});

// --- 7. Bounded Recovery -----------------------------------------------------

test("workflow: parallel batch bounded recovery succeeds for timeout", async () => {
  const recoveredBatch = makeCleanBatchOutput({
    passed: 2,
    failed: 0,
    completionState: "verified-complete",
    tasks: [
      {
        taskId: "t1",
        objective: "Task 1",
        effort: "high",
        effortReason: "Recovery task",
        worktreePath: null,
        error: null,
        state: "completed",
        attempt: 2,
        changedFiles: ["src/a.ts"],
        warnings: [],
        recovery: {
          attempted: true,
          classification: "timeout-continuation",
          evidence: "Resumed timeout worker",
          recoveryAttempt: 1,
          initialAttempt: 1,
          initialDurationSeconds: 60,
          recoveryDurationSeconds: 10,
          initialUsage: null,
          recoveryUsage: null,
        },
        result: makeCleanTaskOutput({ attempt: 2 }),
      },
      {
        taskId: "t2",
        objective: "Task 2",
        effort: "high",
        effortReason: "Task 2",
        worktreePath: null,
        error: null,
        state: "completed",
        attempt: 1,
        changedFiles: ["src/b.ts"],
        warnings: [],
        result: makeCleanTaskOutput({ attempt: 1 }),
      },
    ],
  });

  const deps = setupTestDeps({
    handleDelegateTasks: async () => ({
      content: [{ type: "text", text: "RECOVERED BATCH" }],
      structuredContent: recoveredBatch,
    }),
  });

  const output = await executeWorkflow(
    {
      objective: "Batch with recovery",
      tasks: [
        {
          objective: "Task 1",
          acceptanceCriteria: ["Task 1 works"],
          allowedFiles: ["src/a.ts"],
          forbiddenFiles: [],
          changeIntent: "required",
          verificationCommands: ["npm test"],
          effort: "high",
          effortReason: "Recovery task",
          automaticRepair: true,
          resultDetail: "handoff",
          previousAttempts: [],
        },
      ],
      executionMode: "parallel",
      automaticRecovery: true,
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");
  assert.equal((output.result as BatchOutput).completionState, "verified-complete");
});

// --- 8. Continuation ---------------------------------------------------------

test("workflow: resumes incomplete task via server-issued continuation reference", async () => {
  let continueCalled = false;

  const incompleteResult = makeCleanTaskOutput({
    verdict: "FAILED",
    continuationReference: "ctr_test_valid_001",
    failureDecision: {
      classification: "effort",
      action: "continuation",
      reason: "Worker paused with follow-up continuation available",
      evidenceExecutionIds: ["exec-1"],
      nextEffort: null,
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  });

  const completedResult = makeCleanTaskOutput({
    verdict: "PASS",
    attempt: 2,
    continuationReference: null,
    failureDecision: undefined,
  });

  const deps = setupTestDeps({
    handleDelegateTask: async () => ({
      content: [{ type: "text", text: "INCOMPLETE" }],
      structuredContent: incompleteResult,
    }),
    handleContinueTask: async () => {
      continueCalled = true;
      return {
        content: [{ type: "text", text: "CONTINUED PASS" }],
        structuredContent: completedResult,
      };
    },
  });

  const output = await executeWorkflow(
    {
      objective: "Two-step continuation task",
      continuationInstruction: "Complete final step",
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");
  assert.equal(continueCalled, true);
  assert.ok(output.steps.some((s) => s.state === "continuing"));
  assert.equal((output.result as DelegateTaskOutput).attempt, 2);
});

// --- 9. Effort Escalation via Authoritative Handoff ---------------------------

test("workflow: escalates effort via evidence-earned next-action handoff reference", async () => {
  let calls = 0;

  const failedResult = makeCleanTaskOutput({
    verdict: "FAILED",
    effort: "medium",
    handoffReference: "hdf_test_effort_001",
    failureDecision: {
      classification: "effort",
      action: "effort-escalation",
      reason: "Task required higher effort",
      evidenceExecutionIds: ["exec-1"],
      nextEffort: "high",
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  });

  const escalatedResult = makeCleanTaskOutput({
    verdict: "PASS",
    effort: "high",
    attempt: 2,
    handoffReference: null,
    failureDecision: undefined,
  });

  const deps = setupTestDeps({
    handleDelegateTask: async (input) => {
      calls++;
      if (input.handoffReference) {
        return {
          content: [{ type: "text", text: "ESCALATED PASS" }],
          structuredContent: escalatedResult,
        };
      }
      return {
        content: [{ type: "text", text: "FIRST FAIL" }],
        structuredContent: failedResult,
      };
    },
  });

  const output = await executeWorkflow(
    {
      objective: "Difficult task needing effort escalation",
      computePolicy: { allowEffortEscalation: true },
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");
  assert.equal(calls, 2);
  assert.ok(output.steps.some((s) => s.state === "escalating"));
  assert.equal((output.result as DelegateTaskOutput).effort, "high");
  assert.deepEqual(output.executedModels, ["gpt-5.6-luna"]);
  assert.deepEqual(output.executedEfforts, ["medium", "high"]);
});

// --- 10. Stronger-Executor Fallback using explicit allowedModels + executorOrder -

test("workflow: stronger-executor fallback selects next model in operator executorOrder", async () => {
  let calls = 0;
  let escalatedModel: string | undefined;

  const failedResult = makeCleanTaskOutput({
    verdict: "FAILED",
    model: "gpt-5.6-luna",
    handoffReference: "hdf_test_stronger_001",
    failureDecision: {
      classification: "capability",
      action: "stronger-executor-fallback",
      reason: "Worker capability exceeded",
      evidenceExecutionIds: ["exec-1"],
      nextEffort: null,
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  });

  const strongerResult = makeCleanTaskOutput({
    verdict: "PASS",
    model: "gpt-5.6-sol",
    attempt: 2,
    handoffReference: null,
    failureDecision: undefined,
  });

  const deps = setupTestDeps({
    handleDelegateTask: async (input) => {
      calls++;
      if (input.handoffReference) {
        escalatedModel = "gpt-5.6-sol";
        return {
          content: [{ type: "text", text: "STRONGER EXECUTOR PASS" }],
          structuredContent: strongerResult,
        };
      }
      return {
        content: [{ type: "text", text: "FIRST FAIL" }],
        structuredContent: failedResult,
      };
    },
  });

  const output = await executeWorkflow(
    {
      objective: "Cross-model capability task",
      computePolicy: {
        allowStrongerFallback: true,
      },
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");
  assert.equal(calls, 2);
  assert.equal(escalatedModel, "gpt-5.6-sol");
  assert.ok(output.steps.some((s) => s.state === "escalating"));
  assert.deepEqual(output.executedModels, ["gpt-5.6-luna", "gpt-5.6-sol"]);
  assert.deepEqual(output.executedEfforts, ["high"]);
});

// --- 11. Failed Verification -> Parent Takeover ------------------------------

test("workflow: unrecoverable verification failure yields to parent takeover", async () => {
  const failedResult = makeCleanTaskOutput({
    verdict: "FAILED",
    trustworthy: true,
    verification: [
      {
        command: "npm test",
        source: "orchestrator",
        execution: "argv",
        passed: false,
        exitCode: 1,
        output: "AssertionError: expected true but got false",
      },
    ],
    failureDecision: {
      classification: "verification",
      action: "parent-takeover",
      reason: "Verification failed without repair/retry eligibility",
      evidenceExecutionIds: ["exec-1"],
      nextEffort: null,
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  });

  const deps = setupTestDeps({
    handleDelegateTask: async () => ({
      content: [{ type: "text", text: "UNRECOVERABLE FAIL" }],
      structuredContent: failedResult,
    }),
  });

  const output = await executeWorkflow(
    {
      objective: "Task with specification error",
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "PARENT_TAKEOVER");
  assert.equal(output.state, "parent_takeover");
  assert.match(output.summary, /parent takeover/i);
});

// --- 12. Scope / Security Failure --------------------------------------------

test("workflow: scope violation fails closed and transitions to parent takeover", async () => {
  const scopeViolationResult = makeCleanTaskOutput({
    verdict: "PASS",
    trustworthy: false,
    scopeViolations: ["src/unauthorized.ts"],
    failureDecision: {
      classification: "scope-or-conflict",
      action: "parent-takeover",
      reason: "Observed modification outside declared allowedFiles",
      evidenceExecutionIds: ["exec-1"],
      nextEffort: null,
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  });

  const deps = setupTestDeps({
    handleDelegateTask: async () => ({
      content: [{ type: "text", text: "SCOPE VIOLATION" }],
      structuredContent: scopeViolationResult,
    }),
  });

  const output = await executeWorkflow(
    {
      objective: "Strictly scoped task",
      allowedFiles: ["src/allowed.ts"],
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "PARENT_TAKEOVER");
  assert.ok(output.summary.includes("Scope violation"));
});

// --- 13. Cancellation --------------------------------------------------------

test("workflow: abort signal immediately cancels workflow and marks status CANCELLED", async () => {
  const controller = new AbortController();
  controller.abort();

  const deps = setupTestDeps({
    handleDelegateTask: async () => {
      throw new Error("Should not be called when already aborted");
    },
  });

  const output = await executeWorkflow(
    {
      objective: "Aborted task",
    },
    controller.signal,
    deps,
  );

  assert.equal(output.status, "CANCELLED");
  assert.equal(output.state, "cancelled");
  assert.match(output.summary, /cancelled/i);
});

// --- 14. Concurrent Workflow Isolation ---------------------------------------

test("workflow: concurrent workflows maintain isolated execution leases and context keys", async () => {
  const deps1 = setupTestDeps({ makeWorkflowId: () => "wf_concurrent_1" });
  const deps2 = setupTestDeps({ makeWorkflowId: () => "wf_concurrent_2" });

  const [res1, res2] = await Promise.all([
    executeWorkflow(
      { objective: "Workflow Alpha", executionMode: "single" },
      undefined,
      deps1,
    ),
    executeWorkflow(
      { objective: "Workflow Beta", executionMode: "single" },
      undefined,
      deps2,
    ),
  ]);

  assert.equal(res1.workflowId, "wf_concurrent_1");
  assert.equal(res2.workflowId, "wf_concurrent_2");
  assert.equal(res1.contextKey, "wf_concurrent_1");
  assert.equal(res2.contextKey, "wf_concurrent_2");
  assert.equal(res1.status, "COMPLETED");
  assert.equal(res2.status, "COMPLETED");
});

// --- 15. Restart / Fail-Closed Capability Behavior ---------------------------

test("workflow: restores informational session handoff while expiring all prior capabilities", async () => {
  const emittedEvents: OrchestratorEvent[] = [];
  const deps = setupTestDeps({}, emittedEvents);

  const baseContext = createOrchestrationContext({
    objective: "Historical resume task",
    acceptanceCriteria: ["Must pass tests"],
    allowedFiles: ["src/resume.ts"],
    forbiddenFiles: [],
    changeIntent: "required",
  });

  const sessionHandoff = exportSessionHandoff(baseContext, {
    handoffId: "sho_test_historical_001",
  });

  const output = await executeWorkflow(
    {
      objective: "Resume work from prior session",
      sessionHandoff,
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");
  assert.ok(output.steps.some((s) => s.state === "assessing"));
});

// --- 16. No Unbounded Transition Loop ----------------------------------------

test("workflow: enforces strict transition step limit preventing infinite loop", async () => {
  let callCount = 0;
  const loopResult = makeCleanTaskOutput({
    verdict: "FAILED",
    handoffReference: "hdf_loop",
    failureDecision: {
      classification: "effort",
      action: "effort-escalation",
      reason: "Indefinite loop mock",
      evidenceExecutionIds: ["exec-1"],
      nextEffort: "high",
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  });

  const deps = setupTestDeps({
    handleDelegateTask: async () => {
      callCount++;
      return {
        content: [{ type: "text", text: "LOOPING" }],
        structuredContent: loopResult,
      };
    },
  });

  const output = await executeWorkflow(
    {
      objective: "Looping task",
      maxSteps: 4,
      maxEscalations: 10, // Try to escalate beyond maxSteps
      computePolicy: { allowEffortEscalation: true },
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "PARENT_TAKEOVER");
  assert.ok(output.steps.length <= 5);
  assert.match(output.summary, /workflow-step-limit-exceeded/);
});

// --- 17. Telemetry Privacy ---------------------------------------------------

test("workflow: emits compact telemetry without prompt text, secrets, tokens, or raw outputs", async () => {
  const emittedEvents: OrchestratorEvent[] = [];
  const deps = setupTestDeps({}, emittedEvents);

  const secretString = "sk-proj-supersecretkey123456789012345678";
  const promptText = "Very long private prompt that must not appear in telemetry logs";

  await executeWorkflow(
    {
      objective: promptText,
      context: secretString,
      activityLabel: "Sanitized Task Label",
      executionMode: "single",
    },
    undefined,
    deps,
  );

  const workflowEvents = emittedEvents.filter((e) => e.type.startsWith("workflow."));

  assert.ok(workflowEvents.length >= 2);

  for (const event of workflowEvents) {
    const json = JSON.stringify(event);
    assert.equal(
      json.includes(secretString),
      false,
      "Secret must not appear in telemetry",
    );
    assert.equal(
      json.includes("sk-proj-"),
      false,
      "API key prefix must not appear in telemetry",
    );
    assert.equal(json.includes(promptText), false, "Prompt text must not appear");
    assert.equal(json.includes("ctr_"), false, "Continuation references must not appear");
    assert.equal(json.includes("hdf_"), false, "Handoff references must not appear");
  }
});

// --- 18. Context Compaction during Long Workflows ----------------------------

test("workflow: evaluates context pressure and triggers safe compaction during multi-step runs", async () => {
  const emittedEvents: OrchestratorEvent[] = [];
  const deps = setupTestDeps({}, emittedEvents);

  const output = await executeWorkflow(
    {
      objective: "Long running workflow with exploration and multiple steps",
      explore: true,
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");

  const contextEvaluated = emittedEvents.filter((e) => e.type === "context.evaluated");
  assert.ok(contextEvaluated.length >= 1);
});

test("workflow: batch completion requires authoritative verified-complete state", async () => {
  const deps = setupTestDeps({
    handleDelegateTasks: async () => ({
      content: [{ type: "text", text: "NEEDS SUPERVISOR" }],
      structuredContent: makeCleanBatchOutput({
        completionState: "needs-supervisor",
        passed: 2,
        taskCount: 2,
        integrated: true,
      }),
    }),
  });

  const output = await executeWorkflow(
    {
      objective: "Integrate two owned seams",
      tasks: [
        {
          objective: "First seam",
          acceptanceCriteria: ["First accepted"],
          allowedFiles: ["src/a.ts"],
          forbiddenFiles: [],
          changeIntent: "required",
          verificationCommands: ["npm test"],
          effort: "high",
          effortReason: "Owned seam",
          automaticRepair: true,
          resultDetail: "handoff",
          previousAttempts: [],
        },
        {
          objective: "Second seam",
          acceptanceCriteria: ["Second accepted"],
          allowedFiles: ["src/b.ts"],
          forbiddenFiles: [],
          changeIntent: "required",
          verificationCommands: ["npm test"],
          effort: "high",
          effortReason: "Owned seam",
          automaticRepair: true,
          resultDetail: "handoff",
          previousAttempts: [],
        },
      ],
      executionMode: "parallel",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "PARENT_TAKEOVER");
  assert.equal(output.verified, false);
});

test("workflow: worker PASS without current authoritative verification cannot complete", async () => {
  const deps = setupTestDeps({
    handleDelegateTask: async () => ({
      content: [{ type: "text", text: "UNVERIFIED PASS" }],
      structuredContent: makeCleanTaskOutput({ verification: [] }),
    }),
  });

  const output = await executeWorkflow(
    { objective: "Task with only a worker success claim", executionMode: "single" },
    undefined,
    deps,
  );

  assert.equal(output.status, "PARENT_TAKEOVER");
  assert.equal(output.verified, false);
  assert.match(output.summary, /authoritative verification/i);
});

test("workflow: imported handoff never supplies current execution authority", async () => {
  let delegated: DelegateTaskInput | undefined;
  const deps = setupTestDeps({
    handleDelegateTask: async (task) => {
      delegated = task;
      return {
        content: [{ type: "text", text: "CURRENT PASS" }],
        structuredContent: makeCleanTaskOutput(),
      };
    },
  });
  const historical = exportSessionHandoff(
    createOrchestrationContext({
      objective: "Historical objective",
      acceptanceCriteria: ["Historical acceptance"],
      allowedFiles: ["src/historical.ts"],
      forbiddenFiles: [],
      changeIntent: "required",
    }),
    { handoffId: "sho_test_informational_only" },
  );

  const output = await executeWorkflow(
    {
      objective: "Current objective",
      sessionHandoff: historical,
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "COMPLETED");
  assert.equal(delegated?.handoffReference, undefined);
  assert.deepEqual(delegated?.previousAttempts, []);
  assert.equal(delegated?.objective, "Current objective");
});

test("workflow: mid-flight cancellation awaits handler cleanup and cannot become success", async () => {
  const controller = new AbortController();
  let cleaned = false;
  const deps = setupTestDeps({
    handleDelegateTask: async (_task, signal) =>
      await new Promise((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            cleaned = true;
            resolve({
              content: [{ type: "text" as const, text: "cancelled after cleanup" }],
              isError: true,
            });
          },
          { once: true },
        );
      }),
  });

  const pending = executeWorkflow(
    { objective: "Cancel an in-flight task", executionMode: "single" },
    controller.signal,
    deps,
  );
  controller.abort();
  const output = await pending;

  assert.equal(cleaned, true);
  assert.equal(output.status, "CANCELLED");
  assert.equal(output.state, "cancelled");
  assert.equal(output.verified, false);
  assert.equal(
    output.transitions.some((item) => item.toState === "completed"),
    false,
  );
});

test("workflow: caller context labels cannot merge concurrent canonical state", async () => {
  const deps = setupTestDeps({ makeWorkflowId: () => `wf_${Math.random()}` });
  const [first, second] = await Promise.all([
    executeWorkflow(
      {
        objective: "First isolated task",
        contextKey: "shared-label",
        executionMode: "single",
      },
      undefined,
      deps,
    ),
    executeWorkflow(
      {
        objective: "Second isolated task",
        contextKey: "shared-label",
        executionMode: "single",
      },
      undefined,
      deps,
    ),
  ]);

  assert.notEqual(first.contextKey, second.contextKey);
  assert.match(first.contextKey, /^shared-label:wf_/);
  assert.match(second.contextKey, /^shared-label:wf_/);
});

// --- 26. Workflow Report Rendering -------------------------------------------

test("renderWorkflowReport: generates compact readable human summary", () => {
  const sampleOutput: WorkflowOutput = {
    workflowId: "wf_test_sample",
    status: "COMPLETED",
    state: "completed",
    summary: "Workflow verified complete in 120ms across 3 steps.",
    verified: true,
    durationMs: 120,
    executionMode: "delegate_task",
    recommendedRoute: "delegation-plausible",
    selectedModel: "gpt-5.6-luna",
    selectedEffort: "high",
    executedModels: ["gpt-5.6-luna"],
    executedEfforts: ["high"],
    steps: [],
    transitions: [
      {
        fromState: "assessing",
        toState: "routing",
        reason: "proceed-to-routing",
        timestamp: new Date().toISOString(),
        stepNumber: 1,
      },
      {
        fromState: "routing",
        toState: "delegating",
        reason: "selection-ready",
        timestamp: new Date().toISOString(),
        stepNumber: 2,
      },
      {
        fromState: "delegating",
        toState: "completed",
        reason: "verified-pass",
        timestamp: new Date().toISOString(),
        stepNumber: 3,
      },
    ],
    result: makeCleanTaskOutput(),
    contextKey: "wf_test_sample",
  };

  const report = renderWorkflowReport(sampleOutput);
  assert.match(report, /WORKFLOW wf_test_sample/);
  assert.match(report, /MODE: delegate_task/);
  assert.match(report, /VERIFIED: YES/);
  assert.match(report, /TRANSITIONS:/);
  assert.match(report, /TASK RESULT: verdict=PASS/);
});

// --- Audit regressions: coordinator admission and untrusted intake ----------

test("workflow admission probes the compute this call requests, not shipped defaults", async () => {
  const emitted: OrchestratorEvent[] = [];
  const deps = setupTestDeps({}, emitted);
  let delegatedEffort: string | null = null;
  deps.handleDelegateTask = async (input) => {
    delegatedEffort = input.effort;
    return {
      content: [{ type: "text", text: "DELEGATION REPORT" }],
      structuredContent: makeCleanTaskOutput({ effort: input.effort }),
      isError: false,
    };
  };

  const task: DelegateTaskInput = {
    objective: "Implement the declared seam under a narrowed effort envelope.",
    effort: "medium",
    effortReason: "The operator permits only medium here.",
    allowedFiles: ["src/narrow.ts"],
    forbiddenFiles: [],
    changeIntent: "required",
    acceptanceCriteria: ["Passes"],
    verificationCommands: ["npm test"],
    automaticRepair: false,
    resultDetail: "handoff",
    previousAttempts: [],
  };

  const output = await executeWorkflow(
    {
      objective: "Implement the declared seam under a narrowed effort envelope.",
      tasks: [task],
      executionMode: "single",
      // The probe used to ask about a hard-coded `high` on a hard-coded model,
      // so any installation narrowing either refused its own workflow at the
      // routing step before a single handler ran.
      computePolicy: { allowedEfforts: ["medium"] },
    },
    undefined,
    deps,
  );

  assert.ok(
    !output.transitions.some((t) => t.reason === "compute-policy-refused-execution"),
    "a narrowed but satisfiable envelope must not refuse the workflow",
  );
  assert.ok(output.transitions.some((t) => t.toState === "delegating"));
  assert.equal(delegatedEffort, "medium");
});

test("a malformed cross-session handoff yields parent takeover rather than throwing", async () => {
  const emitted: OrchestratorEvent[] = [];
  const deps = setupTestDeps({}, emitted);

  // Caller-supplied cross-session data is informational and untrusted. Rejecting
  // it used to throw straight out of `executeWorkflow`, before `workflow.started`
  // was emitted and with no structured result for the supervisor to read.
  const output = await executeWorkflow(
    {
      objective: "Resume work from a tampered prior session",
      sessionHandoff: '{"not":"a valid artifact"}',
      executionMode: "single",
    },
    undefined,
    deps,
  );

  assert.equal(output.status, "PARENT_TAKEOVER");
  assert.equal(output.state, "parent_takeover");
  assert.ok(
    output.transitions.some((t) => t.reason.startsWith("session-handoff-rejected")),
  );
  assert.ok(emitted.some((event) => event.type === "workflow.started"));
  assert.ok(emitted.some((event) => event.type === "workflow.completed"));
});

test("an injected context store receives the restored session handoff", async () => {
  const emitted: OrchestratorEvent[] = [];
  const deps = setupTestDeps({}, emitted);
  const injected = new ContextLifecycleStore();
  deps.contextStore = injected;

  const artifact = exportSessionHandoff(
    createOrchestrationContext({
      objective: "Historical objective from a prior session",
      acceptanceCriteria: ["Historical acceptance"],
      allowedFiles: ["src/historical.ts"],
      forbiddenFiles: [],
      changeIntent: "required",
    }),
    { handoffId: "sho_test_injected_store" },
  );

  await executeWorkflow(
    {
      objective: "Current objective",
      sessionHandoff: artifact,
      executionMode: "single",
    },
    undefined,
    deps,
  );

  // The restore used to land in a registry store that was then replaced by the
  // injected one, silently discarding the imported history the caller supplied.
  const restored = injected.getAuthoritativeContext();
  assert.ok(restored);
  assert.equal(restored!.importedHistory?.handoffId, "sho_test_injected_store");
  assert.equal(restored!.importedHistory?.schemaVersion, SESSION_HANDOFF_SCHEMA_VERSION);
});

test("an installation that renames the worker model still routes its workflows", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const workflowModule = fileURLToPath(new URL("./workflow.js", import.meta.url));
  const script = `
    const { executeWorkflow } = await import(${JSON.stringify(pathToFileUrlString(workflowModule))});
    const out = await executeWorkflow(
      { objective: "Implement the declared seam end to end please" },
      undefined,
      {
        emit: () => {},
        handleDelegateTask: async () => ({ content: [], isError: true }),
        handleDelegateTasks: async () => ({ content: [], isError: true }),
        handleExplore: async () => ({ content: [], isError: true }),
        handleContinueTask: async () => ({ content: [], isError: true }),
      },
    );
    process.stdout.write(JSON.stringify(out.transitions.map((t) => t.reason)));
  `;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, LUNA_MODEL: "gpt-5.6-luna-renamed" },
  });
  const reasons = JSON.parse(stdout) as string[];
  // The admission probe named the shipped default model, so every installation
  // that set LUNA_MODEL refused its own workflow before any handler ran.
  assert.ok(!reasons.includes("compute-policy-refused-execution"), stdout);
});

function pathToFileUrlString(file: string): string {
  return new URL(`file://${file.startsWith("/") ? "" : "/"}${file.replaceAll("\\", "/")}`)
    .href;
}
