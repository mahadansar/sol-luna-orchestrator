import test from "node:test";
import assert from "node:assert/strict";
import { EFFORTS, LUNA_MODEL, MAX_BATCH_SIZE, MAX_PARALLEL } from "./config.js";
import {
  admitCompute,
  buildComputePolicy,
  cloneComputePolicy,
  DEFAULT_COMPUTE_POLICY,
  describeComputePolicy,
  narrowPolicy,
  resolveComputePolicy,
  type ComputePolicy,
} from "./policy.js";
import {
  buildDelegationResult,
  classifyFailureDecision,
  Semaphore,
  type ObservedRun,
} from "./worker.js";
import {
  delegateTaskInputSchema,
  type AttemptEvidence,
  type DelegateTaskInput,
  type DelegateTaskOutput,
  type WorkerReport,
} from "./contract.js";

// --- Fixtures ---------------------------------------------------------------

const permissive: ComputePolicy = {
  allowedModels: ["worker-a", "worker-b"],
  allowedEfforts: ["medium", "high", "xhigh", "max"],
  maxConcurrency: 4,
  maxWorkersPerBatch: 8,
  allowEffortEscalation: true,
  allowStrongerFallback: true,
};

const makeTask = (overrides: Partial<DelegateTaskInput> = {}): DelegateTaskInput =>
  delegateTaskInputSchema.parse({
    objective: "Fix the off-by-one error in the pagination helper.",
    effortReason: "Localized bug with a known repro.",
    acceptanceCriteria: ["Pagination returns the correct final page."],
    verificationCommands: ["npm test"],
    allowedFiles: ["src/**"],
    ...overrides,
  });

const implementationReport: WorkerReport = {
  status: "FAILED",
  failureCauses: ["implementation"],
  summary: "Could not make the pagination fix hold.",
  filesChanged: [{ path: "src/pagination.ts", change: "modified", why: "attempted fix" }],
  verification: [],
  notes: "",
  followUps: [],
};

const observed = (report: WorkerReport): ObservedRun => ({
  threadId: "thread-abc",
  finalResponse: JSON.stringify(report),
  filesChanged: [{ path: "src/pagination.ts", kind: "update" }],
  errors: [],
  usage: null,
  timedOut: false,
  cancelled: false,
  termination: "completed",
  terminationMessage: null,
});

const completedAttempt: AttemptEvidence = {
  executionId: "exec-initial",
  logicalAttempt: 1,
  role: "initial",
  predecessorExecutionId: null,
  requestedModel: LUNA_MODEL,
  requestedEffort: "high",
  threadId: "thread-abc",
  threadOperation: "start",
  threadIdentityMatched: null,
  startedAt: "2026-08-26T00:00:00.000Z",
  finishedAt: "2026-08-26T00:00:01.000Z",
  elapsedMs: 1_000,
  workerElapsedMs: 900,
  verificationElapsedMs: 100,
  timeoutMs: 60_000,
  termination: { kind: "completed", message: "completed" },
  usage: { status: "unavailable", reason: "no-turn-completed" },
  workerClaimedStatus: "FAILED",
  workerClaimedFailureCauses: ["implementation"],
  verification: [],
};

/** A repeated trustworthy implementation failure: the escalation-ladder case. */
function repeatedImplementationFailure(taskOverrides: Partial<DelegateTaskInput> = {}): {
  input: DelegateTaskInput;
  result: DelegateTaskOutput;
} {
  const previousAttempts = [
    {
      effort: "medium" as const,
      verdict: "FAILED" as const,
      whatWentWrong: "The implementation remained incomplete.",
    },
  ];
  const input = makeTask({ previousAttempts, ...taskOverrides });
  const result = buildDelegationResult({
    input,
    workingDirectory: process.cwd(),
    observed: observed(implementationReport),
    orchestratorRuns: [],
    durationSeconds: 10,
  });
  result.attempts = [completedAttempt];
  return { input, result };
}

// --- narrowPolicy: the primitive ------------------------------------------

test("narrowPolicy narrows every dimension it is given", () => {
  const narrowed = narrowPolicy(permissive, {
    allowedModels: ["worker-b"],
    allowedEfforts: ["medium", "high"],
    maxConcurrency: 1,
    maxWorkersPerBatch: 2,
    allowEffortEscalation: false,
    allowStrongerFallback: false,
  });

  assert.deepEqual(narrowed, {
    allowedModels: ["worker-b"],
    allowedEfforts: ["medium", "high"],
    maxConcurrency: 1,
    maxWorkersPerBatch: 2,
    allowEffortEscalation: false,
    allowStrongerFallback: false,
  });
});

