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
  ARMS,
  CANONICAL_RESULT_CONSUMPTION,
  DELEGATION_POLICY,
  RESULTS_DIR,
  SUITES,
  buildPrompt,
  getConfiguredConcurrency,
  parseArgs,
  peakOverlap,
  readMcpCall,
  readTelemetry,
} from "./bench/run.js";
import type { Arm } from "./bench/run.js";
import type { BatchOutput } from "./contract.js";
import { compactBatch, renderBatch } from "./server.js";
import { MAX_PARALLEL, MAX_PARALLEL_LIMIT } from "./config.js";
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
  const source = await fs.promises.readFile(
    path.join(RESULTS_DIR, "..", "..", "src", "bench", "run.ts"),
    "utf8",
  );
  assert.ok(!/clean/.test(source), "run.ts mentions a git clean");
});
