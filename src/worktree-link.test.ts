import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseWorktreeLinkDirectories } from "./config.js";
import {
  cleanupWorktree,
  ConfinedDirectoryChainError,
  createTaskWorktree,
  ensureConfinedDirectoryChain,
  filterOrchestratorOwnedSharedLinks,
  linkSharedDirectories,
  prepareWorktreeBase,
  readWorktreeOutcome,
  snapshotSharedDirectories,
  unlinkSharedDirectories,
} from "./worktree.js";
import { runGit } from "./git.js";

async function initializeFixtureRepository(repo: string, name: string): Promise<void> {
  await fs.mkdir(repo, { recursive: true });
  await runGit(["init"], repo);
  await runGit(["config", "user.email", "test@example.invalid"], repo);
  await runGit(["config", "user.name", name], repo);
  await runGit(["config", "core.autocrlf", "false"], repo);
  await fs.writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
  await runGit(["add", "base.txt"], repo);
  const committed = await runGit(["commit", "-m", "fixture"], repo);
  assert.equal(committed.code, 0, committed.stderr || committed.stdout);
}

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
    assert.ok(
      warnings.some((warning) => /unsafe shared worktree link path/i.test(warning)),
    );
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
        { path: `${nested}/dep.js`, status: "??" },
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

test("a destination symlink ancestor cannot redirect shared-link setup or cleanup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-destination-escape-"));
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  const outside = path.join(root, "outside");
  const nested = "packages/a/node_modules";
  try {
    await fs.mkdir(path.join(main, nested), { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    const redirectedParent = path.join(worktree, "packages");
    try {
      await fs.symlink(
        outside,
        redirectedParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      t.skip("directory links are not permitted on this machine");
      return;
    }

    const warnings = await linkSharedDirectories(main, worktree, [nested]);
    assert.ok(warnings.some((warning) => /unsafe destination ancestry/i.test(warning)));
    assert.equal(
      await fs.stat(path.join(outside, "a", "node_modules")).catch(() => null),
      null,
    );

    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "keep\n", "utf8");
    await unlinkSharedDirectories(worktree, [nested]);
    assert.equal(await fs.readFile(sentinel, "utf8"), "keep\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("dependency snapshot safely provisions missing nested destination parents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-snapshot-parent-race-"));
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  const nested = "packages/a/node_modules";
  try {
    await fs.mkdir(path.join(main, nested), { recursive: true });
    await fs.writeFile(path.join(main, nested, "dependency.js"), "module.exports = 1;\n");
    await fs.mkdir(worktree, { recursive: true });
    const result = await snapshotSharedDirectories(main, worktree, [nested]);

    assert.deepEqual(result.provisioned, [nested]);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.rollbackComplete, true);
    assert.equal(
      await fs.readFile(path.join(worktree, nested, "dependency.js"), "utf8"),
      "module.exports = 1;\n",
    );
    for (const directory of ["packages", "packages/a"]) {
      const stat = await fs.lstat(path.join(worktree, directory));
      assert.equal(stat.isDirectory(), true);
      assert.equal(stat.isSymbolicLink(), false);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pinned segment creation cannot follow an ancestor swapped at the pre-create seam", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-segment-create-race-"));
  const confined = path.join(root, "confined");
  const outside = path.join(root, "outside");
  const parked = path.join(root, "parked-packages");
  try {
    await fs.mkdir(confined, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "sentinel.txt"), "keep\n", "utf8");

    let redirected = false;
    let result: Awaited<ReturnType<typeof ensureConfinedDirectoryChain>> | undefined;
    let failure: unknown;
    try {
      result = await ensureConfinedDirectoryChain(
        confined,
        path.join(confined, "packages", "a"),
        {
          beforeCreate: async ({ parent, segment }) => {
            if (segment !== "a") return;
            try {
              await fs.rename(parent.directory, parked);
            } catch {
              // Windows keeps the live cwd directory pinned against replacement.
              return;
            }
            try {
              await fs.symlink(
                outside,
                parent.directory,
                process.platform === "win32" ? "junction" : "dir",
              );
              redirected = true;
            } catch (error) {
              await fs.rename(parked, parent.directory);
              throw error;
            }
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    if (redirected) {
      assert.ok(failure instanceof ConfinedDirectoryChainError);
      assert.equal(failure.rollbackComplete, false);
      assert.equal(result, undefined);
    } else {
      assert.equal(failure, undefined);
      assert.ok(result);
      assert.equal(result.created.length, 2);
    }
    assert.deepEqual(await fs.readdir(outside), ["sentinel.txt"]);
    assert.equal(await fs.lstat(path.join(outside, "a")).catch(() => null), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("dependency snapshot cannot be redirected at the final pinned copy seam", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-snapshot-copy-race-"));
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  const outside = path.join(root, "outside");
  const nested = "packages/a/node_modules";
  try {
    await fs.mkdir(path.join(main, nested), { recursive: true });
    await fs.writeFile(path.join(main, nested, "dependency.js"), "module.exports = 1;\n");
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "sentinel.txt"), "keep\n", "utf8");

    let injected = false;
    const result = await snapshotSharedDirectories(main, worktree, [nested], {
      beforeDestinationCommit: async ({ destination }) => {
        if (injected) return;
        try {
          await fs.symlink(
            outside,
            destination,
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch {
          throw new Error("directory links are not permitted on this machine");
        }
        injected = true;
      },
    });
    if (!injected) {
      t.skip("directory links are not permitted on this machine");
      return;
    }

    assert.deepEqual(result.provisioned, []);
    assert.equal(result.rollbackComplete, false);
    assert.ok(result.warnings.some((warning) => /destination exists/i.test(warning)));
    assert.deepEqual(await fs.readdir(outside), ["sentinel.txt"]);
    assert.equal(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8"), "keep\n");
    assert.equal(
      await fs.lstat(path.join(outside, "dependency.js")).catch(() => null),
      null,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a source symlink ancestor cannot expose a directory outside the workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-source-escape-"));
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  const outside = path.join(root, "outside");
  const nested = "packages/a/node_modules";
  try {
    await fs.mkdir(main, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(path.join(outside, "a", "node_modules"), { recursive: true });
    try {
      await fs.symlink(
        outside,
        path.join(main, "packages"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      t.skip("directory links are not permitted on this machine");
      return;
    }

    const warnings = await linkSharedDirectories(main, worktree, [nested]);
    assert.ok(warnings.some((warning) => /outside the workspace/i.test(warning)));
    assert.equal(await fs.lstat(path.join(worktree, nested)).catch(() => null), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("production worktrees snapshot dependencies privately from worker mutations", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-private-snapshot-"));
  let worktree: Awaited<ReturnType<typeof createTaskWorktree>> | undefined;
  try {
    await initializeFixtureRepository(repo, "Private Snapshot Test");
    const dependency = path.join(repo, "node_modules", "fixture", "index.js");
    await fs.mkdir(path.dirname(dependency), { recursive: true });
    await fs.writeFile(dependency, "module.exports = 'main';\n", "utf8");

    const base = await prepareWorktreeBase(repo, [["base.txt"]]);
    worktree = await createTaskWorktree(base, "private-snapshot", repo);

    assert.deepEqual(worktree.sharedSnapshotDirs, ["node_modules"]);
    const snapshotRoot = path.join(
      worktree.workingDirectory ?? worktree.path,
      "node_modules",
    );
    const snapshotStat = await fs.lstat(snapshotRoot);
    assert.equal(snapshotStat.isDirectory(), true);
    assert.equal(snapshotStat.isSymbolicLink(), false);
    assert.notEqual(
      await fs.realpath(snapshotRoot),
      await fs.realpath(path.join(repo, "node_modules")),
    );

    const workerDependency = path.join(snapshotRoot, "fixture", "index.js");
    assert.equal(
      await fs.readFile(workerDependency, "utf8"),
      "module.exports = 'main';\n",
    );
    await fs.writeFile(workerDependency, "module.exports = 'worker';\n", "utf8");
    assert.equal(await fs.readFile(dependency, "utf8"), "module.exports = 'main';\n");
  } finally {
    if (worktree)
      await cleanupWorktree(worktree, "success", "never").catch(() => undefined);
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("dependency snapshots reject external directory links without touching their targets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-snapshot-escape-"));
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  let worktree: Awaited<ReturnType<typeof createTaskWorktree>> | undefined;
  try {
    await initializeFixtureRepository(repo, "Snapshot Escape Test");
    await fs.mkdir(path.join(repo, "node_modules"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "sentinel.txt"), "keep\n", "utf8");
    try {
      await fs.symlink(
        outside,
        path.join(repo, "node_modules", "external"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      t.skip("directory links are not permitted on this machine");
      return;
    }

    const base = await prepareWorktreeBase(repo, [["base.txt"]]);
    worktree = await createTaskWorktree(base, "snapshot-escape", repo);

    assert.deepEqual(worktree.sharedSnapshotDirs, []);
    assert.ok(
      worktree.warnings.some((warning) =>
        /shared dependency link escapes/i.test(warning),
      ),
      worktree.warnings.join("\n"),
    );
    assert.equal(
      await fs
        .lstat(path.join(worktree.workingDirectory ?? worktree.path, "node_modules"))
        .catch(() => null),
      null,
    );
    assert.deepEqual(await fs.readdir(outside), ["sentinel.txt"]);
    assert.equal(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8"), "keep\n");
  } finally {
    if (worktree)
      await cleanupWorktree(worktree, "success", "never").catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("redirected .sol-luna control state is refused before external worktree or lease creation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-control-redirect-"));
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  try {
    await initializeFixtureRepository(repo, "Control Redirect Test");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "sentinel.txt"), "keep\n", "utf8");

    let base: Awaited<ReturnType<typeof prepareWorktreeBase>>;
    const controlPath = path.join(repo, ".sol-luna");
    if (process.platform === "win32") {
      base = await prepareWorktreeBase(repo, [["base.txt"]]);
      try {
        await fs.symlink(outside, controlPath, "junction");
      } catch {
        t.skip("directory junction creation is not permitted on this machine");
        return;
      }
    } else {
      try {
        await fs.symlink(outside, controlPath, "dir");
      } catch {
        t.skip("directory symlink creation is not permitted on this machine");
        return;
      }
      await runGit(["add", ".sol-luna"], repo);
      const committed = await runGit(
        ["commit", "-m", "commit redirected control path"],
        repo,
      );
      assert.equal(committed.code, 0, committed.stderr || committed.stdout);
      base = await prepareWorktreeBase(repo, [["base.txt"]]);
    }

    await assert.rejects(
      createTaskWorktree(base, "redirected-control", repo),
      /Refusing redirected orchestrator control path/i,
    );
    assert.deepEqual(await fs.readdir(outside), ["sentinel.txt"]);
    assert.equal(await fs.lstat(path.join(outside, "worktrees")).catch(() => null), null);
    assert.equal(
      await fs.lstat(path.join(outside, "continuation-leases")).catch(() => null),
      null,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("nested requested workspaces provision dependency snapshots at the nested worktree path", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-nested-workspace-"));
  let worktree: Awaited<ReturnType<typeof createTaskWorktree>> | undefined;
  try {
    await initializeFixtureRepository(repo, "Nested Workspace Test");

    const requestedWorkspace = path.join(repo, "packages", "app");
    await fs.mkdir(path.join(requestedWorkspace, "node_modules"), { recursive: true });
    await fs.writeFile(
      path.join(requestedWorkspace, "node_modules", "dependency.js"),
      "module.exports = 1;\n",
      "utf8",
    );

    const base = await prepareWorktreeBase(requestedWorkspace, [["src/**"]]);
    worktree = await createTaskWorktree(base, "nested-workspace", requestedWorkspace);
    assert.equal(worktree.sharedLinkRoot, requestedWorkspace);
    assert.equal(worktree.workingDirectory, path.join(worktree.path, "packages", "app"));
    assert.deepEqual(worktree.sharedSnapshotDirs, ["node_modules"]);
    const nestedSnapshot = path.join(worktree.path, "packages", "app", "node_modules");
    const nestedSnapshotStat = await fs.lstat(nestedSnapshot);
    assert.equal(nestedSnapshotStat.isDirectory(), true);
    assert.equal(nestedSnapshotStat.isSymbolicLink(), false);
    assert.equal(
      await fs.readFile(path.join(nestedSnapshot, "dependency.js"), "utf8"),
      "module.exports = 1;\n",
    );
    assert.equal(
      await fs.lstat(path.join(worktree.path, "node_modules")).catch(() => null),
      null,
    );
    const outcome = await readWorktreeOutcome(worktree);
    assert.deepEqual(outcome.changes.files, [], JSON.stringify(outcome.changes.files));
  } finally {
    if (worktree)
      await cleanupWorktree(worktree, "success", "never").catch(() => undefined);
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("worktree cleanup cannot traverse a worker-created directory link", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-cleanup-link-"));
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  let worktree: Awaited<ReturnType<typeof createTaskWorktree>> | undefined;
  try {
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "sentinel.txt"), "keep\n", "utf8");
    await runGit(["init"], repo);
    await runGit(["config", "user.email", "test@example.invalid"], repo);
    await runGit(["config", "user.name", "Cleanup Link Test"], repo);
    await fs.writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
    await runGit(["add", "base.txt"], repo);
    const committed = await runGit(["commit", "-m", "fixture"], repo);
    assert.equal(committed.code, 0, committed.stderr || committed.stdout);

    const base = await prepareWorktreeBase(repo, [["base.txt"]]);
    worktree = await createTaskWorktree(base, "cleanup-link", repo);
    try {
      await fs.symlink(
        outside,
        path.join(worktree.path, "worker-created-link"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      t.skip("directory links are not permitted on this machine");
      return;
    }

    const cleaned = await cleanupWorktree(worktree, "success", "never");
    assert.equal(
      cleaned.removed,
      true,
      cleaned.error ?? "worktree cleanup should succeed",
    );
    worktree = undefined;
    assert.equal(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8"), "keep\n");
  } finally {
    if (worktree) {
      await cleanupWorktree(worktree, "success", "never").catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
