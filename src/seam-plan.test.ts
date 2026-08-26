/**
 * Decomposition and seam planning.
 *
 * Two things are pinned here. First, that a split is only ever earned by declared
 * or derivable evidence, and that silence, adjacency, worker counts, and shared
 * verification commands never earn one. Second, that the plan is genuinely routing's
 * input: several cases run the produced card straight through `evaluateRouting` so a
 * drift between the two layers fails a test rather than a delegation.
 */
import { test } from "node:test";
import assert from "node:assert";
import {
  SEAM_PLAN_REASONS,
  describeSeamPlanReason,
  planSeams,
  type SeamCandidate,
  type SeamPlanningInput,
} from "./seam-plan.js";
import { evaluateRouting, type ComputeEnvelope } from "./routing.js";

const ENVELOPE: ComputeEnvelope = {
  allowedEfforts: ["medium", "high", "xhigh", "max"],
  maxConcurrency: 4,
  maxWorkersPerBatch: 4,
};

/** The evidence a caller must state before any split is available at all. */
const INDEPENDENT = {
  sharedState: "none",
  coreOverlap: "disjoint",
  integration: "mechanical",
} as const;

function unit(label: string, extra: Partial<SeamCandidate> = {}): SeamCandidate {
  return { label, changeIntent: "required", ...extra };
}

// --- Shape invariants ------------------------------------------------------

test("seam count always matches the card the plan hands to routing", () => {
  const inputs: SeamPlanningInput[] = [
    { candidates: [] },
    { candidates: [unit("a")] },
    { candidates: [unit("a"), unit("b")] },
    {
      candidates: [
        unit("a", { allowedFiles: ["pkg/a/**"] }),
        unit("b", { allowedFiles: ["pkg/b/**"] }),
      ],
      declared: INDEPENDENT,
    },
  ];
  for (const input of inputs) {
    const plan = planSeams(input);
    assert.equal(plan.proposedSeamCount, plan.preflightCard.seams.length);
  }
});

test("identical inputs produce identical plans", () => {
  const input: SeamPlanningInput = {
    candidates: [
      unit("api", {
        allowedFiles: ["src/api/**"],
        verificationCommands: ["npm run t:api"],
      }),
      unit("web", {
        allowedFiles: ["src/web/**"],
        verificationCommands: ["npm run t:web"],
      }),
    ],
    declared: INDEPENDENT,
  };
  assert.deepEqual(planSeams(input), planSeams(input));
});

test("every reason code has prose", () => {
  for (const reason of SEAM_PLAN_REASONS) {
    assert.equal(typeof describeSeamPlanReason(reason), "string");
    assert.ok(describeSeamPlanReason(reason).length > 0);
  }
});

// --- Zero and solo ---------------------------------------------------------

test("no declared work is zero seams, not one", () => {
  const plan = planSeams({ candidates: [] });
  assert.equal(plan.decision, "keep-whole");
  assert.equal(plan.proposedSeamCount, 0);
  assert.equal(plan.reason, "no-declared-work");
  assert.deepEqual(plan.preflightCard.seams, []);
  // Routing owns what an empty decomposition means for a mechanism.
  const routed = evaluateRouting(plan.preflightCard, {
    mode: "preflight",
    envelope: ENVELOPE,
  });
  assert.equal(routed.route, "solo");
  assert.equal(routed.shape?.mechanism, "solo");
  assert.equal(routed.shape?.workerCount, 0);
});

test("one unit of work is already one seam", () => {
  const plan = planSeams({
    candidates: [unit("refactor parser", { allowedFiles: ["src/p.ts"] })],
  });
  assert.equal(plan.decision, "keep-whole");
  assert.equal(plan.proposedSeamCount, 1);
  assert.equal(plan.reason, "single-seam");
  assert.deepEqual(plan.preflightCard.seams, ["refactor parser"]);
});

test("a single unit is never asserted independent on no evidence", () => {
  const plan = planSeams({ candidates: [unit("solo")] });
  assert.equal(plan.dependency, "unknown");
  assert.equal(plan.preflightCard.sharedState, "unknown");
  assert.equal(plan.preflightCard.coreOverlap, "unknown");
});

// --- Unknown evidence biases to keeping work whole -------------------------

