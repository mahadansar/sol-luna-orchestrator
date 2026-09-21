import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface PinnedDirectoryAuthority {
  directory: string;
  canonical: string;
  identity: string;
}

export type PinnedDirectoryMutation =
  | { op: "mkdir"; name: string }
  | {
      op: "write-file";
      name: string;
      bytesBase64: string;
      mode: "exclusive" | "replace";
      expectedIdentity?: string;
      expectedSignature?: string;
      testMaxWriteBytes?: number;
      testFailAfterTruncate?: boolean;
      testFailAfterBytes?: number;
    }
  | {
      op: "copy-directory";
      name: string;
      source: string;
    }
  | {
      op: "symlink";
      name: string;
      target: string;
      type: "file" | "dir" | "junction";
    }
  | {
      op: "rename";
      sourceName: string;
      destinationName: string;
    }
  | {
      op: "rename-verified";
      sourceName: string;
      destinationName: string;
      expectedIdentity?: string;
      expectedSignature?: string;
    }
  | {
      op: "unlink";
      name: string;
      expectedIdentity?: string;
      expectedSignature?: string;
      testFailBeforeUnlink?: boolean;
    }
  | {
      op: "rmdir";
      name: string;
      expectedIdentity: string;
    };

export interface PinnedDirectoryMutationResult {
  mutated: boolean;
  snapshot?: {
    kind: "missing" | "file" | "directory" | "link" | "other";
    identity: string | null;
    signature: string;
    linkTarget?: string;
  };
}

