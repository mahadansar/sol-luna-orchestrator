import fs from "node:fs";
import path from "node:path";
import {
  codexAuthPresent,
  codexVersion,
  getRegisteredServer,
  gitVersion,
  readConfig,
} from "./codex.js";
import { describeEventsSource, resolveEventsPath } from "./events-path.js";
import {
  codexConfigPath,
  installLocation,
  minimumNode,
  packageVersion,
} from "./paths.js";
import {
  discoveryHintPath,
  inspectDiscoveryHint,
  readDiscoveryInstructions,
} from "./discovery-hint.js";
import { describeComputePolicy } from "../policy.js";
import { SERVER_NAME, inspectSettings, serverTable } from "./settings.js";
import { findTable, fromTomlValue, readKey } from "./toml-edit.js";
import { resolveRegisteredServerConfig } from "./server-config.js";
import { bold, dim, errOut, out, symbols } from "./ui.js";

/**
 * Diagnose an installation without spending a single model call.
 *
 * Every check reports what it found, what it expected, and the one command that
 * fixes it. A diagnostic that only says "broken" makes the user do the work
 * twice.
 */

export type CheckStatus = "ok" | "fail" | "warn";

export interface Check {
  name: string;
  status: CheckStatus;
  detail?: string;
  expected?: string;
  remedy?: string;
}

export interface DoctorReport {
  version: string;
  checks: Check[];
  ok: boolean;
}

const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 20;

const findRegisteredTable = (configText: string): boolean =>
  findTable(configText, serverTable()) !== null;

export function gitVersionSupported(version: string | undefined): boolean | null {
  if (!version) return null;
  const match = /(?:^|\s)(\d+)\.(\d+)(?:\.\d+)?/.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MIN_GIT_MAJOR || (major === MIN_GIT_MAJOR && minor >= MIN_GIT_MINOR);
}

function pathHealthCheck(
  name: string,
  target: string,
  options: { readable: boolean; initFlag: "--log" | "--events" },
): Check {
  const accessMode = fs.constants.W_OK | (options.readable ? fs.constants.R_OK : 0);
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      return {
        name,
        status: "warn",
        detail: `${target} (not a regular file)`,
        remedy: `Choose a file path and run: sol-luna-orchestrator init ${options.initFlag} <path>`,
      };
    }
    fs.accessSync(target, accessMode);
    return { name, status: "ok", detail: target };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const parent = path.dirname(target);
      try {
        const parentStat = fs.statSync(parent);
        if (!parentStat.isDirectory()) throw new Error("parent is not a directory");
        fs.accessSync(parent, fs.constants.W_OK);
        return {
          name,
          status: "ok",
          detail: `${target} (will be created on first write)`,
        };
      } catch (parentError) {
        return {
          name,
          status: "warn",
          detail: `${target} (${(parentError as Error).message})`,
          remedy: "Choose a path whose parent directory exists and is writable.",
        };
      }
    }
    return {
      name,
      status: "warn",
      detail: `${target} (${(error as Error).message})`,
      remedy: options.readable
        ? "Make the activity file readable and writable, or configure another path."
        : "Make the diagnostic log writable, or configure another path.",
    };
  }
}

