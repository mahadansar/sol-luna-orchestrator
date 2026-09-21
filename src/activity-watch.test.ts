import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("watch mode refuses a directory activity target instead of streaming empty state", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-directory-"));
  const originalStderrWrite = process.stderr.write;
  let errorOutput = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errorOutput += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const { activityCommand } = await import("./cli/activity.js");
    const code = await activityCommand(["--watch", "--json"], { eventsFile: workRoot });
    assert.equal(code, 1);
    assert.match(errorOutput, /not a regular file/i);
  } finally {
    process.stderr.write = originalStderrWrite;
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test("watch mode fails if a valid activity file becomes a directory", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-invalidated-"));
  const eventsPath = path.join(workRoot, "events.jsonl");
  await fs.writeFile(eventsPath, "", "utf8");
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let output = "";
  let errorOutput = "";
  let watchPromise: Promise<number> | undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errorOutput += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    const { activityCommand } = await import("./cli/activity.js");
    watchPromise = activityCommand(["--watch", "--json"], { eventsFile: eventsPath });
    const readyDeadline = Date.now() + 5_000;
    while (!output.trim() && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(output.trim(), "watch should emit its startup snapshot");

    await fs.rm(eventsPath, { force: true });
    await fs.mkdir(eventsPath);

    const code = await Promise.race([
      watchPromise,
      new Promise<number>((_, reject) =>
        setTimeout(
          () => reject(new Error("watch did not fail after target became a directory")),
          5_000,
        ),
      ),
    ]);
    assert.equal(code, 1);
    assert.match(errorOutput, /not a regular file/i);
    watchPromise = undefined;
  } finally {
    if (watchPromise) {
      process.emit("SIGINT", "SIGINT");
      await watchPromise.catch(() => undefined);
    }
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

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

test("watch mode renders integration failure and retained-worktree diagnostics", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-integration-"));
  const eventsPath = path.join(workRoot, "events.jsonl");
  await fs.writeFile(
    eventsPath,
    `${JSON.stringify({
      timestamp: "2024-02-03T00:00:00Z",
      type: "batch.started",
      batchId: "b-integration-warning",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    })}\n`,
    "utf8",
  );

  const originalStdoutWrite = process.stdout.write;
  let output = "";
  let watchPromise: Promise<number> | undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  try {
    const { activityCommand } = await import("./cli/activity.js");
    watchPromise = activityCommand(["--watch"], { eventsFile: eventsPath });
    await waitFor(() => output.includes("RUNNING"));

    await fs.appendFile(
      eventsPath,
      [
        {
          timestamp: "2024-02-03T00:00:01Z",
          type: "integration.failed",
          batchId: "b-integration-warning",
          taskId: "private-task-id",
          attemptedFiles: 1,
          appliedFiles: 0,
        },
        {
          timestamp: "2024-02-03T00:00:02Z",
          type: "worktree.retained",
          batchId: "b-integration-warning",
          taskId: "private-task-id",
          reason: "evidence-failure",
        },
        {
          timestamp: "2024-02-03T00:00:03Z",
          type: "worker.failed",
          batchId: "b-integration-warning",
          taskId: "private-task-id",
          reason: "Could not scan D:\\private\\worktrees\\secret",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
      "utf8",
    );

    await waitFor(
      () =>
        output.includes("Integration failed for a worker") &&
        output.includes("final evidence could not be read") &&
        output.includes("Could not scan <path>"),
    );
    assert.doesNotMatch(output, /private-task-id|D:\\private\\worktrees/);
  } finally {
    if (watchPromise) {
      process.emit("SIGINT", "SIGINT");
      await watchPromise.catch(() => undefined);
    }
    process.stdout.write = originalStdoutWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
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

test("watch mode reattaches after delete/recreate when the old watcher goes silent", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-rotation-"));
  const eventsPath = path.join(workRoot, "events.jsonl");
  const encodeBatch = (batchId: string): string =>
    `${JSON.stringify({
      timestamp: batchId === "old" ? "2024-04-02T00:00:00Z" : "2024-04-03T00:00:00Z",
      type: "batch.started",
      batchId,
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    })}\n`;
  await fs.writeFile(eventsPath, encodeBatch("old"), "utf8");

  let filePresent = true;
  let successfulAttachments = 0;
  let firstListener:
    ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const fakeWatch = ((
    _file: string,
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ) => {
    if (!filePresent) {
      throw Object.assign(new Error("missing activity file"), { code: "ENOENT" });
    }
    successfulAttachments += 1;
    if (successfulAttachments === 1) firstListener = listener;
    const watcher = new EventEmitter() as EventEmitter & { close: () => void };
    watcher.close = () => undefined;
    return watcher;
  }) as any;

  const originalStdoutWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for rotated activity output:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  let watchPromise: Promise<number> | undefined;
  try {
    const { activityCommand } = await import("./cli/activity.js");
    watchPromise = activityCommand(["--watch", "--json"], {
      eventsFile: eventsPath,
      watchFile: fakeWatch,
    });
    await waitFor(() => output.includes('"batchId":"old"'));
    assert.equal(successfulAttachments, 1);

    filePresent = false;
    await fs.rm(eventsPath);
    firstListener?.("rename", path.basename(eventsPath));

    // Give the queued read enough time to observe ENOENT and move into fallback
    // polling. The original watcher sends no further callbacks after this point.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await fs.writeFile(eventsPath, encodeBatch("new"), "utf8");
    filePresent = true;

    await waitFor(() => output.includes('"batchId":"new"'));
    assert.ok(
      successfulAttachments >= 2,
      "the recreated pathname should be watched again",
    );
  } finally {
    if (watchPromise) {
      process.emit("SIGINT", "SIGINT");
      await watchPromise.catch(() => undefined);
    }
    process.stdout.write = originalStdoutWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("watch mode rebinds when rotation happens during the first watcher attachment", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-attach-race-"));
  const eventsPath = path.join(workRoot, "events.jsonl");
  const replacementPath = path.join(workRoot, "replacement.jsonl");
  const encodeBatch = (batchId: string): string =>
    `${JSON.stringify({
      timestamp: batchId === "old" ? "2024-04-04T00:00:00Z" : "2024-04-05T00:00:00Z",
      type: "batch.started",
      batchId,
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    })}\n`;
  await fs.writeFile(eventsPath, encodeBatch("old"), "utf8");

  let attachments = 0;
  let staleWatcherClosed = false;
  let replacementListener:
    ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const fakeWatch = ((
    _file: string,
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ) => {
    attachments += 1;
    const attachment = attachments;
    const watcher = new EventEmitter() as EventEmitter & { close: () => void };
    watcher.close = () => {
      if (attachment === 1) staleWatcherClosed = true;
    };

    if (attachment === 1) {
      // Reproduce the exact attach -> first-stat race: fs.watch has already
      // bound the old inode, then the pathname is atomically replaced before
      // activity gets its first read/stat. This old watcher never emits.
      writeFileSync(replacementPath, encodeBatch("new"), "utf8");
      rmSync(eventsPath);
      renameSync(replacementPath, eventsPath);
    } else {
      replacementListener = listener;
    }
    return watcher;
  }) as any;

  const originalStdoutWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for attach-race activity output:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  let watchPromise: Promise<number> | undefined;
  try {
    const { activityCommand } = await import("./cli/activity.js");
    watchPromise = activityCommand(["--watch", "--json"], {
      eventsFile: eventsPath,
      watchFile: fakeWatch,
    });

    await waitFor(() => output.includes('"batchId":"new"'));
    await waitFor(() => attachments >= 2 && replacementListener !== undefined);
    assert.equal(
      staleWatcherClosed,
      true,
      "the watcher bound to the old inode must be closed",
    );

    await fs.appendFile(
      eventsPath,
      `${JSON.stringify({
        timestamp: "2024-04-05T00:00:01Z",
        type: "task.queued",
        batchId: "new",
        taskId: "later",
        effort: "high",
      })}\n`,
      "utf8",
    );
    replacementListener?.("change", path.basename(eventsPath));
    await waitFor(() => output.includes("later"));
  } finally {
    if (watchPromise) {
      process.emit("SIGINT", "SIGINT");
      await watchPromise.catch(() => undefined);
    }
    process.stdout.write = originalStdoutWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("watch mode health poll recovers silent delete/recreate with zero watcher callbacks", async () => {
  const workRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "luna-watch-silent-rotation-"),
  );
  const eventsPath = path.join(workRoot, "events.jsonl");
  const encodeBatch = (batchId: string): string =>
    `${JSON.stringify({
      timestamp: batchId === "old" ? "2024-04-06T00:00:00Z" : "2024-04-07T00:00:00Z",
      type: "batch.started",
      batchId,
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    })}\n`;
  await fs.writeFile(eventsPath, encodeBatch("old"), "utf8");

  let attachments = 0;
  const silentWatch = (() => {
    attachments += 1;
    const watcher = new EventEmitter() as EventEmitter & { close: () => void };
    watcher.close = () => undefined;
    // Deliberately never invoke the supplied callback and never emit an error.
    return watcher;
  }) as any;

  const originalStdoutWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for silent-rotation activity output:\n${output}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  let watchPromise: Promise<number> | undefined;
  try {
    const { activityCommand } = await import("./cli/activity.js");
    watchPromise = activityCommand(["--watch", "--json"], {
      eventsFile: eventsPath,
      watchFile: silentWatch,
      watchHealthIntervalMs: 20,
    });
    await waitFor(() => output.includes('"batchId":"old"'));
    assert.equal(attachments, 1);

    await fs.rm(eventsPath);
    await fs.writeFile(eventsPath, encodeBatch("new"), "utf8");
    await waitFor(() => output.includes('"batchId":"new"'));
    await waitFor(() => attachments >= 2);

    await fs.appendFile(
      eventsPath,
      `${JSON.stringify({
        timestamp: "2024-04-07T00:00:01Z",
        type: "task.queued",
        batchId: "new",
        taskId: "silent-later",
        effort: "high",
      })}\n`,
      "utf8",
    );
    await waitFor(() => output.includes("silent-later"));
  } finally {
    if (watchPromise) {
      process.emit("SIGINT", "SIGINT");
      await watchPromise.catch(() => undefined);
    }
    process.stdout.write = originalStdoutWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("watch mode polls file growth while watcher attachment keeps failing", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-no-fs-watch-"));
  const eventsPath = path.join(workRoot, "events.jsonl");
  await fs.writeFile(
    eventsPath,
    `${JSON.stringify({
      timestamp: "2024-04-06T00:00:00Z",
      type: "batch.started",
      batchId: "poll-only",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    })}\n`,
    "utf8",
  );

  let attachAttempts = 0;
  const alwaysFailWatch = (() => {
    attachAttempts += 1;
    throw Object.assign(new Error("watch unavailable"), { code: "EPERM" });
  }) as any;

  const originalStdoutWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for polling-only activity output:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  let watchPromise: Promise<number> | undefined;
  try {
    const { activityCommand } = await import("./cli/activity.js");
    watchPromise = activityCommand(["--watch", "--json"], {
      eventsFile: eventsPath,
      watchFile: alwaysFailWatch,
    });
    await waitFor(() => output.includes('"batchId":"poll-only"'));

    await fs.appendFile(
      eventsPath,
      `${JSON.stringify({
        timestamp: "2024-04-06T00:00:01Z",
        type: "task.queued",
        batchId: "poll-only",
        taskId: "polled-later",
        effort: "high",
      })}\n`,
      "utf8",
    );

    await waitFor(() => output.includes("polled-later"));
    assert.ok(attachAttempts >= 2, "watch attachment should keep retrying while polling");
  } finally {
    if (watchPromise) {
      process.emit("SIGINT", "SIGINT");
      await watchPromise.catch(() => undefined);
    }
    process.stdout.write = originalStdoutWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("watch json mode emits newline-delimited snapshots without terminal redraws", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "luna-watch-json-"));
  const eventsPath = path.join(workRoot, "events.jsonl");
  await fs.writeFile(
    eventsPath,
    JSON.stringify({
      timestamp: "2024-05-01T00:00:00Z",
      type: "batch.started",
      batchId: "json-batch",
      mode: "parallel",
      taskCount: 1,
      maxParallel: 1,
    }) + "\n",
    "utf8",
  );

  const originalStdoutWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encoding?: unknown,
    cb?: unknown,
  ) => {
    output += chunk.toString();
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  }) as any;

  const lines = (): string[] => output.split(/\r?\n/).filter(Boolean);
  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for NDJSON activity output:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  let watchPromise: Promise<number> | undefined;
  try {
    const { activityCommand } = await import("./cli/activity.js");
    watchPromise = activityCommand(["--watch", "--json"], { eventsFile: eventsPath });
    await waitFor(() => lines().length >= 1);

    await fs.appendFile(
      eventsPath,
      [
        {
          timestamp: "2024-05-01T00:00:01Z",
          type: "task.queued",
          batchId: "json-batch",
          taskId: "json-task",
          effort: "high",
          activityLabel: "JSON watch task",
        },
        {
          timestamp: "2024-05-01T00:00:02Z",
          type: "worker.started",
          batchId: "json-batch",
          taskId: "json-task",
          effort: "high",
          model: "test-model",
          workingDirectory: "w",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
      "utf8",
    );
    await waitFor(() => lines().length >= 3);

    const snapshots = lines().map(
      (line) =>
        JSON.parse(line) as {
          batchId: string | null;
          workers: Array<{ activityLabel: string | null; state: string }>;
        },
    );
    assert.equal(snapshots[0]?.batchId, "json-batch");
    assert.equal(snapshots[1]?.workers[0]?.activityLabel, "JSON watch task");
    assert.equal(snapshots[1]?.workers[0]?.state, "queued");
    assert.equal(snapshots[2]?.workers[0]?.state, "running");
    assert.doesNotMatch(output, /Sol-Luna Activity|\x1b/);
  } finally {
    if (watchPromise) {
      process.emit("SIGINT", "SIGINT");
      await watchPromise.catch(() => undefined);
    }
    process.stdout.write = originalStdoutWrite;
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
