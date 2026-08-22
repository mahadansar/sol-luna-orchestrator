import path from "node:path";
import {
  codexAuthPresent,
  codexVersion,
  getRegisteredServer,
  readConfig,
  writeConfig,
} from "./codex.js";
import {
  discoveryHintPath,
  ensureDiscoveryHint,
  inspectDiscoveryHint,
  readDiscoveryInstructions,
  writeDiscoveryInstructions,
} from "./discovery-hint.js";
import { defaultEventsPath } from "./events-path.js";
import { codexConfigPath, installLocation } from "./paths.js";
import { resolveRegisteredServerConfig } from "./server-config.js";
import {
  REQUIRED_SETTINGS,
  SERVER_NAME,
  inspectSettings,
  serverEnvTable,
  serverTable,
  settingsSatisfied,
} from "./settings.js";
import {
  findTable,
  fromTomlValue,
  readKey,
  toTomlValue,
  upsertKey,
} from "./toml-edit.js";
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
  noDiscoveryHint: boolean;
  logPath?: string;
  eventsPath?: string;
  /** Arguments that matched no known flag. */
  unknown: string[];
  /** Flags that were given without the value they require. */
  missingValue: string[];
}

const INIT_BOOLEAN_FLAGS = [
  "--dry-run",
  "--force",
  "--allow-ephemeral",
  "--no-discovery-hint",
];
const INIT_VALUE_FLAGS = ["--log", "--events"];

/**
 * Parse `init`'s arguments strictly.
 *
 * A mistyped flag on a command that rewrites configuration must not be ignored:
 * `init --dryrun` silently performing a real write is exactly the surprise this
 * command exists to avoid. Unknown arguments are collected and refused rather
 * than dropped, and a value flag followed by another flag counts as missing its
 * value instead of swallowing the next flag as a path.
 */
export function parseInitOptions(argv: string[]): InitOptions {
  const options: InitOptions = {
    dryRun: false,
    force: false,
    allowEphemeral: false,
    noDiscoveryHint: false,
    unknown: [],
    missingValue: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (INIT_BOOLEAN_FLAGS.includes(arg)) {
      if (arg === "--dry-run") options.dryRun = true;
      if (arg === "--force") options.force = true;
      if (arg === "--allow-ephemeral") options.allowEphemeral = true;
      if (arg === "--no-discovery-hint") options.noDiscoveryHint = true;
      continue;
    }

    if (INIT_VALUE_FLAGS.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        options.missingValue.push(arg);
        continue;
      }
      if (arg === "--log") options.logPath = value;
      if (arg === "--events") options.eventsPath = value;
      i += 1;
      continue;
    }

    options.unknown.push(arg);
  }

  return options;
}

export interface InitConfigInput {
  /** Interpreter Codex should launch the server with. */
  command: string;
  /** Absolute path to the built stdio server. */
  serverEntry: string;
  logPath: string;
  eventsPath: string;
  /** True when `--log` was given, which is a request to replace any value. */
  forceLogPath: boolean;
  /** True when `--events` was given, which is a request to replace any value. */
  forceEventsPath: boolean;
}

/**
 * Produce the new config text from the old one.
 *
 * Pure, and exported so the surgical-edit behaviour that matters most —
 * migrating an existing installation without disturbing anything else — can be
 * tested without a Codex binary on PATH. `initCommand` is not testable that way
 * because it refuses to run at all when Codex is missing, which is exactly the
 * situation in CI.
 */
export function applyInitConfig(before: string, input: InitConfigInput): string {
  let text = before;

  text = upsertKey(text, serverTable(), "command", input.command, {
    comment: ["Registered by `sol-luna-orchestrator init`."],
  });
  text = upsertKey(text, serverTable(), "args", [input.serverEntry]);

  for (const setting of REQUIRED_SETTINGS) {
    if (readKey(text, serverTable(), setting.key) === setting.expected) continue;
    text = upsertKey(text, serverTable(), setting.key, setting.value, {
      comment: setting.comment,
    });
  }

  // Same rule as the event path below: an explicit `--log` replaces whatever is
  // there, a plain re-run never does.
  if (input.forceLogPath || !readKey(text, serverEnvTable(), "SOL_LUNA_LOG")) {
    text = upsertKey(text, serverEnvTable(), "SOL_LUNA_LOG", input.logPath);
  }

  // Never overwrite a path the user chose. `--events` is an explicit request
  // and wins; otherwise an existing value is left exactly as it is, so
  // re-running init cannot redirect someone's history to the default.
  if (input.forceEventsPath || !readKey(text, serverEnvTable(), "SOL_LUNA_EVENTS")) {
    text = upsertKey(text, serverEnvTable(), "SOL_LUNA_EVENTS", input.eventsPath, {
      comment: ["Structured activity events, read by `sol-luna-orchestrator activity`."],
    });
  }

  // The worker disables this exact MCP table. Persist the name in the server's
  // own environment so a custom CLI registration name cannot drift at runtime.
  text = upsertKey(text, serverEnvTable(), "SOL_LUNA_SERVER_NAME", SERVER_NAME);

  return text;
}

