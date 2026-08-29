/** Process-local admission and bounded shutdown coordination. */

export type ShutdownState = "accepting" | "shutting-down" | "closed" | "failed";

export class ShutdownInProgressError extends Error {
  constructor(
    message = "The orchestrator is shutting down and is not accepting new work.",
  ) {
    super(message);
    this.name = "ShutdownInProgressError";
  }
}

export class ShutdownTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Orchestrator shutdown exceeded its ${timeoutMs}ms cleanup bound.`);
    this.name = "ShutdownTimeoutError";
  }
}

export interface ShutdownResult {
  readonly state: "closed";
  readonly cancelledOperations: number;
}

type Cleanup = () => void | Promise<void>;

/**
 * Owns every admitted top-level server operation in this process.
 *
 * Subsystems continue to own their resources and finally blocks. Shutdown only
 * stops admission, aborts their shared signal, waits for those owners to settle,
 * then runs process-lifetime store cleanup exactly once.
 */
export class ShutdownCoordinator {
  private stateValue: ShutdownState = "accepting";
  private readonly active = new Map<symbol, AbortController>();
  private readonly settlements = new Map<symbol, Promise<void>>();
  private readonly cleanups: Cleanup[] = [];
  private shutdownPromise: Promise<ShutdownResult> | null = null;

  get state(): ShutdownState {
    return this.stateValue;
  }

  get activeCount(): number {
    return this.active.size;
  }

  registerCleanup(cleanup: Cleanup): void {
    if (this.stateValue !== "accepting") throw new ShutdownInProgressError();
    this.cleanups.push(cleanup);
  }

  async run<T>(
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.stateValue !== "accepting") throw new ShutdownInProgressError();

    const token = Symbol("server-operation");
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener("abort", forwardAbort, { once: true });

    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.active.set(token, controller);
    this.settlements.set(token, settled);

    try {
      const result = await operation(controller.signal);
      // An operation that ignored cancellation cannot publish a new success
      // after the process-wide authority boundary began closing.
      if (this.stateValue !== "accepting" || controller.signal.aborted) {
        throw new ShutdownInProgressError(
          "The operation completed after shutdown began; its result was not published as success.",
        );
      }
      return result;
    } finally {
      externalSignal?.removeEventListener("abort", forwardAbort);
      this.active.delete(token);
      this.settlements.delete(token);
      settle();
    }
  }

  shutdown(timeoutMs = 30_000): Promise<ShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stateValue = "shutting-down";
    const cancelledOperations = this.active.size;
    for (const controller of this.active.values()) controller.abort("server-shutdown");

    this.shutdownPromise = this.finishShutdown(timeoutMs, cancelledOperations);
    return this.shutdownPromise;
  }

  private async finishShutdown(
    timeoutMs: number,
    cancelledOperations: number,
  ): Promise<ShutdownResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ShutdownTimeoutError(timeoutMs)), timeoutMs);
      timer.unref?.();
    });

    try {
      await Promise.race([
        (async () => {
          await Promise.allSettled([...this.settlements.values()]);
          const failures: unknown[] = [];
          for (const cleanup of this.cleanups) {
            try {
              await cleanup();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, "One or more shutdown cleanups failed.");
          }
        })(),
        timeout,
      ]);
      this.stateValue = "closed";
      return { state: "closed", cancelledOperations };
    } catch (error) {
      this.stateValue = "failed";
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
