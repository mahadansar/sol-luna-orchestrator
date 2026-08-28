/**
 * Reproducibility evidence for a benchmark campaign.
 *
 * Every field is either an observed fact or `null`. The capture layer shells
 * out; the record builder is pure, so the committed shape can be tested without
 * a repository, a network, or an installed toolchain. Nothing here estimates,
 * defaults, or back-fills a value it could not read.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";

/**
 * Environment variables that can change what a campaign measures.
 *
 * An allowlist rather than a dump of `process.env`: a benchmark record is
 * committed evidence, and an unbounded environment snapshot would publish
 * credentials.
 */
export const RECORDED_ENVIRONMENT_KEYS = [
  "BENCH_TASK_TIMEOUT",
  "LUNA_SANDBOX",
  "SOL_LUNA_ALLOWED_EFFORTS",
  "SOL_LUNA_ALLOWED_MODELS",
  "SOL_LUNA_ALLOW_DIRTY",
  "SOL_LUNA_ALLOW_EFFORT_ESCALATION",
  "SOL_LUNA_ALLOW_STRONGER_FALLBACK",
  "SOL_LUNA_CONTEXT_COOLDOWN_TURNS",
  "SOL_LUNA_CONTEXT_MAX_BYTES",
  "SOL_LUNA_CONTEXT_MAX_CLEAN_TURNS",
  "SOL_LUNA_CONTEXT_MAX_TURNS",
  "SOL_LUNA_EXECUTOR_ORDER",
  "SOL_LUNA_KEEP_WORKTREES",
  "SOL_LUNA_MAX_PARALLEL",
  "SOL_LUNA_MAX_WORKERS_PER_BATCH",
  "SOL_LUNA_SERVER_NAME",
  "SOL_LUNA_VERIFY_MODE",
] as const;

export type RecordedEnvironmentKey = (typeof RECORDED_ENVIRONMENT_KEYS)[number];

/** Raw readings handed to the pure builder. Unknown is null, never a guess. */
export interface EnvironmentProbe {
  readonly capturedAt: string;
  readonly gitCommit: string | null;
  readonly gitBranch: string | null;
  readonly gitStatusPorcelain: string | null;
  readonly gitDescribe: string | null;
  readonly nodeVersion: string | null;
  readonly npmVersion: string | null;
  readonly codexCliVersion: string | null;
  readonly codexSdkVersion: string | null;
  readonly packageVersion: string | null;
  readonly platform: string | null;
  readonly arch: string | null;
  readonly osRelease: string | null;
  readonly cpuCount: number | null;
  readonly totalMemoryBytes: number | null;
  readonly timezone: string | null;
  readonly argv: readonly string[];
  readonly cwd: string | null;
  readonly environment: Readonly<Partial<Record<RecordedEnvironmentKey, string>>>;
}

export interface EnvironmentRecord {
  readonly capturedAt: string;
  readonly git: {
    readonly commit: string | null;
    readonly branch: string | null;
    readonly describe: string | null;
    /** Null when `git status` itself could not be read. */
    readonly workingTreeClean: boolean | null;
    readonly dirtyPathCount: number | null;
  };
  readonly runtime: {
    readonly nodeVersion: string | null;
    readonly platform: string | null;
    readonly arch: string | null;
    readonly osRelease: string | null;
    readonly cpuCount: number | null;
    readonly totalMemoryBytes: number | null;
    readonly timezone: string | null;
  };
  readonly toolchain: {
    readonly packageVersion: string | null;
    readonly npmVersion: string | null;
    readonly codexCliVersion: string | null;
    readonly codexSdkVersion: string | null;
  };
  readonly invocation: {
    readonly argv: readonly string[];
    readonly cwd: string | null;
  };
  /** Only allowlisted keys, and only those actually set. */
  readonly environment: Readonly<Partial<Record<RecordedEnvironmentKey, string>>>;
}

