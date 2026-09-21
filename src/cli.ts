#!/usr/bin/env node
/**
 * User-facing CLI.
 *
 * Deliberately separate from the MCP stdio server (`dist/server.js`, exposed as
 * the `sol-luna-orchestrator-mcp` bin). Running the CLI must never accidentally
 * start a stdio server that then sits waiting on a pipe forever — which is
 * exactly what happens if one binary tries to be both.
 */
import { activityCommand } from "./cli/activity.js";
import { absoluteOptionalPathInvalid, parseAbsoluteOptionalPath } from "./config.js";
import { readConfig } from "./cli/codex.js";
import { doctorCommand } from "./cli/doctor.js";
import {
  discoveryHintPath,
  inspectDiscoveryHint,
  readDiscoveryInstructions,
} from "./cli/discovery-hint.js";
import { describeEventsSource, resolveEventsPath } from "./cli/events-path.js";
import { initCommand } from "./cli/init.js";
import { codexConfigPath, installLocation, packageVersion } from "./cli/paths.js";
import { resolveRegisteredServerConfig } from "./cli/server-config.js";
import { describeComputePolicy } from "./policy.js";
import {
  SERVER_NAME,
  inspectSettings,
  registrationEnabled,
  serverEnvTable,
  serverTable,
} from "./cli/settings.js";
import { findTable, fromTomlValue, readKey, toTomlValue } from "./cli/toml-edit.js";
import { bold, dim, errOut, out, symbols, table } from "./cli/ui.js";
import { uninstallCommand } from "./cli/uninstall.js";

const HELP = `${bold("sol-luna-orchestrator")} — delegate bounded Codex tasks to isolated workers

${bold("Usage")}
  sol-luna-orchestrator <command> [options]

${bold("Commands")}
  activity     View live orchestration activity
  init         Register with Codex and apply the required settings
  doctor       Diagnose the installation and print how to fix it
  status       Short summary of the current configuration
  uninstall    Remove this project's Codex registration (nothing else)
  version      Print the package version

${bold("Options")}
  activity --watch         Continuously watch the event stream
  activity --json          Output a machine-readable JSON snapshot
  init --dry-run           Show what would change, write nothing
  init --force             Re-apply configuration even if it looks correct
  init --log <path>        Set the diagnostic log path, replacing any existing one
  init --events <path>     Set the activity event path, replacing any existing one
  init --allow-ephemeral   Permit registering a temporary npx install
  init --no-discovery-hint Skip the optional fresh-chat discovery hint
  doctor --json            Machine-readable report
  doctor --strict          Treat warnings as a non-zero diagnostic result
  status --json            Machine-readable configuration summary
  uninstall --dry-run      Show what would be removed, write nothing

${bold("After init")}
  Open Codex with any compatible parent model and work normally.
  No parent model or reasoning effort is required. Creator example: GPT-5.6 Sol at Medium.

${dim("The MCP server itself runs as `sol-luna-orchestrator-mcp` and is launched by Codex.")}`;

const STATUS_HELP = `${bold("Usage")}
  sol-luna-orchestrator status [--json]

${bold("Options")}
  --json    Output a machine-readable configuration summary
  --help    Show this help`;

