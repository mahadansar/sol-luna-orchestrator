import { codexVersion, getRegisteredServer, readConfig, writeConfig } from "./codex.js";
import {
  discoveryHintPaths,
  readDiscoveryInstructions,
  removeDiscoveryHints,
  writeDiscoveryInstructions,
} from "./discovery-hint.js";
import { codexConfigPath } from "./paths.js";
import { SERVER_NAME, serverTable } from "./settings.js";
import { findTable, listSubTables, removeTable } from "./toml-edit.js";
import { bold, dim, out, symbols } from "./ui.js";

/**
 * Remove this project's Codex registration and exact managed discovery hints.
 *
 * Scope is deliberately tiny: one MCP table and its sub-tables plus the exact
 * managed hint blocks owned by this project. It never touches other servers,
 * other settings, the Codex installation/package, telemetry history, or user
 * instruction bytes outside those managed blocks. Idempotent — running it twice
 * is a no-op.
 *
 * Like `init`, this does the edit itself rather than calling `codex mcp remove`.
 * That command rewrites the whole config: it was measured deleting the comment
 * above an unrelated server's table and rewriting that server's
 * `startup_timeout_sec = 15` as `15.0`. An uninstall that quietly edits
 * configuration belonging to other tools is not an uninstall anyone wants.
 */

export interface UninstallOptions {
  dryRun: boolean;
}

const UNINSTALL_HELP = `${bold("Usage")}
  sol-luna-orchestrator uninstall [--dry-run]

Removes this MCP registration and its managed discovery hint. Other Codex
configuration, telemetry history, and the installed npm package are left in place.

${bold("Options")}
  --dry-run    Show what would be removed, write nothing
  --help, -h   Show this help`;

export async function uninstallCommand(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    const unknownWithHelp = argv.filter((arg) => arg !== "--help" && arg !== "-h");
    if (unknownWithHelp.length > 0) {
      for (const arg of unknownWithHelp) out(`${symbols.fail} Unknown option: ${arg}`);
      return 1;
    }
    out(UNINSTALL_HELP);
    return 0;
  }
  const options: UninstallOptions = { dryRun: argv.includes("--dry-run") };
  const configPath = codexConfigPath();
  const instructionsPaths = discoveryHintPaths();

  out(bold("Sol-Luna Orchestrator uninstall"));
  out();

  // A typo must not turn an intended dry run into a real removal.
  const unknown = argv.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    for (const arg of unknown) out(`${symbols.fail} Unknown option: ${arg}`);
    out();
    out("Valid options: --dry-run");
    out("Nothing was removed.");
    return 1;
  }

  const before = readConfig(configPath);
  const discoveriesBefore = instructionsPaths.map((instructionsPath) => {
    const instructions = readDiscoveryInstructions(instructionsPath);
    return {
      instructionsPath,
      managedCount: removeDiscoveryHints(instructions).removedCount,
    };
  });
  const othersBefore = listSubTables(before, ["mcp_servers"]).filter(
    (name) => name !== SERVER_NAME,
  );

  const codex = await codexVersion();
  const registered = codex.available
    ? await getRegisteredServer(SERVER_NAME)
    : { registered: false };
  const inConfig = findTable(before, serverTable()) !== null;

  const managedHintsBefore = discoveriesBefore.reduce(
    (count, discovery) => count + discovery.managedCount,
    0,
  );

  if (!registered.registered && !inConfig && managedHintsBefore === 0) {
    out(`${symbols.ok} Not configured. Nothing to remove.`);
    if (othersBefore.length > 0) {
      out(dim(`Left untouched: ${othersBefore.join(", ")}`));
    }
    return 0;
  }

  if (registered.registered || inConfig) {
    out(`Will remove MCP server "${SERVER_NAME}" from ${configPath}`);
  }
  for (const discovery of discoveriesBefore) {
    if (discovery.managedCount > 0) {
      out(
        `Will remove the managed Codex discovery hint from ${discovery.instructionsPath}`,
      );
    }
  }
  if (othersBefore.length > 0) {
    out(dim(`Leaving untouched: ${othersBefore.join(", ")}`));
  }

  if (options.dryRun) {
    out();
    out(`${symbols.ok} Dry run: nothing was written.`);
    return 0;
  }

  let backupPath: string | undefined;
  const current = readConfig(configPath);
  if (findTable(current, serverTable()) !== null || hasSubTables(current)) {
    const next = removeTable(current, serverTable());
    if (next !== current) {
      ({ backupPath } = writeConfig(next, configPath));
    }
  }

  for (const instructionsPath of instructionsPaths) {
    const currentInstructions = readDiscoveryInstructions(instructionsPath);
    const removedInstructions = removeDiscoveryHints(currentInstructions);
    if (removedInstructions.removedCount > 0) {
      writeDiscoveryInstructions(removedInstructions.text, instructionsPath);
    }
  }

  // --- Verify the blast radius --------------------------------------------
  const after = readConfig(configPath);
  const stillThere = findTable(after, serverTable()) !== null;
  const othersAfter = listSubTables(after, ["mcp_servers"]).filter(
    (name) => name !== SERVER_NAME,
  );
  const lost = othersBefore.filter((name) => !othersAfter.includes(name));

  if (stillThere) {
    out();
    out(`${symbols.fail} The configuration entry is still present.`);
    if (backupPath) out(dim(`Backup at ${backupPath}`));
    return 1;
  }

  const hintStillThere = instructionsPaths.some(
    (instructionsPath) =>
      removeDiscoveryHints(readDiscoveryInstructions(instructionsPath)).removedCount > 0,
  );
  if (hintStillThere) {
    out();
    out(`${symbols.fail} The managed Codex discovery hint is still present.`);
    if (backupPath) out(dim(`Backup at ${backupPath}`));
    return 1;
  }

  if (lost.length > 0) {
    // Should be impossible, but if it ever happens the user must hear it from
    // us rather than discover it later.
    out();
    out(`${symbols.fail} Other MCP servers went missing: ${lost.join(", ")}`);
    if (backupPath) out(`    Restore from ${backupPath}`);
    return 1;
  }

  out();
  out(`${symbols.ok} Removed.`);
  if (othersAfter.length > 0) {
    out(dim(`Untouched: ${othersAfter.join(", ")}`));
  }
  if (backupPath) out(dim(`Previous config backed up to ${backupPath}`));
  out();
  out(dim("The package itself is still installed."));
  out(dim("If installed globally: npm uninstall -g sol-luna-orchestrator"));

  return 0;
}

const hasSubTables = (text: string): boolean =>
  listSubTables(text, serverTable()).length > 0;
