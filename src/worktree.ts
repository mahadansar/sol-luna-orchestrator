import fs from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import {
  ALLOW_DIRTY_WORKTREE_BASE,
  KEEP_WORKTREES,
  WORKTREE_DIR,
  WORKTREE_LINK_DIRS,
} from "./config.js";
import {
  addWorktree,
  collectWorktreeChanges,
  currentHead,
  ensureLocalExclude,
  findRepoRoot,
  hasCommits,
  isGitAvailable,
  listDirtyPaths,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  type WorktreeChanges,
} from "./git.js";

/**
 * Raised when parallel isolation cannot be provided safely.
 *
 * Always actionable: the caller can either fix what it names or fall back to
 * sequential execution in the shared workspace.
 */
export class WorktreeUnavailableError extends Error {
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(`${message} ${remedy}`);
    this.name = "WorktreeUnavailableError";
  }
}

export interface WorktreeBase {
  repoRoot: string;
  /** Commit every worker's worktree is created from. */
  baseCommit: string;
  /** Uncommitted paths in the main tree, for reporting. */
  dirtyPaths: string[];
}

/**
 * Check that the workspace can host isolated worktrees, and decide whether it is
 * safe to do so right now.
 *
 * Workers branch from HEAD. If the user has uncommitted work inside a task's
 * declared scope, the worker would start from a stale base and its result would
 * silently ignore — or on integration overwrite — those edits. That is refused
 * rather than warned about.
 */
export async function prepareWorktreeBase(
  workspace: string,
  scopes: string[][],
  allowDirty = ALLOW_DIRTY_WORKTREE_BASE,
): Promise<WorktreeBase> {
  if (!(await isGitAvailable())) {
    throw new WorktreeUnavailableError(
      "git was not found on PATH, so isolated worktrees cannot be created.",
      'Install git, or run this batch sequentially with mode:"sequential".',
    );
  }

  const repoRoot = await findRepoRoot(workspace);
  if (!repoRoot) {
    throw new WorktreeUnavailableError(
      `${workspace} is not inside a git repository, so parallel workers cannot be isolated.`,
      'Run `git init` and make one commit, or use mode:"sequential".',
    );
  }

  if (!(await hasCommits(repoRoot))) {
    throw new WorktreeUnavailableError(
      `${repoRoot} has no commits yet, so there is no base revision to branch worktrees from.`,
      'Make an initial commit, or use mode:"sequential".',
    );
  }

  const dirtyPaths = await listDirtyPaths(repoRoot);

  if (!allowDirty && dirtyPaths.length > 0) {
    const conflicting = new Set<string>();
    for (const scope of scopes) {
      if (scope.length === 0) {
        // An unrestricted task claims everything, so any dirt is in its way.
        dirtyPaths.forEach((dirty) => conflicting.add(dirty));
        continue;
      }
      const matches = picomatch(scope, { dot: true, nocase: isCaseInsensitive() });
      for (const dirty of dirtyPaths) {
        if (matches(dirty)) conflicting.add(dirty);
      }
    }

    if (conflicting.size > 0) {
      const listed = [...conflicting].slice(0, 10).join(", ");
      throw new WorktreeUnavailableError(
        `The repository has uncommitted changes inside the file scopes these tasks ` +
          `declare (${listed}${conflicting.size > 10 ? ", ..." : ""}). Workers branch ` +
          `from HEAD, so they would not see this work and integrating their results ` +
          `could overwrite it.`,
        'Commit or stash those files, narrow the task scopes, use mode:"sequential", ' +
          "or set SOL_LUNA_ALLOW_DIRTY=1 if you accept the risk.",
      );
    }
  }

  return { repoRoot, baseCommit: await currentHead(repoRoot), dirtyPaths };
}

const isCaseInsensitive = (): boolean =>
  process.platform === "win32" || process.platform === "darwin";

export interface TaskWorktree {
  taskId: string;
  path: string;
  repoRoot: string;
  /** Non-fatal problems, e.g. a shared directory that could not be linked. */
  warnings: string[];
}

/**
 * Create an isolated worktree for one task.
 *
 * On any failure partway through, whatever was created is torn down before the
 * error propagates, so a half-built worktree never survives to confuse the next
 * run.
 */
export async function createTaskWorktree(
  base: WorktreeBase,
  taskId: string,
  mainWorkspace: string,
): Promise<TaskWorktree> {
  const target = path.join(base.repoRoot, ...WORKTREE_DIR.split("/"), taskId);
  const warnings: string[] = [];

  await fs.mkdir(path.dirname(target), { recursive: true });

  // Keep the runtime directory out of `git status` without touching the user's
  // tracked .gitignore.
  await ensureLocalExclude(base.repoRoot, `${WORKTREE_DIR.split("/")[0]}/`, {
    readFile: (p) => fs.readFile(p, "utf8"),
    appendFile: (p, s) => fs.appendFile(p, s, "utf8"),
    mkdir: async (p) => {
      await fs.mkdir(p, { recursive: true });
    },
  }).catch((error: unknown) => {
    warnings.push(`Could not update .git/info/exclude: ${(error as Error).message}`);
  });

  // A previous crash may have left this path behind.
  await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);

  try {
    await addWorktree(base.repoRoot, target, base.baseCommit);
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    await pruneWorktrees(base.repoRoot).catch(() => undefined);
    throw error;
  }

  try {
    warnings.push(...(await linkSharedDirectories(mainWorkspace, target)));
  } catch (error) {
    await removeWorktree(base.repoRoot, target).catch(() => undefined);
    throw error;
  }

  return { taskId, path: target, repoRoot: base.repoRoot, warnings };
}