const CHILD_SOURCE = String.raw`
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const identity = (stat) =>
  String(stat.dev) + ":" + String(stat.ino) + ":" + String(stat.birthtimeMs);
const fileSignature = (bytes) =>
  "file:" + crypto.createHash("sha256").update(bytes).digest("hex");

function assertChildName(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    path.isAbsolute(name)
  ) {
    throw new Error(
      "Pinned filesystem mutation requires one child name: " + String(name),
    );
  }
}

async function snapshot(name) {
  const entry = await fs.lstat(name).catch((error) => {
    if (error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!entry) {
    return { kind: "missing", identity: null, signature: "missing" };
  }
  if (entry.isSymbolicLink()) {
    const linkTarget = await fs.readlink(name);
    return {
      kind: "link",
      identity: identity(entry),
      signature: "link:" + linkTarget,
      linkTarget,
    };
  }
  if (entry.isFile()) {
    const expectedIdentity = identity(entry);
    const handle = await fs.open(name, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || identity(opened) !== expectedIdentity) {
        throw new Error("Pinned child changed identity while opening " + name + ".");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!after.isFile() || identity(after) !== expectedIdentity) {
        throw new Error("Pinned child changed identity while reading " + name + ".");
      }
      return {
        kind: "file",
        identity: expectedIdentity,
        signature: fileSignature(bytes),
      };
    } finally {
      await handle.close();
    }
  }
  if (entry.isDirectory()) {
    return {
      kind: "directory",
      identity: identity(entry),
      signature: "dir:" + String(entry.mode) + ":" + String(entry.size),
    };
  }
  return {
    kind: "other",
    identity: identity(entry),
    signature: "other:" + String(entry.mode) + ":" + String(entry.size),
  };
}

async function writeAll(handle, bytes, maxWriteBytes, failAfterBytes) {
  let offset = 0;
  while (offset < bytes.length) {
    if (Number.isInteger(failAfterBytes) && offset >= failAfterBytes) {
      throw new Error("Injected pinned write failure after partial write.");
    }
    const remainingBeforeFailure =
      Number.isInteger(failAfterBytes) && failAfterBytes > offset
        ? failAfterBytes - offset
        : bytes.length - offset;
    const requested =
      Number.isInteger(maxWriteBytes) && maxWriteBytes > 0
        ? Math.min(bytes.length - offset, maxWriteBytes, remainingBeforeFailure)
        : Math.min(bytes.length - offset, remainingBeforeFailure);
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      requested,
      offset,
    );
    if (bytesWritten <= 0) {
      throw new Error("Pinned destination write made no progress.");
    }
    offset += bytesWritten;
  }
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

(async () => {
  const cwdStat = await fs.lstat(".");
  emit({
    type: "ready",
    identity: identity(cwdStat),
    canonical: await fs.realpath("."),
  });

  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString("utf8");
  const request = JSON.parse(input);
  let mutated = false;
  let mutationName =
    typeof request.name === "string"
      ? request.name
      : typeof request.destinationName === "string"
        ? request.destinationName
        : null;
  try {
    switch (request.op) {
      case "mkdir": {
        assertChildName(request.name);
        await fs.mkdir(request.name);
        mutated = true;
        emit({ type: "done", mutated, snapshot: await snapshot(request.name) });
        return;
      }
      case "write-file": {
        assertChildName(request.name);
        const bytes = Buffer.from(request.bytesBase64, "base64");
        if (request.mode === "exclusive") {
          const handle = await fs.open(request.name, "wx");
          mutated = true;
          try {
            await writeAll(
              handle,
              bytes,
              request.testMaxWriteBytes,
              request.testFailAfterBytes,
            );
            await handle.sync();
          } finally {
            await handle.close();
          }
        } else if (request.mode === "replace") {
          const handle = await fs.open(request.name, "r+");
          try {
            const opened = await handle.stat();
            if (
              !opened.isFile() ||
              (request.expectedIdentity &&
                identity(opened) !== request.expectedIdentity)
            ) {
              throw new Error(
                "Pinned destination changed identity while opening the write boundary.",
              );
            }
            const openedBytes = await handle.readFile();
            if (
              request.expectedSignature &&
              fileSignature(openedBytes) !== request.expectedSignature
            ) {
              throw new Error(
                "Pinned destination changed bytes while opening the write boundary.",
              );
            }
           await handle.truncate(0);
           mutated = true;
            if (request.testFailAfterTruncate) {
              throw new Error("Injected pinned write failure after truncate.");
            }
            await writeAll(
              handle,
              bytes,
              request.testMaxWriteBytes,
              request.testFailAfterBytes,
            );
            await handle.sync();
          } finally {
            await handle.close();
          }
        } else {
          throw new Error("Unsupported pinned write mode: " + String(request.mode));
        }
        emit({ type: "done", mutated, snapshot: await snapshot(request.name) });
        return;
      }
      case "copy-directory": {
        assertChildName(request.name);
        if ((await snapshot(request.name)).kind !== "missing") {
          throw Object.assign(new Error("Pinned copy destination already exists."), {
            code: "EEXIST",
          });
        }
        try {
          await fs.cp(request.source, request.name, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
            force: false,
            errorOnExist: true,
          });
        } catch (error) {
          mutated = (await snapshot(request.name)).kind !== "missing";
          throw error;
        }
        mutated = true;
        emit({ type: "done", mutated, snapshot: await snapshot(request.name) });
        return;
      }
      case "symlink": {
        assertChildName(request.name);
        await fs.symlink(request.target, request.name, request.type);
        mutated = true;
        emit({ type: "done", mutated, snapshot: await snapshot(request.name) });
        return;
      }
     case "rename": {
       assertChildName(request.sourceName);
       assertChildName(request.destinationName);
       await fs.rename(request.sourceName, request.destinationName);
       mutated = true;
       emit({
         type: "done",
         mutated,
         snapshot: await snapshot(request.destinationName),
       });
       return;
     }
      case "rename-verified": {
        assertChildName(request.sourceName);
        assertChildName(request.destinationName);
        const before = await snapshot(request.sourceName);
        if (
          (request.expectedIdentity && before.identity !== request.expectedIdentity) ||
          (request.expectedSignature && before.signature !== request.expectedSignature)
        ) {
          throw new Error("Pinned rename source changed before the namespace move.");
        }
        if ((await snapshot(request.destinationName)).kind !== "missing") {
          throw Object.assign(new Error("Pinned rename destination already exists."), {
            code: "EEXIST",
          });
        }
        await fs.rename(request.sourceName, request.destinationName);
        mutated = true;
        emit({
          type: "done",
          mutated,
          snapshot: await snapshot(request.destinationName),
        });
        return;
      }
      case "unlink": {
        assertChildName(request.name);
        const before = await snapshot(request.name);
        if (
          (request.expectedIdentity && before.identity !== request.expectedIdentity) ||
          (request.expectedSignature && before.signature !== request.expectedSignature)
        ) {
          throw new Error("Pinned unlink target changed before deletion.");
        }
        if (request.testFailBeforeUnlink) {
          throw new Error("Injected pinned quarantine cleanup failure.");
        }
        await fs.unlink(request.name);
        mutated = true;
        emit({ type: "done", mutated, snapshot: await snapshot(request.name) });
        return;
      }
      case "rmdir": {
        assertChildName(request.name);
        const before = await snapshot(request.name);
        if (
          before.kind !== "directory" ||
          before.identity !== request.expectedIdentity
        ) {
          throw new Error("Pinned directory changed before rollback.");
        }
        await fs.rmdir(request.name);
        mutated = true;
        emit({ type: "done", mutated, snapshot: await snapshot(request.name) });
        return;
      }
      default:
        throw new Error(
          "Unsupported pinned filesystem mutation: " + String(request.op),
        );
    }
  } catch (error) {
    if (!mutated && mutationName) {
      try {
        mutated = (await snapshot(mutationName)).kind !== "missing";
      } catch {}
    }
    emit({
      type: "error",
      mutated,
      code: error && typeof error === "object" ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
})().catch((error) => {
  emit({
    type: "error",
    mutated: false,
    code: error && typeof error === "object" ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
`;

