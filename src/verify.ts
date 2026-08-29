import { spawn } from "cross-spawn";
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import {
  DEFAULT_ALLOWED_EXECUTABLES,
  CommandPolicyError,
  launchesThroughCmd,
  parseCommand,
  unrepresentableCmdArgument,
  type CommandPolicy,
} from "./command.js";
import {
  ExecutableResolutionError,
  resolveExecutable,
  withoutCwdExecutableLookup,
} from "./executable.js";
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

  return { env: withoutCwdExecutableLookup(env), scrubbed: scrubbed.sort() };
}

/**
 * Terminate a process and everything it started.
 *
 * `npm test` spawns node, which spawns a test runner. Killing only the direct
 * child orphans the rest, which then keeps holding the workspace.
 */
function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        // Absolute path only: this runs with the orchestrator's own cwd, which
        // is routinely the workspace a worker just wrote to, and Windows would
        // otherwise prefer a `taskkill.cmd` sitting there.
        const killer = nodeSpawn(
          resolveExecutable("taskkill"),
          ["/pid", String(pid), "/T", "/F"],
          {
            stdio: "ignore",
            windowsHide: true,
            env: withoutCwdExecutableLookup(process.env),
          },
        );
        const killDirectChild = (): void => {
          try {
            // A restricted Windows environment can deny taskkill even though
            // the verifier still owns its direct child. Preserve cleanup by
            // terminating that child as a fallback; /T already handled the
            // full tree when taskkill succeeded.
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        };
        killer.once("error", () => {
          killDirectChild();
          finish();
        });
        killer.once("close", (code) => {
          if (code !== 0) killDirectChild();
          finish();
        });
      } catch {
        // Best effort.
        finish();
      }
    });
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
  return Promise.resolve();
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
    signal?: AbortSignal;
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

  // Resolve the executable ourselves before launching. `cwd` here is the
  // workspace a worker just wrote to, and both Windows and a `PATH` containing
  // `.` search it ahead of the real tool — which would let a planted `npm.cmd`
  // satisfy an allowlisted `npm`. The allowlist decides *which name* may run;
  // this decides *which file* that name means, and the launcher then gets an
  // absolute path it cannot reinterpret.
  let launchFile = file;
  if (!useShell) {
    try {
      launchFile = resolveExecutable(file, { env });
    } catch (error) {
      // An unresolvable name is a missing tool, not a policy refusal, and is
      // reported exactly as an ENOENT launch failure always was: nothing ran,
      // and the check counts as failed rather than merely refused.
      const reason =
        error instanceof ExecutableResolutionError
          ? error.message
          : `Could not resolve executable: ${(error as Error).message}`;
      return Promise.resolve({
        command,
        exitCode: null,
        passed: false,
        execution: "argv" as const,
        output:
          `[orchestrator] failed to launch: ${reason} ` +
          `(is "${file}" installed and on PATH?)`,
      });
    }

    // A `.cmd`/`.bat` launcher means cmd.exe re-parses our argv as text, after
    // the escaping that protected the first parse has already been consumed.
    // Two characters cannot survive that intact, and one of them is a command
    // separator, so the form is refused rather than escaped more cleverly.
    if (launchesThroughCmd(launchFile)) {
      const unsafe = unrepresentableCmdArgument(args);
      if (unsafe) {
        return Promise.resolve({
          command,
          exitCode: null,
          passed: false,
          execution: "rejected" as const,
          output:
            `[orchestrator] Command refused by verification policy. Argument ` +
            `${JSON.stringify(unsafe.argument)} contains ${unsafe.label}, which ` +
            `cannot be passed safely through the Windows "${path.basename(launchFile)}" ` +
            `launcher: cmd.exe parses the forwarded argument a second time, where ` +
            `it would end the quoted span or expand a variable. Rewrite the ` +
            `argument without it, or add a script to the project and call that.`,
        });
      }
    }
  }

  if (options.signal?.aborted) {
    return Promise.resolve({
      command,
      exitCode: null,
      passed: false,
      execution: useShell ? "shell" : "argv",
      output: "[orchestrator] verification cancelled before launch",
    });
  }

  return new Promise((resolve) => {
    const child = useShell
      ? nodeSpawn(command, {
          cwd: workingDirectory,
          shell: true,
          windowsHide: true,
          env,
          detached: process.platform !== "win32",
        })
      : spawn(launchFile, args, {
          cwd: workingDirectory,
          shell: false,
          windowsHide: true,
          env,
          detached: process.platform !== "win32",
        });

    let output = "";
    let settled = false;
    let closeResolve: ((code: number | null) => void) | undefined;
    const closePromise = new Promise<number | null>((resolveClose) => {
      closeResolve = resolveClose;
    });

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
      if (options.signal && onAbort) {
        options.signal.removeEventListener("abort", onAbort);
      }

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

    const cancelAfterTermination = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal && onAbort) {
        options.signal.removeEventListener("abort", onAbort);
      }

      if (child.pid) {
        // Wait for both the tree terminator and the child's close event. The
        // latter reaps the direct child; the former waits for taskkill on
        // Windows and kills the detached process group on POSIX.
        await Promise.all([killProcessTree(child.pid), closePromise]);
      }

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
        exitCode: null,
        passed: false,
        execution: useShell ? "shell" : "argv",
        output: truncate(
          (output + "\n[orchestrator] verification cancelled" + notes.join("")).trim(),
        ),
      });
    };

    const onAbort = (): void => {
      void cancelAfterTermination();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      const pid = child.pid;
      const finishTimeout = async (): Promise<void> => {
        if (pid) await Promise.all([killProcessTree(pid), closePromise]);
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
          exitCode: null,
          passed: false,
          execution: useShell ? "shell" : "argv",
          output: truncate(
            (
              output +
              `\n[orchestrator] timed out after ${timeoutSeconds}s` +
              notes.join("")
            ).trim(),
          ),
        });
      };
      void finishTimeout();
    }, timeoutSeconds * 1000);

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) void cancelAfterTermination();

    child.on("error", (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === "ENOENT" ? ` (is "${file}" installed and on PATH?)` : "";
      finish(null, `\n[orchestrator] failed to launch: ${error.message}${hint}`);
    });
    child.on("close", (code: number | null) => finish(code));
    child.on("close", (code: number | null) => closeResolve?.(code));
  });
}

/** Run every verification command in order. */
export async function runVerifications(
  commands: string[],
  workingDirectory: string,
  options: { signal?: AbortSignal } = {},
): Promise<VerificationRun[]> {
  const results: VerificationRun[] = [];
  for (const command of commands) {
    if (options.signal?.aborted) break;
    results.push(
      await runVerificationCommand(command, workingDirectory, {
        signal: options.signal,
      }),
    );
    if (options.signal?.aborted) break;
  }
  return results;
}
