/**
 * Benchmark fixtures.
 *
 * Each task is a self-contained Node workspace with a deterministic, objective
 * grade. No network, no timers, no subjective judgement: a task passes only if
 * the harness can run its checks and see exit code 0.
 *
 * Fixtures are inlined rather than kept as loose files so a run cannot be
 * contaminated by a previous run's leftovers.
 */

export interface GradeCommand {
  file: string;
  args: string[];
  /** Human-readable purpose, used in the report. */
  label: string;
}

export interface BenchTask {
  id: string;
  title: string;
  category: string;
  /** Why this task is in the suite. */
  rationale: string;
  /**
   * Workload tier, for suites that vary size deliberately. `coupled` marks a
   * fixture whose work has no natural seam and is expected to lose under
   * delegation — a control rather than a rung on the ladder.
   */
  tier?: "A" | "B" | "C" | "D" | "coupled";
  /**
   * How many independent workstreams the fixture contains. Drives the
   * concurrency the orchestrated arms are given, and is the axis the crossover
   * investigation varies.
   */
  streams?: number;
  /** Files written into a fresh workspace before the agent starts. */
  files: Record<string, string>;
  /**
   * Initialise the workspace as a git repository with one commit. Required by
   * the parallel arm, whose workers each need a worktree to branch from.
   */
  requiresGit?: boolean;
  /** The work request, identical for both arms. */
  objective: string;
  /** Files that must be byte-identical afterwards; changing one fails the task. */
  immutable: string[];
  /** All must exit 0 for the task to count as passed. */
  grade: GradeCommand[];
  /**
   * Optional sabotage check: after grading passes, overwrite `file` with a
   * broken implementation and re-run `command`. It must now FAIL. This is how
   * "did they write real tests?" becomes objective.
   */
  mutation?: {
    file: string;
    content: string;
    command: GradeCommand;
  };
}

const nodeTest = (file: string, label: string): GradeCommand => ({
  file: process.execPath,
  args: ["--test", file],
  label,
});

// ---------------------------------------------------------------------------

const paginate: BenchTask = {
  id: "bugfix-pagination",
  title: "Fix off-by-one errors in a pagination helper",
  category: "bugfix",
  rationale: "Small bug with a reliable repro — the archetypal `high` task.",
  immutable: ["paginate.test.mjs"],
  files: {
    "paginate.mjs": `export function paginate(items, pageSize, page) {
  const start = page * pageSize;
  return items.slice(start, start + pageSize);
}

export function pageCount(items, pageSize) {
  return Math.floor(items.length / pageSize);
}
`,
    "paginate.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { pageCount, paginate } from "./paginate.mjs";

const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test("pages are 1-based", () => {
  assert.deepEqual(paginate(items, 3, 1), [1, 2, 3]);
  assert.deepEqual(paginate(items, 3, 2), [4, 5, 6]);
});

test("the final page may be partial", () => {
  assert.deepEqual(paginate(items, 3, 4), [10]);
});

test("out-of-range pages are empty", () => {
  assert.deepEqual(paginate(items, 3, 5), []);
});

test("pageCount rounds up", () => {
  assert.equal(pageCount(items, 3), 4);
  assert.equal(pageCount(items, 5), 2);
  assert.equal(pageCount([], 5), 0);
});
`,
  },
  objective:
    "The tests in paginate.test.mjs fail. Fix paginate.mjs so every test passes. " +
    "Pages are 1-based. Do not modify paginate.test.mjs.",
  grade: [nodeTest("paginate.test.mjs", "pagination tests pass")],
};

// ---------------------------------------------------------------------------

const validation: BenchTask = {
  id: "feature-validation",
  title: "Implement a signup validator against a written spec",
  category: "implementation",
  rationale: "Bounded feature work, fully specified by tests — a `high` task.",
  immutable: ["validate.test.mjs"],
  files: {
    "validate.mjs": `export function validateSignup(input) {
  throw new Error("not implemented");
}
`,
    "validate.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { validateSignup } from "./validate.mjs";

const valid = { username: "ada_l", email: "ada@example.com", password: "lovelace1" };

test("accepts valid input", () => {
  assert.deepEqual(validateSignup(valid), { valid: true, errors: [] });
});

test("ignores unknown fields", () => {
  assert.deepEqual(validateSignup({ ...valid, nickname: "x" }), { valid: true, errors: [] });
});

test("reports a missing email", () => {
  const result = validateSignup({ ...valid, email: undefined });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [{ field: "email", message: "email is required" }]);
});

test("reports a malformed email", () => {
  for (const email of ["ada", "ada@", "ada@example", "@example.com"]) {
    const result = validateSignup({ ...valid, email });
    assert.equal(result.valid, false, email);
    assert.deepEqual(result.errors, [{ field: "email", message: "email is invalid" }]);
  }
});

test("requires a password of at least 8 characters containing a digit", () => {
  assert.deepEqual(validateSignup({ ...valid, password: "short1" }).errors, [
    { field: "password", message: "password must be at least 8 characters" },
  ]);
  assert.deepEqual(validateSignup({ ...valid, password: "nodigitshere" }).errors, [
    { field: "password", message: "password must contain a digit" },
  ]);
});

test("requires a 3-20 character username of letters, digits and underscores", () => {
  assert.deepEqual(validateSignup({ ...valid, username: "ab" }).errors, [
    { field: "username", message: "username must be 3-20 characters" },
  ]);
  assert.deepEqual(validateSignup({ ...valid, username: "a".repeat(21) }).errors, [
    { field: "username", message: "username must be 3-20 characters" },
  ]);
  assert.deepEqual(validateSignup({ ...valid, username: "ada lovelace" }).errors, [
    { field: "username", message: "username may only contain letters, digits and underscores" },
  ]);
});

test("errors are sorted by field name", () => {
  const result = validateSignup({ username: "!", email: "nope", password: "x" });
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map((error) => error.field),
    ["email", "password", "username"],
  );
});
`,
  },
  objective:
    "Implement validateSignup in validate.mjs so every test in validate.test.mjs passes. " +
    "It returns { valid, errors } where errors is a list of { field, message } sorted by " +
    "field name. Do not modify validate.test.mjs.",
  grade: [nodeTest("validate.test.mjs", "validation tests pass")],
};

