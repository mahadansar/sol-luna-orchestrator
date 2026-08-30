/**
 * Sealed Benchmark V3 production-baseline artifact.
 *
 * Source identity and runtime identity are separate facts. The v0.11.0 tag and
 * commit bind tracked source; the runtime manifest binds the built JavaScript,
 * package manifests, and every installed runtime-dependency byte. A V3 result
 * is accepted only when a fresh manifest observation immediately before and
 * after each Adaptive cell matches the digest frozen below.
 */
import { sync as spawnSync } from "cross-spawn";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutCwdExecutableLookup } from "../executable.js";
import { readToolOutput, resolveBenchExecutable } from "./environment.js";
import {
  BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
  BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
} from "./v3-tasks.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");

export const BASELINE_ARTIFACT_DIRECTORY = path.posix.join(
  "bench",
  "baseline",
  `v${BENCHMARK_V3_PRODUCTION_BASELINE_VERSION}`,
);
export const BASELINE_PACKAGE_NAME = "sol-luna-orchestrator" as const;
export const BASELINE_BIN_NAME = "sol-luna-orchestrator-mcp" as const;
export const BASELINE_RUNTIME_MANIFEST_SCHEMA =
  "sol-luna/bench/baseline-runtime-manifest@1" as const;
export const BASELINE_RUNTIME_MANIFEST_FILE = path.posix.join(
  "node_modules",
  ".sol-luna-runtime-manifest.json",
);

/** Frozen after canonical provisioning; observation never updates this value. */
export const BENCHMARK_V3_EXPECTED_RUNTIME_MANIFEST_SHA256 =
  "d63af9ef92ac99c9a0f8425012fce2777a6dee020c76161bc504aee96dafad17" as const;

export const BASELINE_PROVISION_COMMANDS: readonly string[] = Object.freeze([
  "npm run build",
  "node dist/bench/baseline.js --provision",
]);

export interface RuntimeManifestEntry {
  readonly path: string;
  readonly type: "file" | "symlink";
  readonly byteLength: number;
  /** File bytes, or the UTF-8 link target for a symlink. */
  readonly sha256: string;
}

export interface BaselineRuntimeManifest {
  readonly schema: typeof BASELINE_RUNTIME_MANIFEST_SCHEMA;
  readonly entries: readonly RuntimeManifestEntry[];
  readonly aggregateSha256: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly symlinkCount: number;
}

const toPosix = (value: string): string => value.split(path.sep).join("/");
const sha256 = (bytes: string | Buffer): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Build the canonical byte manifest used by provisioning and launch gates.
 *
 * `node_modules/.bin` is the sole subtree excluded: the harness launches the
 * absolute Node executable and absolute dist/server.js, and Node module
 * resolution never consults command shims. Everything else below dist and
 * node_modules is included, including source maps and node_modules' lockfile.
 */
