/**
 * Trusted resolution of executable names to absolute paths.
 *
 * Everything this project launches runs with `cwd` set to a directory a worker
 * can write into. That matters more than it looks:
 *
 *   - On Windows, `cmd.exe` and libuv's own `search_path()` both look in the
 *     *current directory* before walking `PATH`, unless
 *     `NoDefaultCurrentDirectoryInExePath` is set — and it is not set by
 *     default. `spawn("npm", args, { cwd: workspace, shell: false })` therefore
 *     runs `<workspace>\npm.cmd` when one exists, in preference to the real
 *     npm. A worker running under `workspace-write` can create that file.
 *   - On POSIX the same happens whenever `PATH` contains `.` or an empty entry.
 *
 * `command.ts` refuses an executable that *spells* a path, which is what
 * SECURITY.md means by "a repo-local `./npm` cannot hijack the real one". That
 * check is lexical; it cannot see how the operating system later resolves a
 * bare name. This module supplies the missing half: resolve the name ourselves,
 * from `PATH` only, and hand the launcher an absolute path it cannot
 * reinterpret.
 *
 * Failing to resolve is deliberately an error rather than a fall-through to the
 * bare name: falling through would restore exactly the behaviour this exists to
 * remove.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Set on every child we launch. Windows honours it in both `cmd.exe` and
 * `CreateProcess`-based lookups, so it also covers the nested resolution inside
 * a `.cmd` shim that we never get to see.
 */
export const NO_CWD_IN_EXE_PATH_ENV = "NoDefaultCurrentDirectoryInExePath";

/** The platform-specific half of `node:path`. */
type PlatformPath = typeof path.win32;

/** Default Windows extension list, used when `PATHEXT` is unset. */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export class ExecutableResolutionError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = "ExecutableResolutionError";
  }
}

/** Injected in tests; production always reads the real filesystem. */
export interface ExecutableProbe {
  /** True when `candidate` exists and is a regular file we may execute. */
  isExecutableFile(candidate: string): boolean;
}

const realProbe: ExecutableProbe = {
  isExecutableFile(candidate) {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(candidate);
    } catch {
      return false;
    }
    if (!stats.isFile()) return false;
    if (process.platform === "win32") return true;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export const hasPathSeparator = (value: string): boolean =>
  value.includes("/") || value.includes("\\");

/** A drive-qualified or drive-relative name; Windows resolves these itself. */
const isWindowsDriveQualified = (value: string): boolean => /^[A-Za-z]:/.test(value);

/**
 * `PATH` entries we refuse to search.
 *
 * An empty entry and `.` both mean "the current directory", which is the
 * untrusted workspace. A relative entry resolves against it too. Dropping them
 * is the whole point, so a `PATH` made entirely of such entries resolves
 * nothing rather than resolving from the workspace.
 */
function usablePathEntries(
  rawPath: string | undefined,
  delimiter: string,
  paths: PlatformPath,
): string[] {
  return (rawPath ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .map((entry) =>
      entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')
        ? entry.slice(1, -1)
        : entry,
    )
    .filter((entry) => entry.length > 0 && entry !== "." && paths.isAbsolute(entry));
}

/**
 * Candidate filenames for one directory.
 *
 * Mirrors `which`: a name that already carries a dot is tried verbatim first,
 * then with each `PATHEXT` suffix, so `npm.cmd` and `npm` both resolve.
 */
function windowsCandidates(file: string, pathExt: string[]): string[] {
  const withExtensions = pathExt.map((extension) => `${file}${extension}`);
  return file.includes(".") ? [file, ...withExtensions] : withExtensions;
}

export interface ResolveExecutableOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  probe?: ExecutableProbe;
  /** Overrides `path.delimiter`; only tests need this. */
  delimiter?: string;
}

/**
 * Resolve a bare executable name to an absolute path, searching `PATH` only.
 *
 * A name that already spells a path is returned unchanged: reaching one
 * requires an operator to have listed that exact path in
 * `SOL_LUNA_VERIFY_ALLOW`, which is a deliberate decision this must not
 * silently rewrite.
 */
export function resolveExecutable(
  file: string,
  options: ResolveExecutableOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const probe = options.probe ?? realProbe;
  const isWindows = platform === "win32";
  // Resolve with the *target* platform's path rules rather than the host's, so
  // the same function is testable for both from either.
  const paths: PlatformPath = isWindows ? path.win32 : path.posix;
  const delimiter = options.delimiter ?? (isWindows ? ";" : ":");

  if (hasPathSeparator(file) || (isWindows && isWindowsDriveQualified(file))) {
    return file;
  }

  // Windows environment lookup is case-insensitive; Node preserves whatever
  // case the parent used, so find the key rather than assuming `PATH`.
  const pathKey = isWindows
    ? (Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH")
    : "PATH";
  const directories = usablePathEntries(env[pathKey], delimiter, paths);

  const pathExt = isWindows
    ? (env.PATHEXT ?? DEFAULT_PATHEXT)
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

  for (const directory of directories) {
    const names = isWindows ? windowsCandidates(file, pathExt) : [file];
    for (const name of names) {
      const candidate = paths.join(directory, name);
      if (probe.isExecutableFile(candidate)) return candidate;
    }
  }

  throw new ExecutableResolutionError(
    `Executable "${file}" was not found on PATH. ` +
      `The working directory is deliberately not searched, so a file of that ` +
      `name inside the workspace cannot stand in for the real tool.`,
    file,
  );
}

/**
 * Copy an environment and pin off current-directory executable lookup.
 *
 * Defence in depth for the resolution we do not perform ourselves: a `.cmd`
 * shim we launch by absolute path still runs under `cmd.exe`, which would
 * otherwise resolve *its* own commands from the workspace.
 */
export function withoutCwdExecutableLookup<T extends NodeJS.ProcessEnv>(
  env: T,
): T & Record<string, string> {
  return { ...env, [NO_CWD_IN_EXE_PATH_ENV]: "1" } as T & Record<string, string>;
}
