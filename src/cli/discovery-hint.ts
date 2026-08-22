import fs from "node:fs";
import path from "node:path";
import { codexHome } from "./paths.js";

/**
 * A deliberately tiny, surgical hint for fresh Codex chats.
 *
 * AGENTS.md belongs to the user, not this package. Only the current exact
 * three-line block and the one known legacy block may be removed. Anything
 * that resembles either but differs from it is treated as user content.
 */
export const DISCOVERY_HINT_FILENAME = "AGENTS.md";
export const DISCOVERY_HINT_OVERRIDE_FILENAME = "AGENTS.override.md";
export const DISCOVERY_HINT_START = "<!-- BEGIN SOL-LUNA-ORCHESTRATOR DISCOVERY HINT -->";
export const DISCOVERY_HINT_TEXT =
  "For non-trivial work where delegation could plausibly help, first discover the configured sol-luna-orchestrator MCP and use its guidance to decide between solo work, delegate_task, or delegate_tasks. Do not substitute Codex built-in delegation. Zero workers is valid.";
export const DISCOVERY_HINT_END = "<!-- END SOL-LUNA-ORCHESTRATOR DISCOVERY HINT -->";

const LEGACY_DISCOVERY_HINT_TEXT =
  "When delegated work may be useful, consider the configured sol-luna-orchestrator MCP before Codex built-in delegation. Delegation is optional; zero workers is valid.";

export type DiscoveryHintState = "installed" | "missing" | "modified";

export interface DiscoveryHintInspection {
  state: DiscoveryHintState;
  exactCount: number;
  hasMarkers: boolean;
}

interface TextLine {
  value: string;
  start: number;
  end: number;
}

interface ExactBlock {
  start: number;
  end: number;
}

export const discoveryHintPaths = (home = codexHome()): [string, string] => [
  path.join(home, DISCOVERY_HINT_OVERRIDE_FILENAME),
  path.join(home, DISCOVERY_HINT_FILENAME),
];

/** Select the global instruction file Codex will actually load. */
export const discoveryHintPath = (home = codexHome()): string => {
  const [overridePath, agentsPath] = discoveryHintPaths(home);
  return readDiscoveryInstructions(overridePath).trim().length > 0
    ? overridePath
    : agentsPath;
};

/** Read the user's Codex instructions, treating a missing file as empty. */
export function readDiscoveryInstructions(filePath = discoveryHintPath()): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

const lineEntries = (text: string): TextLine[] => {
  const lines: TextLine[] = [];
  let start = 0;

  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) {
      lines.push({ value: text.slice(start), start, end: text.length });
      return lines;
    }

    const valueEnd =
      newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ value: text.slice(start, valueEnd), start, end: newline + 1 });
    start = newline + 1;
    if (start === text.length) {
      lines.push({ value: "", start, end: start });
      return lines;
    }
  }
};

const exactBlocks = (
  text: string,
  hintTexts: readonly string[] = [DISCOVERY_HINT_TEXT],
): ExactBlock[] => {
  const lines = lineEntries(text);
  const blocks: ExactBlock[] = [];

  for (let i = 0; i + 2 < lines.length; i += 1) {
    if (
      lines[i]!.value !== DISCOVERY_HINT_START ||
      !hintTexts.includes(lines[i + 1]!.value) ||
      lines[i + 2]!.value !== DISCOVERY_HINT_END
    ) {
      continue;
    }
    blocks.push({ start: lines[i]!.start, end: lines[i + 2]!.end });
  }

  return blocks;
};

const hasMarkers = (text: string): boolean =>
  lineEntries(text).some(
    (line) => line.value === DISCOVERY_HINT_START || line.value === DISCOVERY_HINT_END,
  );

export function inspectDiscoveryHint(text: string): DiscoveryHintInspection {
  const exactCount = exactBlocks(text).length;
  const markers = hasMarkers(text);
  return {
    state: exactCount > 0 ? "installed" : markers ? "modified" : "missing",
    exactCount,
    hasMarkers: markers,
  };
}

const newlineFor = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

const renderHint = (newline: string): string =>
  [DISCOVERY_HINT_START, DISCOVERY_HINT_TEXT, DISCOVERY_HINT_END].join(newline);

/** Add the exact managed block once at the top, preserving the existing newline style. */
export function ensureDiscoveryHint(text: string): string {
  const legacyBlocks = exactBlocks(text, [LEGACY_DISCOVERY_HINT_TEXT]);
  let updated = removeExactBlocks(text, legacyBlocks);
  if (exactBlocks(updated).length > 0) return updated;

  const newline = newlineFor(updated);
  return `${renderHint(newline)}${newline}${updated}`;
}

const removeExactBlocks = (text: string, blocks: ExactBlock[]): string => {
  let result = text;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]!;
    result = `${result.slice(0, block.start)}${result.slice(block.end)}`;
  }
  return result;
};

/**
 * Remove exact managed blocks and nothing else.
 *
 * The block is normally at the top of the file, so its trailing newline is
 * managed content and the original user bytes follow it untouched. A block
 * placed elsewhere is still removed without consuming surrounding content.
 */
export function removeDiscoveryHints(text: string): {
  text: string;
  removedCount: number;
} {
  const blocks = exactBlocks(text, [DISCOVERY_HINT_TEXT, LEGACY_DISCOVERY_HINT_TEXT]);
  if (blocks.length === 0) return { text, removedCount: 0 };
  return { text: removeExactBlocks(text, blocks), removedCount: blocks.length };
}

/** Write the user's instructions atomically, without creating a backup file. */
export function writeDiscoveryInstructions(
  text: string,
  filePath = discoveryHintPath(),
): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${DISCOVERY_HINT_FILENAME}.sol-luna.${process.pid}.tmp`,
  );

  try {
    fs.writeFileSync(temporary, text, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
