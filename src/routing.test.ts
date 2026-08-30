/**
 * Cheap routing evaluator tests.
 *
 * The evaluator is pure, so these are exhaustive where exhaustive is cheap: the
 * full enum cross-product is only a few hundred cards, and covering it outright
 * is more convincing than choosing examples. The properties asserted over it are
 * the ones the design turns on — uncertainty never refuses, hard gates read raw
 * declarations only, and seam labels never leave the caller's own message.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import {
  CORE_OVERLAPS,
  countUnknowns,
  declaredRoutingFields,
  describeRefusal,
  evaluateParallelEligibility,
  evaluateRouting,
  INTEGRATIONS,
  recommendExecutionShape,
  renderRoutingAdvisory,
  renderRoutingPreflight,
  resolveRoutingValues,
  ROUTING_GATES,
  SEAM_SIZES,
  SHARED_STATES,
  VERIFICATIONS,
  type ComputeEnvelope,
  type CoreOverlap,
  type Integration,
  type RoutingMode,
  type RoutingPreflightCard,
  type SeamSize,
  type SharedState,
  type Verification,
} from "./routing.js";
import { DEFAULT_COMPUTE_POLICY } from "./policy.js";
import { EFFORTS, type Effort } from "./config.js";

/**
 * Source-tree paths, resolved from the compiled test's own location: the checks
 * below are about what the TypeScript sources import and contain, which is not
 * observable from the emitted JavaScript alone.
 */
const SRC_DIR = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  "src",
);

/** A card with no declared hazards, so each test states only what it varies. */
const clean = (overrides: Partial<RoutingPreflightCard> = {}): RoutingPreflightCard => ({
  seams: ["alpha", "beta"],
  seamSize: "substantial",
  sharedState: "none",
  coreOverlap: "disjoint",
  integration: "mechanical",
  verification: "per-seam",
  ...overrides,
});

/** Every card the vocabulary can express, ignoring seam labels. */
function everyCardShape(): RoutingPreflightCard[] {
  const cards: RoutingPreflightCard[] = [];
  for (const seamSize of SEAM_SIZES) {
    for (const sharedState of SHARED_STATES) {
      for (const coreOverlap of CORE_OVERLAPS) {
        for (const integration of INTEGRATIONS) {
          for (const verification of VERIFICATIONS) {
            for (const seamCount of [0, 1, 2, 3]) {
              cards.push({
                seams: Array.from({ length: seamCount }, (_, i) => `seam-${i}`),
                seamSize,
                sharedState,
                coreOverlap,
                integration,
                verification,
              });
            }
          }
        }
      }
    }
  }
  return cards;
}

const ALL_MODES: RoutingMode[] = ["preflight", "single", "sequential", "parallel"];

/** The largest batch the contract accepts, so shape advisories all fire at once. */
const MAX_ADVISORY_TASK_COUNT = 12;

/**
 * Ceiling on the whole preflight answer, in characters.
 *
 * A routing advisory that prevents one unnecessary delegation has to stay
 * materially cheaper than the delegation, so the text is metered rather than
 * merely reviewed. The shape line is measured inside this same total and did not
 * require raising it.
 */
const PREFLIGHT_TEXT_BUDGET = 460;

// --- Unknown resolution -----------------------------------------------------

test("routing - each unknown resolves to its Solo-favouring advisory value", () => {
  const resolved = resolveRoutingValues({
    seams: ["alpha"],
    seamSize: "unknown",
    sharedState: "unknown",
    coreOverlap: "unknown",
    integration: "unknown",
    verification: "unknown",
  });
  assert.deepEqual(resolved, {
    seamSize: "small",
    sharedState: "mutable",
    coreOverlap: "shared-core",
    integration: "architectural",
    verification: "shared-only",
  });
});

test("routing - an entirely unknown card recommends solo without refusing", () => {
  const card = clean({
    seams: ["alpha", "beta"],
    seamSize: "unknown",
    sharedState: "unknown",
    coreOverlap: "unknown",
    integration: "unknown",
    verification: "unknown",
  });
  for (const mode of ALL_MODES) {
    const evaluation = evaluateRouting(card, { mode, taskCount: 2 });
    assert.equal(evaluation.route, "solo", `${mode} should advise solo`);
    assert.deepEqual(evaluation.gates, [], `${mode} must not gate on unknown`);
    assert.equal(evaluation.refusedGate, null, `${mode} must not refuse on unknown`);
  }
});

test("routing - unknown never fires a hard gate in any mode", () => {
  for (const card of everyCardShape()) {
    if (card.seams.length === 0) continue; // the empty-seam gate is not about unknown
    for (const mode of ALL_MODES) {
      const evaluation = evaluateRouting(card, { mode, taskCount: card.seams.length });
      if (card.sharedState === "unknown") {
        assert.ok(
          !evaluation.gates.includes("parallel-shared-mutable"),
          "unknown sharedState must not gate",
        );
      }
      if (card.coreOverlap === "unknown") {
        assert.ok(
          !evaluation.gates.includes("parallel-shared-core"),
          "unknown coreOverlap must not gate",
        );
      }
    }
  }
});

test("routing - hard gates read raw declarations, never resolved values", () => {
  // Both cards resolve identically for advisory purposes; only the explicit one
  // may gate. This is the raw/resolved boundary stated as a test.
  const declared = clean({ sharedState: "mutable", coreOverlap: "shared-core" });
  const admitted = clean({ sharedState: "unknown", coreOverlap: "unknown" });
  const context = { mode: "parallel" as const, taskCount: 2 };

  const declaredEvaluation = evaluateRouting(declared, context);
  const admittedEvaluation = evaluateRouting(admitted, context);

  assert.deepEqual(declaredEvaluation.resolved, admittedEvaluation.resolved);
  assert.equal(declaredEvaluation.route, admittedEvaluation.route);
  assert.deepEqual(declaredEvaluation.gates, [
    "parallel-shared-mutable",
    "parallel-shared-core",
  ]);
  assert.deepEqual(admittedEvaluation.gates, []);
  assert.equal(admittedEvaluation.refusedGate, null);
});

