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
 * Decide whether a set of touched files respects the task contract.
 *
 * Precedence, highest first:
 *   1. Anything resolving outside the workspace is a violation. `allowedFiles`
 *      globs are workspace-relative, so a broad pattern like `**` must never be
 *      read as authorization to write to `../`, another drive, or through a
 *      symlink.
 *   2. `forbiddenFiles` beats `allowedFiles`.
 *   3. An empty `allowedFiles` means unrestricted *within* the workspace.
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

  const isForbidden =
    forbiddenFiles.length > 0 ? picomatch(forbiddenFiles, options) : () => false;
  const isAllowed =
    allowedFiles.length > 0 ? picomatch(allowedFiles, options) : () => true;

  const violations: string[] = [];
  for (const file of touchedFiles) {
    const { relative, outside } = resolvePath(file, workingDirectory, resolver);

    if (outside) {
      violations.push(`${relative} (outside the workspace)`);
    } else if (isForbidden(relative)) {
      violations.push(`${relative} (matches forbiddenFiles)`);
    } else if (!isAllowed(relative)) {
      violations.push(`${relative} (outside allowedFiles)`);
    }
  }
  return violations;
}
