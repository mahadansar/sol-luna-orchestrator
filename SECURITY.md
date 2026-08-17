# Security

This tool runs model-generated instructions against your filesystem and launches
processes on your machine. That is its purpose, so the trust boundaries matter.
This document states them plainly, including where they are weaker than you
might assume.

## Reporting a vulnerability

Open a
[GitHub security advisory](https://github.com/mahadansar/sol-luna-orchestrator/security/advisories/new),
which is private, or a regular
[issue](https://github.com/mahadansar/sol-luna-orchestrator/issues) if the
problem is not sensitive. Please include the orchestrator version, your platform
and Node version, and a reproduction.

**Redact before you send.** Logs and event files can contain repository paths,
file contents and command output. Strip anything you would not publish.

There is no bounty programme and no formal SLA; this is a solo project. Expect an
acknowledgement rather than an immediate fix.

## Threat model

The model driving this server is **not** treated as trusted. A supervising agent
can be steered by the contents of the repository it is reading — a malicious
README, source comment, or test fixture can attempt prompt injection. Every task
contract field (`objective`, `verificationCommands`, `workingDirectory`,
`allowedFiles`, …) is therefore treated as untrusted input.

Trusted inputs are the ones **you** control: environment variables and the Codex
config that launches the server.

## What is enforced

### Verification commands are not shell strings

`verificationCommands` come from the model. By default (`SOL_LUNA_VERIFY_MODE=allowlist`):

- The command is parsed into an argv array by this project's own tokenizer. **No
  shell is involved**, so `;`, `&&`, `|`, backticks and `$(...)` cannot chain or
  substitute anything.
- Those constructs are _rejected_ rather than passed through, because without a
  shell they would silently become literal arguments and quietly do the wrong
  thing.
- Only executables on an allowlist may launch (`npm`, `pytest`, `cargo`, …). The
  executable may not contain a path, so a repo-local `./npm` cannot hijack the
  real one.
- Shell metacharacters _inside quotes_ are allowed and passed through literally.
  They are inert without a shell, and rejecting them would break legitimate test
  filters like `pytest -k "not slow"`.
- Credential-shaped environment variables (matching `KEY`, `TOKEN`, `SECRET`,
  `PASSWORD`, `CREDENTIAL`, `SESSION`, `COOKIE`, `AUTH`) are withheld from the
  child process, because its output is fed back into a model transcript.

`SOL_LUNA_VERIFY_MODE=shell` disables all of the above and hands the raw string
to a system shell. It exists for people who need it and is logged loudly at
startup. **Do not enable it against a repository you do not trust.**

### Workspace boundaries

- `workingDirectory` must be an absolute path to an existing directory.
- Paths are compared **after** resolving symlinks. A symlink inside the workspace
  pointing outside is reported as an escape, not silently followed.
- Escaping the workspace is always a scope violation, even under
  `allowedFiles: ["**"]`. Allowlist globs are workspace-relative and are never
  read as authorization to write elsewhere.
- `SOL_LUNA_ALLOWED_ROOTS` optionally confines delegation to specific roots.
- Glob matching is case-insensitive on Windows and macOS so `SRC/x` cannot slip
  past an `src/**` rule on a case-insensitive filesystem.

### Worker isolation

Workers cannot delegate. Two independent guards, both covered by tests:

1. The worker's Codex process is launched with
   `mcp_servers.<name>.enabled=false`, so Codex never starts this server for it.
2. The worker's environment carries `SOL_LUNA_WORKER=1`. A server that starts
   with that marker registers **no tools at all**, so isolation survives the
   server being registered under a different name.

`--config mcp_servers={}` does **not** work for this: Codex merges that override
into the existing table and every server still starts. This was verified against
codex-cli 0.147.0 and is why guard 1 is written the way it is.

### Parallel batches write inside your repository

A parallel batch creates one git worktree per worker under
`.sol-luna/worktrees/` and adds that path to `.git/info/exclude`. Each worker
edits **real files** in its own worktree — the isolation is between workers, not
between a worker and your disk. Integration copies files back into your working
tree, and only when no two workers touched the same file. A batch is refused up
front if two tasks declare overlapping scopes, or if the repository has
uncommitted changes inside a declared scope.

`SOL_LUNA_WORKTREE_LINK` (default `node_modules`) links directories from your
repository into each worktree — a junction on Windows, a directory symlink
elsewhere. Anything linked is **shared, not copied**: a worker writing through
that link writes into your real directory.

Worktrees are created, removed and pruned one at a time. `git worktree add` walks
metadata shared by the whole repository, so concurrent creation could corrupt
another worker's registration (fixed in 0.5.1). Serializing those operations
costs milliseconds and does not affect the workers themselves, which still run
concurrently once their workspaces exist.

### Logs and telemetry

`SOL_LUNA_LOG` and `SOL_LUNA_EVENTS` write plain files with no access control.
They record objectives, file paths, verification command output and token
counts. Verification output is truncated but not sanitised, so if a test suite
prints a secret, the log will contain it. Keep both outside the repository, and
do not attach them to a public issue without reading them first.

**`init` configures both by default**, under your Codex home, because
`sol-luna-orchestrator activity` cannot work without the event log. Nothing is
transmitted anywhere — these are local files — but they do accumulate a record
of what you delegated across every project. To turn either off, delete its key
from `[mcp_servers.sol-luna-orchestrator.env]`; the server treats an unset value
as "do not write". `uninstall` removes those keys but deliberately leaves the
files themselves alone, since the history is yours rather than ours to delete.

## What is NOT enforced — read this

- **The worker writes real files.** It runs under Codex's `workspace-write`
  sandbox with `approvalPolicy: never`, because there is no human to answer a
  prompt. Scope violations are detected **after** the fact and reported; they are
  not prevented. Use version control.
- **Verification runs outside the Codex sandbox.** The allowlist constrains
  _which_ executable runs, not what that executable then does. `npm test`
  executes your project's own test code, which can do anything your user account
  can. If your repository is untrusted, its test suite is untrusted too.
- **`npm`/`npx` can run arbitrary package code.** Allowlisting `npx` means a
  model-chosen package name could be fetched and executed. Remove `npx` from the
  allowlist for stricter setups.
- **This is not a sandbox.** It is a set of guardrails that make the common
  failure modes loud instead of silent.

## Hardening checklist

```bash
SOL_LUNA_ALLOWED_ROOTS=/home/you/projects   # confine delegation
SOL_LUNA_VERIFY_MODE=off                    # never execute model-chosen commands
LUNA_NETWORK_ACCESS=0                       # default; keep workers offline
```

Run against a git repository with a clean working tree so any scope violation is
one `git diff` away from being visible.
