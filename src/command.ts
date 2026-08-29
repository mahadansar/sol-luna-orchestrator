/**
 * Parsing and policy for model-supplied verification commands.
 *
 * `verificationCommands` arrive from the model. They are untrusted input. This
 * module turns a command string into an argv array without ever consulting a
 * shell, and decides whether the resulting executable is one the operator has
 * agreed to run.
 *
 * Everything here is pure so the policy can be tested exhaustively without
 * spawning anything.
 */

/** Executables allowed by default: standard build/test/lint entry points. */
export const DEFAULT_ALLOWED_EXECUTABLES = [
  // JS/TS
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "deno",
  "node",
  "tsc",
  "vitest",
  "jest",
  "mocha",
  "eslint",
  "prettier",
  "biome",
  // Python
  "python",
  "python3",
  "py",
  "pytest",
  "tox",
  "nox",
  "ruff",
  "mypy",
  "black",
  "flake8",
  "uv",
  "poetry",
  // Other ecosystems
  "go",
  "cargo",
  "rustc",
  "dotnet",
  "mvn",
  "gradle",
  "make",
  "just",
  "cmake",
  "ctest",
  "bundle",
  "rake",
  "rspec",
  "composer",
  "phpunit",
  "swift",
  "dart",
  "flutter",
] as const;

/**
 * Shell constructs that would change control flow or perform substitution.
 *
 * We never invoke a shell, so these would be passed through as literal argv
 * entries and silently do something other than what the model intended.
 * Rejecting is clearer than quietly misbehaving.
 */
