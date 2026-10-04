import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseWorktreeLinkDirectories } from "./config.js";
import {
  capturePinnedDirectoryAuthority,
  PinnedDirectoryMutationError,
  runPinnedDirectoryMutation,
} from "./fs-authority.js";
import {
  captureSharedDirectoryFingerprint,
  cleanupWorktree,
  ConfinedDirectoryChainError,
  createTaskWorktree,
  ensureConfinedDirectoryChain,
  prepareWorktreeBase,
  readWorktreeOutcome,
  snapshotSharedDirectories,
  unlinkSharedDirectories,
} from "./worktree.js";
import { runGit } from "./git.js";

test("pinned helper spawn failure settles when its captured parent disappears", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-pinned-spawn-"));
  const authority = await capturePinnedDirectoryAuthority(root, root);
  await fs.rmdir(root);
  await assert.rejects(
    runPinnedDirectoryMutation(authority, { op: "mkdir", name: "child" }),
    { code: "ENOENT" },
  );
});

test("pinned helper rechecks parent authority after asynchronous pre-execution checks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-pinned-delayed-"));
  const original = path.join(root, "original");
  const replacement = path.join(root, "replacement");
  const route = path.join(root, "route");
  const parent = path.join(route, "parent");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  try {
    await fs.mkdir(path.join(original, "parent"), { recursive: true });
    await fs.mkdir(path.join(replacement, "parent"), { recursive: true });
    try {
      await fs.symlink(original, route, linkType);
    } catch {
      t.skip("directory links are not permitted on this machine");
      return;
    }
    const authority = await capturePinnedDirectoryAuthority(parent, root);
    await assert.rejects(
      runPinnedDirectoryMutation(
        authority,
        { op: "mkdir", name: "child" },
        {
          beforeExecute: async () => {
            await fs.unlink(route);
            await fs.symlink(replacement, route, linkType);
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof PinnedDirectoryMutationError);
        assert.equal(error.mutated, false);
        assert.match(error.message, /parent changed before mutation/i);
        return true;
      },
    );
    assert.deepEqual(await fs.readdir(parent), []);
    assert.deepEqual(await fs.readdir(path.join(original, "parent")), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed pinned unlink does not report mutation merely because its target still exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-pinned-unlink-"));
  const target = path.join(root, "target.txt");
  try {
    await fs.writeFile(target, "keep\n", "utf8");
    const authority = await capturePinnedDirectoryAuthority(root, root);
    await assert.rejects(
      runPinnedDirectoryMutation(authority, {
        op: "unlink",
        name: "target.txt",
        testFailBeforeUnlink: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PinnedDirectoryMutationError);
        assert.equal(error.mutated, false);
        return true;
      },
    );
    assert.equal(await fs.readFile(target, "utf8"), "keep\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejected pinned replace-write does not report mutation for an untouched existing file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-pinned-replace-"));
  const target = path.join(root, "target.txt");
  try {
    await fs.writeFile(target, "keep\n", "utf8");
    const authority = await capturePinnedDirectoryAuthority(root, root);
    await assert.rejects(
      runPinnedDirectoryMutation(authority, {
        op: "write-file",
        name: "target.txt",
        mode: "replace",
        expectedIdentity: "not-the-current-identity",
        bytesBase64: Buffer.from("replacement\n").toString("base64"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof PinnedDirectoryMutationError);
        assert.equal(error.mutated, false);
        return true;
      },
    );
    assert.equal(await fs.readFile(target, "utf8"), "keep\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pinned helper crash after mutation is conservatively reported as mutated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-pinned-crash-"));
  try {
    await fs.writeFile(path.join(root, "source.txt"), "move-me\n", "utf8");
    const authority = await capturePinnedDirectoryAuthority(root, root);
    await assert.rejects(
      runPinnedDirectoryMutation(authority, {
        op: "rename-verified",
        sourceName: "source.txt",
        destinationName: "destination.txt",
        testExitAfterMutationBeforeResult: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PinnedDirectoryMutationError);
        assert.equal(error.mutated, true);
        assert.equal(error.mutationProven, true);
        assert.match(error.message, /exited without a result/i);
        return true;
      },
    );
    await assert.rejects(fs.stat(path.join(root, "source.txt")));
    assert.equal(
      await fs.readFile(path.join(root, "destination.txt"), "utf8"),
      "move-me\n",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pinned helper protocol loss before mutation is reported as possible but unproven", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-pinned-unknown-"));
  try {
    await fs.writeFile(path.join(root, "source.txt"), "stay-put\n", "utf8");
    const authority = await capturePinnedDirectoryAuthority(root, root);
    await assert.rejects(
      runPinnedDirectoryMutation(authority, {
        op: "rename-verified",
        sourceName: "source.txt",
        destinationName: "destination.txt",
        testExitBeforeMutationWithoutResult: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PinnedDirectoryMutationError);
        assert.equal(error.mutated, true, "protocol loss must remain fail-closed");
        assert.equal(error.mutationProven, false);
        return true;
      },
    );
    assert.equal(await fs.readFile(path.join(root, "source.txt"), "utf8"), "stay-put\n");
    await assert.rejects(fs.stat(path.join(root, "destination.txt")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("confined parent creation preserves unknown mkdir protocol loss", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-parent-mkdir-loss-"));
  try {
    await assert.rejects(
      ensureConfinedDirectoryChain(root, path.join(root, "fresh"), {
        testExitBeforeCreateWithoutResult: ({ segment }) => segment === "fresh",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConfinedDirectoryChainError);
        assert.equal(error.rollbackOutcome, "residual-unknown");
        assert.equal(error.rollbackComplete, false);
        return true;
      },
    );
    assert.equal(await fs.lstat(path.join(root, "fresh")).catch(() => null), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("confined parent rollback distinguishes unknown protocol loss from proven residual state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-parent-rmdir-loss-"));
  try {
    const unknownChain = await ensureConfinedDirectoryChain(
      root,
      path.join(root, "unknown"),
      {
        testExitBeforeRollbackWithoutResult: ({ name }) => name === "unknown",
      },
    );
    assert.equal(await unknownChain.rollback(), "residual-unknown");
    assert.equal((await fs.lstat(path.join(root, "unknown"))).isDirectory(), true);

    const provenChain = await ensureConfinedDirectoryChain(
      root,
      path.join(root, "proven"),
    );
    await fs.writeFile(path.join(root, "proven", "sentinel.txt"), "keep\n", "utf8");
    assert.equal(await provenChain.rollback(), "residual-proven");
    assert.equal(
      await fs.readFile(path.join(root, "proven", "sentinel.txt"), "utf8"),
      "keep\n",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("shared dependency fingerprint refuses a configured root redirected outside the workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-shared-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-shared-outside-"));
  try {
    await fs.writeFile(path.join(outside, "sentinel.js"), "outside\n", "utf8");
    await fs.symlink(
      outside,
      path.join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      captureSharedDirectoryFingerprint(root, ["node_modules"]),
      /must be a real directory, not a symbolic link or junction/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("shared dependency fingerprint refuses an ancestor redirect outside the workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-shared-ancestor-"));
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "sol-luna-shared-ancestor-outside-"),
  );
  try {
    const dependency = path.join(outside, "a", "node_modules");
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(path.join(dependency, "sentinel.js"), "outside\n", "utf8");
    await fs.symlink(
      outside,
      path.join(root, "packages"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      captureSharedDirectoryFingerprint(root, ["packages/a/node_modules"]),
      /resolves outside its workspace/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("shared dependency roots that are links are refused even when their targets stay in-workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-shared-root-link-"));
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  try {
    const realDependencies = path.join(main, "deps-real");
    await fs.mkdir(realDependencies, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(
      path.join(realDependencies, "sentinel.js"),
      "module.exports = 1;\n",
    );
    try {
      await fs.symlink(
        realDependencies,
        path.join(main, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      t.skip("directory links are not permitted on this machine");
      return;
    }

    await assert.rejects(
      captureSharedDirectoryFingerprint(main, ["node_modules"]),
      /must be a real directory, not a symbolic link or junction/i,
    );

    const snapshot = await snapshotSharedDirectories(main, worktree, ["node_modules"]);
    assert.deepEqual(snapshot.provisioned, []);
    assert.ok(
      snapshot.warnings.some((warning) => /linked root/i.test(warning)),
      snapshot.warnings.join("\n"),
    );
    assert.deepEqual(await fs.readdir(worktree), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("broken shared dependency root links are refused instead of being treated as missing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-broken-root-link-"));
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  const target = path.join(main, "deps-real");
  const configured = path.join(main, "node_modules");
  try {
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    try {
      await fs.symlink(
        target,
        configured,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      t.skip("directory links are not permitted on this machine");
      return;
    }
    await fs.rm(target, { recursive: true, force: true });
    assert.equal((await fs.lstat(configured)).isSymbolicLink(), true);
    assert.equal(await fs.stat(configured).catch(() => null), null);

    const snapshot = await snapshotSharedDirectories(main, worktree, ["node_modules"]);
    assert.deepEqual(snapshot.provisioned, []);
    assert.ok(
      snapshot.warnings.some((warning) => /linked root/i.test(warning)),
      snapshot.warnings.join("\n"),
    );
    assert.deepEqual(await fs.readdir(worktree), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("private dependency snapshot rejects raced regular-file bytes even when the source is restored", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-snapshot-file-race-"));
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  const sourceFile = path.join(main, "node_modules", "fixture", "index.js");
  try {
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(sourceFile, "module.exports = 'trusted';\n", "utf8");

    const snapshot = await snapshotSharedDirectories(main, worktree, ["node_modules"], {
      beforeCopy: async () => {
        await fs.writeFile(sourceFile, "module.exports = 'raced';\n", "utf8");
      },
      beforeDestinationCommit: async () => {
        await fs.writeFile(sourceFile, "module.exports = 'trusted';\n", "utf8");
      },
    });

    assert.deepEqual(snapshot.provisioned, []);
    assert.ok(
      snapshot.warnings.some((warning) =>
        /state changed while creating the private snapshot/i.test(warning),
      ),
      snapshot.warnings.join("\n"),
    );
    assert.equal(await fs.readFile(sourceFile, "utf8"), "module.exports = 'trusted';\n");
    assert.equal(
      await fs.lstat(path.join(worktree, "node_modules")).catch(() => null),
      null,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pinned dependency copy refuses a link raced outside after parent-side admission", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-copy-link-race-"));
  const source = path.join(root, "source");
  const destinationParent = path.join(root, "destination");
  const outside = path.join(root, "outside");
  const link = path.join(source, "link");
  try {
    const internal = path.join(source, "real");
    await fs.mkdir(internal, { recursive: true });
    await fs.mkdir(destinationParent, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(internal, "inside.txt"), "inside\n", "utf8");
    await fs.writeFile(path.join(outside, "outside.txt"), "outside\n", "utf8");
    try {
      await fs.symlink(internal, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      t.skip("directory links are not permitted on this machine");
      return;
    }

    await captureSharedDirectoryFingerprint(root, ["source"]);
    const authority = await capturePinnedDirectoryAuthority(
      destinationParent,
      destinationParent,
    );
    await assert.rejects(
      runPinnedDirectoryMutation(
        authority,
        { op: "copy-directory", name: "snapshot", source },
        {
          beforeExecute: async () => {
            await fs.unlink(link);
            await fs.symlink(
              outside,
              link,
              process.platform === "win32" ? "junction" : "dir",
            );
          },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof PinnedDirectoryMutationError);
        assert.equal(error.mutated, false);
        assert.match(error.message, /escapes its configured source tree/i);
        return true;
      },
    );
    assert.equal(
      await fs.lstat(path.join(destinationParent, "snapshot")).catch(() => null),
      null,
    );
    assert.equal(
      await fs.readFile(path.join(outside, "outside.txt"), "utf8"),
      "outside\n",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

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

test("dependency snapshot setup and legacy-link cleanup ignore unsafe caller paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-links-"));
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  const sibling = path.join(root, "outside");
  try {
    await fs.mkdir(path.join(main, "node_modules"), { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(path.join(sibling, "sentinel.txt"), "keep\n", "utf8");

    const { warnings } = await snapshotSharedDirectories(main, worktree, ["../outside"]);
    assert.ok(
      warnings.some((warning) => /unsafe shared worktree snapshot path/i.test(warning)),
    );
    await unlinkSharedDirectories(worktree, ["../outside"]);

    assert.equal(await fs.readFile(path.join(sibling, "sentinel.txt"), "utf8"), "keep\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a destination symlink ancestor cannot redirect dependency snapshot setup or legacy-link cleanup", async (t) => {
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

    const { warnings } = await snapshotSharedDirectories(main, worktree, [nested]);
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

    const { warnings } = await snapshotSharedDirectories(main, worktree, [nested]);
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

test("worker-created links to the operator dependencies are never treated as setup evidence", async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-forged-setup-link-"));
  let worktree: Awaited<ReturnType<typeof createTaskWorktree>> | undefined;
  try {
    await initializeFixtureRepository(repo, "Forged Setup Link Test");
    const base = await prepareWorktreeBase(repo, [["base.txt"]]);
    worktree = await createTaskWorktree(base, "forged-setup-link", repo);
    assert.deepEqual(worktree.sharedSnapshotDirs, []);
    const dependencies = path.join(repo, "node_modules");
    await fs.mkdir(dependencies);
    await fs.writeFile(path.join(dependencies, "sentinel.js"), "operator bytes\n");
    try {
      await fs.symlink(
        dependencies,
        path.join(worktree.path, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      t.skip("directory links are not permitted on this machine");
      return;
    }
    const outcome = await readWorktreeOutcome(worktree);
    assert.equal(outcome.error, undefined, outcome.warnings.join("\n"));
    assert.ok(
      outcome.changes.files.some(
        (file) => file.path === "node_modules" || file.path.startsWith("node_modules/"),
      ),
      JSON.stringify(outcome.changes.files),
    );
    assert.equal(
      await fs.readFile(path.join(dependencies, "sentinel.js"), "utf8"),
      "operator bytes\n",
    );
  } finally {
    if (worktree) await cleanupWorktree(worktree, "success", "never");
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("production dependency snapshots rebase confined internal directory links privately", async (t) => {
  const repo = await fs.mkdtemp(
    path.join(os.tmpdir(), "sol-luna-private-link-snapshot-"),
  );
  let worktree: Awaited<ReturnType<typeof createTaskWorktree>> | undefined;
  try {
    await initializeFixtureRepository(repo, "Private Link Snapshot Test");
    const dependencyRoot = path.join(repo, "node_modules");
    const realDependency = path.join(dependencyRoot, "real-package");
    const linkedDependency = path.join(dependencyRoot, "linked-package");
    const mainFile = path.join(realDependency, "index.js");
    await fs.mkdir(realDependency, { recursive: true });
    await fs.writeFile(mainFile, "module.exports = 'main';\n", "utf8");
    try {
      await fs.symlink(
        realDependency,
        linkedDependency,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      t.skip("directory links are not permitted on this machine");
      return;
    }

    const base = await prepareWorktreeBase(repo, [["base.txt"]]);
    worktree = await createTaskWorktree(base, "private-link-snapshot", repo);

    assert.deepEqual(worktree.sharedSnapshotDirs, ["node_modules"]);
    const snapshotRoot = path.join(
      worktree.workingDirectory ?? worktree.path,
      "node_modules",
    );
    const privateLink = path.join(snapshotRoot, "linked-package");
    const privateReal = await fs.realpath(privateLink);
    const relativePrivateTarget = path.relative(snapshotRoot, privateReal);
    assert.ok(
      relativePrivateTarget === "" ||
        (!relativePrivateTarget.startsWith(`..${path.sep}`) &&
          relativePrivateTarget !== ".." &&
          !path.isAbsolute(relativePrivateTarget)),
      `private link escaped snapshot root: ${privateReal}`,
    );
    assert.notEqual(await fs.realpath(privateLink), await fs.realpath(linkedDependency));
    if (process.platform !== "win32") {
      assert.equal(path.isAbsolute(await fs.readlink(privateLink)), false);
    }

    const privateFile = path.join(privateLink, "index.js");
    assert.equal(await fs.readFile(privateFile, "utf8"), "module.exports = 'main';\n");
    await fs.writeFile(privateFile, "module.exports = 'worker';\n", "utf8");
    assert.equal(
      await fs.readFile(path.join(snapshotRoot, "real-package", "index.js"), "utf8"),
      "module.exports = 'worker';\n",
    );
    assert.equal(await fs.readFile(mainFile, "utf8"), "module.exports = 'main';\n");
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
