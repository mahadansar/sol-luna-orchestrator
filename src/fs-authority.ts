import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface PinnedDirectoryAuthority {
  directory: string;
  canonical: string;
  identity: string;
}

interface PinnedDirectoryMutationTestControls {
  /** Deterministic test seam: pause after a successful mutation but before reporting it. */
  testDelayAfterMutationMs?: number;
}

export type PinnedDirectoryMutation = (
  | {
      op: "mkdir";
      name: string;
      /** Deterministic protocol-loss seam before the syscall; production leaves this unset. */
      testExitBeforeMutationWithoutResult?: boolean;
    }
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
      /** Final child name after the caller atomically renames this staging directory. */
      finalName?: string;
    }
  | {
      op: "rename-verified";
      sourceName: string;
      destinationName: string;
      expectedIdentity?: string;
      expectedSignature?: string;
      /** Deterministic protocol-loss seam before the syscall; production leaves this unset. */
      testExitBeforeMutationWithoutResult?: boolean;
      /** Deterministic protocol-crash seam; production leaves this unset. */
      testExitAfterMutationBeforeResult?: boolean;
    }
  | {
      op: "unlink";
      name: string;
      expectedIdentity?: string;
      expectedSignature?: string;
      testFailBeforeUnlink?: boolean;
      /** Deterministic protocol-crash seam; production leaves this unset. */
      testExitAfterMutationBeforeResult?: boolean;
    }
  | {
      op: "rmdir";
      name: string;
      expectedIdentity: string;
      /** Deterministic protocol-loss seam before the syscall; production leaves this unset. */
      testExitBeforeMutationWithoutResult?: boolean;
    }
) &
  PinnedDirectoryMutationTestControls;

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
const MAX_PINNED_SNAPSHOT_FILE_BYTES = 512 * 1024 * 1024;

async function fileSignatureFromHandle(handle, expectedSize, name) {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    expectedSize > MAX_PINNED_SNAPSHOT_FILE_BYTES
  ) {
    throw new Error(
      "Pinned child file exceeds its safe signature budget: " + name + ".",
    );
  }
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < expectedSize) {
    const requested = Math.min(buffer.length, expectedSize - offset);
    const { bytesRead } = await handle.read(buffer, 0, requested, offset);
    if (bytesRead <= 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset !== expectedSize) {
    throw new Error("Pinned child changed size while hashing " + name + ".");
  }
  return "file:" + hash.digest("hex");
}

function pathKey(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function inspectCopyLink(sourceRoot, canonicalRoot, sourcePath, relative) {
  const entry = await fs.lstat(sourcePath);
  if (!entry.isSymbolicLink()) {
    throw new Error("Shared dependency link changed type during snapshot copy: " + sourcePath);
  }
  const rawTarget = await fs.readlink(sourcePath);
  const resolvedTarget = await fs.realpath(sourcePath).catch(() => null);
  if (!resolvedTarget || !pathIsWithin(canonicalRoot, resolvedTarget)) {
    throw new Error("Shared dependency link escapes its configured source tree: " + sourcePath);
  }
  const followed = await fs.stat(sourcePath).catch(() => null);
  const targetKind = followed?.isDirectory()
    ? "directory"
    : followed?.isFile()
      ? "file"
      : null;
  if (!targetKind) {
    throw new Error("Shared dependency link target is missing or unsupported: " + sourcePath);
  }
  if (process.platform === "win32" && targetKind !== "directory") {
    throw new Error(
      "Windows shared dependency snapshots support internal directory junctions only: " +
        sourcePath,
    );
  }
  return {
    sourcePath: path.resolve(sourcePath),
    relative,
    identity: identity(entry),
    rawTarget,
    resolvedTarget,
    targetRelative: path.relative(canonicalRoot, resolvedTarget),
    targetKind,
  };
}

async function planCopyDirectory(source) {
  const rootEntry = await fs.lstat(source);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error("Pinned dependency copy source must be a real directory: " + source);
  }
  const canonicalRoot = await fs.realpath(source);
  const rootIdentity = identity(rootEntry);
  const links = [];

  async function walk(directory, relative) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const child = path.join(directory, name);
      const childRelative = relative ? path.join(relative, name) : name;
      const childEntry = await fs.lstat(child);
      if (childEntry.isSymbolicLink()) {
        links.push(await inspectCopyLink(source, canonicalRoot, child, childRelative));
      } else if (childEntry.isDirectory()) {
        const childReal = await fs.realpath(child);
        if (!pathIsWithin(canonicalRoot, childReal)) {
          throw new Error("Shared dependency directory escaped its source tree: " + child);
        }
        await walk(child, childRelative);
      }
    }
  }

  await walk(source, "");
  return { source: path.resolve(source), canonicalRoot, rootIdentity, links };
}

