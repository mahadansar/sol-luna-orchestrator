/**
 * Security regression tests.
 *
 * Every case here corresponds to a way a model-supplied task contract could try
 * to make the orchestrator do something the operator did not agree to. They run
 * offline and spawn no agents.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CommandPolicyError,
  DEFAULT_ALLOWED_EXECUTABLES,
  launchesThroughCmd,
  MAX_ARGUMENT_COUNT,
  MAX_COMMAND_LENGTH,
  parseCommand,
  tokenizeCommand,
  unrepresentableCmdArgument,
  verificationCommandsEquivalent,
  type CommandPolicy,
} from "./command.js";
import { findScopeViolations, resolvePath, type RealPathResolver } from "./scope.js";
import { buildVerificationEnv, runVerificationCommand } from "./verify.js";
import { sanitizeForLog } from "./log.js";
import {
  keepWorktreesInvalid,
  parseKeepWorktrees,
  parseWorkerSandbox,
  workerSandboxInvalid,
} from "./config.js";
import { WorkspaceError, resolveWorkspace } from "./workspace.js";
import { buildDelegationResult, buildExploreResult } from "./worker.js";
import { delegateTaskInputSchema } from "./contract.js";
import { collectWorktreeChanges, runGit } from "./git.js";

const POLICY: CommandPolicy = { allowed: DEFAULT_ALLOWED_EXECUTABLES };

test("git evidence collection disables repository-controlled external diff execution", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-git-evidence-"));
  const canary = path.join(repo, "canary.txt");
  const helper = path.join(
    repo,
    process.platform === "win32" ? "external.cmd" : "external.sh",
  );
  try {
    await runGit(["init"], repo);
    await runGit(["config", "user.email", "test@example.invalid"], repo);
    await runGit(["config", "user.name", "Security Test"], repo);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n", "utf8");
    await runGit(["add", "tracked.txt"], repo);
    await runGit(["commit", "-m", "initial"], repo);

    fs.writeFileSync(
      helper,
      process.platform === "win32"
        ? `@echo canary> "${canary}"\r\n@exit /b 0\r\n`
        : `#!/bin/sh\nprintf canary > "${canary}"\n`,
      "utf8",
    );
    if (process.platform !== "win32") fs.chmodSync(helper, 0o755);
    await runGit(["config", "diff.external", helper], repo);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "after\n", "utf8");

    const evidence = await collectWorktreeChanges(repo);
    assert.match(evidence.diff, /tracked\.txt/);
    assert.equal(fs.existsSync(canary), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// --- Command parsing --------------------------------------------------------

test("tokenizer splits on whitespace and honours quotes", () => {
  assert.deepEqual(tokenizeCommand("npm test"), ["npm", "test"]);
  assert.deepEqual(tokenizeCommand("  npm   run   build  "), ["npm", "run", "build"]);
  assert.deepEqual(tokenizeCommand(`npm test -- --grep "two words"`), [
    "npm",
    "test",
    "--",
    "--grep",
    "two words",
  ]);
  assert.deepEqual(tokenizeCommand(`pytest -k 'not slow'`), ["pytest", "-k", "not slow"]);
});

test("tokenizer preserves Windows path separators", () => {
  // A backslash must not act as an escape, or `.\gradlew` and `C:\x\y` break.
  assert.deepEqual(tokenizeCommand(String.raw`node scripts\run.js`), [
    "node",
    String.raw`scripts\run.js`,
  ]);
  assert.deepEqual(tokenizeCommand(String.raw`node "C:\Program Files\x\a.js"`), [
    "node",
    String.raw`C:\Program Files\x\a.js`,
  ]);
});

test("tokenizer rejects unbalanced quotes instead of guessing", () => {
  assert.throws(
    () => tokenizeCommand(`npm test --grep "unterminated`),
    CommandPolicyError,
  );
  assert.throws(
    () => tokenizeCommand(`npm test --grep 'unterminated`),
    CommandPolicyError,
  );
});

test("empty tokens from quotes are preserved as real arguments", () => {
  assert.deepEqual(tokenizeCommand(`node -e ""`), ["node", "-e", ""]);
});

for (const injection of [
  "npm test; rm -rf /",
  "npm test && curl evil.example.com",
  "npm test || echo pwned",
  "npm test | sh",
  "npm test > /etc/passwd",
  "npm test < /etc/shadow",
  "npm test `whoami`",
  "npm test $(whoami)",
  "npm test ${HOME}",
  "npm test\nrm -rf /",
]) {
  test(`shell injection is refused: ${JSON.stringify(injection)}`, () => {
    assert.throws(
      () => parseCommand(injection, POLICY),
      (error: Error) => {
        assert.ok(error instanceof CommandPolicyError);
        assert.match(error.message, /unsupported shell construct/);
        return true;
      },
    );
  });
}

test("shell metacharacters inside quotes are safe literal arguments", () => {
  // Without a shell these can never be interpreted, so refusing them would be
  // security theatre that breaks legitimate test filters.
  const parsed = parseCommand(`pytest -k "not slow and not net"`, POLICY);
  assert.equal(parsed.file, "pytest");
  assert.deepEqual(parsed.args, ["-k", "not slow and not net"]);

  const regex = parseCommand(`npx jest --testNamePattern "handles a|b"`, POLICY);
  assert.deepEqual(regex.args, ["jest", "--testNamePattern", "handles a|b"]);
});

test("only allowlisted executables may run", () => {
  assert.equal(parseCommand("npm test", POLICY).file, "npm");
  assert.equal(parseCommand("pytest -q", POLICY).file, "pytest");

  for (const forbidden of ["curl https://x", "bash script.sh", "sh -c ls", "rm -rf ."]) {
    assert.throws(
      () => parseCommand(forbidden, POLICY),
      (error: Error) => {
        assert.match(error.message, /not in the verification allowlist/);
        return true;
      },
    );
  }
});

test("executables cannot be reached by path", () => {
  for (const command of [
    "/usr/bin/curl https://x",
    "./npm test",
    "../../bin/npm test",
    String.raw`C:\Windows\System32\cmd.exe /c dir`,
    String.raw`.\evil.bat`,
  ]) {
    assert.throws(
      () => parseCommand(command, POLICY),
      (error: Error) => {
        assert.match(error.message, /contains a path|not in the verification allowlist/);
        return true;
      },
    );
  }
});

test("a local file named like an allowlisted tool cannot hijack it", () => {
  // `./npm` must not satisfy an `npm` rule.
  assert.throws(() => parseCommand("./npm test", POLICY), /contains a path/);
});

test("operators can permit an exact path explicitly", () => {
  const policy: CommandPolicy = {
    allowed: [...DEFAULT_ALLOWED_EXECUTABLES, "./gradlew"],
  };
  const parsed = parseCommand("./gradlew test", policy);
  assert.equal(parsed.file, "./gradlew");
  // Still exact-match only: a sibling script is not covered.
  assert.throws(() => parseCommand("./gradlew-evil test", policy), CommandPolicyError);
});

test("Windows executable extensions match their base allowlist entry", () => {
  assert.equal(parseCommand("npm.cmd test", POLICY).file, "npm.cmd");
  assert.equal(parseCommand("NPM.CMD test", POLICY).file, "NPM.CMD");
  assert.throws(() => parseCommand("evil.cmd", POLICY), CommandPolicyError);
});

test("verification command equivalence is argv-exact and platform-scoped", () => {
  for (const launcher of ["npm", "npm.cmd", "npm.ps1"]) {
    assert.equal(
      verificationCommandsEquivalent(
        "npm test -- --runInBand",
        `${launcher} test -- --runInBand`,
        POLICY,
        "win32",
      ),
      true,
    );
  }
  assert.equal(
    verificationCommandsEquivalent("npm test", "npm.cmd run test", POLICY, "win32"),
    false,
  );
  assert.equal(
    verificationCommandsEquivalent(
      "npm test",
      "./npm.cmd test",
      { allowed: [...DEFAULT_ALLOWED_EXECUTABLES, "./npm.cmd"] },
      "win32",
    ),
    false,
  );
  assert.equal(
    verificationCommandsEquivalent(
      "npm test",
      "C:npm.cmd test",
      { allowed: [...DEFAULT_ALLOWED_EXECUTABLES, "C:npm.cmd"] },
      "win32",
    ),
    false,
  );
  assert.equal(
    verificationCommandsEquivalent(
      "npm test",
      "npm.cmd test && echo unsafe",
      POLICY,
      "win32",
    ),
    false,
  );
  assert.equal(
    verificationCommandsEquivalent("npm test", "npm.cmd test", POLICY, "linux"),
    false,
  );
});

test("oversized commands are refused", () => {
  assert.throws(
    () => parseCommand(`npm test ${"x".repeat(MAX_COMMAND_LENGTH)}`, POLICY),
    /exceeds \d+ characters/,
  );
  const manyArgs = `npm ${Array.from({ length: MAX_ARGUMENT_COUNT + 5 }, () => "a").join(" ")}`;
  assert.throws(() => parseCommand(manyArgs, POLICY), /more than \d+ arguments/);
});

test("empty and whitespace-only commands are refused", () => {
  assert.throws(() => parseCommand("", POLICY), /empty/);
  assert.throws(() => parseCommand("    ", POLICY), /empty/);
});

// --- Verification execution -------------------------------------------------

test("a refused command is never executed and is reported as such", async () => {
  const marker = path.join(os.tmpdir(), `sol-luna-injection-${process.pid}.txt`);
  fs.rmSync(marker, { force: true });

  const result = await runVerificationCommand(
    `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'x')" && echo done`,
    process.cwd(),
    { mode: "allowlist" },
  );

  assert.equal(result.execution, "rejected");
  assert.equal(result.passed, false);
  assert.equal(result.exitCode, null);
  assert.match(result.output, /refused by verification policy/);
  assert.equal(fs.existsSync(marker), false, "the command must not have run");
});

test("mode=off runs nothing and says the claim is unverified", async () => {
  const result = await runVerificationCommand("npm test", process.cwd(), { mode: "off" });
  assert.equal(result.execution, "skipped");
  assert.equal(result.passed, false);
  assert.match(result.output, /NOT run/);
});

test("allowlisted commands still execute and report real exit codes", async () => {
  const ok = await runVerificationCommand('node -e "process.exit(0)"', process.cwd(), {
    mode: "allowlist",
  });
  assert.equal(ok.execution, "argv");
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.passed, true);

  const bad = await runVerificationCommand('node -e "process.exit(7)"', process.cwd(), {
    mode: "allowlist",
  });
  assert.equal(bad.exitCode, 7);
  assert.equal(bad.passed, false);
});

test("arguments reach the process intact, without shell mangling", async () => {
  const result = await runVerificationCommand(
    `node -e "console.log(process.argv[1])" "a|b;c&d"`,
    process.cwd(),
    { mode: "allowlist" },
  );
  assert.equal(result.execution, "argv");
  assert.match(result.output, /a\|b;c&d/);
});

test("shell mode is genuinely different, and genuinely opt-in", async () => {
  const chained = 'node -e "process.exit(0)" && node -e "process.exit(0)"';

  // The default refuses the chain outright...
  const guarded = await runVerificationCommand(chained, process.cwd(), {
    mode: "allowlist",
  });
  assert.equal(guarded.execution, "rejected");

  // ...while the opt-in mode really does hand it to a shell. This test exists to
  // document that `shell` removes the protection, not to endorse it.
  const permissive = await runVerificationCommand(chained, process.cwd(), {
    mode: "shell",
  });
  assert.equal(permissive.execution, "shell");
  assert.equal(permissive.exitCode, 0);
});

test("a missing executable fails cleanly with a usable hint", async () => {
  const policy: CommandPolicy = { allowed: ["definitely-not-installed-xyz"] };
  const result = await runVerificationCommand(
    "definitely-not-installed-xyz --version",
    process.cwd(),
    { mode: "allowlist", policy },
  );
  assert.equal(result.passed, false);
  assert.match(result.output, /failed to launch|not in the verification allowlist/);
});

// --- Executable substitution from the workspace -----------------------------

/**
 * Write a script named like an allowlisted tool that announces itself loudly.
 *
 * On Windows the launcher goes through `cmd.exe` for anything that is not a
 * `.exe`, so a `.cmd` is what a worker would actually plant. On POSIX a
 * shebanged, executable file is the equivalent.
 */
