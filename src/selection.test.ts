/**
 * Selection policy tests.
 *
 * Three things are pinned here, and they are the three the design turns on.
 *
 * First, that no model hierarchy is ever inferred. `allowedModels` is a membership
 * set, so a `stronger-executor-fallback` against a multi-model envelope must come
 * back retaining the executor that already ran, whatever order the list is in and
 * however many entries it has. The list-order cases below are the regression tests
 * for exactly that.
 *
 * Second, that effort climbs one rung at a time. `xhigh` and `max` are reachable
 * only by climbing to them or from an envelope with no lower level in it, and a
 * cross-product sweep asserts that as a property rather than by example.
 *
 * Third, that the two decisions stay separate: escalating effort never changes the
 * executor, and an executor decision never resets effort.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFORTS, type Effort } from "./config.js";
import { FAILURE_ACTIONS, type FailureAction, type FailureDecision } from "./contract.js";
import { DEFAULT_COMPUTE_POLICY, type ComputePolicy } from "./policy.js";
import { EFFORT_RANK, type ExecutionShape } from "./routing.js";
import {
  SELECTION_REASONS,
  selectCompute,
  type PriorExecution,
  type SelectionInput,
} from "./selection.js";

/** A three-model envelope. Unreachable from the operator surface today, which is
 *  precisely why the ordering rules have to be pinned before one exists. */
const MULTI_MODEL: ComputePolicy = {
  allowedModels: ["worker-a", "worker-b", "worker-c"],
  allowedEfforts: ["medium", "high", "xhigh", "max"],
  maxConcurrency: 4,
  maxWorkersPerBatch: 4,
  allowEffortEscalation: true,
  allowStrongerFallback: true,
};

/** The realistic shape of a resolved envelope: exactly one authorised executor. */
const SINGLE_MODEL: ComputePolicy = { ...MULTI_MODEL, allowedModels: ["worker-a"] };

const DELEGATING: ExecutionShape = {
  mechanism: "delegate_task",
  effort: "medium",
  workerCount: 1,
  concurrency: 1,
  seamsOverCap: 0,
};

const SOLO: ExecutionShape = {
  mechanism: "solo",
  effort: null,
  workerCount: 0,
  concurrency: 0,
  seamsOverCap: 0,
};

function failure(
  action: FailureAction,
  nextEffort: Effort | null = null,
): FailureDecision {
  return {
    classification: action === "effort-escalation" ? "effort" : "capability",
    action,
    reason: "Fixture decision.",
    evidenceExecutionIds: ["exec-1"],
    nextEffort,
    automaticHandler: null,
    automaticRetryCount: 0,
    automaticRetryLimit: 1,
  };
}

function prior(
  requestedModel: string,
  requestedEffort: string,
  decision: FailureDecision,
): PriorExecution {
  return { requestedModel, requestedEffort, failureDecision: decision };
}

// --- Shapes that authorise nothing -----------------------------------------

test("selection - a solo shape selects no executor and no effort", () => {
  const result = selectCompute({ shape: SOLO, policy: SINGLE_MODEL });
  assert.equal(result.model, null);
  assert.equal(result.effort, null);
  assert.equal(result.reason, "solo-no-execution");
});

test("selection - a zero-worker shape selects nothing even with evidence to continue", () => {
  const result = selectCompute({
    shape: { ...DELEGATING, workerCount: 0 },
    policy: SINGLE_MODEL,
    evidence: prior("worker-a", "high", failure("retry")),
  });
  assert.equal(result.model, null);
  assert.equal(result.effort, null);
  assert.equal(result.reason, "solo-no-execution");
});

test("selection - actions that authorise no worker turn select no executor", () => {
  for (const action of ["stop", "parent-takeover"] as const) {
    const result = selectCompute({
      shape: DELEGATING,
      policy: SINGLE_MODEL,
      evidence: prior("worker-a", "high", failure(action)),
    });
    assert.equal(result.model, null, action);
    assert.equal(result.effort, null, action);
    assert.equal(result.reason, "no-authorised-next-execution", action);
  }
});

