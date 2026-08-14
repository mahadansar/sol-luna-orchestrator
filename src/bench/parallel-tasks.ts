/**
 * Benchmark fixtures with several genuinely independent workstreams.
 *
 * The micro suite exists to show where delegation loses. This one exists to test
 * the opposite claim: that orchestration can pay off when a task contains real,
 * separable work. Each fixture has three modules that share no code and have
 * their own test file, so they can be implemented in any order, by anyone, at
 * the same time — and a supervisor working alone must still do all three.
 *
 * Every module is specified by its tests, so grading stays objective.
 */
import type { BenchTask } from "./tasks.js";

const nodeTest = (files: string[], label: string) => ({
  file: process.execPath,
  args: ["--test", ...files],
  label,
});

// ---------------------------------------------------------------------------

const toolkit: BenchTask = {
  id: "parallel-toolkit",
  title: "Implement three independent utility modules",
  category: "implementation",
  rationale:
    "Three unrelated modules with separate test files: the clearest case for " +
    "parallel delegation, and a fair one because each module is real work.",
  requiresGit: true,
  immutable: ["test/slug.test.mjs", "test/money.test.mjs", "test/retry.test.mjs"],
  files: {
    "src/slug.mjs": `export function slugify(input, options = {}) {
  throw new Error("not implemented");
}
`,
    "src/money.mjs": `export function formatMoney(cents, currency = "USD") {
  throw new Error("not implemented");
}
`,
    "src/retry.mjs": `export async function retryWithBackoff(fn, options = {}) {
  throw new Error("not implemented");
}
`,
    "test/slug.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { slugify } from "../src/slug.mjs";

test("lowercases and hyphenates", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses runs of non-alphanumerics into one hyphen", () => {
  assert.equal(slugify("a  --  b__c"), "a-b-c");
});

test("trims leading and trailing separators", () => {
  assert.equal(slugify("  ...Hello!  "), "hello");
});

test("keeps digits", () => {
  assert.equal(slugify("Top 10 Songs"), "top-10-songs");
});

test("returns an empty string when nothing survives", () => {
  assert.equal(slugify("!!!"), "");
});

test("truncates at maxLength without splitting a word", () => {
  assert.equal(slugify("the quick brown fox", { maxLength: 12 }), "the-quick");
});

test("truncates hard when a single word exceeds maxLength", () => {
  assert.equal(slugify("supercalifragilistic", { maxLength: 6 }), "superc");
});
`,
    "test/money.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney } from "../src/money.mjs";

test("formats whole amounts with two decimals", () => {
  assert.equal(formatMoney(1000), "$10.00");
  assert.equal(formatMoney(0), "$0.00");
});

test("formats partial amounts", () => {
  assert.equal(formatMoney(1234), "$12.34");
  assert.equal(formatMoney(5), "$0.05");
});

test("groups thousands with commas", () => {
  assert.equal(formatMoney(123456789), "$1,234,567.89");
});

test("puts the minus sign before the symbol", () => {
  assert.equal(formatMoney(-2550), "-$25.50");
});

test("supports EUR and GBP symbols", () => {
  assert.equal(formatMoney(1000, "EUR"), "€10.00");
  assert.equal(formatMoney(1000, "GBP"), "£10.00");
});

test("falls back to the code for unknown currencies", () => {
  assert.equal(formatMoney(1000, "JPY"), "JPY 10.00");
});

test("rejects non-integer cents", () => {
  assert.throws(() => formatMoney(10.5), TypeError);
});
`,
    "test/retry.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { retryWithBackoff } from "../src/retry.mjs";

// A fake sleep keeps the test deterministic and instant while still proving
// the delay schedule.
const makeSleep = () => {
  const delays = [];
  return { delays, sleep: async (ms) => { delays.push(ms); } };
};

test("returns the first successful value without sleeping", async () => {
  const { delays, sleep } = makeSleep();
  const result = await retryWithBackoff(async () => "ok", { sleep });
  assert.equal(result, "ok");
  assert.deepEqual(delays, []);
});

test("retries until it succeeds", async () => {
  const { delays, sleep } = makeSleep();
  let calls = 0;
  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("boom");
      return calls;
    },
    { sleep },
  );
  assert.equal(result, 3);
  assert.equal(delays.length, 2);
});

