/**
 * CLI and configuration-safety tests.
 *
 * The config editor rewrites a file the user owns and did not create for us, so
 * these tests use realistic TOML — comments, unrelated MCP servers, project
 * tables, odd spacing — and assert on exact surviving bytes rather than on a
 * parsed representation. A round-trip through a TOML serialiser would pass a
 * shallow test while destroying someone's file.
 *
 * All offline. No Codex, no model calls.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  detectNewline,
  findTable,
  formatTableHeader,
  fromTomlValue,
  listSubTables,
  parseTableHeader,
  readKey,
  removeTable,
  toTomlValue,
  upsertKey,
} from "./cli/toml-edit.js";
import { parseInitOptions } from "./cli/init.js";
import { ensureDiscoveryHint } from "./cli/discovery-hint.js";
import { minimumNode } from "./cli/paths.js";
import { inspectSettings, settingsSatisfied } from "./cli/settings.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.js");

/** A config that looks like something a real person has been editing. */
const REALISTIC_CONFIG = `# My Codex configuration
model = "gpt-5.6-sol"
model_reasoning_effort = "high"

[windows]
sandbox = "elevated"

# Work laptop projects
[projects.'c:\\work\\api']
trust_level = "trusted"

# Documentation lookup - do not remove!
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
startup_timeout_sec = 15

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
`;

// --- Header parsing ---------------------------------------------------------

test("table headers parse into dotted segments", () => {
  assert.deepEqual(parseTableHeader("[mcp_servers.foo]"), ["mcp_servers", "foo"]);
  assert.deepEqual(parseTableHeader("  [a.b.c]  "), ["a", "b", "c"]);
  assert.deepEqual(parseTableHeader('[mcp_servers."my server".env]'), [
    "mcp_servers",
    "my server",
    "env",
  ]);
  assert.deepEqual(parseTableHeader("[projects.'c:\\work\\api']"), [
    "projects",
    "c:\\work\\api",
  ]);
});

test("non-headers and array-of-tables are not treated as tables", () => {
  assert.equal(parseTableHeader("key = value"), null);
  assert.equal(parseTableHeader("# [commented.out]"), null);
  assert.equal(parseTableHeader("[[array.of.tables]]"), null);
  assert.equal(parseTableHeader(""), null);
});

test("headers are re-rendered with quoting only where required", () => {
  assert.equal(formatTableHeader(["mcp_servers", "sol-luna"]), "[mcp_servers.sol-luna]");
  assert.equal(
    formatTableHeader(["mcp_servers", "my server"]),
    '[mcp_servers."my server"]',
  );
});

test("values serialise to TOML", () => {
  assert.equal(toTomlValue(3600), "3600");
  assert.equal(toTomlValue("approve"), '"approve"');
  assert.equal(toTomlValue(true), "true");
  assert.equal(toTomlValue(["a", "b"]), '["a", "b"]');
});

test("newline style is detected so edits do not mix endings", () => {
  assert.equal(detectNewline("a\r\nb"), "\r\n");
  assert.equal(detectNewline("a\nb"), "\n");
});

// --- Reading ----------------------------------------------------------------

test("keys are read from the correct table only", () => {
  assert.equal(
    readKey(REALISTIC_CONFIG, ["mcp_servers", "context7"], "command"),
    '"npx"',
  );
  assert.equal(
    readKey(REALISTIC_CONFIG, ["mcp_servers", "context7"], "startup_timeout_sec"),
    "15",
  );
  // `command` exists in context7 but not figma; scoping must hold.
  assert.equal(readKey(REALISTIC_CONFIG, ["mcp_servers", "figma"], "command"), null);
  assert.equal(readKey(REALISTIC_CONFIG, ["mcp_servers", "absent"], "command"), null);
});

test("trailing comments are stripped but quoted hashes survive", () => {
  const text = ["[t]", "a = 5 # five", 'b = "x # y"'].join("\n");
  assert.equal(readKey(text, ["t"], "a"), "5");
  assert.equal(readKey(text, ["t"], "b"), '"x # y"');
});

// --- Writing ----------------------------------------------------------------

