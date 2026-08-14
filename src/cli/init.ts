import path from "node:path";
import {
  codexAuthPresent,
  codexVersion,
  getRegisteredServer,
  readConfig,
  writeConfig,
} from "./codex.js";
import { codexConfigPath, installLocation } from "./paths.js";
import {
  REQUIRED_SETTINGS,
  SERVER_NAME,
  inspectSettings,
  serverEnvTable,
  serverTable,
  settingsSatisfied,
} from "./settings.js";
import { findTable, readKey, toTomlValue, upsertKey } from "./toml-edit.js";
import { bold, dim, out, symbols, table } from "./ui.js";

/**
 * One-command setup.
 *
 * Every change is made with the surgical TOML editor rather than with
 * `codex mcp add`, which was the original design. That command was measured
 * round-tripping the entire config: against a file containing an unrelated
 * `context7` server it deleted the comment above that server's table and
 * rewrote its `startup_timeout_sec = 15` as `15.0`. Losing a comment and
 * retyping an integer in someone else's configuration is not an acceptable
 * price for delegating the write, so registration is done here where the blast
 * radius is exactly the keys we own. (Verified against codex-cli 0.147.0.)
 *
 * `codex mcp get` is still used, read-only, to cross-check what Codex sees.
 *
 * Idempotent by construction: it inspects first, changes only what is wrong, and
 * says so.
 */

export interface InitOptions {
  dryRun: boolean;
  force: boolean;
  allowEphemeral: boolean;
  logPath?: string;
}

export function parseInitOptions(argv: string[]): InitOptions {
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    allowEphemeral: argv.includes("--allow-ephemeral"),
    logPath: valueOf("--log"),
  };
}

