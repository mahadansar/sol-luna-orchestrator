/**
 * Scale suite: fixtures built to locate the solo/orchestrated crossover.
 *
 * The existing `parallel` suite settled a narrower question — parallel
 * delegation beats sequential delegation — but every fixture in it sits far
 * below any break-even point, so it cannot say when orchestration is worth
 * choosing over a supervisor working alone.
 *
 * These fixtures were sized from the previous suite's own numbers rather than
 * guessed. Decomposing four mandated-parallel runs into "slowest worker" and
 * "everything else" gave:
 *
 *   orchestration overhead   62, 64, 66, 81 s   (median 65, near-constant)
 *   Luna per small module    51-121 s           (median 62)
 *   Sol solo per small module 19-28 s           (median 21)
 *
 * Modelling a run of N independent modules as
 *
 *   solo      ~ N * sol_per_module
 *   parallel  ~ luna_per_module + 65            (when concurrency >= N)
 *
 * predicts crossover near N = 6 at the old module size: overhead is fixed, so
 * stream *count* moves the result far more than stream depth. The ladder below
 * therefore varies N while holding module depth roughly constant at about twice
 * the old fixtures, which is also the smallest size that is plausibly worth
 * handing to another model at all.
 *
 * `scale-coupled` is the control for the opposite claim: work whose internal
 * boundaries are the implementer's to choose, where decomposition should cost
 * more than it saves. Without it this suite would only measure cases chosen to
 * favour orchestration.
 *
 * No sleeps, no padding, no arm-specific hints. Every arm gets the same
 * objective text, the same acceptance commands and the same immutable files.
 */
import type { BenchTask, GradeCommand } from "./tasks.js";

const nodeTest = (files: string[], label: string): GradeCommand => ({
  file: process.execPath,
  args: ["--test", ...files],
  label,
});

// ---------------------------------------------------------------------------
// Tier B - four independent modules
// ---------------------------------------------------------------------------

const POINTER_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { get, set, remove } from "../src/jsonpointer.mjs";

const doc = () => ({
  foo: ["bar", "baz"],
  "": 0,
  "a/b": 1,
  "c%d": 2,
  "e^f": 3,
  "m~n": 8,
  nested: { deep: { value: 42 } },
});

test("an empty pointer selects the whole document", () => {
  const d = doc();
  assert.equal(get(d, ""), d);
});

test("pointers walk objects and arrays", () => {
  assert.deepEqual(get(doc(), "/foo"), ["bar", "baz"]);
  assert.equal(get(doc(), "/foo/0"), "bar");
  assert.equal(get(doc(), "/foo/1"), "baz");
  assert.equal(get(doc(), "/nested/deep/value"), 42);
});

test("the empty string is a valid key", () => {
  assert.equal(get(doc(), "/"), 0);
});

test("escapes are decoded: ~1 is a slash and ~0 is a tilde", () => {
  assert.equal(get(doc(), "/a~1b"), 1);
  assert.equal(get(doc(), "/m~0n"), 8);
});

test("~01 decodes to ~1, not to a slash", () => {
  assert.equal(get({ "~1": 9 }, "/~01"), 9);
});

test("missing paths read as undefined rather than throwing", () => {
  assert.equal(get(doc(), "/nope"), undefined);
  assert.equal(get(doc(), "/nested/missing/value"), undefined);
  assert.equal(get(doc(), "/foo/9"), undefined);
});

test("a non-empty pointer must start with a slash", () => {
  assert.throws(() => get(doc(), "foo"), /invalid pointer/i);
  assert.throws(() => set(doc(), "foo", 1), /invalid pointer/i);
});

test("set writes through objects and returns the document", () => {
  const d = doc();
  assert.equal(set(d, "/nested/deep/value", 7), d);
  assert.equal(d.nested.deep.value, 7);
});

test("set creates missing intermediate objects", () => {
  const d = {};
  set(d, "/a/b/c", 1);
  assert.deepEqual(d, { a: { b: { c: 1 } } });
});

test("set replaces an array element by index", () => {
  const d = doc();
  set(d, "/foo/0", "qux");
  assert.deepEqual(d.foo, ["qux", "baz"]);
});

test("a dash appends to an array, and so does the end index", () => {
  const d = doc();
  set(d, "/foo/-", "new");
  assert.deepEqual(d.foo, ["bar", "baz", "new"]);
  set(d, "/foo/3", "end");
  assert.deepEqual(d.foo, ["bar", "baz", "new", "end"]);
});

test("an out-of-range array index is rejected", () => {
  assert.throws(() => set(doc(), "/foo/9", "x"), /index/i);
  assert.throws(() => set(doc(), "/foo/nope", "x"), /index/i);
});

test("remove returns what it deleted", () => {
  const d = doc();
  assert.equal(remove(d, "/nested/deep/value"), 42);
  assert.deepEqual(d.nested.deep, {});
});

test("remove splices arrays rather than leaving a hole", () => {
  const d = doc();
  assert.equal(remove(d, "/foo/0"), "bar");
  assert.deepEqual(d.foo, ["baz"]);
});

