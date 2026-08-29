/**
 * Regression tests for trusted executable resolution.
 *
 * SECURITY.md promises that "a repo-local `./npm` cannot hijack the real one".
 * `command.ts` enforces the lexical half of that — an executable may not spell
 * a path — but the operating system still resolves the surviving bare name, and
 * both Windows and a `PATH` containing `.` resolve it from the current
 * directory first. The current directory is the workspace a worker just wrote
 * to, so the lexical check alone left the promise false.
 *
 * These run with an injected probe and an injected environment, so both
 * platforms' behaviour is exercised on either platform.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PATHEXT,
  ExecutableResolutionError,
  NO_CWD_IN_EXE_PATH_ENV,
  resolveExecutable,
  withoutCwdExecutableLookup,
  type ExecutableProbe,
} from "./executable.js";

/** A filesystem of executables, keyed by absolute path. */
const probeFor = (present: string[]): ExecutableProbe => {
  const set = new Set(present.map((entry) => entry.toLowerCase()));
  return { isExecutableFile: (candidate) => set.has(candidate.toLowerCase()) };
};

const WIN = {
  platform: "win32" as const,
  delimiter: ";",
};
const POSIX = {
  platform: "linux" as const,
  delimiter: ":",
};

test("Windows resolution walks PATH and appends PATHEXT", () => {
  const resolved = resolveExecutable("npm", {
    ...WIN,
    env: { PATH: String.raw`C:\tools;C:\node`, PATHEXT: DEFAULT_PATHEXT },
    probe: probeFor([String.raw`C:\node\npm.CMD`]),
  });
  // PATHEXT supplies the extension, so its casing is what comes back.
  assert.equal(resolved.toLowerCase(), String.raw`c:\node\npm.cmd`);
});

test("Windows resolution honours an explicit extension before appending more", () => {
  const resolved = resolveExecutable("npm.cmd", {
    ...WIN,
    env: { PATH: String.raw`C:\node`, PATHEXT: DEFAULT_PATHEXT },
    probe: probeFor([String.raw`C:\node\npm.cmd`]),
  });
  assert.equal(resolved, String.raw`C:\node\npm.cmd`);
});

test("Windows resolution prefers the earliest PATH entry, not the working directory", () => {
  // The workspace is deliberately absent from PATH. Windows would have searched
  // it first; this must not.
  const resolved = resolveExecutable("npm", {
    ...WIN,
    env: { PATH: String.raw`C:\real`, PATHEXT: DEFAULT_PATHEXT },
    probe: probeFor([String.raw`C:\workspace\npm.cmd`, String.raw`C:\real\npm.cmd`]),
  });
  assert.equal(resolved.toLowerCase(), String.raw`c:\real\npm.cmd`);
});

test("Windows PATH lookup is case-insensitive on the variable name", () => {
  const resolved = resolveExecutable("npm", {
    ...WIN,
    env: { Path: String.raw`C:\node`, PATHEXT: DEFAULT_PATHEXT },
    probe: probeFor([String.raw`C:\node\npm.exe`]),
  });
  assert.equal(resolved.toLowerCase(), String.raw`c:\node\npm.exe`);
});

test("POSIX resolution walks PATH without appending extensions", () => {
  const resolved = resolveExecutable("pytest", {
    ...POSIX,
    env: { PATH: "/usr/local/bin:/usr/bin" },
    probe: probeFor(["/usr/bin/pytest"]),
  });
  assert.equal(resolved, "/usr/bin/pytest");
});

for (const [label, entry] of [
  ["an empty entry", ""],
  ["a bare dot", "."],
  ["a relative directory", "bin"],
  ["a relative traversal", "../bin"],
] as const) {
  test(`PATH entries that mean the working directory are skipped: ${label}`, () => {
    // Every one of these resolves against `cwd`, which is the untrusted
    // workspace. A `PATH` made only of them must resolve nothing.
    assert.throws(
      () =>
        resolveExecutable("npm", {
          ...POSIX,
          env: { PATH: entry },
          probe: probeFor(["npm", "bin/npm", "../bin/npm", "./npm"]),
        }),
      ExecutableResolutionError,
    );

    // And when a real directory follows, the real tool is what runs.
    const resolved = resolveExecutable("npm", {
      ...POSIX,
      env: { PATH: `${entry}:/usr/bin` },
      probe: probeFor(["npm", "bin/npm", "../bin/npm", "/usr/bin/npm"]),
    });
    assert.equal(resolved, "/usr/bin/npm");
  });
}

test("Windows drops the same working-directory PATH entries", () => {
  assert.throws(
    () =>
      resolveExecutable("npm", {
        ...WIN,
        env: { PATH: String.raw`;.;tools`, PATHEXT: DEFAULT_PATHEXT },
        probe: probeFor(["npm.cmd", String.raw`tools\npm.cmd`]),
      }),
    ExecutableResolutionError,
  );
});

test("a quoted Windows PATH entry is still searched", () => {
  const resolved = resolveExecutable("npm", {
    ...WIN,
    env: { PATH: String.raw`"C:\Program Files\node"`, PATHEXT: DEFAULT_PATHEXT },
    probe: probeFor([String.raw`C:\Program Files\node\npm.cmd`]),
  });
  assert.equal(resolved.toLowerCase(), String.raw`c:\program files\node\npm.cmd`);
});

test("an unresolvable name fails closed rather than falling back to the bare name", () => {
  assert.throws(
    () =>
      resolveExecutable("npm", {
        ...POSIX,
        env: { PATH: "/usr/bin" },
        probe: probeFor([]),
      }),
    (error: Error) => {
      assert.ok(error instanceof ExecutableResolutionError);
      assert.match(error.message, /not found on PATH/);
      // Falling through to "npm" is exactly the behaviour this replaces.
      assert.match(error.message, /working directory is deliberately not searched/);
      return true;
    },
  );
});

test("an operator's explicit path entry is passed through untouched", () => {
  // `SOL_LUNA_VERIFY_ALLOW=./gradlew` is a deliberate decision to run something
  // relative to the workspace. Resolution must not silently rewrite it.
  for (const explicit of ["./gradlew", "/usr/local/bin/runner"]) {
    assert.equal(
      resolveExecutable(explicit, {
        ...POSIX,
        env: { PATH: "/usr/bin" },
        probe: probeFor([]),
      }),
      explicit,
    );
  }
  for (const explicit of [
    String.raw`.\gradlew.bat`,
    String.raw`C:\tools\run.exe`,
    "C:run.exe",
  ]) {
    assert.equal(
      resolveExecutable(explicit, {
        ...WIN,
        env: { PATH: String.raw`C:\x` },
        probe: probeFor([]),
      }),
      explicit,
    );
  }
});

test("child environments pin off current-directory executable lookup", () => {
  const env = withoutCwdExecutableLookup({ PATH: "/usr/bin" });
  assert.equal(env[NO_CWD_IN_EXE_PATH_ENV], "1");
  assert.equal(env.PATH, "/usr/bin");
  // Windows consults this in cmd.exe and in CreateProcess-based lookups, which
  // covers the resolution inside a `.cmd` shim that we never see.
  assert.equal(
    withoutCwdExecutableLookup({ [NO_CWD_IN_EXE_PATH_ENV]: "0" })[NO_CWD_IN_EXE_PATH_ENV],
    "1",
  );
});
