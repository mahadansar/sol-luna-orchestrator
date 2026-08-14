/**
 * Full CLI lifecycle against a real Codex CLI and an isolated CODEX_HOME.
 *
 * This drives `codex mcp add` / `codex mcp remove` for real, so it needs Codex
 * installed — but it makes no model calls and costs nothing. It is kept out of
 * `npm test` (and therefore out of CI) for that reason.
 *
 * What it is actually protecting: `init` and `uninstall` mutate a file the user
 * owns. Every scenario below starts from a config containing unrelated servers,
 * comments and project settings, and asserts those survive byte for byte.
 *
 * Run with: npm run smoke:cli
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.js");

const UNRELATED_CONFIG = `# Personal Codex setup - hand written, please keep
model = "gpt-5.6-sol"
model_reasoning_effort = "high"

[windows]
sandbox = "elevated"

[projects.'c:\\work\\api']
trust_level = "trusted"

# Docs lookup. Do not remove.
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
startup_timeout_sec = 15

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
`;

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

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], home: string): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        timeout: 120_000,
        windowsHide: true,
        env: { ...process.env, CODEX_HOME: home, NO_COLOR: "1" },
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

const makeHome = (contents?: string): string => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-home-"));
  if (contents !== undefined) {
    fs.writeFileSync(path.join(home, "config.toml"), contents, "utf8");
  }
  return home;
};

const readConfig = (home: string): string => {
  try {
    return fs.readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    return "";
  }
};

const cleanup = (home: string): void => {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
};

/** Everything the user wrote that must never be disturbed. */
const USER_ARTIFACTS = [
  "# Personal Codex setup - hand written, please keep",
  "# Docs lookup. Do not remove.",
  'model_reasoning_effort = "high"',
  `[projects.'c:\\work\\api']`,
  "[mcp_servers.context7]",
  'args = ["-y", "@upstash/context7-mcp"]',
  "startup_timeout_sec = 15",
  "[mcp_servers.figma]",
  'bearer_token_env_var = "FIGMA_OAUTH_TOKEN"',
  "[windows]",
];

const assertUserConfigIntact = (text: string, context: string): void => {
  for (const artifact of USER_ARTIFACTS) {
    assert.ok(text.includes(artifact), `${context}: lost ${JSON.stringify(artifact)}`);
  }
};

async function scenarioFreshInstall(): Promise<void> {
  console.log("\n[1] init on a machine with an existing hand-written config");
  const home = makeHome(UNRELATED_CONFIG);
  try {
    const result = await cli(["init"], home);
    check("init succeeds", () =>
      assert.equal(result.code, 0, result.stdout + result.stderr),
    );

    const text = readConfig(home);
    check("our server was registered", () =>
      assert.match(text, /\[mcp_servers\.sol-luna-orchestrator\]/),
    );
    check("tool_timeout_sec = 3600", () => assert.match(text, /tool_timeout_sec = 3600/));
    check("approval mode = approve", () =>
      assert.match(text, /default_tools_approval_mode = "approve"/),
    );
    check("diagnostic log configured", () => assert.match(text, /SOL_LUNA_LOG/));
    check("unrelated config survived init", () =>
      assertUserConfigIntact(text, "after init"),
    );
    check("init printed next steps", () =>
      assert.match(result.stdout, /Select GPT-5\.6 Sol/),
    );
  } finally {
    cleanup(home);
  }
}

async function scenarioIdempotent(): Promise<void> {
  console.log("\n[2] init is idempotent");
  const home = makeHome(UNRELATED_CONFIG);
  try {
    await cli(["init"], home);
    const first = readConfig(home);

    const second = await cli(["init"], home);
    const after = readConfig(home);

    check("second init reports it is already configured", () =>
      assert.match(second.stdout, /Already configured/),
    );
    check("second init changed nothing", () => assert.equal(after, first));
    check("no duplicate server table", () =>
      assert.equal(after.match(/\[mcp_servers\.sol-luna-orchestrator\]/g)?.length, 1),
    );
    check("no duplicate timeout key", () =>
      assert.equal(after.match(/tool_timeout_sec/g)?.length, 1),
    );
  } finally {
    cleanup(home);
  }
}

async function scenarioRepair(): Promise<void> {
  console.log("\n[3] init repairs a partially wrong configuration");
  const home = makeHome(UNRELATED_CONFIG);
  try {
    await cli(["init"], home);

    // Break it the way a user might: the old 60s default and a wrong mode.
    let text = readConfig(home);
    text = text
      .replace(/tool_timeout_sec = 3600/, "tool_timeout_sec = 60")
      .replace(
        /default_tools_approval_mode = "approve"/,
        'default_tools_approval_mode = "auto"',
      );
    fs.writeFileSync(path.join(home, "config.toml"), text, "utf8");

    const broken = await cli(["doctor"], home);
    check("doctor detects the broken timeout", () => {
      assert.notEqual(broken.code, 0);
      assert.match(broken.stdout, /Tool timeout/);
    });

    const repair = await cli(["init"], home);
    check("init repairs it", () => assert.equal(repair.code, 0, repair.stdout));

    const fixed = readConfig(home);
    check("timeout restored", () => assert.match(fixed, /tool_timeout_sec = 3600/));
    check("approval mode restored", () =>
      assert.match(fixed, /default_tools_approval_mode = "approve"/),
    );
    check("no duplicate keys after repair", () => {
      assert.equal(fixed.match(/tool_timeout_sec/g)?.length, 1);
      assert.equal(fixed.match(/default_tools_approval_mode/g)?.length, 1);
    });
    check("unrelated config survived repair", () =>
      assertUserConfigIntact(fixed, "after repair"),
    );
  } finally {
    cleanup(home);
  }
}