test("inserting a key leaves every other byte untouched", () => {
  const next = upsertKey(
    REALISTIC_CONFIG,
    ["mcp_servers", "context7"],
    "tool_timeout_sec",
    3600,
  );

  assert.equal(readKey(next, ["mcp_servers", "context7"], "tool_timeout_sec"), "3600");
  // Everything the user wrote is still there, verbatim.
  assert.ok(next.includes("# My Codex configuration"));
  assert.ok(next.includes("# Documentation lookup - do not remove!"));
  assert.ok(next.includes(`[projects.'c:\\work\\api']`));
  assert.ok(next.includes('bearer_token_env_var = "FIGMA_OAUTH_TOKEN"'));
  assert.ok(next.includes('args = ["-y", "@upstash/context7-mcp"]'));
  assert.equal(listSubTables(next, ["mcp_servers"]).sort().join(","), "context7,figma");
});

test("updating a key replaces it in place without duplicating", () => {
  const next = upsertKey(
    REALISTIC_CONFIG,
    ["mcp_servers", "context7"],
    "startup_timeout_sec",
    30,
  );
  assert.equal(readKey(next, ["mcp_servers", "context7"], "startup_timeout_sec"), "30");
  assert.equal(next.match(/startup_timeout_sec/g)?.length, 1);
  assert.ok(!next.includes("startup_timeout_sec = 15"));
});

test("a missing table is created without disturbing existing ones", () => {
  const next = upsertKey(
    REALISTIC_CONFIG,
    ["mcp_servers", "sol-luna-orchestrator"],
    "tool_timeout_sec",
    3600,
    {
      comment: ["Needed because the default is 60s."],
    },
  );

  assert.equal(
    readKey(next, ["mcp_servers", "sol-luna-orchestrator"], "tool_timeout_sec"),
    "3600",
  );
  assert.ok(next.includes("# Needed because the default is 60s."));
  assert.deepEqual(listSubTables(next, ["mcp_servers"]).sort(), [
    "context7",
    "figma",
    "sol-luna-orchestrator",
  ]);
});

test("writing into an empty or absent config produces valid content", () => {
  const fromEmpty = upsertKey("", ["mcp_servers", "x"], "tool_timeout_sec", 3600);
  assert.equal(readKey(fromEmpty, ["mcp_servers", "x"], "tool_timeout_sec"), "3600");
  assert.ok(fromEmpty.startsWith("[mcp_servers.x]"));
});

test("CRLF files stay CRLF", () => {
  const crlf = REALISTIC_CONFIG.replace(/\n/g, "\r\n");
  const next = upsertKey(crlf, ["mcp_servers", "context7"], "tool_timeout_sec", 3600);
  assert.ok(next.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(next), "a bare LF was introduced into a CRLF file");
});

test("indentation of an existing key is preserved", () => {
  const indented = ["[t]", "    a = 1"].join("\n");
  const next = upsertKey(indented, ["t"], "a", 2);
  assert.ok(next.includes("    a = 2"));
});

// --- Removal ----------------------------------------------------------------

test("removing our table leaves unrelated servers intact", () => {
  const withOurs = upsertKey(
    REALISTIC_CONFIG,
    ["mcp_servers", "sol-luna-orchestrator"],
    "tool_timeout_sec",
    3600,
  );
  const withEnv = upsertKey(
    withOurs,
    ["mcp_servers", "sol-luna-orchestrator", "env"],
    "SOL_LUNA_LOG",
    "/tmp/x.log",
  );

  const removed = removeTable(withEnv, ["mcp_servers", "sol-luna-orchestrator"]);

  assert.equal(findTable(removed, ["mcp_servers", "sol-luna-orchestrator"]), null);
  assert.equal(
    findTable(removed, ["mcp_servers", "sol-luna-orchestrator", "env"]),
    null,
    "sub-tables must go too",
  );
  assert.deepEqual(listSubTables(removed, ["mcp_servers"]).sort(), ["context7", "figma"]);
  assert.ok(removed.includes("# Documentation lookup - do not remove!"));
  assert.ok(removed.includes("bearer_token_env_var"));
  assert.ok(removed.includes("model_reasoning_effort"));
});

test("removing a table that is not there changes nothing at all", () => {
  assert.equal(
    removeTable(REALISTIC_CONFIG, ["mcp_servers", "absent"]),
    REALISTIC_CONFIG,
  );
});

test("removal is idempotent", () => {
  const once = removeTable(REALISTIC_CONFIG, ["mcp_servers", "figma"]);
  assert.equal(removeTable(once, ["mcp_servers", "figma"]), once);
});

test("removing the only content yields an empty file rather than junk", () => {
  const only = '[mcp_servers.x]\ncommand = "node"\n';
  assert.equal(removeTable(only, ["mcp_servers", "x"]), "");
});

// --- Settings model ---------------------------------------------------------