test("undeclared coupling keeps work whole and fabricates nothing", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["pkg/a/**"] }),
      unit("b", { allowedFiles: ["pkg/b/**"] }),
    ],
  });
  assert.equal(plan.decision, "keep-whole");
  assert.equal(plan.reason, "undeclared-coupling");
  assert.equal(plan.dependency, "unknown");
  // The unstated stays unstated. Routing's hard gates read raw declarations, so a
  // manufactured `none`/`disjoint` here would be a fabricated permission there.
  assert.equal(plan.preflightCard.sharedState, "unknown");
  assert.equal(plan.preflightCard.coreOverlap, "unknown");
  assert.equal(plan.preflightCard.integration, "unknown");
});

test("keeping work whole never fabricates a hazard either", () => {
  const plan = planSeams({ candidates: [unit("a"), unit("b")] });
  assert.equal(plan.decision, "keep-whole");
  assert.notEqual(plan.preflightCard.sharedState, "mutable");
  assert.notEqual(plan.preflightCard.integration, "architectural");
});

test("partial evidence is still unknown evidence", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["pkg/a/**"] }),
      unit("b", { allowedFiles: ["pkg/b/**"] }),
    ],
    declared: { sharedState: "none", coreOverlap: "disjoint" }, // integration omitted
  });
  assert.equal(plan.decision, "keep-whole");
  assert.equal(plan.reason, "undeclared-coupling");
});

// --- Declared coupling -----------------------------------------------------

test("declared mutable shared state keeps work whole", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["pkg/a/**"] }),
      unit("b", { allowedFiles: ["pkg/b/**"] }),
    ],
    declared: { ...INDEPENDENT, sharedState: "mutable" },
  });
  assert.equal(plan.decision, "keep-whole");
  assert.equal(plan.reason, "declared-shared-mutable-state");
  assert.equal(plan.dependency, "dependent");
});

test("declared shared core keeps work whole", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["pkg/a/**"] }),
      unit("b", { allowedFiles: ["pkg/b/**"] }),
    ],
    declared: { ...INDEPENDENT, coreOverlap: "shared-core" },
  });
  assert.equal(plan.decision, "keep-whole");
  assert.equal(plan.reason, "declared-shared-core");
  assert.equal(plan.dependency, "dependent");
});

test("architectural integration keeps work whole", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["pkg/a/**"] }),
      unit("b", { allowedFiles: ["pkg/b/**"] }),
    ],
    declared: { ...INDEPENDENT, integration: "architectural" },
  });
  assert.equal(plan.decision, "keep-whole");
  assert.equal(plan.reason, "architectural-integration");
  // Independence is about state and core; the integration cost is separate.
  assert.equal(plan.dependency, "independent");
});

// --- Overlapping scopes ----------------------------------------------------

test("overlapping declared scopes outrank an optimistic declaration", () => {
  const plan = planSeams({
    candidates: [
      unit("all of src", { allowedFiles: ["src/**"] }),
      unit("one file", { allowedFiles: ["src/utils.ts"] }),
    ],
    declared: INDEPENDENT,
  });
  assert.equal(plan.decision, "keep-whole");
  assert.equal(plan.reason, "overlapping-scopes");
  assert.equal(plan.dependency, "dependent");
  assert.equal(plan.preflightCard.coreOverlap, "shared-core");
});

test("an unrestricted scope overlaps everything", () => {
  const plan = planSeams({
    candidates: [unit("unscoped"), unit("b", { allowedFiles: ["pkg/b/**"] })],
    declared: INDEPENDENT,
  });
  assert.equal(plan.decision, "keep-whole");
  assert.equal(plan.reason, "overlapping-scopes");
});

test("a plan never blesses scopes the parallel batch gate would refuse", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["src/**"] }),
      unit("b", { allowedFiles: ["src/deep/nested.ts"] }),
    ],
    declared: INDEPENDENT,
  });
  const routed = evaluateRouting(plan.preflightCard, {
    mode: "parallel",
    taskCount: 1,
    envelope: ENVELOPE,
  });
  assert.equal(routed.parallelEligible, false);
  assert.equal(routed.route, "solo");
});

// --- Same-directory proximity is not coupling ------------------------------