const identityOf = (stat: {
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number;
}): string => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

const normalizePathKey = (value: string): string => {
  const normalized = path.resolve(value);
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized;
};

const pathIsWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

export async function capturePinnedDirectoryAuthority(
  directory: string,
  confinedRoot?: string,
): Promise<PinnedDirectoryAuthority> {
  const resolved = path.resolve(directory);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Pinned filesystem parent is redirected or not a directory: ${resolved}.`,
    );
  }
  const canonical = await fs.realpath(resolved);
  if (confinedRoot) {
    const canonicalRoot = await fs.realpath(confinedRoot);
    if (!pathIsWithin(canonicalRoot, canonical)) {
      throw new Error(
        `Pinned filesystem parent resolves outside its confined root: ${resolved}.`,
      );
    }
  }
  return { directory: resolved, canonical, identity: identityOf(stat) };
}

interface ChildReady {
  type: "ready";
  identity: string;
  canonical: string;
}

interface ChildDone {
  type: "done";
  mutated: boolean;
  snapshot?: PinnedDirectoryMutationResult["snapshot"];
}

interface ChildError {
  type: "error";
  mutated: boolean;
  code?: string;
  message: string;
}

type ChildMessage = ChildReady | ChildDone | ChildError;

export class PinnedDirectoryMutationError extends Error {
  readonly mutated: boolean;
  readonly code?: string;

  constructor(message: string, mutated: boolean, code?: string) {
    super(message);
    this.name = "PinnedDirectoryMutationError";
    this.mutated = mutated;
    this.code = code;
  }
}

export async function runPinnedDirectoryMutation(
  authority: PinnedDirectoryAuthority,
  mutation: PinnedDirectoryMutation,
  options: { beforeExecute?: () => void | Promise<void> } = {},
): Promise<PinnedDirectoryMutationResult> {
  const child = spawn(process.execPath, ["-e", CHILD_SOURCE], {
    cwd: authority.directory,
    env: {},
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });

  let readyResolve!: (message: ChildReady) => void;
  let readyReject!: (error: Error) => void;
  const readyPromise = new Promise<ChildReady>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let readySettled = false;
  let firstLineConsumed = false;
  const lines: string[] = [];

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    while (true) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      let parsed: ChildMessage;
      try {
        parsed = JSON.parse(line) as ChildMessage;
      } catch {
        if (!readySettled) {
          readySettled = true;
          readyReject(
            new Error(`Pinned filesystem helper emitted invalid output: ${line}`),
          );
        }
        continue;
      }
      if (!firstLineConsumed) {
        firstLineConsumed = true;
        if (parsed.type !== "ready") {
          if (!readySettled) {
            readySettled = true;
            readyReject(
              new Error(
                parsed.type === "error"
                  ? parsed.message
                  : "Pinned filesystem helper did not establish directory authority.",
              ),
            );
          }
          continue;
        }
        if (!readySettled) {
          readySettled = true;
          readyResolve(parsed);
        }
      } else {
        lines.push(line);
      }
    }
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  child.once("error", (error) => {
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
  });

  let ready: ChildReady;
  try {
    ready = await readyPromise;
  } catch (error) {
    child.kill();
    await exitPromise.catch(() => undefined);
    throw error;
  }

  if (
    ready.identity !== authority.identity ||
    normalizePathKey(ready.canonical) !== normalizePathKey(authority.canonical)
  ) {
    child.kill();
    await exitPromise.catch(() => undefined);
    throw new PinnedDirectoryMutationError(
      `Pinned filesystem parent changed before mutation: ${authority.directory}.`,
      false,
    );
  }

  try {
    await options.beforeExecute?.();
    child.stdin.end(JSON.stringify(mutation));
  } catch (error) {
    child.kill();
    await exitPromise.catch(() => undefined);
    throw error;
  }

  const { code, signal } = await exitPromise;
  if (stdout.trim()) lines.push(stdout.trim());
  const finalLine = lines.at(-1);
  let result: ChildDone | ChildError | undefined;
  if (finalLine) {
    try {
      const parsed = JSON.parse(finalLine) as ChildMessage;
      if (parsed.type === "done" || parsed.type === "error") result = parsed;
    } catch {
      // Fall through to the protocol failure below.
    }
  }
  if (!result) {
    throw new PinnedDirectoryMutationError(
      `Pinned filesystem helper exited without a result (code=${String(code)}, signal=${String(signal)}). ${stderr.trim()}`.trim(),
      false,
    );
  }
  if (result.type === "error") {
    throw new PinnedDirectoryMutationError(result.message, result.mutated, result.code);
  }
  if (code !== 0) {
    throw new PinnedDirectoryMutationError(
      `Pinned filesystem helper exited with code ${String(code)}. ${stderr.trim()}`.trim(),
      result.mutated,
    );
  }
  return { mutated: result.mutated, snapshot: result.snapshot };
}