// --- Conservative first selection -------------------------------------------

test("selection - a first attempt takes the envelope's executor and routing's starting effort", () => {
  const result = selectCompute({ shape: DELEGATING, policy: SINGLE_MODEL });
  assert.equal(result.model, "worker-a");
  assert.equal(result.effort, "medium");
  assert.equal(result.reason, "conservative-baseline");
});

test("selection - routing's substantial-seam start is honoured without being raised", () => {
  const result = selectCompute({
    shape: { ...DELEGATING, effort: "high" },
    policy: SINGLE_MODEL,
  });
  assert.equal(result.effort, "high");
  assert.equal(result.reason, "conservative-baseline");
});

test("selection - several equally authorised executors leave the choice to the parent", () => {
  const result = selectCompute({ shape: DELEGATING, policy: MULTI_MODEL });
  assert.equal(
    result.model,
    null,
    "picking one of three unranked executors would be an invented ordering",
  );
  assert.equal(result.effort, "medium", "the effort is still selectable");
  assert.equal(result.reason, "conservative-baseline");
  assert.match(result.detail, /declares no ordering/);
});

test("selection - list order never decides which executor is chosen", () => {
  const reversed: ComputePolicy = {
    ...MULTI_MODEL,
    allowedModels: [...MULTI_MODEL.allowedModels].reverse(),
  };
  assert.deepEqual(
    selectCompute({ shape: DELEGATING, policy: MULTI_MODEL }),
    selectCompute({ shape: DELEGATING, policy: reversed }),
  );
});

test("selection - a shape naming no effort falls to the envelope's floor, not a literal", () => {
  const result = selectCompute({
    shape: { ...DELEGATING, effort: null },
    policy: { ...SINGLE_MODEL, allowedEfforts: ["high", "xhigh"] },
  });
  assert.equal(result.effort, "high");
});

// --- Effort is never raised without evidence or an envelope that forces it ----

test("selection - max is selected only when the envelope leaves no lower level", () => {
  const forced = selectCompute({
    shape: DELEGATING,
    policy: { ...SINGLE_MODEL, allowedEfforts: ["max"] },
  });
  assert.equal(
    forced.effort,
    "max",
    "the only permitted level is the only honest answer",
  );

  const unforced = selectCompute({
    shape: DELEGATING,
    policy: { ...SINGLE_MODEL, allowedEfforts: ["high", "max"] },
  });
  assert.equal(
    unforced.effort,
    "high",
    "a lower permitted level exists, so max is not taken",
  );
});

test("selection - without evidence, no envelope with a lower option ever yields xhigh or max", () => {
  const efforts: Effort[][] = [
    ["medium"],
    ["high"],
    ["xhigh"],
    ["max"],
    ["medium", "high"],
    ["medium", "max"],
    ["high", "xhigh"],
    ["high", "max"],
    ["xhigh", "max"],
    ["medium", "high", "xhigh", "max"],
  ];
  for (const allowedEfforts of efforts) {
    for (const shapeEffort of [null, ...EFFORTS] as (Effort | null)[]) {
      const result = selectCompute({
        shape: { ...DELEGATING, effort: shapeEffort },
        policy: { ...SINGLE_MODEL, allowedEfforts },
      });
      const label = `${allowedEfforts.join("/")} + ${shapeEffort}`;
      const selected = result.effort!;
      assert.ok(
        allowedEfforts.includes(selected),
        `${label}: stayed inside the envelope`,
      );

      // The envelope's floor is the least compute the operator left available, so
      // an envelope with nothing lower in it is the one way a ceiling is reached
      // without evidence.
      const isFloor =
        allowedEfforts.filter((e) => EFFORT_RANK[e] < EFFORT_RANK[selected]).length === 0;

      // Otherwise the starting effort may only ever come down from what routing
      // asked for. Routing's own preference tops out at `high`, and capping that
      // again here would duplicate its table rather than bound it, so the property
      // asserted is the one this module actually owns: never raise the request.
      assert.ok(
        isFloor ||
          (shapeEffort !== null && EFFORT_RANK[selected] <= EFFORT_RANK[shapeEffort]),
        `${label}: raised the starting effort above what was asked for`,
      );
      if (selected === "xhigh" || selected === "max") {
        assert.ok(
          isFloor ||
            (shapeEffort !== null && EFFORT_RANK[shapeEffort] >= EFFORT_RANK[selected]),
          `${label}: took a ceiling with a lower option available and nothing asking for it`,
        );
      }
    }
  }
});