test("two files in one directory are two files, not a shared core", () => {
  const plan = planSeams({
    candidates: [
      unit("a", {
        allowedFiles: ["src/utils/a.ts"],
        verificationCommands: ["npm run t:a"],
      }),
      unit("b", {
        allowedFiles: ["src/utils/b.ts"],
        verificationCommands: ["npm run t:b"],
      }),
    ],
    declared: INDEPENDENT,
  });
  assert.equal(plan.decision, "split");
  assert.equal(plan.reason, "independent-seams");
  assert.equal(plan.dependency, "independent");
  assert.equal(plan.preflightCard.coreOverlap, "disjoint");
});

// --- Verification boundaries are not dependencies --------------------------

test("a shared verification command is a proof boundary, not a dependency", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["pkg/a/**"], verificationCommands: ["npm test"] }),
      unit("b", { allowedFiles: ["pkg/b/**"], verificationCommands: ["npm test"] }),
    ],
    declared: INDEPENDENT,
  });
  assert.equal(plan.decision, "split");
  assert.equal(plan.proposedSeamCount, 2);
  assert.equal(plan.dependency, "independent");
  assert.equal(plan.preflightCard.verification, "shared-only");
  // Nothing races, so nothing is refused; routing turns the boundary into an
  // economic signal on its own.
  assert.equal(plan.preflightCard.sharedState, "none");
  assert.equal(plan.preflightCard.coreOverlap, "disjoint");
  const routed = evaluateRouting(plan.preflightCard, {
    mode: "preflight",
    envelope: ENVELOPE,
  });
  assert.equal(routed.parallelEligible, true);
  assert.ok(routed.signals.includes("shared-verification-only"));
  assert.equal(routed.gates.length, 0);
});

test("distinct per-seam checks are per-seam proof", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["pkg/a/**"], verificationCommands: ["npm run t:a"] }),
      unit("b", { allowedFiles: ["pkg/b/**"], verificationCommands: ["npm run t:b"] }),
    ],
    declared: INDEPENDENT,
  });
  assert.equal(plan.preflightCard.verification, "per-seam");
});

test("a unit with no declared checks leaves the proof boundary unknown", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["pkg/a/**"], verificationCommands: ["npm run t:a"] }),
      unit("b", { allowedFiles: ["pkg/b/**"] }),
    ],
    declared: INDEPENDENT,
  });
  assert.equal(plan.decision, "split");
  assert.equal(plan.preflightCard.verification, "unknown");
});

test("a declared per-seam claim never survives a derived shared boundary", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["pkg/a/**"], verificationCommands: ["npm test"] }),
      unit("b", { allowedFiles: ["pkg/b/**"], verificationCommands: ["npm test"] }),
    ],
    declared: { ...INDEPENDENT, verification: "per-seam" },
  });
  assert.equal(plan.preflightCard.verification, "shared-only");
});

// --- Read-only work --------------------------------------------------------

test("disjoint read-only work is independent and parallel by default", () => {
  const plan = planSeams({
    candidates: [
      {
        label: "audit a",
        changeIntent: "forbidden",
        allowedFiles: ["pkg/a/**"],
        verificationCommands: ["npm run lint:a"],
      },
      {
        label: "audit b",
        changeIntent: "forbidden",
        allowedFiles: ["pkg/b/**"],
        verificationCommands: ["npm run lint:b"],
      },
    ],
  });
  // No `declared` block at all: the change intent alone earns the split.
  assert.equal(plan.decision, "split");
  assert.equal(plan.dependency, "independent");
  assert.equal(plan.preflightCard.sharedState, "read-only");
  assert.equal(plan.preflightCard.coreOverlap, "disjoint");
  assert.equal(plan.preflightCard.integration, "mechanical");

  const routed = evaluateRouting(plan.preflightCard, {
    mode: "parallel",
    taskCount: 2,
    envelope: ENVELOPE,
  });
  assert.equal(routed.refusedGate, null);
  assert.equal(routed.parallelEligible, true);
  assert.equal(routed.shape?.mechanism, "delegate_tasks_parallel");
  assert.equal(routed.shape?.workerCount, 2);
  assert.equal(routed.shape?.concurrency, 2);
});

