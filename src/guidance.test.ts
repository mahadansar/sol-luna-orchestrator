/**
 * Supervisor guidance tests.
 *
 * Sol never reads `SOL_RULES.md` at runtime. What actually reaches a supervisor
 * is the MCP server's `instructions`, the two tool descriptions, and the Zod
 * `.describe()` text on each input field — all of which live in `server.ts` and
 * `contract.ts`. `SOL_RULES.md` is the human-facing copy of the same policy,
 * shipped in the package and optionally installed as `AGENTS.md`.
 *
 * Two copies of a policy drift. These tests assert the runtime strings first,
 * then assert that the document does not contradict them. They deliberately
 * check for the *presence of a distinction* rather than matching whole
 * paragraphs, so wording can be improved without a test rewrite.
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
import { delegateTaskInputSchema, delegateTaskInputShape } from "./contract.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readDoc = (name: string): Promise<string> =>
  fs.readFile(path.join(ROOT_DIR, name), "utf8");

/** Every string a connected supervisor is actually shown. */
const RUNTIME_SURFACES: Array<[string, string]> = [
  ["server instructions", SERVER_INSTRUCTIONS],
  ["delegate_task description", TOOL_DESCRIPTION],
  ["delegate_tasks description", BATCH_TOOL_DESCRIPTION],
  ["resultDetail field", delegateTaskInputShape.resultDetail.description ?? ""],
  ["contextCapsule field", delegateTaskInputShape.contextCapsule.description ?? ""],
];

// --- The API contract itself is unchanged ------------------------------------

test("resultDetail still defaults to full when omitted", () => {
  const parsed = delegateTaskInputSchema.parse({
    objective: "Just an objective 1234567890",
    acceptanceCriteria: ["done"],
    effortReason: "simple task because it is short",
  });
  assert.equal(parsed.resultDetail, "full");
});

test("contextCapsule is still optional and absent when not supplied", () => {
  const parsed = delegateTaskInputSchema.parse({
    objective: "Just an objective 1234567890",
    acceptanceCriteria: ["done"],
    effortReason: "simple task because it is short",
  });
  assert.equal(parsed.contextCapsule, undefined);
});

// --- resultDetail guidance ---------------------------------------------------

test("every runtime surface that mentions resultDetail asks for it explicitly", () => {
  for (const [label, text] of RUNTIME_SURFACES) {
    if (!/resultDetail/.test(text)) continue;
    assert.match(
      text,
      /compact/,
      `${label} mentions resultDetail without naming compact`,
    );
    assert.match(
      text,
      /routine|explicit/i,
      `${label} should say when compact is the routine choice`,
    );
  }
});

