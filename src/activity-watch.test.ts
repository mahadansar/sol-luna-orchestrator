import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("watch mode partial line and UTF-8 split handling", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-test-"));
  const eventsPath = path.join(workRoot, "events.jsonl");
  process.env.SOL_LUNA_EVENTS = eventsPath;
  await fs.writeFile(eventsPath, "", "utf-8");

  const originalStdoutWrite = process.stdout.write;
  let output = "";
  let renderCount = 0;

  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: unknown,
    cb?: unknown,
  ) => {
    const text = chunk.toString();
    output += text;
    if (text.includes("Sol-Luna Activity")) {
      renderCount++;
    }
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  }) as any;

  try {
    const { activityCommand } = await import("./cli/activity.js");
    const watchPromise = activityCommand(["--watch"]);

    // wait for initial render
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(renderCount, 1, "Initial render should occur");

    // 1. Partial line bug
    const event1_part1 = `{"timestamp":"2024-01-01T00:00:00Z","type":"batch`;
    const event1_part2 = `.started","batchId":"b1","mode":"parallel","taskCount":1,"maxParallel":1}\n`;

    await fs.appendFile(eventsPath, event1_part1, "utf-8");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(renderCount, 1, "Should not render on partial line");

    await fs.appendFile(eventsPath, event1_part2, "utf-8");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(renderCount, 2, "Should render after complete line");
    assert.match(output, /Batch\s+b1/);

    // 2. Incremental UTF-8 split
    // 🦇 is 4 bytes: F0 9F A6 87
    const batChar = Buffer.from([0xf0, 0x9f, 0xa6, 0x87]);

    const event2_prefix = Buffer.from(
      `{"timestamp":"2024-01-01T00:00:01Z","type":"worker.started","batchId":"b1","taskId":"t1_`,
    );
    const event2_suffix = Buffer.from(`","effort":"high","workingDirectory":"w"}\n`);

    // Write prefix + first two bytes of bat
    const chunk1 = Buffer.concat([event2_prefix, batChar.subarray(0, 2)]);
    await fs.appendFile(eventsPath, chunk1);
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(renderCount, 2, "Should not render on partial multi-byte char and line");

    // Write last two bytes of bat + suffix
    const chunk2 = Buffer.concat([batChar.subarray(2), event2_suffix]);
    await fs.appendFile(eventsPath, chunk2);
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(renderCount, 3, "Should render after completing UTF-8 char and line");
    assert.match(output, /t1_🦇/);

    // End watch gracefully
    process.emit("SIGINT", "SIGINT");
    await watchPromise;
  } finally {
    process.stdout.write = originalStdoutWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("watch mode catches events written before a missing file is attached", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-missing-"));
  const eventsPath = path.join(workRoot, "events.jsonl");
  process.env.SOL_LUNA_EVENTS = eventsPath;

  const originalStdoutWrite = process.stdout.write;
  let output = "";
  let renderCount = 0;
  let watchPromise: Promise<number> | undefined;

  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: unknown,
    cb?: unknown,
  ) => {
    const text = chunk.toString();
    output += text;
    if (text.includes("Sol-Luna Activity")) {
      renderCount++;
    }
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  }) as any;

  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for activity output:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  try {
    const { activityCommand } = await import("./cli/activity.js");
    watchPromise = activityCommand(["--watch"]);
    await waitFor(() => renderCount === 1);

    // The polling branch attaches after the file exists. All of these records
    // are deliberately written before that attachment, so the watcher must
    // perform an initial catch-up read rather than wait for another append.
    const events = [
      {
        timestamp: "2024-02-01T00:00:00Z",
        type: "batch.started",
        batchId: "b-delayed",
        mode: "parallel",
        taskCount: 1,
        maxParallel: 1,
      },
      {
        timestamp: "2024-02-01T00:00:01Z",
        type: "task.queued",
        batchId: "b-delayed",
        taskId: "t-delayed",
        effort: "high",
      },
      {
        timestamp: "2024-02-01T00:00:02Z",
        type: "worker.started",
        batchId: "b-delayed",
        taskId: "t-delayed",
        effort: "high",
        workingDirectory: "w",
      },
      {
        timestamp: "2024-02-01T00:00:03Z",
        type: "worker.completed",
        batchId: "b-delayed",
        taskId: "t-delayed",
        verdict: "PASS",
        claimed: "PASS",
        durationSeconds: 1,
        threadId: "thread-delayed",
        model: "test-model",
        effort: "high",
        usage: null,
      },
      {
        timestamp: "2024-02-01T00:00:04Z",
        type: "batch.completed",
        batchId: "b-delayed",
        durationSeconds: 4,
        passed: 1,
        failed: 0,
      },
    ];
    await fs.writeFile(
      eventsPath,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    await waitFor(
      () => output.includes("Batch       b-delayed") && output.includes("t-delayed"),
    );
    assert.match(output, /State\s+completed/);
    assert.ok(renderCount >= 2, "the delayed initial read should render activity");
  } finally {
    if (watchPromise) {
      process.emit("SIGINT", "SIGINT");
      await watchPromise.catch(() => undefined);
    }
    process.stdout.write = originalStdoutWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
});