test("one change-capable unit removes the read-only derivation for all of them", () => {
  const plan = planSeams({
    candidates: [
      { label: "audit", changeIntent: "forbidden", allowedFiles: ["pkg/a/**"] },
      unit("edit", { allowedFiles: ["pkg/b/**"] }),
    ],
  });
  assert.equal(plan.decision, "keep-whole");
  assert.equal(plan.reason, "undeclared-coupling");
});

test("a declared hazard still outranks the read-only derivation", () => {
  const plan = planSeams({
    candidates: [
      { label: "a", changeIntent: "forbidden", allowedFiles: ["pkg/a/**"] },
      { label: "b", changeIntent: "forbidden", allowedFiles: ["pkg/b/**"] },
    ],
    declared: { coreOverlap: "shared-core" },
  });
  assert.equal(plan.decision, "keep-whole");
  assert.equal(plan.reason, "declared-shared-core");
});

// --- Policy is capacity, not semantics -------------------------------------

test("seam count is never trimmed to a worker budget", () => {
  const candidates = ["a", "b", "c", "d", "e"].map((name) =>
    unit(name, {
      allowedFiles: [`pkg/${name}/**`],
      verificationCommands: [`npm run t:${name}`],
    }),
  );
  const plan = planSeams({ candidates, declared: INDEPENDENT });
  assert.equal(plan.decision, "split");
  assert.equal(plan.proposedSeamCount, 5);

  // The narrow envelope constrains what one call may enlist, and says so, without
  // ever changing how many seams the work actually has.
  const routed = evaluateRouting(plan.preflightCard, {
    mode: "preflight",
    envelope: { ...ENVELOPE, maxWorkersPerBatch: 3, maxConcurrency: 2 },
  });
  assert.equal(routed.seamCount, 5);
  assert.equal(routed.shape?.workerCount, 3);
  assert.equal(routed.shape?.seamsOverCap, 2);
});

test("a zero-worker envelope changes the shape, not the decomposition", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["pkg/a/**"], verificationCommands: ["npm run t:a"] }),
      unit("b", { allowedFiles: ["pkg/b/**"], verificationCommands: ["npm run t:b"] }),
    ],
    declared: INDEPENDENT,
  });
  assert.equal(plan.decision, "split");
  const routed = evaluateRouting(plan.preflightCard, {
    mode: "preflight",
    envelope: { ...ENVELOPE, maxWorkersPerBatch: 0, maxConcurrency: 0 },
  });
  assert.equal(routed.shape?.mechanism, "solo");
  assert.equal(routed.shape?.workerCount, 0);
});

// --- The plan names no mechanism -------------------------------------------

test("a plan carries no mechanism, effort, worker count, or concurrency", () => {
  const plan = planSeams({
    candidates: [
      unit("a", { allowedFiles: ["pkg/a/**"] }),
      unit("b", { allowedFiles: ["pkg/b/**"] }),
    ],
    declared: INDEPENDENT,
  });
  assert.deepEqual(Object.keys(plan).sort(), [
    "decision",
    "dependency",
    "preflightCard",
    "proposedSeamCount",
    "reason",
  ]);
});

// --- Labels ----------------------------------------------------------------

test("work kept whole is labelled from its own units", () => {
  const plan = planSeams({
    candidates: [unit("parser"), unit("lexer"), unit("emitter")],
  });
  assert.deepEqual(plan.preflightCard.seams, ["parser +2 more"]);
});

test("labels stay inside the card's schema cap", () => {
  const long = "x".repeat(200);
  const whole = planSeams({ candidates: [unit(long), unit(long)] });
  const split = planSeams({
    candidates: [
      unit(long, { allowedFiles: ["pkg/a/**"] }),
      unit(long, { allowedFiles: ["pkg/b/**"] }),
    ],
    declared: INDEPENDENT,
  });
  for (const seam of [...whole.preflightCard.seams, ...split.preflightCard.seams]) {
    assert.ok(seam.length > 0 && seam.length <= 48, `label length ${seam.length}`);
  }
});

test("a blank label becomes a positional one rather than an empty seam", () => {
  const plan = planSeams({
    candidates: [
      unit("  ", { allowedFiles: ["pkg/a/**"] }),
      unit("b", { allowedFiles: ["pkg/b/**"] }),
    ],
    declared: INDEPENDENT,
  });
  assert.deepEqual(plan.preflightCard.seams, ["seam-1", "b"]);
});
