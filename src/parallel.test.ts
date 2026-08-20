/**
 * Parallel orchestration tests.
 *
 * These run offline. The scheduling, isolation, integration and cleanup logic is
 * exercised with an injected executor, so CI can cover the parts most likely to
 * corrupt a workspace without spending a single model call. Worktree tests use a
 * real temporary git repository, because the failure modes worth catching here
 * are git's and the filesystem's, not a mock's.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BatchRejectedError, runBatch } from "./batch.js";
import {
  MAX_BATCH_SIZE,
  MAX_PARALLEL,
  MAX_PARALLEL_LIMIT,
  WORKTREE_DIR,
  clampParallel,
} from "./config.js";
import {
  delegateTaskInputSchema,
  type BatchOutput,
  type DelegateTaskInput,
  type DelegateTaskOutput,
} from "./contract.js";
import { runGit } from "./git.js";
import {
  expandGlob,
  findIntegrationConflicts,
  findScopeConflicts,
  scopesOverlap,
} from "./overlap.js";
import {
  cleanupWorktree,
  createTaskWorktree,
  linkSharedDirectories,
  prepareWorktreeBase,
  pruneStaleWorktrees,
  worktreeMetadataQueue,
  WorktreeUnavailableError,
} from "./worktree.js";

// --- Scope overlap ----------------------------------------------------------

test("globs expand into concrete example paths", () => {
  assert.ok(expandGlob("src/auth/**").some((p) => p.startsWith("src/auth")));
  assert.deepEqual(expandGlob("src/*.ts"), ["src/sample.ts"]);
  // `**` must also stand for nothing, or `src/**` and `src` look disjoint.
  assert.ok(expandGlob("src/**").includes("src"));
});

test("disjoint module scopes do not overlap", () => {
  assert.equal(scopesOverlap(["src/auth/**"], ["src/payments/**"]), false);
  assert.equal(scopesOverlap(["src/a.ts"], ["src/b.ts"]), false);
  assert.equal(scopesOverlap(["docs/**"], ["src/**"]), false);
});

test("a broader scope overlaps a narrower one", () => {
  assert.equal(scopesOverlap(["src/auth/**"], ["src/**"]), true);
  assert.equal(scopesOverlap(["src/**"], ["src/auth/login.ts"]), true);
  assert.equal(scopesOverlap(["src/auth/**"], ["src/auth/**"]), true);
});

test("an unrestricted scope overlaps everything", () => {
  assert.equal(scopesOverlap([], ["src/auth/**"]), true);
  assert.equal(scopesOverlap(["src/auth/**"], []), true);
});

test("a single-segment wildcard does not reach into subdirectories", () => {
  // `src/*.ts` cannot match `src/auth/x.ts`, so these are genuinely disjoint.
  assert.equal(scopesOverlap(["src/*.ts"], ["src/auth/**"]), false);
});

test("brace and extension patterns are compared sensibly", () => {
  assert.equal(scopesOverlap(["src/**/*.{ts,tsx}"], ["src/auth/**"]), true);
  assert.equal(scopesOverlap(["src/**/*.ts"], ["docs/**/*.md"]), false);
});

test("scope conflicts name both offending tasks", () => {
  const conflicts = findScopeConflicts([
    { allowedFiles: ["src/auth/**"], label: "t1" },
    { allowedFiles: ["src/payments/**"], label: "t2" },
    { allowedFiles: ["src/**"], label: "t3" },
  ]);
  // t3 collides with both others; t1 and t2 do not collide with each other.
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.every((conflict) => conflict.second === 2));
});

test("integration conflicts are found from what workers actually changed", () => {
  const conflicts = findIntegrationConflicts([
    { taskId: "t1", changedFiles: ["src/a.ts", "shared/util.ts"] },
    { taskId: "t2", changedFiles: ["src/b.ts", "shared/util.ts"] },
    { taskId: "t3", changedFiles: ["src/c.ts"] },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.path, "shared/util.ts");
  assert.deepEqual(conflicts[0]?.tasks, ["t1", "t2"]);
});

test("disjoint changes produce no integration conflict", () => {
  assert.deepEqual(
    findIntegrationConflicts([
      { taskId: "t1", changedFiles: ["src/a.ts"] },
      { taskId: "t2", changedFiles: ["src/b.ts"] },
    ]),
    [],
  );
});

// --- Parallelism limits -----------------------------------------------------

test("parallelism is clamped to a sane range", () => {
  assert.equal(clampParallel(3), 3);
  assert.equal(clampParallel(0), 1);
  assert.equal(clampParallel(-5), 1);
  assert.equal(clampParallel(Number.NaN), 1);
  assert.equal(clampParallel(2.7), 2);
  assert.equal(clampParallel(9999), MAX_PARALLEL_LIMIT);
});

// --- Test helpers -----------------------------------------------------------

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-repo-"));
  const real = await fs.realpath(dir);
  await runGit(["init"], real);
  // Never depend on the machine's global git identity.
  await runGit(["config", "user.email", "test@example.invalid"], real);
  await runGit(["config", "user.name", "Orchestrator Test"], real);
  await runGit(["config", "commit.gpgsign", "false"], real);
  // Keep fixture bytes identical on every platform; autocrlf would rewrite
  // line endings on checkout and make content assertions Windows-specific.
  await runGit(["config", "core.autocrlf", "false"], real);
  await fs.writeFile(path.join(real, "README.md"), "# fixture\n", "utf8");
  await fs.mkdir(path.join(real, "src"), { recursive: true });
  await fs.writeFile(path.join(real, "src", "base.txt"), "base\n", "utf8");
  await runGit(["add", "."], real);
  await runGit(["commit", "-m", "initial"], real);
  return real;
}

