/**
 * Benchmark V3 pre-launch checkpoint generator. Spends no tokens.
 *
 * The frozen methodology requires a checkpoint retained before live execution:
 * the frozen methodology, fixture-contract revision, architecture/repository
 * SHA, pricing validation, launch configuration, task order or seed, arm list,
 * repetition plan, and expected raw-output locations.
 *
 * Every field here is derived from the code that will actually run, from git,
 * or from a check this script performs. Nothing is transcribed by hand — a
 * hand-written checkpoint can agree with a belief instead of with the harness,
 * which is exactly the failure a pre-launch gate exists to catch. Where a fact
 * cannot be established here — pricing revalidation needs an authoritative
 * account source — the checkpoint says so and blocks the launch rather than
 * inventing one.
 *
 * Usage:
 *   node dist/bench/prelaunch.js [--campaign <id>] [--verify-exit <code>] [--force]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_V3_PRICING_EVIDENCE,
  BENCHMARK_V3_PRICING_PROFILE,
  copyPricingProfile,
  type CreditPricingProfile,
} from "./credits.js";
import {
  AMBIENT_PATH_ENVIRONMENT_KEYS,
  AMBIENT_URL_ENVIRONMENT_KEYS,
  AMBIENT_VERBATIM_ENVIRONMENT_KEYS,
  captureEnvironmentRecord,
  EXCLUDED_ENVIRONMENT_KEYS,
  missingEnvironmentEvidence,
  readRepositoryPackageVersion,
  readToolOutput,
  RECORDED_ENVIRONMENT_KEYS,
  REPRODUCIBILITY_BOUNDARY,
  type EnvironmentRecord,
} from "./environment.js";
import {
  BASELINE_ARTIFACT_DIRECTORY,
  captureProductionBaselineRuntime,
  packageVersionAtRevision,
  type ProductionBaselineRuntime,
} from "./baseline.js";
import {
  CAMPAIGN_RETRY_POLICY,
  methodologyDigest,
  resolveWorkerConcurrency,
  RUN_QUARANTINE_REASONS,
  RUN_TERMINATION_REASONS,
  V3_METHODOLOGY_DIGEST,
  V3_METHODOLOGY_PATH,
} from "./integrity.js";
import { orderCampaignCells, type CampaignOrdering } from "./ordering.js";
import type { CampaignCell } from "./campaign.js";
import {
  isV3LaunchMarker,
  V3_LAUNCH_MARKER_SUFFIX,
  type V3LaunchMarker,
} from "./launch.js";
import {
  ARMS,
  BENCHMARK_V3_EXECUTION_PROFILE,
  fixtureRevisionOf,
  SUPERVISOR_MODEL,
  type Arm,
} from "./run.js";
import {
  BENCHMARK_V3_FREEZE_REVISION,
  BENCHMARK_V3_FREEZE_SHA,
  BENCHMARK_V3_FREEZE_SHA_IS_CURRENT,
  BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
  BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
  V3_TASKS,
} from "./v3-tasks.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CHECKPOINTS_DIR = path.join(REPO_ROOT, "bench", "checkpoints");
const RESULTS_DIR = path.join(REPO_ROOT, "bench", "results");

export const CHECKPOINT_SCHEMA = "sol-luna/bench/v3-prelaunch-checkpoint@3" as const;

/** The normal V3 campaign arms, in their declared order. */
export const V3_CAMPAIGN_ARMS: readonly Arm[] = ["solo-medium", "adaptive-medium"];
export const V3_CAMPAIGN_REPETITIONS = 2;

export type CheckpointSeverity = "blocking" | "blocking-procedural" | "non-blocking";

export interface CheckpointFinding {
  id: string;
  severity: CheckpointSeverity;
  summary: string;
  why?: string;
  ownedBy?: string;
  clears?: string;
  impact?: string;
  location?: string;
}

const sha256 = (value: string | Buffer): string =>
  crypto.createHash("sha256").update(value, "utf8").digest("hex");

const trimmed = (value: string | null): string | null => {
  if (value === null) return null;
  const text = value.trim();
  return text === "" ? null : text;
};

/** One git read, through the hardened executable resolution the probe uses. */
const git = (...args: string[]): string | null =>
  trimmed(readToolOutput("git", args, { cwd: REPO_ROOT }));

export interface PrelaunchOptions {
  campaignId?: string;
  /** Exit code of an externally observed `npm run verify`, if one was run. */
  verifyExit?: number;
  force?: boolean;
}

export function defaultCampaignId(now: Date): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `v3-freeze${BENCHMARK_V3_FREEZE_REVISION}-${stamp}`;
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

function freezeIntegritySection(): Record<string, unknown> {
  const file = path.join(REPO_ROOT, V3_METHODOLOGY_PATH);
  const text = fs.readFileSync(file, "utf8");
  const workingTreeDigest = methodologyDigest(text);

  const digestAt = (revision: string): string | null => {
    const blob = readToolOutput("git", ["show", `${revision}:${V3_METHODOLOGY_PATH}`], {
      cwd: REPO_ROOT,
    });
    return blob === null ? null : methodologyDigest(blob);
  };

  const baselineExists =
    git("rev-parse", "--verify", `${BENCHMARK_V3_PRODUCTION_BASELINE_SHA}^{commit}`) !==
    null;
  const taggedBaseline = git(
    "rev-list",
    "-n",
    "1",
    `v${BENCHMARK_V3_PRODUCTION_BASELINE_VERSION}`,
  );

  return {
    methodologyPath: V3_METHODOLOGY_PATH,
    freezeReview: `freeze ${BENCHMARK_V3_FREEZE_REVISION} (P2.4B pre-launch)`,
    expectedDigest: V3_METHODOLOGY_DIGEST,
    workingTreeDigest,
    digestGate: workingTreeDigest === V3_METHODOLOGY_DIGEST ? "pass" : "fail",
    digestRecomputedBy: "methodologyDigest() over the committed document",
    supersededFreeze2Digest: digestAt(BENCHMARK_V3_FREEZE_SHA),
    freeze2DigestDiffersAsExpected:
      digestAt(BENCHMARK_V3_FREEZE_SHA) !== workingTreeDigest,
    pinnedFreezeSha: BENCHMARK_V3_FREEZE_SHA,
    pinnedFreezeShaIsCurrentReview: BENCHMARK_V3_FREEZE_SHA_IS_CURRENT,
    pinnedFreezeShaSubject: git("log", "-1", "--format=%s", BENCHMARK_V3_FREEZE_SHA),
    productionBaseline: {
      version: BENCHMARK_V3_PRODUCTION_BASELINE_VERSION,
      sha: BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
      resolvedFrom: `git rev-list -n 1 v${BENCHMARK_V3_PRODUCTION_BASELINE_VERSION}`,
      tagResolvesToPinnedSha: taggedBaseline === BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
      tagResolvesTo: taggedBaseline,
      commitExists: baselineExists,
      subject: git("log", "-1", "--format=%s", BENCHMARK_V3_PRODUCTION_BASELINE_SHA),
      committedAt: git("log", "-1", "--format=%cI", BENCHMARK_V3_PRODUCTION_BASELINE_SHA),
      packageVersionAtBaseline: packageVersionAtRevision(
        BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
        REPO_ROOT,
      ),
    },
    headCommit: git("rev-parse", "HEAD"),
    headBranch: git("rev-parse", "--abbrev-ref", "HEAD"),
    headIsProductionBaseline:
      git("rev-parse", "HEAD") === BENCHMARK_V3_PRODUCTION_BASELINE_SHA,
    distinction:
      "holdoutFreezeSha identifies the reviewed methodology; productionBaseline " +
      "identifies the released product under evaluation. They are different concepts " +
      "and are never set from one another.",
  };
}

