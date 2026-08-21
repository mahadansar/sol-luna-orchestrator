/**
 * The isolated CODEX_HOME a live benchmark parent session runs against.
 *
 * Why this exists. The harness used to start the supervisor with nothing but a
 * `--config` overlay, so Codex resolved `mcp_servers.<name>` from the *user's*
 * `~/.codex/config.toml`. On a machine where that entry points at the globally
 * installed npm package, the benchmark measured a build nobody asked it to
 * measure: a width-12 run recorded `maxParallelConfigured: 12` while the batch
 * that actually ran was clamped to 8, because the package on disk was v0.7.0
 * with `MAX_PARALLEL_LIMIT = 8` and the branch under test allows 20. The overlay
 * delivered `SOL_LUNA_MAX_PARALLEL` correctly; what an overlay cannot do is
 * change which binary Codex launches.
 *
 * So the harness owns the registration now. It writes its own CODEX_HOME whose
 * `mcp_servers.<name>` table is generated here, pointing at this repository's
 * own `dist/server.js`, through the same `applyInitConfig` the shipped `init`
 * command uses — so the benchmark's Codex settings cannot drift from the
 * product's, and `tool_timeout_sec` / `default_tools_approval_mode` come from
 * `REQUIRED_SETTINGS` rather than from a second copy of those values.
 *
 * Everything else in the user's config is carried over verbatim, minus that one
 * table. That is deliberate rather than lazy: the parent session's other MCP
 * servers, the Windows sandbox mode and the project trust levels are part of the
 * environment every previous benchmark measured, and dropping them would change
 * what a run means far more than the bug being fixed here. The user's file is
 * only ever read. Every write goes to the benchmark home, which must be a
 * different directory — see {@link prepareBenchCodexHome}.
 *
 * Nothing here falls back to an installed package. A missing or non-local build
 * is an error, because a benchmark that quietly measures the wrong server is
 * worse than a benchmark that did not run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyInitConfig } from "../cli/init.js";
import {
  codexConfigPath,
  codexHome,
  installLocation,
  packageVersion,
} from "../cli/paths.js";
import {
  REQUIRED_SETTINGS,
  SERVER_NAME,
  inspectSettings,
  serverEnvTable,
  serverTable,
  settingsSatisfied,
} from "../cli/settings.js";
import {
  detectNewline,
  findTable,
  readKey,
  removeTable,
  toTomlValue,
  upsertKey,
} from "../cli/toml-edit.js";
import { MAX_PARALLEL_LIMIT } from "../config.js";

/** This package's name, used to prove the resolved build is actually ours. */
export const PACKAGE_NAME = "sol-luna-orchestrator";

/** The MCP server the benchmark will register, with enough detail to prove it. */
export interface BenchMcpServer {
  /** Absolute path Codex will launch. */
  entry: string;
  /** Content hash of that file, so a stale build is provable after the fact. */
  sha256: string;
  modifiedAt: string;
  packageRoot: string;
  packageVersion: string;
  /**
   * The hard concurrency ceiling compiled into this build. Recorded because it
   * is the single number that distinguishes the branch under test from the
   * published package that produced the misleading width-12 run.
   */
  maxParallelLimit: number;
}

/** What the isolated registration ended up being, recorded per run. */
export interface BenchMcpProvenance extends BenchMcpServer {
  codexHome: string;
  configPath: string;
  configSha256: string;
  toolTimeoutSec: string | null;
  approvalMode: string | null;
  /** `SOL_LUNA_MAX_PARALLEL` written into the server's env; null when solo. */
  maxParallel: number | null;
  /** Whether the server is reachable at all in this arm. */
  serverEnabled: boolean;
  /** Always true: the harness never runs against the user's registration. */
  isolated: true;
}

export interface BenchCodexSession {
  home: string;
  configPath: string;
  provenance: BenchMcpProvenance;
  /** Environment for the Codex CLI child process, CODEX_HOME included. */
  env: Record<string, string>;
}

