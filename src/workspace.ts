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
