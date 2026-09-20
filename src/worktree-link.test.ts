import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseWorktreeLinkDirectories } from "./config.js";
import {
  filterOrchestratorOwnedSharedLinks,
  linkSharedDirectories,
  unlinkSharedDirectories,
} from "./worktree.js";

test("shared worktree link configuration keeps only confined relative paths", () => {
  const parsed = parseWorktreeLinkDirectories(
    [
      "node_modules",
      "packages/app/node_modules",
      "packages\\other\\node_modules",
      "../outside",
      "/absolute/path",
      "C:\\absolute\\path",
      "C:drive-relative",
      "packages/./hidden",
    ].join(","),
  );

  assert.deepEqual(parsed.dirs, [
    "node_modules",
    "packages/app/node_modules",
    "packages/other/node_modules",
  ]);
  assert.deepEqual(parsed.invalid, [
    "../outside",
    "/absolute/path",
    "C:\\absolute\\path",
    "C:drive-relative",
    "packages/./hidden",
  ]);
});

test("shared worktree link setup and cleanup ignore unsafe caller paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-links-"));
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  const sibling = path.join(root, "outside");
  try {
    await fs.mkdir(path.join(main, "node_modules"), { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, "sentinel.txt"), "keep\n", "utf8");

    const warnings = await linkSharedDirectories(main, worktree, ["../outside"]);
    assert.ok(warnings.some((warning) => /unsafe shared worktree link path/i.test(warning)));
    await unlinkSharedDirectories(worktree, ["../outside"]);

    assert.equal(await fs.readFile(path.join(sibling, "sentinel.txt"), "utf8"), "keep\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("nested orchestrator-owned links are filtered exactly from worktree evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-nested-link-"));
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  const nested = "packages/a/node_modules";
  try {
    await fs.mkdir(path.join(main, nested), { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    const warnings = await linkSharedDirectories(main, worktree, [nested]);
    assert.deepEqual(warnings, []);

    const filtered = await filterOrchestratorOwnedSharedLinks(
      main,
      worktree,
      [
        { path: nested, status: "??" },
        { path: "packages/a/src/worker.ts", status: "M" },
        { path: "packages/a/node_modules-shadow", status: "??" },
      ],
      [nested],
    );

    assert.deepEqual(filtered, [
      { path: "packages/a/src/worker.ts", status: "M" },
      { path: "packages/a/node_modules-shadow", status: "??" },
    ]);
    await unlinkSharedDirectories(worktree, [nested]);
    assert.ok(await fs.stat(path.join(main, nested)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
