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
  renderRoutingAdvisory,
  renderRoutingPreflight,
  resolveRoutingValues,
  ROUTING_GATES,
  SEAM_SIZES,
  SHARED_STATES,
  VERIFICATIONS,
  type CoreOverlap,
  type Integration,
  type RoutingMode,
  type RoutingPreflightCard,
  type SeamSize,
  type SharedState,
  type Verification,
} from "./routing.js";

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

test("routing - each Tier 1 coupling signal alone recommends solo in every mode", () => {
  const cases: Array<[string, Partial<RoutingPreflightCard>]> = [
    ["shared-mutable-state", { sharedState: "mutable" }],
    ["shared-core", { coreOverlap: "shared-core" }],
    ["architectural-integration", { integration: "architectural" }],
  ];
  for (const [signal, overrides] of cases) {
    for (const mode of ALL_MODES) {
      const evaluation = evaluateRouting(clean(overrides), { mode, taskCount: 2 });
      assert.equal(evaluation.route, "solo", `${signal} in ${mode} should advise solo`);
      assert.ok(
        evaluation.signals.includes(signal as never),
        `${signal} should be reported in ${mode}`,
      );
    }
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
  assert.deepEqual(evaluation.signals, ["small-seam", "shared-verification-only"]);
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

test("routing - eligibility carries no worker count, concurrency, or effort", () => {
  const evaluation = evaluateRouting(clean({ seams: ["a", "b", "c", "d"] }), {
    mode: "parallel",
    taskCount: 4,
  });
  assert.equal(evaluation.parallelEligible, true);
  // A boolean cannot become a worker count, and nothing else in the result can
  // be mistaken for one: the seam count is a description of separability.
  assert.equal(typeof evaluation.parallelEligible, "boolean");
  const serialized = JSON.stringify(evaluation);
  for (const forbidden of [
    "effort",
    "medium",
    "high",
    "xhigh",
    "max",
    "maxParallel",
    "workers",
    "concurrency",
  ]) {
    assert.doesNotMatch(
      serialized,
      new RegExp(forbidden, "i"),
      `routing must not mention ${forbidden}`,
    );
  }
});

// --- Cross-product invariants ----------------------------------------------

test("routing - the whole vocabulary upholds the design's invariants", () => {
  for (const card of everyCardShape()) {
    const resolved = resolveRoutingValues(card);
    for (const mode of ALL_MODES) {
      for (const taskCount of [1, 3]) {
        const evaluation = evaluateRouting(card, { mode, taskCount });

        // Any Tier 1 coupling signal is decisive, whatever else is present.
        const coupled =
          resolved.sharedState === "mutable" ||
          resolved.coreOverlap === "shared-core" ||
          resolved.integration === "architectural";
        if (coupled) assert.equal(evaluation.route, "solo");
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

/** Follow relative imports from an entry module, returning every module reached. */
function transitiveImports(entry: string): { modules: string[]; external: string[] } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = fs.readFileSync(current, "utf8");
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
  assert.deepEqual(external, [], "the evaluator needs no imports at all");
});

test("routing - preflight text stays inside its budget for every possible card", () => {
  for (const card of everyCardShape()) {
    const rendered = renderRoutingPreflight(
      evaluateRouting(card, { mode: "preflight", taskCount: 12 }),
    );
    assert.ok(
      rendered.length <= 400,
      `rendered preflight text was ${rendered.length} chars:\n${rendered}`,
    );
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

  const solo = evaluateRouting(clean({ sharedState: "mutable" }), {
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
  const importSpecifiers = [
    ...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm),
  ].map((match) => match[1]!);
  assert.deepEqual(importSpecifiers, [], "the evaluator imports nothing at all");
  for (const specifier of importSpecifiers) {
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
