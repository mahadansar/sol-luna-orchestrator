import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import {
  ALLOW_DIRTY_WORKTREE_BASE,
  KEEP_WORKTREES,
  parseWorktreeLinkDirectories,
  WORKTREE_DIR,
  WORKTREE_LINK_DIRS,
} from "./config.js";
import {
  addWorktree,
  captureGitEvidenceAuthority,
  collectTrustedWorktreeChanges,
  currentHead,
  ensureLocalExclude,
  findRepoRoot,
  GIT_TIMEOUT_MS,
  hasCommits,
  isGitAvailable,
  listDirtyPaths,
  listTrustedIgnoredFiles,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  resolveGitCommonDir,
  type GitEvidenceAuthority,
  type TrustedWorkspaceSnapshot,
  type WorktreeChanges,
} from "./git.js";
import {
  capturePinnedDirectoryAuthority,
  PinnedDirectoryMutationError,
  runPinnedDirectoryMutation,
  type PinnedDirectoryAuthority,
} from "./fs-authority.js";

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

export class WorktreeLeaseRenewalError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "WorktreeLeaseRenewalError";
  }
}

export class WorktreeLeaseOwnershipError extends Error {
  constructor(message = "The worktree lease is no longer owned by this continuation.") {
    super(message);
    this.name = "WorktreeLeaseOwnershipError";
  }
}

export class ConfinedDirectoryChainError extends WorktreeUnavailableError {
  constructor(
    message: string,
    remedy: string,
    readonly rollbackComplete: boolean,
  ) {
    super(message, remedy);
    this.name = "ConfinedDirectoryChainError";
  }
}

export interface WorktreeBase {
  repoRoot: string;
  /** Commit every worker's worktree is created from. */
  baseCommit: string;
  /** Requested workspace inside the repository, relative to repoRoot. */
  workspaceRelativePath: string;
  /** Uncommitted paths in the main tree, for reporting. */
  dirtyPaths: string[];
  /** Same dirt projected into the requested workspace's path namespace. */
  workspaceDirtyPaths: string[];
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
  const workspaceRelativePath = path.relative(repoRoot, workspace);
  if (
    workspaceRelativePath.startsWith(`..${path.sep}`) ||
    workspaceRelativePath === ".." ||
    path.isAbsolute(workspaceRelativePath)
  ) {
    throw new WorktreeUnavailableError(
      `${workspace} resolves outside its repository root ${repoRoot}.`,
      "Use a workspace contained by the repository, or run sequentially.",
    );
  }

  const workspaceDirtyPaths = dirtyPaths
    .map((dirty) => {
      const absolute = path.join(repoRoot, ...dirty.split("/"));
      const relative = path.relative(workspace, absolute);
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return null;
      }
      return relative.split(path.sep).join("/");
    })
    .filter((dirty): dirty is string => dirty !== null);

  if (!allowDirty && workspaceDirtyPaths.length > 0) {
    const conflicting = new Set<string>();
    for (const scope of scopes) {
      if (scope.length === 0) {
        // An unrestricted task claims everything, so any dirt is in its way.
        workspaceDirtyPaths.forEach((dirty) => conflicting.add(dirty));
        continue;
      }
      const matches = picomatch(scope, { dot: true, nocase: isCaseInsensitive() });
      for (const dirty of workspaceDirtyPaths) {
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

  return {
    repoRoot,
    baseCommit: await currentHead(repoRoot),
    workspaceRelativePath,
    dirtyPaths,
    workspaceDirtyPaths,
  };
}

const isCaseInsensitive = (): boolean =>
  process.platform === "win32" || process.platform === "darwin";

const pathIsWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

const directoryIdentity = (
  stat: Awaited<ReturnType<typeof fs.lstat>> & {
    dev: number | bigint;
    ino: number | bigint;
    birthtimeMs: number;
  },
): string => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

/** Prove that every destination-parent segment already exists under one real root. */
export async function assertConfinedDirectoryChain(
  root: string,
  targetDirectory: string,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetDirectory);
  if (!pathIsWithin(resolvedRoot, resolvedTarget)) {
    throw new WorktreeUnavailableError(
      `Directory target resolves outside its confined root: ${resolvedTarget}.`,
      "Use an existing real directory inside the isolated workspace.",
    );
  }

  const rootStat = await fs.lstat(resolvedRoot).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new WorktreeUnavailableError(
      `Confined directory root is missing, redirected, or not a directory: ${resolvedRoot}.`,
      "Use an existing real workspace root.",
    );
  }
  const canonicalRoot = await fs.realpath(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = canonicalRoot;
  for (const segment of segments) {
    const parentBefore = await fs.lstat(current).catch(() => null);
    if (!parentBefore || parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) {
      throw new WorktreeUnavailableError(
        `Confined directory parent changed identity: ${current}.`,
        "Retry after restoring a real in-workspace directory ancestry.",
      );
    }
    const parentIdentity = directoryIdentity(parentBefore);
    const candidate = path.join(current, segment);
    const existing = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) {
      throw new WorktreeUnavailableError(
        `Confined destination parent is missing: ${candidate}.`,
        "Create and review the directory outside this authoritative integration boundary before retrying.",
      );
    }
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new WorktreeUnavailableError(
        `Confined directory segment is redirected or not a directory: ${candidate}.`,
        "Replace it with a real in-workspace directory before retrying.",
      );
    }
    const canonicalExisting = await fs.realpath(candidate);
    const parentAfter = await fs.lstat(current).catch(() => null);
    if (
      !parentAfter ||
      parentAfter.isSymbolicLink() ||
      !parentAfter.isDirectory() ||
      directoryIdentity(parentAfter) !== parentIdentity ||
      !pathIsWithin(canonicalRoot, canonicalExisting)
    ) {
      throw new WorktreeUnavailableError(
        `Confined directory ancestry changed while validating ${candidate}.`,
        "Retry after concurrent filesystem mutation has stopped.",
      );
    }
    current = canonicalExisting;
  }
}

export interface ConfinedDirectoryCreateContext {
  parent: PinnedDirectoryAuthority;
  candidate: string;
  segment: string;
}

export interface CreatedConfinedDirectory {
  path: string;
  name: string;
  identity: string;
  parent: PinnedDirectoryAuthority;
}

export interface ConfinedDirectoryChainResult {
  directory: string;
  authority: PinnedDirectoryAuthority;
  created: CreatedConfinedDirectory[];
  /** Remove only directories this call created, in reverse order, if still identical and empty. */
  rollback: () => Promise<boolean>;
}

export interface EnsureConfinedDirectoryChainOptions {
  /** Test/coordination seam after the helper has pinned the parent and before mkdir executes. */
  beforeCreate?: (context: ConfinedDirectoryCreateContext) => void | Promise<void>;
}

async function rollbackCreatedConfinedDirectories(
  created: readonly CreatedConfinedDirectory[],
): Promise<boolean> {
  let complete = true;
  for (const entry of [...created].reverse()) {
    try {
      const removed = await runPinnedDirectoryMutation(entry.parent, {
        op: "rmdir",
        name: entry.name,
        expectedIdentity: entry.identity,
      });
      if (!removed.mutated || removed.snapshot?.kind !== "missing") complete = false;
    } catch {
      complete = false;
    }
  }
  return complete;
}

/**
 * Ensure a real directory chain under an existing real root. Missing segments
 * are created by a helper whose cwd is bound to the already-captured parent.
 */
export async function ensureConfinedDirectoryChain(
  root: string,
  targetDirectory: string,
  options: EnsureConfinedDirectoryChainOptions = {},
): Promise<ConfinedDirectoryChainResult> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetDirectory);
  if (!pathIsWithin(resolvedRoot, resolvedTarget)) {
    throw new ConfinedDirectoryChainError(
      `Directory target resolves outside its confined root: ${resolvedTarget}.`,
      "Use a directory inside the confined root.",
      true,
    );
  }

  const canonicalRoot = await fs.realpath(resolvedRoot).catch(() => null);
  if (!canonicalRoot) {
    throw new ConfinedDirectoryChainError(
      `Confined directory root is missing or inaccessible: ${resolvedRoot}.`,
      "Use an existing real confined root.",
      true,
    );
  }

  let authority: PinnedDirectoryAuthority;
  try {
    authority = await capturePinnedDirectoryAuthority(resolvedRoot, canonicalRoot);
  } catch (error) {
    throw new ConfinedDirectoryChainError(
      (error as Error).message,
      "Use an existing real confined root.",
      true,
    );
  }

  const relative = path.relative(resolvedRoot, resolvedTarget);
  const segments = relative === "" ? [] : relative.split(path.sep);
  const created: CreatedConfinedDirectory[] = [];
  const rollback = (): Promise<boolean> => rollbackCreatedConfinedDirectories(created);

  for (const segment of segments) {
    const parent = authority;
    const candidate = path.join(parent.directory, segment);
    let appearedMissing = false;
    try {
      await fs.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const rollbackComplete = await rollback();
        throw new ConfinedDirectoryChainError(
          `Could not inspect confined directory segment ${candidate}: ${(error as Error).message}`,
          "Retry after concurrent filesystem mutation has stopped.",
          rollbackComplete,
        );
      }
      appearedMissing = true;
    }

    let creation: Awaited<ReturnType<typeof runPinnedDirectoryMutation>> | undefined;
    try {
      creation = await runPinnedDirectoryMutation(
        parent,
        { op: "mkdir", name: segment },
        {
          beforeExecute:
            appearedMissing && options.beforeCreate
              ? () => options.beforeCreate?.({ parent, candidate, segment })
              : undefined,
        },
      );
    } catch (error) {
      if (!(error instanceof PinnedDirectoryMutationError && error.code === "EEXIST")) {
        const rollbackComplete = await rollback();
        const mutationCleanupProven =
          !(error instanceof PinnedDirectoryMutationError) || !error.mutated;
        throw new ConfinedDirectoryChainError(
          `Could not create confined directory segment ${candidate}: ${(error as Error).message}`,
          "Retry after concurrent filesystem mutation has stopped.",
          rollbackComplete && mutationCleanupProven,
        );
      }
    }

    if (creation?.mutated) {
      if (creation.snapshot?.kind !== "directory" || !creation.snapshot.identity) {
        await rollback();
        throw new ConfinedDirectoryChainError(
          `Could not prove the identity of newly created directory ${candidate}.`,
          "Retry after concurrent filesystem mutation has stopped.",
          false,
        );
      }
      created.push({
        path: candidate,
        name: segment,
        identity: creation.snapshot.identity,
        parent,
      });
    }

    let child: PinnedDirectoryAuthority;
    try {
      child = await capturePinnedDirectoryAuthority(candidate, canonicalRoot);
    } catch (error) {
      const rollbackComplete = await rollback();
      throw new ConfinedDirectoryChainError(
        `Confined directory segment is redirected, missing, or not a directory: ${candidate}. ${(error as Error).message}`,
        "Retry after restoring a real in-root directory ancestry.",
        rollbackComplete,
      );
    }
    if (creation?.snapshot?.identity && child.identity !== creation.snapshot.identity) {
      const rollbackComplete = await rollback();
      throw new ConfinedDirectoryChainError(
        `Confined directory segment changed identity after creation: ${candidate}.`,
        "Retry after concurrent filesystem mutation has stopped.",
        rollbackComplete,
      );
    }
    authority = child;
  }

  return { directory: resolvedTarget, authority, created, rollback };
}