async function assertCopyRootStable(plan) {
  const entry = await fs.lstat(plan.source);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    identity(entry) !== plan.rootIdentity ||
    !samePath(await fs.realpath(plan.source), plan.canonicalRoot)
  ) {
    throw new Error("Pinned dependency copy source changed identity during snapshot copy.");
  }
}

async function assertCopyLinkStable(plan, expected) {
  const current = await inspectCopyLink(
    plan.source,
    plan.canonicalRoot,
    expected.sourcePath,
    expected.relative,
  );
  if (
    current.identity !== expected.identity ||
    current.rawTarget !== expected.rawTarget ||
    !samePath(current.resolvedTarget, expected.resolvedTarget) ||
    current.targetKind !== expected.targetKind
  ) {
    throw new Error("Shared dependency link changed during snapshot copy: " + expected.sourcePath);
  }
}

async function assertCopiedTreeHasNoLinks(root) {
  async function walk(directory) {
    for (const name of await fs.readdir(directory)) {
      const child = path.join(directory, name);
      const entry = await fs.lstat(child);
      if (entry.isSymbolicLink()) {
        throw new Error("Unexpected dependency link appeared during snapshot copy: " + child);
      }
      if (entry.isDirectory()) await walk(child);
    }
  }
  await walk(root);
}

