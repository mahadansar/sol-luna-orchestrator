import { createReadStream, statSync, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { readConfig } from "./codex.js";
import { resolveEventsPath } from "./events-path.js";
import {
  type ActivitySnapshot,
  type TimestampedEvent,
  parseEventLine,
  reduceEvents,
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

  if (snapshot.reason) {
    for (const [index, part] of wrapText(`Reason: ${snapshot.reason}`, width).entries()) {
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
    const label = worker.activityLabel?.trim() || `Delegated task ${index + 1}`;
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
        worker.state === "running" || worker.state === "verifying"
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
    if (details.length > 0) lines.push(`   ${details.join(` ${symbols.divider} `)}`);

    const verification = worker.verification;
    if (worker.state === "verifying") {
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
      const reasonLines = wrapText(`Reason: ${reason}`, width - 3);
      for (const part of reasonLines) lines.push(`   ${red(part)}`);
    }

    if (index < snapshot.workers.length - 1) lines.push("");
  });

  if (snapshot.conflicts.scope.length > 0) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(bold(red("SCOPE CONFLICTS")));
    for (const c of snapshot.conflicts.scope) {
      lines.push(`- ${c}`);
    }
  }

  if (snapshot.conflicts.integration.length > 0) {
    if (lines.at(-1) !== "") lines.push("");
    lines.push(bold(red("INTEGRATION CONFLICTS")));
    for (const c of snapshot.conflicts.integration) {
      lines.push(`- ${c}`);
    }
  }

  return lines;
}

export function renderHuman(snapshot: ActivitySnapshot): void {
  for (const line of renderHumanLines(snapshot)) out(line);
}

/**
 * Read all events from a JSONL file. Each line is parsed independently;
 * malformed lines are silently dropped.
 */
async function readEvents(file: string): Promise<TimestampedEvent[]> {
  const events: TimestampedEvent[] = [];
  try {
    const s = statSync(file);
    if (!s.isFile()) return events;
  } catch {
    return events; // file might not exist yet
  }

  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(file, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const ev = parseEventLine(line);
      if (ev) events.push(ev);
    });

    rl.on("close", () => resolve(events));
    rl.on("error", (err) => reject(err));
  });
}

