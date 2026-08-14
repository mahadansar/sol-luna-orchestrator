/**
 * Fixture validation. Spends no tokens.
 *
 * Proves the benchmark can actually tell success from failure:
 *   - every task fails in its starting state (so passing means real work happened)
 *   - every task passes given a known-good reference solution
 *   - the mutation check fails a good test suite when the implementation breaks
 *
 * If this script does not pass, benchmark numbers are meaningless.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PARALLEL_SOLUTIONS } from "./parallel-solutions.js";
import { PARALLEL_TASKS } from "./parallel-tasks.js";
import { BENCH_TASKS, type BenchTask, type GradeCommand } from "./tasks.js";

/** Known-good solutions, used only to prove the grader accepts correct work. */
const REFERENCE_SOLUTIONS: Record<string, Record<string, string>> = {
  "bugfix-pagination": {
    "paginate.mjs": `export function paginate(items, pageSize, page) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function pageCount(items, pageSize) {
  return Math.ceil(items.length / pageSize);
}
`,
  },
  "feature-validation": {
    "validate.mjs": `const EMAIL = /^[^\\s@]+@[^\\s@.]+\\.[^\\s@.]+$/;
const USERNAME = /^[A-Za-z0-9_]+$/;

export function validateSignup(input) {
  const errors = [];
  const { username, email, password } = input ?? {};

  if (email === undefined || email === null || email === "") {
    errors.push({ field: "email", message: "email is required" });
  } else if (!EMAIL.test(email)) {
    errors.push({ field: "email", message: "email is invalid" });
  }

  if (password === undefined || password === null || password === "") {
    errors.push({ field: "password", message: "password is required" });
  } else if (password.length < 8) {
    errors.push({ field: "password", message: "password must be at least 8 characters" });
  } else if (!/[0-9]/.test(password)) {
    errors.push({ field: "password", message: "password must contain a digit" });
  }

  if (username === undefined || username === null || username === "") {
    errors.push({ field: "username", message: "username is required" });
  } else if (username.length < 3 || username.length > 20) {
    errors.push({ field: "username", message: "username must be 3-20 characters" });
  } else if (!USERNAME.test(username)) {
    errors.push({
      field: "username",
      message: "username may only contain letters, digits and underscores",
    });
  }

  errors.sort((a, b) => a.field.localeCompare(b.field));
  return { valid: errors.length === 0, errors };
}
`,
  },
  "tests-stack": {
    "stack.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { Stack } from "./stack.mjs";

test("push returns the stack for chaining", () => {
  const stack = new Stack();
  assert.equal(stack.push(1), stack);
  assert.equal(stack.push(2).push(3).size, 3);
});

test("pop returns items last-in-first-out", () => {
  const stack = new Stack();
  stack.push("a").push("b").push("c");
  assert.equal(stack.pop(), "c");
  assert.equal(stack.pop(), "b");
  assert.equal(stack.pop(), "a");
});

test("peek returns the top without removing it", () => {
  const stack = new Stack();
  stack.push(1).push(2);
  assert.equal(stack.peek(), 2);
  assert.equal(stack.size, 2);
});

test("size reflects the contents", () => {
  const stack = new Stack();
  assert.equal(stack.size, 0);
  stack.push(1);
  assert.equal(stack.size, 1);
  stack.pop();
  assert.equal(stack.size, 0);
});

test("pop and peek throw RangeError when empty", () => {
  const stack = new Stack();
  assert.throws(() => stack.pop(), RangeError);
  assert.throws(() => stack.peek(), RangeError);
});
`,
  },
  "debug-concurrency": {
    "pool.mjs": `export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    function pump() {
      if (index >= items.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < limit && index < items.length) {
        const current = index;
        index += 1;
        active += 1;
        Promise.resolve(fn(items[current], current)).then((value) => {
          results[current] = value;
          active -= 1;
          pump();
        }, reject);
      }
    }
    pump();
  });
}
`,
  },
};

function run(command: GradeCommand, cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      command.file,
      command.args,
      { cwd, timeout: 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error) => {
        if (!error) return resolve(0);
        const code = (error as { code?: unknown }).code;
        resolve(typeof code === "number" ? code : null);
      },
    );
  });
}

function materialize(task: BenchTask): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `benchcheck-${task.id}-`));
  for (const [name, content] of Object.entries(task.files)) {
    const target = path.join(workspace, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return workspace;
}

let failures = 0;
const check = (label: string, condition: boolean, detail = ""): void => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

async function validateTask(task: BenchTask): Promise<void> {
  console.log(`\n${task.id} (${task.category})`);

  // 1. The starting state must fail, or the task measures nothing.
  const fresh = materialize(task);
  try {
    const codes = await Promise.all(task.grade.map((command) => run(command, fresh)));
    check(
      "fails in its starting state",
      codes.some((code) => code !== 0),
      `exit codes: ${codes.join(", ")}`,
    );
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }

  // 2. A known-good solution must pass every grade command.
  const solution = REFERENCE_SOLUTIONS[task.id] ?? PARALLEL_SOLUTIONS[task.id];
  if (!solution) {
    check("has a reference solution", false);
    return;
  }

  const solved = materialize(task);
  try {
    for (const [name, content] of Object.entries(solution)) {
      const target = path.join(solved, ...name.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
    }
    const codes = await Promise.all(task.grade.map((command) => run(command, solved)));
    check(
      "passes with the reference solution",
      codes.every((code) => code === 0),
      `exit codes: ${codes.join(", ")}`,
    );

    // 3. The mutation must break a genuinely good test suite.
    if (task.mutation) {
      const target = path.join(solved, task.mutation.file);
      const original = fs.readFileSync(target, "utf8");
      fs.writeFileSync(target, task.mutation.content, "utf8");
      const mutatedCode = await run(task.mutation.command, solved);
      fs.writeFileSync(target, original, "utf8");
      check(
        "mutation is caught by a real test suite",
        mutatedCode !== 0,
        `exit code: ${mutatedCode}`,
      );
    }
  } finally {
    fs.rmSync(solved, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("Validating benchmark fixtures (no model calls)");
  for (const task of [...BENCH_TASKS, ...PARALLEL_TASKS]) {
    await validateTask(task);
  }
  console.log(
    failures === 0
      ? "\nAll fixtures discriminate correctly."
      : `\n${failures} fixture check(s) FAILED — benchmark results would be meaningless.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("Fixture validation errored:", error);
  process.exit(1);
});