test("routing - unknownCount distinguishes explicit declarations from resolution", () => {
  assert.equal(countUnknowns(clean()), 0);
  assert.equal(countUnknowns(clean({ sharedState: "unknown" })), 1);
  assert.equal(
    countUnknowns(
      clean({
        seamSize: "unknown",
        sharedState: "unknown",
        coreOverlap: "unknown",
        integration: "unknown",
        verification: "unknown",
      }),
    ),
    5,
  );
  // An explicitly declared hazard and an admitted unknown resolve the same way
  // but must never be counted the same way.
  const declared = evaluateRouting(clean({ sharedState: "mutable" }), {
    mode: "sequential",
    taskCount: 2,
  });
  const admitted = evaluateRouting(clean({ sharedState: "unknown" }), {
    mode: "sequential",
    taskCount: 2,
  });
  assert.equal(declared.unknownCount, 0);
  assert.equal(admitted.unknownCount, 1);
  assert.equal(declared.resolved.sharedState, admitted.resolved.sharedState);
});

// --- Explicit hazards -------------------------------------------------------

test("routing - explicit mutable shared state gates parallel only", () => {
  const card = clean({ sharedState: "mutable" });
  assert.deepEqual(evaluateRouting(card, { mode: "parallel", taskCount: 2 }).gates, [
    "parallel-shared-mutable",
  ]);
  for (const mode of ["preflight", "single", "sequential"] as const) {
    assert.deepEqual(
      evaluateRouting(card, { mode, taskCount: 2 }).gates,
      [],
      `${mode} must not treat shared state as structural`,
    );
  }
});

test("routing - explicit shared core gates parallel only", () => {
  const card = clean({ coreOverlap: "shared-core" });
  assert.deepEqual(evaluateRouting(card, { mode: "parallel", taskCount: 2 }).gates, [
    "parallel-shared-core",
  ]);
  for (const mode of ["preflight", "single", "sequential"] as const) {
    assert.deepEqual(evaluateRouting(card, { mode, taskCount: 2 }).gates, []);
  }
});

test("routing - more parallel tasks than seams is structural, sequential is not", () => {
  const card = clean({ seams: ["alpha", "beta"] });
  const parallel = evaluateRouting(card, { mode: "parallel", taskCount: 3 });
  assert.deepEqual(parallel.gates, ["parallel-tasks-exceed-seams"]);
  assert.equal(parallel.refusedGate, "parallel-tasks-exceed-seams");

  const sequential = evaluateRouting(card, { mode: "sequential", taskCount: 3 });
  assert.deepEqual(sequential.gates, []);
  assert.equal(sequential.refusedGate, null);
  assert.ok(sequential.signals.includes("steps-exceed-seams"));
});

test("routing - allowOverlappingScopes downgrades shared core but never mutable state", () => {
  const sharedCore = evaluateRouting(clean({ coreOverlap: "shared-core" }), {
    mode: "parallel",
    taskCount: 2,
    allowOverlappingScopes: true,
  });
  assert.deepEqual(sharedCore.gates, ["parallel-shared-core"]);
  assert.equal(sharedCore.refusedGate, null, "an accepted overlap must not refuse");

  const mutable = evaluateRouting(clean({ sharedState: "mutable" }), {
    mode: "parallel",
    taskCount: 2,
    allowOverlappingScopes: true,
  });
  assert.equal(mutable.refusedGate, "parallel-shared-mutable");

  // The escape hatch downgrades exactly one gate, not the other, even together.
  const both = evaluateRouting(
    clean({ sharedState: "mutable", coreOverlap: "shared-core" }),
    { mode: "parallel", taskCount: 2, allowOverlappingScopes: true },
  );
  assert.equal(both.refusedGate, "parallel-shared-mutable");
});

test("routing - the empty seam list is the one universal structural gate", () => {
  const card = clean({ seams: [] });
  for (const mode of ["single", "sequential", "parallel"] as const) {
    const evaluation = evaluateRouting(card, { mode, taskCount: 1 });
    assert.ok(evaluation.gates.includes("seam-count-zero"));
    assert.equal(evaluation.refusedGate, "seam-count-zero");
  }
  // Even the escape hatch cannot make an empty declaration delegable.
  assert.equal(
    evaluateRouting(card, {
      mode: "parallel",
      taskCount: 1,
      allowOverlappingScopes: true,
    }).refusedGate,
    "seam-count-zero",
  );
});

test("routing - zero seams is a valid preflight answer, not a refusal", () => {
  const evaluation = evaluateRouting(clean({ seams: [] }), { mode: "preflight" });
  assert.equal(evaluation.route, "solo");
  assert.equal(evaluation.refusedGate, null);
  assert.equal(evaluation.parallelEligible, false);
  assert.ok(evaluation.gates.includes("seam-count-zero"));
});

test("routing - the advisory surface refuses nothing at all", () => {
  for (const card of everyCardShape()) {
    const evaluation = evaluateRouting(card, { mode: "preflight", taskCount: 12 });
    assert.equal(evaluation.refusedGate, null, "preflight must never refuse");
  }
});

// --- Tier 1 -----------------------------------------------------------------

test("routing - shared state blocks parallel without making substantial delegation impossible", () => {
  const cases: Array<[string, Partial<RoutingPreflightCard>]> = [
    ["shared-mutable-state", { sharedState: "mutable" }],
    ["shared-core", { coreOverlap: "shared-core" }],
  ];
  for (const [signal, overrides] of cases) {
    for (const mode of ALL_MODES) {
      const evaluation = evaluateRouting(clean(overrides), { mode, taskCount: 2 });
      assert.equal(
        evaluation.route,
        "either",
        `${signal} may run singly or sequentially`,
      );
      assert.equal(evaluation.ruleId, "R4");
      assert.ok(
        evaluation.signals.includes(signal as never),
        `${signal} should be reported in ${mode}`,
      );
    }
  }
});

test("routing - architectural integration remains decisive solo advice", () => {
  for (const mode of ALL_MODES) {
    const evaluation = evaluateRouting(clean({ integration: "architectural" }), {
      mode,
      taskCount: 2,
    });
    assert.equal(evaluation.route, "solo");
    assert.equal(evaluation.ruleId, "R1");
  }
});

test("routing - read-only shared state is not a coupling signal", () => {
  const evaluation = evaluateRouting(clean({ sharedState: "read-only" }), {
    mode: "parallel",
    taskCount: 2,
  });
  assert.ok(!evaluation.signals.includes("shared-mutable-state"));
  assert.deepEqual(evaluation.gates, []);
  assert.equal(evaluation.route, "delegation-plausible");
  assert.equal(evaluation.parallelEligible, true);
});

// --- Tier 2 -----------------------------------------------------------------

test("routing - both Tier 2 signals recommend solo", () => {
  const evaluation = evaluateRouting(
    clean({ seamSize: "small", verification: "shared-only", seams: ["a", "b"] }),
    { mode: "parallel", taskCount: 2 },
  );
  assert.equal(evaluation.route, "solo");
  assert.equal(evaluation.ruleId, "R3");
  assert.deepEqual(evaluation.signals, ["small-seam", "shared-verification-only"]);
});