/**
 * Ensure orchestrator-owned repository control paths cannot be redirected by a
 * checked-in (or operator-created) symlink/junction.
 *
 * These paths are mutated by the parent runtime rather than by delegated code,
 * so normal worker scope checks are too late: a redirected .sol-luna ancestor
 * could otherwise make setup/cleanup create or delete state outside the
 * authorised repository before any worker starts.
 */
async function ensureRuntimeControlRoots(repoRoot: string): Promise<void> {
  const canonicalRepo = await fs.realpath(repoRoot).catch(() => null);
  if (!canonicalRepo) {
    throw new WorktreeUnavailableError(
      `Could not resolve repository root ${repoRoot} for worktree control state.`,
      "Use a real, accessible repository path or run sequentially.",
    );
  }

  try {
    await ensureConfinedDirectoryChain(
      canonicalRepo,
      path.join(canonicalRepo, ".sol-luna", "worktrees"),
    );
  } catch (error) {
    throw new ConfinedDirectoryChainError(
      `Refusing redirected orchestrator control path: ${(error as Error).message}`,
      "Remove the symlink/junction or non-directory .sol-luna control ancestor before using parallel worktrees.",
      !(error instanceof ConfinedDirectoryChainError) || error.rollbackComplete,
    );
  }

  try {
    await ensureConfinedDirectoryChain(
      canonicalRepo,
      path.join(canonicalRepo, ".sol-luna", "continuation-leases"),
    );
  } catch (error) {
    throw new ConfinedDirectoryChainError(
      `Refusing redirected orchestrator lease path: ${(error as Error).message}`,
      "Remove the symlink/junction or non-directory continuation-leases path.",
      !(error instanceof ConfinedDirectoryChainError) || error.rollbackComplete,
    );
  }
}

/**
 * Repository-operation and metadata leases live beside Git's shared control
 * directory so every linked worktree and peer process contends on one identity.
 * That namespace is parent-owned authority just like repo-root `.sol-luna` and
 * must not be redirectable through a symlink/junction planted under `.git`.
 */
async function ensureCommonGitLeaseRoots(commonGitDir: string): Promise<void> {
  const canonicalCommon = await fs.realpath(commonGitDir).catch(() => null);
  if (!canonicalCommon) {
    throw new WorktreeUnavailableError(
      `Could not resolve shared Git directory ${commonGitDir} for repository operation state.`,
      "Retry from a valid accessible Git repository.",
    );
  }

  try {
    await ensureConfinedDirectoryChain(
      canonicalCommon,
      path.join(canonicalCommon, "sol-luna-orchestrator", "continuation-leases"),
    );
  } catch (error) {
    throw new ConfinedDirectoryChainError(
      `Refusing redirected common-Git orchestrator lease path: ${(error as Error).message}`,
      "Remove the symlink/junction or non-directory Git control ancestor before retrying.",
      !(error instanceof ConfinedDirectoryChainError) || error.rollbackComplete,
    );
  }
}

export interface TaskWorktree {
  taskId: string;
  /** Root registered with Git under .sol-luna/worktrees. */
  path: string;
  repoRoot: string;
  /** Requested task workspace projected into this isolated repository worktree. */
  workingDirectory?: string;
  /** Main requested workspace used to resolve configured shared-link sources. */
  sharedLinkRoot?: string;
  /** Dependency/setup directories privately snapshotted into this worktree. */
  sharedSnapshotDirs?: string[];
  /** Private dependency bytes captured after setup and before delegated execution. */
  sharedDirectoryBaseline?: SharedDirectoryFingerprint;
  /** Git identity/base captured before delegated code can mutate control state. */
  gitEvidenceAuthority?: GitEvidenceAuthority;
  /** Main-workspace Git identity captured after setup and before workers run. */
  integrationAuthority?: GitEvidenceAuthority;
  /** Main-workspace filesystem evidence captured before any parallel worker ran. */
  integrationBaseline?: TrustedWorkspaceSnapshot;
  /** Pre-batch workspace dirt that an explicit dirty-base override accepted. */
  initialWorkspaceDirtyPaths?: string[];
  /** Exact persistent owner used for cross-process pruning protection. */
  lease?: WorktreeLease;
  /** Non-fatal problems, e.g. a shared directory that could not be linked. */
  warnings: string[];
}

export interface SharedDirectoryFingerprint {
  root: string;
  dirs: string[];
  digest: string;
}

async function hashSharedPath(
  hash: ReturnType<typeof createHash>,
  target: string,
  logical: string,
  canonicalRoot: string,
): Promise<void> {
  const entry = await fs.lstat(target).catch(() => null);
  if (!entry) {
    hash.update(`missing\0${logical}\0`);
    return;
  }
  if (entry.isSymbolicLink()) {
    const link = await fs.readlink(target);
    hash.update(`link\0${logical}\0${link}\0`);
    const resolved = await fs.realpath(target).catch(() => null);
    if (!resolved || !pathIsWithin(canonicalRoot, resolved)) {
      throw new WorktreeUnavailableError(
        `Shared dependency link escapes its configured source tree: ${target}.`,
        "Replace the external symlink/junction with a dependency contained by the configured shared directory.",
      );
    }
    // Hash the link itself but never traverse through it from the unsandboxed
    // parent process. The canonical target check above is enough to prove that a
    // copied relative link cannot escape the private snapshot.
    return;
  }
  if (entry.isDirectory()) {
    hash.update(`dir\0${logical}\0`);
    for (const name of (await fs.readdir(target)).sort()) {
      await hashSharedPath(
        hash,
        path.join(target, name),
        `${logical}/${name}`,
        canonicalRoot,
      );
    }
    return;
  }
  if (entry.isFile()) {
    hash.update(`file\0${logical}\0${entry.mode}\0${entry.size}\0`);
    hash.update(await fs.readFile(target));
    hash.update("\0");
    return;
  }
  hash.update(`other\0${logical}\0${entry.mode}\0${entry.size}\0`);
}

/** Content identity for directories that may be linked into delegated workspaces. */
export async function captureSharedDirectoryFingerprint(
  root: string,
  dirs: string[] = WORKTREE_LINK_DIRS,
): Promise<SharedDirectoryFingerprint> {
  const parsed = parseWorktreeLinkDirectories(dirs.join(","));
  const hash = createHash("sha256");
  for (const dir of [...parsed.dirs].sort()) {
    const source = path.resolve(root, dir);
    const canonical = await fs.realpath(source).catch(() => null);
    if (canonical) {
      await hashSharedPath(hash, source, dir, canonical);
    } else {
      hash.update(`missing\0${dir}\0`);
    }
  }
  return { root, dirs: [...parsed.dirs], digest: hash.digest("hex") };
}

export async function assertSharedDirectoryFingerprint(
  baseline: SharedDirectoryFingerprint,
): Promise<void> {
  const current = await captureSharedDirectoryFingerprint(baseline.root, baseline.dirs);
  if (current.digest !== baseline.digest) {
    throw new Error(
      "Shared dependency state changed during delegated execution; the result is not trustworthy.",
    );
  }
}

/**
 * Serializes every operation that mutates `.git/worktrees`.
 *
 * The worktrees themselves are isolated, but registering one is not: `git
 * worktree add` walks the shared metadata directory, and a concurrent `add`
 * that has created `.git/worktrees/<id>/` but not yet written `commondir`
 * inside it makes the other process abort. Measured on Windows with eight
 * concurrent creations:
 *
 *     fatal: failed to read .git/worktrees/t5-.../commondir: No error
 *
 * The victim's task then failed with no result at all. `worktree remove` and
 * `worktree prune` rewrite the same directory and are serialized for the same
 * reason.
 *
 * A single queue rather than one per repository: these operations take
 * milliseconds, at most eight ever queue behind each other, and a global queue
 * cannot be defeated by two batches running against the same repository. It
 * covers setup and teardown only — worker execution never passes through here,
 * so parallelism where it actually costs time is untouched.
 *
 * Nothing guarded below calls another guarded function, so this cannot deadlock.
 */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  /** Highest number of operations that have ever been inside the queue at once. */
  private inFlight = 0;
  private peak = 0;

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.inFlight += 1;
      this.peak = Math.max(this.peak, this.inFlight);
      try {
        return await operation();
      } finally {
        this.inFlight -= 1;
      }
    });
    // Keep the chain alive even when a caller's operation rejects.
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Test-visible proof that guarded operations never overlapped. */
  peakOverlap(): number {
    return this.peak;
  }
}

export const worktreeMetadataQueue = new SerialQueue();

/** Worktrees currently owned by a running batch in this server process. */
const activeWorktreePaths = new Set<string>();

export const WORKTREE_LEASE_GRACE_MS = 5 * 60 * 1000;
const METADATA_LEASE_WINDOW_MS = 5 * 60 * 1000;
const METADATA_LEASE_WAIT_MS = 30 * 1000;
const METADATA_COMMAND_SAFETY_MS = GIT_TIMEOUT_MS + 5_000;
const OPERATION_LEASE_WINDOW_MS = WORKTREE_LEASE_GRACE_MS + 60_000;
const LEASE_VERSION = 1;

