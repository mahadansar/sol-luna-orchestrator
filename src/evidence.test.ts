import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  compactBatch,
  compactResult,
  recordEvent,
  renderBatch,
  renderResult,
} from "./server.js";
import {
  delegateTaskInputSchema,
  delegateTasksInputSchema,
  type DelegateTaskOutput,
  type BatchOutput,
} from "./contract.js";
import { MAX_OUTPUT_CHARS } from "./config.js";
import { truncate } from "./verify.js";

function mockResult(): DelegateTaskOutput {
  return {
    changeIntent: "optional",
    verdict: "PASS",
    workerClaimedStatus: "PASS",
    trustworthy: true,
    workerThreadId: "thread_123",
    continuationReference: "ctr_fixture_reference_12345678901234567890",
    model: "gpt-5.6-luna",
    effort: "high",
    effortReason: "simple",
    attempt: 1,
    summary: "Did the thing",
    notes: "",
    followUps: [],
    filesChanged: [
      { path: "src/file.ts", kind: "modified", why: "needed change", observed: true },
    ],
    verification: [
      {
        command: "npm test",
        source: "orchestrator",
        execution: "argv",
        exitCode: 0,
        passed: true,
        output: "Tests passed: 10/10\nSuccess.",
      },
    ],
    verificationMode: "allowlist",
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: [],
    escalationAdvice: null,
    durationSeconds: 10,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      reasoningOutputTokens: 10,
    },
    errors: [],
  };
}

test("evidence packet - legacy/full result compatibility", () => {
  const result = mockResult();
  const text = renderResult(result);
  assert.ok(text.includes("needed change"), "the text block keeps each file's why");
  assert.ok(text.includes("WORKER SUMMARY (claim)"), "should label summary as claim");
  // renderResult has never printed the output of a command that passed. The
  // compaction that matters happens in structuredContent, and is proved below
  // against every model-visible surface at once.
});

test("evidence packet - normal PASS", () => {
  const result = mockResult();
  const text = renderResult(result);
  assert.ok(text.includes("VERDICT: PASS"));
  assert.ok(text.includes("CHANGE INTENT: optional"));
});

test("evidence packet - forbidden intent and contract violation are rendered", () => {
  const result = mockResult();
  result.changeIntent = "forbidden";
  result.verdict = "FAILED";
  result.trustworthy = false;
  result.discrepancies.push(
    "Change intent contract violated: intent is forbidden, but the runtime observed edits in src/file.ts.",
  );
  const text = renderResult(result);
  assert.ok(text.includes("CHANGE INTENT: forbidden"));
  assert.ok(text.includes("Change intent contract violated"));
});

test("evidence packet - worker FAIL", () => {
  const result = mockResult();
  result.verdict = "FAILED";
  result.workerClaimedStatus = "FAILED";
  const text = renderResult(result);
  assert.ok(text.includes("VERDICT: FAILED"));
});

test("evidence packet - malformed worker result", () => {
  const result = mockResult();
  result.errors.push("Malformed JSON from worker");
  result.verdict = "FAILED";
  const text = renderResult(result);
  assert.ok(text.includes("Malformed JSON from worker"));
});

test("evidence packet - verification failure", () => {
  const result = mockResult();
  if (result.verification[0]) {
    result.verification[0].passed = false;
    result.verification[0].output = "Failed 1 test";
  }
  const text = renderResult(result);
  assert.ok(text.includes("Failed 1 test"));
});

test("evidence packet - bounded repair decision and exact failure excerpt", () => {
  const result = mockResult();
  result.repair = {
    requested: true,
    attempted: true,
    classification: "local-verification",
    reason: "The one automatic repair turn completed.",
    failureEvidence: [
      {
        command: "npm test",
        execution: "argv",
        exitCode: 1,
        output: "exact failing assertion",
      },
    ],
  };
  const text = renderResult(result);
  assert.match(text, /REPAIR: attempted.*local-verification/);
  assert.match(text, /npm test/);
  assert.match(text, /exact failing assertion/);
});

test("evidence packet - verification refusal", () => {
  const result = mockResult();
  if (result.verification[0]) {
    result.verification[0].execution = "rejected";
  }
  const text = renderResult(result);
  assert.ok(text.includes("REFUSED"));
});