test("removing something absent yields undefined and changes nothing", () => {
  const d = doc();
  assert.equal(remove(d, "/nope"), undefined);
  assert.equal(remove(d, "/nested/missing/x"), undefined);
  assert.deepEqual(d.foo, ["bar", "baz"]);
});
`;

const LRU_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { createCache } from "../src/lru.mjs";

const clock = (start = 0) => {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => {
    t += ms;
  };
  return fn;
};

test("values round-trip and size reflects what is held", () => {
  const c = createCache({ capacity: 3 });
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("b"), 2);
  assert.equal(c.size(), 2);
  assert.equal(c.get("missing"), undefined);
});

test("capacity evicts the least recently used entry", () => {
  const c = createCache({ capacity: 2 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.get("a"), undefined);
  assert.equal(c.get("b"), 2);
  assert.equal(c.get("c"), 3);
  assert.equal(c.size(), 2);
});

test("reading an entry makes it recently used", () => {
  const c = createCache({ capacity: 2 });
  c.set("a", 1);
  c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.get("a"), 1, "a was read, so b should have been evicted");
  assert.equal(c.get("b"), undefined);
});

test("overwriting a key updates it in place and refreshes it", () => {
  const c = createCache({ capacity: 2 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 10);
  c.set("c", 3);
  assert.equal(c.get("a"), 10);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.size(), 2);
});

test("keys are listed most recently used first", () => {
  const c = createCache({ capacity: 3 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  c.get("a");
  assert.deepEqual(c.keys(), ["a", "c", "b"]);
});

test("entries expire once the ttl has elapsed", () => {
  const now = clock();
  const c = createCache({ capacity: 10, ttlMs: 100, now });
  c.set("a", 1);
  now.advance(99);
  assert.equal(c.get("a"), 1);
  now.advance(2);
  assert.equal(c.get("a"), undefined);
});

test("reading does not extend an entry's lifetime", () => {
  const now = clock();
  const c = createCache({ capacity: 10, ttlMs: 100, now });
  c.set("a", 1);
  now.advance(60);
  assert.equal(c.get("a"), 1);
  now.advance(60);
  assert.equal(c.get("a"), undefined, "ttl runs from set, not from the last read");
});

test("writing again restarts the ttl", () => {
  const now = clock();
  const c = createCache({ capacity: 10, ttlMs: 100, now });
  c.set("a", 1);
  now.advance(60);
  c.set("a", 2);
  now.advance(60);
  assert.equal(c.get("a"), 2);
});

test("expired entries stop counting towards size and are not listed", () => {
  const now = clock();
  const c = createCache({ capacity: 10, ttlMs: 50, now });
  c.set("a", 1);
  c.set("b", 2);
  now.advance(51);
  c.set("c", 3);
  assert.equal(c.size(), 1);
  assert.deepEqual(c.keys(), ["c"]);
});

test("has reports liveness without disturbing recency", () => {
  const now = clock();
  const c = createCache({ capacity: 2, ttlMs: 100, now });
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.has("a"), true);
  c.set("c", 3);
  assert.equal(c.has("a"), false, "has must not have refreshed a");
  now.advance(101);
  assert.equal(c.has("b"), false);
});

test("delete removes an entry and reports whether it was there", () => {
  const c = createCache({ capacity: 2 });
  c.set("a", 1);
  assert.equal(c.delete("a"), true);
  assert.equal(c.delete("a"), false);
  assert.equal(c.size(), 0);
});

test("a capacity below one is rejected", () => {
  assert.throws(() => createCache({ capacity: 0 }), /capacity/i);
});
`;

const BACKOFF_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { nextDelay, retry } from "../src/backoff.mjs";

const policy = (over = {}) => ({
  baseMs: 100,
  factor: 2,
  maxMs: 1000,
  jitter: "none",
  ...over,
});

test("delays grow by the factor and are capped", () => {
  const p = policy();
  assert.equal(nextDelay(1, p), 100);
  assert.equal(nextDelay(2, p), 200);
  assert.equal(nextDelay(3, p), 400);
  assert.equal(nextDelay(4, p), 800);
  assert.equal(nextDelay(5, p), 1000);
  assert.equal(nextDelay(9, p), 1000);
});

test("attempt numbers below one are rejected", () => {
  assert.throws(() => nextDelay(0, policy()), /attempt/i);
});

test("full jitter spans zero to the capped delay", () => {
  const p = policy({ jitter: "full", random: () => 0 });
  assert.equal(nextDelay(3, p), 0);
  assert.equal(nextDelay(3, policy({ jitter: "full", random: () => 1 })), 400);
  assert.equal(nextDelay(3, policy({ jitter: "full", random: () => 0.5 })), 200);
});

test("equal jitter keeps half the delay and randomises the rest", () => {
  assert.equal(nextDelay(3, policy({ jitter: "equal", random: () => 0 })), 200);
  assert.equal(nextDelay(3, policy({ jitter: "equal", random: () => 1 })), 400);
  assert.equal(nextDelay(3, policy({ jitter: "equal", random: () => 0.5 })), 300);
});

test("delays are whole milliseconds", () => {
  const d = nextDelay(2, policy({ jitter: "full", random: () => 0.3333333 }));
  assert.equal(Number.isInteger(d), true);
});

test("an unknown jitter mode is rejected", () => {
  assert.throws(() => nextDelay(1, policy({ jitter: "wobble" })), /jitter/i);
});

test("retry returns the first success without sleeping", async () => {
  const slept = [];
  const result = await retry(async () => "ok", {
    ...policy(),
    maxAttempts: 3,
    sleep: async (ms) => slept.push(ms),
  });
  assert.equal(result, "ok");
  assert.deepEqual(slept, []);
});

test("retry sleeps between attempts and returns the eventual success", async () => {
  const slept = [];
  let calls = 0;
  const result = await retry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("boom");
      return calls;
    },
    { ...policy(), maxAttempts: 5, sleep: async (ms) => slept.push(ms) },
  );
  assert.equal(result, 3);
  assert.equal(calls, 3);
  assert.deepEqual(slept, [100, 200], "one sleep per retry, none after success");
});

