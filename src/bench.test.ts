/**
 * Benchmark harness tests.
 *
 * The harness produces the numbers this project makes claims from, so its
 * measurement logic is worth testing as carefully as the runtime. All offline:
 * no model calls, no benchmark execution.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PACKAGE_NAME,
  assertBenchConfig,
  assertLocalServer,
  benchCodexHome,
  benchEnv,
  buildBenchConfig,
  isPackageInstall,
  prepareBenchCodexHome,
  resolveBenchMcpServer,
} from "./bench/codex-home.js";
import {
  ARMS,
  CANONICAL_RESULT_CONSUMPTION,
  DELEGATION_POLICY,
  RESULTS_DIR,
  SUITES,
  buildPrompt,
  getConfiguredConcurrency,
  mcpConfigOverlay,
  parseArgs,
  peakOverlap,
  readMcpCall,
  readTelemetry,
} from "./bench/run.js";
import type { Arm } from "./bench/run.js";
import {
  REQUIRED_SETTINGS,
  SERVER_NAME,
  serverEnvTable,
  serverTable,
} from "./cli/settings.js";
import { findTable, readKey, toTomlValue } from "./cli/toml-edit.js";
import type { BatchOutput } from "./contract.js";
import { compactBatch, renderBatch } from "./server.js";
import { MAX_PARALLEL, MAX_PARALLEL_LIMIT, clampParallel } from "./config.js";
import { SCALE_SOLUTIONS } from "./bench/scale-solutions.js";
import { SCALE_TASKS } from "./bench/scale-tasks.js";
import type { BenchTask } from "./bench/tasks.js";

// --- Concurrency measurement ------------------------------------------------

test("workers that never overlap peak at one", () => {
  assert.equal(
    peakOverlap([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]),
    1,
  );
});

test("a worker starting exactly as another ends is not concurrent", () => {
  assert.equal(
    peakOverlap([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ]),
    1,
  );
});

test("overlapping workers are counted together", () => {
  assert.equal(
    peakOverlap([
      { start: 0, end: 10 },
      { start: 5, end: 15 },
    ]),
    2,
  );
});

test("peak reflects the busiest instant, not the total", () => {
  assert.equal(
    peakOverlap([
      { start: 0, end: 100 },
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]),
    2,
  );
});

test("a fully parallel batch peaks at its worker count", () => {
  assert.equal(
    peakOverlap([
      { start: 0, end: 90 },
      { start: 1, end: 88 },
      { start: 2, end: 95 },
      { start: 1, end: 70 },
    ]),
    4,
  );
});

test("no workers means no measurable peak", () => {
  assert.equal(peakOverlap([]), 0);
});

// --- Overhead decomposition -------------------------------------------------

const at = (seconds: number): string =>
  new Date(1_000_000 + seconds * 1000).toISOString();

function writeEvents(lines: object[]): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bench-events-")),
    "events.jsonl",
  );
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

test("the breakdown splits a run into supervisor, setup, workers and integration", () => {
  const file = writeEvents([
    {
      timestamp: at(10),
      type: "batch.started",
      mode: "parallel",
      taskCount: 2,
      maxParallel: 2,
    },
    { timestamp: at(11), type: "task.queued", taskId: "t1", effort: "high" },
    { timestamp: at(11), type: "task.queued", taskId: "t2", effort: "medium" },
    { timestamp: at(12), type: "worktree.created", taskId: "t1", path: "/a" },
    { timestamp: at(14), type: "worktree.created", taskId: "t2", path: "/b" },
    { timestamp: at(15), type: "worker.started", taskId: "t1", effort: "high" },
    { timestamp: at(15), type: "worker.started", taskId: "t2", effort: "medium" },
    {
      timestamp: at(70),
      type: "worker.completed",
      taskId: "t2",
      verdict: "PASS",
      effort: "medium",
      durationSeconds: 55,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 2,
        reasoningOutputTokens: 1,
      },
    },
    {
      timestamp: at(95),
      type: "worker.completed",
      taskId: "t1",
      verdict: "PASS",
      effort: "high",
      durationSeconds: 80,
      usage: {
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 4,
        reasoningOutputTokens: 2,
      },
    },
    {
      timestamp: at(99),
      type: "batch.completed",
      durationSeconds: 89,
      passed: 2,
      failed: 0,
    },
  ]);

  // Run started 10s before the batch and ended 21s after it.
  const telemetry = readTelemetry(file, 0, 1_000_000, 1_000_000 + 120_000);
  const b = telemetry.breakdown;

  assert.equal(
    b.supervisorBeforeSeconds,
    10,
    "time before the batch is the supervisor's",
  );
  assert.equal(b.worktreeSetupSeconds, 4, "batch start to the last worktree");
  assert.equal(b.workerWindowSeconds, 80, "first worker start to last completion");
  assert.equal(b.slowestWorkerSeconds, 80);
  assert.equal(b.integrationSeconds, 4, "last worker to batch completion");
  assert.equal(b.supervisorAfterSeconds, 21, "review after the batch");
  assert.equal(b.peakConcurrency, 2);

  assert.deepEqual(telemetry.efforts, ["high", "medium"]);
  assert.equal(telemetry.delegations.length, 2);
  assert.equal(telemetry.delegations[0]?.usage?.inputTokens, 10);
});

test("the breakdown is null rather than zero when a phase was never observed", () => {
  const file = writeEvents([
    { timestamp: at(1), type: "batch.rejected", reason: "nope" },
  ]);
  const b = readTelemetry(file, 0, 1_000_000, 1_000_000 + 5000).breakdown;
  assert.equal(b.workerWindowSeconds, null);
  assert.equal(b.peakConcurrency, null);
  assert.equal(b.slowestWorkerSeconds, null);
});

test("verification failures and worker failures are counted, not lost", () => {
  const file = writeEvents([
    {
      timestamp: at(1),
      type: "batch.started",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: at(2),
      type: "verification.completed",
      taskId: "t1",
      passed: 1,
      failed: 2,
      refused: 1,
    },
    {
      timestamp: at(3),
      type: "worker.failed",
      taskId: "t2",
      reason: "Could not create an isolated worktree: boom",
    },
    {
      timestamp: at(4),
      type: "integration.conflict",
      path: "src/a.ts",
      tasks: ["t1", "t2"],
    },
  ]);
  const t = readTelemetry(file, 0, 1_000_000, 1_000_000 + 5000);
  assert.equal(t.verificationFailed, 2);
  assert.equal(t.verificationRefused, 1);
  assert.equal(t.integrationConflicts, 1);
  assert.equal(t.workerFailures.length, 1);
  assert.match(t.workerFailures[0]!, /isolated worktree/);
});

test("only events after the offset are read, so runs do not bleed into each other", () => {
  const first = { timestamp: at(1), type: "task.queued", taskId: "old", effort: "max" };
  const second = {
    timestamp: at(2),
    type: "task.queued",
    taskId: "new",
    effort: "medium",
  };
  const file = writeEvents([first, second]);
  const offset = Buffer.byteLength(JSON.stringify(first) + "\n");
  assert.deepEqual(readTelemetry(file, offset, 1_000_000, 1_000_000 + 1000).efforts, [
    "medium",
  ]);
});

// --- Fixture integrity ------------------------------------------------------

const allTasks: BenchTask[] = Object.values(SUITES).flat();

test("every fixture protects its own specification", () => {
  for (const task of allTasks) {
    const specs = Object.keys(task.files).filter((name) => /test/.test(name));
    for (const spec of specs) {
      assert.ok(
        task.immutable.includes(spec),
        `${task.id}: ${spec} is the specification but is not immutable, so a run could edit it`,
      );
    }
  }
});

test("every fixture has at least one grading command", () => {
  for (const task of allTasks) {
    assert.ok(task.grade.length > 0, `${task.id} has no grade command`);
  }
});

test("scale fixtures declare their tier and stream count", () => {
  for (const task of SCALE_TASKS) {
    assert.ok(task.tier, `${task.id} has no tier`);
    assert.ok(
      typeof task.streams === "number" && task.streams >= 1,
      `${task.id} has no stream count`,
    );
  }
});

test("every scale fixture has a reference solution for each module it ships", () => {
  for (const task of SCALE_TASKS) {
    const solution = SCALE_SOLUTIONS[task.id];
    assert.ok(solution, `${task.id} has no reference solution`);
    const stubs = Object.keys(task.files).filter((name) => name.startsWith("src/"));
    assert.deepEqual(
      Object.keys(solution).sort(),
      stubs.sort(),
      `${task.id}: reference solution and shipped modules disagree`,
    );
  }
});

test("a fixture's stream count matches the modules it asks for", () => {
  for (const task of SCALE_TASKS) {
    const modules = Object.keys(task.files).filter((name) => name.startsWith("src/"));
    assert.equal(
      modules.length,
      task.streams,
      `${task.id} declares ${task.streams} streams but ships ${modules.length} modules`,
    );
  }
});

test("every module a fixture ships is named in its objective", () => {
  for (const task of SCALE_TASKS) {
    for (const name of Object.keys(task.files).filter((f) => f.startsWith("src/"))) {
      assert.ok(
        task.objective.includes(name),
        `${task.id}: ${name} is never mentioned in the objective`,
      );
    }
  }
});

// --- Arm fairness -----------------------------------------------------------

test("solo arms genuinely cannot delegate", () => {
  for (const arm of ["solo-high", "solo-xhigh"] as const) {
    assert.equal(ARMS[arm].delegation, false);
  }
});

test("the free-choice arm neither mandates nor forbids delegation", () => {
  const guidance = ARMS.adaptive.guidance;
  assert.equal(ARMS.adaptive.delegation, true);
  assert.ok(!/MUST delegate/i.test(guidance));
  assert.ok(!/do not delegate/i.test(guidance));
});

test("every arm runs the supervisor at a stated effort", () => {
  for (const [name, spec] of Object.entries(ARMS)) {
    assert.ok(
      ["medium", "high", "xhigh", "max"].includes(spec.effort),
      `${name} has an unexpected effort`,
    );
  }
});

// --- Delegation policy -------------------------------------------------------

const DELEGATING_ARMS = (Object.keys(ARMS) as Arm[]).filter(
  (arm) => ARMS[arm].delegation,
);
const SOLO_ARMS = (Object.keys(ARMS) as Arm[]).filter((arm) => !ARMS[arm].delegation);
const SCALE_WIDTHS = SUITES.scale.filter((task) => task.tier === "scale");

const [FIXTURE] = SUITES.scale;
if (!FIXTURE) throw new Error("the scale suite is empty");

test("every delegating arm asks for compact results explicitly", () => {
  for (const arm of DELEGATING_ARMS) {
    assert.ok(
      buildPrompt(FIXTURE, arm).includes('resultDetail: "compact"'),
      `${arm} does not ask for compact`,
    );
  }
});

test("a solo arm is given no delegation policy at all", () => {
  for (const arm of SOLO_ARMS) {
    assert.ok(!buildPrompt(FIXTURE, arm).includes(DELEGATION_POLICY));
  }
});

test("successful delegation does not instruct Sol to perform redundant manual review", () => {
  const prompt = buildPrompt(FIXTURE, "par-forced");
  assert.match(prompt, /clean PASS/);
  for (const banned of [
    "git diff",
    "rereading the implementations",
    "rerunning verification",
    "manual integration review",
  ]) {
    assert.ok(prompt.includes(banned), `the clean-PASS rule should mention ${banned}`);
  }
  // ...but only for a clean PASS. Anything else is still investigated.
  assert.match(prompt, /Anything else is\s+investigated properly/);
});

test("no arm still demands a whole-suite rerun just because work was delegated", () => {
  for (const arm of DELEGATING_ARMS) {
    assert.ok(
      !/confirm the whole suite passes/i.test(buildPrompt(FIXTURE, arm)),
      `${arm} still demands an unconditional suite rerun`,
    );
  }
});

test("the capsule is offered as conditional, exactly as the product describes it", () => {
  const prompt = buildPrompt(FIXTURE, "par-forced");
  assert.match(prompt, /Consider `contextCapsule`/);
  assert.match(prompt, /only where it carries something the/);
  assert.match(prompt, /Omit it/);
});

// --- Canonical result consumption --------------------------------------------

test("the canonical consumption path is byte-identical across delegating arms", () => {
  const seen = new Set(
    DELEGATING_ARMS.map((arm) => {
      const prompt = buildPrompt(FIXTURE, arm);
      const at = prompt.indexOf(CANONICAL_RESULT_CONSUMPTION);
      assert.ok(at >= 0, `${arm} is missing the canonical consumption path`);
      return CANONICAL_RESULT_CONSUMPTION;
    }),
  );
  assert.equal(seen.size, 1);
});

test("the canonical consumption path is byte-identical across scale widths", () => {
  // The whole point: width 6, 12 and 20 must differ only in the fixture, never
  // in how the supervisor is told to read the result back.
  assert.deepEqual(
    SCALE_WIDTHS.map((task) => task.streams),
    [6, 12, 20],
  );
  const tail = (task: BenchTask): string => {
    const prompt = buildPrompt(task, "par-forced");
    return prompt.slice(prompt.indexOf(DELEGATION_POLICY));
  };
  const expected = tail(FIXTURE);
  for (const task of SCALE_WIDTHS) assert.equal(tail(task), expected);
  assert.ok(expected.includes(CANONICAL_RESULT_CONSUMPTION));
});

test("the canonical path names both surfaces, text first", () => {
  const text = CANONICAL_RESULT_CONSUMPTION.indexOf("result.content");
  const structured = CANONICAL_RESULT_CONSUMPTION.indexOf("structuredContent");
  assert.ok(text >= 0 && structured > text, "text surface must be printed first");
  // The width-6 run dropped the structured surface and the width-12 run kept
  // it; the canonical path is the one that keeps what a host would deliver.
  assert.match(CANONICAL_RESULT_CONSUMPTION, /structured_content/);
  assert.match(CANONICAL_RESULT_CONSUMPTION, /unsummarised and unfiltered/);
});

// --- What actually crossed the MCP boundary ----------------------------------

/**
 * A batch shaped like the scale fixtures: `width` disjoint tasks, all passing,
 * plus — when asked — one task carrying every kind of bad news at once.
 */
