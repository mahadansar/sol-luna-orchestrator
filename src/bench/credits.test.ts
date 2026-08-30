import assert from "node:assert/strict";
import test from "node:test";
import {
  BENCHMARK_V2_PRICING_PROFILE,
  BENCHMARK_V2_PRICING_PROFILE_ID,
  BENCHMARK_V2_PRICING_SNAPSHOT_DATE,
  BENCHMARK_V2_PRICING_SOURCE_URL,
  BENCHMARK_V3_PRICING_EVIDENCE,
  BENCHMARK_V3_PRICING_PROFILE,
  BENCHMARK_V3_PRICING_PROFILE_ID,
  calculateBenchmarkCredits,
  calculateModelCredits,
  copyPricingProfile,
  createBenchmarkCreditRecord,
} from "./credits.js";

test("the V2 profile is an immutable dated official rate-card snapshot", () => {
  assert.equal(BENCHMARK_V2_PRICING_PROFILE.profileId, BENCHMARK_V2_PRICING_PROFILE_ID);
  assert.equal(BENCHMARK_V2_PRICING_PROFILE.sourceUrl, BENCHMARK_V2_PRICING_SOURCE_URL);
  assert.equal(
    BENCHMARK_V2_PRICING_SOURCE_URL,
    "https://help.openai.com/en/articles/20001106",
  );
  assert.match(BENCHMARK_V2_PRICING_PROFILE_ID, /chatgpt-plus/);
  assert.equal(
    BENCHMARK_V2_PRICING_PROFILE.snapshotDate,
    BENCHMARK_V2_PRICING_SNAPSHOT_DATE,
  );
  assert.equal(BENCHMARK_V2_PRICING_PROFILE.units, "credits-per-1m-tokens");
  assert.match(BENCHMARK_V2_PRICING_PROFILE.applicability, /ChatGPT Plus/);
  assert.equal(BENCHMARK_V2_PRICING_PROFILE.promotionalTerms, null);
  assert.deepEqual(BENCHMARK_V2_PRICING_PROFILE.rates["gpt-5.6-sol"], {
    input: 125,
    cachedInput: 12.5,
    output: 750,
    cacheWrite: 0,
  });
  assert.deepEqual(BENCHMARK_V2_PRICING_PROFILE.rates["gpt-5.6-luna"], {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    cacheWrite: 0,
  });
  assert.ok(Object.isFrozen(BENCHMARK_V2_PRICING_PROFILE));
  assert.ok(Object.isFrozen(BENCHMARK_V2_PRICING_PROFILE.rates));
});

