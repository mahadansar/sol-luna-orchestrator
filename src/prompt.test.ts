import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildWorkerPrompt } from "./prompt.js";
import { delegateTaskInputSchema } from "./contract.js";

test("prompt context capsule - absent", () => {
  const input = delegateTaskInputSchema.parse({
    objective: "Just an objective 1234567890",
    acceptanceCriteria: ["done"],
    effortReason: "simple task because it is short",
  });
  const prompt = buildWorkerPrompt(input, "/fake/dir");
  assert.ok(!prompt.includes("## Relevant context"));
  assert.ok(!prompt.includes("## Interfaces"));
});

test("prompt context capsule - completely empty", () => {
  const input = delegateTaskInputSchema.parse({
    objective: "Just an objective 1234567890",
    acceptanceCriteria: ["done"],
    effortReason: "simple task because it is short",
    contextCapsule: {},
  });
  const prompt = buildWorkerPrompt(input, "/fake/dir");
  assert.ok(!prompt.includes("## Relevant context"));
  assert.ok(!prompt.includes("## Interfaces"));
});

test("prompt context capsule - one field", () => {
  const input = delegateTaskInputSchema.parse({
    objective: "Just an objective 1234567890",
    acceptanceCriteria: ["done"],
    effortReason: "simple task because it is short",
    contextCapsule: {
      knownPitfalls: "Do not delete the root index.js",
    },
  });
  const prompt = buildWorkerPrompt(input, "/fake/dir");
  assert.ok(prompt.includes("## Known pitfalls\n\nDo not delete the root index.js"));
  assert.ok(!prompt.includes("## Relevant context"));
});

test("prompt context capsule - several fields", () => {
  const input = delegateTaskInputSchema.parse({
    objective: "Just an objective 1234567890",
    acceptanceCriteria: ["done"],
    effortReason: "simple task because it is short",
    contextCapsule: {
      invariants: "Keep auth checking",
      interfaces: "Function must return boolean",
    },
  });
  const prompt = buildWorkerPrompt(input, "/fake/dir");
  assert.ok(prompt.includes("## Invariants\n\nKeep auth checking"));
  assert.ok(prompt.includes("## Interfaces\n\nFunction must return boolean"));
  assert.ok(!prompt.includes("## Known pitfalls"));
});

test("prompt context capsule - malformed input", () => {
  // Zod's message is a JSON array of issues and does not contain the words
  // "ZodError", so match on the name and the issue rather than on the message.
  assert.throws(
    () => {
      delegateTaskInputSchema.parse({
        objective: "Just an objective 1234567890",
        acceptanceCriteria: ["done"],
        effortReason: "simple task because it is short",
        contextCapsule: {
          relevantContext: 123, // Must be string
        },
      });
    },
    (error: unknown) => {
      assert.equal((error as Error).name, "ZodError");
      assert.match((error as Error).message, /expected string/i);
      return true;
    },
  );
});
