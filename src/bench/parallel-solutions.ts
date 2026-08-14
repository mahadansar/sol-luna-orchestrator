/**
 * Reference solutions for the parallel benchmark fixtures.
 *
 * These exist only so `bench:validate` can prove the graders accept correct
 * work and reject the starting state. If a fixture cannot be satisfied by a
 * straightforward implementation, its specification is at fault and any
 * benchmark result from it would be noise.
 */

export const PARALLEL_SOLUTIONS: Record<string, Record<string, string>> = {
  "parallel-toolkit": {
    "src/slug.mjs": `export function slugify(input, options = {}) {
  const base = String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const { maxLength } = options;
  if (!maxLength || base.length <= maxLength) return base;

  const clipped = base.slice(0, maxLength);
  const lastSeparator = clipped.lastIndexOf("-");
  if (lastSeparator > 0) return clipped.slice(0, lastSeparator);
  return clipped.replace(/-+$/, "");
}
`,
    "src/money.mjs": `const SYMBOLS = { USD: "$", EUR: "\\u20ac", GBP: "\\u00a3" };

export function formatMoney(cents, currency = "USD") {
  if (!Number.isInteger(cents)) {
    throw new TypeError("cents must be an integer");
  }

  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  const grouped = whole.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");

  const symbol = SYMBOLS[currency];
  const amount = \`\${grouped}.\${fraction}\`;
  const body = symbol ? \`\${symbol}\${amount}\` : \`\${currency} \${amount}\`;

  return negative ? \`-\${body}\` : body;
}
`,
    "src/retry.mjs": `export async function retryWithBackoff(fn, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 50,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError;
}
`,
  },

  "parallel-httpkit": {
    "src/query.mjs": `function coerce(raw) {
  if (raw === "") return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

export function parseQuery(search) {
  const text = String(search ?? "").replace(/^\\?/, "");
  const result = {};
  if (!text) return result;

  for (const pair of text.split("&")) {
    if (!pair) continue;
    const index = pair.indexOf("=");
    const rawKey = index === -1 ? pair : pair.slice(0, index);
    const key = decodeURIComponent(rawKey.replace(/\\+/g, " "));
    if (!key) continue;

    const value =
      index === -1
        ? true
        : coerce(decodeURIComponent(pair.slice(index + 1).replace(/\\+/g, " ")));

    if (Object.prototype.hasOwnProperty.call(result, key)) {
      const existing = result[key];
      result[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      result[key] = value;
    }
  }

  return result;
}
`,
    "src/errors.mjs": `const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
};

export function toHttpError(error) {
  const explicit = typeof error?.status === "number" ? error.status : undefined;
  const mapped = STATUS_BY_CODE[error?.code];
  const status = explicit ?? mapped ?? 500;

  if (status >= 500) {
    return { status, code: "INTERNAL", message: "Internal Server Error" };
  }

  return {
    status,
    code: error?.code ?? "ERROR",
    message: error?.message ?? "",
  };
}
`,
    "src/cursor.mjs": `export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\\+/g, "-")
    .replace(/\\//g, "_")
    .replace(/=+$/, "");
}

export function decodeCursor(cursor) {
  if (typeof cursor !== "string" || cursor === "") return null;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;

  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
`,
  },
};