test("the V3 profile is a separate current ChatGPT Work / Codex credit snapshot", () => {
  assert.notEqual(BENCHMARK_V3_PRICING_PROFILE, BENCHMARK_V2_PRICING_PROFILE);
  assert.equal(BENCHMARK_V3_PRICING_PROFILE.profileId, BENCHMARK_V3_PRICING_PROFILE_ID);
  assert.equal(BENCHMARK_V3_PRICING_PROFILE.snapshotDate, "2026-08-30");
  assert.match(BENCHMARK_V3_PRICING_PROFILE.applicability, /ChatGPT Work \/ Codex/);
  assert.match(BENCHMARK_V3_PRICING_PROFILE.applicability, /excludes.*API-key/i);
  assert.match(BENCHMARK_V3_PRICING_PROFILE.promotionalTerms ?? "", /2026-11-21/);
  assert.deepEqual(BENCHMARK_V3_PRICING_PROFILE.rates["gpt-5.6-sol"], {
    input: 100,
    cachedInput: 10,
    output: 500,
    cacheWrite: 0,
  });
  assert.deepEqual(BENCHMARK_V3_PRICING_PROFILE.rates["gpt-5.6-luna"], {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    cacheWrite: 0,
  });
  assert.deepEqual(BENCHMARK_V3_PRICING_EVIDENCE.equivalentUsdPer1mTokens, {
    "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
    "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  });
  assert.match(BENCHMARK_V3_PRICING_EVIDENCE.accountingBasis, /credits.*primary/i);
  assert.match(BENCHMARK_V3_PRICING_EVIDENCE.cacheWriteSemantics, /1\.25x/);
  assert.ok(Object.isFrozen(BENCHMARK_V3_PRICING_PROFILE));
  assert.ok(Object.isFrozen(BENCHMARK_V3_PRICING_EVIDENCE));
});

test("normal Sol calculation uses input, cached input, and output rates", () => {
  assert.equal(
    calculateModelCredits("gpt-5.6-sol", {
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      outputTokens: 200_000,
      reasoningOutputTokens: 50_000,
    }),
    263.75,
  );
});

test("cached input is charged separately and cache writes are free", () => {
  const oneMillion = {
    inputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheWriteInputTokens: 9_000_000,
  };
  assert.equal(calculateModelCredits("gpt-5.6-luna", oneMillion), 30.5);
  assert.equal(calculateModelCredits("gpt-5.6-sol", oneMillion), 762.5);
  assert.equal(
    calculateModelCredits("gpt-5.6-sol", oneMillion, BENCHMARK_V3_PRICING_PROFILE),
    510,
  );
});

test("reasoning output is diagnostic and is not double-counted", () => {
  const withoutReasoning = calculateModelCredits("gpt-5.6-luna", {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 1_000_000,
  });
  const withReasoning = calculateModelCredits("gpt-5.6-luna", {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 1_000_000,
    reasoningOutputTokens: 900_000,
  });
  assert.equal(withoutReasoning, 30);
  assert.equal(withReasoning, withoutReasoning);
});

test("historical records retain a copied versioned profile", () => {
  const source = copyPricingProfile(BENCHMARK_V2_PRICING_PROFILE);
  const record = createBenchmarkCreditRecord(
    {
      model: "gpt-5.6-luna",
      usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
    },
    source,
  );
  assert.notEqual(record.pricingProfile, source);
  assert.equal(record.pricingProfile.profileId, BENCHMARK_V2_PRICING_PROFILE_ID);
  assert.ok(Object.isFrozen(record.pricingProfile));
  assert.notEqual(record.pricingProfile.rates, source.rates);
  assert.equal(record.pricingProfile.rates["gpt-5.6-luna"].input, 5);
});

test("missing fields and unknown models remain unavailable", () => {
  assert.equal(
    calculateModelCredits("gpt-5.6-sol", {
      inputTokens: 100,
      cachedInputTokens: 10,
    }),
    null,
  );
  assert.equal(
    calculateModelCredits("unknown-model", {
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 10,
    }),
    null,
  );
  const summary = calculateBenchmarkCredits([
    { model: "gpt-5.6-sol", usage: { inputTokens: 100, cachedInputTokens: 0 } },
  ]);
  assert.equal(summary.totalRateCardCredits, null);
  assert.equal(summary.perModel[0]?.rateCardCredits, null);
});

test("summary exposes per-model and total estimates while actual credits stay separate", () => {
  const summary = calculateBenchmarkCredits(
    [
      {
        model: "gpt-5.6-sol",
        usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
        actualCredits: 7,
      },
      {
        model: "gpt-5.6-luna",
        usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 },
        actualCredits: 8,
      },
    ],
    { actualCredits: 99 },
  );
  assert.equal(
    summary.perModel.find((item) => item.model === "gpt-5.6-sol")?.rateCardCredits,
    125,
  );
  assert.equal(
    summary.perModel.find((item) => item.model === "gpt-5.6-luna")?.estimatedCredits,
    5,
  );
  assert.equal(summary.totalRateCardCredits, 130);
  assert.equal(summary.totalEstimatedCredits, 130);
  assert.equal(summary.actualCredits, 99);
  assert.equal(summary.records[0]?.actualCredits, 7);
  assert.equal(summary.records[1]?.actualCredits, 8);
});
