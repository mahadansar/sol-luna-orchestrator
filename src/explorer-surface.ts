import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import picomatch from "picomatch";

const ALWAYS_FORBIDDEN = [
  ".git/**",
  ".sol-luna/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
] as const;

const matchOptions: picomatch.PicomatchOptions = {
  dot: true,
  nocase: process.platform === "win32" || process.platform === "darwin",
};

type EntryKind = "file" | "symlink";

interface ManifestEntry {
  kind: EntryKind;
  digest: string;
}

export interface ExplorationSurface {
  readonly path: string;
  readonly sourceWorkspace: string;
  readonly baseline: ReadonlyMap<string, ManifestEntry>;
}

export interface ExplorationMutation {
  readonly path: string;
  readonly kind: "created" | "deleted" | "modified" | "renamed" | "symlink";
}

function relativePosix(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function makeAdmission(scope: readonly string[], forbidden: readonly string[]) {
  let allowed: (value: string) => boolean;
  let denied: (value: string) => boolean;
  try {
    allowed = picomatch([...scope], matchOptions);
    denied = picomatch([...ALWAYS_FORBIDDEN, ...forbidden], matchOptions);
  } catch (error) {
    throw new Error(`Invalid exploration scope pattern: ${(error as Error).message}`);
  }
  return (relative: string): boolean => allowed(relative) && !denied(relative);
}

async function copyAdmittedTree(
  sourceRoot: string,
  destinationRoot: string,
  admitted: (relative: string) => boolean,
): Promise<number> {
  let copied = 0;

  async function visit(sourceDirectory: string): Promise<void> {
    const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(sourceDirectory, entry.name);
      const relative = relativePosix(sourceRoot, source);

      if (
        relative === ".git" ||
        relative.startsWith(".git/") ||
        relative === ".sol-luna" ||
        relative.startsWith(".sol-luna/")
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        await visit(source);
        continue;
      }
      if (!admitted(relative)) continue;

      const destination = path.join(destinationRoot, ...relative.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true });

      if (entry.isFile()) {
        await fs.copyFile(source, destination);
        copied += 1;
        continue;
      }

      if (entry.isSymbolicLink()) {
        const linkTarget = await fs.readlink(source);
        const sourceTarget = path.resolve(path.dirname(source), linkTarget);
        const destinationTarget = path.resolve(path.dirname(destination), linkTarget);
        if (
          path.isAbsolute(linkTarget) ||
          !inside(sourceRoot, sourceTarget) ||
          !inside(destinationRoot, destinationTarget)
        ) {
          throw new Error(
            `Exploration scope contains unsafe symlink '${relative}'; absolute or escaping links are not admitted.`,
          );
        }
        const targetRelative = relativePosix(sourceRoot, sourceTarget);
        if (!admitted(targetRelative)) {
          throw new Error(
            `Exploration symlink '${relative}' resolves outside the admitted file scope.`,
          );
        }
        await fs.symlink(linkTarget, destination);
        copied += 1;
      }
    }
  }

  await visit(sourceRoot);
  return copied;
}

