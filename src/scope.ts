import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

export interface ResolvedPath {
  /** Workspace-relative POSIX path, or absolute POSIX path when outside. */
  relative: string;
  /** True when the path resolves outside the workspace root. */
  outside: boolean;
}

/** Resolves a path to its on-disk identity, following symlinks. */
export type RealPathResolver = (target: string) => string;

/**
 * Resolve symlinks as far as the filesystem allows.
 *
 * A file the worker deleted no longer exists, so `realpath` on it would throw.
 * We walk up to the deepest ancestor that does exist, resolve that, and
 * re-attach the remainder — enough to catch a symlinked parent directory
 * pointing out of the workspace.
 */
export const defaultRealPathResolver: RealPathResolver = (target) => {
  let current = path.resolve(target);
  const tail: string[] = [];

  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
};

/**
 * Resolve a path reported by the Codex runtime (or claimed by the worker) into
 * a form suitable for glob matching against the task contract.
 *
 * Symlinks are resolved first. Comparing lexical paths would let a symlink
 * inside the workspace point anywhere on disk while still looking contained.
 */
export function resolvePath(
  filePath: string,
  workingDirectory: string,
  resolver: RealPathResolver = defaultRealPathResolver,
): ResolvedPath {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workingDirectory, filePath);

  const realWorkspace = resolver(workingDirectory);
  const realTarget = resolver(absolute);

  const relative = path.relative(realWorkspace, realTarget);
  const outside = !relative || relative.startsWith("..") || path.isAbsolute(relative);

  return {
    relative: outside
      ? realTarget.split(path.sep).join("/")
      : relative.split(path.sep).join("/"),
    outside,
  };
}

/** Convenience wrapper when only the normalized string is needed. */
export const toRelativePosix = (
  filePath: string,
  workingDirectory: string,
  resolver?: RealPathResolver,
): string => resolvePath(filePath, workingDirectory, resolver).relative;

/**
 * Control metadata no delegated task may modify, whatever it was allowed.
 *
 * Two directories, each protected for its own reason:
 *
 *   `.git` is the repository's own control surface. `hooks/pre-commit` runs the
 *   next time the *operator* commits, and `config` alone reaches code execution
 *   several ways (`core.pager`, `core.fsmonitor`, `core.sshCommand`). A worker
 *   that can write there converts a bounded, reviewable file edit into
 *   persistent execution on the operator's machine, outside anything this
 *   runtime observes. No delegated implementation task legitimately edits it —
 *   `.gitignore`, `.gitattributes` and `.github/` are ordinary files and are
 *   deliberately *not* matched.
 *
 *   `.sol-luna` is this orchestrator's own control state: worktree identities
 *   and the filesystem leases that decide which run owns which directory. It is
 *   authoritative runtime state that the runtime later trusts, so a worker able
 *   to edit it could make the orchestrator misread its own evidence. Treating
 *   it as data a task may write would be exactly the confusion this project
 *   exists to prevent.
 *
 * Protected at every depth, not just at the workspace root. A vendored
 * dependency, a submodule, or a fixture repository puts a second `.git`
 * somewhere below, and a hook planted there still executes whenever anyone runs
 * git in that subtree — the escalation does not become safe for being nested.
 * Deliberately creating a nested repository is therefore refused too; that is a
 * rare ask, and a loud scope violation the parent can act on is the right
 * outcome for it.
 *
 * This never blocks the orchestrator's own worktree management. Every scope
 * check resolves paths relative to the *task's* workspace, and a parallel task's
 * workspace is the worktree directory itself, so its files are `src/x.ts`
 * rather than `.sol-luna/worktrees/…/src/x.ts`. Worktree creation and removal
 * do not pass through scope checking at all.
 */
export const PROTECTED_CONTROL_PATHS = [
  ".git",
  ".git/**",
  "**/.git",
  "**/.git/**",
  ".sol-luna",
  ".sol-luna/**",
  "**/.sol-luna",
  "**/.sol-luna/**",
] as const;

/** How a protected-path violation reads in scope evidence. */
export const PROTECTED_CONTROL_VIOLATION =
  "protected repository or orchestrator control metadata";

/**
 * Decide whether a set of touched files respects the task contract.
 *
 * Precedence, highest first:
 *   1. Anything resolving outside the workspace is a violation. `allowedFiles`
 *      globs are workspace-relative, so a broad pattern like `**` must never be
 *      read as authorization to write to `../`, another drive, or through a
 *      symlink.
 *   2. `PROTECTED_CONTROL_PATHS` is a violation regardless of what the caller
 *      declared. It sits above `allowedFiles` rather than inside
 *      `forbiddenFiles` on purpose: `forbiddenFiles` is caller-supplied and a
 *      caller could simply omit it, whereas this is a property of the runtime.
 *      Nothing a caller, a worker, or a model emits can switch it off.
 *   3. `forbiddenFiles` beats `allowedFiles`.
 *   4. An empty `allowedFiles` means unrestricted *within* the workspace, minus
 *      the protected paths above.
 */
export function findScopeViolations(
  touchedFiles: string[],
  allowedFiles: string[],
  forbiddenFiles: string[],
  workingDirectory: string,
  resolver?: RealPathResolver,
): string[] {
  // Windows and macOS are case-insensitive by default; matching case-sensitively
  // there would let `SRC/x.ts` slip past an `src/**` allowlist or a
  // `**/*.SQL` denylist.
  const options: picomatch.PicomatchOptions = {
    dot: true,
    nocase: process.platform === "win32" || process.platform === "darwin",
  };

  const isProtected = picomatch([...PROTECTED_CONTROL_PATHS], options);
  const isForbidden =
    forbiddenFiles.length > 0 ? picomatch(forbiddenFiles, options) : () => false;
  const isAllowed =
    allowedFiles.length > 0 ? picomatch(allowedFiles, options) : () => true;

  const violations: string[] = [];
  for (const file of touchedFiles) {
    const { relative, outside } = resolvePath(file, workingDirectory, resolver);

    // Canonicalisation is necessary for symlink and junction escapes, but it
    // can also erase a control-metadata path component.  For example, a
    // workspace-local `.git` symlink may resolve to an ordinary directory in
    // the same workspace.  Keep the lexical spelling as a second security
    // signal so that `.git/config` and `.sol-luna/state.json` remain protected
    // even when their target has a different canonical name.
    const lexicalAbsolute = path.isAbsolute(file)
      ? path.resolve(file)
      : path.resolve(workingDirectory, file);
    const lexicalRelative = path
      .relative(path.resolve(workingDirectory), lexicalAbsolute)
      .split(path.sep)
      .join("/");

    if (outside) {
      violations.push(`${relative} (outside the workspace)`);
    } else if (isProtected(relative) || isProtected(lexicalRelative)) {
      violations.push(`${relative} (${PROTECTED_CONTROL_VIOLATION})`);
    } else if (isForbidden(relative)) {
      violations.push(`${relative} (matches forbiddenFiles)`);
    } else if (!isAllowed(relative)) {
      violations.push(`${relative} (outside allowedFiles)`);
    }
  }
  return violations;
}
