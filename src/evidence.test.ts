import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { compactBatch, compactResult, renderBatch, renderResult } from "./server.js";
import { type DelegateTaskOutput, type BatchOutput } from "./contract.js";

function mockResult(): DelegateTaskOutput {
  return {
    verdict: "PASS",
    workerClaimedStatus: "PASS",
    trustworthy: true,
    workerThreadId: "thread_123",
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
  const text = renderResult(result, "full");
  assert.ok(text.includes("needed change"), "full mode keeps each file's why");
  // renderResult has never printed the output of a command that passed, in
  // either mode. The compaction that matters happens in structuredContent, and
  // is proved below against every model-visible surface at once.
});

test("evidence packet - compact mode omits large detail", () => {
  const result = mockResult();
  const text = renderResult(result, "compact");
  assert.ok(!text.includes("needed change"), "should omit 'why' for files");
  assert.ok(text.includes("WORKER SUMMARY (claim)"), "should label summary as claim");
});

test("evidence packet - normal PASS", () => {
  const result = mockResult();
  const text = renderResult(result, "compact");
  assert.ok(text.includes("VERDICT: PASS"));
});

test("evidence packet - worker FAIL", () => {
  const result = mockResult();
  result.verdict = "FAILED";
  result.workerClaimedStatus = "FAILED";
  const text = renderResult(result, "compact");
  assert.ok(text.includes("VERDICT: FAILED"));
});

test("evidence packet - malformed worker result", () => {
  const result = mockResult();
  result.errors.push("Malformed JSON from worker");
  result.verdict = "FAILED";
  const text = renderResult(result, "compact");
  assert.ok(text.includes("Malformed JSON from worker"));
});

test("evidence packet - verification failure", () => {
  const result = mockResult();
  if (result.verification[0]) {
    result.verification[0].passed = false;
    result.verification[0].output = "Failed 1 test";
  }
  const text = renderResult(result, "compact");
  assert.ok(text.includes("Failed 1 test"));
});

test("evidence packet - verification refusal", () => {
  const result = mockResult();
  if (result.verification[0]) {
    result.verification[0].execution = "rejected";
  }
  const text = renderResult(result, "compact");
  assert.ok(text.includes("REFUSED"));
});

test("evidence packet - scope violation", () => {
  const result = mockResult();
  result.scopeViolations.push("src/forbidden.ts touched");
  const text = renderResult(result, "compact");
  assert.ok(text.includes("SCOPE VIOLATIONS"));
  assert.ok(text.includes("src/forbidden.ts"));
});

test("evidence packet - claimed/observed file discrepancy", () => {
  const result = mockResult();
  if (result.filesChanged[0]) {
    result.filesChanged[0].observed = false;
  }
  const text = renderResult(result, "compact");
  assert.ok(text.includes("CLAIMED ONLY"));
});

test("evidence packet - no changed files", () => {
  const result = mockResult();
  result.filesChanged = [];
  const text = renderResult(result, "compact");
  assert.ok(text.includes("(none recorded)"));
});

test("evidence packet - missing telemetry", () => {
  const result = mockResult();
  result.usage = null;
  const text = renderResult(result, "compact");
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
  return [renderResult(result, detail), JSON.stringify(structured)].join("\n");
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
