import { createReadStream, statSync, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { EVENTS_FILE } from "../config.js";
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
  out(`Sol         ${snapshot.supervisor.state}`);
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

  if (!EVENTS_FILE) {
    errOut(
      `${bold(red("Error:"))} SOL_LUNA_EVENTS is not set. Event logging is required for the activity command.`,
    );
    errOut("Export SOL_LUNA_EVENTS=/path/to/events.jsonl to enable logging.");
    return 1;
  }

  if (watchMode && jsonMode) {
    errOut(`${bold(red("Error:"))} --watch and --json cannot be used together.`);
    return 1;
  }

  const eventsFile = EVENTS_FILE;
  const events = await readEvents(eventsFile);
  let snapshot = reduceEvents(events);

  if (jsonMode) {
    out(JSON.stringify(snapshot, null, 2));
    return 0;
  }

  if (!watchMode) {
    renderHuman(snapshot);
    return 0;
  }

  // --- Watch mode ---
  // Render initial state, then use fs.watch to detect appends.
  renderHuman(snapshot);

  let currentSize = 0;
  try {
    const s = await stat(eventsFile);
    currentSize = s.size;
  } catch {
    // fine if file doesn't exist yet
  }

  // Buffer for incomplete trailing lines between reads. When the event writer
  // is mid-way through appending a JSONL record, the reader may see a partial
  // final line. We hold the fragment here until the next read completes it.
  let trailingFragment = "";
  let decoder = new StringDecoder("utf-8");

  return new Promise<number>((resolve) => {
    let watcher: FSWatcher;
    try {
      watcher = watch(eventsFile, () => {
        void onFileChange();
      });
    } catch {
      // file may not exist yet — poll until it does
      const interval = setInterval(() => {
        try {
          watcher = watch(eventsFile, () => {
            void onFileChange();
          });
          clearInterval(interval);
        } catch {
          // keep waiting
        }
      }, 1000);

      const cleanup = () => {
        clearInterval(interval);
        out();
        resolve(0);
      };
      process.on("SIGINT", cleanup);
      return;
    }

    async function onFileChange(): Promise<void> {
      try {
        const s = await stat(eventsFile);

        if (s.size < currentSize) {
          // File was truncated — re-read from scratch
          currentSize = 0;
          trailingFragment = "";
          decoder = new StringDecoder("utf-8");
          events.length = 0;
        }

        if (s.size <= currentSize) return;

        // Read only the new bytes appended since last read
        const chunks: Buffer[] = [];
        const stream = createReadStream(eventsFile, {
          start: currentSize,
          end: s.size - 1,
        });

        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }

        const raw = trailingFragment + decoder.write(Buffer.concat(chunks));
        currentSize = s.size;

        // Split into lines. The last element may be a partial line (no trailing
        // newline yet) — hold it in trailingFragment for the next read.
        const parts = raw.split(/\r?\n/);
        trailingFragment = parts.pop() ?? "";

        let changed = false;
        for (const line of parts) {
          const ev = parseEventLine(line);
          if (ev) {
            events.push(ev);
            changed = true;
          }
        }

        if (changed) {
          snapshot = reduceEvents(events);
          clearScreen();
          renderHuman(snapshot);
        }
      } catch {
        // File could be temporarily unavailable
      }
    }

    process.on("SIGINT", () => {
      watcher.close();
      out();
      resolve(0);
    });
  });
}