const sha256File = (file: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const posix = (value: string): string => value.replace(/\\/g, "/");

/**
 * Whether a path lives inside a `node_modules` tree.
 *
 * An installed package — global, local, or an `npx` cache — always does; a
 * working repository does not. This is the check that makes "the current local
 * repository" a testable claim rather than an intention.
 */
export const isPackageInstall = (entry: string): boolean =>
  posix(entry).toLowerCase().includes("/node_modules/");

/** A resolved server path, described so it can be judged without touching disk. */
export interface ServerCandidate {
  entry: string;
  exists: boolean;
  packageRoot: string;
  packageName: string | null;
  /** True when the package root still contains the TypeScript sources. */
  hasSources: boolean;
}

/**
 * Refuse anything that is not this repository's own build.
 *
 * Every failure names what to do about it and none of them offer a fallback:
 * the globally installed package is exactly what this module exists to stop the
 * benchmark from measuring, so "use it instead" is never the remedy.
 */
export function assertLocalServer(candidate: ServerCandidate): void {
  if (isPackageInstall(candidate.entry)) {
    throw new Error(
      `Benchmark MCP server resolved to an installed package: ${candidate.entry}\n` +
        `The benchmark must run this repository's own build. Run the harness from ` +
        `the repository (npm run bench), not from an installed copy. The globally ` +
        `installed sol-luna-orchestrator is never used as a fallback.`,
    );
  }

  if (candidate.packageName !== PACKAGE_NAME) {
    throw new Error(
      `Benchmark MCP server resolved outside ${PACKAGE_NAME}: ${candidate.packageRoot} ` +
        `declares ${candidate.packageName ?? "no package name"}.`,
    );
  }

  if (!candidate.hasSources) {
    throw new Error(
      `Benchmark MCP server at ${candidate.entry} has no sources beside it ` +
        `(${path.join(candidate.packageRoot, "src", "server.ts")} is missing), so it ` +
        `is not the current local repository. Run the harness from a checkout.`,
    );
  }

  if (!candidate.exists) {
    throw new Error(
      `Benchmark MCP server not built: ${candidate.entry} does not exist.\n` +
        `Run: npm run build\n` +
        `The benchmark will not fall back to an installed sol-luna-orchestrator.`,
    );
  }
}

/**
 * The local build the benchmark will register, or an error.
 *
 * Resolution is `installLocation()`, the same walk `init` and `doctor` use, so
 * the benchmark cannot end up pointing somewhere those two would not.
 */
export function resolveBenchMcpServer(): BenchMcpServer {
  const location = installLocation();

  let packageName: string | null = null;
  try {
    const raw = fs.readFileSync(path.join(location.root, "package.json"), "utf8");
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    packageName = typeof name === "string" ? name : null;
  } catch {
    packageName = null;
  }

  assertLocalServer({
    entry: location.serverEntry,
    exists: location.serverEntryExists,
    packageRoot: location.root,
    packageName,
    hasSources: fs.existsSync(path.join(location.root, "src", "server.ts")),
  });

  return {
    entry: location.serverEntry,
    sha256: sha256File(location.serverEntry),
    modifiedAt: fs.statSync(location.serverEntry).mtime.toISOString(),
    packageRoot: location.root,
    packageVersion: packageVersion(),
    maxParallelLimit: MAX_PARALLEL_LIMIT,
  };
}

/**
 * Where the benchmark's own Codex home lives.
 *
 * Beside the user's, not inside it, and outside the repository — so the
 * credential copy below is never anywhere near a commit. Stable rather than
 * per-run, so repeated benchmarks reuse one directory instead of leaving a
 * trail of copied auth tokens.
 *
 * Deliberately not under the OS temp tree. Codex 0.147.0 refuses to create its
 * PATH-alias helper binaries when CODEX_HOME is inside temp — it warns and
 * carries on, but a benchmark should not run in a degraded sandbox setup that
 * the user's own sessions do not have.
 */
export function benchCodexHome(): string {
  const override = process.env.BENCH_CODEX_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".codex-sol-luna-bench");
}

export interface BenchConfigInput {
  /** The user's config text, carried over verbatim apart from our own table. */
  baseConfig: string;
  /** Interpreter Codex launches the server with. */
  command: string;
  serverEntry: string;
  logPath: string;
  eventsPath: string;
  /**
   * Concurrency for this arm, written into the server's environment. `null` is
   * a solo arm: the server is disabled outright, exactly as before.
   */
  maxParallel: number | null;
}