const cleanupRepo = async (dir: string): Promise<void> => {
  await fs
    .rm(dir, { recursive: true, force: true, maxRetries: 3 })
    .catch(() => undefined);
};

/**
 * Render a batch result as per-task evidence.
 *
 * A CI failure that says only `1 !== 2` costs an entire investigation cycle to
 * turn into a hypothesis. Attaching this to the count assertions means the log
 * already names which task fell over and why.
 *
 * Objectives and file paths are fixture data, so there is nothing sensitive to
 * withhold; worker output is not included.
 */
function describeBatch(result: BatchOutput): string {
  const lines = [
    `batch ${result.batchId}: ${result.passed} passed / ${result.failed} failed ` +
      `of ${result.taskCount} (mode ${result.mode}, maxParallel ${result.maxParallel}, ` +
      `integrated ${result.integrated})`,
  ];
  for (const task of result.tasks) {
    lines.push(
      `  ${task.taskId}: state=${task.state} verdict=${task.result?.verdict ?? "none"} ` +
        `changed=[${task.changedFiles.join(", ")}] ` +
        `worktree=${task.worktreePath ?? "removed"}`,
    );
    if (task.error) lines.push(`      error: ${task.error}`);
    for (const warning of task.warnings) lines.push(`      warning: ${warning}`);
  }
  if (result.integrationConflicts.length > 0) {
    lines.push(
      `  integration conflicts: ${result.integrationConflicts
        .map((conflict) => `${conflict.path} (${conflict.tasks.join(" + ")})`)
        .join(", ")}`,
    );
  }
  for (const warning of result.warnings) lines.push(`  batch warning: ${warning}`);
  return lines.join("\n");
}

const makeTask = (overrides: Partial<DelegateTaskInput> = {}): DelegateTaskInput =>
  delegateTaskInputSchema.parse({
    objective: "Do a bounded piece of work in the assigned module.",
    effortReason: "Bounded implementation work.",
    acceptanceCriteria: ["It works."],
    ...overrides,
  });

const makeOutput = (overrides: Partial<DelegateTaskOutput> = {}): DelegateTaskOutput =>
  ({
    verdict: "PASS",
    workerClaimedStatus: "PASS",
    trustworthy: true,
    workerThreadId: "thread-x",
    model: "gpt-5.6-luna",
    effort: "high",
    effortReason: "because",
    attempt: 1,
    summary: "did the work",
    notes: "",
    followUps: [],
    filesChanged: [],
    verification: [],
    verificationMode: "allowlist",
    scopeViolations: [],
    discrepancies: [],
    reviewChecklist: [],
    escalationAdvice: null,
    durationSeconds: 1,
    usage: null,
    errors: [],
    ...overrides,
  }) as DelegateTaskOutput;

/**
 * The module a task owns, taken from its declared scope: `src/auth/**` -> auth.
 *
 * Fixtures key off this rather than off the order the executor happens to be
 * called in. Workers run concurrently, so invocation order is not input order —
 * a fixture that assumed it was would silently attribute one task's behaviour to
 * another and fail for a reason that has nothing to do with the code under test.
 */
function moduleOf(task: DelegateTaskInput): string {
  const scope = task.allowedFiles[0] ?? "";
  const segments = scope.split("/").filter((part) => part && !part.includes("*"));
  return segments.at(-1) ?? task.objective;
}

/**
 * An executor that writes the files it claims to have written, so integration
 * and conflict detection are exercised against a real filesystem.
 *
 * `writes` and `fail` receive the task itself, never a scheduling index.
 */
function fakeExecutor(options: {
  writes?: (task: DelegateTaskInput) => Record<string, string>;
  fail?: (task: DelegateTaskInput) => boolean;
  delayMs?: number;
  onConcurrency?: (active: number) => void;
  barrier?: (active: number, release: () => void) => void;
}) {
  let active = 0;

  return async (
    input: DelegateTaskInput,
    execOptions: { workingDirectory: string; signal?: AbortSignal },
  ): Promise<DelegateTaskOutput> => {
    active += 1;
    options.onConcurrency?.(active);
    try {
      if (options.barrier) {
        await new Promise<void>((resolve) => options.barrier!(active, resolve));
      } else {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 25));
      }
      if (options.fail?.(input)) {
        throw new Error(`worker for ${moduleOf(input)} exploded`);
      }

      const writes = options.writes?.(input) ?? {};
      const changed: DelegateTaskOutput["filesChanged"] = [];
      for (const [relative, content] of Object.entries(writes)) {
        const target = path.join(execOptions.workingDirectory, ...relative.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
        changed.push({ path: relative, kind: "add", why: "test", observed: true });
      }
      return makeOutput({ effort: input.effort, filesChanged: changed });
    } finally {
      active -= 1;
    }
  };
}

