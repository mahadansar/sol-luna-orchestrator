import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ShutdownCoordinator,
  ShutdownInProgressError,
  ShutdownTimeoutError,
} from "./shutdown.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done as (value?: T | PromiseLike<T>) => void;
  });
  return { promise, resolve };
}

test("shutdown cancels active and queued operations, awaits cleanup, and closes once", async () => {
  const coordinator = new ShutdownCoordinator();
  const activeStarted = deferred();
  const queuedStarted = deferred();
  const allowCleanup = deferred();
  let observedAborts = 0;
  let cleanupCalls = 0;
  coordinator.registerCleanup(() => {
    cleanupCalls += 1;
  });

  const operation = (started: ReturnType<typeof deferred<void>>) =>
    coordinator.run(undefined, async (signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            observedAborts += 1;
            resolve();
          },
          { once: true },
        );
      });
      await allowCleanup.promise;
      return "late-success";
    });

  const active = operation(activeStarted);
  const queued = operation(queuedStarted);
  await Promise.all([activeStarted.promise, queuedStarted.promise]);

  const shuttingDown = coordinator.shutdown(1_000);
  assert.equal(coordinator.state, "shutting-down");
  await assert.rejects(
    coordinator.run(undefined, async () => "new-success"),
    ShutdownInProgressError,
  );
  assert.equal(observedAborts, 2);
  assert.equal(
    cleanupCalls,
    0,
    "global cleanup waits for operation-owned finally blocks",
  );

  allowCleanup.resolve();
  await assert.rejects(active, ShutdownInProgressError);
  await assert.rejects(queued, ShutdownInProgressError);
  const result = await shuttingDown;
  assert.deepEqual(result, { state: "closed", cancelledOperations: 2 });
  assert.equal(cleanupCalls, 1);
  assert.equal(coordinator.activeCount, 0);
  assert.strictEqual(coordinator.shutdown(), shuttingDown);
});

test("shutdown fails closed when an operation ignores cancellation past the bound", async () => {
  const coordinator = new ShutdownCoordinator();
  const started = deferred();
  const never = deferred();
  void coordinator
    .run(undefined, async () => {
      started.resolve();
      await never.promise;
      return "unreachable";
    })
    .catch(() => undefined);
  await started.promise;

  await assert.rejects(coordinator.shutdown(20), ShutdownTimeoutError);
  assert.equal(coordinator.state, "failed");
  await assert.rejects(
    coordinator.run(undefined, async () => "new-success"),
    ShutdownInProgressError,
  );
});

