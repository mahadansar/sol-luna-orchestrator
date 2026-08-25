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
import { z } from "zod";
import {
  BATCH_TOOL_DESCRIPTION,
  CONTINUE_TOOL_DESCRIPTION,
  METADATA_SIZE_BUDGETS,
  metadataSizeReport,
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTION,
} from "./server.js";
import { LUNA_MODEL, MAX_BATCH_SIZE, MAX_PARALLEL } from "./config.js";
import {
  continueTaskInputSchema,
  continueTaskMcpInputShape,
  delegateTaskMcpInputShape,
  delegateTaskInputSchema,
  delegateTaskInputShape,
  delegateTaskOutputShape,
  delegateTasksMcpInputShape,
  delegateTasksInputSchema,
  delegateTasksInputShape,
  delegateTasksOutputShape,
  INPUT_METADATA_SIZE_BUDGETS,
  inputMetadataSizeReport,
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

test("guidance fields retain their documented API defaults", () => {
  const parsed = delegateTaskInputSchema.parse(BASE_INPUT);
  assert.equal(parsed.resultDetail, "handoff");
  assert.equal(parsed.contextCapsule, undefined);
  assert.equal(parsed.activityLabel, undefined);
  assert.equal(parsed.automaticRepair, false);
});

test("thin metadata stays within deterministic budgets", () => {
  const report = metadataSizeReport();
  assert.ok(report.serverInstructions <= METADATA_SIZE_BUDGETS.serverInstructions);
  assert.ok(
    report.delegateTaskDescription <= METADATA_SIZE_BUDGETS.delegateTaskDescription,
  );
  assert.ok(
    report.delegateTasksDescription <= METADATA_SIZE_BUDGETS.delegateTasksDescription,
  );
  assert.ok(
    report.continueTaskDescription <= METADATA_SIZE_BUDGETS.continueTaskDescription,
  );
  assert.ok(report.combined <= METADATA_SIZE_BUDGETS.combined);
  const inputs = inputMetadataSizeReport();
  assert.ok(inputs.delegateTask <= INPUT_METADATA_SIZE_BUDGETS.delegateTask);
  assert.ok(inputs.continueTask <= INPUT_METADATA_SIZE_BUDGETS.continueTask);
  assert.ok(inputs.delegateTasks <= INPUT_METADATA_SIZE_BUDGETS.delegateTasks);
  assert.ok(inputs.combined <= INPUT_METADATA_SIZE_BUDGETS.combined);
});

test("advertised schemas retain runtime validation and defaults without prose", () => {
  const single = {
    ...BASE_INPUT,
    contextCapsule: { invariants: "The public API remains stable." },
    previousAttempts: [
      {
        effort: "medium" as const,
        verdict: "FAILED" as const,
        whatWentWrong: "The first attempt missed the edge case.",
      },
    ],
  };
  assert.deepEqual(
    z.object(delegateTaskMcpInputShape).parse(single),
    delegateTaskInputSchema.parse(single),
  );

  const batch = { mode: "parallel" as const, tasks: [single] };
  assert.deepEqual(
    z.object(delegateTasksMcpInputShape).parse(batch),
    delegateTasksInputSchema.parse(batch),
  );

  const continuation = {
    continuationReference: "opaque-reference",
    instruction: "Re-run the bounded verification.",
  };
  assert.deepEqual(
    z.object(continueTaskMcpInputShape).parse(continuation),
    continueTaskInputSchema.parse(continuation),
  );

  assert.throws(() =>
    z.object(delegateTaskMcpInputShape).parse({
      ...single,
      objective: "too short",
    }),
  );
  const advertised = JSON.stringify(z.toJSONSchema(z.object(delegateTasksMcpInputShape)));
  assert.doesNotMatch(advertised, /"description"/);
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
    /optional concise.*label/i,
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
  assert.match(SERVER_INSTRUCTIONS, /parent owns architecture[\s\S]*decomposition/i);
  assert.match(SERVER_INSTRUCTIONS, /Luna owns[\s\S]*implementation[\s\S]*verification/i);
  assert.match(SERVER_INSTRUCTIONS, /adaptive zero-worker use is valid/i);
  assert.match(SERVER_INSTRUCTIONS, /raw tokens are not credit cost/i);
  assert.match(SERVER_INSTRUCTIONS, /savings are parent-conditional/i);
  assert.match(
    SERVER_INSTRUCTIONS,
    /more workers are not automatically better or cheaper/i,
  );
  assert.match(SERVER_INSTRUCTIONS, /Runtime evidence outranks worker claims/i);
  assert.match(SERVER_INSTRUCTIONS, /VERIFIED_COMPLETE[\s\S]*finish without rereading/i);
  assertSilentWaitGuidance(SERVER_INSTRUCTIONS);
});

test("one substantial bounded task may be delegated without another seam", () => {
  assert.match(TOOL_DESCRIPTION, /ONE substantial, bounded/i);
  assert.match(TOOL_DESCRIPTION, /no second seam is required/i);
  assert.match(TOOL_DESCRIPTION, /small,[\s\S]*simple,[\s\S]*tightly coupled/i);
  assert.match(TOOL_DESCRIPTION, /overhead/i);
  assert.match(TOOL_DESCRIPTION, /concise[\s\S]*activityLabel/i);
});

test("single-task guidance is cost-aware without treating pricing as permanent", () => {
  assert.doesNotMatch(TOOL_DESCRIPTION, /\b\d+(?:\.\d+)?x\s+cheaper\b/i);
  assert.doesNotMatch(TOOL_DESCRIPTION, /gpt-5\.6-sol/i);
  assert.doesNotMatch(TOOL_DESCRIPTION, /Sol tokens/i);
  assert.match(TOOL_DESCRIPTION, /raw tokens are not credit cost/i);
  assert.match(TOOL_DESCRIPTION, /parent-conditional credit economics/i);
  assert.match(TOOL_DESCRIPTION, /no saving is guaranteed/i);
  for (const factor of [
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
  assert.match(CONTINUE_TOOL_DESCRIPTION, /continuation never starts automatic repair/i);
});

test("bounded repair guidance and schemas keep parent control and the one-turn limit", async () => {
  assert.match(TOOL_DESCRIPTION, /automaticRepair/i);
  assert.match(TOOL_DESCRIPTION, /at most one conservative same-thread repair/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /automaticRepair/i);
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

test("retention guidance makes operator policy and continuation availability agree", async () => {
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /integrate=false[\s\S]*retention follows operator policy/i,
  );
  assert.doesNotMatch(BATCH_TOOL_DESCRIPTION, /retain worktrees for manual resolution/i);

  const rules = await readDoc("SOL_RULES.md");
  const configuration = await readDoc("docs/CONFIGURATION.md");
  for (const text of [rules, configuration]) {
    assert.match(text, /SOL_LUNA_KEEP_WORKTREES/i);
    assert.match(text, /never/i);
    assert.match(text, /continuation/i);
  }
  assert.match(configuration, /no intentional retention/i);
});

test("single-task results drive risk-based review", () => {
  for (const evidence of [
    "verification",
    "observed edits",
    "discrepant",
    "scope-violating",
  ]) {
    assert.match(TOOL_DESCRIPTION, new RegExp(evidence, "i"));
  }
  assert.match(TOOL_DESCRIPTION, /clean PASS[\s\S]*VERIFIED_COMPLETE/i);
  assert.match(TOOL_DESCRIPTION, /finish without rereading worker-owned files/i);
  assert.match(TOOL_DESCRIPTION, /Worker claims are not authoritative/i);
  for (const suspicious of [
    "FAILED",
    "BLOCKED",
    "untrustworthy",
    "discrepant",
    "scope-violating",
  ]) {
    assert.match(TOOL_DESCRIPTION, new RegExp(suspicious, "i"));
  }
});

test("batch guidance distinguishes sequential and parallel semantics", () => {
  assert.match(BATCH_TOOL_DESCRIPTION, /batch intended for two or more owned seams/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /one task remains accepted for compatibility/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /prefer delegate_task/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /sequential[\s\S]*dependencies/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /shared workspace state/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /parallel only for genuinely independent/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /disjoint declared scopes/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /Do not create artificial seams/i);
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    new RegExp(`at most ${MAX_BATCH_SIZE} tasks`, "i"),
  );
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    new RegExp(`at most ${MAX_PARALLEL} run concurrently`, "i"),
  );
  assert.match(BATCH_TOOL_DESCRIPTION, /the rest queue/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /raw tokens are not credit cost/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /More workers are not automatically cheaper/i);
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /allowOverlappingScopes:true[\s\S]*accepts the declared overlap/i,
  );
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /not a write sandbox[\s\S]*does not permit same-file integration/i,
  );
});

