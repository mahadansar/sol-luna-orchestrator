import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { appendBoundedPrivateFile, TELEMETRY_ROTATED_SUFFIX } from "./telemetry-file.js";

const TELEMETRY_CHILD_FLAG = "--sol-luna-telemetry-child";
const childFlagIndex = process.argv.indexOf(TELEMETRY_CHILD_FLAG);
if (childFlagIndex >= 0) {
  const [barrier, file, ready, maxRaw, recordRaw] = process.argv.slice(
    childFlagIndex + 1,
  );
  if (!barrier || !file || !ready || !maxRaw || !recordRaw) process.exit(2);
  const maxBytes = Number(maxRaw);
  const recordBytes = Number(recordRaw);
  fs.writeFileSync(ready, "ready");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(barrier)) Atomics.wait(wait, 0, 0, 5);
  appendBoundedPrivateFile(file, "y".repeat(recordBytes), { maxBytes });
  process.exit(0);
}

const withTempDir = async (fn: (directory: string) => Promise<void> | void) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sol-luna-telemetry-"));
  try {
    await fn(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

test("bounded telemetry rotates before exceeding its byte budget", async () => {
  await withTempDir((directory) => {
    const file = path.join(directory, "events.jsonl");
    assert.equal(appendBoundedPrivateFile(file, "12345\n", { maxBytes: 10 }), true);
    assert.equal(appendBoundedPrivateFile(file, "67890\n", { maxBytes: 10 }), true);
    assert.equal(fs.readFileSync(file, "utf8"), "67890\n");
    assert.equal(
      fs.readFileSync(`${file}${TELEMETRY_ROTATED_SUFFIX}`, "utf8"),
      "12345\n",
    );
  });
});

test("bounded telemetry refuses a single record larger than the entire budget", async () => {
  await withTempDir((directory) => {
    const file = path.join(directory, "diagnostic.log");
    assert.equal(appendBoundedPrivateFile(file, "oversized", { maxBytes: 4 }), false);
    assert.equal(fs.existsSync(file), false);
  });
});

test("oversized legacy telemetry is never retained as an oversized predecessor", async () => {
  await withTempDir((directory) => {
    const file = path.join(directory, "events.jsonl");
    fs.writeFileSync(file, "x".repeat(100), "utf8");

    assert.equal(appendBoundedPrivateFile(file, "ok\n", { maxBytes: 10 }), true);
    assert.equal(fs.readFileSync(file, "utf8"), "ok\n");
    const predecessor = `${file}${TELEMETRY_ROTATED_SUFFIX}`;
    assert.equal(fs.existsSync(predecessor), false);
  });
});

test("concurrent telemetry writers cannot jointly exceed the file budget", async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, "events.jsonl");
    const barrier = path.join(directory, "go");
    const readyA = path.join(directory, "ready-a");
    const readyB = path.join(directory, "ready-b");
    const maxBytes = 16 * 1024 * 1024;
    const recordBytes = 8 * 1024 * 1024;
    fs.writeFileSync(file, Buffer.alloc(maxBytes - recordBytes, 0x61));

    const self = fileURLToPath(import.meta.url);
    const runner = self.endsWith(".ts")
      ? [
          path.resolve(
            path.dirname(self),
            "..",
            "node_modules",
            "tsx",
            "dist",
            "cli.mjs",
          ),
          self,
        ]
      : [self];
    const children = [readyA, readyB].map((ready) =>
      spawn(
        process.execPath,
        [
          ...runner,
          TELEMETRY_CHILD_FLAG,
          barrier,
          file,
          ready,
          String(maxBytes),
          String(recordBytes),
        ],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      ),
    );
    const childExits = children.map(
      (child) =>
        new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        }),
    );
    try {
      const readyDeadline = Date.now() + 30_000;
      while (
        (!fs.existsSync(readyA) || !fs.existsSync(readyB)) &&
        Date.now() < readyDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(fs.existsSync(readyA) && fs.existsSync(readyB), true);
      fs.writeFileSync(barrier, "go");

      const exitCodes = await Promise.all(childExits);
      assert.deepEqual(exitCodes, [0, 0]);
      assert.ok(fs.statSync(file).size <= maxBytes);
      const predecessor = `${file}${TELEMETRY_ROTATED_SUFFIX}`;
      if (fs.existsSync(predecessor)) {
        assert.ok(fs.statSync(predecessor).size <= maxBytes);
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await Promise.allSettled(childExits);
    }
  });
});

test("a live telemetry owner marker fails closed without changing the file", async () => {
  await withTempDir((directory) => {
    const file = path.join(directory, "events.jsonl");
    fs.writeFileSync(file, "existing\n", "utf8");
    const marker = `${file}.sol-luna.lock.${process.pid}.00000000-0000-4000-8000-000000000001`;
    fs.linkSync(file, marker);

    assert.equal(appendBoundedPrivateFile(file, "new\n", { maxBytes: 1024 }), false);
    assert.equal(fs.readFileSync(file, "utf8"), "existing\n");
    fs.unlinkSync(marker);
  });
});

test("a dead telemetry owner marker is reclaimed by its unique generation", async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, "events.jsonl");
    fs.writeFileSync(file, "existing\n", "utf8");
    const child = spawn(process.execPath, ["-e", ""], {
      stdio: "ignore",
      windowsHide: true,
    });
    const deadPid = child.pid;
    assert.ok(deadPid);
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    const marker = `${file}.sol-luna.lock.${deadPid}.00000000-0000-4000-8000-000000000002`;
    fs.linkSync(file, marker);

    assert.equal(appendBoundedPrivateFile(file, "new\n", { maxBytes: 1024 }), true);
    assert.equal(fs.readFileSync(file, "utf8"), "existing\nnew\n");
    assert.equal(fs.existsSync(marker), false);
  });
});

test("a dead telemetry temp generation is reclaimed before the next write", async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, "events.jsonl");
    fs.writeFileSync(file, "existing\n", "utf8");
    const child = spawn(process.execPath, ["-e", ""], {
      stdio: "ignore",
      windowsHide: true,
    });
    const deadPid = child.pid;
    assert.ok(deadPid);
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    const temp = `${file}.sol-luna.new.${deadPid}.00000000-0000-4000-8000-000000000003`;
    fs.writeFileSync(temp, "bounded-residue\n", "utf8");

    assert.equal(appendBoundedPrivateFile(file, "new\n", { maxBytes: 1024 }), true);
    assert.equal(fs.readFileSync(file, "utf8"), "existing\nnew\n");
    assert.equal(fs.existsSync(temp), false);
  });
});

test("new telemetry files are owner-only on POSIX", async () => {
  if (process.platform === "win32") return;
  await withTempDir((directory) => {
    const file = path.join(directory, "diagnostic.log");
    assert.equal(appendBoundedPrivateFile(file, "safe\n", { maxBytes: 1024 }), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

test("rotation tightens an older permissive predecessor on POSIX", async () => {
  if (process.platform === "win32") return;
  await withTempDir((directory) => {
    const file = path.join(directory, "events.jsonl");
    fs.writeFileSync(file, "12345\n", { encoding: "utf8", mode: 0o644 });
    fs.chmodSync(file, 0o644);

    assert.equal(appendBoundedPrivateFile(file, "67890\n", { maxBytes: 10 }), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(`${file}${TELEMETRY_ROTATED_SUFFIX}`).mode & 0o777, 0o600);
  });
});