export function buildBaselineRuntimeManifest(
  artifactDirectory: string,
): BaselineRuntimeManifest | null {
  try {
    const root = path.resolve(artifactDirectory);
    const entries: RuntimeManifestEntry[] = [];
    const excluded = new Set(["node_modules/.bin", BASELINE_RUNTIME_MANIFEST_FILE]);

    const visit = (absolute: string, relative: string): void => {
      const normalized = toPosix(relative);
      if (
        [...excluded].some(
          (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
        )
      ) {
        return;
      }
      const stats = fs.lstatSync(absolute);
      if (stats.isDirectory()) {
        for (const name of fs.readdirSync(absolute).sort(byCodePoint)) {
          visit(path.join(absolute, name), path.join(relative, name));
        }
        return;
      }
      if (stats.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        entries.push({
          path: normalized,
          type: "symlink",
          byteLength: Buffer.byteLength(target, "utf8"),
          sha256: sha256(target),
        });
        return;
      }
      if (!stats.isFile()) {
        throw new Error(`unsupported runtime artifact type: ${normalized}`);
      }
      const bytes = fs.readFileSync(absolute);
      entries.push({
        path: normalized,
        type: "file",
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      });
    };

    for (const requiredFile of ["package.json", "package-lock.json"]) {
      visit(path.join(root, requiredFile), requiredFile);
    }
    for (const requiredDirectory of ["dist", "node_modules"]) {
      visit(path.join(root, requiredDirectory), requiredDirectory);
    }

    entries.sort((left, right) => byCodePoint(left.path, right.path));
    const canonical = JSON.stringify({
      schema: BASELINE_RUNTIME_MANIFEST_SCHEMA,
      entries,
    });
    return {
      schema: BASELINE_RUNTIME_MANIFEST_SCHEMA,
      entries,
      aggregateSha256: sha256(canonical),
      fileCount: entries.length,
      totalBytes: entries.reduce((total, entry) => total + entry.byteLength, 0),
      symlinkCount: entries.filter((entry) => entry.type === "symlink").length,
    };
  } catch {
    return null;
  }
}

export interface BaselineRuntimeProbe {
  readonly directory: string | null;
  readonly directoryExists: boolean;
  readonly isolatedFromDevelopmentTree: boolean | null;
  readonly headCommit: string | null;
  readonly headTree: string | null;
  readonly statusPorcelain: string | null;
  readonly expectedTree: string | null;
  readonly packageName: string | null;
  readonly packageVersion: string | null;
  readonly packageVersionAtBaselineCommit: string | null;
  readonly declaredBinPath: string | null;
  readonly entryPoint: string | null;
  readonly entryPointExists: boolean;
  readonly entryPointFileType: "file" | "directory" | "symlink" | "other" | null;
  readonly entryPointRealPath: string | null;
  readonly entryPointContained: boolean | null;
  readonly entryPointSha256: string | null;
  readonly launcher: string | null;
  readonly declaredDependencies: readonly string[];
  readonly installedDependencyVersions: Readonly<Record<string, string | null>>;
  readonly runtimeManifest: BaselineRuntimeManifest | null;
}

export const BASELINE_RUNTIME_CHECKS = [
  "artifact-present",
  "artifact-isolated-from-development-tree",
  "artifact-head-is-baseline-commit",
  "artifact-tree-matches-baseline-commit",
  "artifact-working-tree-clean",
  "artifact-package-name-matches",
  "artifact-package-version-matches",
  "artifact-version-matches-baseline-commit",
  "artifact-declares-server-bin",
  "artifact-entry-point-present",
  "artifact-entry-point-regular-file",
  "artifact-entry-point-contained",
  "artifact-dependencies-installed",
  "artifact-launcher-resolved",
  "artifact-runtime-manifest-readable",
  "artifact-runtime-manifest-has-no-symlinks",
  "artifact-runtime-manifest-matches-freeze",
] as const;
export type BaselineRuntimeCheck = (typeof BASELINE_RUNTIME_CHECKS)[number];

export interface ProductionBaselineRuntime {
  readonly expected: {
    readonly version: string;
    readonly sha: string;
    readonly packageName: string;
    readonly artifactDirectory: string;
    readonly runtimeManifestSha256: string;
  };
  readonly observed: {
    readonly artifactDirectory: string | null;
    readonly headCommit: string | null;
    readonly headTree: string | null;
    readonly baselineTree: string | null;
    readonly workingTreeClean: boolean | null;
    readonly dirtyPathCount: number | null;
    readonly packageName: string | null;
    readonly packageVersion: string | null;
    readonly packageVersionAtBaselineCommit: string | null;
    readonly declaredBinPath: string | null;
    readonly entryPoint: string | null;
    readonly entryPointRealPath: string | null;
    readonly entryPointFileType: BaselineRuntimeProbe["entryPointFileType"];
    readonly entryPointSha256: string | null;
    readonly launcher: string | null;
    readonly installedDependencyVersions: Readonly<Record<string, string | null>>;
    readonly runtimeManifest: {
      readonly aggregateSha256: string;
      readonly fileCount: number;
      readonly totalBytes: number;
      readonly symlinkCount: number;
      readonly manifestFile: string;
    } | null;
  };
  readonly checks: Readonly<Record<BaselineRuntimeCheck, boolean | null>>;
  readonly failedChecks: readonly BaselineRuntimeCheck[];
  readonly verified: boolean;
  readonly bindingMechanism: string;
  readonly provisionCommands: readonly string[];
}

export interface BaselineMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly entryPointSha256: string;
  readonly runtimeManifestSha256: string;
}

const dirtyPaths = (porcelain: string | null): string[] | null =>
  porcelain === null
    ? null
    : porcelain
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

