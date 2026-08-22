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
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTION,
} from "./server.js";
import {
  delegateTaskInputSchema,
  delegateTaskInputShape,
  delegateTaskOutputShape,
  delegateTasksInputShape,
} from "./contract.js";
import { buildWorkerPrompt } from "./prompt.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readDoc = (name: string): Promise<string> =>
  fs.readFile(path.join(ROOT_DIR, name), "utf8");

const BASE_INPUT = {
  objective: "Complete one bounded executable task safely.",
  effortReason: "The task needs routine judgement in one area.",
  acceptanceCriteria: ["The requested behavior is present."],
};

test("backwards-compatible guidance fields retain their API defaults", () => {
  const parsed = delegateTaskInputSchema.parse(BASE_INPUT);
  assert.equal(parsed.resultDetail, "full");
  assert.equal(parsed.contextCapsule, undefined);
});

test("server instructions keep roles, evidence authority, and proportional review", () => {
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /Sol supervises/i);
  assert.match(SERVER_INSTRUCTIONS, /Sol-Luna Orchestrator/i);
  assert.match(SERVER_INSTRUCTIONS, /compatible parent Codex model/i);
  assert.match(SERVER_INSTRUCTIONS, /parent supervisor owns/i);
  assert.match(SERVER_INSTRUCTIONS, /workers execute bounded tasks/i);
  assert.match(SERVER_INSTRUCTIONS, /claims are not orchestrator evidence/i);
  assert.match(SERVER_INSTRUCTIONS, /proportion/i);
  assert.match(SERVER_INSTRUCTIONS, /without repetitive polling or status narration/i);
  assert.match(
    SERVER_INSTRUCTIONS,
    /result, error, cancellation, timeout, or meaningful new state/i,
  );
});

test("one substantial bounded task may be delegated without another seam", () => {
  assert.match(TOOL_DESCRIPTION, /ONE substantial, bounded/i);
  assert.match(TOOL_DESCRIPTION, /does not need a second independent seam/i);
  assert.match(TOOL_DESCRIPTION, /small,[\s\S]*simple,[\s\S]*tightly coupled/i);
  assert.match(TOOL_DESCRIPTION, /overhead/i);
});

test("single-task guidance is cost-aware without treating pricing as permanent", () => {
  assert.match(TOOL_DESCRIPTION, /current pricing schedule/i);
  assert.match(TOOL_DESCRIPTION, /roughly 25x cheaper/i);
  assert.match(TOOL_DESCRIPTION, /more aggregate raw tokens[\s\S]*fewer total credits/i);
  assert.match(TOOL_DESCRIPTION, /not an architectural guarantee/i);
  assert.match(TOOL_DESCRIPTION, /More workers is not automatically cheaper/i);
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
  assert.match(BATCH_TOOL_DESCRIPTION, /two or more meaningful bounded tasks/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /sequential[\s\S]*depend/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /share\s+workspace\s+state/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /parallel[\s\S]*genuinely independent/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /disjoint declared scopes/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /does not guarantee/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /Do not create artificial seams/i);
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
    /same-file edits[\s\S]*prevent automatic integration/i,
  );
  assert.match(delegateTasksInputShape.integrate.description ?? "", /Set false/i);
});

test("SOL_RULES carries the runtime's operational distinctions without benchmark narration", async () => {
  const rules = await readDoc("SOL_RULES.md");
  for (const invariant of [
    /Zero workers is valid/i,
    /No second seam is required/i,
    /roughly\s+25x\s+cheaper/i,
    /not an immutable architectural guarantee/i,
    /more workers are not[\s\S]*automatically[\s\S]*cheaper/i,
    /schema default remains[\s\S]*full/i,
    /trustworthy: false/i,
    /Do not automatically rerun a full suite/i,
    /without repetitive polling\s+or status narration/i,
    /normally leave broader final validation to the parent/i,
    /do not pre-commit to rereading[\s\S]*every changed file/i,
  ]) {
    assert.match(rules, invariant);
  }
  assert.doesNotMatch(rules, /2\.3x|3\.5x|V6|around 70 seconds|four and six/i);
});

test("README does not require unconditional integration verification", async () => {
  const readme = await readDoc("README.md");
  assert.doesNotMatch(
    readme,
    /told\s+to\s+run\s+the\s+full\s+suite\s+after\s+integration/i,
  );
  assert.match(
    readme,
    /Use the sol-luna-orchestrator MCP for this task\. Decide whether delegate_task or[\s\S]*delegate_tasks is appropriate based on the work\./,
  );
});