// --- Worktree lifecycle -----------------------------------------------------

test("a clean repository can host worktrees", async () => {
  const repo = await makeRepo();
  try {
    const base = await prepareWorktreeBase(repo, [["src/**"]]);
    assert.equal(base.repoRoot, repo);
    assert.match(base.baseCommit, /^[0-9a-f]{7,40}$/);
    assert.deepEqual(base.dirtyPaths, []);
  } finally {
    await cleanupRepo(repo);
  }
});

test("a directory outside any repository is refused with a remedy", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-plain-"));
  try {
    await assert.rejects(
      prepareWorktreeBase(await fs.realpath(plain), [["src/**"]]),
      (error: Error) => {
        assert.ok(error instanceof WorktreeUnavailableError);
        assert.match(error.message, /not inside a git repository/);
        assert.match(error.message, /sequential/);
        return true;
      },
    );
  } finally {
    await cleanupRepo(plain);
  }
});

test("a repository with no commits is refused", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-empty-"));
  const real = await fs.realpath(dir);
  try {
    await runGit(["init"], real);
    await assert.rejects(prepareWorktreeBase(real, [["src/**"]]), /no commits yet/);
  } finally {
    await cleanupRepo(real);
  }
});

test("uncommitted work inside a task scope blocks parallel delegation", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "src", "base.txt"), "locally edited\n", "utf8");

    await assert.rejects(prepareWorktreeBase(repo, [["src/**"]]), (error: Error) => {
      assert.ok(error instanceof WorktreeUnavailableError);
      assert.match(error.message, /uncommitted changes/);
      assert.match(error.message, /src\/base\.txt/);
      // The remedy must be actionable, not just a complaint.
      assert.match(error.message, /Commit or stash|sequential|SOL_LUNA_ALLOW_DIRTY/);
      return true;
    });
  } finally {
    await cleanupRepo(repo);
  }
});

test("uncommitted work outside every task scope is allowed but reported", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "notes.txt"), "scratch\n", "utf8");
    const base = await prepareWorktreeBase(repo, [["src/**"]]);
    assert.ok(base.dirtyPaths.includes("notes.txt"));
  } finally {
    await cleanupRepo(repo);
  }
});

test("the dirty-tree guard can be overridden deliberately", async () => {
  const repo = await makeRepo();
  try {
    await fs.writeFile(path.join(repo, "src", "base.txt"), "edited\n", "utf8");
    const base = await prepareWorktreeBase(repo, [["src/**"]], true);
    assert.ok(base.dirtyPaths.length > 0);
  } finally {
    await cleanupRepo(repo);
  }
});

test("a worktree is created, isolated, and removed again", async () => {
  const repo = await makeRepo();
  try {
    const base = await prepareWorktreeBase(repo, [["src/**"]]);
    const worktree = await createTaskWorktree(base, "t1-demo", repo);

    // It has the committed content...
    assert.equal(
      await fs.readFile(path.join(worktree.path, "src", "base.txt"), "utf8"),
      "base\n",
    );

    // ...and edits inside it do not reach the main workspace.
    await fs.writeFile(
      path.join(worktree.path, "src", "base.txt"),
      "worker edit\n",
      "utf8",
    );
    assert.equal(await fs.readFile(path.join(repo, "src", "base.txt"), "utf8"), "base\n");

    const cleanup = await cleanupWorktree(worktree, "success", "never");
    assert.equal(cleanup.removed, true);
    assert.equal(await fs.stat(worktree.path).catch(() => null), null);
  } finally {
    await cleanupRepo(repo);
  }
});

test("the runtime directory is excluded from git rather than left untracked", async () => {
  const repo = await makeRepo();
  try {
    const base = await prepareWorktreeBase(repo, [["src/**"]]);
    const worktree = await createTaskWorktree(base, "t1-exclude", repo);

    const status = await runGit(["status", "--porcelain"], repo);
    assert.ok(
      !status.stdout.includes(".sol-luna"),
      `worktree dir polluted git status:\n${status.stdout}`,
    );

    await cleanupWorktree(worktree, "success", "never");
  } finally {
    await cleanupRepo(repo);
  }
});

test("a failed worktree is kept for inspection, a successful one is not", async () => {
  const repo = await makeRepo();
  try {
    const base = await prepareWorktreeBase(repo, [["src/**"]]);

    const kept = await createTaskWorktree(base, "t1-keep", repo);
    const keptResult = await cleanupWorktree(kept, "failure", "onfailure");
    assert.equal(keptResult.removed, false);
    assert.equal(keptResult.keptAt, kept.path);
    assert.ok(await fs.stat(kept.path).catch(() => null));

    const dropped = await createTaskWorktree(base, "t2-drop", repo);
    const droppedResult = await cleanupWorktree(dropped, "success", "onfailure");
    assert.equal(droppedResult.removed, true);

    // Clean up the deliberately kept one.
    await cleanupWorktree(kept, "success", "never");
  } finally {
    await cleanupRepo(repo);
  }
});