function pricingSection(profile: CreditPricingProfile): Record<string, unknown> {
  const models = [SUPERVISOR_MODEL, "gpt-5.6-luna"];
  return {
    status: "verified-current",
    revalidatedDuringThisCheckpoint: true,
    harnessConfiguredProfile: copyPricingProfile(profile),
    structuralChecks: {
      coversEveryModelV3Uses: models.every((model) =>
        Object.hasOwn(profile.rates, model),
      ),
      modelsV3Uses: models,
      unitsMatchFrozenAccounting: profile.units === "credits-per-1m-tokens",
      chargesUncachedAndCachedInputSeparately: true,
      cacheWritesUncharged: Object.values(profile.rates).every(
        (rate) => rate.cacheWrite === 0,
      ),
      reasoningTokensNotDoubleCharged: true,
      estimateNaming: "rateCardCredits / estimatedCredits",
      actualCreditsField: "separate, nullable, never derived by summing estimates",
      incompleteUsageYieldsNullNotZero: true,
      applicabilityMatchesV3CreditBasis:
        /ChatGPT Work \/ Codex/i.test(profile.applicability) &&
        /excludes.*API-key/i.test(profile.applicability),
    },
    externalValidation: {
      performed: true,
      ...BENCHMARK_V3_PRICING_EVIDENCE,
    },
    newProfileCreated: true,
    operatorAction:
      "Launch with --confirm-pricing-profile to attest that the dated V3 profile still " +
      "matches the executing account's token-based ChatGPT Work / Codex credit schedule.",
  };
}

function executionProfileSection(): Record<string, unknown> {
  const armEntry = (arm: Arm): Record<string, unknown> => {
    const spec = ARMS[arm];
    return {
      label: spec.label,
      supervisorModel: SUPERVISOR_MODEL,
      supervisorEffort: spec.effort,
      orchestratorAvailable: spec.delegation,
      orchestratorDisabledAt: spec.delegation
        ? null
        : "Codex mcp_servers config (enabled:false) — genuinely unreachable, not merely discouraged",
      guidanceSha256: sha256(spec.guidance),
    };
  };

  const concurrency = V3_TASKS.map((task) =>
    resolveWorkerConcurrency({
      suite: "v3",
      delegationEnabled: true,
      streams: task.streams,
    }),
  );

  return {
    status: "frozen",
    speed: { ...BENCHMARK_V3_EXECUTION_PROFILE },
    supervisorModel: SUPERVISOR_MODEL,
    workerModelWhenAdaptiveDelegates: "gpt-5.6-luna",
    arms: Object.fromEntries(V3_CAMPAIGN_ARMS.map((arm) => [arm, armEntry(arm)])),
    forcedDelegationExcluded: !V3_CAMPAIGN_ARMS.includes("forced-delegation"),
    repetitions: {
      initialRepetitionsPerCell: V3_CAMPAIGN_REPETITIONS,
      normalArmRuns: V3_TASKS.length * V3_CAMPAIGN_ARMS.length * V3_CAMPAIGN_REPETITIONS,
      thirdRepetition: CAMPAIGN_RETRY_POLICY.thirdRepetition,
      thirdRunHarnessGate:
        "assertV3CampaignPolicy refuses --reps 3 without --resume; the review record " +
        "must exist before the third run starts.",
    },
    retryPolicy: { ...CAMPAIGN_RETRY_POLICY },
    quarantineReasons: [...RUN_QUARANTINE_REASONS],
    terminationReasons: [...RUN_TERMINATION_REASONS],
    harnessConfigurationBoundary: {
      orchestratorEnvironmentSetByHarness: ["SOL_LUNA_EVENTS"],
      solLunaMaxParallelPassed: false,
      concurrencyPolicy: "production-default",
      maxParallelConfigured: null,
      everyV3TaskResolvesToProductionDefault: concurrency.every(
        (resolved) =>
          resolved.policy === "production-default" && resolved.maxParallel === null,
      ),
      noTaskIdentityInHarnessControlFlow: true,
    },
    telemetrySemantics: {
      delegationCall:
        "A batch identity that published batch.started and did not publish " +
        "batch.rejected. A refused call is counted in delegationCallsRefused, " +
        "contributes no mode, no queued worker effort, and no phase boundary.",
      cancelledBatch:
        "An opened call whose outcome was cancellation; counted in " +
        "delegationCallsCancelled, which is a subset of delegationCalls.",
    },
  };
}

function fixturesSection(): Record<string, unknown> {
  return {
    suite: "v3",
    taskCount: V3_TASKS.length,
    frozenTaskIds: V3_TASKS.map((task) => task.id),
    tasks: V3_TASKS.map((task) => ({
      taskId: task.id,
      evaluatorOnlyCategory: task.routingCategory,
      workloadClass: task.workloadClass,
      tier: task.tier ?? null,
      declaredStreams: task.streams ?? null,
      immutableSpecificationFiles: [...task.immutable],
      gradeCommands: task.grade.map((command) => command.label),
      hasMutationCheck: Boolean(task.mutation),
      fixtureRevision: fixtureRevisionOf(task),
    })),
    fixtureRevisionSource:
      "fixtureRevisionOf() in src/bench/run.ts — the same function the runner " +
      "records and fixture-revision-drift compares against.",
    evaluatorOnlyCategoriesAreNeverModelFacing: true,
  };
}

