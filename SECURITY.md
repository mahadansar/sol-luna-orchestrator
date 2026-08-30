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

**Redact before you send.** Logs, event files and tool-result evidence can
contain repository paths, model-supplied text, source details or command output.
Strip anything you would not publish.

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
- The surviving bare name is then resolved to an absolute path **by this
  project, from `PATH` only**. The working directory is never searched, and
  `PATH` entries that mean it — an empty entry, `.`, or anything relative — are
  skipped. This matters because the working directory is the workspace a worker
  just wrote to, and the operating system would otherwise prefer a file there:
  Windows searches the current directory ahead of `PATH` unless
  `NoDefaultCurrentDirectoryInExePath` is set, which by default it is not. A
  name that resolves to nothing on `PATH` is reported as a launch failure rather
  than falling back to the bare name.
- Shell metacharacters _inside quotes_ are allowed and passed through literally.
  They are inert without a shell, and rejecting them would break legitimate test
  filters like `pytest -k "not slow"`. **Two exceptions on Windows**: when the
  allowlisted executable resolves to a `.cmd` or `.bat` — which is what `npm`,
  `yarn`, `mvn`, `gradle` and `tsc` all are there — Windows can only launch it by
  handing a command _line_ to `cmd.exe`, and the shim then forwards its
  arguments with `%*`, so cmd parses them a second time. An argument containing
  `"` would end the quoted span in that second parse and turn the remainder into
  live cmd syntax; an argument containing `!` expands as a variable in any shim
  that enabled delayed expansion. Neither form can be represented safely, so an
  argument containing either is refused rather than escaped more cleverly.
  `&`, `|`, `<`, `>`, `^`, `(`, `)` and `%VAR%` are verified to survive that
  second parse intact and remain permitted. Nothing here applies off Windows, or
  to an executable that resolves to a `.exe`.
- Credential-shaped environment variables (matching `KEY`, `TOKEN`, `SECRET`,
  `PASSWORD`, `PASSWD`, `CREDENTIAL`, `SESSION`, `COOKIE`, `AUTH`) are withheld
  from the child process, because its output is fed back into a model transcript.

`SOL_LUNA_VERIFY_MODE=shell` disables all of the above and hands the raw string
to a system shell. It exists for people who need it and is logged loudly at
startup. **Do not enable it against a repository you do not trust.**

Each task's commands are independently rerun after its worker exits. A batch
also reruns the deduplicated union after sequential execution or successful
parallel integration, in the requested workspace. Both passes use the same
operator-configured execution policy, timeout, environment filtering, and user
permissions. This is independent evidence, not a sandbox: a permitted command
can modify anything the operating-system account permits. An empty, refused,
skipped, failed, or incomplete final set cannot produce the terminal verified
batch state.

Timeout and caller cancellation both terminate the active verification process
tree and wait for that termination before returning. They remain distinct in
the authoritative evidence. POSIX launches verification in a detached process
group and signals the group; Windows awaits `taskkill /T /F` and then awaits the
verification child itself. A cancelled parent therefore does not report
completion while a known verification command is still running.

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
- **`.git/**` and `.sol-luna/**` are always violations**, at any depth, whatever
  `allowedFiles` says. `.git` is a code-execution surface: a `hooks/pre-commit`
  planted there runs the next time _you_ commit, and `core.pager`,
  `core.fsmonitor` and `core.sshCommand` each reach execution from `config`
  alone. `.sol-luna` is this orchestrator's own worktree and lease state, which
  the runtime later reads as authoritative. The rule sits above `allowedFiles`
  rather than inside `forbiddenFiles` because `forbiddenFiles` is caller-supplied
  and a caller can simply omit it; nothing a caller, a worker, or a model emits
  turns this off. Nested repositories are covered too — a hook in
  `vendor/x/.git/hooks/` still runs whenever anyone uses git there. `.gitignore`,
  `.gitattributes` and `.github/` are ordinary files and are not matched.
- Protection checks both the lexical path supplied by the runtime and its
  canonical target. Nested repositories, worktree `.git` files, and links into
  control metadata therefore cannot hide a protected component during symlink
  resolution. The runtime's own continuation path has a narrow internal-only
  admission for its already-owned `.sol-luna/worktrees/<id>` root; ordinary
  delegation cannot request that exception.

