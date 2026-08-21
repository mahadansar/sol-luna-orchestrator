# Runtime and test instructions

These instructions apply to the TypeScript runtime, smoke programs, and tests under
`src/`. The repository-level instructions still apply.

## Architecture and invariants

- `server.ts` exposes `delegate_task` and `delegate_tasks` over stdio. Never write
  diagnostics to stdout; it is the JSON-RPC transport. Importing `server.ts` must not
  start the server.
- `contract.ts` is the public schema boundary. The hand-written worker output JSON
  Schema must remain strict (`required` fields and `additionalProperties: false`) and
  aligned with parsing, rendering, and tests. Batch task inputs intentionally reuse the
  single-task contract.
- `worker.ts` owns one worker turn, independent verification, observed-versus-claimed
  reconciliation, and verdicts. Keep `buildDelegationResult` pure. A worker `PASS` is
  never authoritative by itself.
- Worker recursion is blocked twice: disable the configured orchestrator MCP server in
  the child Codex config and set `SOL_LUNA_WORKER=1`, which makes a child server register
  no tools. Preserve both guards and keep `SOL_LUNA_SERVER_NAME` aligned with the
  registered name.
- `batch.ts` has semantic modes, not merely scheduling choices. Sequential tasks share
  the workspace and may depend on prior tasks. Parallel tasks branch from `HEAD` into
  separate worktrees, require non-overlapping declared scopes by default, and integrate
  only when observed changed-file sets do not collide.
- Worktree metadata mutations (add/remove/prune) must remain serialized. Workers run
  concurrently only after setup. Shared dependency links are junctions/symlinks; unlink
  them before recursively removing a worktree so the source directory is never removed.
- Parallel integration is a file copy, not a git merge. Dirty in-scope work is refused
  unless the operator explicitly opts into the risk. Partial success is retained.
- Verification commands are model-supplied. Default mode tokenizes to argv, rejects
  active shell syntax, restricts executables, and scrubs credential-shaped environment
  variables. Do not introduce a shell or executable-path bypass into the default path.
- Resolve workspaces and touched paths through symlinks before boundary and glob checks.
  Escapes remain violations even under `allowedFiles: ["**"]`; forbidden patterns take
  precedence over allowed patterns.
- Event writes are best-effort and must never fail a run. Event strings are sanitized,
  the event stream does not include prompts/source/command output, and unavailable usage
  is `null`, never zero. Coordinate event schema changes with the activity reducer and
  backward-compatibility tests.

## Guidance surfaces

The same supervisor policy appears in tool descriptions, server instructions,
`SOL_RULES.md`, and portions of the README. Keep these surfaces consistent. In
particular:

- routine delegation should explicitly prefer compact result detail, while the schema
  default remains `full` for compatibility;
- compact mode removes only successful verification output from structured results;
- context capsules are optional, bounded, and omit empty fields;
- clean verified results use risk-based review, while suspicious evidence still demands
  deep inspection;
- parallel integration verification is conditional on meaningful interaction, not an
  unconditional full-suite ritual.

`src/guidance.test.ts`, `src/evidence.test.ts`, and `src/prompt.test.ts` pin these
cross-surface rules.

## Test selection

- Core schemas, parsing, verdicts, and scope basics: `src/selftest.ts`.
- Command policy and filesystem trust boundaries: `src/security.test.ts`.
- Worktrees, overlap, scheduling, cancellation, and integration: `src/parallel.test.ts`.
- CLI/config lifecycle: `src/cli.test.ts` and `src/activity-config.test.ts`.
- Events/activity projection: `src/activity*.test.ts`.
- Prompt, evidence compaction, and policy wording: `src/prompt.test.ts`,
  `src/evidence.test.ts`, and `src/guidance.test.ts`.
- Benchmark harness/fixture invariants: `src/bench.test.ts`.

The package test script enumerates compiled test files explicitly. When adding a new
test file, add it to `package.json` and both CI/publish workflow test commands, or put the
cases in an existing suite.