function scaleBatch(width: number, withTrouble = false): BatchOutput {
  const task = (index: number, bad: boolean) => ({
    taskId: `t${index}-module`,
    state: "completed" as const,
    objective: `implement src/module${index}.mjs`,
    effort: "high",
    effortReason: "bounded implementation",
    result: {
      verdict: bad ? ("FAILED" as const) : ("PASS" as const),
      workerClaimedStatus: "PASS" as const,
      trustworthy: !bad,
      workerThreadId: `thread_${index}`,
      model: "gpt-5.6-luna",
      effort: "high",
      effortReason: "bounded implementation",
      attempt: 1,
      summary: "wrote the module",
      notes: "",
      followUps: [],
      filesChanged: [
        {
          path: `src/module${index}.mjs`,
          kind: "modified",
          why: "the implementation",
          observed: true,
        },
      ],
      verification: [
        {
          command: `node --test test/module${index}.test.mjs`,
          source: "orchestrator" as const,
          execution: "argv" as const,
          exitCode: 0,
          passed: true,
          output: "PASS_OUTPUT_SHOULD_DISAPPEAR",
        },
        ...(bad
          ? [
              {
                command: "node --test test/broken.test.mjs",
                source: "orchestrator" as const,
                execution: "argv" as const,
                exitCode: 1,
                passed: false,
                output: "FAIL_OUTPUT_MUST_SURVIVE",
              },
            ]
          : []),
      ],
      verificationMode: "allowlist",
      scopeViolations: bad ? ["src/off-limits.mjs was modified"] : [],
      discrepancies: bad ? ["worker reported PASS but the rerun exits 1"] : [],
      reviewChecklist: [],
      escalationAdvice: null,
      durationSeconds: 30,
      usage: null,
      errors: [],
    },
    changedFiles: [`src/module${index}.mjs`],
    worktreePath: null,
    error: null,
    warnings: [],
  });

  const tasks = Array.from({ length: width }, (_unused, index) =>
    task(index + 1, withTrouble && index === 0),
  );

  return {
    batchId: `b${width}`,
    mode: "parallel",
    maxParallel: width,
    taskCount: width,
    passed: withTrouble ? width - 1 : width,
    failed: withTrouble ? 1 : 0,
    durationSeconds: 120,
    tasks,
    scopeConflicts: [],
    integrationConflicts: withTrouble
      ? [{ path: "src/shared.mjs", tasks: ["t1-module", "t2-module"] }]
      : [],
    integrated: !withTrouble,
    integrationSummary: withTrouble ? "not integrated" : `merged ${width} files`,
    warnings: [],
    reviewChecklist: [],
  } as BatchOutput;
}