test("retry gives up after maxAttempts and rethrows the last error", async () => {
  const slept = [];
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls += 1;
        throw new Error("failure " + calls);
      },
      { ...policy(), maxAttempts: 3, sleep: async (ms) => slept.push(ms) },
    ),
    /failure 3/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(slept, [100, 200], "no sleep after the final attempt");
});

test("shouldRetry can stop early, and the error still propagates", async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls += 1;
        const error = new Error("fatal");
        error.permanent = true;
        throw error;
      },
      {
        ...policy(),
        maxAttempts: 5,
        shouldRetry: (error) => !error.permanent,
        sleep: async () => {},
      },
    ),
    /fatal/,
  );
  assert.equal(calls, 1);
});

test("shouldRetry sees the attempt number", async () => {
  const seen = [];
  await assert.rejects(
    retry(async () => { throw new Error("x"); }, {
      ...policy(),
      maxAttempts: 4,
      shouldRetry: (error, attempt) => {
        seen.push(attempt);
        return attempt < 2;
      },
      sleep: async () => {},
    }),
    /x/,
  );
  assert.deepEqual(seen, [1, 2]);
});

test("maxAttempts below one is rejected", async () => {
  await assert.rejects(
    retry(async () => "ok", { ...policy(), maxAttempts: 0, sleep: async () => {} }),
    /maxAttempts/i,
  );
});
`;

const SEMVER_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { parse, compare, satisfies } from "../src/semver.mjs";

test("parse splits a plain version", () => {
  assert.deepEqual(parse("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
    build: [],
  });
});

test("parse handles prerelease and build metadata", () => {
  assert.deepEqual(parse("1.0.0-alpha.1+build.5"), {
    major: 1,
    minor: 0,
    patch: 0,
    prerelease: ["alpha", 1],
    build: ["build", "5"],
  });
});

test("numeric prerelease identifiers become numbers, others stay strings", () => {
  assert.deepEqual(parse("1.0.0-1.beta.007").prerelease, [1, "beta", "007"]);
});

test("a leading v is accepted", () => {
  assert.equal(parse("v2.0.0").major, 2);
});

test("invalid versions parse as null", () => {
  for (const bad of ["", "1", "1.2", "1.2.3.4", "a.b.c", "1.2.x", "01.2.3"]) {
    assert.equal(parse(bad), null, bad + " should be invalid");
  }
});

test("compare orders by major, minor, then patch", () => {
  assert.equal(compare("1.0.0", "2.0.0"), -1);
  assert.equal(compare("2.1.0", "2.0.9"), 1);
  assert.equal(compare("1.2.3", "1.2.3"), 0);
});

test("a prerelease is lower than its release", () => {
  assert.equal(compare("1.0.0-alpha", "1.0.0"), -1);
  assert.equal(compare("1.0.0", "1.0.0-alpha"), 1);
});

test("prerelease precedence follows the specification", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let i = 0; i < ordered.length - 1; i += 1) {
    assert.equal(
      compare(ordered[i], ordered[i + 1]),
      -1,
      ordered[i] + " should sort before " + ordered[i + 1],
    );
  }
});

test("build metadata is ignored when comparing", () => {
  assert.equal(compare("1.0.0+a", "1.0.0+b"), 0);
});

test("comparators match", () => {
  assert.equal(satisfies("1.2.3", ">=1.0.0"), true);
  assert.equal(satisfies("1.2.3", ">1.2.3"), false);
  assert.equal(satisfies("1.2.3", "<=1.2.3"), true);
  assert.equal(satisfies("1.2.3", "<1.0.0"), false);
  assert.equal(satisfies("1.2.3", "=1.2.3"), true);
  assert.equal(satisfies("1.2.3", "1.2.3"), true);
});

test("caret allows changes that do not modify the leftmost non-zero digit", () => {
  assert.equal(satisfies("1.2.3", "^1.2.0"), true);
  assert.equal(satisfies("1.9.9", "^1.2.0"), true);
  assert.equal(satisfies("2.0.0", "^1.2.0"), false);
  assert.equal(satisfies("0.2.5", "^0.2.3"), true);
  assert.equal(satisfies("0.3.0", "^0.2.3"), false);
  assert.equal(satisfies("0.0.4", "^0.0.3"), false);
});

test("tilde allows patch-level changes", () => {
  assert.equal(satisfies("1.2.9", "~1.2.3"), true);
  assert.equal(satisfies("1.3.0", "~1.2.3"), false);
  assert.equal(satisfies("1.2.2", "~1.2.3"), false);
});

test("space joins comparators with and", () => {
  assert.equal(satisfies("1.5.0", ">=1.0.0 <2.0.0"), true);
  assert.equal(satisfies("2.0.0", ">=1.0.0 <2.0.0"), false);
});

test("double pipe joins ranges with or", () => {
  assert.equal(satisfies("3.0.0", "^1.0.0 || ^3.0.0"), true);
  assert.equal(satisfies("2.0.0", "^1.0.0 || ^3.0.0"), false);
});

test("a prerelease only satisfies a range that names the same version", () => {
  assert.equal(satisfies("1.2.3-alpha", "^1.0.0"), false);
  assert.equal(satisfies("1.2.3-alpha", ">=1.2.3-alpha <2.0.0"), true);
});

test("an unparseable version never satisfies anything", () => {
  assert.equal(satisfies("nope", "*"), false);
});

test("star matches any release", () => {
  assert.equal(satisfies("4.5.6", "*"), true);
});
`;

