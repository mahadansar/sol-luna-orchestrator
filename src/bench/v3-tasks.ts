/**
 * Benchmark V3 fixtures.
 *
 * V3 keeps the executable BenchTask contract while making routing metadata
 * explicit for fixture analysis. The embedded workspaces are deterministic,
 * offline, and begin with a missing or deliberately incomplete implementation.
 */
import type { BenchTask, GradeCommand } from "./tasks.js";

/** Replaced with the content-freeze commit by the final metadata-only commit. */
export const BENCHMARK_V3_FREEZE_SHA = "FREEZE_SHA_PENDING";
export const BENCHMARK_V3_PRODUCTION_BASELINE_SHA =
  "83f024355c8c7caa21b488a6ea7aaa7b73a3be9e";

export type V3RoutingCategory =
  | "expected-solo"
  | "likely-solo"
  | "ambiguous"
  | "delegation-candidate"
  | "strong-delegation-candidate";

export type V3WorkloadClass =
  "obvious-solo" | "coupled-control" | "delegation-candidate" | "ambiguous";

export interface V3BenchTask extends BenchTask {
  routingCategory: V3RoutingCategory;
  workloadClass: V3WorkloadClass;
}

const nodeTest = (files: string[], label: string): GradeCommand => ({
  file: process.execPath,
  args: ["--test", ...files],
  label,
});

