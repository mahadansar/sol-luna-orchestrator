import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Codex's configuration directory, honouring CODEX_HOME. */
export function codexHome(): string {
  const override = process.env.CODEX_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".codex");
}

export const codexConfigPath = (): string => path.join(codexHome(), "config.toml");

/** Root of this installed package, found by walking up to its package.json. */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to two levels up from dist/cli, which is the built layout.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Absolute path to the MCP stdio server Codex will launch. */
export const serverEntryPath = (): string =>
  path.join(packageRoot(), "dist", "server.js");

export interface InstallLocation {
  root: string;
  serverEntry: string;
  serverEntryExists: boolean;
  /**
   * True when the package lives in a cache that npm may evict — an `npx`
   * one-shot run, for example. Registering that path with Codex produces a
   * configuration that works today and breaks silently later, so `init` refuses
   * it unless the user insists.
   */
  ephemeral: boolean;
  reason?: string;
}

const EPHEMERAL_MARKERS = [
  `${path.sep}_npx${path.sep}`,
  `${path.sep}.npm${path.sep}_cacache${path.sep}`,
  `${path.sep}npm-cache${path.sep}_npx${path.sep}`,
];

export function installLocation(): InstallLocation {
  const root = packageRoot();
  const serverEntry = serverEntryPath();
  const normalized = root.toLowerCase();

  const marker = EPHEMERAL_MARKERS.find((entry) =>
    normalized.includes(entry.toLowerCase()),
  );

  return {
    root,
    serverEntry,
    serverEntryExists: fs.existsSync(serverEntry),
    ephemeral: marker !== undefined,
    reason: marker
      ? "the package is running from an npx cache, which npm can delete at any time"
      : undefined,
  };
}

interface PackageManifest {
  version?: string;
  engines?: { node?: string };
}

function readManifest(): PackageManifest {
  try {
    const raw = fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8");
    return JSON.parse(raw) as PackageManifest;
  } catch {
    return {};
  }
}

/** Read this package's own version without importing JSON at runtime. */
export function packageVersion(): string {
  return readManifest().version ?? "unknown";
}

/**
 * The declared `engines.node` range, parsed into a comparable minimum.
 *
 * `doctor` reports this rather than a constant of its own, so the diagnostic
 * and the package metadata cannot drift apart and tell a user two different
 * things about which Node versions are supported.
 */
export function minimumNode(): { range: string; major: number; minor: number } {
  const range = readManifest().engines?.node ?? ">=22.12.0";
  const match = /(\d+)\.(\d+)/.exec(range);
  return {
    range,
    major: Number(match?.[1] ?? 22),
    minor: Number(match?.[2] ?? 12),
  };
}
