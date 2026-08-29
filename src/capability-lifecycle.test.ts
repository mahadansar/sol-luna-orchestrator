/**
 * P2.x capability lifecycle: reserve -> commit/release, and the ownership a
 * reservation, an expiry, or a concurrent sibling must settle exactly once.
 *
 * Every concurrency test here is deterministic. Interleavings are driven by
 * deferred promises and injected clocks rather than by sleeping, so a slow
 * machine cannot turn a race assertion into a flake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CONTINUATION_TTL_MS, ContinuationStore } from "./continuation.js";
import { HANDOFF_TTL_MS, HandoffStore } from "./handoff.js";
import {
  DEFAULT_COMPUTE_POLICY,
  buildComputePolicy,
  cloneComputePolicy,
  resolveBaselineExecutor,
  type ComputePolicy,
} from "./policy.js";
import { runBatch, BatchRejectedError } from "./batch.js";
import {
  ContextLifecycleRegistry,
  handleContinueTask,
  handleDelegateTask,
} from "./server.js";
import { ContextLifecycleStore } from "./context.js";
import type {
  AttemptEvidence,
  DelegateTaskInput,
  DelegateTaskOutput,
  FailureDecision,
} from "./contract.js";
import type { OrchestratorEvent } from "./events.js";
import type { WorktreeLease } from "./worktree.js";
import { ShutdownCoordinator } from "./shutdown.js";

const LUNA = "gpt-5.6-luna";

function makeTask(overrides: Partial<DelegateTaskInput> = {}): DelegateTaskInput {
  return {
    objective: "Implement the parser seam and keep every declared check green",
    effort: "medium",
    effortReason: "Bounded single-seam change",
    acceptanceCriteria: ["All declared checks pass"],
    allowedFiles: ["src/parser.ts"],
    forbiddenFiles: [],
    verificationCommands: [],
    changeIntent: "required",
    automaticRepair: false,
    resultDetail: "handoff",
    previousAttempts: [],
    routingPreflight: {
      seams: ["parser-seam"],
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
    ...overrides,
  };
}

const ESCALATION_DECISION: FailureDecision = {
  classification: "effort",
  action: "effort-escalation",
  reason: "The declared checks failed for reasons more compute can plausibly fix",
  evidenceExecutionIds: ["exec_1"],
  nextEffort: "high",
  automaticHandler: null,
  automaticRetryCount: 0,
  automaticRetryLimit: 1,
};

/** One completed, trustworthy attempt: the evidence an eligible failure needs. */
const COMPLETED_ATTEMPT: AttemptEvidence = {
  executionId: "exec_1",
  logicalAttempt: 1,
  role: "initial",
  predecessorExecutionId: null,
  requestedModel: LUNA,
  requestedEffort: "medium",
  threadId: "th_cap_1",
  threadOperation: "start",
  threadIdentityMatched: true,
  startedAt: new Date(1_000).toISOString(),
  finishedAt: new Date(4_000).toISOString(),
  elapsedMs: 3_000,
  workerElapsedMs: 3_000,
  verificationElapsedMs: 0,
  timeoutMs: 600_000,
  termination: { kind: "completed", message: null },
  usage: { status: "unavailable", reason: "no-turn-completed" },
  workerClaimedStatus: "FAILED",
  workerClaimedFailureCauses: ["implementation"],
  verification: [],
};

function makeFailure(overrides: Partial<DelegateTaskOutput> = {}): DelegateTaskOutput {
  return {
    verdict: "FAILED",
    workerClaimedStatus: "FAILED",
    workerClaimedFailureCauses: ["implementation"],
    trustworthy: true,
    filesChanged: [],
    verification: [],
    verificationMode: "allowlist",
    scopeViolations: [],
    discrepancies: [],
    errors: [],
    followUps: [],
    notes: "",
    summary: "Declared checks failed",
    reviewChecklist: [],
    escalationAdvice: "escalate-effort",
    usage: null,
    attempt: 1,
    attempts: [{ ...COMPLETED_ATTEMPT }],
    durationSeconds: 3,
    model: LUNA,
    effort: "medium",
    effortReason: "Bounded single-seam change",
    workerThreadId: "th_cap_1",
    changeIntent: "required",
    continuationReference: null,
    continuationState: { status: "not-eligible", reason: "not-eligible" },
    handoffReference: null,
    handoffState: { status: "not-eligible", reason: "not-eligible" },
    failureDecision: { ...ESCALATION_DECISION },
    ...overrides,
  };
}

/** Issue one escalation handoff directly, with a known context owner. */
function issueEscalation(
  store: HandoffStore,
  task: DelegateTaskInput,
  contextKey: string | null = null,
): string {
  return store.issue(task, makeFailure(), "exec_1", contextKey);
}