/**
 * Says what this file is to anyone who finds it. No timestamp and no run id, so
 * two identical arms still produce an identical `configSha256`.
 */
const BANNER = [
  "# Generated by the sol-luna-orchestrator benchmark harness (src/bench/codex-home.ts).",
  "# Disposable: every arm rewrites it. The user's own Codex config is never written.",
  "# The orchestrator entry below is this repository's build, never an installed package.",
];

/**
 * Produce the isolated config text. Pure, so what the benchmark registers can
 * be asserted without a Codex install and without a live run.
 */
export function buildBenchConfig(input: BenchConfigInput): string {
  const newline = detectNewline(input.baseConfig);

  // Drop a banner left by an earlier generation, so rebuilding from a previous
  // benchmark config does not stack them.
  let text = input.baseConfig
    .split(/\r?\n/)
    .filter((line) => !BANNER.includes(line))
    .join(newline)
    .replace(/^(\r?\n)+/, "");

  // Remove the user's registration next — header, keys and the `.env`
  // sub-table — so no value from an installed package can survive into the
  // benchmark's own table by being merged with it.
  text = removeTable(text, serverTable());

  text = applyInitConfig(text, {
    command: input.command,
    serverEntry: input.serverEntry,
    logPath: input.logPath,
    eventsPath: input.eventsPath,
    forceLogPath: true,
    forceEventsPath: true,
  });

  // Written explicitly on every arm rather than only when disabling, so a solo
  // arm's `enabled = false` can never be left behind for a delegating one.
  text = upsertKey(text, serverTable(), "enabled", input.maxParallel !== null, {
    comment: ["Solo benchmark arms cannot reach the server at all."],
  });

  if (input.maxParallel !== null) {
    text = upsertKey(
      text,
      serverEnvTable(),
      "SOL_LUNA_MAX_PARALLEL",
      String(input.maxParallel),
      { comment: ["Set by the benchmark from the fixture's stream count."] },
    );
  }

  return [...BANNER, "", text].join(newline);
}

/**
 * Check a rendered benchmark config actually says what it must.
 *
 * Run against the generated text and again against the file after writing it,
 * because "the isolated configuration could not be established" has to be an
 * error before a single token is spent rather than a surprise in the results.
 */
export function assertBenchConfig(text: string, input: BenchConfigInput): void {
  const table = findTable(text, serverTable());
  if (table === null) {
    throw new Error(
      `Benchmark config does not register "${SERVER_NAME}"; refusing to run ` +
        `against the user's global registration.`,
    );
  }

  const args = readKey(text, serverTable(), "args");
  if (args !== toTomlValue([input.serverEntry])) {
    throw new Error(
      `Benchmark config points at ${args ?? "nothing"}, expected ` +
        `${toTomlValue([input.serverEntry])}.`,
    );
  }

  const command = readKey(text, serverTable(), "command");
  if (command !== toTomlValue(input.command)) {
    throw new Error(
      `Benchmark config launches ${command ?? "nothing"}, expected ` +
        `${toTomlValue(input.command)}.`,
    );
  }

  // Scoped to our own table: the user's other MCP servers legitimately live in
  // node_modules, and carrying those over is intended.
  const body = text.split(/\r?\n/).slice(table.start, table.end).join("\n");
  if (/node_modules/i.test(body)) {
    throw new Error(
      `Benchmark registration for "${SERVER_NAME}" still names a node_modules ` +
        `install:\n${body}`,
    );
  }

  const settings = inspectSettings(text);
  if (!settingsSatisfied(settings)) {
    const wrong = settings
      .filter((setting) => setting.required && setting.state !== "ok")
      .map(
        (setting) =>
          `${setting.key}=${setting.actual ?? "missing"} (want ${setting.expected})`,
      );
    throw new Error(
      `Benchmark config is missing required Codex settings: ${wrong.join(", ")}`,
    );
  }

  const configured = readKey(text, serverEnvTable(), "SOL_LUNA_MAX_PARALLEL");
  const expected =
    input.maxParallel === null ? null : toTomlValue(String(input.maxParallel));
  if (configured !== expected) {
    throw new Error(
      `Benchmark config sets SOL_LUNA_MAX_PARALLEL=${configured ?? "nothing"}, ` +
        `expected ${expected ?? "nothing"}.`,
    );
  }
}