test("doubles the delay each attempt starting from baseDelayMs", async () => {
  const { delays, sleep } = makeSleep();
  await retryWithBackoff(
    async () => {
      throw new Error("always");
    },
    { attempts: 4, baseDelayMs: 100, sleep },
  ).catch(() => {});
  assert.deepEqual(delays, [100, 200, 400]);
});

test("throws the last error after exhausting attempts", async () => {
  const { sleep } = makeSleep();
  await assert.rejects(
    retryWithBackoff(
      async () => {
        throw new Error("final failure");
      },
      { attempts: 2, sleep },
    ),
    /final failure/,
  );
});

test("defaults to 3 attempts and a 50ms base delay", async () => {
  const { delays, sleep } = makeSleep();
  await retryWithBackoff(
    async () => {
      throw new Error("nope");
    },
    { sleep },
  ).catch(() => {});
  assert.deepEqual(delays, [50, 100]);
});
`,
  },
  objective: `This project has three unfinished modules. Each has a test file that fully
specifies its behaviour, and the three modules are completely independent of
each other.

  src/slug.mjs   - slugify(input, options)         (tests: test/slug.test.mjs)
  src/money.mjs  - formatMoney(cents, currency)    (tests: test/money.test.mjs)
  src/retry.mjs  - retryWithBackoff(fn, options)   (tests: test/retry.test.mjs)

Implement all three so that every test passes. Do not modify any file under
test/.

Verify with: node --test test/slug.test.mjs test/money.test.mjs test/retry.test.mjs`,
  grade: [
    nodeTest(
      ["test/slug.test.mjs", "test/money.test.mjs", "test/retry.test.mjs"],
      "all three module test suites pass",
    ),
  ],
};

// ---------------------------------------------------------------------------

const httpKit: BenchTask = {
  id: "parallel-httpkit",
  title: "Implement three independent HTTP helper modules",
  category: "implementation",
  rationale:
    "A second multi-module fixture in a different problem domain, so the result " +
    "does not rest on the peculiarities of one task.",
  requiresGit: true,
  immutable: ["test/query.test.mjs", "test/errors.test.mjs", "test/cursor.test.mjs"],
  files: {
    "src/query.mjs": `export function parseQuery(search) {
  throw new Error("not implemented");
}
`,
    "src/errors.mjs": `export function toHttpError(error) {
  throw new Error("not implemented");
}
`,
    "src/cursor.mjs": `export function encodeCursor(value) {
  throw new Error("not implemented");
}

export function decodeCursor(cursor) {
  throw new Error("not implemented");
}
`,
    "test/query.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { parseQuery } from "../src/query.mjs";

test("parses simple key/value pairs", () => {
  assert.deepEqual(parseQuery("a=1&b=two"), { a: 1, b: "two" });
});

test("accepts a leading question mark", () => {
  assert.deepEqual(parseQuery("?a=1"), { a: 1 });
});

test("coerces booleans and numbers, leaving other text alone", () => {
  assert.deepEqual(parseQuery("n=42&f=3.5&t=true&f2=false&s=hello"), {
    n: 42,
    f: 3.5,
    t: true,
    f2: false,
    s: "hello",
  });
});

test("decodes percent encoding", () => {
  assert.deepEqual(parseQuery("q=hello%20world&sym=%26"), { q: "hello world", sym: "&" });
});

test("collects repeated keys into an array", () => {
  assert.deepEqual(parseQuery("tag=a&tag=b&tag=c"), { tag: ["a", "b", "c"] });
});

test("treats a bare key as true and an empty value as empty string", () => {
  assert.deepEqual(parseQuery("flag&empty="), { flag: true, empty: "" });
});

test("returns an empty object for empty input", () => {
  assert.deepEqual(parseQuery(""), {});
  assert.deepEqual(parseQuery("?"), {});
});
`,
    "test/errors.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { toHttpError } from "../src/errors.mjs";

