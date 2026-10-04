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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  installedCodexCatalogCommand,
  readCodexModelCatalog,
  selectLatestLuna,
} from "./model-catalog.js";
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

const catalogModel = (
  model: string,
  efforts = ["medium", "high", "xhigh", "max"],
  hidden = false,
) => ({
  model,
  hidden,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
});

test("latest Luna selection orders numeric versions and requires all operator efforts", () => {
  assert.equal(
    selectLatestLuna(
      [
        catalogModel("gpt-6.2-luna"),
        catalogModel("gpt-6.10-luna"),
        catalogModel("gpt-7-luna", ["medium"]),
        catalogModel("gpt-8-luna", undefined, true),
        catalogModel("gpt-99-sol"),
        catalogModel("gpt-20-luna-preview"),
        catalogModel("gpt-20-luna-2026-10-04"),
        catalogModel("gpt-06-luna"),
        catalogModel("gpt-99999-luna"),
        null,
        {},
      ],
      ["medium", "high", "xhigh", "max"],
    ),
    "gpt-6.10-luna",
  );
  assert.equal(
    selectLatestLuna([catalogModel("gpt-7-luna", ["medium"])], ["medium"]),
    "gpt-7-luna",
  );
});

test("latest Luna refuses missing capabilities, hidden/older models, and ambiguous duplicates", () => {
  for (const entries of [
    [],
    [catalogModel("gpt-5.6-luna")],
    [catalogModel("gpt-6-luna", [], true)],
    [{ model: "gpt-6-luna", supportedReasoningEfforts: [] }],
    [{ model: "gpt-6-luna", hidden: false }],
  ])
    assert.throws(() => selectLatestLuna(entries, ["medium"]), /No visible/);
  assert.throws(
    () =>
      selectLatestLuna(
        [catalogModel("gpt-6-luna"), catalogModel("gpt-6-luna", [], true)],
        ["medium"],
      ),
    /duplicate/,
  );
});

const catalogFixture = (body: string): readonly string[] => [
  process.execPath,
  "-e",
  `
const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);
 const send=result=>process.stdout.write(JSON.stringify({id:msg.id,result})+'\\n');
 if(msg.method==='initialize'){send({});return;}
 if(msg.method==='initialized')return;
 if(msg.method!=='model/list')process.exit(7);
 ${body}
});`,
];

test("catalog uses the SDK dependency's absolute public CLI entrypoint", () => {
  const command = installedCodexCatalogCommand();
  assert.equal(command[0], process.execPath);
  assert.match(command[1]!, /[\\/]bin[\\/]codex\.js$/);
  assert.deepEqual(command.slice(2), ["app-server"]);
});

test("catalog exchange initializes, paginates, ignores notifications, and cleans up a lingering child", async () => {
  const entries = await readCodexModelCatalog({
    command: catalogFixture(`
    if(process.env.SOL_LUNA_WORKER!=='1')process.exit(9);
    if(msg.params.includeHidden!==false||msg.params.limit!==20)process.exit(10);
    process.stdout.write(JSON.stringify({method:'catalog/notice',params:{}})+'\\n');
    send({data:[{model:msg.params.cursor?'gpt-7-luna':'gpt-6-luna'}],nextCursor:msg.params.cursor?null:'next'});
    setInterval(()=>{},1000);
  `),
  });
  assert.deepEqual(entries, [{ model: "gpt-6-luna" }, { model: "gpt-7-luna" }]);
});

for (const [name, body, options, error] of [
  ["repeated cursor", "send({data:[],nextCursor:'same'});", {}, /repeated/],
  ["missing cursor", "send({data:[]});", {}, /malformed/],
  ["malformed JSON", "process.stdout.write('not-json\\n');", {}, /malformed/],
  [
    "error response",
    "process.stdout.write(JSON.stringify({id:msg.id,error:{message:'private'}})+'\\n');",
    {},
    /malformed/,
  ],
  [
    "unexpected response",
    "process.stdout.write(JSON.stringify({id:99,result:{}})+'\\n');",
    {},
    /unexpected/,
  ],
  [
    "response overflow",
    "process.stdout.write('x'.repeat(4096));",
    { maxBytes: 1000 },
    /byte limit/,
  ],
  [
    "stderr overflow",
    "process.stderr.write('x'.repeat(4096));",
    { maxBytes: 1000 },
    /byte limit/,
  ],
  [
    "page overflow",
    "send({data:[],nextCursor:String(msg.id)});",
    { maxPages: 2 },
    /pagination/,
  ],
  ["premature exit", "process.exit(4);", {}, /exited before/],
  [
    "too many page entries",
    "send({data:Array(21).fill({}),nextCursor:null});",
    {},
    /malformed/,
  ],
] as const)
  test(`catalog refuses ${name}`, async () => {
    await assert.rejects(
      readCodexModelCatalog({ command: catalogFixture(body), ...options }),
      error,
    );
  });

