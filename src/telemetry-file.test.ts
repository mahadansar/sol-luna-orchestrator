import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendBoundedPrivateFile, TELEMETRY_ROTATED_SUFFIX } from "./telemetry-file.js";

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