export async function initCommand(argv: string[]): Promise<number> {
  const options = parseInitOptions(argv);

  out(bold("Sol-Luna Orchestrator setup"));
  out();

  // --- Prerequisites -------------------------------------------------------
  const codex = await codexVersion();
  if (!codex.available) {
    out(`${symbols.fail} Codex CLI not found on PATH.`);
    out("    Install the OpenAI Codex CLI, then run this again.");
    return 1;
  }
  out(`${symbols.ok} Codex CLI  ${dim(codex.version ?? "")}`);

  if (!codexAuthPresent()) {
    out(`${symbols.warn} Codex is not logged in. Run: codex login`);
  }

  const location = installLocation();
  if (!location.serverEntryExists) {
    out(`${symbols.fail} Built server not found at ${location.serverEntry}`);
    out("    Run: npm run build");
    return 1;
  }
  out(`${symbols.ok} Server build  ${dim(location.serverEntry)}`);

  // Registering a path npm may delete produces a config that breaks silently
  // later, which is worse than refusing now.
  if (location.ephemeral && !options.allowEphemeral) {
    out();
    out(`${symbols.fail} Refusing to register an impermanent install.`);
    out(`    ${location.reason}.`);
    out("    Install it properly, then run init:");
    out("      npm install -g sol-luna-orchestrator");
    out("      sol-luna-orchestrator init");
    out("    Or pass --allow-ephemeral if you understand it may stop working.");
    return 1;
  }

  const configPath = codexConfigPath();
  const before = readConfig(configPath);
  const settingsBefore = inspectSettings(before);

  // The config file is what Codex actually loads, so it is the authority here.
  // Values are compared in their rendered TOML form: a Windows path in the file
  // is backslash-escaped, so comparing it against the raw path would never match
  // and `init` would rewrite an already-correct config on every run.
  const isRegistered = findTable(before, serverTable()) !== null;
  const pathMatches =
    readKey(before, serverTable(), "args") === toTomlValue([location.serverEntry]);
  const commandMatches =
    readKey(before, serverTable(), "command") === toTomlValue(process.execPath);

  const registrationOk = isRegistered && pathMatches && commandMatches;
  const alreadyDone = registrationOk && settingsSatisfied(settingsBefore);

  if (alreadyDone && !options.force) {
    out();
    out(`${symbols.ok} Already configured. Nothing to change.`);
    printSummary(location.serverEntry, before);
    return 0;
  }

  const logPath =
    options.logPath ?? path.join(path.dirname(configPath), "sol-luna-orchestrator.log");

  const planned: string[] = [];
  if (!isRegistered) planned.push(`register MCP server "${SERVER_NAME}"`);
  else if (!pathMatches || !commandMatches)
    planned.push(`re-point "${SERVER_NAME}" at this install`);
  else if (options.force) planned.push(`re-register "${SERVER_NAME}"`);

  for (const setting of settingsBefore) {
    if (setting.state === "ok") continue;
    planned.push(
      `set ${setting.key} = ${setting.expected}` +
        (setting.actual ? ` (currently ${setting.actual})` : ""),
    );
  }
  if (!readKey(before, serverEnvTable(), "SOL_LUNA_LOG")) {
    planned.push("set SOL_LUNA_LOG for diagnostics");
  }

  out();
  out(bold("Planned changes"));
  for (const change of planned) out(`  - ${change}`);
  out(dim(`  config: ${configPath}`));

  if (options.dryRun) {
    out();
    out(`${symbols.ok} Dry run: nothing was written.`);
    return 0;
  }

  // --- Write only the keys we own ------------------------------------------
  let text = before;
  const original = text;

  text = upsertKey(text, serverTable(), "command", process.execPath, {
    comment: ["Registered by `sol-luna-orchestrator init`."],
  });
  text = upsertKey(text, serverTable(), "args", [location.serverEntry]);

  for (const setting of REQUIRED_SETTINGS) {
    if (readKey(text, serverTable(), setting.key) === setting.expected) continue;
    text = upsertKey(text, serverTable(), setting.key, setting.value, {
      comment: setting.comment,
    });
  }

  if (!readKey(text, serverEnvTable(), "SOL_LUNA_LOG")) {
    text = upsertKey(text, serverEnvTable(), "SOL_LUNA_LOG", logPath);
  }

  let backupPath: string | undefined;
  if (text !== original) {
    ({ backupPath } = writeConfig(text, configPath));
  }

  // --- Verify what we wrote ------------------------------------------------
  const after = readConfig(configPath);
  const settingsAfter = inspectSettings(after);
  const wroteRegistration = findTable(after, serverTable()) !== null;

  // Cross-check against Codex itself where possible, but do not fail on it:
  // `codex mcp get` needs a parseable config and Codex on PATH, neither of
  // which is required for the file we just wrote to be correct.
  const seenByCodex = await getRegisteredServer(SERVER_NAME);
  if (!seenByCodex.registered) {
    out(dim("Note: `codex mcp get` did not confirm the entry; verifying from the file."));
  }

  if (!wroteRegistration || !settingsSatisfied(settingsAfter)) {
    out();
    out(`${symbols.fail} Configuration did not verify after writing.`);
    for (const setting of settingsAfter) {
      if (setting.state === "ok") continue;
      out(
        `    ${setting.key}: ${setting.actual ?? "missing"} (expected ${setting.expected})`,
      );
    }
    if (backupPath) out(`    Previous config saved at ${backupPath}`);
    return 1;
  }

  out();
  out(`${symbols.ok} ${bold("Sol-Luna Orchestrator configured.")}`);
  printSummary(location.serverEntry, after);
  if (backupPath) out(dim(`Previous config backed up to ${backupPath}`));

  out();
  out("Next:");
  out("  1. Open Codex");
  out("  2. Select GPT-5.6 Sol at High effort");
  out("  3. Work normally");
  out();
  out(dim("Run `sol-luna-orchestrator doctor` any time."));

  return 0;
}

function printSummary(serverEntry: string, configText: string): void {
  const settings = inspectSettings(configText);
  const value = (key: string): string =>
    settings.find((setting) => setting.key === key)?.actual ?? "unset";

  out();
  table([
    ["MCP", `ready (${SERVER_NAME})`],
    ["Server", serverEntry],
    ["Timeout", `${value("tool_timeout_sec")}s`],
    ["Approval", value("default_tools_approval_mode").replace(/"/g, "")],
    ["Workers", `max ${process.env.SOL_LUNA_MAX_PARALLEL ?? "3"}`],
    ["Verify", process.env.SOL_LUNA_VERIFY_MODE ?? "allowlist"],
  ]);
}