test("catalog startup timeout and abort settle without a dangling process", async () => {
  await assert.rejects(
    readCodexModelCatalog({
      command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      timeoutMs: 50,
    }),
    /deadline/,
  );
  const controller = new AbortController();
  const pending = readCodexModelCatalog({
    command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    signal: controller.signal,
  });
  const refused = assert.rejects(pending, /cancelled/);
  controller.abort();
  await refused;
  await assert.rejects(
    readCodexModelCatalog({ command: [process.execPath], signal: controller.signal }),
    /cancelled/,
  );
});

test("catalog rejects untrusted launcher names and handles spawn failure", async () => {
  await assert.rejects(readCodexModelCatalog({ command: ["codex"] }), /absolute/);
  await assert.rejects(
    readCodexModelCatalog({ command: [process.execPath + "-missing"] }),
    /could not start/,
  );
});

test("automatic startup freezes concrete model, policy, descriptions, and operator ladder together", async () => {
  const run = promisify(execFile);
  const server = new URL("./server.js", import.meta.url).href;
  const config = new URL("./config.js", import.meta.url).href;
  const policy = new URL("./policy.js", import.meta.url).href;
  const { stdout } = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import * as server from ${JSON.stringify(server)};
    import * as config from ${JSON.stringify(config)};
    import * as policy from ${JSON.stringify(policy)};
    let calls=0;
    const first=server.initializeWorkerModel(async efforts=>{calls++;return 'gpt-7-luna';});
    const second=server.initializeWorkerModel(async ()=>{throw new Error('must not rediscover');});
    await Promise.all([first,second]);
    console.log(JSON.stringify({calls,model:config.LUNA_MODEL,allowed:config.ALLOWED_MODELS,
      baseline:policy.DEFAULT_COMPUTE_POLICY_ENVIRONMENT.model,policy:policy.DEFAULT_COMPUTE_POLICY,
      descriptions:[server.TOOL_DESCRIPTION,server.BATCH_TOOL_DESCRIPTION,server.EXPLORE_TOOL_DESCRIPTION,server.SERVER_INSTRUCTIONS],
      ladderInvalid:policy.EXECUTOR_ORDER_UNUSABLE}));
    try{config.pinDiscoveredLuna('gpt-8-luna');process.exitCode=2;}catch{}
  `,
    ],
    {
      env: {
        ...process.env,
        SOL_LUNA_WORKER: "0",
        LUNA_MODEL: "latest-luna",
        SOL_LUNA_ALLOWED_MODELS: "gpt-6-sol",
        SOL_LUNA_EXECUTOR_ORDER: "latest-luna,gpt-6-sol",
      },
      timeout: 10000,
    },
  );
  const resolved = JSON.parse(stdout);
  assert.equal(resolved.calls, 1);
  assert.equal(resolved.model, "gpt-7-luna");
  assert.equal(resolved.baseline, resolved.model);
  assert.deepEqual(resolved.allowed, ["gpt-7-luna", "gpt-6-sol"]);
  assert.deepEqual(resolved.policy.allowedModels, resolved.allowed);
  assert.deepEqual(resolved.policy.executorOrder, resolved.allowed);
  assert.equal(resolved.ladderInvalid, false);
  assert.ok(
    resolved.descriptions.every(
      (description: string) =>
        description.includes(resolved.model) && !description.includes("latest-luna"),
    ),
  );
});

test("pinned startup and offline config inspection never discover a catalog", async () => {
  const run = promisify(execFile);
  const server = new URL("./server.js", import.meta.url).href;
  for (const pin of ["gpt-6-luna", "gpt-5.6-luna"]) {
    const { stdout } = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {initializeWorkerModel} from ${JSON.stringify(server)};
      console.log(await initializeWorkerModel(async()=>{throw new Error('unexpected discovery');}));
    `,
      ],
      { env: { ...process.env, LUNA_MODEL: pin }, timeout: 10000 },
    );
    assert.equal(stdout.trim(), pin);
  }
  const offline = new URL("./cli/server-config.js", import.meta.url).href;
  const { stdout } = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {resolveRegisteredServerConfig} from ${JSON.stringify(offline)};
    console.log(JSON.stringify(resolveRegisteredServerConfig('[mcp_servers.sol-luna-orchestrator.env]\\nLUNA_MODEL = "latest-luna"\\n')));
  `,
    ],
    { env: { ...process.env, LUNA_MODEL: "latest-luna" }, timeout: 10000 },
  );
  assert.match(stdout, /latest-luna/);
});
