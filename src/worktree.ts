import { randomBytes } from "node:crypto";
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
  GIT_TIMEOUT_MS,
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

export class WorktreeLeaseRenewalError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "WorktreeLeaseRenewalError";
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
  /** Exact persistent owner used for cross-process pruning protection. */
  lease?: WorktreeLease;
  /** Non-fatal problems, e.g. a shared directory that could not be linked. */
  warnings: string[];
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
const LEASE_VERSION = 1;

export type WorktreeLeasePhase =
  | "metadata"
  | "creating"
  | "running"
  | "retained-continuation"
  | "executing-continuation";

export interface WorktreeLease {
  worktreePath: string;
  ownerToken: string;
  /** Last successfully published protection horizon. */
  expiresAt: number;
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
  /** Test-only timer override; production derives a conservative interval. */
  maintenanceIntervalMs?: number;
}

export interface WorktreeLeaseMaintenance {
  /** Throws after the first failed refresh; callers use this at mutation boundaries. */
  assertHealthy: (minimumRemainingMs?: number) => void;
  /** Resolves exactly once with the first renewal failure. */
  whenUnhealthy: Promise<WorktreeLeaseRenewalError>;
  /** Stops renewal and rejects when renewal health was lost. */
  stop: () => Promise<void>;
}

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
  private readonly maintenanceIntervalMs?: number;

  constructor(options: WorktreeLeaseStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenFactory =
      options.tokenFactory ?? (() => randomBytes(24).toString("base64url"));
    this.afterArtifactCreated = options.afterArtifactCreated;
    this.beforePublish = options.beforePublish;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs;
  }

  async acquire(
    worktreePath: string,
    expiresAt: number,
    phase: WorktreeLeasePhase,
  ): Promise<WorktreeLease> {
    assertLeaseExpiry(expiresAt, this.now());
    const artifact = continuationLeasePath(worktreePath);
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    const lease = { worktreePath, ownerToken: this.tokenFactory(), expiresAt };
    await this.reserveAcquisition(lease, expiresAt, phase);

    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await fs.mkdir(artifact);
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
    const inspection = await this.inspectArtifact(artifact);
    if (
      !inspection.records.some(({ record }) => record.ownerToken === lease.ownerToken)
    ) {
      throw new Error("The worktree lease is no longer owned by this continuation.");
    }

    const published = await this.publish(lease, expiresAt, phase);
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
    const inspection = await this.inspectArtifact(artifact);
    const owned = inspection.records.filter(
      ({ record }) => record.ownerToken === lease.ownerToken,
    );
    await Promise.all(
      owned.map(({ file }) => fs.rm(file, { force: true }).catch(() => undefined)),
    );
    await fs
      .rm(acquisitionOwnerMarkerPath(artifact, lease.ownerToken), { force: true })
      .catch(() => undefined);
    await fs.rmdir(artifact).catch(() => undefined);
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
      if (!(await this.retireExpiredArtifact(reservation))) continue;
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
      if (!(await this.retireExpiredArtifact(artifact))) continue;
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
    timer.unref();

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
      stop: async () => {
        stopped = true;
        clearInterval(timer);
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

  private async rollbackAcquisition(lease: WorktreeLease): Promise<void> {
    const artifact = continuationLeasePath(lease.worktreePath);
    // Exact-owner cleanup only. A replacement has a different marker and
    // generation owner, so its non-empty artifact cannot be removed here.
    await this.release(lease);
    await fs
      .rm(acquisitionOwnerMarkerPath(artifact, lease.ownerToken), { force: true })
      .catch(() => undefined);
    await fs.rmdir(artifact).catch(() => undefined);
  }

  private async publish(
    lease: WorktreeLease,
    expiresAt: number,
    phase: WorktreeLeasePhase,
    assertBeforePublication?: () => Promise<void>,
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
      await assertBeforePublication?.();
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
    if (
      temporaryExpiries.some((expiresAt) => expiresAt === null || Number(expiresAt) > now)
    ) {
      return { state: "protected", records: [] };
    }

    const records: LeaseFileRecord[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const file = path.join(artifact, name);
      const record = parseLeaseRecord(await fs.readFile(file, "utf8").catch(() => ""));
      if (!record) return { state: "protected", records: [] };
      records.push({ file, record });
    }
    if (records.length === 0) {
      return {
        state: "expired",
        records: [],
      };
    }
    return {
      state: records.some(({ record }) => record.expiresAt > now)
        ? "protected"
        : "expired",
      records,
    };
  }

  private async retireExpiredArtifact(artifact: string): Promise<boolean> {
    const retired = `${artifact}.expired-${randomBytes(12).toString("hex")}`;
    try {
      await fs.rename(artifact, retired);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
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
): WorktreeLeaseMaintenance => worktreeLeaseStore.maintain(lease, lifetimeMs, phase);

async function withPersistentMetadataLease<T>(
  repoRoot: string,
  operation: (assertLeaseHealthy: () => void) => Promise<T>,
): Promise<T> {
  const lockPath = path.join(repoRoot, ...WORKTREE_DIR.split("/"), ".metadata");
  const deadline = Date.now() + METADATA_LEASE_WAIT_MS;
  let lease: WorktreeLease | null = null;

  while (!lease) {
    try {
      lease = await worktreeLeaseStore.acquire(
        lockPath,
        Date.now() + METADATA_LEASE_WINDOW_MS,
        "metadata",
      );
    } catch (error) {
      if (!(error instanceof WorktreeUnavailableError) || Date.now() >= deadline)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const renewal = worktreeLeaseStore.maintain(
    lease,
    METADATA_LEASE_WINDOW_MS,
    "metadata",
  );
  const assertLeaseHealthy = (): void =>
    renewal.assertHealthy(METADATA_COMMAND_SAFETY_MS);
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
): Promise<TaskWorktree> {
  return worktreeMetadataQueue.run(() =>
    withPersistentMetadataLease(base.repoRoot, (assertLeaseHealthy) =>
      createTaskWorktreeUnsynchronized(
        base,
        taskId,
        mainWorkspace,
        leaseLifetimeMs,
        assertLeaseHealthy,
      ),
    ),
  );
}

async function createTaskWorktreeUnsynchronized(
  base: WorktreeBase,
  taskId: string,
  mainWorkspace: string,
  leaseLifetimeMs: number,
  assertMetadataLeaseHealthy: () => void,
): Promise<TaskWorktree> {
  const target = path.join(base.repoRoot, ...WORKTREE_DIR.split("/"), taskId);
  const targetKey = worktreePathKey(target);
  const warnings: string[] = [];
  let lease: WorktreeLease | null = null;

  await fs.mkdir(path.dirname(target), { recursive: true });

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
    warnings.push(...(await linkSharedDirectories(mainWorkspace, target)));
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

  return { taskId, path: target, repoRoot: base.repoRoot, warnings, lease };
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
  /** Set when git could not provide a trustworthy final worktree snapshot. */
  error?: string;
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
    const detail = `Could not read worktree changes: ${(error as Error).message}`;
    warnings.push(detail);
    return { changes: { files: [], diff: "" }, warnings, error: detail };
  }
}

export type CleanupReason = "success" | "failure" | "cancelled" | "evidence-failure";

/**
 * Remove a worktree unless it is worth keeping as evidence.
 *
 * Linked directories are unlinked first: on Windows a junction that git deletes
 * recursively would take the real `node_modules` with it.
 */
export function cleanupWorktree(
  worktree: TaskWorktree,
  reason: CleanupReason,
  keepPolicy = KEEP_WORKTREES,
): Promise<{ removed: boolean; keptAt?: string; error?: string }> {
  return worktreeMetadataQueue
    .run(() =>
      withPersistentMetadataLease(worktree.repoRoot, async (assertLeaseHealthy) => {
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
      }),
    )
    .finally(() => {
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
  keepPolicy: typeof KEEP_WORKTREES,
  assertMetadataLeaseHealthy: () => void,
): Promise<{ removed: boolean; keptAt?: string; error?: string }> {
  const keep =
    reason === "evidence-failure" ||
    keepPolicy === "always" ||
    (keepPolicy === "onfailure" && reason !== "success");

  if (keep) return { removed: false, keptAt: worktree.path };

  assertMetadataLeaseHealthy();
  await unlinkSharedDirectories(worktree.path);
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
export function pruneStaleWorktrees(
  repoRoot: string,
  protectedPaths: Iterable<string> = [],
): Promise<string[]> {
  return worktreeMetadataQueue.run(() =>
    withPersistentMetadataLease(repoRoot, (assertLeaseHealthy) =>
      pruneStaleWorktreesUnsynchronized(repoRoot, protectedPaths, assertLeaseHealthy),
    ),
  );
}

async function pruneStaleWorktreesUnsynchronized(
  repoRoot: string,
  protectedPaths: Iterable<string>,
  assertMetadataLeaseHealthy: () => void,
): Promise<string[]> {
  const removed: string[] = [];
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