// ---------------------------------------------------------------------------
// HandoffStore: ready -> reserved -> consumed
// ---------------------------------------------------------------------------

test("handoff reservation refuses a concurrent consumer for the whole window", () => {
  const store = new HandoffStore();
  const reference = issueEscalation(store, makeTask());

  const reserved = store.reserve(reference);
  assert.equal(reserved.status, "ready");
  if (reserved.status !== "ready") return;

  // No second consumer may act on a reserved reference, by either surface.
  assert.equal(store.reserve(reference).status, "used");
  assert.equal(store.consume(reference).status, "used");
  assert.equal(store.status(reference), "consumed");

  // Committing makes that permanent.
  reserved.reservation.commit();
  assert.equal(store.consume(reference).status, "used");
  assert.equal(store.status(reference), "consumed");
});

test("releasing an unspent reservation restores exactly the same authority", () => {
  const store = new HandoffStore();
  const task = makeTask();
  const reference = issueEscalation(store, task);

  const reserved = store.reserve(reference);
  assert.equal(reserved.status, "ready");
  if (reserved.status !== "ready") return;
  reserved.reservation.release();

  assert.equal(store.status(reference), "issued");
  const second = store.consume(reference);
  assert.equal(second.status, "ready");
  if (second.status !== "ready") return;
  assert.equal(second.entry.predecessorExecutionId, "exec_1");
  assert.equal(second.entry.failureDecision.action, "effort-escalation");
  assert.deepEqual(second.entry.input.allowedFiles, task.allowedFiles);
  // Restored once means restored once: the second consume is terminal.
  assert.equal(store.consume(reference).status, "used");
});

test("a reservation settles exactly once whichever order it is settled in", () => {
  const store = new HandoffStore();
  const first = issueEscalation(store, makeTask());
  const second = issueEscalation(store, makeTask());

  const a = store.reserve(first);
  assert.equal(a.status, "ready");
  if (a.status !== "ready") return;
  a.reservation.commit();
  // A release after a commit must not resurrect spent authority.
  a.reservation.release();
  a.reservation.release();
  assert.equal(store.status(first), "consumed");
  assert.equal(store.consume(first).status, "used");

  const b = store.reserve(second);
  assert.equal(b.status, "ready");
  if (b.status !== "ready") return;
  b.reservation.release();
  // A commit after a release must not re-destroy restored authority.
  b.reservation.commit();
  b.reservation.release();
  assert.equal(store.status(second), "issued");
  assert.equal(store.consume(second).status, "ready");
});

test("authority that expires while reserved is retired rather than handed back", () => {
  let now = 1_000_000;
  const store = new HandoffStore({ now: () => now });
  const reference = issueEscalation(store, makeTask());

  const reserved = store.reserve(reference);
  assert.equal(reserved.status, "ready");
  if (reserved.status !== "ready") return;

  now += HANDOFF_TTL_MS + 1;
  reserved.reservation.release();

  // A reservation never extends a TTL, and never returns dead authority.
  assert.equal(store.status(reference), "unavailable");
  assert.equal(store.consume(reference).status, "expired");
});

test("a reserved handoff still owns its lifecycle context", () => {
  const store = new HandoffStore();
  const reference = issueEscalation(store, makeTask(), "ctx_key_1");

  assert.equal(store.hasContextKey("ctx_key_1"), true);
  const reserved = store.reserve(reference);
  assert.equal(reserved.status, "ready");
  if (reserved.status !== "ready") return;

  // The window in which a refusal could still hand the reference back is
  // exactly the window in which its context must not be reclaimed.
  assert.equal(store.hasContextKey("ctx_key_1"), true);
  reserved.reservation.release();
  assert.equal(store.hasContextKey("ctx_key_1"), true);
  store.consume(reference);
  assert.equal(store.hasContextKey("ctx_key_1"), false);
});

test("two consumers racing one handoff: exactly one executes, the other is refused", async () => {
  const store = new HandoffStore();
  const reference = issueEscalation(store, makeTask());

  const results = await Promise.all([
    Promise.resolve().then(() => store.reserve(reference)),
    Promise.resolve().then(() => store.reserve(reference)),
  ]);
  assert.equal(results.filter((result) => result.status === "ready").length, 1);
  assert.equal(results.filter((result) => result.status === "used").length, 1);
});

// ---------------------------------------------------------------------------
// delegate_task: refusal before execution must not destroy earned authority
// ---------------------------------------------------------------------------

