import assert from "node:assert/strict";
import test from "node:test";
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