export function buildProductionBaselineRuntime(
  probe: BaselineRuntimeProbe,
  expected: {
    version?: string;
    sha?: string;
    packageName?: string;
    artifactDirectory?: string;
    runtimeManifestSha256?: string;
  } = {},
): ProductionBaselineRuntime {
  const version = expected.version ?? BENCHMARK_V3_PRODUCTION_BASELINE_VERSION;
  const sha = expected.sha ?? BENCHMARK_V3_PRODUCTION_BASELINE_SHA;
  const packageName = expected.packageName ?? BASELINE_PACKAGE_NAME;
  const artifactDirectory = expected.artifactDirectory ?? BASELINE_ARTIFACT_DIRECTORY;
  const runtimeManifestSha256 =
    expected.runtimeManifestSha256 ?? BENCHMARK_V3_EXPECTED_RUNTIME_MANIFEST_SHA256;
  const dirty = dirtyPaths(probe.statusPorcelain);
  const missingDependencies = probe.declaredDependencies.filter(
    (name) => probe.installedDependencyVersions[name] == null,
  );
  const manifest = probe.runtimeManifest;

  const checks: Record<BaselineRuntimeCheck, boolean | null> = {
    "artifact-present": probe.directoryExists,
    "artifact-isolated-from-development-tree": probe.isolatedFromDevelopmentTree,
    "artifact-head-is-baseline-commit":
      probe.headCommit === null ? null : probe.headCommit === sha,
    "artifact-tree-matches-baseline-commit":
      probe.headTree === null || probe.expectedTree === null
        ? null
        : probe.headTree === probe.expectedTree,
    "artifact-working-tree-clean": dirty === null ? null : dirty.length === 0,
    "artifact-package-name-matches":
      probe.packageName === null ? null : probe.packageName === packageName,
    "artifact-package-version-matches":
      probe.packageVersion === null ? null : probe.packageVersion === version,
    "artifact-version-matches-baseline-commit":
      probe.packageVersionAtBaselineCommit === null || probe.packageVersion === null
        ? null
        : probe.packageVersionAtBaselineCommit === probe.packageVersion,
    "artifact-declares-server-bin": probe.declaredBinPath !== null,
    "artifact-entry-point-present":
      probe.entryPointExists && probe.entryPointSha256 !== null,
    "artifact-entry-point-regular-file":
      probe.entryPointFileType === null ? null : probe.entryPointFileType === "file",
    "artifact-entry-point-contained": probe.entryPointContained,
    "artifact-dependencies-installed":
      probe.declaredDependencies.length === 0 ? null : missingDependencies.length === 0,
    "artifact-launcher-resolved": probe.launcher !== null && probe.launcher !== "",
    "artifact-runtime-manifest-readable": manifest !== null,
    "artifact-runtime-manifest-has-no-symlinks":
      manifest === null ? null : manifest.symlinkCount === 0,
    "artifact-runtime-manifest-matches-freeze":
      manifest === null ? null : manifest.aggregateSha256 === runtimeManifestSha256,
  };
  const failedChecks = BASELINE_RUNTIME_CHECKS.filter((check) => checks[check] !== true);

  return {
    expected: {
      version,
      sha,
      packageName,
      artifactDirectory,
      runtimeManifestSha256,
    },
    observed: {
      artifactDirectory: probe.directory,
      headCommit: probe.headCommit,
      headTree: probe.headTree,
      baselineTree: probe.expectedTree,
      workingTreeClean: dirty === null ? null : dirty.length === 0,
      dirtyPathCount: dirty === null ? null : dirty.length,
      packageName: probe.packageName,
      packageVersion: probe.packageVersion,
      packageVersionAtBaselineCommit: probe.packageVersionAtBaselineCommit,
      declaredBinPath: probe.declaredBinPath,
      entryPoint: probe.entryPoint,
      entryPointRealPath: probe.entryPointRealPath,
      entryPointFileType: probe.entryPointFileType,
      entryPointSha256: probe.entryPointSha256,
      launcher: probe.launcher,
      installedDependencyVersions: { ...probe.installedDependencyVersions },
      runtimeManifest:
        manifest === null
          ? null
          : {
              aggregateSha256: manifest.aggregateSha256,
              fileCount: manifest.fileCount,
              totalBytes: manifest.totalBytes,
              symlinkCount: manifest.symlinkCount,
              manifestFile: BASELINE_RUNTIME_MANIFEST_FILE,
            },
    },
    checks,
    failedChecks,
    verified: failedChecks.length === 0,
    bindingMechanism:
      "The v0.11.0 commit/tree identifies source. A separately frozen aggregate " +
      "manifest hashes package.json, package-lock.json, every dist file, and every " +
      "installed runtime-dependency file. Each Adaptive cell re-observes that " +
      "manifest immediately before launch and after completion; both must equal " +
      "the frozen expected digest before its result may be retained. The absolute " +
      "entry point is passed directly, so this does not depend on the operator's " +
      "external MCP registration.",
    provisionCommands: [...BASELINE_PROVISION_COMMANDS],
  };
}

