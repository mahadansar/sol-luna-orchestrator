import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_GIT_OUTPUT_BYTES,
  assertGitEvidenceAuthority,
  captureGitEvidenceAuthority,
  collectTrustedWorktreeChanges,
  collectWorktreeChanges,
  createIsolatedWorkerGitEnvironment,
  git,
  listTrustedIgnoredFiles,
  runGit,
} from "./git.js";
import { findScopeViolations } from "./scope.js";

async function initFixtureRepo(prefix: string): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await runGit(["init"], repo);
  await runGit(["config", "user.email", "test@example.invalid"], repo);
  await runGit(["config", "user.name", "Git Evidence Test"], repo);
  return repo;
}

const toShellPath = (value: string): string =>
  `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;

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

test("isolated Git metadata preserves nested workspace semantics and local config isolation", async () => {
  const repo = await initFixtureRepo("sol-luna-git-private-");
  let isolated:
    Awaited<ReturnType<typeof createIsolatedWorkerGitEnvironment>> | undefined;
  try {
    const nested = path.join(repo, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(repo, "root.txt"), "root\n", "utf8");
    await fs.writeFile(path.join(nested, "nested.txt"), "before\n", "utf8");
    await runGit(["add", "."], repo);
    const committed = await runGit(["commit", "-m", "fixture"], repo);
    assert.equal(committed.code, 0, committed.stderr || committed.stdout);

    const authority = await captureGitEvidenceAuthority(nested);
    assert.ok(authority);
    isolated = await createIsolatedWorkerGitEnvironment(authority, nested);

    assert.equal((await git(["status", "--porcelain"], nested, isolated.env)).trim(), "");
    assert.equal(
      path.normalize(
        (await git(["rev-parse", "--show-toplevel"], nested, isolated.env)).trim(),
      ),
      path.normalize(repo),
    );

    await git(
      ["config", "--local", "sol-luna.private", "isolated"],
      nested,
      isolated.env,
    );
    assert.equal(
      (
        await git(
          ["config", "--local", "--get", "sol-luna.private"],
          nested,
          isolated.env,
        )
      ).trim(),
      "isolated",
    );
    const operatorConfig = await runGit(
      ["config", "--local", "--get", "sol-luna.private"],
      repo,
    );
    assert.notEqual(
      operatorConfig.code,
      0,
      "isolated git config must not reach operator config",
    );

    await fs.writeFile(path.join(nested, "nested.txt"), "after\n", "utf8");
    const names = (
      await git(["diff", "--name-only", authority.baseCommit], nested, isolated.env)
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((entry) => entry.replaceAll("\\", "/"));
    assert.deepEqual(names, ["packages/app/nested.txt"]);
  } finally {
    await isolated?.cleanup().catch(() => undefined);
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("trusted evidence does not execute repository-local clean or process filters", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-git-filter-"));
  const repo = path.join(root, "repo");
  const helper = path.join(root, "filter-canary.mjs");
  const canary = path.join(root, "canary.txt");
  try {
    await fs.mkdir(repo, { recursive: true });
    await runGit(["init"], repo);
    await runGit(["config", "user.email", "test@example.invalid"], repo);
    await runGit(["config", "user.name", "Git Evidence Test"], repo);
    await fs.writeFile(
      path.join(repo, ".gitattributes"),
      "tracked.txt filter=evil\n",
      "utf8",
    );
    await fs.writeFile(path.join(repo, "tracked.txt"), "before\n", "utf8");
    await runGit(["add", "."], repo);
    const committed = await runGit(["commit", "-m", "fixture"], repo);
    assert.equal(committed.code, 0, committed.stderr || committed.stdout);

    await fs.writeFile(
      helper,
      [
        'import fs from "node:fs";',
        `fs.writeFileSync(${JSON.stringify(canary)}, "executed\\n", "utf8");`,
        "process.exit(31);",
        "",
      ].join("\n"),
      "utf8",
    );
    const filterCommand = `${toShellPath(process.execPath)} ${toShellPath(helper)}`;
    await runGit(["config", "filter.evil.clean", filterCommand], repo);
    await runGit(["config", "filter.evil.process", filterCommand], repo);
    await runGit(["config", "filter.evil.required", "true"], repo);

    const authority = await captureGitEvidenceAuthority(repo);
    assert.ok(authority);
    await fs.writeFile(path.join(repo, "tracked.txt"), "after\n", "utf8");

    const evidence = await collectTrustedWorktreeChanges(authority);
    assert.deepEqual(evidence.files, [{ path: "tracked.txt", status: "M" }]);
    assert.match(evidence.diff, /-before/);
    assert.match(evidence.diff, /\+after/);
    assert.equal(
      await fs.access(canary).then(
        () => true,
        () => false,
      ),
      false,
      "trusted evidence must not execute operator-local filter commands",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("trusted evidence ignores replace refs that would otherwise redefine the base commit", async () => {
  const repo = await initFixtureRepo("sol-luna-git-replace-");
  const indexRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "sol-luna-git-replace-index-"),
  );
  const indexPath = path.join(indexRoot, "replacement.index");
  try {
    await fs.writeFile(path.join(repo, "tracked.txt"), "before\n", "utf8");
    await runGit(["add", "."], repo);
    const committed = await runGit(["commit", "-m", "fixture"], repo);
    assert.equal(committed.code, 0, committed.stderr || committed.stdout);
    const baseCommit = (await git(["rev-parse", "HEAD"], repo)).trim();

    await fs.writeFile(path.join(repo, "tracked.txt"), "after\n", "utf8");
    const privateIndex = { GIT_INDEX_FILE: indexPath };
    await git(["read-tree", baseCommit], repo, privateIndex);
    await git(["add", "tracked.txt"], repo, privateIndex);
    const replacementTree = (await git(["write-tree"], repo, privateIndex)).trim();
    const replacementCommit = (
      await git(
        ["commit-tree", replacementTree, "-p", baseCommit, "-m", "replacement"],
        repo,
      )
    ).trim();
    await git(["replace", baseCommit, replacementCommit], repo);

    const authority = await captureGitEvidenceAuthority(repo, baseCommit);
    assert.ok(authority);
    const evidence = await collectTrustedWorktreeChanges(authority);
    assert.deepEqual(evidence.files, [{ path: "tracked.txt", status: "M" }]);
    assert.match(evidence.diff, /-before/);
    assert.match(evidence.diff, /\+after/);
  } finally {
    await fs.rm(indexRoot, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("trusted evidence rejects common Git control mutation after authority capture", async () => {
  const repo = await initFixtureRepo("sol-luna-git-control-");
  try {
    await fs.writeFile(path.join(repo, "tracked.txt"), "before\n", "utf8");
    await runGit(["add", "."], repo);
    const committed = await runGit(["commit", "-m", "fixture"], repo);
    assert.equal(committed.code, 0, committed.stderr || committed.stdout);

    const authority = await captureGitEvidenceAuthority(repo);
    assert.ok(authority);
    const changed = await runGit(
      ["config", "--local", "sol-luna.after-capture", "changed"],
      repo,
    );
    assert.equal(changed.code, 0, changed.stderr || changed.stdout);

    await assert.rejects(
      () => collectTrustedWorktreeChanges(authority),
      /Git evidence authority changed: repository config\/refs\/hooks\/info or lock state was modified/,
    );
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("trusted evidence independently exposes initialized submodule changes hidden by ignore=all", async () => {
  const repo = await initFixtureRepo("sol-luna-git-submodule-ignore-super-");
  const submoduleSource = await initFixtureRepo("sol-luna-git-submodule-ignore-source-");
  try {
    await fs.writeFile(path.join(submoduleSource, ".gitignore"), "ignored.log\n", "utf8");
    await fs.writeFile(
      path.join(submoduleSource, "dependency.txt"),
      "dependency before\n",
      "utf8",
    );
    await runGit(["add", "."], submoduleSource);
    const sourceCommit = await runGit(
      ["commit", "-m", "submodule fixture"],
      submoduleSource,
    );
    assert.equal(sourceCommit.code, 0, sourceCommit.stderr || sourceCommit.stdout);

    await fs.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await runGit(["add", "."], repo);
    const baseCommit = await runGit(["commit", "-m", "super fixture"], repo);
    assert.equal(baseCommit.code, 0, baseCommit.stderr || baseCommit.stdout);

    const added = await runGit(
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        submoduleSource,
        "vendor/dependency",
      ],
      repo,
    );
    assert.equal(added.code, 0, added.stderr || added.stdout);
    const submodulePath = path.join(repo, "vendor", "dependency");
    // Keep the fixture byte-identical to its blobs even when the host Git uses
    // checkout-time CRLF conversion; trusted evidence intentionally runs with
    // isolated config and therefore compares the filesystem bytes directly.
    await fs.writeFile(path.join(submodulePath, ".gitignore"), "ignored.log\n", "utf8");
    await fs.writeFile(
      path.join(submodulePath, "dependency.txt"),
      "dependency before\n",
      "utf8",
    );
    const ignoreConfigured = await runGit(
      ["config", "-f", ".gitmodules", "submodule.vendor/dependency.ignore", "all"],
      repo,
    );
    assert.equal(
      ignoreConfigured.code,
      0,
      ignoreConfigured.stderr || ignoreConfigured.stdout,
    );
    await runGit(["add", ".gitmodules", "vendor/dependency"], repo);
    const committed = await runGit(["commit", "-m", "add ignored submodule"], repo);
    assert.equal(committed.code, 0, committed.stderr || committed.stdout);

    const authority = await captureGitEvidenceAuthority(repo);
    assert.ok(authority);
    assert.deepEqual(
      authority.submodules.map((entry) => entry.path),
      ["vendor/dependency"],
    );

    await fs.writeFile(
      path.join(submodulePath, "dependency.txt"),
      "dependency after\n",
      "utf8",
    );
    await fs.writeFile(path.join(submodulePath, "untracked.txt"), "untracked\n", "utf8");
    await fs.writeFile(path.join(submodulePath, "ignored.log"), "ignored\n", "utf8");

    const ordinaryStatus = await git(
      ["status", "--porcelain", "-z", "--untracked-files=all"],
      repo,
    );
    assert.equal(
      ordinaryStatus,
      "",
      "the fixture must prove committed ignore=all hides the dirty gitlink from the superproject",
    );

    const evidence = await collectTrustedWorktreeChanges(authority);
    assert.deepEqual(evidence.files, [
      { path: "vendor/dependency/dependency.txt", status: "M" },
      { path: "vendor/dependency/untracked.txt", status: "??" },
    ]);
    assert.match(evidence.diff, /a\/vendor\/dependency\/dependency\.txt/);
    assert.match(evidence.diff, /b\/vendor\/dependency\/dependency\.txt/);
    assert.deepEqual(await listTrustedIgnoredFiles(authority), [
      "vendor/dependency/ignored.log",
    ]);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(submoduleSource, { recursive: true, force: true });
  }
});

test("uninitialized gitlink admission state rejects later population, replacement, and redirects", async (t) => {
  const repo = await initFixtureRepo("sol-luna-git-uninitialized-super-");
  const submoduleSource = await initFixtureRepo("sol-luna-git-uninitialized-source-");
  const submodulePath = path.join(repo, "vendor", "dependency");
  try {
    await fs.writeFile(
      path.join(submoduleSource, "dependency.txt"),
      "dependency\n",
      "utf8",
    );
    await runGit(["add", "."], submoduleSource);
    const sourceCommit = await runGit(
      ["commit", "-m", "submodule fixture"],
      submoduleSource,
    );
    assert.equal(sourceCommit.code, 0, sourceCommit.stderr || sourceCommit.stdout);

    await fs.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await runGit(["add", "."], repo);
    const baseCommit = await runGit(["commit", "-m", "super fixture"], repo);
    assert.equal(baseCommit.code, 0, baseCommit.stderr || baseCommit.stdout);

    const added = await runGit(
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        submoduleSource,
        "vendor/dependency",
      ],
      repo,
    );
    assert.equal(added.code, 0, added.stderr || added.stdout);
    await runGit(["add", ".gitmodules", "vendor/dependency"], repo);
    const committed = await runGit(["commit", "-m", "add submodule"], repo);
    assert.equal(committed.code, 0, committed.stderr || committed.stdout);

    const deinitialized = await runGit(
      ["submodule", "deinit", "-f", "--", "vendor/dependency"],
      repo,
    );
    assert.equal(deinitialized.code, 0, deinitialized.stderr || deinitialized.stdout);
    await fs.mkdir(submodulePath, { recursive: true });
    assert.deepEqual(await fs.readdir(submodulePath), []);

    const admission = await captureGitEvidenceAuthority(repo);
    assert.ok(admission);
    assert.deepEqual(admission.submodules, []);
    assert.equal(admission.uninitializedGitlinks.length, 1);
    assert.equal(admission.uninitializedGitlinks[0]?.path, "vendor/dependency");
    assert.equal(admission.uninitializedGitlinks[0]?.pathState.kind, "empty-directory");

    await t.test("new bytes under an admitted empty gitlink", async () => {
      const authority = await captureGitEvidenceAuthority(repo);
      assert.ok(authority);
      const introduced = path.join(submodulePath, "introduced.txt");
      await fs.writeFile(introduced, "introduced\n", "utf8");
      try {
        await assert.rejects(
          () => assertGitEvidenceAuthority(authority),
          /populated uninitialized submodule worktree/,
        );
      } finally {
        await fs.rm(introduced, { force: true });
      }
    });

    await t.test("empty gitlink directory replacement", async () => {
      const authority = await captureGitEvidenceAuthority(repo);
      assert.ok(authority);
      const savedPath = `${submodulePath}-saved`;
      await fs.rename(submodulePath, savedPath);
      await fs.mkdir(submodulePath, { recursive: true });
      try {
        await assert.rejects(
          () => collectTrustedWorktreeChanges(authority),
          /uninitialized submodule worktree state differs/,
        );
      } finally {
        await fs.rm(submodulePath, { recursive: true, force: true });
        await fs.rename(savedPath, submodulePath);
      }
    });

    await t.test("missing gitlink becomes populated", async () => {
      await fs.rm(submodulePath, { recursive: true, force: true });
      const authority = await captureGitEvidenceAuthority(repo);
      assert.ok(authority);
      assert.equal(authority.uninitializedGitlinks[0]?.pathState.kind, "missing");
      await fs.mkdir(submodulePath, { recursive: true });
      const introduced = path.join(submodulePath, "introduced.txt");
      await fs.writeFile(introduced, "introduced\n", "utf8");
      try {
        await assert.rejects(
          () => assertGitEvidenceAuthority(authority),
          /populated uninitialized submodule worktree/,
        );
      } finally {
        await fs.rm(submodulePath, { recursive: true, force: true });
        await fs.mkdir(submodulePath, { recursive: true });
      }
    });

    await t.test("uninitialized gitlink redirect", async (redirectTest) => {
      const authority = await captureGitEvidenceAuthority(repo);
      assert.ok(authority);
      const outsideRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "sol-luna-git-uninitialized-redirect-"),
      );
      const savedPath = `${submodulePath}-saved`;
      let linked = false;
      await fs.rename(submodulePath, savedPath);
      try {
        try {
          await fs.symlink(
            outsideRoot,
            submodulePath,
            process.platform === "win32" ? "junction" : "dir",
          );
          linked = true;
        } catch {
          redirectTest.skip("directory links are not permitted on this machine");
          return;
        }
        await assert.rejects(
          () => collectTrustedWorktreeChanges(authority),
          /redirected uninitialized submodule worktree/,
        );
      } finally {
        if (linked) await fs.unlink(submodulePath).catch(() => undefined);
        await fs.rename(savedPath, submodulePath).catch(() => undefined);
        await fs.rm(outsideRoot, { recursive: true, force: true });
      }
    });
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(submoduleSource, { recursive: true, force: true });
  }
});

test("trusted evidence rejects real submodule Git control mutation after authority capture", async (t) => {
  const repo = await initFixtureRepo("sol-luna-git-submodule-super-");
  const submoduleSource = await initFixtureRepo("sol-luna-git-submodule-source-");
  try {
    await fs.writeFile(
      path.join(submoduleSource, "dependency.txt"),
      "dependency\n",
      "utf8",
    );
    await runGit(["add", "."], submoduleSource);
    const submoduleCommit = await runGit(
      ["commit", "-m", "submodule fixture"],
      submoduleSource,
    );
    assert.equal(
      submoduleCommit.code,
      0,
      submoduleCommit.stderr || submoduleCommit.stdout,
    );

    await fs.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await runGit(["add", "."], repo);
    const baseCommit = await runGit(["commit", "-m", "super fixture"], repo);
    assert.equal(baseCommit.code, 0, baseCommit.stderr || baseCommit.stdout);

    const submodulePath = path.join(repo, "vendor", "dependency");
    const added = await runGit(
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        submoduleSource,
        "vendor/dependency",
      ],
      repo,
    );
    assert.equal(added.code, 0, added.stderr || added.stdout);
    await runGit(["add", ".gitmodules", "vendor/dependency"], repo);
    const committed = await runGit(["commit", "-m", "add local submodule"], repo);
    assert.equal(committed.code, 0, committed.stderr || committed.stdout);

    const initialAuthority = await captureGitEvidenceAuthority(repo);
    assert.ok(initialAuthority);
    const rawSubmoduleGitDir = (
      await git(["rev-parse", "--git-dir"], submodulePath)
    ).trim();
    const submoduleGitDir = path.normalize(
      path.isAbsolute(rawSubmoduleGitDir)
        ? rawSubmoduleGitDir
        : path.resolve(submodulePath, rawSubmoduleGitDir),
    );
    const modulesRoot = path.normalize(
      path.join(initialAuthority.commonGitDir, "modules"),
    );
    const relativeSubmoduleGitDir = path.relative(modulesRoot, submoduleGitDir);
    assert.ok(
      relativeSubmoduleGitDir !== "" &&
        relativeSubmoduleGitDir !== ".." &&
        !relativeSubmoduleGitDir.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeSubmoduleGitDir),
      `${submoduleGitDir} should be stored under ${modulesRoot}`,
    );

    const submoduleHead = (await git(["rev-parse", "HEAD"], submodulePath)).trim();
    const mutations: Array<{
      name: string;
      apply(): Promise<() => Promise<void>>;
    }> = [
      {
        name: "config",
        apply: async () => {
          const target = path.join(submoduleGitDir, "config");
          const original = await fs.readFile(target);
          await fs.appendFile(target, "\n[sol-luna]\n\tprobe = true\n", "utf8");
          return () => fs.writeFile(target, original);
        },
      },
      {
        name: "hook",
        apply: async () => {
          const target = path.join(submoduleGitDir, "hooks", "sol-luna-probe");
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, "probe\n", "utf8");
          return () => fs.rm(target, { force: true });
        },
      },
      {
        name: "ref",
        apply: async () => {
          const target = path.join(submoduleGitDir, "refs", "heads", "sol-luna-probe");
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, `${submoduleHead}\n`, "utf8");
          return () => fs.rm(target, { force: true });
        },
      },
      {
        name: "index",
        apply: async () => {
          const target = path.join(submoduleGitDir, "index");
          const original = await fs.readFile(target);
          await fs.writeFile(target, Buffer.concat([original, Buffer.from([0])]));
          return () => fs.writeFile(target, original);
        },
      },
      {
        name: "HEAD control",
        apply: async () => {
          const target = path.join(submoduleGitDir, "HEAD");
          const original = await fs.readFile(target);
          await fs.writeFile(target, Buffer.concat([original, Buffer.from("\n")]));
          return () => fs.writeFile(target, original);
        },
      },
      {
        name: "index lock",
        apply: async () => {
          const target = path.join(submoduleGitDir, "index.lock");
          await fs.writeFile(target, "stale\n", "utf8");
          return () => fs.rm(target, { force: true });
        },
      },
    ];

    for (const mutation of mutations) {
      await t.test(mutation.name, async () => {
        const authority = await captureGitEvidenceAuthority(repo);
        assert.ok(authority);
        const restore = await mutation.apply();
        try {
          await assert.rejects(
            () => collectTrustedWorktreeChanges(authority),
            /Git evidence authority changed: repository config\/refs\/hooks\/info or lock state was modified/,
          );
        } finally {
          await restore();
        }
      });
    }

    await t.test("post-capture submodule gitfile redirect", async () => {
      const authority = await captureGitEvidenceAuthority(repo);
      assert.ok(authority);
      const controlPath = path.join(submodulePath, ".git");
      const savedControlPath = `${controlPath}.saved`;
      const externalGitDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "sol-luna-git-submodule-gitfile-redirect-"),
      );
      await fs.rename(controlPath, savedControlPath);
      try {
        await fs.writeFile(controlPath, `gitdir: ${externalGitDir}\n`, "utf8");
        await assert.rejects(
          () => collectTrustedWorktreeChanges(authority),
          /worktree \.git was modified/,
        );
      } finally {
        await fs.rm(controlPath, { force: true });
        await fs.rename(savedControlPath, controlPath);
        await fs.rm(externalGitDir, { recursive: true, force: true });
      }
    });

    await t.test(
      "redirected submodule worktree is rejected before traversal",
      async (redirectTest) => {
        const authority = await captureGitEvidenceAuthority(repo);
        assert.ok(authority);
        const outsideRoot = await fs.mkdtemp(
          path.join(os.tmpdir(), "sol-luna-git-submodule-worktree-redirect-"),
        );
        const backupPath = `${submodulePath}-saved`;
        let linked = false;
        await fs.rename(submodulePath, backupPath);
        try {
          try {
            await fs.symlink(
              outsideRoot,
              submodulePath,
              process.platform === "win32" ? "junction" : "dir",
            );
            linked = true;
          } catch {
            redirectTest.skip("directory links are not permitted on this machine");
            return;
          }
          await assert.rejects(
            () => collectTrustedWorktreeChanges(authority),
            /cannot trust redirected submodule worktree/,
          );
        } finally {
          if (linked) await fs.unlink(submodulePath).catch(() => undefined);
          await fs.rename(backupPath, submodulePath).catch(() => undefined);
          await fs.rm(outsideRoot, { recursive: true, force: true });
        }
      },
    );

    await t.test("redirected modules container", async (redirectTest) => {
      const authority = await captureGitEvidenceAuthority(repo);
      assert.ok(authority);
      const outsideRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "sol-luna-git-submodule-redirect-"),
      );
      const externalModules = path.join(outsideRoot, "modules");
      let linked = false;
      try {
        await fs.rename(modulesRoot, externalModules);
        try {
          await fs.symlink(
            externalModules,
            modulesRoot,
            process.platform === "win32" ? "junction" : "dir",
          );
          linked = true;
        } catch {
          redirectTest.skip("directory links are not permitted on this machine");
          return;
        }

        await assert.rejects(
          () => collectTrustedWorktreeChanges(authority),
          /cannot trust redirected submodule Git control metadata/,
        );
      } finally {
        if (linked) {
          await fs.rm(modulesRoot, { recursive: true, force: true });
        }
        if (await fs.lstat(externalModules).catch(() => null)) {
          await fs.rename(externalModules, modulesRoot);
        }
        await fs.rm(outsideRoot, { recursive: true, force: true });
      }
    });
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(submoduleSource, { recursive: true, force: true });
  }
});

test("explicit real --git-dir cannot invisibly redirect the private worker index", async () => {
  const repo = await initFixtureRepo("sol-luna-git-real-index-");
  let isolated:
    Awaited<ReturnType<typeof createIsolatedWorkerGitEnvironment>> | undefined;
  try {
    await fs.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await runGit(["add", "."], repo);
    const committed = await runGit(["commit", "-m", "fixture"], repo);
    assert.equal(committed.code, 0, committed.stderr || committed.stdout);

    const authority = await captureGitEvidenceAuthority(repo);
    assert.ok(authority);
    isolated = await createIsolatedWorkerGitEnvironment(authority, repo);
    const realIndex = path.join(authority.gitDir, "index");
    const realGitArgs = [
      "--git-dir",
      authority.gitDir,
      "--work-tree",
      repo,
      "update-index",
      "--force-remove",
      "tracked.txt",
    ];

    // A real --git-dir alone must still use the worker's explicitly pinned
    // private index rather than the operator repository's index.
    await git(realGitArgs, repo, isolated.env);
    assert.equal((await git(["status", "--porcelain"], repo)).trim(), "");

    // Delegated code can explicitly override environment variables in its own
    // command. If it points GIT_INDEX_FILE at the real index too, the mutation
    // is possible but must invalidate authority before trusted evidence runs.
    await git(realGitArgs, repo, {
      ...isolated.env,
      GIT_INDEX_FILE: realIndex,
    });
    const operatorStatus = (await git(["status", "--porcelain"], repo))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    assert.deepEqual(operatorStatus.sort(), ["?? tracked.txt", "D  tracked.txt"].sort());
    await assert.rejects(
      () => collectTrustedWorktreeChanges(authority),
      /Git evidence authority changed: worktree Git control\/index metadata or lock state was modified/,
    );
  } finally {
    await isolated?.cleanup().catch(() => undefined);
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("linked-worktree real index state is authority-bearing", async () => {
  const repo = await initFixtureRepo("sol-luna-git-linked-index-");
  const linked = `${repo}-linked`;
  let isolated:
    Awaited<ReturnType<typeof createIsolatedWorkerGitEnvironment>> | undefined;
  try {
    await fs.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
    await runGit(["add", "."], repo);
    const committed = await runGit(["commit", "-m", "fixture"], repo);
    assert.equal(committed.code, 0, committed.stderr || committed.stdout);
    const added = await runGit(["worktree", "add", "--detach", linked, "HEAD"], repo);
    assert.equal(added.code, 0, added.stderr || added.stdout);

    const authority = await captureGitEvidenceAuthority(linked);
    assert.ok(authority);
    assert.equal(authority.gitControlKind, "file");
    isolated = await createIsolatedWorkerGitEnvironment(authority, linked);
    await git(
      [
        "--git-dir",
        authority.gitDir,
        "--work-tree",
        linked,
        "update-index",
        "--force-remove",
        "tracked.txt",
      ],
      linked,
      {
        ...isolated.env,
        GIT_INDEX_FILE: path.join(authority.gitDir, "index"),
      },
    );

    await assert.rejects(
      () => collectTrustedWorktreeChanges(authority),
      /Git evidence authority changed: worktree Git control\/index metadata or lock state was modified/,
    );
  } finally {
    await isolated?.cleanup().catch(() => undefined);
    await runGit(["worktree", "remove", "--force", linked], repo).catch(() => undefined);
    await fs.rm(linked, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("trusted evidence rejects stale ref, config, and index locks", async (t) => {
  const cases = [
    {
      name: "ref lock",
      lockPath: async (
        repo: string,
        authority: NonNullable<Awaited<ReturnType<typeof captureGitEvidenceAuthority>>>,
      ) => {
        const headRef = (await git(["symbolic-ref", "HEAD"], repo)).trim();
        return path.join(authority.commonGitDir, ...headRef.split("/")) + ".lock";
      },
      expected: /repository config\/refs\/hooks\/info or lock state was modified/,
    },
    {
      name: "config lock",
      lockPath: async (
        _repo: string,
        authority: NonNullable<Awaited<ReturnType<typeof captureGitEvidenceAuthority>>>,
      ) => path.join(authority.commonGitDir, "config.lock"),
      expected: /repository config\/refs\/hooks\/info or lock state was modified/,
    },
    {
      name: "index lock",
      lockPath: async (
        _repo: string,
        authority: NonNullable<Awaited<ReturnType<typeof captureGitEvidenceAuthority>>>,
      ) => path.join(authority.gitDir, "index.lock"),
      expected: /worktree Git control\/index metadata or lock state was modified/,
    },
  ];

  for (const lockCase of cases) {
    await t.test(lockCase.name, async () => {
      const repo = await initFixtureRepo(
        `sol-luna-git-${lockCase.name.replace(" ", "-")}-`,
      );
      try {
        await fs.writeFile(path.join(repo, "tracked.txt"), "base\n", "utf8");
        await runGit(["add", "."], repo);
        const committed = await runGit(["commit", "-m", "fixture"], repo);
        assert.equal(committed.code, 0, committed.stderr || committed.stdout);
        const authority = await captureGitEvidenceAuthority(repo);
        assert.ok(authority);

        const lockPath = await lockCase.lockPath(repo, authority);
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
        await fs.writeFile(lockPath, "stale\n", "utf8");
        await assert.rejects(
          () => collectTrustedWorktreeChanges(authority),
          lockCase.expected,
        );
      } finally {
        await fs.rm(repo, { recursive: true, force: true });
      }
    });
  }
});

test("runGit fails closed when stdout exceeds its byte budget", async () => {
  const repo = await initFixtureRepo("sol-luna-git-output-");
  try {
    const large = path.join(repo, "large.bin");
    await fs.writeFile(large, Buffer.alloc(MAX_GIT_OUTPUT_BYTES + 1024, 0x61));
    const objectId = (await git(["hash-object", "-w", "large.bin"], repo)).trim();

    const result = await runGit(["cat-file", "blob", objectId], repo);
    assert.equal(result.code, null);
    assert.match(result.stderr, /git stdout exceeded \d+ bytes/);
    assert.ok(
      Buffer.byteLength(result.stdout, "utf8") <= MAX_GIT_OUTPUT_BYTES,
      "captured stdout must stay within the configured byte budget",
    );
  } finally {
    await fs.rm(repo, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 5 : 0,
      retryDelay: 100,
    });
  }
});
