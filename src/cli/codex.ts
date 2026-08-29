import { spawn } from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import {
  ExecutableResolutionError,
  resolveExecutable,
  withoutCwdExecutableLookup,
} from "../executable.js";
import { codexConfigPath } from "./paths.js";

/**
 * Wrapper around the Codex CLI and its config file.
 *
 * Read-only checks use the Codex CLI where it is authoritative. Registration
 * writes go through the surgical TOML editor so this project changes only the
 * table and keys it owns, without round-tripping unrelated user configuration.
 */

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(
  file: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<CommandResult> {
  // The CLI runs in whatever directory the operator happens to be in, which is
  // routinely a repository they are evaluating rather than one they wrote.
  // Windows resolves a bare `codex` or `git` from that directory before PATH,
  // so resolve it here instead and hand `spawn` an absolute path.
  let executable: string;
  try {
    executable = resolveExecutable(file);
  } catch (error) {
    // Same wording an ENOENT launch produced before resolution moved earlier,
    // so the CLI diagnostic surface is unchanged.
    const detail =
      error instanceof ExecutableResolutionError
        ? `${file} not found on PATH`
        : `failed to resolve ${file}: ${(error as Error).message}`;
    return Promise.resolve({ code: null, stdout: "", stderr: detail });
  }

  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      env: withoutCwdExecutableLookup(process.env),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const finish = (code: number | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, `\ntimed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(null, error.code === "ENOENT" ? `${file} not found on PATH` : error.message);
    });
    child.on("close", (code) => finish(code));
  });
}

export interface ToolInfo {
  available: boolean;
  version?: string;
  error?: string;
}

export async function codexVersion(): Promise<ToolInfo> {
  const result = await run("codex", ["--version"], 20_000);
  if (result.code !== 0) {
    return { available: false, error: result.stderr.trim() || "codex --version failed" };
  }
  return { available: true, version: result.stdout.trim() };
}

export async function gitVersion(): Promise<ToolInfo> {
  const result = await run("git", ["--version"], 20_000);
  if (result.code !== 0) {
    return { available: false, error: "git not found on PATH" };
  }
  return { available: true, version: result.stdout.trim() };
}

/**
 * Whether Codex has stored credentials.
 *
 * Checked by looking for the auth file rather than by making a network call, so
 * `doctor` stays free and offline.
 */
export function codexAuthPresent(): boolean {
  try {
    return fs.existsSync(path.join(path.dirname(codexConfigPath()), "auth.json"));
  } catch {
    return false;
  }
}

export interface RegisteredServer {
  registered: boolean;
  raw?: string;
  enabled?: boolean;
  command?: string;
  args?: string;
}

/** Ask Codex what it thinks is registered under `name`. */
export async function getRegisteredServer(name: string): Promise<RegisteredServer> {
  const result = await run("codex", ["mcp", "get", name], 30_000);
  if (result.code !== 0) return { registered: false };

  const raw = result.stdout;
  const field = (label: string): string | undefined =>
    raw.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "m"))?.[1]?.trim();

  return {
    registered: true,
    raw,
    enabled: field("enabled") !== "false",
    command: field("command"),
    args: field("args"),
  };
}

// `codex mcp add` / `codex mcp remove` are deliberately not used. Both rewrite
// the whole config file: measured against codex-cli 0.147.0, adding a server
// deleted the comment above an unrelated `context7` table and rewrote that
// server's `startup_timeout_sec = 15` as `15.0`. Registration is done with the
// surgical editor in `toml-edit.ts` instead, so only our own keys are touched.

/** Read the config file, returning an empty string when it does not exist. */
export function readConfig(configPath = codexConfigPath()): string {
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch {
    return "";
  }
}

export interface WriteResult {
  backupPath?: string;
}

/**
 * Write the config file atomically, keeping one backup of the previous content.
 *
 * Written to a temporary file in the same directory and renamed, so an
 * interrupted write cannot leave a half-written config behind: the rename is
 * atomic on every platform this supports, and the original stays intact until
 * it succeeds.
 */
export function writeConfig(
  contents: string,
  configPath = codexConfigPath(),
): WriteResult {
  const directory = path.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true });

  let backupPath: string | undefined;
  if (fs.existsSync(configPath)) {
    backupPath = `${configPath}.sol-luna-backup`;
    fs.copyFileSync(configPath, backupPath);
  }

  const temporary = path.join(directory, `.config.toml.sol-luna.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, "utf8");
    fs.renameSync(temporary, configPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }

  return { backupPath };
}
