/** Hidden known-good solutions for Benchmark V3 fixtures. */

export const V3_SOLUTIONS: Record<string, Record<string, string>> = {
  "v3-csv-dialect": {
    "src/csv-dialect.mjs": `function splitRecord(line, delimiter) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === String.fromCharCode(34)) {
      if (quoted && line[index + 1] === String.fromCharCode(34)) {
        field += String.fromCharCode(34);
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("unterminated CSV quote");
  fields.push(field.trim());
  return fields;
}

function parseRecords(source, delimiter) {
  return source
    .split(/\\r?\\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => splitRecord(line, delimiter));
}

function isDataValue(value) {
  return /^(?:-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?|true|false|\\d{4}-\\d{2}-\\d{2})$/i.test(value.trim());
}

function hasHeader(records) {
  if (records.length < 2) return false;
  const first = records[0];
  if (first.length < 2 || first.some((value) => !/^[A-Za-z_][A-Za-z0-9 _-]*$/.test(value))) {
    return false;
  }
  if (new Set(first.map((value) => value.toLowerCase())).size !== first.length) return false;
  return records.slice(1).some((record) => record.some(isDataValue));
}

export function inferCsvDialect(source) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const candidates = [",", ";", String.fromCharCode(9), "|"];
  let best = { delimiter: ",", consistent: -1, fields: 1 };
  for (const delimiter of candidates) {
    const records = parseRecords(source, delimiter);
    const fields = records[0]?.length ?? 1;
    const consistent = fields > 1 && records.every((record) => record.length === fields)
      ? records.length
      : -1;
    if (consistent > best.consistent || (consistent === best.consistent && fields > best.fields)) {
      best = { delimiter, consistent, fields };
    }
  }
  const records = parseRecords(source, best.delimiter);
  return { delimiter: best.delimiter, hasHeader: hasHeader(records) };
}
`,
  },
  "v3-lru-cache-tests": {
    "test/lru-cache.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { LruCache } from "../src/lru.mjs";

test("validates a positive integer capacity", () => {
  assert.throws(() => new LruCache(0), /capacity/i);
  assert.throws(() => new LruCache(1.5), /capacity/i);
  assert.throws(() => new LruCache("2"), /capacity/i);
});

test("sets, gets, chains, and reports size and keys", () => {
  const cache = new LruCache(3);
  assert.equal(cache.set("a", 1), cache);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.has("b"), true);
  assert.equal(cache.size, 2);
  assert.deepEqual(cache.keys(), ["b", "a"]);
});

test("evicts the least recently used entry", () => {
  const cache = new LruCache(2);
  cache.set("a", 1).set("b", 2).set("c", 3);
  assert.equal(cache.has("a"), false);
  assert.deepEqual(cache.keys(), ["b", "c"]);
  assert.equal(cache.size, 2);
});

test("get refreshes recency before the next insertion", () => {
  const cache = new LruCache(2);
  cache.set("a", 1).set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
  assert.deepEqual(cache.keys(), ["a", "c"]);
});

test("replacing a key refreshes it and missing reads are inert", () => {
  const cache = new LruCache(2);
  cache.set("a", 1).set("b", 2);
  assert.equal(cache.get("missing"), undefined);
  assert.equal(cache.has("missing"), false);
  cache.set("a", 10).set("c", 3);
  assert.equal(cache.get("a"), 10);
  assert.equal(cache.has("b"), false);
});
`,
  },
  "v3-reservation-ledger": {
    "src/reservation-ledger.mjs": `function copyItems(items) {
  return items.map((item) => ({ ...item }));
}

function copyRecord(record) {
  return {
    ...record,
    items: copyItems(record.items),
  };
}

function sameItems(left, right) {
  return left.length === right.length && left.every((item, index) =>
    item.sku === right[index].sku && item.quantity === right[index].quantity,
  );
}

function canonicalItems(items, inventory) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError("items must be non-empty");
  const quantities = new Map();
  for (const item of items) {
    if (!item || typeof item.sku !== "string" || item.sku.length === 0) {
      throw new TypeError("sku is required");
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new RangeError("quantity must be positive");
    }
    if (!Object.prototype.hasOwnProperty.call(inventory, item.sku)) {
      throw new Error("unknown sku");
    }
    quantities.set(item.sku, (quantities.get(item.sku) ?? 0) + item.quantity);
  }
  return [...quantities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sku, quantity]) => ({ sku, quantity }));
}