export async function collectChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  // --- Runtime -------------------------------------------------------------
  const minimum = minimumNode();
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeOk =
    major > minimum.major || (major === minimum.major && minor >= minimum.minor);
  checks.push({
    name: "Node.js supported",
    status: nodeOk ? "ok" : "fail",
    detail: `v${process.versions.node}`,
    expected: minimum.range,
    remedy: nodeOk
      ? undefined
      : `Upgrade Node.js — ${minimum.range}. Tested on 24 (LTS) and 26 (Current).`,
  });

  const git = await gitVersion();
  const gitSupported = git.available ? gitVersionSupported(git.version) : null;
  checks.push({
    name: "git supported",
    status: git.available && gitSupported === true ? "ok" : "warn",
    detail: git.available ? git.version : (git.error ?? "not found"),
    expected: `>=${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}`,
    remedy:
      git.available && gitSupported === true
        ? undefined
        : git.available && gitSupported === false
          ? `Upgrade git to ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR} or newer for parallel worktrees.`
          : git.available
            ? "Could not parse the git version; parallel worktree support is unverified."
            : "Install git — required only for parallel batches (worktrees)",
  });

  // --- Codex ---------------------------------------------------------------
  const codex = await codexVersion();
  checks.push({
    name: "Codex CLI found",
    status: codex.available ? "ok" : "fail",
    detail: codex.available ? codex.version : (codex.error ?? "not found on PATH"),
    remedy: codex.available ? undefined : "Install the OpenAI Codex CLI",
  });

  checks.push({
    name: "Codex authentication present",
    status: codexAuthPresent() ? "ok" : "warn",
    detail: codexAuthPresent() ? "auth.json found" : "no auth.json",
    remedy: codexAuthPresent() ? undefined : "Run: codex login",
  });

  // --- This package --------------------------------------------------------
  const location = installLocation();
  checks.push({
    name: "MCP server build present",
    status: location.serverEntryExists ? "ok" : "fail",
    detail: location.serverEntry,
    remedy: location.serverEntryExists ? undefined : "Run: npm run build",
  });

  if (location.ephemeral) {
    checks.push({
      name: "Install location is durable",
      status: "warn",
      detail: location.reason,
      remedy: "Install persistently: npm install -g sol-luna-orchestrator",
    });
  }

  // --- Registration --------------------------------------------------------
  const configText = readConfig();
  const configuredInFile = findRegisteredTable(configText);
  const registered = codex.available
    ? await getRegisteredServer(SERVER_NAME)
    : { registered: false, inspectionError: codex.error };

  checks.push({
    name: "MCP server registered",
    status: registered.registered ? "ok" : "fail",
    detail: registered.registered
      ? SERVER_NAME
      : registered.inspectionError
        ? `Codex inspection failed: ${registered.inspectionError}`
        : configuredInFile
          ? "configured in config.toml but not confirmed by Codex"
          : "not registered with Codex",
    remedy: registered.registered
      ? undefined
      : registered.inspectionError && configuredInFile
        ? "Fix the reported Codex/config error, then rerun doctor."
        : "Run: sol-luna-orchestrator init",
  });

  if (registered.registered) {
    const argsMatch = registered.args?.includes(location.serverEntry) ?? false;
    checks.push({
      name: "Registered command resolves",
      status: argsMatch && location.serverEntryExists ? "ok" : "fail",
      detail: registered.args ?? "unknown",
      expected: location.serverEntry,
      remedy:
        argsMatch && location.serverEntryExists
          ? undefined
          : "Registered path differs from this install. Run: sol-luna-orchestrator init",
    });

    checks.push({
      name: "MCP server enabled",
      status: registered.enabled === false ? "fail" : "ok",
      detail: registered.enabled === false ? "enabled = false" : "enabled",
      remedy:
        registered.enabled === false ? "Run: sol-luna-orchestrator init" : undefined,
    });
  }

  // --- Required settings ---------------------------------------------------
  const serverConfig = resolveRegisteredServerConfig(configText);
  const discovery = inspectDiscoveryHint(readDiscoveryInstructions());
  for (const setting of inspectSettings(configText)) {
    const label =
      setting.key === "tool_timeout_sec"
        ? "Tool timeout"
        : setting.key === "default_tools_approval_mode"
          ? "Approval mode"
          : "Startup timeout";

    checks.push({
      name: label,
      status: setting.state === "ok" ? "ok" : setting.required ? "fail" : "warn",
      detail: setting.actual ?? "not set",
      expected: setting.expected,
      remedy:
        setting.state === "ok"
          ? undefined
          : `${setting.why} Run: sol-luna-orchestrator init`,
    });
  }

  // --- Runtime policy ------------------------------------------------------
  checks.push({
    name: "Verification mode",
    status: serverConfig.verificationMode === "shell" ? "warn" : "ok",
    detail: serverConfig.verificationMode,
    remedy:
      serverConfig.verificationMode === "shell"
        ? "shell mode runs model-chosen commands unsandboxed; prefer allowlist"
        : undefined,
  });

  checks.push({
    name: "Worker model",
    status: serverConfig.workerModel.trim() ? "ok" : "fail",
    detail: serverConfig.workerModel.trim() ? serverConfig.workerModel : "empty",
    remedy: serverConfig.workerModel.trim()
      ? undefined
      : "Set LUNA_MODEL to a non-empty model name in the registered MCP environment.",
  });

  checks.push({
    name: "Maximum concurrency",
    status: "ok",
    detail: String(serverConfig.maxParallel),
  });

  checks.push({
    name: "Maximum workers per batch",
    status: "ok",
    detail: String(serverConfig.maxWorkersPerBatch),
  });

  checks.push({
    name: "Worker timeout",
    status: "ok",
    detail: `${serverConfig.workerTimeoutSeconds}s`,
  });

  checks.push({
    name: "Verification timeout",
    status: "ok",
    detail: `${serverConfig.verificationTimeoutSeconds}s`,
  });

  checks.push({
    name: "Worker sandbox",
    status: serverConfig.workerSandbox === "danger-full-access" ? "warn" : "ok",
    detail: serverConfig.workerSandbox,
    remedy:
      serverConfig.workerSandbox === "danger-full-access"
        ? "Use workspace-write unless the host requires this trusted-machine workaround."
        : undefined,
  });

  checks.push({
    name: "Worker network access",
    status: "ok",
    detail: serverConfig.workerNetworkAccess ? "enabled" : "disabled",
  });

  checks.push({
    name: "Worktree retention",
    status: "ok",
    detail: serverConfig.keepWorktrees,
  });

  checks.push({
    name: "Dirty parallel base",
    status: serverConfig.allowDirtyWorktreeBase ? "warn" : "ok",
    detail: serverConfig.allowDirtyWorktreeBase ? "allowed" : "refused",
    remedy: serverConfig.allowDirtyWorktreeBase
      ? "Unset SOL_LUNA_ALLOW_DIRTY unless stale-base parallel work is intentional."
      : undefined,
  });

  checks.push({
    name: "Compute policy",
    status: serverConfig.executorOrderUnusable ? "warn" : "ok",
    detail: describeComputePolicy(serverConfig.computePolicy),
    remedy: serverConfig.executorOrderUnusable
      ? "SOL_LUNA_EXECUTOR_ORDER was declared but does not list every model in " +
        "SOL_LUNA_ALLOWED_MODELS exactly once, starting with LUNA_MODEL, so it was " +
        "ignored and stronger-executor fallback stays unresolvable"
      : undefined,
  });

  for (const diagnostic of serverConfig.diagnostics) {
    checks.push({
      name: `Config correction: ${diagnostic.key}`,
      status: "warn",
      detail: `"${diagnostic.raw}" -> ${diagnostic.effective}`,
      remedy: diagnostic.message,
    });
  }

  const disableTargetMatches = serverConfig.recursionDisableTarget === SERVER_NAME;
  checks.push({
    name: "Worker MCP disable target",
    status: disableTargetMatches ? "ok" : "fail",
    detail: serverConfig.recursionDisableTarget,
    expected: SERVER_NAME,
    remedy: disableTargetMatches
      ? undefined
      : "Registered name and SOL_LUNA_SERVER_NAME differ. Run: sol-luna-orchestrator init",
  });

  const logPath = fromTomlValue(
    readKey(configText, [...serverTable(), "env"], "SOL_LUNA_LOG"),
  );
  checks.push({
    name: "Diagnostic log configured",
    status: logPath ? "ok" : "warn",
    detail: logPath ?? "not set",
    remedy: logPath
      ? undefined
      : "Optional, but it is the best troubleshooting signal. Run: sol-luna-orchestrator init",
  });
  if (logPath) {
    checks.push(
      pathHealthCheck("Diagnostic log path healthy", logPath, {
        readable: false,
        initFlag: "--log",
      }),
    );
  }

  // `init` owns this key now, so doctor has to check it — a setup command that
  // writes something its own diagnostic ignores is how the two start disagreeing.
  const events = resolveEventsPath(configText);
  checks.push({
    name: "Activity log configured",
    status: events.path ? "ok" : "warn",
    detail: events.path
      ? `${events.path} (${describeEventsSource(events.source)})`
      : "not set",
    remedy: events.path
      ? undefined
      : "`sol-luna-orchestrator activity` needs this. Run: sol-luna-orchestrator init",
  });
  if (events.path) {
    checks.push(
      pathHealthCheck("Activity log path healthy", events.path, {
        readable: true,
        initFlag: "--events",
      }),
    );
  }

  checks.push({
    name: "Codex discovery hint",
    status: discovery.state === "installed" ? "ok" : "warn",
    detail:
      discovery.state === "installed"
        ? `installed at ${discoveryHintPath()}`
        : discovery.state === "modified"
          ? `modified or partial content at ${discoveryHintPath()}`
          : `not installed at ${discoveryHintPath()}`,
    remedy:
      discovery.state === "installed"
        ? undefined
        : "Run: sol-luna-orchestrator init (or init --no-discovery-hint to opt out)",
  });

  checks.push({
    name: "Workspace confinement",
    status: "ok",
    detail: serverConfig.allowedRoots
      ? serverConfig.allowedRoots
      : "any existing directory (SOL_LUNA_ALLOWED_ROOTS unset)",
  });

  return checks;
}

