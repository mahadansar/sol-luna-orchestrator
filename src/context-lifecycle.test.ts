import test from "node:test";
import assert from "node:assert/strict";
import {
  ContextLifecycleStore,
  calculateContextPressureMetrics,
  compactContext,
} from "./context.js";
import { CONTINUATION_TTL_MS, ContinuationStore } from "./continuation.js";
import { HANDOFF_TTL_MS, HandoffStore } from "./handoff.js";
import {
  handleContinueTask,
  ContextLifecycleRegistry,
  handleDelegateTask,
  handleDelegateTasks,
  handleRoutingPreflight,
} from "./server.js";
import type {
  AttemptEvidence,
  BatchOutput,
  DelegateTaskInput,
  DelegateTaskOutput,
  DelegateTasksInput,
} from "./contract.js";
import type { OrchestratorEvent } from "./events.js";

function makeMinimalOutput(
  overrides: Partial<DelegateTaskOutput> = {},
): DelegateTaskOutput {
  return {
    verdict: "PASS",
    workerClaimedStatus: "PASS",
    workerClaimedFailureCauses: [],
    trustworthy: true,
    filesChanged: [
      { path: "src/main.ts", why: "updated", kind: "modified", observed: true },
    ],
    verification: [
      {
        command: "npm test",
        passed: true,
        source: "orchestrator",
        execution: "argv",
        exitCode: 0,
        output:
          "TAP version 13\n" +
          "ok 1 - test scenario passed\n".repeat(50) +
          "1..50\n# tests 50\n# pass 50\n",
      },
    ],
    verificationMode: "allowlist",
    scopeViolations: [],
    discrepancies: [],
    errors: [],
    followUps: [],
    notes: "",
    summary: "Executed task successfully",
    reviewChecklist: [],
    escalationAdvice: null,
    usage: null,
    attempt: 1,
    attempts: [],
    durationSeconds: 2,
    model: "test-model",
    effort: "medium",
    effortReason: "Minimal task requiring medium effort",
    workerThreadId: "th_test123",
    changeIntent: "required",
    continuationReference: null,
    continuationState: { status: "not-eligible", reason: "not-eligible" },
    handoffReference: null,
    handoffState: { status: "not-eligible", reason: "not-eligible" },
    ...overrides,
  };
}