interface DelegateHarness {
  readonly events: OrchestratorEvent[];
  readonly handoffStore: HandoffStore;
  readonly continuationStore: ContinuationStore;
  readonly registry: ContextLifecycleRegistry;
  readonly contextStore: ContextLifecycleStore;
}

function makeDelegateHarness(): DelegateHarness {
  const events: OrchestratorEvent[] = [];
  const emit = (event: OrchestratorEvent): void => {
    events.push(event);
  };
  const handoffStore = new HandoffStore();
  const continuationStore = new ContinuationStore();
  const registry = new ContextLifecycleRegistry({
    handoffStore,
    continuationStore,
    emit,
  });
  const contextStore = new ContextLifecycleStore({
    handoffStore,
    continuationStore,
    emit,
  });
  return { events, handoffStore, continuationStore, registry, contextStore };
}

test("a compute-policy refusal after handoff resolution hands the escalation back", async () => {
  const harness = makeDelegateHarness();
  // The envelope is read off the *restored* contract, never off the caller's
  // request, so the unsatisfiable narrowing has to live in the authority that
  // the handoff carries. Admission then refuses strictly after the handoff has
  // been resolved and before any worker is handed the contract.
  const task = makeTask({
    computePolicy: {
      ...cloneComputePolicy(DEFAULT_COMPUTE_POLICY),
      maxWorkersPerBatch: 0,
    },
  });
  const reference = issueEscalation(harness.handoffStore, task);

  let executed = false;
  const response = await handleDelegateTask(
    { ...makeTask(), handoffReference: reference },
    undefined,
    {
      handoffStore: harness.handoffStore,
      continuationStore: harness.continuationStore,
      contextRegistry: harness.registry,
      contextStore: harness.contextStore,
      delegateToLuna: async () => {
        executed = true;
        return makeFailure();
      },
      emit: (event) => harness.events.push(event),
      record: () => undefined,
      makeBatchId: () => "b_refused",
    },
  );

  assert.equal(response.isError, true);
  assert.equal(executed, false, "no worker may run when admission refuses");
  assert.equal(
    harness.handoffStore.status(reference),
    "issued",
    "earned authority survives a refusal that ran nothing",
  );
  assert.equal(harness.handoffStore.consume(reference).status, "ready");
});

test("an executor that throws still spends the handoff it was handed", async () => {
  const harness = makeDelegateHarness();
  const task = makeTask();
  const reference = issueEscalation(harness.handoffStore, task);

  const response = await handleDelegateTask(
    { ...task, handoffReference: reference },
    undefined,
    {
      handoffStore: harness.handoffStore,
      continuationStore: harness.continuationStore,
      contextRegistry: harness.registry,
      contextStore: harness.contextStore,
      delegateToLuna: async () => {
        throw new Error("worker process exited");
      },
      emit: (event) => harness.events.push(event),
      record: () => undefined,
      makeBatchId: () => "b_threw",
    },
  );

  assert.equal(response.isError, true);
  assert.equal(
    harness.handoffStore.status(reference),
    "consumed",
    "authority handed to an executor is spent whatever the executor does",
  );
});

test("cancellation before the executor is entered hands the escalation back", async () => {
  const harness = makeDelegateHarness();
  const task = makeTask();
  const reference = issueEscalation(harness.handoffStore, task);
  const controller = new AbortController();
  controller.abort();

  await handleDelegateTask({ ...task, handoffReference: reference }, controller.signal, {
    handoffStore: harness.handoffStore,
    continuationStore: harness.continuationStore,
    contextRegistry: harness.registry,
    contextStore: harness.contextStore,
    delegateToLuna: async () => {
      throw new Error("cancelled");
    },
    emit: (event) => harness.events.push(event),
    record: () => undefined,
    makeBatchId: () => "b_cancelled",
  });

  assert.equal(harness.handoffStore.status(reference), "issued");
});

test("a context is not reclaimed while a reserved capability still references it", async () => {
  const events: OrchestratorEvent[] = [];
  const emit = (event: OrchestratorEvent): void => {
    events.push(event);
  };
  const handoffStore = new HandoffStore();
  const continuationStore = new ContinuationStore();
  const registry = new ContextLifecycleRegistry({
    handoffStore,
    continuationStore,
    emit,
  });

  const contextKey = "ctx_live";
  const owned = registry.getOrCreate(contextKey);
  owned.recordDecision({ summary: "canonical decision that must survive" });

  const task = makeTask();
  const reference = issueEscalation(handoffStore, task, contextKey);

  // A refusal reached only after the reservation exists. The sweep that runs on
  // every getOrCreate must not reclaim the reserved capability's context in the
  // window before it is handed back.
  await handleDelegateTask(
    { ...task, handoffReference: reference, computePolicy: { maxWorkersPerBatch: 0 } },
    undefined,
    {
      handoffStore,
      continuationStore,
      contextRegistry: registry,
      delegateToLuna: async () => makeFailure(),
      emit,
      record: () => undefined,
      makeBatchId: () => "b_sweep",
    },
  );

  registry.getOrCreate("ctx_other");
  const restored = registry.getOrCreate(contextKey);
  assert.equal(
    restored.getAuthoritativeContext()?.decisions.length,
    1,
    "the reserved capability's canonical context survives an unrelated sweep",
  );
});

