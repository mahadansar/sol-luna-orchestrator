import { spawn } from "cross-spawn";
import { spawn as nodeSpawn } from "node:child_process";
import {
  DEFAULT_ALLOWED_EXECUTABLES,
  CommandPolicyError,
  parseCommand,
  type CommandPolicy,
} from "./command.js";
import {
  EXTRA_ALLOWED_EXECUTABLES,
  MAX_OUTPUT_CHARS,
  VERIFY_MODE,
  VERIFY_SCRUB_ENV,
  VERIFY_TIMEOUT_SECONDS,
  type VerifyMode,
} from "./config.js";

export interface VerificationRun {
  command: string;
  exitCode: number | null;
  passed: boolean;
  output: string;
  /** How this command was executed, or why it was not. */
  execution: "argv" | "shell" | "rejected" | "skipped";
}

export const verificationPolicy: CommandPolicy = {
  allowed: [...DEFAULT_ALLOWED_EXECUTABLES, ...EXTRA_ALLOWED_EXECUTABLES],
};

export function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.4));
  const tail = text.slice(-Math.floor(limit * 0.6));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n... [${omitted} chars omitted] ...\n${tail}`;
}

/** Variables that look like credentials and should not reach a test process. */
const SENSITIVE_ENV =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|COOKIE|AUTH)/i;

/** Variables matching the pattern above that are nonetheless harmless. */
const SENSITIVE_ENV_EXCEPTIONS = new Set([
  "SSH_AUTH_SOCK",
  "GPG_AGENT_INFO",
  "AUTHORITY",
]);

/**
 * Build the environment for a verification command.
 *
 * Output from these commands is fed back into a model transcript, so anything
 * credential-shaped is dropped unless the operator opted out.
 */
export function buildVerificationEnv(
  source: NodeJS.ProcessEnv = process.env,
  scrub = VERIFY_SCRUB_ENV,
): { env: Record<string, string>; scrubbed: string[] } {
  const env: Record<string, string> = {};
  const scrubbed: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (scrub && SENSITIVE_ENV.test(key) && !SENSITIVE_ENV_EXCEPTIONS.has(key)) {
      scrubbed.push(key);
      continue;
    }
    env[key] = value;
  }

  return { env, scrubbed: scrubbed.sort() };
}

/**
 * Terminate a process and everything it started.
 *
 * `npm test` spawns node, which spawns a test runner. Killing only the direct
 * child orphans the rest, which then keeps holding the workspace.
 */
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // Best effort.
    }
    return;
  }
  try {
    // Negative pid targets the process group created by `detached: true`.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run one verification command in the workspace and capture its real outcome.
 *
 * This runs after the worker has exited, and its exit code — not the worker's
 * self-report — is what decides the verdict.
 */
export function runVerificationCommand(
  command: string,
  workingDirectory: string,
  options: {
    mode?: VerifyMode;
    timeoutSeconds?: number;
    policy?: CommandPolicy;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<VerificationRun> {
  const mode = options.mode ?? VERIFY_MODE;
  const timeoutSeconds = options.timeoutSeconds ?? VERIFY_TIMEOUT_SECONDS;
  const policy = options.policy ?? verificationPolicy;

  if (mode === "off") {
    return Promise.resolve({
      command,
      exitCode: null,
      passed: false,
      execution: "skipped",
      output:
        "[orchestrator] Independent verification is disabled " +
        "(SOL_LUNA_VERIFY_MODE=off). This command was NOT run; the worker's own " +
        "claim about it is unverified.",
    });
  }

  let file = command;
  let args: string[] = [];
  const useShell = mode === "shell";

  if (!useShell) {
    try {
      const parsed = parseCommand(command, policy);
      file = parsed.file;
      args = parsed.args;
    } catch (error) {
      const reason =
        error instanceof CommandPolicyError
          ? error.message
          : `Could not parse command: ${(error as Error).message}`;
      return Promise.resolve({
        command,
        exitCode: null,
        passed: false,
        execution: "rejected",
        output: `[orchestrator] Command refused by verification policy. ${reason}`,
      });
    }
  }

  const { env, scrubbed } = buildVerificationEnv(options.env);

  return new Promise((resolve) => {
    const child = useShell
      ? nodeSpawn(command, {
          cwd: workingDirectory,
          shell: true,
          windowsHide: true,
          env,
          detached: process.platform !== "win32",
        })
      : spawn(file, args, {
          cwd: workingDirectory,
          shell: false,
          windowsHide: true,
          env,
          detached: process.platform !== "win32",
        });

    let output = "";
    let settled = false;

    const append = (chunk: Buffer): void => {
      // Bound memory on pathologically chatty commands; only an excerpt is
      // reported anyway.
      if (output.length < MAX_OUTPUT_CHARS * 8) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const finish = (exitCode: number | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const notes: string[] = [];
      if (scrubbed.length > 0) {
        notes.push(
          `\n[orchestrator] ${scrubbed.length} credential-shaped env var(s) were ` +
            `hidden from this command (${scrubbed.slice(0, 5).join(", ")}` +
            `${scrubbed.length > 5 ? ", ..." : ""}). ` +
            `Set SOL_LUNA_VERIFY_ENV_PASSTHROUGH=1 if the suite genuinely needs them.`,
        );
      }

      resolve({
        command,
        exitCode,
        passed: exitCode === 0,
        execution: useShell ? "shell" : "argv",
        output: truncate((output + extra + notes.join("")).trim()),
      });
    };

    const timer = setTimeout(() => {
      if (child.pid) killProcessTree(child.pid);
      finish(null, `\n[orchestrator] timed out after ${timeoutSeconds}s`);
    }, timeoutSeconds * 1000);

    child.on("error", (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === "ENOENT" ? ` (is "${file}" installed and on PATH?)` : "";
      finish(null, `\n[orchestrator] failed to launch: ${error.message}${hint}`);
    });
    child.on("close", (code: number | null) => finish(code));
  });
}

/** Run every verification command in order. */
export async function runVerifications(
  commands: string[],
  workingDirectory: string,
): Promise<VerificationRun[]> {
  const results: VerificationRun[] = [];
  for (const command of commands) {
    results.push(await runVerificationCommand(command, workingDirectory));
  }
  return results;
}
