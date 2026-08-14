/**
 * Live parallel delegation test.
 *
 * Runs three real Luna workers at three different efforts, in one batch, in a
 * throwaway git repository. Everything asserted here is read from telemetry or
 * the filesystem — never from a model's description of what it did.
 *
 * Spends model tokens. Run with: npm run smoke:parallel
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The events file is read from the environment when the modules below load, so
// it has to be set before they are imported.
const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-parallel-"));
const eventsPath = path.join(workRoot, "events.jsonl");
process.env.SOL_LUNA_EVENTS = eventsPath;

const { runBatch } = await import("./batch.js");
const { delegateTaskInputSchema } = await import("./contract.js");
const { runGit } = await import("./git.js");

const MODULES = [
  { name: "add", op: "+", effort: "medium" as const, expected: 7 },
  { name: "sub", op: "-", effort: "high" as const, expected: 1 },
  { name: "mul", op: "*", effort: "xhigh" as const, expected: 12 },
];

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${(error as Error).message}`);
  }
};

interface EventRecord {
  timestamp: string;
  type?: string;
  taskId?: string;
  path?: string;
  kept?: boolean;
  effort?: string;
  verdict?: string;
}

async function readEvents(): Promise<EventRecord[]> {
  const raw = await fs.readFile(eventsPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as EventRecord);
}

async function main(): Promise<void> {
  const repo = path.join(workRoot, "repo");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.mkdir(path.join(repo, "test"), { recursive: true });

  for (const module of MODULES) {
    await fs.writeFile(
      path.join(repo, "src", `${module.name}.mjs`),
      `export function ${module.name}(a, b) {\n  throw new Error("not implemented");\n}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(repo, "test", `${module.name}.test.mjs`),
      `import assert from "node:assert/strict";\n` +
        `import test from "node:test";\n` +
        `import { ${module.name} } from "../src/${module.name}.mjs";\n\n` +
        `test("${module.name} computes a ${module.op} b", () => {\n` +
        `  assert.equal(${module.name}(4, 3), ${module.expected});\n` +
        `});\n`,
      "utf8",
    );
  }

  await runGit(["init"], repo);
  await runGit(["config", "user.email", "smoke@example.invalid"], repo);
  await runGit(["config", "user.name", "Smoke Test"], repo);
  await runGit(["config", "commit.gpgsign", "false"], repo);
  await runGit(["add", "."], repo);
  await runGit(["commit", "-m", "fixture"], repo);

  console.log(`Workspace: ${repo}`);
  console.log(`Running 3 parallel workers at medium / high / xhigh...\n`);

  const tasks = MODULES.map((module) =>
    delegateTaskInputSchema.parse({
      objective:
        `Implement the ${module.name} function in src/${module.name}.mjs so that it ` +
        `returns a ${module.op} b. The test in test/${module.name}.test.mjs must pass. ` +
        `Do not modify anything under test/.`,
      effort: module.effort,
      effortReason: `Single arithmetic function; used to exercise ${module.effort} effort.`,
      allowedFiles: [`src/${module.name}.mjs`],
      forbiddenFiles: ["test/**"],
      acceptanceCriteria: [`node --test test/${module.name}.test.mjs exits 0`],
      verificationCommands: [`node --test test/${module.name}.test.mjs`],
      timeoutSeconds: 600,
    }),
  );

  const started = Date.now();
  const batch = await runBatch(tasks, { mode: "parallel", workingDirectory: repo });
  const elapsed = Math.round((Date.now() - started) / 1000);

  console.log(
    `\nBatch ${batch.batchId}: ${batch.passed}/${batch.taskCount} passed in ${elapsed}s\n`,
  );

  const events = await readEvents();

  // --- Every task ran and passed -------------------------------------------
  check("all three workers passed", () => {
    assert.equal(
      batch.passed,
      3,
      JSON.stringify(batch.tasks.map((t) => t.result?.verdict)),
    );
  });

  check("each worker got its own Codex thread", () => {
    const threads = batch.tasks.map((task) => task.result?.workerThreadId);
    assert.equal(new Set(threads).size, 3, `thread ids were ${threads.join(", ")}`);
  });

  // --- Efforts were honoured per task --------------------------------------
  check("each worker ran at the effort it was assigned", () => {
    assert.deepEqual(
      batch.tasks.map((task) => task.result?.effort),
      ["medium", "high", "xhigh"],
    );
  });

  // --- Workers genuinely overlapped in time --------------------------------
  check("at least two workers ran concurrently", () => {
    const windows = new Map<string, { start?: number; end?: number }>();
    for (const event of events) {
      if (!event.taskId) continue;
      const window = windows.get(event.taskId) ?? {};
      if (event.type === "worker.started") window.start = Date.parse(event.timestamp);
      if (event.type === "worker.completed") window.end = Date.parse(event.timestamp);
      windows.set(event.taskId, window);
    }

    const spans = [...windows.values()].filter(
      (window): window is { start: number; end: number } =>
        window.start !== undefined && window.end !== undefined,
    );
    assert.ok(spans.length >= 2, `only ${spans.length} complete worker spans recorded`);

    const overlapping = spans.some((a, i) =>
      spans.some((b, j) => i !== j && a.start < b.end && b.start < a.end),
    );
    assert.ok(overlapping, "no two worker execution windows overlapped in time");
  });

  // --- Isolation: one worktree per task, all cleaned up --------------------
  check("a separate worktree was created for each task", () => {
    const created = events.filter((event) => event.type === "worktree.created");
    assert.equal(created.length, 3);
    assert.equal(new Set(created.map((event) => event.path)).size, 3);
  });

  check("no scope violations were recorded", () => {
    for (const task of batch.tasks) {
      assert.deepEqual(task.result?.scopeViolations ?? [], [], task.taskId);
    }
  });

  check("each worker changed only its own module", () => {
    for (const [index, task] of batch.tasks.entries()) {
      assert.deepEqual(task.changedFiles, [`src/${MODULES[index]!.name}.mjs`]);
    }
  });

  // --- Integration ---------------------------------------------------------
  check("no integration conflicts", () => {
    assert.deepEqual(batch.integrationConflicts, []);
    assert.equal(batch.integrated, true);
  });

  const { execFile } = await import("node:child_process");
  const combined = await new Promise<{ code: number; output: string }>((resolve) => {
    execFile(
      process.execPath,
      ["--test", ...MODULES.map((module) => `test/${module.name}.test.mjs`)],
      { cwd: repo, timeout: 120_000, windowsHide: true },
      (error, stdout, stderr) =>
        resolve({ code: error ? 1 : 0, output: `${stdout}${stderr}`.slice(-1500) }),
    );
  });

  check("all three modules pass together in the real workspace", () => {
    assert.equal(combined.code, 0, `combined run failed:\n${combined.output}`);
  });

  // --- Cleanup -------------------------------------------------------------
  check("worktrees were removed after a successful batch", async () => {
    const removed = events.filter((event) => event.type === "worktree.removed");
    assert.equal(removed.length, 3);
    assert.ok(
      removed.every((event) => event.kept === false),
      "successful worktrees should not be kept",
    );
  });

  const leftovers = await fs
    .readdir(path.join(repo, ".sol-luna", "worktrees"))
    .catch(() => []);
  check("no worktree directories remain on disk", () => {
    assert.deepEqual(leftovers, []);
  });

  const worktreeList = await runGit(["worktree", "list", "--porcelain"], repo);
  check("git has no leftover worktree registrations", () => {
    assert.ok(
      !worktreeList.stdout.includes(".sol-luna"),
      `git still lists our worktrees:\n${worktreeList.stdout}`,
    );
  });

  console.log(
    failures === 0
      ? "\nLive parallel delegation PASSED."
      : `\nLive parallel delegation FAILED (${failures} check(s)).`,
  );

  await fs
    .rm(workRoot, { recursive: true, force: true, maxRetries: 3 })
    .catch(() => undefined);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  console.error("\nLive parallel test errored:\n", error);
  await fs
    .rm(workRoot, { recursive: true, force: true, maxRetries: 3 })
    .catch(() => undefined);
  process.exit(1);
});