// ---------------------------------------------------------------------------
// delegate_tasks: siblings stay individually authoritative
// ---------------------------------------------------------------------------

type BatchOptions = Parameters<typeof runBatch>[1];

function batchOptionsFor(
  handoffStore: HandoffStore,
  overrides: Partial<BatchOptions> = {},
): BatchOptions {
  return {
    mode: "parallel",
    handoffStore,
    eventEmitter: () => undefined,
    batchId: "b_batch",
    executor: async () => {
      throw new Error("no worker should run in this test");
    },
    ...overrides,
  } as BatchOptions;
}

test("an invalid sibling handoff cannot burn a valid sibling's handoff", async () => {
  const handoffStore = new HandoffStore();
  const first = makeTask({ allowedFiles: ["src/a.ts"] });
  const second = makeTask({ allowedFiles: ["src/b.ts"] });
  const valid = issueEscalation(handoffStore, first);

  await assert.rejects(
    runBatch(
      [
        { ...first, handoffReference: valid },
        // Well-formed, but never issued by this process.
        { ...second, handoffReference: `hdf_${"z".repeat(40)}` },
      ],
      batchOptionsFor(handoffStore),
    ),
    BatchRejectedError,
  );

  assert.equal(
    handoffStore.status(valid),
    "issued",
    "a sibling's malformed reference must not destroy earned authority",
  );
});

test("an overlapping-scope refusal hands every reserved batch handoff back", async () => {
  const handoffStore = new HandoffStore();
  const overlapping = makeTask({ allowedFiles: ["src/shared.ts"] });
  const first = issueEscalation(handoffStore, overlapping);
  const second = issueEscalation(handoffStore, overlapping);

  await assert.rejects(
    runBatch(
      [
        { ...overlapping, handoffReference: first },
        { ...overlapping, handoffReference: second },
      ],
      batchOptionsFor(handoffStore),
    ),
    BatchRejectedError,
  );

  assert.equal(handoffStore.status(first), "issued");
  assert.equal(handoffStore.status(second), "issued");
});

test("a batch that reaches its workers spends every handoff it reserved", async () => {
  const handoffStore = new HandoffStore();
  const task = makeTask({ allowedFiles: ["src/only.ts"] });
  const reference = issueEscalation(handoffStore, task);

  await runBatch(
    [{ ...task, handoffReference: reference }],
    batchOptionsFor(handoffStore, {
      mode: "sequential",
      executor: async () => makeFailure({ failureDecision: undefined }),
    }),
  );

  assert.equal(handoffStore.status(reference), "consumed");
});

// ---------------------------------------------------------------------------
// ContinuationStore: expiry must surrender what it owns, exactly once
// ---------------------------------------------------------------------------

function makeLease(worktreePath: string): WorktreeLease {
  return { worktreePath, ownerToken: `token_${worktreePath}`, expiresAt: 1 };
}

test("an expired continuation releases its retained worktree lease exactly once", async () => {
  let now = 5_000_000;
  const released: WorktreeLease[] = [];
  const store = new ContinuationStore({
    now: () => now,
    releaseLease: (lease) => {
      released.push(lease);
    },
  });
  const worktree = "/repo/.sol-luna/worktrees/t1";
  const lease = makeLease(worktree);
  const reference = store.issue(
    makeTask(),
    "th_1",
    worktree,
    true,
    lease,
    null,
    2,
    LUNA,
    null,
    "/repo",
  );

  assert.deepEqual(store.protectedWorkingDirectories(), [worktree]);

  now += CONTINUATION_TTL_MS + 1;

  // Every path that observes the expiry must agree, and only one may release.
  assert.equal(store.status(reference), "unavailable");
  assert.deepEqual(store.protectedWorkingDirectories(), []);
  assert.equal(store.consume(reference).status, "expired");
  await store.whenExpiredLeasesReleased();

  assert.equal(released.length, 1);
  assert.equal(released[0]?.ownerToken, lease.ownerToken);
});