export function createReservationLedger({ inventory = {}, holdTtlMs = 1, now = Date.now } = {}) {
  if (!inventory || typeof inventory !== "object") throw new TypeError("inventory is required");
  if (!Number.isInteger(holdTtlMs) || holdTtlMs < 1) throw new RangeError("holdTtlMs must be positive");
  const stock = {};
  for (const [sku, quantity] of Object.entries(inventory)) {
    if (!Number.isInteger(quantity) || quantity < 0) throw new RangeError("inventory must be non-negative");
    stock[sku] = quantity;
  }
  const records = new Map();
  const committed = new Map();

  const readNow = () => {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError("now must return a finite number");
    return value;
  };

  const expireDue = (at) => {
    const expired = [];
    for (const record of records.values()) {
      if (record.status === "held" && at >= record.expiresAt) {
        record.status = "expired";
        delete record.expiresAt;
        expired.push(record.id);
      }
    }
    return expired;
  };

  const heldFor = (sku) => {
    let total = 0;
    for (const record of records.values()) {
      if (record.status !== "held") continue;
      for (const item of record.items) if (item.sku === sku) total += item.quantity;
    }
    return total;
  };

  const available = (sku) => {
    expireDue(readNow());
    return (stock[sku] ?? 0) - (committed.get(sku) ?? 0) - heldFor(sku);
  };

  return {
    hold(id, items) {
      if (typeof id !== "string" || id.length === 0) throw new TypeError("reservation id is required");
      const normalized = canonicalItems(items, stock);
      const existing = records.get(id);
      if (existing) {
        if (existing.status === "held" && sameItems(existing.items, normalized)) return copyRecord(existing);
        throw new Error("reservation id already used");
      }
      const at = readNow();
      expireDue(at);
      for (const item of normalized) {
        if (item.quantity > available(item.sku)) throw new Error("insufficient stock");
      }
      const record = {
        id,
        status: "held",
        items: copyItems(normalized),
        expiresAt: at + holdTtlMs,
      };
      records.set(id, record);
      return copyRecord(record);
    },

    commit(id) {
      const record = records.get(id);
      if (!record) throw new Error("reservation not found");
      if (record.status === "committed") return copyRecord(record);
      if (record.status !== "held") throw new Error("reservation is " + record.status);
      const at = readNow();
      expireDue(at);
      if (record.status !== "held") throw new Error("reservation is expired");
      for (const item of record.items) committed.set(item.sku, (committed.get(item.sku) ?? 0) + item.quantity);
      record.status = "committed";
      record.committedAt = at;
      delete record.expiresAt;
      return copyRecord(record);
    },

    release(id) {
      const record = records.get(id);
      if (!record) throw new Error("reservation not found");
      if (record.status === "released") return copyRecord(record);
      if (record.status !== "held") throw new Error("reservation is " + record.status);
      const at = readNow();
      expireDue(at);
      if (record.status !== "held") throw new Error("reservation is expired");
      record.status = "released";
      record.releasedAt = at;
      delete record.expiresAt;
      return copyRecord(record);
    },

    expire() {
      return expireDue(readNow());
    },

    available,
  };
}
`,
  },
  "v3-workflow-journal": {
    "src/workflow-journal.mjs": `function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function equalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneEvent(event) {
  return { ...event, payload: cloneValue(event.payload) };
}