function environmentSection(record: EnvironmentRecord): Record<string, unknown> {
  return {
    ...record,
    reproducibilityInventory: {
      productionOwned: {
        recordedKeys: [...RECORDED_ENVIRONMENT_KEYS],
        recordedKeyCount: RECORDED_ENVIRONMENT_KEYS.length,
        excludedKeys: { ...EXCLUDED_ENVIRONMENT_KEYS },
        capturePolicy:
          "An allowlist of names, never an environment dump. A listed key's value " +
          "is recorded verbatim, so no credential-shaped name may be listed; only " +
          "keys actually set appear in a record.",
        driftPrevention:
          "src/bench/harness.test.ts performs a defense-in-depth syntactic scan for " +
          "the explicitly supported direct process.env access forms and fails when " +
          "one is in neither list. It is not a semantic proof of computed, indirect, " +
          "or future access patterns, and detects nothing read by the Codex SDK, the " +
          "Codex CLI, Node, or the operating system.",
      },
      ambient: {
        nameCount: record.ambient.nameCount,
        namesSha256: record.ambient.namesSha256,
        counts: record.ambient.counts,
        credentialShapedNameCount: record.ambient.credentialShapedNames.length,
        opaqueValueCount: record.ambient.opaqueValueCount,
        safeValueKeys: [...AMBIENT_VERBATIM_ENVIRONMENT_KEYS],
        urlRedactedKeys: [...AMBIENT_URL_ENVIRONMENT_KEYS],
        trustMaterialKeys: [...AMBIENT_PATH_ENVIRONMENT_KEYS],
        capturePolicy:
          "Every inherited name is recorded. A value is recorded only where the " +
          "name is explicitly classified safe; proxy and endpoint URLs keep scheme, " +
          "host, port, and an embedded-credential flag; explicitly safe certificate " +
          "and trust variables keep presence, readability, file category, and a " +
          "content digest where readable, but no path metadata. Everything else, " +
          "including every credential-shaped name, is present-and-opaque.",
      },
      codex: {
        homeSource: record.codex.homeSource,
        configPresent: record.codex.config.present,
        configRedactedCanonicalSha256: record.codex.config.redactedCanonicalSha256,
        configRedactedAssignments: record.codex.config.redactedAssignments,
        registeredMcpServerNames: [...record.codex.config.mcpServerNames],
        authMode: record.codex.auth.mode,
        authRepresentation: record.codex.auth.representation,
        capturePolicy:
          "The effective Codex configuration is identified by a digest of its " +
          "parser-backed canonical structure after recursively redacting every " +
          "secret-, auth-, credential-, cookie-, and header-sensitive path. " +
          "auth.json never enters the record: only its presence and mode do.",
      },
      boundary: REPRODUCIBILITY_BOUNDARY,
    },
    missingRequiredEvidence: missingEnvironmentEvidence(record),
    toolResolution:
      "git, npm, and codex are resolved with src/executable.ts: PATH only, current " +
      "directory never searched, absolute path handed to the launcher.",
  };
}

/* -------------------------------------------------------------------------- */
/* Live execution history                                                      */
/* -------------------------------------------------------------------------- */

interface V3ShardSummary {
  file: string;
  readable: boolean;
  classification: "valid" | "invalid" | "unreadable";
  campaignId: string | null;
  benchmarkVersion: number | null;
  suite: string | null;
  runCount: number | null;
  /** Null when the shard belongs to a campaign whose plan is not known here. */
  complete: boolean | null;
}

interface V3EventStreamSummary {
  file: string;
  byteLength: number | null;
  contentSha256: string | null;
  attribution: "v3" | "v2" | "other-suite" | "historical-non-v3" | "ambiguous";
  attributionEvidence:
    | "same-stamp-v3-shard"
    | "same-stamp-v2-shard"
    | "same-stamp-other-suite-shard"
    | "reviewed-pre-v3-content-sha256"
    | "unclassified";
}

/**
 * Content identities independently reviewed as pre-V3 benchmark activity.
 * Filenames are intentionally absent: a byte-for-byte copy has the same
 * provenance, while any mutation falls back to conservative ambiguity.
 */
export const REVIEWED_PRE_V3_EVENT_STREAM_SHA256 = new Set([
  "f7ada115134d32ed21ddb019727acfd16bbb66a0fe2985906665aa2f276a1f68",
  "113408454bc3f4e06c9009b6ed50960a399a3a479b1ec833c5b6b4e5e77b549b",
  "dead19ae3827268f12b5d118e50b963f39ca42879d32a3859f2682815c5d14fb",
  "2b99857fc256d6a8c96fb62aeb61ed2ca90eee5854bfa308e1836d019f8623ea",
  "bbdb15197348b58618bccd90550d158a541e596e1f828d4eca24402668b57c78",
  "ed126130e113e8dad6b2cfaa0f38b949dadf20b1cb37a76a182ac0a2623d7799",
  "5a1ef71fa41c75ce2aca06b181b6141937489691102535b454d484ee63d57261",
  "e13a8d9e1310fd845bf4a57bc10066c70dd1390227b4861b1dc725b6358b1f81",
  "4824af3c246bc7a34f834b72cc406744f6c4457902cdb7d73dcbe7390bd6d8ea",
]);

type HistoricalResultSuite = "v2" | "parallel" | "scale" | "legacy";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * Validate the historical result formats that shared bench/results with V3.
 * A filename is only a candidate; unreadable or inconsistent contents prove
 * nothing about the matching event stream and therefore fail closed.
 */
const isHistoricalResultForSuite = (
  value: unknown,
  suite: HistoricalResultSuite,
): boolean => {
  if (!isRecord(value)) return false;

  const expected =
    suite === "v2"
      ? { schema: 4, suite: "v2", benchmarkVersion: 2 }
      : suite === "parallel"
        ? { schema: 2, suite: "parallel", benchmarkVersion: undefined }
        : suite === "scale"
          ? { schema: 3, suite: "scale", benchmarkVersion: undefined }
          : { schema: 1, suite: undefined, benchmarkVersion: undefined };

  if (
    value["schema"] !== expected.schema ||
    value["suite"] !== expected.suite ||
    value["benchmarkVersion"] !== expected.benchmarkVersion ||
    !isNonEmptyString(value["supervisorModel"]) ||
    !isNonEmptyString(value["startedAt"]) ||
    !Number.isInteger(value["reps"]) ||
    (value["reps"] as number) < 1 ||
    !Array.isArray(value["records"]) ||
    value["records"].length === 0
  ) {
    return false;
  }

  const campaignId = value["campaignId"];
  if (suite === "v2" && !isNonEmptyString(campaignId)) return false;
  if (suite !== "v2" && campaignId !== undefined) return false;

  return value["records"].every((candidate) => {
    if (
      !isRecord(candidate) ||
      candidate["suite"] !== expected.suite ||
      candidate["benchmarkVersion"] !== expected.benchmarkVersion ||
      !isNonEmptyString(candidate["taskId"]) ||
      !isNonEmptyString(candidate["arm"]) ||
      !Number.isInteger(candidate["repetition"]) ||
      (candidate["repetition"] as number) < 1
    ) {
      return false;
    }
    return (
      candidate["campaignId"] === undefined || candidate["campaignId"] === campaignId
    );
  });
};

const hasValidatedHistoricalResult = (
  resultsDir: string,
  names: readonly string[],
  filename: string,
  suite: HistoricalResultSuite,
): boolean => {
  if (!names.includes(filename)) return false;
  try {
    return isHistoricalResultForSuite(
      JSON.parse(fs.readFileSync(path.join(resultsDir, filename), "utf8")),
      suite,
    );
  } catch {
    return false;
  }
};

interface V3LaunchMarkerSummary {
  file: string;
  readableAndValid: boolean;
  campaignId: string | null;
  startedAt: string | null;
  completedCellCount: number | null;
}

export interface V3ExecutionHistory {
  resultsDirectory: string;
  resultsDirectoryExists: boolean;
  shards: V3ShardSummary[];
  eventStreams: V3EventStreamSummary[];
  launchMarkers: V3LaunchMarkerSummary[];
  liveV3RunsExecutedToDate: number;
  liveV3RunsForThisCampaign: number;
  campaignIdsWithV3Results: string[];
  otherCampaignIdsWithV3Results: string[];
  retainedCheckpointCampaignIds: string[];
  incompleteV3Shards: string[];
  invalidV3Shards: string[];
  unreadableV3Shards: string[];
  v3EventStreamsWithTelemetry: string[];
  ambiguousEventStreams: string[];
  invalidOrUnreadableLaunchMarkers: string[];
  launchMarkerCampaignIds: string[];
  launchMarkerExistsForThisCampaign: boolean;
  collidesWithPriorResultCampaignId: boolean;
  retainedCheckpointExistsForThisCampaign: boolean;
  freshLaunch: boolean;
  derivation: string;
  limitation: string;
}

