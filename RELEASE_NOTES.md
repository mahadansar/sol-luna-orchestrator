# Release notes — working draft

This file stages the body of the **next** GitHub Release. It is not a record of
past releases:

- Shipped releases are recorded in [`CHANGELOG.md`](CHANGELOG.md), which is
  authoritative.
- Published release bodies live on the
  [Releases page](https://github.com/mahadansar/sol-luna-orchestrator/releases).

Drafting the narrative version here rather than in the changelog means a release
body can be written and reviewed before the tag exists. Once a release has
shipped, clear this file back to the outline below: a copy of an entry that is
already published only drifts from it.

**Currently in preparation: v0.7.1.** This is a focused consistency,
supervisor-context-efficiency, and activity reliability patch.

---

## sol-luna-orchestrator v0.7.1

### What this release is for

This patch makes delegation guidance more concise and consistent with the
current bounded-work model, while making live activity monitoring more reliable.

### Install

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
```

### Changed

- Substantially reduced supervisor guidance and repeated schema narration without
  changing public delegation semantics. One bounded executable task, sequential
  dependent work, and parallel independent work retain their existing roles.
- Corrected implementation-only wording and aligned the README, worker brief,
  tool contracts, contributor guidance, troubleshooting command, and annotated
  configuration example with current behavior.
- Clarified context and result-detail guidance so supervisors can send smaller,
  task-relevant briefs and review returned evidence proportionally.
- Made the MCP server advertise the package implementation version instead of a
  hard-coded placeholder.

### Fixed

- Fixed an `activity --watch` startup race that could miss events when the event
  file was created and populated before the delayed watcher attached. File-change
  processing is also serialized to avoid overlapping reads.

### Unchanged

- Worker scheduling, concurrency limits, model routing, cost rates, verification,
  isolation, scope checks, and public schema shapes/defaults are unchanged.

### Links

- [README](README.md)
- [`CHANGELOG.md`](CHANGELOG.md)
- [`SECURITY.md`](SECURITY.md)
- [MIT licence](LICENSE)

Keep every claim traceable to something measured or shipped. No performance or
cost claim belongs here that `bench/RESULTS.md` does not support.
