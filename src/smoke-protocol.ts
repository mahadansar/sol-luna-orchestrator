/**
 * Protocol smoke test: launches the built server exactly the way Codex will
 * (stdio subprocess), performs a real MCP handshake, and inspects the advertised
 * tool. Makes no model calls, so it is free and safe to run repeatedly.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Overridable so the same protocol checks can be pointed at a packed install
// rather than the source tree — proving what an npm user actually receives.
const serverEntry = process.env.SOL_LUNA_SMOKE_SERVER
  ? path.resolve(process.env.SOL_LUNA_SMOKE_SERVER)
  : path.join(here, "server.js");

const check = (label: string, fn: () => void): void => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    console.log(`  FAIL ${label}`);
    throw error;
  }
};

async function main(): Promise<void> {
  console.log(`Launching MCP server: node ${serverEntry}\n`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke-test", version: "1.0.0" });

  await client.connect(transport);
  console.log("Handshake complete.\n");

  const info = client.getServerVersion();
  check("server identifies as sol-luna-orchestrator", () => {
    assert.equal(info?.name, "sol-luna-orchestrator");
  });

  check("server sends supervisor instructions", () => {
    assert.match(client.getInstructions() ?? "", /delegate_task/);
  });

  const { tools } = await client.listTools();
  console.log(`\nTools advertised: ${tools.map((t) => t.name).join(", ")}\n`);

  const tool = tools.find((t) => t.name === "delegate_task");
  check("delegate_task is advertised", () => assert.ok(tool));

  const batchTool = tools.find((t) => t.name === "delegate_tasks");
  check("delegate_tasks is advertised", () => assert.ok(batchTool));

  check("delegate_tasks accepts a mode and a task list", () => {
    const properties = (batchTool?.inputSchema?.properties ?? {}) as Record<
      string,
      unknown
    >;
    assert.ok("mode" in properties);
    assert.ok("tasks" in properties);
    const mode = properties.mode as { enum?: string[] };
    assert.deepEqual(mode.enum, ["parallel", "sequential"]);
  });

  check("delegate_tasks reports conflicts and integration state", () => {
    const out = (batchTool?.outputSchema?.properties ?? {}) as Record<string, unknown>;
    for (const field of [
      "tasks",
      "scopeConflicts",
      "integrationConflicts",
      "integrated",
      "reviewChecklist",
    ]) {
      assert.ok(field in out, `missing batch output field: ${field}`);
    }
  });

  check("the batch description tells Sol when parallel is inappropriate", () => {
    assert.match(batchTool?.description ?? "", /DISJOINT/);
    assert.match(batchTool?.description ?? "", /sequential/);
  });

  const properties = (tool?.inputSchema?.properties ?? {}) as Record<string, unknown>;
  const required = (tool?.inputSchema?.required ?? []) as string[];

  check("input schema carries the full task contract", () => {
    for (const field of [
      "objective",
      "effort",
      "effortReason",
      "allowedFiles",
      "forbiddenFiles",
      "acceptanceCriteria",
      "verificationCommands",
    ]) {
      assert.ok(field in properties, `missing contract field: ${field}`);
    }
  });

  check("objective, effortReason and acceptanceCriteria are required", () => {
    for (const field of ["objective", "effortReason", "acceptanceCriteria"]) {
      assert.ok(required.includes(field), `${field} should be required`);
    }
  });

  check("effort offers exactly medium|high|xhigh|max", () => {
    const effort = properties.effort as { enum?: string[]; default?: string };
    assert.deepEqual(effort.enum, ["medium", "high", "xhigh", "max"]);
  });

  check("effort defaults to high", () => {
    const effort = properties.effort as { default?: string };
    assert.equal(effort.default, "high");
  });

  check("description tells Sol when to pick max", () => {
    assert.match(tool?.description ?? "", /max\s+Genuinely hard problems only/);
    assert.match(tool?.description ?? "", /importance is not difficulty/);
  });

  check("input schema carries escalation metadata", () => {
    for (const field of ["taskCategory", "previousAttempts"]) {
      assert.ok(field in properties, `missing metadata field: ${field}`);
    }
  });

  check("description warns that verification runs without a shell", () => {
    assert.match(tool?.description ?? "", /without a shell/);
  });

  check("output schema exposes verdict and review fields", () => {
    const out = (tool?.outputSchema?.properties ?? {}) as Record<string, unknown>;
    for (const field of [
      "verdict",
      "workerClaimedStatus",
      "workerThreadId",
      "filesChanged",
      "verification",
      "verificationMode",
      "discrepancies",
      "reviewChecklist",
      "escalationAdvice",
      "attempt",
    ]) {
      assert.ok(field in out, `missing output field: ${field}`);
    }
  });

  // Exercise the call path without spending a model call: invalid input must be
  // rejected by the server's own schema validation.
  const invalid = await client.callTool({
    name: "delegate_task",
    arguments: { objective: "too short", effortReason: "x", acceptanceCriteria: [] },
  });
  check("invalid task contracts are rejected", () => {
    assert.equal(invalid.isError, true);
  });

  await client.close();
  console.log("\nAll protocol checks passed.");
}

main().catch((error: unknown) => {
  console.error("\nProtocol smoke test failed:\n", error);
  process.exit(1);
});
