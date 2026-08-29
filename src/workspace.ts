import fs from "node:fs";
import path from "node:path";
import { ALLOWED_WORKSPACE_ROOTS } from "./config.js";
import { defaultRealPathResolver } from "./scope.js";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

function controlName(name: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? name.toLowerCase()
    : name;
}

function hasControlMetadataComponent(
  target: string,
  allowInternalWorktree: boolean,
): boolean {
  const parts = path.resolve(target).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const name = controlName(parts[index]!);
    if (name === ".git") return true;
    if (name !== ".sol-luna") continue;

    // `.sol-luna/worktrees/<id>` (and files below that real worktree) is the
    // one control-tree exception.  A second control directory below it is
    // still blocked by the next loop iteration.
    const isInternalWorktree =
      allowInternalWorktree &&
      controlName(parts[index + 1] ?? "") === "worktrees" &&
      index + 2 < parts.length;
    if (!isInternalWorktree) return true;
  }
  return false;
}

function assertWorkspaceIsNotControlMetadata(
  lexical: string,
  real: string,
  allowInternalWorktree: boolean,
): void {
  if (
    hasControlMetadataComponent(lexical, allowInternalWorktree) ||
    hasControlMetadataComponent(real, allowInternalWorktree)
  ) {
    throw new WorkspaceError(
      `workingDirectory "${real}" is repository or orchestrator control metadata.`,
    );
  }
}

/**
 * Validate and canonicalise the directory a worker will run in.
 *
 * `workingDirectory` comes from the model, and the worker gets write access to
 * whatever it names. We require it to exist, resolve it through symlinks so
 * later scope checks compare like with like, and optionally confine it to roots
 * the operator configured.
 */
export function resolveWorkspace(
  requested: string | undefined,
  allowedRoots: readonly string[] = ALLOWED_WORKSPACE_ROOTS,
  resolver = defaultRealPathResolver,
  options: { allowInternalWorktree?: boolean } = {},
): string {
  const candidate = requested ?? process.cwd();

  if (!path.isAbsolute(candidate)) {
    throw new WorkspaceError(
      `workingDirectory must be an absolute path; received "${candidate}".`,
    );
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(candidate);
  } catch {
    throw new WorkspaceError(`workingDirectory does not exist: "${candidate}".`);
  }
  if (!stats.isDirectory()) {
    throw new WorkspaceError(`workingDirectory is not a directory: "${candidate}".`);
  }

  const real = resolver(candidate);

  // Check both spellings.  A symlink or junction can hide a control directory
  // from either the requested path or its canonical target, and a workspace
  // rooted at that directory would otherwise reset the scope boundary around
  // the metadata itself.
  assertWorkspaceIsNotControlMetadata(
    candidate,
    real,
    options.allowInternalWorktree === true,
  );

  if (allowedRoots.length > 0) {
    const permitted = allowedRoots.some((root) => {
      const realRoot = resolver(path.resolve(root));
      const relative = path.relative(realRoot, real);
      return (
        relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
      );
    });

    if (!permitted) {
      throw new WorkspaceError(
        `workingDirectory "${real}" is outside the roots this orchestrator is ` +
          `allowed to work in (SOL_LUNA_ALLOWED_ROOTS).`,
      );
    }
  }

  return real;
}