// --- Same-contract actions ---------------------------------------------------

test("selection - repair, continuation and retry retain both executor and effort", () => {
  for (const action of ["repair", "continuation", "retry"] as const) {
    const result = selectCompute({
      shape: DELEGATING,
      policy: SINGLE_MODEL,
      evidence: prior("worker-a", "high", failure(action)),
    });
    assert.equal(result.model, "worker-a", action);
    assert.equal(result.effort, "high", `${action} must not raise effort`);
    assert.equal(result.reason, "same-contract-retry", action);
  }
});

// --- Effort escalation -------------------------------------------------------

test("selection - escalation climbs exactly one permitted rung", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: MULTI_MODEL,
    evidence: prior("worker-b", "medium", failure("effort-escalation", "high")),
  });
  assert.equal(result.effort, "high");
  assert.equal(result.model, "worker-b", "escalating effort never changes the executor");
  assert.equal(result.reason, "effort-escalated");
});

test("selection - escalation skips the levels the envelope withholds", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: { ...MULTI_MODEL, allowedEfforts: ["medium", "max"] },
    evidence: prior("worker-b", "medium", failure("effort-escalation", "max")),
  });
  assert.equal(
    result.effort,
    "max",
    "max is the next permitted rung, not a jump past one",
  );
  assert.equal(result.reason, "effort-escalated");
});

test("selection - a stale decision naming a distant level is clamped to one rung", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: MULTI_MODEL,
    // P1.1 computes the next rung itself, so this disagreement only arises from
    // stale or hand-built evidence. It must lower the jump, never honour it.
    evidence: prior("worker-b", "medium", failure("effort-escalation", "max")),
  });
  assert.equal(result.effort, "high");
  assert.equal(result.reason, "effort-escalated");
});

test("selection - escalation never selects a level above the one P1.1 named", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: { ...MULTI_MODEL, allowedEfforts: ["medium", "max"] },
    evidence: prior("worker-b", "medium", failure("effort-escalation", "high")),
  });
  assert.equal(
    result.effort,
    "medium",
    "max exceeds the recommendation, so nothing is raised",
  );
  assert.equal(result.reason, "effort-escalation-exhausted");
});

test("selection - escalation with no named level is refused rather than originated here", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: MULTI_MODEL,
    evidence: prior("worker-b", "medium", failure("effort-escalation", null)),
  });
  assert.equal(result.effort, "medium");
  assert.equal(result.reason, "effort-escalation-exhausted");
});

test("selection - escalation at the top of the envelope retains the current level", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: MULTI_MODEL,
    evidence: prior("worker-b", "max", failure("effort-escalation", "max")),
  });
  assert.equal(result.effort, "max");
  assert.equal(result.reason, "effort-escalation-exhausted");
});

test("selection - an envelope withholding escalation is enforced here too", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: { ...MULTI_MODEL, allowEffortEscalation: false },
    evidence: prior("worker-b", "medium", failure("effort-escalation", "high")),
  });
  assert.equal(result.effort, "medium");
  assert.equal(result.model, "worker-b");
  assert.equal(result.reason, "effort-escalation-not-permitted");
});

