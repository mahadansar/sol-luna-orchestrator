import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ExecutableResolutionError,
  resolveExecutable,
  withoutCwdExecutableLookup,
} from "./executable.js";

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

export const GIT_TIMEOUT_MS = 120_000;
export const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const NO_HOOKS_PATH = path.join(
  os.tmpdir(),
  `sol-luna-no-hooks-${process.pid}-${randomBytes(12).toString("hex")}`,
);

/**
 * Absolute path to git, resolved once from PATH.
 *
 * `runGit` always sets `cwd` to a repository or worktree a worker can write
 * into, and Windows resolves a bare `git` from the current directory before
 * PATH. Launching a planted `git.cmd` would hand the orchestrator's own
 * evidence collection to the code it is supposed to be auditing. Resolved
 * lazily so an import in a git-less environment still succeeds, and memoised
 * because every batch runs dozens of git commands.
 */
let resolvedGit: string | null = null;

function gitExecutable(): string {
  if (resolvedGit === null) resolvedGit = resolveExecutable("git");
  return resolvedGit;
}

/** Test seam: forget the memoised path so a fresh PATH is honoured. */
export function resetGitExecutableCache(): void {
  resolvedGit = null;
}

export function runGit(
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<GitResult> {
  let executable: string;
  try {
    executable = gitExecutable();
  } catch (error) {
    const detail =
      error instanceof ExecutableResolutionError
        ? error.message
        : `failed to resolve git: ${(error as Error).message}`;
    return Promise.resolve({ code: null, stdout: "", stderr: detail });
  }

  return new Promise((resolve) => {
    const child = spawn(
      executable,
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "diff.external=",
        "-c",
        `core.hooksPath=${NO_HOOKS_PATH}`,
        ...args,
      ],
      {
        cwd,
        shell: false,
        windowsHide: true,
        // Keep git from opening editors, pagers, or credential prompts: this runs
        // unattended and a blocked prompt would hang the batch.
        env: withoutCwdExecutableLookup({
          ...process.env,
          ...envOverrides,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_NO_REPLACE_OBJECTS: "1",
        }),
      },
    );

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(null, `\ngit stdout exceeded ${MAX_GIT_OUTPUT_BYTES} bytes`);
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(null, `\ngit stderr exceeded ${MAX_GIT_OUTPUT_BYTES} bytes`);
        return;
      }
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
export async function git(
  args: string[],
  cwd: string,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<string> {
  const result = await runGit(args, cwd, GIT_TIMEOUT_MS, envOverrides);
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

/** Canonical shared Git directory for a repository or linked worktree. */
export async function resolveGitCommonDir(dir: string): Promise<string | null> {
  const repoRoot = await findRepoRoot(dir);
  if (!repoRoot) return null;
  const result = await runGit(["rev-parse", "--git-common-dir"], repoRoot);
  if (result.code !== 0) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  return realpath(path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw)).catch(
    () => null,
  );
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
 * Remove a worktree without asking Git to recursively delete worker-controlled
 * filesystem contents.
 *
 * `git worktree remove --force` follows directory junctions on Windows. A worker
 * can therefore leave a junction inside its worktree that points outside the
 * isolated tree and make Git delete the external target during cleanup. Node's
 * recursive `rm` removes symlinks/junctions as links instead of traversing them,
 * so delete the filesystem tree first, then make Git prune only its now-stale
 * administrative metadata.
 */
export async function removeWorktree(
  repoRoot: string,
  target: string,
  attempts = 3,
  beforeAttempt?: () => void,
): Promise<{ removed: boolean; error?: string }> {
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    beforeAttempt?.();
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 0 });
    } catch (error) {
      lastError = (error as Error).message;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
      continue;
    }

    beforeAttempt?.();
    const prune = await runGit(["worktree", "prune", "--expire", "now"], repoRoot);
    if (prune.code === 0) return { removed: true };
    lastError = prune.stderr.trim() || prune.stdout.trim();

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
  /**
   * Repository-relative POSIX paths implicated in final changes.
   *
   * Rename/copy records include both Git's destination path and its second
   * NUL-terminated source path so scope/evidence consumers cannot lose the old
   * side of a rename. Rename sources are deletion evidence; copy sources carry
   * an explicit copy-source status because the source itself still exists.
   */
  files: Array<{ path: string; status: string }>;
  /** Unified diff of tracked changes; empty when only untracked files exist. */
  diff: string;
}

export type GitCommand = (args: string[], cwd: string) => Promise<string>;

export interface GitEvidenceAuthority {
  /** Repository/worktree root whose filesystem bytes are being audited. */
  repoRoot: string;
  /** Canonical Git directory captured before delegated execution begins. */
  gitDir: string;
  /** Immutable commit the evidence scan must compare the filesystem against. */
  baseCommit: string;
  /** Whether the trusted root originally exposed .git as a file or directory. */
  gitControlKind: "file" | "directory";
  /** Exact linked-worktree gitfile bytes; absent for a normal .git directory. */
  gitFileContent?: string;
  /** Shared Git control directory used by linked worktrees. */
  commonGitDir: string;
  /** Digest of shared operator Git config/refs/hooks/info, submodule control, and locks. */
  commonControlDigest: string;
  /** Digest of this worktree's control files, real index, and their lock state. */
  worktreeControlDigest: string;
  /** Initialized gitlink worktrees pinned recursively before delegated execution. */
  submodules: GitSubmoduleEvidenceAuthority[];
  /** Gitlinks that were explicitly uninitialized before delegated execution. */
  uninitializedGitlinks: GitUninitializedSubmoduleEvidenceAuthority[];
}

export interface GitSubmoduleEvidenceAuthority {
  /** Path of the gitlink relative to its containing repository. */
  path: string;
  /** Canonical directory identity captured before delegated execution. */
  realPath: string;
  /** Independent authority for the initialized submodule repository. */
  authority: GitEvidenceAuthority;
}

export interface GitUninitializedSubmoduleEvidenceAuthority {
  /** Path of the gitlink relative to its containing repository. */
  path: string;
  /** Commit recorded by the containing repository for this gitlink. */
  commit: string;
  /** Exact safe filesystem state admitted before delegated execution. */
  pathState: { kind: "missing" } | { kind: "empty-directory"; identity: string };
}

const commonControlRoots = [
  "config",
  "config.lock",
  "HEAD",
  "HEAD.lock",
  "packed-refs",
  "packed-refs.lock",
  "refs",
  "hooks",
  "info",
];
const worktreeControlRoots = [
  "HEAD",
  "HEAD.lock",
  "commondir",
  "gitdir",
  "config.worktree",
  "config.worktree.lock",
  "index",
  "index.lock",
];

const submoduleControlRoots = [
  "config",
  "config.lock",
  "HEAD",
  "HEAD.lock",
  "packed-refs",
  "packed-refs.lock",
  "refs",
  "hooks",
  "info",
  "index",
  "index.lock",
  "commondir",
  "gitdir",
  "config.worktree",
  "config.worktree.lock",
  "shallow",
  "shallow.lock",
  "worktrees",
];

async function fingerprintGitControlPath(
  hash: ReturnType<typeof createHash>,
  root: string,
  relative: string,
  logical = relative,
  rejectRedirects = false,
): Promise<void> {
  const absolute = path.join(root, ...relative.split("/"));
  const targetStat = await lstat(absolute).catch(() => null);
  if (!targetStat) {
    hash.update(`missing\0${logical}\0`);
    return;
  }
  if (targetStat.isSymbolicLink()) {
    if (rejectRedirects) {
      throw new GitError(
        `Git evidence authority cannot trust redirected submodule Git control metadata: ${absolute}`,
      );
    }
    hash.update(`link\0${logical}\0${await readlink(absolute)}\0`);
    return;
  }
  if (targetStat.isDirectory()) {
    hash.update(`dir\0${logical}\0`);
    for (const name of (await readdir(absolute)).sort()) {
      await fingerprintGitControlPath(
        hash,
        root,
        relative ? `${relative}/${name}` : name,
        logical ? `${logical}/${name}` : name,
        rejectRedirects,
      );
    }
    return;
  }
  if (targetStat.isFile()) {
    hash.update(`file\0${logical}\0`);
    hash.update(await readFile(absolute));
    hash.update("\0");
    return;
  }
  hash.update(`other\0${logical}\0${targetStat.mode}\0${targetStat.size}\0`);
}

async function fingerprintSubmoduleGitControl(
  hash: ReturnType<typeof createHash>,
  commonGitDir: string,
): Promise<void> {
  const modulesRoot = path.join(commonGitDir, "modules");

  const visitContainer = async (directory: string, logical: string): Promise<void> => {
    const directoryStat = await lstat(directory).catch(() => null);
    if (!directoryStat) {
      hash.update(`missing\0${logical}\0`);
      return;
    }
    if (directoryStat.isSymbolicLink()) {
      throw new GitError(
        `Git evidence authority cannot trust redirected submodule Git control metadata: ${directory}`,
      );
    }
    if (!directoryStat.isDirectory()) {
      hash.update(`other\0${logical}\0${directoryStat.mode}\0${directoryStat.size}\0`);
      return;
    }

    const [configStat, headStat] = await Promise.all([
      lstat(path.join(directory, "config")).catch(() => null),
      lstat(path.join(directory, "HEAD")).catch(() => null),
    ]);
    if (configStat?.isFile() && headStat?.isFile()) {
      hash.update(`submodule-gitdir\0${logical}\0`);
      for (const root of submoduleControlRoots) {
        await fingerprintGitControlPath(
          hash,
          directory,
          root,
          `${logical}/${root}`,
          true,
        );
      }
      await visitContainer(path.join(directory, "modules"), `${logical}/modules`);
      return;
    }

    hash.update(`submodule-container\0${logical}\0`);
    for (const name of (await readdir(directory)).sort()) {
      const child = path.join(directory, name);
      const childStat = await lstat(child).catch(() => null);
      if (childStat?.isDirectory() || childStat?.isSymbolicLink()) {
        await visitContainer(child, `${logical}/${name}`);
        continue;
      }
      if (childStat?.isFile()) {
        hash.update(`file\0${logical}/${name}\0`);
        hash.update(await readFile(child));
        hash.update("\0");
        continue;
      }
      if (childStat) {
        hash.update(`other\0${logical}/${name}\0${childStat.mode}\0${childStat.size}\0`);
      }
    }
  };

  await visitContainer(modulesRoot, "modules");
}

async function fingerprintCommonGitControl(commonGitDir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const root of commonControlRoots) {
    await fingerprintGitControlPath(hash, commonGitDir, root);
  }
  await fingerprintSubmoduleGitControl(hash, commonGitDir);
  return hash.digest("hex");
}

