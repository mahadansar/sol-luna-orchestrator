/**
 * Integration tests for the delivered P1.2 adaptive-routing primitives.
 *
 * Tests the full pipeline:
 * seam planning -> routing evaluation -> execution shape -> compute selection -> telemetry
 *
 * Assertions:
 * - Solo path (tightly coupled / zero worker / shared mutable state)
 * - Single-worker delegation
 * - Sequential multi-worker path
 * - Parallel independent seams
 * - Policy-constrained execution (clamping worker count, concurrency, effort)
 * - Explicit executor ordering and stronger fallback
 * - Unresolved / ambiguous routing (unknown fields stay conservative)
 * - Zero-worker envelope
 * - Telemetry consistency
 * - No artificial seam/model hierarchy
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  routeAdaptiveTask,
  routeAdaptiveCard,
  deriveSeamCandidate,
  deriveSeamCandidates,
  deriveDeclaredEvidence,
  routeLiveTask,
  routeLiveTasks,
} from "./adaptive.js";
import { buildComputePolicy, type ComputePolicy } from "./policy.js";
import type { SeamCandidate } from "./seam-plan.js";
import type { OrchestratorEvent } from "./events.js";
import { recordEvent, refuseSingleDelegation } from "./server.js";
import { runBatch } from "./batch.js";
import {
  delegateTaskInputSchema,
  type DelegateTaskOutput,
  type FailureDecision,
  type DelegateTaskInput,
} from "./contract.js";
import {
  HandoffStore,
  handoffError,
  registerHandoff,
  isHandoffReference,
} from "./handoff.js";
import { type PriorExecution } from "./selection.js";
import { executeTask, type WorkerCodex } from "./worker.js";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";

const DEFAULT_POLICY: ComputePolicy = buildComputePolicy({
  model: "gpt-5.6-luna",
  allowedEfforts: ["medium", "high", "xhigh", "max"],
  maxConcurrency: 3,
  maxWorkersPerBatch: 6,
  allowEffortEscalation: true,
  allowStrongerFallback: true,
});

const ORDERED_POLICY: ComputePolicy = buildComputePolicy({
  model: "gpt-5.6-luna",
  allowedModels: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-sol-max"],
  allowedEfforts: ["medium", "high", "xhigh", "max"],
  maxConcurrency: 3,
  maxWorkersPerBatch: 6,
  allowEffortEscalation: true,
  allowStrongerFallback: true,
  executorOrder: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-sol-max"],
});

function makeCandidate(overrides: Partial<SeamCandidate> = {}): SeamCandidate {
  return {
    label: "Test candidate",
    allowedFiles: ["src/feature-a/**"],
    verificationCommands: ["npm test"],
    ...overrides,
  };
}

function failure(
  action: FailureDecision["action"],
  nextEffort: FailureDecision["nextEffort"] = null,
): FailureDecision {
  return {
    classification: action === "effort-escalation" ? "effort" : "capability",
    action,
    reason: "Test failure decision",
    evidenceExecutionIds: ["exec-1"],
    nextEffort,
    automaticHandler: null,
    automaticRetryCount: 0,
    automaticRetryLimit: 1,
  };
}

test("adaptive routing - solo path for zero candidates or tightly coupled work", () => {
  // Zero candidates -> solo
  const emptyResult = routeAdaptiveTask({
    candidates: [],
    policy: DEFAULT_POLICY,
  });
  assert.equal(emptyResult.plan.decision, "keep-whole");
  assert.equal(emptyResult.recommendedRoute, "solo");
  assert.equal(emptyResult.recommendedShape.mechanism, "solo");
  assert.equal(emptyResult.recommendedShape.workerCount, 0);
  assert.equal(emptyResult.selectedModel, null);
  assert.equal(emptyResult.selectedEffort, null);
  assert.equal(emptyResult.selection.reason, "solo-no-execution");

  // Tightly coupled shared mutable state -> solo
  const coupledResult = routeAdaptiveTask({
    candidates: [makeCandidate({ label: "c1" }), makeCandidate({ label: "c2" })],
    declared: {
      sharedState: "mutable",
      coreOverlap: "shared-core",
    },
    policy: DEFAULT_POLICY,
  });
  assert.equal(coupledResult.plan.decision, "keep-whole");
  assert.equal(coupledResult.recommendedRoute, "solo");
  assert.equal(coupledResult.recommendedShape.mechanism, "solo");
  assert.equal(coupledResult.recommendedShape.workerCount, 0);
  assert.equal(coupledResult.selectedModel, null);
  assert.equal(coupledResult.selectedEffort, null);
});

test("adaptive routing - single-worker delegation", () => {
  const result = routeAdaptiveTask({
    candidates: [
      makeCandidate({
        label: "Seam 1",
        allowedFiles: ["src/feature-a/**"],
        verificationCommands: ["npm test"],
      }),
    ],
    declared: {
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
    policy: DEFAULT_POLICY,
  });

  assert.equal(result.plan.decision, "keep-whole");
  assert.equal(result.plan.proposedSeamCount, 1);
  assert.equal(result.recommendedRoute, "delegation-plausible");
  assert.equal(result.recommendedShape.mechanism, "delegate_task");
  assert.equal(result.recommendedShape.workerCount, 1);
  assert.equal(result.recommendedShape.concurrency, 1);
  assert.equal(result.selectedModel, "gpt-5.6-luna");
  assert.equal(result.selectedEffort, "high");
  assert.equal(result.selection.reason, "conservative-baseline");
});

test("adaptive routing - sequential multi-worker path for dependent seams", () => {
  const result = routeAdaptiveTask({
    candidates: [
      makeCandidate({
        label: "Step 1",
        allowedFiles: ["src/step1/**"],
      }),
      makeCandidate({
        label: "Step 2",
        allowedFiles: ["src/step2/**"],
      }),
    ],
    declared: {
      seamSize: "substantial",
      sharedState: "read-only",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
    context: {
      mode: "sequential",
    },
    policy: DEFAULT_POLICY,
  });

  assert.equal(result.plan.decision, "split");
  assert.equal(result.plan.proposedSeamCount, 2);
  assert.equal(result.recommendedShape.mechanism, "delegate_tasks_sequential");
  assert.equal(result.recommendedShape.workerCount, 2);
  assert.equal(result.recommendedShape.concurrency, 1);
  assert.equal(result.selectedModel, "gpt-5.6-luna");
  assert.equal(result.selectedEffort, "high");
});

test("adaptive routing - parallel independent seams", () => {
  const result = routeAdaptiveTask({
    candidates: [
      makeCandidate({
        label: "Module A",
        allowedFiles: ["src/module-a/**"],
        verificationCommands: ["npm test -- module-a"],
      }),
      makeCandidate({
        label: "Module B",
        allowedFiles: ["src/module-b/**"],
        verificationCommands: ["npm test -- module-b"],
      }),
    ],
    declared: {
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
    policy: DEFAULT_POLICY,
  });

  assert.equal(result.plan.decision, "split");
  assert.equal(result.plan.dependency, "independent");
  assert.equal(result.plan.proposedSeamCount, 2);
  assert.equal(result.recommendedRoute, "delegation-plausible");
  assert.equal(result.evaluation.parallelEligible, true);
  assert.equal(result.recommendedShape.mechanism, "delegate_tasks_parallel");
  assert.equal(result.recommendedShape.workerCount, 2);
  assert.equal(result.recommendedShape.concurrency, 2);
  assert.equal(result.selectedModel, "gpt-5.6-luna");
  assert.equal(result.selectedEffort, "high");
});

test("adaptive routing - policy-constrained execution clamps workers, concurrency, and effort", () => {
  const tightPolicy = buildComputePolicy({
    model: "gpt-5.6-luna",
    allowedEfforts: ["high"],
    maxConcurrency: 1,
    maxWorkersPerBatch: 2,
    allowEffortEscalation: false,
    allowStrongerFallback: false,
  });

  const result = routeAdaptiveTask({
    candidates: [
      makeCandidate({
        label: "c1",
        allowedFiles: ["src/a/**"],
        verificationCommands: ["test1"],
      }),
      makeCandidate({
        label: "c2",
        allowedFiles: ["src/b/**"],
        verificationCommands: ["test2"],
      }),
      makeCandidate({
        label: "c3",
        allowedFiles: ["src/c/**"],
        verificationCommands: ["test3"],
      }),
      makeCandidate({
        label: "c4",
        allowedFiles: ["src/d/**"],
        verificationCommands: ["test4"],
      }),
    ],
    declared: {
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
    policy: tightPolicy,
  });

  assert.equal(result.recommendedShape.workerCount, 2, "bounded by maxWorkersPerBatch");
  assert.equal(result.recommendedShape.concurrency, 1, "bounded by maxConcurrency");
  assert.equal(result.recommendedShape.seamsOverCap, 2, "over-cap seams reported");
  assert.equal(result.selectedEffort, "high", "bounded by allowedEfforts");
  assert.equal(result.selectedModel, "gpt-5.6-luna");
});

test("adaptive routing - explicit operator ordering and stronger fallback ladder", () => {
  const candidate = makeCandidate({
    allowedFiles: ["src/a/**"],
    verificationCommands: ["test1"],
  });
  const declared = {
    seamSize: "substantial" as const,
    sharedState: "none" as const,
    coreOverlap: "disjoint" as const,
    integration: "mechanical" as const,
    verification: "per-seam" as const,
  };

  // Baseline selects the base model
  const baseline = routeAdaptiveTask({
    candidates: [candidate],
    declared,
    policy: ORDERED_POLICY,
  });
  assert.equal(baseline.selectedModel, "gpt-5.6-luna");
  assert.equal(baseline.selectedEffort, "high");
  assert.equal(baseline.selection.reason, "conservative-baseline");

  // Fallback 1: climbs to gpt-5.6-sol
  const step1 = routeAdaptiveTask({
    candidates: [candidate],
    declared,
    policy: ORDERED_POLICY,
    evidence: {
      requestedModel: "gpt-5.6-luna",
      requestedEffort: "high",
      failureDecision: failure("stronger-executor-fallback"),
    },
  });
  assert.equal(step1.selectedModel, "gpt-5.6-sol");
  assert.equal(step1.selectedEffort, "high");
  assert.equal(step1.selection.reason, "stronger-executor-selected");

  // Fallback 2: climbs to gpt-5.6-sol-max
  const step2 = routeAdaptiveTask({
    candidates: [candidate],
    declared,
    policy: ORDERED_POLICY,
    evidence: {
      requestedModel: "gpt-5.6-sol",
      requestedEffort: "high",
      failureDecision: failure("stronger-executor-fallback"),
    },
  });
  assert.equal(step2.selectedModel, "gpt-5.6-sol-max");
  assert.equal(step2.selectedEffort, "high");
  assert.equal(step2.selection.reason, "stronger-executor-selected");

  // Fallback 3: exhausted at the top of the ladder
  const step3 = routeAdaptiveTask({
    candidates: [candidate],
    declared,
    policy: ORDERED_POLICY,
    evidence: {
      requestedModel: "gpt-5.6-sol-max",
      requestedEffort: "high",
      failureDecision: failure("stronger-executor-fallback"),
    },
  });
  assert.equal(step3.selectedModel, "gpt-5.6-sol-max");
  assert.equal(step3.selectedEffort, "high");
  assert.equal(step3.selection.reason, "stronger-executor-exhausted");
});

test("adaptive routing - unresolved / ambiguous routing stays conservative", () => {
  const ambiguousResult = routeAdaptiveTask({
    candidates: [makeCandidate({ label: "c1" }), makeCandidate({ label: "c2" })],
    policy: DEFAULT_POLICY,
  });

  // With unknown coupling, route biases toward solo
  assert.equal(ambiguousResult.recommendedRoute, "solo");
  assert.ok(ambiguousResult.evaluation.unknownCount > 0);
  assert.equal(ambiguousResult.recommendedShape.mechanism, "solo");
  assert.equal(ambiguousResult.selectedModel, null);
  assert.equal(ambiguousResult.selectedEffort, null);
});

test("adaptive routing - zero-worker envelope yields solo selection", () => {
  const zeroPolicy: ComputePolicy = {
    ...DEFAULT_POLICY,
    maxWorkersPerBatch: 1,
    maxConcurrency: 1,
  };
  const zeroShapeCard = routeAdaptiveCard({
    card: {
      seams: ["s1"],
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
    policy: {
      ...zeroPolicy,
      allowedEfforts: [],
      allowedModels: [],
    },
  });

  assert.equal(zeroShapeCard.selection.reason, "no-authorised-next-execution");
  assert.equal(zeroShapeCard.selectedModel, null);
  assert.equal(zeroShapeCard.selectedEffort, null);
});

test("adaptive routing - telemetry consistency in server and batch execution", async () => {
  const events: OrchestratorEvent[] = [];
  const emit = (event: OrchestratorEvent): void => {
    events.push(event);
  };

  // 1. Single delegation refuseSingleDelegation emits shape and selection fields
  refuseSingleDelegation(
    {
      seams: ["s1"],
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
    "batch-single-1",
    emit,
    ORDERED_POLICY,
  );

  const singleDeclared = events.find(
    (e) => e.type === "routing.declared" && e.batchId === "batch-single-1",
  );
  assert.ok(singleDeclared && singleDeclared.type === "routing.declared");
  assert.equal(singleDeclared.declaration, "attached");
  assert.equal(singleDeclared.route, "delegation-plausible");
  assert.equal(singleDeclared.recommendedMechanism, "delegate_task");
  assert.equal(singleDeclared.recommendedWorkerCount, 1);
  assert.equal(singleDeclared.selectedModel, "gpt-5.6-luna");
  assert.equal(singleDeclared.selectedEffort, "high");
  assert.equal(singleDeclared.selectionReason, "conservative-baseline");

  // 2. Batch delegation emits shape and selection fields
  events.length = 0;
  await runBatch(
    [
      delegateTaskInputSchema.parse({
        objective: "Task 1: Implement the first independent seam thoroughly.",
        effort: "medium",
        effortReason: "Standard task complexity requiring moderate reasoning.",
        acceptanceCriteria: ["AC1 passed"],
        verificationCommands: [],
        allowedFiles: ["src/a.ts"],
      }),
      delegateTaskInputSchema.parse({
        objective: "Task 2: Implement the second independent seam thoroughly.",
        effort: "medium",
        effortReason: "Standard task complexity requiring moderate reasoning.",
        acceptanceCriteria: ["AC2 passed"],
        verificationCommands: [],
        allowedFiles: ["src/b.ts"],
      }),
    ],
    {
      mode: "parallel",
      workingDirectory: process.cwd(),
      routingPreflight: {
        seams: ["s1", "s2"],
        seamSize: "substantial",
        sharedState: "none",
        coreOverlap: "disjoint",
        integration: "mechanical",
        verification: "per-seam",
      },
      computePolicy: ORDERED_POLICY,
      eventEmitter: emit,
      executor: async (taskInput) => ({
        changeIntent: "required",
        verdict: "PASS",
        workerClaimedStatus: "PASS",
        workerClaimedFailureCauses: [],
        trustworthy: true,
        workerThreadId: "thread-x",
        continuationReference: null,
        model: "gpt-5.6-luna",
        effort: taskInput.effort,
        effortReason: "test",
        attempt: 1,
        summary: "did the work",
        notes: "",
        followUps: [],
        filesChanged: [],
        verification: [],
        verificationMode: "allowlist",
        scopeViolations: [],
        discrepancies: [],
        reviewChecklist: [],
        escalationAdvice: null,
        durationSeconds: 1,
        usage: null,
        errors: [],
      }),
    },
  );

  const batchDeclared = events.find((e) => e.type === "routing.declared");
  assert.ok(batchDeclared && batchDeclared.type === "routing.declared");
  assert.equal(batchDeclared.declaration, "attached");
  assert.equal(batchDeclared.recommendedMechanism, "delegate_tasks_parallel");
  assert.equal(batchDeclared.recommendedWorkerCount, 2);
  assert.equal(batchDeclared.selectedModel, "gpt-5.6-luna");
  assert.equal(batchDeclared.selectedEffort, "high");
  assert.equal(batchDeclared.selectionReason, "conservative-baseline");
});

test("adaptive routing - no artificial seam or model hierarchy inferred", () => {
  // Reversing allowedModels has zero effect on ordering
  const reversedPolicy: ComputePolicy = {
    ...ORDERED_POLICY,
    allowedModels: [...ORDERED_POLICY.allowedModels].reverse(),
  };

  const candidate = makeCandidate();
  const declared = {
    seamSize: "substantial" as const,
    sharedState: "none" as const,
    coreOverlap: "disjoint" as const,
    integration: "mechanical" as const,
    verification: "per-seam" as const,
  };

  const resultNormal = routeAdaptiveTask({
    candidates: [candidate],
    declared,
    policy: ORDERED_POLICY,
  });
  const resultReversed = routeAdaptiveTask({
    candidates: [candidate],
    declared,
    policy: reversedPolicy,
  });

  assert.equal(resultNormal.selectedModel, resultReversed.selectedModel);
  assert.equal(resultNormal.selectedEffort, resultReversed.selectedEffort);
  assert.equal(resultNormal.selection.reason, resultReversed.selection.reason);

  // When no executorOrder is declared, multiple allowedModels leaves choice open to parent (null)
  const unrankedPolicy: ComputePolicy = {
    ...DEFAULT_POLICY,
    allowedModels: ["model-x", "model-y"],
  };
  const unrankedResult = routeAdaptiveTask({
    candidates: [candidate],
    declared,
    policy: unrankedPolicy,
  });
  assert.equal(unrankedResult.selectedModel, null);
  assert.equal(unrankedResult.selectedEffort, "high");
  assert.equal(unrankedResult.selection.reason, "conservative-baseline");
});

function makeOutput(overrides: Partial<DelegateTaskOutput> = {}): DelegateTaskOutput {
  return {
    changeIntent: "required",
    verdict: "FAILED",
    workerClaimedStatus: "FAILED",
    workerClaimedFailureCauses: ["implementation"],
    trustworthy: true,
    workerThreadId: "thread-turn-1",
    continuationReference: null,
    model: "gpt-5.6-luna",
    effort: "medium",
    effortReason: "Standard complexity",
    attempt: 1,
    summary: "Attempted implementation but encountered algorithmic bottleneck.",
    notes: "",
    followUps: [],
    filesChanged: [{ path: "src/a.ts", kind: "modified", why: "edited", observed: true }],
    verification: [
      {
        command: "npm test",
        source: "orchestrator",
        execution: "argv",
        exitCode: 1,
        passed: false,
        output: "Tests failed",
      },
    ],
    verificationMode: "allowlist",
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: [],
    escalationAdvice: "Escalate effort.",
    durationSeconds: 12,
    usage: null,
    errors: [],
    attempts: [
      {
        executionId: "exec-turn-1",
        logicalAttempt: 1,
        role: "initial",
        predecessorExecutionId: null,
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "medium",
        threadId: "thread-turn-1",
        threadOperation: "start",
        threadIdentityMatched: null,
        startedAt: new Date(Date.now() - 12000).toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: 12000,
        workerElapsedMs: 12000,
        verificationElapsedMs: 100,
        timeoutMs: 60000,
        termination: { kind: "completed", message: null },
        usage: { status: "unavailable", reason: "no-turn-completed" },
        workerClaimedStatus: "FAILED",
        workerClaimedFailureCauses: ["implementation"],
        verification: [],
      },
    ],
    failureDecision: {
      classification: "effort",
      action: "effort-escalation",
      reason: "Implementation failed due to effort ceiling; escalate to high.",
      evidenceExecutionIds: ["exec-turn-1"],
      nextEffort: "high",
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
    ...overrides,
  };
}

test("adaptive execution - live contract -> seam planning -> routing -> selection", () => {
  const task = delegateTaskInputSchema.parse({
    objective:
      "Implement Feature A across components and tests bounded to src/feature-a.",
    activityLabel: "feature-a-seam",
    effort: "medium",
    effortReason: "Moderate complexity component.",
    allowedFiles: ["src/feature-a/**", "test/feature-a/**"],
    verificationCommands: ["npm test -- feature-a"],
    acceptanceCriteria: ["Feature A works"],
    routingPreflight: {
      seams: ["feature-a-seam"],
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
  });

  // 1. Derive candidate from live contract: globs are NOT split into artificial seams
  const candidate = deriveSeamCandidate(task);
  assert.equal(candidate.label, "feature-a-seam");
  assert.deepEqual(candidate.allowedFiles, ["src/feature-a/**", "test/feature-a/**"]);
  assert.deepEqual(candidate.verificationCommands, ["npm test -- feature-a"]);

  // 2. Derive declared evidence
  const declared = deriveDeclaredEvidence(task.routingPreflight);
  assert.equal(declared?.sharedState, "none");
  assert.equal(declared?.integration, "mechanical");

  // 3. Route live task directly
  const result = routeLiveTask(task, { policy: DEFAULT_POLICY });
  assert.equal(result.plan.decision, "keep-whole");
  assert.equal(result.plan.proposedSeamCount, 1);
  assert.equal(result.recommendedRoute, "delegation-plausible");
  assert.equal(result.recommendedShape.mechanism, "delegate_task");
  assert.equal(result.recommendedShape.workerCount, 1);
  assert.equal(result.selectedModel, "gpt-5.6-luna");
  assert.equal(result.selectedEffort, "high");
});

test("live seam derivation treats task contracts as semantic units, not file globs", () => {
  const first = delegateTaskInputSchema.parse({
    objective: "Implement the first bounded semantic unit.",
    activityLabel: "first-unit",
    effort: "medium",
    effortReason: "Bounded implementation work.",
    allowedFiles: ["src/a/**", "test/a/**"],
    verificationCommands: ["npm test -- a"],
    acceptanceCriteria: ["The first unit passes."],
  });
  const second = delegateTaskInputSchema.parse({
    objective: "Implement the second bounded semantic unit.",
    activityLabel: "second-unit",
    effort: "medium",
    effortReason: "Bounded implementation work.",
    allowedFiles: ["src/b/**", "test/b/**", "fixtures/b/**"],
    verificationCommands: ["npm test -- b"],
    acceptanceCriteria: ["The second unit passes."],
    routingPreflight: {
      seams: ["caller-label-a", "caller-label-b"],
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
  });

  const candidates = deriveSeamCandidates([first, second]);
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((candidate) => candidate.label),
    ["first-unit", "second-unit"],
  );
  assert.deepEqual(candidates[0]!.allowedFiles, ["src/a/**", "test/a/**"]);
  assert.deepEqual(candidates[1]!.allowedFiles, [
    "src/b/**",
    "test/b/**",
    "fixtures/b/**",
  ]);

  const single = routeLiveTask(second, { policy: DEFAULT_POLICY });
  assert.equal(single.plan.proposedSeamCount, 1);
  assert.equal(single.plan.reason, "single-seam");
  assert.deepEqual(single.plan.preflightCard.seams, ["second-unit"]);
});

test("HandoffStore issues opaque references, enforces concurrent single-use and TTL expiration", async () => {
  let currentTime = 1_000_000;
  const store = new HandoffStore({ now: () => currentTime });

  const input = delegateTaskInputSchema.parse({
    objective: "Implement resilient parser.",
    effort: "medium",
    effortReason: "Moderate work.",
    allowedFiles: ["src/parser.ts"],
    acceptanceCriteria: ["Parses successfully."],
    verificationCommands: ["npm test"],
  });

  const failureResult: DelegateTaskOutput = {
    changeIntent: "required",
    verdict: "FAILED",
    workerClaimedStatus: "FAILED",
    workerClaimedFailureCauses: ["verification"],
    trustworthy: true,
    workerThreadId: "thread-1",
    continuationReference: null,
    model: "gpt-5.6-luna",
    effort: "medium",
    effortReason: "Initial run",
    attempt: 1,
    summary: "Verification failed on edge cases",
    notes: "",
    followUps: [],
    filesChanged: [],
    verification: [],
    verificationMode: "allowlist",
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: [],
    escalationAdvice: "escalate-effort",
    durationSeconds: 10,
    usage: null,
    errors: [],
    attempts: [
      {
        executionId: "exec-initial-1",
        logicalAttempt: 1,
        role: "initial",
        predecessorExecutionId: null,
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "medium",
        threadId: "thread-1",
        threadOperation: "start",
        threadIdentityMatched: true,
        startedAt: new Date(currentTime - 10_000).toISOString(),
        finishedAt: new Date(currentTime).toISOString(),
        elapsedMs: 10_000,
        workerElapsedMs: 8_000,
        verificationElapsedMs: 2_000,
        timeoutMs: 600_000,
        termination: { kind: "completed", message: null },
        usage: { status: "unavailable", reason: "no-turn-completed" },
        workerClaimedStatus: "FAILED",
        workerClaimedFailureCauses: ["implementation"],
        verification: [],
      },
    ],
    failureDecision: {
      classification: "effort",
      action: "effort-escalation",
      reason: "Defect required higher effort",
      evidenceExecutionIds: ["exec-initial-1"],
      nextEffort: "high",
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  };

  const ref = registerHandoff(input, failureResult, store, {
    authoritativePrior: true,
  });
  assert.ok(ref);
  assert.ok(isHandoffReference(ref));
  assert.equal(failureResult.handoffState?.status, "issued");

  // Invalid reference
  assert.equal(store.consume("not-a-ref").status, "invalid");
  assert.equal(store.consume("hdf_01234567890123456789012345678901").status, "unknown");

  // Two consumers scheduled together still resolve through one atomic consume:
  // exactly one receives the contract and the other sees the retired reference.
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => store.consume(ref)),
    Promise.resolve().then(() => store.consume(ref)),
  ]);
  const consumed = first.status === "ready" ? first : second;
  const rejected = first.status === "ready" ? second : first;
  assert.equal(consumed.status, "ready");
  assert.equal(rejected.status, "used");
  if (consumed.status === "ready") {
    assert.equal(consumed.entry.predecessorExecutionId, "exec-initial-1");
    assert.equal(consumed.entry.logicalAttempt, 2);
    assert.equal(consumed.entry.model, "gpt-5.6-luna");
    assert.equal(consumed.entry.effort, "medium");
    assert.equal(consumed.entry.failureDecision.nextEffort, "high");
    assert.deepEqual(consumed.entry.input.allowedFiles, ["src/parser.ts"]);
  }

  // Every later consume remains rejected as already used.
  assert.equal(store.consume(ref).status, "used");

  // Expiration behavior
  const ref2 = registerHandoff(input, failureResult, store, {
    authoritativePrior: true,
  });
  assert.ok(ref2);
  currentTime += 20 * 60 * 1000; // Fast forward 20 minutes past TTL
  assert.equal(store.consume(ref2).status, "expired");
});

test("HandoffStore returns not-eligible for PASS, cancellation, and non-retryable actions", () => {
  const store = new HandoffStore();
  const input = delegateTaskInputSchema.parse({
    objective: "Implement resilient parser.",
    effort: "medium",
    effortReason: "Moderate work.",
    allowedFiles: ["src/parser.ts"],
    acceptanceCriteria: ["Parses successfully."],
    verificationCommands: [],
  });

  // 1. Passing result
  const passResult: DelegateTaskOutput = {
    changeIntent: "required",
    verdict: "PASS",
    workerClaimedStatus: "PASS",
    workerClaimedFailureCauses: [],
    trustworthy: true,
    workerThreadId: "thread-1",
    continuationReference: null,
    model: "gpt-5.6-luna",
    effort: "medium",
    effortReason: "Initial run",
    attempt: 1,
    summary: "Done",
    notes: "",
    followUps: [],
    filesChanged: [],
    verification: [],
    verificationMode: "allowlist",
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: [],
    escalationAdvice: null,
    durationSeconds: 10,
    usage: null,
    errors: [],
  };
  assert.equal(registerHandoff(input, passResult, store), null);
  assert.equal(passResult.handoffState?.status, "not-eligible");

  // 2. Cancellation
  const cancelResult: DelegateTaskOutput = {
    ...passResult,
    verdict: "FAILED",
    errors: ["Task was cancelled."],
  };
  assert.equal(registerHandoff(input, cancelResult, store), null);
  assert.equal(cancelResult.handoffState?.status, "not-eligible");

  // 3. Parent takeover failure decision
  const takeoverResult: DelegateTaskOutput = {
    ...passResult,
    verdict: "FAILED",
    failureDecision: {
      classification: "scope-or-conflict",
      action: "parent-takeover",
      reason: "Scope discrepancy requires supervisor",
      evidenceExecutionIds: [],
      nextEffort: null,
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  };
  assert.equal(registerHandoff(input, takeoverResult, store), null);
  assert.equal(takeoverResult.handoffState?.status, "not-eligible");

  // One same-effort retry handoff bootstraps server-authenticated lineage. The
  // next failure sees that lineage and cannot earn another same-effort retry.
  const retryResult: DelegateTaskOutput = {
    ...passResult,
    verdict: "FAILED",
    failureDecision: {
      classification: "implementation",
      action: "retry",
      reason: "A bounded automatic retry was classified.",
      evidenceExecutionIds: [],
      nextEffort: null,
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  };
  assert.ok(registerHandoff(input, retryResult, store));
  assert.equal(retryResult.handoffState?.status, "issued");
});

test("Live handoff preserves immutable contract fields and protects against caller tampering", async () => {
  const store = new HandoffStore();
  const originalInput = delegateTaskInputSchema.parse({
    objective: "Implement parser securely.",
    effort: "medium",
    effortReason: "Moderate work.",
    allowedFiles: ["src/secure-parser.ts"],
    forbiddenFiles: ["src/secret.key"],
    changeIntent: "required",
    acceptanceCriteria: ["Tests pass."],
    verificationCommands: ["npm test"],
    timeoutSeconds: 321,
    activityLabel: "authoritative-label",
    workingDirectory: process.cwd(),
    computePolicy: { allowStrongerFallback: false },
  });

  const failureResult: DelegateTaskOutput = {
    changeIntent: "required",
    verdict: "FAILED",
    workerClaimedStatus: "FAILED",
    workerClaimedFailureCauses: ["verification"],
    trustworthy: true,
    workerThreadId: "thread-1",
    continuationReference: null,
    model: "gpt-5.6-luna",
    effort: "medium",
    effortReason: "Initial run",
    attempt: 1,
    summary: "Failed on tests",
    notes: "",
    followUps: [],
    filesChanged: [],
    verification: [],
    verificationMode: "allowlist",
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: [],
    escalationAdvice: "escalate-effort",
    durationSeconds: 10,
    usage: null,
    errors: [],
    attempts: [
      {
        executionId: "exec-turn-1",
        logicalAttempt: 1,
        role: "initial",
        predecessorExecutionId: null,
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "medium",
        threadId: "thread-1",
        threadOperation: "start",
        threadIdentityMatched: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: 10_000,
        workerElapsedMs: 8_000,
        verificationElapsedMs: 2_000,
        timeoutMs: 600_000,
        termination: { kind: "completed", message: null },
        usage: { status: "unavailable", reason: "no-turn-completed" },
        workerClaimedStatus: "FAILED",
        workerClaimedFailureCauses: ["implementation"],
        verification: [],
      },
    ],
    failureDecision: {
      classification: "effort",
      action: "effort-escalation",
      reason: "Needs more reasoning capacity",
      evidenceExecutionIds: ["exec-turn-1"],
      nextEffort: "high",
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  };

  const handoffRef = registerHandoff(originalInput, failureResult, store, {
    authoritativePrior: true,
  });
  assert.ok(handoffRef);

  // Caller attempts to tamper with allowedFiles, forbiddenFiles, and objective when supplying handoffReference
  const tamperedInput = delegateTaskInputSchema.parse({
    objective: "TAMPERED: Read everything.",
    effort: "medium",
    effortReason: "Tampered reason.",
    allowedFiles: ["src/**", "config/**"], // Widened scope
    forbiddenFiles: [], // Removed forbidden files
    changeIntent: "optional",
    acceptanceCriteria: ["Whatever passes."],
    verificationCommands: [],
    timeoutSeconds: 999,
    activityLabel: "tampered-label",
    workingDirectory: path.dirname(process.cwd()),
    computePolicy: { allowStrongerFallback: true },
    handoffReference: handoffRef,
  });

  let executedInput: DelegateTaskInput | null = null;
  let executedModel: string | null = null;
  let executedLogicalAttempt: number | null = null;
  let executedPredecessor: string | null = null;

  await runBatch([tamperedInput], {
    mode: "sequential",
    workingDirectory: process.cwd(),
    computePolicy: ORDERED_POLICY,
    handoffStore: store,
    executor: async (input, options) => {
      executedInput = input;
      executedModel = options?.model ?? null;
      executedLogicalAttempt = options?.logicalAttempt ?? null;
      executedPredecessor = options?.predecessorExecutionId ?? null;
      return {
        changeIntent: input.changeIntent,
        verdict: "PASS",
        workerClaimedStatus: "PASS",
        workerClaimedFailureCauses: [],
        trustworthy: true,
        workerThreadId: "thread-2",
        continuationReference: null,
        model: options?.model ?? "gpt-5.6-luna",
        effort: input.effort,
        effortReason: "Turn 2",
        attempt: options?.logicalAttempt ?? 2,
        summary: "Fixed and verified.",
        notes: "",
        followUps: [],
        filesChanged: [],
        verification: [],
        verificationMode: "allowlist",
        scopeViolations: [],
        discrepancies: [],
        reviewChecklist: [],
        escalationAdvice: null,
        durationSeconds: 5,
        usage: null,
        errors: [],
      };
    },
  });

  // Verify that the server strictly restored the immutable contract fields
  assert.ok(executedInput !== null);
  const actualInput = executedInput as DelegateTaskInput;
  assert.equal(actualInput.objective, "Implement parser securely.");
  assert.deepEqual(actualInput.allowedFiles, ["src/secure-parser.ts"]);
  assert.deepEqual(actualInput.forbiddenFiles, ["src/secret.key"]);
  assert.equal(actualInput.changeIntent, "required");
  assert.deepEqual(actualInput.acceptanceCriteria, ["Tests pass."]);
  assert.deepEqual(actualInput.verificationCommands, ["npm test"]);
  assert.equal(actualInput.timeoutSeconds, 321);
  assert.equal(actualInput.activityLabel, "authoritative-label");
  assert.equal(actualInput.workingDirectory, process.cwd());
  assert.equal(actualInput.computePolicy?.allowStrongerFallback, false);

  // Verify compute escalation and lineage propagation
  assert.equal(actualInput.effort, "high"); // Escalated from medium to high
  assert.equal(executedModel, "gpt-5.6-luna");
  assert.equal(executedLogicalAttempt, 2);
  assert.equal(executedPredecessor, "exec-turn-1");
});

test("Live adaptive dispatch routes selected model and effort across batch tasks and passes to workers", async () => {
  const recordedExecutions: Array<{ taskId: string; model: string; effort: string }> = [];
  const sdkTurns: ThreadOptions[] = [];

  const batchResults = await runBatch(
    [
      delegateTaskInputSchema.parse({
        objective: "Implement first component.",
        effort: "medium",
        effortReason: "Standard task.",
        allowedFiles: ["src/comp1.ts"],
        changeIntent: "optional",
        acceptanceCriteria: ["Passes"],
        verificationCommands: [],
      }),
      delegateTaskInputSchema.parse({
        objective: "Implement second component.",
        effort: "high",
        effortReason: "Complex task.",
        allowedFiles: ["src/comp2.ts"],
        changeIntent: "optional",
        acceptanceCriteria: ["Passes"],
        verificationCommands: [],
      }),
    ],
    {
      mode: "parallel",
      workingDirectory: process.cwd(),
      computePolicy: ORDERED_POLICY,
      routingPreflight: {
        seams: ["s1", "s2"],
        seamSize: "substantial",
        sharedState: "none",
        coreOverlap: "disjoint",
        integration: "mechanical",
        verification: "per-seam",
      },
      executor: async (input, options) => {
        recordedExecutions.push({
          taskId: (input as any).activityLabel ?? input.objective.slice(0, 15),
          model: options?.model ?? "unknown",
          effort: input.effort,
        });
        const events = async function* (): AsyncGenerator<ThreadEvent> {
          yield {
            type: "item.completed",
            item: {
              id: "message",
              type: "agent_message",
              text: JSON.stringify({
                status: "PASS",
                failureCauses: [],
                summary: "Done",
                filesChanged: [],
                verification: [],
                notes: "",
                followUps: [],
              }),
            },
          };
        };
        const codex: WorkerCodex = {
          startThread: (threadOptions) => {
            sdkTurns.push(threadOptions);
            return {
              id: `thread-${sdkTurns.length}`,
              runStreamed: async () => ({ events: events() }),
            };
          },
          resumeThread: () => {
            throw new Error("initial adaptive batch turns must start fresh threads");
          },
        };
        return executeTask(input, { ...options, codex });
      },
    },
  );

  assert.equal(batchResults.passed, 2);
  assert.equal(recordedExecutions.length, 2);
  assert.equal(recordedExecutions[0]!.model, "gpt-5.6-luna");
  assert.equal(recordedExecutions[1]!.model, "gpt-5.6-luna");
  assert.equal(recordedExecutions[0]!.effort, "high");
  assert.equal(recordedExecutions[1]!.effort, "high");
  assert.equal(sdkTurns.length, 2);
  assert.ok(sdkTurns.every((turn) => turn.model === "gpt-5.6-luna"));
  assert.ok(sdkTurns.every((turn) => turn.modelReasoningEffort === "high"));
});

test("Multi-step escalation ladder climbs effort rungs then stronger executors through handoff references", async () => {
  const store = new HandoffStore();

  const originalTask = delegateTaskInputSchema.parse({
    objective: "Implement tough algorithmic invariant.",
    effort: "medium",
    effortReason: "Initial baseline effort.",
    allowedFiles: ["src/algo.ts"],
    acceptanceCriteria: ["All invariant tests pass."],
    verificationCommands: ["npm test"],
  });

  // --- Step 1: Initial run at medium effort fails ---
  const result1: DelegateTaskOutput = {
    changeIntent: "required",
    verdict: "FAILED",
    workerClaimedStatus: "FAILED",
    workerClaimedFailureCauses: ["verification"],
    trustworthy: true,
    workerThreadId: "thread-step-1",
    continuationReference: null,
    model: "gpt-5.6-luna",
    effort: "medium",
    effortReason: "Step 1",
    attempt: 1,
    summary: "Step 1 failed",
    notes: "",
    followUps: [],
    filesChanged: [],
    verification: [],
    verificationMode: "allowlist",
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: [],
    escalationAdvice: "escalate-effort",
    durationSeconds: 10,
    usage: null,
    errors: [],
    attempts: [
      {
        executionId: "exec-1",
        logicalAttempt: 1,
        role: "initial",
        predecessorExecutionId: null,
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "medium",
        threadId: "thread-step-1",
        threadOperation: "start",
        threadIdentityMatched: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: 10_000,
        workerElapsedMs: 8_000,
        verificationElapsedMs: 2_000,
        timeoutMs: 600_000,
        termination: { kind: "completed", message: null },
        usage: { status: "unavailable", reason: "no-turn-completed" },
        workerClaimedStatus: "FAILED",
        workerClaimedFailureCauses: ["verification"],
        verification: [],
      },
    ],
    failureDecision: {
      classification: "effort",
      action: "effort-escalation",
      reason: "Defect needs more effort",
      evidenceExecutionIds: ["exec-1"],
      nextEffort: "high",
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  };
  const ref1 = registerHandoff(originalTask, result1, store, {
    authoritativePrior: true,
  });
  assert.ok(ref1);

  // --- Step 2: Consume handoff 1 -> executes at high effort -> fails with max effort advice ---
  let run2Input: DelegateTaskInput | null = null;
  let run2Model: string | null = null;
  await runBatch(
    [
      delegateTaskInputSchema.parse({
        ...originalTask,
        handoffReference: ref1,
      }),
    ],
    {
      mode: "sequential",
      workingDirectory: process.cwd(),
      computePolicy: ORDERED_POLICY,
      handoffStore: store,
      executor: async (input, options) => {
        run2Input = input;
        run2Model = options?.model ?? null;
        return {
          ...result1,
          effort: input.effort,
          attempt: options?.logicalAttempt ?? 2,
          failureDecision: {
            classification: "effort",
            action: "effort-escalation",
            reason: "Still failing at high effort",
            evidenceExecutionIds: ["exec-2"],
            nextEffort: "max",
            automaticHandler: null,
            automaticRetryCount: 0,
            automaticRetryLimit: 1,
          },
        };
      },
    },
  );
  assert.equal(run2Input!.effort, "high");
  assert.equal(run2Model, "gpt-5.6-luna");

  const result2: DelegateTaskOutput = {
    ...result1,
    effort: "high",
    attempt: 2,
    attempts: [
      ...result1.attempts!,
      {
        executionId: "exec-2",
        logicalAttempt: 2,
        role: "initial",
        predecessorExecutionId: "exec-1",
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "high",
        threadId: "thread-step-2",
        threadOperation: "start",
        threadIdentityMatched: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: 10_000,
        workerElapsedMs: 8_000,
        verificationElapsedMs: 2_000,
        timeoutMs: 600_000,
        termination: { kind: "completed", message: null },
        usage: { status: "unavailable", reason: "no-turn-completed" },
        workerClaimedStatus: "FAILED",
        workerClaimedFailureCauses: ["verification"],
        verification: [],
      },
    ],
    failureDecision: {
      classification: "effort",
      action: "effort-escalation",
      reason: "Still failing at high effort",
      evidenceExecutionIds: ["exec-2"],
      nextEffort: "max",
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  };
  const ref2 = registerHandoff(run2Input!, result2, store, {
    authoritativePrior: true,
  });
  assert.ok(ref2);

  // --- Step 3: Consume handoff 2 -> climbs one rung from high to xhigh ---
  let run3Input: DelegateTaskInput | null = null;
  let run3Model: string | null = null;
  await runBatch(
    [
      delegateTaskInputSchema.parse({
        ...originalTask,
        handoffReference: ref2,
      }),
    ],
    {
      mode: "sequential",
      workingDirectory: process.cwd(),
      computePolicy: ORDERED_POLICY,
      handoffStore: store,
      executor: async (input, options) => {
        run3Input = input;
        run3Model = options?.model ?? null;
        return {
          ...result2,
          effort: input.effort,
          attempt: options?.logicalAttempt ?? 3,
          failureDecision: {
            classification: "effort",
            action: "effort-escalation",
            reason: "Still failing at xhigh effort",
            evidenceExecutionIds: ["exec-3"],
            nextEffort: "max",
            automaticHandler: null,
            automaticRetryCount: 0,
            automaticRetryLimit: 1,
          },
        };
      },
    },
  );
  assert.equal(run3Input!.effort, "xhigh");
  assert.equal(run3Model, "gpt-5.6-luna");

  const result3: DelegateTaskOutput = {
    ...result2,
    effort: "xhigh",
    attempt: 3,
    attempts: [
      ...result2.attempts!,
      {
        executionId: "exec-3",
        logicalAttempt: 3,
        role: "initial",
        predecessorExecutionId: "exec-2",
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "xhigh",
        threadId: "thread-step-3",
        threadOperation: "start",
        threadIdentityMatched: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: 10_000,
        workerElapsedMs: 8_000,
        verificationElapsedMs: 2_000,
        timeoutMs: 600_000,
        termination: { kind: "completed", message: null },
        usage: { status: "unavailable", reason: "no-turn-completed" },
        workerClaimedStatus: "FAILED",
        workerClaimedFailureCauses: ["verification"],
        verification: [],
      },
    ],
    failureDecision: {
      classification: "effort",
      action: "effort-escalation",
      reason: "Still failing at xhigh effort",
      evidenceExecutionIds: ["exec-3"],
      nextEffort: "max",
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  };
  const ref3 = registerHandoff(run3Input!, result3, store, {
    authoritativePrior: true,
  });
  assert.ok(ref3);

  // --- Step 4: Consume handoff 3 -> climbs one rung from xhigh to max ---
  let run4Input: DelegateTaskInput | null = null;
  let run4Model: string | null = null;
  await runBatch(
    [
      delegateTaskInputSchema.parse({
        ...originalTask,
        handoffReference: ref3,
      }),
    ],
    {
      mode: "sequential",
      workingDirectory: process.cwd(),
      computePolicy: ORDERED_POLICY,
      handoffStore: store,
      executor: async (input, options) => {
        run4Input = input;
        run4Model = options?.model ?? null;
        return {
          ...result3,
          effort: input.effort,
          attempt: options?.logicalAttempt ?? 4,
          failureDecision: {
            classification: "capability",
            action: "stronger-executor-fallback",
            reason: "Luna exhausted at max effort, fall back to stronger executor",
            evidenceExecutionIds: ["exec-4"],
            nextEffort: null,
            automaticHandler: null,
            automaticRetryCount: 0,
            automaticRetryLimit: 1,
          },
        };
      },
    },
  );
  assert.equal(run4Input!.effort, "max");
  assert.equal(run4Model, "gpt-5.6-luna");

  const result4: DelegateTaskOutput = {
    ...result3,
    effort: "max",
    attempt: 4,
    attempts: [
      ...result3.attempts!,
      {
        executionId: "exec-4",
        logicalAttempt: 4,
        role: "initial",
        predecessorExecutionId: "exec-3",
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "max",
        threadId: "thread-step-4",
        threadOperation: "start",
        threadIdentityMatched: true,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMs: 10_000,
        workerElapsedMs: 8_000,
        verificationElapsedMs: 2_000,
        timeoutMs: 600_000,
        termination: { kind: "completed", message: null },
        usage: { status: "unavailable", reason: "no-turn-completed" },
        workerClaimedStatus: "FAILED",
        workerClaimedFailureCauses: ["verification"],
        verification: [],
      },
    ],
    failureDecision: {
      classification: "capability",
      action: "stronger-executor-fallback",
      reason: "Luna exhausted at max effort, fall back to stronger executor",
      evidenceExecutionIds: ["exec-4"],
      nextEffort: null,
      automaticHandler: null,
      automaticRetryCount: 0,
      automaticRetryLimit: 1,
    },
  };
  const ref4 = registerHandoff(run4Input!, result4, store, {
    authoritativePrior: true,
  });
  assert.ok(ref4);

  // --- Step 5: Consume handoff 4 -> falls back to stronger executor gpt-5.6-sol ---
  let run5Input: DelegateTaskInput | null = null;
  let run5Model: string | null = null;
  await runBatch(
    [
      delegateTaskInputSchema.parse({
        ...originalTask,
        handoffReference: ref4,
      }),
    ],
    {
      mode: "sequential",
      workingDirectory: process.cwd(),
      computePolicy: ORDERED_POLICY,
      handoffStore: store,
      executor: async (input, options) => {
        run5Input = input;
        run5Model = options?.model ?? null;
        return {
          ...result4,
          model: options?.model ?? "gpt-5.6-sol",
          effort: input.effort,
          attempt: options?.logicalAttempt ?? 5,
        };
      },
    },
  );
  assert.equal(run5Model, "gpt-5.6-sol");
  assert.equal(run5Input!.effort, "max");
});

test("Caller-supplied previousAttempts without a handoff reference cannot claim higher effort or bypass baseline selection", async () => {
  const store = new HandoffStore();

  // Caller invents fake previousAttempts claiming a prior failure that demanded high/max effort or stronger fallback
  const forgedTask = delegateTaskInputSchema.parse({
    objective: "Implement forged task with sufficient description.",
    effort: "medium",
    effortReason: "Baseline initial run.",
    allowedFiles: ["src/forged.ts"],
    changeIntent: "optional",
    acceptanceCriteria: ["Passes"],
    verificationCommands: [],
    previousAttempts: [
      {
        effort: "max",
        verdict: "FAILED",
        whatWentWrong: "Claimed failure requiring gpt-5.6-sol",
      },
    ],
  });

  let executedModel: string | null = null;
  let executedEffort: string | null = null;

  const forgedResult = await runBatch([forgedTask], {
    mode: "sequential",
    workingDirectory: process.cwd(),
    computePolicy: ORDERED_POLICY,
    handoffStore: store,
    executor: async (input, options) => {
      executedModel = options?.model ?? null;
      executedEffort = input.effort;
      return {
        changeIntent: input.changeIntent,
        verdict: "FAILED",
        workerClaimedStatus: "FAILED",
        workerClaimedFailureCauses: ["implementation"],
        trustworthy: true,
        workerThreadId: "thread-fake",
        continuationReference: null,
        model: options?.model ?? "gpt-5.6-luna",
        effort: input.effort,
        effortReason: "ok",
        attempt: 1,
        summary: "Implementation still failed.",
        notes: "",
        followUps: [],
        filesChanged: [],
        verification: [],
        verificationMode: "allowlist",
        scopeViolations: [],
        discrepancies: [],
        reviewChecklist: [],
        escalationAdvice: null,
        durationSeconds: 1,
        usage: null,
        errors: [],
      };
    },
  });

  // The forged history neither changes this execution nor creates authority for
  // the escalation decision produced after its real implementation failure.
  assert.equal(executedModel, "gpt-5.6-luna");
  assert.equal(executedEffort, "medium");
  assert.equal(
    forgedResult.tasks[0]?.result?.failureDecision?.action,
    "effort-escalation",
  );
  assert.equal(forgedResult.tasks[0]?.handoffReference, null);
  assert.equal(forgedResult.tasks[0]?.handoffState?.status, "not-eligible");
});

test("Live batch registers handoffs for eligible failed tasks and ignores successful siblings", async () => {
  const store = new HandoffStore();
  const events: OrchestratorEvent[] = [];

  const task1 = delegateTaskInputSchema.parse({
    objective: "Implement the first component that passes cleanly.",
    effort: "medium",
    effortReason: "Task 1 reasonable effort.",
    allowedFiles: ["src/task1.ts"],
    changeIntent: "optional",
    acceptanceCriteria: ["Passes"],
    verificationCommands: [],
  });

  const task2 = delegateTaskInputSchema.parse({
    objective: "Implement the second component that fails on verification.",
    effort: "medium",
    effortReason: "Task 2 reasonable effort.",
    allowedFiles: ["src/task2.ts"],
    acceptanceCriteria: ["Passes"],
    verificationCommands: [],
  });

  const batchResults = await runBatch([task1, task2], {
    mode: "sequential",
    workingDirectory: process.cwd(),
    computePolicy: ORDERED_POLICY,
    handoffStore: store,
    eventEmitter: (event) => events.push(event),
    executor: async (input) => {
      if (input.objective.includes("first component")) {
        return {
          changeIntent: input.changeIntent,
          verdict: "PASS",
          workerClaimedStatus: "PASS",
          workerClaimedFailureCauses: [],
          trustworthy: true,
          workerThreadId: "thread-1",
          continuationReference: null,
          model: "gpt-5.6-luna",
          effort: input.effort,
          effortReason: "ok",
          attempt: 1,
          summary: "Done",
          notes: "",
          followUps: [],
          filesChanged: [],
          verification: [],
          verificationMode: "allowlist",
          scopeViolations: [],
          discrepancies: [],
          reviewChecklist: [],
          escalationAdvice: null,
          durationSeconds: 1,
          usage: null,
          errors: [],
        };
      }
      return {
        changeIntent: input.changeIntent,
        verdict: "FAILED",
        workerClaimedStatus: "FAILED",
        workerClaimedFailureCauses: ["implementation"],
        trustworthy: true,
        workerThreadId: "thread-2",
        continuationReference: null,
        model: "gpt-5.6-luna",
        effort: input.effort,
        effortReason: "failed",
        attempt: 1,
        summary: "Implementation failed.",
        notes: "",
        followUps: [],
        filesChanged: [],
        verification: [],
        verificationMode: "allowlist",
        scopeViolations: [],
        discrepancies: [],
        reviewChecklist: [],
        escalationAdvice: "retry",
        durationSeconds: 1,
        usage: null,
        errors: [],
        failureDecision: {
          classification: "implementation",
          action: "retry",
          reason: "One same-effort retry is warranted.",
          evidenceExecutionIds: [],
          nextEffort: null,
          automaticHandler: null,
          automaticRetryCount: 0,
          automaticRetryLimit: 1,
        },
      };
    },
  });

  assert.equal(batchResults.passed, 1);
  assert.equal(batchResults.failed, 1);

  // Task 1 was PASS -> no handoff issued
  assert.equal(batchResults.tasks[0]!.handoffReference, null);
  assert.equal(batchResults.tasks[0]!.taskId, "t1");
  assert.equal(batchResults.tasks[0]!.state, "completed");
  assert.equal(batchResults.tasks[0]!.result?.verdict, "PASS");

  // Task 2 was FAILED with one bounded retry -> handoff issued!
  const task2Handoff = batchResults.tasks[1]!.handoffReference;
  assert.ok(task2Handoff);
  assert.ok(isHandoffReference(task2Handoff));
  assert.equal(batchResults.tasks[1]!.handoffState?.status, "issued");
  assert.equal(batchResults.tasks[1]!.taskId, "t2");
  assert.equal(batchResults.tasks[1]!.state, "completed");
  assert.equal(JSON.stringify(events).includes(task2Handoff), false);

  // Consume task 2 handoff
  const consumed = store.consume(task2Handoff);
  assert.equal(consumed.status, "ready");
  if (consumed.status === "ready") {
    assert.equal(
      consumed.entry.input.objective,
      "Implement the second component that fails on verification.",
    );
    const failedExecutionId =
      batchResults.tasks[1]!.result?.attempts?.at(-1)?.executionId;
    const siblingExecutionId =
      batchResults.tasks[0]!.result?.attempts?.at(-1)?.executionId;
    assert.equal(consumed.entry.predecessorExecutionId, failedExecutionId);
    assert.notEqual(consumed.entry.predecessorExecutionId, siblingExecutionId);
    assert.deepEqual(
      consumed.entry.attemptEvidence.map((attempt) => attempt.executionId),
      [failedExecutionId],
    );
  }

  // Usage/event history intentionally records execution facts, never bearer
  // references returned to the direct caller.
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-handoff-"));
  try {
    const eventsFile = path.join(tempDirectory, "events.jsonl");
    recordEvent(batchResults.tasks[1]!.result!, eventsFile);
    assert.equal(fs.readFileSync(eventsFile, "utf8").includes(task2Handoff), false);
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