export function createWorkflowJournal({ initialState, transitions, now = Date.now } = {}) {
  if (typeof initialState !== "string" || !transitions || typeof transitions !== "object") {
    throw new TypeError("initialState and transitions are required");
  }
  const workflows = new Map();
  const commands = new Map();
  let nextSequence = 1;

  const freshState = (id) => ({ id, state: initialState, version: 0, events: [] });
  const stateFor = (id) => workflows.get(id) ?? freshState(id);

  const transition = (workflowId, type, options = {}) => {
    if (typeof workflowId !== "string" || workflowId.length === 0) throw new TypeError("workflow id is required");
    if (typeof type !== "string" || type.length === 0) throw new TypeError("transition type is required");
    const { commandId, payload = {} } = options;
    if (typeof commandId !== "string" || commandId.length === 0) throw new TypeError("command id is required");
    const previousCommand = commands.get(commandId);
    if (previousCommand) {
      if (previousCommand.workflowId === workflowId && previousCommand.type === type && equalValue(previousCommand.payload, payload)) {
        return cloneEvent(previousCommand);
      }
      throw new Error("command id already used");
    }
    const current = stateFor(workflowId);
    const destination = transitions[current.state]?.[type];
    if (typeof destination !== "string") throw new Error("invalid transition");
    const event = {
      sequence: nextSequence,
      workflowId,
      commandId,
      type,
      from: current.state,
      to: destination,
      version: current.version + 1,
      at: now(),
      payload: cloneValue(payload),
    };
    nextSequence += 1;
    current.state = destination;
    current.version += 1;
    current.events.push(event);
    workflows.set(workflowId, current);
    commands.set(commandId, event);
    return cloneEvent(event);
  };

  const snapshot = (id) => {
    const current = stateFor(id);
    return { id, state: current.state, version: current.version };
  };

  const events = (id) => stateFor(id).events.map(cloneEvent);

  const replay = (eventList) => {
    if (!Array.isArray(eventList) || eventList.length === 0) throw new Error("cannot replay empty event list");
    const first = eventList[0];
    let state = first.from;
    let version = 0;
    let previousSequence = 0;
    let workflowId = first.workflowId;
    for (const event of eventList) {
      if (
        event.workflowId !== workflowId ||
        event.sequence <= previousSequence ||
        event.from !== state ||
        event.version !== version + 1 ||
        transitions[state]?.[event.type] !== event.to
      ) {
        throw new Error("invalid replay order or transition");
      }
      state = event.to;
      version = event.version;
      previousSequence = event.sequence;
    }
    return { id: workflowId, state, version };
  };

  return {
    transition,
    snapshot,
    events,
    allEvents() {
      return [...workflows.values()].flatMap((workflow) => workflow.events.map(cloneEvent))
        .sort((left, right) => left.sequence - right.sequence);
    },
    replay,
  };
}
`,
  },
  "v3-static-site-pipeline": {
    "src/tokenizer.mjs": `export function tokenize(source) {
  if (typeof source !== "string") throw new TypeError("template source must be a string");
  const tokens = [];
  const expression = /\\{\\{\\s*([>/]?)([^{}]+?)\\s*\\}\\}/g;
  let cursor = 0;
  let match;
  while ((match = expression.exec(source))) {
    if (match.index > cursor) tokens.push({ type: "text", value: source.slice(cursor, match.index) });
    const name = match[2].trim();
    if (!name) throw new Error("empty template tag");
    if (match[1] === ">") tokens.push({ type: "partial", name });
    else if (match[1] === "/") throw new Error("closing tags are not supported");
    else tokens.push({ type: "variable", name });
    cursor = expression.lastIndex;
  }
  if (source.indexOf("{{", cursor) >= 0) throw new Error("unclosed template tag");
  if (cursor < source.length) tokens.push({ type: "text", value: source.slice(cursor) });
  return tokens;
}
`,
    "src/template.mjs": `import { tokenize } from "./tokenizer.mjs";