export async function activityCommand(
  argv: string[],
  options: { eventsFile?: string } = {},
): Promise<number> {
  const watchMode = argv.includes("--watch");
  const jsonMode = argv.includes("--json");

  // Resolved from this process first, then from the registered MCP server's
  // env table — which is where `init` puts it and where the running server
  // reads it from. A missing file is not an error: it simply means nothing has
  // been delegated yet.
  const resolved = options.eventsFile
    ? { path: options.eventsFile }
    : resolveEventsPath(readConfig());

  if (!resolved.path) {
    errOut(`${bold(red("Error:"))} Activity logging is not configured.`);
    errOut("Run: sol-luna-orchestrator init");
    return 1;
  }

  if (watchMode && jsonMode) {
    errOut(`${bold(red("Error:"))} --watch and --json cannot be used together.`);
    return 1;
  }

  const eventsFile = resolved.path;
  if (!watchMode) {
    const events = await readEvents(eventsFile);
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
    let elapsedTimer: NodeJS.Timeout | undefined;
    let changeQueue = Promise.resolve();
    let currentSize = 0;
    let currentFile: { dev: number; ino: number; mtimeMs: number } | null = null;
    let trailingFragment = "";
    let decoder = new StringDecoder("utf-8");
    let ready = false;
    let pendingChange = false;
    let closed = false;

    const resetReadState = (): void => {
      currentSize = 0;
      currentFile = null;
      trailingFragment = "";
      decoder = new StringDecoder("utf-8");
      events.length = 0;
    };

    const fileInfo = async (): Promise<{
      size: number;
      dev: number;
      ino: number;
      mtimeMs: number;
    } | null> => {
      try {
        const current = await stat(eventsFile);
        return current.isFile()
          ? {
              size: current.size,
              dev: current.dev,
              ino: current.ino,
              mtimeMs: current.mtimeMs,
            }
          : null;
      } catch {
        return null;
      }
    };

    /** Consume complete records from the current file tail. */
    const readAvailable = async (): Promise<boolean> => {
      const info = await fileInfo();
      if (info === null) return false;

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
        return false;
      }

      const chunks: Buffer[] = [];
      const stream = createReadStream(eventsFile, {
        start: currentSize,
        end: info.size - 1,
      });
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }

      const raw = trailingFragment + decoder.write(Buffer.concat(chunks));
      currentSize = info.size;
      currentFile = info;

      // The last element may be a partial line. Keep it, including a split
      // UTF-8 sequence retained by StringDecoder, until the next append.
      const parts = raw.split(/\r?\n/);
      trailingFragment = parts.pop() ?? "";

      let changed = false;
      for (const line of parts) {
        const event = parseEventLine(line);
        if (event) {
          events.push(event);
          changed = true;
        }
      }
      return changed;
    };

    const updateElapsedTimer = (): void => {
      const active =
        snapshot.state === "running" &&
        snapshot.workers.some(
          (worker) => worker.state === "running" || worker.state === "verifying",
        );
      if (active && !elapsedTimer) {
        elapsedTimer = setInterval(() => {
          if (closed) return;
          const stillActive =
            snapshot.state === "running" &&
            snapshot.workers.some(
              (worker) => worker.state === "running" || worker.state === "verifying",
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
      clearScreen();
      renderHuman(snapshot);
      updateElapsedTimer();
    };

    const onFileChange = async (render = true): Promise<void> => {
      try {
        const changed = await readAvailable();
        if (!closed && changed && render) renderCurrent();
      } catch {
        // The file can be temporarily unavailable while it is replaced.
      }
    };

    const scheduleFileChange = (): void => {
      if (closed) return;
      if (!ready) {
        pendingChange = true;
        return;
      }
      changeQueue = changeQueue.then(
        () => onFileChange(),
        () => onFileChange(),
      );
    };

    const attachWatcher = (): boolean => {
      if (watcher) return true;
      try {
        // This is deliberately done before the initial read. The immediate
        // catch-up below handles records written before or during attachment.
        const nextWatcher = watch(eventsFile, () => scheduleFileChange());
        // On Windows, a watcher can report EPERM asynchronously (including
        // while its directory is being cleaned up). Never let that become an
        // uncaught process error in a long-running CLI command.
        nextWatcher.on("error", () => {
          if (watcher === nextWatcher) watcher = undefined;
          nextWatcher.close();
          startMissingFilePoll();
        });
        watcher = nextWatcher;
        return true;
      } catch {
        return false;
      }
    };

    const startMissingFilePoll = (): void => {
      if (missingFilePoll || closed) return;
      missingFilePoll = setInterval(() => {
        if (closed || watcher) return;
        if (!attachWatcher()) return;
        if (missingFilePoll) clearInterval(missingFilePoll);
        missingFilePoll = undefined;
        scheduleFileChange();
      }, 100);
    };

    const onSigint = (): void => {
      if (closed) return;
      closed = true;
      if (missingFilePoll) clearInterval(missingFilePoll);
      if (elapsedTimer) clearInterval(elapsedTimer);
      watcher?.close();
      process.off("SIGINT", onSigint);
      out();
      resolve(0);
    };

    process.on("SIGINT", onSigint);

    const initialize = async (): Promise<void> => {
      const attached = attachWatcher();
      if (!attached) {
        // A configured file may not exist until the first event is emitted.
        // Polling is only for that missing-file case; once it exists, attach
        // first and then schedule a full catch-up from currentSize.
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
      renderHuman(snapshot);
      updateElapsedTimer();
      ready = true;
      if (pendingChange) {
        pendingChange = false;
        scheduleFileChange();
      }
    };

    void initialize().catch(() => {
      if (closed) return;
      // Keep watch mode useful even if a transient startup read failed.
      snapshot = reduceEvents(events);
      renderHuman(snapshot);
      ready = true;
      scheduleFileChange();
    });
  });
}
