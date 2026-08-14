/**
 * Minimal, surgical editing of a TOML file.
 *
 * This exists because the user's `~/.codex/config.toml` is *their* file. It can
 * hold unrelated MCP servers, model preferences, project trust settings,
 * experimental flags, comments they wrote, and formatting they care about.
 * Parsing it into a data structure and serialising it back would silently
 * discard every comment and reorder everything — an unacceptable thing to do to
 * someone's configuration in exchange for saving us some work.
 *
 * So this module never round-trips. It locates the one table it owns, edits
 * lines inside it, and leaves every other byte of the file untouched.
 *
 * Scope of support, deliberately narrow:
 *   - standard `[table.header]` lines (unquoted or quoted segments)
 *   - simple `key = value` scalars inside a table
 *   - removal of a table plus its sub-tables
 *
 * It does not attempt to understand inline tables, multi-line arrays, or
 * multi-line strings, and it only ever writes inside a table this project owns,
 * so those constructs are never touched.
 */

export interface TableBlock {
  /** Index of the `[header]` line. */
  start: number;
  /** Index one past the last line belonging to this table. */
  end: number;
}

const LINE_SPLIT = /\r?\n/;

/** Detect the dominant newline so edits do not mix line endings. */
export function detectNewline(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Parse a table header line into its dotted segments.
 *
 * `[mcp_servers."my server".env]` -> ["mcp_servers", "my server", "env"]
 * Returns null when the line is not a table header.
 */
export function parseTableHeader(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[") || trimmed.startsWith("[[")) return null;

  const close = trimmed.lastIndexOf("]");
  if (close <= 0) return null;

  const inner = trimmed.slice(1, close).trim();
  if (!inner) return null;

  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]!;
    if (quote) {
      // Basic strings process escapes; literal ('single') strings do not.
      if (char === "\\" && quote === '"' && i + 1 < inner.length) {
        const { text, consumed } = decodeEscape(inner, i + 1);
        current += text;
        i += consumed;
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current.trim());

  return segments.every((segment) => segment.length > 0) ? segments : null;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  '"': '"',
  "\\": "\\",
};

/**
 * Decode one escape sequence inside a TOML basic string.
 *
 * Returns the decoded text and how many characters after the backslash were
 * consumed. An unrecognised escape keeps its literal character, which is more
 * forgiving than rejecting a config we only want to read one table out of.
 */
function decodeEscape(text: string, index: number): { text: string; consumed: number } {
  const char = text[index]!;

  const simple = SIMPLE_ESCAPES[char];
  if (simple !== undefined) return { text: simple, consumed: 1 };

  if (char === "u" || char === "U") {
    const width = char === "u" ? 4 : 8;
    const hex = text.slice(index + 1, index + 1 + width);
    if (hex.length === width && /^[0-9a-fA-F]+$/.test(hex)) {
      return {
        text: String.fromCodePoint(Number.parseInt(hex, 16)),
        consumed: width + 1,
      };
    }
  }

  return { text: char, consumed: 1 };
}

/** Render dotted segments as a header, quoting only where TOML requires it. */
export function formatTableHeader(segments: string[]): string {
  const rendered = segments.map((segment) =>
    /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment),
  );
  return `[${rendered.join(".")}]`;
}

const segmentsEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((segment, index) => segment === b[index]);

const isPrefix = (prefix: string[], candidate: string[]): boolean =>
  candidate.length > prefix.length &&
  prefix.every((segment, index) => candidate[index] === segment);

/**
 * Locate a table's line range.
 *
 * The range ends at the next table header at any level, so sub-tables are NOT
 * included — `[a.b]` stops where `[a.b.c]` begins.
 */
export function findTable(text: string, target: string[]): TableBlock | null {
  const lines = text.split(LINE_SPLIT);

  for (let i = 0; i < lines.length; i += 1) {
    const header = parseTableHeader(lines[i]!);
    if (!header || !segmentsEqual(header, target)) continue;

    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (parseTableHeader(lines[j]!)) {
        end = j;
        break;
      }
    }
    return { start: i, end };
  }
  return null;
}

/** Read a scalar key from inside a table, as its raw TOML text. */
export function readKey(text: string, target: string[], key: string): string | null {
  const block = findTable(text, target);
  if (!block) return null;

  const lines = text.split(LINE_SPLIT);
  for (let i = block.start + 1; i < block.end; i += 1) {
    const match = matchKey(lines[i]!, key);
    if (match !== null) return match;
  }
  return null;
}

/** Match `key = value`, ignoring comments and other keys. Returns raw value. */
function matchKey(line: string, key: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  if (eq < 0) return null;

  const rawKey = trimmed
    .slice(0, eq)
    .trim()
    .replace(/^["']|["']$/g, "");
  if (rawKey !== key) return null;

  // Strip a trailing comment, but not a `#` inside a quoted value.
  let value = trimmed.slice(eq + 1).trim();
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    if (quote) {
      if (char === quote && value[i - 1] !== "\\") quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      value = value.slice(0, i).trim();
      break;
    }
  }
  return value;
}

/** Serialise a JS value as TOML. Only scalars and flat arrays are supported. */
export function toTomlValue(value: string | number | boolean | string[]): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `[${value.map((entry) => JSON.stringify(entry)).join(", ")}]`;
}

/**
 * Turn a raw TOML scalar back into readable text, for display only.
 *
 * Values are stored escaped — a Windows path arrives as
 * `"C:\\Users\\me\\log"` — which is correct in the file and unreadable in a
 * diagnostic. Non-string values are returned as they are.
 */
export function fromTomlValue(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();

  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1); // literal string: no escapes to decode
  }
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  let result = "";
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      const { text, consumed } = decodeEscape(inner, i + 1);
      result += text;
      i += consumed;
      continue;
    }
    result += inner[i];
  }
  return result;
}