const text = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const count = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Turn one probe into the committed record. Pure: no environment access. */
export function buildEnvironmentRecord(probe: EnvironmentProbe): EnvironmentRecord {
  const porcelain = probe.gitStatusPorcelain;
  const dirtyPaths =
    typeof porcelain === "string"
      ? porcelain
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : null;
  return {
    capturedAt: probe.capturedAt,
    git: {
      commit: text(probe.gitCommit),
      branch: text(probe.gitBranch),
      describe: text(probe.gitDescribe),
      workingTreeClean: dirtyPaths === null ? null : dirtyPaths.length === 0,
      dirtyPathCount: dirtyPaths === null ? null : dirtyPaths.length,
    },
    runtime: {
      nodeVersion: text(probe.nodeVersion),
      platform: text(probe.platform),
      arch: text(probe.arch),
      osRelease: text(probe.osRelease),
      cpuCount: count(probe.cpuCount),
      totalMemoryBytes: count(probe.totalMemoryBytes),
      timezone: text(probe.timezone),
    },
    toolchain: {
      packageVersion: text(probe.packageVersion),
      npmVersion: text(probe.npmVersion),
      codexCliVersion: text(probe.codexCliVersion),
      codexSdkVersion: text(probe.codexSdkVersion),
    },
    invocation: {
      argv: [...probe.argv],
      cwd: text(probe.cwd),
    },
    environment: Object.fromEntries(
      RECORDED_ENVIRONMENT_KEYS.filter(
        (key) => text(probe.environment[key]) !== null,
      ).map((key) => [key, probe.environment[key] as string]),
    ),
  };
}

/**
 * Reproducibility fields a live campaign may not launch without.
 *
 * A benchmark whose commit, branch, runtime, or invocation is unknown cannot be
 * audited later, so the launch fails loudly here rather than producing evidence
 * that quietly cannot be reproduced.
 */
export const REQUIRED_ENVIRONMENT_FIELDS = [
  "git.commit",
  "git.branch",
  "git.workingTreeClean",
  "runtime.nodeVersion",
  "runtime.platform",
  "runtime.arch",
  "toolchain.packageVersion",
  "invocation.cwd",
] as const;

export type RequiredEnvironmentField = (typeof REQUIRED_ENVIRONMENT_FIELDS)[number];

export function missingEnvironmentEvidence(
  record: EnvironmentRecord,
): RequiredEnvironmentField[] {
  const values: Record<RequiredEnvironmentField, unknown> = {
    "git.commit": record.git.commit,
    "git.branch": record.git.branch,
    "git.workingTreeClean": record.git.workingTreeClean,
    "runtime.nodeVersion": record.runtime.nodeVersion,
    "runtime.platform": record.runtime.platform,
    "runtime.arch": record.runtime.arch,
    "toolchain.packageVersion": record.toolchain.packageVersion,
    "invocation.cwd": record.invocation.cwd,
  };
  return REQUIRED_ENVIRONMENT_FIELDS.filter(
    (field) => values[field] === null || values[field] === undefined,
  );
}

/**
 * Refuse to launch without auditable provenance.
 *
 * A dirty working tree is rejected for a holdout campaign because the recorded
 * commit would then not describe the code that actually ran.
 */
export function assertEnvironmentEvidence(
  record: EnvironmentRecord,
  options: { requireCleanWorkingTree?: boolean } = {},
): void {
  const missing = missingEnvironmentEvidence(record);
  if (missing.length > 0) {
    throw new Error(
      `Benchmark launch requires reproducibility evidence; unavailable: ${missing.join(", ")}`,
    );
  }
  if (options.requireCleanWorkingTree && record.git.workingTreeClean !== true) {
    throw new Error(
      `Benchmark launch requires a clean working tree; ${
        record.git.dirtyPathCount ?? "unknown"
      } path(s) differ from the recorded commit`,
    );
  }
}

const readCommand = (file: string, args: readonly string[]): string | null => {
  try {
    return execFileSync(file, [...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    });
  } catch {
    return null;
  }
};

/** Read the live environment. The only impure function in this module. */
export function captureEnvironmentProbe(
  options: {
    cwd?: string;
    argv?: readonly string[];
    packageVersion?: string | null;
    codexSdkVersion?: string | null;
  } = {},
): EnvironmentProbe {
  const environment: Partial<Record<RecordedEnvironmentKey, string>> = {};
  for (const key of RECORDED_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim() !== "") environment[key] = value;
  }
  return {
    capturedAt: new Date().toISOString(),
    gitCommit: readCommand("git", ["rev-parse", "HEAD"]),
    gitBranch: readCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitStatusPorcelain: readCommand("git", ["status", "--porcelain"]),
    gitDescribe: readCommand("git", ["describe", "--always", "--dirty", "--tags"]),
    nodeVersion: process.version,
    npmVersion: readCommand(process.platform === "win32" ? "npm.cmd" : "npm", [
      "--version",
    ]),
    codexCliVersion: readCommand("codex", ["--version"]),
    codexSdkVersion: options.codexSdkVersion ?? null,
    packageVersion: options.packageVersion ?? null,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    argv: options.argv ?? process.argv.slice(2),
    cwd: options.cwd ?? process.cwd(),
    environment,
  };
}

export const captureEnvironmentRecord = (
  options: Parameters<typeof captureEnvironmentProbe>[0] = {},
): EnvironmentRecord => buildEnvironmentRecord(captureEnvironmentProbe(options));