function lookup(context, name) {
  let value = context;
  for (const part of name.split(".")) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

export function renderTokens(tokens, context = {}, partials = {}, stack = []) {
  if (!Array.isArray(tokens)) throw new TypeError("tokens must be an array");
  return tokens.map((token) => {
    if (token.type === "text") return token.value;
    if (token.type === "variable") {
      const value = lookup(context, token.name);
      return value === undefined || value === null ? "" : String(value);
    }
    if (token.type === "partial") {
      if (!Object.prototype.hasOwnProperty.call(partials, token.name)) return "";
      if (stack.includes(token.name)) throw new Error("recursive partial");
      return renderTemplate(partials[token.name], context, partials, [...stack, token.name]);
    }
    throw new Error("unknown template token");
  }).join("");
}

export function renderTemplate(source, context = {}, partials = {}, stack = []) {
  return renderTokens(tokenize(source), context, partials, stack);
}
`,
    "src/assets.mjs": `import { createHash } from "node:crypto";

function logicalPath(value) {
  if (typeof value !== "string") throw new TypeError("asset path must be a string");
  const normalized = value.replace(/\\\\/g, "/").replace(/^\\.\\//, "");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\\//.test(normalized) || parts.includes("..") || parts.includes("")) {
    throw new Error("unsafe asset path");
  }
  return normalized;
}

export function fingerprintAssets(assets, prefix = "assets") {
  if (!assets || typeof assets !== "object") throw new TypeError("assets must be an object");
  const cleanPrefix = String(prefix).replace(/\\\\/g, "/").replace(/^\\/+|\\/+$/g, "");
  if (!cleanPrefix || cleanPrefix.split("/").includes("..")) throw new Error("unsafe asset prefix");
  const manifest = {};
  const files = {};
  for (const original of Object.keys(assets).sort()) {
    const name = logicalPath(original);
    const content = assets[original];
    if (typeof content !== "string") throw new TypeError("asset content must be a string");
    const digest = createHash("sha256").update(content).digest("hex").slice(0, 8);
    const dot = name.lastIndexOf(".");
    const slash = name.lastIndexOf("/");
    const extension = dot > slash ? name.slice(dot) : "";
    const stem = extension ? name.slice(0, dot) : name;
    const output = cleanPrefix + "/" + stem + "." + digest + extension;
    manifest[name] = output;
    files[output] = content;
  }
  return { manifest, files };
}
`,
    "src/build.mjs": `import { fingerprintAssets } from "./assets.mjs";
import { renderTemplate } from "./template.mjs";

function pagePath(value) {
  if (typeof value !== "string") throw new TypeError("page path must be a string");
  const normalized = value.replace(/\\\\/g, "/").replace(/^\\.\\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\\//.test(normalized) || normalized.split("/").includes("..") || normalized.split("/").includes("")) {
    throw new Error("unsafe page path");
  }
  return normalized;
}

export function buildSite({ pages = {}, data = {}, partials = {}, assets = {}, assetPrefix = "assets" } = {}) {
  const assetResult = fingerprintAssets(assets, assetPrefix);
  const files = { ...assetResult.files };
  for (const original of Object.keys(pages).sort()) {
    const path = pagePath(original);
    if (typeof pages[original] !== "string") throw new TypeError("page content must be a string");
    files[path] = renderTemplate(pages[original], data, partials);
  }
  return { files, manifest: { ...assetResult.manifest } };
}
`,
  },
  "v3-observability-ingestors": {
    "src/trace-jsonl.mjs": `const KNOWN = new Set(["ts", "service", "event", "operation", "status", "duration_ms", "trace_id"]);

function canonical(value, lineNumber) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid telemetry record at line " + lineNumber);
  if (typeof value.ts !== "string" || typeof value.service !== "string" || typeof value.event !== "string" || typeof value.operation !== "string") {
    throw new Error("missing telemetry fields at line " + lineNumber);
  }
  if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599) throw new Error("invalid status at line " + lineNumber);
  if (!Number.isFinite(value.duration_ms) || value.duration_ms < 0) throw new Error("invalid duration at line " + lineNumber);
  const attributes = {};
  for (const key of Object.keys(value).filter((key) => !KNOWN.has(key)).sort()) attributes[key] = value[key];
  return {
    timestamp: value.ts,
    service: value.service,
    kind: value.event,
    operation: value.operation,
    status: value.status,
    durationMs: value.duration_ms,
    traceId: typeof value.trace_id === "string" ? value.trace_id : "",
    attributes,
  };
}

