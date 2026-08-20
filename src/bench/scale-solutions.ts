/**
 * Known-good solutions for the scale suite.
 *
 * These exist only so `bench:validate` can prove the grader accepts correct
 * work, exactly as `parallel-solutions.ts` does for the parallel suite. They are
 * never shown to a model — a fixture that only ever fails would score every arm
 * identically and tell us nothing.
 */

export const SCALE_SOLUTIONS: Record<string, Record<string, string>> = {
  // -------------------------------------------------------------------------
  "scale-svckit": {
    "src/jsonpointer.mjs": `function segments(pointer) {
  if (pointer === "") return [];
  if (typeof pointer !== "string" || pointer[0] !== "/") {
    throw new Error("invalid pointer: " + String(pointer));
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function childOf(node, key) {
  if (node === null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
    return node[Number(key)];
  }
  return Object.prototype.hasOwnProperty.call(node, key) ? node[key] : undefined;
}

export function get(doc, pointer) {
  const parts = segments(pointer);
  let node = doc;
  for (const part of parts) {
    node = childOf(node, part);
    if (node === undefined) return undefined;
  }
  return node;
}

export function set(doc, pointer, value) {
  const parts = segments(pointer);
  if (parts.length === 0) throw new Error("invalid pointer: cannot replace the root");

  let node = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (Array.isArray(node)) {
      const index = Number(key);
      if (!/^(0|[1-9][0-9]*)$/.test(key) || index >= node.length) {
        throw new Error("invalid array index: " + key);
      }
      node = node[index];
      continue;
    }
    if (node[key] === undefined || node[key] === null || typeof node[key] !== "object") {
      node[key] = {};
    }
    node = node[key];
  }

  const last = parts[parts.length - 1];
  if (Array.isArray(node)) {
    if (last === "-") {
      node.push(value);
      return doc;
    }
    const index = Number(last);
    if (!/^(0|[1-9][0-9]*)$/.test(last) || index > node.length) {
      throw new Error("invalid array index: " + last);
    }
    node[index] = value;
    return doc;
  }
  node[last] = value;
  return doc;
}

export function remove(doc, pointer) {
  const parts = segments(pointer);
  if (parts.length === 0) return undefined;

  let node = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    node = childOf(node, parts[i]);
    if (node === null || typeof node !== "object") return undefined;
  }

  const last = parts[parts.length - 1];
  if (Array.isArray(node)) {
    if (!/^(0|[1-9][0-9]*)$/.test(last)) return undefined;
    const index = Number(last);
    if (index >= node.length) return undefined;
    return node.splice(index, 1)[0];
  }
  if (node === null || typeof node !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(node, last)) return undefined;
  const previous = node[last];
  delete node[last];
  return previous;
}
`,
    "src/lru.mjs": `export function createCache(options = {}) {
  const capacity = options.capacity;
  const ttlMs = options.ttlMs;
  const now = options.now ?? Date.now;

  if (!Number.isFinite(capacity) || capacity < 1) {
    throw new Error("capacity must be at least 1");
  }

  // Map iteration order is insertion order, so re-inserting on read gives LRU
  // ordering for free: the first key is the least recently used.
  const entries = new Map();

  const expired = (entry) => ttlMs !== undefined && now() - entry.storedAt >= ttlMs;

  const live = (key) => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (expired(entry)) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  const sweep = () => {
    for (const [key, entry] of [...entries]) {
      if (expired(entry)) entries.delete(key);
    }
  };

  return {
    get(key) {
      const entry = live(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value, storedAt: now() });
      sweep();
      while (entries.size > capacity) {
        entries.delete(entries.keys().next().value);
      }
    },
    has(key) {
      return live(key) !== undefined;
    },
    delete(key) {
      return entries.delete(key);
    },
    size() {
      sweep();
      return entries.size;
    },
    keys() {
      sweep();
      return [...entries.keys()].reverse();
    },
  };
}
`,
    "src/backoff.mjs": `export function nextDelay(attempt, policy = {}) {
  if (!Number.isFinite(attempt) || attempt < 1) {
    throw new Error("attempt must be at least 1");
  }
  const baseMs = policy.baseMs ?? 100;
  const factor = policy.factor ?? 2;
  const maxMs = policy.maxMs ?? Infinity;
  const jitter = policy.jitter ?? "none";
  const random = policy.random ?? Math.random;

  const capped = Math.min(baseMs * Math.pow(factor, attempt - 1), maxMs);

  if (jitter === "none") return Math.round(capped);
  if (jitter === "full") return Math.round(random() * capped);
  if (jitter === "equal") return Math.round(capped / 2 + random() * (capped / 2));
  throw new Error("unknown jitter mode: " + String(jitter));
}

export async function retry(fn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be at least 1");
  }
  const shouldRetry = options.shouldRetry ?? (() => true);
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      if (!shouldRetry(error, attempt)) break;
      await sleep(nextDelay(attempt, options));
    }
  }
  throw lastError;
}
`,
    "src/semver.mjs": `const PATTERN =
  /^v?(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\\+([0-9A-Za-z.-]+))?$/;

const identifier = (part) =>
  /^(0|[1-9][0-9]*)$/.test(part) ? Number(part) : part;

export function parse(version) {
  if (typeof version !== "string") return null;
  const match = PATTERN.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".").map(identifier) : [],
    build: match[5] ? match[5].split(".") : [],
  };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = typeof left === "number";
    const rightNumeric = typeof right === "number";
    if (leftNumeric && rightNumeric) {
      const result = cmp(left, right);
      if (result !== 0) return result;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const result = cmp(String(left), String(right));
    if (result !== 0) return result;
  }
  return 0;
}

export function compare(a, b) {
  const left = typeof a === "string" ? parse(a) : a;
  const right = typeof b === "string" ? parse(b) : b;
  if (!left || !right) throw new Error("invalid version");

  return (
    cmp(left.major, right.major) ||
    cmp(left.minor, right.minor) ||
    cmp(left.patch, right.patch) ||
    comparePrerelease(left.prerelease, right.prerelease)
  );
}

const format = (v) =>
  v.major + "." + v.minor + "." + v.patch + (v.prerelease.length ? "-" + v.prerelease.join(".") : "");

function comparatorsFor(part) {
  const trimmed = part.trim();
  if (trimmed === "*" || trimmed === "") return [];

  const caret = /^\\^\\s*(.+)$/.exec(trimmed);
  if (caret) {
    const base = parse(caret[1]);
    if (!base) return null;
    let upper;
    if (base.major !== 0) upper = { major: base.major + 1, minor: 0, patch: 0 };
    else if (base.minor !== 0) upper = { major: 0, minor: base.minor + 1, patch: 0 };
    else upper = { major: 0, minor: 0, patch: base.patch + 1 };
    return [
      { op: ">=", version: base },
      { op: "<", version: { ...upper, prerelease: [], build: [] } },
    ];
  }

  const tilde = /^~\\s*(.+)$/.exec(trimmed);
  if (tilde) {
    const base = parse(tilde[1]);
    if (!base) return null;
    return [
      { op: ">=", version: base },
      {
        op: "<",
        version: {
          major: base.major,
          minor: base.minor + 1,
          patch: 0,
          prerelease: [],
          build: [],
        },
      },
    ];
  }

  const comparator = /^(>=|<=|>|<|=)?\\s*(.+)$/.exec(trimmed);
  if (!comparator) return null;
  const version = parse(comparator[2]);
  if (!version) return null;
  return [{ op: comparator[1] ?? "=", version }];
}

export function satisfies(version, range) {
  const target = parse(version);
  if (!target) return false;

  for (const orPart of String(range).split("||")) {
    const comparators = [];
    let valid = true;
    for (const token of orPart.trim().split(/\\s+/).filter(Boolean).reduce(joinOps, [])) {
      const parsed = comparatorsFor(token);
      if (parsed === null) {
        valid = false;
        break;
      }
      comparators.push(...parsed);
    }
    if (!valid) continue;

    // A prerelease only satisfies a range that mentions the same [major, minor,
    // patch] tuple, which is what stops ^1.0.0 from matching 1.2.3-alpha.
    if (target.prerelease.length > 0) {
      const named = comparators.some(
        (c) =>
          c.version.prerelease.length > 0 &&
          c.version.major === target.major &&
          c.version.minor === target.minor &&
          c.version.patch === target.patch,
      );
      if (!named) continue;
    }

    const ok = comparators.every((c) => {
      const result = compare(format(target), format(c.version));
      if (c.op === ">=") return result >= 0;
      if (c.op === "<=") return result <= 0;
      if (c.op === ">") return result > 0;
      if (c.op === "<") return result < 0;
      return result === 0;
    });
    if (ok) return true;
  }
  return false;
}

/** Re-join a bare operator with the version token that follows it. */
function joinOps(tokens, token) {
  const previous = tokens[tokens.length - 1];
  if (previous !== undefined && /^(>=|<=|>|<|=|\\^|~)$/.test(previous)) {
    tokens[tokens.length - 1] = previous + token;
    return tokens;
  }
  tokens.push(token);
  return tokens;
}
`,
  },

  // -------------------------------------------------------------------------
  "scale-datakit": {
    "src/csv.mjs": `export function parseCsv(text, options = {}) {
  const delimiter = options.delimiter ?? ",";
  if (text === "") return [];

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let index = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        const after = text[index + 1];
        if (after !== undefined && after !== delimiter && after !== "\\n" && after !== "\\r") {
          throw new Error("unexpected quote at position " + index);
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (char === "\\r" && text[index + 1] === "\\n") {
      endRow();
      index += 2;
      continue;
    }
    if (char === "\\n") {
      endRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  if (quoted) throw new Error("unterminated quoted field");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

export function toCsv(rows, options = {}) {
  const delimiter = options.delimiter ?? ",";
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = value === null || value === undefined ? "" : String(value);
          return /["\\n\\r]/.test(text) || text.includes(delimiter)
            ? '"' + text.replace(/"/g, '""') + '"'
            : text;
        })
        .join(delimiter),
    )
    .join("\\n");
}
`,
    "src/querystring.mjs": `const decode = (text) => decodeURIComponent(text.replace(/\\+/g, " "));

function assign(target, path, value) {
  let node = target;
  for (let i = 0; i < path.length; i += 1) {
    const key = path[i];
    const last = i === path.length - 1;

    if (key === "") {
      if (!Array.isArray(node)) return;
      if (last) node.push(value);
      return;
    }

    if (last) {
      if (Array.isArray(node)) node[Number(key)] = value;
      else node[key] = value;
      continue;
    }

    const nextKey = path[i + 1];
    const wantsArray = nextKey === "" || /^(0|[1-9][0-9]*)$/.test(nextKey);
    if (node[key] === undefined) node[key] = wantsArray ? [] : {};
    node = node[key];
  }
}

export function parseQuery(input) {
  const text = String(input ?? "").replace(/^\\?/, "");
  if (text === "") return {};

  const result = {};
  const seen = new Map();

  for (const pair of text.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : decode(pair.slice(eq + 1));

    const match = /^([^[]*)((?:\\[[^\\]]*\\])*)$/.exec(rawKey);
    if (!match) continue;
    const head = decode(match[1]);

    if (match[2] === "") {
      // Flat key. A repeat turns the entry into an array.
      const count = (seen.get(head) ?? 0) + 1;
      seen.set(head, count);
      if (count === 1) result[head] = value;
      else if (count === 2) result[head] = [result[head], value];
      else result[head].push(value);
      continue;
    }

    const path = [head];
    for (const part of match[2].matchAll(/\\[([^\\]]*)\\]/g)) path.push(decode(part[1]));

    const nextKey = path[1];
    if (result[head] === undefined) {
      result[head] = nextKey === "" || /^(0|[1-9][0-9]*)$/.test(nextKey) ? [] : {};
    }
    assign(result, path, value);
  }

  return result;
}

const encode = (text) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function flatten(prefix, value, out) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) flatten(prefix + "[]", entry, out);
    return;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value).sort()) {
      flatten(prefix + "[" + key + "]", value[key], out);
    }
    return;
  }
  out.push(encode(prefix) + "=" + encode(String(value)));
}

export function stringifyQuery(object) {
  const out = [];
  for (const key of Object.keys(object ?? {}).sort()) {
    flatten(key, object[key], out);
  }
  return out.join("&");
}
`,
    "src/diff.mjs": `const split = (text) => (text === "" ? [] : text.replace(/\\r\\n/g, "\\n").split("\\n"));

export function diffLines(before, after) {
  const a = split(before);
  const b = split(after);

  // Longest common subsequence table, then walk it back into operations.
  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        a[i] === b[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: "=", value: a[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      ops.push({ type: "-", value: a[i] });
      i += 1;
    } else {
      ops.push({ type: "+", value: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ type: "-", value: a[i] });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ type: "+", value: b[j] });
    j += 1;
  }
  return ops;
}

export function formatDiff(ops) {
  return ops
    .map((op) => (op.type === "=" ? " " : op.type) + op.value)
    .join("\\n");
}
`,
    "src/ratelimit.mjs": `export function createLimiter(options = {}) {
  const capacity = options.capacity;
  const refillPerSecond = options.refillPerSecond;
  const now = options.now ?? Date.now;

  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error("capacity must be positive");
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new Error("refillPerSecond must be positive");
  }

  let tokens = capacity;
  let updatedAt = now();

  const refill = () => {
    const at = now();
    const elapsed = at - updatedAt;
    if (elapsed > 0) {
      tokens = Math.min(capacity, tokens + (elapsed / 1000) * refillPerSecond);
      updatedAt = at;
    }
  };

  const check = (count) => {
    if (!Number.isFinite(count) || count <= 0) {
      throw new Error("count must be positive");
    }
    if (count > capacity) {
      throw new Error("count exceeds capacity");
    }
  };

  return {
    tokens() {
      refill();
      return tokens;
    },
    tryRemove(count = 1) {
      check(count);
      refill();
      if (tokens < count) return false;
      tokens -= count;
      return true;
    },
    retryAfterMs(count = 1) {
      check(count);
      refill();
      if (tokens >= count) return 0;
      return Math.ceil(((count - tokens) / refillPerSecond) * 1000);
    },
    reset() {
      tokens = capacity;
      updatedAt = now();
    },
  };
}
`,
    "src/glob.mjs": `function toSource(pattern) {
  let source = "";
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    // A globstar is only meaningful together with its surrounding separators:
    // src/**/x must match src/x, and src/** must match src itself.
    if (char === "/" && pattern.startsWith("**", index + 1)) {
      if (index + 3 === pattern.length) {
        source += "(?:/.*)?";
        index = pattern.length;
        continue;
      }
      if (pattern[index + 3] === "/") {
        source += "/(?:.*/)?";
        index += 4;
        continue;
      }
    }

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }

    if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) {
        source += "\\\\[";
        index += 1;
        continue;
      }
      let body = pattern.slice(index + 1, close);
      if (body[0] === "!") body = "^" + body.slice(1);
      source += "[" + body + "]";
      index = close + 1;
      continue;
    }

    if (char === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close === -1) {
        source += "\\\\{";
        index += 1;
        continue;
      }
      const alternatives = pattern.slice(index + 1, close).split(",");
      source += "(?:" + alternatives.map(toSource).join("|") + ")";
      index = close + 1;
      continue;
    }

    source += char.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
    index += 1;
  }

  return source;
}

export function matchGlob(pattern, filePath) {
  const normalized = String(filePath).replace(/\\\\/g, "/");
  return new RegExp("^" + toSource(String(pattern)) + "$").test(normalized);
}
`,
    "src/interval.mjs": `function normalise(intervals) {
  for (const [start, end] of intervals) {
    if (!(Number.isFinite(start) && Number.isFinite(end)) || end < start) {
      throw new Error("invalid interval: [" + start + ", " + end + "]");
    }
  }
  return intervals
    .filter(([start, end]) => end > start)
    .map(([start, end]) => [start, end])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

export function merge(intervals) {
  const sorted = normalise(intervals);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

export function intersect(a, b) {
  const left = merge(a);
  const right = merge(b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i][0], right[j][0]);
    const end = Math.min(left[i][1], right[j][1]);
    if (end > start) out.push([start, end]);
    if (left[i][1] < right[j][1]) i += 1;
    else j += 1;
  }
  return out;
}

export function subtract(a, b) {
  const holes = merge(b);
  const out = [];
  for (const [start, end] of merge(a)) {
    let cursor = start;
    for (const [holeStart, holeEnd] of holes) {
      if (holeEnd <= cursor || holeStart >= end) continue;
      if (holeStart > cursor) out.push([cursor, holeStart]);
      cursor = Math.max(cursor, holeEnd);
      if (cursor >= end) break;
    }
    if (cursor < end) out.push([cursor, end]);
  }
  return out;
}

export function contains(intervals, point) {
  return merge(intervals).some(([start, end]) => point >= start && point < end);
}

export function totalLength(intervals) {
  return merge(intervals).reduce((sum, [start, end]) => sum + (end - start), 0);
}
`,
  },

  // -------------------------------------------------------------------------
  "scale-coupled": {
    "src/expression.mjs": `const FUNCTIONS = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  round: Math.round,
};

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\\s/.test(char)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^[0-9]*\\.?[0-9]+/.exec(source.slice(i));
      tokens.push({ type: "number", value: Number(match[0]), at: i });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      tokens.push({ type: "name", value: match[0], at: i });
      i += match[0].length;
      continue;
    }
    const three = source.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(three)) {
      tokens.push({ type: "op", value: three, at: i });
      i += 2;
      continue;
    }
    if ("+-*/%^()<>!,".includes(char)) {
      tokens.push({ type: "op", value: char, at: i });
      i += 1;
      continue;
    }
    throw new Error("unexpected character " + char + " at position " + i);
  }
  tokens.push({ type: "end", value: "", at: source.length });
  return tokens;
}

// Precedence climbing. Higher binds tighter; ^ is right associative.
const BINARY = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
  "^": 8,
};

export function evaluate(source, scope = {}) {
  const tokens = tokenize(String(source));
  let position = 0;

  const peek = () => tokens[position];
  const next = () => tokens[position++];

  const expect = (value) => {
    const token = peek();
    if (token.value !== value) {
      throw new Error("expected " + value + " at position " + token.at);
    }
    return next();
  };

  function parsePrimary() {
    const token = peek();
    if (token.type === "end") throw new Error("unexpected end of input");

    if (token.value === "-" || token.value === "+" || token.value === "!") {
      next();
      // Unary binds looser than ^, so -2 ^ 2 is -(2 ^ 2).
      const operand = parseBinary(7);
      if (token.value === "-") return -operand;
      if (token.value === "+") return operand;
      return !operand;
    }
    if (token.value === "(") {
      next();
      const value = parseBinary(0);
      expect(")");
      return value;
    }
    if (token.type === "number") {
      next();
      return token.value;
    }
    if (token.type === "name") {
      next();
      if (peek().value === "(") {
        next();
        const args = [];
        if (peek().value !== ")") {
          args.push(parseBinary(0));
          while (peek().value === ",") {
            next();
            args.push(parseBinary(0));
          }
        }
        expect(")");
        const fn = FUNCTIONS[token.value];
        if (!fn) throw new Error("unknown function: " + token.value);
        return fn(...args);
      }
      if (!Object.prototype.hasOwnProperty.call(scope, token.value)) {
        throw new Error("unknown variable: " + token.value);
      }
      return scope[token.value];
    }
    throw new Error("unexpected token " + token.value + " at position " + token.at);
  }

  function apply(op, left, right) {
    if (op === "+") return left + right;
    if (op === "-") return left - right;
    if (op === "*") return left * right;
    if (op === "/") return left / right;
    if (op === "%") return left % right;
    if (op === "^") return Math.pow(left, right);
    if (op === "<") return left < right;
    if (op === "<=") return left <= right;
    if (op === ">") return left > right;
    if (op === ">=") return left >= right;
    if (op === "==") return left === right;
    if (op === "!=") return left !== right;
    throw new Error("unknown operator " + op);
  }

  function parseBinary(minPrecedence) {
    let left = parsePrimary();
    for (;;) {
      const token = peek();
      const precedence = token.type === "op" ? BINARY[token.value] : undefined;
      if (precedence === undefined || precedence < minPrecedence) return left;
      next();

      if (token.value === "&&") {
        const right = parseBinary(precedence + 1);
        left = Boolean(left) && Boolean(right);
        continue;
      }
      if (token.value === "||") {
        const right = parseBinary(precedence + 1);
        left = Boolean(left) || Boolean(right);
        continue;
      }
      const right = parseBinary(token.value === "^" ? precedence : precedence + 1);
      left = apply(token.value, left, right);
    }
  }

  const value = parseBinary(0);
  const trailing = peek();
  if (trailing.type !== "end") {
    throw new Error("unexpected token " + trailing.value + " at position " + trailing.at);
  }
  return value;
}
`,
  },
  "scale-validators-6": {
    "src/email.mjs":
      'export function normalizeEmail(input) {\n  if (typeof input !== "string") return null;\n  const trimmed = input.trim().toLowerCase();\n  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(trimmed)) return null;\n  return trimmed;\n}\n',
    "src/ipv4.mjs":
      'export function parseCidr(input) {\n  if (typeof input !== "string") return null;\n  const parts = input.split("/");\n  if (parts.length !== 2) return null;\n  const ip = parts[0];\n  const prefix = parseInt(parts[1], 10);\n  if (isNaN(prefix) || prefix < 0 || prefix > 32) return null;\n  const octets = ip.split(".");\n  if (octets.length !== 4) return null;\n  for (const octet of octets) {\n    const num = parseInt(octet, 10);\n    if (isNaN(num) || num < 0 || num > 255 || String(num) !== octet) return null;\n  }\n  return { ip, prefix };\n}\n',
    "src/uuid.mjs":
      'export function normalizeUuid(input) {\n  if (typeof input !== "string") return null;\n  const cleaned = input.toLowerCase().replace(/[{}-]/g, "");\n  if (cleaned.length !== 32 || !/^[0-9a-f]{32}$/.test(cleaned)) return null;\n  return `${cleaned.slice(0, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}-${cleaned.slice(16, 20)}-${cleaned.slice(20, 32)}`;\n}\n',
    "src/pagination.mjs":
      'export function encodeCursor(data) {\n  try { return Buffer.from(JSON.stringify(data)).toString("base64"); } catch (e) { return null; }\n}\nexport function decodeCursor(cursor) {\n  try { return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")); } catch (e) { return null; }\n}\n',
    "src/date_range.mjs":
      "export function isOverlap(r1, r2) {\n  const s1 = new Date(r1.start).getTime();\n  const e1 = new Date(r1.end).getTime();\n  const s2 = new Date(r2.start).getTime();\n  const e2 = new Date(r2.end).getTime();\n  if (isNaN(s1) || isNaN(e1) || isNaN(s2) || isNaN(e2)) return null;\n  return s1 < e2 && s2 < e1;\n}\n",
    "src/retry.mjs":
      'export function parseRetryPolicy(input) {\n  if (typeof input !== "string") return null;\n  const result = {};\n  const pairs = input.split(",");\n  for (const pair of pairs) {\n    const [k, v] = pair.split("=");\n    if (!k || !v) return null;\n    if (k === "max" || k === "delay") {\n      const num = parseInt(v, 10);\n      if (isNaN(num)) return null;\n      result[k] = num;\n    } else {\n      result[k] = v;\n    }\n  }\n  return result;\n}\n',
  },
  "scale-validators-12": {
    "src/email.mjs":
      'export function normalizeEmail(input) {\n  if (typeof input !== "string") return null;\n  const trimmed = input.trim().toLowerCase();\n  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(trimmed)) return null;\n  return trimmed;\n}\n',
    "src/ipv4.mjs":
      'export function parseCidr(input) {\n  if (typeof input !== "string") return null;\n  const parts = input.split("/");\n  if (parts.length !== 2) return null;\n  const ip = parts[0];\n  const prefix = parseInt(parts[1], 10);\n  if (isNaN(prefix) || prefix < 0 || prefix > 32) return null;\n  const octets = ip.split(".");\n  if (octets.length !== 4) return null;\n  for (const octet of octets) {\n    const num = parseInt(octet, 10);\n    if (isNaN(num) || num < 0 || num > 255 || String(num) !== octet) return null;\n  }\n  return { ip, prefix };\n}\n',
    "src/uuid.mjs":
      'export function normalizeUuid(input) {\n  if (typeof input !== "string") return null;\n  const cleaned = input.toLowerCase().replace(/[{}-]/g, "");\n  if (cleaned.length !== 32 || !/^[0-9a-f]{32}$/.test(cleaned)) return null;\n  return `${cleaned.slice(0, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}-${cleaned.slice(16, 20)}-${cleaned.slice(20, 32)}`;\n}\n',
    "src/pagination.mjs":
      'export function encodeCursor(data) {\n  try { return Buffer.from(JSON.stringify(data)).toString("base64"); } catch (e) { return null; }\n}\nexport function decodeCursor(cursor) {\n  try { return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")); } catch (e) { return null; }\n}\n',
    "src/date_range.mjs":
      "export function isOverlap(r1, r2) {\n  const s1 = new Date(r1.start).getTime();\n  const e1 = new Date(r1.end).getTime();\n  const s2 = new Date(r2.start).getTime();\n  const e2 = new Date(r2.end).getTime();\n  if (isNaN(s1) || isNaN(e1) || isNaN(s2) || isNaN(e2)) return null;\n  return s1 < e2 && s2 < e1;\n}\n",
    "src/retry.mjs":
      'export function parseRetryPolicy(input) {\n  if (typeof input !== "string") return null;\n  const result = {};\n  const pairs = input.split(",");\n  for (const pair of pairs) {\n    const [k, v] = pair.split("=");\n    if (!k || !v) return null;\n    if (k === "max" || k === "delay") {\n      const num = parseInt(v, 10);\n      if (isNaN(num)) return null;\n      result[k] = num;\n    } else {\n      result[k] = v;\n    }\n  }\n  return result;\n}\n',
    "src/money.mjs":
      'export function parseAmount(input) {\n  if (typeof input !== "string") return null;\n  const cleaned = input.replace(/[$,]/g, "");\n  if (!/^\\d+(\\.\\d{1,2})?$/.test(cleaned)) return null;\n  const num = parseFloat(cleaned);\n  if (isNaN(num)) return null;\n  return Math.round(num * 100);\n}\n',
    "src/slug.mjs":
      'export function generateSlug(input) {\n  if (typeof input !== "string") return "";\n  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n',
    "src/http_headers.mjs":
      'export function parseHeaders(input) {\n  if (typeof input !== "string") return {};\n  const result = {};\n  for (const line of input.split(/\\r?\\n/)) {\n    if (!line.trim()) continue;\n    const colon = line.indexOf(":");\n    if (colon === -1) continue;\n    const k = line.slice(0, colon).trim().toLowerCase();\n    const v = line.slice(colon + 1).trim();\n    result[k] = v;\n  }\n  return result;\n}\n',
    "src/query_filter.mjs":
      'export function parseFilter(input) {\n  if (typeof input !== "string") return null;\n  const parts = input.split(":");\n  if (parts.length !== 3) return null;\n  return { field: parts[0], op: parts[1], value: parts[2] };\n}\n',
    "src/sort_spec.mjs":
      'export function parseSort(input) {\n  if (typeof input !== "string") return [];\n  return input.split(",").filter(Boolean).map(s => {\n    s = s.trim();\n    if (s.startsWith("-")) return { field: s.slice(1), desc: true };\n    return { field: s, desc: false };\n  });\n}\n',
    "src/phone.mjs":
      'export function normalizePhone(input) {\n  if (typeof input !== "string") return null;\n  const cleaned = "+" + input.replace(/[^0-9]/g, "");\n  if (cleaned.length < 10 || cleaned.length > 15) return null;\n  return cleaned;\n}\n',
  },
  "scale-validators-20": {
    "src/email.mjs":
      'export function normalizeEmail(input) {\n  if (typeof input !== "string") return null;\n  const trimmed = input.trim().toLowerCase();\n  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(trimmed)) return null;\n  return trimmed;\n}\n',
    "src/ipv4.mjs":
      'export function parseCidr(input) {\n  if (typeof input !== "string") return null;\n  const parts = input.split("/");\n  if (parts.length !== 2) return null;\n  const ip = parts[0];\n  const prefix = parseInt(parts[1], 10);\n  if (isNaN(prefix) || prefix < 0 || prefix > 32) return null;\n  const octets = ip.split(".");\n  if (octets.length !== 4) return null;\n  for (const octet of octets) {\n    const num = parseInt(octet, 10);\n    if (isNaN(num) || num < 0 || num > 255 || String(num) !== octet) return null;\n  }\n  return { ip, prefix };\n}\n',
    "src/uuid.mjs":
      'export function normalizeUuid(input) {\n  if (typeof input !== "string") return null;\n  const cleaned = input.toLowerCase().replace(/[{}-]/g, "");\n  if (cleaned.length !== 32 || !/^[0-9a-f]{32}$/.test(cleaned)) return null;\n  return `${cleaned.slice(0, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}-${cleaned.slice(16, 20)}-${cleaned.slice(20, 32)}`;\n}\n',
    "src/pagination.mjs":
      'export function encodeCursor(data) {\n  try { return Buffer.from(JSON.stringify(data)).toString("base64"); } catch (e) { return null; }\n}\nexport function decodeCursor(cursor) {\n  try { return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")); } catch (e) { return null; }\n}\n',
    "src/date_range.mjs":
      "export function isOverlap(r1, r2) {\n  const s1 = new Date(r1.start).getTime();\n  const e1 = new Date(r1.end).getTime();\n  const s2 = new Date(r2.start).getTime();\n  const e2 = new Date(r2.end).getTime();\n  if (isNaN(s1) || isNaN(e1) || isNaN(s2) || isNaN(e2)) return null;\n  return s1 < e2 && s2 < e1;\n}\n",
    "src/retry.mjs":
      'export function parseRetryPolicy(input) {\n  if (typeof input !== "string") return null;\n  const result = {};\n  const pairs = input.split(",");\n  for (const pair of pairs) {\n    const [k, v] = pair.split("=");\n    if (!k || !v) return null;\n    if (k === "max" || k === "delay") {\n      const num = parseInt(v, 10);\n      if (isNaN(num)) return null;\n      result[k] = num;\n    } else {\n      result[k] = v;\n    }\n  }\n  return result;\n}\n',
    "src/money.mjs":
      'export function parseAmount(input) {\n  if (typeof input !== "string") return null;\n  const cleaned = input.replace(/[$,]/g, "");\n  if (!/^\\d+(\\.\\d{1,2})?$/.test(cleaned)) return null;\n  const num = parseFloat(cleaned);\n  if (isNaN(num)) return null;\n  return Math.round(num * 100);\n}\n',
    "src/slug.mjs":
      'export function generateSlug(input) {\n  if (typeof input !== "string") return "";\n  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n',
    "src/http_headers.mjs":
      'export function parseHeaders(input) {\n  if (typeof input !== "string") return {};\n  const result = {};\n  for (const line of input.split(/\\r?\\n/)) {\n    if (!line.trim()) continue;\n    const colon = line.indexOf(":");\n    if (colon === -1) continue;\n    const k = line.slice(0, colon).trim().toLowerCase();\n    const v = line.slice(colon + 1).trim();\n    result[k] = v;\n  }\n  return result;\n}\n',
    "src/query_filter.mjs":
      'export function parseFilter(input) {\n  if (typeof input !== "string") return null;\n  const parts = input.split(":");\n  if (parts.length !== 3) return null;\n  return { field: parts[0], op: parts[1], value: parts[2] };\n}\n',
    "src/sort_spec.mjs":
      'export function parseSort(input) {\n  if (typeof input !== "string") return [];\n  return input.split(",").filter(Boolean).map(s => {\n    s = s.trim();\n    if (s.startsWith("-")) return { field: s.slice(1), desc: true };\n    return { field: s, desc: false };\n  });\n}\n',
    "src/phone.mjs":
      'export function normalizePhone(input) {\n  if (typeof input !== "string") return null;\n  const cleaned = "+" + input.replace(/[^0-9]/g, "");\n  if (cleaned.length < 10 || cleaned.length > 15) return null;\n  return cleaned;\n}\n',
    "src/bool_coerce.mjs":
      'export function toBool(input) {\n  if (typeof input === "boolean") return input;\n  if (typeof input !== "string" && typeof input !== "number") return null;\n  const str = String(input).trim().toLowerCase();\n  if (["true", "1", "yes", "on", "t", "y"].includes(str)) return true;\n  if (["false", "0", "no", "off", "f", "n"].includes(str)) return false;\n  return null;\n}\n',
    "src/idempotency.mjs":
      'export function validateIdempotencyKey(input) {\n  if (typeof input !== "string") return false;\n  return /^[a-zA-Z0-9_-]{10,255}$/.test(input);\n}\n',
    "src/locale.mjs":
      'export function parseLocale(input) {\n  if (typeof input !== "string") return [];\n  return input.split(",").filter(Boolean).map(s => {\n    const parts = s.split(";");\n    const lang = parts[0].trim();\n    let q = 1;\n    if (parts[1] && parts[1].trim().startsWith("q=")) {\n      q = parseFloat(parts[1].trim().slice(2));\n    }\n    return { lang, q };\n  }).sort((a, b) => b.q - a.q);\n}\n',
    "src/content_type.mjs":
      'export function parseContentType(input) {\n  if (typeof input !== "string") return null;\n  const parts = input.split(";");\n  const type = parts[0].trim().toLowerCase();\n  const params = {};\n  for (let i = 1; i < parts.length; i++) {\n    const [k, v] = parts[i].split("=");\n    if (k && v) params[k.trim().toLowerCase()] = v.trim();\n  }\n  return { type, params };\n}\n',
    "src/duration.mjs":
      'export function parseDuration(input) {\n  if (typeof input !== "string") return null;\n  const regex = /(\\d+)\\s*(h|m|s|ms)/g;\n  let match;\n  let total = 0;\n  let found = false;\n  while ((match = regex.exec(input)) !== null) {\n    found = true;\n    const val = parseInt(match[1], 10);\n    const unit = match[2];\n    if (unit === "h") total += val * 3600000;\n    else if (unit === "m") total += val * 60000;\n    else if (unit === "s") total += val * 1000;\n    else if (unit === "ms") total += val;\n  }\n  return found ? total : null;\n}\n',
    "src/int_range.mjs":
      'export function parseIntRange(input) {\n  if (typeof input !== "string") return null;\n  const s = input.trim();\n  if (s.includes("..")) {\n    const parts = s.split("..");\n    return { min: parseInt(parts[0], 10), max: parseInt(parts[1], 10) };\n  }\n  if (s.startsWith(">=")) return { min: parseInt(s.slice(2), 10), max: Infinity };\n  if (s.startsWith("<=")) return { min: -Infinity, max: parseInt(s.slice(2), 10) };\n  return null;\n}\n',
    "src/rate_limit.mjs":
      'export function parseRateLimit(input) {\n  if (typeof input !== "string") return null;\n  const parts = input.split("/");\n  if (parts.length !== 2) return null;\n  const reqs = parseInt(parts[0], 10);\n  const windowStr = parts[1].trim();\n  let windowMs = 0;\n  if (windowStr.endsWith("h")) windowMs = parseInt(windowStr, 10) * 3600000;\n  else if (windowStr.endsWith("m")) windowMs = parseInt(windowStr, 10) * 60000;\n  else if (windowStr.endsWith("s")) windowMs = parseInt(windowStr, 10) * 1000;\n  if (isNaN(reqs) || isNaN(windowMs) || windowMs === 0) return null;\n  return { reqs, windowMs };\n}\n',
    "src/tags.mjs":
      'export function normalizeTags(input) {\n  if (!Array.isArray(input)) return [];\n  const set = new Set();\n  for (const tag of input) {\n    if (typeof tag === "string") set.add(tag.trim().toLowerCase());\n  }\n  return Array.from(set).sort();\n}\n',
  },
};
