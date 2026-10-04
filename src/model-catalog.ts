/** Read-only Codex catalog discovery. No thread, turn, or model request is made. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveExecutable, withoutCwdExecutableLookup } from "./executable.js";

export const LATEST_LUNA_SELECTOR = "latest-luna";
const versionOf = (model: string): number[] | null => {
  if (!/^gpt-[1-9]\d{0,3}(?:\.(?:0|[1-9]\d{0,3})){0,3}-luna$/.test(model)) return null;
  return model.slice(4, -5).split(".").map(Number);
};
const compare = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
};

export function selectLatestLuna(
  entries: readonly unknown[],
  efforts: readonly string[],
): string {
  const candidates = new Map<string, number[]>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.model !== "string") continue;
    const version = versionOf(item.model);
    if (!version) continue;
    // Conflicting duplicates must never hide an incompatible/hidden declaration.
    if (seen.has(item.model))
      throw new Error("Codex catalog contains duplicate Luna models.");
    seen.add(item.model);
    if (item.hidden !== false || compare(version, [6]) < 0) continue;
    if (!Array.isArray(item.supportedReasoningEfforts)) continue;
    const supported = item.supportedReasoningEfforts.map((effort: unknown) =>
      effort && typeof effort === "object"
        ? (effort as Record<string, unknown>).reasoningEffort
        : null,
    );
    if (efforts.every((effort) => supported.includes(effort))) {
      candidates.set(item.model, version);
    }
  }
  const ordered = [...candidates].sort(
    ([a, av], [b, bv]) => compare(bv, av) || a.localeCompare(b),
  );
  if (!ordered.length) {
    throw new Error(
      "No visible GPT-6-or-newer Luna model supports all allowed efforts in the Codex catalog. " +
        "Update Codex or set LUNA_MODEL to an explicit model pin.",
    );
  }
  return ordered[0]![0];
}

/** Resolve the public CLI entrypoint from the same installed dependency as the SDK. */
export function installedCodexCatalogCommand(): readonly string[] {
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const manifestPath = sdkRequire.resolve("@openai/codex/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: { codex?: unknown };
  };
  const relative = manifest.bin?.codex;
  if (typeof relative !== "string")
    throw new Error("Installed Codex has no public CLI entrypoint.");
  const root = path.dirname(manifestPath);
  const entry = path.resolve(root, relative);
  const fromRoot = path.relative(root, entry);
  if (!fromRoot || fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
    throw new Error("Installed Codex CLI entrypoint escapes its package.");
  }
  return [process.execPath, entry, "app-server"];
}

export interface CatalogOptions {
  /** Trusted injection for deterministic subprocess fixtures; never a tool input. */
  command: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  maxPages?: number;
  signal?: AbortSignal;
}

/** Kill the isolated process group/tree, including the public CLI's native child. */
async function terminateCatalogTree(pid: number): Promise<boolean> {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* best effort */
      }
      return false;
    }
  }
  return await new Promise<boolean>((resolve) => {
    let killer;
    const fallback = (): void => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* best effort */
      }
    };
    try {
      killer = spawn(resolveExecutable("taskkill"), ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        env: withoutCwdExecutableLookup(process.env),
      });
    } catch {
      fallback();
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!confirmed) fallback();
      resolve(confirmed);
    };
    const timer = setTimeout(() => {
      killer.kill();
      finish(false);
    }, 2000);
    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

