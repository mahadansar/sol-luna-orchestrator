/**
 * Activity configuration tests.
 *
 * v0.6.0 shipped an `activity` command that could not find its own event file
 * after a normal `init`: the path lives in `[mcp_servers.<name>.env]`, which
 * Codex injects into the MCP server it launches, and a standalone CLI process
 * is not that child. These tests pin both halves of the fix — that `init`
 * writes the key, and that every command resolves it the same way.
 *
 * All offline. No Codex binary, no model calls.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyInitConfig, parseInitOptions } from "./cli/init.js";
import {
  DISCOVERY_HINT_END,
  DISCOVERY_HINT_START,
  DISCOVERY_HINT_TEXT,
  discoveryHintPath,
  ensureDiscoveryHint,
  inspectDiscoveryHint,
  removeDiscoveryHints,
} from "./cli/discovery-hint.js";
import {
  defaultEventsPath,
  describeEventsSource,
  resolveEventsPath,
} from "./cli/events-path.js";
import { serverEnvTable } from "./cli/settings.js";
import { resolveRegisteredServerConfig } from "./cli/server-config.js";
import { fromTomlValue, readKey, toTomlValue, upsertKey } from "./cli/toml-edit.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.js");

const INPUT = {
  command: "/usr/bin/node",
  serverEntry: "/opt/sol-luna/dist/server.js",
  logPath: "/home/you/.codex/sol-luna-orchestrator.log",
  eventsPath: "/home/you/.codex/sol-luna-orchestrator.events.jsonl",
  forceLogPath: false,
  forceEventsPath: false,
};

/** A realistic config: comments, an unrelated server, hand-set formatting. */
const REALISTIC = `# My Codex configuration. Do not reformat.
model = "gpt-5.6-sol"

# Docs lookup. Do not remove.
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
startup_timeout_sec = 15

[mcp_servers.context7.env]
CONTEXT7_TOKEN = "keep-me"
`;

test("registered policy keeps model authorization separate from executor order", () => {
  let config = REALISTIC;
  config = upsertKey(config, serverEnvTable(), "LUNA_MODEL", "base-model");
  config = upsertKey(
    config,
    serverEnvTable(),
    "SOL_LUNA_ALLOWED_MODELS",
    "base-model,stronger-model",
  );
  config = upsertKey(
    config,
    serverEnvTable(),
    "SOL_LUNA_EXECUTOR_ORDER",
    "base-model,stronger-model",
  );
  const resolved = resolveRegisteredServerConfig(config).computePolicy;
  assert.deepEqual(resolved.allowedModels, ["base-model", "stronger-model"]);
  assert.deepEqual(resolved.executorOrder, ["base-model", "stronger-model"]);
});

test("registered configuration preserves explicit empty strings without converting them to unset nulls", () => {
  let config = REALISTIC;
  config = upsertKey(config, serverEnvTable(), "LUNA_MODEL", "");
  config = upsertKey(config, serverEnvTable(), "SOL_LUNA_MAX_PARALLEL", "");
  config = upsertKey(config, serverEnvTable(), "SOL_LUNA_SERVER_NAME", "");
  config = upsertKey(config, serverEnvTable(), "SOL_LUNA_VERIFY_MODE", "");
  config = upsertKey(config, serverEnvTable(), "SOL_LUNA_ALLOWED_ROOTS", "");

  const resolved = resolveRegisteredServerConfig(config);
  assert.equal(resolved.workerModel, "");
  assert.equal(resolved.maxParallel, 1);
  assert.equal(resolved.recursionDisableTarget, "");
  assert.equal(resolved.verificationMode, "allowlist");
  assert.equal(resolved.allowedRoots, "");
  assert.deepEqual(resolved.computePolicy.allowedModels, [""]);
  assert.equal(resolved.computePolicy.maxConcurrency, 1);
});

/** What a v0.6.0 install looks like: registered, configured, no event path. */
const V060 = `[mcp_servers.sol-luna-orchestrator]
command = "/usr/bin/node"
args = ["/opt/sol-luna/dist/server.js"]
tool_timeout_sec = 3600
default_tools_approval_mode = "approve"
startup_timeout_sec = 30

[mcp_servers.sol-luna-orchestrator.env]
SOL_LUNA_LOG = "/home/you/.codex/sol-luna-orchestrator.log"
`;

