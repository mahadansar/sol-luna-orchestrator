/** Known-good solutions for Benchmark V2 fixtures. */

export const V2_SOLUTIONS: Record<string, Record<string, string>> = {
  "v2-config-overlay": {
    "src/config.mjs": `const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

export function mergeConfig(base, patch) {
  const result = isPlainObject(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeConfig(result[key], value);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

function parseValue(raw) {
  let value;
  try {
    value = decodeURIComponent(raw);
  } catch {
    value = raw;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$/.test(value)) return Number(value);
  return value;
}

export function parseEnvOverrides(entries, prefix = "APP") {
  const result = {};
  const marker = String(prefix).toUpperCase() + "__";
  for (const entry of entries ?? []) {
    if (typeof entry !== "string") continue;
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const name = entry.slice(0, separator);
    if (name.toUpperCase().startsWith(marker) === false) continue;
    const parts = name.slice(marker.length).split("__");
    if (parts.some((part) => !/^[A-Za-z0-9]+$/.test(part))) continue;
    let target = result;
    for (const part of parts.slice(0, -1)) {
      const key = part.toLowerCase();
      if (!isPlainObject(target[key])) target[key] = {};
      target = target[key];
    }
    if (parts.length > 0) target[parts[parts.length - 1].toLowerCase()] = parseValue(entry.slice(separator + 1));
  }
  return result;
}
`,
  },
  "v2-rate-limiter-tests": {
    "test/rate-limit.test.mjs": `import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowLimiter } from "../src/rate-limit.mjs";

test("validates constructor options", () => {
  assert.throws(() => new FixedWindowLimiter({ limit: 0, windowMs: 10 }), /limit/i);
  assert.throws(() => new FixedWindowLimiter({ limit: 1, windowMs: 0 }), /windowMs/i);
});

test("allows exactly the limit and then denies the key", () => {
  const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 100, now: () => 0 });
  assert.deepEqual(limiter.allow("user"), { allowed: true, remaining: 1, resetAt: 100 });
  assert.deepEqual(limiter.allow("user"), { allowed: true, remaining: 0, resetAt: 100 });
  assert.deepEqual(limiter.allow("user"), { allowed: false, remaining: 0, resetAt: 100 });
});

test("starts a fresh window at the exact reset boundary", () => {
  let now = 0;
  const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 100, now: () => now });
  assert.equal(limiter.allow("user").allowed, true);
  assert.equal(limiter.allow("user").allowed, false);
  now = 100;
  assert.deepEqual(limiter.allow("user"), { allowed: true, remaining: 0, resetAt: 200 });
});

test("keeps windows independent by key", () => {
  const limiter = new FixedWindowLimiter({ limit: 1, windowMs: 100, now: () => 0 });
  assert.equal(limiter.allow("a").allowed, true);
  assert.equal(limiter.allow("a").allowed, false);
  assert.equal(limiter.allow("b").allowed, true);
});
`,
  },
  "v2-frontmatter-parser": {
    "src/frontmatter.mjs": `function parseScalar(raw) {
  const value = raw.trim();
  if ((value.startsWith("\\\"") && value.endsWith("\\\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$/.test(value)) return Number(value);
  return value;
}

function splitArray(value) {
  const parts = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === String.fromCharCode(34) || char === "'") && (i === 0 || value[i - 1] !== String.fromCharCode(92))) {
      quote = quote === char ? "" : quote || char;
    } else if (char === "," && !quote) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter((part) => part.length > 0).map(parseScalar);
}

function parseValue(value) {
  return value.includes(",") ? splitArray(value) : parseScalar(value);
}

export function parseDocument(source) {
  if (typeof source !== "string") throw new TypeError("source must be a string");
  const lines = source.split("\\n");
  if (lines[0] !== "---") return { data: {}, content: source };
  const end = lines.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
  if (end < 0) throw new Error("unterminated front matter");

  const data = {};
  for (const rawLine of lines.slice(1, end)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("invalid metadata line");
    const key = line.slice(0, colon).trim();
    if (Object.prototype.hasOwnProperty.call(data, key)) throw new Error("duplicate metadata key");
    data[key] = parseValue(line.slice(colon + 1).trim());
  }
  return { data, content: lines.slice(end + 1).join("\\n").replace(/^\\n/, "") };
}
`,
  },
  "v2-worker-pool": {
    "src/worker-pool.mjs": `export async function runPool(items, worker, options = {}) {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a positive integer");
  }
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  const results = new Array(items.length);
  let next = 0;

  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => consume()));
  return results;
}
`,
  },
  "v2-integration-toolkit": {
    "src/route-key.mjs": `export function toRouteKey(input, options = {}) {
  const maxLength = options.maxLength ?? 64;
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new RangeError("maxLength must be positive");
  const normalized = String(input ?? "")
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized.length <= maxLength) return normalized;
  const words = normalized.split("-");
  let result = "";
  for (const word of words) {
    const candidate = result ? result + "-" + word : word;
    if (candidate.length > maxLength) {
      if (!result) return word.slice(0, maxLength);
      break;
    }
    result = candidate;
  }
  return result;
}
`,
    "src/money.mjs": `const SYMBOLS = { USD: "$", EUR: "€", GBP: "£" };

export function formatCents(cents, currency = "USD") {
  if (!Number.isSafeInteger(cents)) throw new TypeError("cents must be an integer");
  const code = String(currency).toUpperCase();
  const symbol = SYMBOLS[code];
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100).toLocaleString("en-US");
  const fraction = String(absolute % 100).padStart(2, "0");
  return symbol ? sign + symbol + whole + "." + fraction : sign + code + " " + whole + "." + fraction;
}

export function parseCents(value, currency = "USD") {
  if (typeof value !== "string") throw new TypeError("amount must be a string");
  const code = String(currency).toUpperCase();
  const symbol = SYMBOLS[code];
  let text = value.trim().replace(/,/g, "");
  if (text.startsWith("-")) text = "-" + text.slice(1).trim();
  const sign = text.startsWith("-") ? -1 : 1;
  if (sign < 0) text = text.slice(1).trim();
  if (symbol && text.startsWith(symbol)) text = text.slice(symbol.length).trim();
  else if (text.toUpperCase().startsWith(code + " ")) text = text.slice(code.length).trim();
  else if (/^[A-Z]{3}\\s/.test(text)) text = text.slice(4).trim();
  const match = /^(0|[1-9][0-9]*)(?:\\.([0-9]{1,2}))?$/.exec(text);
  if (!match) throw new TypeError("invalid amount");
  return sign * (Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")));
}
`,
    "src/retry.mjs": `export async function retry(operation, options = {}) {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const sleep = options.sleep ?? (async () => {});
  const shouldRetry = options.shouldRetry ?? (() => true);
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts must be positive");
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) throw new RangeError("baseDelayMs must be non-negative");
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) throw error;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}
`,
    "src/headers.mjs": `const TOKEN = /^[!#$%&'*+\\-.^_\\x60|~0-9A-Za-z]+$/;

function validate(name, value) {
  if (typeof name !== "string" || !TOKEN.test(name)) throw new TypeError("invalid header name");
  if (typeof value !== "string" || /[\\r\\n]/.test(value)) throw new TypeError("invalid header value");
}

export class HeaderBag {
  #entries = new Map();

  constructor(initial = {}) {
    for (const [name, value] of Object.entries(initial)) this.set(name, value);
  }

  set(name, value) {
    validate(name, value);
    const key = name.toLowerCase();
    const existing = this.#entries.get(key);
    this.#entries.set(key, { name: existing?.name ?? name, value });
    return this;
  }

  append(name, value) {
    validate(name, value);
    const key = name.toLowerCase();
    const existing = this.#entries.get(key);
    if (!existing) this.#entries.set(key, { name, value });
    else existing.value = existing.value + ", " + value;
    return this;
  }

  get(name) { return this.#entries.get(String(name).toLowerCase())?.value; }
  has(name) { return this.#entries.has(String(name).toLowerCase()); }
  delete(name) { return this.#entries.delete(String(name).toLowerCase()); }

  toObject() {
    return Object.fromEntries([...this.#entries.values()]
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .map(({ name, value }) => [name, value]));
  }
}
`,
  },
  "v2-data-contracts": {
    "src/jsonpatch.mjs": `function clone(value) {
  return structuredClone(value);
}

function parts(pointer) {
  if (pointer === "") return [];
  if (typeof pointer !== "string" || !pointer.startsWith("/")) throw new Error("invalid JSON Pointer");
  return pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function child(node, key) {
  if (node === null || typeof node !== "object") throw new Error("path does not exist");
  if (Array.isArray(node)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= node.length) throw new Error("array path does not exist");
    return node[Number(key)];
  }
  if (!Object.prototype.hasOwnProperty.call(node, key)) throw new Error("path does not exist");
  return node[key];
}

function parent(document, pointer) {
  const tokens = parts(pointer);
  if (tokens.length === 0) throw new Error("root has no parent");
  let node = document;
  for (const token of tokens.slice(0, -1)) node = child(node, token);
  return { node, key: tokens[tokens.length - 1] };
}

function read(document, pointer) {
  let node = document;
  for (const token of parts(pointer)) node = child(node, token);
  return node;
}

function add(document, pointer, value) {
  const { node, key } = parent(document, pointer);
  if (Array.isArray(node)) {
    if (key === "-") node.push(value);
    else if (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) <= node.length) node.splice(Number(key), 0, value);
    else throw new Error("invalid array index");
  } else if (node !== null && typeof node === "object") node[key] = value;
  else throw new Error("path does not exist");
}

function remove(document, pointer) {
  const { node, key } = parent(document, pointer);
  if (Array.isArray(node)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= node.length) throw new Error("path does not exist");
    return node.splice(Number(key), 1)[0];
  }
  if (node === null || typeof node !== "object" || !Object.prototype.hasOwnProperty.call(node, key)) throw new Error("path does not exist");
  const value = node[key];
  delete node[key];
  return value;
}

export function applyPatch(document, operations) {
  const result = clone(document);
  for (const operation of operations) {
    if (!operation || typeof operation.op !== "string") throw new Error("invalid operation");
    if (operation.op === "add") add(result, operation.path, clone(operation.value));
    else if (operation.op === "replace") {
      read(result, operation.path);
      const { node, key } = parent(result, operation.path);
      if (Array.isArray(node)) node[Number(key)] = clone(operation.value);
      else node[key] = clone(operation.value);
    } else if (operation.op === "remove") remove(result, operation.path);
    else if (operation.op === "copy") add(result, operation.path, clone(read(result, operation.from)));
    else if (operation.op === "move") add(result, operation.path, remove(result, operation.from));
    else if (operation.op === "test") {
      if (JSON.stringify(read(result, operation.path)) !== JSON.stringify(operation.value)) throw new Error("test operation failed");
    } else throw new Error("unknown operation");
  }
  return result;
}
`,
    "src/etag.mjs": `function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value.toString(16);
}

export function makeEtag(value, options = {}) {
  const tag = "\\\"" + hash(stable(value)) + "\\\"";
  return options.weak ? "W/" + tag : tag;
}

export function matchesIfNoneMatch(current, header) {
  if (current === undefined || current === null || typeof header !== "string") return false;
  if (header.trim() === "*") return true;
  const normalize = (tag) => tag.trim().replace(/^W\\//, "");
  const wanted = normalize(current);
  return header.split(",").some((tag) => normalize(tag) === wanted);
}
`,
    "src/circuit-breaker.mjs": `export class CircuitBreaker {
  #failureThreshold;
  #cooldownMs;
  #now;
  #state = "closed";
  #failures = 0;
  #openedAt = 0;
  #probe = false;

  constructor({ failureThreshold = 3, cooldownMs = 1000, now = Date.now } = {}) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new RangeError("failureThreshold must be positive");
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new RangeError("cooldownMs must be non-negative");
    this.#failureThreshold = failureThreshold;
    this.#cooldownMs = cooldownMs;
    this.#now = now;
  }

  get state() { return this.#state; }

  async execute(operation) {
    if (this.#state === "open") {
      if (this.#now() - this.#openedAt < this.#cooldownMs) throw new Error("circuit is open");
      this.#state = "half-open";
      this.#probe = true;
    } else if (this.#state === "half-open" && this.#probe) {
      throw new Error("circuit is open for a probe");
    }
    try {
      const result = await operation();
      this.#state = "closed";
      this.#failures = 0;
      this.#probe = false;
      return result;
    } catch (error) {
      this.#failures += 1;
      if (this.#state === "half-open" || this.#failures >= this.#failureThreshold) {
        this.#state = "open";
        this.#openedAt = this.#now();
        this.#probe = false;
      }
      throw error;
    }
  }
}
`,
  },
  "v2-repository-tools": {
    "src/manifest.mjs": `const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const VERSION = /^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

export function validateManifest(manifest) {
  const errors = [];
  const value = manifest ?? {};
  const name = typeof value.name === "string" ? value.name.toLowerCase() : "";
  if (!NAME.test(name)) errors.push({ field: "name", message: "name is invalid" });
  if (typeof value.version !== "string" || !VERSION.test(value.version)) errors.push({ field: "version", message: "version must be semver" });
  if (value.type !== "module" && value.type !== "commonjs") errors.push({ field: "type", message: "type must be module or commonjs" });
  if (!value.scripts || typeof value.scripts !== "object" || typeof value.scripts.test !== "string" || value.scripts.test.trim() === "") {
    errors.push({ field: "scripts", message: "scripts.test is required" });
  }
  errors.sort((a, b) => a.field.localeCompare(b.field));
  return errors.length === 0 ? { valid: true, errors: [], normalizedName: name } : { valid: false, errors };
}
`,
    "src/path-policy.mjs": `import path from "node:path";

export function assertSafeRelativePath(root, candidate) {
  if (typeof root !== "string" || typeof candidate !== "string" || candidate.length === 0) throw new Error("invalid path");
  const portable = candidate.replace(/\\\\/g, "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\\//.test(portable)) throw new Error("path must be relative");
  const base = path.resolve(root);
  const resolved = path.resolve(base, portable);
  const relative = path.relative(base, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("path escapes root");
  }
  return resolved;
}
`,
    "src/change-set.mjs": `const STATUSES = new Set(["added", "modified", "deleted"]);

export function summarizeChanges(changes) {
  const latest = new Map();
  for (const change of changes ?? []) {
    if (!change || typeof change.path !== "string" || !STATUSES.has(change.status)) throw new TypeError("invalid change status");
    if (!Number.isInteger(change.linesAdded) || change.linesAdded < 0 || !Number.isInteger(change.linesDeleted) || change.linesDeleted < 0) throw new TypeError("invalid line counts");
    latest.set(change.path, {
      path: change.path,
      status: change.status,
      linesAdded: change.linesAdded,
      linesDeleted: change.linesDeleted,
    });
  }
  const files = [...latest.values()].sort((a, b) => a.path.localeCompare(b.path));
  const counts = { added: 0, modified: 0, deleted: 0 };
  let linesAdded = 0;
  let linesDeleted = 0;
  for (const file of files) {
    counts[file.status] += 1;
    linesAdded += file.linesAdded;
    linesDeleted += file.linesDeleted;
  }
  const codeChange = files.some((file) => /^(?:src|lib|test)\\//.test(file.path));
  const risk = codeChange || counts.deleted > 0 || linesAdded + linesDeleted > 20 ? "high" : files.length === 0 || files.every((file) => /^(?:README|docs\\/)/i.test(file.path)) ? "low" : "medium";
  return { files, counts, linesAdded, linesDeleted, risk };
}
`,
  },
  "v2-checkout-engine": {
    "src/checkout.mjs": `function cloneCatalog(catalog) {
  return new Map(Object.entries(catalog ?? {}).map(([sku, item]) => [sku, { ...item }]));
}

function roundTax(value) {
  return Math.round(value);
}

export function createCheckout({ catalog, taxRate = 0, shippingRates = {}, coupons = {} } = {}) {
  const stock = cloneCatalog(catalog);
  const completed = new Map();
  const rates = { ...shippingRates };

  function quote(order) {
    if (!order || typeof order.id !== "string" || order.id.length === 0) throw new Error("order id is required");
    if (!Array.isArray(order.items) || order.items.length === 0) throw new Error("items are required");
    const items = order.items.map((line) => {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new RangeError("quantity must be positive");
      const product = stock.get(line.sku);
      if (!product) throw new Error("unknown sku");
      if (line.quantity > product.stock) throw new Error("insufficient stock");
      return {
        sku: line.sku,
        name: product.name,
        quantity: line.quantity,
        unitPriceCents: product.priceCents,
        lineTotalCents: product.priceCents * line.quantity,
      };
    });
    const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
    let discountCents = 0;
    if (order.coupon !== undefined) {
      const coupon = coupons[order.coupon];
      if (!coupon) throw new Error("unknown coupon");
      discountCents = coupon.kind === "percent" ? Math.round(subtotalCents * coupon.value / 100) : coupon.kind === "fixed" ? coupon.value : (() => { throw new Error("invalid coupon"); })();
      discountCents = Math.min(subtotalCents, discountCents);
    }
    const taxableCents = subtotalCents - discountCents;
    const shippingName = order.shipping ?? "standard";
    const shippingCents = rates[shippingName] ?? (() => { throw new Error("unknown shipping"); })();
    const taxCents = roundTax(taxableCents * taxRate);
    return {
      subtotalCents,
      discountCents,
      shippingCents,
      taxableCents,
      taxCents,
      totalCents: taxableCents + shippingCents + taxCents,
      items,
    };
  }

  return {
    quote,
    commit(order) {
      if (completed.has(order?.id)) return completed.get(order.id);
      const result = quote(order);
      for (const line of order.items) stock.get(line.sku).stock -= line.quantity;
      completed.set(order.id, result);
      return result;
    },
    stock(sku) {
      const product = stock.get(sku);
      if (!product) throw new Error("unknown sku");
      return product.stock;
    },
  };
}
`,
  },
};