test("evidence packet - scope violation", () => {
  const result = mockResult();
  result.scopeViolations.push("src/forbidden.ts touched");
  const text = renderResult(result);
  assert.ok(text.includes("SCOPE VIOLATIONS"));
  assert.ok(text.includes("src/forbidden.ts"));
});

test("evidence packet - claimed/observed file discrepancy", () => {
  const result = mockResult();
  if (result.filesChanged[0]) {
    result.filesChanged[0].observed = false;
  }
  const text = renderResult(result);
  assert.ok(text.includes("CLAIMED ONLY"));
});

test("evidence packet - no changed files", () => {
  const result = mockResult();
  result.filesChanged = [];
  const text = renderResult(result);
  assert.ok(text.includes("(none recorded)"));
});

test("evidence packet - missing telemetry", () => {
  const result = mockResult();
  result.usage = null;
  const text = renderResult(result);
  assert.ok(!text.includes("tokens:"));
});

test("evidence packet - parallel/batch per-task result", () => {
  const batch: BatchOutput = {
    batchId: "b1",
    mode: "parallel",
    maxParallel: 2,
    taskCount: 1,
    passed: 1,
    failed: 0,
    durationSeconds: 15,
    tasks: [
      {
        taskId: "t1",
        state: "completed",
        objective: "do it",
        effort: "high",
        effortReason: "yep",
        result: mockResult(),
        changedFiles: ["src/file.ts"],
        worktreePath: null,
        error: null,
        warnings: [],
      },
    ],
    scopeConflicts: [],
    integrationConflicts: [],
    integrated: true,
    integrationSummary: "all merged",
    warnings: [],
    reviewChecklist: [],
  };
  const text = renderBatch(batch);
  assert.ok(text.includes("worker summary (claim)"));
  assert.ok(text.includes("change intent: optional"));
});

test("evidence packet - integration conflict", () => {
  const batch: BatchOutput = {
    batchId: "b1",
    mode: "parallel",
    maxParallel: 2,
    taskCount: 2,
    passed: 2,
    failed: 0,
    durationSeconds: 15,
    tasks: [],
    scopeConflicts: [],
    integrationConflicts: [{ path: "src/file.ts", tasks: ["t1", "t2"] }],
    integrated: false,
    integrationSummary: "collided",
    warnings: [],
    reviewChecklist: [],
  };
  const text = renderBatch(batch);
  assert.ok(text.includes("INTEGRATION CONFLICTS"));
});

// --- The actual compaction ---------------------------------------------------
//
// Compact mode exists to keep the stdout of routine passing commands out of the
// model's context. A tool result reaches the model through two surfaces, the
// text `content` block and `structuredContent`, so removing it from one and
// leaving it in the other would achieve nothing. These tests assert against
// both at once, the way the handler assembles them.

/** Every model-visible representation of a task result, as one string. */
const taskSurfaces = (result: DelegateTaskOutput, detail: "full" | "compact"): string => {
  const structured = detail === "compact" ? compactResult(result) : result;
  return [renderResult(result), JSON.stringify(structured)].join("\n");
};

const PASSING_STDOUT = "Tests passed: 10/10";

test("full mode keeps the stdout of a command that passed", () => {
  assert.ok(
    taskSurfaces(mockResult(), "full").includes(PASSING_STDOUT),
    "the default must stay backward compatible",
  );
});

test("compact mode removes passing stdout from every model-visible surface", () => {
  const surfaces = taskSurfaces(mockResult(), "compact");
  assert.ok(
    !surfaces.includes(PASSING_STDOUT),
    "passing stdout leaked into the text block or structuredContent",
  );
  assert.ok(!surfaces.includes("Success."), "the rest of that output leaked too");
});

test("compact mode does not substitute a placeholder for removed output", () => {
  const compacted = compactResult(mockResult());
  assert.equal(compacted.verification[0]?.output, "");
  assert.ok(
    !JSON.stringify(compacted).includes("omitted"),
    "an empty string is the smallest truthful representation; do not narrate it",
  );
});

test("compact mode keeps the output of a command that failed", () => {
  const result = mockResult();
  result.verification[0]!.passed = false;
  result.verification[0]!.exitCode = 1;
  result.verification[0]!.output = "AssertionError: expected 3 got 4";
  const surfaces = taskSurfaces(result, "compact");
  assert.ok(
    surfaces.includes("AssertionError: expected 3 got 4"),
    "failure evidence is the whole point of the packet",
  );
});