test("settings inspection distinguishes missing, wrong and correct", () => {
  const partly = [
    "[mcp_servers.sol-luna-orchestrator]",
    'command = "node"',
    "tool_timeout_sec = 60",
  ].join("\n");

  const checks = inspectSettings(partly, "sol-luna-orchestrator");
  const byKey = Object.fromEntries(checks.map((check) => [check.key, check]));

  assert.equal(byKey.tool_timeout_sec?.state, "wrong");
  assert.equal(byKey.tool_timeout_sec?.actual, "60");
  assert.equal(byKey.default_tools_approval_mode?.state, "missing");
  assert.equal(settingsSatisfied(checks), false);
});

test("a fully configured table satisfies the required settings", () => {
  const good = [
    "[mcp_servers.sol-luna-orchestrator]",
    'command = "node"',
    "tool_timeout_sec = 3600",
    'default_tools_approval_mode = "approve"',
  ].join("\n");

  const checks = inspectSettings(good, "sol-luna-orchestrator");
  assert.equal(settingsSatisfied(checks), true, JSON.stringify(checks));
  // startup_timeout_sec is optional, so its absence must not fail the check.
  assert.equal(
    checks.find((check) => check.key === "startup_timeout_sec")?.state,
    "missing",
  );
});

// --- Malicious / hostile input ----------------------------------------------

test("a server name cannot inject TOML structure", () => {
  // A crafted name must be quoted into a single segment, never break out into
  // new tables or keys.
  const hostile = "evil]\ninjected = true\n[mcp_servers.other";
  const next = upsertKey("", ["mcp_servers", hostile], "tool_timeout_sec", 3600);

  assert.equal(readKey(next, ["mcp_servers", "other"], "injected"), null);
  const names = listSubTables(next, ["mcp_servers"]);
  assert.equal(names.length, 1);
  assert.equal(names[0], hostile);
});

test("string values are escaped rather than interpolated", () => {
  const next = upsertKey("", ["t"], "path", 'C:\\x\\"y"\nz = 1');
  assert.equal(readKey(next, ["t"], "z"), null, "value must not become a second key");
  assert.equal(next.split("\n").filter((line) => line.includes("=")).length, 1);
});

test("a malformed config does not crash the editor", () => {
  for (const broken of ["[unclosed\nkey = 1", "= 5", "[[a]]\nb = 1", "\u0000\u0001"]) {
    assert.doesNotThrow(() => readKey(broken, ["a"], "b"));
    assert.doesNotThrow(() => upsertKey(broken, ["z"], "k", 1));
    assert.doesNotThrow(() => removeTable(broken, ["a"]));
  }
});

// --- CLI process behaviour --------------------------------------------------

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        timeout: 60_000,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1", ...env },
      },
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

test("--help lists the commands and exits 0", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  for (const command of ["init", "doctor", "status", "uninstall"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.match(
    result.stdout,
    /Open Codex with any compatible parent model and work normally\./,
  );
  assert.match(result.stdout, /No parent model or reasoning effort is required\./);
  assert.match(result.stdout, /Creator example: GPT-5\.6 Sol at Medium\./);
});

test("no arguments prints help and exits non-zero", async () => {
  const result = await runCli([]);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /Usage/);
});

