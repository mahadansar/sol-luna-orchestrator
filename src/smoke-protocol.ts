/**
 * Protocol smoke test: launches the built server exactly the way Codex will
 * (stdio subprocess), performs a real MCP handshake, and inspects the advertised
 * tool. Makes no model calls, so it is free and safe to run repeatedly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageVersion = (
  JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

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

  const telemetryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-protocol-"));
  const eventsPath = path.join(telemetryRoot, "events.jsonl");
  const logPath = path.join(telemetryRoot, "orchestrator.log");
  const cleanupTelemetry = (): void =>
    fs.rmSync(telemetryRoot, { recursive: true, force: true });
  process.once("exit", cleanupTelemetry);
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  childEnv.SOL_LUNA_EVENTS = eventsPath;
  childEnv.SOL_LUNA_LOG = logPath;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    stderr: "pipe",
    env: childEnv,
  });
  const client = new Client({ name: "smoke-test", version: "1.0.0" });

  await client.connect(transport);
  console.log("Handshake complete.\n");

  const info = client.getServerVersion();
  check("server identifies as sol-luna-orchestrator", () => {
    assert.equal(info?.name, "sol-luna-orchestrator");
  });

  check("server advertises the package implementation version", () => {
    assert.equal(info?.version, packageVersion);
  });

  check("server sends supervisor instructions", () => {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /compatible parent Codex model/);
    assert.match(instructions, /Sol-Luna Orchestrator/);
    assert.match(instructions, /runtime evidence outranks worker claims/i);
    assert.match(instructions, /VERIFIED_COMPLETE[\s\S]*without rereading/i);
    assert.match(instructions, /has no meaningful new state, remain silent/i);
    assert.match(instructions, /result, error, cancellation, timeout/i);
  });

  const { tools } = await client.listTools();
  console.log(`\nTools advertised: ${tools.map((t) => t.name).join(", ")}\n`);

  const tool = tools.find((t) => t.name === "delegate_task");
  check("delegate_task is advertised", () => assert.ok(tool));

  const batchTool = tools.find((t) => t.name === "delegate_tasks");
  check("delegate_tasks is advertised", () => assert.ok(batchTool));

  const continueTool = tools.find((t) => t.name === "continue_task");
  check("continue_task is advertised", () => assert.ok(continueTool));

  const preflightTool = tools.find((t) => t.name === "routing_preflight");
  check("routing_preflight is advertised", () => assert.ok(preflightTool));
  check("routing_preflight advertises exactly the finalized card fields", () => {
    const properties = (preflightTool?.inputSchema?.properties ?? {}) as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(properties).sort(), [
      "coreOverlap",
      "integration",
      "seamSize",
      "seams",
      "sharedState",
      "verification",
    ]);
    const enums: Record<string, string[]> = {
      seamSize: ["small", "substantial", "unknown"],
      sharedState: ["none", "read-only", "mutable", "unknown"],
      coreOverlap: ["disjoint", "shared-core", "unknown"],
      integration: ["mechanical", "architectural", "unknown"],
      verification: ["per-seam", "shared-only", "unknown"],
    };
    for (const [field, expected] of Object.entries(enums)) {
      const schema = properties[field] as { enum?: string[]; default?: string };
      assert.deepEqual(schema.enum, expected, `${field} vocabulary drifted`);
      assert.equal(schema.default, "unknown", `${field} must default to unknown`);
    }
  });
  check("routing_preflight is advisory and creates nothing", () => {
    const description = preflightTool?.description ?? "";
    assert.match(description, /advisory only/i);
    assert.match(description, /creates no worker/i);
    assert.match(description, /refuses nothing/i);
    assert.match(description, /never required/i);
  });
  check("the delegation tools accept the same optional card", () => {
    for (const delegation of [tool, batchTool]) {
      const properties = (delegation?.inputSchema?.properties ?? {}) as Record<
        string,
        unknown
      >;
      assert.ok("routingPreflight" in properties, `${delegation?.name} lacks the card`);
      const required = (delegation?.inputSchema?.required ?? []) as string[];
      assert.ok(
        !required.includes("routingPreflight"),
        "the card must stay optional for backward compatibility",
      );
    }
  });
  check("the advertised card says it is advisory and that it can refuse", () => {
    // Read off the wire, not off the internal shape: a description stripped from
    // the advertised copy is invisible to the parent and therefore worthless. The
    // card is the only optional input here that can refuse a delegation, so that
    // has to be legible from the schema alone.
    for (const delegation of [tool, batchTool]) {
      const properties = (delegation?.inputSchema?.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      const prose = properties.routingPreflight?.description ?? "";
      assert.ok(prose.length > 0, `${delegation?.name} advertises an unlabeled card`);
      assert.match(prose, /advisory/i);
      assert.match(prose, /never blocks execution/i);
      assert.match(prose, /empty seams/i);
      assert.match(prose, /parallel/i);
      assert.match(prose, /sharedState/);
      assert.match(prose, /coreOverlap/);
      assert.match(prose, /unknown/);
      assert.ok(prose.length <= 320, `card prose was ${prose.length} bytes`);
    }
  });
  check(
    "continue_task accepts a bounded reference, instruction, and result detail",
    () => {
      const properties = (continueTool?.inputSchema?.properties ?? {}) as Record<
        string,
        unknown
      >;
      assert.deepEqual(Object.keys(properties).sort(), [
        "continuationReference",
        "instruction",
        "resultDetail",
      ]);
    },
  );

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

  check("all tools omit advertised output schemas", () => {
    assert.equal(tool?.outputSchema, undefined);
    assert.equal(batchTool?.outputSchema, undefined);
    assert.equal(continueTool?.outputSchema, undefined);
    assert.equal(preflightTool?.outputSchema, undefined);
  });

  const preflight = await client.callTool({
    name: "routing_preflight",
    arguments: {
      seams: ["auth adapter", "billing adapter"],
      seamSize: "substantial",
      sharedState: "none",
      coreOverlap: "disjoint",
      integration: "mechanical",
      verification: "per-seam",
    },
  });
  const preflightText = ((preflight.content as Array<{ text?: string }>) ?? [])
    .map((entry) => entry.text ?? "")
    .join("\n");
  check("routing_preflight answers without creating anything", () => {
    assert.notEqual(preflight.isError, true);
    assert.match(preflightText, /ROUTE: delegation-plausible/);
    assert.match(preflightText, /PARALLEL-ELIGIBLE: true/);
    assert.ok(preflightText.length <= 400, `advisory text was ${preflightText.length}`);
    // A parent's own seam labels must not be echoed back at it.
    assert.doesNotMatch(preflightText, /auth adapter|billing adapter/);
  });

  const soloPreflight = await client.callTool({
    name: "routing_preflight",
    arguments: { seams: [] },
  });
  check("an empty seam list is a valid solo answer, not an error", () => {
    assert.notEqual(soloPreflight.isError, true);
    const text = ((soloPreflight.content as Array<{ text?: string }>) ?? [])
      .map((entry) => entry.text ?? "")
      .join("\n");
    assert.match(text, /ROUTE: solo/);
    assert.match(text, /no delegation is required/i);
  });

  check("the batch description tells the parent when parallel is inappropriate", () => {
    assert.match(batchTool?.description ?? "", /disjoint/i);
    assert.match(batchTool?.description ?? "", /sequential/);
  });

  const properties = (tool?.inputSchema?.properties ?? {}) as Record<string, unknown>;
  const required = (tool?.inputSchema?.required ?? []) as string[];

  check("input schema carries the full task contract", () => {
    for (const field of [
      "objective",
      "effort",
      "effortReason",
      "automaticRepair",
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

  check(
    "advertised fields omit repeated prose while the routing card keeps guidance",
    () => {
      const effort = properties.effort as { description?: string };
      const verification = properties.verificationCommands as {
        description?: string;
      };
      assert.equal(effort.description, undefined);
      assert.equal(verification.description, undefined);
      assert.match(tool?.description ?? "", /Luna owns[\s\S]*implementation/i);
      assert.match(tool?.description ?? "", /verification/i);
    },
  );

  check("input schema carries escalation metadata", () => {
    for (const field of ["taskCategory", "previousAttempts"]) {
      assert.ok(field in properties, `missing metadata field: ${field}`);
    }
  });

  check("handoff is the economical result default", () => {
    const resultDetail = properties.resultDetail as {
      enum?: string[];
      default?: string;
    };
    assert.deepEqual(resultDetail.enum, ["handoff", "compact", "full"]);
    assert.equal(resultDetail.default, "handoff");
  });

  check("structured output remains a runtime result boundary", () => {
    assert.equal(tool?.outputSchema, undefined);
    assert.equal(batchTool?.outputSchema, undefined);
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

  // A worker process must not be able to reach any orchestration surface, the
  // new advisory tool included: recursive delegation is prevented by not
  // advertising the tools at all, not by trusting a name match.
  const workerEnv = { ...childEnv, SOL_LUNA_WORKER: "1" };
  const workerTransport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    stderr: "pipe",
    env: workerEnv,
  });
  const workerClient = new Client({ name: "smoke-test-worker", version: "1.0.0" });
  await workerClient.connect(workerTransport);
  const workerCapabilities = workerClient.getServerCapabilities();
  // With nothing registered the server does not even declare a tool capability,
  // so listing is a missing method rather than an empty list.
  let workerToolNames: string[] | null = null;
  let workerListError: unknown = null;
  try {
    workerToolNames = (await workerClient.listTools()).tools.map((t) => t.name);
  } catch (error) {
    workerListError = error;
  }
  await workerClient.close();
  check("a worker process exposes no tool surface at all", () => {
    assert.equal(workerCapabilities?.tools, undefined);
    if (workerToolNames !== null) {
      assert.deepEqual(workerToolNames, [], "a worker must advertise no tools");
      return;
    }
    assert.match(String(workerListError), /Method not found/);
  });

  check("diagnostic logging uses the smoke's isolated path", () => {
    assert.match(fs.readFileSync(logPath, "utf8"), /client connected|ready in/);
  });
  console.log("\nAll protocol checks passed.");
  cleanupTelemetry();
  process.off("exit", cleanupTelemetry);
}

main().catch((error: unknown) => {
  console.error("\nProtocol smoke test failed:\n", error);
  process.exit(1);
});