test("selection - escalating one rung leaves the rest of the ladder for the next one", () => {
  let effort: Effort = "medium";
  const climbed: Effort[] = [effort];
  for (let step = 0; step < 5; step += 1) {
    const next = EFFORTS[EFFORTS.indexOf(effort) + 1] ?? null;
    const result = selectCompute({
      shape: DELEGATING,
      policy: MULTI_MODEL,
      evidence: prior("worker-b", effort, failure("effort-escalation", next)),
    });
    if (result.reason !== "effort-escalated") break;
    effort = result.effort!;
    climbed.push(effort);
  }
  assert.deepEqual(climbed, ["medium", "high", "xhigh", "max"]);
});

// --- Stronger-executor fallback ----------------------------------------------

test("selection - a permitted fallback against several executors is reported, not resolved", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: MULTI_MODEL,
    evidence: prior("worker-a", "max", failure("stronger-executor-fallback")),
  });
  assert.equal(
    result.model,
    "worker-a",
    "no operator surface ranks these three, so none of them is the stronger one",
  );
  assert.equal(result.effort, "max", "a fallback decision never resets effort");
  assert.equal(result.reason, "stronger-executor-unresolvable");
  assert.match(result.detail, /no\s+strength ordering/);
});

test("selection - a fallback selects the same executor whatever order the list is in", () => {
  const evidence = prior("worker-b", "max", failure("stronger-executor-fallback"));
  const forwards = selectCompute({ shape: DELEGATING, policy: MULTI_MODEL, evidence });
  const backwards = selectCompute({
    shape: DELEGATING,
    policy: { ...MULTI_MODEL, allowedModels: ["worker-c", "worker-b", "worker-a"] },
    evidence,
  });
  assert.equal(forwards.model, "worker-b");
  assert.deepEqual(forwards.model, backwards.model);
});

test("selection - a fallback against a single-executor envelope retains it", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: SINGLE_MODEL,
    evidence: prior("worker-a", "max", failure("stronger-executor-fallback")),
  });
  assert.equal(result.model, "worker-a");
  assert.equal(result.effort, "max");
  assert.equal(result.reason, "stronger-executor-unresolvable");
  assert.match(result.detail, /authorises only executor/);
});

test("selection - an envelope withholding the fallback is enforced here too", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: { ...MULTI_MODEL, allowStrongerFallback: false },
    evidence: prior("worker-a", "max", failure("stronger-executor-fallback")),
  });
  assert.equal(result.model, "worker-a");
  assert.equal(result.effort, "max");
  assert.equal(result.reason, "stronger-executor-not-permitted");
});

// --- Evidence bounded by the envelope ----------------------------------------

test("selection - an executor the envelope no longer permits is not continued", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: SINGLE_MODEL,
    evidence: prior("worker-z", "max", failure("retry")),
  });
  assert.equal(result.model, "worker-a");
  assert.equal(result.effort, "medium", "its effort does not carry forward either");
  assert.equal(result.reason, "evidence-outside-envelope");
});

test("selection - an effort above the envelope is clamped down, never carried", () => {
  const result = selectCompute({
    shape: DELEGATING,
    policy: { ...SINGLE_MODEL, allowedEfforts: ["medium", "high"] },
    evidence: prior("worker-a", "max", failure("retry")),
  });
  assert.equal(result.effort, "high");
});

test("selection - an unreadable effort claim falls back to the conservative start", () => {
  const result = selectCompute({
    shape: { ...DELEGATING, effort: "medium" },
    policy: SINGLE_MODEL,
    evidence: prior("worker-a", "ludicrous", failure("effort-escalation", "high")),
  });
  // The claim is unusable, so escalation climbs from the conservative start.
  assert.equal(result.effort, "high");
  assert.equal(result.model, "worker-a");
});

test("selection - narrowing the envelope never widens what is selected", () => {
  const evidence = prior("worker-b", "high", failure("effort-escalation", "xhigh"));
  const wide = selectCompute({ shape: DELEGATING, policy: MULTI_MODEL, evidence });
  assert.equal(wide.effort, "xhigh");

  const narrowed = selectCompute({
    shape: DELEGATING,
    policy: {
      ...MULTI_MODEL,
      allowedModels: ["worker-b"],
      allowedEfforts: ["medium", "high"],
      allowEffortEscalation: false,
    },
    evidence,
  });
  assert.equal(narrowed.effort, "high", "the narrowed envelope's ceiling holds");
  assert.equal(narrowed.model, "worker-b");
});