test("routing - three explicit small disjoint read-only seams escape R3 Solo narrowly", () => {
  const evaluation = evaluateRouting(
    clean({
      seams: ["tokenizer", "renderer", "fingerprinter"],
      seamSize: "small",
      sharedState: "read-only",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "shared-only",
    }),
    { mode: "preflight", envelope: WIDE_ENVELOPE },
  );
  assert.equal(evaluation.ruleId, "R3");
  assert.equal(evaluation.route, "either");
  assert.equal(evaluation.parallelEligible, true);
  assert.equal(evaluation.shape?.mechanism, "delegate_tasks_sequential");
});

test("routing correction - obvious single small coupled seam stays Solo", () => {
  const evaluation = evaluateRouting(
    clean({
      seams: ["coupled-leaf"],
      seamSize: "small",
      sharedState: "mutable",
      coreOverlap: "shared-core",
    }),
    { mode: "single", envelope: WIDE_ENVELOPE },
  );
  assert.equal(evaluation.route, "solo");
  assert.equal(evaluation.ruleId, "R1");
});

test("routing correction - substantial mutable leaf permits one sequential owner", () => {
  const evaluation = evaluateRouting(
    clean({ seams: ["mutable-leaf"], sharedState: "mutable" }),
    { mode: "single", taskCount: 1, envelope: WIDE_ENVELOPE },
  );
  assert.equal(evaluation.parallelEligible, false);
  assert.equal(evaluation.route, "either");
  assert.equal(evaluation.ruleId, "R4");
  assert.equal(evaluation.shape?.mechanism, "delegate_task");
});

test("routing correction - static-site pipeline repetition-2 shape is delegation-plausible enough", () => {
  const evaluation = evaluateRouting(
    clean({
      seams: ["tokenizer", "template renderer", "asset fingerprinter"],
      seamSize: "small",
      sharedState: "read-only",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "shared-only",
    }),
    { mode: "preflight", envelope: WIDE_ENVELOPE },
  );
  assert.equal(evaluation.ruleId, "R3");
  assert.equal(evaluation.route, "either");
  assert.equal(evaluation.shape?.mechanism, "delegate_tasks_sequential");
});

test("routing correction - observability parser leaves are classified independently", () => {
  for (const seam of ["JSONL parser", "access-log parser"]) {
    const evaluation = evaluateRouting(
      clean({ seams: [seam], sharedState: "read-only" }),
      { mode: "single", taskCount: 1, envelope: WIDE_ENVELOPE },
    );
    assert.equal(evaluation.route, "delegation-plausible");
    assert.equal(evaluation.ruleId, "R5");
    assert.equal(evaluation.shape?.mechanism, "delegate_task");
  }
});

test("routing correction - parent-retained AST contract leaves renderers bounded", () => {
  for (const seam of ["HTML renderer", "text renderer", "Markdown renderer"]) {
    const evaluation = evaluateRouting(
      clean({ seams: [seam], sharedState: "read-only" }),
      { mode: "single", taskCount: 1, envelope: WIDE_ENVELOPE },
    );
    assert.equal(evaluation.route, "delegation-plausible");
    assert.equal(evaluation.parallelEligible, false, "one leaf is not a parallel plan");
    assert.equal(evaluation.shape?.mechanism, "delegate_task");
  }
});

test("routing correction - provenance distinguishes explicit cards from defaults", () => {
  const explicit = evaluateRouting(clean(), { mode: "preflight" });
  const defaulted = evaluateRouting(clean({ verification: "unknown" }), {
    mode: "preflight",
  });
  assert.equal(explicit.cardProvenance, "explicit");
  assert.equal(explicit.ruleId, "R5");
  assert.equal(defaulted.cardProvenance, "pessimistic-defaults");
  assert.equal(defaulted.ruleId, "R4");
});

test("routing - exactly one Tier 2 signal is ambiguous, not a delegation", () => {
  const smallOnly = evaluateRouting(clean({ seamSize: "small", seams: ["a", "b"] }), {
    mode: "parallel",
    taskCount: 2,
  });
  assert.equal(smallOnly.route, "either");

  const sharedVerification = evaluateRouting(clean({ verification: "shared-only" }), {
    mode: "parallel",
    taskCount: 2,
  });
  assert.equal(sharedVerification.route, "either");
});

test("routing - no signals at all is the only delegation-plausible route", () => {
  const evaluation = evaluateRouting(clean(), { mode: "parallel", taskCount: 2 });
  assert.equal(evaluation.route, "delegation-plausible");
  assert.deepEqual(evaluation.signals, []);
});

test("routing - a small single seam is solo even without a second Tier 2 signal", () => {
  const oneSeam = evaluateRouting(clean({ seamSize: "small", seams: ["only"] }), {
    mode: "single",
    taskCount: 1,
  });
  assert.equal(oneSeam.route, "solo");
  // The same card with two seams is merely ambiguous, which is what makes this
  // rule about overhead per seam rather than about size alone.
  assert.equal(
    evaluateRouting(clean({ seamSize: "small", seams: ["a", "b"] }), {
      mode: "single",
      taskCount: 1,
    }).route,
    "either",
  );
});

// --- Route-neutral advisories ----------------------------------------------

test("routing - shape advisories never move the route", () => {
  const singleSeamBatch = evaluateRouting(clean({ seams: ["only"] }), {
    mode: "sequential",
    taskCount: 1,
  });
  assert.ok(singleSeamBatch.signals.includes("single-seam-batch"));
  assert.equal(singleSeamBatch.route, "delegation-plausible");

  const stepsExceed = evaluateRouting(clean({ seams: ["a", "b"] }), {
    mode: "sequential",
    taskCount: 5,
  });
  assert.ok(stepsExceed.signals.includes("steps-exceed-seams"));
  assert.equal(stepsExceed.route, "delegation-plausible");

  // Neither advisory belongs to a single delegation, which has no batch shape.
  const single = evaluateRouting(clean({ seams: ["only"] }), {
    mode: "single",
    taskCount: 1,
  });
  assert.deepEqual(single.signals, []);
});

// --- Parallel eligibility ---------------------------------------------------

test("routing - parallel eligibility needs at least two seams", () => {
  assert.equal(evaluateParallelEligibility(clean({ seams: [] })), false);
  assert.equal(evaluateParallelEligibility(clean({ seams: ["only"] })), false);
  assert.equal(evaluateParallelEligibility(clean({ seams: ["a", "b"] })), true);
  assert.equal(evaluateParallelEligibility(clean({ seams: ["a", "b", "c"] })), true);
});