test("the runtime keeps full available as a deliberate exception, not a ban", () => {
  const text = `${TOOL_DESCRIPTION}\n${delegateTaskInputShape.resultDetail.description}`;
  assert.match(text, /full/);
  // The schema default is a compatibility promise, so the guidance has to say
  // so rather than implying compact is the default the API applies.
  assert.match(text, /default\s+remains\s+.?"?full/i);
  assert.ok(
    !/never\s+use\s+.?"?full/i.test(text),
    "full must remain a legitimate choice",
  );
});

test("compact is described as dropping only passed-command output", () => {
  const text = TOOL_DESCRIPTION;
  assert.match(text, /passed/);
  for (const kept of ["discrepancies", "scope violations", "verdict"]) {
    assert.ok(
      text.toLowerCase().includes(kept.toLowerCase()),
      `the description should say ${kept} survive compact`,
    );
  }
});

// --- contextCapsule guidance -------------------------------------------------

test("the capsule is described as conditional, bounded, and non-duplicating", () => {
  const text = delegateTaskInputShape.contextCapsule.description ?? "";
  assert.match(text, /optional/i);
  assert.match(text, /only\s+when\s+useful|include\s+only/i);
  assert.match(text, /omit/i);
  assert.match(text, /never\s+dump|not\s+a\s+dump/i);
  assert.match(text, /duplicate/i);
});

// --- Review policy -----------------------------------------------------------

/** The unconditional ritual the live cost study argued against. */
const UNCONDITIONAL_REVIEW =
  /(always|never\s+accept)[^.]{0,80}(read|review)[^.]{0,40}diff|read\s+the\s+(actual\s+)?diff\s+of\s+every\s+changed\s+file/i;

test("no runtime surface still demands an unconditional diff re-read", () => {
  for (const [label, text] of RUNTIME_SURFACES) {
    assert.ok(
      !UNCONDITIONAL_REVIEW.test(text),
      `${label} still demands an unconditional diff re-read`,
    );
  }
});

test("a clean verified PASS is told not to re-derive existing evidence", () => {
  assert.match(TOOL_DESCRIPTION, /clean\s+PASS/i);
  assert.match(TOOL_DESCRIPTION, /Do\s+NOT\s+automatically\s+reread/i);
  assert.match(TOOL_DESCRIPTION, /trustworthy: true/);
  // A clean PASS is defined by all of these together, not by the verdict alone.
  for (const signal of ["discrepancies", "scope violations", "verification"]) {
    assert.ok(
      TOOL_DESCRIPTION.toLowerCase().includes(signal),
      `the clean-PASS definition should include ${signal}`,
    );
  }
});

test("suspicious evidence still calls for deeper review", () => {
  for (const trigger of [
    "FAILED",
    "BLOCKED",
    "trustworthy: false",
    "discrepancies",
    "scope violations",
  ]) {
    assert.ok(
      TOOL_DESCRIPTION.includes(trigger),
      `${trigger} should still trigger deeper review`,
    );
  }
  assert.match(TOOL_DESCRIPTION, /SHOULD\s+happen\s+when\s+justified/);
});

test("this is not a licence to trust workers blindly", () => {
  const text = `${SERVER_INSTRUCTIONS}\n${TOOL_DESCRIPTION}`;
  assert.match(text, /claim|evidence,\s+not\s+a\s+conclusion/i);
  assert.ok(
    !/trust\s+the\s+worker/i.test(text),
    "nothing should tell the supervisor to trust the worker",
  );
});

test("parallel integration verification is conditional, not automatic", () => {
  assert.match(BATCH_TOOL_DESCRIPTION, /verified\s+alone|in\s+isolation/i);
  assert.match(BATCH_TOOL_DESCRIPTION, /can\s+actually\s+interact/i);
  assert.match(
    BATCH_TOOL_DESCRIPTION,
    /merely\s+because\s+the\s+batch\s+ran\s+in\s+parallel/i,
  );
});

// --- Cost awareness ----------------------------------------------------------

test("runtime guidance explicitly distinguishes raw-token volume from credit cost", () => {
  assert.match(TOOL_DESCRIPTION, /do NOT optimize[\s\S]*raw token/i);
  assert.match(
    TOOL_DESCRIPTION,
    /substantially more[\s\S]*raw tokens[\s\S]*fewer total credits/i,
  );
});

test("current Luna-vs-Sol cost advantage is represented without claiming it is permanent", () => {
  assert.match(TOOL_DESCRIPTION, /Luna compute is roughly 25x cheaper/i);
  assert.match(TOOL_DESCRIPTION, /based on the current schedule[\s\S]*not an immutable/i);
});

test("existing 'small tasks may be better solo' guidance remains", () => {
  assert.match(TOOL_DESCRIPTION, /small[\s\S]*overhead exceeds the work/i);
  assert.match(TOOL_DESCRIPTION, /Do it yourself when:/i);
  assert.match(TOOL_DESCRIPTION, /change is small, mechanical, or confined to one file/i);
});

test("guidance does not imply 'always delegate' or 'more workers is cheaper'", () => {
  assert.match(TOOL_DESCRIPTION, /More workers is not automatically cheaper/i);
  assert.match(TOOL_DESCRIPTION, /driven by useful task seams/i);
});

// --- Framing & applicability -------------------------------------------------

test("delegate_task is not framed as implementation-only", () => {
  const surfaces = [
    TOOL_DESCRIPTION,
    SERVER_INSTRUCTIONS,
    delegateTaskInputShape.objective.description,
  ];
  for (const text of surfaces) {
    assert.ok(
      !/implementation task/i.test(text ?? ""),
      "should not say 'implementation task'",
    );
    assert.ok(
      !/implementation work;/i.test(text ?? ""),
      "should not say 'implementation work;'",
    );
    assert.match(text ?? "", /executable( task| work)/i);
  }
});

test("investigation, tests, refactor remain legitimate delegated work", () => {
  const schemaDesc = delegateTaskInputShape.taskCategory.description ?? "";
  assert.match(schemaDesc, /investigation/i);
  assert.match(schemaDesc, /bugfix/i);
  assert.match(schemaDesc, /chore/i);
  assert.match(schemaDesc, /tests/i);
});

test("one substantial bounded task may be delegated without requiring a second seam", () => {
  assert.ok(
    !/no second independent piece of work to overlap it with/i.test(TOOL_DESCRIPTION),
    "should not use lack of a second task as a reason to do it yourself",
  );
  assert.match(TOOL_DESCRIPTION, /does NOT need a second independent seam/i);
});

test("parallel delegation is not described as guaranteed faster", () => {
  assert.ok(
    !/can actually save wall-clock time/i.test(TOOL_DESCRIPTION),
    "should not guarantee wall-clock savings",
  );
  assert.match(TOOL_DESCRIPTION, /may reduce latency[\s\S]*not guaranteed/i);
});

// --- The document must not contradict the runtime ----------------------------

test("SOL_RULES.md carries the same policy as the runtime surfaces", async () => {
  const rules = await readDoc("SOL_RULES.md");

  assert.ok(
    !UNCONDITIONAL_REVIEW.test(rules),
    "SOL_RULES.md still demands an unconditional diff re-read",
  );
  assert.match(rules, /clean\s+PASS/i);
  assert.match(rules, /risk-based/i);
  assert.match(
    rules,
    /Default\s+supervisor\s+behaviou?r\s+for\s+routine\s+delegation\s+is\s+`?compact/i,
  );
  assert.match(rules, /schema\s+default\s+remains\s+`?full/i);
  assert.match(rules, /Never\s+dump\s+the\s+parent\s+transcript/i);
  // Deeper review must survive in the document too, or it reads as "trust it".
  assert.match(rules, /trustworthy: false/);
  assert.match(rules, /Do\s+NOT\s+automatically\s+rerun\s+a\s+full\s+suite/i);
  assert.match(rules, /roughly 25x cheaper/i);
  assert.match(rules, /not automatically cheaper/i);
});

test("the README does not promise a full suite rerun after every parallel batch", async () => {
  const readme = await readDoc("README.md");
  assert.ok(
    !/told\s+to\s+run\s+the\s+full\s+suite\s+after\s+integration/i.test(readme),
    "README still states the old unconditional rule",
  );
});
