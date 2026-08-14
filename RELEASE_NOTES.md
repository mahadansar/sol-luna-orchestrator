# Release notes draft — v0.5.1

Draft for the next release. Not published; paste into the GitHub Release body
when the tag is created.

---

## sol-luna-orchestrator v0.5.1

A patch release fixing a race in parallel delegation, plus release
infrastructure and documentation.

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
```

### Fixed

**A parallel batch could fail a task that had nothing wrong with it.** Worker
worktrees were created concurrently, and `git worktree add` walks metadata
shared by the whole repository, so one creation could abort part-way through
reading another's half-written entry. The affected task came back with no result
and the batch reported a failure that retrying the work would not have fixed.
This was present in 0.5.0; upgrade if you use `mode: "parallel"`.

Worktree setup is now serialized and a batch builds every worktree before any
worker starts. **Worker execution is unchanged and still fully concurrent** — in
fact more so, since workers no longer queue behind each other's setup while
holding a concurrency slot. An eight-task batch now reaches eight concurrent
workers where it previously peaked at three to six.

### What else changed

- **npm Trusted Publishing.** A new `publish.yml` workflow publishes from a
  version tag using GitHub Actions OIDC. There is no npm token in the workflow,
  no repository secret, and nothing to rotate or leak.
- **Provenance.** Because the repository and package are both public, npm
  attaches provenance automatically to anything published this way, so releases
  from 0.5.1 onward carry cryptographic proof of the commit and workflow that
  built them. 0.5.0 was published manually and has no provenance attestation.
- **Tag/version guard.** The workflow refuses to publish if the pushed tag does
  not match `package.json`, and does so before anything is built.
- **npm version badge** in the README, now that the package genuinely exists on
  npm.
- **Roadmap cleanup.** "Publishing to npm" is done and has been removed. The
  benchmark, worker-continuation and sandboxed-verification entries now say what
  each would actually involve. Verification is **not** sandboxed today.
- **Release procedure** documented for maintainers in `CONTRIBUTING.md`.

### Unchanged

Delegation, worker isolation, scope enforcement, verification, the CLI and
telemetry behave exactly as they did in 0.5.0 — the only runtime change is when
worktrees are created, not what workers do. The benchmark findings stand:
orchestration has not beaten the supervisor working alone on any fixture in the
suite, and no token or cost saving is claimed.

### Links

- [README](https://github.com/mahadansar/sol-luna-orchestrator#readme)
- [Changelog](https://github.com/mahadansar/sol-luna-orchestrator/blob/main/CHANGELOG.md)
- [Security model](https://github.com/mahadansar/sol-luna-orchestrator/blob/main/SECURITY.md)

MIT licensed.