/** Exactly what {@link CANONICAL_RESULT_CONSUMPTION} tells the supervisor to print. */
function canonicalTranscript(batch: BatchOutput, detail: "full" | "compact"): string {
  const structured = detail === "compact" ? compactBatch(batch) : batch;
  return [renderBatch(batch), JSON.stringify(structured)].join("\n");
}

/** The tool result the server hands back, in the shape the event stream reports. */
function mcpItem(batch: BatchOutput, detail: "full" | "compact", width: number) {
  const structured = detail === "compact" ? compactBatch(batch) : batch;
  return {
    tool: "delegate_tasks",
    arguments: {
      mode: "parallel",
      resultDetail: detail,
      tasks: Array.from({ length: width }, (_unused, index) => ({
        objective: `implement src/module${index + 1}.mjs`,
      })),
    },
    result: {
      content: [{ type: "text", text: renderBatch(batch) }],
      structured_content: structured,
    },
  };
}

test("the canonical representation is the same construction at every width", () => {
  // Not the same *bytes* — the payload genuinely grows with the task count.
  // The same construction: both surfaces, text first, nothing dropped.
  for (const width of [6, 12, 20]) {
    const batch = scaleBatch(width);
    const transcript = canonicalTranscript(batch, "compact");
    assert.ok(transcript.startsWith(renderBatch(batch)), `width ${width} lost the text`);
    assert.ok(
      transcript.includes(JSON.stringify(compactBatch(batch))),
      `width ${width} lost the structured surface`,
    );
    for (let index = 1; index <= width; index += 1) {
      assert.ok(
        transcript.includes(`src/module${index}.mjs`),
        `width ${width} lost task ${index}`,
      );
    }
  }
});

