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
import { SERVER_NAME, inspectSettings } from "./cli/settings.js";
import { findTable, fromTomlValue } from "./cli/toml-edit.js";
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
  uninstall --dry-run      Show what would be removed, write nothing

${bold("After init")}
  Open Codex with a compatible parent model; creator example: Select GPT-5.6 Sol at Medium effort.

${dim("The MCP server itself runs as `sol-luna-orchestrator-mcp` and is launched by Codex.")}`;

function statusCommand(): number {
  const location = installLocation();
  const configText = readConfig();
  const configured = findTable(configText, ["mcp_servers", SERVER_NAME]) !== null;
  const settings = inspectSettings(configText);
  const events = resolveEventsPath(configText);
  const discovery = inspectDiscoveryHint(readDiscoveryInstructions());
  const value = (key: string): string =>
    settings.find((setting) => setting.key === key)?.actual ?? "unset";

  out(bold("Sol-Luna Orchestrator"));
  out();
  table([
    ["Version", packageVersion()],
    ["Configured", configured ? "yes" : `no  (run: sol-luna-orchestrator init)`],
    ["MCP name", SERVER_NAME],
    ["Server", location.serverEntryExists ? location.serverEntry : "not built"],
    ["Timeout", configured ? `${value("tool_timeout_sec")}s` : "-"],
    [
      "Approval",
      configured ? (fromTomlValue(value("default_tools_approval_mode")) ?? "-") : "-",
    ],
    ["Max workers", process.env.SOL_LUNA_MAX_PARALLEL ?? "3"],
    ["Verification", process.env.SOL_LUNA_VERIFY_MODE ?? "allowlist"],
    [
      "Activity log",
      // Same resolver `activity` uses. Reporting only this shell's environment
      // told people telemetry was off while the server was busy writing it.
      events.path
        ? `${events.path}  ${dim(`(${describeEventsSource(events.source)})`)}`
        : "not configured  (run: sol-luna-orchestrator init)",
    ],
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
      return statusCommand();
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