test("dependency directories are linked in, and unlinking never eats the original", async () => {
  const repo = await makeRepo();
  try {
    const modules = path.join(repo, "node_modules", "left-pad");
    await fs.mkdir(modules, { recursive: true });
    await fs.writeFile(path.join(modules, "index.js"), "module.exports=1;\n", "utf8");

    const base = await prepareWorktreeBase(repo, [["src/**"]]);
    const worktree = await createTaskWorktree(base, "t1-link", repo);

    const linked = path.join(worktree.path, "node_modules", "left-pad", "index.js");
    const linkStat = await fs.stat(linked).catch(() => null);

    if (!linkStat) {
      // Some environments forbid links entirely; the warning must say so.
      assert.ok(
        worktree.warnings.some((warning) => /Could not link/.test(warning)),
        "a failure to link must be reported, not silent",
      );
    } else {
      assert.equal(await fs.readFile(linked, "utf8"), "module.exports=1;\n");
    }

    await cleanupWorktree(worktree, "success", "never");

    // The real dependency tree must survive the worktree being deleted.
    assert.equal(
      await fs.readFile(path.join(modules, "index.js"), "utf8"),
      "module.exports=1;\n",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("stale worktrees from a crashed run are pruned, and only ours", async () => {
  const repo = await makeRepo();
  const userWorktree = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "user-wt-")),
    "wt",
  );
  try {
    const base = await prepareWorktreeBase(repo, [["src/**"]]);
    const stale = await createTaskWorktree(base, "t1-stale", repo);

    // A worktree the user made themselves, outside our runtime directory.
    await runGit(["worktree", "add", "--detach", userWorktree, base.baseCommit], repo);

    const removed = await pruneStaleWorktrees(repo);
    assert.ok(removed.some((entry) => entry === stale.path));
    assert.ok(
      await fs.stat(userWorktree).catch(() => null),
      "a user's own worktree must never be pruned",
    );

    await runGit(["worktree", "remove", "--force", userWorktree], repo);
  } finally {
    await cleanupRepo(repo);
    await cleanupRepo(path.dirname(userWorktree));
  }
});

// --- Batch orchestration ----------------------------------------------------

test("a parallel batch isolates workers and integrates disjoint results", async () => {
  const repo = await makeRepo();
  try {
    let peak = 0;
    const result = await runBatch(
      [
        makeTask({
          objective: "Implement the auth module fully.",
          allowedFiles: ["src/auth/**"],
        }),
        makeTask({
          objective: "Implement the payments module fully.",
          allowedFiles: ["src/payments/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: fakeExecutor({
          onConcurrency: (active) => {
            peak = Math.max(peak, active);
          },
          writes: (task): Record<string, string> =>
            moduleOf(task) === "auth"
              ? { "src/auth/login.ts": "export const login = () => true;\n" }
              : { "src/payments/charge.ts": "export const charge = () => true;\n" },
        }),
      },
    );

    assert.equal(result.mode, "parallel");
    assert.equal(result.passed, 2, describeBatch(result));
    assert.equal(result.failed, 0, describeBatch(result));
    assert.deepEqual(result.integrationConflicts, [], describeBatch(result));
    assert.equal(result.integrated, true, describeBatch(result));

    // Both workers really ran at once.
    assert.ok(peak > 1, `expected concurrent execution, peak was ${peak}`);
    assert.ok(peak <= MAX_PARALLEL, `peak ${peak} exceeded the configured limit`);

    // Their work landed in the real workspace.
    assert.match(
      await fs.readFile(path.join(repo, "src", "auth", "login.ts"), "utf8"),
      /login/,
    );
    assert.match(
      await fs.readFile(path.join(repo, "src", "payments", "charge.ts"), "utf8"),
      /charge/,
    );
  } finally {
    await cleanupRepo(repo);
  }
});

// --- Regression: concurrent worktree registration ---------------------------
//
// `git worktree add` walks the shared `.git/worktrees` directory. Two running at
// once made one abort reading the other's half-written metadata:
//
//     fatal: failed to read .git/worktrees/t5-.../commondir: No error
//
// The victim's task ended with no result at all, so a batch that should have
// reported 2 passed reported 1. It reproduced roughly once per thousand
// creations, which is exactly often enough to fail CI and not often enough to
// fail locally. These tests pin the invariant rather than the odds.

test("worktree registration never overlaps, however concurrently it is requested", async () => {
  const repo = await makeRepo();
  try {
    const base = await prepareWorktreeBase(repo, [["src/**"]]);

    // Fan out deliberately: this is the exact call pattern that used to race.
    const worktrees = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        createTaskWorktree(base, `race-${index}`, repo),
      ),
    );

    assert.equal(worktrees.length, 6);
    assert.equal(
      new Set(worktrees.map((worktree) => worktree.path)).size,
      6,
      "each task must get its own worktree",
    );
    for (const worktree of worktrees) {
      assert.ok(
        await fs.stat(path.join(worktree.path, "README.md")).catch(() => null),
        `${worktree.taskId} was registered but not checked out`,
      );
    }

    assert.equal(
      worktreeMetadataQueue.peakOverlap(),
      1,
      "two worktree metadata operations ran at the same time",
    );

    for (const worktree of worktrees) await cleanupWorktree(worktree, "success", "never");
  } finally {
    await cleanupRepo(repo);
  }
});

