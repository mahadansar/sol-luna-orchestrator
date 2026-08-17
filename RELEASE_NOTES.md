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

**Currently in preparation: v0.6.1.**

---

## sol-luna-orchestrator v0.6.1

A patch release making live orchestration activity inspection work out of the
box after `init`, plus self-repair for existing v0.6.0 installations.

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
```

### What changed

In v0.6.0, `sol-luna-orchestrator activity` required manually exporting the
`SOL_LUNA_EVENTS` environment variable in your shell. In v0.6.1:

- **Activity works out of the box.** `init` automatically configures a local
  event log path under your Codex home directory (`~/.codex/sol-luna-orchestrator.events.jsonl`).
- **Automatic path discovery.** Standalone CLI commands (`activity`, `activity --watch`,
  `activity --json`, `status`, `doctor`) automatically resolve the configured event
  path from your Codex configuration. No manual `export SOL_LUNA_EVENTS` is needed.
- **Seamless repair.** Existing v0.6.0 installations can migrate simply by
  rerunning `sol-luna-orchestrator init`. It will add the missing event configuration
  while preserving all existing settings.
- **Explicit path overrides.** `init --events <path>` allows choosing a custom
  event file, and `init --log <path>` now correctly updates an existing log path.
  Custom paths you set manually are always preserved by plain `init`.

### Unchanged

- Event telemetry remains strictly local and private on your machine.
- Core orchestration, task contracts, verification, and benchmark conclusions
  are unchanged.

### Links

- [README](https://github.com/mahadansar/sol-luna-orchestrator#readme)
- [Changelog](https://github.com/mahadansar/sol-luna-orchestrator/blob/main/CHANGELOG.md)
- [Security policy](https://github.com/mahadansar/sol-luna-orchestrator/blob/main/SECURITY.md)
