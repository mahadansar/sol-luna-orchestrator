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
import { bold, dim, errOut, green, out, red, yellow } from "./ui.js";

/** Format elapsed time from ISO timestamps. Uses wall clock for active workers. */
function formatDuration(startISO: string | null, endISO: string | null): string {
  if (!startISO) return "-";
  const start = new Date(startISO).getTime();
  const end = endISO ? new Date(endISO).getTime() : Date.now();
  const diff = Math.max(0, Math.floor((end - start) / 1000));
  return `${diff}s`;
}

/** Clear screen only when stdout is a TTY. Non-TTY gets a separator instead. */
function clearScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1Bc");
  } else {
    out("---");
  }
}

export function renderHuman(snapshot: ActivitySnapshot): void {
  out(bold("Sol-Luna Activity"));
  out();

  if (!snapshot.batchId) {
    out(dim("No orchestration activity found."));
    return;
  }

  out(`Batch       ${snapshot.batchId}`);
  out(`Mode        ${snapshot.mode ?? "-"}`);
  out(
    `State       ${snapshot.state === "running" ? green(snapshot.state) : snapshot.state}`,
  );

  const activeWorkers = snapshot.workers.filter(
    (w) => w.state === "running" || w.state === "verifying",
  ).length;
  out(`Workers     ${activeWorkers} active / ${snapshot.taskCount} total`);
  out(
    `Concurrency ${snapshot.concurrency.current} current / ${snapshot.concurrency.peak} peak`,
  );
  out();

  out(bold("SUPERVISOR"));
  out(`Parent      ${snapshot.supervisor.state}`);
  out(`Usage       unavailable to MCP`);
  out();

  out(bold("WORKERS"));
  if (snapshot.workers.length === 0) {
    out(dim("  none"));
  } else {
    for (const w of snapshot.workers) {
      let wState = w.state.padEnd(11);
      if (w.state === "running" || w.state === "verifying") {
        wState = green(wState);
      } else if (w.state === "failed" || w.state === "timedOut") {
        wState = red(wState);
      } else if (w.state === "cancelled") {
        wState = yellow(wState);
      }

      const dur = formatDuration(w.startTime, w.endTime).padEnd(5);

      let details = "";
      if (w.verdict) {
        details += ` verdict:${w.verdict === "PASS" ? green(w.verdict) : red(w.verdict)}`;
      }
      if (w.failReason) {
        details += ` ${red(w.failReason)}`;
      }
      if (w.integration?.conflicted) {
        details += ` ${red("conflict")}`;
      } else if (w.integration?.appliedFiles) {
        details += ` applied:${w.integration.appliedFiles}`;
      }

      out(`${w.taskId.padEnd(16)} ${w.effort.padEnd(7)} ${wState} ${dur}${details}`);
    }
  }

  if (snapshot.conflicts.scope.length > 0) {
    out();
    out(bold(red("SCOPE CONFLICTS")));
    for (const c of snapshot.conflicts.scope) {
      out(`- ${c}`);
    }
  }

  if (snapshot.conflicts.integration.length > 0) {
    out();
    out(bold(red("INTEGRATION CONFLICTS")));
    for (const c of snapshot.conflicts.integration) {
      out(`- ${c}`);
    }
  }
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

export async function activityCommand(argv: string[]): Promise<number> {
  const watchMode = argv.includes("--watch");
  const jsonMode = argv.includes("--json");

  // Resolved from this process first, then from the registered MCP server's
  // env table — which is where `init` puts it and where the running server
  // reads it from. A missing file is not an error: it simply means nothing has
  // been delegated yet.
  const resolved = resolveEventsPath(readConfig());

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
    let trailingFragment = "";
    let decoder = new StringDecoder("utf-8");
    let ready = false;
    let pendingChange = false;
    let closed = false;

    const resetReadState = (): void => {
      currentSize = 0;
      trailingFragment = "";
      decoder = new StringDecoder("utf-8");
      events.length = 0;
    };

    const fileSize = async (): Promise<number | null> => {
      try {
        const current = await stat(eventsFile);
        return current.isFile() ? current.size : null;
      } catch {
        return null;
      }
    };

    /** Consume complete records from the current file tail. */
    const readAvailable = async (): Promise<boolean> => {
      const size = await fileSize();
      if (size === null) return false;

      if (size < currentSize) resetReadState();
      if (size <= currentSize) return false;

      const chunks: Buffer[] = [];
      const stream = createReadStream(eventsFile, {
        start: currentSize,
        end: size - 1,
      });
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }

      const raw = trailingFragment + decoder.write(Buffer.concat(chunks));
      currentSize = size;

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
        const size = await fileSize();
        if (!pendingChange && (size === null || size <= currentSize)) break;
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