export interface UpsertOptions {
  /** Comment lines written above the key when it is first inserted. */
  comment?: string[];
}

/**
 * Set `key = value` inside `target`, creating the table if it does not exist.
 *
 * An existing key is replaced in place, preserving its position and any
 * surrounding comments. Everything outside the target table is byte-identical.
 */
export function upsertKey(
  text: string,
  target: string[],
  key: string,
  value: string | number | boolean | string[],
  options: UpsertOptions = {},
): string {
  const newline = detectNewline(text);
  const lines = text.split(LINE_SPLIT);
  const rendered = `${key} = ${toTomlValue(value)}`;

  const block = findTable(text, target);

  if (!block) {
    // Trim trailing blanks, then re-add exactly one, so a new table is always
    // separated from what came before by a single empty line rather than being
    // glued onto the previous table or buried under a stack of blanks.
    const body = [...lines];
    while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();

    const addition = [
      ...(body.length > 0 ? [""] : []),
      formatTableHeader(target),
      ...(options.comment ?? []).map((line) => `# ${line}`),
      rendered,
      "",
    ];
    return [...body, ...addition].join(newline);
  }

  for (let i = block.start + 1; i < block.end; i += 1) {
    if (matchKey(lines[i]!, key) === null) continue;
    // Preserve the original indentation so hand-formatted files stay tidy.
    const indent = lines[i]!.match(/^\s*/)?.[0] ?? "";
    lines[i] = `${indent}${rendered}`;
    return lines.join(newline);
  }

  // Insert after the last non-blank line of the table, so trailing blank lines
  // that separate it from the next table are preserved.
  let insertAt = block.end;
  while (insertAt > block.start + 1 && lines[insertAt - 1]!.trim() === "") {
    insertAt -= 1;
  }

  const addition = [...(options.comment ?? []).map((line) => `# ${line}`), rendered];
  lines.splice(insertAt, 0, ...addition);
  return lines.join(newline);
}

/**
 * Remove a table and every sub-table beneath it.
 *
 * Comments written immediately above a removed header are removed with it,
 * since they almost always describe the block being deleted.
 */
export function removeTable(text: string, target: string[]): string {
  const newline = detectNewline(text);
  let lines = text.split(LINE_SPLIT);
  let removedAny = false;

  for (;;) {
    let found = false;

    for (let i = 0; i < lines.length; i += 1) {
      const header = parseTableHeader(lines[i]!);
      if (!header) continue;
      if (!segmentsEqual(header, target) && !isPrefix(target, header)) continue;

      let end = lines.length;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (parseTableHeader(lines[j]!)) {
          end = j;
          break;
        }
      }

      // Absorb contiguous comment lines directly above the header.
      let start = i;
      while (start > 0) {
        const above = lines[start - 1]!.trim();
        if (above.startsWith("#")) start -= 1;
        else break;
      }

      lines.splice(start, end - start);
      found = true;
      removedAny = true;
      break;
    }

    if (!found) break;
  }

  if (!removedAny) return text;

  // Collapse the run of blank lines the removal may have left behind.
  const collapsed: string[] = [];
  for (const line of lines) {
    const previous = collapsed[collapsed.length - 1];
    if (line.trim() === "" && previous !== undefined && previous.trim() === "") continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1]!.trim() === "") {
    collapsed.pop();
  }

  return collapsed.length === 0 ? "" : `${collapsed.join(newline)}${newline}`;
}

/** Names of every table directly under a prefix, e.g. all `mcp_servers.*`. */
export function listSubTables(text: string, prefix: string[]): string[] {
  const names = new Set<string>();
  for (const line of text.split(LINE_SPLIT)) {
    const header = parseTableHeader(line);
    if (header && isPrefix(prefix, header)) names.add(header[prefix.length]!);
  }
  return [...names];
}