async function fingerprintWorktreeGitControl(gitDir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const name of worktreeControlRoots) {
    const target = path.join(gitDir, name);
    const targetStat = await lstat(target).catch(() => null);
    if (!targetStat) {
      hash.update(`missing\0${name}\0`);
      continue;
    }
    if (targetStat.isFile()) {
      hash.update(`file\0${name}\0`);
      hash.update(await readFile(target));
      hash.update("\0");
      continue;
    }
    if (targetStat.isSymbolicLink()) {
      hash.update(`link\0${name}\0${await readlink(target)}\0`);
      continue;
    }
    hash.update(`other\0${name}\0${targetStat.mode}\0${targetStat.size}\0`);
  }
  return hash.digest("hex");
}

const gitdirFromControlFile = (content: string, controlPath: string): string => {
  const match = /^gitdir:\s*(.+?)\s*$/i.exec(content.trim());
  if (!match?.[1])
    throw new GitError(`Invalid worktree Git control file: ${controlPath}`);
  return path.isAbsolute(match[1])
    ? path.normalize(match[1])
    : path.resolve(path.dirname(controlPath), match[1]);
};

const sameFilesystemPath = (left: string, right: string): boolean => {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
};

async function resolveConfinedSubmoduleRoot(
  parentRepoRoot: string,
  repoRelativePath: string,
  expectedRealPath?: string,
): Promise<string | null> {
  const parts = repoRelativePath.split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new GitError(`Invalid pinned submodule path: ${repoRelativePath}`);
  }

  let current = path.resolve(parentRepoRoot);
  for (const part of parts) {
    current = path.join(current, part);
    const currentStat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!currentStat) return null;
    if (currentStat.isSymbolicLink()) {
      throw new GitError(
        `Git evidence authority cannot trust redirected submodule worktree: ${repoRelativePath}`,
      );
    }
    if (!currentStat.isDirectory()) return null;
  }

  const real = await realpath(current);
  if (expectedRealPath && !sameFilesystemPath(real, expectedRealPath)) {
    throw new GitError(
      `Git evidence authority changed: submodule worktree identity differs for ${repoRelativePath}.`,
    );
  }
  return real;
}

