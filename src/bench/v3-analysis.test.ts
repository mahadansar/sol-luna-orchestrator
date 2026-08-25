import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeV3,
  recommendV3ThirdRepetition,
  type RunRecordCompatible,
} from "./v3-analysis.js";

const record = (overrides: Partial<RunRecordCompatible> = {}): RunRecordCompatible => ({
  taskId: "task",
  arm: "adaptive-medium",
  repetition: 1,
  taskCategory: "implementation",
  workloadClass: "medium",
  durationSeconds: 10,
  passed: true,
  workerCount: 0,
  workerEfforts: [],
  delegations: [],
  verificationFailed: 0,
  integrationConflicts: 0,
  workerFailures: [],
  agentError: null,
  breakdown: {
    supervisorBeforeSeconds: 1,
    worktreeSetupSeconds: 1,
    workerWindowSeconds: null,
    slowestWorkerSeconds: null,
    integrationSeconds: 1,
    supervisorAfterSeconds: 1,
    peakConcurrency: null,
  },
  creditAccounting: {
    pricingProfileId: "test",
    actualCredits: null,
    participants: [],
    rateCardCredits: { total: 10, sol: 7, luna: 3 },
  },
  ...overrides,
});

test("V3 reports routing/workload, telemetry, and evaluator diagnostics without changing correctness", () => {
  const records = [
    record({
      taskId: "coupled",
      arm: "adaptive-medium",
      repetition: 1,
      workerCount: 2,
      durationSeconds: 20,
      breakdown: {
        workerWindowSeconds: 12,
        slowestWorkerSeconds: 10,
        supervisorBeforeSeconds: null,
        worktreeSetupSeconds: null,
        integrationSeconds: null,
        supervisorAfterSeconds: null,
        peakConcurrency: 2,
      },
      verificationFailed: 1,
      integrationConflicts: 1,
      agentError: "worker timed out",
      delegations: [
        {
          model: "luna",
          effort: "medium",
          verdict: "retry",
          attempt: 1,
          recoveryClassification: "retry",
          durationSeconds: 10,
          usage: null,
        },
      ],
    }),
    record({
      taskId: "coupled",
      arm: "adaptive-medium",
      repetition: 2,
      workerCount: 0,
      durationSeconds: 10,
      passed: false,
    }),
    record({
      taskId: "obvious",
      arm: "adaptive-medium",
      repetition: 1,
      workerCount: 1,
      taskCategory: "small",
    }),
    record({
      taskId: "candidate",
      arm: "adaptive-medium",
      repetition: 1,
      workerCount: 0,
      taskCategory: "medium",
    }),
    record({
      taskId: "solo",
      arm: "solo-medium",
      repetition: 1,
      workerCount: 0,
      taskCategory: "small",
    }),
  ];
  const analysis = analyzeV3(records, {
    coupled: { routingCategory: "coupled-control", workload: "coupled", coupled: true },
    obvious: { routingCategory: "small", workload: "small", obviousSolo: true },
    candidate: {
      routingCategory: "medium",
      workload: "medium",
      delegationCandidate: true,
    },
    solo: { routingCategory: "small", workload: "small" },
  });
  const coupled = analysis.cells.find((cell) => cell.taskId === "coupled")!;
  assert.equal(coupled.passed, 1);
  assert.equal(coupled.failed, 1);
  assert.equal(coupled.passRate, 0.5);
  assert.equal(coupled.delegationRate, 0.5);
  assert.equal(coupled.zeroWorkerRate, 0.5);
  assert.deepEqual(coupled.workerCounts.min, 0);
  assert.deepEqual(coupled.workerCounts.max, 2);
  assert.equal(coupled.workerCountStable, false);
  assert.equal(coupled.routingChanges, 1);
  assert.equal(coupled.routingOutcome, "routing changed between repetitions");
  assert.equal(coupled.solCredits.median, 7);
  assert.equal(coupled.lunaCredits.median, 3);
  assert.equal(coupled.totalCredits.median, 10);
  assert.equal(coupled.endToEndLatencySeconds.median, 15);
  assert.equal(coupled.workerWindowSeconds.median, 12);
  assert.equal(coupled.slowestWorkerSeconds.median, 10);
  assert.equal(coupled.timeoutIncidence, 0.5);
  assert.equal(coupled.recoveryIncidence, 0.5);
  assert.equal(coupled.stragglerIncidence, 1);
  assert.equal(coupled.verificationFailureIncidence, 0.5);
  assert.equal(coupled.integrationConflictIncidence, 0.5);
  assert.ok(analysis.coupledOrControlDelegated.includes("coupled\0adaptive-medium"));
  assert.ok(analysis.obviousSoloDelegated.includes("obvious\0adaptive-medium"));
  assert.deepEqual(analysis.adaptiveStayedSolo, ["candidate"]);
  assert.equal(analysis.verificationFailures, 1);
  assert.equal(analysis.integrationConflicts, 1);
  assert.equal(
    analysis.byRoutingCategory.find((group) => group.key === "small")?.runs,
    2,
  );
  assert.equal(
    analysis.byRoutingCategory.find((group) => group.key === "coupled-control")
      ?.delegationRate,
    0.5,
  );
});

test("evaluator routing expectation is descriptive and never determines pass/fail", () => {
  const analysis = analyzeV3([record({ passed: true, workerCount: 1 })], {
    task: { routingCategory: "expected-solo", obviousSolo: true },
  });
  const cell = analysis.cells[0]!;
  assert.equal(cell.passed, 1);
  assert.equal(cell.passRate, 1);
  assert.equal(cell.routingOutcome, "delegated despite Solo expectation");
  assert.equal(cell.routingCategory, "expected-solo");
});

