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
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleContinueTask, renderBatch } from "./server.js";
import { BatchRejectedError, runBatch as runProductionBatch } from "./batch.js";
import { CONTINUATION_TTL_MS, ContinuationStore } from "./continuation.js";
import {
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
  type WorkerReport,
} from "./contract.js";
import { collectWorktreeChanges, runGit } from "./git.js";
import {
  expandGlob,
  findIntegrationConflicts,
  findScopeConflicts,
  scopesOverlap,
} from "./overlap.js";
import {
  cleanupWorktree,
  createTaskWorktree,
  continuationLeasePath,
  linkSharedDirectories,
  prepareWorktreeBase,
  pruneStaleWorktrees,
  refreshWorktreeLease,
  releaseWorktreeLease,
  releaseWorktreeOwnership,
  shouldRetainWorktree,
  sweepExpiredWorktreeLeases,
  WORKTREE_LEASE_GRACE_MS,
  WorktreeLeaseRenewalError,
  WorktreeLeaseStore,
  worktreeMetadataQueue,
  WorktreeUnavailableError,
} from "./worktree.js";
import { executeTask, type WorkerCodex } from "./worker.js";
import type { ThreadEvent } from "@openai/codex-sdk";

/**
 * Deterministic scheduling cases must not inherit the production event sink.
 * Event-emission cases below use a child process and their own temporary file.
 */
const runBatch: typeof runProductionBatch = (tasks, options) =>
  runProductionBatch(tasks, { ...options, eventEmitter: () => undefined });

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
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
};

async function readLeaseRecords(
  artifact: string,
): Promise<Array<{ phase?: string; expiresAt?: number; ownerToken?: string }>> {
  const entries = await fs.readdir(artifact);
  return Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) =>
        JSON.parse(await fs.readFile(path.join(artifact, entry), "utf8")),
      ),
  );
}

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
    changeIntent: "required",
    verdict: "PASS",
    workerClaimedStatus: "PASS",
    workerClaimedFailureCauses: [],
    trustworthy: true,
    workerThreadId: "thread-x",
    continuationReference: null,
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

test("a failed final git diff is an explicit evidence-scan failure", async () => {
  const commands: string[] = [];
  await assert.rejects(
    collectWorktreeChanges("fixture-worktree", async (args) => {
      commands.push(args[0] ?? "");
      if (args[0] === "status") return "";
      throw new Error("diff evidence unavailable");
    }),
    /diff evidence unavailable/,
  );
  assert.deepEqual(commands, ["status", "diff"]);
});

/**
 * An executor that writes the files it claims to have written, so integration
 * and conflict detection are exercised against a real filesystem.
 *
 * `writes` and `fail` receive the task itself, never a scheduling index.
 */
