import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("watch mode partial line and UTF-8 split handling", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-test-"));
  const eventsPath = path.join(workRoot, "events.jsonl");
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
    const watchPromise = activityCommand(["--watch"], { eventsFile: eventsPath });

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
    assert.match(output, /RUNNING.*parallel/);

    // 2. Incremental UTF-8 split
    // 🦇 is 4 bytes: F0 9F A6 87
    const batChar = Buffer.from([0xf0, 0x9f, 0xa6, 0x87]);

    const event2_prefix = Buffer.from(
      `{"timestamp":"2024-01-01T00:00:01Z","type":"worker.started","batchId":"b1","taskId":"t1","effort":"high","workingDirectory":"w","model":"t1_`,
    );
    const event2_suffix = Buffer.from(`"}\n`);

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
    watchPromise = activityCommand(["--watch"], { eventsFile: eventsPath });
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
        activityLabel: "Delayed task",
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

    await waitFor(() => output.includes("COMPLETED") && output.includes("Delayed task"));
    assert.match(output, /COMPLETED.*1\/1 passed/);
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

test("watch startup silently folds historical runs into one current render", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-history-"));
  const eventsPath = path.join(workRoot, "events.jsonl");

  const events = [
    {
      timestamp: "2024-02-01T00:00:00Z",
      type: "batch.started",
      batchId: "b-old",
      mode: "sequential",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-02-01T00:00:01Z",
      type: "batch.completed",
      batchId: "b-old",
      durationSeconds: 1,
      passed: 1,
      failed: 0,
    },
    {
      timestamp: "2024-02-02T00:00:00Z",
      type: "batch.started",
      batchId: "b-latest",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-02-02T00:00:01Z",
      type: "worker.completed",
      batchId: "b-latest",
      taskId: "t-latest",
      verdict: "PASS",
      claimed: "PASS",
      durationSeconds: 1,
      threadId: null,
      model: "test-model",
      effort: "high",
      usage: null,
    },
    {
      timestamp: "2024-02-02T00:00:02Z",
      type: "batch.completed",
      batchId: "b-latest",
      durationSeconds: 2,
      passed: 1,
      failed: 0,
    },
  ];
  await fs.writeFile(
    eventsPath,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

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
    if (text.includes("Sol-Luna Activity")) renderCount++;
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  }) as any;

  let watchPromise: Promise<number> | undefined;
  try {
    const { activityCommand } = await import("./cli/activity.js");
    watchPromise = activityCommand(["--watch"], { eventsFile: eventsPath });

    const deadline = Date.now() + 5_000;
    while (renderCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.equal(renderCount, 1);
    assert.match(output, /COMPLETED.*1\/1 passed/);
    assert.match(output, /test-model/);
    assert.doesNotMatch(output, /t-latest/);
    assert.doesNotMatch(output, /b-old|b-latest/);
  } finally {
    if (watchPromise) {
      process.emit("SIGINT", "SIGINT");
      await watchPromise.catch(() => undefined);
    }
    process.stdout.write = originalStdoutWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("startup folds history once and catches an append during attachment", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-catchup-"));
  const eventsPath = path.join(workRoot, "events.jsonl");

  const oldBatch = {
    timestamp: "2024-03-01T00:00:00Z",
    type: "batch.started",
    batchId: "b-old",
    mode: "sequential",
    taskCount: 1,
    maxParallel: 1,
  };
  const currentBatch = {
    timestamp: "2024-03-02T00:00:00Z",
    type: "batch.started",
    batchId: "b-current",
    mode: "parallel",
    taskCount: 1,
    maxParallel: 1,
  };
  await fs.writeFile(
    eventsPath,
    `${JSON.stringify(oldBatch)}\n${JSON.stringify(currentBatch)}\n`,
    "utf8",
  );

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
    if (text.includes("Sol-Luna Activity")) renderCount++;
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  }) as any;

  let watchPromise: Promise<number> | undefined;
  try {
    const { activityCommand } = await import("./cli/activity.js");
    watchPromise = activityCommand(["--watch"], { eventsFile: eventsPath });

    // The command has attached its watcher synchronously before its first
    // awaited stat. This append therefore needs startup catch-up to observe it;
    // no later append is made to trigger the live path.
    await fs.appendFile(
      eventsPath,
      `${JSON.stringify({
        timestamp: "2024-03-02T00:00:01Z",
        type: "worker.started",
        batchId: "b-current",
        taskId: "t-current",
        effort: "high",
        model: "current",
        workingDirectory: "w",
      })}\n`,
      "utf8",
    );

    const deadline = Date.now() + 5_000;
    while (!output.includes("current") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(output, /RUNNING.*parallel/);
    assert.match(output, /current/);
    assert.doesNotMatch(output, /t-current/);
    assert.doesNotMatch(output, /b-old|b-current/);
    assert.ok(renderCount >= 1 && renderCount <= 2);
  } finally {
    if (watchPromise) {
      process.emit("SIGINT", "SIGINT");
      await watchPromise.catch(() => undefined);
    }
    process.stdout.write = originalStdoutWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("watch mode detects a same-size file replacement", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-replace-"));
  const eventsPath = path.join(workRoot, "events.jsonl");
  const oldEvents = [
    {
      timestamp: "2024-04-01T00:00:00Z",
      type: "batch.started",
      batchId: "old",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    },
    {
      timestamp: "2024-04-01T00:00:01Z",
      type: "worker.started",
      batchId: "old",
      taskId: "old",
      effort: "high",
      model: "old",
      workingDirectory: "w",
    },
  ];
  const newEvents = oldEvents.map((event) => ({
    ...event,
    batchId: "new",
    ...(event.type === "worker.started" ? { taskId: "new", model: "new" } : {}),
  }));
  const encode = (events: object[]): string =>
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const oldText = encode(oldEvents);
  const newText = encode(newEvents);
  assert.equal(Buffer.byteLength(oldText), Buffer.byteLength(newText));
  await fs.writeFile(eventsPath, oldText, "utf8");

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
    if (text.includes("Sol-Luna Activity")) renderCount++;
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  }) as any;

  let watchPromise: Promise<number> | undefined;
  try {
    const { activityCommand } = await import("./cli/activity.js");
    watchPromise = activityCommand(["--watch"], { eventsFile: eventsPath });
    const deadline = Date.now() + 5_000;
    while (!output.includes("old") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(output, /old/);

    await fs.writeFile(eventsPath, newText, "utf8");
    while (!output.includes("new") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(output, /new/);
    assert.ok(renderCount >= 2);
  } finally {
    if (watchPromise) {
      process.emit("SIGINT", "SIGINT");
      await watchPromise.catch(() => undefined);
    }
    process.stdout.write = originalStdoutWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
});
