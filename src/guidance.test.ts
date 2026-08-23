/**
 * Semantic synchronization tests for supervisor guidance.
 *
 * Runtime strings are the always-exposed policy. SOL_RULES.md is the optional
 * human reference. These assertions pin distinctions, not paragraphs.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_TOOL_DESCRIPTION,
  CONTINUE_TOOL_DESCRIPTION,
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTION,
} from "./server.js";
import { LUNA_MODEL, MAX_BATCH_SIZE, MAX_PARALLEL } from "./config.js";
import {
  delegateTaskInputSchema,
  delegateTaskInputShape,
  delegateTaskOutputShape,
  delegateTasksInputSchema,
  delegateTasksInputShape,
} from "./contract.js";
import { buildWorkerPrompt } from "./prompt.js";
import { DISCOVERY_HINT_TEXT } from "./cli/discovery-hint.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readDoc = (name: string): Promise<string> =>
  fs.readFile(path.join(ROOT_DIR, name), "utf8");

const BASE_INPUT = {
  objective: "Complete one bounded executable task safely.",
  effortReason: "The task needs routine judgement in one area.",
  acceptanceCriteria: ["The requested behavior is present."],
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const assertSilentWaitGuidance = (guidance: string): void => {
  assert.match(guidance, /remain silent/i);
  assert.match(guidance, /no meaningful new state/i);
  assert.match(guidance, /do not\s+narrate/i);
  for (const reportable of [
    "results?",
    "errors?",
    "cancellations?",
    "timeouts?",
    "actionable state changes?",
  ]) {
    assert.match(guidance, new RegExp(reportable, "i"));
  }
};

test("backwards-compatible guidance fields retain their API defaults", () => {
  const parsed = delegateTaskInputSchema.parse(BASE_INPUT);
  assert.equal(parsed.resultDetail, "full");
  assert.equal(parsed.contextCapsule, undefined);
  assert.equal(parsed.activityLabel, undefined);
  assert.equal(parsed.automaticRepair, false);
});

test("activityLabel is optional, concise, and bounded", () => {
  const parsed = delegateTaskInputSchema.parse({
    ...BASE_INPUT,
    activityLabel: "Update auth retries",
  });
  assert.equal(parsed.activityLabel, "Update auth retries");
  assert.throws(() =>
    delegateTaskInputSchema.parse({
      ...BASE_INPUT,
      activityLabel: "x".repeat(81),
    }),
  );
  assert.match(
    delegateTaskInputShape.activityLabel.description ?? "",
    /optional concise label/i,
  );
  assert.match(
    delegateTaskInputShape.activityLabel.description ?? "",
    /persisted locally/i,
  );
});

test("server instructions keep roles, evidence authority, and proportional review", () => {
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /Sol supervises/i);
  assert.match(SERVER_INSTRUCTIONS, /Sol-Luna Orchestrator/i);
  assert.match(SERVER_INSTRUCTIONS, /compatible parent Codex model/i);
  assert.match(SERVER_INSTRUCTIONS, /parent supervisor owns/i);
  assert.match(SERVER_INSTRUCTIONS, /workers execute bounded tasks/i);
  assert.match(SERVER_INSTRUCTIONS, /delegation is adaptive/i);
  assert.match(SERVER_INSTRUCTIONS, /zero workers is valid/i);
  assert.match(SERVER_INSTRUCTIONS, /raw tokens are not credit cost/i);
  assert.match(SERVER_INSTRUCTIONS, /selected parent model is priced above/i);
  assert.match(SERVER_INSTRUCTIONS, /current[\s\S]*pricing schedule/i);
  assert.match(
    SERVER_INSTRUCTIONS,
    /more workers are not automatically better or cheaper/i,
  );
  assert.match(SERVER_INSTRUCTIONS, /claims are not orchestrator evidence/i);
  assert.match(SERVER_INSTRUCTIONS, /proportion/i);
  assertSilentWaitGuidance(SERVER_INSTRUCTIONS);
  assert.match(
    SERVER_INSTRUCTIONS,
    /do not narrate polling, waiting, elapsed time, or that it is still running/i,
  );
  assert.match(
    SERVER_INSTRUCTIONS,
    /result, error, cancellation, timeout, or actionable state change/i,
  );
});

test("one substantial bounded task may be delegated without another seam", () => {
  assert.match(TOOL_DESCRIPTION, /ONE substantial, bounded/i);
  assert.match(TOOL_DESCRIPTION, /does not need a second independent seam/i);
  assert.match(TOOL_DESCRIPTION, /small,[\s\S]*simple,[\s\S]*tightly coupled/i);
  assert.match(TOOL_DESCRIPTION, /overhead/i);
  assert.match(TOOL_DESCRIPTION, /optionally provide a useful concise activityLabel/i);
});

test("single-task guidance is cost-aware without treating pricing as permanent", () => {
  assert.doesNotMatch(TOOL_DESCRIPTION, /\b\d+(?:\.\d+)?x\s+cheaper\b/i);
  assert.doesNotMatch(TOOL_DESCRIPTION, /gpt-5\.6-sol/i);
  assert.doesNotMatch(TOOL_DESCRIPTION, /Sol tokens/i);
  assert.match(TOOL_DESCRIPTION, /raw token count is not credit cost/i);
  assert.match(
    TOOL_DESCRIPTION,
    new RegExp(
      `selected parent model is priced above\\s+${escapeRegExp(LUNA_MODEL)}` +
        `[\\s\\S]*current pricing\\s+schedule`,
      "i",
    ),
  );
  assert.match(TOOL_DESCRIPTION, /fewer total credits/i);
  assert.match(TOOL_DESCRIPTION, /depends on which parent model is in use/i);
  assert.match(TOOL_DESCRIPTION, /not an architectural guarantee/i);
  assert.match(TOOL_DESCRIPTION, /not a measured saving/i);
  assert.match(TOOL_DESCRIPTION, /More workers is not\s+automatically\s+cheaper/i);
  for (const factor of [
    "credit cost",
    "latency",
    "context",
    "overhead",
    "verification",
    "isolation",
    "coordination risk",
    "quality",
  ]) {
    assert.match(TOOL_DESCRIPTION, new RegExp(factor, "i"));
  }
});

test("single and batch tool guidance require silent waiting", () => {
  assertSilentWaitGuidance(TOOL_DESCRIPTION);
  assertSilentWaitGuidance(BATCH_TOOL_DESCRIPTION);
  assertSilentWaitGuidance(CONTINUE_TOOL_DESCRIPTION);
});

test("continuation guidance keeps the contract fixed and bounded", () => {
  assert.match(CONTINUE_TOOL_DESCRIPTION, /same Luna Codex thread/i);
  assert.match(CONTINUE_TOOL_DESCRIPTION, /opaque/i);
  assert.match(CONTINUE_TOOL_DESCRIPTION, /single-use/i);
  assert.match(
    CONTINUE_TOOL_DESCRIPTION,
    /original objective, allowedFiles, forbiddenFiles, changeIntent/i,
  );
  assert.match(CONTINUE_TOOL_DESCRIPTION, /no[\s\S]*widening fields/i);
  assert.match(
    CONTINUE_TOOL_DESCRIPTION,
    /verification[\s\S]*scope checks[\s\S]*evidence reconciliation/i,
  );
  assert.match(CONTINUE_TOOL_DESCRIPTION, /never starts an automatic repair/i);
});

test("bounded repair guidance and schemas keep parent control and the one-turn limit", async () => {
  assert.match(TOOL_DESCRIPTION, /automaticRepair/i);
  assert.match(TOOL_DESCRIPTION, /at most one repair/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /automaticRepair/i);
  assert.match(SERVER_INSTRUCTIONS, /same-thread automatic repair/i);
  assert.match(
    delegateTaskInputShape.automaticRepair.description ?? "",
    /same worker thread and immutable task contract/i,
  );
  assert.equal(delegateTaskInputSchema.parse(BASE_INPUT).automaticRepair, false);
  assert.equal(
    delegateTasksInputSchema.parse({ mode: "sequential", tasks: [BASE_INPUT] }).tasks[0]
      ?.automaticRepair,
    false,
  );
  assert.match(delegateTaskOutputShape.repair.description ?? "", /failure evidence/i);

  const rules = await readDoc("SOL_RULES.md");
  assert.match(rules, /exactly one[\s\S]*same-thread repair/i);
  assert.match(rules, /Manual[\s\S]*continue_task[\s\S]*never chains into repair/i);
});

test("delegation remains broader than implementation", () => {
  for (const kind of [
    "implementation",
    "tests",
    "bug fixing",
    "refactoring",
    "investigation",
    "chores",
  ]) {
    assert.match(TOOL_DESCRIPTION, new RegExp(kind, "i"));
  }
  const prompt = buildWorkerPrompt(delegateTaskInputSchema.parse(BASE_INPUT), ROOT_DIR);
  assert.doesNotMatch(prompt, /implementation worker/i);
  assert.match(prompt, /bounded execution worker/i);
});

test("the parent orchestrator retains strategy and final judgment", () => {
  for (const retained of [
    "architecture",
    "decomposition",
    "unresolved design",
    "sequencing",
    "final judgement",
  ]) {
    assert.match(TOOL_DESCRIPTION, new RegExp(retained, "i"));
  }
  assert.match(TOOL_DESCRIPTION, /cannot see the\s+conversation or[\s\S]*delegate/i);
});

test("single-task results drive risk-based review", () => {
  for (const evidence of [
    "verdict",
    "verification",
    "observed files",
    "discrepancies",
    "scope\\s+violations",
    "review checklist",
  ]) {
    assert.match(TOOL_DESCRIPTION, new RegExp(evidence, "i"));
  }
  assert.match(TOOL_DESCRIPTION, /clean\s+verified PASS/i);
  assert.match(TOOL_DESCRIPTION, /proportionate\s+review/i);
  assert.match(TOOL_DESCRIPTION, /Choose review depth after seeing that evidence/i);
  assert.match(TOOL_DESCRIPTION, /do not pre-commit to rereading every file/i);
  for (const suspicious of [
    "FAILED",
    "BLOCKED",
    "trustworthy: false",
    "discrepancies",
    "scope\\s+violations",
  ]) {
    assert.match(TOOL_DESCRIPTION, new RegExp(suspicious, "i"));
  }
});

test("batch guidance distinguishes sequential and parallel semantics", () => {
  assert.match(BATCH_TOOL_DESCRIPTION, /intended for two or more tasks/i);
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /one-task batch remains accepted for[\s\S]*compatibility/i,
  );
  assert.match(BATCH_TOOL_DESCRIPTION, /prefer delegate_task for a single task/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /sequential[\s\S]*depend/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /share\s+workspace\s+state/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /parallel[\s\S]*genuinely independent/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /disjoint declared scopes/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /does not guarantee/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /Do not create artificial seams/i);
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    new RegExp(`at most ${MAX_BATCH_SIZE} tasks`, "i"),
  );
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    new RegExp(`at most ${MAX_PARALLEL} at once`, "i"),
  );
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /batch size is not the number of[\s\S]*simultaneous workers/i,
  );
  assert.match(BATCH_TOOL_DESCRIPTION, /queues the rest/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /remainder as a second batch/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /raw tokens are not credit cost/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /selected parent model is priced above/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /current[\s\S]*pricing[\s\S]*schedule/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /fewer total credits/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /parent-conditional/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /not guaranteed or measured/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /batch size and task mix affect the economics/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /coordination and review[\s\S]*increase/i);
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /parallel execution may reduce latency[\s\S]*not automatically cheaper than sequential/i,
  );
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /more workers[\s\S]*not[\s\S]*automatically cheaper/i,
  );
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /allowOverlappingScopes:true[\s\S]*call-level escape hatch/i,
  );
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /does not turn scopes into a write sandbox[\s\S]*same-file edits still[\s\S]*prevent automatic integration/i,
  );
  assert.doesNotMatch(
    BATCH_TOOL_DESCRIPTION,
    new RegExp(
      `${MAX_BATCH_SIZE}[^.]{0,40}(?:simultaneous|concurrent|workers at once)`,
      "i",
    ),
  );
});

test("batch guidance states integration and partial-outcome behavior", () => {
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /same-file edits prevent automatic[\s\S]*integration/i,
  );
  assert.match(BATCH_TOOL_DESCRIPTION, /FAILED or BLOCKED/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /verified in isolation/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /when changes can meaningfully interact/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /merely because[\s\S]*parallel/i);
});

test("resultDetail pins compact preference and full compatibility default", () => {
  const text = delegateTaskInputShape.resultDetail.description ?? "";
  assert.match(text, /compact routinely/i);
  assert.match(text, /only successful verification output/i);
  assert.match(text, /schema default remains full[\s\S]*backwards compatibility/i);
  for (const retained of ["failed", "refused", "skipped"]) {
    assert.match(text, new RegExp(retained, "i"));
  }
});

test("plain and structured context are complementary and bounded", () => {
  const plain = delegateTaskInputShape.context.description ?? "";
  const capsule = delegateTaskInputShape.contextCapsule.description ?? "";
  assert.match(plain, /Legacy plain-text/i);
  assert.match(plain, /both are sent/i);
  assert.match(capsule, /supplements[\s\S]*legacy context/i);
  assert.match(capsule, /omit empty/i);
  assert.match(capsule, /never copy the parent transcript/i);
  assert.match(capsule, /do not duplicate/i);
});

test("verification fields preserve authority without treating non-execution as proof", () => {
  const input = delegateTaskInputShape.verificationCommands.description ?? "";
  const row = delegateTaskOutputShape.verification.element;
  const source = row.shape.source.description ?? "";
  const execution = row.shape.execution.description ?? "";
  assert.match(input, /configured policy/i);
  assert.match(input, /Targeted deterministic checks/i);
  assert.match(input, /full suite[\s\S]*genuinely requires/i);
  assert.match(input, /executed orchestrator rows are authoritative/i);
  assert.match(input, /refused or skipped rows prove nothing/i);
  assert.match(source, /Orchestrator rows authoritatively record/i);
  assert.match(source, /worker rows are self-reported/i);
  assert.match(execution, /rejected/);
  assert.match(execution, /skipped/);
  assert.match(execution, /Only successful executed rows prove a command/i);
});

test("scope, discrepancy, and checklist descriptions demand review", () => {
  assert.match(delegateTaskOutputShape.scopeViolations.description ?? "", /workspace/i);
  assert.match(
    delegateTaskOutputShape.scopeViolations.description ?? "",
    /deeper review/i,
  );
  assert.match(delegateTaskOutputShape.discrepancies.description ?? "", /do not accept/i);
  assert.match(
    delegateTaskOutputShape.reviewChecklist.description ?? "",
    /parent orchestrator/i,
  );
});

test("batch input descriptions qualify overlap and integration", () => {
  assert.match(
    delegateTasksInputShape.mode.description ?? "",
    /sequential[\s\S]*dependent/i,
  );
  assert.match(
    delegateTasksInputShape.mode.description ?? "",
    /parallel[\s\S]*isolated/i,
  );
  assert.match(
    delegateTasksInputShape.allowOverlappingScopes.description ?? "",
    /call-level escape hatch[\s\S]*same-file edits[\s\S]*prevent automatic integration/i,
  );
  assert.match(
    delegateTasksInputShape.resultDetail.description ?? "",
    /batch-level[\s\S]*uniformly[\s\S]*not a per-task field/i,
  );
  assert.match(
    delegateTasksInputShape.tasks.description ?? "",
    /one-task batch remains accepted for compatibility/i,
  );
  assert.match(delegateTasksInputShape.integrate.description ?? "", /Set false/i);
  const task = delegateTasksInputSchema.shape.tasks.element;
  assert.ok("activityLabel" in task.shape);
  assert.match(
    delegateTasksInputShape.tasks.description ?? "",
    new RegExp(`at most ${MAX_BATCH_SIZE} tasks`, "i"),
  );
  assert.match(
    delegateTasksInputShape.tasks.description ?? "",
    new RegExp(`at most ${MAX_PARALLEL} workers`, "i"),
  );
  assert.match(
    delegateTasksInputShape.tasks.description ?? "",
    /batch size is not concurrency/i,
  );
  assert.match(delegateTasksInputShape.tasks.description ?? "", /queues the rest/i);
  const maximumTasks = Array.from({ length: MAX_BATCH_SIZE }, () => BASE_INPUT);
  const tooManyTasks = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => BASE_INPUT);
  assert.doesNotThrow(() =>
    delegateTasksInputSchema.parse({ mode: "sequential", tasks: maximumTasks }),
  );
  assert.throws(() =>
    delegateTasksInputSchema.parse({ mode: "sequential", tasks: tooManyTasks }),
  );
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /optionally give each task a useful concise activityLabel/i,
  );
});

test("parent model and effort guidance stays example-only across surfaces", async () => {
  const [readme, rules, configuration, example] = await Promise.all([
    readDoc("README.md"),
    readDoc("SOL_RULES.md"),
    readDoc("docs/CONFIGURATION.md"),
    readDoc("examples/codex-config.toml"),
  ]);
  assert.match(readme, /any compatible parent model/i);
  assert.match(readme, /creator\s+examples?/i);
  const parentSection = configuration.slice(
    configuration.indexOf("## Parent model and effort"),
    configuration.indexOf("## Platform support"),
  );
  assert.doesNotMatch(parentSection, /\brecommended\b/i);
  assert.match(parentSection, /creator's usual setting/i);
  assert.match(parentSection, /high[\s\S]*heavier work/i);
  for (const document of [readme, rules, configuration, example]) {
    assert.doesNotMatch(document, /high[^\n]{0,80}recommended/i);
    assert.doesNotMatch(document, /recommended[^\n]{0,80}high/i);
  }
  for (const category of ["REQUIRED", "DEFAULT", "OPTIONAL", "EXAMPLE"]) {
    assert.match(example, new RegExp(`\\b${category}:`, "i"));
  }
  assert.match(example, /model_reasoning_effort\s*=\s*"medium"/i);
  assert.match(example, /creator session choices, not requirements or recommendations/i);
  assert.match(example, /any compatible parent model and reasoning effort may be used/i);
  assert.doesNotMatch(example, /\bRECOMMENDED\b/i);

  const rulesCost = rules.slice(
    rules.indexOf("## Cost and parallelism"),
    rules.indexOf("## Worker effort"),
  );
  assert.match(rulesCost, /raw token[s\s\S]*not credit cost/i);
  assert.match(
    rulesCost,
    /only when[\s\S]*(?:selected parent(?: model)?|parent you picked)[\s\S]*priced above[\s\S]*worker[\s\S]*(?:current|applicable)[\s\S]*(?:pricing )?schedule/i,
  );
  assert.match(rulesCost, /no (?:cost )?saving has been\s+measured/i);
  assert.match(readme, /Raw tokens are not billed[\s\S]*no cost saving is claimed/i);
  assert.match(readme, /docs\/CONFIGURATION\.md#cost/i);
});

test("SOL_RULES carries the runtime's operational distinctions without benchmark narration", async () => {
  const rules = await readDoc("SOL_RULES.md");
  for (const invariant of [
    /Zero workers is valid/i,
    /No second seam is required/i,
    /raw tokens[\s\S]*credit cost/i,
    /not an\s+immutable architectural\s+guarantee/i,
    /more workers are not[\s\S]*automatically[\s\S]*cheaper/i,
    /schema default remains[\s\S]*full/i,
    /trustworthy: false/i,
    /Do not automatically rerun a full suite/i,
    /has no meaningful new state,[\s\S]*remain silent/i,
    /do not narrate polling,[\s\S]*waiting,[\s\S]*elapsed time/i,
    /normally leave broader final validation to the parent/i,
    /do not pre-commit to rereading[\s\S]*every changed file/i,
    /empty `allowedFiles` means no in-workspace allowlist/i,
    /does not[\s\S]*declare read-only intent/i,
    /changeIntent[\s\S]*forbidden[\s\S]*optional[\s\S]*required/i,
    /omitted[\s\S]*defaults to `required`/i,
    /forbidden[\s\S]*runtime-observed edit[\s\S]*contract violation/i,
    /batch-level choice applied uniformly/i,
    /call-level `allowOverlappingScopes: true`[\s\S]*escape hatch/i,
    /actual same-file[\s\S]*edits still prevent[\s\S]*integration/i,
    /2026-08-23[\s\S]*API[\s\S]*25:1[\s\S]*purchased credits[\s\S]*20:1[\s\S]*16\.7:1/i,
  ]) {
    assert.match(rules, invariant);
  }
  assert.doesNotMatch(rules, /2\.3x|3\.5x|V6|around 70 seconds|four and six/i);
});

test("landing page links to authoritative operational guidance", async () => {
  const [readme, rules, discovery] = await Promise.all([
    readDoc("README.md"),
    readDoc("SOL_RULES.md"),
    readDoc("docs/DELEGATION_DISCOVERY.md"),
  ]);
  assert.doesNotMatch(
    readme,
    /told\s+to\s+run\s+the\s+full\s+suite\s+after\s+integration/i,
  );
  assert.match(readme, /SOL_RULES\.md/);
  assert.match(readme, /Delegation Discovery/);
  assert.match(
    discovery.replace(/^>\s?/gm, ""),
    new RegExp(escapeRegExp(DISCOVERY_HINT_TEXT).replaceAll(" ", "\\s+")),
  );
  assert.match(
    rules,
    /batch contract accepts one task for compatibility[\s\S]*use `delegate_task`/i,
  );
  assert.match(
    rules,
    /changeIntent[\s\S]*forbidden[\s\S]*optional[\s\S]*required[\s\S]*defaults to `required`/i,
  );
  assert.match(rules, /allowOverlappingScopes: true[\s\S]*actual same-file edits/i);
  assert.match(rules, /active Sol-Luna tool call[\s\S]*no meaningful new state/i);
  assert.match(rules, /remain silent/i);
  assert.match(rules, /do not[\s\S]*narrat[\s\S]*(?:polling|waiting|elapsed time)/i);
  for (const reportable of [
    "results?",
    "errors?",
    "cancellations?",
    "timeouts?",
    "actionable state changes?",
  ]) {
    assert.match(rules, new RegExp(reportable, "i"));
  }
});

test("human pricing example is dated and distinct from durable runtime policy", async () => {
  const configuration = await readDoc("docs/CONFIGURATION.md");
  const roadmap = await readDoc("ROADMAP.md");
  assert.match(
    configuration,
    /2026-08-23[\s\S]*Codex[\s\S]*100\/10\/500[\s\S]*5\/0\.5\/30[\s\S]*20:1[\s\S]*16\.7:1[\s\S]*promotional[\s\S]*2026-11-21[\s\S]*API[\s\S]*25:1/i,
  );
  assert.match(
    configuration,
    /Sol at \$5\/\$0\.50\/\$30[\s\S]*Luna at[\s\S]*\$0\.20\/\$0\.02\/\$1\.20/i,
  );
  assert.match(
    configuration,
    /promotion does not change included plan usage,[\s\S]*5-hour[\s\S]*weekly limits,[\s\S]*legacy credit rates/i,
  );
  assert.match(
    configuration,
    /API prices[\s\S]*Codex\s+credit rates[\s\S]*not interchangeable/i,
  );
  assert.match(
    configuration,
    /promotion is a temporary rate card[\s\S]*underlying contexts[\s\S]*not a billing context/i,
  );
  assert.match(
    configuration,
    /aggregate task token usage[\s\S]*selected[\s\S]*parent[\s\S]*worker count[\s\S]*coordination and[\s\S]*review overhead[\s\S]*latency[\s\S]*quality[\s\S]*realised task[\s\S]*cost/i,
  );
  assert.match(configuration, /legacy[\s\S]*rate card/i);
  assert.match(
    configuration,
    /Purchased-credit rates do not describe every included Plus or Pro task/i,
  );
  assert.match(
    roadmap,
    /P0\.2a[\s\S]*Implemented in the working tree[\s\S]*changeIntent[\s\S]*forbidden[\s\S]*optional[\s\S]*required[\s\S]*task category[\s\S]*`allowedFiles: \[\]`/i,
  );
  assert.doesNotMatch(
    [SERVER_INSTRUCTIONS, TOOL_DESCRIPTION, BATCH_TOOL_DESCRIPTION].join("\n"),
    /\$\s*\d|\b\d+(?:\.\d+)?\s*(?:x|:1)\b/i,
  );
});