/**
 * Environment for the Codex CLI child.
 *
 * The SDK stops inheriting `process.env` once `env` is given, so the parent's
 * environment is passed through wholesale and only CODEX_HOME is changed. Any
 * differently-cased CODEX_HOME is dropped first: Windows environment names are
 * case-insensitive, and two spellings in one block is not worth the gamble.
 */
export function benchEnv(
  home: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (/^codex_home$/i.test(key)) continue;
    env[key] = value;
  }
  env.CODEX_HOME = home;
  return env;
}

/**
 * Copy the user's Codex credentials into the benchmark home.
 *
 * Required: an isolated CODEX_HOME has no auth of its own, and a live run
 * against one without credentials fails only after the harness has started
 * spending. Copied on every arm rather than once, so a token refreshed during a
 * long benchmark cannot go stale in the copy. The copy is the only thing
 * written; the user's own `auth.json` is read and never modified.
 */
function ensureAuth(userHome: string, home: string): void {
  const source = path.join(userHome, "auth.json");
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(home, "auth.json"));
    return;
  }
  if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) return;

  throw new Error(
    `No Codex credentials for the benchmark's isolated CODEX_HOME: ${source} does ` +
      `not exist and neither CODEX_API_KEY nor OPENAI_API_KEY is set.\n` +
      `Run: codex login`,
  );
}

/**
 * Establish the isolated home for one arm and return how to reach it.
 *
 * Called per arm because `SOL_LUNA_MAX_PARALLEL` and whether the server is
 * enabled at all are per-arm facts. Writing the whole table each time also
 * means an arm can never inherit the previous arm's concurrency.
 */
export function prepareBenchCodexHome(input: {
  eventsPath: string;
  maxParallel: number | null;
}): BenchCodexSession {
  const server = resolveBenchMcpServer();
  const home = benchCodexHome();
  const userHome = codexHome();

  if (path.resolve(home).toLowerCase() === path.resolve(userHome).toLowerCase()) {
    throw new Error(
      `The benchmark CODEX_HOME (${home}) is the user's own Codex home. The ` +
        `harness writes that directory, so it must be a separate one. Unset ` +
        `BENCH_CODEX_HOME or point it somewhere else.`,
    );
  }

  fs.mkdirSync(home, { recursive: true });

  const userConfigPath = codexConfigPath();
  const configInput: BenchConfigInput = {
    // Read, never written. A machine with no Codex config at all starts empty.
    baseConfig: fs.existsSync(userConfigPath)
      ? fs.readFileSync(userConfigPath, "utf8")
      : "",
    command: process.execPath,
    serverEntry: server.entry,
    logPath: path.join(home, "sol-luna-orchestrator.log"),
    eventsPath: input.eventsPath,
    maxParallel: input.maxParallel,
  };

  const text = buildBenchConfig(configInput);
  assertBenchConfig(text, configInput);

  const configPath = path.join(home, "config.toml");
  fs.writeFileSync(configPath, text, "utf8");

  // Verify the file Codex will actually read, not the string we meant to write.
  const written = fs.readFileSync(configPath, "utf8");
  assertBenchConfig(written, configInput);

  ensureAuth(userHome, home);

  return {
    home,
    configPath,
    env: benchEnv(home),
    provenance: {
      ...server,
      codexHome: home,
      configPath,
      configSha256: sha256File(configPath),
      toolTimeoutSec: readKey(written, serverTable(), "tool_timeout_sec"),
      approvalMode: readKey(written, serverTable(), "default_tools_approval_mode"),
      maxParallel: input.maxParallel,
      serverEnabled: input.maxParallel !== null,
      isolated: true,
    },
  };
}

/** The Codex settings the benchmark depends on, for printing before a run. */
export const requiredSettingSummary = (): string =>
  REQUIRED_SETTINGS.filter((setting) => setting.required)
    .map((setting) => `${setting.key}=${setting.expected}`)
    .join(" ");