test("maps a known error code to its status", () => {
  const error = Object.assign(new Error("nope"), { code: "NOT_FOUND" });
  assert.deepEqual(toHttpError(error), {
    status: 404,
    code: "NOT_FOUND",
    message: "nope",
  });
});

test("maps the full code table", () => {
  const cases = [
    ["BAD_REQUEST", 400],
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["CONFLICT", 409],
    ["RATE_LIMITED", 429],
  ];
  for (const [code, status] of cases) {
    const error = Object.assign(new Error("x"), { code });
    assert.equal(toHttpError(error).status, status, code);
  }
});

test("falls back to 500 and INTERNAL for unknown codes", () => {
  const error = Object.assign(new Error("weird"), { code: "SOMETHING_ELSE" });
  assert.deepEqual(toHttpError(error), {
    status: 500,
    code: "INTERNAL",
    message: "Internal Server Error",
  });
});

test("hides the message of a 500 but keeps it for client errors", () => {
  const server = toHttpError(new Error("secret detail"));
  assert.equal(server.message, "Internal Server Error");

  const client = Object.assign(new Error("visible detail"), { code: "CONFLICT" });
  assert.equal(toHttpError(client).message, "visible detail");
});

test("honours an explicit numeric status on the error", () => {
  const error = Object.assign(new Error("teapot"), { status: 418 });
  assert.equal(toHttpError(error).status, 418);
  assert.equal(toHttpError(error).message, "teapot");
});
`,
    "test/cursor.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { decodeCursor, encodeCursor } from "../src/cursor.mjs";

test("round-trips an object", () => {
  const value = { id: 42, createdAt: "2024-01-01" };
  assert.deepEqual(decodeCursor(encodeCursor(value)), value);
});

test("produces url-safe output", () => {
  const cursor = encodeCursor({ q: "a+b/c=d?e&f" });
  assert.match(cursor, /^[A-Za-z0-9_-]+$/, cursor);
});

test("round-trips arrays and primitives", () => {
  assert.deepEqual(decodeCursor(encodeCursor([1, 2, 3])), [1, 2, 3]);
  assert.equal(decodeCursor(encodeCursor("plain")), "plain");
  assert.equal(decodeCursor(encodeCursor(7)), 7);
});

test("returns null for malformed input rather than throwing", () => {
  assert.equal(decodeCursor("!!!not base64!!!"), null);
  assert.equal(decodeCursor(""), null);
  assert.equal(decodeCursor(null), null);
});

test("different values produce different cursors", () => {
  assert.notEqual(encodeCursor({ id: 1 }), encodeCursor({ id: 2 }));
});
`,
  },
  objective: `This project has three unfinished modules. Each has a test file that fully
specifies its behaviour, and the three modules are completely independent of
each other.

  src/query.mjs   - parseQuery(search)                      (tests: test/query.test.mjs)
  src/errors.mjs  - toHttpError(error)                       (tests: test/errors.test.mjs)
  src/cursor.mjs  - encodeCursor(value) / decodeCursor(str)  (tests: test/cursor.test.mjs)

Implement all three so that every test passes. Do not modify any file under
test/.

Verify with: node --test test/query.test.mjs test/errors.test.mjs test/cursor.test.mjs`,
  grade: [
    nodeTest(
      ["test/query.test.mjs", "test/errors.test.mjs", "test/cursor.test.mjs"],
      "all three module test suites pass",
    ),
  ],
};

export const PARALLEL_TASKS: BenchTask[] = [toolkit, httpKit];