test("shutdown abort releases referenced worktree lease maintenance so the process can exit", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const shutdownModule = pathToFileURL(path.join(here, "shutdown.js")).href;
  const worktreeModule = pathToFileURL(path.join(here, "worktree.js")).href;
  const script = `
    import fs from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { ShutdownCoordinator, ShutdownTimeoutError } from ${JSON.stringify(shutdownModule)};
    import { WorktreeLeaseStore, WORKTREE_LEASE_GRACE_MS } from ${JSON.stringify(worktreeModule)};

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-shutdown-lease-"));
    const artifact = path.join(root, ".sol-luna", "worktrees", ".metadata");
    const lifetimeMs = WORKTREE_LEASE_GRACE_MS + 5_000;
    const leases = new WorktreeLeaseStore({ maintenanceIntervalMs: 5 });
    const lease = await leases.acquire(artifact, Date.now() + lifetimeMs, "metadata");
    const coordinator = new ShutdownCoordinator();
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    void coordinator.run(undefined, async (signal) => {
      leases.maintain(lease, lifetimeMs, "metadata", signal);
      started();
      await new Promise(() => {});
    }).catch(() => undefined);
    await startedPromise;
    try {
      await coordinator.shutdown(20);
      process.exitCode = 2;
    } catch (error) {
      if (!(error instanceof ShutdownTimeoutError)) throw error;
    }
    await fs.rm(root, { recursive: true, force: true });
    console.log("shutdown-bound-settled");
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exit = new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `child stayed alive past shutdown bound; stdout=${stdout}; stderr=${stderr}`,
        ),
      );
    }, 2_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.equal(await exit, 0, stderr);
  assert.match(stdout, /shutdown-bound-settled/);
});

test("shutdown timeout force-stops repository operation renewal without reopening the repo", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const shutdownModule = pathToFileURL(path.join(here, "shutdown.js")).href;
  const worktreeModule = pathToFileURL(path.join(here, "worktree.js")).href;
  const gitModule = pathToFileURL(path.join(here, "git.js")).href;
  const script = `
    import fs from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { ShutdownCoordinator, ShutdownTimeoutError } from ${JSON.stringify(shutdownModule)};
    import {
      acquireRepositoryOperationAuthority,
      forceStopRepositoryOperationRenewals,
    } from ${JSON.stringify(worktreeModule)};
    import { runGit } from ${JSON.stringify(gitModule)};

    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-shutdown-operation-"));
    await runGit(["init", "-q"], repo);
    const coordinator = new ShutdownCoordinator();
    coordinator.registerForcedCleanup(() => forceStopRepositoryOperationRenewals());
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    let authority;
    void coordinator.run(undefined, async () => {
      authority = await acquireRepositoryOperationAuthority(repo);
      if (!authority) throw new Error("expected Git repository operation authority");
      started();
      await new Promise(() => {});
    }).catch(() => undefined);
    await startedPromise;
    const leaseArtifact = path.join(
      authority.commonGitDir,
      "sol-luna-orchestrator",
      "continuation-leases",
      ".repository.lease",
    );
    if (!(await fs.stat(leaseArtifact).catch(() => null))) {
      throw new Error("healthy operation authority did not publish its referenced lease");
    }
    const waiter = acquireRepositoryOperationAuthority(repo).then(
      () => {
        throw new Error("waiting repository operation unexpectedly acquired authority");
      },
      (error) => error,
    );
    try {
      await coordinator.shutdown(20);
      process.exitCode = 2;
    } catch (error) {
      if (!(error instanceof ShutdownTimeoutError)) throw error;
    }
    if (!(await fs.stat(leaseArtifact).catch(() => null))) {
      throw new Error("forced shutdown removed the still-needed repository operation owner");
    }
    let unhealthy = false;
    try {
      authority.assertHealthy();
    } catch (error) {
      unhealthy = /force-stopped during shutdown/i.test(String(error?.message ?? error));
    }
    if (!unhealthy) {
      throw new Error("forced shutdown did not mark repository operation authority unhealthy");
    }
    const waiterError = await waiter;
    if (waiterError?.name !== "AbortError") {
      throw new Error(
        "forced shutdown did not cancel a pending repository-operation acquisition",
      );
    }
    await fs.rm(repo, { recursive: true, force: true });
    console.log("repository-operation-renewal-and-waiter-force-stopped");
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exit = new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `child stayed alive after forced repository-operation renewal stop; stdout=${stdout}; stderr=${stderr}`,
        ),
      );
    }, 3_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.equal(await exit, 0, stderr);
  assert.match(stdout, /repository-operation-renewal-and-waiter-force-stopped/);
});

test("forced shutdown during repository acquisition cannot start an untracked renewal", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const worktreeModule = pathToFileURL(path.join(here, "worktree.js")).href;
  const gitModule = pathToFileURL(path.join(here, "git.js")).href;
  const script = `
    import fs from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import {
      acquireRepositoryOperationAuthority,
      forceStopRepositoryOperationRenewals,
    } from ${JSON.stringify(worktreeModule)};
    import { runGit } from ${JSON.stringify(gitModule)};

    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-shutdown-acquire-race-"));
    await runGit(["init", "-q"], repo);
    let seamReached = false;
    try {
      await acquireRepositoryOperationAuthority(repo, undefined, {
        afterLeaseAcquired: async () => {
          seamReached = true;
          await forceStopRepositoryOperationRenewals();
        },
      });
      throw new Error("authority escaped a forced shutdown that began during acquisition");
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
    }
    if (!seamReached) throw new Error("post-acquire shutdown seam was not exercised");
    await fs.rm(repo, { recursive: true, force: true });
    console.log("post-acquire-forced-shutdown-released");
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exit = new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `child stayed alive after post-acquire forced shutdown; stdout=${stdout}; stderr=${stderr}`,
        ),
      );
    }, 3_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.equal(await exit, 0, stderr);
  assert.match(stdout, /post-acquire-forced-shutdown-released/);
});