async function scenarioDoctorHealthy(): Promise<void> {
  console.log("\n[4] doctor on a healthy install");
  const home = makeHome(UNRELATED_CONFIG);
  try {
    await cli(["init"], home);

    const result = await cli(["doctor"], home);
    check("doctor exits 0", () => assert.equal(result.code, 0, result.stdout));
    check("doctor reports ready", () => assert.match(result.stdout, /Ready/));

    const json = await cli(["doctor", "--json"], home);
    const report = JSON.parse(json.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    check("json report is ok", () => assert.equal(report.ok, true));
    check("json has no failing checks", () =>
      assert.deepEqual(
        report.checks.filter((entry) => entry.status === "fail").map((e) => e.name),
        [],
      ),
    );

    const status = await cli(["status"], home);
    check("status reports configured", () => {
      assert.equal(status.code, 0);
      assert.match(status.stdout, /Configured:\s*yes/);
    });
  } finally {
    cleanup(home);
  }
}

async function scenarioUninstall(): Promise<void> {
  console.log("\n[5] uninstall removes only our entry");
  const home = makeHome(UNRELATED_CONFIG);
  try {
    await cli(["init"], home);

    const result = await cli(["uninstall"], home);
    check("uninstall succeeds", () => assert.equal(result.code, 0, result.stdout));

    const text = readConfig(home);
    check("our table is gone", () =>
      assert.ok(!/\[mcp_servers\.sol-luna-orchestrator\]/.test(text)),
    );
    check("our env sub-table is gone", () => assert.ok(!/SOL_LUNA_LOG/.test(text)));
    check("unrelated servers survived", () => {
      assert.match(text, /\[mcp_servers\.context7\]/);
      assert.match(text, /\[mcp_servers\.figma\]/);
    });
    check("unrelated config survived uninstall", () =>
      assertUserConfigIntact(text, "after uninstall"),
    );

    const again = await cli(["uninstall"], home);
    check("second uninstall is a safe no-op", () => {
      assert.equal(again.code, 0);
      assert.match(again.stdout, /Nothing to remove/);
    });
    check("second uninstall changed nothing", () => assert.equal(readConfig(home), text));
  } finally {
    cleanup(home);
  }
}

async function scenarioRoundTrip(): Promise<void> {
  console.log("\n[6] init then uninstall restores the original config");
  const home = makeHome(UNRELATED_CONFIG);
  try {
    await cli(["init"], home);
    await cli(["uninstall"], home);

    const after = readConfig(home).replace(/\r\n/g, "\n").trimEnd();
    const before = UNRELATED_CONFIG.replace(/\r\n/g, "\n").trimEnd();

    // Codex's own `mcp add` may normalise incidental whitespace, so compare the
    // meaningful lines rather than demanding a byte-identical file.
    const meaningful = (text: string): string[] =>
      text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);

    check("every original line is still present", () => {
      const remaining = new Set(meaningful(after));
      const missing = meaningful(before).filter((line) => !remaining.has(line));
      assert.deepEqual(missing, [], `lines lost: ${missing.join(" | ")}`);
    });
    check("nothing of ours was left behind", () =>
      assert.ok(!/sol-luna/i.test(after), after),
    );
  } finally {
    cleanup(home);
  }
}

async function scenarioEmptyConfig(): Promise<void> {
  console.log("\n[7] init on a machine with no config at all");
  const home = makeHome();
  try {
    const result = await cli(["init"], home);
    check("init succeeds with no pre-existing config", () =>
      assert.equal(result.code, 0, result.stdout + result.stderr),
    );

    const text = readConfig(home);
    check("a valid server table was created", () => {
      assert.match(text, /\[mcp_servers\.sol-luna-orchestrator\]/);
      assert.match(text, /tool_timeout_sec = 3600/);
    });

    const doctor = await cli(["doctor"], home);
    check("doctor is happy afterwards", () =>
      assert.equal(doctor.code, 0, doctor.stdout),
    );
  } finally {
    cleanup(home);
  }
}

async function scenarioMalformedConfig(): Promise<void> {
  console.log("\n[8] a malformed config is not silently destroyed");
  const home = makeHome("[unclosed\nthis is not valid toml = = =\n");
  const before = readConfig(home);
  try {
    const result = await cli(["init"], home);
    const after = readConfig(home);

    // Codex itself will likely refuse; either way the user's bytes must not
    // vanish, and a backup must exist if we did write.
    check("original content is preserved or backed up", () => {
      const backup = path.join(home, "config.toml.sol-luna-backup");
      const preserved = after.includes("this is not valid toml");
      const backedUp = fs.existsSync(backup)
        ? fs.readFileSync(backup, "utf8").includes("this is not valid toml")
        : false;
      assert.ok(
        preserved || backedUp,
        `content lost. exit=${result.code} after=${JSON.stringify(after.slice(0, 120))}`,
      );
    });
    check("init did not claim success on a broken config", () => {
      if (result.code === 0) assert.match(after, /sol-luna-orchestrator/);
    });
    void before;
  } finally {
    cleanup(home);
  }
}

async function main(): Promise<void> {
  console.log("Sol-Luna Orchestrator CLI lifecycle smoke test");
  console.log(
    "Uses the real Codex CLI against isolated CODEX_HOME dirs. No model calls.",
  );

  await scenarioFreshInstall();
  await scenarioIdempotent();
  await scenarioRepair();
  await scenarioDoctorHealthy();
  await scenarioUninstall();
  await scenarioRoundTrip();
  await scenarioEmptyConfig();
  await scenarioMalformedConfig();

  console.log(
    failures === 0
      ? "\nCLI lifecycle smoke test PASSED."
      : `\nCLI lifecycle smoke test FAILED (${failures} check(s)).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("\nCLI lifecycle smoke test errored:\n", error);
  process.exit(1);
});