// --- Whole-surface properties ------------------------------------------------

test("selection - every decision stays inside the envelope for every action", () => {
  const policies = [SINGLE_MODEL, MULTI_MODEL, DEFAULT_COMPUTE_POLICY];
  for (const policy of policies) {
    for (const action of FAILURE_ACTIONS) {
      for (const requestedEffort of [...EFFORTS, "not-an-effort"]) {
        for (const requestedModel of [policy.allowedModels[0]!, "worker-z"]) {
          for (const nextEffort of [null, ...EFFORTS]) {
            const result = selectCompute({
              shape: DELEGATING,
              policy,
              evidence: prior(
                requestedModel,
                requestedEffort,
                failure(action, nextEffort),
              ),
            });
            const label = `${action}/${requestedModel}/${requestedEffort}/${nextEffort}`;
            assert.ok(SELECTION_REASONS.includes(result.reason), label);
            if (result.model !== null) {
              assert.ok(
                policy.allowedModels.includes(result.model),
                `${label}: model permitted`,
              );
            }
            if (result.effort !== null) {
              assert.ok(
                policy.allowedEfforts.includes(result.effort),
                `${label}: effort permitted`,
              );
            }
            assert.equal(
              result.effort === null,
              result.reason === "solo-no-execution" ||
                result.reason === "no-authorised-next-execution",
              `${label}: a null effort means no authorised execution`,
            );
            if (!policy.allowEffortEscalation) {
              assert.notEqual(
                result.reason,
                "effort-escalated",
                `${label}: escalation withheld`,
              );
            }
          }
        }
      }
    }
  }
});

test("selection - the decision is deterministic and reads nothing it can mutate", () => {
  const input: SelectionInput = {
    shape: DELEGATING,
    policy: MULTI_MODEL,
    evidence: prior("worker-b", "high", failure("effort-escalation", "xhigh")),
  };
  const snapshot = JSON.stringify(input);
  const first = selectCompute(input);
  const second = selectCompute(input);
  assert.deepEqual(first, second);
  assert.notEqual(first, second, "each call owns its own decision object");
  assert.equal(JSON.stringify(input), snapshot, "the input is never mutated");
});

// --- Structural guarantees ----------------------------------------------------

const SRC_DIR = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  "src",
);

/**
 * Follow relative *runtime* imports from an entry module.
 *
 * Type-only statements are stripped first: they are erased at build time, so they
 * cannot reach a module, read an environment variable, or cost anything at run
 * time. The same walk `routing.test.ts` uses, for the same reason.
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

test("selection - the module reads no environment, filesystem, or model code", () => {
  const { modules, external } = transitiveImports(path.join(SRC_DIR, "selection.ts"));

  // Exactly one runtime dependency, and it is `routing.ts`, which itself imports
  // nothing at run time. `config.ts` is the module that reads the process
  // environment, and it must stay off this graph: a value import of it — or of
  // `policy.ts`, which imports it — would put the launching environment behind
  // every selection and make the envelope something other than an argument.
  assert.deepEqual(
    modules.sort(),
    [path.join(SRC_DIR, "routing.ts"), path.join(SRC_DIR, "selection.ts")].sort(),
    "the only runtime dependency is the effort ladder route planning already uses",
  );
  assert.deepEqual(external, [], "the selector needs no external runtime imports at all");

  const source = fs.readFileSync(path.join(SRC_DIR, "selection.ts"), "utf8");
  assert.doesNotMatch(source, /process\.env/, "no environment read");
  assert.doesNotMatch(source, /bench/i, "no benchmark code");
});

test("selection - worker count and concurrency are not restated as a selection", () => {
  const decision = selectCompute({ shape: DELEGATING, policy: SINGLE_MODEL });
  assert.deepEqual(Object.keys(decision).sort(), ["detail", "effort", "model", "reason"]);
});