async function manifest(root: string): Promise<Map<string, ManifestEntry>> {
  const result = new Map<string, ManifestEntry>();

  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = relativePosix(root, target);
      const stat = await fs.lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await visit(target);
      } else if (stat.isSymbolicLink()) {
        const link = await fs.readlink(target);
        result.set(relative, {
          kind: "symlink",
          digest: createHash("sha256").update(link).digest("hex"),
        });
      } else if (stat.isFile()) {
        const bytes = await fs.readFile(target);
        result.set(relative, {
          kind: "file",
          digest: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }

  await visit(root);
  return result;
}

export async function createExplorationSurface(
  sourceWorkspace: string,
  scope: readonly string[],
  forbiddenFiles: readonly string[],
): Promise<ExplorationSurface> {
  if (scope.length === 0) {
    throw new Error("Exploration requires at least one explicit admitted scope pattern.");
  }
  const admitted = makeAdmission(scope, forbiddenFiles);
  const surfacePath = await fs.mkdtemp(path.join(os.tmpdir(), "sol-luna-explore-"));
  try {
    const copied = await copyAdmittedTree(sourceWorkspace, surfacePath, admitted);
    if (copied === 0) {
      throw new Error("Exploration scope admitted no readable files.");
    }
    return {
      path: surfacePath,
      sourceWorkspace,
      baseline: await manifest(surfacePath),
    };
  } catch (error) {
    await fs.rm(surfacePath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function collectExplorationMutations(
  surface: ExplorationSurface,
): Promise<ExplorationMutation[]> {
  const after = await manifest(surface.path);
  const changes: ExplorationMutation[] = [];
  const deleted = new Map<string, string[]>();
  const created = new Map<string, string[]>();

  for (const [file, before] of surface.baseline) {
    const current = after.get(file);
    if (!current) {
      const key = `${before.kind}:${before.digest}`;
      deleted.set(key, [...(deleted.get(key) ?? []), file]);
    } else if (before.kind !== current.kind) {
      changes.push({ path: file, kind: "symlink" });
    } else if (before.digest !== current.digest) {
      changes.push({
        path: file,
        kind: current.kind === "symlink" ? "symlink" : "modified",
      });
    }
  }

  for (const [file, current] of after) {
    if (surface.baseline.has(file)) continue;
    const key = `${current.kind}:${current.digest}`;
    created.set(key, [...(created.get(key) ?? []), file]);
  }

  for (const [key, deletedFiles] of deleted) {
    const createdFiles = created.get(key) ?? [];
    while (deletedFiles.length > 0 && createdFiles.length > 0) {
      const from = deletedFiles.shift()!;
      const to = createdFiles.shift()!;
      changes.push({ path: `${from} -> ${to}`, kind: "renamed" });
    }
    for (const file of deletedFiles) changes.push({ path: file, kind: "deleted" });
    if (createdFiles.length > 0) created.set(key, createdFiles);
    else created.delete(key);
  }
  for (const files of created.values()) {
    for (const file of files) changes.push({ path: file, kind: "created" });
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export async function removeExplorationSurface(
  surface: ExplorationSurface,
): Promise<void> {
  const resolved = path.resolve(surface.path);
  const tempRoot = path.resolve(os.tmpdir());
  if (!inside(tempRoot, resolved) || path.dirname(resolved) !== tempRoot) {
    throw new Error(
      "Refused to remove an exploration surface outside the system temp root.",
    );
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

export async function verifyGrounding(
  surface: ExplorationSurface,
  sourceFile: string,
  sourceLine: number,
  evidence: string,
): Promise<string | null> {
  if (path.isAbsolute(sourceFile)) return "sourceFile must be workspace-relative";
  const normalized = sourceFile.replaceAll("\\", "/");
  if (normalized.startsWith("../") || normalized === "..") {
    return "sourceFile escapes the admitted workspace";
  }
  const target = path.resolve(surface.path, ...normalized.split("/"));
  if (!inside(surface.path, target)) return "sourceFile escapes the admitted workspace";
  const baseline = surface.baseline.get(normalized);
  if (!baseline || baseline.kind !== "file")
    return "sourceFile was not an admitted regular file";

  const content = await fs.readFile(target, "utf8").catch(() => null);
  if (content === null) return "sourceFile could not be read from the isolated surface";
  const needle = evidence.trim();
  if (!needle) return "evidence must not be empty";
  const index = content.indexOf(needle);
  if (index < 0) return "evidence text was not present in sourceFile";
  const actualLine = content.slice(0, index).split(/\r?\n/).length;
  if (actualLine !== sourceLine) {
    return `evidence starts at line ${actualLine}, not claimed line ${sourceLine}`;
  }
  return null;
}