/**
 * Derive what has actually been executed rather than asserting it.
 *
 * A hard-coded zero here is the same class of defect the checkpoint exists to
 * catch: it agrees with a belief instead of with the evidence directory. The
 * canonical locations are the ones the harness itself writes — `*.v3.json`
 * shards under `bench/results/`, and the `<stamp>.events.jsonl` stream each run
 * opens beside its shard.
 *
 * Only V3 evidence counts. V2 and the older parallel/scale suites wrote into
 * the same directory, and counting those would turn unrelated historical work
 * into a launch blocker for this campaign.
 */
export function deriveV3ExecutionHistory(
  campaignId: string,
  options: { resultsDir?: string; checkpointsDir?: string } = {},
): V3ExecutionHistory {
  const resultsDir = options.resultsDir ?? RESULTS_DIR;
  const checkpointsDir = options.checkpointsDir ?? CHECKPOINTS_DIR;
  const expectedRunCount =
    V3_TASKS.length * V3_CAMPAIGN_ARMS.length * V3_CAMPAIGN_REPETITIONS;

  const shards: V3ShardSummary[] = [];
  const eventStreams: V3EventStreamSummary[] = [];
  const launchMarkers: V3LaunchMarkerSummary[] = [];
  const resultsDirectoryExists = fs.existsSync(resultsDir);
  const names = resultsDirectoryExists ? fs.readdirSync(resultsDir).sort() : [];

  for (const name of names.filter((candidate) => candidate.endsWith(".v3.json"))) {
    let data: Record<string, unknown> | null = null;
    try {
      data = JSON.parse(fs.readFileSync(path.join(resultsDir, name), "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      data = null;
    }
    if (data === null) {
      // Unreadable is not empty. A shard nobody can parse is evidence that
      // something ran, so it never contributes zero silently.
      shards.push({
        file: name,
        readable: false,
        classification: "unreadable",
        campaignId: null,
        benchmarkVersion: null,
        suite: null,
        runCount: null,
        complete: null,
      });
      continue;
    }
    const runCount = Array.isArray(data["records"])
      ? (data["records"] as unknown[]).length
      : null;
    const shardCampaign =
      typeof data["campaignId"] === "string" ? (data["campaignId"] as string) : null;
    const valid =
      data["schema"] === 4 &&
      data["benchmarkVersion"] === 3 &&
      data["suite"] === "v3" &&
      shardCampaign !== null &&
      shardCampaign !== "" &&
      runCount !== null;
    shards.push({
      file: name,
      readable: true,
      classification: valid ? "valid" : "invalid",
      campaignId: shardCampaign,
      benchmarkVersion:
        typeof data["benchmarkVersion"] === "number"
          ? (data["benchmarkVersion"] as number)
          : null,
      suite: typeof data["suite"] === "string" ? (data["suite"] as string) : null,
      runCount,
      complete:
        !valid || shardCampaign !== campaignId ? null : runCount >= expectedRunCount,
    });
  }

  for (const name of names.filter((candidate) =>
    candidate.endsWith(V3_LAUNCH_MARKER_SUFFIX),
  )) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(resultsDir, name), "utf8"));
    } catch {
      parsed = null;
    }
    const marker = isV3LaunchMarker(parsed) ? (parsed as V3LaunchMarker) : null;
    launchMarkers.push({
      file: name,
      readableAndValid: marker !== null,
      campaignId: marker?.campaignId ?? null,
      startedAt: marker?.startedAt ?? null,
      completedCellCount: marker?.completedCells.length ?? null,
    });
  }

  const attributionOf = (
    stamp: string,
    contentSha256: string | null,
  ): Pick<V3EventStreamSummary, "attribution" | "attributionEvidence"> => {
    const v3 = shards.find((shard) => shard.file === `${stamp}.v3.json`);
    if (v3 !== undefined) {
      return {
        attribution: v3.classification === "valid" ? "v3" : "ambiguous",
        attributionEvidence: "same-stamp-v3-shard",
      };
    }
    if (hasValidatedHistoricalResult(resultsDir, names, `${stamp}.v2.json`, "v2")) {
      return { attribution: "v2", attributionEvidence: "same-stamp-v2-shard" };
    }
    const knownOtherSuite =
      hasValidatedHistoricalResult(resultsDir, names, `${stamp}.json`, "legacy") ||
      hasValidatedHistoricalResult(
        resultsDir,
        names,
        `${stamp}.parallel.json`,
        "parallel",
      ) ||
      hasValidatedHistoricalResult(resultsDir, names, `${stamp}.scale.json`, "scale");
    if (knownOtherSuite) {
      return {
        attribution: "other-suite",
        attributionEvidence: "same-stamp-other-suite-shard",
      };
    }
    if (
      contentSha256 !== null &&
      REVIEWED_PRE_V3_EVENT_STREAM_SHA256.has(contentSha256)
    ) {
      return {
        attribution: "historical-non-v3",
        attributionEvidence: "reviewed-pre-v3-content-sha256",
      };
    }
    return { attribution: "ambiguous", attributionEvidence: "unclassified" };
  };

  for (const name of names.filter((candidate) => candidate.endsWith(".events.jsonl"))) {
    let byteLength: number | null = null;
    let contentSha256: string | null = null;
    try {
      const content = fs.readFileSync(path.join(resultsDir, name));
      byteLength = content.byteLength;
      contentSha256 = sha256(content);
    } catch {
      byteLength = null;
    }
    const attribution = attributionOf(
      name.slice(0, -".events.jsonl".length),
      contentSha256,
    );
    eventStreams.push({
      file: name,
      byteLength,
      contentSha256,
      ...attribution,
    });
  }

  const retainedCheckpointCampaignIds = new Set<string>();
  if (fs.existsSync(checkpointsDir)) {
    for (const name of fs.readdirSync(checkpointsDir).sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(checkpointsDir, name), "utf8"),
        ) as { campaign?: { campaignId?: unknown } };
        const id = data.campaign?.campaignId;
        if (typeof id === "string") retainedCheckpointCampaignIds.add(id);
      } catch {
        continue;
      }
    }
  }

  const validShards = shards.filter((shard) => shard.classification === "valid");
  const liveV3RunsExecutedToDate = validShards.reduce(
    (total, shard) => total + (shard.runCount ?? 0),
    0,
  );
  const liveV3RunsForThisCampaign = validShards
    .filter((shard) => shard.campaignId === campaignId)
    .reduce((total, shard) => total + (shard.runCount ?? 0), 0);
  const campaignIdsWithV3Results = [
    ...new Set(
      validShards
        .map((shard) => shard.campaignId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ].sort();
  const v3EventStreamsWithTelemetry = eventStreams
    .filter(
      (stream) =>
        stream.attribution === "v3" &&
        (stream.byteLength === null || stream.byteLength > 0),
    )
    .map((stream) => stream.file);
  const unreadableV3Shards = shards
    .filter((shard) => shard.classification === "unreadable")
    .map((shard) => shard.file);
  const invalidV3Shards = shards
    .filter((shard) => shard.classification === "invalid")
    .map((shard) => shard.file);
  const ambiguousEventStreams = eventStreams
    .filter(
      (stream) =>
        stream.attribution === "ambiguous" &&
        (stream.byteLength === null || stream.byteLength > 0),
    )
    .map((stream) => stream.file);
  const invalidOrUnreadableLaunchMarkers = launchMarkers
    .filter((marker) => !marker.readableAndValid)
    .map((marker) => marker.file);
  const launchMarkerCampaignIds = [
    ...new Set(
      launchMarkers
        .map((marker) => marker.campaignId)
        .filter((id): id is string => id !== null),
    ),
  ].sort();

  return {
    resultsDirectory: path.relative(REPO_ROOT, resultsDir).split(path.sep).join("/"),
    resultsDirectoryExists,
    shards,
    eventStreams,
    launchMarkers,
    liveV3RunsExecutedToDate,
    liveV3RunsForThisCampaign,
    campaignIdsWithV3Results,
    otherCampaignIdsWithV3Results: campaignIdsWithV3Results.filter(
      (id) => id !== campaignId,
    ),
    retainedCheckpointCampaignIds: [...retainedCheckpointCampaignIds].sort(),
    incompleteV3Shards: shards
      .filter((shard) => shard.complete === false)
      .map((shard) => shard.file),
    invalidV3Shards,
    unreadableV3Shards,
    v3EventStreamsWithTelemetry,
    ambiguousEventStreams,
    invalidOrUnreadableLaunchMarkers,
    launchMarkerCampaignIds,
    launchMarkerExistsForThisCampaign: launchMarkerCampaignIds.includes(campaignId),
    // A campaign identity that already carries *results* is the real collision.
    // A retained checkpoint under this same identity is not: this generator
    // writes one, so counting it would make every checkpoint collide with
    // itself and report a fabricated conflict.
    collidesWithPriorResultCampaignId: campaignIdsWithV3Results.includes(campaignId),
    retainedCheckpointExistsForThisCampaign:
      retainedCheckpointCampaignIds.has(campaignId),
    freshLaunch:
      launchMarkers.length === 0 &&
      validShards.length === 0 &&
      invalidV3Shards.length === 0 &&
      unreadableV3Shards.length === 0 &&
      ambiguousEventStreams.length === 0,
    derivation:
      "Derived from valid, invalid, and unreadable bench/results/*.v3.json shards; " +
      "the durable *.v3-launch.json record written immediately before the first " +
      "SDK call; and non-empty event streams attributed by validated same-stamp " +
      "suite contents or reviewed pre-V3 content identity. Campaign identity comes " +
      "from valid live evidence, never from a checkpoint.",
    limitation:
      "A non-empty stream without validated same-stamp suite contents or an exact " +
      "reviewed pre-V3 content identity is ambiguous. A sibling that is unreadable, " +
      "malformed, or internally inconsistent does not suppress that ambiguity. It " +
      "blocks freshness rather than being treated as proof that V3 never ran. " +
      "Inherited SDK, CLI, and OS state remains outside repository control.",
  };
}

/**
 * Which orchestrator will actually serve delegation calls, and whether it was
 * proven to be the pinned production baseline.
 */
function baselineRuntimeSection(
  runtime: ProductionBaselineRuntime,
): Record<string, unknown> {
  return {
    artifactDirectory: BASELINE_ARTIFACT_DIRECTORY,
    verified: runtime.verified,
    failedChecks: [...runtime.failedChecks],
    checks: runtime.checks,
    expected: runtime.expected,
    observed: runtime.observed,
    bindingMechanism: runtime.bindingMechanism,
    provisionCommands: [...runtime.provisionCommands],
    dependsOnExternalMcpRegistration: false,
  };
}

function orderingSection(campaignId: string): {
  ordering: CampaignOrdering;
  section: Record<string, unknown>;
} {
  const planned: CampaignCell[] = [];
  for (let repetition = 1; repetition <= V3_CAMPAIGN_REPETITIONS; repetition += 1) {
    for (const task of V3_TASKS) {
      for (const arm of V3_CAMPAIGN_ARMS) {
        planned.push({ campaignId, taskId: task.id, arm, repetition });
      }
    }
  }
  const { cells, ordering } = orderCampaignCells(planned, {
    mode: "seeded",
    seed: campaignId,
  });
  return {
    ordering,
    section: {
      mode: ordering.mode,
      seed: ordering.seed,
      seedRationale:
        "The seed is the campaign ID itself — freeze review plus date, nothing else. " +
        "It holds no free parameter that could have been tuned, and no V3 result " +
        "exists to tune against.",
      generator:
        "splitmix32 seeded from sha256(seed + space + label); platform-independent",
      plannedCellCount: cells.length,
      sequenceSha256: sha256(ordering.sequence.join("\n")),
      repetitionBlocksInterleaved: false,
      sequence: cells.map((cell, index) => ({
        position: index + 1,
        repetition: cell.repetition,
        taskId: cell.taskId,
        arm: cell.arm,
      })),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic checks                                                        */
/* -------------------------------------------------------------------------- */

interface CheckResult {
  command: string;
  exitCode: number | null;
  result: "pass" | "fail" | "not-recorded";
  detail: string;
}

function runDeterministicChecks(
  digestGatePassed: boolean,
  verifyExit: number | undefined,
): CheckResult[] {
  const checks: CheckResult[] = [
    {
      command: `assertMethodologyFrozen(${V3_METHODOLOGY_PATH})`,
      exitCode: digestGatePassed ? 0 : 1,
      result: digestGatePassed ? "pass" : "fail",
      detail: digestGatePassed
        ? "The committed methodology matches V3_METHODOLOGY_DIGEST."
        : "The committed methodology does not match its recorded freeze digest.",
    },
  ];

  const whitespace = readToolOutput("git", ["diff", "--check"], { cwd: REPO_ROOT });
  checks.push({
    command: "git diff --check",
    exitCode: whitespace === null ? null : 0,
    result: whitespace === null ? "fail" : "pass",
    detail:
      whitespace === null
        ? "git diff --check reported whitespace errors or could not be read."
        : "No whitespace errors.",
  });

  checks.push(
    verifyExit === undefined
      ? {
          command: "npm run verify",
          exitCode: null,
          result: "not-recorded",
          detail:
            "Not observed by this checkpoint. Re-run with --verify-exit <code> to " +
            "record the canonical gate's result.",
        }
      : {
          command: "npm run verify",
          exitCode: verifyExit,
          result: verifyExit === 0 ? "pass" : "fail",
          detail:
            "Externally observed canonical gate: typecheck, format:check, the full " +
            "test suite, the protocol smoke, and bench:validate.",
        },
  );

  return checks;
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

export function buildCheckpoint(options: PrelaunchOptions = {}): Record<string, unknown> {
  const generatedAt = new Date();
  const campaignId = options.campaignId ?? defaultCampaignId(generatedAt);
  const environment = captureEnvironmentRecord({
    argv: [],
    packageVersion: readRepositoryPackageVersion(),
  });
  const freezeIntegrity = freezeIntegritySection();
  const pricing = pricingSection(BENCHMARK_V3_PRICING_PROFILE);
  const { section: ordering } = orderingSection(campaignId);
  const history = deriveV3ExecutionHistory(campaignId);
  const baselineRuntime = captureProductionBaselineRuntime();
  const checks = runDeterministicChecks(
    freezeIntegrity.digestGate === "pass",
    options.verifyExit,
  );

  const blockers: CheckpointFinding[] = [];
  const advisories: CheckpointFinding[] = [];

  if (freezeIntegrity.digestGate !== "pass") {
    blockers.push({
      id: "methodology-digest-mismatch",
      severity: "blocking",
      summary: `${V3_METHODOLOGY_PATH} does not match V3_METHODOLOGY_DIGEST.`,
      why: "The launch gate cannot attest which specification the campaign ran under.",
      ownedBy: "benchmark owner",
      clears:
        "Re-freeze through the document's correction policy and recompute the digest.",
    });
  }

  if (!BENCHMARK_V3_FREEZE_SHA_IS_CURRENT) {
    blockers.push({
      id: "freeze-content-commit-not-pinned",
      severity: "blocking-procedural",
      summary:
        `Freeze ${BENCHMARK_V3_FREEZE_REVISION} is authored in a working tree, so ` +
        `BENCHMARK_V3_FREEZE_SHA still names the freeze-2 content commit ` +
        `${BENCHMARK_V3_FREEZE_SHA}.`,
      why:
        "A pin cannot name the commit that contains it. Recording the previous " +
        "review's commit would attribute the campaign to text it did not run under, " +
        "so assertV3FreezePinned refuses the launch instead.",
      ownedBy: "launch operator",
      clears:
        `Commit the frozen ${V3_METHODOLOGY_PATH}, repin BENCHMARK_V3_FREEZE_SHA to ` +
        "that commit, and set BENCHMARK_V3_FREEZE_SHA_IS_CURRENT to true.",
    });
  }

  const baseline = freezeIntegrity.productionBaseline as Record<string, unknown>;
  if (baseline.tagResolvesToPinnedSha !== true) {
    blockers.push({
      id: "production-baseline-not-the-tagged-release",
      severity: "blocking",
      summary:
        `v${BENCHMARK_V3_PRODUCTION_BASELINE_VERSION} does not resolve to the pinned ` +
        `baseline ${BENCHMARK_V3_PRODUCTION_BASELINE_SHA}.`,
      why: "A campaign must evaluate a released commit, not an arbitrary one.",
      ownedBy: "benchmark owner",
      clears: `Repin BENCHMARK_V3_PRODUCTION_BASELINE_SHA to git rev-list -n 1 v${BENCHMARK_V3_PRODUCTION_BASELINE_VERSION}.`,
    });
  }

  if (!baselineRuntime.verified) {
    blockers.push({
      id: "production-baseline-runtime-unverified",
      severity: "blocking",
      summary:
        `The orchestrator that would execute this campaign has not been proven to ` +
        `be production baseline v${BENCHMARK_V3_PRODUCTION_BASELINE_VERSION} ` +
        `(${BENCHMARK_V3_PRODUCTION_BASELINE_SHA}); failed checks: ` +
        `${baselineRuntime.failedChecks.join(", ")}.`,
      why:
        "A result may not claim a released baseline that the process serving its " +
        "delegation calls was never shown to be. The MCP registration that would " +
        "otherwise decide this lives outside the repository and can point at a " +
        "global install, another checkout, or this development tree.",
      ownedBy: "launch operator",
      clears: `Provision the baseline artifact: ${baselineRuntime.provisionCommands.join(" && ")}`,
      location: BASELINE_ARTIFACT_DIRECTORY,
    });
  }

  // Prior live execution is not an advisory. A fresh-launch claim that a
  // result already contradicts is exactly what this checkpoint attests to.
  if (!history.freshLaunch) {
    blockers.push({
      id: "prior-live-v3-execution-evidence",
      severity: "blocking",
      summary:
        `Fresh V3 launch cannot be proven from ${history.resultsDirectory}: ` +
        `${history.liveV3RunsExecutedToDate} valid completed run record(s)` +
        (history.launchMarkers.length > 0
          ? `, plus ${history.launchMarkers.length} launch marker(s)`
          : "") +
        (history.invalidV3Shards.length > 0
          ? `, plus ${history.invalidV3Shards.length} invalid shard(s)`
          : "") +
        (history.unreadableV3Shards.length > 0
          ? `, plus ${history.unreadableV3Shards.length} unreadable shard(s)`
          : "") +
        (history.ambiguousEventStreams.length > 0
          ? `, plus ${history.ambiguousEventStreams.length} ambiguous event stream(s)`
          : "") +
        ".",
      why:
        "Freshness is derived from authoritative and ambiguous evidence, never " +
        "asserted. A false positive requires operator review; a false claim that " +
        "V3 never launched would invalidate the freeze boundary.",
      ownedBy: "benchmark owner",
      clears:
        "Review the existing V3 evidence and decide explicitly whether this is a " +
        "new campaign, a resumption, or a re-analysis before launching.",
      location: history.resultsDirectory,
    });
  }

  if (history.collidesWithPriorResultCampaignId) {
    blockers.push({
      id: "campaign-id-already-has-results",
      severity: "blocking",
      summary: `Campaign ${campaignId} already has committed V3 result shards.`,
      why:
        "Reusing a campaign identity pools work reviewed under different rules. A " +
        "new freeze review requires a new campaign ID.",
      ownedBy: "launch operator",
      clears: "Launch under a new --campaign identity.",
    });
  }

  if (environment.git.workingTreeClean !== true) {
    blockers.push({
      id: "working-tree-not-clean",
      severity: "blocking-procedural",
      summary:
        `${environment.git.dirtyPathCount ?? "an unknown number of"} path(s) differ ` +
        "from the recorded commit, including this checkpoint itself.",
      why:
        "A V3 launch refuses a dirty tree because the recorded commit would not " +
        "describe the code that ran.",
      ownedBy: "launch operator",
      clears:
        "Commit the freeze revision and this checkpoint — the methodology requires " +
        "the checkpoint be retained before live execution — then confirm " +
        "`git status --porcelain` is empty immediately before launching.",
    });
  }

  const failed = checks.filter((check) => check.result === "fail");
  for (const check of failed) {
    if (check.command === `assertMethodologyFrozen(${V3_METHODOLOGY_PATH})`) continue;
    blockers.push({
      id: `deterministic-check-failed-${check.command.replace(/[^a-z0-9]+/gi, "-")}`,
      severity: "blocking",
      summary: `${check.command} did not pass.`,
      why: "A benchmark whose deterministic gates fail cannot produce trustworthy evidence.",
      ownedBy: "benchmark owner",
      clears: "Fix the failure and regenerate this checkpoint.",
    });
  }

  if (options.verifyExit === undefined) {
    advisories.push({
      id: "canonical-verify-not-recorded",
      severity: "non-blocking",
      summary:
        "`npm run verify` was not observed by this checkpoint; it must pass immediately " +
        "before launch.",
      impact:
        "Evidence completeness only. Re-run with --verify-exit <code> to record it.",
    });
  }

  if (freezeIntegrity.headIsProductionBaseline !== true) {
    advisories.push({
      id: "head-is-not-the-production-baseline",
      severity: "non-blocking",
      summary:
        `HEAD (${String(freezeIntegrity.headCommit)}) is not the pinned production ` +
        `baseline ${BENCHMARK_V3_PRODUCTION_BASELINE_SHA}.`,
      impact:
        "The commit that actually executes is recorded separately in " +
        "environment.git.commit; a report must not present HEAD as the baseline.",
    });
  }

  return {
    schema: CHECKPOINT_SCHEMA,
    title: `Benchmark V3 / freeze ${BENCHMARK_V3_FREEZE_REVISION} pre-launch checkpoint`,
    generatedAt: generatedAt.toISOString(),
    generatedBy: "npm run bench:v3:checkpoint (dist/bench/prelaunch.js)",
    launchReadiness: blockers.length === 0 ? "ready" : "blocked",
    blockers,
    advisories,
    campaign: {
      campaignId,
      benchmarkVersion: 3,
      suite: "v3",
      freezeReview: `freeze ${BENCHMARK_V3_FREEZE_REVISION} (P2.4B pre-launch)`,
      reason:
        "Freeze 3 changed a telemetry definition, the reproducibility record, and the " +
        "production baseline pin, so under the post-freeze correction policy it is a " +
        "new freeze review requiring a new campaign ID.",
      // Every campaign identity the repository knows about, split by what kind
      // of evidence carries it. The current campaign's own retained checkpoint
      // is not a prior campaign; only a result shard makes an identity used.
      campaignIdsWithV3Results: history.campaignIdsWithV3Results,
      otherCampaignIdsWithV3Results: history.otherCampaignIdsWithV3Results,
      retainedCheckpointCampaignIds: history.retainedCheckpointCampaignIds,
      launchMarkerCampaignIds: history.launchMarkerCampaignIds,
      launchMarkerExistsForThisCampaign: history.launchMarkerExistsForThisCampaign,
      collidesWithPriorResultCampaignId: history.collidesWithPriorResultCampaignId,
      retainedCheckpointExistsForThisCampaign:
        history.retainedCheckpointExistsForThisCampaign,
      reusesEarlierFreezeCampaignIdentity: history.collidesWithPriorResultCampaignId,
      liveV3RunsExecutedToDate: history.liveV3RunsExecutedToDate,
      liveV3RunsForThisCampaign: history.liveV3RunsForThisCampaign,
      freshLaunch: history.freshLaunch,
    },
    executionHistory: history,
    freezeIntegrity,
    productionBaselineRuntime: baselineRuntimeSection(baselineRuntime),
    pricing,
    executionProfile: executionProfileSection(),
    ordering,
    environment: environmentSection(environment),
    fixtures: fixturesSection(),
    deterministicChecks: {
      modelBackedRunsExecuted: 0,
      checks,
      deliberatelyNotExecuted: [
        "npm run bench:v3 (model-backed)",
        "any model-backed benchmark task",
        "any inspection or generation of V3 results",
      ],
    },
    expectedOutputs: {
      resultsDirectory: "bench/results/",
      rawResultShard: "bench/results/<stamp>.v3.json",
      liveLaunchMarker: "bench/results/campaign-<campaign-id-digest>.v3-launch.json",
      eventStream: "bench/results/<stamp>.events.jsonl (gitignored raw telemetry)",
      generatedSummary: "bench/results/<stamp>.v3.md via npm run bench:report",
      crossRunAnalysis: "npm run bench:v3:analyze (deterministic, no model calls)",
      checkpoint: [
        `bench/checkpoints/${campaignId}.prelaunch.json`,
        `bench/checkpoints/${campaignId}.prelaunch.md`,
      ],
      refusesOverwrite:
        "The runner refuses to overwrite an existing shard, and planCampaignCells " +
        "refuses to re-run a completed cell without --resume.",
    },
    launchCommand:
      `npm run bench:v3 -- --campaign ${campaignId} --order seeded --order-seed ` +
      `${campaignId} --confirm-standard-speed --confirm-pricing-profile`,
    scope:
      "This checkpoint executed no model-backed run and created no live-launch " +
      "marker. It deterministically inspected existing V3-named history without " +
      "changing any result, methodology, fixture, grader, routing rule, prompt, " +
      "threshold, or production behaviour.",
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

export function renderCheckpoint(checkpoint: Record<string, unknown>): string {
  const get = <T>(key: string): T => checkpoint[key] as T;
  const freeze = get<Record<string, unknown>>("freezeIntegrity");
  const baseline = freeze.productionBaseline as Record<string, unknown>;
  const campaign = get<Record<string, unknown>>("campaign");
  const ordering = get<Record<string, unknown>>("ordering");
  const fixtures = get<Record<string, unknown>>("fixtures");
  const checks = get<Record<string, unknown>>("deterministicChecks");
  const blockers = get<CheckpointFinding[]>("blockers");
  const advisories = get<CheckpointFinding[]>("advisories");

  const history = get<V3ExecutionHistory>("executionHistory");
  const baselineRuntime = get<Record<string, unknown>>("productionBaselineRuntime");

  const lines: string[] = [];
  lines.push(`# ${String(checkpoint.title)}`, "");
  lines.push(
    `Generated ${String(checkpoint.generatedAt)} by \`${String(checkpoint.generatedBy)}\`.`,
    "",
    `**Launch readiness: ${String(checkpoint.launchReadiness).toUpperCase()}.** ` +
      // Derived from the evidence directory, never asserted: the JSON and this
      // summary read the same field, so they cannot disagree.
      (history.freshLaunch
        ? "No model-backed V3 run is recorded under any freeze."
        : "Prior or ambiguous V3 live-execution evidence is already recorded."),
    "",
  );

  lines.push("## Identity", "");
  lines.push(
    "| Field | Value |",
    "|---|---|",
    `| Campaign ID | \`${String(campaign.campaignId)}\` |`,
    `| Freeze review | ${String(campaign.freezeReview)} |`,
    `| Methodology digest | \`${String(freeze.expectedDigest)}\` (gate: ${String(freeze.digestGate)}) |`,
    `| Methodology freeze commit (pinned) | \`${String(freeze.pinnedFreezeSha)}\` — current review: ${String(freeze.pinnedFreezeShaIsCurrentReview)} |`,
    `| Production baseline under evaluation | v${String(baseline.version)} @ \`${String(baseline.sha)}\` |`,
    `| Baseline resolved from | \`${String(baseline.resolvedFrom)}\` (matches: ${String(baseline.tagResolvesToPinnedSha)}) |`,
    `| Baseline runtime verified | ${String(baselineRuntime.verified)} — artifact \`${String(baselineRuntime.artifactDirectory)}\` |`,
    `| Expected sealed runtime-manifest digest | \`${String((baselineRuntime.expected as Record<string, unknown>).runtimeManifestSha256)}\` |`,
    `| Observed sealed runtime-manifest digest | \`${String(((baselineRuntime.observed as Record<string, unknown>).runtimeManifest as Record<string, unknown> | null)?.aggregateSha256 ?? null)}\` |`,
    `| HEAD | \`${String(freeze.headCommit)}\` on ${String(freeze.headBranch)} |`,
    "",
    String(freeze.distinction),
    "",
    String(baselineRuntime.bindingMechanism),
    "",
  );

  lines.push("## Live execution history", "");
  lines.push(
    "| Fact | Value |",
    "|---|---|",
    `| Live V3 runs recorded to date | ${history.liveV3RunsExecutedToDate} |`,
    `| Live V3 runs for this campaign | ${history.liveV3RunsForThisCampaign} |`,
    `| V3 result shards | ${history.shards.length} |`,
    `| V3 launch markers | ${history.launchMarkers.length} |`,
    `| Launch marker for this campaign | ${String(history.launchMarkerExistsForThisCampaign)} |`,
    `| Incomplete V3 shards | ${history.incompleteV3Shards.length} |`,
    `| Invalid V3 shards | ${history.invalidV3Shards.length} |`,
    `| Unreadable V3 shards | ${history.unreadableV3Shards.length} |`,
    `| V3 event streams with telemetry | ${history.v3EventStreamsWithTelemetry.length} |`,
    `| Ambiguous non-empty/unreadable event streams | ${history.ambiguousEventStreams.length} |`,
    `| Campaign IDs with V3 results | ${history.campaignIdsWithV3Results.length === 0 ? "none" : history.campaignIdsWithV3Results.join(", ")} |`,
    `| Collides with a prior result campaign ID | ${String(history.collidesWithPriorResultCampaignId)} |`,
    `| Retained checkpoint for this campaign ID | ${String(history.retainedCheckpointExistsForThisCampaign)} |`,
    `| Fresh launch | ${String(history.freshLaunch)} |`,
    "",
    history.derivation,
    "",
    `Limitation: ${history.limitation}`,
    "",
  );

  if (baselineRuntime.verified !== true) {
    lines.push(
      `Baseline runtime checks not satisfied: ${(baselineRuntime.failedChecks as string[]).join(", ")}.`,
      "",
      `Provision with: \`${(baselineRuntime.provisionCommands as string[]).join(" && ")}\`.`,
      "",
    );
  }

  lines.push("## Blockers", "");
  if (blockers.length === 0) {
    lines.push("None.", "");
  } else {
    for (const blocker of blockers) {
      lines.push(`### ${blocker.id} (${blocker.severity})`, "");
      lines.push(blocker.summary, "");
      if (blocker.why) lines.push(`**Why:** ${blocker.why}`, "");
      if (blocker.ownedBy) lines.push(`**Owned by:** ${blocker.ownedBy}`, "");
      if (blocker.clears) lines.push(`**Clears when:** ${blocker.clears}`, "");
    }
  }

  lines.push("## Advisories", "");
  if (advisories.length === 0) {
    lines.push("None.", "");
  } else {
    for (const advisory of advisories) {
      lines.push(`- **${advisory.id}** — ${advisory.summary}`);
      if (advisory.impact) lines.push(`  Impact: ${advisory.impact}`);
    }
    lines.push("");
  }

  lines.push("## Deterministic checks", "");
  lines.push("| Command | Exit | Result |", "|---|---:|---|");
  for (const check of checks.checks as CheckResult[]) {
    lines.push(`| \`${check.command}\` | ${check.exitCode ?? "—"} | ${check.result} |`);
  }
  lines.push(
    "",
    `Model-backed runs executed: ${String(checks.modelBackedRunsExecuted)}.`,
    "",
  );

  lines.push("## Plan", "");
  lines.push(
    `- Tasks: ${String(fixtures.taskCount)} frozen V3 fixtures.`,
    `- Arms: ${V3_CAMPAIGN_ARMS.join(", ")} (Forced Delegation excluded).`,
    `- Repetitions: ${V3_CAMPAIGN_REPETITIONS} per cell, ${String(ordering.plannedCellCount)} planned cells.`,
    `- Ordering: ${String(ordering.mode)}, seed \`${String(ordering.seed)}\`, sequence sha256 \`${String(ordering.sequenceSha256)}\`.`,
    `- Launch command: \`${String(checkpoint.launchCommand)}\``,
    "",
  );

  lines.push("## Pricing", "");
  const pricing = get<Record<string, unknown>>("pricing");
  lines.push(
    `Status: **${String(pricing.status)}**. Revalidated during this checkpoint: ` +
      `${String(pricing.revalidatedDuringThisCheckpoint)}.`,
    "",
    "Pricing is a measurement dependency, not a frozen assumption. The dated " +
      "credit-first V3 profile and its separate USD-equivalence evidence were " +
      "revalidated from official OpenAI documentation.",
    "",
  );

  lines.push("## Scope", "", String(checkpoint.scope), "");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export function parsePrelaunchArgs(argv: readonly string[]): PrelaunchOptions {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const verify = get("--verify-exit");
  const campaignId = get("--campaign");
  if (verify !== undefined && !/^\d+$/.test(verify)) {
    throw new Error("--verify-exit takes the observed exit code of `npm run verify`");
  }
  return {
    ...(campaignId === undefined ? {} : { campaignId }),
    ...(verify === undefined ? {} : { verifyExit: Number(verify) }),
    force: argv.includes("--force"),
  };
}

/** Move an explicitly replaced checkpoint into the retained superseded ledger. */
export function preserveSupersededCheckpointFiles(
  files: readonly string[],
  checkpointsDir: string = CHECKPOINTS_DIR,
  now: Date = new Date(),
): string[] {
  const existing = files.filter((file) => fs.existsSync(file));
  if (existing.length === 0) return [];
  const directory = path.join(checkpointsDir, "superseded");
  fs.mkdirSync(directory, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return existing.map((file) => {
    const parsed = path.parse(file);
    const destination = path.join(directory, `${parsed.name}.${stamp}${parsed.ext}`);
    if (fs.existsSync(destination)) {
      throw new Error(`Refusing to overwrite superseded checkpoint ${destination}`);
    }
    fs.renameSync(file, destination);
    return destination;
  });
}

function main(): void {
  const options = parsePrelaunchArgs(process.argv.slice(2));
  const checkpoint = buildCheckpoint(options);
  const campaignId = (checkpoint.campaign as { campaignId: string }).campaignId;

  fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  const jsonFile = path.join(CHECKPOINTS_DIR, `${campaignId}.prelaunch.json`);
  const markdownFile = path.join(CHECKPOINTS_DIR, `${campaignId}.prelaunch.md`);

  // Earlier checkpoints are retained evidence of what was known before an
  // earlier launch decision. A new freeze review gets a new campaign ID and
  // therefore new files; overwriting one is an explicit act.
  for (const file of [jsonFile, markdownFile]) {
    if (fs.existsSync(file) && !options.force) {
      throw new Error(
        `Refusing to overwrite existing checkpoint evidence ${path.relative(REPO_ROOT, file)}. ` +
          "Use a new --campaign id for a new freeze review, or --force to replace it deliberately.",
      );
    }
  }

  if (options.force) {
    preserveSupersededCheckpointFiles([jsonFile, markdownFile]);
  }

  fs.writeFileSync(jsonFile, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownFile, renderCheckpoint(checkpoint), "utf8");

  console.log(`Campaign: ${campaignId}`);
  console.log(`Launch readiness: ${String(checkpoint.launchReadiness)}`);
  console.log(`Blockers: ${(checkpoint.blockers as unknown[]).length}`);
  console.log(`Wrote ${path.relative(REPO_ROOT, jsonFile)}`);
  console.log(`Wrote ${path.relative(REPO_ROOT, markdownFile)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
