# Security

This tool runs model-generated instructions against your filesystem and launches
processes on your machine. That is its purpose, so the trust boundaries matter.
This document states them plainly, including where they are weaker than you
might assume.

## Reporting a vulnerability

Open a GitHub security advisory, or a regular issue if the problem is not
sensitive. Please include the version, your platform, and a reproduction.

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