function makeMinimalTask(overrides: Partial<DelegateTaskInput> = {}): DelegateTaskInput {
  return {
    objective: "Implement feature X safely with clear seam",
    effortReason: "Minimal task requiring medium effort",
    acceptanceCriteria: ["All tests pass", "Zero regressions"],
    allowedFiles: ["src/main.ts"],
    forbiddenFiles: ["package.json"],
    verificationCommands: ["npm test"],
    changeIntent: "required",
    effort: "medium",
    automaticRepair: false,
    resultDetail: "handoff",
    previousAttempts: [],
    routingPreflight: {
      seams: ["main-seam"],
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
    ...overrides,
  };
}

test("lifecycle - single delegation compaction boundary triggers at post-delegation", async () => {
  const events: OrchestratorEvent[] = [];
  const emit = (event: OrchestratorEvent) => events.push(event);
  const continuationStore = new ContinuationStore();
  const handoffStore = new HandoffStore();
  const contextStore = new ContextLifecycleStore({
    continuationStore,
    handoffStore,
    emit,
    config: {
      maxTotalTurns: 1,
      minReclaimableBytes: 1,
      cooldownTurns: 0,
    },
  });

  const task = makeMinimalTask();
  const output = makeMinimalOutput();

  const response = await handleDelegateTask(task, undefined, {
    continuationStore,
    handoffStore,
    contextStore,
    delegateToLuna: async () => output,
    emit,
    makeBatchId: () => "b_test_1",
  });

  assert.equal(response.isError, undefined);
  const authContext = contextStore.getAuthoritativeContext();
  assert.ok(authContext);
  assert.equal(authContext.turns.length, 1);

  const projection = contextStore.getCompactedProjection();
  assert.ok(projection);
  assert.equal(projection.stats.compactedCleanTurns, 1);

  const evaluatedEvents = events.filter((e) => e.type === "context.evaluated");
  assert.equal(evaluatedEvents.length, 1);
  assert.equal(evaluatedEvents[0]?.boundary, "post-delegation");
  assert.equal(evaluatedEvents[0]?.decision, "trigger");

  const compactedEvents = events.filter((e) => e.type === "context.compacted");
  assert.equal(compactedEvents.length, 1);
  assert.equal(compactedEvents[0]?.boundary, "post-delegation");
  assert.equal(compactedEvents[0]?.compactedCleanTurns, 1);
});

test("lifecycle - batch delegation compaction boundary triggers at post-batch", async () => {
  const events: OrchestratorEvent[] = [];
  const emit = (event: OrchestratorEvent) => events.push(event);
  const continuationStore = new ContinuationStore();
  const handoffStore = new HandoffStore();
  const contextStore = new ContextLifecycleStore({
    continuationStore,
    handoffStore,
    emit,
    config: {
      maxTotalTurns: 1,
      minReclaimableBytes: 1,
      cooldownTurns: 0,
    },
  });

  const batchInput: DelegateTasksInput = {
    mode: "sequential",
    resultDetail: "handoff",
    allowOverlappingScopes: false,
    integrate: true,
    automaticRecovery: true,
    tasks: [
      makeMinimalTask({ objective: "Task 1: first component" }),
      makeMinimalTask({ objective: "Task 2: second component" }),
    ],
  };

  const fakeBatchResult: BatchOutput = {
    mode: "sequential",
    batchId: "b_batch_1",
    taskCount: 2,
    maxParallel: 1,
    passed: 2,
    failed: 0,
    integrated: true,
    completionState: "verified-complete",
    durationSeconds: 4,
    integrationVerification: [
      {
        command: "npm test",
        passed: true,
        source: "orchestrator",
        execution: "argv",
        exitCode: 0,
        output: "TAP version 13\n" + "ok 1 - integration passed\n".repeat(50) + "1..50\n",
      },
    ],
    integrationSummary: "all passed",
    tasks: [
      {
        taskId: "t1",
        state: "completed",
        objective: "Task 1: first component",
        effort: "medium",
        effortReason: "test",
        changedFiles: ["src/main.ts"],
        worktreePath: "/tmp/worktree",
        error: null,
        warnings: [],
        result: makeMinimalOutput(),
      },
      {
        taskId: "t2",
        state: "completed",
        objective: "Task 2: second component",
        effort: "medium",
        effortReason: "test",
        changedFiles: ["src/main.ts"],
        worktreePath: "/tmp/worktree",
        error: null,
        warnings: [],
        result: makeMinimalOutput(),
      },
    ],
    integrationConflicts: [],
    scopeConflicts: [],
    warnings: [],
    reviewChecklist: [],
  };

  const response = await handleDelegateTasks(batchInput, undefined, {
    continuationStore,
    handoffStore,
    contextStore,
    runBatch: async () => fakeBatchResult,
    emit,
    makeBatchId: () => "b_batch_1",
  });

  assert.equal(response.isError, undefined);
  const authContext = contextStore.getAuthoritativeContext();
  assert.ok(authContext);
  assert.equal(authContext.turns.length, 1);

  const evaluatedEvents = events.filter((e) => e.type === "context.evaluated");
  assert.equal(evaluatedEvents.length, 1);
  assert.equal(evaluatedEvents[0]?.boundary, "post-batch");
  assert.equal(evaluatedEvents[0]?.decision, "trigger");

  const compactedEvents = events.filter((e) => e.type === "context.compacted");
  assert.equal(compactedEvents.length, 1);
  assert.equal(compactedEvents[0]?.boundary, "post-batch");
});

test("lifecycle - continuation compaction boundary records turn and compacts correctly", async () => {
  const events: OrchestratorEvent[] = [];
  const emit = (event: OrchestratorEvent) => events.push(event);
  const continuationStore = new ContinuationStore();
  const handoffStore = new HandoffStore();
  const contextStore = new ContextLifecycleStore({
    continuationStore,
    handoffStore,
    emit,
    config: {
      maxTotalTurns: 1,
      minReclaimableBytes: 1,
      cooldownTurns: 0,
    },
  });

  const baseTask = makeMinimalTask();
  const ref = continuationStore.issue(
    baseTask,
    "th_123",
    process.cwd(),
    false,
    null,
    null,
    2,
    "test-model",
  );

  const output = makeMinimalOutput({
    attempt: 2,
    workerClaimedStatus: "PASS",
    verdict: "PASS",
  });

  const response = await handleContinueTask(
    {
      continuationReference: ref,
      instruction: "Please fix lint errors",
    },
    undefined,
    {
      store: continuationStore,
      handoffStore,
      contextStore,
      continueTask: async () => output,
      emit,
      makeBatchId: () => "b_cont_1",
    },
  );

  assert.equal(response.isError, undefined);
  const authContext = contextStore.getAuthoritativeContext();
  assert.ok(authContext);
  assert.equal(authContext.turns.length, 1);
  assert.equal(authContext.turns[0]?.kind, "continuation");

  const evaluatedEvents = events.filter((e) => e.type === "context.evaluated");
  assert.equal(evaluatedEvents.length, 1);
  assert.equal(evaluatedEvents[0]?.boundary, "post-continuation");
});

test("lifecycle - repair and recovery evidence is fully preserved across compaction", () => {
  const continuationStore = new ContinuationStore();
  const handoffStore = new HandoffStore();
  const contextStore = new ContextLifecycleStore({
    continuationStore,
    handoffStore,
    config: {
      maxTotalTurns: 1,
      minReclaimableBytes: 1,
      cooldownTurns: 0,
    },
  });

  const task = makeMinimalTask();
  const repairAttempt: AttemptEvidence = {
    logicalAttempt: 1,
    role: "automatic-repair",
    executionId: "exec_rep_1",
    predecessorExecutionId: null,
    requestedModel: "test-model",
    requestedEffort: "medium",
    threadId: "th_test123",
    threadOperation: "resume",
    threadIdentityMatched: true,
    startedAt: new Date(1000).toISOString(),
    finishedAt: new Date(2000).toISOString(),
    elapsedMs: 1000,
    workerElapsedMs: 800,
    verificationElapsedMs: 200,
    timeoutMs: 30000,
    termination: {
      kind: "completed",
      message: null,
    },
    usage: {
      status: "unavailable",
      reason: "cancelled",
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
        output: "SyntaxError: Unexpected token",
      },
    ],
  };
  const recoveryAttempt: AttemptEvidence = {
    ...structuredClone(repairAttempt),
    logicalAttempt: 2,
    role: "process-retry",
    executionId: "exec_rec_2",
    predecessorExecutionId: "exec_rep_1",
  };

  const output = makeMinimalOutput({
    verdict: "FAILED",
    workerClaimedStatus: "FAILED",
    trustworthy: true,
    attempts: [repairAttempt, recoveryAttempt],
    repair: {
      requested: true,
      attempted: true,
      classification: "scope-or-conflict",
      reason: "Syntax error",
      failureEvidence: [],
    },
    recovery: {
      attempted: true,
      classification: "worker-process-retry",
      evidence: "exit code 1",
      initialAttempt: 1,
      recoveryAttempt: 1,
      initialDurationSeconds: 1,
      recoveryDurationSeconds: 1,
      initialUsage: null,
      recoveryUsage: null,
    },
    failureDecision: {
      classification: "scope-or-conflict",
      action: "parent-takeover",
      reason: "Syntax error could not be resolved automatically",
      evidenceExecutionIds: ["exec_rep_1"],
      nextEffort: null,
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
    errors: ["Syntax error in main.ts"],
    discrepancies: ["Line 42 broken"],
  });

  contextStore.recordDelegationTurn(task, output);
  const compactionResult = contextStore.evaluateAndMaybeCompact("post-delegation", {
    force: true,
  });
  assert.equal(compactionResult.compacted, true);

  const projection = contextStore.getCompactedProjection();
  assert.ok(projection);
  assert.equal(projection.turns.length, 1);
  const compactedTurn = projection.turns[0]!;
  assert.equal(compactedTurn.isClean, false);
  assert.equal(compactedTurn.errors.length, 1);
  assert.equal(compactedTurn.errors[0], "Syntax error in main.ts");
  assert.equal(compactedTurn.discrepancies.length, 1);
  assert.equal(compactedTurn.discrepancies[0], "Line 42 broken");
  assert.equal(compactedTurn.failureDecision?.action, "parent-takeover");

  // Lineage retention
  assert.equal(projection.lineage.length, 2);
  assert.equal(projection.lineage[0]?.executionId, "exec_rep_1");
  assert.equal(projection.lineage[1]?.executionId, "exec_rec_2");
  assert.equal(projection.lineage[0]?.verdict, undefined);
  assert.equal(projection.lineage[1]?.verdict, undefined);
  assert.equal(compactedTurn.verdict, "FAILED");
});

test("lifecycle - live issued, consumed, and expired reference state is respected", () => {
  const continuationStore = new ContinuationStore();
  const handoffStore = new HandoffStore();
  const contextStore = new ContextLifecycleStore({
    continuationStore,
    handoffStore,
  });

  const task = makeMinimalTask();
  const ref1 = continuationStore.issue(
    task,
    "th_1",
    process.cwd(),
    false,
    null,
    null,
    1,
    "test",
  );
  const ref2 = continuationStore.issue(
    task,
    "th_2",
    process.cwd(),
    false,
    null,
    null,
    1,
    "test",
  );
  const href1 = handoffStore.issue(
    task,
    makeMinimalOutput({
      model: "test",
      effort: "medium",
      failureDecision: {
        classification: "scope-or-conflict",
        action: "retry",
        reason: "transient",
        evidenceExecutionIds: [],
        nextEffort: null,
        automaticHandler: "automatic-recovery",
        automaticRetryCount: 1,
        automaticRetryLimit: 1,
      },
    }),
  );

  // Consume ref1 in continuationStore
  const reserved = continuationStore.consume(ref1);
  assert.equal(reserved.status, "ready");

  const out1 = makeMinimalOutput({
    continuationReference: ref1,
    continuationState: { status: "issued", reason: "issued" },
  });
  const out2 = makeMinimalOutput({
    continuationReference: ref2,
    continuationState: { status: "issued", reason: "issued" },
    handoffReference: href1,
    handoffState: { status: "issued", reason: "issued" },
  });

  contextStore.recordDelegationTurn(task, out1);
  contextStore.recordDelegationTurn(task, out2);

  const auth = contextStore.getAuthoritativeContext();
  assert.ok(auth);

  // Metrics should show active references pruned by live store status (ref1 was consumed)
  const metrics = calculateContextPressureMetrics(auth, {
    continuationStore,
    handoffStore,
  });
  assert.equal(metrics.activeContinuationsCount, 1); // only ref2 is active
  assert.equal(metrics.activeHandoffsCount, 1); // href1 is active

  const compacted = compactContext(auth, { continuationStore, handoffStore });
  assert.equal(compacted.activeContinuations.length, 1);
  assert.equal(compacted.activeHandoffs.length, 1);
  assert.ok(!JSON.stringify(compacted).includes(ref2));
  assert.ok(!JSON.stringify(compacted).includes(href1));
});

test("lifecycle - live reference status checks are non-consuming and expiry is truthful", () => {
  let now = 0;
  const continuationStore = new ContinuationStore({
    now: () => now,
    tokenFactory: () => `ctr_${"c".repeat(32)}`,
  });
  const handoffStore = new HandoffStore({
    now: () => now,
    tokenFactory: () => `hdf_${"h".repeat(32)}`,
  });
  const task = makeMinimalTask();
  const continuation = continuationStore.issue(task, "th_status", process.cwd());
  const handoff = handoffStore.issue(
    task,
    makeMinimalOutput({
      verdict: "FAILED",
      failureDecision: {
        classification: "runtime",
        action: "retry",
        reason: "retry",
        evidenceExecutionIds: [],
        nextEffort: null,
        automaticHandler: "automatic-recovery",
        automaticRetryCount: 1,
        automaticRetryLimit: 1,
      },
    }),
  );

  assert.equal(continuationStore.status(continuation), "issued");
  assert.equal(continuationStore.consume(continuation).status, "ready");
  assert.equal(handoffStore.status(handoff), "issued");
  assert.equal(handoffStore.consume(handoff).status, "ready");

  const expiringContinuation = continuationStore.issue(task, "th_expiry", process.cwd());
  const expiringHandoff = handoffStore.issue(task, makeMinimalOutput());
  now = Math.max(CONTINUATION_TTL_MS, HANDOFF_TTL_MS);
  assert.equal(continuationStore.status(expiringContinuation), "unavailable");
  assert.equal(continuationStore.consume(expiringContinuation).status, "expired");
  assert.equal(handoffStore.status(expiringHandoff), "unavailable");
  assert.equal(handoffStore.consume(expiringHandoff).status, "expired");
});

test("lifecycle - cooldown hysteresis prevents compaction thrashing across real calls", () => {
  const continuationStore = new ContinuationStore();
  const handoffStore = new HandoffStore();
  const contextStore = new ContextLifecycleStore({
    continuationStore,
    handoffStore,
    config: {
      maxTotalTurns: 1,
      minReclaimableBytes: 1,
      cooldownTurns: 2,
    },
  });

  const task = makeMinimalTask();
  const output = makeMinimalOutput();

  // Turn 1
  contextStore.recordDelegationTurn(task, output);
  const eval1 = contextStore.evaluateAndMaybeCompact("post-delegation");
  assert.equal(eval1.compacted, true);
  assert.equal(eval1.evaluation.decision, "trigger");
  assert.equal(eval1.evaluation.cooldownRemaining, 0);

  // Turn 2: within cooldown (lastCompactedTurn = 1, currentTurn = 2, cooldownRemaining = 2 - 1 = 1)
  contextStore.recordDelegationTurn(task, output);
  const eval2 = contextStore.evaluateAndMaybeCompact("post-delegation");
  assert.equal(eval2.compacted, false);
  assert.equal(eval2.evaluation.decision, "block");
  assert.equal(eval2.evaluation.primaryReason, "block:cooldown-active");
  assert.equal(eval2.evaluation.cooldownRemaining, 1);

  // Turn 3: at boundary (lastCompactedTurn = 1, currentTurn = 3, cooldownRemaining = 2 - 2 = 0)
  contextStore.recordDelegationTurn(task, output);
  const eval3 = contextStore.evaluateAndMaybeCompact("post-delegation");
  assert.equal(eval3.compacted, true);
  assert.equal(eval3.evaluation.decision, "trigger");
  assert.equal(eval3.evaluation.cooldownRemaining, 0);
});

test("lifecycle - execution leases block compaction until every lease is released", () => {
  const contextStore = new ContextLifecycleStore({
    config: {
      maxTotalTurns: 1,
      minReclaimableBytes: 1,
      cooldownTurns: 0,
    },
  });

  const task = makeMinimalTask();
  contextStore.recordDelegationTurn(task, makeMinimalOutput());

  const releaseA = contextStore.acquireExecutionLease();
  const releaseB = contextStore.acquireExecutionLease();
  assert.equal(contextStore.getInFlightCount(), 2);
  releaseA();
  assert.equal(contextStore.getInFlightCount(), 1);
  const inFlightEval = contextStore.evaluateAndMaybeCompact("post-delegation");
  assert.equal(inFlightEval.compacted, false);
  assert.equal(inFlightEval.evaluation.decision, "block");
  assert.equal(inFlightEval.evaluation.primaryReason, "block:unsafe-lifecycle-boundary");

  releaseA();
  assert.equal(contextStore.getInFlightCount(), 1);
  releaseB();
  assert.equal(contextStore.getInFlightCount(), 0);
  const safeEval = contextStore.evaluateAndMaybeCompact("post-delegation");
  assert.equal(safeEval.compacted, true);
  assert.equal(safeEval.evaluation.decision, "trigger");
});

test("lifecycle - no caller spoofing: caller cannot forge context state or fake compaction", () => {
  const contextStore = new ContextLifecycleStore({
    config: {
      maxTotalTurns: 1,
      minReclaimableBytes: 1,
      cooldownTurns: 2,
    },
  });

  const task = makeMinimalTask();
  // Turn 1
  contextStore.recordDelegationTurn(task, makeMinimalOutput());

  // Calling evaluate with force without safe boundary is still governed by policy
  const evalUnsafe = contextStore.evaluateAndMaybeCompact("in-flight");
  assert.equal(evalUnsafe.compacted, false);
  assert.equal(evalUnsafe.evaluation.decision, "block");

  // State persists authoritatively and cannot be overridden by caller arguments
  const auth = contextStore.getAuthoritativeContext();
  assert.ok(auth);
  assert.equal(auth.turns.length, 1);
});

test("lifecycle - telemetry privacy: events emit factual metrics and zero secrets or capability tokens", async () => {
  const emittedEvents: OrchestratorEvent[] = [];
  const emit = (event: OrchestratorEvent) => emittedEvents.push(event);
  const continuationStore = new ContinuationStore();
  const handoffStore = new HandoffStore();
  const contextStore = new ContextLifecycleStore({
    continuationStore,
    handoffStore,
    emit,
    config: {
      maxTotalTurns: 1,
      minReclaimableBytes: 1,
      cooldownTurns: 0,
    },
  });

  const secretString = "api_key=sk-1234567890abcdef1234567890abcdef";
  const task = makeMinimalTask({
    objective: `Connect to backend with secret: ${secretString}`,
  });
  const output = makeMinimalOutput();

  const res = await handleDelegateTask(task, undefined, {
    continuationStore,
    handoffStore,
    contextStore,
    delegateToLuna: async () => output,
    emit,
    makeBatchId: () => "b_privacy_1",
  });

  assert.equal(res.isError, undefined);

  const contextEvaluated = emittedEvents.find((e) => e.type === "context.evaluated");
  const contextCompacted = emittedEvents.find((e) => e.type === "context.compacted");

  assert.ok(contextEvaluated);
  assert.ok(contextCompacted);

  const jsonEvaluated = JSON.stringify(contextEvaluated);
  const jsonCompacted = JSON.stringify(contextCompacted);

  assert.ok(!jsonEvaluated.includes("sk-1234567890abcdef1234567890abcdef"));
  assert.ok(!jsonCompacted.includes("sk-1234567890abcdef1234567890abcdef"));
  assert.ok(!jsonEvaluated.includes("ctr_"));
  assert.ok(!jsonCompacted.includes("ctr_"));
  assert.ok(!jsonEvaluated.includes("hdf_"));
  assert.ok(!jsonCompacted.includes("hdf_"));
});

test("lifecycle - repeated lifecycle progression maintains bounded size and monotonic turn counts", () => {
  const contextStore = new ContextLifecycleStore({
    config: {
      maxTotalTurns: 3,
      minReclaimableBytes: 1,
      cooldownTurns: 1,
    },
  });

  const task = makeMinimalTask();

  for (let i = 1; i <= 10; i++) {
    contextStore.recordDelegationTurn(task, makeMinimalOutput(), {
      id: `turn_${i}`,
    });
    contextStore.evaluateAndMaybeCompact("post-delegation");
  }

  const auth = contextStore.getAuthoritativeContext();
  assert.ok(auth);
  assert.equal(auth.turns.length, 10);
  assert.equal(auth.turns[9]?.turnNumber, 10);

  const projection = contextStore.getCompactedProjection();
  assert.ok(projection);
  assert.ok(projection.stats.compactedSizeBytes <= projection.stats.originalSizeBytes);
});

test("lifecycle - context persistence across calls maintains decisions, constraints, blockers", () => {
  const contextStore = new ContextLifecycleStore();

  contextStore.recordDecision({
    summary: "Use PostgreSQL for persistence",
  });

  contextStore.recordConstraint({
    description: "Node 20+ required",
    kind: "policy",
  });

  contextStore.recordBlocker({
    id: "blk_db_1",
    description: "Migration pending",
    kind: "verification-failure",
  });

  const authBefore = contextStore.getAuthoritativeContext();
  assert.ok(authBefore);
  assert.equal(authBefore.decisions.length, 1);
  assert.equal(authBefore.constraints.length, 1);
  assert.equal(authBefore.blockers.length, 1);
  assert.equal(authBefore.blockers[0]?.resolved, false);

  contextStore.resolveBlocker("blk_db_1");

  const authAfter = contextStore.getAuthoritativeContext();
  assert.ok(authAfter);
  assert.equal(authAfter.blockers[0]?.resolved, true);
});

test("lifecycle - routing preflight remains advisory and does not persist context", () => {
  const events: OrchestratorEvent[] = [];
  const emit = (event: OrchestratorEvent) => events.push(event);
  const contextStore = new ContextLifecycleStore({
    emit,
    config: {
      maxTotalTurns: 1,
      minReclaimableBytes: 1,
      cooldownTurns: 0,
    },
  });

  const response = handleRoutingPreflight(
    {
      seams: ["exploration-seam"],
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
    {
      emit,
      makePreflightId: () => "p_preflight_1",
    },
  );

  assert.ok(response.content[0]?.text);
  assert.equal(contextStore.getAuthoritativeContext(), null);

  const evaluatedEvents = events.filter((e) => e.type === "context.evaluated");
  assert.equal(evaluatedEvents.length, 0);
});

test("lifecycle - production registry isolates unrelated fresh MCP calls", async () => {
  const continuationStore = new ContinuationStore();
  const handoffStore = new HandoffStore();
  const emit = (_event: OrchestratorEvent): void => {};
  const registry = new ContextLifecycleRegistry({
    continuationStore,
    handoffStore,
    emit,
  });

  await handleDelegateTask(
    makeMinimalTask({ objective: "unrelated alpha task" }),
    undefined,
    {
      continuationStore,
      handoffStore,
      contextRegistry: registry,
      delegateToLuna: async (_input, _signal, hooks) => {
        hooks?.onStarted?.(process.cwd());
        return makeMinimalOutput();
      },
      emit,
      record: () => {},
      makeBatchId: () => "b_iso_alpha",
    },
  );
  await handleDelegateTask(
    makeMinimalTask({ objective: "unrelated beta task" }),
    undefined,
    {
      continuationStore,
      handoffStore,
      contextRegistry: registry,
      delegateToLuna: async (_input, _signal, hooks) => {
        hooks?.onStarted?.(process.cwd());
        return makeMinimalOutput();
      },
      emit,
      record: () => {},
      makeBatchId: () => "b_iso_beta",
    },
  );

  const alpha = registry.getOrCreate("b_iso_alpha").getAuthoritativeContext();
  const beta = registry.getOrCreate("b_iso_beta").getAuthoritativeContext();
  assert.ok(alpha);
  assert.ok(beta);
  assert.equal(alpha.objective, "unrelated alpha task");
  assert.equal(beta.objective, "unrelated beta task");
  assert.equal(alpha.turns.length, 1);
  assert.equal(beta.turns.length, 1);
  assert.ok(!JSON.stringify(alpha).includes("unrelated beta task"));
  assert.ok(!JSON.stringify(beta).includes("unrelated alpha task"));
});

test("lifecycle - overlapping handlers cannot clear another execution lease", async () => {
  const events: OrchestratorEvent[] = [];
  const contextStore = new ContextLifecycleStore({
    config: { maxTotalTurns: 1, minReclaimableBytes: 1, cooldownTurns: 0 },
  });
  const continuationStore = new ContinuationStore();
  const handoffStore = new HandoffStore();
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });

  const first = handleDelegateTask(makeMinimalTask({ objective: "first" }), undefined, {
    contextStore,
    continuationStore,
    handoffStore,
    delegateToLuna: async () => {
      await firstGate;
      return makeMinimalOutput();
    },
    emit: (event) => events.push(event),
    record: () => {},
    makeBatchId: () => "b_overlap_first",
  });
  const second = handleDelegateTask(makeMinimalTask({ objective: "second" }), undefined, {
    contextStore,
    continuationStore,
    handoffStore,
    delegateToLuna: async () => {
      await secondGate;
      return makeMinimalOutput();
    },
    emit: (event) => events.push(event),
    record: () => {},
    makeBatchId: () => "b_overlap_second",
  });

  await Promise.resolve();
  assert.equal(contextStore.getInFlightCount(), 2);
  releaseFirst();
  await first;
  assert.equal(contextStore.getInFlightCount(), 1);
  const firstEvaluation = events.find(
    (event) => event.type === "context.evaluated" && event.batchId === "b_overlap_first",
  );
  if (!firstEvaluation || firstEvaluation.type !== "context.evaluated") {
    assert.fail("missing first context evaluation");
  }
  assert.equal(firstEvaluation?.boundary, "in-flight");
  assert.equal(firstEvaluation?.decision, "block");

  releaseSecond();
  await second;
  assert.equal(contextStore.getInFlightCount(), 0);
  assert.ok(contextStore.getCompactedProjection());
});

