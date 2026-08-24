/** Combine committed Benchmark V2 result files without making model calls. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCampaignCompatibility,
  campaignCompatibilityFromShard,
  collectCompletedCampaignCells,
  type LoadedCampaignShard,
} from "./campaign.js";
import { renderReport, type ResultsFile } from "./report.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(HERE, "..", "..", "bench", "results");

export function loadV2Campaign(directory: string, campaignId?: string): ResultsFile {
  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const v2 = files
    .map((name) => ({
      file: name,
      data: JSON.parse(
        fs.readFileSync(path.join(directory, name), "utf8"),
      ) as ResultsFile,
    }))
    .filter(({ data }) =>
      campaignId === undefined
        ? data.schema === 4 || data.benchmarkVersion === 2
        : data.campaignId === campaignId,
    );
  if (v2.length === 0) throw new Error(`No Benchmark V2 result files in ${directory}`);
  const campaignIds = new Set(v2.map(({ data }) => data.campaignId ?? "missing"));
  if (campaignIds.size !== 1 || campaignIds.has("missing")) {
    throw new Error(
      `Select one campaign with --campaign; found: ${[...campaignIds].join(", ")}`,
    );
  }
  const shards = v2 as LoadedCampaignShard[];
  const compatibility = campaignCompatibilityFromShard(shards[0]!);
  assertCampaignCompatibility(shards, compatibility);
  collectCompletedCampaignCells(shards, [...campaignIds][0]!);
  return {
    schema: 4,
    benchmarkVersion: 2,
    suite: "v2-campaign",
    supervisorModel: v2[0]!.data.supervisorModel,
    supervisorEffort: v2[0]!.data.supervisorEffort,
    executionProfile: v2[0]!.data.executionProfile,
    pricingProfile: v2[0]!.data.pricingProfile,
    campaignId: v2[0]!.data.campaignId,
    reps: 2,
    records: v2.flatMap(({ data }) => data.records),
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const outputIndex = argv.indexOf("--output");
  const campaignIndex = argv.indexOf("--campaign");
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !output) throw new Error("--output requires a path");
  if (campaignIndex >= 0 && !argv[campaignIndex + 1]) {
    throw new Error("--campaign requires an id");
  }
  const directoryArgument = argv.find(
    (argument, index) =>
      !argument.startsWith("--") &&
      index !== outputIndex + 1 &&
      index !== campaignIndex + 1,
  );
  const directory = path.resolve(directoryArgument ?? DEFAULT_DIR);
  const campaign = loadV2Campaign(
    directory,
    campaignIndex >= 0 ? argv[campaignIndex + 1] : undefined,
  );
  const report = renderReport(campaign, {
    sourceName: "combined Benchmark V2 JSON",
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