### Completion, observability, and shutdown

Event and recording sinks are observability only. A sink failure is isolated
from execution authority and cannot skip lease or workspace cleanup, replace a
verified result, or publish a second terminal state. If presentation fails after
completion, the tool returns a minimal message and preserves the authoritative
result in structured content. Cleanup failure is different: the evidence is
retained, but the result is marked for supervisor attention because filesystem
state may remain.

On `SIGINT` or `SIGTERM` the server stops accepting new operations, aborts active
ones (including queued worker-slot waits and verification subprocesses), waits
for bounded cleanup, then closes the transport. Capability stores and context
registries are disposed only after active calls settle. The shutdown bound is 30
seconds; exceeding it fails closed and leaves admission closed rather than
allowing a late success.

### Worker isolation

Workers cannot delegate. Two independent guards:

1. The worker's Codex process is launched with
   `mcp_servers.<name>.enabled=false`, so Codex never starts this server for it.
2. The worker's environment carries `SOL_LUNA_WORKER=1`. A server that starts
   with that marker registers **no tools at all**, so isolation survives the
   server being registered under a different name.

Both are exercised by `npm run smoke:isolation`, not by the deterministic CI
suite: guard 2 by starting a marked server and listing its tools, guard 1 by
running a real worker turn and checking the log for a server it should never have
started. Reach for that suite whenever a worker claims it can delegate — a
model's own answer is not evidence.

`--config mcp_servers={}` does **not** work for this: Codex merges that override
into the existing table and every server still starts. This was verified against
codex-cli 0.147.0 and is why guard 1 is written the way it is.

**The worker inherits your full environment.** The worker's Codex process is
launched with a copy of the orchestrator's own environment plus
`SOL_LUNA_WORKER=1`. Nothing is removed from it — the worker needs your provider
credentials to run at all, so it gets `OPENAI_API_KEY` and everything beside it,
including variables belonging to unrelated tools.