function statusCommand(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    const unknownWithHelp = argv.filter((arg) => arg !== "--help" && arg !== "-h");
    if (unknownWithHelp.length > 0) {
      for (const arg of unknownWithHelp) errOut(`Unknown option: ${arg}`);
      return 1;
    }
    out(STATUS_HELP);
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    for (const arg of unknown) errOut(`Unknown option: ${arg}`);
    errOut("Valid options: --json, --help");
    return 1;
  }
  const asJson = argv.includes("--json");
  const location = installLocation();
  const configText = readConfig();
  const configured = findTable(configText, ["mcp_servers", SERVER_NAME]) !== null;
  const settings = inspectSettings(configText);
  // Status describes what the registered MCP server will actually use. A shell
  // override affects only this standalone CLI process, so surface it separately
  // instead of letting it mask a broken registered path.
  const events = resolveEventsPath(configText, {});
  const rawDiagnosticLog = fromTomlValue(
    readKey(configText, serverEnvTable(), "SOL_LUNA_LOG"),
  );
  const diagnosticLogPath = parseAbsoluteOptionalPath(rawDiagnosticLog) ?? null;
  const diagnosticLogError = absoluteOptionalPathInvalid(rawDiagnosticLog)
    ? "Configured SOL_LUNA_LOG must be a non-empty absolute path"
    : null;
  const diagnosticLogSource = rawDiagnosticLog === null ? "unconfigured" : "configured";
  const cliEventsOverride =
    process.env.SOL_LUNA_EVENTS !== undefined
      ? resolveEventsPath("", { SOL_LUNA_EVENTS: process.env.SOL_LUNA_EVENTS })
      : null;
  const serverConfig = resolveRegisteredServerConfig(configText);
  const discovery = inspectDiscoveryHint(readDiscoveryInstructions());
  const value = (key: string): string =>
    settings.find((setting) => setting.key === key)?.actual ?? "unset";
  const registeredCommand = fromTomlValue(readKey(configText, serverTable(), "command"));
  const registeredArgs = readKey(configText, serverTable(), "args");
  const registeredEnabled = configured ? registrationEnabled(configText) : null;
  const registrationMatchesCurrentInstall =
    configured &&
    registeredEnabled === true &&
    registeredCommand === process.execPath &&
    registeredArgs === toTomlValue([location.serverEntry]);

  if (asJson) {
    out(
      JSON.stringify(
        {
          version: packageVersion(),
          configured,
          mcpName: SERVER_NAME,
          currentInstall: {
            serverEntry: location.serverEntry,
            serverEntryExists: location.serverEntryExists,
          },
          registration: {
            command: registeredCommand,
            args: registeredArgs,
            enabled: registeredEnabled,
            matchesCurrentInstall: registrationMatchesCurrentInstall,
          },
          codexSettings: Object.fromEntries(
            settings.map((setting) => [
              setting.key,
              {
                state: setting.state,
                actual: setting.actual,
                expected: setting.expected,
              },
            ]),
          ),
          runtime: {
            workerModel: serverConfig.workerModel,
            maxConcurrency: serverConfig.maxParallel,
            maxWorkersPerBatch: serverConfig.maxWorkersPerBatch,
            workerTimeoutSeconds: serverConfig.workerTimeoutSeconds,
            verificationTimeoutSeconds: serverConfig.verificationTimeoutSeconds,
            verificationMode: serverConfig.verificationMode,
            workerSandbox: serverConfig.workerSandbox,
            workerNetworkAccess: serverConfig.workerNetworkAccess,
            keepWorktrees: serverConfig.keepWorktrees,
            allowDirtyWorktreeBase: serverConfig.allowDirtyWorktreeBase,
            allowedRoots: serverConfig.allowedRoots,
            recursionDisableTarget: serverConfig.recursionDisableTarget,
            computePolicy: serverConfig.computePolicy,
            diagnostics: serverConfig.diagnostics,
          },
          activity: {
            path: events.path,
            source: events.source,
            error: events.error ?? null,
            cliOverride: cliEventsOverride
              ? {
                  path: cliEventsOverride.path,
                  error: cliEventsOverride.error ?? null,
                }
              : null,
          },
          diagnosticLog: {
            path: diagnosticLogPath,
            source: diagnosticLogSource,
            error: diagnosticLogError,
          },
          discovery: {
            state: discovery.state,
            path: discoveryHintPath(),
          },
          configPath: codexConfigPath(),
        },
        null,
        2,
      ),
    );
    return configured ? 0 : 1;
  }

  out(bold("Sol-Luna Orchestrator"));
  out();
  table([
    ["Version", packageVersion()],
    ["Configured", configured ? "yes" : `no  (run: sol-luna-orchestrator init)`],
    ["MCP name", SERVER_NAME],
    [
      "Current server build",
      location.serverEntryExists ? location.serverEntry : "not built",
    ],
    ["Registered command", configured ? (registeredCommand ?? "missing") : "-"],
    ["Registered args", configured ? (registeredArgs ?? "missing") : "-"],
    [
      "Registered enabled",
      configured ? (registeredEnabled ? "yes" : "no  (run init to reconcile)") : "-",
    ],
    [
      "Registration match",
      configured
        ? registrationMatchesCurrentInstall
          ? "yes"
          : "no  (run init to reconcile)"
        : "-",
    ],
    ["Timeout", configured ? `${value("tool_timeout_sec")}s` : "-"],
    [
      "Approval",
      configured ? (fromTomlValue(value("default_tools_approval_mode")) ?? "-") : "-",
    ],
    ["Worker model", serverConfig.workerModel],
    ["Max concurrency", String(serverConfig.maxParallel)],
    ["Max workers/batch", String(serverConfig.maxWorkersPerBatch)],
    ["Worker timeout", `${serverConfig.workerTimeoutSeconds}s`],
    ["Verify timeout", `${serverConfig.verificationTimeoutSeconds}s`],
    ["Compute policy", describeComputePolicy(serverConfig.computePolicy)],
    ["Verification", serverConfig.verificationMode],
    ["Worker sandbox", serverConfig.workerSandbox],
    ["Worker network", serverConfig.workerNetworkAccess ? "enabled" : "disabled"],
    ["Keep worktrees", serverConfig.keepWorktrees],
    ["Dirty worktree base", serverConfig.allowDirtyWorktreeBase ? "allowed" : "refused"],
    ["Workspace roots", serverConfig.allowedRoots || "any existing directory"],
    [
      "Diagnostic log",
      diagnosticLogPath
        ? `${diagnosticLogPath}  ${dim("(registered config)")}`
        : diagnosticLogError
          ? `invalid  (${diagnosticLogError}; run init to reconcile)`
          : "not configured  (run: sol-luna-orchestrator init)",
    ],
    [
      "Activity log",
      events.path
        ? `${events.path}  ${dim(`(${describeEventsSource(events.source)})`)}`
        : events.error
          ? `invalid  (${events.error}; run init to reconcile)`
          : "not configured  (run: sol-luna-orchestrator init)",
    ],
    ...(cliEventsOverride
      ? ([
          [
            "CLI activity override",
            cliEventsOverride.path
              ? `${cliEventsOverride.path}  ${dim("(standalone activity only)")}`
              : `invalid  (${cliEventsOverride.error ?? "invalid override"})`,
          ],
        ] as Array<[string, string]>)
      : []),
    [
      "Discovery hint",
      discovery.state === "installed"
        ? `installed  (${discoveryHintPath()})`
        : discovery.state === "modified"
          ? `modified/partial  (${discoveryHintPath()}; run init to add the exact hint)`
          : "not installed  (run init, or opt out with --no-discovery-hint)",
    ],
    ["Codex config", codexConfigPath()],
  ]);
  if (serverConfig.diagnostics.length > 0) {
    out();
    for (const diagnostic of serverConfig.diagnostics) {
      out(
        `${symbols.warn} ${diagnostic.key}="${diagnostic.raw}" -> ${diagnostic.effective}: ${diagnostic.message}`,
      );
    }
  }

  if (!configured) {
    out();
    out(`${symbols.warn} Not configured yet. Run: sol-luna-orchestrator init`);
    return 1;
  }
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    out(HELP);
    return command ? 0 : 1;
  }

  switch (command) {
    case "activity":
      return activityCommand(argv.slice(1));
    case "init":
      return initCommand(argv.slice(1));
    case "doctor":
      return doctorCommand(argv.slice(1));
    case "status":
      return statusCommand(argv.slice(1));
    case "uninstall":
      return uninstallCommand(argv.slice(1));
    case "version":
    case "--version":
    case "-v":
      out(packageVersion());
      return 0;
    default:
      errOut(`Unknown command: ${command}`);
      errOut("Run `sol-luna-orchestrator --help` for usage.");
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    errOut(`${symbols.fail} ${(error as Error).message}`);
    process.exitCode = 1;
  });