// Forced process shutdown is a distinct authority boundary from ordinary
// request cancellation. It is triggered only after the ShutdownCoordinator's
// cleanup bound has already failed. Pending repository-operation acquirers must
// stop retrying at that point just like active renewal timers must stop, or a
// waiter that does not yet own an authority object can keep Node alive forever.
const forcedRepositoryOperationShutdown = new AbortController();

export type WorktreeLeasePhase =
  | "metadata"
  | "operation"
  | "creating"
  | "running"
  | "retained-continuation"
  | "executing-continuation";

export interface WorktreeLease {
  worktreePath: string;
  ownerToken: string;
  /** Last successfully published protection horizon. */
  expiresAt: number;
  /**
   * In-memory identity of the lease artifact directory created by this owner.
   * Never persisted: a peer process that replaces the directory cannot make a
   * stale owner accept the replacement merely by replaying its visible token.
   */
  artifactIdentity?: string;
  /** In-memory identities of parent-owned lease-control ancestors. */
  leaseRootIdentity?: string;
  leaseNamespaceIdentity?: string;
}

interface WorktreeLeaseRecord {
  version: typeof LEASE_VERSION;
  ownerToken: string;
  phase: WorktreeLeasePhase;
  expiresAt: number;
}

interface LeaseFileRecord {
  file: string;
  record: WorktreeLeaseRecord;
}

interface LeaseInspection {
  state: "absent" | "protected" | "expired";
  records: LeaseFileRecord[];
}

export interface WorktreeLeaseStoreOptions {
  now?: () => number;
  tokenFactory?: () => string;
  /** Test seam after the protected acquisition reservation and empty directory exist. */
  afterArtifactCreated?: (phase: WorktreeLeasePhase) => void | Promise<void>;
  /** Pauses after a complete temp record exists but before atomic publication. */
  beforePublish?: (phase: WorktreeLeasePhase) => void | Promise<void>;
  /** Test-only seam immediately before an expired lease artifact is retired. */
  beforeRetire?: (artifact: string) => void | Promise<void>;
  /** Test-only timer override; production derives a conservative interval. */
  maintenanceIntervalMs?: number;
}

export interface WorktreeLeaseMaintenance {
  /** Throws after the first failed refresh; callers use this at mutation boundaries. */
  assertHealthy: (minimumRemainingMs?: number) => void;
  /** Resolves exactly once with the first renewal failure. */
  whenUnhealthy: Promise<WorktreeLeaseRenewalError>;
  /**
   * Stop only the referenced renewal timer/listener immediately, without
   * waiting for any already-started refresh. Reserved for forced process
   * shutdown; normal lifecycle code must use `stop()` so refresh health is
   * observed before continuing.
   */
  forceStop: () => void;
  /** Stops renewal and rejects when renewal health was lost. */
  stop: () => Promise<void>;
}

export interface RepositoryOperationAuthority {
  /** Canonical shared Git directory used as the cross-process repository identity. */
  commonGitDir: string;
  /** Throws after abort or lease-renewal health loss. */
  assertHealthy: (minimumRemainingMs?: number) => void;
  /** Stops renewal and releases the persistent repository-operation owner. */
  release: () => Promise<void>;
}

/**
 * Long-lived repository-operation authorities are deliberately independent of
 * request cancellation: an aborted worker still needs the same-repository lock
 * while its parent reconciles evidence and cleans up. A bounded *process*
 * shutdown is different. Once its cleanup bound has already failed, no result
 * may be published and referenced renewal timers must not keep the process
 * alive forever. These finalizers are therefore invoked only by that forced
 * shutdown path.
 */
const activeRepositoryOperationFinalizers = new Set<() => Promise<void>>();

/**
 * Owner-token leases protect every orchestrator worktree phase across server
 * processes. Acquisition first hard-links a complete owner record to a stable
 * reservation path, then creates the artifact directory. Readers therefore
 * never have to guess whether an empty directory belongs to a live publisher.
 * Generation refreshes remain temp-then-rename atomic.
 */
export class WorktreeLeaseStore {
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly afterArtifactCreated?: WorktreeLeaseStoreOptions["afterArtifactCreated"];
  private readonly beforePublish?: (phase: WorktreeLeasePhase) => void | Promise<void>;
  private readonly beforeRetire?: (artifact: string) => void | Promise<void>;
  private readonly maintenanceIntervalMs?: number;