const csvDialect: V3BenchTask = {
  id: "v3-csv-dialect",
  title: "Infer a CSV delimiter and header row",
  category: "implementation",
  routingCategory: "expected-solo",
  workloadClass: "obvious-solo",
  tier: "A",
  streams: 1,
  rationale:
    "A focused text-inference seam with a compact contract and deterministic edge cases.",
  immutable: ["test/csv-dialect.test.mjs"],
  files: {
    "src/csv-dialect.mjs": `export function inferCsvDialect(source) {
  throw new Error("not implemented");
}
`,
    "test/csv-dialect.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { inferCsvDialect } from "../src/csv-dialect.mjs";

test("chooses a semicolon delimiter and recognizes a header", () => {
  assert.deepEqual(inferCsvDialect("name;count;active\\nwidget;4;true\\ngadget;8;false"), {
    delimiter: ";",
    hasHeader: true,
  });
});

test("supports quoted delimiters and tab-separated records", () => {
  assert.deepEqual(inferCsvDialect("name\\tcreated\\tteam\\nAda\\t2026-08-24\\t\\"platform\\tcore\\""), {
    delimiter: "\\t",
    hasHeader: true,
  });
});

test("does not call a data row a header", () => {
  assert.deepEqual(inferCsvDialect("1|alpha\\n2|beta\\n3|gamma"), {
    delimiter: "|",
    hasHeader: false,
  });
});

test("uses comma and no header for a single-column document", () => {
  assert.deepEqual(inferCsvDialect("alpha\\nbeta\\n"), {
    delimiter: ",",
    hasHeader: false,
  });
});

test("rejects non-string input", () => {
  assert.throws(() => inferCsvDialect(null), TypeError);
});
`,
  },
  objective:
    "Implement src/csv-dialect.mjs with inferCsvDialect(source). Inspect non-empty records while " +
    "respecting quoted delimiters and doubled quotes, choose the strongest delimiter from comma, " +
    "semicolon, tab, and pipe using consistent field counts, and return { delimiter, hasHeader }. " +
    "Treat a first record as a header only when its fields are labels and a later record contains " +
    "clear data values such as numbers, booleans, or ISO dates. Default to comma for a single-column " +
    "document and reject non-string input. Do not modify test/csv-dialect.test.mjs.",
  grade: [nodeTest(["test/csv-dialect.test.mjs"], "CSV dialect tests pass")],
  mutation: {
    file: "src/csv-dialect.mjs",
    content: `export function inferCsvDialect(source) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  return { delimiter: ",", hasHeader: false };
}
`,
    command: nodeTest(
      ["test/csv-dialect.test.mjs"],
      "tests catch a collapsed dialect inference",
    ),
  },
};

const lruCacheTests: V3BenchTask = {
  id: "v3-lru-cache-tests",
  title: "Author contract tests for an immutable LRU cache",
  category: "tests",
  routingCategory: "expected-solo",
  workloadClass: "obvious-solo",
  tier: "A",
  streams: 1,
  rationale:
    "A bounded test-authoring control around one existing data structure, with mutation grading for recency semantics.",
  immutable: ["src/lru.mjs"],
  files: {
    "src/lru.mjs": `export class LruCache {
  #capacity;
  #entries = new Map();

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  get(key) {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key);
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key, value) {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#capacity) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    return this;
  }

  has(key) {
    return this.#entries.has(key);
  }

  get size() {
    return this.#entries.size;
  }

  keys() {
    return [...this.#entries.keys()];
  }
}
`,
  },
  objective:
    "Create test/lru-cache.test.mjs using node:test and node:assert/strict for the existing " +
    "LruCache class. Cover positive-capacity validation, fluent set, get and has behavior, size, " +
    "insertion-order keys, eviction of the least recently used entry at capacity, get refreshing " +
    "recency, replacing a key refreshing recency, and missing-key behavior without mutation. Use " +
    "the real implementation without changing src/lru.mjs.",
  grade: [nodeTest(["test/lru-cache.test.mjs"], "authored LRU cache tests pass")],
  mutation: {
    file: "src/lru.mjs",
    content: `export class LruCache {
  #capacity;
  #entries = new Map();

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  get(key) {
    return this.#entries.get(key);
  }

  set(key, value) {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#capacity) {
      this.#entries.delete(this.#entries.keys().next().value);
    }
    return this;
  }

  has(key) {
    return this.#entries.has(key);
  }

  get size() {
    return this.#entries.size;
  }

  keys() {
    return [...this.#entries.keys()];
  }
}
`,
    command: nodeTest(
      ["test/lru-cache.test.mjs"],
      "tests catch missing LRU recency updates",
    ),
  },
};

const reservationLedger: V3BenchTask = {
  id: "v3-reservation-ledger",
  title: "Implement an idempotent inventory reservation ledger",
  category: "implementation",
  routingCategory: "likely-solo",
  workloadClass: "coupled-control",
  tier: "coupled",
  streams: 1,
  rationale:
    "Hold, commit, release, expiry, and retry behavior all operate on one transactional inventory state.",
  immutable: ["test/reservation-ledger.test.mjs"],
  files: {
    "src/reservation-ledger.mjs": `export function createReservationLedger(options = {}) {
  throw new Error("not implemented");
}
`,
    "test/reservation-ledger.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { createReservationLedger } from "../src/reservation-ledger.mjs";

const makeLedger = (now) => createReservationLedger({
  inventory: { skuA: 5, skuB: 2 },
  holdTtlMs: 10,
  now: () => now.value,
});

test("holds reserve shared inventory and repeat holds are idempotent", () => {
  const now = { value: 100 };
  const ledger = makeLedger(now);
  const held = ledger.hold("r1", [{ sku: "skuA", quantity: 2 }]);
  assert.deepEqual(held, {
    id: "r1",
    status: "held",
    items: [{ sku: "skuA", quantity: 2 }],
    expiresAt: 110,
  });
  assert.deepEqual(ledger.hold("r1", [{ sku: "skuA", quantity: 2 }]), held);
  assert.equal(ledger.available("skuA"), 3);
  assert.throws(() => ledger.hold("r1", [{ sku: "skuA", quantity: 1 }]), /id/i);
  assert.throws(() => ledger.hold("r2", [{ sku: "skuA", quantity: 4 }]), /stock/i);
});

test("commit is idempotent and removes the held units from availability", () => {
  const now = { value: 200 };
  const ledger = makeLedger(now);
  ledger.hold("r1", [{ sku: "skuA", quantity: 2 }]);
  const committed = ledger.commit("r1");
  assert.deepEqual(committed, {
    id: "r1",
    status: "committed",
    items: [{ sku: "skuA", quantity: 2 }],
    committedAt: 200,
  });
  now.value = 999;
  assert.deepEqual(ledger.commit("r1"), committed);
  assert.equal(ledger.available("skuA"), 3);
  assert.throws(() => ledger.release("r1"), /committed/i);
});

test("release restores a held quantity and repeats safely", () => {
  const now = { value: 300 };
  const ledger = makeLedger(now);
  ledger.hold("r1", [{ sku: "skuB", quantity: 1 }]);
  const released = ledger.release("r1");
  assert.deepEqual(released, {
    id: "r1",
    status: "released",
    items: [{ sku: "skuB", quantity: 1 }],
    releasedAt: 300,
  });
  assert.deepEqual(ledger.release("r1"), released);
  assert.equal(ledger.available("skuB"), 2);
  assert.throws(() => ledger.commit("r1"), /released/i);
});

test("expiry occurs at the exact deadline and is visible in the ledger state", () => {
  const now = { value: 400 };
  const ledger = makeLedger(now);
  ledger.hold("r1", [{ sku: "skuA", quantity: 2 }]);
  now.value = 409;
  assert.equal(ledger.available("skuA"), 3);
  now.value = 410;
  assert.deepEqual(ledger.expire(), ["r1"]);
  assert.equal(ledger.available("skuA"), 5);
  assert.deepEqual(ledger.expire(), []);
  assert.throws(() => ledger.commit("r1"), /expired/i);
  assert.throws(() => ledger.hold("r1", [{ sku: "skuA", quantity: 1 }]), /id/i);
});

test("validates quantities and unknown inventory", () => {
  const now = { value: 0 };
  const ledger = makeLedger(now);
  assert.throws(() => ledger.hold("bad", [{ sku: "skuA", quantity: 0 }]), /quantity/i);
  assert.throws(() => ledger.hold("bad2", [{ sku: "missing", quantity: 1 }]), /sku|stock/i);
  assert.throws(() => ledger.commit("missing"), /reservation/i);
  assert.equal(ledger.available("missing"), 0);
});
`,
  },
  objective:
    "Implement src/reservation-ledger.mjs with createReservationLedger({ inventory, holdTtlMs, now }). " +
    "The ledger must validate positive integer item quantities and known stock, canonicalize items by " +
    "SKU, reserve units on hold, restore them on release, consume them exactly once on commit, and " +
    "expire held records when now reaches their deadline. Repeating the same hold, commit, or release " +
    "request with the same reservation id and payload must return the original result without changing " +
    "inventory; conflicting reuse and invalid state transitions must throw. Keep availability and all " +
    "state transitions consistent, and do not modify test/reservation-ledger.test.mjs.",
  grade: [
    nodeTest(["test/reservation-ledger.test.mjs"], "reservation ledger tests pass"),
  ],
  mutation: {
    file: "src/reservation-ledger.mjs",
    content: `export function createReservationLedger({ inventory = {}, holdTtlMs = 1, now = Date.now } = {}) {
  const stock = { ...inventory };
  const records = new Map();
  return {
    hold(id, items) {
      const normalized = items.map(({ sku, quantity }) => ({ sku, quantity }));
      const record = { id, status: "held", items: normalized, expiresAt: now() + holdTtlMs };
      records.set(id, record);
      return { ...record, items: record.items.map((item) => ({ ...item })) };
    },
    commit(id) {
      const record = records.get(id);
      if (!record) throw new Error("reservation not found");
      record.status = "committed";
      record.committedAt = now();
      return { ...record, items: record.items.map((item) => ({ ...item })) };
    },
    release(id) {
      const record = records.get(id);
      if (!record) throw new Error("reservation not found");
      record.status = "released";
      record.releasedAt = now();
      return { ...record, items: record.items.map((item) => ({ ...item })) };
    },
    expire() {
      return [];
    },
    available(sku) {
      return stock[sku] ?? 0;
    },
  };
}
`,
    command: nodeTest(
      ["test/reservation-ledger.test.mjs"],
      "tests catch non-transactional reservation state",
    ),
  },
};