test("routing - explicitly declared hazards make parallel structurally ineligible", () => {
  assert.equal(evaluateParallelEligibility(clean({ sharedState: "mutable" })), false);
  assert.equal(evaluateParallelEligibility(clean({ coreOverlap: "shared-core" })), false);
});

test("routing - unknown hazards do not force parallel ineligibility", () => {
  assert.equal(
    evaluateParallelEligibility(
      clean({ sharedState: "unknown", coreOverlap: "unknown" }),
    ),
    true,
  );
  // An unstated hazard stays eligible; a stated one does not, even alongside it.
  assert.equal(
    evaluateParallelEligibility(
      clean({ sharedState: "unknown", coreOverlap: "shared-core" }),
    ),
    false,
  );
});

test("routing - parallel eligibility is structural and can disagree with the route", () => {
  // The design's worked example: separable, but not worth separating.
  const evaluation = evaluateRouting(
    clean({
      seams: ["alpha", "beta"],
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "architectural",
      verification: "per-seam",
    }),
    { mode: "parallel", taskCount: 2 },
  );
  assert.equal(evaluation.parallelEligible, true);
  assert.equal(evaluation.route, "solo");
  assert.deepEqual(evaluation.gates, []);
});

test("routing - parallel eligibility depends on nothing but the three raw inputs", () => {
  for (const card of everyCardShape()) {
    const expected =
      card.seams.length >= 2 &&
      card.sharedState !== "mutable" &&
      card.coreOverlap !== "shared-core";
    for (const mode of ALL_MODES) {
      for (const taskCount of [1, 2, 7]) {
        for (const allowOverlappingScopes of [false, true]) {
          const evaluation = evaluateRouting(card, {
            mode,
            taskCount,
            allowOverlappingScopes,
          });
          assert.equal(
            evaluation.parallelEligible,
            expected,
            "eligibility must not vary with mode, task count, or the escape hatch",
          );
        }
      }
    }
  }
});

// --- Cross-product invariants ----------------------------------------------

test("routing - the whole vocabulary upholds the design's invariants", () => {
  for (const card of everyCardShape()) {
    const resolved = resolveRoutingValues(card);
    for (const mode of ALL_MODES) {
      for (const taskCount of [1, 3]) {
        const evaluation = evaluateRouting(card, { mode, taskCount });

        // Architectural integration and small coupled work remain decisive.
        const coupled =
          resolved.sharedState === "mutable" || resolved.coreOverlap === "shared-core";
        if (
          resolved.integration === "architectural" ||
          (coupled && resolved.seamSize === "small")
        ) {
          assert.equal(evaluation.route, "solo");
        }
        if (evaluation.route === "delegation-plausible") {
          assert.equal(coupled, false);
          assert.equal(resolved.seamSize, "substantial");
          assert.equal(resolved.verification, "per-seam");
        }

        // Only the parallel mechanism can produce a parallel gate, and only the
        // parallel mechanism refuses for anything but an empty seam list.
        if (mode !== "parallel") {
          assert.ok(evaluation.gates.every((gate) => gate === "seam-count-zero"));
        }
        if (mode === "single" || mode === "sequential") {
          assert.ok(
            evaluation.refusedGate === null ||
              evaluation.refusedGate === "seam-count-zero",
          );
        }
        if (mode === "preflight") assert.equal(evaluation.refusedGate, null);

        // A refusal is always one of the gates that actually fired.
        if (evaluation.refusedGate) {
          assert.ok(evaluation.gates.includes(evaluation.refusedGate));
        }
        assert.ok(ROUTING_GATES.includes(evaluation.refusedGate ?? "seam-count-zero"));
        assert.equal(evaluation.seamCount, card.seams.length);
        assert.equal(evaluation.unknownCount, countUnknowns(card));
      }
    }
  }
});

// --- Cheapness --------------------------------------------------------------

test("routing - evaluation is synchronous and returns no promise", () => {
  const evaluation = evaluateRouting(clean(), { mode: "preflight" });
  assert.ok(!(evaluation instanceof Promise));
  assert.equal(typeof (evaluation as { then?: unknown }).then, "undefined");
  for (const fn of [
    evaluateRouting,
    evaluateParallelEligibility,
    resolveRoutingValues,
    countUnknowns,
    renderRoutingPreflight,
  ]) {
    assert.notEqual(fn.constructor.name, "AsyncFunction", `${fn.name} must not be async`);
  }
});

/**
 * Follow relative *runtime* imports from an entry module.
 *
 * Type-only statements are stripped first: they are erased at build time, so they
 * cannot reach a module, read an environment variable, or cost anything at run
 * time. Keeping them out of this graph is what lets the evaluator name a shared
 * vocabulary type while still depending on nothing when it actually runs.
 */