function plantImposter(directory: string, name: string, marker: string): void {
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(directory, `${name}.cmd`),
      `@echo off\r\necho ${marker}\r\nexit /b 0\r\n`,
    );
    return;
  }
  const file = path.join(directory, name);
  fs.writeFileSync(file, `#!/bin/sh\necho ${marker}\nexit 0\n`);
  fs.chmodSync(file, 0o755);
}

function prependPath(env: NodeJS.ProcessEnv, entry: string): void {
  const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
  const inherited = pathKeys.map((key) => env[key]).find(Boolean) ?? "";
  for (const key of pathKeys) delete env[key];
  env.PATH = `${entry}${path.delimiter}${inherited}`;
}

test("a file planted in the workspace cannot stand in for an allowlisted tool", async (t) => {
  // SECURITY.md: "a repo-local `./npm` cannot hijack the real one". The lexical
  // check in `parseCommand` only refuses an executable that *spells* a path;
  // the surviving bare name is still resolved by the OS, which searches the
  // working directory first on Windows, and on POSIX whenever PATH contains an
  // entry meaning "here". The working directory is the workspace the worker
  // just wrote to, so without PATH-only resolution this is a live sandbox
  // escape: the planted script runs unsandboxed, as the operator.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-hijack-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  plantImposter(workspace, "npm", "HIJACKED-BY-WORKSPACE");

  const env = { ...process.env };
  // Windows only searches the working directory when this is unset, which is
  // the default state on a real machine; some shells set it. Remove it so the
  // test reproduces the default rather than the incidental configuration.
  delete env.NoDefaultCurrentDirectoryInExePath;
  // The POSIX equivalent of the same exposure.
  prependPath(env, ".");

  const result = await runVerificationCommand("npm --version", workspace, {
    mode: "allowlist",
    timeoutSeconds: 60,
    env,
  });

  assert.doesNotMatch(
    result.output,
    /HIJACKED-BY-WORKSPACE/,
    "the workspace copy must never be the file that runs",
  );
  assert.equal(result.exitCode, 0, result.output);
});