test("a consumed continuation's lease is owned by its turn, never by expiry", async () => {
  let now = 6_000_000;
  const released: WorktreeLease[] = [];
  const store = new ContinuationStore({
    now: () => now,
    releaseLease: (lease) => {
      released.push(lease);
    },
  });
  const worktree = "/repo/.sol-luna/worktrees/t2";
  const reference = store.issue(
    makeTask(),
    "th_2",
    worktree,
    true,
    makeLease(worktree),
    null,
    2,
    LUNA,
    null,
    "/repo",
  );

  assert.equal(store.consume(reference).status, "ready");

  // The turn holds it past the TTL; the store must not release underneath it.
  now += CONTINUATION_TTL_MS + 1;
  assert.deepEqual(store.protectedWorkingDirectories(), [worktree]);
  await store.whenExpiredLeasesReleased();
  assert.equal(released.length, 0);

  store.release(reference);
  assert.deepEqual(store.protectedWorkingDirectories(), []);
  await store.whenExpiredLeasesReleased();
  assert.equal(released.length, 0, "expiry never double-releases a consumed lease");
});

test("concurrent expiry, prune and consume release one lease between them", async () => {
  let now = 7_000_000;
  const released: WorktreeLease[] = [];
  const store = new ContinuationStore({
    now: () => now,
    releaseLease: (lease) => {
      released.push(lease);
    },
  });
  const worktree = "/repo/.sol-luna/worktrees/t3";
  const reference = store.issue(
    makeTask(),
    "th_3",
    worktree,
    true,
    makeLease(worktree),
    null,
    2,
    LUNA,
    null,
    "/repo",
  );

  now += CONTINUATION_TTL_MS + 1;
  await Promise.all([
    Promise.resolve().then(() => store.consume(reference)),
    Promise.resolve().then(() => store.protectedWorkingDirectories()),
    Promise.resolve().then(() => store.status(reference)),
    Promise.resolve().then(() => store.hasContextKey("anything")),
  ]);
  await store.whenExpiredLeasesReleased();

  assert.equal(released.length, 1);
});

test("a continuation with no lease expires without inventing a release", async () => {
  let now = 8_000_000;
  const released: WorktreeLease[] = [];
  const store = new ContinuationStore({
    now: () => now,
    releaseLease: (lease) => {
      released.push(lease);
    },
  });
  const reference = store.issue(makeTask(), "th_4", "/repo");
  now += CONTINUATION_TTL_MS + 1;
  assert.equal(store.consume(reference).status, "expired");
  await store.whenExpiredLeasesReleased();
  assert.equal(released.length, 0);
});

// ---------------------------------------------------------------------------
// A handoff issued after a retained continuation must not name a released dir
// ---------------------------------------------------------------------------

test("a handoff after a retained continuation names the workspace, not the released worktree", async () => {
  const events: OrchestratorEvent[] = [];
  const emit = (event: OrchestratorEvent): void => {
    events.push(event);
  };
  const handoffStore = new HandoffStore();
  const continuationStore = new ContinuationStore();
  const registry = new ContextLifecycleRegistry({
    handoffStore,
    continuationStore,
    emit,
  });
  const worktree = "/repo/.sol-luna/worktrees/t9";
  const reference = continuationStore.issue(
    makeTask({ workingDirectory: "/repo" }),
    "th_retained",
    worktree,
    true,
    makeLease(worktree),
    "exec_prev",
    2,
    LUNA,
    null,
    "/repo",
  );

  const releasedLeases: WorktreeLease[] = [];
  const response = await handleContinueTask(
    { continuationReference: reference, instruction: "Finish the remaining criterion" },
    undefined,
    {
      store: continuationStore,
      handoffStore,
      contextRegistry: registry,
      continueTask: async () => makeFailure({ workerThreadId: "th_retained" }),
      reconcile: async (_input, result) => result,
      refreshLease: async () => undefined,
      releaseLease: async (released) => {
        releasedLeases.push(released);
      },
      emit,
      record: () => undefined,
      makeBatchId: () => "b_retained",
    },
  );

  assert.equal(response.isError, undefined);
  assert.equal(releasedLeases.length, 1, "the retained worktree lease is surrendered");

  const issued = response.structuredContent?.handoffReference ?? null;
  assert.ok(issued, "a failed continuation earns a next-action handoff");
  const consumed = handoffStore.consume(issued);
  assert.equal(consumed.status, "ready");
  if (consumed.status !== "ready") return;
  assert.equal(
    consumed.entry.input.workingDirectory,
    "/repo",
    "a fresh attempt must not be bound to a worktree whose lease this turn released",
  );
});

// ---------------------------------------------------------------------------
// Executor choice: one rule, never an inference from membership-set order
// ---------------------------------------------------------------------------

