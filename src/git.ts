import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Thin, cross-platform wrapper around the git CLI.
 *
 * Every call passes an argument array and never a shell string: paths on the
 * command line here come from the filesystem and from task ids, and quoting
 * rules differ enough between cmd.exe and POSIX shells that going through one
 * is a portability and injection hazard for no benefit.
 */

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly result?: GitResult,
  ) {
    super(message);
    this.name = "GitError";
  }
}

const GIT_TIMEOUT_MS = 120_000;

export function runGit(
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      // Keep git from opening editors, pagers, or credential prompts: this runs
      // unattended and a blocked prompt would hang the batch.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
      },
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
      finish(null, `\ngit timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(
        null,
        error.code === "ENOENT"
          ? "git executable not found on PATH"
          : `failed to launch git: ${error.message}`,
      );
    });
    child.on("close", (code) => finish(code));
  });
}

/** Run git and throw when it fails, with the stderr attached. */
export async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw new GitError(
      `git ${args.slice(0, 3).join(" ")} failed (exit ${result.code}): ` +
        `${result.stderr.trim() || result.stdout.trim()}`,
      result,
    );
  }
  return result.stdout;
}

export async function isGitAvailable(): Promise<boolean> {
  const result = await runGit(["--version"], process.cwd(), 15_000);
  return result.code === 0;
}

/** Absolute path of the repository containing `dir`, or null if there is none. */
export async function findRepoRoot(dir: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--show-toplevel"], dir);
  if (result.code !== 0) return null;
  const root = result.stdout.trim();
  return root ? path.normalize(root) : null;
}

/** True when the repository has at least one commit to branch a worktree from. */
export async function hasCommits(repoRoot: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", "HEAD"], repoRoot);
  return result.code === 0;
}

export async function currentHead(repoRoot: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], repoRoot)).trim();
}

/**
 * Paths with uncommitted changes, relative to the repository root, in POSIX
 * form. Uses `-z` so paths containing spaces or quotes need no unescaping.
 */
export async function listDirtyPaths(repoRoot: string): Promise<string[]> {
  const output = await git(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    repoRoot,
  );
  const entries = output.split("\0").filter((entry) => entry.length > 0);
  const paths: string[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    // Format is "XY path"; a rename adds a second NUL-terminated source path.
    const status = entry.slice(0, 2);
    const target = entry.slice(3);
    if (target) paths.push(target.split(path.sep).join("/"));
    if (status.startsWith("R") || status.startsWith("C")) {
      const source = entries[i + 1];
      if (source) paths.push(source.split(path.sep).join("/"));
      i += 1;
    }
  }

  return paths;
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  prunable: boolean;
}

/** Every worktree git currently knows about, including the main one. */
export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const output = await git(["worktree", "list", "--porcelain"], repoRoot);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = {
        path: path.normalize(line.slice("worktree ".length)),
        detached: false,
        prunable: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Create a detached worktree at `target` pinned to `ref`.
 *
 * Detached on purpose: creating a branch per task would litter the user's
 * branch namespace and risk colliding with names they already use.
 */
export async function addWorktree(
  repoRoot: string,
  target: string,
  ref: string,
): Promise<void> {
  await git(["worktree", "add", "--detach", "--force", target, ref], repoRoot);
}

/**
 * Remove a worktree, tolerating the file locking Windows applies while an
 * antivirus scanner or a just-exited child still holds a handle.
 */
export async function removeWorktree(
  repoRoot: string,
  target: string,
  attempts = 3,
): Promise<{ removed: boolean; error?: string }> {
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runGit(["worktree", "remove", "--force", target], repoRoot);
    if (result.code === 0) return { removed: true };
    lastError = result.stderr.trim() || result.stdout.trim();

    // "is not a working tree" means it is already gone; nothing to retry.
    if (/not a working tree|No such file or directory/i.test(lastError)) {
      await runGit(["worktree", "prune"], repoRoot);
      return { removed: true };
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  return { removed: false, error: lastError };
}

export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await runGit(["worktree", "prune"], repoRoot);
}

export interface WorktreeChanges {
  /** Repository-relative POSIX paths that differ from the base commit. */
  files: Array<{ path: string; status: string }>;
  /** Unified diff of tracked changes; empty when only untracked files exist. */
  diff: string;
}

/**
 * What a worker actually changed inside its worktree.
 *
 * Untracked files count: a task that adds a new module produces no tracked diff
 * but has certainly done work.
 */
export async function collectWorktreeChanges(
  worktreePath: string,
): Promise<WorktreeChanges> {
  const status = await git(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    worktreePath,
  );
  const entries = status.split("\0").filter((entry) => entry.length > 0);
  const files: Array<{ path: string; status: string }> = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const code = entry.slice(0, 2).trim() || "?";
    const target = entry.slice(3);
    if (target) {
      files.push({ path: target.split(path.sep).join("/"), status: code });
    }
    if (code.startsWith("R") || code.startsWith("C")) i += 1;
  }

  const diffResult = await runGit(["diff", "HEAD"], worktreePath);
  return { files, diff: diffResult.code === 0 ? diffResult.stdout : "" };
}

/** Add a pattern to `.git/info/exclude`, which is local and untracked. */
export async function ensureLocalExclude(
  repoRoot: string,
  pattern: string,
  fs: {
    readFile: (p: string) => Promise<string>;
    appendFile: (p: string, s: string) => Promise<void>;
    mkdir: (p: string) => Promise<void>;
  },
): Promise<void> {
  const gitDir = (await git(["rev-parse", "--git-common-dir"], repoRoot)).trim();
  const absoluteGitDir = path.isAbsolute(gitDir)
    ? gitDir
    : path.resolve(repoRoot, gitDir);
  const infoDir = path.join(absoluteGitDir, "info");
  const excludeFile = path.join(infoDir, "exclude");

  const existing = await fs.readFile(excludeFile).catch(() => "");
  if (existing.split(/\r?\n/).some((line) => line.trim() === pattern)) return;

  await fs.mkdir(infoDir).catch(() => undefined);
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fs.appendFile(excludeFile, `${prefix}${pattern}\n`);
}
