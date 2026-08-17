import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-activity-"));
const eventsPath = path.join(workRoot, "events.jsonl");
process.env.SOL_LUNA_EVENTS = eventsPath;

const { runBatch } = await import("./batch.js");
const { delegateTaskInputSchema } = await import("./contract.js");
const { runGit } = await import("./git.js");
const { activityCommand } = await import("./cli/activity.js");

async function main() {
  const repo = path.join(workRoot, "repo");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await fs.writeFile(
    path.join(repo, "src", "add.js"),
    `export function add(a, b) { throw new Error("no"); }`,
    "utf8",
  );
  await fs.writeFile(
    path.join(repo, "src", "sub.js"),
    `export function sub(a, b) { throw new Error("no"); }`,
    "utf8",
  );

  await runGit(["init"], repo);
  await runGit(["config", "user.email", "smoke@example.invalid"], repo);
  await runGit(["config", "user.name", "Smoke Test"], repo);
  await runGit(["add", "."], repo);
  await runGit(["commit", "-m", "fixture"], repo);

  const tasks = [
    delegateTaskInputSchema.parse({
      objective: "Implement add in src/add.js so it returns a + b",
      effort: "medium",
      effortReason: "tiny E2E test",
      allowedFiles: ["src/add.js"],
      forbiddenFiles: [],
      acceptanceCriteria: ["Tests pass"],
      verificationCommands: [],
      timeoutSeconds: 600,
    }),
    delegateTaskInputSchema.parse({
      objective: "Implement sub in src/sub.js so it returns a - b",
      effort: "medium",
      effortReason: "tiny E2E test",
      allowedFiles: ["src/sub.js"],
      forbiddenFiles: [],
      acceptanceCriteria: ["Tests pass"],
      verificationCommands: [],
      timeoutSeconds: 600,
    }),
  ];

  console.log("Starting batch...");

  // Start the batch without awaiting it immediately
  const batchPromise = runBatch(tasks, { mode: "parallel", workingDirectory: repo });

  // Wait a few seconds to let workers start, then read activity
  await new Promise((r) => setTimeout(r, 5000));

  console.log("\n--- Checking activity during run (JSON) ---");
  const origLog = console.log;
  let jsonOutput = "";
  const originalStdoutWrite = process.stdout.write;
  try {
    process.stdout.write = ((
      chunk: string | Uint8Array,
      encoding?: unknown,
      cb?: unknown,
    ) => {
      jsonOutput += chunk.toString();
      if (typeof encoding === "function") encoding();
      else if (typeof cb === "function") cb();
      return true;
    }) as any;

    await activityCommand(["--json"]);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const parsed = JSON.parse(jsonOutput);
  origLog("Activity batch ID:", parsed.batchId);
  origLog("Activity state:", parsed.state);
  origLog("Activity workers:", parsed.workers.length);

  assert.equal(parsed.workers.length, 2, "Expected 2 workers in activity");

  // Wait for batch to finish
  console.log("\nWaiting for batch to finish...");
  const batch = await batchPromise;
  console.log(`Batch passed: ${batch.passed}/${batch.taskCount}`);

  console.log("\n--- Checking activity after run (Human) ---");
  await activityCommand([]);

  await fs.rm(workRoot, { recursive: true, force: true });
}

main().catch(async (e) => {
  console.error("Failed:", e);
  await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