test("the canonical representation grows only with the payload", () => {
  // A 12-wide batch should cost about twice a 6-wide one. The first width-12
  // run cost roughly twelve times the width-6 one because the two supervisors
  // serialised differently; under one construction that cannot recur.
  const size = (width: number): number =>
    canonicalTranscript(scaleBatch(width), "compact").length;
  const ratio = size(12) / size(6);
  assert.ok(ratio > 1.6 && ratio < 2.4, `width 12/6 size ratio was ${ratio.toFixed(2)}`);
});

test("compact plus the canonical path still surfaces every kind of bad news", () => {
  const transcript = canonicalTranscript(scaleBatch(6, true), "compact");
  for (const evidence of [
    "FAILED",
    "FAIL_OUTPUT_MUST_SURVIVE",
    "worker reported PASS but the rerun exits 1",
    "src/off-limits.mjs was modified",
    "src/shared.mjs",
  ]) {
    assert.ok(transcript.includes(evidence), `compact hid: ${evidence}`);
  }
  // ...while still doing the one thing compact is for.
  assert.ok(!transcript.includes("PASS_OUTPUT_SHOULD_DISAPPEAR"));
});

test("a full result keeps the passing output the compact one drops", () => {
  const batch = scaleBatch(6);
  assert.ok(canonicalTranscript(batch, "full").includes("PASS_OUTPUT_SHOULD_DISAPPEAR"));
  assert.ok(
    !canonicalTranscript(batch, "compact").includes("PASS_OUTPUT_SHOULD_DISAPPEAR"),
  );
});

test("the recorded call reports the width, the detail and both surface sizes", () => {
  for (const width of [6, 12, 20]) {
    const batch = scaleBatch(width);
    const record = readMcpCall(mcpItem(batch, "compact", width));
    assert.equal(record.tool, "delegate_tasks");
    assert.equal(record.taskCount, width);
    assert.equal(record.resultDetail, "compact");
    assert.equal(record.contextCapsule, false);
    assert.equal(record.contentChars, renderBatch(batch).length);
    assert.equal(record.structuredChars, JSON.stringify(compactBatch(batch)).length);
    assert.equal(
      record.canonicalChars,
      record.contentChars + record.structuredChars,
      "canonicalChars must be both surfaces, so a reader can check comparability",
    );
    // One character apart, because the transcript joins the two with a newline.
    assert.equal(record.canonicalChars, canonicalTranscript(batch, "compact").length - 1);
  }
});

test("a supervisor that omitted resultDetail is recorded as having omitted it", () => {
  // The prompt asks for compact. Whether it obeyed is a fact about the run, so
  // it is read off the call rather than assumed from the prompt.
  const record = readMcpCall({
    tool: "delegate_tasks",
    arguments: { mode: "parallel", tasks: [{ objective: "x" }] },
    result: { content: [], structured_content: null },
  });
  assert.equal(record.resultDetail, null);
});

test("a capsule is recorded when any task carries one", () => {
  const withCapsule = readMcpCall({
    tool: "delegate_tasks",
    arguments: {
      tasks: [
        { objective: "a" },
        { objective: "b", contextCapsule: { interfaces: "x" } },
      ],
    },
  });
  assert.equal(withCapsule.contextCapsule, true);

  const single = readMcpCall({
    tool: "delegate_task",
    arguments: { objective: "a", contextCapsule: { interfaces: "x" } },
  });
  assert.equal(single.taskCount, null);
  assert.equal(single.contextCapsule, true);
});

test("an unexpected or failed call is recorded, not thrown away", () => {
  // Losing a whole benchmark run to a telemetry surprise is worse than an
  // incomplete row.
  const record = readMcpCall({
    tool: undefined,
    arguments: undefined,
    result: undefined,
  });
  assert.equal(record.tool, "unknown");
  assert.equal(record.taskCount, null);
  assert.equal(record.canonicalChars, 0);
});