const gitlinkDirectoryIdentity = (targetStat: {
  dev: bigint;
  ino: bigint;
  mode: bigint;
}): string =>
  `${targetStat.dev.toString()}:${targetStat.ino.toString()}:${targetStat.mode.toString()}`;

async function inspectUninitializedGitlinkPath(
  parentRepoRoot: string,
  repoRelativePath: string,
): Promise<GitUninitializedSubmoduleEvidenceAuthority["pathState"]> {
  const parts = repoRelativePath.split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new GitError(`Invalid pinned submodule path: ${repoRelativePath}`);
  }

  let current = path.resolve(parentRepoRoot);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    const currentStat = await lstat(current, { bigint: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (!currentStat) return { kind: "missing" };
    if (currentStat.isSymbolicLink()) {
      throw new GitError(
        `Git evidence authority cannot trust redirected uninitialized submodule worktree: ${repoRelativePath}`,
      );
    }

    const leaf = index === parts.length - 1;
    if (!leaf) {
      if (!currentStat.isDirectory()) {
        throw new GitError(
          `Git evidence authority cannot trust non-directory uninitialized submodule path: ${repoRelativePath}`,
        );
      }
      continue;
    }

    if (!currentStat.isDirectory()) {
      throw new GitError(
        `Git evidence authority cannot trust non-directory uninitialized submodule worktree: ${repoRelativePath}`,
      );
    }

    const identity = gitlinkDirectoryIdentity(currentStat);
    const entries = await readdir(current).catch((error: NodeJS.ErrnoException) => {
      throw new GitError(
        `Git evidence authority could not inspect uninitialized submodule worktree ${repoRelativePath}: ${error.message}`,
      );
    });
    const after = await lstat(current, { bigint: true }).catch(() => null);
    if (
      !after ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      gitlinkDirectoryIdentity(after) !== identity
    ) {
      throw new GitError(
        `Git evidence authority changed while inspecting uninitialized submodule worktree: ${repoRelativePath}`,
      );
    }
    if (entries.length !== 0) {
      throw new GitError(
        `Git evidence authority cannot trust populated uninitialized submodule worktree: ${repoRelativePath}`,
      );
    }
    return { kind: "empty-directory", identity };
  }

  return { kind: "missing" };
}