test("compact mode keeps the output of a refused command", () => {
  const result = mockResult();
  result.verification[0]!.passed = false;
  result.verification[0]!.execution = "rejected";
  result.verification[0]!.output = "Command refused by verification policy";
  assert.ok(taskSurfaces(result, "compact").includes("refused by verification policy"));
});

test("compact mode changes nothing except passing output", () => {
  const result = mockResult();
  const compacted = compactResult(result);
  assert.deepEqual(
    { ...compacted, verification: null },
    { ...result, verification: null },
    "no field outside verification may differ",
  );
  assert.equal(compacted.verification.length, result.verification.length);
  const [before] = result.verification;
  const [after] = compacted.verification;
  assert.deepEqual(
    { ...after, output: null },
    { ...before, output: null },
    "only the output field may differ",
  );
});

test("compact mode leaves the original result object untouched", () => {
  const result = mockResult();
  const originalOutput = mockResult().verification[0]?.output;
  compactResult(result);
  assert.equal(
    result.verification[0]?.output,
    originalOutput,
    "compaction must not mutate what the caller still holds",
  );
});

test("compacting a batch removes passing stdout from every task", () => {
  const task = mockResult();
  const batch: BatchOutput = {
    batchId: "b1",
    mode: "parallel",
    maxParallel: 2,
    taskCount: 1,
    passed: 1,
    failed: 0,
    durationSeconds: 12,
    tasks: [
      {
        taskId: "t1",
        state: "completed",
        objective: "do the thing",
        effort: "high",
        effortReason: "because",
        result: task,
        changedFiles: ["src/file.ts"],
        worktreePath: null,
        error: null,
        warnings: [],
      },
    ],
    scopeConflicts: [],
    integrationConflicts: [],
    integrated: true,
    integrationSummary: "copied 1 file",
    warnings: [],
    reviewChecklist: [],
  };

  const surfaces = [renderBatch(batch), JSON.stringify(compactBatch(batch))].join("\n");
  assert.ok(!surfaces.includes(PASSING_STDOUT), "batch compaction missed a task");
  assert.ok(
    JSON.stringify(batch).includes(PASSING_STDOUT),
    "the input batch must not be mutated",
  );
});

test("compacting a batch tolerates a task with no result", () => {
  const batch: BatchOutput = {
    batchId: "b2",
    mode: "sequential",
    maxParallel: 1,
    taskCount: 1,
    passed: 0,
    failed: 1,
    durationSeconds: 3,
    tasks: [
      {
        taskId: "t1",
        state: "failed",
        objective: "never ran",
        effort: "high",
        effortReason: "because",
        result: null,
        changedFiles: [],
        worktreePath: null,
        error: "Could not create an isolated worktree",
        warnings: [],
      },
    ],
    scopeConflicts: [],
    integrationConflicts: [],
    integrated: false,
    integrationSummary: "nothing to integrate",
    warnings: [],
    reviewChecklist: [],
  };
  const compacted = compactBatch(batch);
  assert.equal(compacted.tasks[0]?.result, null);
  assert.ok(
    JSON.stringify(compacted).includes("Could not create an isolated worktree"),
    "a task that failed before running keeps its error",
  );
});

test("importing the server module does not start the stdio server", async () => {
  // `server.ts` exports the pure render and compaction helpers these tests use,
  // but it is also the MCP entry point. Without a guard around `main()`, merely
  // importing it connects the stdio transport, stdin stays open and the process
  // never exits, which hangs the whole suite rather than failing it.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(
    process.execPath,
    ["-e", `import(${JSON.stringify(pathToFileURL(path.join(here, "server.js")).href)})`],
    {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    },
  );

  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 15_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  assert.ok(exited, "importing server.js hung: the entry-point guard is missing");
});