test("batch guidance states integration and partial-outcome behavior", () => {
  assert.match(BATCH_TOOL_DESCRIPTION, /same-file edits prevent automatic integration/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /Partial outcomes remain visible/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /Successful streams survive sibling failure/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /deduplicated union[\s\S]*final workspace/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /completionState=verified-complete/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /failure\/refusal\/conflict[\s\S]*rich evidence/i);
});

test("resultDetail makes the thin handoff default and preserves compatibility modes", () => {
  const text = delegateTaskInputShape.resultDetail.description ?? "";
  assert.match(text, /handoff \(default\)/i);
  assert.match(text, /omits structuredContent[\s\S]*clean verified PASS/i);
  assert.match(text, /rich failure evidence/i);
  assert.match(text, /compact[\s\S]*compatibility structure/i);
  assert.match(text, /full[\s\S]*complete structure/i);
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

test("worker failure causes remain worker claim evidence", () => {
  const description =
    delegateTaskOutputShape.workerClaimedFailureCauses.description ?? "";
  assert.match(description, /worker-declared failure causes/i);
  assert.match(description, /not an orchestrator repair or retry classification/i);
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
    /batch-level[\s\S]*handoff[\s\S]*default/i,
  );
  assert.match(
    delegateTasksInputShape.tasks.description ?? "",
    /one-task batch remains accepted for compatibility/i,
  );
  assert.match(delegateTasksInputShape.integrate.description ?? "", /Set false/i);
  assert.match(
    delegateTasksOutputShape.integrationConflicts.description ?? "",
    /parallel integration[\s\S]*sequential shared-workspace batches return an empty array/i,
  );
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
  assert.match(BATCH_TOOL_DESCRIPTION, /concise[\s\S]*activityLabel[\s\S]*safe label/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /same-file edits prevent automatic integration/i);
  assert.match(
    delegateTasksOutputShape.integrationVerification.description ?? "",
    /Final authoritative verification[\s\S]*integrated\/shared workspace/i,
  );
  assert.match(
    delegateTasksOutputShape.completionState.description ?? "",
    /verified-complete[\s\S]*final workspace verification/i,
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
  assert.match(
    readme,
    /exact final Adaptive credit total is unknown[\s\S]*lower\s+bound[\s\S]*at least approximately 6\.5% more expensive than Solo/i,
  );
  assert.match(readme, /Raw tokens remain diagnostics rather than equivalent cost/i);
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
    /default `resultDetail: "handoff"`[\s\S]*compact[\s\S]*full/i,
    /trustworthy: false/i,
    /do not routinely reread[\s\S]*rerun[\s\S]*passed checks/i,
    /needs-supervisor[\s\S]*targeted diagnosis/i,
    /has no meaningful new state,[\s\S]*remain silent/i,
    /do not narrate polling,[\s\S]*waiting,[\s\S]*elapsed time/i,
    /deduplicated union[\s\S]*final shared workspace/i,
    /do not pre-commit to rereading[\s\S]*every changed file/i,
    /empty `allowedFiles` means no in-workspace allowlist/i,
    /does not[\s\S]*declare read-only intent/i,
    /changeIntent[\s\S]*forbidden[\s\S]*optional[\s\S]*required/i,
    /omitted[\s\S]*defaults to `required`/i,
    /forbidden[\s\S]*runtime-observed edit[\s\S]*contract violation/i,
    /batch-level choice applied uniformly/i,
    /call-level `allowOverlappingScopes: true`[\s\S]*escape hatch/i,
    /actual same-file[\s\S]*edits still prevent[\s\S]*integration/i,
  ]) {
    assert.match(rules, invariant);
  }
  assert.doesNotMatch(rules, /2\.3x|3\.5x|V6|around 70 seconds|four and six/i);
});