// ---------------------------------------------------------------------------

const stackTests: BenchTask = {
  id: "tests-stack",
  title: "Write a test suite for an existing class",
  category: "tests",
  rationale:
    "Test-writing graded objectively: the suite must pass against the real " +
    "implementation AND fail against a deliberately broken one.",
  immutable: ["stack.mjs"],
  files: {
    "stack.mjs": `export class Stack {
  #items = [];

  push(value) {
    this.#items.push(value);
    return this;
  }

  pop() {
    if (this.#items.length === 0) throw new RangeError("stack is empty");
    return this.#items.pop();
  }

  peek() {
    if (this.#items.length === 0) throw new RangeError("stack is empty");
    return this.#items[this.#items.length - 1];
  }

  get size() {
    return this.#items.length;
  }
}
`,
  },
  objective:
    "Create stack.test.mjs using node:test and node:assert/strict, testing the Stack " +
    "class in stack.mjs. Cover: push returns the stack for chaining; pop returns items " +
    "in last-in-first-out order; peek returns the top without removing it; size reflects " +
    "the contents; and pop and peek each throw RangeError when the stack is empty. " +
    "The suite must pass with `node --test stack.test.mjs`. Do not modify stack.mjs.",
  grade: [nodeTest("stack.test.mjs", "authored tests pass against the real class")],
  mutation: {
    file: "stack.mjs",
    // pop() takes from the wrong end: any suite that genuinely checks LIFO order fails.
    content: `export class Stack {
  #items = [];

  push(value) {
    this.#items.push(value);
    return this;
  }

  pop() {
    if (this.#items.length === 0) throw new RangeError("stack is empty");
    return this.#items.shift();
  }

  peek() {
    if (this.#items.length === 0) throw new RangeError("stack is empty");
    return this.#items[this.#items.length - 1];
  }

  get size() {
    return this.#items.length;
  }
}
`,
    command: nodeTest("stack.test.mjs", "authored tests catch a broken implementation"),
  },
};

// ---------------------------------------------------------------------------

const concurrency: BenchTask = {
  id: "debug-concurrency",
  title: "Diagnose a result-ordering bug in a concurrency limiter",
  category: "investigation",
  rationale:
    "The failure is an ordering bug that only appears when completion order " +
    "differs from start order — the kind of task that justifies xhigh.",
  immutable: ["pool.test.mjs"],
  files: {
    "pool.mjs": `export async function mapWithConcurrency(items, limit, fn) {
  const results = [];
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
          results.push(value);
          active -= 1;
          pump();
        }, reject);
      }
    }
    pump();
  });
}
`,
    "pool.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "./pool.mjs";

// Deterministic "slowness" without timers: each tick is one microtask hop, so
// completion order is fixed and reproducible on any machine.
const ticks = async (count) => {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
};

test("results keep input order even when tasks finish out of order", async () => {
  const items = [0, 1, 2, 3, 4, 5];
  const results = await mapWithConcurrency(items, 2, async (item) => {
    await ticks(12 - item * 2);
    return item * 10;
  });
  assert.deepEqual(results, [0, 10, 20, 30, 40, 50]);
});

test("never exceeds the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await ticks(4);
    active -= 1;
    return item;
  });
  assert.ok(peak <= 3, \`peak concurrency was \${peak}, expected at most 3\`);
});

test("handles an empty input list", async () => {
  assert.deepEqual(await mapWithConcurrency([], 3, async (x) => x), []);
});

test("propagates the first rejection", async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("boom");
      return item;
    }),
    /boom/,
  );
});
`,
  },
  objective:
    "The suite in pool.test.mjs fails against pool.mjs. Diagnose the cause and fix " +
    "pool.mjs so every test passes, keeping the concurrency limit intact. " +
    "Do not modify pool.test.mjs.",
  grade: [nodeTest("pool.test.mjs", "concurrency tests pass")],
};

export const BENCH_TASKS: BenchTask[] = [paginate, validation, stackTests, concurrency];

export const getTasks = (ids: string[]): BenchTask[] =>
  ids.length === 0 ? BENCH_TASKS : BENCH_TASKS.filter((task) => ids.includes(task.id));