test("lifecycle - a new authoritative turn invalidates a stale projection", () => {
  const contextStore = new ContextLifecycleStore({
    config: { maxTotalTurns: 1, minReclaimableBytes: 1, cooldownTurns: 0 },
  });
  contextStore.recordDelegationTurn(makeMinimalTask(), makeMinimalOutput());
  assert.equal(contextStore.evaluateAndMaybeCompact("post-delegation").compacted, true);
  assert.ok(contextStore.getCompactedProjection());

  contextStore.recordDelegationTurn(
    makeMinimalTask({ objective: "new post-compaction turn" }),
    makeMinimalOutput(),
  );
  assert.equal(contextStore.getCompactedProjection(), null);
  const current = contextStore.getCurrentProjection();
  assert.ok(current && "turns" in current);
  assert.equal(current.turns.length, 2);
});

test("lifecycle - thrown execution failures remain authoritative and release once", async () => {
  const events: OrchestratorEvent[] = [];
  const contextStore = new ContextLifecycleStore();
  const response = await handleDelegateTask(makeMinimalTask(), undefined, {
    contextStore,
    continuationStore: new ContinuationStore(),
    handoffStore: new HandoffStore(),
    delegateToLuna: async () => {
      throw new Error("deterministic runtime failure");
    },
    emit: (event) => events.push(event),
    record: () => {},
    makeBatchId: () => "b_runtime_failure",
  });

  assert.equal(response.isError, true);
  assert.equal(contextStore.getInFlightCount(), 0);
  const context = contextStore.getAuthoritativeContext();
  assert.ok(context);
  assert.equal(context.blockers.length, 1);
  assert.equal(context.blockers[0]?.kind, "runtime-error");
  assert.ok(
    events.some(
      (event) =>
        event.type === "context.evaluated" && event.batchId === "b_runtime_failure",
    ),
  );
});