const REJECTED_CONSTRUCTS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\|\|?/, label: "pipe or ||" },
  { pattern: /&&?/, label: "&& or background &" },
  { pattern: /;/, label: "command separator ;" },
  { pattern: /[<>]/, label: "redirection < >" },
  { pattern: /`/, label: "backtick substitution" },
  { pattern: /\$\(/, label: "$( ) substitution" },
  { pattern: /\$\{/, label: "${ } expansion" },
  { pattern: /[\r\n]/, label: "newline" },
  { pattern: /\0/, label: "null byte" },
];

export const MAX_COMMAND_LENGTH = 2000;
export const MAX_ARGUMENT_COUNT = 64;

export class CommandPolicyError extends Error {
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message);
    this.name = "CommandPolicyError";
  }
}

/**
 * Split a command string into argv the way a shell would, minus every feature
 * that makes shells dangerous.
 *
 * Supported: whitespace separation, 'single quotes' (fully literal), and
 * "double quotes" (with \" and \\ escapes).
 *
 * Deliberately NOT supported: backslash escaping outside quotes. On Windows a
 * bare backslash is a path separator, so treating it as an escape would mangle
 * `.\gradlew` and `C:\tools\x`. Quote such arguments instead.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === '"') {
      if (char === "\\") {
        const next = command[i + 1];
        // Only \" and \\ are escapes; anything else keeps the backslash so
        // Windows paths inside quotes survive intact.
        if (next === '"' || next === "\\") {
          current += next;
          i += 1;
        } else {
          current += char;
        }
      } else if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (quote) {
    throw new CommandPolicyError(
      `Unbalanced ${quote === '"' ? "double" : "single"} quote.`,
      command,
    );
  }
  if (started) tokens.push(current);

  return tokens;
}

/** Strip a Windows executable extension so `npm.cmd` matches an `npm` rule. */
const stripExecutableExtension = (name: string): string =>
  name.replace(/\.(cmd|bat|exe|com|ps1)$/i, "");

const hasPathSeparator = (value: string): boolean =>
  value.includes("/") || value.includes("\\");

export interface CommandPolicy {
  /** Executable names (no path separators) or exact literal paths. */
  allowed: readonly string[];
}

export interface ParsedCommand {
  /** The original string, for reporting. */
  raw: string;
  /** Executable to launch. */
  file: string;
  /** Arguments, excluding the executable. */
  args: string[];
}

/**
 * Validate a model-supplied command against the operator's policy.
 *
 * Throws `CommandPolicyError` with a reason the model can act on. Note that
 * shell metacharacters *inside quotes* are fine — they become literal argv
 * entries and never reach an interpreter.
 */
export function parseCommand(command: string, policy: CommandPolicy): ParsedCommand {
  const raw = command.trim();

  if (!raw) {
    throw new CommandPolicyError("Command is empty.", command);
  }
  if (raw.length > MAX_COMMAND_LENGTH) {
    throw new CommandPolicyError(
      `Command exceeds ${MAX_COMMAND_LENGTH} characters.`,
      command,
    );
  }

  // Check for shell constructs on the unquoted portions only.
  const unquoted = stripQuotedSections(raw);
  for (const { pattern, label } of REJECTED_CONSTRUCTS) {
    if (pattern.test(unquoted)) {
      throw new CommandPolicyError(
        `Command contains an unsupported shell construct (${label}). ` +
          `Verification runs without a shell, so this would not do what you expect. ` +
          `Use a single command, or add a script to the project and call that.`,
        command,
      );
    }
  }

  const tokens = tokenizeCommand(raw);
  if (tokens.length === 0) {
    throw new CommandPolicyError("Command is empty.", command);
  }
  if (tokens.length > MAX_ARGUMENT_COUNT) {
    throw new CommandPolicyError(
      `Command has more than ${MAX_ARGUMENT_COUNT} arguments.`,
      command,
    );
  }

  const file = tokens[0]!;
  const rest = tokens.slice(1);

  // Exact-match entries in the allowlist may contain separators: an operator who
  // explicitly permits `./gradlew` has made a deliberate decision.
  const exactAllowed = policy.allowed.includes(file);

  if (!exactAllowed) {
    if (hasPathSeparator(file)) {
      throw new CommandPolicyError(
        `Executable "${file}" contains a path. Only bare executable names ` +
          `resolved from PATH are allowed, unless the operator has explicitly ` +
          `permitted this exact path.`,
        command,
      );
    }

    const normalized = stripExecutableExtension(file).toLowerCase();
    const permitted = policy.allowed.some(
      (entry) =>
        !hasPathSeparator(entry) &&
        stripExecutableExtension(entry).toLowerCase() === normalized,
    );

    if (!permitted) {
      throw new CommandPolicyError(
        `Executable "${file}" is not in the verification allowlist. ` +
          `Allowed: ${[...policy.allowed].sort().join(", ")}. ` +
          `An operator can permit more with SOL_LUNA_VERIFY_ALLOW.`,
        command,
      );
    }
  }

  return { raw, file, args: rest };
}

/**
 * Whether launching `resolvedFile` puts a `cmd.exe` layer under our argv.
 *
 * Windows can only launch `.com` and `.exe` directly. Everything else — the
 * `.cmd` and `.bat` shims that `npm`, `yarn`, `mvn`, `gradle` and `tsc` all are
 * on Windows, and every `PATHEXT` script type — is run by handing a command
 * *line* to `cmd.exe`. That is the same condition cross-spawn uses to decide it
 * must escape, and it is the only situation in which our argv is re-parsed as
 * text by an interpreter.
 */
export function launchesThroughCmd(
  resolvedFile: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && !/\.(?:com|exe)$/i.test(resolvedFile);
}

/**
 * Characters an argument may not contain when a `cmd.exe` layer is involved.
 *
 * SECURITY.md promises that "shell metacharacters inside quotes are allowed and
 * passed through literally… they are inert without a shell". On Windows that
 * held for `&`, `|`, `<`, `>`, `^`, `(`, `)` and `%` — all of which were
 * verified to arrive verbatim — but not for these two, because a `.cmd` shim
 * forwards its arguments with `%*` and cmd then parses the result a *second*
 * time, after the escaping that protected the first parse has been consumed:
 *
 *   `"` closes the quoted span in that second parse, so the rest of the
 *       argument becomes live cmd syntax. Verified against a real `npm.cmd`:
 *       `npm run "a\" & echo X & \"b"` executes `echo X`. That is arbitrary
 *       command execution from a model-supplied argument, in the *default*
 *       allowlist mode, which is precisely what the mode exists to prevent.
 *
 *   `!` expands as a delayed-expansion variable reference in any shim that ran
 *       `setlocal enabledelayedexpansion`, substituting an environment value
 *       into an argument whose output is fed back into a model transcript.
 *
 * Neither can be represented safely through that second parse, so they are
 * refused rather than escaped more cleverly. The refusal is narrow: it applies
 * only on Windows, and only when the resolved executable really is launched
 * through `cmd.exe`, so `node -e "…"` and every other `.exe` is untouched.
 */
const CMD_UNREPRESENTABLE: Array<{ character: string; label: string }> = [
  { character: '"', label: "a double quote" },
  { character: "!", label: "an exclamation mark" },
];

/**
 * The first argument that cannot survive a `cmd.exe` launcher, or null.
 *
 * Pure, so the policy is testable for Windows from any platform.
 */
export function unrepresentableCmdArgument(
  args: readonly string[],
): { argument: string; label: string } | null {
  for (const argument of args) {
    for (const { character, label } of CMD_UNREPRESENTABLE) {
      if (argument.includes(character)) return { argument, label };
    }
  }
  return null;
}

/**
 * Compare two verification commands as safe argv, never as shell text.
 *
 * Windows launcher suffixes are equivalent only for bare executable names;
 * arguments remain exact and ordered on every platform.
 */
export function verificationCommandsEquivalent(
  firstCommand: string,
  secondCommand: string,
  policy: CommandPolicy,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    const first = parseCommand(firstCommand, policy);
    const second = parseCommand(secondCommand, policy);
    const pathQualified = (file: string): boolean =>
      hasPathSeparator(file) || (platform === "win32" && /^[A-Za-z]:/.test(file));
    if (pathQualified(first.file) || pathQualified(second.file)) return false;

    const executable = (file: string): string =>
      platform === "win32" ? stripExecutableExtension(file).toLowerCase() : file;
    if (executable(first.file) !== executable(second.file)) return false;
    return (
      first.args.length === second.args.length &&
      first.args.every((argument, index) => argument === second.args[index])
    );
  } catch {
    return false;
  }
}

/** Blank out quoted spans so construct detection only inspects live syntax. */
function stripQuotedSections(command: string): string {
  let result = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;

    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) {
        i += 1;
        continue;
      }
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    result += char;
  }

  return result;
}
