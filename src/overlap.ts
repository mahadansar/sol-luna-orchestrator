import picomatch from "picomatch";

/**
 * Detecting whether two globs can ever match the same path.
 *
 * Deciding glob intersection exactly is not worth the complexity here, so this
 * works by construction instead: expand each pattern into concrete example
 * paths it definitely matches, then test those examples against the other
 * pattern. Cheap, order-independent, and wrong only in the safe direction — it
 * can report an overlap that a pathological pattern would not actually produce,
 * never miss one that a realistic pattern would.
 */

const nocase = (): boolean =>
  process.platform === "win32" || process.platform === "darwin";

/**
 * Build concrete paths a glob matches.
 *
 * `**` expands both to nothing and to a nested path so that `src/**` yields
 * `src` and `src/a/b.ts`; without the empty case, `src/**` and `src` would look
 * disjoint.
 */
export function expandGlob(pattern: string): string[] {
  const cleaned = pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!cleaned) return [];

  let variants = [""];
  const segments = cleaned.split("/");

  for (const segment of segments) {
    const next: string[] = [];
    for (const prefix of variants) {
      for (const expansion of expandSegment(segment)) {
        next.push(
          expansion === "" ? prefix : prefix ? `${prefix}/${expansion}` : expansion,
        );
      }
    }
    variants = next;
    // Keep the search bounded on patterns with many alternations.
    if (variants.length > 32) variants = variants.slice(0, 32);
  }

  return [...new Set(variants.filter(Boolean))];
}

function expandSegment(segment: string): string[] {
  // `**` stands for nothing, for a directory, and for a file. The file forms
  // matter: without them `src/auth/**` and `src/**/*.ts` would look disjoint,
  // even though `src/auth/x.ts` matches both.
  if (segment === "**") {
    return ["", "sample", "sample/nested", "sample.ts", "sample/nested.ts"];
  }

  // Take the first alternative of a brace group: {ts,tsx} -> ts.
  const withBraces = segment.replace(/\{([^{}]*)\}/g, (_, group: string) =>
    (group.split(",")[0] ?? "").trim(),
  );

  // Character classes collapse to a plausible member.
  const withClasses = withBraces.replace(/\[[^\]]*\]/g, "a");

  const filled = withClasses.replace(/\*+/g, "sample").replace(/\?/g, "a");
  return [filled];
}

/**
 * Whether two file scopes can select the same path.
 *
 * An empty scope means "unrestricted", which overlaps everything — that is why
 * the tool description pushes hard for explicit scopes on parallel batches.
 */
export function scopesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;

  const options = { dot: true, nocase: nocase() };
  const matchesA = picomatch(a, options);
  const matchesB = picomatch(b, options);

  for (const pattern of b) {
    for (const example of expandGlob(pattern)) {
      if (matchesA(example)) return true;
    }
  }
  for (const pattern of a) {
    for (const example of expandGlob(pattern)) {
      if (matchesB(example)) return true;
    }
  }
  return false;
}

export interface ScopeConflict {
  /** Indices of the two tasks whose scopes intersect. */
  first: number;
  second: number;
  detail: string;
}

/**
 * Find every pair of tasks whose declared scopes intersect.
 *
 * Overlapping scopes do not make parallel execution impossible, but they make
 * the outcome depend on which worker happens to finish last — which is exactly
 * the class of bug this project exists to avoid.
 */
export function findScopeConflicts(
  scopes: Array<{ allowedFiles: string[]; label: string }>,
): ScopeConflict[] {
  const conflicts: ScopeConflict[] = [];

  for (let i = 0; i < scopes.length; i += 1) {
    for (let j = i + 1; j < scopes.length; j += 1) {
      const first = scopes[i]!;
      const second = scopes[j]!;
      if (!scopesOverlap(first.allowedFiles, second.allowedFiles)) continue;

      const describe = (scope: { allowedFiles: string[]; label: string }): string =>
        scope.allowedFiles.length === 0
          ? `${scope.label} (unrestricted)`
          : `${scope.label} (${scope.allowedFiles.join(", ")})`;

      conflicts.push({
        first: i,
        second: j,
        detail: `${describe(first)} and ${describe(second)} can both match the same files.`,
      });
    }
  }

  return conflicts;
}

export interface IntegrationConflict {
  path: string;
  tasks: string[];
}

/**
 * Files more than one worker actually changed.
 *
 * Declared scopes can be disjoint while the work still collides — a worker may
 * touch a shared file it was not forbidden from touching. This is measured from
 * what was written, not from what was promised.
 */
export function findIntegrationConflicts(
  results: Array<{ taskId: string; changedFiles: string[] }>,
): IntegrationConflict[] {
  const owners = new Map<string, string[]>();
  const insensitive = nocase();

  for (const result of results) {
    for (const file of result.changedFiles) {
      const key = insensitive ? file.toLowerCase() : file;
      const list = owners.get(key);
      if (list) {
        if (!list.includes(result.taskId)) list.push(result.taskId);
      } else {
        owners.set(key, [result.taskId]);
      }
    }
  }

  const conflicts: IntegrationConflict[] = [];
  for (const [file, tasks] of owners) {
    if (tasks.length > 1) conflicts.push({ path: file, tasks });
  }
  return conflicts.sort((a, b) => a.path.localeCompare(b.path));
}