function policyWith(overrides: Partial<ComputePolicy>): ComputePolicy {
  return { ...cloneComputePolicy(DEFAULT_COMPUTE_POLICY), ...overrides };
}

test("baseline executor reads declarations only, never list position", () => {
  // One authorised executor is a selection the envelope makes by itself.
  assert.equal(
    resolveBaselineExecutor(policyWith({ allowedModels: ["only-model"] })),
    "only-model",
  );

  // Several authorised executors and no ordering: the configured baseline
  // worker, which is an operator surface, not index 0.
  assert.equal(
    resolveBaselineExecutor(policyWith({ allowedModels: ["other", LUNA] })),
    LUNA,
  );

  // An operator-declared ladder names its own baseline rung.
  assert.equal(
    resolveBaselineExecutor(
      policyWith({
        allowedModels: [LUNA, "stronger"],
        executorOrder: [LUNA, "stronger"],
      }),
    ),
    LUNA,
  );

  // Nothing declared and no baseline permitted: refuse rather than guess.
  assert.equal(
    resolveBaselineExecutor(policyWith({ allowedModels: ["alpha", "beta"] })),
    null,
  );
});

test("single and batch delegation name the same executor for one envelope", async () => {
  const policy = buildComputePolicy({
    model: LUNA,
    allowedModels: [LUNA, "extra-executor"],
    allowedEfforts: ["medium", "high"],
    maxConcurrency: 2,
    maxWorkersPerBatch: 4,
    allowEffortEscalation: true,
    allowStrongerFallback: true,
  });

  const singleChoice = resolveBaselineExecutor(policy);

  const observed: Array<string | undefined> = [];
  await runBatch([makeTask({ allowedFiles: ["src/one.ts"] })], {
    mode: "sequential",
    computePolicy: policy,
    batchId: "b_executor",
    eventEmitter: () => undefined,
    executor: async (_input, options) => {
      observed.push(options.model);
      return makeFailure({ failureDecision: undefined });
    },
  } as BatchOptions);

  assert.equal(observed.length, 1);
  assert.equal(observed[0], singleChoice);
  assert.equal(observed[0], LUNA);
});

test("an envelope with no declared executor choice refuses instead of picking one", async () => {
  await assert.rejects(
    runBatch([makeTask()], {
      mode: "sequential",
      computePolicy: policyWith({ allowedModels: ["alpha", "beta"] }),
      batchId: "b_ambiguous",
      eventEmitter: () => undefined,
      executor: async () => {
        throw new Error("no worker may run without a declared executor");
      },
    } as BatchOptions),
    /declares no executor ordering/,
  );
});

// ---------------------------------------------------------------------------
// Terminal telemetry: one batch identity, one terminal outcome
// ---------------------------------------------------------------------------

test("a late failure after a published result does not publish a second outcome", async () => {
  const harness = makeDelegateHarness();
  const events: OrchestratorEvent[] = [];

  const response = await handleDelegateTask(makeTask(), undefined, {
    handoffStore: harness.handoffStore,
    continuationStore: harness.continuationStore,
    contextRegistry: harness.registry,
    contextStore: harness.contextStore,
    delegateToLuna: async (_task, _signal, hooks) => {
      hooks?.onStarted?.(process.cwd());
      return makeFailure({ failureDecision: undefined });
    },
    emit: (event) => events.push(event),
    record: () => {
      // A bookkeeping sink that fails after the outcome is already final.
      throw new Error("telemetry sink unavailable");
    },
    render: () => {
      throw new Error("renderer unavailable");
    },
    makeBatchId: () => "b_late",
  });

  assert.notEqual(response.isError, true);
  assert.match(response.content[0]?.text ?? "", /VERDICT: FAILED/);
  assert.match(response.content[0]?.text ?? "", /evidence is preserved/);
  assert.equal(response.structuredContent?.verdict, "FAILED");
  const terminal = events.filter(
    (event) =>
      event.type === "batch.completed" ||
      event.type === "batch.cancelled" ||
      event.type === "batch.rejected",
  );
  assert.equal(terminal.length, 1, "exactly one terminal batch event per batch identity");
  assert.equal(terminal[0]?.type, "batch.completed");
  assert.equal(
    events.filter((event) => event.type === "worker.failed").length,
    0,
    "a settled worker outcome is not re-reported as a failure",
  );
});

// ---------------------------------------------------------------------------
// Shared context: a finished execution cannot speak for a running sibling
// ---------------------------------------------------------------------------

