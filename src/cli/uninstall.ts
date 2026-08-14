import { codexVersion, getRegisteredServer, readConfig, writeConfig } from "./codex.js";
import { codexConfigPath } from "./paths.js";
import { SERVER_NAME, serverTable } from "./settings.js";
import { findTable, listSubTables, removeTable } from "./toml-edit.js";
import { bold, dim, out, symbols } from "./ui.js";

/**
 * Remove this project's Codex registration and nothing else.
 *
 * Scope is deliberately tiny: one MCP table and its sub-tables. It never
 * touches other servers, other settings, the Codex installation, or anything on
 * disk that belongs to the user. Idempotent — running it twice is a no-op.
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

export async function uninstallCommand(argv: string[]): Promise<number> {
  const options: UninstallOptions = { dryRun: argv.includes("--dry-run") };
  const configPath = codexConfigPath();

  out(bold("Sol-Luna Orchestrator uninstall"));
  out();

  const before = readConfig(configPath);
  const othersBefore = listSubTables(before, ["mcp_servers"]).filter(
    (name) => name !== SERVER_NAME,
  );

  const codex = await codexVersion();
  const registered = codex.available
    ? await getRegisteredServer(SERVER_NAME)
    : { registered: false };
  const inConfig = findTable(before, serverTable()) !== null;

  if (!registered.registered && !inConfig) {
    out(`${symbols.ok} Not configured. Nothing to remove.`);
    if (othersBefore.length > 0) {
      out(dim(`Left untouched: ${othersBefore.join(", ")}`));
    }
    return 0;
  }

  out(`Will remove MCP server "${SERVER_NAME}" from ${configPath}`);
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
  out(dim("The package itself is still installed; remove it with npm if you want."));

  return 0;
}

const hasSubTables = (text: string): boolean =>
  listSubTables(text, serverTable()).length > 0;