function transitiveImports(entry: string): { modules: string[]; external: string[] } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = fs
      .readFileSync(current, "utf8")
      .replace(/^\s*(?:import|export)\s+type\s[^;]*;/gm, "");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"|import\("([^"]+)"\)/g)].map(
      (match) => match[1] ?? match[2]!,
    );
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) {
        external.add(specifier);
        continue;
      }
      queue.push(path.join(path.dirname(current), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return { modules: [...seen], external: [...external] };
}

test("routing - the evaluator reaches no filesystem, process, socket, or model code", () => {
  const { modules, external } = transitiveImports(path.join(SRC_DIR, "routing.ts"));
  assert.deepEqual(modules, [path.join(SRC_DIR, "routing.ts")], "no local imports");
  for (const forbidden of [
    "node:fs",
    "node:fs/promises",
    "node:child_process",
    "node:net",
    "node:http",
    "@openai/codex-sdk",
  ]) {
    assert.ok(
      !external.includes(forbidden),
      `routing must not reach ${forbidden}, found: ${external.join(", ")}`,
    );
  }
  assert.deepEqual(external, [], "the evaluator needs no runtime imports at all");
});

test("routing - preflight text stays inside its budget for every possible card", () => {
  // Every envelope, including none at all, because the shape line is the only
  // part of this text whose presence and width the caller can change.
  for (const card of everyCardShape()) {
    for (const envelope of [undefined, ...SHAPE_ENVELOPES]) {
      const rendered = renderRoutingPreflight(
        evaluateRouting(card, { mode: "preflight", taskCount: 12, envelope }),
      );
      assert.ok(
        rendered.length <= PREFLIGHT_TEXT_BUDGET,
        `rendered preflight text was ${rendered.length} chars:\n${rendered}`,
      );
    }
  }
});

test("routing - rendering never echoes the card or its seam labels", () => {
  const card = clean({
    seams: ["SEAM_LABEL_LEAK_SENTINEL", "SECOND_LABEL_SENTINEL"],
    sharedState: "mutable",
  });
  const evaluation = evaluateRouting(card, { mode: "parallel", taskCount: 2 });
  const surfaces = [
    renderRoutingPreflight(evaluation),
    renderRoutingAdvisory(evaluation) ?? "",
    describeRefusal("parallel-shared-mutable"),
    JSON.stringify(declaredRoutingFields(card)),
  ];
  for (const surface of surfaces) {
    assert.doesNotMatch(surface, /SENTINEL/);
  }
  // The count is kept because it is not a description of the work; the labels
  // are dropped because they are.
  assert.match(renderRoutingPreflight(evaluation), /seams 2/);
});

test("routing - the declared projection keeps raw values and drops everything else", () => {
  const card = clean({
    seams: ["alpha", "beta"],
    seamSize: "unknown",
    sharedState: "read-only",
  });
  assert.deepEqual(declaredRoutingFields(card), {
    declaredSeamSize: "unknown",
    declaredSharedState: "read-only",
    declaredCoreOverlap: "disjoint",
    declaredIntegration: "mechanical",
    declaredVerification: "per-seam",
  });
});

test("routing - the advisory line is omitted when routing has nothing to add", () => {
  const plausible = evaluateRouting(clean(), { mode: "parallel", taskCount: 2 });
  assert.equal(renderRoutingAdvisory(plausible), null);

  const solo = evaluateRouting(clean({ integration: "architectural" }), {
    mode: "sequential",
    taskCount: 2,
  });
  const line = renderRoutingAdvisory(solo);
  assert.match(line ?? "", /^ROUTING: solo advised/);
  assert.match(line ?? "", /parent owns this judgement/);
  assert.ok(!(line ?? "").includes("\n"), "the advisory must stay one line");

  const either = evaluateRouting(clean({ seamSize: "small" }), {
    mode: "parallel",
    taskCount: 2,
  });
  assert.match(renderRoutingAdvisory(either) ?? "", /needs explicit justification/);

  // Solo with no deciding signal is reachable (an empty seam list), so the
  // reason parenthetical has to disappear rather than render empty.
  const noSeams = evaluateRouting(clean({ seams: [] }), {
    mode: "sequential",
    taskCount: 1,
  });
  const noSeamsLine = renderRoutingAdvisory(noSeams) ?? "";
  assert.match(noSeamsLine, /^ROUTING: solo advised;/);
  assert.doesNotMatch(noSeamsLine, /\(\)/);
});

test("routing - the advisory line discloses assumptions it made from unknown", () => {
  // Every deciding signal here is the cautious reading of an `unknown`, not
  // something the caller declared. Without the count, the line reads as a claim
  // about what the caller said.
  const allUnknown = clean({
    seamSize: "unknown",
    sharedState: "unknown",
    coreOverlap: "unknown",
    integration: "unknown",
    verification: "unknown",
  });
  const line = renderRoutingAdvisory(
    evaluateRouting(allUnknown, { mode: "parallel", taskCount: 2 }),
  );
  assert.match(line ?? "", /unknown 5/, "the advisory must disclose its assumptions");
  assert.match(line ?? "", /^ROUTING: solo advised \([^)]*unknown 5\)/);

  // One unknown, one declared hazard: both are named, and the count says how
  // much of the parenthetical was assumed rather than stated.
  const partial = renderRoutingAdvisory(
    evaluateRouting(clean({ sharedState: "mutable", integration: "unknown" }), {
      mode: "sequential",
      taskCount: 2,
    }),
  );
  assert.match(partial ?? "", /shared-mutable-state/);
  assert.match(partial ?? "", /unknown 1/);

  // A fully declared card assumed nothing, so it must not claim an unknown.
  const declared = renderRoutingAdvisory(
    evaluateRouting(clean({ sharedState: "mutable" }), {
      mode: "sequential",
      taskCount: 2,
    }),
  );
  assert.doesNotMatch(declared ?? "", /unknown/);
});

test("routing - the advisory line stays one compact line for every possible card", () => {
  for (const card of everyCardShape()) {
    for (const mode of ["single", "sequential", "parallel"] as const) {
      const line = renderRoutingAdvisory(
        evaluateRouting(card, { mode, taskCount: MAX_ADVISORY_TASK_COUNT }),
      );
      if (line === null) continue;
      assert.ok(!line.includes("\n"), "the advisory must stay one line");
      assert.ok(line.length <= 400, `advisory line was ${line.length} chars:\n${line}`);
      // The unknown count is present exactly when something was assumed.
      assert.equal(
        /unknown \d/.test(line),
        card.seamSize === "unknown" ||
          card.sharedState === "unknown" ||
          card.coreOverlap === "unknown" ||
          card.integration === "unknown" ||
          card.verification === "unknown",
        `unknown disclosure disagrees with the card:\n${line}`,
      );
    }
  }
});

// --- Genericity -------------------------------------------------------------

/** Runtime modules are the shipped, non-test sources outside the benchmark. */
function runtimeModules(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "bench") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (entry.name.endsWith(".test.ts")) continue;
      found.push(full);
    }
  };
  walk(SRC_DIR);
  return found;
}

test("routing - the evaluator imports nothing from the benchmark", () => {
  const source = fs.readFileSync(path.join(SRC_DIR, "routing.ts"), "utf8");
  const statements = [
    ...source.matchAll(/^\s*((?:import|export)\s[^;]*?from\s+"([^"]+)");/gm),
  ].map((match) => ({ statement: match[1]!.trim(), specifier: match[2]! }));

  // One import, and it must be type-only. A value import would put a module —
  // and everything that module reads at load time — behind every preflight.
  assert.deepEqual(
    statements.map((entry) => entry.statement),
    ['import type { Effort } from "./config.js"'],
    "the evaluator's only import is the type-only effort vocabulary",
  );
  for (const { specifier } of statements) {
    assert.doesNotMatch(specifier, /bench/i);
  }
});

