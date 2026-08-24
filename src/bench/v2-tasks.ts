/**
 * Benchmark V2 fixtures.
 *
 * V2 keeps the legacy BenchTask contract intact while adding routing metadata
 * for experiments that force a particular delegation shape. Every fixture is
 * self-contained, offline, deterministic, and starts with a failing or
 * incomplete implementation.
 */
import type { BenchTask, GradeCommand } from "./tasks.js";

export type V2WorkloadClass = "small" | "medium" | "delegation-friendly" | "coupled";

export type ForcedDelegation =
  | {
      mode: "none";
      tool: "none";
      appropriate: boolean;
      reason: string;
    }
  | {
      mode: "single";
      tool: "delegate_task";
      appropriate: true;
      task: {
        title: string;
        objective: string;
        scope: string[];
      };
    }
  | {
      mode: "parallel";
      tool: "delegate_tasks";
      appropriate: true;
      tasks: Array<{
        id: string;
        objective: string;
        scope: string[];
      }>;
    };

export interface V2BenchTask extends BenchTask {
  workloadClass: V2WorkloadClass;
  forcedDelegation: ForcedDelegation;
}

const nodeTest = (files: string[], label: string): GradeCommand => ({
  file: process.execPath,
  args: ["--test", ...files],
  label,
});

const none = (appropriate: boolean, reason: string): ForcedDelegation => ({
  mode: "none",
  tool: "none",
  appropriate,
  reason,
});

const single = (title: string, objective: string, scope: string[]): ForcedDelegation => ({
  mode: "single",
  tool: "delegate_task",
  appropriate: true,
  task: { title, objective, scope },
});

const parallel = (
  tasks: Array<{ id: string; objective: string; scope: string[] }>,
): ForcedDelegation => ({
  mode: "parallel",
  tool: "delegate_tasks",
  appropriate: true,
  tasks,
});

// ---------------------------------------------------------------------------
// Small: clearly solo-friendly work.