test("narrowPolicy cannot expand any dimension of its parent", () => {
  const restrictive: ComputePolicy = {
    allowedModels: ["worker-a"],
    allowedEfforts: ["medium"],
    maxConcurrency: 1,
    maxWorkersPerBatch: 2,
    allowEffortEscalation: false,
    allowStrongerFallback: false,
  };

  // Every field asks for strictly more than the parent permits.
  const attempted = narrowPolicy(restrictive, {
    allowedModels: ["worker-a", "worker-b", "worker-c"],
    allowedEfforts: ["medium", "high", "xhigh", "max"],
    maxConcurrency: 99,
    maxWorkersPerBatch: 99,
    allowEffortEscalation: true,
    allowStrongerFallback: true,
  });

  assert.deepEqual(attempted, restrictive, "no field may widen");

  // A parent that forbids something stays forbidding it however the child asks.
  for (const flag of ["allowEffortEscalation", "allowStrongerFallback"] as const) {
    assert.equal(narrowPolicy(restrictive, { [flag]: true })[flag], false);
    assert.equal(narrowPolicy(restrictive, { [flag]: undefined })[flag], false);
    assert.equal(narrowPolicy(permissive, { [flag]: true })[flag], true);
    assert.equal(narrowPolicy(permissive, { [flag]: false })[flag], false);
  }

  // Models and efforts intersect rather than union: an entry the parent never
  // held cannot be introduced by naming it.
  assert.deepEqual(
    narrowPolicy(restrictive, { allowedModels: ["worker-b", "worker-a"] }).allowedModels,
    ["worker-a"],
  );
  assert.deepEqual(
    narrowPolicy(restrictive, { allowedEfforts: ["max", "medium"] }).allowedEfforts,
    ["medium"],
  );
});

test("narrowPolicy is idempotent, so re-resolving a resolved envelope is a no-op", () => {
  const once = narrowPolicy(permissive, {
    maxConcurrency: 2,
    allowStrongerFallback: false,
  });
  assert.deepEqual(narrowPolicy(once, once), once);
  assert.deepEqual(narrowPolicy(permissive, once), once);
});

test("narrowPolicy refuses an empty intersection instead of resolving permissively", () => {
  assert.throws(
    () => narrowPolicy(permissive, { allowedModels: ["not-a-worker"] }),
    /at least one model/,
  );
  assert.throws(
    () =>
      narrowPolicy(
        { ...permissive, allowedEfforts: ["medium"] },
        { allowedEfforts: ["max"] },
      ),
    /at least one effort/,
  );
});

// --- The operator-owned baseline -------------------------------------------

test("the default baseline reproduces the pre-policy runtime", () => {
  assert.deepEqual(DEFAULT_COMPUTE_POLICY.allowedModels, [LUNA_MODEL]);
  assert.deepEqual(DEFAULT_COMPUTE_POLICY.allowedEfforts, [...EFFORTS]);
  assert.equal(DEFAULT_COMPUTE_POLICY.maxConcurrency, MAX_PARALLEL);
  assert.equal(DEFAULT_COMPUTE_POLICY.maxWorkersPerBatch, MAX_BATCH_SIZE);
  assert.equal(DEFAULT_COMPUTE_POLICY.allowEffortEscalation, true);
  assert.equal(DEFAULT_COMPUTE_POLICY.allowStrongerFallback, true);
});

test("operator settings narrow the baseline and cannot raise the hard ceilings", () => {
  const narrowed = buildComputePolicy({
    model: "operator-worker",
    allowedEfforts: ["medium", "high"],
    maxConcurrency: 2,
    maxWorkersPerBatch: 3,
    allowEffortEscalation: false,
    allowStrongerFallback: false,
  });
  assert.deepEqual(narrowed.allowedModels, ["operator-worker"]);
  assert.deepEqual(narrowed.allowedEfforts, ["medium", "high"]);
  assert.equal(narrowed.maxConcurrency, 2);
  assert.equal(narrowed.maxWorkersPerBatch, 3);
  assert.equal(narrowed.allowEffortEscalation, false);

  // An operator asking for more than the runtime will ever run is clamped to
  // the protocol ceiling, exactly as a caller would be.
  const greedy = buildComputePolicy({
    model: "operator-worker",
    allowedEfforts: [...EFFORTS],
    maxConcurrency: 9_000,
    maxWorkersPerBatch: 9_000,
    allowEffortEscalation: true,
    allowStrongerFallback: true,
  });
  assert.ok(greedy.maxConcurrency <= 8, `concurrency ceiling: ${greedy.maxConcurrency}`);
  assert.equal(greedy.maxWorkersPerBatch, MAX_BATCH_SIZE);
});