async function recreatePrivateCopyLinks(plan, destinationRoot, finalName) {
  const canonicalDestinationRoot = await fs.realpath(destinationRoot);
  if (finalName !== undefined) assertChildName(finalName);
  for (const link of plan.links) {
    await assertCopyRootStable(plan);
    await assertCopyLinkStable(plan, link);
    const destinationLink = path.join(destinationRoot, link.relative);
    if ((await snapshot(destinationLink)).kind !== "missing") {
      throw new Error("Dependency link destination appeared during snapshot copy: " + destinationLink);
    }
    const destinationTarget = path.resolve(destinationRoot, link.targetRelative);
    const canonicalDestinationTarget = await fs.realpath(destinationTarget).catch(() => null);
    if (
      !canonicalDestinationTarget ||
      !pathIsWithin(canonicalDestinationRoot, canonicalDestinationTarget)
    ) {
      throw new Error("Dependency link target was not copied into the private snapshot: " + link.relative);
    }
    const targetStat = await fs.stat(destinationTarget);
    if (
      (link.targetKind === "directory" && !targetStat.isDirectory()) ||
      (link.targetKind === "file" && !targetStat.isFile())
    ) {
      throw new Error("Dependency link target changed type in the private snapshot: " + link.relative);
    }

    if (process.platform === "win32") {
      const finalRoot = finalName
        ? path.resolve(path.dirname(destinationRoot), finalName)
        : canonicalDestinationRoot;
      const finalTarget = path.resolve(finalRoot, link.targetRelative);
      if (!pathIsWithin(finalRoot, finalTarget)) {
        throw new Error("Private dependency junction target escaped its final root: " + link.relative);
      }
      await fs.symlink(finalTarget, destinationLink, "junction");
      const copiedRawTarget = await fs.readlink(destinationLink);
      if (!samePath(copiedRawTarget, finalTarget)) {
        throw new Error("Private dependency junction did not retain its rebased target: " + link.relative);
      }
    } else {
      const relativeTarget = path.relative(path.dirname(destinationLink), destinationTarget) || ".";
      await fs.symlink(
        relativeTarget,
        destinationLink,
        link.targetKind === "directory" ? "dir" : "file",
      );
    }

    if (process.platform !== "win32" || !finalName) {
      const copiedTarget = await fs.realpath(destinationLink).catch(() => null);
      if (!copiedTarget || !samePath(copiedTarget, canonicalDestinationTarget)) {
        throw new Error("Private dependency link did not resolve to its copied target: " + link.relative);
      }
    }
  }
}

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
      const signature = await fileSignatureFromHandle(handle, opened.size, name);
      const after = await handle.stat();
      if (
        !after.isFile() ||
        identity(after) !== expectedIdentity ||
        after.size !== opened.size
      ) {
        throw new Error("Pinned child changed identity while reading " + name + ".");
      }
      return {
        kind: "file",
        identity: expectedIdentity,
        signature,
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

async function emitDone(request, value) {
  if (
    Number.isFinite(request.testDelayAfterMutationMs) &&
    request.testDelayAfterMutationMs > 0
  ) {
    await new Promise((resolve) => setTimeout(resolve, request.testDelayAfterMutationMs));
  }
  emit(value);
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
  try {
    switch (request.op) {
      case "mkdir": {
        assertChildName(request.name);
        if (request.testExitBeforeMutationWithoutResult) process.exit(94);
        await fs.mkdir(request.name);
        mutated = true;
        await emitDone(request, {
          type: "done",
          mutated,
          snapshot: await snapshot(request.name),
        });
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
            const openedSignature = await fileSignatureFromHandle(
              handle,
              opened.size,
              request.name,
            );
            if (
              request.expectedSignature &&
              openedSignature !== request.expectedSignature
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
        await emitDone(request, {
          type: "done",
          mutated,
          snapshot: await snapshot(request.name),
        });
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
          const plan = await planCopyDirectory(request.source);
          const plannedLinks = new Map(
            plan.links.map((entry) => [pathKey(entry.sourcePath), entry]),
          );
          const observedLinks = new Set();
          await assertCopyRootStable(plan);
          await fs.cp(request.source, request.name, {
            recursive: true,
            dereference: false,
            force: false,
            errorOnExist: true,
            filter: async (sourcePath) => {
              const sourceEntry = await fs.lstat(sourcePath);
              const planned = plannedLinks.get(pathKey(sourcePath));
              if (sourceEntry.isSymbolicLink()) {
                if (!planned) {
                  throw new Error(
                    "Unplanned dependency link appeared during snapshot copy: " + sourcePath,
                  );
                }
                await assertCopyLinkStable(plan, planned);
                observedLinks.add(pathKey(sourcePath));
                return false;
              }
              if (planned) {
                throw new Error(
                  "Planned dependency link changed type during snapshot copy: " + sourcePath,
                );
              }
              return true;
            },
          });
          await assertCopyRootStable(plan);
          for (const link of plan.links) {
            if (!observedLinks.has(pathKey(link.sourcePath))) {
              throw new Error(
                "Planned dependency link disappeared during snapshot copy: " + link.sourcePath,
              );
            }
          }
          await assertCopiedTreeHasNoLinks(request.name);
          await recreatePrivateCopyLinks(plan, request.name, request.finalName);
        } catch (error) {
          mutated = (await snapshot(request.name)).kind !== "missing";
          throw error;
        }
        mutated = true;
        await emitDone(request, {
          type: "done",
          mutated,
          snapshot: await snapshot(request.name),
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
        if (request.testExitBeforeMutationWithoutResult) process.exit(93);
        await fs.rename(request.sourceName, request.destinationName);
        mutated = true;
        if (request.testExitAfterMutationBeforeResult) process.exit(91);
        await emitDone(request, {
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
        if (request.testExitAfterMutationBeforeResult) process.exit(92);
        await emitDone(request, {
          type: "done",
          mutated,
          snapshot: await snapshot(request.name),
        });
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
        if (request.testExitBeforeMutationWithoutResult) process.exit(95);
        await fs.rmdir(request.name);
        mutated = true;
        await emitDone(request, {
          type: "done",
          mutated,
          snapshot: await snapshot(request.name),
        });
        return;
      }
      default:
        throw new Error(
          "Unsupported pinned filesystem mutation: " + String(request.op),
        );
    }
  } catch (error) {
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
  /** Whether `mutated` is known rather than a conservative protocol-loss assumption. */
  readonly mutationProven: boolean;
  readonly code?: string;

  constructor(message: string, mutated: boolean, code?: string, mutationProven = true) {
    super(message);
    this.name = "PinnedDirectoryMutationError";
    this.mutated = mutated;
    this.mutationProven = mutationProven;
    this.code = code;
  }
}

export interface PinnedDirectoryMutationOptions {
  beforeExecute?: () => void | Promise<void>;
  /** Cancellation owned by the enclosing orchestration operation. */
  signal?: AbortSignal;
  /** Relative helper lifetime bound. Production defaults to five minutes. */
  timeoutMs?: number;
  /** Optional absolute epoch-millisecond deadline; the earlier bound wins. */
  deadlineAt?: number;
}

export const PINNED_DIRECTORY_MUTATION_TIMEOUT_MS = 5 * 60 * 1000;
const PINNED_DIRECTORY_KILL_GRACE_MS = 5_000;

export async function runPinnedDirectoryMutation(
  authority: PinnedDirectoryAuthority,
  mutation: PinnedDirectoryMutation,
  options: PinnedDirectoryMutationOptions = {},
): Promise<PinnedDirectoryMutationResult> {
  if (options.signal?.aborted) {
    throw new PinnedDirectoryMutationError(
      "Pinned filesystem mutation was cancelled before helper launch.",
      false,
      "ABORT_ERR",
    );
  }
  const configuredTimeout = options.timeoutMs ?? PINNED_DIRECTORY_MUTATION_TIMEOUT_MS;
  if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) {
    throw new PinnedDirectoryMutationError(
      "Pinned filesystem mutation requires a positive finite timeout.",
      false,
      "EINVAL",
    );
  }
  const deadlineDelay =
    options.deadlineAt === undefined
      ? configuredTimeout
      : options.deadlineAt - Date.now();
  const timeoutMs = Math.min(configuredTimeout, deadlineDelay);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PinnedDirectoryMutationError(
      "Pinned filesystem mutation deadline elapsed before helper launch.",
      false,
      "ETIMEDOUT",
    );
  }

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

  let childClosed = false;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("close", (code, signal) => {
        childClosed = true;
        if (!readySettled) {
          readySettled = true;
          readyReject(
            new Error(
              "Pinned filesystem helper closed before establishing directory authority.",
            ),
          );
        }
        resolve({ code, signal });
      });
    },
  );
  child.once("error", (error) => {
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
  });
  // A helper that closes while an asynchronous pre-execution check is pending
  // can leave a broken stdin pipe. Handle its error and use the closed helper's
  // result (or conservative protocol loss) below instead of crashing the parent.
  child.stdin.on("error", () => undefined);

  let requestDispatched = false;
  let cancellation:
    | { kind: "abort"; code: "ABORT_ERR"; message: string }
    | { kind: "timeout"; code: "ETIMEDOUT"; message: string }
    | null = null;
  let rejectCancellation!: (error: Error) => void;
  const cancellationPromise = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  // The rejection is also observed by each active Promise.race below; attaching
  // this handler prevents a late abort between stages from becoming unhandled.
  void cancellationPromise.catch(() => undefined);

  const cancellationError = (): PinnedDirectoryMutationError => {
    const state = cancellation!;
    return new PinnedDirectoryMutationError(
      state.message,
      requestDispatched,
      state.code,
      !requestDispatched,
    );
  };
  const requestCancellation = (kind: "abort" | "timeout"): void => {
    if (cancellation || childClosed) return;
    cancellation =
      kind === "abort"
        ? {
            kind,
            code: "ABORT_ERR",
            message: "Pinned filesystem mutation was cancelled.",
          }
        : {
            kind,
            code: "ETIMEDOUT",
            message: `Pinned filesystem mutation timed out after ${Math.ceil(timeoutMs)}ms.`,
          };
    child.kill("SIGKILL");
    rejectCancellation(cancellationError());
  };
  const onAbort = (): void => requestCancellation("abort");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => requestCancellation("timeout"), timeoutMs);
  if (options.signal?.aborted) requestCancellation("abort");

  const stopAndReap = async (): Promise<void> => {
    if (!childClosed) child.kill("SIGKILL");
    let grace: NodeJS.Timeout | undefined;
    const reaped = await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        grace = setTimeout(() => resolve(false), PINNED_DIRECTORY_KILL_GRACE_MS);
      }),
    ]).catch(() => false);
    if (grace) clearTimeout(grace);
    if (!reaped) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
  };

  const awaitCancellable = async <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([promise, cancellationPromise]);

  try {
    let ready: ChildReady;
    try {
      ready = await awaitCancellable(readyPromise);
    } catch (error) {
      await stopAndReap();
      if (cancellation) throw cancellationError();
      throw error;
    }

    if (
      ready.identity !== authority.identity ||
      normalizePathKey(ready.canonical) !== normalizePathKey(authority.canonical)
    ) {
      await stopAndReap();
      throw new PinnedDirectoryMutationError(
        `Pinned filesystem parent changed before mutation: ${authority.directory}.`,
        false,
      );
    }

    try {
      if (options.beforeExecute) {
        await awaitCancellable(Promise.resolve().then(options.beforeExecute));
      }
      const current = await awaitCancellable(
        capturePinnedDirectoryAuthority(authority.directory),
      );
      if (
        current.identity !== authority.identity ||
        normalizePathKey(current.canonical) !== normalizePathKey(authority.canonical)
      ) {
        throw new PinnedDirectoryMutationError(
          `Pinned filesystem parent changed before mutation: ${authority.directory}.`,
          false,
        );
      }
      requestDispatched = true;
      child.stdin.end(JSON.stringify(mutation));
    } catch (error) {
      await stopAndReap();
      if (cancellation) throw cancellationError();
      throw error;
    }

    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await awaitCancellable(exitPromise);
      childClosed = true;
    } catch {
      await stopAndReap();
      throw cancellationError();
    }

    const { code, signal } = exit;
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
      const deterministicPostMutationCrash = code === 91 || code === 92;
      throw new PinnedDirectoryMutationError(
        `Pinned filesystem helper exited without a result (code=${String(code)}, signal=${String(signal)}). ${stderr.trim()}`.trim(),
        true,
        undefined,
        deterministicPostMutationCrash,
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
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