// --- Concurrency configuration ----------------------------------------------

test("a scale fixture is run at the concurrency its width needs", () => {
  const arm = ARMS["par-forced"];
  // The first width-12 run was capped at 8 and therefore measured waves, not
  // 12-way concurrency. Each width must now configure its own stream count.
  assert.equal(getConfiguredConcurrency(arm, { streams: 6 }), 6);
  assert.equal(getConfiguredConcurrency(arm, { streams: 12 }), 12);
  assert.equal(getConfiguredConcurrency(arm, { streams: 20 }), 20);
});

test("every scale fixture asks for exactly as many workers as it has streams", () => {
  const arm = ARMS["par-forced"];
  for (const task of SUITES.scale) {
    assert.equal(
      getConfiguredConcurrency(arm, task),
      task.streams ?? 3,
      `${task.id} would not run at its own width`,
    );
  }
});

test("solo arms configure no concurrency at all", () => {
  for (const arm of ["solo-high", "solo-xhigh"] as const) {
    assert.equal(getConfiguredConcurrency(ARMS[arm], { streams: 12 }), null);
  }
});

test("benchmark concurrency cannot exceed the runtime's own hard ceiling", () => {
  assert.equal(
    getConfiguredConcurrency(ARMS["par-forced"], { streams: MAX_PARALLEL_LIMIT + 40 }),
    MAX_PARALLEL_LIMIT,
  );
  assert.equal(MAX_PARALLEL_LIMIT, 20);
});

test("the production default concurrency is untouched by the benchmark helper", () => {
  // The helper only computes a value to hand the orchestrator via
  // SOL_LUNA_MAX_PARALLEL for one arm. Nothing it does may change what an
  // ordinary server starts with.
  assert.equal(process.env.SOL_LUNA_MAX_PARALLEL, undefined);
  assert.equal(MAX_PARALLEL, 3);
  getConfiguredConcurrency(ARMS["par-forced"], { streams: 20 });
  assert.equal(MAX_PARALLEL, 3);
});

test("BENCH_MAX_PARALLEL overrides the fixture width when set", () => {
  process.env.BENCH_MAX_PARALLEL = "5";
  try {
    assert.equal(getConfiguredConcurrency(ARMS["par-forced"], { streams: 12 }), 5);
  } finally {
    delete process.env.BENCH_MAX_PARALLEL;
  }
});

test("an unusable BENCH_MAX_PARALLEL is an error, not a silent run at one", () => {
  // Silently coercing garbage to 1 produces a run that looks like a valid
  // measurement afterwards, which is the worst possible failure for a
  // benchmark that costs real money.
  for (const bad of ["twelve", "", "0", "-3"]) {
    process.env.BENCH_MAX_PARALLEL = bad;
    try {
      assert.throws(
        () => getConfiguredConcurrency(ARMS["par-forced"], { streams: 12 }),
        /BENCH_MAX_PARALLEL/,
        `"${bad}" should be rejected`,
      );
    } finally {
      delete process.env.BENCH_MAX_PARALLEL;
    }
  }
});

// --- Explicit suite selection -----------------------------------------------

test("deterministic preflight cannot accidentally invoke the live micro benchmark", () => {
  assert.throws(() => parseArgs([]), /--suite must be specified/);
});

test("a suite that does not exist is refused before anything is spent", () => {
  assert.throws(() => parseArgs(["--suite", "scale12"]), /Unknown --suite/);
});

test("a flag cannot be swallowed as the suite name", () => {
  // `--suite --reps 1` used to read "--reps" as the suite, then fall through
  // to the micro default arm list and start a live run.
  assert.throws(() => parseArgs(["--suite", "--reps", "1"]), /Unknown --suite/);
});

test("each real suite still resolves to its own arms", () => {
  for (const name of Object.keys(SUITES)) {
    const parsed = parseArgs(["--suite", name]);
    assert.equal(parsed.suite, name);
    assert.ok(parsed.arms.length > 0);
  }
});

// --- Artifact safety ---------------------------------------------------------

test("results never live where the per-arm reset can reach them", () => {
  // Between arms the harness removes its temp workspace with a recursive rm.
  // That is only safe while the results directory cannot be inside it, so
  // assert the two trees are genuinely disjoint rather than assuming it.
  const tmp = fs.realpathSync(os.tmpdir());
  const results = fs.realpathSync(RESULTS_DIR);
  const inside = path.relative(tmp, results);
  assert.ok(
    // A different drive letter on Windows yields an absolute path, which is
    // as disjoint as a leading "..".
    inside === "" ? false : inside.startsWith("..") || path.isAbsolute(inside),
    `results directory ${results} sits inside the OS temp tree ${tmp}`,
  );
  assert.equal(path.basename(results), "results");
  assert.equal(path.basename(path.dirname(results)), "bench");
});

test("the results directory is fixed to the repository, not the cwd", () => {
  // A cwd-relative results path would write somewhere new every time the
  // harness were launched from a different directory, and older artifacts
  // would look deleted when they were merely elsewhere.
  assert.ok(path.isAbsolute(RESULTS_DIR));
  const original = process.cwd();
  try {
    process.chdir(os.tmpdir());
    assert.equal(RESULTS_DIR, path.resolve(RESULTS_DIR));
  } finally {
    process.chdir(original);
  }
});