interface PinnedGitlink {
  path: string;
  commit: string;
}

async function listPinnedGitlinks(
  authority: GitEvidenceAuthority,
): Promise<PinnedGitlink[]> {
  const isolated = await createIsolatedWorkerGitEnvironment(
    authority,
    authority.repoRoot,
  );
  try {
    const output = await git(
      ["ls-files", "--stage", "-z"],
      authority.repoRoot,
      isolated.env,
    );
    const gitlinks: PinnedGitlink[] = [];
    for (const entry of output.split("\0")) {
      if (!entry) continue;
      const separator = entry.indexOf("\t");
      if (separator < 0) continue;
      const [mode, object, stage] = entry.slice(0, separator).split(" ");
      if (mode !== "160000" || stage !== "0" || !object) continue;
      gitlinks.push({ path: entry.slice(separator + 1), commit: object });
    }
    return gitlinks;
  } finally {
    await isolated.cleanup().catch(() => undefined);
  }
}

async function captureSingleGitEvidenceAuthority(
  repoRoot: string,
  baseCommit?: string,
): Promise<GitEvidenceAuthority> {
  const controlPath = path.join(repoRoot, ".git");
  const control = await lstat(controlPath).catch(() => null);
  if (!control) throw new GitError(`Git control metadata is missing: ${controlPath}`);

  const commonGitDir = await resolveGitCommonDir(repoRoot);
  if (!commonGitDir) {
    throw new GitError(`Could not resolve the shared Git directory for ${repoRoot}.`);
  }
  const commonControlDigest = await fingerprintCommonGitControl(commonGitDir);
  const pinnedBaseCommit = baseCommit ?? (await currentHead(repoRoot));

  if (control.isFile()) {
    const gitFileContent = await readFile(controlPath, "utf8");
    const gitDir = await realpath(gitdirFromControlFile(gitFileContent, controlPath));
    return {
      repoRoot,
      gitDir,
      baseCommit: pinnedBaseCommit,
      gitControlKind: "file",
      gitFileContent,
      commonGitDir,
      commonControlDigest,
      worktreeControlDigest: await fingerprintWorktreeGitControl(gitDir),
      submodules: [],
      uninitializedGitlinks: [],
    };
  }

  if (!control.isDirectory()) {
    throw new GitError(
      `Git control metadata is not a regular file or directory: ${controlPath}`,
    );
  }
  const gitDir = await realpath(controlPath);
  return {
    repoRoot,
    gitDir,
    baseCommit: pinnedBaseCommit,
    gitControlKind: "directory",
    commonGitDir,
    commonControlDigest,
    worktreeControlDigest: await fingerprintWorktreeGitControl(gitDir),
    submodules: [],
    uninitializedGitlinks: [],
  };
}

