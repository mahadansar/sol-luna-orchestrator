/**
 * Console output helpers.
 *
 * Colour is opt-out via NO_COLOR and is skipped when stdout is not a TTY, so
 * piping into a file or CI log never produces escape sequences. Symbols degrade
 * to ASCII on Windows terminals that cannot render the Unicode ones, because a
 * status line full of replacement characters is worse than a plain `[ok]`.
 */

const useColor = (): boolean =>
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

/**
 * Windows Terminal and modern shells handle these fine; the legacy console host
 * does not. WT_SESSION is the reliable signal for the former.
 */
const useUnicode = (): boolean =>
  process.platform !== "win32" ||
  Boolean(process.env.WT_SESSION) ||
  process.env.TERM_PROGRAM === "vscode";

const ESC = String.fromCharCode(27);

const paint = (code: number, text: string): string =>
  useColor() ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const green = (text: string): string => paint(32, text);
export const red = (text: string): string => paint(31, text);
export const yellow = (text: string): string => paint(33, text);
export const dim = (text: string): string => paint(90, text);
export const bold = (text: string): string => paint(1, text);

export const symbols = {
  get ok(): string {
    return green(useUnicode() ? "✓" : "[ok]");
  },
  get fail(): string {
    return red(useUnicode() ? "✗" : "[!!]");
  },
  get warn(): string {
    return yellow(useUnicode() ? "!" : "[ws]");
  },
  get skip(): string {
    return dim(useUnicode() ? "-" : "[--]");
  },
};

export const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

export const errOut = (line = ""): void => {
  process.stderr.write(`${line}\n`);
};

/** Render `label   value` pairs with aligned columns. */
export function table(rows: Array<[string, string]>, indent = ""): void {
  const width = Math.max(0, ...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    out(`${indent}${(label + ":").padEnd(width + 2)}${value}`);
  }
}