test("lifecycle - continuation restores only its server-owned lineage context", async () => {
  const continuationStore = new ContinuationStore();
  const handoffStore = new HandoffStore();
  const registry = new ContextLifecycleRegistry({
    continuationStore,
    handoffStore,
    emit: () => {},
  });
  const owner = registry.getOrCreate("ctx_owner");
  owner.recordDelegationTurn(
    makeMinimalTask({ objective: "owned lineage" }),
    makeMinimalOutput(),
  );
  const reference = continuationStore.issue(
    makeMinimalTask({ objective: "owned lineage" }),
    "th_owned",
    process.cwd(),
    false,
    null,
    null,
    2,
    "test-model",
    "ctx_owner",
  );
  const unrelated = registry.getOrCreate("ctx_unrelated");
  unrelated.recordDelegationTurn(
    makeMinimalTask({ objective: "unrelated lineage" }),
    makeMinimalOutput(),
  );

  const response = await handleContinueTask(
    { continuationReference: reference, instruction: "continue owned task" },
    undefined,
    {
      store: continuationStore,
      handoffStore,
      contextRegistry: registry,
      continueTask: async () => makeMinimalOutput({ attempt: 2 }),
      emit: () => {},
      record: () => {},
      makeBatchId: () => "b_owned_continuation",
    },
  );

  assert.equal(response.isError, undefined);
  assert.equal(owner.getAuthoritativeContext()?.turns.length, 2);
  assert.equal(unrelated.getAuthoritativeContext()?.turns.length, 1);
  assert.ok(
    !JSON.stringify(owner.getAuthoritativeContext()).includes("unrelated lineage"),
  );
});
