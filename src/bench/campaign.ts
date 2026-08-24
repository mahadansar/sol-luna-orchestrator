/** Interruption-safe planning for schema-4 Benchmark V2 campaign shards. */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CreditPricingProfile } from "./credits.js";

export interface CampaignCompatibility {
  schema: 4;
  benchmarkVersion: 2;
  suite: "v2";
  supervisorModel: string;
  supervisorEffort: "medium";
  pricingProfile: CreditPricingProfile;
  executionProfile: Readonly<Record<string, unknown>>;
}

export interface CampaignCell {
  campaignId: string;
  taskId: string;
  arm: string;
  repetition: number;
}

export interface CampaignShardRecord {
  taskId: string;
  arm: string;
  repetition: number;
  passed?: boolean;
}

export interface CampaignShard extends Partial<CampaignCompatibility> {
  campaignId?: string;
  records?: CampaignShardRecord[];
}

export interface LoadedCampaignShard {
  file: string;
  data: CampaignShard;
}

export interface CampaignPlan {
  planned: CampaignCell[];
  completed: CampaignCell[];
  remaining: CampaignCell[];
  resume: boolean;
}

export const benchmarkCellKey = (cell: CampaignCell): string =>
  JSON.stringify([cell.campaignId, cell.taskId, cell.arm, cell.repetition]);

export function campaignCompatibilityFromShard(
  shard: LoadedCampaignShard,
): CampaignCompatibility {
  const data = shard.data;
  if (
    data.schema !== 4 ||
    data.benchmarkVersion !== 2 ||
    data.suite !== "v2" ||
    typeof data.supervisorModel !== "string" ||
    data.supervisorEffort !== "medium" ||
    !data.pricingProfile ||
    typeof data.pricingProfile !== "object" ||
    !data.executionProfile ||
    typeof data.executionProfile !== "object"
  ) {
    throw new Error(
      `Campaign shard ${path.basename(shard.file)} has incomplete schema-4 compatibility metadata`,
    );
  }
  return {
    schema: data.schema,
    benchmarkVersion: data.benchmarkVersion,
    suite: data.suite,
    supervisorModel: data.supervisorModel,
    supervisorEffort: data.supervisorEffort,
    pricingProfile: data.pricingProfile,
    executionProfile: data.executionProfile,
  };
}

export function readCampaignShards(
  directory: string,
  campaignId: string,
): LoadedCampaignShard[] {
  if (!fs.existsSync(directory)) return [];
  const shards: LoadedCampaignShard[] = [];
  for (const name of fs
    .readdirSync(directory)
    .filter((candidate) => candidate.endsWith(".json"))
    .sort()) {
    const file = path.join(directory, name);
    let data: CampaignShard;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8")) as CampaignShard;
    } catch (error) {
      if (name.endsWith(".v2.json")) {
        throw new Error(
          `Cannot inspect Benchmark V2 shard ${name}: ${(error as Error).message}`,
        );
      }
      continue;
    }
    if (data.campaignId === campaignId) shards.push({ file, data });
  }
  return shards;
}

export function assertCampaignCompatibility(
  shards: readonly LoadedCampaignShard[],
  expected: CampaignCompatibility,
): void {
  const fields: Array<keyof CampaignCompatibility> = [
    "schema",
    "benchmarkVersion",
    "suite",
    "supervisorModel",
    "supervisorEffort",
    "pricingProfile",
    "executionProfile",
  ];
  for (const shard of shards) {
    for (const field of fields) {
      if (!isDeepStrictEqual(shard.data[field], expected[field])) {
        throw new Error(
          `Campaign shard ${path.basename(shard.file)} has incompatible ${field}`,
        );
      }
    }
    if (!Array.isArray(shard.data.records)) {
      throw new Error(`Campaign shard ${path.basename(shard.file)} has no records array`);
    }
  }
}

export function collectCompletedCampaignCells(
  shards: readonly LoadedCampaignShard[],
  campaignId: string,
): CampaignCell[] {
  const completed: CampaignCell[] = [];
  const owners = new Map<string, string>();
  for (const shard of shards) {
    for (const record of shard.data.records ?? []) {
      if (
        typeof record.taskId !== "string" ||
        !record.taskId ||
        typeof record.arm !== "string" ||
        !record.arm ||
        !Number.isInteger(record.repetition) ||
        record.repetition < 1
      ) {
        throw new Error(
          `Campaign shard ${path.basename(shard.file)} contains an invalid benchmark cell identity`,
        );
      }
      const cell: CampaignCell = {
        campaignId,
        taskId: record.taskId,
        arm: record.arm,
        repetition: record.repetition,
      };
      const key = benchmarkCellKey(cell);
      const previous = owners.get(key);
      if (previous) {
        throw new Error(
          `Duplicate existing benchmark cell ${cell.taskId}/${cell.arm}/rep-${cell.repetition} in ${previous} and ${path.basename(shard.file)}`,
        );
      }
      owners.set(key, path.basename(shard.file));
      completed.push(cell);
    }
  }
  return completed;
}

export function planCampaignCells(options: {
  planned: readonly CampaignCell[];
  completed: readonly CampaignCell[];
  resume: boolean;
}): CampaignPlan {
  const planned = [...options.planned];
  const plannedKeys = new Set<string>();
  for (const cell of planned) {
    const key = benchmarkCellKey(cell);
    if (plannedKeys.has(key)) {
      throw new Error(
        `Duplicate planned benchmark cell ${cell.taskId}/${cell.arm}/rep-${cell.repetition}`,
      );
    }
    plannedKeys.add(key);
  }
  const completedKeys = new Set(options.completed.map(benchmarkCellKey));
  const alreadyCompleted = planned.filter((cell) =>
    completedKeys.has(benchmarkCellKey(cell)),
  );
  if (!options.resume && alreadyCompleted.length > 0) {
    const first = alreadyCompleted[0]!;
    throw new Error(
      `Selected benchmark cells already exist, including ${first.taskId}/${first.arm}/rep-${first.repetition}. Re-run with --resume to preserve and skip completed evidence.`,
    );
  }
  return {
    planned,
    completed: alreadyCompleted,
    remaining: options.resume
      ? planned.filter((cell) => !completedKeys.has(benchmarkCellKey(cell)))
      : planned,
    resume: options.resume,
  };
}