test("a finished execution cannot compact or reclaim a context a sibling still holds", async () => {
  const events: OrchestratorEvent[] = [];
  const emit = (event: OrchestratorEvent): void => {
    events.push(event);
  };
  const handoffStore = new HandoffStore();
  const continuationStore = new ContinuationStore();
  const registry = new ContextLifecycleRegistry({
    handoffStore,
    continuationStore,
    emit,
  });
  const contextStore = new ContextLifecycleStore({
    handoffStore,
    continuationStore,
    emit,
    config: { maxTotalTurns: 1, minReclaimableBytes: 1, cooldownTurns: 0 },
  });

  let releaseB!: () => void;
  const bMayFinish = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  let bEntered!: () => void;
  const bIsRunning = new Promise<void>((resolve) => {
    bEntered = resolve;
  });

  const b = handleDelegateTask(makeTask({ allowedFiles: ["src/b.ts"] }), undefined, {
    handoffStore,
    continuationStore,
    contextRegistry: registry,
    contextStore,
    delegateToLuna: async () => {
      bEntered();
      await bMayFinish;
      return makeFailure({ failureDecision: undefined });
    },
    emit,
    record: () => undefined,
    makeBatchId: () => "b_long",
  });

  await bIsRunning;

  // A finishes entirely while B is still inside its executor.
  await handleDelegateTask(makeTask({ allowedFiles: ["src/a.ts"] }), undefined, {
    handoffStore,
    continuationStore,
    contextRegistry: registry,
    contextStore,
    delegateToLuna: async () => makeFailure({ failureDecision: undefined }),
    emit,
    record: () => undefined,
    makeBatchId: () => "b_short",
  });

  assert.equal(contextStore.isInFlight(), true, "B's lease survives A's release");
  const evaluated = events.filter((event) => event.type === "context.evaluated");
  assert.ok(evaluated.length > 0);
  assert.ok(
    evaluated.every((event) => event.boundary === "in-flight"),
    "a boundary reached while a sibling runs is never treated as safe",
  );
  assert.equal(
    events.some((event) => event.type === "context.compacted"),
    false,
    "A must not compact the shared context under a running B",
  );

  releaseB();
  await b;
  assert.equal(contextStore.isInFlight(), false);
});

// ---------------------------------------------------------------------------
// Long-lived authoritative context: bounded projections, unbounded evidence
// ---------------------------------------------------------------------------

test("repeated lifecycles compact the projection without discarding canonical evidence", async () => {
  const handoffStore = new HandoffStore();
  const continuationStore = new ContinuationStore();
  const registry = new ContextLifecycleRegistry({ handoffStore, continuationStore });
  const contextStore = new ContextLifecycleStore({
    handoffStore,
    continuationStore,
    // An aggressive target: every turn past the first is over the limit.
    config: {
      maxTotalTurns: 1,
      maxCleanTurns: 1,
      minReclaimableBytes: 1,
      cooldownTurns: 0,
    },
  });

  for (let turn = 0; turn < 6; turn += 1) {
    await handleDelegateTask(makeTask({ allowedFiles: [`src/f${turn}.ts`] }), undefined, {
      handoffStore,
      continuationStore,
      contextRegistry: registry,
      contextStore,
      delegateToLuna: async () => makeFailure(),
      emit: () => undefined,
      record: () => undefined,
      makeBatchId: () => `b_chain_${turn}`,
    });
  }

  const authoritative = contextStore.getAuthoritativeContext();
  assert.ok(authoritative);
  assert.equal(
    authoritative.turns.length,
    6,
    "authoritative history is never truncated to satisfy a size target",
  );

  const projection = contextStore.getCompactedProjection();
  assert.ok(projection, "an over-target context compacts its projection");
  // Every failed turn is diagnostic evidence, so none of them may be omitted
  // however far over the soft turn limit that puts the projection.
  assert.equal(projection.turns.length, 6);
  assert.equal(projection.stats.omittedCleanTurns, 0);
  assert.equal(projection.stats.retainedDiagnosticTurns, 6);
});

test("resetting a context does not report a live execution as idle", () => {
  const store = new ContextLifecycleStore();
  const release = store.acquireExecutionLease();
  assert.equal(store.isInFlight(), true);

  store.reset();

  assert.equal(
    store.isInFlight(),
    true,
    "a live execution survives a history replacement it never asked for",
  );
  release();
  assert.equal(store.isInFlight(), false);
});