test("economic labels apply only to Adaptive runs that actually delegated", () => {
  const analysis = analyzeV3([
    record({
      taskId: "benefit",
      arm: "solo-medium",
      workerCount: 0,
      creditAccounting: {
        pricingProfileId: "x",
        actualCredits: null,
        participants: [],
        rateCardCredits: { total: 12, sol: 12, luna: 0 },
      },
    }),
    record({
      taskId: "benefit",
      arm: "adaptive-medium",
      workerCount: 2,
      creditAccounting: {
        pricingProfileId: "x",
        actualCredits: null,
        participants: [],
        rateCardCredits: { total: 10, sol: 6, luna: 4 },
      },
    }),
    record({
      taskId: "harm",
      arm: "solo-medium",
      workerCount: 0,
      creditAccounting: {
        pricingProfileId: "x",
        actualCredits: null,
        participants: [],
        rateCardCredits: { total: 8, sol: 8, luna: 0 },
      },
    }),
    record({
      taskId: "harm",
      arm: "adaptive-medium",
      workerCount: 1,
      creditAccounting: {
        pricingProfileId: "x",
        actualCredits: null,
        participants: [],
        rateCardCredits: { total: 11, sol: 7, luna: 4 },
      },
    }),
    record({ taskId: "no-worker", arm: "solo-medium", workerCount: 0 }),
    record({ taskId: "no-worker", arm: "adaptive-medium", workerCount: 0 }),
  ]);
  assert.deepEqual(
    analysis.economicComparisons.map(({ taskId, label }) => [taskId, label]),
    [
      ["benefit", "beneficial delegation"],
      ["harm", "harmful delegation"],
    ],
  );
});

test("missing telemetry remains unknown rather than becoming zero", () => {
  const cell = analyzeV3([
    record({
      workerCount: null,
      durationSeconds: undefined,
      breakdown: undefined,
      verificationFailed: undefined,
      integrationConflicts: undefined,
      delegations: undefined,
      creditAccounting: undefined,
    }),
  ]).cells[0]!;
  assert.equal(cell.delegationRate, null);
  assert.equal(cell.zeroWorkerRate, null);
  assert.equal(cell.workerCounts.median, null);
  assert.equal(cell.totalCredits.median, null);
  assert.equal(cell.workerWindowSeconds.median, null);
  assert.equal(cell.verificationFailureIncidence, null);
  assert.equal(cell.integrationConflictIncidence, null);
});

const pair = (
  overrides: [Partial<RunRecordCompatible>, Partial<RunRecordCompatible>],
) => [
  record({ repetition: 1, ...overrides[0] }),
  record({ repetition: 2, ...overrides[1] }),
];

test("every V3 third-repetition trigger is deterministic", () => {
  assert.match(
    recommendV3ThirdRepetition(pair([{ passed: true }, { passed: false }]))!.reasons[0]!,
    /PASS\/FAIL/,
  );
  assert.ok(
    recommendV3ThirdRepetition(
      pair([{ durationSeconds: 10 }, { durationSeconds: 14 }]),
    )!.reasons.includes("end-to-end latency relative range >=25%"),
  );
  assert.ok(
    recommendV3ThirdRepetition(
      pair([
        {
          creditAccounting: {
            pricingProfileId: "x",
            actualCredits: null,
            participants: [],
            rateCardCredits: { total: 10, sol: null, luna: null },
          },
        },
        {
          creditAccounting: {
            pricingProfileId: "x",
            actualCredits: null,
            participants: [],
            rateCardCredits: { total: 13, sol: null, luna: null },
          },
        },
      ]),
    )!.reasons.includes("total-credit relative range >=20%"),
  );
  assert.ok(
    recommendV3ThirdRepetition(
      pair([{ workerCount: 0 }, { workerCount: 1 }]),
    )!.reasons.includes("Adaptive routing changed between repetitions"),
  );
  assert.ok(
    recommendV3ThirdRepetition(
      pair([{ workerCount: 0 }, { workerCount: 2 }]),
    )!.reasons.includes("worker-count absolute difference >=2"),
  );
  const nearTie = recommendV3ThirdRepetition(
    pair([{ workerCount: 0 }, { workerCount: 0 }]),
    pair([
      { arm: "solo-medium", taskId: "task", workerCount: 0 },
      { arm: "solo-medium", taskId: "task", workerCount: 0 },
    ]),
  );
  assert.ok(
    nearTie?.reasons.includes(
      "non-Solo correctness-equivalent economic near-tie (median total credits within 10% of Solo)",
    ),
  );
});

test("a Solo-vs-Solo economic near-tie never triggers", () => {
  const recommendation = recommendV3ThirdRepetition(
    pair([{ arm: "solo-medium" }, { arm: "solo-medium" }]),
    pair([{ arm: "solo-medium" }, { arm: "solo-medium" }]),
  );
  assert.equal(recommendation, null);
});

test("repetition recommendation requires exactly the two initial repetitions", () => {
  assert.equal(
    recommendV3ThirdRepetition([
      record({ repetition: 2 }),
      record({ repetition: 3, passed: false }),
    ]),
    null,
  );
  assert.equal(
    recommendV3ThirdRepetition([
      record({ repetition: 1 }),
      record({ repetition: 1, passed: false }),
    ]),
    null,
  );
  assert.equal(
    recommendV3ThirdRepetition([
      record({ repetition: 1 }),
      record({ repetition: 2 }),
      record({ repetition: 3 }),
    ]),
    null,
  );
});
