import { createHash } from "node:crypto";
import { createReadStream, statSync, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { readConfig } from "./codex.js";
import { resolveEventsPath } from "./events-path.js";
import { TELEMETRY_FILE_MAX_BYTES } from "../telemetry-file.js";
import {
  type ActivitySnapshot,
  type TimestampedEvent,
  parseEventLine,
  reduceEvents,
  reduceRecentBatches,
  selectLatestBatchEvents,
} from "./activity-reducer.js";
import { bold, dim, errOut, green, out, red, symbols, yellow } from "./ui.js";

function secondsBetween(
  startISO: string | null,
  endISO: string | null,
  now: number,
): number | null {
  if (!startISO) return null;
  const start = new Date(startISO).getTime();
  const end = endISO ? new Date(endISO).getTime() : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function humanModel(model: string): string {
  const suffix = model.split("-").at(-1)?.toLowerCase();
  if (suffix === "luna") return "Luna";
  if (suffix === "sol") return "Sol";
  return model;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function wrapText(text: string, width: number): string[] {
  const available = Math.max(20, width);
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (line.length + word.length + 1 <= available) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function wrapParts(parts: string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const part of parts) {
    const next = line ? `${line}  |  ${part}` : part;
    if (line && visibleLength(next) > width) {
      lines.push(line);
      line = `  ${part}`;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function taskCategoryLabel(category: string | null): string | null {
  switch (category?.trim().toLowerCase()) {
    case "implementation":
      return "Implementation task";
    case "tests":
      return "Tests task";
    case "bugfix":
      return "Bugfix task";
    case "refactor":
      return "Refactor task";
    case "investigation":
      return "Investigation task";
    case "chore":
      return "Chore task";
    default:
      return null;
  }
}

/** Keep absolute and worktree paths out of terminal diagnostics. */
function redactDiagnostic(text: string): string {
  const quotedPath = /(["'`])((?:[A-Za-z]:[\\/]|\\\\|\/)[^"'`]*?)\1/g;
  const pathSuffix = /[^\s"'`<>|,;:!?)]*/;
  return text
    .replace(
      /(^|[\s([{:="'])(?:\.sol-luna[\\/](?:worktrees|continuation-leases)[\\/])[^\s"'`<>|,;:!?)]*/gi,
      "$1<worktree>",
    )
    .replace(quotedPath, "$1<path>$1")
    .replace(new RegExp(`[A-Za-z]:[\\\\/]${pathSuffix.source}`, "g"), "<path>")
    .replace(new RegExp(`\\\\${pathSuffix.source}`, "g"), "<path>")
    .replace(new RegExp(`(^|[\\s([{:="'])\\/${pathSuffix.source}`, "g"), "$1<path>");
}

/**
 * Give the human view enough provenance to distinguish a global CODEX_HOME
 * stream without exposing the absolute working directory. Parallel workers run
 * under <project>/.sol-luna/worktrees/<id>, so collapse that internal suffix
 * back to the project directory name. Other absolute directories use only their
 * basename. Ambiguous multi-directory batches stay deliberately generic.
 */
function workspaceLabel(snapshot: ActivitySnapshot): string | null {
  const candidates = new Set<string>();
  for (const worker of snapshot.workers) {
    const directory = worker.workingDirectory?.trim();
    if (!directory || !path.isAbsolute(directory)) continue;
    const segments = directory.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0) continue;
    const solLunaIndex = segments.lastIndexOf(".sol-luna");
    const label =
      solLunaIndex > 0 && segments[solLunaIndex + 1] === "worktrees"
        ? segments[solLunaIndex - 1]
        : segments.at(-1);
    if (label) candidates.add(label);
  }
  if (candidates.size === 1) return [...candidates][0]!;
  if (candidates.size > 1) return "multiple workspaces";
  return null;
}

function anonymousRunLabel(batchId: string): string {
  return createHash("sha256").update(batchId).digest("hex").slice(0, 8);
}

/** Clear screen only when stdout is a TTY. Non-TTY gets a separator instead. */
function clearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1Bc");
  } else {
    out("---");
  }
}

export function renderHumanLines(
  snapshot: ActivitySnapshot,
  now: number = Date.now(),
  width: number = process.stdout.columns ?? 100,
): string[] {
  const lines = [bold("Sol-Luna Activity"), ""];
  if (!snapshot.batchId) {
    lines.push(dim("No orchestration activity found."));
    return lines;
  }

  const batchParts: string[] = [];
  const batchState = snapshot.state.toUpperCase();
  batchParts.push(
    snapshot.state === "running"
      ? green(batchState)
      : snapshot.state === "cancelled" || snapshot.state === "rejected"
        ? yellow(batchState)
        : batchState,
  );
  if (snapshot.mode) batchParts.push(snapshot.mode);

  if (snapshot.state === "running") {
    batchParts.push(
      `${snapshot.concurrency.current} active / ${snapshot.taskCount} total`,
    );
    const elapsed = secondsBetween(snapshot.startTime, null, now);
    if (elapsed !== null) batchParts.push(`elapsed ${formatSeconds(elapsed)}`);
  } else {
    if (snapshot.passed !== null) {
      batchParts.push(`${snapshot.passed}/${snapshot.taskCount} passed`);
    }
    if (snapshot.durationSeconds !== null) {
      batchParts.push(formatSeconds(snapshot.durationSeconds));
    }
  }
  if (snapshot.concurrency.peak > 0) batchParts.push(`peak ${snapshot.concurrency.peak}`);
  lines.push(...wrapParts(batchParts, width), "");

  const workspace = workspaceLabel(snapshot);
  const source = `${workspace ? `workspace ${workspace} ${symbols.divider} ` : ""}run ${anonymousRunLabel(snapshot.batchId)}`;
  lines.push(dim(`Source: ${source}`), "");

  if (snapshot.reason) {
    const reasonLines = wrapText(`Reason: ${redactDiagnostic(snapshot.reason)}`, width);
    for (const [index, part] of reasonLines.entries()) {
      lines.push(index === 0 ? part : `        ${part}`);
    }
    lines.push("");
  }

  if (snapshot.workers.length > 0) {
    lines.push(bold("WORKERS"), "");
  }

  snapshot.workers.forEach((worker, index) => {
    const effectiveState =
      worker.state === "completed" && worker.verdict ? worker.verdict : worker.state;
    const status =
      effectiveState === "timedOut" ? "TIMED OUT" : effectiveState.toUpperCase();
    const isPassed = effectiveState === "PASS";
    const isFailed =
      effectiveState === "FAILED" ||
      effectiveState === "failed" ||
      effectiveState === "timedOut";
    const isBlocked = effectiveState === "BLOCKED";
    const marker = isPassed
      ? green("PASS")
      : isFailed
        ? red(status === "FAILED" ? "FAIL" : status)
        : isBlocked
          ? yellow("BLOCKED")
          : worker.state === "cancelled"
            ? yellow("CANCELLED")
            : String(index + 1);
    // The objective is the worker prompt and is deliberately absent from
    // telemetry. An optional activity label is a deliberately persisted,
    // bounded hint; otherwise use a truthful presentation label without
    // exposing the opaque internal id or deriving text from the objective.
    const label =
      worker.activityLabel?.trim() ||
      taskCategoryLabel(worker.category) ||
      `Delegated task ${index + 1}`;
    const prefix = `${marker}  `;
    const wrappedLabel = wrapText(label, width - prefix.length);
    lines.push(`${prefix}${wrappedLabel[0]}`);
    for (const continuation of wrappedLabel.slice(1)) {
      lines.push(`${" ".repeat(prefix.length)}${continuation}`);
    }

    const details: string[] = [];
    if (worker.model) details.push(humanModel(worker.model));
    if (worker.effort !== "unknown") details.push(worker.effort);
    if (!isPassed) {
      const renderedState =
        worker.state === "running" ||
        worker.state === "verifying" ||
        worker.state === "repairing" ||
        worker.state === "recovering"
          ? green(status)
          : worker.state === "cancelled"
            ? yellow(status)
            : isFailed || effectiveState === "BLOCKED"
              ? red(status)
              : status;
      details.push(renderedState);
    }
    const duration =
      worker.durationSeconds ?? secondsBetween(worker.startTime, worker.endTime, now);
    if (duration !== null) details.push(formatSeconds(duration));
    if (worker.attempt > 1) details.push(`attempt ${worker.attempt}`);
    if (details.length > 0) lines.push(`   ${details.join(` ${symbols.divider} `)}`);

    const verification = worker.verification;
    if (worker.state === "repairing") {
      lines.push("   Repair: running (turn 1 of 1)");
    } else if (worker.state === "recovering") {
      lines.push(
        `   Recovery: running (attempt ${worker.recovery?.attempt ?? worker.attempt}, ${worker.recovery?.classification ?? "unknown"})`,
      );
    } else if (worker.state === "verifying") {
      lines.push("   Verification: running");
    } else if (
      (worker.state === "running" || worker.state === "queued") &&
      !verification
    ) {
      lines.push("   Verification: pending");
    } else if (verification && (verification.failed > 0 || verification.refused > 0)) {
      const resultParts: string[] = [];
      if (verification.failed > 0) resultParts.push(`${verification.failed} failed`);
      if (verification.passed > 0) resultParts.push(`${verification.passed} passed`);
      if (verification.refused > 0) resultParts.push(`${verification.refused} refused`);
      lines.push(`   Verification: ${resultParts.join(` ${symbols.divider} `)}`);
    }

    const summary: string[] = [];
    if (worker.repair?.verdict) {
      summary.push(
        worker.repair.verdict === "PASS"
          ? "repair passed (1 turn)"
          : "repair exhausted (1 turn)",
      );
    }
    if (worker.recovery?.attempted && worker.recovery.verdict) {
      summary.push(
        worker.recovery.verdict === "PASS"
          ? `recovery passed (attempt ${worker.recovery.attempt})`
          : `recovery exhausted (attempt ${worker.recovery.attempt})`,
      );
    }
    const changedFiles = worker.changedFiles ?? worker.integration?.appliedFiles ?? null;
    if (changedFiles !== null && changedFiles > 0) {
      summary.push(`${plural(changedFiles, "file")} changed`);
    }
    if (
      verification &&
      verification.passed > 0 &&
      verification.failed === 0 &&
      verification.refused === 0
    ) {
      summary.push(`${plural(verification.passed, "check")} passed`);
    }
    if (worker.integration?.conflicted) summary.push(red("integration conflict"));
    if (summary.length > 0) lines.push(`   ${summary.join(` ${symbols.divider} `)}`);

    let reason = worker.failReason;
    if (!reason && worker.state === "timedOut" && worker.timeoutSeconds !== null) {
      reason = `Exceeded the ${formatSeconds(worker.timeoutSeconds)} timeout`;
    }
    if (!reason && verification && verification.failed > 0 && worker.verdict !== "PASS") {
      reason = `${plural(verification.failed, "verification check")} failed`;
    }
    if (reason) {
      const reasonLines = wrapText(`Reason: ${redactDiagnostic(reason)}`, width - 3);
      for (const part of reasonLines) lines.push(`   ${red(part)}`);
    }

    if (index < snapshot.workers.length - 1) lines.push("");
  });

  if (snapshot.conflicts.scope.length > 0) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(bold(red("SCOPE CONFLICTS")));
    for (const c of snapshot.conflicts.scope) {
      lines.push(`- ${redactDiagnostic(c)}`);
    }
  }

  if (snapshot.conflicts.integration.length > 0) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(bold(red("INTEGRATION CONFLICTS")));
    for (const c of snapshot.conflicts.integration) {
      lines.push(`- ${redactDiagnostic(c)}`);
    }
  }

  if (snapshot.integration.verification) {
    if (lines.at(-1) !== "") lines.push("");
    const verification = snapshot.integration.verification;
    const status =
      verification.completed &&
      verification.total !== null &&
      verification.total > 0 &&
      verification.passed === verification.total &&
      verification.failed === 0 &&
      verification.refused === 0
        ? green("PASS")
        : red("NEEDS SUPERVISOR");
    lines.push(bold("FINAL WORKSPACE VERIFICATION"));
    lines.push(
      `${status}  ${verification.passed} passed ${symbols.divider} ` +
        `${verification.failed} failed ${symbols.divider} ${verification.refused} refused`,
    );
  }

  if (snapshot.warnings.length > 0) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(bold(yellow("WARNINGS")));
    for (const warning of snapshot.warnings) {
      for (const [index, part] of wrapText(warning, width - 2).entries()) {
        lines.push(`${index === 0 ? "- " : "  "}${part}`);
      }
    }
  }

  return lines;
}

export function renderHuman(snapshot: ActivitySnapshot): void {
  for (const line of renderHumanLines(snapshot)) out(line);
}

const boundedReadWindow = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : TELEMETRY_FILE_MAX_BYTES;

function trimLeadingPartialRecord(buffer: Buffer, startedBeforeTail: boolean): Buffer {
  if (!startedBeforeTail || buffer.length === 0) return buffer;
  if (buffer[0] === 0x0a) return buffer.subarray(1);
  const newline = buffer.indexOf(0x0a);
  return newline >= 0 ? buffer.subarray(newline + 1) : Buffer.alloc(0);
}

/**
 * Read only a bounded tail of the JSONL file. Upgraded installations may have
 * activity files from before writer rotation existed; keeping one current-file
 * budget avoids retaining an arbitrarily large legacy file in memory.
 */
async function readEvents(
  file: string,
  maxBytes: number,
  readStream: typeof createReadStream,
): Promise<TimestampedEvent[]> {
  const events: TimestampedEvent[] = [];
  let size = 0;
  try {
    const s = statSync(file);
    if (!s.isFile()) {
      throw new Error(`Activity log is not a regular file: ${file}`);
    }
    size = s.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return events;
    throw error;
  }

  if (size === 0) return events;
  const tailStart = Math.max(0, size - maxBytes);
  const streamStart = tailStart > 0 ? tailStart - 1 : 0;
  const chunks: Buffer[] = [];
  const stream = readStream(file, { start: streamStart, end: size - 1 });
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }

  const retained = trimLeadingPartialRecord(Buffer.concat(chunks), tailStart > 0);
  for (const line of retained.toString("utf8").split(/\r?\n/)) {
    const event = parseEventLine(line);
    if (event) events.push(event);
  }
  return events;
}

export const ACTIVITY_HISTORY_MAX = 100;

export type ActivityArgs =
  | {
      ok: true;
      watch: boolean;
      json: boolean;
      history: number | null;
      help: boolean;
    }
  | { ok: false; error: string };

export function parseActivityArgs(argv: string[]): ActivityArgs {
  let watch = false;
  let json = false;
  let history: number | null = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--watch") {
      if (watch) return { ok: false, error: "Duplicate option: --watch" };
      watch = true;
      continue;
    }
    if (arg === "--json") {
      if (json) return { ok: false, error: "Duplicate option: --json" };
      json = true;
      continue;
    }
    if (arg === "--history") {
      if (history !== null) return { ok: false, error: "Duplicate option: --history" };
      const raw = argv[index + 1];
      if (raw === undefined || raw.startsWith("--")) {
        return { ok: false, error: "--history requires a positive integer" };
      }
      if (!/^[1-9]\d*$/.test(raw)) {
        return { ok: false, error: "--history requires a positive integer" };
      }
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value > ACTIVITY_HISTORY_MAX) {
        return {
          ok: false,
          error: `--history must be between 1 and ${ACTIVITY_HISTORY_MAX}`,
        };
      }
      history = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      if (help) return { ok: false, error: `Duplicate option: ${arg}` };
      help = true;
      continue;
    }
    return { ok: false, error: `Unknown option: ${arg}` };
  }

  if (help && (watch || json || history !== null)) {
    return { ok: false, error: "--help cannot be combined with other activity options" };
  }
  if (watch && history !== null) {
    return { ok: false, error: "--watch and --history cannot be used together" };
  }

  return { ok: true, watch, json, history, help };
}

const ACTIVITY_HELP = `Usage
  sol-luna-orchestrator activity [--json]
  sol-luna-orchestrator activity --history <N> [--json]
  sol-luna-orchestrator activity --watch [--json]

Options
  --watch        Continuously watch activity; with --json emits NDJSON snapshots
  --json         Machine-readable JSON output
  --history <N>  Show the most recent N batches (1-${ACTIVITY_HISTORY_MAX})
  --help, -h     Show this help`;

function renderHumanHistory(snapshots: ActivitySnapshot[]): void {
  if (snapshots.length === 0) {
    renderHuman(reduceEvents([]));
    return;
  }
  for (const [index, snapshot] of snapshots.entries()) {
    if (index > 0) out();
    out(
      dim(
        `Recent batch ${index + 1} of ${snapshots.length}${index === 0 ? " (latest)" : ""}`,
      ),
    );
    renderHuman(snapshot);
  }
}

export async function activityCommand(
  argv: string[],
  options: {
    eventsFile?: string;
    watchFile?: typeof watch;
    readStream?: typeof createReadStream;
    watchHealthIntervalMs?: number;
    readWindowBytes?: number;
    readCycleObserver?: () => void;
  } = {},
): Promise<number> {
  const parsedArgs = parseActivityArgs(argv);
  if (!parsedArgs.ok) {
    errOut(`${bold(red("Error:"))} ${parsedArgs.error}`);
    errOut("Run: sol-luna-orchestrator activity --help");
    return 1;
  }
  if (parsedArgs.help) {
    out(ACTIVITY_HELP);
    return 0;
  }
  const watchMode = parsedArgs.watch;
  const jsonMode = parsedArgs.json;

  // Resolved from this process first, then from the registered MCP server's
  // env table — which is where `init` puts it and where the running server
  // reads it from. A missing file is not an error: it simply means nothing has
  // been delegated yet.
  const resolved = options.eventsFile
    ? { path: path.resolve(options.eventsFile) }
    : resolveEventsPath(readConfig());

  if ("error" in resolved && resolved.error) {
    errOut(`${bold(red("Error:"))} ${resolved.error}.`);
    return 1;
  }
  if (!resolved.path) {
    errOut(`${bold(red("Error:"))} Activity logging is not configured.`);
    errOut("Run: sol-luna-orchestrator init");
    return 1;
  }

  const eventsFile = resolved.path;
  const watchFile = options.watchFile ?? watch;
  const readStream = options.readStream ?? createReadStream;
  const watchHealthIntervalMs = options.watchHealthIntervalMs ?? 1_000;
  const readWindowBytes = boundedReadWindow(options.readWindowBytes);
  if (!watchMode) {
    let events: TimestampedEvent[];
    try {
      events = await readEvents(eventsFile, readWindowBytes, readStream);
    } catch (error) {
      errOut(
        `${bold(red("Error:"))} Cannot read activity log: ${(error as Error).message}`,
      );
      return 1;
    }
    if (parsedArgs.history !== null) {
      const snapshots = reduceRecentBatches(events, parsedArgs.history);
      if (jsonMode) out(JSON.stringify(snapshots, null, 2));
      else renderHumanHistory(snapshots);
      return 0;
    }
    const snapshot = reduceEvents(events);
    if (jsonMode) {
      out(JSON.stringify(snapshot, null, 2));
    } else {
      renderHuman(snapshot);
    }
    return 0;
  }

  const events: TimestampedEvent[] = [];
  let snapshot = reduceEvents(events);

  // --- Watch mode ---------------------------------------------------------
  // Attach before the historical read. Notifications received while the
  // initial snapshot is reconstructed are held silent and replayed as a
  // normal incremental read after startup, so no append can fall into a gap.
  return new Promise<number>((resolve) => {
    let watcher: FSWatcher | undefined;
    let missingFilePoll: NodeJS.Timeout | undefined;
    let watchHealthPoll: NodeJS.Timeout | undefined;
    let elapsedTimer: NodeJS.Timeout | undefined;
    let currentSize = 0;
    let retainedEventBytes = 0;
    const eventSizes = new WeakMap<object, number>();
    let currentFile: { dev: number; ino: number; mtimeMs: number } | null = null;
    let trailingFragment = "";
    let decoder = new StringDecoder("utf-8");
    let needsInitialTailRead = true;
    let ready = false;
    let pendingChange = false;
    let changeReadRunning = false;
    let changeReadPending = false;
    let closed = false;

    const resetProjectionState = (): void => {
      trailingFragment = "";
      decoder = new StringDecoder("utf-8");
      events.length = 0;
      retainedEventBytes = 0;
    };

    const resetReadState = (): void => {
      currentSize = 0;
      currentFile = null;
      resetProjectionState();
      needsInitialTailRead = true;
    };

    const fileInfo = async (): Promise<{
      size: number;
      dev: number;
      ino: number;
      mtimeMs: number;
    } | null> => {
      try {
        const current = await stat(eventsFile);
        if (!current.isFile()) {
          throw new Error(`Activity log is not a regular file: ${eventsFile}`);
        }
        return {
          size: current.size,
          dev: current.dev,
          ino: current.ino,
          mtimeMs: current.mtimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };

    const fileInfoSync = (): {
      size: number;
      dev: number;
      ino: number;
      mtimeMs: number;
    } | null => {
      try {
        const current = statSync(eventsFile);
        if (!current.isFile()) {
          throw new Error(`Activity log is not a regular file: ${eventsFile}`);
        }
        return {
          size: current.size,
          dev: current.dev,
          ino: current.ino,
          mtimeMs: current.mtimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };

    const sameFileIdentity = (
      left: { dev: number; ino: number },
      right: { dev: number; ino: number },
    ): boolean => left.dev === right.dev && left.ino === right.ino;

    /** Consume complete records from the current file tail. */
    const readAvailable = async (
      captureIncrementalSnapshots = false,
    ): Promise<{
      changed: boolean;
      snapshots: ActivitySnapshot[];
      watchTarget: "same" | "missing" | "replaced";
    }> => {
      options.readCycleObserver?.();
      const info = await fileInfo();
      if (info === null) {
        // Once a pathname disappears, any later file at that path is a new
        // stream even if the platform happens to recycle the same inode/mtime.
        // Reset the byte cursor now so reattachment reconstructs from a fresh
        // bounded tail rather than carrying state across file identities.
        resetReadState();
        return { changed: false, snapshots: [], watchTarget: "missing" };
      }

      const replaced =
        currentFile !== null &&
        (currentFile.dev !== info.dev || currentFile.ino !== info.ino);
      const rewritten =
        currentFile !== null &&
        info.size === currentSize &&
        currentFile.mtimeMs !== info.mtimeMs;

      if (info.size < currentSize || replaced || rewritten) resetReadState();
      if (info.size <= currentSize) {
        currentFile = info;
        return {
          changed: false,
          snapshots: [],
          watchTarget: replaced || rewritten ? "replaced" : "same",
        };
      }

      const unreadBytes = info.size - currentSize;
      if (!needsInitialTailRead && unreadBytes > readWindowBytes) {
        throw new Error(
          `Activity log advanced by ${unreadBytes} bytes, beyond the bounded ${readWindowBytes}-byte watch catch-up window. Restart activity to rebuild from a bounded tail.`,
        );
      }

      let chunks: Buffer[];
      let streamStart = currentSize;
      let startedBeforeTail = false;
      if (needsInitialTailRead && currentSize === 0 && info.size > readWindowBytes) {
        const tailStart = info.size - readWindowBytes;
        streamStart = tailStart - 1;
        startedBeforeTail = true;
      }
      try {
        chunks = [];
        const stream = readStream(eventsFile, {
          start: streamStart,
          end: info.size - 1,
        });
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
      } catch (readError) {
        // The file may have been deleted or atomically rotated between the stat
        // check and the stream read. Recover the same way as an explicit ENOENT
        // stat result: reset byte state and let the watcher reattach later.
        if (
          readError instanceof Error &&
          "code" in readError &&
          (readError as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          resetReadState();
          return { changed: false, snapshots: [], watchTarget: "missing" as const };
        }
        throw readError;
      }

      const retained = trimLeadingPartialRecord(Buffer.concat(chunks), startedBeforeTail);
      const raw = trailingFragment + decoder.write(retained);
      currentSize = info.size;
      currentFile = info;
      needsInitialTailRead = false;

      let changed = false;
      const snapshots: ActivitySnapshot[] = [];
      const acceptLine = (line: string, captureSnapshot: boolean): void => {
        const event = parseEventLine(line);
        if (event) {
          const eventBytes = Buffer.byteLength(line, "utf8") + 1;
          const currentBatchId = events.find(
            (candidate) => candidate.type === "batch.started",
          )?.batchId;
          if (
            event.type !== "batch.started" &&
            currentBatchId !== undefined &&
            event.batchId !== currentBatchId
          ) {
            return;
          }
          events.push(event);
          eventSizes.set(event, eventBytes);
          if (event.type === "batch.started") {
            const compacted = selectLatestBatchEvents(events);
            const eventRetained = compacted.includes(event);
            events.splice(0, events.length, ...compacted);
            retainedEventBytes = events.reduce(
              (total, candidate) => total + (eventSizes.get(candidate) ?? 0),
              0,
            );
            changed ||= eventRetained;
            if (eventRetained && captureSnapshot) {
              snapshots.push(reduceEvents(events));
            }
          } else {
            retainedEventBytes += eventBytes;
            changed = true;
            if (captureSnapshot) snapshots.push(reduceEvents(events));
          }
          if (retainedEventBytes > readWindowBytes) {
            throw new Error(
              `Retained activity history exceeded the bounded ${readWindowBytes}-byte watch window. Restart activity to rebuild from a bounded tail.`,
            );
          }
        }
      };

      // The last element may be a partial line. Keep it, including a split
      // UTF-8 sequence retained by StringDecoder, until the next append.
      const parts = raw.split(/\r?\n/);
      trailingFragment = parts.pop() ?? "";
      if (Buffer.byteLength(trailingFragment, "utf8") > readWindowBytes) {
        throw new Error(
          `Partial activity record exceeded the bounded ${readWindowBytes}-byte watch window.`,
        );
      }
      for (const line of parts) {
        acceptLine(line, captureIncrementalSnapshots);
      }
      return {
        changed,
        snapshots,
        // A same-size rewrite can be delete/recreate with a recycled inode.
        // Rebind even when dev/ino happen to match the previous file.
        watchTarget: replaced || rewritten ? "replaced" : "same",
      };
    };

    const updateElapsedTimer = (): void => {
      if (jsonMode) {
        if (elapsedTimer) clearInterval(elapsedTimer);
        elapsedTimer = undefined;
        return;
      }
      const active =
        snapshot.state === "running" &&
        snapshot.workers.some(
          (worker) =>
            worker.state === "running" ||
            worker.state === "verifying" ||
            worker.state === "repairing",
        );
      if (active && !elapsedTimer) {
        elapsedTimer = setInterval(() => {
          if (closed) return;
          const stillActive =
            snapshot.state === "running" &&
            snapshot.workers.some(
              (worker) =>
                worker.state === "running" ||
                worker.state === "verifying" ||
                worker.state === "repairing",
            );
          if (stillActive) renderCurrent();
        }, 1000);
      } else if (!active && elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
      }
    };

    const renderCurrent = (): void => {
      snapshot = reduceEvents(events);
      if (jsonMode) {
        out(JSON.stringify(snapshot));
      } else {
        clearScreen();
        renderHuman(snapshot);
      }
      updateElapsedTimer();
    };

    const onFileChange = async (render = true): Promise<void> => {
      const { changed, snapshots, watchTarget } = await readAvailable(render && jsonMode);
      if (watchTarget !== "same" && watcher) {
        const staleWatcher = watcher;
        watcher = undefined;
        staleWatcher.close();

        // File watchers may stay bound to the old inode after delete/recreate
        // or atomic log rotation and then go permanently silent. Reattach to
        // the pathname we just inspected; if it is still absent, poll until a
        // new file can be watched. Schedule one catch-up after attachment so an
        // append racing the handoff cannot be missed.
        if (attachWatcher()) scheduleFileChange();
        else startMissingFilePoll();
      }
      if (closed || !changed || !render) return;
      if (jsonMode) {
        for (const next of snapshots) {
          snapshot = next;
          out(JSON.stringify(snapshot));
        }
      } else {
        renderCurrent();
      }
    };

    const scheduleFileChange = (): void => {
      if (closed) return;
      if (!ready) {
        pendingChange = true;
        return;
      }
      changeReadPending = true;
      if (changeReadRunning) return;
      changeReadRunning = true;
      void (async () => {
        try {
          while (!closed && changeReadPending) {
            changeReadPending = false;
            await onFileChange();
          }
        } catch (error) {
          finish(1, error);
        } finally {
          changeReadRunning = false;
        }
      })();
    };

    const attachWatcher = (): boolean => {
      if (watcher) return true;
      let nextWatcher: FSWatcher | undefined;
      try {
        // Bind the watcher to a pathname identity we can prove. Without the two
        // stats below, an atomic rotation inside `watch(...)` can leave us
        // watching the old inode while the first history read silently consumes
        // the replacement. A silent old watcher would then freeze the live view.
        const beforeWatch = fileInfoSync();
        if (beforeWatch === null) return false;
        // This is deliberately done before the initial read. The immediate
        // catch-up below handles records written before or during attachment.
        nextWatcher = watchFile(eventsFile, () => scheduleFileChange());
        const attachedWatcher = nextWatcher;
        // On Windows, a watcher can report EPERM asynchronously (including
        // while its directory is being cleaned up). Never let that become an
        // uncaught process error in a long-running CLI command.
        attachedWatcher.on("error", () => {
          if (watcher !== attachedWatcher) {
            attachedWatcher.close();
            return;
          }
          watcher = undefined;
          attachedWatcher.close();
          startMissingFilePoll();
        });
        const afterWatch = fileInfoSync();
        if (afterWatch === null || !sameFileIdentity(beforeWatch, afterWatch)) {
          attachedWatcher.close();
          return false;
        }
        watcher = attachedWatcher;
        // Seed the initial identity before the first read. If rotation happens
        // after this check but before that read, readAvailable() now recognizes
        // the replacement and immediately drops/re-attaches this stale watcher.
        if (currentFile === null) currentFile = afterWatch;
        return true;
      } catch {
        nextWatcher?.close();
        return false;
      }
    };

    const startMissingFilePoll = (): void => {
      if (missingFilePoll || closed) return;
      missingFilePoll = setInterval(() => {
        if (closed || watcher) return;
        if (attachWatcher()) {
          if (missingFilePoll) clearInterval(missingFilePoll);
          missingFilePoll = undefined;
          scheduleFileChange();
          return;
        }

        // A missing file and an unavailable platform watcher both land here.
        // Poll the actual file contents while no watcher can be attached: ENOENT
        // remains a harmless empty state, a readable file stays live, and a
        // directory/permission failure terminates truthfully instead of leaving
        // a stale snapshot on screen forever.
        if (!ready) return;
        scheduleFileChange();
      }, 100);
    };

    const startWatchHealthPoll = (): void => {
      if (watchHealthPoll || closed) return;
      watchHealthPoll = setInterval(() => {
        // fs.watch is advisory: on some filesystems a watcher can remain bound
        // to an unlinked inode and never emit rename/error. Independently re-stat
        // and tail the pathname while a watcher is nominally healthy so silent
        // rotation, delete/recreate, and silent appends cannot freeze the view.
        if (closed || !ready || !watcher) return;
        scheduleFileChange();
      }, watchHealthIntervalMs);
    };

    const finish = (code: number, error?: unknown): void => {
      if (closed) return;
      closed = true;
      if (missingFilePoll) clearInterval(missingFilePoll);
      if (watchHealthPoll) clearInterval(watchHealthPoll);
      if (elapsedTimer) clearInterval(elapsedTimer);
      watcher?.close();
      process.off("SIGINT", onSigint);
      if (error) {
        errOut(
          `${bold(red("Error:"))} Cannot watch activity log: ${(error as Error).message}`,
        );
      } else if (!jsonMode) {
        out();
      }
      resolve(code);
    };

    const onSigint = (): void => {
      finish(0);
    };

    process.on("SIGINT", onSigint);

    const initialize = async (): Promise<void> => {
      const attached = attachWatcher();
      if (!attached) {
        // A configured file may not exist until the first event is emitted.
        // Polling is only for that missing-file case; once it exists, attach
        // first and then schedule a bounded catch-up from currentSize.
        startMissingFilePoll();
      }

      // Fold history silently. Repeat while notifications or file growth show
      // that an append raced this catch-up. This avoids needing a later append
      // to make a record written during startup visible.
      for (;;) {
        pendingChange = false;
        await onFileChange(false);
        if (closed) return;
        const info = await fileInfo();
        if (!pendingChange && (info === null || info.size <= currentSize)) break;
      }

      if (closed) return;
      // Exactly one startup render, containing the reconstructed latest state.
      snapshot = reduceEvents(events);
      if (jsonMode) out(JSON.stringify(snapshot));
      else renderHuman(snapshot);
      updateElapsedTimer();
      ready = true;
      startWatchHealthPoll();
      if (pendingChange) {
        pendingChange = false;
        scheduleFileChange();
      }
    };

    void initialize().catch((error) => finish(1, error));
  });
}