async function capturePinnedSubmodules(authority: GitEvidenceAuthority): Promise<{
  initialized: GitSubmoduleEvidenceAuthority[];
  uninitialized: GitUninitializedSubmoduleEvidenceAuthority[];
}> {
  const pinned: GitSubmoduleEvidenceAuthority[] = [];
  const uninitialized: GitUninitializedSubmoduleEvidenceAuthority[] = [];
  for (const gitlink of await listPinnedGitlinks(authority)) {
    const realPath = await resolveConfinedSubmoduleRoot(authority.repoRoot, gitlink.path);
    if (!realPath) {
      uninitialized.push({
        path: gitlink.path,
        commit: gitlink.commit,
        pathState: await inspectUninitializedGitlinkPath(
          authority.repoRoot,
          gitlink.path,
        ),
      });
      continue;
    }

    const submoduleRoot = path.join(authority.repoRoot, ...gitlink.path.split("/"));
    const control = await lstat(path.join(submoduleRoot, ".git")).catch(() => null);
    if (!control) {
      uninitialized.push({
        path: gitlink.path,
        commit: gitlink.commit,
        pathState: await inspectUninitializedGitlinkPath(
          authority.repoRoot,
          gitlink.path,
        ),
      });
      continue;
    }
    if (control.isSymbolicLink()) {
      throw new GitError(
        `Git evidence authority cannot trust redirected submodule Git control metadata: ${path.join(submoduleRoot, ".git")}`,
      );
    }

    const discoveredRoot = await findRepoRoot(submoduleRoot);
    if (!discoveredRoot || !sameFilesystemPath(discoveredRoot, submoduleRoot)) {
      throw new GitError(
        `Could not pin initialized submodule repository identity for ${gitlink.path}.`,
      );
    }
    const submoduleAuthority = await captureSingleGitEvidenceAuthority(
      discoveredRoot,
      gitlink.commit,
    );
    const nested = await capturePinnedSubmodules(submoduleAuthority);
    submoduleAuthority.submodules = nested.initialized;
    submoduleAuthority.uninitializedGitlinks = nested.uninitialized;
    pinned.push({ path: gitlink.path, realPath, authority: submoduleAuthority });
  }
  return { initialized: pinned, uninitialized };
}

/**
 * Pin the Git identity used by a later evidence scan before delegated code runs.
 *
 * The worker may write the worktree root, including its `.git` gitfile, and may
 * invoke Git commands that mutate HEAD/index state. Evidence therefore keeps an
 * out-of-band canonical Git directory plus the exact starting commit rather than
 * rediscovering authority from worker-controlled bytes after execution.
 */
export async function captureGitEvidenceAuthority(
  workspace: string,
  baseCommit?: string,
): Promise<GitEvidenceAuthority | null> {
  const repoRoot = await findRepoRoot(workspace);
  if (!repoRoot || !(await hasCommits(repoRoot))) return null;
  const authority = await captureSingleGitEvidenceAuthority(repoRoot, baseCommit);
  const pinned = await capturePinnedSubmodules(authority);
  authority.submodules = pinned.initialized;
  authority.uninitializedGitlinks = pinned.uninitialized;
  return authority;
}

async function validateGitEvidenceAuthority(
  authority: GitEvidenceAuthority,
): Promise<void> {
  const commonDigest = await fingerprintCommonGitControl(authority.commonGitDir);
  if (commonDigest !== authority.commonControlDigest) {
    throw new GitError(
      "Git evidence authority changed: repository config/refs/hooks/info or lock state was modified during delegated execution, including submodule Git control metadata.",
    );
  }
  const worktreeDigest = await fingerprintWorktreeGitControl(authority.gitDir);
  if (worktreeDigest !== authority.worktreeControlDigest) {
    throw new GitError(
      "Git evidence authority changed: worktree Git control/index metadata or lock state was modified during delegated execution.",
    );
  }
  const controlPath = path.join(authority.repoRoot, ".git");
  const control = await lstat(controlPath).catch(() => null);
  if (!control) throw new GitError("Git evidence authority changed: .git is missing.");

  if (authority.gitControlKind === "file") {
    if (!control.isFile()) {
      throw new GitError(
        "Git evidence authority changed: worktree .git is no longer a file.",
      );
    }
    const current = await readFile(controlPath, "utf8");
    if (current !== authority.gitFileContent) {
      throw new GitError("Git evidence authority changed: worktree .git was modified.");
    }
    const currentGitDir = await realpath(gitdirFromControlFile(current, controlPath));
    if (path.normalize(currentGitDir) !== path.normalize(authority.gitDir)) {
      throw new GitError(
        "Git evidence authority changed: worktree gitdir identity differs.",
      );
    }
  } else {
    if (!control.isDirectory()) {
      throw new GitError(
        "Git evidence authority changed: repository .git is no longer a directory.",
      );
    }
    const currentGitDir = await realpath(controlPath);
    if (path.normalize(currentGitDir) !== path.normalize(authority.gitDir)) {
      throw new GitError(
        "Git evidence authority changed: repository gitdir identity differs.",
      );
    }
  }

  for (const submodule of authority.submodules) {
    const expectedRoot = path.join(authority.repoRoot, ...submodule.path.split("/"));
    if (!sameFilesystemPath(expectedRoot, submodule.authority.repoRoot)) {
      throw new GitError(
        `Git evidence authority changed: pinned submodule path differs for ${submodule.path}.`,
      );
    }
    const currentRealPath = await resolveConfinedSubmoduleRoot(
      authority.repoRoot,
      submodule.path,
      submodule.realPath,
    );
    if (!currentRealPath) {
      throw new GitError(
        `Git evidence authority changed: initialized submodule worktree is missing for ${submodule.path}.`,
      );
    }
    await validateGitEvidenceAuthority(submodule.authority);
  }

  for (const gitlink of authority.uninitializedGitlinks) {
    const currentState = await inspectUninitializedGitlinkPath(
      authority.repoRoot,
      gitlink.path,
    );
    if (
      currentState.kind !== gitlink.pathState.kind ||
      (currentState.kind === "empty-directory" &&
        gitlink.pathState.kind === "empty-directory" &&
        currentState.identity !== gitlink.pathState.identity)
    ) {
      throw new GitError(
        `Git evidence authority changed: uninitialized submodule worktree state differs for ${gitlink.path}.`,
      );
    }
  }

  // Do not ask the mutable operator repository to resolve HEAD here. The
  // worktree/common fingerprints above already bind HEAD plus every ref that can
  // resolve it, while avoiding the operator's config and index entirely. Trusted
  // evidence below resolves the pinned base commit only inside private metadata.
}