const configOverlay: V2BenchTask = {
  id: "v2-config-overlay",
  title: "Implement a layered configuration overlay",
  category: "small",
  workloadClass: "small",
  tier: "A",
  streams: 1,
  rationale:
    "One focused configuration utility with a compact, executable contract; " +
    "the setup and review cost of delegation would dominate the implementation.",
  immutable: ["test/config.test.mjs"],
  files: {
    "src/config.mjs": `export function mergeConfig(base, patch) {
  throw new Error("not implemented");
}

export function parseEnvOverrides(entries, prefix = "APP") {
  throw new Error("not implemented");
}
`,
    "test/config.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig, parseEnvOverrides } from "../src/config.mjs";

test("deep-merges plain objects without mutating either input", () => {
  const base = { port: 3000, db: { host: "localhost", pool: 4 }, tags: ["api"] };
  const patch = { db: { pool: 8 }, tags: ["worker"], debug: true };
  assert.deepEqual(mergeConfig(base, patch), {
    port: 3000,
    db: { host: "localhost", pool: 8 },
    tags: ["worker"],
    debug: true,
  });
  assert.deepEqual(base, { port: 3000, db: { host: "localhost", pool: 4 }, tags: ["api"] });
  assert.deepEqual(patch, { db: { pool: 8 }, tags: ["worker"], debug: true });
});

test("undefined patch values leave an inherited setting unchanged", () => {
  assert.deepEqual(mergeConfig({ retries: 3, nested: { enabled: true } }, {
    retries: undefined,
    nested: { enabled: false },
  }), { retries: 3, nested: { enabled: false } });
});

test("environment entries become typed nested overrides", () => {
  assert.deepEqual(parseEnvOverrides([
    "APP__PORT=8080",
    "APP__FEATURES__CACHE=true",
    "APP__FEATURES__TRACE=false",
    "APP__NAME=service%20api",
    "OTHER__PORT=9999",
    "APP__EMPTY=",
  ]), {
    port: 8080,
    features: { cache: true, trace: false },
    name: "service api",
    empty: "",
  });
});

test("ignores malformed entries and is case-insensitive for the prefix", () => {
  assert.deepEqual(parseEnvOverrides(["bad", "app__PORT=4", "APP_PORT=5"], "APP"), { port: 4 });
});
`,
  },
  objective:
    "Implement src/config.mjs. mergeConfig(base, patch) must recursively merge plain objects, " +
    "replace arrays and scalar values, skip undefined patch values, and leave inputs untouched. " +
    "parseEnvOverrides(entries, prefix) must accept PREFIX__KEY=VALUE entries, build lower-case " +
    "nested keys, decode URI components, coerce true/false and finite decimal integers, and " +
    "ignore malformed or differently prefixed entries. Do not modify test/config.test.mjs.",
  forcedDelegation: none(
    false,
    "A single small module has a short feedback loop and no natural independent workstream.",
  ),
  grade: [nodeTest(["test/config.test.mjs"], "configuration overlay tests pass")],
};

const rateLimiterTests: V2BenchTask = {
  id: "v2-rate-limiter-tests",
  title: "Author contract tests for a fixed-window rate limiter",
  category: "small",
  workloadClass: "small",
  tier: "A",
  streams: 1,
  rationale:
    "A bounded test-authoring task around one existing class; mutation grading makes " +
    "coverage quality objective while keeping the work comfortably solo-sized.",
  immutable: ["src/rate-limit.mjs"],
  files: {
    "src/rate-limit.mjs": `export class FixedWindowLimiter {
  #limit;
  #windowMs;
  #now;
  #windows = new Map();

  constructor({ limit, windowMs, now = Date.now } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be positive");
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError("windowMs must be positive");
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  allow(key) {
    const current = this.#now();
    let window = this.#windows.get(key);
    if (!window || current >= window.resetAt) {
      window = { count: 0, resetAt: current + this.#windowMs };
      this.#windows.set(key, window);
    }
    if (window.count >= this.#limit) {
      return { allowed: false, remaining: 0, resetAt: window.resetAt };
    }
    window.count += 1;
    return {
      allowed: true,
      remaining: this.#limit - window.count,
      resetAt: window.resetAt,
    };
  }
}
`,
  },
  objective:
    "Create test/rate-limit.test.mjs using node:test and node:assert/strict. Test constructor " +
    "validation, that a key can consume exactly its limit, that the next request is denied " +
    "with remaining 0, that a request at the exact reset boundary starts a new window, and " +
    "that keys have independent windows. Use an injected clock so tests are deterministic. " +
    "Do not modify src/rate-limit.mjs.",
  forcedDelegation: none(
    false,
    "The deliverable is one focused test file and mutation feedback is immediate.",
  ),
  grade: [nodeTest(["test/rate-limit.test.mjs"], "authored rate-limiter tests pass")],
  mutation: {
    file: "src/rate-limit.mjs",
    content: `export class FixedWindowLimiter {
  #limit;
  #windowMs;
  #now;
  #windows = new Map();

  constructor({ limit, windowMs, now = Date.now } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be positive");
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError("windowMs must be positive");
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  allow(key) {
    const current = this.#now();
    let window = this.#windows.get(key);
    if (!window || current > window.resetAt) {
      window = { count: 0, resetAt: current + this.#windowMs };
      this.#windows.set(key, window);
    }
    if (window.count >= this.#limit) {
      return { allowed: false, remaining: 0, resetAt: window.resetAt };
    }
    window.count += 1;
    return { allowed: true, remaining: this.#limit - window.count, resetAt: window.resetAt };
  }
}
`,
    command: nodeTest(
      ["test/rate-limit.test.mjs"],
      "tests catch a boundary-window mutation",
    ),
  },
};

// ---------------------------------------------------------------------------
// Medium: routing-ambiguous work where one substantial worker can help, but
// the supervisor still has a plausible solo path.

const frontmatter: V2BenchTask = {
  id: "v2-frontmatter-parser",
  title: "Implement a Markdown front-matter parser",
  category: "medium",
  workloadClass: "medium",
  tier: "B",
  streams: 1,
  rationale:
    "A self-contained parser with several edge cases and a meaningful review surface; " +
    "it can be handed to one worker, but its size remains reasonable for a careful solo pass.",
  immutable: ["test/frontmatter.test.mjs"],
  files: {
    "src/frontmatter.mjs": `export function parseDocument(source) {
  throw new Error("not implemented");
}
`,
    "test/frontmatter.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument } from "../src/frontmatter.mjs";

test("parses front matter and preserves the Markdown body", () => {
  assert.deepEqual(parseDocument("---\\ntitle: Hello\\npublished: true\\ncount: 3\\n---\\n# Body\\n\\nText"), {
    data: { title: "Hello", published: true, count: 3 },
    content: "# Body\\n\\nText",
  });
});

test("supports quoted strings, null, and comma-separated arrays", () => {
  assert.deepEqual(parseDocument("---\\ntitle: \\\"A: guide\\\"\\ntags: one, two, \\\"three, four\\\"\\ndraft: null\\n...\\nbody"), {
    data: { title: "A: guide", tags: ["one", "two", "three, four"], draft: null },
    content: "body",
  });
});

test("returns an empty data object when no front matter is present", () => {
  assert.deepEqual(parseDocument("# Just Markdown\\n"), { data: {}, content: "# Just Markdown\\n" });
});

test("ignores comments and trims keys and values", () => {
  assert.deepEqual(parseDocument("---\\n# comment\\n title :  hello  \\nactive: false\\n---\\nbody"), {
    data: { title: "hello", active: false },
    content: "body",
  });
});

test("rejects malformed, duplicate, and unterminated metadata", () => {
  assert.throws(() => parseDocument("---\\ntitle\\n---\\nbody"), /metadata/i);
  assert.throws(() => parseDocument("---\\na: 1\\na: 2\\n---\\nbody"), /duplicate/i);
  assert.throws(() => parseDocument("---\\ntitle: x\\nbody"), /unterminated/i);
});
`,
  },
  objective:
    "Implement src/frontmatter.mjs with parseDocument(source). A document has optional metadata " +
    "only when its first line is ---; metadata ends at --- or ..., each non-comment line is a " +
    "trimmed key:value pair, duplicate keys and missing colons are errors, and the body is " +
    "returned unchanged after the closing marker. Parse quoted strings, null, booleans, finite " +
    "numbers, and comma-separated arrays (respecting quoted commas). Do not modify the tests.",
  forcedDelegation: single(
    "Implement and review the Markdown metadata parser",
    "Implement src/frontmatter.mjs against the immutable edge-case suite, including marker detection, scalar coercion, quoted arrays, duplicate-key rejection, and exact body preservation. Run the supplied node:test grade before returning.",
    ["src/frontmatter.mjs"],
  ),
  grade: [nodeTest(["test/frontmatter.test.mjs"], "front-matter parser tests pass")],
};

const workerPool: V2BenchTask = {
  id: "v2-worker-pool",
  title: "Implement an order-preserving asynchronous worker pool",
  category: "medium",
  workloadClass: "medium",
  tier: "B",
  streams: 1,
  rationale:
    "Concurrency, ordering, validation, and rejection propagation create a substantial " +
    "debugging surface, but all behavior lives behind one coherent API.",
  immutable: ["test/worker-pool.test.mjs"],
  files: {
    "src/worker-pool.mjs": `export async function runPool(items, worker, options = {}) {
  throw new Error("not implemented");
}
`,
    "test/worker-pool.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { runPool } from "../src/worker-pool.mjs";

const ticks = async (count) => {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
};

test("returns results in input order despite out-of-order completion", async () => {
  const result = await runPool([0, 1, 2, 3, 4], async (value) => {
    await ticks(10 - value * 2);
    return value * 2;
  }, { concurrency: 2 });
  assert.deepEqual(result, [0, 2, 4, 6, 8]);
});

test("never exceeds the configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const result = await runPool([1, 2, 3, 4, 5, 6], async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await ticks(2);
    active -= 1;
    return value;
  }, { concurrency: 3 });
  assert.equal(peak, 3);
  assert.deepEqual(result, [1, 2, 3, 4, 5, 6]);
});

test("handles empty input and passes the index to workers", async () => {
  assert.deepEqual(await runPool([], async (value) => value), []);
  assert.deepEqual(await runPool(["a", "b"], async (value, index) => value + index, { concurrency: 1 }), ["a0", "b1"]);
});

test("propagates a worker rejection", async () => {
  await assert.rejects(runPool([1, 2, 3], async (value) => {
    if (value === 2) throw new Error("bad item");
    return value;
  }, { concurrency: 2 }), /bad item/);
});

test("rejects invalid concurrency values", async () => {
  await assert.rejects(runPool([1], async (value) => value, { concurrency: 0 }), /concurrency/i);
  await assert.rejects(runPool([1], async (value) => value, { concurrency: 1.5 }), /concurrency/i);
});
`,
  },
  objective:
    "Implement src/worker-pool.mjs with runPool(items, worker, { concurrency }). It must validate " +
    "a positive integer concurrency, run at most that many workers at once, pass each item and its " +
    "original index, preserve input order in the returned array even when promises finish out of " +
    "order, handle empty input, and reject when a worker rejects. Do not modify the tests.",
  forcedDelegation: single(
    "Implement and verify the asynchronous worker pool",
    "Implement src/worker-pool.mjs using the immutable tests as the contract. Preserve order, enforce the concurrency cap, propagate failures, validate options, and run the full node:test grade.",
    ["src/worker-pool.mjs"],
  ),
  grade: [nodeTest(["test/worker-pool.test.mjs"], "worker-pool tests pass")],
};

// ---------------------------------------------------------------------------
// Delegation-friendly: each fixture has natural, disjoint module scopes. The
// first has four substantial streams and is intentionally large enough that a
// forced parallel run has a plausible crossover against a strong solo pass.

const integrationToolkit: V2BenchTask = {
  id: "v2-integration-toolkit",
  title: "Build four independent service-integration utilities",
  category: "delegation-friendly",
  workloadClass: "delegation-friendly",
  tier: "C",
  streams: 4,
  requiresGit: true,
  rationale:
    "Four production-shaped utilities have separate APIs, specifications, and tests. Their " +
    "combined depth is substantial while their file scopes are genuinely disjoint, making " +
    "parallel delegation a meaningful routing candidate rather than a toy fan-out.",
  immutable: [
    "test/route-key.test.mjs",
    "test/money.test.mjs",
    "test/retry.test.mjs",
    "test/headers.test.mjs",
  ],
  files: {
    "src/route-key.mjs": `export function toRouteKey(input, options = {}) {
  throw new Error("not implemented");
}
`,
    "src/money.mjs": `export function formatCents(cents, currency = "USD") {
  throw new Error("not implemented");
}

export function parseCents(value, currency = "USD") {
  throw new Error("not implemented");
}
`,
    "src/retry.mjs": `export async function retry(operation, options = {}) {
  throw new Error("not implemented");
}
`,
    "src/headers.mjs": `export class HeaderBag {
  constructor(initial = {}) {
    throw new Error("not implemented");
  }
}
`,
    "test/route-key.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { toRouteKey } from "../src/route-key.mjs";

test("normalizes case, accents, punctuation, and ampersands", () => {
  assert.equal(toRouteKey("  Café & Bistro / West  "), "cafe-and-bistro-west");
});

test("collapses separators and keeps digits", () => {
  assert.equal(toRouteKey("Release---2026__Q3"), "release-2026-q3");
});

test("truncates at a word boundary", () => {
  assert.equal(toRouteKey("the quick brown fox", { maxLength: 12 }), "the-quick");
});

test("hard-truncates a first word longer than the limit", () => {
  assert.equal(toRouteKey("supercalifragilistic", { maxLength: 6 }), "superc");
});

test("returns an empty key for punctuation-only input", () => {
  assert.equal(toRouteKey("!!!"), "");
});

test("rejects invalid maxLength", () => {
  assert.throws(() => toRouteKey("hello", { maxLength: 0 }), /maxLength/i);
});
`,
    "test/money.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { formatCents, parseCents } from "../src/money.mjs";

test("formats currencies with grouping and two decimals", () => {
  assert.equal(formatCents(123456), "$1,234.56");
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(-2550), "-$25.50");
  assert.equal(formatCents(1000, "EUR"), "€10.00");
  assert.equal(formatCents(1000, "GBP"), "£10.00");
});

test("uses an ISO code for unknown currencies", () => {
  assert.equal(formatCents(1250, "JPY"), "JPY 12.50");
});

test("parses symbols, codes, commas, and negative values", () => {
  assert.equal(parseCents("$1,234.50"), 123450);
  assert.equal(parseCents("EUR 2.05", "EUR"), 205);
  assert.equal(parseCents("-0.99"), -99);
});

test("rejects malformed or over-precise amounts", () => {
  assert.throws(() => parseCents("$1.234"), /amount/i);
  assert.throws(() => parseCents("not money"), /amount/i);
  assert.throws(() => formatCents(1.5), /integer/i);
});
`,
    "test/retry.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { retry } from "../src/retry.mjs";

test("returns a first-attempt result without sleeping", async () => {
  const delays = [];
  assert.equal(await retry(async () => "ok", { sleep: async (ms) => delays.push(ms) }), "ok");
  assert.deepEqual(delays, []);
});

test("uses exponential delays between failed attempts", async () => {
  const delays = [];
  let calls = 0;
  const value = await retry(async () => {
    calls += 1;
    if (calls < 3) throw new Error("temporary");
    return "done";
  }, { attempts: 4, baseDelayMs: 25, sleep: async (ms) => delays.push(ms) });
  assert.equal(value, "done");
  assert.deepEqual(delays, [25, 50]);
});

test("throws the final error after exhausting attempts", async () => {
  const delays = [];
  await assert.rejects(retry(async () => { throw new Error("permanent"); }, {
    attempts: 3,
    sleep: async (ms) => delays.push(ms),
  }), /permanent/);
  assert.deepEqual(delays, [50, 100]);
});

test("can stop retrying with a predicate and validates attempts", async () => {
  let calls = 0;
  await assert.rejects(retry(async () => {
    calls += 1;
    throw new Error("stop");
  }, { attempts: 5, shouldRetry: () => false, sleep: async () => {} }), /stop/);
  assert.equal(calls, 1);
  await assert.rejects(retry(async () => "x", { attempts: 0 }), /attempts/i);
});
`,
    "test/headers.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { HeaderBag } from "../src/headers.mjs";

test("looks up and replaces names case-insensitively", () => {
  const headers = new HeaderBag({ "Content-Type": "application/json", Accept: "text/plain" });
  assert.equal(headers.get("content-type"), "application/json");
  headers.set("CONTENT-TYPE", "text/event-stream");
  assert.equal(headers.get("Content-Type"), "text/event-stream");
  assert.equal(headers.has("accept"), true);
});

test("appends duplicate values using HTTP list syntax", () => {
  const headers = new HeaderBag();
  headers.append("Vary", "Accept");
  headers.append("vary", "Origin");
  assert.equal(headers.get("VARY"), "Accept, Origin");
});

test("deletes entries and exposes deterministic canonical output", () => {
  const headers = new HeaderBag({ Zeta: "z", alpha: "a", Empty: "" });
  headers.delete("EMPTY");
  assert.deepEqual(headers.toObject(), { alpha: "a", Zeta: "z" });
});

test("rejects invalid names and values", () => {
  const headers = new HeaderBag();
  assert.throws(() => headers.set("bad name", "x"), /header/i);
  assert.throws(() => headers.set("X-Test", "line\\nbreak"), /header/i);
});
`,
  },
  objective:
    "Implement all four independent modules, preserving the immutable tests. " +
    "src/route-key.mjs must export toRouteKey with accent removal, separator normalization, " +
    "ampersand expansion, and maxLength handling. src/money.mjs must export formatCents and " +
    "parseCents for grouped signed amounts and symbols/codes. src/retry.mjs must export retry " +
    "with injected sleep, exponential delays, final-error propagation, and shouldRetry. " +
    "src/headers.mjs must export a case-insensitive HeaderBag with set/get/has/append/delete and " +
    "sorted canonical output. Do not modify any test file.",
  forcedDelegation: parallel([
    {
      id: "route-key",
      objective:
        "Implement and test src/route-key.mjs only; run test/route-key.test.mjs.",
      scope: ["src/route-key.mjs", "test/route-key.test.mjs (read-only)"],
    },
    {
      id: "money",
      objective: "Implement and test src/money.mjs only; run test/money.test.mjs.",
      scope: ["src/money.mjs", "test/money.test.mjs (read-only)"],
    },
    {
      id: "retry",
      objective: "Implement and test src/retry.mjs only; run test/retry.test.mjs.",
      scope: ["src/retry.mjs", "test/retry.test.mjs (read-only)"],
    },
    {
      id: "headers",
      objective: "Implement and test src/headers.mjs only; run test/headers.test.mjs.",
      scope: ["src/headers.mjs", "test/headers.test.mjs (read-only)"],
    },
  ]),
  grade: [
    nodeTest(
      [
        "test/route-key.test.mjs",
        "test/money.test.mjs",
        "test/retry.test.mjs",
        "test/headers.test.mjs",
      ],
      "all four integration utilities pass",
    ),
  ],
};

const dataContracts: V2BenchTask = {
  id: "v2-data-contracts",
  title: "Implement three independent data-contract utilities",
  category: "delegation-friendly",
  workloadClass: "delegation-friendly",
  tier: "C",
  streams: 3,
  requiresGit: true,
  rationale:
    "JSON Patch, entity-tag comparison, and a circuit breaker are realistic service-layer " +
    "components with separate APIs and tests. They are independent enough for parallel workers " +
    "but each has enough edge cases to make the fixture substantive.",
  immutable: [
    "test/jsonpatch.test.mjs",
    "test/etag.test.mjs",
    "test/circuit-breaker.test.mjs",
  ],
  files: {
    "src/jsonpatch.mjs": `export function applyPatch(document, operations) {
  throw new Error("not implemented");
}
`,
    "src/etag.mjs": `export function makeEtag(value, options = {}) {
  throw new Error("not implemented");
}

export function matchesIfNoneMatch(current, header) {
  throw new Error("not implemented");
}
`,
    "src/circuit-breaker.mjs": `export class CircuitBreaker {
  constructor(options = {}) {
    throw new Error("not implemented");
  }
}
`,
    "test/jsonpatch.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { applyPatch } from "../src/jsonpatch.mjs";

test("applies add, replace, and remove without mutating the source", () => {
  const source = { user: { name: "Ada" }, tags: ["one", "two"] };
  const result = applyPatch(source, [
    { op: "replace", path: "/user/name", value: "Grace" },
    { op: "add", path: "/user/role", value: "admin" },
    { op: "remove", path: "/tags/0" },
  ]);
  assert.deepEqual(result, { user: { name: "Grace", role: "admin" }, tags: ["two"] });
  assert.deepEqual(source, { user: { name: "Ada" }, tags: ["one", "two"] });
});

test("supports array append, copy, and move", () => {
  assert.deepEqual(applyPatch({ a: [1, 2], b: {} }, [
    { op: "add", path: "/a/-", value: 3 },
    { op: "copy", from: "/a/0", path: "/b/first" },
    { op: "move", from: "/a/1", path: "/b/moved" },
  ]), { a: [1, 3], b: { first: 1, moved: 2 } });
});

test("test operations compare values and invalid operations fail", () => {
  assert.deepEqual(applyPatch({ ok: true }, [{ op: "test", path: "/ok", value: true }]), { ok: true });
  assert.throws(() => applyPatch({ ok: true }, [{ op: "test", path: "/ok", value: false }]), /test/i);
  assert.throws(() => applyPatch({}, [{ op: "remove", path: "/missing" }]), /path/i);
  assert.throws(() => applyPatch({}, [{ op: "unknown", path: "/x" }]), /operation/i);
});
`,
    "test/etag.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { makeEtag, matchesIfNoneMatch } from "../src/etag.mjs";

test("creates stable quoted tags independent of object key insertion order", () => {
  assert.equal(makeEtag({ b: 2, a: 1 }), makeEtag({ a: 1, b: 2 }));
  assert.match(makeEtag({ a: 1 }), new RegExp('^"[0-9a-f]+"$'));
  assert.match(makeEtag({ a: 1 }, { weak: true }), new RegExp('^W/"[0-9a-f]+"$'));
});

test("matches a current tag in a comma-separated If-None-Match header", () => {
  const current = makeEtag({ version: 4 });
  assert.equal(matchesIfNoneMatch(current, "\\\"other\\\", W/" + current), true);
  assert.equal(matchesIfNoneMatch(current, "*"), true);
  assert.equal(matchesIfNoneMatch(current, "\\\"other\\\""), false);
  assert.equal(matchesIfNoneMatch(undefined, "*"), false);
});
`,
    "test/circuit-breaker.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { CircuitBreaker } from "../src/circuit-breaker.mjs";

test("opens after the failure threshold and rejects while open", async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => 0 });
  await assert.rejects(breaker.execute(async () => { throw new Error("one"); }), /one/);
  await assert.rejects(breaker.execute(async () => { throw new Error("two"); }), /two/);
  assert.equal(breaker.state, "open");
  await assert.rejects(breaker.execute(async () => "blocked"), /open/i);
});

test("allows one half-open probe after cooldown and closes on success", async () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50, now: () => now });
  await assert.rejects(breaker.execute(async () => { throw new Error("down"); }));
  now = 50;
  assert.equal(await breaker.execute(async () => "up"), "up");
  assert.equal(breaker.state, "closed");
});

test("a half-open failure reopens the breaker", async () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10, now: () => now });
  await assert.rejects(breaker.execute(async () => { throw new Error("down"); }));
  now = 10;
  await assert.rejects(breaker.execute(async () => { throw new Error("still down"); }), /still down/);
  assert.equal(breaker.state, "open");
});
`,
  },
  objective:
    "Implement the three independent modules named in this request: src/jsonpatch.mjs must export " +
    "applyPatch with add/replace/remove/copy/move/test and JSON Pointer paths without mutating the " +
    "input; src/etag.mjs must export stable key-order-independent makeEtag and weak-aware " +
    "matchesIfNoneMatch; src/circuit-breaker.mjs must export a clock-injectable CircuitBreaker " +
    "with closed/open/half-open transitions, a failure threshold, and cooldown. Do not edit tests.",
  forcedDelegation: parallel([
    {
      id: "jsonpatch",
      objective:
        "Implement and test src/jsonpatch.mjs only; run test/jsonpatch.test.mjs.",
      scope: ["src/jsonpatch.mjs", "test/jsonpatch.test.mjs (read-only)"],
    },
    {
      id: "etag",
      objective: "Implement and test src/etag.mjs only; run test/etag.test.mjs.",
      scope: ["src/etag.mjs", "test/etag.test.mjs (read-only)"],
    },
    {
      id: "circuit-breaker",
      objective:
        "Implement and test src/circuit-breaker.mjs only; run test/circuit-breaker.test.mjs.",
      scope: ["src/circuit-breaker.mjs", "test/circuit-breaker.test.mjs (read-only)"],
    },
  ]),
  grade: [
    nodeTest(
      ["test/jsonpatch.test.mjs", "test/etag.test.mjs", "test/circuit-breaker.test.mjs"],
      "all three data-contract utilities pass",
    ),
  ],
};

const repositoryTools: V2BenchTask = {
  id: "v2-repository-tools",
  title: "Implement three independent repository policy utilities",
  category: "delegation-friendly",
  workloadClass: "delegation-friendly",
  tier: "C",
  streams: 3,
  requiresGit: true,
  rationale:
    "Manifest validation, artifact path policy, and change-set summarization mirror common " +
    "repository automation responsibilities. Each has its own immutable contract and natural " +
    "worker scope, with enough edge cases to make parallel work worthwhile.",
  immutable: [
    "test/manifest.test.mjs",
    "test/path-policy.test.mjs",
    "test/change-set.test.mjs",
  ],
  files: {
    "src/manifest.mjs": `export function validateManifest(manifest) {
  throw new Error("not implemented");
}
`,
    "src/path-policy.mjs": `export function assertSafeRelativePath(root, candidate) {
  throw new Error("not implemented");
}
`,
    "src/change-set.mjs": `export function summarizeChanges(changes) {
  throw new Error("not implemented");
}
`,
    "test/manifest.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { validateManifest } from "../src/manifest.mjs";

test("accepts a valid package manifest and normalizes its name", () => {
  assert.deepEqual(validateManifest({
    name: "@Acme/Widget",
    version: "1.2.3",
    type: "module",
    scripts: { test: "node --test" },
  }), { valid: true, errors: [], normalizedName: "@acme/widget" });
});

test("reports sorted field errors", () => {
  const result = validateManifest({ name: "Bad Name", version: "1.2", type: "commonjs" });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.field), ["name", "scripts", "version"]);
});

test("rejects invalid package names, versions, and script shapes", () => {
  assert.equal(validateManifest({
    name: "ok-name",
    version: "0.0.1-beta.1",
    type: "commonjs",
    scripts: { test: "node --test" },
  }).valid, true);
  assert.equal(validateManifest({ name: "ok", version: "1.0.0", type: "module", scripts: {} }).valid, false);
});
`,
    "test/path-policy.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { assertSafeRelativePath } from "../src/path-policy.mjs";

test("resolves safe normalized paths beneath the repository root", () => {
  assert.equal(assertSafeRelativePath("/repo", "dist/app.js"), path.resolve("/repo", "dist/app.js"));
  assert.equal(assertSafeRelativePath("/repo", "./dist/../src/index.js"), path.resolve("/repo", "src/index.js"));
});

test("rejects traversal, absolute, and empty candidates", () => {
  for (const candidate of ["../outside.txt", "/etc/passwd", "", "./", "a/../../b"]) {
    assert.throws(() => assertSafeRelativePath("/repo", candidate), /path/i, candidate);
  }
});

test("rejects Windows-style traversal even on a POSIX runner", () => {
  assert.throws(() => assertSafeRelativePath("/repo", "..\\\\secret.txt"), /path/i);
});
`,
    "test/change-set.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { summarizeChanges } from "../src/change-set.mjs";

test("sorts files and counts added, modified, and deleted changes", () => {
  assert.deepEqual(summarizeChanges([
    { path: "src/z.mjs", status: "modified", linesAdded: 4, linesDeleted: 1 },
    { path: "README.md", status: "added", linesAdded: 20, linesDeleted: 0 },
    { path: "src/a.mjs", status: "deleted", linesAdded: 0, linesDeleted: 12 },
  ]), {
    files: [
      { path: "README.md", status: "added", linesAdded: 20, linesDeleted: 0 },
      { path: "src/a.mjs", status: "deleted", linesAdded: 0, linesDeleted: 12 },
      { path: "src/z.mjs", status: "modified", linesAdded: 4, linesDeleted: 1 },
    ],
    counts: { added: 1, modified: 1, deleted: 1 },
    linesAdded: 24,
    linesDeleted: 13,
    risk: "high",
  });
});

test("deduplicates repeated paths by keeping the latest status", () => {
  assert.deepEqual(summarizeChanges([
    { path: "src/a.mjs", status: "added", linesAdded: 5, linesDeleted: 0 },
    { path: "src/a.mjs", status: "modified", linesAdded: 2, linesDeleted: 1 },
  ]).counts, { added: 0, modified: 1, deleted: 0 });
});

test("uses low risk for documentation-only changes and validates input", () => {
  assert.equal(summarizeChanges([{ path: "README.md", status: "modified", linesAdded: 1, linesDeleted: 0 }]).risk, "low");
  assert.throws(() => summarizeChanges([{ path: "x", status: "unknown" }]), /status/i);
});
`,
  },
  objective:
    "Implement the three independent repository utilities. src/manifest.mjs must validate a " +
    "package-like manifest (scoped/lowercase name, semver, module/commonjs type, and a test script) " +
    "with sorted errors and normalizedName. src/path-policy.mjs must resolve only non-empty relative " +
    "paths that remain beneath root, rejecting POSIX and Windows traversal. src/change-set.mjs must " +
    "deduplicate by latest path, sort files, count statuses and line totals, and classify risk. Do " +
    "not modify any test file.",
  forcedDelegation: parallel([
    {
      id: "manifest",
      objective: "Implement and test src/manifest.mjs only; run test/manifest.test.mjs.",
      scope: ["src/manifest.mjs", "test/manifest.test.mjs (read-only)"],
    },
    {
      id: "path-policy",
      objective:
        "Implement and test src/path-policy.mjs only; run test/path-policy.test.mjs.",
      scope: ["src/path-policy.mjs", "test/path-policy.test.mjs (read-only)"],
    },
    {
      id: "change-set",
      objective:
        "Implement and test src/change-set.mjs only; run test/change-set.test.mjs.",
      scope: ["src/change-set.mjs", "test/change-set.test.mjs (read-only)"],
    },
  ]),
  grade: [
    nodeTest(
      ["test/manifest.test.mjs", "test/path-policy.test.mjs", "test/change-set.test.mjs"],
      "all three repository utilities pass",
    ),
  ],
};

// ---------------------------------------------------------------------------
// Coupled control: one integrated feature whose boundaries are intentionally
// internal and whose state transitions must be reviewed together.

const checkoutEngine: V2BenchTask = {
  id: "v2-checkout-engine",
  title: "Implement an idempotent inventory-aware checkout engine",
  category: "coupled",
  workloadClass: "coupled",
  tier: "coupled",
  streams: 1,
  rationale:
    "Pricing, coupon application, inventory reservation, shipping, tax, and idempotent commits " +
    "share state and invariants. Splitting them would create integration conflicts, so this is a " +
    "control against assuming every large fixture should be delegated.",
  immutable: ["test/checkout.test.mjs"],
  files: {
    "src/checkout.mjs": `export function createCheckout(options = {}) {
  throw new Error("not implemented");
}
`,
    "test/checkout.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { createCheckout } from "../src/checkout.mjs";

const makeCheckout = () => createCheckout({
  catalog: {
    sku1: { name: "Notebook", priceCents: 1200, stock: 5 },
    sku2: { name: "Pen", priceCents: 250, stock: 10 },
  },
  taxRate: 0.1,
  shippingRates: { standard: 500, express: 1200 },
  coupons: { SAVE10: { kind: "percent", value: 10 }, FLAT5: { kind: "fixed", value: 500 } },
});

test("quotes line items, discounts, shipping, tax, and total", () => {
  const checkout = makeCheckout();
  assert.deepEqual(checkout.quote({
    id: "order-1",
    items: [{ sku: "sku1", quantity: 2 }, { sku: "sku2", quantity: 1 }],
    coupon: "SAVE10",
    shipping: "standard",
  }), {
    subtotalCents: 2650,
    discountCents: 265,
    shippingCents: 500,
    taxableCents: 2385,
    taxCents: 239,
    totalCents: 3124,
    items: [
      { sku: "sku1", name: "Notebook", quantity: 2, unitPriceCents: 1200, lineTotalCents: 2400 },
      { sku: "sku2", name: "Pen", quantity: 1, unitPriceCents: 250, lineTotalCents: 250 },
    ],
  });
});

test("commit reserves inventory and repeats safely by order id", () => {
  const checkout = makeCheckout();
  const order = { id: "order-2", items: [{ sku: "sku1", quantity: 2 }], shipping: "express" };
  const first = checkout.commit(order);
  const second = checkout.commit(order);
  assert.deepEqual(second, first);
  assert.equal(checkout.stock("sku1"), 3);
});

test("rejects insufficient stock, invalid quantities, and unknown coupons", () => {
  const checkout = makeCheckout();
  assert.throws(() => checkout.quote({ id: "x", items: [{ sku: "sku1", quantity: 6 }] }), /stock/i);
  assert.throws(() => checkout.quote({ id: "y", items: [{ sku: "sku1", quantity: 0 }] }), /quantity/i);
  assert.throws(() => checkout.quote({ id: "z", items: [{ sku: "sku1", quantity: 1 }], coupon: "NOPE" }), /coupon/i);
});

test("fixed discounts cannot make the taxable amount negative", () => {
  const checkout = makeCheckout();
  const quote = checkout.quote({ id: "order-3", items: [{ sku: "sku2", quantity: 1 }], coupon: "FLAT5" });
  assert.equal(quote.discountCents, 250);
  assert.equal(quote.taxableCents, 0);
  assert.equal(quote.totalCents, 500);
});
`,
  },
  objective:
    "Implement src/checkout.mjs with createCheckout({ catalog, taxRate, shippingRates, coupons }). " +
    "The returned object must quote and commit orders: validate positive integer quantities and stock, " +
    "calculate line totals/subtotal, apply percent or fixed coupons without negative taxable amounts, " +
    "add selected shipping and rounded tax, preserve deterministic item output, decrement stock only on " +
    "commit, return the same committed result for a repeated order id, and expose stock(sku). Keep all " +
    "checkout invariants together and do not edit test/checkout.test.mjs.",
  forcedDelegation: none(
    false,
    "Pricing, inventory, shipping, tax, and idempotency share mutable state and must be reviewed as one coupled control.",
  ),
  grade: [nodeTest(["test/checkout.test.mjs"], "coupled checkout tests pass")],
};

export const V2_TASKS: V2BenchTask[] = [
  configOverlay,
  rateLimiterTests,
  frontmatter,
  workerPool,
  integrationToolkit,
  dataContracts,
  repositoryTools,
  checkoutEngine,
];

export const getV2Tasks = (ids: string[]): V2BenchTask[] =>
  ids.length === 0 ? V2_TASKS : V2_TASKS.filter((task) => ids.includes(task.id));