test("landing page links to authoritative operational guidance", async () => {
  const [readme, rules, configuration] = await Promise.all([
    readDoc("README.md"),
    readDoc("SOL_RULES.md"),
    readDoc("docs/CONFIGURATION.md"),
  ]);
  assert.doesNotMatch(
    readme,
    /told\s+to\s+run\s+the\s+full\s+suite\s+after\s+integration/i,
  );
  assert.match(readme, /SOL_RULES\.md/);
  assert.match(readme, /CONFIGURATION\.md#discovery-hint-and-adaptive-routing/i);
  assert.match(
    configuration.replace(/^>\s?/gm, ""),
    new RegExp(escapeRegExp(DISCOVERY_HINT_TEXT).replaceAll(" ", "\\s+")),
  );
  assert.match(
    rules,
    /first discover[\s\S]*configured Sol-Luna MCP[\s\S]*Do not substitute Codex built-in delegation/i,
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
    /2026-08-24[\s\S]*API[\s\S]*Sol at \$4\/\$0\.40\/\$20[\s\S]*Luna at \$0\.20\/\$0\.02\/\$1\.20[\s\S]*20:1[\s\S]*16\.7:1/i,
  );
  assert.match(
    configuration,
    /Codex credit rates[\s\S]*separate billing context[\s\S]*cannot be derived from[\s\S]*API prices/i,
  );
  assert.match(
    configuration,
    /plan and rate card applicable to the[\s\S]*account[\s\S]*current official rate card/i,
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
    /Codex credit,[\s\S]*included-plan,[\s\S]*promotional,[\s\S]*legacy schedules may differ from[\s\S]*API/i,
  );
  assert.match(roadmap, /Completed and implemented foundations[\s\S]*P0\.2a/i);
  assert.match(roadmap, /release status[\s\S]*CHANGELOG\.md/i);
  assert.doesNotMatch(roadmap, /25:1|20:1|16\.7:1/);
  assert.doesNotMatch(
    [SERVER_INSTRUCTIONS, TOOL_DESCRIPTION, BATCH_TOOL_DESCRIPTION].join("\n"),
    /\$\s*\d|\b\d+(?:\.\d+)?\s*(?:x|:1)\b/i,
  );
});

test("release guidance creates a verified non-draft release after publishing", async () => {
  const [contributing, agents] = await Promise.all([
    readDoc("CONTRIBUTING.md"),
    readDoc("AGENTS.md"),
  ]);
  const version = contributing.indexOf("npm version <x.y.z> --no-git-tag-version");
  const tag = contributing.indexOf("Create the annotated release tag");
  const publish = contributing.indexOf("tag-triggered publish succeeds");
  const release = contributing.indexOf(
    "create the GitHub Release against that existing tag",
  );
  assert.ok(version >= 0 && version < tag && tag < publish && publish < release);
  assert.match(
    contributing,
    /gh release create vX\.Y\.Z --verify-tag[\s\S]*cannot[\s\S]*implicitly create or[\s\S]*retarget a tag/i,
  );
  assert.doesNotMatch(contributing, /\b--draft\b/);
  assert.match(
    contributing,
    /Prepare and review the intended GitHub Release body[\s\S]*transiently[\s\S]*do not commit a second release-body source/i,
  );
  assert.doesNotMatch(contributing, /RELEASE_NOTES\.md/);

  const releaseHeading = agents.indexOf("## Release discipline");
  assert.ok(releaseHeading >= 0);
  const releaseGuidance = agents.slice(releaseHeading);
  const agentPublish = releaseGuidance.search(
    /tag-matching OIDC\s+workflow publish successfully/i,
  );
  const agentRelease = releaseGuidance.search(/create a non-draft GitHub Release/i);
  assert.ok(agentPublish >= 0 && agentPublish < agentRelease);
  assert.match(releaseGuidance, /existing remote tag/i);
  assert.match(releaseGuidance, /--verify-tag/);
  assert.doesNotMatch(releaseGuidance, /GitHub Release draft|\b--draft\b/i);
  assert.match(
    releaseGuidance,
    /GitHub Release body transiently[\s\S]*do not commit a separate release body/i,
  );
});

test("current documentation distinguishes diagnostics, activity privacy, and legacy files", async () => {
  const [observability, security] = await Promise.all([
    readDoc("docs/OBSERVABILITY.md"),
    readDoc("SECURITY.md"),
  ]);

  for (const text of [observability, security]) {
    assert.match(
      text,
      /Verification\s+command output[\s\S]*tool-result evidence[\s\S]*not\s+copied/i,
    );
    assert.match(text, /pre-hardening/i);
    assert.match(text, /objective/i);
    assert.match(text, /current activity writers exclude|current writers omit/i);
  }
  assert.match(
    observability,
    /normally returned `delegate_task` result[\s\S]*written \*\*twice\*\*/i,
  );
  assert.match(observability, /failure before a normal result[\s\S]*typed/i);
});

test("acceptance ledger owns the current release baseline", async () => {
  const acceptance = await readDoc("docs/FEATURE_ACCEPTANCE.md");
  assert.match(acceptance, /package version is `0\.9\.1`/i);
  assert.match(acceptance, /current main runtime is its release baseline/i);
  assert.match(acceptance, /\*\*513\/516 tests passed and 3 expected platform skips\*\*/);
  assert.match(acceptance, /## Current capability matrix/);
  assert.match(
    acceptance,
    /Terminal verification and thin handoff boundary[\s\S]*NOT TESTED/,
  );
  assert.match(acceptance, /Parallel batches[\s\S]*Battle-tested/);
  assert.match(acceptance, /Worker Continuation[\s\S]*Battle-tested/);
  assert.match(acceptance, /no fresh parent[\s\S]*sequential batch/i);
  assert.match(acceptance, /No natural `xhigh` or `max` selection is claimed/i);
  assert.doesNotMatch(acceptance, /findings\.md/i);
  assert.doesNotMatch(acceptance, /runtime is unchanged from/i);
});