/** Bounded JSON-lines initialize/model-list exchange, with no inference calls. */
export async function readCodexModelCatalog(options: CatalogOptions): Promise<unknown[]> {
  if (options.signal?.aborted) throw new Error("Luna catalog discovery cancelled.");
  const [executable, ...args] = options.command;
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error("Catalog launcher must be a trusted absolute executable.");
  }
  const child = spawn(executable, args, {
    cwd: os.tmpdir(),
    env: withoutCwdExecutableLookup({ ...process.env, SOL_LUNA_WORKER: "1" }),
    stdio: "pipe",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let closed = false;
  const close = new Promise<void>((resolve) =>
    child.once("close", () => {
      closed = true;
      resolve();
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      let bytes = 0;
      let buffer = "";
      let requestId = 0;
      let pages = 0;
      const cursors = new Set<string>();
      const entries: unknown[] = [];
      const decoder = new StringDecoder("utf8");
      let failed = false;
      const fail = (reason: string): void => {
        failed = true;
        reject(new Error(`Luna catalog discovery: ${reason}`));
      };
      abort = () => fail("startup cancelled.");
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      const send = (message: unknown): void => {
        child.stdin.write(JSON.stringify(message) + "\n", (error) => {
          if (error) fail("could not write to Codex app-server.");
        });
      };
      const requestPage = (cursor?: string): void => {
        if (++pages > (options.maxPages ?? 50)) {
          fail("pagination limit exceeded.");
          return;
        }
        send({
          id: ++requestId,
          method: "model/list",
          params: {
            limit: 20,
            includeHidden: false,
            ...(cursor ? { cursor } : {}),
          },
        });
      };
      timer = setTimeout(
        () => fail("startup deadline exceeded; pin LUNA_MODEL or update Codex."),
        options.timeoutMs ?? 10000,
      );
      child.once("error", () => fail("could not start Codex app-server."));
      child.stdin.on("error", () => fail("Codex app-server input closed."));
      child.once("close", (code) => {
        if (!complete) fail(`Codex app-server exited before discovery (code ${code}).`);
      });
      const count = (chunk: Buffer): boolean => {
        bytes += chunk.length;
        if (bytes > (options.maxBytes ?? 4 * 1024 * 1024)) {
          fail("response byte limit exceeded.");
          return false;
        }
        return true;
      };
      // Drain, bound, and never print raw diagnostics, which may contain account data.
      child.stderr.on("data", (chunk: Buffer) => {
        count(chunk);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (!count(chunk) || complete || failed) return;
        buffer += decoder.write(chunk);
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0 && !complete && !failed) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            if (!message || typeof message !== "object" || Array.isArray(message))
              throw new Error();
            if (!Object.hasOwn(message, "id") && typeof message.method === "string")
              continue;
            if (
              message.id !== requestId ||
              message.error ||
              !Object.hasOwn(message, "result")
            )
              throw new Error();
            if (requestId === 0) {
              send({ method: "initialized", params: {} });
              requestPage();
              continue;
            }
            const result = message.result as Record<string, unknown> | null;
            if (!result || !Array.isArray(result.data) || result.data.length > 20)
              throw new Error();
            entries.push(...result.data);
            const cursor = result.nextCursor;
            if (cursor === null) {
              complete = true;
              resolve(entries);
            } else if (
              typeof cursor === "string" &&
              cursor.length > 0 &&
              cursor.length <= 4096 &&
              !cursors.has(cursor)
            ) {
              cursors.add(cursor);
              requestPage(cursor);
            } else throw new Error();
          } catch {
            fail("malformed, unexpected, or repeated catalog response.");
            return;
          }
        }
      });
      send({
        id: 0,
        method: "initialize",
        params: {
          clientInfo: { name: "sol_luna_orchestrator", version: "1.0.0" },
        },
      });
    });
  } finally {
    if (abort) options.signal?.removeEventListener("abort", abort);
    if (timer) clearTimeout(timer);
    // Terminate even after successful discovery: EOF alone is not a cleanup guarantee.
    const treeConfirmed = closed || !child.pid || (await terminateCatalogTree(child.pid));
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      close,
      new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, 2000);
      }),
    ]);
    if (closeTimer) clearTimeout(closeTimer);
    if (!closed || !treeConfirmed) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      child.unref();
      throw new Error("Codex catalog process cleanup could not be confirmed.");
    }
  }
}

export async function discoverLatestLuna(efforts: readonly string[]): Promise<string> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const entries = await readCodexModelCatalog({
      command: installedCodexCatalogCommand(),
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw new Error("Luna catalog discovery cancelled.");
    return selectLatestLuna(entries, efforts);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
