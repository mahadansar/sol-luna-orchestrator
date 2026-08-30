/** Combine committed benchmark result files without making model calls. */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  assertCampaignCompatibility,
  campaignCompatibilityFromShard,
  collectCompletedCampaignCells,
  type LoadedCampaignShard,
} from "./campaign.js";
import { V3_LAUNCH_MARKER_SUFFIX } from "./launch.js";
import { renderReport, type ResultsFile } from "./report.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(HERE, "..", "..", "bench", "results");

const reproducibilityFields = [
  "environment",
  "ordering",
  "methodologyDigest",
  "retryPolicy",
] as const satisfies readonly (keyof ResultsFile)[];

function combineReproducibilityMetadata(
  matching: readonly { file: string; data: ResultsFile }[],
): Pick<ResultsFile, (typeof reproducibilityFields)[number]> {
  const metadata: Record<string, unknown> = {};
  for (const field of reproducibilityFields) {
    const first = matching.find(({ data }) => data[field] !== undefined);
    if (!first) continue;
    for (const candidate of matching) {
      if (
        candidate.data[field] !== undefined &&
        !isDeepStrictEqual(candidate.data[field], first.data[field])
      ) {
        throw new Error(
          `Campaign shard ${path.basename(candidate.file)} has incompatible ${field}`,
        );
      }
    }
    metadata[field] = first.data[field];
  }
  return metadata as Pick<ResultsFile, (typeof reproducibilityFields)[number]>;
}

export function loadCampaign(
  directory: string,
  benchmarkVersion: 2 | 3,
  campaignId?: string,
): ResultsFile {
  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.endsWith(V3_LAUNCH_MARKER_SUFFIX))
    .sort();
  const candidates = files.map((name) => ({
    file: name,
    data: JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as ResultsFile,
  }));
  const resultSuffix = `.v${benchmarkVersion}.json`;
  for (const candidate of candidates.filter(({ file }) => file.endsWith(resultSuffix))) {
    const shard = candidate as LoadedCampaignShard;
    const compatibility = campaignCompatibilityFromShard(shard);
    if (compatibility.benchmarkVersion !== benchmarkVersion) {
      throw new Error(
        `Campaign shard ${path.basename(candidate.file)} has incompatible benchmarkVersion`,
      );
    }
    assertCampaignCompatibility([shard], compatibility);
  }
  const matching = candidates
    .filter(({ data }) =>
      campaignId === undefined
        ? data.benchmarkVersion === benchmarkVersion
        : data.campaignId === campaignId,
    )
    .filter(({ data }) => data.benchmarkVersion === benchmarkVersion);
  if (matching.length === 0) {
    throw new Error(`No Benchmark V${benchmarkVersion} result files in ${directory}`);
  }
  const campaignIds = new Set(matching.map(({ data }) => data.campaignId ?? "missing"));
  if (campaignIds.size !== 1 || campaignIds.has("missing")) {
    throw new Error(
      `Select one campaign with --campaign; found: ${[...campaignIds].join(", ")}`,
    );
  }
  const shards = matching as LoadedCampaignShard[];
  const compatibility = campaignCompatibilityFromShard(shards[0]!);
  assertCampaignCompatibility(shards, compatibility);
  const reproducibilityMetadata = combineReproducibilityMetadata(matching);
  collectCompletedCampaignCells(shards, [...campaignIds][0]!);
  return {
    schema: 4,
    benchmarkVersion,
    suite: `v${benchmarkVersion}-campaign`,
    supervisorModel: matching[0]!.data.supervisorModel,
    supervisorEffort: matching[0]!.data.supervisorEffort,
    executionProfile: matching[0]!.data.executionProfile,
    pricingProfile: matching[0]!.data.pricingProfile,
    campaignId: matching[0]!.data.campaignId,
    holdoutFreezeSha: matching[0]!.data.holdoutFreezeSha,
    productionBaseline: matching[0]!.data.productionBaseline,
    ...reproducibilityMetadata,
    reps: Math.max(
      ...matching.flatMap(({ data }) => data.records.map((record) => record.repetition)),
    ),
    records: matching.flatMap(({ data }) => data.records),
  };
}

export const loadV2Campaign = (directory: string, campaignId?: string): ResultsFile =>
  loadCampaign(directory, 2, campaignId);

export const loadV3Campaign = (directory: string, campaignId?: string): ResultsFile =>
  loadCampaign(directory, 3, campaignId);

function main(): void {
  const argv = process.argv.slice(2);
  const outputIndex = argv.indexOf("--output");
  const campaignIndex = argv.indexOf("--campaign");
  const versionIndex = argv.indexOf("--version");
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !output) throw new Error("--output requires a path");
  if (campaignIndex >= 0 && !argv[campaignIndex + 1]) {
    throw new Error("--campaign requires an id");
  }
  const versionValue = versionIndex >= 0 ? argv[versionIndex + 1] : "2";
  if (versionValue !== "2" && versionValue !== "3") {
    throw new Error("--version requires 2 or 3");
  }
  const benchmarkVersion = Number(versionValue) as 2 | 3;
  const directoryArgument = argv.find(
    (argument, index) =>
      !argument.startsWith("--") &&
      index !== outputIndex + 1 &&
      index !== campaignIndex + 1 &&
      index !== versionIndex + 1,
  );
  const directory = path.resolve(directoryArgument ?? DEFAULT_DIR);
  const campaign = loadCampaign(
    directory,
    benchmarkVersion,
    campaignIndex >= 0 ? argv[campaignIndex + 1] : undefined,
  );
  const report = renderReport(campaign, {
    sourceName: `combined Benchmark V${benchmarkVersion} JSON`,
  });
  if (output) {
    const target = path.resolve(output);
    fs.writeFileSync(target, `${report}\n`, "utf8");
    console.error(`Wrote ${target}`);
  } else {
    console.log(report);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