function fakeExecutor(options: {
  writes?: (task: DelegateTaskInput) => Record<string, string>;
  fail?: (task: DelegateTaskInput) => boolean;
  output?: (task: DelegateTaskInput) => Partial<DelegateTaskOutput>;
  delayMs?: number;
  onConcurrency?: (active: number) => void;
}) {
  let active = 0;

  return async (
    input: DelegateTaskInput,
    execOptions: { workingDirectory: string; signal?: AbortSignal },
  ): Promise<DelegateTaskOutput> => {
    active += 1;
    options.onConcurrency?.(active);
    try {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 25));
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
      const overrides = options.output?.(input) ?? {};
      return makeOutput({ effort: input.effort, filesChanged: changed, ...overrides });
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

test("retention policy precedence covers every cleanup reason", () => {
  const reasons = ["success", "failure", "cancelled", "evidence-failure"] as const;
  const expected = {
    onfailure: [false, true, true, true],
    always: [true, true, true, true],
    never: [false, false, false, false],
  } as const;

  for (const [policy, outcomes] of Object.entries(expected)) {
    assert.deepEqual(
      reasons.map((reason) =>
        shouldRetainWorktree(reason, policy as keyof typeof expected),
      ),
      outcomes,
      policy,
    );
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
      if (process.platform !== "win32") {
        const linkedRoot = path.join(worktree.path, "node_modules");
        assert.equal((await fs.lstat(linkedRoot)).isSymbolicLink(), true);
        assert.equal(
          await fs.realpath(linkedRoot),
          await fs.realpath(path.join(repo, "node_modules")),
        );
      }
      assert.equal(await fs.readFile(linked, "utf8"), "module.exports=1;\n");
    }

    await cleanupWorktree(worktree, "evidence-failure", "never");

    // The real dependency tree must survive the worktree being deleted.
    assert.equal(
      await fs.readFile(path.join(modules, "index.js"), "utf8"),
      "module.exports=1;\n",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("successful and non-passing verdicts follow each retention mode", async () => {
  const cases = [
    { policy: "onfailure", verdict: "PASS", retained: false },
    { policy: "always", verdict: "PASS", retained: true },
    { policy: "never", verdict: "PASS", retained: false },
    { policy: "onfailure", verdict: "FAILED", retained: true },
    { policy: "always", verdict: "FAILED", retained: true },
    { policy: "never", verdict: "FAILED", retained: false },
    { policy: "onfailure", verdict: "BLOCKED", retained: true },
    { policy: "never", verdict: "BLOCKED", retained: false },
  ] as const;

  for (const scenario of cases) {
    const repo = await makeRepo();
    const events: Array<Record<string, unknown>> = [];
    try {
      const result = await runProductionBatch(
        [makeTask({ allowedFiles: ["src/result/**"] })],
        {
          mode: "parallel",
          workingDirectory: repo,
          keepWorktrees: scenario.policy,
          eventEmitter: (event) => events.push(event),
          executor: fakeExecutor({
            writes: () => ({ "src/result/value.ts": "changed\n" }),
            output: () =>
              scenario.verdict === "PASS"
                ? {}
                : {
                    verdict: scenario.verdict,
                    workerClaimedStatus: scenario.verdict,
                  },
          }),
          continuationRegistrar: () => `ctr_${"v".repeat(32)}`,
        },
      );

      const task = result.tasks[0]!;
      assert.equal(Boolean(task.worktreePath), scenario.retained, describeBatch(result));
      assert.equal(
        task.result?.continuationReference,
        `ctr_${"v".repeat(32)}`,
        "integrated results continue in the requested workspace under every policy",
      );
      assert.equal(
        events.some(
          (event) =>
            event.type === "worktree.removed" && event.kept === scenario.retained,
        ),
        true,
        JSON.stringify(events),
      );
      assert.equal(
        events.filter((event) => event.type === "worktree.retained").length,
        scenario.retained ? 1 : 0,
        JSON.stringify(events),
      );
      if (task.worktreePath) {
        assert.equal(
          await fs.stat(continuationLeasePath(task.worktreePath)).catch(() => null),
          null,
          "a workspace-bound continuation must not lease a diagnostic worktree",
        );
        await cleanupWorktree(
          {
            taskId: task.taskId,
            path: task.worktreePath,
            repoRoot: repo,
            warnings: [],
          },
          "success",
          "never",
        );
      }
    } finally {
      await cleanupRepo(repo);
    }
  }
});

test("worktree-required continuations follow retention and leave no stale never lease", async () => {
  for (const policy of ["onfailure", "always", "never"] as const) {
    const repo = await makeRepo();
    const events: Array<Record<string, unknown>> = [];
    let registrations = 0;
    try {
      const result = await runProductionBatch(
        [makeTask({ allowedFiles: ["src/diagnostic/**"] })],
        {
          mode: "parallel",
          workingDirectory: repo,
          integrate: false,
          keepWorktrees: policy,
          eventEmitter: (event) => events.push(event),
          executor: fakeExecutor({
            writes: () => ({ "src/diagnostic/value.ts": "changed\n" }),
          }),
          continuationRegistrar: () => {
            registrations += 1;
            return `ctr_${"d".repeat(32)}`;
          },
        },
      );

      const task = result.tasks[0]!;
      const retained = policy !== "never";
      assert.equal(Boolean(task.worktreePath), retained, describeBatch(result));
      assert.equal(registrations, retained ? 1 : 0);
      assert.equal(
        task.result?.continuationReference,
        retained ? `ctr_${"d".repeat(32)}` : null,
      );
      assert.equal(
        events.some(
          (event) => event.type === "worktree.removed" && event.kept === retained,
        ),
        true,
        JSON.stringify(events),
      );
      assert.equal(
        events.filter((event) => event.type === "worktree.retained").length,
        retained ? 1 : 0,
      );
      assert.match(result.integrationSummary, /remains after cleanup/i);

      if (task.worktreePath) {
        assert.ok(
          await fs.stat(continuationLeasePath(task.worktreePath)).catch(() => null),
          "a retained-worktree continuation needs a persistent lease",
        );
        await cleanupWorktree(
          {
            taskId: task.taskId,
            path: task.worktreePath,
            repoRoot: repo,
            warnings: [],
          },
          "success",
          "never",
        );
      } else {
        assert.deepEqual(await fs.readdir(path.join(repo, WORKTREE_DIR)), []);
      }
    } finally {
      await cleanupRepo(repo);
    }
  }
});

test("integration conflicts preserve evidence but obey retention", async () => {
  for (const policy of ["onfailure", "always", "never"] as const) {
    const repo = await makeRepo();
    try {
      const result = await runBatch(
        [
          makeTask({ allowedFiles: ["src/one/**", "shared/**"] }),
          makeTask({ allowedFiles: ["src/two/**", "shared/**"] }),
        ],
        {
          mode: "parallel",
          workingDirectory: repo,
          allowOverlappingScopes: true,
          keepWorktrees: policy,
          executor: fakeExecutor({
            writes: (task) => ({
              [`src/${moduleOf(task)}/value.ts`]: "unique\n",
              "shared/value.ts": `${moduleOf(task)}\n`,
            }),
          }),
        },
      );

      assert.equal(result.integrationConflicts.length, 1, describeBatch(result));
      assert.equal(result.integrationConflicts[0]?.path, "shared/value.ts");
      assert.equal(result.integrated, false);
      assert.equal(
        result.tasks.every((task) => Boolean(task.worktreePath) === (policy !== "never")),
        true,
        describeBatch(result),
      );
      assert.match(result.integrationSummary, /Conflict evidence|after cleanup/i);

      for (const task of result.tasks) {
        if (!task.worktreePath) continue;
        await cleanupWorktree(
          {
            taskId: task.taskId,
            path: task.worktreePath,
            repoRoot: repo,
            warnings: [],
          },
          "success",
          "never",
        );
      }
    } finally {
      await cleanupRepo(repo);
    }
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
    releaseWorktreeOwnership(stale);
    assert.ok(stale.lease);
    await releaseWorktreeLease(stale.lease);

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

test("batch continuations bind to the integrated workspace or a retained worktree", async () => {
  const integratedRepo = await makeRepo();
  const retainedRepo = await makeRepo();
  try {
    const integratedDirectories: string[] = [];
    const integrated = await runBatch([makeTask({ allowedFiles: ["src/auth/**"] })], {
      mode: "parallel",
      workingDirectory: integratedRepo,
      executor: fakeExecutor({ writes: () => ({ "src/auth/login.ts": "ok\n" }) }),
      continuationRegistrar: (_input, _result, workingDirectory) => {
        integratedDirectories.push(workingDirectory);
        return `ctr_${"i".repeat(32)}`;
      },
    });

    assert.equal(
      integrated.tasks[0]?.result?.continuationReference,
      `ctr_${"i".repeat(32)}`,
    );
    assert.deepEqual(integratedDirectories, [integratedRepo]);
    assert.equal(integrated.tasks[0]?.worktreePath, null);

    const retainedDirectories: string[] = [];
    const retained = await runBatch([makeTask({ allowedFiles: ["src/payments/**"] })], {
      mode: "parallel",
      workingDirectory: retainedRepo,
      integrate: false,
      executor: fakeExecutor({
        writes: () => ({ "src/payments/charge.ts": "ok\n" }),
        output: () => ({
          verdict: "FAILED",
          workerClaimedStatus: "FAILED",
          trustworthy: false,
        }),
      }),
      keepWorktrees: "onfailure",
      continuationRegistrar: (_input, _result, workingDirectory) => {
        retainedDirectories.push(workingDirectory);
        return `ctr_${"r".repeat(32)}`;
      },
    });

    const retainedPath = retained.tasks[0]?.worktreePath;
    assert.equal(
      retained.tasks[0]?.result?.continuationReference,
      `ctr_${"r".repeat(32)}`,
    );
    assert.equal(retainedDirectories[0], retainedPath);
    assert.ok(retainedPath, describeBatch(retained));
    assert.ok(
      await fs.stat(retainedPath).catch(() => null),
      "retained worktree must remain usable",
    );
  } finally {
    await cleanupRepo(integratedRepo);
    await cleanupRepo(retainedRepo);
  }
});

test("retained worktrees have unique identities and protected continuations are not pruned", async () => {
  const repo = await makeRepo();
  const retainedPaths: string[] = [];
  try {
    const first = await runBatch([makeTask({ allowedFiles: ["src/one/**"] })], {
      mode: "parallel",
      workingDirectory: repo,
      integrate: false,
      keepWorktrees: "onfailure",
      executor: fakeExecutor({ writes: () => ({ "src/one/value.ts": "one\n" }) }),
      continuationRegistrar: () => `ctr_${"p".repeat(32)}`,
    });
    const firstPath = first.tasks[0]?.worktreePath;
    assert.ok(firstPath, describeBatch(first));
    retainedPaths.push(firstPath);

    const second = await runBatch([makeTask({ allowedFiles: ["src/two/**"] })], {
      mode: "parallel",
      workingDirectory: repo,
      integrate: false,
      keepWorktrees: "onfailure",
      executor: fakeExecutor({ writes: () => ({ "src/two/value.ts": "two\n" }) }),
    });
    const secondPath = second.tasks[0]?.worktreePath;
    assert.ok(secondPath, describeBatch(second));
    retainedPaths.push(secondPath);

    assert.notEqual(firstPath, secondPath, "batch identity must be part of the path");
    assert.ok(
      await fs.stat(firstPath).catch(() => null),
      "protected worktree was pruned",
    );
    assert.ok(await fs.stat(secondPath).catch(() => null));
  } finally {
    for (const retainedPath of retainedPaths) {
      await cleanupWorktree(
        {
          taskId: path.basename(retainedPath),
          path: retainedPath,
          repoRoot: repo,
          warnings: [],
        },
        "success",
        "never",
      ).catch(() => undefined);
    }
    await cleanupRepo(repo);
  }
});

test("persistent ownership prevents a different process from pruning an active worktree", async () => {
  const repo = await makeRepo();
  const base = await prepareWorktreeBase(repo, [["src/**"]]);
  const worktree = await createTaskWorktree(base, "cross-process-active", repo);

  try {
    releaseWorktreeOwnership(worktree);
    assert.deepEqual(await pruneStaleWorktrees(repo), []);
    assert.ok(await fs.stat(worktree.path).catch(() => null));

    assert.ok(worktree.lease);
    await releaseWorktreeLease(worktree.lease);
    assert.deepEqual(await pruneStaleWorktrees(repo), [worktree.path]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("a live retained continuation worktree cannot be reused by a replayed batch identity", async () => {
  const repo = await makeRepo();
  const base = await prepareWorktreeBase(repo, [["a.txt"]]);
  const worktree = await createTaskWorktree(base, "replayed-t1", repo);

  try {
    releaseWorktreeOwnership(worktree);

    await assert.rejects(
      createTaskWorktree(base, "replayed-t1", repo),
      /identity replayed-t1 is still in use/i,
    );
    assert.equal((await fs.stat(worktree.path)).isDirectory(), true);
  } finally {
    if (worktree.lease) await releaseWorktreeLease(worktree.lease);
    await cleanupWorktree(worktree, "success", "never");
    await cleanupRepo(repo);
  }
});

test("lease acquire and refresh publication are conservatively atomic to readers", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-lease-atomic-"));
  const worktreePath = path.join(repo, ".sol-luna", "worktrees", "atomic");
  let now = 1_000;
  let pause = true;
  let published!: () => void;
  let resume!: () => void;
  const publicationStarted = new Promise<void>((resolve) => {
    published = resolve;
  });
  const publicationGate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const writer = new WorktreeLeaseStore({
    now: () => now,
    tokenFactory: () => "owner-atomic",
    beforePublish: async () => {
      if (!pause) return;
      published();
      await publicationGate;
    },
  });
  const reader = new WorktreeLeaseStore({ now: () => now });

  try {
    const acquiring = writer.acquire(worktreePath, now + 100, "creating");
    await publicationStarted;
    assert.equal(await reader.isProtected(worktreePath), true);
    pause = false;
    resume();
    const lease = await acquiring;

    let refreshPublished!: () => void;
    let refreshResume!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      refreshPublished = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      refreshResume = resolve;
    });
    const refresher = new WorktreeLeaseStore({
      now: () => now,
      beforePublish: async (phase) => {
        if (phase !== "executing-continuation") return;
        refreshPublished();
        await refreshGate;
      },
    });
    now += 100;
    const refreshing = refresher.refresh(lease, now + 1_000, "executing-continuation");
    await refreshStarted;
    assert.equal(
      await reader.isProtected(worktreePath),
      true,
      "an expired old generation plus an in-progress new generation stays protected",
    );
    refreshResume();
    await refreshing;
    assert.equal(await reader.isProtected(worktreePath), true);
    await refresher.release(lease);
  } finally {
    await cleanupRepo(repo);
  }
});

test("an acquisition crash before first generation expires and releases the metadata identity", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-lease-acquire-crash-"));
  const metadataPath = path.join(repo, ".sol-luna", "worktrees", ".metadata");
  let now = 1_000;
  let artifactCreated!: () => void;
  const artifactCreatedPromise = new Promise<void>((resolve) => {
    artifactCreated = resolve;
  });
  const crashedPublisher = new WorktreeLeaseStore({
    now: () => now,
    tokenFactory: () => "owner-crashed-metadata",
    afterArtifactCreated: async () => {
      artifactCreated();
      await new Promise<void>(() => undefined);
    },
  });
  const reader = new WorktreeLeaseStore({
    now: () => now,
    tokenFactory: () => "owner-replacement-metadata",
  });

  try {
    const abandoned = crashedPublisher.acquire(metadataPath, now + 100, "metadata");
    void abandoned.catch(() => undefined);
    await artifactCreatedPromise;

    assert.equal(await reader.isProtected(metadataPath), true);
    await assert.rejects(
      reader.acquire(metadataPath, now + 100, "metadata"),
      /identity \.metadata is still in use/i,
    );

    now += 100;
    assert.deepEqual(await sweepExpiredWorktreeLeases(repo, now), []);
    assert.equal(await reader.isProtected(metadataPath), false);

    const replacement = await reader.acquire(metadataPath, now + 100, "metadata");
    assert.equal(await reader.isProtected(metadataPath), true);
    await reader.release(replacement);
  } finally {
    await cleanupRepo(repo);
  }
});

test("a stale acquirer cannot publish into a replacement artifact", async (t) => {
  for (const identity of ["reclaimed-task", ".metadata"]) {
    await t.test(identity, async () => {
      const repo = await fs.mkdtemp(
        path.join(os.tmpdir(), "sol-luna-lease-stale-publisher-"),
      );
      const worktreePath = path.join(repo, ".sol-luna", "worktrees", identity);
      const artifact = continuationLeasePath(worktreePath);
      const reservation = `${artifact}.acquire`;
      let now = 1_000;
      let aCreated!: () => void;
      let resumeA!: () => void;
      const aCreatedPromise = new Promise<void>((resolve) => {
        aCreated = resolve;
      });
      const aGate = new Promise<void>((resolve) => {
        resumeA = resolve;
      });
      let bCreated!: () => void;
      let resumeB!: () => void;
      const bCreatedPromise = new Promise<void>((resolve) => {
        bCreated = resolve;
      });
      const bGate = new Promise<void>((resolve) => {
        resumeB = resolve;
      });
      const acquirerA = new WorktreeLeaseStore({
        now: () => now,
        tokenFactory: () => `owner-a-${identity}`,
        afterArtifactCreated: async () => {
          aCreated();
          await aGate;
        },
      });
      const acquirerB = new WorktreeLeaseStore({
        now: () => now,
        tokenFactory: () => `owner-b-${identity}`,
        afterArtifactCreated: async () => {
          bCreated();
          await bGate;
        },
      });

      try {
        const stale = acquirerA.acquire(worktreePath, now + 100, "metadata");
        await aCreatedPromise;
        now += 100;
        const swept = await sweepExpiredWorktreeLeases(repo, now);
        assert.deepEqual(swept, identity === ".metadata" ? [] : [worktreePath]);

        const replacement = acquirerB.acquire(worktreePath, now + 1_000, "metadata");
        await bCreatedPromise;
        assert.equal(await acquirerB.isProtected(worktreePath), true);
        assert.ok(await fs.stat(artifact).catch(() => null));
        assert.ok(await fs.stat(reservation).catch(() => null));

        resumeA();
        await assert.rejects(stale, /changed ownership before publication/i);
        assert.equal(await acquirerB.isProtected(worktreePath), true);
        assert.ok(await fs.stat(artifact).catch(() => null));
        assert.ok(await fs.stat(reservation).catch(() => null));

        resumeB();
        const replacementLease = await replacement;
        assert.equal(await acquirerB.isProtected(worktreePath), true);
        assert.equal(
          (await fs.readdir(artifact)).filter((name) => name.endsWith(".json")).length,
          1,
        );
        await acquirerB.release(replacementLease);
      } finally {
        resumeA();
        resumeB();
        await cleanupRepo(repo);
      }
    });
  }
});

test("lease maintenance surfaces renewal loss while the original horizon remains protective", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-lease-renewal-"));
  const metadataPath = path.join(repo, ".sol-luna", "worktrees", ".metadata");
  let now = 10_000;
  let failRefresh = false;
  let refreshAttempted!: () => void;
  const refreshAttemptedPromise = new Promise<void>((resolve) => {
    refreshAttempted = resolve;
  });
  const leases = new WorktreeLeaseStore({
    now: () => now,
    tokenFactory: () => "owner-renewal-health",
    maintenanceIntervalMs: 5,
    beforePublish: async () => {
      if (!failRefresh) return;
      refreshAttempted();
      throw new Error("fixture refresh failure");
    },
  });
  const lifetimeMs = WORKTREE_LEASE_GRACE_MS + 1_000;
  const lease = await leases.acquire(metadataPath, now + lifetimeMs, "metadata");
  const maintenance = leases.maintain(lease, lifetimeMs, "metadata");

  try {
    maintenance.assertHealthy(lifetimeMs - 1);
    assert.throws(
      () => maintenance.assertHealthy(lifetimeMs),
      /lease health is insufficient for the next bounded operation/i,
    );
    failRefresh = true;
    await refreshAttemptedPromise;
    await maintenance.whenUnhealthy;

    assert.throws(
      () => maintenance.assertHealthy(),
      /persistent worktree lease renewal failed.*fixture refresh failure/i,
    );
    await assert.rejects(
      maintenance.stop(),
      /persistent worktree lease renewal failed.*fixture refresh failure/i,
    );
    assert.equal(await leases.isProtected(metadataPath, lease.expiresAt - 1), true);
    assert.equal(await leases.isProtected(metadataPath, lease.expiresAt), false);
  } finally {
    await leases.release(lease);
    await cleanupRepo(repo);
  }
});

test("batch renewal failure releases local ownership but preserves the bounded lease", async () => {
  const repo = await makeRepo();
  const batchId = "lease-stop-failure";
  const worktreePath = path.join(repo, ".sol-luna", "worktrees", `${batchId}-t1`);
  const renewalError = new WorktreeLeaseRenewalError(
    "fixture batch renewal failure",
    undefined,
  );

  try {
    await assert.rejects(
      runBatch(
        [
          makeTask({
            allowedFiles: ["src/renewal/**"],
            timeoutSeconds: 1,
          }),
        ],
        {
          mode: "parallel",
          workingDirectory: repo,
          integrate: false,
          keepWorktrees: "onfailure",
          batchId,
          executor: fakeExecutor({
            writes: () => ({ "src/renewal/value.ts": "x\n" }),
          }),
          leaseMaintainer: () => ({
            assertHealthy: () => undefined,
            whenUnhealthy: Promise.resolve(renewalError),
            stop: async () => {
              throw renewalError;
            },
          }),
        },
      ),
      /fixture batch renewal failure/i,
    );

    assert.ok(await fs.stat(worktreePath).catch(() => null));
    assert.deepEqual(await pruneStaleWorktrees(repo), []);

    await sweepExpiredWorktreeLeases(repo, Date.now() + WORKTREE_LEASE_GRACE_MS + 10_000);
    assert.deepEqual(await pruneStaleWorktrees(repo), [worktreePath]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("near-expiry continuation consumption protects the full execution window", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-lease-consume-"));
  const worktreePath = path.join(repo, ".sol-luna", "worktrees", "continued");
  let now = 10_000;
  const reference = `ctr_${"c".repeat(32)}`;
  const leases = new WorktreeLeaseStore({
    now: () => now,
    tokenFactory: () => "owner-continuation",
  });
  const lease = await leases.acquire(
    worktreePath,
    now + CONTINUATION_TTL_MS + WORKTREE_LEASE_GRACE_MS,
    "retained-continuation",
  );
  const continuations = new ContinuationStore({
    now: () => now,
    tokenFactory: () => reference,
  });
  const input = makeTask({ timeoutSeconds: 7_200 });
  const issuedAt = now;
  continuations.issue(input, "thread", worktreePath, true, lease);

  try {
    now += CONTINUATION_TTL_MS - 1;
    const consumed = continuations.consume(reference);
    assert.equal(consumed.status, "ready");
    assert.ok(consumed.status === "ready" && consumed.entry.worktreeLease);
    const executionExpiresAt =
      now + input.timeoutSeconds! * 1_000 + WORKTREE_LEASE_GRACE_MS;
    await leases.refresh(
      consumed.entry.worktreeLease,
      executionExpiresAt,
      "executing-continuation",
    );

    now = issuedAt + CONTINUATION_TTL_MS + WORKTREE_LEASE_GRACE_MS + 1;
    assert.equal(await leases.isProtected(worktreePath), true);
    assert.equal(await leases.isProtected(worktreePath, executionExpiresAt - 1), true);
    assert.equal(await leases.isProtected(worktreePath, executionExpiresAt), false);
    await leases.release(consumed.entry.worktreeLease);
    continuations.release(reference);
  } finally {
    await cleanupRepo(repo);
  }
});

test("failed retained continuation registration releases protection and ownership", async () => {
  const repo = await makeRepo();
  try {
    const batch = await runBatch([makeTask({ allowedFiles: ["src/failure/**"] })], {
      mode: "parallel",
      workingDirectory: repo,
      integrate: false,
      keepWorktrees: "onfailure",
      executor: fakeExecutor({ writes: () => ({ "src/failure/value.ts": "x\n" }) }),
      continuationRegistrar: async () => {
        throw new Error("fixture registration failure");
      },
    });
    const task = batch.tasks[0]!;
    assert.equal(task.result?.continuationReference, null);
    assert.ok(task.warnings.some((warning) => /registration failed/i.test(warning)));
    assert.ok(task.worktreePath);
    assert.deepEqual(await pruneStaleWorktrees(repo), [task.worktreePath]);
  } finally {
    await cleanupRepo(repo);
  }
});

test("a consumed retained continuation failure finalizes its refreshed lease", async () => {
  const repo = await makeRepo();
  const reference = `ctr_${"f".repeat(32)}`;
  const continuations = new ContinuationStore({ tokenFactory: () => reference });
  const events: Array<Record<string, unknown>> = [];
  let retainedPath: string | null = null;
  let refreshes = 0;
  let releases = 0;
  try {
    const original = makeTask({
      objective: "Create retained continuation evidence under an immutable contract.",
      effort: "xhigh",
      changeIntent: "required",
      allowedFiles: ["src/continued/**"],
      forbiddenFiles: ["src/forbidden/**"],
      acceptanceCriteria: ["The original retained edit remains observable."],
      verificationCommands: [],
      timeoutSeconds: 60,
    });
    const originalSnapshot = { ...structuredClone(original), contextCapsule: undefined };
    const batch = await runBatch([original], {
      mode: "parallel",
      batchId: "b-retained-continuation-failure",
      workingDirectory: repo,
      integrate: false,
      keepWorktrees: "onfailure",
      executor: fakeExecutor({
        writes: () => ({ "src/continued/first.ts": "export const first = true;\n" }),
        output: () => ({ workerThreadId: "thread-retained-failure" }),
      }),
      continuationRegistrar: (input, result, workingDirectory, reconcile, lease) =>
        result.workerThreadId
          ? continuations.issue(
              input,
              result.workerThreadId,
              workingDirectory,
              reconcile,
              lease,
            )
          : null,
    });

    const retainedTask = batch.tasks[0]!;
    retainedPath = retainedTask.worktreePath;
    assert.ok(retainedPath, describeBatch(batch));
    assert.equal(retainedTask.result?.continuationReference, reference);
    const leaseArtifact = continuationLeasePath(retainedPath!);
    const retainedRecords = await readLeaseRecords(leaseArtifact);
    assert.ok(
      retainedRecords.some((record) => record.phase === "retained-continuation"),
      JSON.stringify(retainedRecords),
    );

    const response = await handleContinueTask(
      {
        continuationReference: reference,
        instruction: "Attempt the bounded follow-up and fail after execution starts.",
      },
      undefined,
      {
        store: continuations,
        emit: (event) => events.push(event),
        record: () => undefined,
        makeBatchId: () => "b-consumed-continuation-failure",
        refreshLease: async (lease, expiresAt, phase) => {
          refreshes += 1;
          assert.equal(phase, "executing-continuation");
          await refreshWorktreeLease(lease, expiresAt, phase);
        },
        releaseLease: async (lease) => {
          releases += 1;
          await releaseWorktreeLease(lease);
        },
        continueTask: async (input, options) => {
          assert.deepEqual(
            input,
            originalSnapshot,
            "the consumed contract must be immutable",
          );
          assert.equal(options.threadId, "thread-retained-failure");
          assert.equal(options.workingDirectory, retainedPath);
          assert.match(options.instruction, /fail after execution starts/i);
          options.hooks?.onStarted?.(options.workingDirectory);
          const executingRecords = await readLeaseRecords(leaseArtifact);
          assert.ok(
            executingRecords.some((record) => record.phase === "executing-continuation"),
            JSON.stringify(executingRecords),
          );
          throw new Error("controlled continuation failure after lease refresh");
        },
      },
    );

    assert.equal(response.isError, true);
    assert.match(response.content[0]?.text ?? "", /controlled continuation failure/i);
    assert.equal(refreshes, 1, "consumption must refresh the retained lease once");
    assert.equal(releases, 1, "the handler finally must release the refreshed lease");
    assert.equal(continuations.consume(reference).status, "used");
    assert.deepEqual(continuations.protectedWorkingDirectories(), []);
    assert.equal(await fs.stat(leaseArtifact).catch(() => null), null);
    assert.ok(await fs.stat(retainedPath!).catch(() => null));
    assert.ok(
      events.some(
        (event) =>
          event.type === "worker.started" &&
          event.batchId === "b-consumed-continuation-failure",
      ),
      JSON.stringify(events),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "worker.failed" &&
          /controlled continuation failure after lease refresh/.test(
            String(event.reason),
          ),
      ),
      JSON.stringify(events),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "batch.completed" && event.passed === 0 && event.failed === 1,
      ),
      JSON.stringify(events),
    );

    assert.deepEqual(await pruneStaleWorktrees(repo), [retainedPath]);
    assert.equal(await fs.stat(retainedPath!).catch(() => null), null);
    assert.equal(
      (await runGit(["worktree", "list", "--porcelain"], repo)).stdout.includes(
        retainedPath!,
      ),
      false,
    );
    retainedPath = null;
  } finally {
    if (
      retainedPath &&
      !(await fs.stat(continuationLeasePath(retainedPath)).catch(() => null))
    ) {
      await pruneStaleWorktrees(repo).catch(() => undefined);
    }
    await cleanupRepo(repo);
  }
});

test("expired orphan lease artifacts are swept without a Git worktree", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-lease-orphan-"));
  const worktreePath = path.join(repo, ".sol-luna", "worktrees", "missing");
  const interruptedPath = path.join(repo, ".sol-luna", "worktrees", "interrupted");
  let now = 100;
  const leases = new WorktreeLeaseStore({
    now: () => now,
    tokenFactory: () => "owner-orphan",
  });
  await leases.acquire(worktreePath, 200, "retained-continuation");
  const interruptedArtifact = continuationLeasePath(interruptedPath);
  await fs.mkdir(interruptedArtifact, { recursive: true });
  await fs.writeFile(
    path.join(interruptedArtifact, ".publish-200-deadbeef.tmp"),
    "partially published",
    "utf8",
  );
  assert.equal(await leases.isProtected(interruptedPath, 199), true);
  now = 200;

  try {
    assert.deepEqual(
      new Set(await sweepExpiredWorktreeLeases(repo, now)),
      new Set([worktreePath, interruptedPath]),
    );
    assert.equal(
      await fs.stat(continuationLeasePath(worktreePath)).catch(() => null),
      null,
    );
    assert.equal(await fs.stat(interruptedArtifact).catch(() => null), null);
  } finally {
    await cleanupRepo(repo);
  }
});

test("legacy path-only lease files protect live worktrees and sweep after expiry", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-lease-legacy-"));
  const worktreePath = path.join(repo, ".sol-luna", "worktrees", "legacy");
  const artifact = continuationLeasePath(worktreePath);
  let now = 100;
  const leases = new WorktreeLeaseStore({ now: () => now });

  try {
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "200\n", "utf8");

    assert.equal(await leases.isProtected(worktreePath), true);
    assert.deepEqual(await sweepExpiredWorktreeLeases(repo, 199), []);
    assert.ok(await fs.stat(artifact).catch(() => null));

    now = 200;
    assert.equal(await leases.isProtected(worktreePath), false);
    assert.deepEqual(await sweepExpiredWorktreeLeases(repo, now), [worktreePath]);
    assert.equal(await fs.stat(artifact).catch(() => null), null);
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
    const batchId = "b-create-failure";
    const secondTaskId = "t2";
    const blocked = path.join(
      repo,
      ...WORKTREE_DIR.split("/"),
      `${batchId}-${secondTaskId}`,
    );
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
        batchId,
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
        keepWorktrees: "onfailure",
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

test("a completed FAILED result can still contribute disjoint integrated edits", async () => {
  const repo = await makeRepo();
  try {
    const result = await runBatch(
      [
        makeTask({
          objective: "Complete the passing independent module.",
          allowedFiles: ["src/pass/**"],
        }),
        makeTask({
          objective: "Attempt the failing independent module.",
          allowedFiles: ["src/fail/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: fakeExecutor({
          writes: (task) => ({ [`src/${moduleOf(task)}/mod.ts`]: "changed\n" }),
          output: (task) =>
            moduleOf(task) === "fail"
              ? { verdict: "FAILED", workerClaimedStatus: "FAILED" }
              : {},
        }),
      },
    );

    assert.equal(result.integrated, true, describeBatch(result));
    assert.equal(result.passed, 1, describeBatch(result));
    assert.equal(
      result.tasks.find((task) => task.objective.includes("failing"))?.state,
      "completed",
    );
    assert.ok(
      await fs.stat(path.join(repo, "src", "fail", "mod.ts")).catch(() => null),
      "completed FAILED edits should be visible for supervisor review",
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

test("an already-running parallel worker cancels while its sibling completes", async () => {
  const repo = await makeRepo();
  const controller = new AbortController();
  const events: Array<Record<string, unknown>> = [];
  let retainedPath: string | null = null;
  let started = 0;
  let active = 0;
  let abortObserved = false;
  const registeredThreads: Array<string | null> = [];
  let releaseBothStarted!: () => void;
  let releaseSiblingCompleted!: () => void;
  const bothStarted = new Promise<void>((resolve) => (releaseBothStarted = resolve));
  const siblingCompleted = new Promise<void>(
    (resolve) => (releaseSiblingCompleted = resolve),
  );

  const workerReport = (file: string): WorkerReport => ({
    status: "PASS",
    failureCauses: [],
    summary: "Completed the independent sibling.",
    filesChanged: [{ path: file, change: "added", why: "fixture output" }],
    verification: [],
    notes: "",
    followUps: [],
  });

  try {
    const batchPromise = runProductionBatch(
      [
        makeTask({
          objective: "Complete the independent sibling before cancellation.",
          allowedFiles: ["src/complete/**"],
        }),
        makeTask({
          objective: "Remain in flight until the batch is cancelled.",
          allowedFiles: ["src/cancelled/**"],
        }),
      ],
      {
        mode: "parallel",
        batchId: "b-inflight-cancellation",
        workingDirectory: repo,
        signal: controller.signal,
        eventEmitter: (event) => events.push(event),
        keepWorktrees: "onfailure",
        continuationRegistrar: (_input, result) => {
          registeredThreads.push(result.workerThreadId);
          return `ctr_${"c".repeat(32)}`;
        },
        executor: async (input, options) => {
          const completing = input.objective.includes("independent sibling");
          const threadId = completing ? "thread-complete" : "thread-cancelled";
          const codex: WorkerCodex = {
            startThread: () => ({
              id: threadId,
              runStreamed: async (_prompt, turnOptions) => {
                started += 1;
                active += 1;
                if (started === 2) releaseBothStarted();

                const eventStream = async function* (): AsyncGenerator<ThreadEvent> {
                  try {
                    await bothStarted;
                    if (completing) {
                      const target = path.join(
                        options.workingDirectory,
                        "src",
                        "complete",
                        "value.ts",
                      );
                      await fs.mkdir(path.dirname(target), { recursive: true });
                      await fs.writeFile(
                        target,
                        "export const completed = true;\n",
                        "utf8",
                      );
                      yield {
                        type: "item.completed",
                        item: {
                          id: "completed-change",
                          type: "file_change",
                          status: "completed",
                          changes: [{ path: target, kind: "add" }],
                        },
                      };
                      yield {
                        type: "item.completed",
                        item: {
                          id: "completed-report",
                          type: "agent_message",
                          text: JSON.stringify(workerReport(target)),
                        },
                      };
                      releaseSiblingCompleted();
                      return;
                    }

                    await new Promise<never>((_resolve, reject) => {
                      const signal = turnOptions?.signal;
                      const onAbort = (): void => {
                        abortObserved = true;
                        reject(new Error("controlled worker abort"));
                      };
                      if (signal?.aborted) onAbort();
                      else signal?.addEventListener("abort", onAbort, { once: true });
                    });
                  } finally {
                    active -= 1;
                  }
                };
                return { events: eventStream() };
              },
            }),
            resumeThread: () => {
              throw new Error("fresh parallel workers must not resume");
            },
          };
          return executeTask(input, {
            workingDirectory: options.workingDirectory,
            signal: options.signal,
            codex,
          });
        },
      },
    );

    await bothStarted;
    await siblingCompleted;
    assert.equal(started, 2, "both workers must start before cancellation");
    assert.equal(active, 1, "the cancelled worker must still be in flight");
    controller.abort();
    const result = await batchPromise;

    const completed = result.tasks[0]!;
    const cancelled = result.tasks[1]!;
    retainedPath = cancelled.worktreePath;
    assert.equal(abortObserved, true);
    assert.equal(active, 0, "no controlled worker may remain active");
    assert.equal(completed.state, "completed", describeBatch(result));
    assert.equal(completed.result?.verdict, "PASS", describeBatch(result));
    assert.equal(completed.result?.trustworthy, true, describeBatch(result));
    assert.equal(cancelled.state, "cancelled", describeBatch(result));
    assert.equal(cancelled.result?.verdict, "FAILED", describeBatch(result));
    assert.equal(cancelled.result?.workerClaimedStatus, "FAILED");
    assert.equal(cancelled.result?.trustworthy, false);
    assert.equal(completed.result?.continuationReference, `ctr_${"c".repeat(32)}`);
    assert.equal(cancelled.result?.continuationReference, null);
    assert.deepEqual(registeredThreads, ["thread-complete"]);
    assert.ok(
      cancelled.result?.errors.some((error) =>
        /cancelled before it finished/i.test(error),
      ),
      JSON.stringify(cancelled.result),
    );
    assert.deepEqual(cancelled.changedFiles, []);
    assert.equal(result.passed, 1, describeBatch(result));
    assert.equal(result.failed, 1, describeBatch(result));
    assert.equal(result.integrated, true, describeBatch(result));
    assert.equal(
      await fs.readFile(path.join(repo, "src", "complete", "value.ts"), "utf8"),
      "export const completed = true;\n",
    );

    assert.equal(events.filter((event) => event.type === "worker.started").length, 2);
    assert.ok(
      events.some(
        (event) =>
          event.type === "worker.completed" &&
          event.taskId === "t1" &&
          event.verdict === "PASS",
      ),
      JSON.stringify(events),
    );
    assert.ok(
      events.some((event) => event.type === "worker.cancelled" && event.taskId === "t2"),
      JSON.stringify(events),
    );
    assert.equal(events.filter((event) => event.type === "batch.cancelled").length, 1);
    assert.equal(events.filter((event) => event.type === "batch.completed").length, 0);
    assert.ok(
      events.some(
        (event) =>
          event.type === "integration.applied" &&
          event.taskId === "t1" &&
          event.fileCount === 1,
      ),
      JSON.stringify(events),
    );
    assert.ok(retainedPath, describeBatch(result));
    assert.ok(await fs.stat(retainedPath!).catch(() => null));
    assert.equal(
      await fs.stat(continuationLeasePath(retainedPath!)).catch(() => null),
      null,
    );
  } finally {
    if (retainedPath) {
      await cleanupWorktree(
        { taskId: "t2", path: retainedPath, repoRoot: repo, warnings: [] },
        "success",
        "never",
      ).catch(() => undefined);
    }
    await cleanupRepo(repo);
  }
});

test("mid-flight cancellation stops the remaining sequential tasks", async () => {
  const repo = await makeRepo();
  try {
    const controller = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    let calls = 0;

    const result = await runProductionBatch(
      [
        makeTask({ objective: "First sequential step of the pipeline." }),
        makeTask({ objective: "Second sequential step of the pipeline." }),
        makeTask({ objective: "Third sequential step of the pipeline." }),
      ],
      {
        mode: "sequential",
        workingDirectory: repo,
        signal: controller.signal,
        eventEmitter: (event) => events.push(event),
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
    assert.equal(events.filter((event) => event.type === "batch.cancelled").length, 1);
    assert.equal(events.filter((event) => event.type === "batch.completed").length, 0);
  } finally {
    await cleanupRepo(repo);
  }
});

test("a late abort does not rewrite a completed batch as cancelled", async () => {
  const repo = await makeRepo();
  try {
    const controller = new AbortController();
    const events: Array<Record<string, unknown>> = [];
    const result = await runProductionBatch([makeTask()], {
      mode: "sequential",
      workingDirectory: repo,
      signal: controller.signal,
      eventEmitter: (event) => events.push(event),
      executor: async () => {
        controller.abort();
        return makeOutput();
      },
    });

    assert.equal(result.tasks[0]?.state, "completed");
    assert.equal(events.filter((event) => event.type === "batch.cancelled").length, 0);
    assert.equal(events.filter((event) => event.type === "batch.completed").length, 1);
  } finally {
    await cleanupRepo(repo);
  }
});

test("sequential mode shares the workspace so later tasks see earlier work", async () => {
  const repo = await makeRepo();
  try {
    const seen: string[] = [];
    const eventTypes: string[] = [];
    const result = await runProductionBatch(
      [
        makeTask({ objective: "Create the shared groundwork file." }),
        makeTask({ objective: "Build on top of the groundwork file." }),
      ],
      {
        mode: "sequential",
        workingDirectory: repo,
        eventEmitter: (event) => eventTypes.push(event.type),
        executor: async (_input, options) => {
          const marker = path.join(options.workingDirectory, "sequence.txt");
          const existing = await fs.readFile(marker, "utf8").catch(() => "");
          seen.push(existing);
          await fs.writeFile(
            marker,
            `${existing}${existing ? "beta" : "alpha"}\n`,
            "utf8",
          );
          return makeOutput({
            filesChanged: [
              {
                path: "sequence.txt",
                kind: existing ? "update" : "add",
                why: "sequential fixture",
                observed: true,
              },
            ],
          });
        },
      },
    );

    assert.deepEqual(
      seen,
      ["", "alpha\n"],
      "the second task must see the first task's write",
    );
    assert.equal(
      await fs.readFile(path.join(repo, "sequence.txt"), "utf8"),
      "alpha\nbeta\n",
    );
    assert.equal(result.integrated, true);
    assert.match(result.integrationSummary, /already in place/);
    assert.deepEqual(result.integrationConflicts, []);
    assert.equal(eventTypes.includes("integration.conflict"), false);
    assert.ok(result.tasks.every((task) => task.worktreePath === null));
    assert.ok(
      result.reviewChecklist.every(
        (item) =>
          !/nothing was merged|version is in its worktree|integration conflict/i.test(
            item,
          ),
      ),
    );
    const rendered = renderBatch(result);
    assert.doesNotMatch(
      rendered,
      /INTEGRATION CONFLICTS|nothing was merged|worktree kept/i,
    );
    assert.match(rendered, /Sequential tasks worked directly in the workspace/);
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

test("batch counts final verdict while rendering the contradictory worker claim", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-verdict-batch-"));
  const real = await fs.realpath(plain);
  try {
    const result = await runBatch([makeTask()], {
      mode: "sequential",
      workingDirectory: real,
      executor: async () =>
        makeOutput({
          verdict: "PASS",
          workerClaimedStatus: "FAILED",
          workerClaimedFailureCauses: ["verification"],
          trustworthy: false,
          discrepancies: [
            "Worker claimed FAILED because verification failed, but matching authoritative verification executed successfully.",
          ],
          verification: [
            {
              command: "npm test",
              source: "orchestrator",
              execution: "argv",
              exitCode: 0,
              passed: true,
              output: "passed",
            },
            {
              command: "npm test",
              source: "worker",
              execution: "reported",
              exitCode: 1,
              passed: false,
              output: "failed",
            },
          ],
        }),
    });

    assert.equal(result.passed, 1);
    assert.equal(result.failed, 0);
    const rendered = renderBatch(result);
    assert.match(rendered, /PASS \(worker claimed FAILED\)/);
    assert.match(rendered, /worker-claimed failure causes: verification/);
    assert.match(rendered, /authoritative 1 executed \(1 passed, 0 failed\)/);
    assert.match(rendered, /worker-reported 0 passed, 1 failed/);
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
    const many = Array.from({ length: 20 }, (_, index) =>
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

test("parallel git evidence is reconciled into the nested result before integration", async () => {
  const repo = await makeRepo();
  try {
    const events: Array<Record<string, unknown>> = [];
    const result = await runProductionBatch(
      [
        makeTask({
          objective: "Write the auth module from the worktree.",
          allowedFiles: ["src/auth/**"],
        }),
        makeTask({
          objective: "Write the payments module from the worktree.",
          allowedFiles: ["src/payments/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        eventEmitter: (event) => events.push(event),
        executor: async (input, options) => {
          const module = moduleOf(input);
          const relative = `src/${module}/from-git.ts`;
          const target = path.join(options.workingDirectory, ...relative.split("/"));
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, "export const done = true;\n", "utf8");
          return makeOutput({
            effort: input.effort,
            // The runtime report deliberately omits the edit. Git is the
            // authoritative evidence used by parallel integration.
            filesChanged: [],
          });
        },
      },
    );

    assert.equal(result.integrated, true, describeBatch(result));
    for (const task of result.tasks) {
      const nested = task.result?.filesChanged.find((file) => file.observed);
      assert.ok(nested, describeBatch(result));
      assert.equal(task.changedFiles.length, 1, describeBatch(result));
      assert.equal(nested?.path, task.changedFiles[0], describeBatch(result));
    }
    const completed = events.filter((event) => event.type === "worker.completed");
    assert.equal(completed.length, 2);
    assert.ok(completed.every((event) => event.changedFiles === 1));
  } finally {
    await cleanupRepo(repo);
  }
});

test("parallel timeout recovery resumes the same thread and integrates final evidence", async () => {
  const repo = await makeRepo();
  const calls: Array<{ directory: string; resumeThreadId?: string }> = [];
  const events: Array<Record<string, unknown>> = [];
  try {
    const result = await runProductionBatch(
      [makeTask({ allowedFiles: ["src/recovered/**"] })],
      {
        mode: "parallel",
        workingDirectory: repo,
        eventEmitter: (event) => events.push(event),
        executor: async (input, options) => {
          calls.push({
            directory: options.workingDirectory,
            resumeThreadId: options.resumeThreadId,
          });
          const target = path.join(
            options.workingDirectory,
            "src",
            "recovered",
            "value.ts",
          );
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(
            target,
            calls.length === 1 ? "initial\n" : "recovered\n",
            "utf8",
          );
          return makeOutput({
            effort: input.effort,
            workerThreadId: "thread-timeout",
            verdict: calls.length === 1 ? "FAILED" : "PASS",
            workerClaimedStatus: calls.length === 1 ? "FAILED" : "PASS",
            errors:
              calls.length === 1
                ? ["Worker exceeded its 1s budget and was aborted."]
                : [],
            filesChanged: [
              {
                path: "src/recovered/value.ts",
                kind: "add",
                why: "test",
                observed: true,
              },
            ],
          });
        },
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.directory, calls[1]?.directory);
    assert.equal(calls[0]?.resumeThreadId, undefined);
    assert.equal(calls[1]?.resumeThreadId, "thread-timeout");
    assert.equal(result.tasks[0]?.attempt, 2);
    assert.equal(result.tasks[0]?.result?.attempt, 2);
    assert.equal(
      result.tasks[0]?.result?.recovery?.classification,
      "timeout-continuation",
    );
    assert.equal(result.tasks[0]?.result?.recovery?.recoveryAttempt, 2);
    assert.equal(result.integrated, true);
    assert.equal(
      await fs.readFile(path.join(repo, "src", "recovered", "value.ts"), "utf8"),
      "recovered\n",
    );
    const recoveryDone = events.findIndex((event) => event.type === "recovery.completed");
    const integration = events.findIndex(
      (event) => event.type === "integration.completed",
    );
    assert.ok(recoveryDone >= 0 && integration > recoveryDone);
  } finally {
    await cleanupRepo(repo);
  }
});

test("parallel worker-process failures get one fresh retry in the same worktree", async () => {
  const repo = await makeRepo();
  const calls: Array<{ directory: string; resumeThreadId?: string }> = [];
  try {
    const result = await runProductionBatch(
      [makeTask({ allowedFiles: ["src/fresh/**"] })],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: async (input, options) => {
          calls.push({
            directory: options.workingDirectory,
            resumeThreadId: options.resumeThreadId,
          });
          if (calls.length === 1) throw new Error("worker process exited");
          const target = path.join(options.workingDirectory, "src", "fresh", "value.ts");
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, "fresh retry\n", "utf8");
          return makeOutput({
            effort: input.effort,
            workerThreadId: "thread-fresh",
            filesChanged: [
              { path: "src/fresh/value.ts", kind: "add", why: "test", observed: true },
            ],
          });
        },
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.directory, calls[1]?.directory);
    assert.equal(calls[0]?.resumeThreadId, undefined);
    assert.equal(calls[1]?.resumeThreadId, undefined);
    assert.equal(
      result.tasks[0]?.result?.recovery?.classification,
      "worker-process-retry",
    );
    assert.equal(result.tasks[0]?.result?.attempt, 2);
    assert.equal(result.passed, 1);
  } finally {
    await cleanupRepo(repo);
  }
});

test("parallel recovery runs independent failures concurrently and never retries successes", async () => {
  const repo = await makeRepo();
  const calls = new Map<string, number>();
  let activeRecovery = 0;
  let peakRecovery = 0;
  try {
    const result = await runProductionBatch(
      [
        makeTask({
          objective: "Successful stream stays single attempt.",
          allowedFiles: ["src/one/**"],
        }),
        makeTask({
          objective: "First failed stream recovers once.",
          allowedFiles: ["src/two/**"],
        }),
        makeTask({
          objective: "Second failed stream recovers once.",
          allowedFiles: ["src/three/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: async (input, options) => {
          const key = moduleOf(input);
          const count = (calls.get(key) ?? 0) + 1;
          calls.set(key, count);
          if (key === "one") return makeOutput({ effort: input.effort });
          if (count === 1) throw new Error(`first process failure for ${key}`);
          activeRecovery += 1;
          peakRecovery = Math.max(peakRecovery, activeRecovery);
          await new Promise((resolve) => setTimeout(resolve, 35));
          activeRecovery -= 1;
          const relative = `src/${key}/value.ts`;
          const target = path.join(options.workingDirectory, ...relative.split("/"));
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, "recovered\n", "utf8");
          return makeOutput({
            effort: input.effort,
            filesChanged: [{ path: relative, kind: "add", why: "test", observed: true }],
          });
        },
      },
    );
    assert.equal(calls.get("one"), 1);
    assert.equal(calls.get("two"), 2);
    assert.equal(calls.get("three"), 2);
    assert.equal(peakRecovery, 2);
    assert.equal(result.passed, 3);
  } finally {
    await cleanupRepo(repo);
  }
});

test("parallel recovery does not retry contract discrepancies and stops after one failed retry", async () => {
  const repo = await makeRepo();
  const calls = new Map<string, number>();
  try {
    const result = await runProductionBatch(
      [
        makeTask({
          objective: "Contract discrepancy stays parent-owned.",
          allowedFiles: ["src/discrepancy/**"],
        }),
        makeTask({
          objective: "Always failing stream gets one retry.",
          allowedFiles: ["src/bounded/**"],
        }),
        makeTask({
          objective: "Failed timeout recovery keeps the initial result evidence.",
          allowedFiles: ["src/timeout/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: async (input) => {
          const key = moduleOf(input);
          const count = (calls.get(key) ?? 0) + 1;
          calls.set(key, count);
          if (key === "discrepancy") {
            return makeOutput({
              verdict: "FAILED",
              workerClaimedStatus: "FAILED",
              discrepancies: ["contract mismatch"],
            });
          }
          if (key === "timeout" && count === 1) {
            return makeOutput({
              verdict: "FAILED",
              workerClaimedStatus: "FAILED",
              errors: ["Worker exceeded its 1s budget and was aborted."],
            });
          }
          throw new Error("persistent worker process failure");
        },
      },
    );
    assert.equal(calls.get("discrepancy"), 1);
    assert.equal(calls.get("bounded"), 2);
    assert.equal(calls.get("timeout"), 2);
    const bounded = result.tasks.find((task) => task.taskId === "t2")!;
    assert.equal(bounded.result, null);
    assert.equal(bounded.recovery?.attempted, true);
    assert.equal(bounded.recovery?.recoveryAttempt, 2);
    assert.equal(
      result.tasks.find((task) => task.taskId === "t1")?.recovery?.classification,
      "contract-discrepancy",
    );
    const timeout = result.tasks.find((task) => task.taskId === "t3")!;
    assert.equal(timeout.result?.verdict, "FAILED");
    assert.equal(timeout.result?.attempt, 2);
    assert.equal(timeout.result?.recovery?.classification, "timeout-continuation");
    assert.ok(
      timeout.result?.errors.some((error) =>
        error.includes("persistent worker process failure"),
      ),
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("successful integration emits applied counts before an explicit completion", async () => {
  const repo = await makeRepo();
  const events: Array<Record<string, unknown>> = [];
  try {
    const result = await runProductionBatch(
      [makeTask({ allowedFiles: ["src/integration/**"] })],
      {
        mode: "parallel",
        workingDirectory: repo,
        eventEmitter: (event) => events.push(event),
        executor: fakeExecutor({
          writes: () => ({ "src/integration/value.ts": "ok\n" }),
        }),
      },
    );
    assert.equal(result.integrated, true, describeBatch(result));
    const appliedIndex = events.findIndex(
      (event) => event.type === "integration.applied",
    );
    const completedIndex = events.findIndex(
      (event) => event.type === "integration.completed",
    );
    assert.ok(appliedIndex >= 0, JSON.stringify(events));
    assert.ok(completedIndex > appliedIndex, JSON.stringify(events));
    assert.equal(events[appliedIndex]?.fileCount, 1);
  } finally {
    await cleanupRepo(repo);
  }
});

test("partial integration retains truthful evidence after an earlier file applies", async () => {
  const repo = await makeRepo();
  const events: Array<Record<string, unknown>> = [];
  let retainedPath: string | null = null;
  try {
    const blocker = path.join(repo, "src", "integration-blocker");
    await fs.writeFile(blocker, "main-workspace blocker\n", "utf8");

    const result = await runProductionBatch(
      [
        makeTask({
          allowedFiles: [
            "src/integration-applied.txt",
            "src/integration-blocker/later.txt",
          ],
        }),
      ],
      {
        mode: "parallel",
        batchId: "b-partial-integration",
        workingDirectory: repo,
        eventEmitter: (event) => events.push(event),
        keepWorktrees: "onfailure",
        executor: fakeExecutor({
          writes: () => ({
            "src/integration-applied.txt": "applied before failure\n",
            "src/integration-blocker/later.txt": "cannot replace parent file\n",
          }),
        }),
      },
    );

    const task = result.tasks[0]!;
    retainedPath = task.worktreePath;
    assert.equal(result.passed, 1, describeBatch(result));
    assert.equal(result.failed, 0, describeBatch(result));
    assert.equal(task.state, "completed", describeBatch(result));
    assert.equal(task.result?.verdict, "PASS", describeBatch(result));
    assert.equal(task.result?.trustworthy, true, describeBatch(result));
    assert.deepEqual(task.result?.discrepancies, [], describeBatch(result));
    assert.equal(result.integrated, false, describeBatch(result));
    assert.match(result.integrationSummary, /incomplete after copying 1 file/i);
    assert.ok(
      result.warnings.some((warning) =>
        /Could not integrate src\/integration-blocker\/later\.txt from t1/.test(warning),
      ),
      describeBatch(result),
    );

    const partial = events.find((event) => event.type === "integration.partial");
    assert.deepEqual(
      partial,
      {
        type: "integration.partial",
        batchId: "b-partial-integration",
        taskId: "t1",
        attemptedFiles: 2,
        appliedFiles: 1,
      },
      JSON.stringify(events),
    );
    assert.equal(
      events.find((event) => event.type === "integration.applied")?.fileCount,
      1,
    );
    assert.equal(
      events.some((event) => event.type === "integration.completed"),
      false,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "worktree.retained" && event.reason === "integration-partial",
      ),
      JSON.stringify(events),
    );

    assert.equal(
      await fs.readFile(path.join(repo, "src", "integration-applied.txt"), "utf8"),
      "applied before failure\n",
    );
    assert.equal(await fs.readFile(blocker, "utf8"), "main-workspace blocker\n");
    assert.equal(await fs.stat(path.join(blocker, "later.txt")).catch(() => null), null);
    assert.ok(retainedPath, describeBatch(result));
    assert.equal(
      await fs.readFile(
        path.join(retainedPath!, "src", "integration-applied.txt"),
        "utf8",
      ),
      "applied before failure\n",
    );
    assert.equal(
      await fs.readFile(
        path.join(retainedPath!, "src", "integration-blocker", "later.txt"),
        "utf8",
      ),
      "cannot replace parent file\n",
    );
    assert.equal(
      await fs.stat(continuationLeasePath(retainedPath!)).catch(() => null),
      null,
    );
  } finally {
    if (retainedPath) {
      await cleanupWorktree(
        { taskId: "t1", path: retainedPath, repoRoot: repo, warnings: [] },
        "success",
        "never",
      ).catch(() => undefined);
    }
    await cleanupRepo(repo);
  }
});

test("git evidence drives parallel scope and change-intent verdicts", async () => {
  const repo = await makeRepo();
  try {
    const outside = await runBatch(
      [
        makeTask({
          objective: "Write only inside the declared module.",
          allowedFiles: ["src/allowed/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: async (_input, options) => {
          await fs.writeFile(path.join(options.workingDirectory, "outside.ts"), "x\n");
          return makeOutput({ filesChanged: [] });
        },
      },
    );
    const outsideResult = outside.tasks[0]?.result;
    assert.ok(outsideResult?.verdict === "FAILED", describeBatch(outside));
    assert.equal(outsideResult?.trustworthy, false);
    assert.ok(
      outsideResult?.scopeViolations.some((item) => /outside allowedFiles/.test(item)),
    );
    assert.match(outsideResult?.escalationAdvice ?? "", /outside its file scope/i);
    assert.deepEqual(outside.tasks[0]?.changedFiles, ["outside.ts"]);

    const forbidden = await runBatch(
      [
        makeTask({
          objective: "Do not edit the forbidden module.",
          changeIntent: "forbidden",
          allowedFiles: ["src/forbidden/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: async (_input, options) => {
          const target = path.join(options.workingDirectory, "src", "forbidden", "x.ts");
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, "x\n");
          return makeOutput({ filesChanged: [] });
        },
      },
    );
    const forbiddenResult = forbidden.tasks[0]?.result;
    assert.equal(forbiddenResult?.verdict, "FAILED", JSON.stringify(forbidden));
    assert.equal(forbiddenResult?.trustworthy, false);
    assert.ok(
      forbiddenResult?.discrepancies.some((item) =>
        /change intent contract violated/i.test(item),
      ),
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("a worktree evidence scan failure is explicit and retains diagnosis state", async () => {
  const repo = await makeRepo();
  const events: Array<Record<string, unknown>> = [];
  let retainedPath: string | null = null;
  let movedPath: string | null = null;
  try {
    const result = await runProductionBatch(
      [makeTask({ allowedFiles: ["src/scan/**"] })],
      {
        mode: "parallel",
        workingDirectory: repo,
        eventEmitter: (event) => events.push(event),
        executor: async (_input, options) => {
          movedPath = `${options.workingDirectory}.moved`;
          await fs.rename(options.workingDirectory, movedPath);
          await fs.writeFile(
            options.workingDirectory,
            "the worktree disappeared\n",
            "utf8",
          );
          return makeOutput();
        },
      },
    );

    const task = result.tasks[0]!;
    retainedPath = task.worktreePath;
    assert.ok(
      task.state === "failed",
      `${describeBatch(result)} result=${JSON.stringify(task.result)}`,
    );
    assert.match(task.error ?? "", /worktree evidence/i);
    assert.equal(task.result?.verdict, "FAILED");
    assert.equal(task.result?.trustworthy, false);
    assert.ok(task.result?.errors.some((error) => /evidence scan failed/i.test(error)));
    assert.match(result.integrationSummary, /evidence scan failed/i);
    assert.equal(result.integrated, false);
    assert.ok(retainedPath, describeBatch(result));
    assert.ok(await fs.stat(retainedPath!).catch(() => null));
    assert.equal(
      events.filter((event) => event.type === "integration.notAttempted").length,
      1,
    );
    assert.equal(events.filter((event) => event.type === "integration.failed").length, 0);
    assert.equal(
      events.filter((event) => event.type === "integration.applied").length,
      0,
    );
  } finally {
    if (retainedPath) {
      await fs.rm(retainedPath, { recursive: true, force: true }).catch(() => undefined);
      if (movedPath && (await fs.stat(movedPath).catch(() => null))) {
        await fs.rename(movedPath, retainedPath).catch(() => undefined);
      }
      await cleanupWorktree(
        {
          taskId: "t1",
          path: retainedPath,
          repoRoot: repo,
          warnings: [],
        },
        "success",
        "never",
      ).catch(() => undefined);
    }
    await cleanupRepo(repo);
  }
});

test("invalid batch workspace emits a reducer-visible rejected lifecycle", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-invalid-workspace-"));
  const events: Array<Record<string, unknown>> = [];
  try {
    await assert.rejects(
      runProductionBatch([makeTask({ activityLabel: "Invalid workspace task" })], {
        mode: "sequential",
        workingDirectory: path.join(parent, "missing"),
        eventEmitter: (event) => events.push(event),
        executor: fakeExecutor({}),
      }),
      BatchRejectedError,
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["batch.started", "task.queued", "batch.rejected"],
    );
  } finally {
    await cleanupRepo(parent);
  }
});

test("clean parallel batch returns risk-based review checklist without unconditional full-suite or diff reread", async () => {
  const repo = await makeRepo();
  try {
    const result = await runBatch(
      [
        makeTask({
          objective: "Implement first module.",
          allowedFiles: ["src/one/**"],
        }),
        makeTask({
          objective: "Implement second module.",
          allowedFiles: ["src/two/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: fakeExecutor({
          writes: (task) =>
            moduleOf(task) === "one"
              ? ({ "src/one/mod.ts": "export const a = 1;\n" } as Record<string, string>)
              : ({ "src/two/mod.ts": "export const b = 2;\n" } as Record<string, string>),
        }),
      },
    );

    assert.equal(result.passed, 2);
    assert.equal(result.integrated, true);
    assert.ok(
      result.reviewChecklist.some((item) => /high-risk or architecturally/i.test(item)),
      "clean batch should instruct risk-based diff review",
    );
    assert.ok(
      result.reviewChecklist.some((item) => /if the changes can interact/i.test(item)),
      "clean batch should instruct risk-based interaction check",
    );
    assert.ok(
      !result.reviewChecklist.some((item) => /Run the full test suite once/i.test(item)),
      "clean batch must not demand unconditional full test suite rerun",
    );
    assert.ok(
      !result.reviewChecklist.some((item) =>
        /Read the (actual )?diff of every/i.test(item),
      ),
      "clean batch must not demand unconditional diff reread",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("parallel batch with integration conflicts retains deeper review guidance", async () => {
  const repo = await makeRepo();
  try {
    const result = await runBatch(
      [
        makeTask({
          objective: "First module conflicting.",
          allowedFiles: ["src/**"],
        }),
        makeTask({
          objective: "Second module conflicting.",
          allowedFiles: ["src/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        allowOverlappingScopes: true,
        executor: fakeExecutor({
          writes: () => ({ "src/conflict.ts": "content\n" }),
        }),
      },
    );

    assert.equal(result.integrationConflicts.length, 1);
    assert.equal(result.integrated, false);
    assert.ok(
      result.reviewChecklist.some((item) => /Resolve 1 integration conflict/i.test(item)),
      "conflicts must instruct manual resolution",
    );
    assert.ok(
      result.reviewChecklist.some((item) => /Read the actual diff/i.test(item)),
      "conflicts must demand diff reading",
    );
    assert.ok(
      result.reviewChecklist.some((item) => /weaken tests, loosen types/i.test(item)),
      "conflicts must check for test weakening",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("parallel batch with untrusted worker results retains deeper review guidance", async () => {
  const repo = await makeRepo();
  try {
    const result = await runBatch(
      [
        makeTask({
          objective: "Implement first module.",
          allowedFiles: ["src/one/**"],
        }),
        makeTask({
          objective: "Implement second module.",
          allowedFiles: ["src/two/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: fakeExecutor({
          writes: (task) =>
            moduleOf(task) === "one"
              ? ({ "src/one/mod.ts": "export const a = 1;\n" } as Record<string, string>)
              : ({ "src/two/mod.ts": "export const b = 2;\n" } as Record<string, string>),
          output: (task) =>
            moduleOf(task) === "two"
              ? {
                  trustworthy: false,
                  discrepancies: ["Worker claims contradicted by evidence."],
                }
              : {},
        }),
      },
    );

    assert.ok(
      result.reviewChecklist.some((item) => /Scrutinise t2/i.test(item)),
      "untrusted worker must be called out for scrutiny",
    );
    assert.ok(
      result.reviewChecklist.some((item) => /Read the actual diff/i.test(item)),
      "untrusted batch must demand diff reading",
    );
    assert.ok(
      result.reviewChecklist.some((item) => /weaken tests, loosen types/i.test(item)),
      "untrusted batch must check for test weakening",
    );
  } finally {
    await cleanupRepo(repo);
  }
});

test("parallel batch with partial failure retains deeper review guidance", async () => {
  const repo = await makeRepo();
  try {
    const result = await runBatch(
      [
        makeTask({
          objective: "Implement first module.",
          allowedFiles: ["src/one/**"],
        }),
        makeTask({
          objective: "Implement second module.",
          allowedFiles: ["src/two/**"],
        }),
      ],
      {
        mode: "parallel",
        workingDirectory: repo,
        executor: fakeExecutor({
          fail: (task) => moduleOf(task) === "two",
          writes: (task) => ({ [`src/${moduleOf(task)}/mod.ts`]: "x\n" }),
        }),
      },
    );

    assert.ok(
      result.reviewChecklist.some((item) => /Partial success/i.test(item)),
      "partial success must be called out",
    );
    assert.ok(
      result.reviewChecklist.some((item) => /Read the actual diff/i.test(item)),
      "partial failures must demand diff reading",
    );
    assert.ok(
      result.reviewChecklist.some((item) => /weaken tests, loosen types/i.test(item)),
      "partial failures must check for test weakening",
    );
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

async function captureBatchEvents(
  mode: "parallel" | "sequential",
  workingDirectory: string,
  abortBeforeStart = false,
  timeoutFirst = false,
): Promise<Record<string, unknown>[]> {
  const eventRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-events-"));
  const eventsPath = path.join(eventRoot, "events.jsonl");
  const configuredPath = path.join(eventRoot, "configured-events.jsonl");
  const configuredSentinel = '{"type":"real-history-sentinel"}\n';
  await fs.writeFile(configuredPath, configuredSentinel, "utf8");
  const batchModule = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "batch.js"),
  ).href;
  const eventsModule = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "events.js"),
  ).href;
  const tasks = [
    makeTask({
      objective: "Complete the first event task.",
      activityLabel: "First event task",
      allowedFiles: ["src/one/**"],
    }),
    makeTask({
      objective: "Throw from the second event task.",
      allowedFiles: ["src/two/**"],
    }),
    makeTask({
      objective: "Return no output from the third event task.",
      allowedFiles: ["src/three/**"],
    }),
  ];
  const runner = `
const { runBatch } = await import(${JSON.stringify(batchModule)});
const { createEventEmitter } = await import(${JSON.stringify(eventsModule)});
const tasks = ${JSON.stringify(tasks)};
const controller = new AbortController();
if (${JSON.stringify(abortBeforeStart)}) controller.abort();
  await runBatch(tasks, {
    mode: ${JSON.stringify(mode)},
    automaticRecovery: false,
    workingDirectory: ${JSON.stringify(workingDirectory)},
  signal: controller.signal,
  eventEmitter: createEventEmitter(${JSON.stringify(eventsPath)}),
  executor: async (input) => {
    if (input.objective.includes("Throw")) throw new Error("fixture failure");
    if (input.objective.includes("no output")) return undefined;
    const timedOut = ${JSON.stringify(timeoutFirst)} && input.objective.includes("first");
    return {
      verdict: timedOut ? "FAILED" : "PASS",
      workerClaimedStatus: timedOut ? "FAILED" : "PASS",
      trustworthy: !timedOut,
      workerThreadId: "fixture-thread",
      model: "fixture-model",
      effort: input.effort,
      effortReason: input.effortReason,
      attempt: 1,
      summary: "fixture result",
      notes: "",
      followUps: [],
      filesChanged: [],
      verification: [],
      verificationMode: "allowlist",
      scopeViolations: [],
      discrepancies: [],
      reviewChecklist: [],
      escalationAdvice: null,
      durationSeconds: 0,
      usage: null,
      errors: timedOut ? ["Worker exceeded its 1800s budget."] : [],
    };
  },
});
`;

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", runner], {
        env: {
          ...process.env,
          LUNA_MODEL: "gpt-5.6-luna",
          LUNA_TIMEOUT_SECONDS: "1800",
          SOL_LUNA_EVENTS: configuredPath,
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`event fixture exited ${code}: ${stderr}`));
      });
    });
    assert.equal(
      await fs.readFile(configuredPath, "utf8"),
      configuredSentinel,
      "an inherited production activity path must remain append-only and untouched by fixtures",
    );
    const lines = (await fs.readFile(eventsPath, "utf8")).trim().split("\n");
    return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  } finally {
    await fs.rm(eventRoot, { recursive: true, force: true });
  }
}

test("batch timeout events use the real default when the task omits a timeout", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-timeout-event-"));
  try {
    const events = await captureBatchEvents("sequential", work, false, true);
    const timedOut = events.find((event) => event.type === "worker.timedOut");
    assert.equal(timedOut?.timeoutSeconds, 1800);
  } finally {
    await cleanupRepo(work);
  }
});

test("event-emitting batch fixtures cannot append to an inherited activity path", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-event-seam-"));
  try {
    const events = await captureBatchEvents("sequential", work);
    assert.ok(events.some((event) => event.type === "batch.started"));
    assert.ok(events.some((event) => event.type === "batch.completed"));
  } finally {
    await cleanupRepo(work);
  }
});

for (const mode of ["parallel", "sequential"] as const) {
  test(`${mode} batches record one completion per returned result`, async () => {
    const repo =
      mode === "parallel"
        ? await makeRepo()
        : await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-events-work-"));
    try {
      const events = await captureBatchEvents(mode, repo);
      const queued = events.filter((event) => event.type === "task.queued");
      assert.equal(queued.length, 3);
      assert.ok(queued.every((event) => !("objective" in event)));
      assert.deepEqual(
        queued.map((event) => event.taskId),
        ["t1", "t2", "t3"],
        "task ids remain opaque and are not derived from objective text",
      );
      assert.equal(queued[0]?.activityLabel, "First event task");
      assert.ok(queued.every((event) => event.model === "gpt-5.6-luna"));
      assert.ok(
        events
          .filter((event) => event.type === "worker.started")
          .every((event) => event.model === "gpt-5.6-luna"),
      );
      const completed = events.filter((event) => event.type === "worker.completed");
      assert.equal(completed.length, 1);
      assert.equal(completed[0]?.changedFiles, 0);
      assert.equal(events.filter((event) => event.type === "worker.failed").length, 2);
      assert.equal(new Set(completed.map((event) => event.taskId)).size, 1);
    } finally {
      await cleanupRepo(repo);
    }
  });

  test(`${mode} batches with no started tasks record no completions`, async () => {
    const repo =
      mode === "parallel"
        ? await makeRepo()
        : await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-events-cancelled-"));
    try {
      const events = await captureBatchEvents(mode, repo, true);
      assert.equal(events.filter((event) => event.type === "worker.completed").length, 0);
      assert.equal(events.filter((event) => event.type === "worker.cancelled").length, 3);
      assert.equal(events.filter((event) => event.type === "batch.cancelled").length, 1);
      assert.equal(events.filter((event) => event.type === "batch.completed").length, 0);
    } finally {
      await cleanupRepo(repo);
    }
  });
}