test("a long continuation lineage expires and reclaims without resurrection or evidence loss", async () => {
  let now = 20_000_000;
  let token = 0;
  const released: WorktreeLease[] = [];
  const continuationStore = new ContinuationStore({
    now: () => now,
    tokenFactory: () => `ctr_${String(++token).padStart(32, "a")}`,
    releaseLease: (lease) => {
      released.push(lease);
    },
  });
  const handoffStore = new HandoffStore({ now: () => now });
  const registry = new ContextLifecycleRegistry({ handoffStore, continuationStore });
  const contextKey = "ctx_long_continuation_lineage";
  const contextStore = registry.getOrCreate(contextKey);
  const task = makeTask({ changeIntent: "optional" });
  const consumed: string[] = [];

  for (let turn = 1; turn <= 64; turn += 1) {
    const reference = continuationStore.issue(
      task,
      "thread-long-chain",
      process.cwd(),
      false,
      null,
      turn === 1 ? null : `exec_${turn - 1}`,
      turn + 1,
      LUNA,
      contextKey,
    );
    const ready = continuationStore.consume(reference);
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") return;
    assert.equal(
      ready.entry.predecessorExecutionId,
      turn === 1 ? null : `exec_${turn - 1}`,
    );

    const output = makeFailure({
      attempt: turn + 1,
      attempts: [
        {
          ...COMPLETED_ATTEMPT,
          executionId: `exec_${turn}`,
          logicalAttempt: turn + 1,
          predecessorExecutionId: turn === 1 ? null : `exec_${turn - 1}`,
          threadId: "thread-long-chain",
          threadOperation: "resume",
        },
      ],
    });
    contextStore.recordContinuationTurn(
      { continuationReference: reference, instruction: `continue turn ${turn}` },
      output,
      { id: `continuation_turn_${turn}` },
    );
    continuationStore.release(reference);
    consumed.push(reference);
    assert.equal(continuationStore.consume(reference).status, "used");

    if (turn % 8 === 0) {
      contextStore.evaluateAndMaybeCompact("post-continuation", { force: true });
    }
  }

  const expiringLease = makeLease("/repo/.sol-luna/worktrees/long-final");
  const expiring = continuationStore.issue(
    task,
    "thread-long-chain",
    expiringLease.worktreePath,
    true,
    expiringLease,
    "exec_64",
    66,
    LUNA,
    contextKey,
  );
  assert.equal(registry.size, 1);
  registry.releaseIfUnreferenced(contextKey);
  assert.equal(registry.size, 1, "a live capability keeps its context registered");

  now += CONTINUATION_TTL_MS;
  assert.equal(continuationStore.status(expiring), "unavailable");
  await continuationStore.whenExpiredLeasesReleased();
  assert.deepEqual(
    released.map((lease) => lease.ownerToken),
    [expiringLease.ownerToken],
  );
  assert.equal(continuationStore.consume(expiring).status, "expired");

  const authoritative = contextStore.getAuthoritativeContext();
  assert.equal(authoritative?.turns.length, 64);
  assert.deepEqual(
    authoritative?.lineage.map((entry) => entry.executionId),
    Array.from({ length: 64 }, (_, index) => `exec_${index + 1}`),
  );
  const projection = contextStore.getCompactedProjection();
  assert.ok(projection);
  assert.equal(projection.stats.retainedDiagnosticTurns, 64);
  assert.equal(
    consumed.every((reference) => continuationStore.status(reference) !== "issued"),
    true,
  );

  registry.releaseIfUnreferenced(contextKey);
  assert.equal(registry.size, 0, "expired capability and idle context are reclaimed");
  assert.equal(
    released.length,
    1,
    "the final retained lease is surrendered exactly once",
  );
});

test("shutdown invalidates capability stores and releases retained continuation leases once", async () => {
  const released: WorktreeLease[] = [];
  const continuationStore = new ContinuationStore({
    releaseLease: (lease) => {
      released.push(lease);
    },
  });
  const handoffStore = new HandoffStore();
  const lease = makeLease("/repo/.sol-luna/worktrees/shutdown-owned");
  const continuation = continuationStore.issue(
    makeTask(),
    "thread-shutdown",
    lease.worktreePath,
    true,
    lease,
  );
  const handoff = issueEscalation(handoffStore, makeTask());
  const coordinator = new ShutdownCoordinator();
  coordinator.registerCleanup(() => continuationStore.dispose());
  coordinator.registerCleanup(() => handoffStore.dispose());

  await coordinator.shutdown(1_000);
  assert.equal(continuationStore.consume(continuation).status, "unknown");
  assert.equal(handoffStore.consume(handoff).status, "unknown");
  assert.throws(
    () => continuationStore.issue(makeTask(), "thread-new", process.cwd()),
    /shut down/,
  );
  assert.throws(() => issueEscalation(handoffStore, makeTask()), /shut down/);
  assert.deepEqual(
    released.map((item) => item.ownerToken),
    [lease.ownerToken],
  );
  await coordinator.shutdown(1_000);
  assert.equal(released.length, 1);
});