/** Public fail-closed validation used immediately before authoritative verification. */
export const assertGitEvidenceAuthority = validateGitEvidenceAuthority;

export interface IsolatedWorkerGitEnvironment {
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

/**
 * Give delegated Git commands private config/refs/index/object-write state.
 *
 * Objects from the operator repository are readable through Git's alternates
 * mechanism, while new commits, refs, config edits, replace refs, index flags,
 * and hooks stay inside a temporary Git directory that is destroyed after the
 * worker turn. The real worktree bytes remain the same filesystem the worker is
 * authorised to edit and the orchestrator audits independently afterwards.
 */
export async function createIsolatedWorkerGitEnvironment(
  authority: GitEvidenceAuthority,
  workingDirectory: string,
): Promise<IsolatedWorkerGitEnvironment> {
  await validateGitEvidenceAuthority(authority);
  const workspaceRelative = path.relative(
    authority.repoRoot,
    path.resolve(workingDirectory),
  );
  if (
    workspaceRelative === ".." ||
    workspaceRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(workspaceRelative)
  ) {
    throw new GitError(
      `Delegated Git workspace resolves outside its pinned repository root: ${workingDirectory}`,
    );
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "sol-luna-worker-git-"));
  const init = await runGit(["init", "--quiet", root], process.cwd());
  if (init.code !== 0) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw new GitError(
      `Could not create isolated worker Git metadata: ${init.stderr.trim() || init.stdout.trim()}`,
      init,
    );
  }

  const gitDir = path.join(root, ".git");
  const alternates = path.join(gitDir, "objects", "info", "alternates");
  const isolatedIndex = path.join(gitDir, "index");
  const isolatedGlobalConfig = path.join(root, "global.gitconfig");
  await mkdir(path.dirname(alternates), { recursive: true });
  await writeFile(
    alternates,
    `${path.join(authority.commonGitDir, "objects")}\n`,
    "utf8",
  );
  await writeFile(path.join(gitDir, "HEAD"), `${authority.baseCommit}\n`, "utf8");
  await writeFile(isolatedGlobalConfig, "", "utf8");

  const env: Record<string, string> = {
    GIT_DIR: gitDir,
    // Pin the index independently of GIT_DIR. A worker may pass an explicit
    // --git-dir to Git; retaining this private GIT_INDEX_FILE prevents that alone
    // from redirecting index writes into the operator repository. If delegated
    // code explicitly overrides this too, authority validation detects any
    // resulting real-index mutation before evidence or verification is trusted.
    GIT_INDEX_FILE: isolatedIndex,
    // The private index contains the complete repository tree. Keep Git's
    // work-tree identity pinned to that same repository root even when the
    // delegated process itself runs from a nested requested workspace. Git
    // derives the normal path prefix from cwd; moving GIT_WORK_TREE down to the
    // nested cwd would instead reinterpret every repository path relative to it.
    GIT_WORK_TREE: authority.repoRoot,
    GIT_NO_REPLACE_OBJECTS: "1",
    // Delegated/evidence Git must not inherit operator-global filter drivers,
    // attributes, hooks, includes, or other executable configuration. The
    // private repository below intentionally contains only the metadata we
    // create here plus read-only object alternates.
    GIT_CONFIG_NOSYSTEM: "1",
    // Git for Windows does not accept the Win32 NUL device as a config path.
    // A real empty file inside the private metadata root is cross-platform and
    // gives the same "no operator global config" semantics.
    GIT_CONFIG_GLOBAL: isolatedGlobalConfig,
    GIT_ATTR_NOSYSTEM: "1",
  };
  await git(["read-tree", authority.baseCommit], workingDirectory, env);

  return {
    env,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function parsePorcelainStatus(status: string): Array<{ path: string; status: string }> {
  const entries = status.split("\0").filter((entry) => entry.length > 0);
  const files: Array<{ path: string; status: string }> = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const rawCode = entry.slice(0, 2);
    const code = rawCode.trim() || "?";
    const target = entry.slice(3);
    if (target) {
      files.push({ path: target.split(path.sep).join("/"), status: code });
    }

    const renamed = rawCode.includes("R");
    const copied = !renamed && rawCode.includes("C");
    if (renamed || copied) {
      const source = entries[i + 1];
      if (source) {
        files.push({
          path: source.split(path.sep).join("/"),
          status: renamed ? "D" : "C-source",
        });
        i += 1;
      }
    }
  }
  return files;
}