  constructor(options: WorktreeLeaseStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(24).toString("base64url"));
    this.afterArtifactCreated = options.afterArtifactCreated;
    this.beforePublish = options.beforePublish;
    this.beforeRetire = options.beforeRetire;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs;
  }

  async acquire(
    worktreePath: string,
    expiresAt: number,
    phase: WorktreeLeasePhase,
  ): Promise<WorktreeLease> {
    assertLeaseExpiry(expiresAt, this.now());
    const artifact = continuationLeasePath(worktreePath);
    const leaseRoot = path.dirname(artifact);
    const leaseNamespace = path.dirname(leaseRoot);
    await ensureConfinedDirectoryChain(path.dirname(leaseNamespace), leaseRoot);
    const lease: WorktreeLease = {
      worktreePath,
      ownerToken: this.tokenFactory(),
      expiresAt,
      leaseRootIdentity: await this.readDirectoryIdentity(leaseRoot),
      leaseNamespaceIdentity: await this.readDirectoryIdentity(leaseNamespace),
    };
    await this.reserveAcquisition(lease, expiresAt, phase);

    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await fs.mkdir(artifact);
          lease.artifactIdentity = await this.readArtifactIdentity(artifact);
          await fs.writeFile(
            acquisitionOwnerMarkerPath(artifact, lease.ownerToken),
            JSON.stringify(makeLeaseRecord(lease, expiresAt, phase)),
            { encoding: "utf8", flag: "wx" },
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = await this.inspectArtifact(artifact);
          if (existing.state !== "expired") {
            throw new WorktreeUnavailableError(
              `The isolated worktree identity ${path.basename(worktreePath)} is still in use.`,
              "Retry with a fresh batch identity, or wait for its bounded lease to expire.",
            );
          }
          await this.retireExpiredArtifact(artifact);
          continue;
        }

        await this.afterArtifactCreated?.(phase);
        await this.assertAcquisitionOwnership(lease);
        await this.publish(lease, expiresAt, phase, () =>
          this.assertAcquisitionOwnership(lease),
        );
        await this.releaseAcquisitionReservation(lease);
        return lease;
      }

      throw new WorktreeUnavailableError(
        `The isolated worktree identity ${path.basename(worktreePath)} changed ownership while it was being acquired.`,
        "Retry with a fresh batch identity.",
      );
    } catch (error) {
      await this.rollbackAcquisition(lease);
      await this.releaseAcquisitionReservation(lease);
      throw error;
    }
  }

  async refresh(
    lease: WorktreeLease,
    expiresAt: number,
    phase: WorktreeLeasePhase,
  ): Promise<void> {
    assertLeaseExpiry(expiresAt, this.now());
    const artifact = continuationLeasePath(lease.worktreePath);
    await this.assertArtifactIdentity(lease, artifact);
    const inspection = await this.inspectArtifact(artifact);
    const now = this.now();
    if (
      !inspection.records.some(
        ({ record }) => record.ownerToken === lease.ownerToken && record.expiresAt > now,
      ) ||
      inspection.records.some(
        ({ record }) => record.ownerToken !== lease.ownerToken && record.expiresAt > now,
      )
    ) {
      throw new WorktreeLeaseOwnershipError();
    }

    const published = await this.publish(lease, expiresAt, phase, (temporary) =>
      this.assertRefreshOwnership(lease, temporary),
    );
    lease.expiresAt = expiresAt;
    await Promise.all(
      inspection.records
        .filter(
          ({ file, record }) =>
            record.ownerToken === lease.ownerToken && file !== published,
        )
        .map(({ file }) => fs.rm(file, { force: true }).catch(() => undefined)),
    );
  }

  async release(lease: WorktreeLease): Promise<void> {
    const artifact = continuationLeasePath(lease.worktreePath);
    await this.assertArtifactIdentity(lease, artifact);
    const inspection = await this.inspectArtifact(artifact);
    const reservation = await this.inspectArtifact(acquisitionReservationPath(artifact));
    const now = this.now();
    const owned = inspection.records.filter(
      ({ record }) => record.ownerToken === lease.ownerToken,
    );
    const ownsReservation = reservation.records.some(
      ({ record }) => record.ownerToken === lease.ownerToken,
    );
    const hasOtherLiveOwner = inspection.records.some(
      ({ record }) => record.ownerToken !== lease.ownerToken && record.expiresAt > now,
    );
    if ((owned.length === 0 && !ownsReservation) || hasOtherLiveOwner) {
      throw new WorktreeLeaseOwnershipError(
        "Persistent worktree lease ownership could not be proven during release.",
      );
    }
    await Promise.all(
      owned.map(({ file }) => fs.rm(file, { force: true }).catch(() => undefined)),
    );
    await fs
      .rm(acquisitionOwnerMarkerPath(artifact, lease.ownerToken), { force: true })
      .catch(() => undefined);
    try {
      await fs.rmdir(artifact);
    } catch (error) {
      throw new WorktreeLeaseOwnershipError(
        `Persistent worktree lease artifact could not be removed cleanly during release: ${(error as Error).message}`,
      );
    }
  }

  async isProtected(worktreePath: string, now = this.now()): Promise<boolean> {
    const artifact = continuationLeasePath(worktreePath);
    if (
      (await this.inspectArtifact(acquisitionReservationPath(artifact), now)).state ===
      "protected"
    ) {
      return true;
    }
    return (await this.inspectArtifact(artifact, now)).state === "protected";
  }

  async sweepExpired(repoRoot: string, now = this.now()): Promise<string[]> {
    const root = continuationLeaseRoot(repoRoot);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const removed = new Set<string>();

    // Prepared records were never active, but a crash before the hard link can
    // leave one behind. Their expiry is encoded in the filename.
    for (const entry of entries) {
      const match = /^(.*\.lease)\.acquire\.publish-(\d+)-[a-f0-9]+\.tmp$/.exec(
        entry.name,
      );
      if (!match || Number(match[2]) > now) continue;
      await fs.rm(path.join(root, entry.name), { force: true }).catch(() => undefined);
    }

    // Acquisition reservations are complete records atomically hard-linked to
    // their stable names. Sweep them independently so a crash before mkdir does
    // not strand the reusable metadata identity.
    for (const entry of entries) {
      if (!entry.name.endsWith(".lease.acquire")) continue;
      const reservation = path.join(root, entry.name);
      if ((await this.inspectArtifact(reservation, now)).state !== "expired") continue;
      if (!(await this.retireExpiredArtifact(reservation, now))) continue;
      const identity = entry.name.slice(0, -".lease.acquire".length);
      if (identity !== ".metadata") {
        removed.add(path.join(repoRoot, ...WORKTREE_DIR.split("/"), identity));
      }
    }

    for (const entry of entries) {
      if (!entry.name.endsWith(".lease")) continue;
      const artifact = path.join(root, entry.name);
      if (
        (await this.inspectArtifact(acquisitionReservationPath(artifact), now)).state ===
        "protected"
      ) {
        continue;
      }
      if ((await this.inspectArtifact(artifact, now)).state !== "expired") continue;
      if (!(await this.retireExpiredArtifact(artifact, now))) continue;
      const identity = entry.name.slice(0, -".lease".length);
      if (identity !== ".metadata") {
        removed.add(path.join(repoRoot, ...WORKTREE_DIR.split("/"), identity));
      }
    }
    return [...removed];
  }

  maintain(
    lease: WorktreeLease,
    lifetimeMs: number,
    phase: WorktreeLeasePhase,
    signal?: AbortSignal,
  ): WorktreeLeaseMaintenance {
    const safeLifetime = Math.max(lifetimeMs, WORKTREE_LEASE_GRACE_MS + 1_000);
    const intervalMs =
      this.maintenanceIntervalMs ??
      Math.max(1_000, Math.min(60_000, Math.floor(safeLifetime / 3)));
    let stopped = false;
    let failure: Error | null = null;
    let reportFailure!: (error: WorktreeLeaseRenewalError) => void;
    const whenUnhealthy = new Promise<WorktreeLeaseRenewalError>((resolve) => {
      reportFailure = resolve;
    });
    let inFlight: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      if (stopped || failure) return;
      inFlight = inFlight
        .then(() => this.refresh(lease, this.now() + safeLifetime, phase))
        .catch((error: unknown) => {
          const renewalError = new WorktreeLeaseRenewalError(
            `Persistent worktree lease renewal failed: ${(error as Error).message}`,
            error,
          );
          failure = renewalError;
          reportFailure(renewalError);
          clearInterval(timer);
        });
    }, intervalMs);

    const stopTimer = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    };
    const onAbort = (): void => stopTimer();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    return {
      assertHealthy: (minimumRemainingMs = 0) => {
        if (failure) throw failure;
        if (lease.expiresAt - this.now() <= minimumRemainingMs) {
          throw new WorktreeLeaseRenewalError(
            "Persistent worktree lease health is insufficient for the next bounded operation.",
            undefined,
          );
        }
      },
      whenUnhealthy,
      forceStop: () => {
        stopTimer();
        signal?.removeEventListener("abort", onAbort);
      },
      stop: async () => {
        stopTimer();
        signal?.removeEventListener("abort", onAbort);
        await inFlight;
        if (failure) throw failure;
      },
    };
  }

  private async reserveAcquisition(
    lease: WorktreeLease,
    expiresAt: number,
    phase: WorktreeLeasePhase,
  ): Promise<void> {
    const artifact = continuationLeasePath(lease.worktreePath);
    const reservation = acquisitionReservationPath(artifact);
    const record = JSON.stringify(makeLeaseRecord(lease, expiresAt, phase));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const generation = randomBytes(12).toString("hex");
      const prepared = `${reservation}.publish-${Math.trunc(expiresAt)}-${generation}.tmp`;
      await fs.writeFile(prepared, record, { encoding: "utf8", flag: "wx" });
      try {
        await fs.link(prepared, reservation);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.inspectArtifact(reservation);
        if (existing.state !== "expired") {
          throw new WorktreeUnavailableError(
            `The isolated worktree identity ${path.basename(lease.worktreePath)} is still in use.`,
            "Retry with a fresh batch identity, or wait for its bounded lease to expire.",
          );
        }
        await this.retireExpiredArtifact(reservation);
      } finally {
        await fs.rm(prepared, { force: true }).catch(() => undefined);
      }
    }

    throw new WorktreeUnavailableError(
      `The isolated worktree identity ${path.basename(lease.worktreePath)} changed ownership while it was being acquired.`,
      "Retry with a fresh batch identity.",
    );
  }

  private async releaseAcquisitionReservation(lease: WorktreeLease): Promise<void> {
    const reservation = acquisitionReservationPath(
      continuationLeasePath(lease.worktreePath),
    );
    const inspection = await this.inspectArtifact(reservation);
    if (!inspection.records.some(({ record }) => record.ownerToken === lease.ownerToken))
      return;
    await fs.rm(reservation, { force: true }).catch(() => undefined);
  }

  private async assertAcquisitionOwnership(lease: WorktreeLease): Promise<void> {
    const artifact = continuationLeasePath(lease.worktreePath);
    await this.assertArtifactIdentity(lease, artifact);
    const reservation = await this.inspectArtifact(acquisitionReservationPath(artifact));
    const marker = parseLeaseRecord(
      await fs
        .readFile(acquisitionOwnerMarkerPath(artifact, lease.ownerToken), "utf8")
        .catch(() => ""),
    );
    const now = this.now();
    const ownsLiveReservation = reservation.records.some(
      ({ record }) => record.ownerToken === lease.ownerToken && record.expiresAt > now,
    );
    if (
      !ownsLiveReservation ||
      !marker ||
      marker.ownerToken !== lease.ownerToken ||
      marker.expiresAt <= now
    ) {
      throw new WorktreeUnavailableError(
        `The isolated worktree identity ${path.basename(lease.worktreePath)} changed ownership before publication.`,
        "Retry with a fresh batch identity.",
      );
    }
  }

  /** Revalidate the exact live owner immediately before a refresh is published. */
  private async assertRefreshOwnership(
    lease: WorktreeLease,
    publicationTemporary?: string,
  ): Promise<void> {
    const artifact = continuationLeasePath(lease.worktreePath);
    await this.assertArtifactIdentity(lease, artifact);
    if (publicationTemporary) {
      // Once the complete next-generation record exists, that exact temp file is
      // the refresher's protected ownership claim. Sweep treats its future
      // expiry as protected, so the old generation may cross its expiry while a
      // slow fsync/hook seam is paused without opening a replacement window.
      const record = parseLeaseRecord(
        await fs.readFile(publicationTemporary, "utf8").catch(() => ""),
      );
      const now = this.now();
      if (record?.ownerToken === lease.ownerToken && record.expiresAt > now) {
        return;
      }
      throw new WorktreeLeaseOwnershipError();
    }
    const inspection = await this.inspectArtifact(artifact);
    const now = this.now();
    const ownsLiveGeneration = inspection.records.some(
      ({ record }) => record.ownerToken === lease.ownerToken && record.expiresAt > now,
    );
    const hasOtherLiveOwner = inspection.records.some(
      ({ record }) => record.ownerToken !== lease.ownerToken && record.expiresAt > now,
    );
    if (!ownsLiveGeneration || hasOtherLiveOwner) throw new WorktreeLeaseOwnershipError();
  }

  private async readDirectoryIdentity(directory: string): Promise<string> {
    const stat = await fs.lstat(directory, { bigint: true }).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorktreeLeaseOwnershipError(
        "Persistent worktree lease control directory is missing or redirected.",
      );
    }
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  }

  private async readArtifactIdentity(artifact: string): Promise<string> {
    return this.readDirectoryIdentity(artifact);
  }

  private async assertArtifactIdentity(
    lease: WorktreeLease,
    artifact = continuationLeasePath(lease.worktreePath),
  ): Promise<void> {
    const leaseRoot = path.dirname(artifact);
    const leaseNamespace = path.dirname(leaseRoot);
    if (lease.leaseNamespaceIdentity) {
      const currentNamespace = await this.readDirectoryIdentity(leaseNamespace).catch(
        () => null,
      );
      if (currentNamespace !== lease.leaseNamespaceIdentity) {
        throw new WorktreeLeaseOwnershipError(
          "Persistent worktree lease namespace changed identity after acquisition.",
        );
      }
    }
    if (lease.leaseRootIdentity) {
      const currentRoot = await this.readDirectoryIdentity(leaseRoot).catch(() => null);
      if (currentRoot !== lease.leaseRootIdentity) {
        throw new WorktreeLeaseOwnershipError(
          "Persistent worktree lease root changed identity after acquisition.",
        );
      }
    }
    if (!lease.artifactIdentity) return;
    const current = await this.readArtifactIdentity(artifact).catch(() => null);
    if (current !== lease.artifactIdentity) {
      throw new WorktreeLeaseOwnershipError(
        "Persistent worktree lease artifact changed identity after acquisition.",
      );
    }
  }

  private async rollbackAcquisition(lease: WorktreeLease): Promise<void> {
    // Exact-owner cleanup only. A replacement has a different marker and
    // generation owner, so its non-empty artifact cannot be removed here.
    try {
      await this.release(lease);
    } catch (error) {
      if (!(error instanceof WorktreeLeaseOwnershipError)) throw error;
      // Losing the artifact/ancestor identity is itself proof that this stale
      // acquirer no longer has cleanup authority. Leave the replacement owner
      // untouched; the stable acquisition reservation is released separately.
    }
  }

  private async publish(
    lease: WorktreeLease,
    expiresAt: number,
    phase: WorktreeLeasePhase,
    assertBeforePublication?: (publicationTemporary?: string) => Promise<void>,
  ): Promise<string> {
    const artifact = continuationLeasePath(lease.worktreePath);
    const generation = randomBytes(12).toString("hex");
    const temporary = path.join(
      artifact,
      `.publish-${Math.trunc(expiresAt)}-${generation}.tmp`,
    );
    const published = path.join(artifact, `${generation}.json`);
    const record = makeLeaseRecord(lease, expiresAt, phase);

    await assertBeforePublication?.();
    await fs.writeFile(temporary, JSON.stringify(record), {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      await this.beforePublish?.(phase);
      await assertBeforePublication?.(temporary);
      await fs.rename(temporary, published);
      return published;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async inspectArtifact(
    artifact: string,
    now = this.now(),
  ): Promise<LeaseInspection> {
    const stat = await fs.lstat(artifact).catch(() => null);
    if (!stat) return { state: "absent", records: [] };

    // Compatibility with the first path-only lease format on this branch.
    if (!stat.isDirectory()) {
      const value = await fs.readFile(artifact, "utf8").catch(() => "");
      const record = parseLeaseRecord(value);
      if (record) {
        return {
          state: record.expiresAt <= now ? "expired" : "protected",
          records: [{ file: artifact, record }],
        };
      }
      const expiresAt = Number(value);
      return {
        state: Number.isFinite(expiresAt) && expiresAt <= now ? "expired" : "protected",
        records: [],
      };
    }

    const names = await fs.readdir(artifact).catch(() => null);
    if (!names) return { state: "protected", records: [] };
    const temporaryExpiries = names
      .filter((name) => name.endsWith(".tmp"))
      .map((name) => /^\.publish-(\d+)-[a-f0-9]+\.tmp$/.exec(name)?.[1] ?? null);
    const hasLiveOrUnknownPublication = temporaryExpiries.some(
      (expiresAt) => expiresAt === null || Number(expiresAt) > now,
    );

    const records: LeaseFileRecord[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const file = path.join(artifact, name);
      const record = parseLeaseRecord(await fs.readFile(file, "utf8").catch(() => ""));
      if (!record) return { state: "protected", records: [] };
      records.push({ file, record });
    }
    if (records.length === 0) {
      return {
        // An in-progress publisher is conservatively protected even before its
        // generation becomes visible. Keep returning records when they do
        // exist, though: refresh ownership revalidation must still be able to
        // identify the exact live owner while its own temp file is present.
        state: hasLiveOrUnknownPublication ? "protected" : "expired",
        records: [],
      };
    }
    return {
      state:
        hasLiveOrUnknownPublication ||
        records.some(({ record }) => record.expiresAt > now)
          ? "protected"
          : "expired",
      records,
    };
  }

  private async retireExpiredArtifact(
    artifact: string,
    now = this.now(),
  ): Promise<boolean> {
    const retired = `${artifact}.expired-${randomBytes(12).toString("hex")}`;
    try {
      await this.beforeRetire?.(artifact);
      await fs.rename(artifact, retired);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      if (["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        // Windows can transiently refuse a rename while another process has the
        // stale reservation open or is racing to retire the same stable name.
        // Never treat that as permission to reuse the identity: reinspection is
        // authoritative and the caller must retry acquisition if the stale name
        // still exists. This converts a sharing race into ordinary contention
        // without deleting, ignoring, or claiming ownership of protected state.
        await this.inspectArtifact(artifact, now);
        return false;
      }
      throw error;
    }

    // The earlier inspection and this rename are not one filesystem CAS. A
    // legitimate owner may publish a fresh generation between them. Inspect the
    // exact directory we atomically moved; if it contains live/future protection,
    // restore it when possible and never tell pruning that the worktree is stale.
    if ((await this.inspectArtifact(retired, now)).state === "protected") {
      try {
        await fs.rename(retired, artifact);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A replacement generation already owns the stable name. Keep the
        // retired directory out of that owner's way; it no longer authorizes
        // pruning of the shared worktree identity.
      }
      return false;
    }
    await fs.rm(retired, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }
}

const worktreeLeaseStore = new WorktreeLeaseStore();

const worktreePathKey = (value: string): string => {
  const normalized = path.resolve(value);
  return isCaseInsensitive() ? normalized.toLowerCase() : normalized;
};

const continuationLeaseRoot = (repoRoot: string): string =>
  path.join(repoRoot, ".sol-luna", "continuation-leases");

export const continuationLeasePath = (worktreePath: string): string =>
  path.join(
    path.dirname(path.dirname(worktreePath)),
    "continuation-leases",
    `${path.basename(worktreePath)}.lease`,
  );

const acquisitionReservationPath = (artifact: string): string => `${artifact}.acquire`;

const acquisitionOwnerMarkerPath = (artifact: string, ownerToken: string): string =>
  path.join(artifact, `.owner-${ownerToken}.marker`);

const makeLeaseRecord = (
  lease: WorktreeLease,
  expiresAt: number,
  phase: WorktreeLeasePhase,
): WorktreeLeaseRecord => ({
  version: LEASE_VERSION,
  ownerToken: lease.ownerToken,
  phase,
  expiresAt,
});

const parseLeaseRecord = (value: string): WorktreeLeaseRecord | null => {
  try {
    const candidate = JSON.parse(value) as Partial<WorktreeLeaseRecord>;
    if (
      candidate.version !== LEASE_VERSION ||
      typeof candidate.ownerToken !== "string" ||
      candidate.ownerToken.length === 0 ||
      ![
        "metadata",
        "operation",
        "creating",
        "running",
        "retained-continuation",
        "executing-continuation",
      ].includes(candidate.phase ?? "") ||
      typeof candidate.expiresAt !== "number" ||
      !Number.isFinite(candidate.expiresAt)
    ) {
      return null;
    }
    return candidate as WorktreeLeaseRecord;
  } catch {
    return null;
  }
};

const assertLeaseExpiry = (expiresAt: number, now: number): void => {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("A worktree lease must expire in the future.");
  }
};

export const refreshWorktreeLease = (
  lease: WorktreeLease,
  expiresAt: number,
  phase: WorktreeLeasePhase,
): Promise<void> => worktreeLeaseStore.refresh(lease, expiresAt, phase);

export const releaseWorktreeLease = (lease: WorktreeLease): Promise<void> =>
  worktreeLeaseStore.release(lease);

export const sweepExpiredWorktreeLeases = (
  repoRoot: string,
  now?: number,
): Promise<string[]> => worktreeLeaseStore.sweepExpired(repoRoot, now);

export const maintainWorktreeLease = (
  lease: WorktreeLease,
  lifetimeMs: number,
  phase: WorktreeLeasePhase,
  signal?: AbortSignal,
): WorktreeLeaseMaintenance =>
  worktreeLeaseStore.maintain(lease, lifetimeMs, phase, signal);

const repositoryOperationIdentity = (commonGitDir: string): string =>
  path.join(commonGitDir, "sol-luna-orchestrator", "operations", ".repository");

const repositoryOperationAbortError = (): Error => {
  const error = new Error("Repository operation was cancelled.");
  error.name = "AbortError";
  return error;
};

const throwIfOperationAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted && !forcedRepositoryOperationShutdown.signal.aborted) return;
  throw repositoryOperationAbortError();
};

const operationRetryDelay = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const forcedSignal = forcedRepositoryOperationShutdown.signal;
    if (signal?.aborted || forcedSignal.aborted) {
      reject(repositoryOperationAbortError());
      return;
    }
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      forcedSignal.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 25);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(repositoryOperationAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    forcedSignal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Acquire the long-lived, repo-scoped authority for one evidence-bearing
 * operation. The persistent identity is derived from the canonical common Git
 * directory, so peer servers contend on the same repository while unrelated
 * repositories remain independent.
 *
 * This is intentionally distinct from `withWorktreeMetadataAuthority`: callers
 * may hold this authority while invoking worktree add/remove/integration, which
 * then takes the short metadata lease underneath it. No code acquires these in
 * the opposite order.
 */
export async function acquireRepositoryOperationAuthority(
  workspace: string,
  signal?: AbortSignal,
  testHooks: {
    /** Deterministic seam for the forced-shutdown post-acquire race regression. */
    afterLeaseAcquired?: (lease: WorktreeLease) => void | Promise<void>;
  } = {},
): Promise<RepositoryOperationAuthority | null> {
  throwIfOperationAborted(signal);
  const resolvedCommonGitDir = await resolveGitCommonDir(workspace);
  if (!resolvedCommonGitDir) return null;
  const commonGitDir = await fs.realpath(resolvedCommonGitDir);
  await ensureCommonGitLeaseRoots(commonGitDir);
  const identity = repositoryOperationIdentity(commonGitDir);
  let lease: WorktreeLease | null = null;

  while (!lease) {
    throwIfOperationAborted(signal);
    try {
      lease = await worktreeLeaseStore.acquire(
        identity,
        Date.now() + OPERATION_LEASE_WINDOW_MS,
        "operation",
      );
    } catch (error) {
      if (!(error instanceof WorktreeUnavailableError)) throw error;
      await operationRetryDelay(signal);
    }
  }

  try {
    await testHooks.afterLeaseAcquired?.(lease);
    // Forced shutdown can begin while the filesystem acquisition above is
    // already in flight. Recheck both request and process-shutdown authority
    // before starting a referenced renewal or registering its finalizer.
    throwIfOperationAborted(signal);
  } catch (error) {
    await worktreeLeaseStore.release(lease);
    throw error;
  }

  const renewal = worktreeLeaseStore.maintain(
    lease,
    OPERATION_LEASE_WINDOW_MS,
    "operation",
  );
  let finalized = false;
  let forceStopped = false;
  let finalization: Promise<void> | null = null;
  const assertHealthy = (minimumRemainingMs = METADATA_COMMAND_SAFETY_MS): void => {
    if (forceStopped) {
      throw new WorktreeLeaseOwnershipError(
        "Repository operation authority renewal was force-stopped during shutdown.",
      );
    }
    if (finalized) {
      throw new WorktreeLeaseOwnershipError(
        "Repository operation authority is no longer owned by this operation.",
      );
    }
    renewal.assertHealthy(minimumRemainingMs);
  };

  try {
    assertHealthy();
  } catch (error) {
    try {
      await renewal.stop();
    } finally {
      await worktreeLeaseStore.release(lease);
    }
    throw error;
  }

  const finalize = (): Promise<void> => {
    if (finalization) return finalization;
    finalized = true;
    activeRepositoryOperationFinalizers.delete(forceStopRenewal);
    finalization = (async () => {
      let healthError: unknown = null;
      if (forceStopped) {
        healthError = new WorktreeLeaseOwnershipError(
          "Repository operation authority renewal was force-stopped during shutdown.",
        );
      } else {
        try {
          renewal.assertHealthy(0);
        } catch (error) {
          healthError = error;
        }
      }
      try {
        await renewal.stop();
      } catch (error) {
        healthError ??= error;
      }
      try {
        // In-memory renewal health is not enough: delegated code can mutate
        // `.git` directly. Prove the exact persistent owner still exists at
        // the final authority boundary before allowing callers to publish
        // success. A late unwind after forced shutdown still performs this
        // proof before surrendering the published owner.
        await worktreeLeaseStore.refresh(
          lease,
          Date.now() + OPERATION_LEASE_WINDOW_MS,
          "operation",
        );
      } catch (error) {
        healthError ??= error;
      }
      try {
        await worktreeLeaseStore.release(lease);
      } catch (error) {
        healthError ??= error;
      }
      if (healthError) throw healthError;
    })();
    return finalization;
  };
  const forceStopRenewal = async (): Promise<void> => {
    if (forceStopped || finalized) return;
    forceStopped = true;
    activeRepositoryOperationFinalizers.delete(forceStopRenewal);
    // Deliberately leave the persistent owner artifact in place. The operation
    // may still exist after ignoring abort, so reopening same-repository
    // concurrency here would be unsafe. Its already-published expiry remains a
    // bounded exclusion horizon, and a later normal unwind can still release it.
    renewal.forceStop();
  };
  activeRepositoryOperationFinalizers.add(forceStopRenewal);

  return {
    commonGitDir,
    assertHealthy,
    release: () => finalize(),
  };
}

/**
 * Forced process-shutdown escape hatch. Normal cancellation must never call
 * this: doing so would release same-repository exclusion before reconciliation
 * and cleanup finish. After the ShutdownCoordinator's bounded cleanup has
 * already failed, however, no operation result can be published; stopping the
 * pending acquisition retries and remaining operation renewals lets the process
 * terminate instead of being kept alive by their referenced timers. Persistent
 * owners are intentionally left published until their bounded expiry (or a
 * later normal unwind), so a stuck operation never reopens same-repository
 * concurrency merely because shutdown timed out.
 */
export async function forceStopRepositoryOperationRenewals(): Promise<void> {
  if (!forcedRepositoryOperationShutdown.signal.aborted) {
    forcedRepositoryOperationShutdown.abort("server-shutdown-timeout");
  }
  const finalizers = [...activeRepositoryOperationFinalizers];
  if (finalizers.length === 0) return;
  await Promise.allSettled(finalizers.map((finalize) => finalize()));
}

/** Main repository that owns a retained worktree lease artifact. */
export const repositoryRootForWorktreeLease = (lease: WorktreeLease): string =>
  path.resolve(
    lease.worktreePath,
    ...Array.from({ length: WORKTREE_DIR.split("/").length + 1 }, () => ".."),
  );

/**
 * Release a retained-worktree lease from an asynchronous parent lifecycle path
 * (for example continuation expiry) without contaminating a concurrent worker
 * evidence window in the same repository.
 */
export async function releaseWorktreeLeaseWithOperationAuthority(
  lease: WorktreeLease,
  signal?: AbortSignal,
): Promise<void> {
  const authority = await acquireRepositoryOperationAuthority(
    repositoryRootForWorktreeLease(lease),
    signal,
  );
  try {
    authority?.assertHealthy();
    await releaseWorktreeLease(lease);
    authority?.assertHealthy();
  } finally {
    await authority?.release();
  }
}

async function withPersistentMetadataLease<T>(
  repoRoot: string,
  operation: (assertLeaseHealthy: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const throwIfAborted = (): void => {
    if (!signal?.aborted) return;
    const error = new Error("Worktree metadata operation was cancelled.");
    error.name = "AbortError";
    throw error;
  };
  const abortableDelay = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!signal) {
        setTimeout(resolve, ms);
        return;
      }
      if (signal.aborted) {
        const error = new Error("Worktree metadata operation was cancelled.");
        error.name = "AbortError";
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        const error = new Error("Worktree metadata operation was cancelled.");
        error.name = "AbortError";
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

  const commonGitDir = await resolveGitCommonDir(repoRoot);
  if (!commonGitDir) {
    throw new WorktreeUnavailableError(
      `Could not resolve shared Git metadata for ${repoRoot}.`,
      "Retry from a valid Git repository; parallel worktree metadata cannot be safely serialized otherwise.",
    );
  }
  await ensureCommonGitLeaseRoots(commonGitDir);
  // Key peer processes by the canonical common Git directory, not by their
  // individual linked-worktree roots. Every linked worktree mutates the same
  // common .git/worktrees registry, so they must contend on one persistent
  // authority as well as this process's in-memory queue.
  const lockPath = path.join(
    commonGitDir,
    "sol-luna-orchestrator",
    "worktrees",
    ".metadata",
  );
  const deadline = Date.now() + METADATA_LEASE_WAIT_MS;
  let lease: WorktreeLease | null = null;

  while (!lease) {
    throwIfAborted();
    try {
      lease = await worktreeLeaseStore.acquire(
        lockPath,
        Date.now() + METADATA_LEASE_WINDOW_MS,
        "metadata",
      );
    } catch (error) {
      if (!(error instanceof WorktreeUnavailableError) || Date.now() >= deadline)
        throw error;
      await abortableDelay(25);
    }
  }

  throwIfAborted();

  const renewal = worktreeLeaseStore.maintain(
    lease,
    METADATA_LEASE_WINDOW_MS,
    "metadata",
    signal,
  );
  const assertLeaseHealthy = (): void => {
    throwIfAborted();
    renewal.assertHealthy(METADATA_COMMAND_SAFETY_MS);
  };
  try {
    assertLeaseHealthy();
    const result = await operation(assertLeaseHealthy);
    assertLeaseHealthy();
    return result;
  } finally {
    try {
      await renewal.stop();
    } finally {
      await worktreeLeaseStore.release(lease);
    }
  }
}

/**
 * Serialize a repository mutation across both this process and peer servers.
 * Integration uses the same authority as worktree registration so two batches
 * cannot perform last-writer-wins copies into one workspace concurrently.
 */
export function withWorktreeMetadataAuthority<T>(
  repoRoot: string,
  operation: (assertLeaseHealthy: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return worktreeMetadataQueue.run(() =>
    withPersistentMetadataLease(repoRoot, operation, signal),
  );
}

/**
 * Create an isolated worktree for one task.
 *
 * Serialized against every other worktree registration — see
 * `worktreeMetadataQueue`. On any failure partway through, whatever was created
 * is torn down before the error propagates, so a half-built worktree never
 * survives to confuse the next run.
 */
export function createTaskWorktree(
  base: WorktreeBase,
  taskId: string,
  mainWorkspace: string,
  leaseLifetimeMs = 2 * 60 * 60 * 1000 + WORKTREE_LEASE_GRACE_MS,
  signal?: AbortSignal,
): Promise<TaskWorktree> {
  return withWorktreeMetadataAuthority(
    base.repoRoot,
    (assertLeaseHealthy) =>
      createTaskWorktreeUnsynchronized(
        base,
        taskId,
        mainWorkspace,
        leaseLifetimeMs,
        assertLeaseHealthy,
      ),
    signal,
  );
}

async function createTaskWorktreeUnsynchronized(
  base: WorktreeBase,
  taskId: string,
  mainWorkspace: string,
  leaseLifetimeMs: number,
  assertMetadataLeaseHealthy: () => void,
): Promise<TaskWorktree> {
  await ensureRuntimeControlRoots(base.repoRoot);
  const target = path.join(base.repoRoot, ...WORKTREE_DIR.split("/"), taskId);
  const targetKey = worktreePathKey(target);
  const warnings: string[] = [];
  let lease: WorktreeLease | null = null;
  let workingDirectory = target;
  let gitEvidenceAuthority: GitEvidenceAuthority | null = null;
  let sharedSnapshotDirs: string[] = [];
  let sharedDirectoryBaseline: SharedDirectoryFingerprint | undefined;

  if (activeWorktreePaths.has(targetKey)) {
    throw new WorktreeUnavailableError(
      `The isolated worktree identity ${taskId} is still in use.`,
      "Retry the batch so it receives a fresh identity, or wait for its continuation to expire.",
    );
  }

  // Cross-process ownership exists before the target or Git metadata does.
  lease = await worktreeLeaseStore.acquire(
    target,
    Date.now() + leaseLifetimeMs,
    "creating",
  );
  activeWorktreePaths.add(targetKey);

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

  try {
    assertMetadataLeaseHealthy();
    // A previous expired lease/crash may have left this path behind.
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    assertMetadataLeaseHealthy();
    await addWorktree(base.repoRoot, target, base.baseCommit);
    assertMetadataLeaseHealthy();
    workingDirectory = base.workspaceRelativePath
      ? path.join(target, base.workspaceRelativePath)
      : target;
    await ensureConfinedDirectoryChain(target, workingDirectory);
    gitEvidenceAuthority = await captureGitEvidenceAuthority(target, base.baseCommit);
    if (!gitEvidenceAuthority) {
      throw new WorktreeUnavailableError(
        `Could not pin Git evidence authority for isolated worktree ${taskId}.`,
        "Retry the batch; do not trust worker evidence without an authenticated Git base.",
      );
    }
    const sharedSnapshot = await snapshotSharedDirectories(
      mainWorkspace,
      workingDirectory,
    );
    warnings.push(...sharedSnapshot.warnings);
    sharedSnapshotDirs = sharedSnapshot.provisioned;
    if (sharedSnapshotDirs.length > 0) {
      sharedDirectoryBaseline = await captureSharedDirectoryFingerprint(
        workingDirectory,
        sharedSnapshotDirs,
      );
    }
    assertMetadataLeaseHealthy();
    await worktreeLeaseStore.refresh(lease, Date.now() + leaseLifetimeMs, "running");
  } catch (error) {
    if (error instanceof WorktreeLeaseRenewalError) {
      // Fail closed: a partially registered worktree remains protected by its
      // full bounded task lease and is reclaimed only after that lease expires.
      activeWorktreePaths.delete(targetKey);
      throw error;
    }
    await removeWorktree(base.repoRoot, target).catch(() => undefined);
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    activeWorktreePaths.delete(targetKey);
    await worktreeLeaseStore.release(lease);
    throw error;
  }

  if (!gitEvidenceAuthority) {
    throw new WorktreeUnavailableError(
      `Could not retain Git evidence authority for isolated worktree ${taskId}.`,
      "Retry the batch.",
    );
  }

  return {
    taskId,
    path: target,
    repoRoot: base.repoRoot,
    workingDirectory,
    sharedLinkRoot: mainWorkspace,
    sharedSnapshotDirs,
    sharedDirectoryBaseline,
    gitEvidenceAuthority,
    initialWorkspaceDirtyPaths: [...base.workspaceDirtyPaths],
    warnings,
    lease,
  };
}

/** Project repository-root Git evidence into the task's requested workspace. */
export function projectWorktreeChangesToWorkspace(
  worktreeRoot: string,
  workingDirectory: string,
  changes: WorktreeChanges,
): WorktreeChanges {
  return {
    ...changes,
    files: changes.files.map((file) => {
      const absolute = path.join(worktreeRoot, ...file.path.split("/"));
      return {
        ...file,
        path: path.relative(workingDirectory, absolute).split(path.sep).join("/"),
      };
    }),
  };
}

/**
 * Link dependency directories from the main workspace into a worktree.
 *
 * A worktree holds tracked files only, so `node_modules` is missing and every
 * verification command would fail to resolve its imports. Junctions are used on
 * Windows because they need no elevated privileges, unlike symlinks.
 */
async function confinedSharedSource(root: string, dir: string): Promise<string | null> {
  const source = path.resolve(root, dir);
  const sourceStat = await fs.stat(source).catch(() => null);
  if (!sourceStat?.isDirectory()) return null;
  const [rootReal, sourceReal] = await Promise.all([
    fs.realpath(root).catch(() => null),
    fs.realpath(source).catch(() => null),
  ]);
  if (!rootReal || !sourceReal || !pathIsWithin(rootReal, sourceReal)) return null;
  return source;
}

async function confinedSharedDestination(
  worktreePath: string,
  dir: string,
): Promise<string | null> {
  const root = path.resolve(worktreePath);
  const destination = path.resolve(root, dir);
  const parent = path.dirname(destination);
  if (!pathIsWithin(root, parent)) return null;
  try {
    await assertConfinedDirectoryChain(root, parent);
  } catch {
    return null;
  }
  const [rootReal, parentReal] = await Promise.all([
    fs.realpath(root).catch(() => null),
    fs.realpath(parent).catch(() => null),
  ]);
  if (!rootReal || !parentReal || !pathIsWithin(rootReal, parentReal)) return null;
  return destination;
}

interface ProvisionedSharedDestination {
  destination: string;
  name: string;
  parent: PinnedDirectoryAuthority;
  chain: ConfinedDirectoryChainResult;
}

async function provisionSharedDestination(
  worktreePath: string,
  dir: string,
  beforeCreate?: EnsureConfinedDirectoryChainOptions["beforeCreate"],
): Promise<ProvisionedSharedDestination> {
  const root = path.resolve(worktreePath);
  const destination = path.resolve(root, dir);
  const parentDirectory = path.dirname(destination);
  if (!pathIsWithin(root, parentDirectory)) {
    throw new ConfinedDirectoryChainError(
      `Shared destination resolves outside its worktree root: ${destination}.`,
      "Use a confined relative shared-directory path.",
      true,
    );
  }
  const chain = await ensureConfinedDirectoryChain(root, parentDirectory, {
    beforeCreate,
  });
  return {
    destination,
    name: path.basename(destination),
    parent: chain.authority,
    chain,
  };
}

export async function linkSharedDirectories(
  mainWorkspace: string,
  worktreePath: string,
  dirs: string[] = WORKTREE_LINK_DIRS,
): Promise<string[]> {
  const warnings: string[] = [];
  const parsed = parseWorktreeLinkDirectories(dirs.join(","));
  for (const invalid of parsed.invalid) {
    warnings.push(`Skipped unsafe shared worktree link path: ${invalid}`);
  }

  for (const dir of parsed.dirs) {
    const sourceCandidate = path.resolve(mainWorkspace, dir);
    const sourceStat = await fs.stat(sourceCandidate).catch(() => null);
    if (!sourceStat?.isDirectory()) continue;
    const source = await confinedSharedSource(mainWorkspace, dir);
    if (!source) {
      warnings.push(`Skipped shared worktree link outside the workspace: ${dir}`);
      continue;
    }
    let destination: ProvisionedSharedDestination;
    try {
      destination = await provisionSharedDestination(worktreePath, dir);
    } catch (error) {
      warnings.push(
        `Skipped shared worktree link with unsafe destination ancestry: ${dir} (${(error as Error).message})`,
      );
      continue;
    }

    try {
      await runPinnedDirectoryMutation(destination.parent, {
        op: "symlink",
        name: destination.name,
        target: source,
        type: process.platform === "win32" ? "junction" : "dir",
      });
    } catch (error) {
      const rollbackComplete = await destination.chain.rollback();
      if (error instanceof PinnedDirectoryMutationError && error.code === "EEXIST") {
        if (!rollbackComplete) {
          warnings.push(
            `Could not fully roll back parent directories after ${dir} appeared concurrently.`,
          );
        }
        continue;
      }
      warnings.push(
        `Could not link ${dir} into the worktree (${(error as Error).message}). ` +
          `Verification commands that need it will fail.${rollbackComplete ? "" : " Parent rollback could not be proven complete."}`,
      );
    }
  }

  return warnings;
}

export interface SharedDirectorySnapshotResult {
  warnings: string[];
  provisioned: string[];
  rollbackComplete: boolean;
}

export interface SnapshotSharedDirectoriesOptions {
  beforeParentCreate?: EnsureConfinedDirectoryChainOptions["beforeCreate"];
  /** Test seam after the helper has pinned the destination parent and before final rename. */
  beforeDestinationCommit?: (context: {
    parent: PinnedDirectoryAuthority;
    destination: string;
    name: string;
    dir: string;
  }) => void | Promise<void>;
}

/**
 * Copy configured dependency/setup directories into an isolated worktree.
 *
 * Production worktrees deliberately use private snapshots rather than writable
 * links back into the operator workspace. A worker may modify its copy, but it
 * cannot thereby author code that a later parent-side verification command will
 * execute from the authoritative workspace.
 */
export async function snapshotSharedDirectories(
  mainWorkspace: string,
  worktreePath: string,
  dirs: string[] = WORKTREE_LINK_DIRS,
  options: SnapshotSharedDirectoriesOptions = {},
): Promise<SharedDirectorySnapshotResult> {
  const warnings: string[] = [];
  const provisioned: string[] = [];
  let rollbackComplete = true;
  const parsed = parseWorktreeLinkDirectories(dirs.join(","));
  for (const invalid of parsed.invalid) {
    warnings.push(`Skipped unsafe shared worktree snapshot path: ${invalid}`);
  }

  for (const dir of parsed.dirs) {
    const sourceCandidate = path.resolve(mainWorkspace, dir);
    const sourceStat = await fs.stat(sourceCandidate).catch(() => null);
    if (!sourceStat?.isDirectory()) continue;
    const source = await confinedSharedSource(mainWorkspace, dir);
    if (!source) {
      warnings.push(`Skipped shared worktree snapshot outside the workspace: ${dir}`);
      continue;
    }
    let destination: ProvisionedSharedDestination;
    try {
      destination = await provisionSharedDestination(
        worktreePath,
        dir,
        options.beforeParentCreate,
      );
    } catch (error) {
      if (error instanceof ConfinedDirectoryChainError) {
        rollbackComplete &&= error.rollbackComplete;
      }
      warnings.push(
        `Skipped shared worktree snapshot with unsafe destination ancestry: ${dir} (${(error as Error).message})`,
      );
      continue;
    }

    const existingDestination = await fs.lstat(destination.destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (existingDestination) {
      const parentRollbackComplete = await destination.chain.rollback();
      rollbackComplete &&= parentRollbackComplete;
      warnings.push(
        `Skipped shared worktree snapshot because the destination exists: ${dir}` +
          `${parentRollbackComplete ? "" : " Parent rollback could not be proven complete."}`,
      );
      continue;
    }

    const stagingName = `.sol-luna-snapshot-${randomBytes(12).toString("hex")}.tmp`;
    let stagingIdentity: string | undefined;
    let stagingMayExist = false;
    try {
      // The fingerprint walk is also the confinement walk: every symlink or
      // junction descendant must resolve inside this configured source tree and
      // is never traversed by the unsandboxed parent process.
      await captureSharedDirectoryFingerprint(mainWorkspace, [dir]);
      const copied = await runPinnedDirectoryMutation(destination.parent, {
        op: "copy-directory",
        name: stagingName,
        source,
      });
      stagingMayExist = copied.mutated;
      if (copied.snapshot?.kind !== "directory" || !copied.snapshot.identity) {
        throw new Error(
          "Pinned dependency staging copy did not retain directory identity.",
        );
      }
      stagingIdentity = copied.snapshot.identity;
      await runPinnedDirectoryMutation(
        destination.parent,
        {
          op: "rename-verified",
          sourceName: stagingName,
          destinationName: destination.name,
          expectedIdentity: stagingIdentity,
        },
        {
          beforeExecute: options.beforeDestinationCommit
            ? () =>
                options.beforeDestinationCommit?.({
                  parent: destination.parent,
                  destination: destination.destination,
                  name: destination.name,
                  dir,
                })
            : undefined,
        },
      );
      stagingMayExist = false;
      provisioned.push(dir.split(path.sep).join("/"));
    } catch (error) {
      if (error instanceof PinnedDirectoryMutationError && error.mutated) {
        stagingMayExist = true;
      }
      let stagingRollbackComplete = !stagingMayExist;
      if (stagingMayExist && stagingIdentity) {
        try {
          const removed = await runPinnedDirectoryMutation(destination.parent, {
            op: "rmdir",
            name: stagingName,
            expectedIdentity: stagingIdentity,
          });
          stagingRollbackComplete =
            removed.mutated && removed.snapshot?.kind === "missing";
        } catch {
          stagingRollbackComplete = false;
        }
      }
      const parentRollbackComplete = await destination.chain.rollback();
      rollbackComplete &&= parentRollbackComplete && stagingRollbackComplete;
      if (error instanceof PinnedDirectoryMutationError && error.code === "EEXIST") {
        warnings.push(
          `Skipped shared worktree snapshot because the destination exists: ${dir}` +
            `${parentRollbackComplete && stagingRollbackComplete ? "" : " Rollback could not be proven complete."}`,
        );
        continue;
      }
      warnings.push(
        `Could not snapshot ${dir} into the worktree (${(error as Error).message}). ` +
          `Verification commands that need it will fail.${parentRollbackComplete && stagingRollbackComplete ? "" : " Rollback could not be proven complete."}`,
      );
    }
  }
  return { warnings, provisioned, rollbackComplete };
}

/**
 * Remove only dependency-link entries that still match orchestrator setup.
 *
 * Git reports an untracked directory symlink as a changed top-level path. That
 * link is setup state, not worker work, but a worker-replaced directory or link
 * must remain visible and fail the normal scope checks.
 */
export async function filterOrchestratorOwnedSharedLinks(
  repoRoot: string,
  worktreePath: string,
  files: WorktreeChanges["files"],
  dirs: string[] = WORKTREE_LINK_DIRS,
): Promise<WorktreeChanges["files"]> {
  const unchangedLinks = new Set<string>();
  const parsed = parseWorktreeLinkDirectories(dirs.join(","));
  for (const dir of parsed.dirs) {
    const source = await confinedSharedSource(repoRoot, dir);
    const destination = await confinedSharedDestination(worktreePath, dir);
    if (!source || !destination) continue;
    const stat = await fs.lstat(destination).catch(() => null);
    if (!stat?.isSymbolicLink()) continue;

    const [sourceTarget, destinationTarget] = await Promise.all([
      fs.realpath(source).catch(() => null),
      fs.realpath(destination).catch(() => null),
    ]);
    if (
      sourceTarget &&
      destinationTarget &&
      worktreePathKey(sourceTarget) === worktreePathKey(destinationTarget)
    ) {
      unchangedLinks.add(dir.split(path.sep).join("/"));
    }
  }

  return files.filter(
    (file) =>
      ![...unchangedLinks].some(
        (link) => file.path === link || file.path.startsWith(`${link}/`),
      ),
  );
}

function filterProvisionedSharedSnapshots(
  files: WorktreeChanges["files"],
  dirs: string[] = [],
): WorktreeChanges["files"] {
  const roots = dirs.map((dir) => dir.split(path.sep).join("/").replace(/\/$/, ""));
  return files.filter(
    (file) =>
      !roots.some((root) => file.path === root || file.path.startsWith(`${root}/`)),
  );
}

export interface WorktreeOutcome {
  changes: WorktreeChanges;
  warnings: string[];
  /** Set when git could not provide a trustworthy final worktree snapshot. */
  error?: string;
}

/** Read what a worker changed before the worktree is torn down. */
export async function readWorktreeOutcome(
  worktree: TaskWorktree,
): Promise<WorktreeOutcome> {
  const warnings: string[] = [];
  try {
    if (!worktree.gitEvidenceAuthority) {
      throw new Error("Pinned Git evidence authority is unavailable for this worktree.");
    }
    const workingDirectory = worktree.workingDirectory ?? worktree.path;
    const workspacePrefix = path.relative(worktree.path, workingDirectory);
    const excludedRepoPaths = (worktree.sharedSnapshotDirs ?? []).map((dir) =>
      path.join(workspacePrefix, ...dir.split("/")),
    );
    const ignored = await listTrustedIgnoredFiles(
      worktree.gitEvidenceAuthority,
      excludedRepoPaths,
    );
    const trusted = await collectTrustedWorktreeChanges(worktree.gitEvidenceAuthority);
    const changes = projectWorktreeChangesToWorkspace(worktree.path, workingDirectory, {
      ...trusted,
      files: [...trusted.files, ...ignored.map((file) => ({ path: file, status: "I" }))],
    });
    const withoutLegacyLinks = await filterOrchestratorOwnedSharedLinks(
      worktree.sharedLinkRoot ?? worktree.repoRoot,
      workingDirectory,
      changes.files,
    );
    return {
      changes: {
        ...changes,
        files: filterProvisionedSharedSnapshots(
          withoutLegacyLinks,
          worktree.sharedSnapshotDirs,
        ),
      },
      warnings,
    };
  } catch (error) {
    const detail = `Could not read worktree changes: ${(error as Error).message}`;
    warnings.push(detail);
    return { changes: { files: [], diff: "" }, warnings, error: detail };
  }
}

export type CleanupReason = "success" | "failure" | "cancelled" | "evidence-failure";
export type WorktreeRetentionPolicy = "onfailure" | "always" | "never";

/** Decide intentional retention before any filesystem cleanup is attempted. */
export function shouldRetainWorktree(
  reason: CleanupReason,
  keepPolicy: WorktreeRetentionPolicy,
): boolean {
  if (keepPolicy === "never") return false;
  return keepPolicy === "always" || reason !== "success";
}

/**
 * Apply the operator's final retention decision, then remove when required.
 *
 * Linked directories are unlinked first: on Windows a junction that git deletes
 * recursively would take the real `node_modules` with it.
 */
export function cleanupWorktree(
  worktree: TaskWorktree,
  reason: CleanupReason,
  keepPolicy = KEEP_WORKTREES,
  signal?: AbortSignal,
): Promise<{ removed: boolean; keptAt?: string; error?: string }> {
  return withWorktreeMetadataAuthority(
    worktree.repoRoot,
    async (assertLeaseHealthy) => {
      const result = await cleanupWorktreeUnsynchronized(
        worktree,
        reason,
        keepPolicy,
        assertLeaseHealthy,
      );
      if (result.removed && worktree.lease) {
        await worktreeLeaseStore.release(worktree.lease);
      }
      return result;
    },
    signal,
  ).finally(() => {
    // Cleanup is the end of local execution ownership even when metadata
    // renewal or removal fails. Persistent protection remains independently.
    activeWorktreePaths.delete(worktreePathKey(worktree.path));
  });
}

/** Transfer a kept worktree from running-batch ownership to continuation policy. */
export function releaseWorktreeOwnership(worktree: TaskWorktree): void {
  activeWorktreePaths.delete(worktreePathKey(worktree.path));
}

async function cleanupWorktreeUnsynchronized(
  worktree: TaskWorktree,
  reason: CleanupReason,
  keepPolicy: WorktreeRetentionPolicy,
  assertMetadataLeaseHealthy: () => void,
): Promise<{ removed: boolean; keptAt?: string; error?: string }> {
  if (shouldRetainWorktree(reason, keepPolicy)) {
    return { removed: false, keptAt: worktree.path };
  }

  assertMetadataLeaseHealthy();
  await ensureRuntimeControlRoots(worktree.repoRoot);
  assertMetadataLeaseHealthy();
  await unlinkSharedDirectories(worktree.workingDirectory ?? worktree.path);
  assertMetadataLeaseHealthy();

  const result = await removeWorktree(
    worktree.repoRoot,
    worktree.path,
    3,
    assertMetadataLeaseHealthy,
  );
  assertMetadataLeaseHealthy();
  if (!result.removed) {
    // Fall back to removing the directory outright, then let git forget it.
    await fs.rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
    assertMetadataLeaseHealthy();
    await pruneWorktrees(worktree.repoRoot).catch(() => undefined);
    assertMetadataLeaseHealthy();
    const stillThere = await fs.stat(worktree.path).catch(() => null);
    if (stillThere) return { removed: false, keptAt: worktree.path, error: result.error };
  }

  assertMetadataLeaseHealthy();
  await pruneWorktrees(worktree.repoRoot).catch(() => undefined);
  assertMetadataLeaseHealthy();
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
  const parsed = parseWorktreeLinkDirectories(dirs.join(","));
  for (const dir of parsed.dirs) {
    const destination = await confinedSharedDestination(worktreePath, dir);
    if (!destination) continue;
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
export function pruneStaleWorktrees(
  repoRoot: string,
  protectedPaths: Iterable<string> = [],
  signal?: AbortSignal,
): Promise<string[]> {
  return withWorktreeMetadataAuthority(
    repoRoot,
    (assertLeaseHealthy) =>
      pruneStaleWorktreesUnsynchronized(repoRoot, protectedPaths, assertLeaseHealthy),
    signal,
  );
}

async function pruneStaleWorktreesUnsynchronized(
  repoRoot: string,
  protectedPaths: Iterable<string>,
  assertMetadataLeaseHealthy: () => void,
): Promise<string[]> {
  const removed: string[] = [];
  await ensureRuntimeControlRoots(repoRoot);
  assertMetadataLeaseHealthy();
  const ours = path.join(repoRoot, ...WORKTREE_DIR.split("/"));
  const protectedKeys = new Set([...protectedPaths].map(worktreePathKey));

  // Lease artifacts exist independently of Git worktree registration.
  await worktreeLeaseStore.sweepExpired(repoRoot);
  assertMetadataLeaseHealthy();

  const entries = await listWorktrees(repoRoot).catch(() => []);
  assertMetadataLeaseHealthy();
  for (const entry of entries) {
    const relative = path.relative(ours, entry.path);
    const isOurs =
      relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    if (!isOurs) continue;
    const key = worktreePathKey(entry.path);
    if (
      activeWorktreePaths.has(key) ||
      protectedKeys.has(key) ||
      (await worktreeLeaseStore.isProtected(entry.path))
    )
      continue;

    assertMetadataLeaseHealthy();
    await unlinkSharedDirectories(entry.path);
    assertMetadataLeaseHealthy();
    const result = await removeWorktree(repoRoot, entry.path, 1);
    assertMetadataLeaseHealthy();
    if (result.removed) {
      removed.push(entry.path);
    }
  }

  assertMetadataLeaseHealthy();
  await pruneWorktrees(repoRoot).catch(() => undefined);
  assertMetadataLeaseHealthy();
  return removed;
}