test("an unknown command fails with guidance on stderr", async () => {
  const result = await runCli(["frobnicate"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command/);
});

test("version prints something version-shaped", async () => {
  const result = await runCli(["version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("the CLI never starts the MCP stdio server", async () => {
  // If the CLI accidentally booted the server it would hold stdio open and this
  // would hit the timeout instead of returning.
  const result = await runCli(["status"], { CODEX_HOME: emptyCodexHome() });
  assert.notEqual(result.code, null, "CLI hung — it may have started the server");
  assert.match(result.stdout, /Sol-Luna Orchestrator/);
});

test("status reports an unconfigured install without throwing", async () => {
  const result = await runCli(["status"], { CODEX_HOME: emptyCodexHome() });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Configured:\s*no/);
});

test("doctor --json emits a parseable report", async () => {
  const result = await runCli(["doctor", "--json"], { CODEX_HOME: emptyCodexHome() });
  const report = JSON.parse(result.stdout) as {
    version: string;
    ok: boolean;
    checks: Array<{ name: string; status: string }>;
  };
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  assert.ok(
    report.checks.every((check) => ["ok", "warn", "fail"].includes(check.status)),
  );
  assert.match(report.version, /^\d+\.\d+\.\d+/);
});

test("doctor reports a missing registration as a failure", async () => {
  const result = await runCli(["doctor"], { CODEX_HOME: emptyCodexHome() });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /MCP server registered/);
});

test("init --dry-run writes nothing", async () => {
  const home = emptyCodexHome();
  const configPath = path.join(home, "config.toml");
  fs.writeFileSync(configPath, REALISTIC_CONFIG, "utf8");
  const before = fs.readFileSync(configPath, "utf8");

  await runCli(["init", "--dry-run"], { CODEX_HOME: home });

  assert.equal(
    fs.readFileSync(configPath, "utf8"),
    before,
    "dry run modified the config",
  );
});

test("uninstall --dry-run writes nothing and reports scope", async () => {
  const home = emptyCodexHome();
  const configPath = path.join(home, "config.toml");
  const instructionsPath = path.join(home, "AGENTS.md");
  fs.writeFileSync(configPath, REALISTIC_CONFIG, "utf8");
  fs.writeFileSync(instructionsPath, ensureDiscoveryHint("# Keep this.\n"), "utf8");
  const before = fs.readFileSync(configPath, "utf8");
  const instructionsBefore = fs.readFileSync(instructionsPath, "utf8");

  const result = await runCli(["uninstall", "--dry-run"], { CODEX_HOME: home });

  assert.equal(fs.readFileSync(configPath, "utf8"), before);
  assert.equal(fs.readFileSync(instructionsPath, "utf8"), instructionsBefore);
  assert.equal(result.code, 0);
});

test("status and doctor report the deterministic discovery-hint state", async () => {
  const home = emptyCodexHome();
  fs.writeFileSync(
    path.join(home, "AGENTS.md"),
    ensureDiscoveryHint("# Keep this.\n"),
    "utf8",
  );

  const status = await runCli(["status"], { CODEX_HOME: home });
  assert.match(status.stdout, /Discovery hint/);
  assert.match(status.stdout, /installed/);

  const doctor = await runCli(["doctor", "--json"], { CODEX_HOME: home });
  const report = JSON.parse(doctor.stdout) as {
    checks: Array<{ name: string; status: string; detail?: string }>;
  };
  const check = report.checks.find((entry) => entry.name === "Codex discovery hint");
  assert.equal(check?.status, "ok");
  assert.match(check?.detail ?? "", /AGENTS\.md/);
});

test("uninstall on an unconfigured machine is a safe no-op", async () => {
  const home = emptyCodexHome();
  const result = await runCli(["uninstall"], { CODEX_HOME: home });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Nothing to remove/);
});

// --- Display decoding -------------------------------------------------------

test("raw TOML values are decoded for display without altering the file", () => {
  assert.equal(fromTomlValue(`"C:\\\\Users\\\\me\\\\log.txt"`), "C:\\Users\\me\\log.txt");
  assert.equal(fromTomlValue(`"approve"`), "approve");
  assert.equal(fromTomlValue(`'C:\\raw\\path'`), "C:\\raw\\path");
  assert.equal(fromTomlValue("3600"), "3600");
  assert.equal(fromTomlValue(null), null);
});

test("decoding a value and re-encoding it round-trips", () => {
  const original = "C:\\Users\\me\\sol luna\\log.txt";
  assert.equal(fromTomlValue(toTomlValue(original)), original);
});

// --- Argument handling on config-mutating commands --------------------------

test("a mistyped init flag is refused instead of performing a real write", async () => {
  const home = emptyCodexHome();
  const configPath = path.join(home, "config.toml");
  fs.writeFileSync(configPath, REALISTIC_CONFIG, "utf8");

  const result = await runCli(["init", "--dryrun"], { CODEX_HOME: home });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /Unknown option: --dryrun/);
  assert.equal(fs.readFileSync(configPath, "utf8"), REALISTIC_CONFIG);
});

test("init --log does not swallow a following flag as its value", () => {
  const options = parseInitOptions(["--log", "--force"]);
  assert.equal(options.logPath, undefined);
  assert.deepEqual(options.missingValue, ["--log"]);
  // --force must still be seen; it was never the log path.
  assert.equal(options.force, true);
});

test("init --log at the end of the line reports a missing value", () => {
  const options = parseInitOptions(["--log"]);
  assert.deepEqual(options.missingValue, ["--log"]);
  assert.deepEqual(options.unknown, []);
});

test("valid init flags still parse", () => {
  const options = parseInitOptions(["--dry-run", "--log", "/tmp/x.log", "--force"]);
  assert.equal(options.dryRun, true);
  assert.equal(options.force, true);
  assert.equal(options.logPath, "/tmp/x.log");
  assert.deepEqual(options.unknown, []);
  assert.deepEqual(options.missingValue, []);
});

