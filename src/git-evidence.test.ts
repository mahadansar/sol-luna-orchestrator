import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectWorktreeChanges, runGit } from "./git.js";
import { findScopeViolations } from "./scope.js";

test("porcelain -z rename and copy records preserve destination and source evidence", async () => {
  const calls: string[][] = [];
  const changes = await collectWorktreeChanges("fixture-worktree", async (args) => {
    calls.push(args);
    if (args[0] === "status") {
      return [
        "R  src/renamed.ts",
        "legacy/old-name.ts",
        " C src/copied.ts",
        "shared/source.ts",
        " M src/changed.ts",
        "",
      ].join("\0");
    }
    if (args[0] === "diff") return "fixture diff";
    throw new Error("unexpected git command: " + args.join(" "));
  });

  assert.deepEqual(changes.files, [
    { path: "src/renamed.ts", status: "R" },
    { path: "legacy/old-name.ts", status: "D" },
    { path: "src/copied.ts", status: "C" },
    { path: "shared/source.ts", status: "C-source" },
    { path: "src/changed.ts", status: "M" },
  ]);
  assert.equal(changes.diff, "fixture diff");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["status", "--porcelain", "-z", "--untracked-files=all"]);
  assert.deepEqual(calls[1], ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]);
});

test("a staged real rename returns both new destination and deleted source paths", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-git-rename-"));
  try {
    await runGit(["init"], repo);
    await runGit(["config", "user.email", "test@example.invalid"], repo);
    await runGit(["config", "user.name", "Git Evidence Test"], repo);

    const oldDirectory = path.join(repo, "outside");
    const newDirectory = path.join(repo, "src");
    const oldPath = path.join(oldDirectory, "owned-elsewhere.txt");
    const newPath = path.join(newDirectory, "moved.txt");
    await fs.mkdir(oldDirectory, { recursive: true });
    await fs.writeFile(oldPath, "rename evidence\n", "utf8");
    await runGit(["add", "."], repo);
    const committed = await runGit(["commit", "-m", "fixture"], repo);
    assert.equal(committed.code, 0, committed.stderr || committed.stdout);

    await fs.mkdir(newDirectory, { recursive: true });
    await fs.rename(oldPath, newPath);
    const staged = await runGit(["add", "-A"], repo);
    assert.equal(staged.code, 0, staged.stderr || staged.stdout);

    const evidence = await collectWorktreeChanges(repo);
    assert.deepEqual(evidence.files, [
      { path: "src/moved.txt", status: "R" },
      { path: "outside/owned-elsewhere.txt", status: "D" },
    ]);
    assert.deepEqual(
      findScopeViolations(
        evidence.files.map((file) => file.path),
        ["src/**"],
        [],
        repo,
      ),
      ["outside/owned-elsewhere.txt (outside allowedFiles)"],
    );
    assert.match(evidence.diff, /rename from outside\/owned-elsewhere\.txt/);
    assert.match(evidence.diff, /rename to src\/moved\.txt/);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