test("cloneComputePolicy copies the lists rather than aliasing them", () => {
  const clone = cloneComputePolicy(permissive);
  clone.allowedModels.push("smuggled");
  clone.allowedEfforts.pop();
  assert.deepEqual(permissive.allowedModels, ["worker-a", "worker-b"]);
  assert.equal(permissive.allowedEfforts.length, 4);
});

test("resolveComputePolicy is total: an impossible request falls back, never throws", () => {
  assert.deepEqual(resolveComputePolicy(undefined), DEFAULT_COMPUTE_POLICY);
  assert.deepEqual(
    resolveComputePolicy({ allowedModels: ["not-a-worker"] }),
    DEFAULT_COMPUTE_POLICY,
  );
  assert.equal(resolveComputePolicy({ maxConcurrency: 1 }).maxConcurrency, 1);
});

// --- admitCompute: the one gate both surfaces use --------------------------

test("admitCompute admits a request that fits and reports the resolved envelope", () => {
  const admission = admitCompute({
    model: LUNA_MODEL,
    efforts: ["high"],
    workerCount: 2,
    requested: { maxConcurrency: 1, allowStrongerFallback: false },
  });
  assert.equal(admission.refusal, null);
  assert.equal(admission.policy.maxConcurrency, 1);
  assert.equal(admission.policy.allowStrongerFallback, false);
  assert.equal(admission.policy.allowEffortEscalation, true);
});

test("admitCompute refuses a disallowed effort and names what is permitted", () => {
  const baseline = buildComputePolicy({
    model: LUNA_MODEL,
    allowedEfforts: ["medium"],
    maxConcurrency: MAX_PARALLEL,
    maxWorkersPerBatch: MAX_BATCH_SIZE,
    allowEffortEscalation: true,
    allowStrongerFallback: true,
  });
  const admission = admitCompute({
    baseline,
    model: LUNA_MODEL,
    efforts: ["medium", "max"],
    workerCount: 1,
  });
  assert.match(admission.refusal ?? "", /effort 'max' is not permitted/);
  assert.match(admission.refusal ?? "", /Allowed: medium/);
  assert.match(admission.refusal ?? "", /solo/, "a refusal should name the way out");
});

test("admitCompute refuses an unauthorized worker model", () => {
  const admission = admitCompute({
    baseline: permissive,
    model: "unlisted-worker",
    efforts: ["high"],
    workerCount: 1,
  });
  assert.match(
    admission.refusal ?? "",
    /worker model 'unlisted-worker' is not permitted/,
  );
});

test("admitCompute bounds worker count in both modes, not just parallel", () => {
  // The gate takes a count, not a mode: a sequential batch enlists as many
  // workers as a parallel one and must be bounded the same way.
  const admission = admitCompute({
    baseline: permissive,
    model: "worker-a",
    efforts: ["high"],
    workerCount: 9,
  });
  assert.match(admission.refusal ?? "", /9 workers exceeds the permitted 8 per batch/);

  const narrowed = admitCompute({
    baseline: permissive,
    model: "worker-a",
    efforts: ["high"],
    workerCount: 3,
    requested: { maxWorkersPerBatch: 2 },
  });
  assert.match(narrowed.refusal ?? "", /3 workers exceeds the permitted 2 per batch/);
});

test("admitCompute never throws on an unsatisfiable declaration", () => {
  const admission = admitCompute({
    baseline: permissive,
    model: "worker-a",
    efforts: ["high"],
    workerCount: 1,
    requested: { allowedEfforts: [] as never[] },
  });
  assert.match(admission.refusal ?? "", /Compute policy refusal/);
  assert.deepEqual(admission.policy, permissive, "the baseline is still reported");
});

test("describeComputePolicy renders every bound an operator set", () => {
  const described = describeComputePolicy({
    ...permissive,
    allowedEfforts: ["medium", "high"],
    maxConcurrency: 2,
    maxWorkersPerBatch: 5,
    allowStrongerFallback: false,
  });
  assert.match(described, /medium\/high/);
  assert.match(described, /max 2 concurrent/);
  assert.match(described, /5 per batch/);
  assert.match(described, /escalation on/);
  assert.match(described, /fallback off/);
});

// --- The failure ladder: policy shortens it, never reorders it -------------

test("the escalation ladder still escalates one effort step by default", () => {
  const { input, result } = repeatedImplementationFailure({ effort: "medium" });
  const decision = classifyFailureDecision(input, result);
  assert.equal(decision.action, "effort-escalation");
  assert.equal(decision.nextEffort, "high");
});