test("a mistyped uninstall flag removes nothing", async () => {
  const home = emptyCodexHome();
  const configPath = path.join(home, "config.toml");
  fs.writeFileSync(configPath, REALISTIC_CONFIG, "utf8");

  const result = await runCli(["uninstall", "--dry"], { CODEX_HOME: home });

  assert.equal(result.code, 1);
  assert.match(result.stdout, /Unknown option: --dry/);
  assert.equal(fs.readFileSync(configPath, "utf8"), REALISTIC_CONFIG);
});

// --- Node support policy ----------------------------------------------------
//
// The supported Node range is stated in four places: package `engines`, the
// CLI doctor, CI, and the README. They are only useful if they agree, so the
// agreement is asserted rather than maintained by hand.

const REPO_ROOT = path.resolve(HERE, "..");

const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
) as { engines: { node: string }; version: string };

test("doctor reports the same Node range the package declares", () => {
  assert.equal(minimumNode().range, manifest.engines.node);
});

test("doctor's runtime check is derived from engines, not a private constant", async () => {
  const result = await runCli(["doctor", "--json"], { CODEX_HOME: emptyCodexHome() });
  const report = JSON.parse(result.stdout) as {
    checks: Array<{ name: string; expected?: string }>;
  };
  const node = report.checks.find((check) => check.name === "Node.js supported");
  assert.equal(node?.expected, manifest.engines.node);
});

test("every Node version CI tests is at or above the declared minimum", () => {
  const workflow = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
  const text = fs.readFileSync(workflow, "utf8");
  const line = /^\s*node:\s*\[(.+)\]\s*$/m.exec(text);
  assert.ok(line, "could not find the CI node matrix");

  const versions = line[1]!
    .split(",")
    .map((entry) => Number(entry.trim().replace(/"/g, "")));
  assert.ok(versions.length > 0);

  for (const version of versions) {
    assert.ok(
      version >= minimumNode().major,
      `CI tests Node ${version}, below the declared minimum ${minimumNode().range}`,
    );
  }
});

// --- Release workflow -------------------------------------------------------
//
// The publish workflow can only be exercised by pushing a tag, which is exactly
// the wrong moment to discover a mistake in it. These assertions are cheap and
// catch the failure modes that matter: a leaked credential, a trigger that fires
// on a branch, or a version that disagrees with the changelog.

const publishWorkflow = fs.readFileSync(
  path.join(REPO_ROOT, ".github", "workflows", "publish.yml"),
  "utf8",
);

test("the publish workflow carries no npm token or secret", () => {
  for (const forbidden of [
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "npm_token",
    "secrets.",
    "//registry.npmjs.org/:_authToken",
  ]) {
    assert.ok(
      !publishWorkflow.includes(forbidden),
      `publish.yml must not reference ${forbidden} — publishing is OIDC-only`,
    );
  }
});

test("the publish workflow requests exactly the OIDC permissions", () => {
  assert.match(publishWorkflow, /id-token:\s*write/);
  assert.match(publishWorkflow, /contents:\s*read/);
  assert.ok(
    !/contents:\s*write/.test(publishWorkflow),
    "the publish job does not need write access to the repository",
  );
});

test("the publish workflow triggers on release tags only", () => {
  assert.match(publishWorkflow, /tags:\s*\n\s*- "v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"/);
  assert.ok(
    !/^\s*(branches|pull_request):/m.test(publishWorkflow),
    "a branch or pull_request trigger would let a merge publish",
  );
});

test("the publish workflow guards the tag against package.json", () => {
  assert.match(publishWorkflow, /GITHUB_REF_NAME#v/);
  assert.match(publishWorkflow, /does not match package\.json/);
  assert.match(publishWorkflow, /exit 1/);
  // The guard has to come before the publish, or it guards nothing.
  assert.ok(
    publishWorkflow.indexOf("GITHUB_REF_NAME#v") <
      publishWorkflow.indexOf("run: npm publish"),
    "the version guard must run before npm publish",
  );
});

test("the changelog documents the version being shipped", () => {
  const changelog = fs.readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const newest = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog);
  assert.equal(
    newest?.[1],
    manifest.version,
    "the newest changelog entry should be the version in package.json",
  );
});

test("the README states the same minimum Node version", () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
  const { major, minor } = minimumNode();
  assert.ok(
    readme.includes(`Node.js ≥ ${major}.${minor}`),
    `README should state "Node.js ≥ ${major}.${minor}"`,
  );
});

function emptyCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-cli-"));
  return dir;
}