test("existing result artifacts survive a workspace reset", () => {
  // The reset is a recursive rm of one temp workspace. Prove that a sibling
  // artifact outside that workspace is untouched by exactly that operation.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-reset-"));
  try {
    const results = path.join(root, "results");
    fs.mkdirSync(results);
    const artifact = path.join(results, "2026-01-01T00-00-00-000Z.scale.json");
    fs.writeFileSync(artifact, '{"records":[]}');

    const workspace = fs.mkdtempSync(path.join(root, "bench-scale-"));
    fs.writeFileSync(path.join(workspace, "throwaway.mjs"), "");
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });

    assert.equal(fs.existsSync(workspace), false, "the workspace should be gone");
    assert.equal(fs.existsSync(artifact), true, "the artifact should survive");
    assert.equal(fs.readFileSync(artifact, "utf8"), '{"records":[]}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the harness never invokes a git clean", async () => {
  // Untracked-but-unignored result files are exactly what `git clean -fd`
  // removes while leaving ignored ones behind, so the harness must not run it.
  //
  // Checked against how commands are actually built rather than by searching
  // the file for a word: the harness reaches a process in exactly two ways,
  // and prose is not one of them. (Searching the text matches "a clean PASS"
  // in the delegation policy, so that form of the check could only ever be
  // vacuous or wrong.)
  //
  //   1. runGit(args, cwd), which spawns `git` with args[0] as the subcommand.
  const source = await fs.promises.readFile(
    path.join(RESULTS_DIR, "..", "..", "src", "bench", "run.ts"),
    "utf8",
  );
  const subcommands = [...source.matchAll(/runGit\(\s*\[\s*"([^"]+)"/g)].map(
    (m) => m[1]!,
  );
  assert.deepEqual(
    [...new Set(subcommands)].sort(),
    ["add", "commit", "config", "init"],
    "the harness runs a git subcommand this test has not vetted",
  );
  // Every call site must have been read. An argument list the pattern above
  // cannot see — a variable, or a subcommand built at runtime — would
  // otherwise go unexamined and pass.
  assert.equal(
    subcommands.length,
    (source.match(/runGit\(/g) ?? []).length,
    "a runGit call site was not readable as a literal argument list",
  );

  //   2. execFile(command.file, command.args) for each fixture's grading and
  //      mutation commands, which are data rather than source.
  for (const [suite, tasks] of Object.entries(SUITES)) {
    for (const task of tasks) {
      const commands = [...task.grade, ...(task.mutation ? [task.mutation.command] : [])];
      for (const command of commands) {
        // Either separator: `command.file` is an absolute path on Windows.
        const isGit = /(^|[\\/])git(\.exe)?$/i.test(command.file);
        assert.ok(
          !(isGit && command.args.includes("clean")),
          `${suite}/${task.id} runs ${command.file} ${command.args.join(" ")}`,
        );
      }
    }
  }
});

// --- Which MCP server a live run is actually given ---------------------------

/**
 * The registration this machine had when a width-12 run recorded a ceiling of
 * eight: the globally installed npm package rather than the branch under test.
 *
 * Used as the base config below so the tests prove two things at once — that
 * the harness overrides exactly this entry, and that it disturbs nothing else
 * in a file it does not own.
 */
const GLOBAL_INSTALL_ENTRY =
  "C:\\Users\\mahad\\AppData\\Local\\nvm\\v26.7.0\\node_modules\\sol-luna-orchestrator\\dist\\server.js";

const USER_CONFIG = `model = "gpt-5.6-sol"
model_reasoning_effort = "medium"

[windows]
sandbox = "elevated"

[projects.'d:\\code\\gpt-test']
trust_level = "trusted"

# Docs lookup. Do not remove.
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
startup_timeout_sec = 15

[mcp_servers.sol-luna-orchestrator]
command = 'C:\\nvm4w\\nodejs\\node.exe'
args = ['${GLOBAL_INSTALL_ENTRY}']
tool_timeout_sec = 3600
startup_timeout_sec = 30
default_tools_approval_mode = "approve"

[mcp_servers.sol-luna-orchestrator.env]
SOL_LUNA_LOG = 'C:\\Users\\mahad\\.codex\\orchestrator.log'
`;

/** This repository's own built server, derived without touching the filesystem. */
const LOCAL_ENTRY = path.join(path.resolve(RESULTS_DIR, "..", ".."), "dist", "server.js");

const benchConfigInput = (
  maxParallel: number | null,
  baseConfig = USER_CONFIG,
): Parameters<typeof buildBenchConfig>[0] => ({
  baseConfig,
  command: process.execPath,
  serverEntry: LOCAL_ENTRY,
  logPath: path.join(os.tmpdir(), "sol-luna-bench-codex-home", "orchestrator.log"),
  eventsPath: path.join(RESULTS_DIR, "2026-01-01T00-00-00-000Z.events.jsonl"),
  maxParallel,
});

const benchConfigFor = (maxParallel: number | null, baseConfig = USER_CONFIG): string =>
  buildBenchConfig(benchConfigInput(maxParallel, baseConfig));

test("the benchmark registers this repository's own build, not an installed package", () => {
  const server = resolveBenchMcpServer();
  const repository = path.resolve(RESULTS_DIR, "..", "..");

  assert.equal(server.packageRoot, repository);
  assert.equal(server.entry, path.join(repository, "dist", "server.js"));
  assert.equal(fs.existsSync(server.entry), true, `${server.entry} is missing`);
  assert.equal(isPackageInstall(server.entry), false);
  assert.match(server.sha256, /^[0-9a-f]{64}$/);

  // The one number that made the original mismatch visible: the published
  // package clamps a batch at 8, this build at MAX_PARALLEL_LIMIT.
  assert.equal(server.maxParallelLimit, MAX_PARALLEL_LIMIT);
});

test("the isolated configuration never names the global installation", () => {
  const text = benchConfigFor(12);

  assert.equal(readKey(text, serverTable(), "args"), toTomlValue([LOCAL_ENTRY]));
  assert.equal(readKey(text, serverTable(), "command"), toTomlValue(process.execPath));
  assert.ok(
    !text.includes(GLOBAL_INSTALL_ENTRY),
    "the globally installed server path survived into the benchmark config",
  );

  const table = findTable(text, serverTable());
  assert.ok(table, "the benchmark config does not register the orchestrator");
  const ours = text.split(/\r?\n/).slice(table.start, table.end).join("\n");
  assert.ok(!/node_modules/i.test(ours), `registration still names an install:\n${ours}`);

  // Everything else in the user's file is the environment previous benchmarks
  // were measured in, so it has to survive verbatim.
  for (const artifact of [
    "# Docs lookup. Do not remove.",
    "[mcp_servers.context7]",
    'args = ["-y", "@upstash/context7-mcp"]',
    'sandbox = "elevated"',
    "[projects.'d:\\code\\gpt-test']",
    'model_reasoning_effort = "medium"',
  ]) {
    assert.ok(text.includes(artifact), `carried-over config lost ${artifact}`);
  }
});

test("the isolated configuration keeps every setting delegation needs", () => {
  // Read from the shipped list rather than restated here, so a setting added to
  // the product cannot be silently missing from the benchmark's own config.
  const text = benchConfigFor(12);
  for (const setting of REQUIRED_SETTINGS) {
    assert.equal(
      readKey(text, serverTable(), setting.key),
      setting.expected,
      setting.key,
    );
  }
  assert.equal(readKey(text, serverTable(), "tool_timeout_sec"), "3600");
  assert.equal(readKey(text, serverTable(), "default_tools_approval_mode"), '"approve"');
});

test("6, 12 and 20 reach the MCP server on both surfaces", () => {
  for (const width of [6, 12, 20]) {
    // What the harness chooses for a fixture of this width...
    assert.equal(getConfiguredConcurrency(ARMS["par-forced"], { streams: width }), width);

    // ...is what the isolated config hands the server...
    assert.equal(
      readKey(benchConfigFor(width), serverEnvTable(), "SOL_LUNA_MAX_PARALLEL"),
      toTomlValue(String(width)),
      `width ${width} did not reach the config`,
    );

    // ...and what the --config overlay says, which must agree with it...
    const overlay = mcpConfigOverlay("events.jsonl", width).mcp_servers[SERVER_NAME];
    const env = overlay?.env as Record<string, string> | undefined;
    assert.equal(env?.SOL_LUNA_MAX_PARALLEL, String(width));

    // ...and the build being registered honours it rather than clamping it,
    // which is the half that was untrue while a v0.7.0 package was launched.
    assert.equal(clampParallel(width), width);
  }
});

test("a solo arm cannot reach the server, and the next arm still can", () => {
  const solo = benchConfigFor(null);
  assert.equal(readKey(solo, serverTable(), "enabled"), "false");
  assert.equal(readKey(solo, serverEnvTable(), "SOL_LUNA_MAX_PARALLEL"), null);
  assert.equal(
    mcpConfigOverlay("events.jsonl", null).mcp_servers[SERVER_NAME]?.enabled,
    false,
  );

  // Feeding a solo arm's own output back in as the base proves the per-arm
  // rewrite cannot leave `enabled = false` behind for a delegating arm.
  const delegating = benchConfigFor(12, solo);
  assert.equal(readKey(delegating, serverTable(), "enabled"), "true");
  assert.equal(readKey(delegating, serverTable(), "args"), toTomlValue([LOCAL_ENTRY]));
  assert.equal(
    readKey(delegating, serverEnvTable(), "SOL_LUNA_MAX_PARALLEL"),
    toTomlValue("12"),
  );
});

test("a config still pointing at the global install is refused, not used", () => {
  assert.throws(
    () => assertBenchConfig(USER_CONFIG, benchConfigInput(12)),
    /Benchmark config points at/,
  );
  // And a benchmark config whose concurrency went missing is refused too: a
  // run at a silently different width is not a measurement.
  assert.throws(
    () => assertBenchConfig(benchConfigFor(null), benchConfigInput(12)),
    /SOL_LUNA_MAX_PARALLEL/,
  );
});

test("a missing local build fails the run instead of falling back to npm", () => {
  const repository = path.resolve(RESULTS_DIR, "..", "..");
  assert.throws(
    () =>
      assertLocalServer({
        entry: path.join(repository, "dist", "server.js"),
        exists: false,
        packageRoot: repository,
        packageName: PACKAGE_NAME,
        hasSources: true,
      }),
    (error: Error) =>
      /npm run build/.test(error.message) && /will not fall back/.test(error.message),
  );
});

test("an installed package is refused even when it is present and complete", () => {
  assert.equal(isPackageInstall(GLOBAL_INSTALL_ENTRY), true);
  assert.equal(isPackageInstall("/home/me/repo/dist/server.js"), false);

  assert.throws(
    () =>
      assertLocalServer({
        entry: GLOBAL_INSTALL_ENTRY,
        exists: true,
        packageRoot: path.dirname(path.dirname(GLOBAL_INSTALL_ENTRY)),
        packageName: PACKAGE_NAME,
        hasSources: false,
      }),
    /resolved to an installed package/,
  );

  // A dist-only tree outside node_modules is not the local repository either.
  assert.throws(
    () =>
      assertLocalServer({
        entry: "/opt/sol-luna/dist/server.js",
        exists: true,
        packageRoot: "/opt/sol-luna",
        packageName: PACKAGE_NAME,
        hasSources: false,
      }),
    /not the current local repository/,
  );
});

test("preparing the benchmark home never touches the user's Codex config", () => {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "bench-user-home-"));
  const benchHome = fs.mkdtempSync(path.join(os.tmpdir(), "bench-codex-home-"));
  const previousUser = process.env.CODEX_HOME;
  const previousBench = process.env.BENCH_CODEX_HOME;

  try {
    fs.writeFileSync(path.join(userHome, "config.toml"), USER_CONFIG, "utf8");
    // Not a credential: only its presence and its copying are asserted.
    fs.writeFileSync(path.join(userHome, "auth.json"), '{"fake":true}\n', "utf8");
    process.env.CODEX_HOME = userHome;
    process.env.BENCH_CODEX_HOME = benchHome;

    const session = prepareBenchCodexHome({
      eventsPath: path.join(benchHome, "events.jsonl"),
      maxParallel: 12,
    });

    // The user's home, byte for byte, with nothing added beside it — no
    // rewritten registration and no backup file either.
    assert.equal(
      fs.readFileSync(path.join(userHome, "config.toml"), "utf8"),
      USER_CONFIG,
    );
    assert.deepEqual(fs.readdirSync(userHome).sort(), ["auth.json", "config.toml"]);

    // The benchmark's own home is where everything happened.
    assert.equal(session.home, benchHome);
    assert.equal(session.configPath, path.join(benchHome, "config.toml"));
    assert.equal(session.env.CODEX_HOME, benchHome);

    const written = fs.readFileSync(session.configPath, "utf8");
    assert.ok(!written.includes(GLOBAL_INSTALL_ENTRY));
    assert.equal(
      readKey(written, serverEnvTable(), "SOL_LUNA_MAX_PARALLEL"),
      toTomlValue("12"),
    );
    assert.equal(
      readKey(written, serverTable(), "args"),
      toTomlValue([resolveBenchMcpServer().entry]),
    );

    // Credentials are copied in, because an isolated home has none of its own.
    assert.equal(fs.existsSync(path.join(benchHome, "auth.json")), true);

    // Provenance is what proves, after the fact, which server a run had.
    assert.equal(session.provenance.isolated, true);
    assert.equal(session.provenance.maxParallel, 12);
    assert.equal(session.provenance.serverEnabled, true);
    assert.equal(session.provenance.maxParallelLimit, MAX_PARALLEL_LIMIT);
    assert.equal(session.provenance.toolTimeoutSec, "3600");
    assert.equal(session.provenance.approvalMode, '"approve"');
    assert.equal(session.provenance.codexHome, benchHome);
    assert.match(session.provenance.configSha256, /^[0-9a-f]{64}$/);
  } finally {
    if (previousUser === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousUser;
    if (previousBench === undefined) delete process.env.BENCH_CODEX_HOME;
    else process.env.BENCH_CODEX_HOME = previousBench;
    fs.rmSync(userHome, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(benchHome, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the benchmark refuses to run inside the user's own Codex home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bench-same-home-"));
  const previousUser = process.env.CODEX_HOME;
  const previousBench = process.env.BENCH_CODEX_HOME;

  try {
    process.env.CODEX_HOME = home;
    process.env.BENCH_CODEX_HOME = home;
    assert.throws(
      () =>
        prepareBenchCodexHome({
          eventsPath: path.join(home, "events.jsonl"),
          maxParallel: 12,
        }),
      /must be a separate one/,
    );
    assert.deepEqual(fs.readdirSync(home), []);
  } finally {
    if (previousUser === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousUser;
    if (previousBench === undefined) delete process.env.BENCH_CODEX_HOME;
    else process.env.BENCH_CODEX_HOME = previousBench;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the parent session is pointed at the benchmark home and nothing else moves", () => {
  const env = benchEnv("/bench/home", {
    PATH: "/usr/bin",
    CODEX_HOME: "/user/home",
    Codex_Home: "/user/home",
    UNSET: undefined,
  });

  assert.equal(env.CODEX_HOME, "/bench/home");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal("UNSET" in env, false);
  assert.deepEqual(
    Object.keys(env).filter((key) => /^codex_home$/i.test(key)),
    ["CODEX_HOME"],
  );
});

test("the benchmark's Codex home is its own directory, beside the user's", () => {
  const previous = process.env.BENCH_CODEX_HOME;
  try {
    delete process.env.BENCH_CODEX_HOME;
    const home = benchCodexHome();
    assert.ok(path.isAbsolute(home));

    // Never the user's own home: that is the file this whole module exists to
    // leave alone.
    assert.notEqual(
      path.resolve(home).toLowerCase(),
      path.resolve(path.join(os.homedir(), ".codex")).toLowerCase(),
    );

    // Never inside the repository either: a copied credential must not be able
    // to land somewhere a commit could pick it up.
    const inside = path.relative(path.resolve(RESULTS_DIR, "..", ".."), home);
    assert.ok(
      inside.startsWith("..") || path.isAbsolute(inside),
      `${home} sits inside the repository`,
    );

    // An explicit override is honoured, so a run can be pointed elsewhere.
    process.env.BENCH_CODEX_HOME = path.join(os.tmpdir(), "elsewhere");
    assert.equal(benchCodexHome(), path.resolve(path.join(os.tmpdir(), "elsewhere")));
  } finally {
    if (previous === undefined) delete process.env.BENCH_CODEX_HOME;
    else process.env.BENCH_CODEX_HOME = previous;
  }
});

test("a benchmark config identifies itself and does not stack banners", () => {
  const once = benchConfigFor(12);
  assert.match(once, /^# Generated by the sol-luna-orchestrator benchmark harness/);

  // Rebuilding from a previous benchmark config is what a reused home does.
  const twice = buildBenchConfig(benchConfigInput(12, once));
  assert.equal(twice, once, "regenerating from its own output is not stable");
});
