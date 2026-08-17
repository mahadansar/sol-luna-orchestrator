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
