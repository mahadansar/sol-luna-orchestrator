import fs from "node:fs";
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
import { fromTomlValue, readKey } from "./toml-edit.js";
import { resolveRegisteredServerConfig } from "./server-config.js";
import { bold, dim, out, symbols } from "./ui.js";

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
  checks.push({
    name: "git available",
    status: git.available ? "ok" : "warn",
    detail: git.available ? git.version : "not found",
    remedy: git.available
      ? undefined
      : "Install git — required only for parallel batches (worktrees)",
  });

  // --- Codex ---------------------------------------------------------------
  const codex = await codexVersion();
  checks.push({
    name: "Codex CLI found",
    status: codex.available ? "ok" : "fail",
    detail: codex.available ? codex.version : "not found on PATH",
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
  const registered = codex.available
    ? await getRegisteredServer(SERVER_NAME)
    : { registered: false };

  checks.push({
    name: "MCP server registered",
    status: registered.registered ? "ok" : "fail",
    detail: registered.registered ? SERVER_NAME : "not registered with Codex",
    remedy: registered.registered ? undefined : "Run: sol-luna-orchestrator init",
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
  const configText = readConfig();
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
    status: "ok",
    detail: serverConfig.workerModel,
  });

  checks.push({
    name: "Maximum workers",
    status: "ok",
    detail: String(serverConfig.maxParallel),
  });

  checks.push({
    name: "Compute policy",
    status: "ok",
    detail: describeComputePolicy(serverConfig.computePolicy),
  });

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
    detail:
      serverConfig.allowedRoots ??
      "any existing directory (SOL_LUNA_ALLOWED_ROOTS unset)",
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

export async function doctorCommand(argv: string[]): Promise<number> {
  const asJson = argv.includes("--json");
  const report = await buildReport();

  if (asJson) {
    out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
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
  const warnings = report.checks.filter((check) => check.status === "warn").length;

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

  return report.ok ? 0 : 1;
}