export function assertProductionBaselineRuntime(
  runtime: ProductionBaselineRuntime,
): void {
  if (runtime.verified) return;
  throw new Error(
    `Benchmark V3 cannot attribute a run to production baseline v${runtime.expected.version} ` +
      `(${runtime.expected.sha}): the baseline artifact at ${runtime.expected.artifactDirectory} ` +
      `failed ${runtime.failedChecks.join(", ")}. Provision it with: ` +
      `${runtime.provisionCommands.join(" && ")}`,
  );
}

export function baselineMcpServer(runtime: ProductionBaselineRuntime): BaselineMcpServer {
  assertProductionBaselineRuntime(runtime);
  const command = runtime.observed.launcher;
  const entry = runtime.observed.entryPoint;
  const entryDigest = runtime.observed.entryPointSha256;
  const manifestDigest = runtime.observed.runtimeManifest?.aggregateSha256 ?? null;
  if (
    command === null ||
    entry === null ||
    entryDigest === null ||
    manifestDigest === null
  ) {
    throw new Error(
      "A verified production baseline must resolve a launcher, regular entry point, " +
        "entry-point digest, and runtime-manifest digest",
    );
  }
  return {
    command,
    args: [entry],
    entryPointSha256: entryDigest,
    runtimeManifestSha256: manifestDigest,
  };
}

export interface BaselineCellRuntimeIdentity {
  readonly expectedRuntimeManifestSha256: string;
  readonly pre: {
    readonly observedRuntimeManifestSha256: string | null;
    readonly entryPoint: string | null;
    readonly entryPointSha256: string | null;
    readonly verified: boolean;
  };
  readonly post: {
    readonly observedRuntimeManifestSha256: string | null;
    readonly entryPoint: string | null;
    readonly entryPointSha256: string | null;
    readonly verified: boolean;
  };
  readonly verified: boolean;
}

export function buildBaselineCellRuntimeIdentity(
  pre: ProductionBaselineRuntime,
  post: ProductionBaselineRuntime,
): BaselineCellRuntimeIdentity {
  const expected = pre.expected.runtimeManifestSha256;
  const preDigest = pre.observed.runtimeManifest?.aggregateSha256 ?? null;
  const postDigest = post.observed.runtimeManifest?.aggregateSha256 ?? null;
  const sameExpected = post.expected.runtimeManifestSha256 === expected;
  const sameEntryPoint =
    pre.observed.entryPoint !== null &&
    pre.observed.entryPoint === post.observed.entryPoint &&
    pre.observed.entryPointSha256 !== null &&
    pre.observed.entryPointSha256 === post.observed.entryPointSha256;
  return {
    expectedRuntimeManifestSha256: expected,
    pre: {
      observedRuntimeManifestSha256: preDigest,
      entryPoint: pre.observed.entryPoint,
      entryPointSha256: pre.observed.entryPointSha256,
      verified: pre.verified,
    },
    post: {
      observedRuntimeManifestSha256: postDigest,
      entryPoint: post.observed.entryPoint,
      entryPointSha256: post.observed.entryPointSha256,
      verified: post.verified,
    },
    verified:
      pre.verified &&
      post.verified &&
      sameExpected &&
      preDigest === expected &&
      postDigest === expected &&
      sameEntryPoint,
  };
}