/**
 * Link dependency directories from the main workspace into a worktree.
 *
 * A worktree holds tracked files only, so `node_modules` is missing and every
 * verification command would fail to resolve its imports. Junctions are used on
 * Windows because they need no elevated privileges, unlike symlinks.
 */
export async function linkSharedDirectories(
  mainWorkspace: string,
  worktreePath: string,
  dirs: string[] = WORKTREE_LINK_DIRS,
): Promise<string[]> {
  const warnings: string[] = [];

  for (const dir of dirs) {
    const source = path.resolve(mainWorkspace, dir);
    const destination = path.join(worktreePath, dir);

    const sourceStat = await fs.stat(source).catch(() => null);
    if (!sourceStat?.isDirectory()) continue;

    const existing = await fs.lstat(destination).catch(() => null);
    if (existing) continue;

    await fs.mkdir(path.dirname(destination), { recursive: true }).catch(() => undefined);

    try {
      await fs.symlink(
        source,
        destination,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      warnings.push(
        `Could not link ${dir} into the worktree (${(error as Error).message}). ` +
          `Verification commands that need it will fail.`,
      );
    }
  }

  return warnings;
}

export interface WorktreeOutcome {
  changes: WorktreeChanges;
  warnings: string[];
}

/** Read what a worker changed before the worktree is torn down. */
export async function readWorktreeOutcome(
  worktree: TaskWorktree,
): Promise<WorktreeOutcome> {
  const warnings: string[] = [];
  try {
    const changes = await collectWorktreeChanges(worktree.path);
    // Linked directories are not the worker's work.
    const linked = new Set(WORKTREE_LINK_DIRS);
    return {
      changes: {
        ...changes,
        files: changes.files.filter((file) => !linked.has(file.path.split("/")[0] ?? "")),
      },
      warnings,
    };
  } catch (error) {
    warnings.push(`Could not read worktree changes: ${(error as Error).message}`);
    return { changes: { files: [], diff: "" }, warnings };
  }
}

export type CleanupReason = "success" | "failure" | "cancelled";

/**
 * Remove a worktree unless it is worth keeping as evidence.
 *
 * Linked directories are unlinked first: on Windows a junction that git deletes
 * recursively would take the real `node_modules` with it.
 */
export async function cleanupWorktree(
  worktree: TaskWorktree,
  reason: CleanupReason,
  keepPolicy = KEEP_WORKTREES,
): Promise<{ removed: boolean; keptAt?: string; error?: string }> {
  const keep =
    keepPolicy === "always" || (keepPolicy === "onfailure" && reason !== "success");

  if (keep) return { removed: false, keptAt: worktree.path };

  await unlinkSharedDirectories(worktree.path);

  const result = await removeWorktree(worktree.repoRoot, worktree.path);
  if (!result.removed) {
    // Fall back to removing the directory outright, then let git forget it.
    await fs.rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
    await pruneWorktrees(worktree.repoRoot).catch(() => undefined);
    const stillThere = await fs.stat(worktree.path).catch(() => null);
    if (stillThere) return { removed: false, keptAt: worktree.path, error: result.error };
  }

  await pruneWorktrees(worktree.repoRoot).catch(() => undefined);
  return { removed: true };
}

/**
 * Remove the links created by `linkSharedDirectories`.
 *
 * `fs.rm` on a junction removes the link, not the target, but only when the
 * junction itself is the target of the call — which is why this runs before any
 * recursive delete of the worktree.
 */
export async function unlinkSharedDirectories(
  worktreePath: string,
  dirs: string[] = WORKTREE_LINK_DIRS,
): Promise<void> {
  for (const dir of dirs) {
    const destination = path.join(worktreePath, dir);
    const stat = await fs.lstat(destination).catch(() => null);
    if (!stat?.isSymbolicLink()) continue;
    await fs.unlink(destination).catch(() => undefined);
  }
}

/**
 * Remove worktrees left behind by an earlier crashed run.
 *
 * Only touches paths under this project's own runtime directory, so a user's
 * own worktrees are never candidates.
 */
export async function pruneStaleWorktrees(repoRoot: string): Promise<string[]> {
  const removed: string[] = [];
  const ours = path.join(repoRoot, ...WORKTREE_DIR.split("/"));

  const entries = await listWorktrees(repoRoot).catch(() => []);
  for (const entry of entries) {
    const relative = path.relative(ours, entry.path);
    const isOurs =
      relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    if (!isOurs) continue;

    await unlinkSharedDirectories(entry.path);
    const result = await removeWorktree(repoRoot, entry.path, 1);
    if (result.removed) removed.push(entry.path);
  }

  await pruneWorktrees(repoRoot).catch(() => undefined);
  return removed;
}
