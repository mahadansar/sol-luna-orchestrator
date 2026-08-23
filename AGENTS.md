# Repository instructions

## Source of truth

This package is a Node.js/TypeScript MCP server and companion CLI for bounded
delegation from a supervising Codex agent to isolated worker threads. The
supervisor owns architecture, decomposition, and review; workers receive
self-contained contracts, cannot delegate, and return claims that the runtime
checks against observed edits and independently rerun verification.

Use the current implementation and tests as the authority for behavior. Use
[`CHANGELOG.md`](CHANGELOG.md) for shipped behavior and [`ROADMAP.md`](ROADMAP.md)
for future work only. Keep these ownership boundaries:

- [`README.md`](README.md): product overview and normal use.
- [`SOL_RULES.md`](SOL_RULES.md): supervisor delegation, effort, contract, and
  review policy.
- [`SECURITY.md`](SECURITY.md): threat model, trust boundaries, and log
  sensitivity.
- [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md): settings, environment,
  platform support, and current numeric configuration details.
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md): operational diagnosis and
  recovery.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): contributor and release workflow.
- [`bench/RESULTS.md`](bench/RESULTS.md): benchmark evidence and limits.

Do not duplicate current runtime semantics, benchmark figures, or detailed
release history in these instructions. Do not edit generated `dist/`,
dependencies, runtime logs/events, or `.sol-luna/` worktrees.

## Repository-specific safety

- Treat task contracts, repository contents, paths, commands, worker reports, and
  verification output as untrusted. Operator configuration and environment are
  the policy boundary.
- File scopes are detective rather than a write sandbox. Verification runs
  outside the Codex sandbox with the user's permissions; never describe either
  boundary more strongly than [`SECURITY.md`](SECURITY.md) does.
- Preserve cross-platform behavior, canonical path checks, Windows junction and
  process cleanup handling, and case-insensitive matching where the runtime
  requires it.
- Keep strict TypeScript and existing security boundaries intact. Changes to
  `command.ts`, `scope.ts`, `verify.ts`, or `workspace.ts` require a regression
  case in `src/security.test.ts`.
- When setup, configuration, security, tool contracts, or review guidance
  changes, update the applicable canonical documentation and tests in the same
  change.

## Verification

Choose verification proportionally. Documentation-only changes do not require
model-backed smoke tests. For implementation changes, run at least
`npm run typecheck` and the tests covering the changed area; use `npm run verify`
for broad runtime changes. The deterministic protocol smoke test is
`npm run smoke`, and fixture validation is `npm run bench:validate`.

## Release discipline

Do not publish from a branch or pull request. Maintainers bump `package.json` and
the lockfile, update [`CHANGELOG.md`](CHANGELOG.md), and prepare a transient
GitHub Release draft from that changelog entry; do not commit a separate release
body. Publish only after green CI on `main`, through the tag-matching OIDC
workflow. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the detailed release
workflow. Never add npm tokens or publish secrets.