test("single-task delegation records its result exactly once with the existing shape", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-single-event-"));
  const eventsPath = path.join(workRoot, "events.jsonl");

  try {
    recordEvent(mockResult(), eventsPath);

    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(event).sort(), [
      "attempt",
      "discrepancies",
      "durationSeconds",
      "effort",
      "filesChanged",
      "model",
      "scopeViolations",
      "timestamp",
      "trustworthy",
      "usage",
      "verdict",
      "workerClaimedStatus",
      "workerThreadId",
    ]);
    assert.equal(event.workerThreadId, "thread_123");
    assert.equal(event.verdict, "PASS");
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test("legacy activity records expose repair classification without failure output", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-repair-event-"));
  const eventsPath = path.join(workRoot, "events.jsonl");
  try {
    const result = mockResult();
    result.repair = {
      requested: true,
      attempted: true,
      classification: "local-verification",
      reason: "completed",
      failureEvidence: [
        {
          command: "npm test",
          execution: "argv",
          exitCode: 1,
          output: "PRIVATE_FAILURE_OUTPUT",
        },
      ],
    };
    recordEvent(result, eventsPath);
    const raw = await fs.readFile(eventsPath, "utf8");
    assert.doesNotMatch(raw, /PRIVATE_FAILURE_OUTPUT|npm test/);
    const event = JSON.parse(raw) as {
      repair?: { attempted?: boolean; classification?: string };
    };
    assert.deepEqual(event.repair, {
      attempted: true,
      classification: "local-verification",
    });
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

// --- resultDetail contract ---------------------------------------------------

const BASE_TASK = {
  objective: "Just an objective 1234567890",
  acceptanceCriteria: ["done"],
  effortReason: "simple task because it is short",
};

test("resultDetail defaults to full when the caller omits it", () => {
  assert.equal(delegateTaskInputSchema.parse(BASE_TASK).resultDetail, "full");
});

test("resultDetail accepts both documented values", () => {
  for (const value of ["full", "compact"] as const) {
    assert.equal(
      delegateTaskInputSchema.parse({ ...BASE_TASK, resultDetail: value }).resultDetail,
      value,
    );
  }
});

test("an unrecognised resultDetail is rejected rather than silently ignored", () => {
  assert.throws(
    () => delegateTaskInputSchema.parse({ ...BASE_TASK, resultDetail: "terse" }),
    (error: unknown) => {
      assert.equal((error as Error).name, "ZodError");
      return true;
    },
  );
});

test("a batch carries resultDetail once, not per task", () => {
  const batch = delegateTasksInputSchema.parse({
    mode: "parallel",
    tasks: [BASE_TASK, BASE_TASK],
  });
  assert.equal(batch.resultDetail, "full");
  // Per-task detail would let one batch return two different shapes. The batch
  // task shape deliberately leaves the field out, so Zod strips it.
  const mixed = delegateTasksInputSchema.parse({
    mode: "parallel",
    tasks: [{ ...BASE_TASK, resultDetail: "compact" }],
    resultDetail: "compact",
  });
  assert.ok(!("resultDetail" in (mixed.tasks[0] ?? {})));
});

test("a one-task batch remains accepted for compatibility", () => {
  const single = delegateTasksInputSchema.parse({
    mode: "sequential",
    tasks: [BASE_TASK],
  });
  assert.equal(single.tasks.length, 1);
  assert.throws(() => delegateTasksInputSchema.parse({ mode: "sequential", tasks: [] }));
});

// --- Compact against the awkward cases ---------------------------------------

test("compact clears every passing command, not just the first", () => {
  const result = mockResult();
  result.verification = [
    { ...result.verification[0]!, command: "npm run build", output: "BUILD_STDOUT" },
    { ...result.verification[0]!, command: "npm test", output: "TEST_STDOUT" },
    { ...result.verification[0]!, command: "npm run lint", output: "LINT_STDOUT" },
  ];
  const surfaces = taskSurfaces(result, "compact");
  for (const sentinel of ["BUILD_STDOUT", "TEST_STDOUT", "LINT_STDOUT"]) {
    assert.ok(!surfaces.includes(sentinel), `${sentinel} survived compaction`);
  }
});

test("compact keeps failing output while clearing passing output beside it", () => {
  const result = mockResult();
  result.verification = [
    {
      ...result.verification[0]!,
      command: "npm run build",
      output: "BUILD_PASSED_NOISE",
    },
    {
      ...result.verification[0]!,
      command: "npm test",
      passed: false,
      exitCode: 1,
      output: "AssertionError: expected 3 got 4",
    },
  ];
  const surfaces = taskSurfaces(result, "compact");
  assert.ok(!surfaces.includes("BUILD_PASSED_NOISE"), "passing noise survived");
  assert.ok(
    surfaces.includes("AssertionError: expected 3 got 4"),
    "failure evidence lost",
  );
});

test("compact keeps the explanation of a command that was never run", () => {
  // Verification disabled, or a command the policy refused: `passed` is false,
  // so the orchestrator's explanation of why nothing was proved is retained.
  const result = mockResult();
  result.verification[0]!.passed = false;
  result.verification[0]!.execution = "skipped";
  result.verification[0]!.exitCode = null;
  result.verification[0]!.output =
    "[orchestrator] Independent verification is disabled (SOL_LUNA_VERIFY_MODE=off).";
  assert.ok(taskSurfaces(result, "compact").includes("verification is disabled"));
});

test("failing output reaches compact already bounded by capture-time truncation", () => {
  // Compact imposes no size limit of its own, and deliberately so: shrinking
  // failure evidence is the opposite of the point. The bound comes earlier,
  // when `verify.ts` captures the output, and applies in full mode too.
  const enormous = "x".repeat(MAX_OUTPUT_CHARS * 20);
  const asCaptured = truncate(enormous);
  assert.ok(
    asCaptured.length < MAX_OUTPUT_CHARS + 200,
    "capture-time truncation is what bounds a chatty failing command",
  );

  const result = mockResult();
  result.verification[0]!.passed = false;
  result.verification[0]!.exitCode = 1;
  result.verification[0]!.output = asCaptured;
  assert.equal(
    compactResult(result).verification[0]?.output,
    asCaptured,
    "compact must pass bounded failure output through unchanged",
  );
});

// --- filesChanged[].why ------------------------------------------------------

test("compact keeps filesChanged[].why on both model-visible surfaces", () => {
  // `why` is a worker claim, but it is short next to command output and it is
  // the only carrier of the runtime's own note about a file the worker never
  // mentioned. Compact removes exactly one thing, and this is not it.
  const result = mockResult();
  const surfaces = taskSurfaces(result, "compact");
  assert.ok(surfaces.includes("needed change"), "why was dropped from compact");
  assert.ok(renderResult(result).includes("needed change"), "why left the text block");
});

test("compact keeps the marker for a file the worker never claimed", () => {
  const result = mockResult();
  result.filesChanged = [
    {
      path: "src/surprise.ts",
      kind: "modified",
      why: "(not mentioned in the worker's report)",
      observed: true,
    },
  ];
  assert.ok(
    taskSurfaces(result, "compact").includes("not mentioned in the worker's report"),
    "an unclaimed but observed edit must stay visible in compact",
  );
});

test("compact keys off passed, so a worker's mis-claimed row is cleared too", () => {
  // Observed live: a worker reported `passed: true` on a command that exits 1.
  // Compact clears that row's output because the row says it passed, and that
  // is the right call. The row is the worker's own claimed evidence for a
  // command the orchestrator re-ran itself, so the authoritative row beside it
  // keeps the real output, and the discrepancy list names the contradiction.
  const result = mockResult();
  result.verification = [
    {
      command: "node check.mjs",
      source: "orchestrator",
      execution: "argv",
      exitCode: 1,
      passed: false,
      output: "REAL_FAILURE_OUTPUT",
    },
    {
      command: "node check.mjs",
      source: "worker",
      execution: "reported",
      exitCode: 1,
      passed: true,
      output: "WORKER_CLAIMED_EVIDENCE",
    },
  ];
  result.discrepancies = ["Worker reported `node check.mjs` as passing, but it exits 1."];

  const surfaces = taskSurfaces(result, "compact");
  assert.ok(surfaces.includes("REAL_FAILURE_OUTPUT"), "authoritative evidence was lost");
  assert.ok(!surfaces.includes("WORKER_CLAIMED_EVIDENCE"), "compact keys off passed");
  assert.ok(surfaces.includes("but it exits 1"), "the contradiction stays visible");
});

test("the text block is identical whichever detail the caller asked for", () => {
  // `resultDetail` is a structuredContent lever only. Rendering the full result
  // and the compacted one has to produce the same string, which is the same
  // thing as saying the text block never carried passing output to begin with.
  const result = mockResult();
  assert.equal(
    renderResult(result),
    renderResult(compactResult(result)),
    "compaction changed the text block, so the two surfaces disagree",
  );
});
