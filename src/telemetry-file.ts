import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  linkSync,
  lstatSync,
  opendirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";

/**
 * A diagnostic stream is useful only while it remains bounded. One current file
 * plus one rotated predecessor caps each stream at roughly 32 MiB without
 * making telemetry authoritative for execution.
 */
export const TELEMETRY_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const TELEMETRY_ROTATED_SUFFIX = ".1";
const TELEMETRY_WRITE_LOCK_INFIX = ".sol-luna.lock.";
const TELEMETRY_NEW_FILE_INFIX = ".sol-luna.new.";
const TELEMETRY_LOCK_SCAN_MAX_ENTRIES = 4096;

export interface BoundedAppendOptions {
  maxBytes?: number;
}

function tightenPrivateMode(file: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best-effort only: telemetry must never become execution authority.
  }
}

interface TelemetryWriteLock {
  readonly marker: string;
  readonly current: Stats;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function processDefinitelyExited(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function reapDeadTelemetryArtifacts(file: string): void {
  const directory = path.dirname(file);
  const base = path.basename(file);
  const prefixes = [
    `${base}${TELEMETRY_WRITE_LOCK_INFIX}`,
    `${base}${TELEMETRY_NEW_FILE_INFIX}`,
  ];
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(directory);
    let scanned = 0;
    for (;;) {
      if (scanned >= TELEMETRY_LOCK_SCAN_MAX_ENTRIES) return;
      const entry = handle.readSync();
      if (!entry) return;
      scanned += 1;
      if (!entry.isFile()) continue;

      const prefix = prefixes.find((candidate) => entry.name.startsWith(candidate));
      if (!prefix) continue;
      const suffix = entry.name.slice(prefix.length);
      const match =
        /^(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
          suffix,
        );
      if (!match) continue;
      const ownerPid = Number(match[1]);
      if (!processDefinitelyExited(ownerPid)) continue;

      try {
        unlinkSync(path.join(directory, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      }
    }
  } catch {
    // Lock maintenance is telemetry-only. If the directory cannot be inspected,
    // acquisition below fails closed without affecting execution authority.
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // Best-effort telemetry cleanup only.
    }
  }
}

/**
 * Serialize one existing telemetry inode across MCP server processes.
 *
 * The owner marker is a unique hard link to the current telemetry inode. The
 * owner proceeds only when that link raises the inode's link count from one to
 * exactly two. A concurrent contender temporarily raises it higher, observes
 * contention, removes only its own unique marker, and drops its record.
 *
 * The marker name carries the owner PID and a random token. If a process dies,
 * a later writer can prove that PID is gone and unlink that exact marker without
 * ever deleting a replacement owner's differently named marker. This avoids the
 * stale fixed-lock ABA race while keeping telemetry best-effort and non-blocking.
 */
function acquireTelemetryWriteLock(file: string): TelemetryWriteLock | null {
  reapDeadTelemetryArtifacts(file);
  const marker = `${file}${TELEMETRY_WRITE_LOCK_INFIX}${process.pid}.${randomUUID()}`;
  let linked = false;
  let acquired = false;
  try {
    linkSync(file, marker);
    linked = true;
    const current = statSync(file, { throwIfNoEntry: false });
    const markerStat = lstatSync(marker);
    if (
      !current ||
      !markerStat.isFile() ||
      !sameFileIdentity(current, markerStat) ||
      current.nlink !== 2
    ) {
      return null;
    }
    acquired = true;
    return { marker, current };
  } catch {
    return null;
  } finally {
    if (linked && !acquired) {
      try {
        unlinkSync(marker);
      } catch {
        // The contender owns no user data through this marker; a failed unlink
        // is reaped after process exit if it survives.
      }
    }
  }
}

function createTelemetryFileExclusively(file: string, record: string): boolean {
  const temp = `${file}${TELEMETRY_NEW_FILE_INFIX}${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temp, record, { encoding: "utf8", mode: 0o600, flag: "wx" });
    tightenPrivateMode(temp);
    // Publish only a fully-written bounded inode. Hard-link creation is an
    // atomic no-replace operation: if another writer filled the missing current
    // path first, this record is dropped rather than appended without ownership.
    linkSync(temp, file);
    tightenPrivateMode(file);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(temp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A surviving owner-named temp is bounded/private and is reclaimed only
        // after this process is provably gone.
      }
    }
  }
}

function releaseTelemetryWriteLock(lock: TelemetryWriteLock): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      unlinkSync(lock.marker);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    }
  }
}

/**
 * Best-effort append for sensitive local telemetry.
 *
 * The caller deliberately ignores failures: logs/events must never affect task
 * authority. Records larger than the complete file budget are dropped rather
 * than creating an already-oversized file. When rotation cannot be completed
 * (for example, transient Windows sharing), the append is skipped so the file
 * cannot grow without bound; a later append retries rotation.
 */
export function appendBoundedPrivateFile(
  file: string,
  record: string,
  options: BoundedAppendOptions = {},
): boolean {
  const maxBytes = options.maxBytes ?? TELEMETRY_FILE_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return false;

  const recordBytes = Buffer.byteLength(record, "utf8");
  if (recordBytes > maxBytes) return false;

  reapDeadTelemetryArtifacts(file);
  let first: Stats | undefined;
  try {
    first = statSync(file, { throwIfNoEntry: false });
  } catch {
    return false;
  }
  if (!first) {
    return createTelemetryFileExclusively(file, record);
  }
  if (!first.isFile()) return false;

  const lock = acquireTelemetryWriteLock(file);
  if (!lock) return false;
  try {
    let existing: Stats | undefined = lock.current;
    tightenPrivateMode(file);

    const rotated = `${file}${TELEMETRY_ROTATED_SUFFIX}`;
    const predecessor = statSync(rotated, { throwIfNoEntry: false });
    if (predecessor && (!predecessor.isFile() || predecessor.size > maxBytes)) {
      rmSync(rotated, { force: true });
    }

    // A pre-hardening or externally-written current file may already exceed the
    // bound before this writer sees it. Retaining that whole file as `.1` would
    // preserve the very unbounded state rotation is meant to eliminate, so drop
    // the oversized legacy current and resume with this admitted record.
    if (existing && existing.size > maxBytes) {
      rmSync(file, { force: true });
      existing = undefined;
    } else if (existing && existing.size + recordBytes > maxBytes) {
      rmSync(rotated, { force: true });
      renameSync(file, rotated);
      tightenPrivateMode(rotated);
      existing = undefined;
    }

    if (existing) {
      appendFileSync(file, record, { encoding: "utf8", mode: 0o600 });
    } else {
      if (!createTelemetryFileExclusively(file, record)) return false;
    }
    // `mode` applies only at creation time. Tighten an older permissive current
    // file as well, while keeping telemetry best-effort.
    tightenPrivateMode(file);
    return true;
  } catch {
    return false;
  } finally {
    releaseTelemetryWriteLock(lock);
  }
}