const workflowJournal: V3BenchTask = {
  id: "v3-workflow-journal",
  title: "Implement an ordered idempotent workflow journal",
  category: "implementation",
  routingCategory: "likely-solo",
  workloadClass: "coupled-control",
  tier: "coupled",
  streams: 1,
  rationale:
    "The transition graph, append-only events, replay, and command retries share one state core.",
  immutable: ["test/workflow-journal.test.mjs"],
  files: {
    "src/workflow-journal.mjs": `export function createWorkflowJournal(options = {}) {
  throw new Error("not implemented");
}
`,
    "test/workflow-journal.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowJournal } from "../src/workflow-journal.mjs";

const transitions = {
  draft: { submit: "submitted", cancel: "cancelled" },
  submitted: { approve: "approved", reject: "rejected" },
  approved: { ship: "shipped" },
};

 const makeJournal = (now) => createWorkflowJournal({
   initialState: "draft",
   transitions,
   now: () => now.value,
 });

 test("records valid transitions with ordered versions and timestamps", () => {
   const now = { value: 10 };
   const journal = makeJournal(now);
   const event = journal.transition("order-1", "submit", {
     commandId: "cmd-1",
     payload: { actor: "ada" },
   });
   assert.deepEqual(event, {
     sequence: 1,
     workflowId: "order-1",
     commandId: "cmd-1",
     type: "submit",
     from: "draft",
     to: "submitted",
     version: 1,
     at: 10,
     payload: { actor: "ada" },
   });
   assert.deepEqual(journal.snapshot("order-1"), {
     id: "order-1",
     state: "submitted",
     version: 1,
   });
 });

 test("rejects invalid transitions without appending an event", () => {
   const now = { value: 20 };
   const journal = makeJournal(now);
   assert.throws(() => journal.transition("order-1", "ship", { commandId: "bad" }), /transition/i);
   assert.deepEqual(journal.snapshot("order-1"), { id: "order-1", state: "draft", version: 0 });
   assert.deepEqual(journal.events("order-1"), []);
 });

 test("retries by command id return the original event and reject conflicts", () => {
   const now = { value: 30 };
   const journal = makeJournal(now);
   const first = journal.transition("order-1", "submit", { commandId: "cmd-1" });
   now.value = 999;
   assert.deepEqual(journal.transition("order-1", "submit", { commandId: "cmd-1" }), first);
   assert.throws(() => journal.transition("order-1", "approve", { commandId: "cmd-1" }), /command/i);
   assert.equal(journal.events("order-1").length, 1);
 });

 test("sequences events globally and preserves per-workflow order", () => {
   const now = { value: 40 };
   const journal = makeJournal(now);
   journal.transition("a", "submit", { commandId: "a-1" });
   journal.transition("b", "submit", { commandId: "b-1" });
   journal.transition("a", "approve", { commandId: "a-2" });
   assert.deepEqual(journal.events("a").map((event) => [event.sequence, event.version]), [[1, 1], [3, 2]]);
   assert.deepEqual(journal.events("b").map((event) => [event.sequence, event.version]), [[2, 1]]);
 });

 test("replays an event list into the same snapshot and returns defensive copies", () => {
   const now = { value: 50 };
   const journal = makeJournal(now);
   journal.transition("order-1", "submit", { commandId: "cmd-1" });
   journal.transition("order-1", "approve", { commandId: "cmd-2" });
   const events = journal.events("order-1");
   events[0].payload.changed = true;
   assert.equal(journal.events("order-1")[0].payload.changed, undefined);
   assert.deepEqual(journal.replay(journal.events("order-1")), {
     id: "order-1",
     state: "approved",
     version: 2,
   });
   assert.throws(() => journal.replay([{ ...events[1], sequence: 1 }]), /order|replay/i);
 });
`,
  },
  objective:
    "Implement src/workflow-journal.mjs with createWorkflowJournal({ initialState, transitions, now }). " +
    "Provide transition(workflowId, type, { commandId, payload }) that validates the transition graph, " +
    "records immutable events with a global sequence, per-workflow version, timestamp, and from/to states, " +
    "and leaves state unchanged on invalid input. Repeating a command id with the same transition returns " +
    "the original event; reusing it for a different command must throw. Provide snapshot, events, and replay " +
    "operations with defensive copies and deterministic ordering. Do not modify test/workflow-journal.test.mjs.",
  grade: [nodeTest(["test/workflow-journal.test.mjs"], "workflow journal tests pass")],
  mutation: {
    file: "src/workflow-journal.mjs",
    content: `export function createWorkflowJournal({ initialState = "draft", transitions = {}, now = Date.now } = {}) {
   const workflows = new Map();
   const copy = (event) => ({ ...event, payload: { ...event.payload } });
   const stateFor = (id) => workflows.get(id) ?? { state: initialState, version: 0, events: [] };
   return {
     transition(workflowId, type, { commandId, payload = {} } = {}) {
       const current = stateFor(workflowId);
       const destination = transitions[current.state]?.[type];
       if (!destination) throw new Error("invalid transition");
       const event = {
         sequence: current.events.length + 1,
         workflowId,
         commandId,
         type,
         from: current.state,
         to: destination,
         version: current.version + 1,
         at: now(),
         payload: { ...payload },
       };
       current.state = destination;
       current.version += 1;
       current.events.push(event);
       workflows.set(workflowId, current);
       return copy(event);
     },
     snapshot(id) {
       const current = stateFor(id);
       return { id, state: current.state, version: current.version };
     },
     events(id) {
       return stateFor(id).events.map(copy);
     },
     replay(events) {
       if (!events.length) throw new Error("cannot replay empty event list");
       let state = events[0].from;
       let version = 0;
       let previous = 0;
       for (const event of events) {
         if (event.sequence <= previous || event.from !== state || event.version !== version + 1) {
           throw new Error("invalid replay order");
         }
         state = event.to;
         version = event.version;
         previous = event.sequence;
       }
       return { id: events[0].workflowId, state, version };
     },
   };
 }
`,
    command: nodeTest(
      ["test/workflow-journal.test.mjs"],
      "tests catch per-workflow event sequencing",
    ),
  },
};

const staticSitePipeline: V3BenchTask = {
  id: "v3-static-site-pipeline",
  title: "Build a deterministic static-site pipeline",
  category: "implementation",
  routingCategory: "strong-delegation-candidate",
  workloadClass: "delegation-candidate",
  tier: "D",
  streams: 4,
  requiresGit: true,
  rationale:
    "Tokenization, template rendering, asset fingerprinting, and site assembly have explicit contracts and a mechanical build boundary.",
  immutable: ["test/static-site.test.mjs"],
  files: {
    "src/tokenizer.mjs": `export function tokenize(source) {
  throw new Error("not implemented");
}
`,
    "src/template.mjs": `export function renderTokens(tokens, context = {}, partials = {}) {
  throw new Error("not implemented");
}

export function renderTemplate(source, context = {}, partials = {}) {
  throw new Error("not implemented");
}
`,
    "src/assets.mjs": `export function fingerprintAssets(assets, prefix = "assets") {
  throw new Error("not implemented");
}
`,
    "src/build.mjs": `export function buildSite(options = {}) {
  throw new Error("not implemented");
}
`,
    "test/static-site.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintAssets } from "../src/assets.mjs";
import { buildSite } from "../src/build.mjs";
import { renderTemplate, renderTokens } from "../src/template.mjs";
import { tokenize } from "../src/tokenizer.mjs";

test("tokenizer returns explicit text, variable, and partial tokens", () => {
  assert.deepEqual(tokenize("Hello {{ user.name }}! {{> footer }}"), [
    { type: "text", value: "Hello " },
    { type: "variable", name: "user.name" },
    { type: "text", value: "! " },
    { type: "partial", name: "footer" },
  ]);
  assert.throws(() => tokenize("{{ missing"), /template/i);
});

test("template rendering resolves dotted values and partials", () => {
  const tokens = tokenize("Hi {{ user.name }} {{> footer }}");
  assert.equal(renderTokens(tokens, { user: { name: "Ada" } }, { footer: "<small>{{ year }}</small>" }), "Hi Ada <small></small>");
  assert.equal(renderTemplate("{{ title }} / {{ version }}", { title: "Docs", version: 2 }), "Docs / 2");
});

test("asset fingerprints are stable, sorted, and preserve logical paths", () => {
  const result = fingerprintAssets({
    "js/app.js": "console.log(1);",
    "css/site.css": "body{}",
  }, "static");
  assert.deepEqual(Object.keys(result.manifest), ["css/site.css", "js/app.js"]);
  assert.ok(result.manifest["css/site.css"].startsWith("static/css/site."));
  assert.match(result.manifest["css/site.css"], /[0-9a-f]{8}/);
  assert.ok(result.manifest["css/site.css"].endsWith(".css"));
  assert.equal(result.files[result.manifest["css/site.css"]], "body{}");
  assert.notEqual(result.manifest["js/app.js"], "static/js/app.js");
  assert.throws(() => fingerprintAssets({ "../secret.txt": "x" }), /path/i);
});

test("the build mechanically combines templates and fingerprinted assets", () => {
  const site = buildSite({
    pages: {
      "index.html": "<h1>{{ title }}</h1>" + String.fromCharCode(10) + "{{> footer }}",
      "docs/start.html": "<p>{{ title }} v{{ version }}</p>",
    },
    data: { title: "Home", version: 3 },
    partials: { footer: "<footer>v{{ version }}</footer>" },
    assets: { "css/site.css": "body{}" },
    assetPrefix: "static",
  });
  assert.equal(site.files["index.html"], "<h1>Home</h1>" + String.fromCharCode(10) + "<footer>v3</footer>");
  assert.equal(site.files["docs/start.html"], "<p>Home v3</p>");
  assert.equal(site.files[site.manifest["css/site.css"]], "body{}");
  assert.deepEqual(Object.keys(site.files).filter((name) => name.endsWith(".html")), ["docs/start.html", "index.html"]);
});
`,
  },
  objective:
    "Implement the static-site modules. src/tokenizer.mjs must tokenize text, {{ name }} variables, and " +
    "{{> partial }} references while rejecting unclosed tags. src/template.mjs must render dotted values " +
    "and partial templates deterministically. src/assets.mjs must validate logical relative paths, sort " +
    "them, preserve content, and emit stable eight-hex-digit SHA-256 fingerprints under a POSIX-style " +
    "prefix. src/build.mjs must render sorted page paths and combine them with the asset files and manifest. " +
    "Keep the four module contracts compatible and do not modify test/static-site.test.mjs.",
  grade: [nodeTest(["test/static-site.test.mjs"], "static-site pipeline tests pass")],
  mutation: {
    file: "src/assets.mjs",
    content: `export function fingerprintAssets(assets, prefix = "assets") {
  const manifest = {};
  const files = {};
  for (const name of Object.keys(assets ?? {}).sort()) {
    const output = String(prefix).replace(/\\\\/g, "/").replace(/\\/$/, "") + "/" + name;
    manifest[name] = output;
    files[output] = assets[name];
  }
  return { manifest, files };
}
`,
    command: nodeTest(
      ["test/static-site.test.mjs"],
      "tests catch missing asset fingerprints",
    ),
  },
};