test("a workspace imposter cannot satisfy an operator-added allowlist entry either", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-hijack2-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  plantImposter(workspace, "sol-luna-audit-probe", "HIJACKED-EXTRA-ALLOW");

  const env = { ...process.env };
  delete env.NoDefaultCurrentDirectoryInExePath;
  prependPath(env, ".");

  const result = await runVerificationCommand("sol-luna-audit-probe", workspace, {
    mode: "allowlist",
    timeoutSeconds: 60,
    policy: { allowed: ["sol-luna-audit-probe"] },
    env,
  });

  assert.doesNotMatch(result.output, /HIJACKED-EXTRA-ALLOW/);
  // Nothing on PATH provides it, so this is an honest launch failure rather
  // than a silent fall-through to the workspace copy.
  assert.equal(result.passed, false);
  assert.match(result.output, /failed to launch/);
});

test("Windows .cmd launchers receive arguments verbatim, not as cmd.exe syntax", async (t) => {
  // A `.cmd` on the allowlist is not launched directly: cross-spawn routes it
  // through `cmd.exe /d /s /c`. That is the one place a model-supplied
  // argument meets a real command interpreter, so the Windows expansion and
  // control constructs POSIX metacharacter filtering does not cover — `%VAR%`,
  // `^`, `&`, `|`, `<`, `>`, `(`, `)`, `!` — have to arrive as literal text.
  if (process.platform !== "win32") {
    t.skip("cmd.exe launcher escaping is Windows-only");
    return;
  }
  const toolDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-cmdarg-"));
  t.after(() => fs.rmSync(toolDirectory, { recursive: true, force: true }));
  const tool = "sol-luna-echo-probe";
  // Shaped like the launchers this actually has to survive: every Windows
  // `npm`, `yarn`, `gradle` and `mvn` on the allowlist is a `.cmd` that
  // forwards `%*` to a real program, so the argument is re-parsed by cmd a
  // second time inside the shim. The reporter is a Node script rather than
  // `echo`, because `echo` would show cmd's re-parse of the line rather than
  // the argv the child process was actually handed.
  const reporter = path.join(toolDirectory, "report-argv.cjs");
  fs.writeFileSync(
    reporter,
    `console.log("ARGV=" + JSON.stringify(process.argv.slice(2)));\n`,
  );
  fs.writeFileSync(
    path.join(toolDirectory, `${tool}.cmd`),
    `@echo off\r\nsetlocal\r\nnode "${reporter}" %*\r\nexit /b %errorlevel%\r\n`,
  );

  const env = { ...process.env };
  delete env.NoDefaultCurrentDirectoryInExePath;
  prependPath(env, toolDirectory);
  env.SOL_LUNA_AUDIT_CANARY = "LEAKED-ENV-VALUE";

  const hostile = [
    "%SOL_LUNA_AUDIT_CANARY%",
    "%PATH%",
    "a&echo INJECTED",
    "a|echo INJECTED",
    "a^&echo INJECTED",
    "a>out.txt",
    "a<in.txt",
    "(a)",
  ];

  for (const argument of hostile) {
    // Quoted, so `parseCommand` admits it as one literal argv entry.
    const result = await runVerificationCommand(
      `${tool} "${argument.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
      toolDirectory,
      { mode: "allowlist", timeoutSeconds: 60, policy: { allowed: [tool] }, env },
    );
    assert.equal(result.exitCode, 0, `${argument}: ${result.output}`);
    assert.doesNotMatch(
      result.output,
      /LEAKED-ENV-VALUE/,
      `${argument} was environment-expanded`,
    );
    // The child's whole output must be the single argv line. Anything extra is
    // a second command having run, or a redirect having swallowed part of it —
    // and asserting on the exact line also proves the argument was neither
    // split, re-quoted, nor stripped of its metacharacters on the way through.
    const emitted = result.output
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith("[orchestrator]"));
    assert.deepEqual(
      emitted,
      [`ARGV=${JSON.stringify([argument])}`],
      `${argument} did not arrive as exactly one verbatim argv entry`,
    );
  }

  // Redirection must not have created anything either.
  assert.deepEqual(fs.readdirSync(toolDirectory).sort(), [
    "report-argv.cjs",
    `${tool}.cmd`,
  ]);
});

test("argument forms a cmd.exe launcher cannot carry are refused, not escaped", () => {
  // Pure policy, so both characters are covered from either platform.
  assert.equal(launchesThroughCmd(String.raw`C:\node\npm.cmd`, "win32"), true);
  assert.equal(launchesThroughCmd(String.raw`C:\tools\thing.bat`, "win32"), true);
  assert.equal(launchesThroughCmd(String.raw`C:\node\node.exe`, "win32"), false);
  assert.equal(launchesThroughCmd(String.raw`C:\w\x.COM`, "win32"), false);
  // No cmd layer exists off Windows, so nothing is refused there.
  assert.equal(launchesThroughCmd("/usr/bin/npm", "linux"), false);

  assert.deepEqual(unrepresentableCmdArgument(["--grep", "not slow"]), null);
  assert.deepEqual(unrepresentableCmdArgument(["a&b", "c|d", "%X%", "(e)", "f^g"]), null);
  assert.deepEqual(unrepresentableCmdArgument([String.raw`a" & echo x & "b`]), {
    argument: String.raw`a" & echo x & "b`,
    label: "a double quote",
  });
  assert.deepEqual(unrepresentableCmdArgument(["ok", "!VAR!"]), {
    argument: "!VAR!",
    label: "an exclamation mark",
  });
});

test("a quoted argument cannot break out of a Windows .cmd launcher", async (t) => {
  // The `.cmd` shims that `npm`, `yarn`, `mvn` and `gradle` are on Windows
  // forward their arguments with `%*`, so cmd parses them a second time with
  // the first parse's escaping already consumed. A double quote ends the
  // quoted span there, turning the rest of a model-supplied argument into live
  // cmd syntax. Verified against the real `npm.cmd`: before this was refused,
  // the command below created a file outside the workspace.
  if (process.platform !== "win32") {
    t.skip("cmd.exe launcher re-parsing is Windows-only");
    return;
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-breakout-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const witness = path.join(workspace, "witness.txt");

  const env = { ...process.env };
  delete env.NoDefaultCurrentDirectoryInExePath;

  const result = await runVerificationCommand(
    `npm run "a\\" & echo x > ${witness} & \\"b"`,
    workspace,
    { mode: "allowlist", timeoutSeconds: 120, env },
  );

  assert.equal(result.execution, "rejected");
  assert.equal(result.passed, false);
  assert.match(result.output, /contains a double quote/);
  // A side effect on disk, so no returned text can fake this passing.
  assert.equal(fs.existsSync(witness), false, "an arbitrary command executed");
});

test("verification children are told not to resolve executables from the cwd", () => {
  const { env } = buildVerificationEnv({ PATH: "/usr/bin" }, true);
  // Defence in depth for resolution we do not perform: a `.cmd` shim launched
  // by absolute path still runs under cmd.exe, which would otherwise resolve
  // its own commands from the workspace.
  assert.equal(env.NoDefaultCurrentDirectoryInExePath, "1");
});

test("credential-shaped environment variables are withheld", () => {
  const { env, scrubbed } = buildVerificationEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      OPENAI_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp_secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      DB_PASSWORD: "hunter2",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      NODE_ENV: "test",
    },
    true,
  );

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.SSH_AUTH_SOCK, "/tmp/agent.sock", "known-safe exception kept");

  for (const secret of [
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "DB_PASSWORD",
  ]) {
    assert.equal(env[secret], undefined, `${secret} must not be passed through`);
    assert.ok(scrubbed.includes(secret));
  }
});

test("environment scrubbing can be disabled deliberately", () => {
  const { env, scrubbed } = buildVerificationEnv({ OPENAI_API_KEY: "sk-x" }, false);
  assert.equal(env.OPENAI_API_KEY, "sk-x");
  assert.deepEqual(scrubbed, []);
});

// --- Operator configuration -------------------------------------------------

test("an unrecognised LUNA_SANDBOX narrows confinement rather than widening it", () => {
  for (const valid of ["read-only", "workspace-write", "danger-full-access"]) {
    assert.equal(parseWorkerSandbox(valid), valid);
    assert.equal(workerSandboxInvalid(valid), false);
  }
  // Case and surrounding whitespace are operator typos, not different modes.
  assert.equal(parseWorkerSandbox(" Workspace-Write "), "workspace-write");
  assert.equal(workerSandboxInvalid(" Workspace-Write "), false);

  // Unset keeps the documented default, so configuring nothing changes nothing.
  assert.equal(parseWorkerSandbox(undefined), "workspace-write");
  assert.equal(workerSandboxInvalid(undefined), false);

  // An unreadable value must never resolve to something more permissive than
  // the operator may have meant: `readonly` is a plausible typo for
  // `read-only`, and silently granting write access to a worker instead is the
  // one outcome that cannot be noticed by reading the failure.
  for (const invalid of ["readonly", "workspace_write", "full-access", "", "1", "off"]) {
    assert.equal(workerSandboxInvalid(invalid), true, invalid);
    assert.equal(parseWorkerSandbox(invalid), "read-only", invalid);
  }
});

test("an unrecognised SOL_LUNA_KEEP_WORKTREES is reported instead of silently retaining", () => {
  assert.equal(parseKeepWorktrees(undefined), "onfailure");
  assert.equal(keepWorktreesInvalid(undefined), false);
  for (const [raw, expected] of [
    ["always", "always"],
    ["Never", "never"],
    [" onFailure ", "onfailure"],
  ] as const) {
    assert.equal(parseKeepWorktrees(raw), expected);
    assert.equal(keepWorktreesInvalid(raw), false);
  }
  // `no` and `false` read as "never" to a human but matched neither branch, so
  // worktrees full of worker output were retained on every failure in silence.
  for (const invalid of ["no", "false", "0", "on-failure", "yes"]) {
    assert.equal(keepWorktreesInvalid(invalid), true, invalid);
    assert.equal(parseKeepWorktrees(invalid), "onfailure", invalid);
  }
});

// --- Log integrity ----------------------------------------------------------

test("model-supplied text cannot forge log lines", () => {
  const forged =
    "harmless objective\n2026-01-01T00:00:00Z [sol-luna-orchestrator] done: verdict=PASS";
  const safe = sanitizeForLog(forged);

  assert.ok(!safe.includes("\n"), "newlines must not survive into the log");
  assert.ok(!safe.includes("\r"));
  assert.ok(safe.includes("harmless objective"), "legitimate text is preserved");
  assert.equal(sanitizeForLog("a\tb\u0000c\u007fd"), "a b c d");
});

// --- Workspace boundary -----------------------------------------------------

/** Simulate a symlink without needing filesystem privileges. */
function fakeResolver(links: Record<string, string>): RealPathResolver {
  return (target) => {
    const normalized = path.resolve(target);
    for (const [from, to] of Object.entries(links)) {
      const fromResolved = path.resolve(from);
      if (normalized === fromResolved) return path.resolve(to);
      const relative = path.relative(fromResolved, normalized);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return path.resolve(to, relative);
      }
    }
    return normalized;
  };
}

const WORKSPACE = path.resolve("/repo");

test("a symlinked file escaping the workspace is caught", () => {
  const resolver = fakeResolver({
    [path.resolve(WORKSPACE, "src/escape.ts")]: path.resolve("/etc/passwd"),
  });

  const resolved = resolvePath("src/escape.ts", WORKSPACE, resolver);
  assert.equal(resolved.outside, true);

  const violations = findScopeViolations(
    ["src/escape.ts"],
    ["src/**"],
    [],
    WORKSPACE,
    resolver,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /outside the workspace/);
});

test("a symlinked directory escaping the workspace is caught", () => {
  const resolver = fakeResolver({
    [path.resolve(WORKSPACE, "src/vendor")]: path.resolve("/opt/other"),
  });

  const violations = findScopeViolations(
    ["src/vendor/lib.ts"],
    ["src/**"],
    [],
    WORKSPACE,
    resolver,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /outside the workspace/);
});

test("a symlinked workspace root does not produce false positives", () => {
  // e.g. /tmp -> /private/tmp on macOS: both sides must normalise the same way.
  const resolver = fakeResolver({ [WORKSPACE]: path.resolve("/private/repo") });
  const violations = findScopeViolations(
    ["src/a.ts"],
    ["src/**"],
    [],
    WORKSPACE,
    resolver,
  );
  assert.deepEqual(violations, []);
});

test("symlinks inside the workspace are matched at their real location", () => {
  const resolver = fakeResolver({
    [path.resolve(WORKSPACE, "src/link.ts")]: path.resolve(WORKSPACE, "secrets/real.ts"),
  });
  const violations = findScopeViolations(
    ["src/link.ts"],
    ["src/**"],
    [],
    WORKSPACE,
    resolver,
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /secrets\/real\.ts \(outside allowedFiles\)/);
});

test("traversal via .. is caught regardless of allowlist breadth", () => {
  for (const attempt of [
    "../outside.ts",
    "src/../../outside.ts",
    "src/../../../etc/hosts",
  ]) {
    const violations = findScopeViolations([attempt], ["**"], [], WORKSPACE);
    assert.equal(violations.length, 1, `${attempt} should be a violation`);
    assert.match(violations[0] ?? "", /outside the workspace/);
  }
});

// --- Protected control metadata ---------------------------------------------

const CONTROL_PATHS = [
  ".git",
  ".git/config",
  ".git/hooks/pre-commit",
  ".sol-luna",
  ".sol-luna/worktrees/b-1/x.ts",
  "vendor/dep/.git/config",
  "fixtures/repo/.git/hooks/post-checkout",
  "packages/a/.sol-luna/state.json",
];

test("repository and orchestrator control metadata is a violation under any allowlist", () => {
  // The invariant: `allowedFiles` grants nothing here. A caller declaring the
  // broadest possible scope, or naming the path outright, still cannot
  // authorize a worker to write a git hook that runs on the operator's next
  // commit, or to edit the lease state this runtime later trusts.
  for (const declared of [
    [] as string[], // empty allowlist means "unrestricted within the workspace"
    ["**"],
    ["**/*"],
    [".git/**", ".sol-luna/**"], // named outright
    ["**/.git/**"],
  ]) {
    const violations = findScopeViolations(CONTROL_PATHS, declared, [], WORKSPACE);
    assert.equal(
      violations.length,
      CONTROL_PATHS.length,
      `allowedFiles ${JSON.stringify(declared)} must not authorize any control path`,
    );
    for (const violation of violations) {
      assert.match(violation, /protected repository or orchestrator control metadata/);
    }
  }
});

test("control-path protection outranks allowedFiles but not the workspace boundary", () => {
  // Precedence is observable in the reported reason, which is what the parent
  // reads. An escape is still reported as an escape.
  assert.match(
    findScopeViolations([".git/config"], ["**"], [], WORKSPACE)[0] ?? "",
    /protected repository or orchestrator control metadata/,
  );
  assert.match(
    findScopeViolations(["../.git/config"], ["**"], [], WORKSPACE)[0] ?? "",
    /outside the workspace/,
  );
});

test("control-path protection does not catch ordinary files that merely look similar", () => {
  // Over-matching here would break real work: these are normal tracked files.
  const ordinary = [
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".github/workflows/ci.yml",
    "src/.gitkeep",
    "src/git/index.ts",
    "docs/git-workflow.md",
    "sol-luna.config.ts",
    "src/sol-luna/client.ts",
  ];
  assert.deepEqual(findScopeViolations(ordinary, ["**"], [], WORKSPACE), []);
  // And with no allowlist at all, which is the permissive default.
  assert.deepEqual(findScopeViolations(ordinary, [], [], WORKSPACE), []);
});

test("a parallel worktree's own files are never read as orchestrator control state", () => {
  // Scope is always resolved against the *task's* workspace. A parallel task
  // runs inside `.sol-luna/worktrees/<id>/`, so its files are `src/x.ts` and
  // not `.sol-luna/...`. If that were not true, protecting `.sol-luna` would
  // have made every parallel task fail its own scope check.
  const worktree = path.join(WORKSPACE, ".sol-luna", "worktrees", "b-1");
  const resolver: RealPathResolver = (target) => path.resolve(target);
  assert.deepEqual(
    findScopeViolations(["src/x.ts", "README.md"], ["**"], [], worktree, resolver),
    [],
  );
  // The same file named from the repository root is control state, and is
  // refused — that is the direction the protection is for.
  assert.match(
    findScopeViolations(
      [".sol-luna/worktrees/b-1/src/x.ts"],
      ["**"],
      [],
      WORKSPACE,
      resolver,
    )[0] ?? "",
    /protected repository or orchestrator control metadata/,
  );
});

test("a single delegation that writes a git hook fails on protected control metadata", async (t) => {
  // The end-to-end shape for the surface that can actually reach it. A single
  // delegation runs in the repository root, where `.git` is a real directory —
  // unlike a parallel worktree, where `.git` is a file and the write fails for
  // unrelated reasons. `allowedFiles: ["**"]` is the broadest grant a caller
  // can make, and it still does not authorize this.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-control-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "real.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");

  const input = delegateTaskInputSchema.parse({
    objective: "Do a bounded piece of work in the assigned module.",
    effortReason: "Bounded implementation work.",
    acceptanceCriteria: ["It works."],
    allowedFiles: ["**"],
  });

  const result = buildDelegationResult({
    input,
    workingDirectory: repo,
    observed: {
      threadId: "thread-control",
      finalResponse: JSON.stringify({
        status: "PASS",
        failureCauses: [],
        summary: "did the work",
        filesChanged: [{ path: "src/real.ts", change: "modified", why: "work" }],
        verification: [],
        notes: "",
        followUps: [],
      }),
      // What the runtime actually saw, which is what decides scope.
      filesChanged: [
        { path: "src/real.ts", kind: "update" },
        { path: ".git/hooks/pre-commit", kind: "update" },
      ],
      errors: [],
      usage: null,
      timedOut: false,
      cancelled: false,
      termination: "completed",
      terminationMessage: null,
    },
    orchestratorRuns: [],
    durationSeconds: 1,
  });

  assert.ok(
    result.scopeViolations.some((violation) =>
      /^\.git\/hooks\/pre-commit \(protected repository or orchestrator control metadata\)$/.test(
        violation,
      ),
    ),
    `expected a protected-path violation, got ${JSON.stringify(result.scopeViolations)}`,
  );
  // Reported truthfully through the existing evidence channels, not a new one.
  assert.equal(result.verdict, "FAILED");
  assert.equal(result.trustworthy, false);
  assert.ok(result.discrepancies.some((entry) => /scope was violated/i.test(entry)));
  // The in-scope edit is still reported as the ordinary change it is.
  assert.deepEqual(
    result.scopeViolations.filter((violation) => violation.startsWith("src/")),
    [],
  );
});

test("nested repository, submodule-like, and nested orchestrator metadata stay protected on disk", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-nested-control-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "vendor", "submodule", ".git"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "fixtures", "nested", ".sol-luna"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(workspace, "vendor", "submodule", ".git", "config"),
    "[core]\n",
  );
  fs.writeFileSync(
    path.join(workspace, "fixtures", "nested", ".sol-luna", "state.json"),
    "{}\n",
  );

  const violations = findScopeViolations(
    [
      "vendor/submodule/.git/config",
      "fixtures/nested/.sol-luna/state.json",
      "ordinary.ts",
    ],
    ["**"],
    [],
    workspace,
  );

  assert.equal(violations.length, 2);
  assert.ok(violations.some((entry) => entry.startsWith("vendor/submodule/.git/")));
  assert.ok(violations.some((entry) => entry.startsWith("fixtures/nested/.sol-luna/")));
});

test("a worktree .git file is still metadata while its internal worktree root remains usable", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-worktree-control-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, ".sol-luna", "worktrees", "task-1");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(
    path.join(worktree, ".git"),
    "gitdir: /repository/.git/worktrees/task-1\n",
  );

  assert.throws(() => resolveWorkspace(worktree, [root]), /control metadata/);
  assert.equal(
    resolveWorkspace(worktree, [root], undefined, { allowInternalWorktree: true }),
    fs.realpathSync.native(worktree),
  );
  const violations = findScopeViolations([".git", ".git/index"], ["**"], [], worktree);
  assert.equal(violations.length, 2);
  assert.ok(
    violations.every((entry) =>
      /protected repository or orchestrator control metadata/.test(entry),
    ),
  );
});

test("a workspace rooted at repository or orchestrator metadata is rejected", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-root-control-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "nested", ".sol-luna"), { recursive: true });

  // Before this guard, changing the workspace to `.git` or nested `.sol-luna`
  // made their contents appear as ordinary relative files and bypassed the
  // protected-path matcher entirely.
  assert.throws(
    () => resolveWorkspace(path.join(root, ".git"), [root]),
    /control metadata/,
  );
  assert.throws(
    () => resolveWorkspace(path.join(root, "nested", ".sol-luna"), [root]),
    /control metadata/,
  );
});

test("parent repository metadata cannot be reached after workspace canonicalization", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-parent-repo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const workspace = path.join(repository, "packages", "child");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  const resolved = resolveWorkspace(`${workspace}${path.sep}..${path.sep}child`, [root]);
  assert.equal(resolved, fs.realpathSync.native(workspace));
  const violations = findScopeViolations(["../../.git/config"], ["**"], [], resolved);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /outside the workspace/);
});

test("a metadata symlink cannot be renamed into an ordinary in-workspace path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-control-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "ordinary"), { recursive: true });

  try {
    fs.symlinkSync(
      path.join(workspace, "ordinary"),
      path.join(workspace, ".git"),
      "junction",
    );
  } catch {
    t.skip("directory junction creation not permitted on this machine");
    return;
  }

  const violations = findScopeViolations([".git/config"], ["**"], [], workspace);
  assert.equal(violations.length, 1);
  assert.match(
    violations[0] ?? "",
    /protected repository or orchestrator control metadata/,
  );
});

test("absolute paths outside the workspace are caught", () => {
  const outside = process.platform === "win32" ? "C:\\Windows\\x.ts" : "/etc/hosts";
  const violations = findScopeViolations([outside], ["**"], [], WORKSPACE);
  assert.equal(violations.length, 1);
});

// --- Workspace resolution ---------------------------------------------------

test("workingDirectory must be absolute and exist", () => {
  assert.throws(() => resolveWorkspace("relative/path"), WorkspaceError);
  assert.throws(
    () => resolveWorkspace(path.resolve(os.tmpdir(), "sol-luna-does-not-exist-xyz")),
    WorkspaceError,
  );
});

test("workingDirectory must be a directory, not a file", () => {
  const file = path.join(os.tmpdir(), `sol-luna-file-${process.pid}.txt`);
  fs.writeFileSync(file, "x");
  try {
    assert.throws(() => resolveWorkspace(file), /not a directory/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("allowed roots confine where a worker may run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-root-"));
  const inside = path.join(root, "project");
  fs.mkdirSync(inside);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-outside-"));

  try {
    assert.equal(resolveWorkspace(inside, [root]), fs.realpathSync.native(inside));
    assert.equal(resolveWorkspace(root, [root]), fs.realpathSync.native(root));
    assert.throws(() => resolveWorkspace(outside, [root]), /outside the roots/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("with no allowed roots configured, any existing directory is accepted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-any-"));
  try {
    assert.equal(resolveWorkspace(dir, []), fs.realpathSync.native(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Real filesystem symlink check (skipped where unsupported) --------------

test("real symlink escape is caught on disk", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-link-"));
  const workspace = path.join(root, "workspace");
  const secret = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, "secret.txt"), "classified");

  const linkPath = path.join(workspace, "leak.txt");
  try {
    fs.symlinkSync(path.join(secret, "secret.txt"), linkPath, "file");
  } catch {
    // Windows needs Developer Mode or elevation for symlinks.
    t.skip("symlink creation not permitted on this machine");
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }

  try {
    const violations = findScopeViolations(["leak.txt"], ["**"], [], workspace);
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /outside the workspace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real directory symlink escape is caught on disk", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-dir-link-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);

  const linkPath = path.join(workspace, "vendor");
  try {
    fs.symlinkSync(outside, linkPath, "dir");
  } catch {
    t.skip("directory symlink creation not permitted on this machine");
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }

  try {
    const violations = findScopeViolations(
      ["vendor/new-file.txt"],
      ["**"],
      [],
      workspace,
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /outside the workspace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POSIX verification timeout kills a spawned process-group descendant", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-process-group-"));
  const childScript = path.join(root, "child.js");
  const parentScript = path.join(root, "parent.js");
  const pidPath = path.join(root, "child.pid");
  const heartbeatPath = path.join(root, "heartbeat.txt");

  fs.writeFileSync(
    childScript,
    `const fs = require("node:fs");\n` +
      `setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeatPath)}, "x"), 25);\n`,
    "utf8",
  );
  fs.writeFileSync(
    parentScript,
    `const fs = require("node:fs");\n` +
      `const { spawn } = require("node:child_process");\n` +
      `const child = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "ignore" });\n` +
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));\n` +
      `setInterval(() => {}, 10000);\n`,
    "utf8",
  );

  try {
    const result = await runVerificationCommand(`node ${parentScript}`, root, {
      timeoutSeconds: 1,
    });
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, null);
    assert.match(result.output, /timed out after 1s/);

    const childPid = Number(fs.readFileSync(pidPath, "utf8"));
    assert.ok(Number.isInteger(childPid) && childPid > 0);

    const deadline = Date.now() + 3_000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        alive = false;
        break;
      }
    }
    assert.equal(alive, false, `descendant process ${childPid} survived timeout`);

    const heartbeatSize = fs.statSync(heartbeatPath).size;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      fs.statSync(heartbeatPath).size,
      heartbeatSize,
      "descendant kept writing after process-group termination",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explorer strictly enforces read-only: observed edits cause contract discrepancy and failure", () => {
  const input = {
    target: "Investigate authentication module structure",
    effort: "high" as const,
    effortReason: "detailed inspection of auth flow",
    scope: ["src/auth/**"],
    forbiddenFiles: [],
    questions: ["How are tokens signed?"],
    resultDetail: "handoff" as const,
  };
  const observed = {
    threadId: "thread-exp-security",
    finalResponse: JSON.stringify({
      status: "PASS",
      summary: "I investigated auth and modified a helper file.",
      observedFacts: [],
      inferences: [],
      unknowns: [],
      relevantFiles: [{ path: "src/auth/helper.ts", why: "modified" }],
      recommendedSeams: [],
      notes: "",
    }),
    filesChanged: [{ path: "src/auth/helper.ts", kind: "modified" }],
    errors: [],
    usage: null,
    timedOut: false,
    cancelled: false,
    termination: "completed" as const,
    terminationMessage: null,
  };

  const result = buildExploreResult({
    input,
    workingDirectory: process.cwd(),
    observed,
    durationSeconds: 2,
  });

  assert.equal(result.verdict, "FAILED");
  assert.equal(result.trustworthy, false);
  assert.ok(
    result.discrepancies.some((d: string) => /Change intent contract violated/i.test(d)),
  );
});