const svckit: BenchTask = {
  id: "scale-svckit",
  title: "Four independent service-toolkit modules",
  category: "implementation",
  tier: "B",
  rationale:
    "Four separable modules at roughly twice the depth of the original parallel " +
    "fixtures. Model predicts solo still wins here; the point is to bracket the " +
    "crossover from below rather than to find it.",
  requiresGit: true,
  streams: 4,
  immutable: [
    "test/jsonpointer.test.mjs",
    "test/lru.test.mjs",
    "test/backoff.test.mjs",
    "test/semver.test.mjs",
  ],
  files: {
    "package.json": '{\n  "name": "svckit",\n  "private": true,\n  "type": "module"\n}\n',
    "README.md":
      "# svckit\n\nFour independent utility modules. Each is specified entirely by its test file.\n",
    "src/jsonpointer.mjs":
      "// Implement get, set and remove for RFC 6901 JSON Pointers.\n",
    "src/lru.mjs": "// Implement createCache.\n",
    "src/backoff.mjs": "// Implement nextDelay and retry.\n",
    "src/semver.mjs": "// Implement parse, compare and satisfies.\n",
    "test/jsonpointer.test.mjs": POINTER_TEST,
    "test/lru.test.mjs": LRU_TEST,
    "test/backoff.test.mjs": BACKOFF_TEST,
    "test/semver.test.mjs": SEMVER_TEST,
  },
  objective: `This project has four unimplemented modules. Each has a test file that fully
specifies its behaviour, and the four modules are completely independent of each
other — none imports another.

  src/jsonpointer.mjs  get / set / remove for RFC 6901 JSON Pointers
  src/lru.mjs          createCache: LRU eviction plus TTL expiry
  src/backoff.mjs      nextDelay / retry: exponential backoff with jitter
  src/semver.mjs       parse / compare / satisfies for semantic versions

Implement all four so that every test passes. Do not modify any file under test/.

Verify with:
  node --test test/jsonpointer.test.mjs test/lru.test.mjs test/backoff.test.mjs test/semver.test.mjs`,
  grade: [
    nodeTest(
      [
        "test/jsonpointer.test.mjs",
        "test/lru.test.mjs",
        "test/backoff.test.mjs",
        "test/semver.test.mjs",
      ],
      "all four module test suites pass",
    ),
  ],
};

// ---------------------------------------------------------------------------
// Tier C - six independent modules
// ---------------------------------------------------------------------------

const CSV_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { parseCsv, toCsv } from "../src/csv.mjs";

test("plain rows split on commas and newlines", () => {
  assert.deepEqual(parseCsv("a,b\\nc,d"), [["a", "b"], ["c", "d"]]);
});

test("CRLF line endings are handled", () => {
  assert.deepEqual(parseCsv("a,b\\r\\nc,d\\r\\n"), [["a", "b"], ["c", "d"]]);
});

test("a trailing newline does not produce an empty final row", () => {
  assert.deepEqual(parseCsv("a,b\\n"), [["a", "b"]]);
});

test("empty input is no rows at all", () => {
  assert.deepEqual(parseCsv(""), []);
});

test("empty fields are preserved", () => {
  assert.deepEqual(parseCsv("a,,b"), [["a", "", "b"]]);
  assert.deepEqual(parseCsv(",")[0], ["", ""]);
});

test("quoted fields may contain delimiters and newlines", () => {
  assert.deepEqual(parseCsv('a,"b,c"'), [["a", "b,c"]]);
  assert.deepEqual(parseCsv('a,"b\\nc"'), [["a", "b\\nc"]]);
});

test("a doubled quote inside a quoted field is one quote", () => {
  assert.deepEqual(parseCsv('"he said ""hi"""'), [['he said "hi"']]);
});

test("whitespace inside fields is significant", () => {
  assert.deepEqual(parseCsv(' a , b '), [[" a ", " b "]]);
});

test("the delimiter is configurable", () => {
  assert.deepEqual(parseCsv("a;b", { delimiter: ";" }), [["a", "b"]]);
});

test("an unterminated quoted field is an error", () => {
  assert.throws(() => parseCsv('"abc'), /unterminated/i);
});

test("a stray quote inside a quoted field is an error", () => {
  assert.throws(() => parseCsv('"ab"c"'), /quote/i);
});

test("toCsv quotes only what needs quoting", () => {
  assert.equal(toCsv([["a", "b"]]), "a,b");
  assert.equal(toCsv([["a,b", "c"]]), '"a,b",c');
  assert.equal(toCsv([['say "hi"']]), '"say ""hi"""');
  assert.equal(toCsv([["line\\nbreak"]]), '"line\\nbreak"');
});