const observabilityIngestors: V3BenchTask = {
  id: "v3-observability-ingestors",
  title: "Normalize offline observability ingestors",
  category: "implementation",
  routingCategory: "delegation-candidate",
  workloadClass: "delegation-candidate",
  tier: "C",
  streams: 3,
  requiresGit: true,
  rationale:
    "Two format-specific parsers feed a separately specified canonical merge that sorts and deduplicates records.",
  immutable: ["test/observability-ingestors.test.mjs"],
  files: {
    "src/trace-jsonl.mjs": `export function parseTraceJsonl(source) {
  throw new Error("not implemented");
}
`,
    "src/access-log.mjs": `export function parseAccessLog(source) {
  throw new Error("not implemented");
}
`,
    "src/telemetry-merge.mjs": `export function mergeTelemetry(...batches) {
  throw new Error("not implemented");
}
`,
    "test/observability-ingestors.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { parseAccessLog } from "../src/access-log.mjs";
import { parseTraceJsonl } from "../src/trace-jsonl.mjs";
import { mergeTelemetry } from "../src/telemetry-merge.mjs";

test("parses JSONL telemetry into canonical request records", () => {
  assert.deepEqual(parseTraceJsonl([
    JSON.stringify({ ts: "2026-08-25T10:00:02Z", service: "api", event: "request", operation: "GET /b", status: 200, duration_ms: 9, trace_id: "t2" }),
    "",
    JSON.stringify({ ts: "2026-08-25T10:00:01Z", service: "api", event: "request", operation: "GET /a", status: 500, duration_ms: 15, trace_id: "t1", region: "eu" }),
  ].join(String.fromCharCode(10))), [
    { timestamp: "2026-08-25T10:00:02Z", service: "api", kind: "request", operation: "GET /b", status: 200, durationMs: 9, traceId: "t2", attributes: {} },
    { timestamp: "2026-08-25T10:00:01Z", service: "api", kind: "request", operation: "GET /a", status: 500, durationMs: 15, traceId: "t1", attributes: { region: "eu" } },
  ]);
});

test("parses the line-oriented access format and reports bad lines", () => {
  assert.deepEqual(parseAccessLog("2026-08-25T10:00:03Z web GET /health 200 2ms trace=t3"), [
    { timestamp: "2026-08-25T10:00:03Z", service: "web", kind: "request", operation: "GET /health", status: 200, durationMs: 2, traceId: "t3", attributes: {} },
  ]);
  assert.deepEqual(parseAccessLog("2026-08-25T10:00:04Z web POST /submit 201 8ms"), [
    { timestamp: "2026-08-25T10:00:04Z", service: "web", kind: "request", operation: "POST /submit", status: 201, durationMs: 8, traceId: "", attributes: {} },
  ]);
  assert.throws(() => parseAccessLog("not a telemetry line"), /line/i);
});

test("merges batches without mutation, deduplicates trace ids, and sorts canonically", () => {
  const json = parseTraceJsonl(JSON.stringify({ ts: "2026-08-25T10:00:02Z", service: "api", event: "request", operation: "GET /b", status: 200, duration_ms: 9, trace_id: "t2" }));
  const access = parseAccessLog("2026-08-25T10:00:01Z api GET /a 500 15ms trace=t1");
  const duplicate = JSON.parse(JSON.stringify(json));
  const before = JSON.stringify([json, access]);
  const merged = mergeTelemetry(json, access, duplicate);
  assert.deepEqual(merged, [access[0], json[0]]);
  assert.equal(JSON.stringify([json, access]), before);
  assert.deepEqual(mergeTelemetry(access, json), merged);
});

test("rejects malformed JSONL records and invalid canonical batches", () => {
  assert.throws(() => parseTraceJsonl("{bad"), /line|JSON/i);
  assert.throws(() => mergeTelemetry([{ service: "api" }]), /record|telemetry/i);
});
`,
  },
  objective:
    "Implement the offline telemetry ingestors. parseTraceJsonl(source) must read non-empty JSONL records " +
    "with ts, service, event, operation, status, duration_ms, and optional trace_id into canonical records " +
    "with timestamp, service, kind, operation, status, durationMs, traceId, and attributes. parseAccessLog " +
    "must parse timestamp/service/method/path/status/duration lines with an optional trace token and report " +
    "line errors. mergeTelemetry(...batches) must validate canonical records, avoid mutating inputs, choose " +
    "one record per trace id, and return a deterministic timestamp/service/operation ordering. Keep all behavior " +
    "offline and do not modify test/observability-ingestors.test.mjs.",
  grade: [
    nodeTest(
      ["test/observability-ingestors.test.mjs"],
      "observability ingestor tests pass",
    ),
  ],
  mutation: {
    file: "src/telemetry-merge.mjs",
    content: `export function mergeTelemetry(...batches) {
  return batches.flat().map((record) => ({ ...record })).sort((a, b) =>
    String(b.timestamp).localeCompare(String(a.timestamp)),
  );
}
`,
    command: nodeTest(
      ["test/observability-ingestors.test.mjs"],
      "tests catch nondeterministic telemetry merging",
    ),
  },
};
const markupRenderers: V3BenchTask = {
  id: "v3-markup-renderers",
  title: "Render a validated immutable markup AST",
  category: "implementation",
  routingCategory: "strong-delegation-candidate",
  workloadClass: "delegation-candidate",
  tier: "D",
  streams: 4,
  requiresGit: true,
  rationale:
    "A shared immutable AST contract feeds three format-specific renderers with deterministic mechanical validation.",
  immutable: ["test/markup-renderers.test.mjs"],
  files: {
    "src/ast.mjs": `export function assertDocument(ast) {
  throw new Error("not implemented");
}
`,
    "src/render-html.mjs": `export function renderHtml(ast) {
  throw new Error("not implemented");
}
`,
    "src/render-text.mjs": `export function renderPlainText(ast) {
  throw new Error("not implemented");
}
`,
    "src/render-markdown.mjs": `export function renderMarkdown(ast) {
  throw new Error("not implemented");
}
`,
    "test/markup-renderers.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { assertDocument } from "../src/ast.mjs";
import { renderHtml } from "../src/render-html.mjs";
import { renderMarkdown } from "../src/render-markdown.mjs";
import { renderPlainText } from "../src/render-text.mjs";

const document = () => ({
  type: "document",
  children: [
    { type: "heading", level: 1, children: [{ type: "text", value: "Hello & world" }] },
    {
      type: "paragraph",
      children: [
        { type: "text", value: "See " },
        { type: "emphasis", children: [{ type: "text", value: "docs" }] },
        { type: "text", value: " and " },
        { type: "link", href: "https://example.test?a=1&b=2", children: [{ type: "text", value: "link" }] },
        { type: "text", value: "." },
      ],
    },
    {
      type: "list",
      ordered: false,
      items: [
        { type: "list-item", children: [{ type: "text", value: "First" }] },
        { type: "list-item", children: [{ type: "text", value: "Second" }] },
      ],
    },
    { type: "code-block", language: "js", value: "const x = 1 < 2;" },
  ],
});

test("validates the AST contract and rejects malformed nodes", () => {
  const ast = document();
  assert.equal(assertDocument(ast), ast);
  assert.throws(() => assertDocument({ type: "document", children: [{ type: "heading", level: 7, children: [] }] }), /level/i);
  assert.throws(() => assertDocument({ type: "document", children: [{ type: "link", children: [] }] }), /node|link/i);
});

test("renders HTML with structural tags and escaped text", () => {
  assert.equal(renderHtml(document()), [
    "<h1>Hello &amp; world</h1>",
     '<p>See <em>docs</em> and <a href="https://example.test?a=1&amp;b=2">link</a>.</p>',
    "<ul>",
    "<li>First</li>",
    "<li>Second</li>",
    "</ul>",
     '<pre><code class="language-js">const x = 1 &lt; 2;</code></pre>',
  ].join("\\n"));
});

test("renders plain text without markup syntax", () => {
  assert.equal(renderPlainText(document()), [
    "Hello & world",
    "See docs and link.",
    "- First",
    "- Second",
    "const x = 1 < 2;",
  ].join("\\n"));
});

test("renders canonical Markdown", () => {
  assert.equal(renderMarkdown(document()), [
    "# Hello & world",
    "",
    "See *docs* and [link](https://example.test?a=1&b=2).",
    "",
    "- First",
    "- Second",
    "",
    String.fromCharCode(96).repeat(3) + "js",
    "const x = 1 < 2;",
    String.fromCharCode(96).repeat(3),
  ].join("\\n"));
});
`,
  },
  objective:
    "Implement an immutable markup AST contract in src/ast.mjs and deterministic renderers in " +
    "src/render-html.mjs, src/render-text.mjs, and src/render-markdown.mjs. Validate document, heading, " +
    "paragraph, list, list-item, code-block, text, emphasis, and link nodes without mutating them. " +
    "Render the same AST with structural HTML and escaped text, readable plain text, or canonical Markdown " +
    "including lists, code fences, emphasis, and links. Reject malformed nodes and do not modify " +
    "test/markup-renderers.test.mjs.",
  grade: [nodeTest(["test/markup-renderers.test.mjs"], "markup renderer tests pass")],
  mutation: {
    file: "src/render-html.mjs",
    content: `import { assertDocument } from "./ast.mjs";

export function renderHtml(ast) {
  assertDocument(ast);
  return ast.children.map((node) => node.type === "heading"
    ? "<h" + node.level + ">" + node.children.map((child) => child.value ?? "").join("") + "</h" + node.level + ">"
    : "<p>" + node.children.map((child) => child.value ?? "").join("") + "</p>").join("\\n");
}
`,
    command: nodeTest(
      ["test/markup-renderers.test.mjs"],
      "tests catch unescaped HTML rendering",
    ),
  },
};

