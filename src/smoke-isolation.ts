/**
 * Isolation test: proves a Luna worker cannot reach `delegate_task`.
 *
 * Model self-reports are useless here — a low-effort model will cheerfully
 * answer "YES, I have that tool" without checking. So this test uses ground
 * truth instead: the orchestrator's own log file. A server started inside a
 * worker inherits SOL_LUNA_WORKER=1 and logs that fact, so its absence is proof
 * that Codex never started this server for the worker. (Asserting the log is
 * entirely empty would be stricter but flaky — any unrelated Codex session on
 * the machine writes startup lines to the same file.)
 *
 * Requires the server to be registered in Codex with
 * `--env SOL_LUNA_LOG=<path>`. Spends a small number of model tokens.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WORKER_MARKER_ENV } from "./config.js";
import { delegateTaskInputSchema } from "./contract.js";
import { delegateToLuna } from "./worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "server.js");
const LOG_PATH = process.env.SOL_LUNA_LOG ?? path.join(here, "..", "orchestrator.log");

const readLog = async (): Promise<string> =>
  fs.readFile(LOG_PATH, "utf8").catch(() => "");

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

/** Guard 2: a server process marked as a worker must advertise no tools. */
async function testEnvBackstop(): Promise<void> {
  console.log(`\n[1] Env backstop (${WORKER_MARKER_ENV}=1)`);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env[WORKER_MARKER_ENV] = "1";

  const client = new Client({ name: "isolation-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env,
      stderr: "pipe",
    }),
  );

  // With no tools registered the server does not even declare the `tools`
  // capability, so `tools/list` is an unimplemented method (-32601). Either
  // "no capability" or "empty list" satisfies isolation.
  const capabilities = client.getServerCapabilities();
  check("a worker-marked server declares no tools capability", () => {
    assert.equal(capabilities?.tools, undefined);
  });

  const toolNames = await client
    .listTools()
    .then(({ tools }) => tools.map((t) => t.name))
    .catch((error: { code?: number }) => {
      if (error.code === -32601) return [] as string[];
      throw error;
    });
  check("a worker-marked server advertises no tools at all", () => {
    assert.deepEqual(toolNames, []);
  });
  await client.close();

  // Control: without the marker the tool must still be there, otherwise the
  // test above would pass for the wrong reason.
  const control = new Client({ name: "isolation-control", version: "1.0.0" });
  await control.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      stderr: "pipe",
    }),
  );
  const { tools: controlTools } = await control.listTools();
  check("control: an unmarked server still advertises delegate_task", () => {
    assert.ok(controlTools.some((t) => t.name === "delegate_task"));
  });
  await control.close();
}

/** Guard 1: Codex must not even spawn this server for a worker's process. */
async function testWorkerCannotStartOrchestrator(): Promise<void> {
  console.log("\n[2] Config isolation (real Luna worker)");
  console.log(`    watching log: ${LOG_PATH}`);

  await fs.rm(LOG_PATH, { force: true });

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "luna-isolation-"));
  await fs.writeFile(path.join(workspace, "NOTES.md"), "# Notes\n", "utf8");

  const task = delegateTaskInputSchema.parse({
    objective:
      "Inspect the tools available to you and append a single line to NOTES.md " +
      "reading exactly 'delegate_task available: yes' or " +
      "'delegate_task available: no', reflecting whether you actually have an " +
      "MCP tool named delegate_task. Do not attempt to call it.",
    effort: "medium",
    effortReason: "Trivial introspection task used to probe worker isolation.",
    allowedFiles: ["NOTES.md"],
    acceptanceCriteria: ["NOTES.md gains exactly one line reporting the answer."],
    workingDirectory: workspace,
    timeoutSeconds: 300,
  });

  const result = await delegateToLuna(task);
  console.log(`    worker thread: ${result.workerThreadId}`);

  const after = await readLog();

  // Look for the signature of a server started *by a worker* rather than for an
  // empty log. Any unrelated Codex session on this machine also writes startup
  // lines here, so "no new lines at all" is only true when nothing else is
  // running — that made this check flaky rather than strict. A server launched
  // inside a worker inherits SOL_LUNA_WORKER=1 and says so, which is specific.
  check("no MCP server was started inside a worker process", () => {
    assert.ok(
      !/SOL_LUNA_WORKER=1 detected/.test(after),
      `a worker started this orchestrator:\n${after}`,
    );
  });

  const notes = await fs
    .readFile(path.join(workspace, "NOTES.md"), "utf8")
    .catch(() => "");
  console.log(`    worker wrote: ${JSON.stringify(notes.trim().split("\n").pop())}`);
  check("worker itself reports it has no delegation tool", () => {
    assert.match(notes, /delegate_task available:\s*no/i);
  });
}

async function main(): Promise<void> {
  await testEnvBackstop();
  await testWorkerCannotStartOrchestrator();

  console.log(
    failures === 0
      ? "\nIsolation verified: workers cannot delegate."
      : `\nIsolation test FAILED (${failures} check(s)).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("\nIsolation test errored:\n", error);
  process.exit(1);
});
