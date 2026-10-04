import { appendFileSync, chmodSync, renameSync, rmSync, statSync } from "node:fs";

/**
 * A diagnostic stream is useful only while it remains bounded. One current file
 * plus one rotated predecessor caps each stream at roughly 32 MiB without
 * making telemetry authoritative for execution.
 */
export const TELEMETRY_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const TELEMETRY_ROTATED_SUFFIX = ".1";

export interface BoundedAppendOptions {
  maxBytes?: number;
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

  try {
    const existing = statSync(file, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) return false;

    if (existing && existing.size + recordBytes > maxBytes) {
      const rotated = `${file}${TELEMETRY_ROTATED_SUFFIX}`;
      rmSync(rotated, { force: true });
      renameSync(file, rotated);
    }

    appendFileSync(file, record, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      // `mode` applies only at creation time. Tighten an older permissive file
      // as well, but keep this best-effort so diagnostics never break runtime.
      try {
        chmodSync(file, 0o600);
      } catch {
        // Ignore unsupported/read-only permission changes.
      }
    }
    return true;
  } catch {
    return false;
  }
}