test("a forbidden effort escalation falls to the parent, never to a stronger executor", () => {
  // The inversion this guards against: refusing the cheap next step must not
  // promote the run to the strictly more expensive executor ladder.
  const { input, result } = repeatedImplementationFailure({
    effort: "medium",
    computePolicy: { allowEffortEscalation: false },
  });
  const decision = classifyFailureDecision(input, result);
  assert.equal(decision.action, "parent-takeover");
  assert.equal(decision.classification, "capability");
  assert.equal(decision.nextEffort, null);
  assert.match(decision.reason, /no further effort escalation/);
});

test("an effort ceiling below max also withholds the stronger-executor fallback", () => {
  const { input, result } = repeatedImplementationFailure({
    effort: "medium",
    // Escalation is permitted, but no higher effort is in the allowed set.
    computePolicy: { allowedEfforts: ["medium"] },
  });
  const decision = classifyFailureDecision(input, result);
  assert.equal(decision.action, "parent-takeover");
  assert.equal(decision.nextEffort, null);
});

test("escalation skips to the next permitted effort rather than dead-ending", () => {
  // A non-contiguous allowed set: `high` and `xhigh` are excluded, so a single
  // step lands nowhere and the ladder must look further up instead of giving up.
  const { input, result } = repeatedImplementationFailure({
    effort: "medium",
    computePolicy: { allowedEfforts: ["medium", "max"] },
  });
  const decision = classifyFailureDecision(input, result);
  assert.equal(decision.action, "effort-escalation");
  assert.equal(decision.nextEffort, "max");
});

test("max effort still reaches the stronger-executor fallback, and policy can withhold it", () => {
  const permitted = repeatedImplementationFailure({ effort: "max" });
  const fallback = classifyFailureDecision(permitted.input, permitted.result);
  assert.equal(fallback.action, "stronger-executor-fallback");
  assert.equal(fallback.classification, "capability");
  assert.match(fallback.reason, /at max effort/);

  const withheld = repeatedImplementationFailure({
    effort: "max",
    computePolicy: { allowStrongerFallback: false },
  });
  const decision = classifyFailureDecision(withheld.input, withheld.result);
  assert.equal(decision.action, "parent-takeover");
  assert.match(decision.reason, /no stronger-executor fallback/);
});

test("failure classification stays total when a task carries an impossible policy", () => {
  // Classification runs while handling a failure. It must not convert a FAILED
  // result into a thrown exception, whatever the attached policy says.
  const { input, result } = repeatedImplementationFailure({
    effort: "medium",
    computePolicy: { allowedModels: ["not-a-worker"] },
  });
  const decision = classifyFailureDecision(input, result);
  assert.equal(decision.action, "effort-escalation");
});

// --- Concurrency ----------------------------------------------------------

test("the policy semaphore admits exactly its permitted number at once", async () => {
  const slots = new Semaphore(2);
  let live = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      const release = await slots.acquire();
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setImmediate(resolve));
      live -= 1;
      release();
    }),
  );
  assert.equal(peak, 2);
  assert.equal(live, 0);
});

test("nesting the policy and global semaphores in a fixed order cannot deadlock", async () => {
  // The batch scheduler always takes the policy slot first and the global slot
  // second, then releases in reverse. Contending both ways round would be the
  // only route to a cycle, so this pins the ordering the scheduler relies on.
  const policySlots = new Semaphore(1);
  const globalSlots = new Semaphore(2);
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: 4 }, (_unused, index) => async () => {
      const policyRelease = await policySlots.acquire();
      const globalRelease = await globalSlots.acquire();
      try {
        order.push(index);
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        globalRelease();
        policyRelease();
      }
    }).map((thunk) => thunk()),
  );
  assert.equal(order.length, 4, "every waiter completed");
});

test("a released permit hands off to the next waiter exactly once", async () => {
  const slots = new Semaphore(1);
  const release = await slots.acquire();
  let acquired = false;
  const pending = slots.acquire().then((next) => {
    acquired = true;
    return next;
  });
  assert.equal(acquired, false, "the second acquire waits");
  release();
  release(); // Idempotent: a double release must not create a permit.
  const second = await pending;
  assert.equal(acquired, true);
  second();
  second();

  // If the double releases had leaked a permit, three holders could coexist.
  const a = await slots.acquire();
  let thirdAcquired = false;
  void slots.acquire().then(() => {
    thirdAcquired = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdAcquired, false, "no extra permit was created");
  a();
});