const eventsOf = (text: string): string | null =>
  fromTomlValue(readKey(text, serverEnvTable(), "SOL_LUNA_EVENTS"));

const logOf = (text: string): string | null =>
  fromTomlValue(readKey(text, serverEnvTable(), "SOL_LUNA_LOG"));

// --- Default path -----------------------------------------------------------

test("the default event path sits under the Codex home, not the project", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexhome-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const resolved = defaultEventsPath();
    assert.equal(path.dirname(resolved), home);
    assert.equal(path.isAbsolute(resolved), true);
    assert.match(path.basename(resolved), /\.jsonl$/);
    assert.ok(
      !resolved.startsWith(process.cwd()),
      "the event log must not land inside whatever repository init was run from",
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

// --- Resolution precedence --------------------------------------------------

test("a process override beats the configured value", () => {
  const configured = applyInitConfig("", INPUT);
  const resolved = resolveEventsPath(configured, {
    SOL_LUNA_EVENTS: "/tmp/override.jsonl",
  });
  assert.equal(resolved.path, "/tmp/override.jsonl");
  assert.equal(resolved.source, "override");
});

test("without a process override the configured value is used", () => {
  const configured = applyInitConfig("", INPUT);
  const resolved = resolveEventsPath(configured, {});
  assert.equal(resolved.path, INPUT.eventsPath);
  assert.equal(resolved.source, "configured");
});

test("an unconfigured install resolves to nothing rather than a guess", () => {
  const resolved = resolveEventsPath(V060, {});
  assert.equal(resolved.path, null);
  assert.equal(resolved.source, "unconfigured");
});

test("an empty environment variable counts as unset", () => {
  const resolved = resolveEventsPath(V060, { SOL_LUNA_EVENTS: "   " });
  assert.equal(resolved.path, null);
  assert.equal(resolved.source, "unconfigured");
});

test("each source is described for humans", () => {
  assert.match(describeEventsSource("override"), /override/i);
  assert.match(describeEventsSource("configured"), /init/i);
  assert.match(describeEventsSource("unconfigured"), /not configured/i);
});

// --- init: fresh, migrate, idempotent ---------------------------------------

test("a fresh init configures the event path", () => {
  const after = applyInitConfig("", INPUT);
  assert.equal(eventsOf(after), INPUT.eventsPath);
  assert.equal(
    fromTomlValue(readKey(after, serverEnvTable(), "SOL_LUNA_SERVER_NAME")),
    "sol-luna-orchestrator",
  );
});

test("a v0.6.0 installation is migrated rather than left alone", () => {
  assert.equal(eventsOf(V060), null, "precondition: v0.6.0 had no event path");
  const after = applyInitConfig(V060, INPUT);
  assert.equal(eventsOf(after), INPUT.eventsPath);
  // Migration must not disturb what was already correct.
  assert.equal(
    fromTomlValue(readKey(after, serverEnvTable(), "SOL_LUNA_LOG")),
    "/home/you/.codex/sol-luna-orchestrator.log",
  );
  assert.match(after, /tool_timeout_sec = 3600/);
  assert.match(after, /default_tools_approval_mode = "approve"/);
});

test("migrating twice changes nothing the second time", () => {
  const once = applyInitConfig(V060, INPUT);
  const twice = applyInitConfig(once, INPUT);
  assert.equal(twice, once);
});

test("a fresh init applied twice is byte-identical", () => {
  const once = applyInitConfig(REALISTIC, INPUT);
  const twice = applyInitConfig(once, INPUT);
  assert.equal(twice, once);
});

// --- Codex discovery hint lifecycle ----------------------------------------

test("discovery hint is tiny, exact, idempotent, and round-trips user bytes", () => {
  const user = "# Keep this instruction\r\nUse my preferred tools.\r\n";
  const once = ensureDiscoveryHint(user);
  const twice = ensureDiscoveryHint(once);

  assert.equal(twice, once);
  assert.equal(inspectDiscoveryHint(once).state, "installed");
  assert.match(
    once,
    new RegExp(`${DISCOVERY_HINT_START}[\\s\\S]*${DISCOVERY_HINT_TEXT}`),
  );
  assert.match(once, new RegExp(`${DISCOVERY_HINT_TEXT}[\\s\\S]*${DISCOVERY_HINT_END}`));
  assert.ok(once.includes(user), "pre-existing AGENTS.md bytes must survive init");
  assert.ok(once.includes("\r\n"));
  assert.equal(
    DISCOVERY_HINT_TEXT,
    "For non-trivial work where delegation could plausibly help, first discover the configured sol-luna-orchestrator MCP and use its guidance to decide between solo work, delegate_task, or delegate_tasks. Do not substitute Codex built-in delegation. Zero workers is valid.",
  );
  assert.ok(DISCOVERY_HINT_TEXT.length <= 280, "the permanent hint must stay tiny");

  const removed = removeDiscoveryHints(once);
  assert.equal(removed.removedCount, 1);
  assert.equal(removed.text, user);
});

test("discovery hint migrates the exact legacy block without touching user bytes", () => {
  const user = "# Keep this instruction\nUse my preferred tools.\n";
  const legacy = [
    DISCOVERY_HINT_START,
    "When delegated work may be useful, consider the configured sol-luna-orchestrator MCP before Codex built-in delegation. Delegation is optional; zero workers is valid.",
    DISCOVERY_HINT_END,
    user,
  ].join("\n");

  assert.equal(inspectDiscoveryHint(legacy).state, "modified");
  const directlyRemoved = removeDiscoveryHints(legacy);
  assert.equal(directlyRemoved.removedCount, 1);
  assert.equal(directlyRemoved.text, user);

  const migrated = ensureDiscoveryHint(legacy);
  assert.equal(inspectDiscoveryHint(migrated).state, "installed");
  assert.ok(migrated.includes(DISCOVERY_HINT_TEXT));
  assert.doesNotMatch(migrated, /When delegated work may be useful/);
  assert.ok(migrated.endsWith(user));

  const removed = removeDiscoveryHints(migrated);
  assert.equal(removed.removedCount, 1);
  assert.equal(removed.text, user);
});

test("discovery hint preserves surrounding content and does not remove an altered block", () => {
  const altered = [
    "# User content",
    DISCOVERY_HINT_START,
    "A user-edited instruction",
    DISCOVERY_HINT_END,
    "Keep this too.",
  ].join("\n");
  assert.equal(inspectDiscoveryHint(altered).state, "modified");

  const installed = ensureDiscoveryHint(altered);
  assert.equal(inspectDiscoveryHint(installed).exactCount, 1);
  const removed = removeDiscoveryHints(installed);
  assert.equal(removed.text, altered);
});

test("discovery hint targets the active global Codex instruction file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-discovery-"));
  try {
    assert.equal(discoveryHintPath(home), path.join(home, "AGENTS.md"));

    fs.writeFileSync(path.join(home, "AGENTS.override.md"), "\n", "utf8");
    assert.equal(discoveryHintPath(home), path.join(home, "AGENTS.md"));

    fs.writeFileSync(
      path.join(home, "AGENTS.override.md"),
      "# Active override\n",
      "utf8",
    );
    assert.equal(discoveryHintPath(home), path.join(home, "AGENTS.override.md"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("init opt-out is explicit and does not get swallowed by another flag", () => {
  const options = parseInitOptions(["--no-discovery-hint", "--dry-run"]);
  assert.equal(options.noDiscoveryHint, true);
  assert.equal(options.dryRun, true);
  assert.deepEqual(options.unknown, []);
});

// --- init: custom value preservation ----------------------------------------

test("an existing custom event path survives re-running init", () => {
  const custom = applyInitConfig("", { ...INPUT, eventsPath: "/data/mine.jsonl" });
  const after = applyInitConfig(custom, INPUT);
  assert.equal(eventsOf(after), "/data/mine.jsonl");
});

test("--events replaces an existing path, because it was asked to", () => {
  const custom = applyInitConfig("", { ...INPUT, eventsPath: "/data/mine.jsonl" });
  const after = applyInitConfig(custom, {
    ...INPUT,
    eventsPath: "/data/chosen.jsonl",
    forceEventsPath: true,
  });
  assert.equal(eventsOf(after), "/data/chosen.jsonl");
});

test("--events is parsed, and refuses to swallow a following flag", () => {
  assert.equal(parseInitOptions(["--events", "/a/b.jsonl"]).eventsPath, "/a/b.jsonl");
  const bad = parseInitOptions(["--events", "--force"]);
  assert.equal(bad.eventsPath, undefined);
  assert.deepEqual(bad.missingValue, ["--events"]);
  assert.equal(bad.force, true);
});

// --- init: --log has the same explicit-request semantics as --events --------
//
// `--log` shipped with the defect `--events` was fixed for: the early return
// treated an already-configured install as "nothing to do", and the write was
// guarded by "only when absent", so the flag was inert exactly where someone
// would reach for it.

test("--log replaces the value on an already-configured install", () => {
  const configured = applyInitConfig("", INPUT);
  assert.equal(logOf(configured), INPUT.logPath, "precondition: a log path exists");

  const after = applyInitConfig(configured, {
    ...INPUT,
    logPath: "/var/log/sol-luna.log",
    forceLogPath: true,
  });
  assert.equal(logOf(after), "/var/log/sol-luna.log");
});

test("--log is not swallowed when everything else is already configured", () => {
  // The command-level guard: an explicit path must defeat the shortcut that
  // prints "Already configured" and returns before writing anything.
  const options = parseInitOptions(["--log", "/var/log/sol-luna.log"]);
  assert.equal(options.logPath, "/var/log/sol-luna.log");
  assert.equal(options.force, false, "no --force should be needed to use --log");

  const configured = applyInitConfig("", INPUT);
  const after = applyInitConfig(configured, {
    ...INPUT,
    logPath: options.logPath!,
    forceLogPath: options.logPath !== undefined,
  });
  assert.notEqual(after, configured, "an explicit --log must change something");
  assert.equal(logOf(after), "/var/log/sol-luna.log");
});

test("without --log an existing custom log path is preserved", () => {
  const custom = applyInitConfig("", { ...INPUT, logPath: "/data/my.log" });
  const after = applyInitConfig(custom, INPUT);
  assert.equal(logOf(after), "/data/my.log");
});

test("re-applying the same explicit --log is idempotent", () => {
  const once = applyInitConfig("", {
    ...INPUT,
    logPath: "/var/log/x.log",
    forceLogPath: true,
  });
  const twice = applyInitConfig(once, {
    ...INPUT,
    logPath: "/var/log/x.log",
    forceLogPath: true,
  });
  assert.equal(twice, once);
});

test("--log and --events together update both without swallowing either", () => {
  const configured = applyInitConfig("", INPUT);
  const after = applyInitConfig(configured, {
    ...INPUT,
    logPath: "/var/log/both.log",
    eventsPath: "/var/log/both.events.jsonl",
    forceLogPath: true,
    forceEventsPath: true,
  });
  assert.equal(logOf(after), "/var/log/both.log");
  assert.equal(eventsOf(after), "/var/log/both.events.jsonl");

  const parsed = parseInitOptions([
    "--log",
    "/var/log/both.log",
    "--events",
    "/var/log/both.events.jsonl",
  ]);
  assert.equal(parsed.logPath, "/var/log/both.log");
  assert.equal(parsed.eventsPath, "/var/log/both.events.jsonl");
  assert.deepEqual(parsed.unknown, []);
  assert.deepEqual(parsed.missingValue, []);
});

test("replacing paths does not disturb comments, formatting or other keys", () => {
  const base = applyInitConfig(REALISTIC, INPUT);
  const withExtra = base.replace(
    /(\[mcp_servers\.sol-luna-orchestrator\.env\]\r?\n)/,
    '$1# my own note\nMY_OWN = "keep"\n',
  );

  const after = applyInitConfig(withExtra, {
    ...INPUT,
    logPath: "/var/log/replaced.log",
    eventsPath: "/var/log/replaced.events.jsonl",
    forceLogPath: true,
    forceEventsPath: true,
  });

  assert.equal(logOf(after), "/var/log/replaced.log");
  assert.equal(eventsOf(after), "/var/log/replaced.events.jsonl");
  assert.equal(fromTomlValue(readKey(after, serverEnvTable(), "MY_OWN")), "keep");
  assert.match(after, /# my own note/);
  assert.match(after, /# Docs lookup\. Do not remove\./);
  assert.match(after, /startup_timeout_sec = 15/);
  assert.match(after, /CONTEXT7_TOKEN = "keep-me"/);
  assert.equal(
    after.match(/SOL_LUNA_LOG/g)?.length,
    1,
    "replacing must not duplicate the key",
  );
});

// --- init: surgical editing -------------------------------------------------

test("configuring activity leaves unrelated servers and comments untouched", () => {
  const after = applyInitConfig(REALISTIC, INPUT);
  for (const line of REALISTIC.trimEnd().split("\n")) {
    assert.ok(after.includes(line), `migration lost a line: ${JSON.stringify(line)}`);
  }
  assert.match(after, /# Docs lookup\. Do not remove\./);
  assert.match(after, /startup_timeout_sec = 15/, "integer formatting must survive");
  assert.match(after, /CONTEXT7_TOKEN = "keep-me"/, "another server's env survives");
});

test("an unrelated env entry in our own table survives", () => {
  const withExtra = applyInitConfig(
    `[mcp_servers.sol-luna-orchestrator.env]\nMY_OWN = "value"\n`,
    INPUT,
  );
  assert.equal(fromTomlValue(readKey(withExtra, serverEnvTable(), "MY_OWN")), "value");
  assert.equal(eventsOf(withExtra), INPUT.eventsPath);
});

test("CRLF files stay CRLF", () => {
  const after = applyInitConfig(REALISTIC.replace(/\n/g, "\r\n"), INPUT);
  assert.ok(after.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(after), "a stray LF would mean mixed line endings");
});

test("a Windows path round-trips through the config", () => {
  const windows = "C:\\Users\\me\\.codex\\sol luna.events.jsonl";
  const after = applyInitConfig("", { ...INPUT, eventsPath: windows });
  assert.match(after, /SOL_LUNA_EVENTS = "C:\\\\Users\\\\me/, "must be escaped in TOML");
  assert.equal(eventsOf(after), windows, "and must decode back to the original");
  assert.equal(resolveEventsPath(after, {}).path, windows);
});

test("a path containing spaces survives", () => {
  const spaced = "/home/my user/Application Data/events.jsonl";
  const after = applyInitConfig("", { ...INPUT, eventsPath: spaced });
  assert.equal(resolveEventsPath(after, {}).path, spaced);
});

test("a TOML literal string is read without escape decoding", () => {
  // Single quotes are the recommended way to write a Windows path by hand.
  const text = `[mcp_servers.sol-luna-orchestrator.env]\nSOL_LUNA_EVENTS = 'D:\\raw\\events.jsonl'\n`;
  assert.equal(resolveEventsPath(text, {}).path, "D:\\raw\\events.jsonl");
});

test("the value written is exactly what toTomlValue produces", () => {
  const after = applyInitConfig("", INPUT);
  assert.equal(
    readKey(after, serverEnvTable(), "SOL_LUNA_EVENTS"),
    toTomlValue(INPUT.eventsPath),
  );
});

// --- CLI process behaviour --------------------------------------------------

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    // The suite must never inherit a real SOL_LUNA_EVENTS from the developer's
    // shell, or the "no environment variable set" cases would silently pass.
    const base: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    delete base.SOL_LUNA_EVENTS;
    execFile(
      process.execPath,
      [CLI, ...args],
      { timeout: 60_000, windowsHide: true, env: { ...base, ...env } },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? null
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** A Codex home whose config already has activity configured. */
function configuredHome(eventsPath?: string): { home: string; events: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-activity-"));
  const events = eventsPath ?? path.join(home, "events.jsonl");
  fs.writeFileSync(
    path.join(home, "config.toml"),
    applyInitConfig("", { ...INPUT, eventsPath: events }),
    "utf8",
  );
  return { home, events };
}

test("activity on a never-initialised install points at init, not at an env var", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-activity-"));
  const result = await runCli(["activity"], { CODEX_HOME: home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not configured/i);
  assert.match(result.stderr, /sol-luna-orchestrator init/);
  assert.ok(
    !/export SOL_LUNA_EVENTS/i.test(result.stderr),
    "telling a normal user to export a variable is the bug being fixed",
  );
});

test("activity finds the configured path with no environment variable set", async () => {
  const { home } = configuredHome();
  const result = await runCli(["activity"], { CODEX_HOME: home });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No orchestration activity found/);
});

test("a configured but not yet created file is empty activity, not an error", async () => {
  const { home, events } = configuredHome();
  assert.ok(!fs.existsSync(events), "precondition: nothing has been delegated yet");
  const result = await runCli(["activity", "--json"], { CODEX_HOME: home });
  assert.equal(result.code, 0);
  const snapshot = JSON.parse(result.stdout) as { batchId: string | null };
  assert.equal(snapshot.batchId, null);
});

test("activity reads real events from the configured path", async () => {
  const { home, events } = configuredHome();
  fs.writeFileSync(
    events,
    [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "batch.started",
        batchId: "b1",
        mode: "parallel",
        taskCount: 2,
        maxParallel: 2,
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "task.queued",
        batchId: "b1",
        taskId: "t1",
        effort: "medium",
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const human = await runCli(["activity"], { CODEX_HOME: home });
  assert.equal(human.code, 0);
  assert.match(human.stdout, /RUNNING.*parallel/);
  assert.match(human.stdout, /Delegated task 1/);
  assert.doesNotMatch(human.stdout, /\bt1\b/);
  assert.doesNotMatch(human.stdout, /b1/);

  const json = await runCli(["activity", "--json"], { CODEX_HOME: home });
  const snapshot = JSON.parse(json.stdout) as { batchId: string; taskCount: number };
  assert.equal(snapshot.batchId, "b1");
  assert.equal(snapshot.taskCount, 2);
});

test("a process override redirects activity away from the configured path", async () => {
  const { home } = configuredHome();
  const other = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-override-")),
    "other.jsonl",
  );
  fs.writeFileSync(
    other,
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "batch.started",
      batchId: "from-override",
      mode: "sequential",
      taskCount: 1,
      maxParallel: 1,
    }) + "\n",
    "utf8",
  );

  const result = await runCli(["activity", "--json"], {
    CODEX_HOME: home,
    SOL_LUNA_EVENTS: other,
  });
  const snapshot = JSON.parse(result.stdout) as { batchId: string };
  assert.equal(snapshot.batchId, "from-override");
});

test("activity rejects --watch with --json before touching the filesystem", async () => {
  const { home } = configuredHome();
  const result = await runCli(["activity", "--watch", "--json"], { CODEX_HOME: home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot be used together/);
});

// --- status and doctor agree with activity ----------------------------------

test("status reports the configured path rather than this shell's environment", async () => {
  const { home, events } = configuredHome();
  const result = await runCli(["status"], { CODEX_HOME: home });
  assert.match(result.stdout, /Activity log/);
  assert.ok(
    result.stdout.includes(events),
    `status should show ${events}\n${result.stdout}`,
  );
  assert.ok(
    !/off \(set SOL_LUNA_EVENTS\)/.test(result.stdout),
    "status claimed telemetry was off while the server was configured to write it",
  );
});

test("status marks an override as an override", async () => {
  const { home } = configuredHome();
  const result = await runCli(["status"], {
    CODEX_HOME: home,
    SOL_LUNA_EVENTS: "/tmp/from-env.jsonl",
  });
  assert.match(result.stdout, /from-env\.jsonl/);
  assert.match(result.stdout, /override/i);
});

test("status reports registered server policy instead of differing CLI-shell values", async () => {
  const { home } = configuredHome();
  const configPath = path.join(home, "config.toml");
  let config = fs.readFileSync(configPath, "utf8");
  config = upsertKey(config, serverEnvTable(), "LUNA_MODEL", "registered-model");
  config = upsertKey(config, serverEnvTable(), "SOL_LUNA_MAX_PARALLEL", "6");
  config = upsertKey(config, serverEnvTable(), "SOL_LUNA_VERIFY_MODE", "off");
  config = upsertKey(config, serverEnvTable(), "SOL_LUNA_ALLOWED_ROOTS", "/registered");
  fs.writeFileSync(configPath, config, "utf8");

  const result = await runCli(["status"], {
    CODEX_HOME: home,
    LUNA_MODEL: "shell-model",
    SOL_LUNA_MAX_PARALLEL: "2",
    SOL_LUNA_VERIFY_MODE: "shell",
    SOL_LUNA_ALLOWED_ROOTS: "/shell",
  });
  assert.match(result.stdout, /registered-model/);
  assert.match(result.stdout, /Max workers:\s+6/);
  assert.match(result.stdout, /Verification:\s+off/);
  assert.match(result.stdout, /Workspace roots:\s+\/registered/);
  assert.doesNotMatch(result.stdout, /shell-model|\/shell/);
});

test("status says how to fix an unconfigured install", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-activity-"));
  const result = await runCli(["status"], { CODEX_HOME: home });
  assert.match(result.stdout, /not configured/);
  assert.match(result.stdout, /sol-luna-orchestrator init/);
});

test("doctor reports activity configuration, and agrees with init", async () => {
  const { home, events } = configuredHome();
  const result = await runCli(["doctor", "--json"], { CODEX_HOME: home });
  const report = JSON.parse(result.stdout) as {
    checks: Array<{ name: string; status: string; detail?: string }>;
  };
  const check = report.checks.find((c) => c.name === "Activity log configured");
  assert.ok(check, "doctor must check the key init writes");
  assert.equal(check.status, "ok");
  assert.ok(check.detail?.includes(events));
});

test("doctor reports registered policy and verifies the recursion disable target", async () => {
  const { home } = configuredHome();
  const configPath = path.join(home, "config.toml");
  let config = fs.readFileSync(configPath, "utf8");
  config = upsertKey(config, serverEnvTable(), "LUNA_MODEL", "registered-model");
  config = upsertKey(config, serverEnvTable(), "SOL_LUNA_VERIFY_MODE", "off");
  config = upsertKey(config, serverEnvTable(), "SOL_LUNA_ALLOWED_ROOTS", "/registered");
  config = upsertKey(config, serverEnvTable(), "SOL_LUNA_SERVER_NAME", "wrong-name");
  fs.writeFileSync(configPath, config, "utf8");

  const result = await runCli(["doctor", "--json"], {
    CODEX_HOME: home,
    LUNA_MODEL: "shell-model",
    SOL_LUNA_VERIFY_MODE: "shell",
    SOL_LUNA_ALLOWED_ROOTS: "/shell",
  });
  const report = JSON.parse(result.stdout) as {
    checks: Array<{ name: string; status: string; detail?: string }>;
  };
  assert.equal(
    report.checks.find((c) => c.name === "Worker model")?.detail,
    "registered-model",
  );
  assert.equal(report.checks.find((c) => c.name === "Verification mode")?.detail, "off");
  assert.equal(
    report.checks.find((c) => c.name === "Workspace confinement")?.detail,
    "/registered",
  );
  const recursion = report.checks.find((c) => c.name === "Worker MCP disable target");
  assert.equal(recursion?.status, "fail");
  assert.equal(recursion?.detail, "wrong-name");
  assert.equal(
    report.checks.some((c) => c.name === "Worker recursion blocked"),
    false,
  );
});

test("doctor warns, rather than fails, when activity is unconfigured", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-activity-"));
  fs.writeFileSync(path.join(home, "config.toml"), V060, "utf8");
  const result = await runCli(["doctor", "--json"], { CODEX_HOME: home });
  const report = JSON.parse(result.stdout) as {
    checks: Array<{ name: string; status: string; remedy?: string }>;
  };
  const check = report.checks.find((c) => c.name === "Activity log configured");
  assert.equal(check?.status, "warn", "delegation still works without telemetry");
  assert.match(check?.remedy ?? "", /init/);
});

// --- uninstall keeps user data ----------------------------------------------

test("uninstall removes the configuration but never the event history", async () => {
  const { home, events } = configuredHome();
  fs.writeFileSync(events, '{"type":"batch.started"}\n', "utf8");

  const result = await runCli(["uninstall"], { CODEX_HOME: home });
  assert.equal(result.code, 0);

  const after = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  assert.equal(readKey(after, serverEnvTable(), "SOL_LUNA_EVENTS"), null);
  assert.equal(
    fs.existsSync(events),
    true,
    "the user's activity history is their data, not ours to delete",
  );
});
