/**
 * Live end-to-end test: delegates a real (tiny) task to a real Luna worker in a
 * throwaway directory, then checks that the orchestrator's independent
 * verification, scope enforcement and structured reporting all behaved.
 *
 * This DOES spend model tokens. Run with: npm run smoke:live
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { delegateTaskInputSchema } from "./contract.js";
import { delegateToLuna } from "./worker.js";

const TEST_FILE = `import assert from "node:assert/strict";
import { slugify } from "./slugify.mjs";

assert.equal(slugify("Hello World!"), "hello-world");
assert.equal(slugify("  Multiple   Spaces  "), "multiple-spaces");
assert.equal(slugify("Already-Slugged"), "already-slugged");
console.log("all slugify tests passed");
`;

async function main(): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "luna-smoke-"));
  console.log(`Workspace: ${workspace}\n`);

  await fs.writeFile(path.join(workspace, "test.mjs"), TEST_FILE, "utf8");

  const task = delegateTaskInputSchema.parse({
    objective:
      "Create slugify.mjs exporting a named function `slugify(input: string): string` " +
      "that lowercases the input, trims it, replaces any run of non-alphanumeric " +
      "characters with a single hyphen, and strips leading/trailing hyphens. " +
      "The existing test.mjs must pass unchanged.",
    effort: "medium",
    effortReason:
      "Small, fully specified pure function with tests already written — mechanical work.",
    allowedFiles: ["slugify.mjs"],
    forbiddenFiles: ["test.mjs"],
    acceptanceCriteria: [
      "slugify.mjs exists and exports a named function `slugify`.",
      "`node test.mjs` exits 0 with all assertions passing.",
      "test.mjs is not modified.",
    ],
    verificationCommands: ["node test.mjs"],
    workingDirectory: workspace,
    timeoutSeconds: 600,
  });

  console.log(`Delegating at effort=${task.effort}…\n`);
  const started = Date.now();
  const result = await delegateToLuna(task);

  console.log(JSON.stringify(result, null, 2));
  console.log(`\n--- checks (${Math.round((Date.now() - started) / 1000)}s) ---`);

  const checks: Array<[string, () => void]> = [
    [
      "a worker thread id was captured",
      () => assert.ok(result.workerThreadId, "no thread id"),
    ],
    [
      "worker ran as gpt-5.6-luna at the requested effort",
      () => {
        assert.match(result.model, /luna/);
        assert.equal(result.effort, "medium");
      },
    ],
    ["verdict is PASS", () => assert.equal(result.verdict, "PASS")],
    [
      "orchestrator independently re-ran the verification command",
      () => {
        const own = result.verification.filter((v) => v.source === "orchestrator");
        assert.equal(own.length, 1, "expected one orchestrator-run command");
        assert.equal(own[0]?.passed, true);
        assert.equal(own[0]?.exitCode, 0);
      },
    ],
    [
      "slugify.mjs was recorded as changed by the runtime",
      () => {
        const file = result.filesChanged.find((f) => f.path === "slugify.mjs");
        assert.ok(file, `slugify.mjs not in ${JSON.stringify(result.filesChanged)}`);
        assert.equal(file.observed, true, "edit was claimed but not observed");
      },
    ],
    ["no scope violations", () => assert.deepEqual(result.scopeViolations, [])],
    ["no discrepancies", () => assert.deepEqual(result.discrepancies, [])],
    ["result is marked trustworthy", () => assert.equal(result.trustworthy, true)],
    [
      "a review checklist was produced for Sol",
      () => assert.ok(result.reviewChecklist.length > 0),
    ],
    ["token usage was reported", () => assert.ok(result.usage)],
  ];

  let failures = 0;
  for (const [label, fn] of checks) {
    try {
      fn();
      console.log(`  ok   ${label}`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL ${label}: ${(error as Error).message}`);
    }
  }

  // Ground truth, independent of anything the worker or orchestrator reported.
  const onDisk = await fs
    .readFile(path.join(workspace, "slugify.mjs"), "utf8")
    .catch(() => null);
  if (onDisk) {
    console.log(`  ok   slugify.mjs really exists on disk (${onDisk.length} bytes)`);
  } else {
    failures += 1;
    console.log("  FAIL slugify.mjs does not exist on disk");
  }

  const testUnchanged =
    (await fs.readFile(path.join(workspace, "test.mjs"), "utf8")) === TEST_FILE;
  console.log(
    testUnchanged
      ? "  ok   forbidden file test.mjs was left untouched"
      : "  FAIL test.mjs was modified",
  );
  if (!testUnchanged) failures += 1;

  console.log(
    failures === 0
      ? "\nLive delegation smoke test PASSED."
      : `\nLive delegation smoke test FAILED (${failures} check(s)).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("\nLive smoke test errored:\n", error);
  process.exit(1);
});