/**
 * What a worker actually changed inside its worktree.
 *
 * Untracked files count: a task that adds a new module produces no tracked diff
 * but has certainly done work.
 */
export async function collectWorktreeChanges(
  worktreePath: string,
  run: GitCommand = git,
): Promise<WorktreeChanges> {
  const status = await run(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    worktreePath,
  );
  const files = parsePorcelainStatus(status);

  // A failed diff is missing evidence, not an empty successful diff. Let the
  // caller retain the worktree and surface an explicit evidence-scan failure.
  const diff = await run(
    ["diff", "--no-ext-diff", "--no-textconv", "HEAD"],
    worktreePath,
  );
  return { files, diff };
}

/**
 * Collect final filesystem evidence using only authority pinned before execution.
 *
 * A fresh temporary index prevents `git add`, `assume-unchanged`, or other index
 * mutations performed by delegated code from hiding bytes. `GIT_DIR` and
 * `GIT_WORK_TREE` bypass a tampered root `.git`, while the explicit base commit
 * makes a worker-created commit visible instead of redefining the comparison.
 */
export async function collectTrustedWorktreeChanges(
  authority: GitEvidenceAuthority,
): Promise<WorktreeChanges> {
  return collectTrustedWorktreeChangesRecursive(authority, "");
}

const joinRepoRelativePath = (prefix: string, entry: string): string =>
  prefix ? `${prefix}/${entry}` : entry;

async function collectTrustedWorktreeChangesRecursive(
  authority: GitEvidenceAuthority,
  prefix: string,
): Promise<WorktreeChanges> {
  await validateGitEvidenceAuthority(authority);
  const isolated = await createIsolatedWorkerGitEnvironment(
    authority,
    authority.repoRoot,
  );
  try {
    const status = await git(
      ["status", "--porcelain", "-z", "--untracked-files=all"],
      authority.repoRoot,
      isolated.env,
    );
    const diffArgs = ["diff", "--no-ext-diff", "--no-textconv"];
    if (prefix) {
      diffArgs.push(`--src-prefix=a/${prefix}/`, `--dst-prefix=b/${prefix}/`);
    }
    diffArgs.push(authority.baseCommit);
    const diff = await git(diffArgs, authority.repoRoot, isolated.env);
    const pinnedSubmodulePaths = new Set(authority.submodules.map((entry) => entry.path));
    const files = parsePorcelainStatus(status)
      .filter((file) => !pinnedSubmodulePaths.has(file.path))
      .map((file) => ({
        ...file,
        path: joinRepoRelativePath(prefix, file.path),
      }));
    const diffs = diff ? [diff] : [];

    for (const submodule of authority.submodules) {
      const nestedPrefix = joinRepoRelativePath(prefix, submodule.path);
      const nested = await collectTrustedWorktreeChangesRecursive(
        submodule.authority,
        nestedPrefix,
      );
      files.push(...nested.files);
      if (nested.diff) diffs.push(nested.diff);
    }

    return { files, diff: diffs.join("\n") };
  } finally {
    await isolated.cleanup().catch(() => undefined);
  }
}

/** Exact ignored, untracked files under a pinned Git authority. */
export async function listTrustedIgnoredFiles(
  authority: GitEvidenceAuthority,
  excludedRepoPaths: string[] = [],
): Promise<string[]> {
  return listTrustedIgnoredFilesRecursive(authority, excludedRepoPaths, "");
}

const normalizeRepoRelativePath = (value: string): string =>
  value.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");