This is **not** the filtered environment described under
[verification commands](#verification-commands-are-not-shell-strings). Those two
subprocesses are deliberately different: a verification command is a test suite
that has no business holding your keys and whose output is fed back into a
transcript, while the worker is the agent that must authenticate to the model
provider. Credential-shaped filtering applies to the first and not the second.

What follows from that: a worker running under `workspace-write` can read its own
environment, and a repository whose test or build tooling the worker chooses to
run inherits it too. If a variable would be damaging in a model transcript or in
an untrusted repository's hands, do not put it in the environment that launches
this server. `SOL_LUNA_VERIFY_ENV_PASSTHROUGH` does not affect this path in
either direction.

Exploration narrows file admission further before creating its disposable
surface. In addition to `.git`, `.sol-luna`, and caller-supplied
`forbiddenFiles`, it categorically excludes `.env`, `.env.*`, `.envrc`, `.npmrc`,
`.netrc`, `_netrc`, `.aws/credentials`, and `.git-credentials` at any depth.
This is a small denylist for conventional credential files, not a secret
scanner: deliberately broad patterns such as `*.pem`, `*.key`, `id_rsa`, and
`secrets*` are not automatically excluded because repositories commonly contain
non-secret fixtures with those names. Add them to `forbiddenFiles` when needed.

### Parallel batches write inside your repository

A parallel batch creates one git worktree per worker under
`.sol-luna/worktrees/` and adds that path to `.git/info/exclude`. Each worker
edits **real files** in its own worktree — the isolation is between workers, not
between a worker and your disk. Integration copies files back into your working
tree, and only when no two workers touched the same file **and the task that
produced them stayed inside its declared scope**. A task with scope violations is
excluded from integration entirely: finishing its turn is not authorization for
its changes, and the whole point of declaring a scope is that work outside it was
never asked for. The violation appears in that task's scope evidence, an
`integration.blocked` event records the exclusion, and the batch cannot reach
the terminal verified state. The isolated bytes remain available only until
finalization; `SOL_LUNA_KEEP_WORKTREES` then decides whether that worktree is
retained, and `never` attempts to remove it.
Clean siblings still integrate, because parallel tasks are required to declare
disjoint scopes and that is what makes them independent; when a call sets
`allowOverlappingScopes:true` it withdraws that declaration, so a single
violation there blocks integration for the whole batch rather than leaving the
workspace holding half of a set of changes that were never independent.
Sequential batches have no integration step at all — those tasks write directly
into the workspace — so there a violation is reported, not undone. A batch is
refused up front if two tasks declare overlapping scopes, or if the repository has
uncommitted changes inside a declared scope. `SOL_LUNA_ALLOW_DIRTY=1` is an
explicit escape hatch with consequences: workers still branch from `HEAD`, so
they neither see nor preserve uncommitted work inside their scopes, and
integration can overwrite it.

Worktree directory names include an opaque batch identity as well as the task
ordinal, so retained worktrees are not reused by later batches. Every active
parallel worktree has a bounded, owner-specific filesystem lease before Git
registration begins. Retained continuations transfer that same lease through
reference expiry and refresh it for the full continuation timeout; exact-owner
release prevents an older run from unprotecting a newer identity. Acquisition
atomically links a complete expiring reservation before creating the lease
directory, so a crash before the first generation is distinguishable and later
reclaimable without exposing a live publisher. Immediately before publishing
the first generation, the acquirer revalidates the live same-owner reservation
and its owner marker; stale publishers fail with owner-specific rollback and
cannot remove a replacement artifact or reservation.

`SOL_LUNA_WORKTREE_LINK` (default `node_modules`) links directories from your
repository into each worktree — a junction on Windows, a directory symlink
elsewhere. Anything linked is **shared, not copied**: a worker writing through
that link writes into your real directory.

Worktrees are created, removed and pruned one at a time, including across MCP
server processes sharing a repository. `git worktree add` walks metadata shared
by the whole repository, so concurrent creation could corrupt another worker's
registration. Serializing those operations does not affect the workers
themselves, which still run concurrently once their workspaces exist.
Metadata-lease renewal is fail-closed: its first refresh failure becomes visible
to the owning operation, which refuses to begin another Git metadata command.
Every command begins only after checking that the last published horizon still
covers Git's 120-second cap plus a five-second scheduling margin; retry loops
check again between attempts. Worker and continuation leases are initially
published for their complete configured execution timeout plus cleanup grace,
so renewal loss cannot create a mid-turn pruning window and is still surfaced
when maintenance stops. Teardown releases process-local ownership in a `finally`
path even when renewal or cleanup fails; any retained filesystem state remains
protected only by its real bounded persistent horizon and becomes pruneable
after expiry.

### Bounded parallel recovery

When enabled (the `delegate_tasks` default), recovery is decided only after all
initial parallel workers have stopped and their final worktree evidence has been
read. A timeout may resume its observed thread only when the owned worktree is
readable and confined; a worker-process failure with no result may start one fresh
thread in that same owned worktree. No recovery widens a path scope, changes
effort or acceptance, reruns a successful task, or crosses cancellation,
scope/security, evidence, refused-verification, contract-discrepancy, or known
integration-conflict boundaries. The one-turn bound and stable batch/task ids are
recorded in results and telemetry. If the retry fails, the original sibling work
remains available for normal integration and review.

### Logs and telemetry

`SOL_LUNA_LOG` and `SOL_LUNA_EVENTS` write plain files with no access control.
They hold different things, which matters when deciding what is safe to share:

- **`SOL_LUNA_LOG`** is the human-readable diagnostics log. It records
  objective previews for single delegations, paths, thread ids, verdicts and
  errors. Verification command output is returned in tool-result evidence, not
  copied into this file. Treat the log as sensitive even without command output.

- **`SOL_LUNA_EVENTS`** is the structured stream `activity` reads, and the
  deliberately less sensitive of the two. Its schema carries opaque task and
  batch ids, effort, category, verdicts, model, durations, token counts,
  changed-file counts, worktree and working-directory paths, failure reasons and
  conflicting file paths. A caller-provided, bounded `activityLabel` is
  deliberately persisted locally and can reveal a short work description. It does
  **not** contain worker prompts or objectives, task context, source code or
  command output; only a short failure reason may surface from a failed check.
  Paths, labels and failure reasons may themselves be revealing.
  [Observability](docs/OBSERVABILITY.md) documents the full shapes.

Opaque continuation and next-action handoff references are bearer-like process
capabilities. They are returned only in the directly related tool result and are
not written to diagnostic logs, telemetry events, usage records, or activity
history. Both are single-use and TTL-bounded in memory; restarting the server
invalidates them rather than reconstructing authority from retained logs or
caller-supplied history.

An `hdf_*` next-action reference has an atomic `ready -> reserved -> consumed`
lifecycle. Admission reserves it before gates that may still refuse the call, so
a concurrent consumer cannot also execute. A refusal before execution releases
the reservation with its original expiry; an expiry while reserved retires it,
and entry into worker execution commits consumption. Release never grants a new
TTL or reconstructs a capability. `ctr_*` continuation references are likewise
consumed once, but do not use the pre-execution handoff-reservation path.

Cross-session handoff artifacts are different: they are portable, caller-held
historical context and are never bearer capabilities or authenticated runtime
evidence. Their schema proves structure only. On import, objective and scope are
marked `imported-informational`; decisions, constraints, blockers, observations,
verification, verdicts, failure decisions, and attempt lineage remain inside a
separate imported-history packet. They do not populate the current session's
canonical evidence, capability stores, retry lineage, compute selection, or
verification state. A fresh delegation establishes its contract from the new
request and passes the normal admission, scope, policy, and verification gates.
Restore refuses non-empty or in-flight context stores, and a restart continues to
invalidate every process-local `ctr_*` and `hdf_*` reference.

Export sanitizes concrete capability and credential patterns, omits raw worker
prompts and compacted turn payloads, and rejects artifacts above 256 KiB rather
than truncating diagnostic semantics. It is still a potentially sensitive local
artifact: historical paths, decisions, failures, source-grounding excerpts, and
verification output can remain. Inspect it before sharing and do not treat
redaction as a general-purpose data-loss-prevention boundary.

Current activity writers exclude objectives and task context. Historical JSONL
retained from pre-hardening versions may still contain older schema fields,
including objectives; the current reader dropping such fields does not erase
them from disk. Rotate old files if their contents should no longer be retained.
Diagnostic logs and tool-result evidence remain more sensitive than current
activity telemetry.

Control characters and complete bearer-shaped `ctr_*` / `hdf_*` identifiers are
redacted at the diagnostic and event boundaries. Structured event values are
sanitized recursively, including nested error and accounting metadata; short
ordinary prose such as `ctr_example` is preserved. This is still not a general
secret filter. Keep both files outside the repository, and read either before
attaching it to a public issue.

**`init` configures both logs by default**, under your Codex home, because
`sol-luna-orchestrator activity` cannot work without the event log. Nothing is
transmitted anywhere — these are local files — but they do accumulate a record
of what you delegated across every project. To turn either off, delete its key
from `[mcp_servers.sol-luna-orchestrator.env]`; the server treats an unset value
as "do not write". `uninstall` removes those keys but deliberately leaves the
files themselves alone, since the history is yours rather than ours to delete.

`init` also makes one surgical, optional change to the user-owned global Codex
instructions for discovery. It does not force delegation or start workers; see
[Configuration](docs/CONFIGURATION.md#discovery-hint-and-adaptive-routing) for
the exact file-selection, ownership, opt-out, and removal behavior.

## What is NOT enforced — read this

- **The worker writes real files.** It runs under Codex's `workspace-write`
  sandbox with `approvalPolicy: never`, because there is no human to answer a
  prompt. Scope violations are detected **after** the fact and reported; the
  write itself is not prevented. What _is_ prevented is an unauthorized change
  reaching your working tree through integration — a parallel task that violated
  its scope is excluded, and the change remains only in the isolated worktree
  until retention-policy finalization. That does not
  help a single delegation or a sequential batch, which write into your
  workspace directly and have nothing to exclude. Use version control.
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