test("routing - V3 evaluator routing categories stay confined to benchmark code", () => {
  const holdoutLiterals = [
    "expected-solo",
    "likely-solo",
    "ambiguous",
    "delegation-candidate",
    "strong-delegation-candidate",
  ];
  const offenders: string[] = [];
  for (const module of runtimeModules()) {
    const source = fs.readFileSync(module, "utf8");
    for (const literal of holdoutLiterals) {
      // Matched as a quoted string literal, which is the only form that could
      // actually classify anything. "ambiguous" is also an ordinary English word
      // and appears in unrelated prose.
      if (new RegExp(`["'\`]${literal}["'\`]`).test(source)) {
        offenders.push(`${module}: ${literal}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `benchmark routing categories leaked into runtime code:\n${offenders.join("\n")}`,
  );
});

// --- Types ------------------------------------------------------------------

test("routing - every vocabulary member resolves, and nothing resolves to unknown", () => {
  // The compile-time half of this guarantee lives in routing.ts: resolution and
  // the parallel-hazard tests are `satisfies Record<Vocabulary, …>` total maps, so
  // a new declarable value fails the build until its semantics are stated. This
  // is the runtime half: every value the vocabulary currently exposes must
  // actually resolve to a defined, non-unknown value on every field.
  const base = clean();
  const fields = [
    ["seamSize", SEAM_SIZES],
    ["sharedState", SHARED_STATES],
    ["coreOverlap", CORE_OVERLAPS],
    ["integration", INTEGRATIONS],
    ["verification", VERIFICATIONS],
  ] as const;

  for (const [field, vocabulary] of fields) {
    for (const value of vocabulary) {
      const card = { ...base, [field]: value } as RoutingPreflightCard;
      const resolved = resolveRoutingValues(card);
      assert.notEqual(
        resolved[field],
        undefined,
        `${field}="${value}" has no resolution`,
      );
      assert.notEqual(
        resolved[field],
        "unknown",
        `${field}="${value}" must resolve away from unknown`,
      );
      assert.ok(
        (vocabulary as readonly string[]).includes(resolved[field]),
        `${field}="${value}" resolved outside its own vocabulary`,
      );

      // Parallel eligibility must also be a decision about every value, never a
      // default falling out of an inequality.
      assert.equal(
        typeof evaluateParallelEligibility(card),
        "boolean",
        `${field}="${value}" has no eligibility answer`,
      );
    }
  }

  // Resolution is total, so no card can leave a resolved field undefined.
  for (const card of everyCardShape()) {
    const resolved = resolveRoutingValues(card);
    for (const value of Object.values(resolved)) {
      assert.notEqual(value, undefined);
      assert.notEqual(value, "unknown");
    }
  }
});

test("routing - every declared vocabulary keeps its unknown escape value", () => {
  const withUnknown: Array<readonly string[]> = [
    SEAM_SIZES,
    SHARED_STATES,
    CORE_OVERLAPS,
    INTEGRATIONS,
    VERIFICATIONS,
  ];
  for (const vocabulary of withUnknown) {
    assert.ok(
      vocabulary.includes("unknown"),
      `a declarable field without "unknown" would force a guess: ${vocabulary.join("|")}`,
    );
  }
  // Compile-time proof the exported unions match the exported vocabularies.
  const seamSize: SeamSize = "unknown";
  const sharedState: SharedState = "read-only";
  const coreOverlap: CoreOverlap = "disjoint";
  const integration: Integration = "mechanical";
  const verification: Verification = "per-seam";
  assert.ok(
    [seamSize, sharedState, coreOverlap, integration, verification].every(Boolean),
  );
});

// --- Recommended execution shape -------------------------------------------

/**
 * Wide enough that a shape reflects the card rather than a cap, so a narrower
 * envelope's effect is always attributable to the envelope.
 */
const WIDE_ENVELOPE: ComputeEnvelope = {
  allowedEfforts: [...EFFORTS],
  maxConcurrency: 8,
  maxWorkersPerBatch: 12,
};

/** Envelopes that between them bind every bound a shape reads. */
const SHAPE_ENVELOPES: ComputeEnvelope[] = [
  WIDE_ENVELOPE,
  // One worker, one at a time, one effort: the narrowest envelope policy allows.
  { allowedEfforts: ["medium"], maxConcurrency: 1, maxWorkersPerBatch: 1 },
  // Concurrency narrowed below the seam count, so parallel becomes sequential.
  { allowedEfforts: ["medium", "high"], maxConcurrency: 1, maxWorkersPerBatch: 12 },
  // Workers narrowed below the seam count, so seams are left with the parent.
  { allowedEfforts: ["high", "xhigh"], maxConcurrency: 8, maxWorkersPerBatch: 2 },
  // An envelope whose floor is above the effort routing would prefer.
  { allowedEfforts: ["xhigh", "max"], maxConcurrency: 3, maxWorkersPerBatch: 3 },
];

/** Ascending, mirroring the evaluator's own ranking without importing it. */
const EFFORT_ORDER: readonly Effort[] = ["medium", "high", "xhigh", "max"];
const lowestEffort = (allowed: readonly Effort[]): Effort =>
  [...allowed].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b))[0]!;

/**
 * The effort `config.ts` itself would default to for a given permitted list.
 *
 * Restated here rather than imported, so the assertion is that routing agrees
 * with the installation's own default rather than that two modules share a
 * function.
 */
const installationDefaultEffort = (allowed: readonly Effort[]): Effort =>
  allowed.includes("high") ? "high" : lowestEffort(allowed);

test("routing - no envelope means no shape, and no mention of one", () => {
  for (const mode of ALL_MODES) {
    const evaluation = evaluateRouting(clean(), { mode, taskCount: 2 });
    assert.equal(evaluation.shape, null);
    // The guarantee the pre-shape evaluator made, kept for every caller that
    // still declines to name an envelope: no effort, worker count, or
    // concurrency value appears anywhere in the result.
    const serialized = JSON.stringify(evaluation);
    for (const forbidden of [...EFFORTS, "effort", "worker", "concurrency"]) {
      assert.doesNotMatch(
        serialized,
        new RegExp(forbidden, "i"),
        `an envelope-free evaluation must not mention ${forbidden}`,
      );
    }
    assert.doesNotMatch(renderRoutingPreflight(evaluation), /SHAPE/);
  }
});

test("routing - a solo route never advertises a delegation mechanism", () => {
  for (const card of everyCardShape()) {
    for (const envelope of SHAPE_ENVELOPES) {
      for (const mode of ALL_MODES) {
        const evaluation = evaluateRouting(card, { mode, taskCount: 2, envelope });
        const shape = evaluation.shape!;
        if (evaluation.route === "solo") {
          assert.deepEqual(
            shape,
            {
              mechanism: "solo",
              effort: null,
              workerCount: 0,
              concurrency: 0,
              seamsOverCap: 0,
            },
            "a solo recommendation must name no mechanism and no compute",
          );
        } else {
          // The converse, so the two can never drift apart: every envelope here
          // permits at least one worker, so a non-solo route always has a shape.
          assert.notEqual(shape.mechanism, "solo");
          assert.ok(shape.workerCount >= 1);
        }
        assert.equal(shape.mechanism === "solo", shape.workerCount === 0);
      }
    }
  }
});

test("routing - the rendered shape line never contradicts the rendered route", () => {
  for (const card of everyCardShape()) {
    for (const envelope of SHAPE_ENVELOPES) {
      const rendered = renderRoutingPreflight(
        evaluateRouting(card, { mode: "preflight", envelope }),
      );
      if (/^ROUTE: solo/m.test(rendered)) {
        assert.match(rendered, /^SHAPE: solo; zero workers$/m);
        assert.doesNotMatch(rendered, /delegate_/);
      } else {
        assert.match(rendered, /^SHAPE: delegate_/m);
      }
      // An unjustified overhead must read as conditional, never as an order.
      if (/^ROUTE: either/m.test(rendered)) {
        assert.match(rendered, /^SHAPE: .*; only if justified$/m);
      }
    }
  }
});

test("routing - seam count alone decides nothing about parallel safety", () => {
  // Same seam count, same envelope; only the coupling declaration differs.
  const coupled = evaluateRouting(clean({ sharedState: "mutable" }), {
    mode: "preflight",
    envelope: WIDE_ENVELOPE,
  });
  const clean2 = evaluateRouting(clean(), {
    mode: "preflight",
    envelope: WIDE_ENVELOPE,
  });
  assert.equal(coupled.seamCount, clean2.seamCount);
  assert.equal(coupled.route, "either");
  assert.equal(coupled.parallelEligible, false);
  assert.equal(coupled.shape?.mechanism, "delegate_tasks_sequential");
  assert.equal(clean2.shape?.mechanism, "delegate_tasks_parallel");
});

test("routing - one clean substantial seam starts at high, not at the ceiling", () => {
  const evaluation = evaluateRouting(clean({ seams: ["only"] }), {
    mode: "preflight",
    envelope: WIDE_ENVELOPE,
  });
  assert.equal(evaluation.route, "delegation-plausible");
  assert.deepEqual(evaluation.shape, {
    mechanism: "delegate_task",
    effort: "high",
    workerCount: 1,
    concurrency: 1,
    seamsOverCap: 0,
  });
});

test("routing - independent disjoint seams with per-seam proof go parallel", () => {
  const evaluation = evaluateRouting(clean({ seams: ["a", "b", "c"] }), {
    mode: "preflight",
    envelope: WIDE_ENVELOPE,
  });
  assert.equal(evaluation.route, "delegation-plausible");
  assert.deepEqual(evaluation.shape, {
    mechanism: "delegate_tasks_parallel",
    effort: "high",
    workerCount: 3,
    concurrency: 3,
    seamsOverCap: 0,
  });
});

test("routing - seams that cannot be proven apart are staggered, not raced", () => {
  const evaluation = evaluateRouting(
    clean({ seams: ["a", "b", "c"], verification: "shared-only" }),
    { mode: "preflight", envelope: WIDE_ENVELOPE },
  );
  assert.equal(evaluation.route, "either");
  assert.deepEqual(evaluation.shape, {
    mechanism: "delegate_tasks_sequential",
    effort: "high",
    workerCount: 3,
    concurrency: 1,
    seamsOverCap: 0,
  });
});

test("routing - substantial shared seams stagger while architectural integration stays solo", () => {
  for (const coupling of [
    { sharedState: "mutable" } as const,
    { coreOverlap: "shared-core" } as const,
  ]) {
    const evaluation = evaluateRouting(clean({ seams: ["a", "b"], ...coupling }), {
      mode: "preflight",
      envelope: WIDE_ENVELOPE,
    });
    assert.equal(evaluation.route, "either");
    assert.equal(evaluation.parallelEligible, false);
    assert.equal(evaluation.shape?.mechanism, "delegate_tasks_sequential");
  }
  const architectural = evaluateRouting(clean({ integration: "architectural" }), {
    mode: "preflight",
    envelope: WIDE_ENVELOPE,
  });
  assert.equal(architectural.route, "solo");
  assert.equal(architectural.shape?.mechanism, "solo");
});

test("routing - an entirely undeclared card is never recommended concurrency", () => {
  const card = clean({
    seams: ["a", "b", "c"],
    seamSize: "unknown",
    sharedState: "unknown",
    coreOverlap: "unknown",
    integration: "unknown",
    verification: "unknown",
  });
  const evaluation = evaluateRouting(card, {
    mode: "preflight",
    envelope: WIDE_ENVELOPE,
  });
  // The whole raw/resolved asymmetry in one card: structurally separable, and
  // still not recommended, because the recommendation reads resolved values.
  assert.equal(evaluation.parallelEligible, true);
  assert.equal(evaluation.route, "solo");
  assert.equal(evaluation.shape?.mechanism, "solo");
  assert.equal(evaluation.refusedGate, null);
});

test("routing - concurrency is never recommended over a resolved hazard", () => {
  for (const card of everyCardShape()) {
    for (const envelope of SHAPE_ENVELOPES) {
      const evaluation = evaluateRouting(card, { mode: "preflight", envelope });
      const shape = evaluation.shape!;
      if (shape.mechanism !== "delegate_tasks_parallel") continue;
      assert.notEqual(evaluation.resolved.sharedState, "mutable");
      assert.notEqual(evaluation.resolved.coreOverlap, "shared-core");
      assert.equal(evaluation.resolved.verification, "per-seam");
      assert.ok(shape.workerCount >= 2);
      assert.ok(shape.concurrency >= 2);
    }
  }
});

test("routing - an envelope that runs one worker at a time is a sequential shape", () => {
  const evaluation = evaluateRouting(clean({ seams: ["a", "b", "c"] }), {
    mode: "preflight",
    envelope: { allowedEfforts: [...EFFORTS], maxConcurrency: 1, maxWorkersPerBatch: 12 },
  });
  assert.deepEqual(evaluation.shape, {
    mechanism: "delegate_tasks_sequential",
    effort: "high",
    workerCount: 3,
    concurrency: 1,
    seamsOverCap: 0,
  });
});

test("routing - seams beyond the worker cap stay with the parent and are named", () => {
  const evaluation = evaluateRouting(clean({ seams: ["a", "b", "c", "d"] }), {
    mode: "preflight",
    envelope: {
      allowedEfforts: ["medium", "high"],
      maxConcurrency: 8,
      maxWorkersPerBatch: 2,
    },
  });
  assert.deepEqual(evaluation.shape, {
    mechanism: "delegate_tasks_parallel",
    effort: "high",
    workerCount: 2,
    concurrency: 2,
    seamsOverCap: 2,
  });
  // Silently shrinking the batch would read as though the work had shrunk too.
  assert.match(renderRoutingPreflight(evaluation), /2 seams stay with you/);
});

test("routing - a cap of one worker is a single delegation, not a batch", () => {
  const evaluation = evaluateRouting(clean({ seams: ["a", "b", "c"] }), {
    mode: "preflight",
    envelope: { allowedEfforts: ["medium"], maxConcurrency: 1, maxWorkersPerBatch: 1 },
  });
  assert.deepEqual(evaluation.shape, {
    mechanism: "delegate_task",
    effort: "medium",
    workerCount: 1,
    concurrency: 1,
    seamsOverCap: 2,
  });
});

test("routing - an envelope permitting no worker recommends solo", () => {
  for (const degenerate of [
    { allowedEfforts: [...EFFORTS], maxConcurrency: 0, maxWorkersPerBatch: 0 },
    { allowedEfforts: [...EFFORTS], maxConcurrency: 4, maxWorkersPerBatch: 0.5 },
    { allowedEfforts: [...EFFORTS], maxConcurrency: 4, maxWorkersPerBatch: Number.NaN },
    { allowedEfforts: [...EFFORTS], maxConcurrency: 4, maxWorkersPerBatch: -3 },
  ] satisfies ComputeEnvelope[]) {
    const evaluation = evaluateRouting(clean(), {
      mode: "preflight",
      envelope: degenerate,
    });
    assert.equal(evaluation.shape?.mechanism, "solo");
    assert.equal(evaluation.shape?.workerCount, 0);
  }
});

test("routing - effort is the installation's own default, never the ceiling", () => {
  for (const card of everyCardShape()) {
    for (const envelope of SHAPE_ENVELOPES) {
      const evaluation = evaluateRouting(card, { mode: "preflight", envelope });
      const shape = evaluation.shape!;
      if (shape.effort === null) {
        assert.equal(shape.mechanism, "solo");
        continue;
      }
      assert.ok(
        envelope.allowedEfforts.includes(shape.effort),
        "a recommended effort must be permitted",
      );
      const expected =
        evaluation.resolved.seamSize === "substantial"
          ? installationDefaultEffort(envelope.allowedEfforts)
          : lowestEffort(envelope.allowedEfforts);
      assert.equal(shape.effort, expected);
      // The ladder above `high` belongs to failure evidence, so routing may only
      // reach it when the operator has left nothing lower permitted.
      if (EFFORT_ORDER.indexOf(shape.effort) > EFFORT_ORDER.indexOf("high")) {
        assert.ok(
          envelope.allowedEfforts.every(
            (effort) =>
              EFFORT_ORDER.indexOf(effort) >= EFFORT_ORDER.indexOf(shape.effort!),
          ),
          "xhigh or max may only be recommended when nothing lower is permitted",
        );
      }
    }
  }
});

test("routing - a substantial seam under the widest envelope still starts at high", () => {
  for (const seams of [["a"], ["a", "b"], ["a", "b", "c"]]) {
    const evaluation = evaluateRouting(clean({ seams }), {
      mode: "preflight",
      envelope: WIDE_ENVELOPE,
    });
    assert.equal(evaluation.shape?.effort, "high");
  }
});

test("routing - nothing in a recommended shape exceeds its envelope", () => {
  for (const card of everyCardShape()) {
    for (const envelope of SHAPE_ENVELOPES) {
      const shape = evaluateRouting(card, { mode: "preflight", envelope }).shape!;
      assert.ok(shape.workerCount <= envelope.maxWorkersPerBatch);
      assert.ok(shape.workerCount <= card.seams.length);
      assert.ok(shape.concurrency <= envelope.maxConcurrency);
      assert.ok(shape.concurrency <= shape.workerCount);
      assert.ok(shape.seamsOverCap >= 0);
      if (shape.mechanism === "solo") {
        assert.equal(shape.seamsOverCap, 0);
      } else {
        assert.equal(shape.seamsOverCap, card.seams.length - shape.workerCount);
      }
      if (shape.mechanism === "delegate_task") assert.equal(shape.workerCount, 1);
      if (shape.mechanism === "delegate_tasks_sequential") {
        assert.equal(shape.concurrency, 1);
        assert.ok(shape.workerCount >= 2);
      }
    }
  }
});

test("routing - the resolved compute policy is a usable envelope as it stands", () => {
  // Pinned because routing deliberately does not import the policy module: the
  // structural type must keep matching the envelope the runtime really resolves.
  const envelope: ComputeEnvelope = DEFAULT_COMPUTE_POLICY;
  const shape = evaluateRouting(clean(), { mode: "preflight", envelope }).shape!;
  assert.ok(envelope.allowedEfforts.includes(shape.effort!));
  assert.ok(shape.workerCount <= DEFAULT_COMPUTE_POLICY.maxWorkersPerBatch);
  assert.ok(shape.concurrency <= DEFAULT_COMPUTE_POLICY.maxConcurrency);
});

test("routing - shape recommendation is deterministic and freshly owned", () => {
  const resolved = resolveRoutingValues(clean());
  const first = recommendExecutionShape(
    "delegation-plausible",
    3,
    resolved,
    WIDE_ENVELOPE,
  );
  const second = recommendExecutionShape(
    "delegation-plausible",
    3,
    resolved,
    WIDE_ENVELOPE,
  );
  assert.deepEqual(first, second);
  assert.notEqual(first, second, "each evaluation owns its own shape object");
  first.workerCount = 99;
  assert.equal(
    recommendExecutionShape("delegation-plausible", 3, resolved, WIDE_ENVELOPE)
      .workerCount,
    3,
  );
  assert.notEqual(recommendExecutionShape.constructor.name, "AsyncFunction");
});

test("routing - a shape names no seam label", () => {
  const evaluation = evaluateRouting(
    clean({ seams: ["SHAPE_LABEL_SENTINEL", "SECOND_SENTINEL"] }),
    { mode: "preflight", envelope: WIDE_ENVELOPE },
  );
  assert.doesNotMatch(JSON.stringify(evaluation.shape), /SENTINEL/);
  assert.doesNotMatch(renderRoutingPreflight(evaluation), /SENTINEL/);
});