async function listTrustedIgnoredFilesRecursive(
  authority: GitEvidenceAuthority,
  excludedRepoPaths: string[],
  prefix: string,
): Promise<string[]> {
  await validateGitEvidenceAuthority(authority);
  const isolated = await createIsolatedWorkerGitEnvironment(
    authority,
    authority.repoRoot,
  );
  try {
    const pathspecs = excludedRepoPaths.flatMap((value) => {
      const normalized = normalizeRepoRelativePath(value);
      if (!normalized) return [];
      return [`:(exclude)${normalized}`, `:(exclude)${normalized}/**`];
    });
    const output = await git(
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
        ".",
        ...pathspecs,
      ],
      authority.repoRoot,
      isolated.env,
    );
    const ignored = output
      .split("\0")
      .filter(Boolean)
      .map((file) => joinRepoRelativePath(prefix, file.split(path.sep).join("/")));

    const normalizedExclusions = excludedRepoPaths
      .map(normalizeRepoRelativePath)
      .filter(Boolean);
    for (const submodule of authority.submodules) {
      if (
        normalizedExclusions.some(
          (excluded) =>
            submodule.path === excluded || submodule.path.startsWith(`${excluded}/`),
        )
      ) {
        continue;
      }
      const nestedExclusions = normalizedExclusions.flatMap((excluded) =>
        excluded.startsWith(`${submodule.path}/`)
          ? [excluded.slice(submodule.path.length + 1)]
          : [],
      );
      ignored.push(
        ...(await listTrustedIgnoredFilesRecursive(
          submodule.authority,
          nestedExclusions,
          joinRepoRelativePath(prefix, submodule.path),
        )),
      );
    }
    return ignored;
  } finally {
    await isolated.cleanup().catch(() => undefined);
  }
}

export type TrustedWorkspaceSnapshot = Map<string, string>;

/**
 * Content-hashed evidence for workspaces that are intentionally not Git
 * repositories. Symlinks are recorded as links and never traversed by the
 * unsandboxed parent process.
 */
export async function snapshotFilesystemWorkspaceEvidence(
  workspace: string,
): Promise<TrustedWorkspaceSnapshot> {
  const root = path.resolve(workspace);
  const snapshot: TrustedWorkspaceSnapshot = new Map();

  const walk = async (target: string, relative: string): Promise<void> => {
    const targetStat = await lstat(target).catch(() => null);
    if (!targetStat) return;
    const logical = relative.split(path.sep).join("/");
    if (targetStat.isSymbolicLink()) {
      snapshot.set(logical, `link:${await readlink(target)}`);
      return;
    }
    if (targetStat.isFile()) {
      const digest = createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
      snapshot.set(logical, `file:${targetStat.mode}:${targetStat.size}:${digest}`);
      return;
    }
    if (targetStat.isDirectory()) {
      if (logical) snapshot.set(logical, `dir:${targetStat.mode}`);
      for (const entry of (await readdir(target)).sort()) {
        await walk(
          path.join(target, entry),
          relative ? path.join(relative, entry) : entry,
        );
      }
      return;
    }
    snapshot.set(logical, `other:${targetStat.mode}:${targetStat.size}`);
  };

  await walk(root, "");
  snapshot.delete("");
  return snapshot;
}

const workspaceRelativePath = (
  repoRoot: string,
  workspace: string,
  repoRelativeFile: string,
): string =>
  path
    .relative(workspace, path.join(repoRoot, ...repoRelativeFile.split("/")))
    .split(path.sep)
    .join("/");

async function snapshotPathSignature(target: string, status: string): Promise<string> {
  const targetStat = await lstat(target).catch(() => null);
  if (!targetStat) return `${status}:missing`;
  if (targetStat.isSymbolicLink()) {
    return `${status}:link:${await readlink(target)}`;
  }
  if (targetStat.isFile()) {
    const digest = createHash("sha256")
      .update(await readFile(target))
      .digest("hex");
    return `${status}:file:${digest}`;
  }
  return `${status}:${targetStat.mode}:${targetStat.size}`;
}

/**
 * Snapshot every Git-visible mutation plus ignored untracked files, using a
 * pinned repository identity and content hashes. Callers compare two snapshots
 * to detect shell side effects that Codex did not report as file_change items.
 */
export async function snapshotTrustedWorkspaceEvidence(
  authority: GitEvidenceAuthority,
  workspace: string,
  excludedWorkspacePaths: string[] = [],
): Promise<TrustedWorkspaceSnapshot> {
  const tracked = await collectTrustedWorktreeChanges(authority);
  const workspacePrefix = path.relative(authority.repoRoot, workspace);
  const excludedRepoPaths = excludedWorkspacePaths.map((entry) =>
    path.join(workspacePrefix, ...entry.split("/")),
  );
  const ignored = await listTrustedIgnoredFiles(authority, excludedRepoPaths);
  const snapshot: TrustedWorkspaceSnapshot = new Map();

  for (const file of tracked.files) {
    const relative = workspaceRelativePath(authority.repoRoot, workspace, file.path);
    const target = path.join(workspace, ...relative.split("/"));
    snapshot.set(relative, await snapshotPathSignature(target, file.status));
  }
  for (const repoRelative of ignored) {
    const relative = workspaceRelativePath(authority.repoRoot, workspace, repoRelative);
    const target = path.join(authority.repoRoot, ...repoRelative.split("/"));
    snapshot.set(relative, await snapshotPathSignature(target, "I"));
  }
  return snapshot;
}

export function changedTrustedWorkspacePaths(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((file) => before.get(file) !== after.get(file)).sort();
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