export function assertBaselineCellRuntimeIdentity(
  identity: BaselineCellRuntimeIdentity,
): void {
  if (identity.verified) return;
  throw new Error(
    "Benchmark V3 Adaptive cell failed closed: its pre/post production-baseline " +
      `runtime identity did not both match ${identity.expectedRuntimeManifestSha256}`,
  );
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const trimmed = (value: string | null): string | null => {
  if (value === null) return null;
  const text = value.trim();
  return text === "" ? null : text;
};

export function packageVersionAtRevision(
  revision: string,
  repoRoot: string = REPO_ROOT,
): string | null {
  const blob = readToolOutput("git", ["show", `${revision}:package.json`], {
    cwd: repoRoot,
  });
  if (blob === null) return null;
  try {
    const parsed = JSON.parse(blob) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

const entryPointReading = (
  entryPoint: string | null,
  directory: string,
): Pick<
  BaselineRuntimeProbe,
  | "entryPointExists"
  | "entryPointFileType"
  | "entryPointRealPath"
  | "entryPointContained"
  | "entryPointSha256"
> => {
  if (entryPoint === null) {
    return {
      entryPointExists: false,
      entryPointFileType: null,
      entryPointRealPath: null,
      entryPointContained: null,
      entryPointSha256: null,
    };
  }
  try {
    const stats = fs.lstatSync(entryPoint);
    const fileType = stats.isSymbolicLink()
      ? "symlink"
      : stats.isFile()
        ? "file"
        : stats.isDirectory()
          ? "directory"
          : "other";
    const real = fs.realpathSync(entryPoint);
    const relative = path.relative(fs.realpathSync(directory), real);
    const contained =
      relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..";
    const bytes = fileType === "file" ? fs.readFileSync(entryPoint) : null;
    return {
      entryPointExists: true,
      entryPointFileType: fileType,
      entryPointRealPath: real,
      entryPointContained: contained,
      entryPointSha256: bytes === null ? null : sha256(bytes),
    };
  } catch {
    return {
      entryPointExists: false,
      entryPointFileType: null,
      entryPointRealPath: null,
      entryPointContained: null,
      entryPointSha256: null,
    };
  }
};

export function captureBaselineRuntimeProbe(
  options: {
    repoRoot?: string;
    artifactDirectory?: string;
    baselineSha?: string;
    launcher?: string;
  } = {},
): BaselineRuntimeProbe {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const relative = options.artifactDirectory ?? BASELINE_ARTIFACT_DIRECTORY;
  const sha = options.baselineSha ?? BENCHMARK_V3_PRODUCTION_BASELINE_SHA;
  const directory = path.resolve(repoRoot, relative);
  const directoryExists = fs.existsSync(directory);
  const expectedTree = trimmed(
    readToolOutput("git", ["rev-parse", `${sha}^{tree}`], { cwd: repoRoot }),
  );

  if (!directoryExists) {
    return {
      directory,
      directoryExists: false,
      isolatedFromDevelopmentTree: path.resolve(directory) !== path.resolve(repoRoot),
      headCommit: null,
      headTree: null,
      statusPorcelain: null,
      expectedTree,
      packageName: null,
      packageVersion: null,
      packageVersionAtBaselineCommit: packageVersionAtRevision(sha, repoRoot),
      declaredBinPath: null,
      entryPoint: null,
      entryPointExists: false,
      entryPointFileType: null,
      entryPointRealPath: null,
      entryPointContained: null,
      entryPointSha256: null,
      launcher: options.launcher ?? process.execPath,
      declaredDependencies: [],
      installedDependencyVersions: {},
      runtimeManifest: null,
    };
  }

  const packageJson = readJson(path.join(directory, "package.json"));
  const bin = packageJson?.["bin"];
  const declaredBinPath =
    bin !== null && typeof bin === "object"
      ? (((bin as Record<string, unknown>)[BASELINE_BIN_NAME] as string | undefined) ??
        null)
      : null;
  const entryPoint =
    declaredBinPath === null ? null : path.resolve(directory, declaredBinPath);
  const entry = entryPointReading(entryPoint, directory);
  const dependencies = packageJson?.["dependencies"];
  const declaredDependencies =
    dependencies !== null && typeof dependencies === "object"
      ? Object.keys(dependencies as Record<string, unknown>).sort(byCodePoint)
      : [];
  const installedDependencyVersions: Record<string, string | null> = {};
  for (const name of declaredDependencies) {
    const installed = readJson(
      path.join(directory, "node_modules", ...name.split("/"), "package.json"),
    );
    installedDependencyVersions[name] =
      typeof installed?.["version"] === "string"
        ? (installed["version"] as string)
        : null;
  }

  return {
    directory,
    directoryExists: true,
    isolatedFromDevelopmentTree: path.resolve(directory) !== path.resolve(repoRoot),
    headCommit: trimmed(readToolOutput("git", ["rev-parse", "HEAD"], { cwd: directory })),
    headTree: trimmed(
      readToolOutput("git", ["rev-parse", "HEAD^{tree}"], { cwd: directory }),
    ),
    statusPorcelain: readToolOutput(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: directory },
    ),
    expectedTree,
    packageName:
      typeof packageJson?.["name"] === "string" ? (packageJson["name"] as string) : null,
    packageVersion:
      typeof packageJson?.["version"] === "string"
        ? (packageJson["version"] as string)
        : null,
    packageVersionAtBaselineCommit: packageVersionAtRevision(sha, repoRoot),
    declaredBinPath,
    entryPoint,
    ...entry,
    launcher: options.launcher ?? process.execPath,
    declaredDependencies,
    installedDependencyVersions,
    runtimeManifest: buildBaselineRuntimeManifest(directory),
  };
}

export const captureProductionBaselineRuntime = (
  options: Parameters<typeof captureBaselineRuntimeProbe>[0] = {},
): ProductionBaselineRuntime =>
  buildProductionBaselineRuntime(captureBaselineRuntimeProbe(options));

const assertProvisionTarget = (repoRoot: string, directory: string): void => {
  const baselineRoot = path.resolve(repoRoot, "bench", "baseline");
  const relative = path.relative(baselineRoot, directory);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Refusing unsafe baseline artifact target: ${directory}`);
  }
};

const runProvisionCommand = (
  file: string,
  args: readonly string[],
  cwd: string,
  allowFailure = false,
): void => {
  const env = withoutCwdExecutableLookup(process.env);
  const resolved = resolveBenchExecutable(file, { env });
  if (resolved === null) throw new Error(`Cannot resolve ${file} from PATH`);
  const result = spawnSync(resolved, [...args], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    stdio: allowFailure ? ["ignore", "ignore", "ignore"] : "inherit",
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`${file} ${args.join(" ")} failed with ${String(result.status)}`);
  }
};

/** Canonically materialize, install, build, prune, manifest, and verify v0.11.0. */
export function provisionProductionBaselineArtifact(
  repoRoot: string = REPO_ROOT,
): ProductionBaselineRuntime {
  const directory = path.resolve(repoRoot, BASELINE_ARTIFACT_DIRECTORY);
  assertProvisionTarget(repoRoot, directory);
  const tagged = trimmed(
    readToolOutput(
      "git",
      ["rev-list", "-n", "1", `v${BENCHMARK_V3_PRODUCTION_BASELINE_VERSION}`],
      { cwd: repoRoot },
    ),
  );
  if (tagged !== BENCHMARK_V3_PRODUCTION_BASELINE_SHA) {
    throw new Error(
      `v${BENCHMARK_V3_PRODUCTION_BASELINE_VERSION} resolves to ${String(tagged)}, ` +
        `not ${BENCHMARK_V3_PRODUCTION_BASELINE_SHA}`,
    );
  }

  runProvisionCommand(
    "git",
    ["worktree", "remove", "--force", directory],
    repoRoot,
    true,
  );
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  runProvisionCommand("git", ["worktree", "prune"], repoRoot);
  runProvisionCommand(
    "git",
    ["worktree", "add", "--detach", directory, BENCHMARK_V3_PRODUCTION_BASELINE_SHA],
    repoRoot,
  );
  runProvisionCommand("npm", ["ci", "--prefix", directory], repoRoot);
  runProvisionCommand("npm", ["run", "build", "--prefix", directory], repoRoot);
  runProvisionCommand("npm", ["prune", "--omit=dev", "--prefix", directory], repoRoot);

  const manifest = buildBaselineRuntimeManifest(directory);
  if (manifest === null) throw new Error("Could not calculate baseline runtime manifest");
  fs.writeFileSync(
    path.join(directory, BASELINE_RUNTIME_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n",
    { encoding: "utf8", flag: "w", flush: true },
  );
  const runtime = captureProductionBaselineRuntime({ repoRoot });
  console.log(`Baseline source commit: ${BENCHMARK_V3_PRODUCTION_BASELINE_SHA}`);
  console.log(
    `Expected runtime manifest: ${BENCHMARK_V3_EXPECTED_RUNTIME_MANIFEST_SHA256}`,
  );
  console.log(
    `Observed runtime manifest: ${runtime.observed.runtimeManifest?.aggregateSha256 ?? "unreadable"}`,
  );
  assertProductionBaselineRuntime(runtime);
  return runtime;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv.includes("--provision")
) {
  try {
    provisionProductionBaselineArtifact();
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