test("toCsv joins rows with a newline and round-trips", () => {
  const rows = [["a", "b,c"], ['d"e', "f\\ng"]];
  assert.equal(toCsv(rows), 'a,"b,c"\\n"d""e","f\\ng"');
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("toCsv renders null and undefined as empty fields", () => {
  assert.equal(toCsv([[null, undefined, 0]]), ",,0");
});
`;

const QUERY_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { parseQuery, stringifyQuery } from "../src/querystring.mjs";

test("flat pairs parse into an object of strings", () => {
  assert.deepEqual(parseQuery("a=1&b=2"), { a: "1", b: "2" });
});

test("a leading question mark is ignored", () => {
  assert.deepEqual(parseQuery("?a=1"), { a: "1" });
});

test("empty input is an empty object", () => {
  assert.deepEqual(parseQuery(""), {});
  assert.deepEqual(parseQuery("?"), {});
});

test("a key with no equals sign has an empty value", () => {
  assert.deepEqual(parseQuery("a&b=2"), { a: "", b: "2" });
});

test("percent escapes and plus signs are decoded", () => {
  assert.deepEqual(parseQuery("q=a%20b+c&k%3D=v"), { q: "a b c", "k=": "v" });
});

test("bracket notation builds nested objects", () => {
  assert.deepEqual(parseQuery("a[b]=1&a[c]=2"), { a: { b: "1", c: "2" } });
  assert.deepEqual(parseQuery("a[b][c]=1"), { a: { b: { c: "1" } } });
});

test("empty brackets append to an array", () => {
  assert.deepEqual(parseQuery("a[]=1&a[]=2"), { a: ["1", "2"] });
});

test("numeric brackets index an array", () => {
  assert.deepEqual(parseQuery("a[0]=x&a[1]=y"), { a: ["x", "y"] });
});

test("a repeated flat key becomes an array", () => {
  assert.deepEqual(parseQuery("a=1&a=2&a=3"), { a: ["1", "2", "3"] });
});

test("stringify emits keys in sorted order", () => {
  assert.equal(stringifyQuery({ b: "2", a: "1" }), "a=1&b=2");
});

test("stringify encodes reserved characters", () => {
  assert.equal(stringifyQuery({ q: "a b&c" }), "q=a%20b%26c");
});

test("stringify writes arrays with empty brackets", () => {
  assert.equal(stringifyQuery({ a: ["1", "2"] }), "a%5B%5D=1&a%5B%5D=2");
});

test("stringify writes nested objects with bracket paths", () => {
  assert.equal(stringifyQuery({ a: { b: "1" } }), "a%5Bb%5D=1");
});

test("stringify skips null and undefined values", () => {
  assert.equal(stringifyQuery({ a: "1", b: null, c: undefined }), "a=1");
});

test("stringify renders numbers and booleans", () => {
  assert.equal(stringifyQuery({ n: 3, t: true }), "n=3&t=true");
});

test("an empty object stringifies to an empty string", () => {
  assert.equal(stringifyQuery({}), "");
});
`;

const DIFF_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { diffLines, formatDiff } from "../src/diff.mjs";

const ops = (a, b) => diffLines(a, b).map((op) => op.type + op.value);

test("identical input is all context", () => {
  assert.deepEqual(ops("a\\nb", "a\\nb"), ["=a", "=b"]);
});

test("an appended line is an insert", () => {
  assert.deepEqual(ops("a", "a\\nb"), ["=a", "+b"]);
});

test("a removed line is a delete", () => {
  assert.deepEqual(ops("a\\nb", "a"), ["=a", "-b"]);
});

test("a replaced line is a delete followed by an insert", () => {
  assert.deepEqual(ops("a\\nb\\nc", "a\\nx\\nc"), ["=a", "-b", "+x", "=c"]);
});

test("empty against empty is no operations", () => {
  assert.deepEqual(diffLines("", ""), []);
});

test("everything inserted when the original is empty", () => {
  assert.deepEqual(ops("", "a\\nb"), ["+a", "+b"]);
});

test("everything deleted when the result is empty", () => {
  assert.deepEqual(ops("a\\nb", ""), ["-a", "-b"]);
});

test("the common subsequence found is the longest one", () => {
  assert.deepEqual(ops("a\\nb\\nc\\nd", "a\\nc\\nd"), ["=a", "-b", "=c", "=d"]);
  assert.deepEqual(ops("x\\na\\nb", "a\\nb\\ny"), ["-x", "=a", "=b", "+y"]);
});

test("repeated lines are matched without duplication", () => {
  assert.deepEqual(ops("a\\na\\nb", "a\\nb"), ["=a", "-a", "=b"]);
});

test("a diff applied to the original reproduces the result", () => {
  const a = "one\\ntwo\\nthree\\nfour";
  const b = "one\\nthree\\nfour\\nfive";
  const rebuilt = diffLines(a, b)
    .filter((op) => op.type !== "-")
    .map((op) => op.value)
    .join("\\n");
  assert.equal(rebuilt, b);
});

test("the number of context operations is maximal", () => {
  const result = diffLines("a\\nb\\nc", "c\\nb\\na");
  assert.equal(result.filter((op) => op.type === "=").length, 1);
});

test("formatDiff renders unified-style prefixes", () => {
  assert.equal(formatDiff(diffLines("a\\nb", "a\\nc")), " a\\n-b\\n+c");
});

test("CRLF input is normalised before diffing", () => {
  assert.deepEqual(ops("a\\r\\nb", "a\\nb"), ["=a", "=b"]);
});
`;

const RATELIMIT_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { createLimiter } from "../src/ratelimit.mjs";

const clock = () => {
  let t = 0;
  const fn = () => t;
  fn.advance = (ms) => {
    t += ms;
  };
  return fn;
};

test("a fresh bucket starts full", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 5, refillPerSecond: 1, now: c });
  assert.equal(limiter.tokens(), 5);
});

test("taking tokens succeeds while the bucket has them", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 3, refillPerSecond: 1, now: c });
  assert.equal(limiter.tryRemove(), true);
  assert.equal(limiter.tryRemove(2), true);
  assert.equal(limiter.tokens(), 0);
});

test("taking more than is left fails and consumes nothing", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 3, refillPerSecond: 1, now: c });
  assert.equal(limiter.tryRemove(2), true);
  assert.equal(limiter.tryRemove(2), false);
  assert.equal(limiter.tokens(), 1);
});

test("tokens refill over time at the configured rate", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 10, refillPerSecond: 2, now: c });
  limiter.tryRemove(10);
  c.advance(1000);
  assert.equal(limiter.tokens(), 2);
  c.advance(500);
  assert.equal(limiter.tokens(), 3);
});

test("refill is fractional rather than stepwise", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 10, refillPerSecond: 4, now: c });
  limiter.tryRemove(10);
  c.advance(250);
  assert.equal(limiter.tokens(), 1);
});

test("the bucket never exceeds its capacity", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 5, refillPerSecond: 100, now: c });
  limiter.tryRemove(5);
  c.advance(10_000);
  assert.equal(limiter.tokens(), 5);
});

test("retryAfterMs is zero when the request would succeed now", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 5, refillPerSecond: 1, now: c });
  assert.equal(limiter.retryAfterMs(5), 0);
});

test("retryAfterMs reports the wait for the missing tokens", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 5, refillPerSecond: 2, now: c });
  limiter.tryRemove(5);
  assert.equal(limiter.retryAfterMs(1), 500);
  assert.equal(limiter.retryAfterMs(4), 2000);
});

test("retryAfterMs rounds up to a whole millisecond", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 5, refillPerSecond: 3, now: c });
  limiter.tryRemove(5);
  assert.equal(limiter.retryAfterMs(1), 334);
});

test("asking for more than capacity is rejected", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 5, refillPerSecond: 1, now: c });
  assert.throws(() => limiter.tryRemove(6), /capacity/i);
  assert.throws(() => limiter.retryAfterMs(6), /capacity/i);
});

test("taking zero or a negative count is rejected", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 5, refillPerSecond: 1, now: c });
  assert.throws(() => limiter.tryRemove(0), /positive/i);
  assert.throws(() => limiter.tryRemove(-1), /positive/i);
});

test("invalid configuration is rejected", () => {
  assert.throws(() => createLimiter({ capacity: 0, refillPerSecond: 1 }), /capacity/i);
  assert.throws(() => createLimiter({ capacity: 1, refillPerSecond: 0 }), /refill/i);
});

test("reset refills the bucket", () => {
  const c = clock();
  const limiter = createLimiter({ capacity: 5, refillPerSecond: 1, now: c });
  limiter.tryRemove(5);
  limiter.reset();
  assert.equal(limiter.tokens(), 5);
});
`;

const GLOB_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { matchGlob } from "../src/glob.mjs";

test("a literal pattern matches only itself", () => {
  assert.equal(matchGlob("src/index.js", "src/index.js"), true);
  assert.equal(matchGlob("src/index.js", "src/other.js"), false);
});

test("a star matches within one segment", () => {
  assert.equal(matchGlob("src/*.js", "src/index.js"), true);
  assert.equal(matchGlob("src/*.js", "src/index.ts"), false);
  assert.equal(matchGlob("src/*.js", "src/deep/index.js"), false);
});

test("a star matches an empty run", () => {
  assert.equal(matchGlob("a*b", "ab"), true);
});

test("a question mark matches exactly one character, never a slash", () => {
  assert.equal(matchGlob("a?c", "abc"), true);
  assert.equal(matchGlob("a?c", "ac"), false);
  assert.equal(matchGlob("a?c", "a/c"), false);
});

test("a double star crosses segment boundaries", () => {
  assert.equal(matchGlob("src/**/*.js", "src/a/b/c.js"), true);
  assert.equal(matchGlob("src/**/*.js", "src/a.js"), true);
  assert.equal(matchGlob("**/test.js", "test.js"), true);
});

test("a trailing double star matches everything below", () => {
  assert.equal(matchGlob("src/**", "src/a/b"), true);
  assert.equal(matchGlob("src/**", "src"), true);
  assert.equal(matchGlob("src/**", "lib/a"), false);
});

test("braces expand to alternatives", () => {
  assert.equal(matchGlob("*.{js,ts}", "a.ts"), true);
  assert.equal(matchGlob("*.{js,ts}", "a.md"), false);
  assert.equal(matchGlob("{src,lib}/a.js", "lib/a.js"), true);
});

test("braces may contain a glob", () => {
  assert.equal(matchGlob("{src/*,lib}/x.js", "src/a/x.js"), true);
});

test("character classes match one listed character", () => {
  assert.equal(matchGlob("a[bc]d", "abd"), true);
  assert.equal(matchGlob("a[bc]d", "add"), false);
  assert.equal(matchGlob("a[a-c]d", "abd"), true);
});

test("a negated character class excludes what it lists", () => {
  assert.equal(matchGlob("a[!bc]d", "add"), true);
  assert.equal(matchGlob("a[!bc]d", "abd"), false);
});

test("regular-expression metacharacters are literal", () => {
  assert.equal(matchGlob("a.b", "a.b"), true);
  assert.equal(matchGlob("a.b", "axb"), false);
  assert.equal(matchGlob("a+b", "a+b"), true);
  assert.equal(matchGlob("(a)", "(a)"), true);
});

test("matching is anchored at both ends", () => {
  assert.equal(matchGlob("src", "src/a"), false);
  assert.equal(matchGlob("a", "ba"), false);
});

test("backslashes in a path are treated as separators", () => {
  assert.equal(matchGlob("src/*.js", "src\\\\index.js"), true);
});

test("an empty pattern matches only an empty path", () => {
  assert.equal(matchGlob("", ""), true);
  assert.equal(matchGlob("", "a"), false);
});
`;

const INTERVAL_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { merge, intersect, subtract, contains, totalLength } from "../src/interval.mjs";

test("merge sorts and joins overlapping intervals", () => {
  assert.deepEqual(merge([[5, 7], [1, 3], [2, 6]]), [[1, 7]]);
});

test("merge joins intervals that only touch", () => {
  assert.deepEqual(merge([[1, 3], [3, 5]]), [[1, 5]]);
});

test("merge keeps disjoint intervals apart", () => {
  assert.deepEqual(merge([[1, 2], [3, 4]]), [[1, 2], [3, 4]]);
});

test("merge drops empty intervals", () => {
  assert.deepEqual(merge([[1, 1], [2, 4]]), [[2, 4]]);
});

test("merge of nothing is nothing", () => {
  assert.deepEqual(merge([]), []);
});

test("merge does not mutate its input", () => {
  const input = [[3, 4], [1, 2]];
  merge(input);
  assert.deepEqual(input, [[3, 4], [1, 2]]);
});

test("merge rejects a reversed interval", () => {
  assert.throws(() => merge([[5, 1]]), /interval/i);
});

test("intersect keeps only shared coverage", () => {
  assert.deepEqual(intersect([[1, 10]], [[2, 4], [6, 8]]), [[2, 4], [6, 8]]);
  assert.deepEqual(intersect([[1, 5]], [[4, 9]]), [[4, 5]]);
});

test("touching intervals do not intersect", () => {
  assert.deepEqual(intersect([[1, 3]], [[3, 5]]), []);
});

test("intersecting with nothing gives nothing", () => {
  assert.deepEqual(intersect([[1, 5]], []), []);
});

test("intersect normalises unsorted overlapping input first", () => {
  assert.deepEqual(intersect([[6, 8], [1, 4]], [[3, 7]]), [[3, 4], [6, 7]]);
});

test("subtract removes the second set from the first", () => {
  assert.deepEqual(subtract([[1, 10]], [[3, 5]]), [[1, 3], [5, 10]]);
  assert.deepEqual(subtract([[1, 10]], [[0, 20]]), []);
  assert.deepEqual(subtract([[1, 10]], [[10, 20]]), [[1, 10]]);
});

test("subtract handles several holes", () => {
  assert.deepEqual(subtract([[0, 10]], [[1, 2], [4, 6]]), [[0, 1], [2, 4], [6, 10]]);
});

test("contains reports whether a point is covered", () => {
  assert.equal(contains([[1, 5]], 1), true);
  assert.equal(contains([[1, 5]], 4.9), true);
  assert.equal(contains([[1, 5]], 5), false, "the end is exclusive");
  assert.equal(contains([[1, 5]], 0), false);
});

test("totalLength sums merged coverage without double counting", () => {
  assert.equal(totalLength([[1, 3], [2, 6]]), 5);
  assert.equal(totalLength([]), 0);
});
`;

const datakit: BenchTask = {
  id: "scale-datakit",
  title: "Six independent data-toolkit modules",
  category: "implementation",
  tier: "C",
  rationale:
    "Six separable modules at the same depth as tier B. The model predicts the " +
    "solo arm crosses above the orchestrated arm somewhere near six streams, " +
    "because orchestration overhead is roughly fixed while solo cost is linear.",
  requiresGit: true,
  streams: 6,
  immutable: [
    "test/csv.test.mjs",
    "test/querystring.test.mjs",
    "test/diff.test.mjs",
    "test/ratelimit.test.mjs",
    "test/glob.test.mjs",
    "test/interval.test.mjs",
  ],
  files: {
    "package.json":
      '{\n  "name": "datakit",\n  "private": true,\n  "type": "module"\n}\n',
    "README.md":
      "# datakit\n\nSix independent utility modules. Each is specified entirely by its test file.\n",
    "src/csv.mjs": "// Implement parseCsv and toCsv.\n",
    "src/querystring.mjs": "// Implement parseQuery and stringifyQuery.\n",
    "src/diff.mjs": "// Implement diffLines and formatDiff.\n",
    "src/ratelimit.mjs": "// Implement createLimiter.\n",
    "src/glob.mjs": "// Implement matchGlob.\n",
    "src/interval.mjs":
      "// Implement merge, intersect, subtract, contains and totalLength.\n",
    "test/csv.test.mjs": CSV_TEST,
    "test/querystring.test.mjs": QUERY_TEST,
    "test/diff.test.mjs": DIFF_TEST,
    "test/ratelimit.test.mjs": RATELIMIT_TEST,
    "test/glob.test.mjs": GLOB_TEST,
    "test/interval.test.mjs": INTERVAL_TEST,
  },
  objective: `This project has six unimplemented modules. Each has a test file that fully
specifies its behaviour, and the six modules are completely independent of each
other — none imports another.

  src/csv.mjs          parseCsv / toCsv, RFC 4180 quoting rules
  src/querystring.mjs  parseQuery / stringifyQuery with bracket nesting
  src/diff.mjs         diffLines / formatDiff, longest common subsequence
  src/ratelimit.mjs    createLimiter, a token bucket with fractional refill
  src/glob.mjs         matchGlob supporting * ** ? {a,b} and [abc]
  src/interval.mjs     merge / intersect / subtract / contains / totalLength

Implement all six so that every test passes. Do not modify any file under test/.

Verify with:
  node --test test/csv.test.mjs test/querystring.test.mjs test/diff.test.mjs test/ratelimit.test.mjs test/glob.test.mjs test/interval.test.mjs`,
  grade: [
    nodeTest(
      [
        "test/csv.test.mjs",
        "test/querystring.test.mjs",
        "test/diff.test.mjs",
        "test/ratelimit.test.mjs",
        "test/glob.test.mjs",
        "test/interval.test.mjs",
      ],
      "all six module test suites pass",
    ),
  ],
};

// ---------------------------------------------------------------------------
// Coupled control - work that should NOT be split
// ---------------------------------------------------------------------------

const EXPR_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "../src/expression.mjs";

test("numbers and arithmetic", () => {
  assert.equal(evaluate("1"), 1);
  assert.equal(evaluate("1 + 2"), 3);
  assert.equal(evaluate("7 - 2 - 1"), 4);
  assert.equal(evaluate("2 * 3 + 4"), 10);
  assert.equal(evaluate("4 + 2 * 3"), 10);
  assert.equal(evaluate("10 / 4"), 2.5);
  assert.equal(evaluate("10 % 3"), 1);
});

test("decimals are supported", () => {
  assert.equal(evaluate("1.5 * 2"), 3);
  assert.equal(evaluate("0.1 + 0.2 > 0.3"), true);
});

test("parentheses override precedence", () => {
  assert.equal(evaluate("(4 + 2) * 3"), 18);
  assert.equal(evaluate("((1 + 2)) * (3)"), 9);
});

test("exponentiation binds tighter than multiplication and is right associative", () => {
  assert.equal(evaluate("2 ^ 3"), 8);
  assert.equal(evaluate("2 * 3 ^ 2"), 18);
  assert.equal(evaluate("2 ^ 3 ^ 2"), 512);
});

test("unary minus and plus", () => {
  assert.equal(evaluate("-3"), -3);
  assert.equal(evaluate("-3 + 5"), 2);
  assert.equal(evaluate("2 * -3"), -6);
  assert.equal(evaluate("-2 ^ 2"), -4, "unary minus binds looser than ^");
  assert.equal(evaluate("+4"), 4);
});

test("comparisons and equality produce booleans", () => {
  assert.equal(evaluate("1 < 2"), true);
  assert.equal(evaluate("2 <= 2"), true);
  assert.equal(evaluate("3 > 4"), false);
  assert.equal(evaluate("3 >= 4"), false);
  assert.equal(evaluate("1 + 1 == 2"), true);
  assert.equal(evaluate("1 != 2"), true);
});

test("logical operators short-circuit and have lower precedence", () => {
  assert.equal(evaluate("1 < 2 && 3 < 4"), true);
  assert.equal(evaluate("1 > 2 || 3 < 4"), true);
  assert.equal(evaluate("!(1 > 2)"), true);
  assert.equal(evaluate("1 > 2 && (1 / 0) > 0"), false);
});

test("variables are read from the scope", () => {
  assert.equal(evaluate("x + y", { x: 2, y: 3 }), 5);
  assert.equal(evaluate("total * rate", { total: 200, rate: 0.1 }), 20);
});

test("functions may be called", () => {
  assert.equal(evaluate("min(3, 1, 2)"), 1);
  assert.equal(evaluate("max(3, 1, 2)"), 3);
  assert.equal(evaluate("abs(-4)"), 4);
  assert.equal(evaluate("round(2.5)"), 3);
  assert.equal(evaluate("min(x, 10)", { x: 4 }), 4);
});

test("whitespace is insignificant", () => {
  assert.equal(evaluate("  1   +\\t2  "), 3);
});

test("an unknown variable is an error naming it", () => {
  assert.throws(() => evaluate("a + 1"), /unknown variable: a/i);
});

test("an unknown function is an error naming it", () => {
  assert.throws(() => evaluate("nope(1)"), /unknown function: nope/i);
});

test("a syntax error reports the position", () => {
  assert.throws(() => evaluate("1 +"), /unexpected end/i);
  assert.throws(() => evaluate("1 + + "), /unexpected end/i);
  assert.throws(() => evaluate("(1"), /expected \\)/i);
  assert.throws(() => evaluate("1 $ 2"), /unexpected character.*position 2/i);
});

test("trailing input is rejected", () => {
  assert.throws(() => evaluate("1 2"), /unexpected/i);
});

test("division by zero yields infinity rather than throwing", () => {
  assert.equal(evaluate("1 / 0"), Infinity);
});
`;

const coupled: BenchTask = {
  id: "scale-coupled",
  title: "One expression evaluator with no natural seam",
  category: "implementation",
  tier: "coupled",
  rationale:
    "The control for the opposite claim. A tokenizer, parser and evaluator are " +
    "sequentially dependent and share an intermediate representation that the " +
    "specification does not fix, so splitting them across workers means agreeing " +
    "an AST across contracts. Included so the suite measures a case orchestration " +
    "should lose, not only cases it might win.",
  requiresGit: true,
  streams: 1,
  immutable: ["test/expression.test.mjs"],
  files: {
    "package.json":
      '{\n  "name": "exprkit",\n  "private": true,\n  "type": "module"\n}\n',
    "README.md":
      "# exprkit\n\nA single expression evaluator, specified entirely by its test file.\n",
    "src/expression.mjs": "// Implement evaluate(source, scope).\n",
    "test/expression.test.mjs": EXPR_TEST,
  },
  objective: `This project has one unimplemented module, src/expression.mjs, exporting a
single function:

  evaluate(source, scope = {})

It must evaluate arithmetic and logical expressions written as text: numbers,
+ - * / % ^, unary + and -, parentheses, comparisons, == != && || !, variables
resolved from scope, and the functions min, max, abs and round. Errors must name
what went wrong.

test/expression.test.mjs specifies the behaviour completely, including operator
precedence, associativity and error messages. Implement the module so that every
test passes. Do not modify any file under test/.

Verify with: node --test test/expression.test.mjs`,
  grade: [nodeTest(["test/expression.test.mjs"], "the expression test suite passes")],
};

export const SCALE_TASKS: BenchTask[] = [svckit, datakit, coupled];