test("a batch builds every worktree before any worker starts, then runs them together", async () => {
  const repo = await makeRepo();
  const worktreeRoot = path.join(repo, ...WORKTREE_DIR.split("/"));
  try {
    let peak = 0;
    // How many worktrees existed the moment the first worker began. Under the
    // old design a worker could start while later worktrees were still being
    // created — which is precisely what made the creations concurrent.
    let treesAtFirstWorker = -1;

    const result = await runBatch(
      ["alpha", "beta", "gamma"].map((name) =>
        makeTask({
          objective: `Implement the ${name} module fully.`,
          allowedFiles: [`src/${name}/**`],
        }),
      ),
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: fakeExecutor({
          onConcurrency: (active) => {
            peak = Math.max(peak, active);
            if (treesAtFirstWorker < 0) {
              treesAtFirstWorker = readdirSync(worktreeRoot).length;
            }
          },
          writes: (task) => ({ [`src/${moduleOf(task)}/mod.ts`]: "x\n" }),
          delayMs: 60,
        }),
      },
    );

    assert.equal(result.passed, 3, describeBatch(result));
    assert.equal(result.failed, 0, describeBatch(result));

    assert.equal(
      treesAtFirstWorker,
      3,
      `all worktrees must exist before the first worker starts; saw ${treesAtFirstWorker}`,
    );

    // Setup was serialized...
    assert.equal(worktreeMetadataQueue.peakOverlap(), 1);
    // ...and the workers themselves were not. All three overlapped, which is
    // only possible if none of them was still waiting for a worktree.
    assert.equal(
      peak,
      Math.min(3, MAX_PARALLEL),
      `workers should run together; peak was ${peak}`,
    );

    for (const name of ["alpha", "beta", "gamma"]) {
      assert.ok(
        await fs.stat(path.join(repo, "src", name, "mod.ts")).catch(() => null),
        `${name} did not integrate\n${describeBatch(result)}`,
      );
    }

    assert.deepEqual(
      await fs.readdir(worktreeRoot).catch(() => []),
      [],
      "worktrees should be gone after a clean batch",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("a worktree that cannot be created fails only its own task", async () => {
  const repo = await makeRepo();
  try {
    // Serializing setup must not turn one task's problem into a batch-wide one.
    // A *locked* worktree whose directory is missing is the one case git refuses
    // to overwrite with a single `--force`, which gives a deterministic
    // per-task creation failure rather than a contrived one.
    const secondTaskId = "t2-implement-the-duo-module";
    const blocked = path.join(repo, ...WORKTREE_DIR.split("/"), secondTaskId);
    await fs.mkdir(path.dirname(blocked), { recursive: true });
    await runGit(["worktree", "add", "--detach", blocked, "HEAD"], repo);
    await runGit(["worktree", "lock", blocked], repo);
    await fs.rm(blocked, { recursive: true, force: true });

    const result = await runBatch(
      ["solo", "duo"].map((name) =>
        makeTask({
          objective: `Implement the ${name} module.`,
          allowedFiles: [`src/${name}/**`],
        }),
      ),
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: fakeExecutor({
          writes: (task) => ({ [`src/${moduleOf(task)}/mod.ts`]: "x\n" }),
        }),
      },
    );

    // If the id scheme ever changes this assertion fails loudly, rather than the
    // test quietly passing while blocking nothing.
    assert.equal(
      result.tasks[1]?.taskId,
      secondTaskId,
      `setup targeted the wrong task\n${describeBatch(result)}`,
    );

    assert.equal(result.passed, 1, describeBatch(result));
    assert.equal(result.failed, 1, describeBatch(result));
    assert.equal(result.tasks[1]?.state, "failed", describeBatch(result));
    assert.match(
      result.tasks[1]?.error ?? "",
      /Could not create an isolated worktree/,
      describeBatch(result),
    );

    // The healthy task still ran and its work still landed.
    assert.equal(result.tasks[0]?.result?.verdict, "PASS", describeBatch(result));
    assert.ok(
      await fs.stat(path.join(repo, "src", "solo", "mod.ts")).catch(() => null),
      describeBatch(result),
    );

    await runGit(["worktree", "unlock", blocked], repo).catch(() => undefined);
    await runGit(["worktree", "prune"], repo).catch(() => undefined);
  } finally {
    await cleanupRepo(repo);
  }
});

test("each task keeps its own effort", async () => {
  const repo = await makeRepo();
  try {
    const result = await runBatch(
      [
        makeTask({
          objective: "Mechanical rename across the api module.",
          effort: "medium",
          allowedFiles: ["src/api/**"],
        }),
        makeTask({
          objective: "Track down the flaky ordering bug.",
          effort: "xhigh",
          allowedFiles: ["src/queue/**"],
        }),
      ],
      { mode: "parallel", workingDirectory: repo, executor: fakeExecutor({}) },
    );

    assert.deepEqual(
      result.tasks.map((task) => task.effort),
      ["medium", "xhigh"],
    );
    assert.deepEqual(
      result.tasks.map((task) => task.result?.effort),
      ["medium", "xhigh"],
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("overlapping scopes are refused before any worker starts", async () => {
  const repo = await makeRepo();
  try {
    let started = false;
    await assert.rejects(
      runBatch(
        [
          makeTask({
            objective: "Work on the auth module here.",
            allowedFiles: ["src/auth/**"],
          }),
          makeTask({
            objective: "Work across the whole src tree.",
            allowedFiles: ["src/**"],
          }),
        ],
        {
          mode: "parallel",
          workingDirectory: repo,
          executor: async () => {
            started = true;
            return makeOutput();
          },
        },
      ),
      (error: Error) => {
        assert.ok(error instanceof BatchRejectedError);
        assert.match(error.message, /overlapping file scopes/);
        assert.match(error.message, /sequential|allowOverlappingScopes/);
        return true;
      },
    );
    assert.equal(started, false, "no worker may start once the batch is rejected");
  } finally {
    await cleanupRepo(repo);
  }
});

test("overlapping scopes can be accepted deliberately", async () => {
  const repo = await makeRepo();
  try {
    const result = await runBatch(
      [
        makeTask({
          objective: "Work on the auth module here.",
          allowedFiles: ["src/auth/**"],
        }),
        makeTask({
          objective: "Work across the whole src tree.",
          allowedFiles: ["src/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        allowOverlappingScopes: true,
        executor: fakeExecutor({}),
      },
    );
    assert.equal(result.scopeConflicts.length, 1);
    assert.equal(result.passed, 2);
  } finally {
    await cleanupRepo(repo);
  }
});

test("workers that touch the same file block integration instead of overwriting", async () => {
  const repo = await makeRepo();
  try {
    const result = await runBatch(
      [
        makeTask({
          objective: "Update the auth module and shared config.",
          allowedFiles: ["src/auth/**", "shared/**"],
        }),
        makeTask({
          objective: "Update the payments module and shared config.",
          allowedFiles: ["src/payments/**", "shared/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        allowOverlappingScopes: true,
        executor: fakeExecutor({
          writes: (task): Record<string, string> =>
            moduleOf(task) === "auth"
              ? { "src/auth/a.ts": "a\n", "shared/config.ts": "from-auth\n" }
              : { "src/payments/b.ts": "b\n", "shared/config.ts": "from-payments\n" },
        }),
      },
    );

    assert.equal(result.integrationConflicts.length, 1);
    assert.equal(result.integrationConflicts[0]?.path, "shared/config.ts");
    assert.equal(result.integrated, false);
    assert.match(result.integrationSummary, /Nothing was integrated/);

    // Nothing was copied, so neither version silently won.
    assert.equal(
      await fs.stat(path.join(repo, "shared", "config.ts")).catch(() => null),
      null,
    );
    assert.equal(
      await fs.stat(path.join(repo, "src", "auth", "a.ts")).catch(() => null),
      null,
    );

    // The evidence is preserved for a human to merge.
    assert.ok(result.tasks.every((task) => task.worktreePath));
    for (const task of result.tasks) {
      if (task.worktreePath)
        await fs.rm(task.worktreePath, { recursive: true, force: true });
    }
  } finally {
    await cleanupRepo(repo);
  }
});

test("one worker failing does not discard the others", async () => {
  const repo = await makeRepo();
  try {
    const result = await runBatch(
      [
        makeTask({
          objective: "Implement the first independent module.",
          allowedFiles: ["src/one/**"],
        }),
        makeTask({
          objective: "Implement the second independent module.",
          allowedFiles: ["src/two/**"],
        }),
        makeTask({
          objective: "Implement the third independent module.",
          allowedFiles: ["src/three/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: fakeExecutor({
          // Keyed on the task's own scope: whichever worker runs first, it is
          // always the `two` task that fails and always `one` that succeeds.
          fail: (task) => moduleOf(task) === "two",
          writes: (task) => ({ [`src/${moduleOf(task)}/mod.ts`]: "x\n" }),
        }),
      },
    );

    assert.equal(result.taskCount, 3, describeBatch(result));
    assert.equal(
      result.tasks.filter((task) => task.state === "failed").length,
      1,
      describeBatch(result),
    );
    assert.equal(
      result.tasks.filter((task) => task.state === "completed").length,
      2,
      describeBatch(result),
    );
    assert.match(
      result.tasks.find((task) => task.state === "failed")?.error ?? "",
      /exploded/,
    );

    // The successful work is still integrated.
    assert.ok(
      await fs.stat(path.join(repo, "src", "one", "mod.ts")).catch(() => null),
      describeBatch(result),
    );
    assert.ok(
      result.reviewChecklist.some((item) => /Partial success/.test(item)),
      "partial success must be called out, not buried",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("a cancelled batch starts nothing and leaves no worktrees behind", async () => {
  const repo = await makeRepo();
  try {
    const controller = new AbortController();
    controller.abort();

    let started = false;
    const result = await runBatch(
      [
        makeTask({
          objective: "First module of the cancelled batch.",
          allowedFiles: ["src/one/**"],
        }),
        makeTask({
          objective: "Second module of the cancelled batch.",
          allowedFiles: ["src/two/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        signal: controller.signal,
        executor: async () => {
          started = true;
          return makeOutput();
        },
      },
    );

    assert.equal(started, false);
    assert.ok(result.tasks.every((task) => task.state === "cancelled"));

    const worktreeRoot = path.join(repo, ".sol-luna", "worktrees");
    const leftovers = await fs.readdir(worktreeRoot).catch(() => []);
    assert.deepEqual(leftovers, [], "cancellation must not leave worktrees behind");
  } finally {
    await cleanupRepo(repo);
  }
});

test("mid-flight cancellation stops the remaining sequential tasks", async () => {
  const repo = await makeRepo();
  try {
    const controller = new AbortController();
    let calls = 0;

    const result = await runBatch(
      [
        makeTask({ objective: "First sequential step of the pipeline." }),
        makeTask({ objective: "Second sequential step of the pipeline." }),
        makeTask({ objective: "Third sequential step of the pipeline." }),
      ],
      {
        mode: "sequential",
        workingDirectory: repo,
        signal: controller.signal,
        executor: async () => {
          calls += 1;
          controller.abort();
          return makeOutput();
        },
      },
    );

    assert.equal(calls, 1, "no further tasks may start after cancellation");
    // The task that actually ran keeps its result; only the unstarted ones are
    // cancelled. Finished work is never discarded because the batch stopped.
    assert.equal(result.tasks[0]?.state, "completed");
    assert.equal(result.tasks.filter((task) => task.state === "cancelled").length, 2);
  } finally {
    await cleanupRepo(repo);
  }
});

test("sequential mode shares the workspace so later tasks see earlier work", async () => {
  const repo = await makeRepo();
  try {
    const seen: string[] = [];
    const result = await runBatch(
      [
        makeTask({ objective: "Create the shared groundwork file." }),
        makeTask({ objective: "Build on top of the groundwork file." }),
      ],
      {
        mode: "sequential",
        workingDirectory: repo,
        executor: async (_input, options) => {
          const marker = path.join(options.workingDirectory, "step.txt");
          const existing = await fs.readFile(marker, "utf8").catch(() => "");
          seen.push(existing);
          await fs.writeFile(marker, `${existing}step\n`, "utf8");
          return makeOutput({
            filesChanged: [{ path: "step.txt", kind: "add", why: "t", observed: true }],
          });
        },
      },
    );

    assert.deepEqual(
      seen,
      ["", "step\n"],
      "the second task must see the first task's write",
    );
    assert.equal(result.integrated, true);
    assert.match(result.integrationSummary, /already in place/);
  } finally {
    await cleanupRepo(repo);
  }
});

test("sequential mode needs no git repository at all", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-nogit-"));
  const real = await fs.realpath(plain);
  try {
    const result = await runBatch(
      [makeTask({ objective: "Do the work in a plain directory." })],
      {
        mode: "sequential",
        workingDirectory: real,
        executor: fakeExecutor({}),
      },
    );
    assert.equal(result.passed, 1);
  } finally {
    await cleanupRepo(real);
  }
});

test("parallel mode outside a git repository fails with a usable message", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-nogit2-"));
  const real = await fs.realpath(plain);
  try {
    await assert.rejects(
      runBatch(
        [
          makeTask({
            objective: "First module in a non-git directory.",
            allowedFiles: ["a/**"],
          }),
          makeTask({
            objective: "Second module in a non-git directory.",
            allowedFiles: ["b/**"],
          }),
        ],
        { mode: "parallel", workingDirectory: real, executor: fakeExecutor({}) },
      ),
      (error: Error) => {
        assert.ok(error instanceof BatchRejectedError);
        assert.match(error.message, /not inside a git repository/);
        return true;
      },
    );
  } finally {
    await cleanupRepo(real);
  }
});

test("oversized batches are refused", async () => {
  const repo = await makeRepo();
  try {
    const many = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, index) =>
      makeTask({ objective: `Independent module number ${index} implementation.` }),
    );
    await assert.rejects(
      runBatch(many, {
        mode: "sequential",
        workingDirectory: repo,
        executor: fakeExecutor({}),
      }),
      /at most \d+ tasks/,
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("an empty batch is refused", async () => {
  const repo = await makeRepo();
  try {
    await assert.rejects(
      runBatch([], {
        mode: "parallel",
        workingDirectory: repo,
        executor: fakeExecutor({}),
      }),
      /at least one task/,
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("batch results carry the structure a supervisor needs to act on", async () => {
  const repo = await makeRepo();
  try {
    const result = await runBatch(
      [
        makeTask({
          objective: "Implement one bounded module end to end.",
          allowedFiles: ["src/one/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: fakeExecutor({ writes: () => ({ "src/one/mod.ts": "x\n" }) }),
      },
    );

    assert.match(result.batchId, /^b[a-z0-9]+$/);
    assert.equal(typeof result.durationSeconds, "number");
    assert.ok(result.tasks[0]?.taskId);
    assert.deepEqual(result.tasks[0]?.changedFiles, ["src/one/mod.ts"]);
    assert.ok(result.tasks[0]?.diff !== undefined, "a worktree task should carry a diff");
    assert.ok(result.reviewChecklist.length > 0);
  } finally {
    await cleanupRepo(repo);
  }
});

test("linking is a no-op when there is nothing to link", async () => {
  const repo = await makeRepo();
  try {
    const warnings = await linkSharedDirectories(repo, repo, ["does-not-exist"]);
    assert.deepEqual(warnings, []);
  } finally {
    await cleanupRepo(repo);
  }
});

// --- Deterministic Concurrency Limits ---

import { Semaphore } from "./worker.js";

async function runConcurrencyTest(
  taskCount: number,
  maxConcurrency: number,
): Promise<{ peak: number; completed: number }> {
  const repo = await makeRepo();
  try {
    let peak = 0;
    const tasks = Array.from({ length: taskCount }, (_, i) => {
      const t = makeTask();
      t.allowedFiles = [`src/mod${i + 1}/**`];
      return t;
    });
    const sem = new Semaphore(maxConcurrency);

    let releases: Array<() => void> = [];
    let started = 0;

    const result = await runBatch(tasks, {
      mode: "parallel",
      workingDirectory: repo,
      semaphore: sem,
      executor: fakeExecutor({
        onConcurrency: (active) => {
          peak = Math.max(peak, active);
        },
        barrier: (active, release) => {
          releases.push(release);
          started++;
          const remaining = taskCount - started;
          const expectedWaveSize = Math.min(maxConcurrency, releases.length + remaining);

          if (releases.length === expectedWaveSize) {
            const currentWave = releases;
            releases = [];
            // Resolve asynchronously to allow concurrency counting to register properly
            setTimeout(() => {
              for (const r of currentWave) r();
            }, 0);
          }
        },
      }),
    });
    return { peak, completed: result.passed };
  } finally {
    await cleanupRepo(repo);
  }
}

test("1 task with max 20 -> peak concurrency 1", async () => {
  const { peak, completed } = await runConcurrencyTest(1, 20);
  assert.equal(completed, 1);
  assert.equal(peak, 1);
});

test("6 independent tasks with max 20 -> can reach peak 6", async () => {
  const { peak, completed } = await runConcurrencyTest(6, 20);
  assert.equal(completed, 6);
  assert.equal(peak, 6);
});

test("12 independent tasks with max 20 -> can reach peak 12", async () => {
  const { peak, completed } = await runConcurrencyTest(12, 20);
  assert.equal(completed, 12);
  assert.equal(peak, 12);
});

test("20 independent tasks with max 20 -> can reach peak 20", async () => {
  const { peak, completed } = await runConcurrencyTest(20, 20);
  assert.equal(completed, 20);
  assert.equal(peak, 20);
});

test("25 tasks with max 20 -> never exceeds 20 and remaining tasks run in a later wave", async () => {
  const { peak, completed } = await runConcurrencyTest(25, 20);
  assert.equal(completed, 25);
  assert.equal(peak, 20);
});

test("max 6 with 20 tasks -> never exceeds 6", async () => {
  const { peak, completed } = await runConcurrencyTest(20, 6);
  assert.equal(completed, 20);
  assert.equal(peak, 6);
});

test("existing default still behaves according to its current value", async () => {
  const { peak, completed } = await runConcurrencyTest(6, MAX_PARALLEL);
  assert.equal(completed, 6);
  assert.equal(peak, Math.min(6, MAX_PARALLEL));
});

test("invalid values above ceiling are clamped according to current project conventions", () => {
  assert.equal(clampParallel(9999), MAX_PARALLEL_LIMIT);
  assert.ok(MAX_PARALLEL_LIMIT >= 20);
});

test("cancellation/semaphore cleanup does not leak capacity", async () => {
  const repo = await makeRepo();
  try {
    const sem = new Semaphore(2);
    const controller = new AbortController();

    let started = 0;
    const executor = async (
      input: DelegateTaskInput,
      options: { signal?: AbortSignal },
    ) => {
      started++;
      if (started === 2) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (options.signal?.aborted)
        return makeOutput({ errors: ["Task was cancelled before it finished."] });
      return makeOutput();
    };

    const tasks = Array.from({ length: 4 }, (_, i) => {
      const t = makeTask();
      t.allowedFiles = [`src/mod${i + 1}/**`];
      return t;
    });
    await runBatch(tasks, {
      mode: "parallel",
      workingDirectory: repo,
      semaphore: sem,
      signal: controller.signal,
      executor,
    });

    const release1 = await sem.acquire();
    const release2 = await sem.acquire();
    release1();
    release2();
    assert.ok(true, "Semaphore capacity did not leak");
  } finally {
    await cleanupRepo(repo);
  }
});
