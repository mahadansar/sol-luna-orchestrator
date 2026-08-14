# Release notes draft — v0.5.1

Draft for the next release. Not published; paste into the GitHub Release body
when the tag is created.

---

## sol-luna-orchestrator v0.5.1

A patch release covering release infrastructure and documentation. **No
orchestration or runtime behaviour changed.** The published code is functionally
identical to 0.5.0 — upgrading gains you nothing but the version number.

```bash
npm install -g sol-luna-orchestrator
sol-luna-orchestrator init
```

### What changed

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

Delegation, worker isolation, scope enforcement, worktrees, verification, the
CLI and telemetry are all exactly as they were in 0.5.0. The benchmark findings
stand: orchestration has not beaten the supervisor working alone on any fixture
in the suite, and no token or cost saving is claimed.

### Links

- [README](https://github.com/mahadansar/sol-luna-orchestrator#readme)
- [Changelog](https://github.com/mahadansar/sol-luna-orchestrator/blob/main/CHANGELOG.md)
- [Security model](https://github.com/mahadansar/sol-luna-orchestrator/blob/main/SECURITY.md)

MIT licensed.