export async function buildReport(): Promise<DoctorReport> {
  const checks = await collectChecks();
  return {
    version: packageVersion(),
    checks,
    ok: checks.every((check) => check.status !== "fail"),
  };
}

export function doctorExitCode(report: DoctorReport, strict: boolean): number {
  if (!report.ok) return 1;
  if (strict && report.checks.some((check) => check.status === "warn")) return 1;
  return 0;
}

const DOCTOR_HELP = `${bold("Usage")}
  sol-luna-orchestrator doctor [--json] [--strict]

${bold("Options")}
  --json    Output a machine-readable diagnostic report
  --strict  Return non-zero when warnings are present
  --help    Show this help`;

export async function doctorCommand(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    const unknownWithHelp = argv.filter((arg) => arg !== "--help" && arg !== "-h");
    if (unknownWithHelp.length > 0) {
      for (const arg of unknownWithHelp) errOut(`Unknown option: ${arg}`);
      return 1;
    }
    out(DOCTOR_HELP);
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== "--json" && arg !== "--strict");
  if (unknown.length > 0) {
    for (const arg of unknown) errOut(`Unknown option: ${arg}`);
    errOut("Valid options: --json, --strict, --help");
    return 1;
  }
  const asJson = argv.includes("--json");
  const strict = argv.includes("--strict");
  const report = await buildReport();
  const warnings = report.checks.filter((check) => check.status === "warn").length;
  const exitCode = doctorExitCode(report, strict);

  if (asJson) {
    out(JSON.stringify(report, null, 2));
    return exitCode;
  }

  out(bold(`Sol-Luna Orchestrator Doctor  ${dim(`v${report.version}`)}`));
  out();

  const width = Math.max(...report.checks.map((check) => check.name.length));
  for (const check of report.checks) {
    const symbol =
      check.status === "ok"
        ? symbols.ok
        : check.status === "warn"
          ? symbols.warn
          : symbols.fail;
    const detail = check.detail ? dim(`  ${check.detail}`) : "";
    out(`${symbol} ${check.name.padEnd(width)}${detail}`);

    if (check.status !== "ok") {
      if (check.expected) out(`    expected: ${check.expected}`);
      if (check.remedy) out(`    ${check.remedy}`);
    }
  }

  out();
  const failures = report.checks.filter((check) => check.status === "fail").length;

  if (failures === 0 && warnings === 0) {
    out(`${symbols.ok} Ready.`);
  } else if (failures === 0) {
    out(`${symbols.ok} Ready, with ${warnings} warning(s).`);
  } else {
    out(`${symbols.fail} ${failures} problem(s) found. Run: sol-luna-orchestrator init`);
  }

  out(
    dim(
      `Codex config: ${codexConfigPath()}${fs.existsSync(codexConfigPath()) ? "" : " (missing)"}`,
    ),
  );

  return exitCode;
}
