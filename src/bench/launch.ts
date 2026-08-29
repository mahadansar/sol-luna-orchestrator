/** Durable evidence that a live Benchmark V3 campaign reached its first SDK call. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CampaignCell } from "./campaign.js";

export const V3_LAUNCH_MARKER_SCHEMA = "sol-luna/bench/v3-launch@1" as const;
export const V3_LAUNCH_MARKER_SUFFIX = ".v3-launch.json" as const;

export interface V3LaunchMarker {
  readonly schema: typeof V3_LAUNCH_MARKER_SCHEMA;
  readonly benchmarkVersion: 3;
  readonly suite: "v3";
  readonly campaignId: string;
  readonly methodologyDigest: string;
  readonly holdoutFreezeSha: string;
  readonly productionBaseline: {
    readonly version: string;
    readonly sha: string;
    readonly runtimeManifestSha256: string;
  };
  readonly startedAt: string;
  readonly state: "started";
  readonly completedCells: ReadonlyArray<CampaignCell & { readonly completedAt: string }>;
}

export interface V3LaunchIdentity {
  readonly campaignId: string;
  readonly methodologyDigest: string;
  readonly holdoutFreezeSha: string;
  readonly productionBaseline: V3LaunchMarker["productionBaseline"];
}

const sha256 = (text: string): string =>
  crypto.createHash("sha256").update(text, "utf8").digest("hex");

export const v3LaunchMarkerFilename = (campaignId: string): string =>
  `campaign-${sha256(campaignId).slice(0, 24)}${V3_LAUNCH_MARKER_SUFFIX}`;

export const v3LaunchMarkerPath = (resultsDir: string, campaignId: string): string =>
  path.join(resultsDir, v3LaunchMarkerFilename(campaignId));

export function isV3LaunchMarker(value: unknown): value is V3LaunchMarker {
  if (value === null || typeof value !== "object") return false;
  const marker = value as Record<string, unknown>;
  const baseline = marker["productionBaseline"];
  return (
    marker["schema"] === V3_LAUNCH_MARKER_SCHEMA &&
    marker["benchmarkVersion"] === 3 &&
    marker["suite"] === "v3" &&
    typeof marker["campaignId"] === "string" &&
    marker["campaignId"] !== "" &&
    typeof marker["methodologyDigest"] === "string" &&
    typeof marker["holdoutFreezeSha"] === "string" &&
    typeof marker["startedAt"] === "string" &&
    marker["state"] === "started" &&
    Array.isArray(marker["completedCells"]) &&
    baseline !== null &&
    typeof baseline === "object" &&
    typeof (baseline as Record<string, unknown>)["version"] === "string" &&
    typeof (baseline as Record<string, unknown>)["sha"] === "string" &&
    typeof (baseline as Record<string, unknown>)["runtimeManifestSha256"] === "string"
  );
}

export function readV3LaunchMarker(file: string): V3LaunchMarker | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return isV3LaunchMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const sameIdentity = (marker: V3LaunchMarker, identity: V3LaunchIdentity): boolean =>
  marker.campaignId === identity.campaignId &&
  marker.methodologyDigest === identity.methodologyDigest &&
  marker.holdoutFreezeSha === identity.holdoutFreezeSha &&
  marker.productionBaseline.version === identity.productionBaseline.version &&
  marker.productionBaseline.sha === identity.productionBaseline.sha &&
  marker.productionBaseline.runtimeManifestSha256 ===
    identity.productionBaseline.runtimeManifestSha256;

/**
 * Called by the live runner immediately before its first model-backed SDK call.
 * Deterministic validation, baseline provisioning, and checkpoint generation do
 * not call this function and therefore cannot create launch evidence.
 */
export function createV3LaunchMarker(
  resultsDir: string,
  identity: V3LaunchIdentity,
  options: { resume: boolean; now?: Date } = { resume: false },
): V3LaunchMarker {
  const file = v3LaunchMarkerPath(resultsDir, identity.campaignId);
  if (fs.existsSync(file)) {
    const existing = readV3LaunchMarker(file);
    if (existing === null) {
      throw new Error(`Existing V3 launch marker is invalid or unreadable: ${file}`);
    }
    if (!sameIdentity(existing, identity)) {
      throw new Error(`Existing V3 launch marker has incompatible provenance: ${file}`);
    }
    if (!options.resume) {
      throw new Error(
        `Campaign ${identity.campaignId} was already launched; use the reviewed ` +
          "resume path rather than claiming a fresh launch",
      );
    }
    return existing;
  }

  const marker: V3LaunchMarker = {
    schema: V3_LAUNCH_MARKER_SCHEMA,
    benchmarkVersion: 3,
    suite: "v3",
    campaignId: identity.campaignId,
    methodologyDigest: identity.methodologyDigest,
    holdoutFreezeSha: identity.holdoutFreezeSha,
    productionBaseline: { ...identity.productionBaseline },
    startedAt: (options.now ?? new Date()).toISOString(),
    state: "started",
    completedCells: [],
  };
  fs.writeFileSync(file, JSON.stringify(marker, null, 2) + "\n", {
    encoding: "utf8",
    flag: "wx",
    flush: true,
  });
  return marker;
}

/** Atomically add one accepted cell while preserving the original start evidence. */
export function recordV3LaunchCompletedCell(
  resultsDir: string,
  marker: V3LaunchMarker,
  cell: CampaignCell,
  now: Date = new Date(),
): V3LaunchMarker {
  const file = v3LaunchMarkerPath(resultsDir, marker.campaignId);
  const current = readV3LaunchMarker(file);
  if (current === null || !sameIdentity(current, marker)) {
    throw new Error(`Cannot update invalid or replaced V3 launch marker: ${file}`);
  }
  const key = (candidate: CampaignCell): string =>
    `${candidate.campaignId}\0${candidate.taskId}\0${candidate.arm}\0${candidate.repetition}`;
  const completedCells = current.completedCells.some(
    (candidate) => key(candidate) === key(cell),
  )
    ? [...current.completedCells]
    : [...current.completedCells, { ...cell, completedAt: now.toISOString() }];
  const updated: V3LaunchMarker = { ...current, completedCells };
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, JSON.stringify(updated, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      flush: true,
    });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return updated;
}