export function parseTraceJsonl(source) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  return source.split(/\\r?\\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("invalid JSON at line " + (index + 1));
    }
    return [canonical(value, index + 1)];
  });
}
`,
    "src/access-log.mjs": `export function parseAccessLog(source) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const records = [];
  for (const [index, line] of source.split(/\\r?\\n/).entries()) {
    if (!line.trim()) continue;
    const match = /^(\\S+)\\s+(\\S+)\\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s+(\\S+)\\s+([1-5]\\d\\d)\\s+(\\d+)ms(?:\\s+trace=(\\S+))?$/.exec(line.trim());
    if (!match) throw new Error("invalid access log line " + (index + 1));
    records.push({
      timestamp: match[1],
      service: match[2],
      kind: "request",
      operation: match[3] + " " + match[4],
      status: Number(match[5]),
      durationMs: Number(match[6]),
      traceId: match[7] ?? "",
      attributes: {},
    });
  }
  return records;
}
`,
    "src/telemetry-merge.mjs": `function cloneRecord(record) {
  return {
    timestamp: record.timestamp,
    service: record.service,
    kind: record.kind,
    operation: record.operation,
    status: record.status,
    durationMs: record.durationMs,
    traceId: record.traceId,
    attributes: Object.fromEntries(Object.entries(record.attributes).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function compare(left, right) {
  for (const key of ["timestamp", "service", "operation", "kind", "traceId"]) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return left.durationMs - right.durationMs || left.status - right.status;
}

function validRecord(record) {
  return record && typeof record === "object" &&
    typeof record.timestamp === "string" && typeof record.service === "string" &&
    typeof record.kind === "string" && typeof record.operation === "string" &&
    Number.isInteger(record.status) && Number.isFinite(record.durationMs) &&
    typeof record.traceId === "string" && record.attributes && typeof record.attributes === "object";
}

export function mergeTelemetry(...batches) {
  const selected = new Map();
  for (const batch of batches) {
    if (!Array.isArray(batch)) throw new TypeError("telemetry batches must be arrays");
    for (const record of batch) {
      if (!validRecord(record)) throw new TypeError("invalid telemetry record");
      const copy = cloneRecord(record);
      const key = copy.traceId || [copy.timestamp, copy.service, copy.kind, copy.operation, copy.status, copy.durationMs].join("|");
      const prior = selected.get(key);
      if (!prior || JSON.stringify(copy) < JSON.stringify(prior)) selected.set(key, copy);
    }
  }
  return [...selected.values()].sort(compare);
}
`,
  },
  "v3-markup-renderers": {
    "src/ast.mjs": `const BLOCKS = new Set(["heading", "paragraph", "list", "code-block"]);
const INLINES = new Set(["text", "emphasis", "link"]);

function fail(message) {
  throw new TypeError("invalid markup node: " + message);
}

function validateInline(node) {
  if (!node || typeof node !== "object" || !INLINES.has(node.type)) fail("type");
  if (node.type === "text") {
    if (typeof node.value !== "string") fail("text value");
    return;
  }
  if (!Array.isArray(node.children)) fail("children");
  if (node.type === "link" && (typeof node.href !== "string" || node.href.length === 0)) fail("link href");
  for (const child of node.children) validateInline(child);
}

function validateBlock(node) {
  if (!node || typeof node !== "object" || !BLOCKS.has(node.type)) fail("block type");
  if (node.type === "code-block") {
    if (typeof node.value !== "string" || (node.language !== null && typeof node.language !== "string")) fail("code block");
    return;
  }
  if (node.type === "heading") {
    if (!Number.isInteger(node.level) || node.level < 1 || node.level > 6) fail("heading level");
    if (!Array.isArray(node.children)) fail("heading children");
    for (const child of node.children) validateInline(child);
    return;
  }
  if (node.type === "paragraph") {
    if (!Array.isArray(node.children)) fail("paragraph children");
    for (const child of node.children) validateInline(child);
    return;
  }
  if (typeof node.ordered !== "boolean" || !Array.isArray(node.items)) fail("list");
  for (const item of node.items) {
    if (!item || item.type !== "list-item" || !Array.isArray(item.children)) fail("list item");
    for (const child of item.children) validateInline(child);
  }
}

export function assertDocument(ast) {
  if (!ast || ast.type !== "document" || !Array.isArray(ast.children)) fail("document");
  for (const child of ast.children) validateBlock(child);
  return ast;
}
`,
    "src/render-html.mjs": `import { assertDocument } from "./ast.mjs";

const escape = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\\\"/g, "&quot;")
  .replace(/'/g, "&#39;");

function inline(node) {
  if (node.type === "text") return escape(node.value);
  if (node.type === "emphasis") return "<em>" + node.children.map(inline).join("") + "</em>";
  const quote = String.fromCharCode(34);
  return "<a href=" + quote + escape(node.href) + quote + ">" + node.children.map(inline).join("") + "</a>";
}

export function renderHtml(ast) {
  assertDocument(ast);
  return ast.children.map((node) => {
    if (node.type === "heading") return "<h" + node.level + ">" + node.children.map(inline).join("") + "</h" + node.level + ">";
    if (node.type === "paragraph") return "<p>" + node.children.map(inline).join("") + "</p>";
    if (node.type === "list") {
      const tag = node.ordered ? "ol" : "ul";
      return "<" + tag + ">\\n" + node.items.map((item) => "<li>" + item.children.map(inline).join("") + "</li>").join("\\n") + "\\n</" + tag + ">";
    }
    const quote = String.fromCharCode(34);
    const language = node.language ? " class=" + quote + "language-" + escape(node.language) + quote : "";
    return "<pre><code" + language + ">" + escape(node.value) + "</code></pre>";
  }).join("\\n");
}
`,
    "src/render-text.mjs": `import { assertDocument } from "./ast.mjs";

function inline(node) {
  if (node.type === "text") return node.value;
  if (node.type === "emphasis" || node.type === "link") return node.children.map(inline).join("");
  return "";
}

export function renderPlainText(ast) {
  assertDocument(ast);
  const lines = [];
  for (const node of ast.children) {
    if (node.type === "heading" || node.type === "paragraph") lines.push(node.children.map(inline).join(""));
    else if (node.type === "list") {
      node.items.forEach((item, index) => lines.push((node.ordered ? String(index + 1) + ". " : "- ") + item.children.map(inline).join("")));
    } else lines.push(node.value);
  }
  return lines.join("\\n");
}
`,
    "src/render-markdown.mjs": `import { assertDocument } from "./ast.mjs";

function inline(node) {
  if (node.type === "text") return node.value;
  if (node.type === "emphasis") return "*" + node.children.map(inline).join("") + "*";
  return "[" + node.children.map(inline).join("") + "](" + node.href + ")";
}

export function renderMarkdown(ast) {
  assertDocument(ast);
  const blocks = [];
  const fence = String.fromCharCode(96).repeat(3);
  for (const node of ast.children) {
    if (node.type === "heading") blocks.push("#".repeat(node.level) + " " + node.children.map(inline).join(""));
    else if (node.type === "paragraph") blocks.push(node.children.map(inline).join(""));
    else if (node.type === "list") {
      blocks.push(node.items.map((item, index) => (node.ordered ? String(index + 1) + ". " : "- ") + item.children.map(inline).join("")).join("\\n"));
    } else blocks.push(fence + (node.language ?? "") + "\\n" + node.value + "\\n" + fence);
  }
  return blocks.join("\\n\\n");
}
`,
  },
  "v3-policy-engine": {
    "src/policy.mjs": `function scan(source) {
  if (typeof source !== "string") throw new TypeError("policy source must be a string");
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\\s/.test(character)) {
      index += 1;
      continue;
    }
    if ("()[],".includes(character)) {
      tokens.push({ kind: character, value: character });
      index += 1;
      continue;
    }
    const two = source.slice(index, index + 2);
    if (["==", "!=", ">=", "<="].includes(two)) {
      tokens.push({ kind: "operator", value: two });
      index += 2;
      continue;
    }
    if ([">", "<"].includes(character)) {
      tokens.push({ kind: "operator", value: character });
      index += 1;
      continue;
    }
    if (character === "\\\"" || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source[index++];
        if (current === quote) {
          closed = true;
          break;
        }
        if (current === "\\\\") {
          if (index >= source.length) break;
          const escaped = source[index++];
          value += ({ n: "\\n", r: "\\r", t: "\\t" }[escaped] ?? escaped);
        } else value += current;
      }
      if (!closed) throw new SyntaxError("unterminated policy string");
      tokens.push({ kind: "literal", value });
      continue;
    }
    const number = /^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?/.exec(source.slice(index));
    if (number) {
      tokens.push({ kind: "literal", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(index));
    if (identifier) {
      const word = identifier[0];
      if (["and", "or", "not", "contains", "in"].includes(word)) tokens.push({ kind: "operator", value: word });
      else if (word === "true" || word === "false") tokens.push({ kind: "literal", value: word === "true" });
      else if (word === "null") tokens.push({ kind: "literal", value: null });
      else if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(word)) throw new SyntaxError("invalid policy identifier");
      else tokens.push({ kind: "path", value: word });
      index += word.length;
      continue;
    }
    throw new SyntaxError("unexpected policy character at " + index);
  }
  tokens.push({ kind: "eof", value: "eof" });
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek() {
    return this.tokens[this.index];
  }

  take(kind, value) {
    const token = this.peek();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new SyntaxError("unexpected policy token");
    }
    this.index += 1;
    return token;
  }

  parse() {
    const expression = this.parseOr();
    if (this.peek().kind !== "eof") throw new SyntaxError("trailing policy input");
    return expression;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek().kind === "operator" && this.peek().value === "or") {
      this.index += 1;
      left = { type: "binary", operator: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseUnary();
    while (this.peek().kind === "operator" && this.peek().value === "and") {
      this.index += 1;
      left = { type: "binary", operator: "and", left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary() {
    if (this.peek().kind === "operator" && this.peek().value === "not") {
      this.index += 1;
      return { type: "unary", operator: "not", argument: this.parseUnary() };
    }
    return this.parseComparison();
  }

  parseComparison() {
    let left = this.parsePrimary();
    const token = this.peek();
    if (token.kind === "operator" && ["==", "!=", ">", ">=", "<", "<=", "contains", "in"].includes(token.value)) {
      this.index += 1;
      left = { type: "binary", operator: token.value, left, right: this.parsePrimary() };
    }
    return left;
  }

  parsePrimary() {
    const token = this.peek();
    if (token.kind === "(") {
      this.index += 1;
      const expression = this.parseOr();
      this.take(")");
      return expression;
    }
    if (token.kind === "literal") {
      this.index += 1;
      return { type: "literal", value: token.value };
    }
    if (token.kind === "path") {
      this.index += 1;
      return { type: "path", parts: token.value.split(".") };
    }
    if (token.kind === "[") {
      this.index += 1;
      const items = [];
      if (this.peek().kind !== "]") {
        while (true) {
          items.push(this.parsePrimary());
          if (this.peek().kind === "]") break;
          this.take(",");
        }
      }
      this.take("]");
      return { type: "array", items };
    }
    throw new SyntaxError("expected policy value");
  }
}

export function parsePolicy(source) {
  return new Parser(scan(source)).parse();
}

const MISSING = Symbol("missing");

function valueOf(node, subject) {
  if (node.type === "literal") return node.value;
  if (node.type === "array") return node.items.map((item) => valueOf(item, subject));
  if (node.type === "path") {
    let value = subject;
    for (const part of node.parts) {
      if (value === null || value === undefined || typeof value !== "object" || !(part in value)) return MISSING;
      value = value[part];
    }
    return value;
  }
  return evaluate(node, subject);
}

function evaluate(node, subject) {
  if (node.type === "literal" || node.type === "array" || node.type === "path") return valueOf(node, subject);
  if (node.type === "unary") return !Boolean(evaluate(node.argument, subject));
  if (node.operator === "and") return Boolean(evaluate(node.left, subject)) && Boolean(evaluate(node.right, subject));
  if (node.operator === "or") return Boolean(evaluate(node.left, subject)) || Boolean(evaluate(node.right, subject));
  const left = valueOf(node.left, subject);
  const right = valueOf(node.right, subject);
  if (left === MISSING || right === MISSING) return node.operator === "!=" && left !== right;
  if (node.operator === "==") return Object.is(left, right);
  if (node.operator === "!=") return !Object.is(left, right);
  if (node.operator === ">") return left > right;
  if (node.operator === ">=") return left >= right;
  if (node.operator === "<") return left < right;
  if (node.operator === "<=") return left <= right;
  if (node.operator === "contains") return Array.isArray(left) ? left.some((item) => Object.is(item, right)) : typeof left === "string" && left.includes(String(right));
  if (node.operator === "in") return Array.isArray(right) && right.some((item) => Object.is(item, left));
  throw new Error("unknown policy operator");
}

export function compilePolicy(source) {
  const ast = parsePolicy(source);
  return {
    source,
    ast,
    evaluate(subject = {}) {
      return Boolean(evaluate(ast, subject));
    },
  };
}

export function createPolicyEngine({ maxEntries = 64 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be positive");
  const cache = new Map();
  let hits = 0;
  let misses = 0;
  const compile = (source) => {
    if (cache.has(source)) {
      const program = cache.get(source);
      cache.delete(source);
      cache.set(source, program);
      hits += 1;
      return program;
    }
    misses += 1;
    const program = compilePolicy(source);
    cache.set(source, program);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return program;
  };
  return {
    compile,
    evaluate(source, subject = {}) {
      return compile(source).evaluate(subject);
    },
    cacheStats() {
      return { hits, misses, size: cache.size };
    },
    clear() {
      cache.clear();
    },
  };
}
`,
  },
  "v3-sync-reconciler": {
    "src/sync-reconciler.mjs": `function normalizePath(value) {
  if (typeof value !== "string") throw new TypeError("path must be a string");
  const normalized = value.replace(/\\\\/g, "/").replace(/^\\.\\//, "");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\\//.test(normalized) || parts.includes("..") || parts.includes("")) {
    throw new Error("unsafe path");
  }
  return normalized;
}

function normalizeTree(tree) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) throw new TypeError("tree must be an object");
  const result = {};
  for (const [rawPath, content] of Object.entries(tree)) {
    const path = normalizePath(rawPath);
    if (Object.prototype.hasOwnProperty.call(result, path)) throw new Error("duplicate normalized path");
    if (typeof content !== "string") throw new TypeError("file content must be a string");
    result[path] = content;
  }
  return result;
}

const has = (tree, path) => Object.prototype.hasOwnProperty.call(tree, path);
const same = (left, right) => left.present === right.present && (!left.present || left.value === right.value);

function detectRenames(base, local, remote, merged, operations) {
  const candidates = [];
  for (const oldPath of Object.keys(base).sort()) {
    if (has(merged, oldPath)) continue;
    for (const newPath of Object.keys(merged).sort()) {
      if (has(base, newPath) || base[oldPath] !== merged[newPath]) continue;
      const localRename = !has(local, oldPath) && has(local, newPath) && local[newPath] === base[oldPath];
      const remoteRename = !has(remote, oldPath) && has(remote, newPath) && remote[newPath] === base[oldPath];
      if (localRename || remoteRename) candidates.push({ oldPath, newPath, content: base[oldPath] });
    }
  }
  for (const rename of candidates) {
    const deleteIndex = operations.findIndex((operation) => operation.type === "delete" && operation.path === rename.oldPath);
    const writeIndex = operations.findIndex((operation) => operation.type === "write" && operation.path === rename.newPath && operation.content === rename.content);
    if (deleteIndex >= 0 && writeIndex >= 0) {
      operations.splice(Math.max(deleteIndex, writeIndex), 1);
      operations.splice(Math.min(deleteIndex, writeIndex), 1);
      operations.push({ type: "rename", from: rename.oldPath, path: rename.newPath, content: rename.content });
    }
  }
}

export function planReconciliation(base, local, remote) {
  const common = normalizeTree(base);
  const left = normalizeTree(local);
  const right = normalizeTree(remote);
  const paths = [...new Set([...Object.keys(common), ...Object.keys(left), ...Object.keys(right)])].sort();
  const merged = {};
  const conflicts = [];
  for (const path of paths) {
    const baseValue = { present: has(common, path), value: common[path] };
    const localValue = { present: has(left, path), value: left[path] };
    const remoteValue = { present: has(right, path), value: right[path] };
    if (same(localValue, remoteValue)) {
      if (localValue.present) merged[path] = localValue.value;
    } else if (same(localValue, baseValue)) {
      if (remoteValue.present) merged[path] = remoteValue.value;
    } else if (same(remoteValue, baseValue)) {
      if (localValue.present) merged[path] = localValue.value;
    } else {
      conflicts.push({
        path,
        base: baseValue.present ? baseValue.value : null,
        local: localValue.present ? localValue.value : null,
        remote: remoteValue.present ? remoteValue.value : null,
      });
    }
  }
  const operations = [];
  for (const path of Object.keys(common).sort()) {
    if (!has(merged, path)) {
      if (!conflicts.some((conflict) => conflict.path === path)) operations.push({ type: "delete", path });
    } else if (common[path] !== merged[path]) {
      operations.push({ type: "write", path, content: merged[path] });
    }
  }
  for (const path of Object.keys(merged).sort()) {
    if (!has(common, path)) operations.push({ type: "write", path, content: merged[path] });
  }
  detectRenames(common, left, right, merged, operations);
  operations.sort((leftOperation, rightOperation) => {
    const leftPath = leftOperation.path;
    const rightPath = rightOperation.path;
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : leftOperation.type.localeCompare(rightOperation.type);
  });
  return { operations, conflicts };
}

export function applyReconciliation(tree, plan) {
  const result = normalizeTree(tree);
  if (!plan || !Array.isArray(plan.operations) || !Array.isArray(plan.conflicts)) throw new TypeError("invalid reconciliation plan");
  if (plan.conflicts.length > 0) throw new Error("cannot apply unresolved conflicts");
  for (const operation of plan.operations) {
    if (operation.type === "write") {
      const path = normalizePath(operation.path);
      if (typeof operation.content !== "string") throw new TypeError("file content must be a string");
      result[path] = operation.content;
    } else if (operation.type === "delete") {
      delete result[normalizePath(operation.path)];
    } else if (operation.type === "rename") {
      const from = normalizePath(operation.from);
      const path = normalizePath(operation.path);
      if (!has(result, from)) throw new Error("rename source is missing");
      if (typeof operation.content !== "string") throw new TypeError("file content must be a string");
      delete result[from];
      result[path] = operation.content;
    } else {
      throw new Error("unknown reconciliation operation");
    }
  }
  return result;
}
`,
  },
};