const policyEngine: V3BenchTask = {
  id: "v3-policy-engine",
  title: "Compile and cache a boolean policy engine",
  category: "implementation",
  routingCategory: "ambiguous",
  workloadClass: "ambiguous",
  tier: "B",
  streams: 1,
  rationale:
    "Parsing, compilation, evaluation, and cache invalidation share a language and authorization contract that needs one coherent design.",
  immutable: ["test/policy-engine.test.mjs"],
  files: {
    "src/policy.mjs": `export function parsePolicy(source) {
  throw new Error("not implemented");
}

export function compilePolicy(source) {
  throw new Error("not implemented");
}

export function createPolicyEngine(options = {}) {
  throw new Error("not implemented");
}
`,
    "test/policy-engine.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { compilePolicy, createPolicyEngine, parsePolicy } from "../src/policy.mjs";

test("parses boolean precedence, paths, and literals", () => {
  const ast = parsePolicy('role == "admin" or age >= 18 and active == true');
  assert.equal(ast.type, "binary");
  assert.equal(ast.operator, "or");
  assert.equal(ast.right.operator, "and");
  assert.deepEqual(ast.left.left, { type: "path", parts: ["role"] });
  assert.deepEqual(ast.left.right, { type: "literal", value: "admin" });
});

test("evaluates comparisons, contains, in, parentheses, and missing paths", () => {
  const policy = 'role == "admin" and (scopes contains "write" or region in ["eu", "us"])';
  const engine = createPolicyEngine({ maxEntries: 3 });
  assert.equal(engine.evaluate(policy, { role: "admin", scopes: ["read", "write"], region: "apac" }), true);
  assert.equal(engine.evaluate(policy, { role: "admin", scopes: ["read"], region: "us" }), true);
  assert.equal(engine.evaluate(policy, { role: "user", scopes: ["write"], region: "eu" }), false);
  assert.equal(engine.evaluate("not active == true", {}), true);
});

test("compiled programs are cached with LRU eviction and observable stats", () => {
  const engine = createPolicyEngine({ maxEntries: 2 });
  const first = engine.compile('role == "admin"');
  assert.equal(engine.compile('role == "admin"'), first);
  engine.compile("age >= 18");
  engine.compile("active == true");
  assert.deepEqual(engine.cacheStats(), { hits: 1, misses: 3, size: 2 });
  assert.notEqual(engine.compile('role == "admin"'), undefined);
  assert.deepEqual(engine.cacheStats(), { hits: 1, misses: 4, size: 2 });
  assert.equal(engine.compile("active == true"), engine.compile("active == true"));
});

test("rejects invalid syntax and invalid cache sizes", () => {
  assert.throws(() => parsePolicy("role =="), /policy|syntax|unexpected/i);
  assert.throws(() => parsePolicy('role == "admin" trailing'), /policy|syntax|unexpected/i);
  assert.throws(() => createPolicyEngine({ maxEntries: 0 }), /cache|positive/i);
  assert.throws(() => compilePolicy('(role == "admin"'), /policy|syntax|unexpected/i);
});
`,
  },
  objective:
    "Implement src/policy.mjs with a small boolean policy language. Parse identifiers with dotted paths, " +
    "string/number/boolean/null and array literals, parentheses, not, and/or, ==, !=, <, <=, >, >=, " +
    "contains, and in with normal precedence. compilePolicy must produce a reusable evaluator that safely " +
    "handles missing paths. createPolicyEngine({ maxEntries }) must evaluate policies, cache compiled programs " +
    "with least-recently-used eviction, expose hit/miss/size statistics, and reject malformed policies or " +
    "invalid limits. Do not modify test/policy-engine.test.mjs.",
  grade: [nodeTest(["test/policy-engine.test.mjs"], "policy engine tests pass")],
  mutation: {
    file: "src/policy.mjs",
    content: `export function parsePolicy() {
  return { type: "literal", value: true };
}

export function compilePolicy(source) {
  return { source, ast: parsePolicy(source), evaluate: () => true };
}

export function createPolicyEngine() {
  return {
    compile: compilePolicy,
    evaluate: () => true,
    cacheStats: () => ({ hits: 0, misses: 0, size: 0 }),
  };
}
`,
    command: nodeTest(
      ["test/policy-engine.test.mjs"],
      "tests catch a policy engine that bypasses parsing and caching",
    ),
  },
};

const syncReconciler: V3BenchTask = {
  id: "v3-sync-reconciler",
  title: "Plan and apply a portable three-way sync",
  category: "implementation",
  routingCategory: "ambiguous",
  workloadClass: "ambiguous",
  tier: "B",
  streams: 2,
  rationale:
    "Planning, rename detection, conflict reporting, and application share one normalized reconciliation contract.",
  immutable: ["test/sync-reconciler.test.mjs"],
  files: {
    "src/sync-reconciler.mjs": `export function planReconciliation(base, local, remote) {
  throw new Error("not implemented");
}

export function applyReconciliation(tree, plan) {
  throw new Error("not implemented");
}
`,
    "test/sync-reconciler.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { applyReconciliation, planReconciliation } from "../src/sync-reconciler.mjs";

test("merges independent changes into a deterministic operation plan", () => {
  const base = {
    "README.md": "base",
    "src/app.mjs": "v1",
  };
  const local = {
    "README.md": "local",
    "src/app.mjs": "v1",
    "local.txt": "only local",
  };
  const remote = {
    "README.md": "base",
    "src/app.mjs": "v2",
    "remote.txt": "only remote",
  };
  const plan = planReconciliation(base, local, remote);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.operations, [
    { type: "write", path: "README.md", content: "local" },
    { type: "write", path: "local.txt", content: "only local" },
    { type: "write", path: "remote.txt", content: "only remote" },
    { type: "write", path: "src/app.mjs", content: "v2" },
  ]);
  assert.deepEqual(applyReconciliation(base, plan), {
    "README.md": "local",
    "src/app.mjs": "v2",
    "local.txt": "only local",
    "remote.txt": "only remote",
  });
});

test("detects content-preserving renames and normalizes Windows separators", () => {
  const plan = planReconciliation(
    { "docs/readme.txt": "hello" },
    { "docs\\\\guide.txt": "hello" },
    { "docs/readme.txt": "hello" },
  );
  assert.deepEqual(plan.operations, [{
    type: "rename",
    from: "docs/readme.txt",
    path: "docs/guide.txt",
    content: "hello",
  }]);
  assert.deepEqual(applyReconciliation({ "docs/readme.txt": "hello" }, plan), {
    "docs/guide.txt": "hello",
  });
});

test("reports divergent edits as conflicts and refuses to apply them", () => {
  const plan = planReconciliation(
    { "src/app.mjs": "base" },
    { "src/app.mjs": "local" },
    { "src/app.mjs": "remote" },
  );
  assert.deepEqual(plan.conflicts, [{
    path: "src/app.mjs",
    base: "base",
    local: "local",
    remote: "remote",
  }]);
  assert.throws(() => applyReconciliation({ "src/app.mjs": "base" }, plan), /conflict/i);
});

test("rejects unsafe paths and does not mutate snapshots or plans", () => {
  const base = { "safe/file.txt": "x" };
  const local = { "safe/file.txt": "y" };
  const remote = { "safe/file.txt": "x" };
  const before = JSON.stringify([base, local, remote]);
  const plan = planReconciliation(base, local, remote);
  assert.equal(JSON.stringify([base, local, remote]), before);
  assert.throws(() => planReconciliation({ "../outside": "x" }, {}, {}), /path/i);
  assert.throws(() => applyReconciliation({}, { operations: [{ type: "write", path: "C:\\\\outside", content: "x" }], conflicts: [] }), /path/i);
  plan.operations[0].content = "changed";
  assert.equal(local["safe/file.txt"], "y");
});
`,
  },
  objective:
    "Implement src/sync-reconciler.mjs with a three-way planReconciliation(base, local, remote) and " +
    "applyReconciliation(tree, plan). Normalize logical paths to POSIX separators while rejecting empty, " +
    "absolute, and traversal paths. Merge unchanged and independently changed files, detect content-preserving " +
    "renames, produce sorted write/delete/rename operations, and report divergent edits as deterministic " +
    "conflicts. Applying a conflict plan must throw; applying a valid plan must return a new tree without " +
    "mutating its inputs. Do not modify test/sync-reconciler.test.mjs.",
  grade: [nodeTest(["test/sync-reconciler.test.mjs"], "sync reconciler tests pass")],
  mutation: {
    file: "src/sync-reconciler.mjs",
    content: `export function planReconciliation() {
  return { operations: [], conflicts: [] };
}

export function applyReconciliation(tree) {
  return { ...tree };
}
`,
    command: nodeTest(
      ["test/sync-reconciler.test.mjs"],
      "tests catch a no-op reconciliation plan",
    ),
  },
};

export const V3_TASKS: V3BenchTask[] = [
  csvDialect,
  lruCacheTests,
  reservationLedger,
  workflowJournal,
  staticSitePipeline,
  observabilityIngestors,
  markupRenderers,
  policyEngine,
  syncReconciler,
];

export const getV3Tasks = (ids: string[]): V3BenchTask[] =>
  ids.length === 0 ? V3_TASKS : V3_TASKS.filter((task) => ids.includes(task.id));