export async function initCommand(argv: string[]): Promise<number> {
  const options = parseInitOptions(argv);

  out(bold("Sol-Luna Orchestrator setup"));
  out();

  if (options.unknown.length > 0 || options.missingValue.length > 0) {
    for (const arg of options.unknown) out(`${symbols.fail} Unknown option: ${arg}`);
    for (const arg of options.missingValue) {
      out(`${symbols.fail} ${arg} needs a value, e.g. ${arg} /path/to/file`);
    }
    out();
    out(
      `Valid options: ${[...INIT_BOOLEAN_FLAGS, "--log <path>", "--events <path>"].join(", ")}`,
    );
    out("Nothing was written. Run `sol-luna-orchestrator --help` for usage.");
    return 1;
  }

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
  const instructionsPath = discoveryHintPath();
  const instructionsBefore = readDiscoveryInstructions(instructionsPath);
  const discoveryBefore = inspectDiscoveryHint(instructionsBefore);
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

  // Activity logging is configuration this command owns, so a config missing it
  // is not "already configured". Without this an installation made by an
  // earlier version reports Already configured forever and `activity` never
  // works, which is exactly the bug this check exists to prevent.
  const eventsConfigured = readKey(before, serverEnvTable(), "SOL_LUNA_EVENTS") !== null;
  const serverNameConfigured =
    fromTomlValue(readKey(before, serverEnvTable(), "SOL_LUNA_SERVER_NAME")) ===
    SERVER_NAME;

  const registrationOk = isRegistered && pathMatches && commandMatches;
  const discoveryHintConfigured =
    options.noDiscoveryHint || discoveryBefore.exactCount > 0;
  const alreadyDone =
    registrationOk &&
    settingsSatisfied(settingsBefore) &&
    eventsConfigured &&
    serverNameConfigured &&
    discoveryHintConfigured;

  // `--log` and `--events` each name a specific path, so either is a request to
  // change one. Letting the "nothing to do" shortcut swallow them would make
  // the flags silently inert on exactly the installations someone would use
  // them on.
  const explicitPath = options.logPath !== undefined || options.eventsPath !== undefined;

  if (alreadyDone && !options.force && !explicitPath) {
    out();
    out(`${symbols.ok} Already configured. Nothing to change.`);
    printSummary(location.serverEntry, before);
    return 0;
  }

  const logPath =
    options.logPath ?? path.join(path.dirname(configPath), "sol-luna-orchestrator.log");
  const eventsPath = options.eventsPath ?? defaultEventsPath();

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
  const logConfigured = readKey(before, serverEnvTable(), "SOL_LUNA_LOG") !== null;
  if (options.logPath !== undefined && logConfigured) {
    planned.push(`replace SOL_LUNA_LOG with ${logPath}`);
  } else if (!logConfigured) {
    planned.push(`set SOL_LUNA_LOG for diagnostics (${logPath})`);
  }
  if (options.eventsPath !== undefined && eventsConfigured) {
    planned.push(`replace SOL_LUNA_EVENTS with ${eventsPath}`);
  } else if (!eventsConfigured) {
    planned.push(`set SOL_LUNA_EVENTS so \`activity\` works (${eventsPath})`);
  }
  if (!serverNameConfigured) {
    planned.push(`set SOL_LUNA_SERVER_NAME to ${SERVER_NAME} for worker isolation`);
  }
  if (options.noDiscoveryHint) {
    if (discoveryBefore.exactCount === 0) {
      planned.push(`skip Codex discovery hint (--no-discovery-hint)`);
    }
  } else if (discoveryBefore.exactCount === 0) {
    planned.push(`install Codex discovery hint in ${instructionsPath}`);
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
  const original = before;
  const text = applyInitConfig(before, {
    command: process.execPath,
    serverEntry: location.serverEntry,
    logPath,
    eventsPath,
    forceLogPath: options.logPath !== undefined,
    forceEventsPath: options.eventsPath !== undefined,
  });

  let backupPath: string | undefined;
  if (text !== original) {
    ({ backupPath } = writeConfig(text, configPath));
  }

  if (!options.noDiscoveryHint) {
    const instructionsAfter = ensureDiscoveryHint(instructionsBefore);
    if (instructionsAfter !== instructionsBefore) {
      writeDiscoveryInstructions(instructionsAfter, instructionsPath);
    }
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

  const discoveryAfter = inspectDiscoveryHint(
    readDiscoveryInstructions(instructionsPath),
  );
  if (!options.noDiscoveryHint && discoveryAfter.exactCount === 0) {
    out();
    out(`${symbols.fail} Codex discovery hint did not verify after writing.`);
    out(`    Expected managed content in ${instructionsPath}`);
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
  out(
    "  2. Select GPT-5.6 Sol at Medium effort (creator example only; compatible parent models are supported)",
  );
  out("  3. Work normally");
  out();
  out(dim("Run `sol-luna-orchestrator doctor` any time."));

  return 0;
}

function printSummary(serverEntry: string, configText: string): void {
  const settings = inspectSettings(configText);
  const value = (key: string): string =>
    settings.find((setting) => setting.key === key)?.actual ?? "unset";
  const serverConfig = resolveRegisteredServerConfig(configText);

  out();
  table([
    ["MCP", `ready (${SERVER_NAME})`],
    ["Server", serverEntry],
    ["Timeout", `${value("tool_timeout_sec")}s`],
    ["Approval", fromTomlValue(value("default_tools_approval_mode")) ?? "unset"],
    ["Worker", serverConfig.workerModel],
    ["Workers", `max ${serverConfig.maxParallel}`],
    ["Verify", serverConfig.verificationMode],
    ["Roots", serverConfig.allowedRoots ?? "any existing directory"],
    [
      "Activity",
      fromTomlValue(readKey(configText, serverEnvTable(), "SOL_LUNA_EVENTS")) ??
        "not configured",
    ],
  ]);
}
