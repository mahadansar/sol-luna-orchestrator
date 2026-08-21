# Repository instructions

## Purpose and source of truth

This package is a Node.js/TypeScript MCP server and companion CLI for bounded
delegation from a supervising Codex agent to isolated worker threads. The supervisor
owns architecture, decomposition, and review; workers receive self-contained task
contracts, may not delegate further, and return claims that the orchestrator checks
against observed edits and independently rerun verification.

Use the current implementation and tests as the authority for behavior. Use
`CHANGELOG.md` for what has shipped. `ROADMAP.md` describes future work; never present
an unshipped roadmap item or a research experiment as current behavior. Keep the
following focused documents authoritative rather than copying them into code or other
docs:

- `README.md`: product overview, normal use, and architecture summary.
- `SOL_RULES.md`: supervisor delegation, effort, contract, and review policy.
- `SECURITY.md`: threat model and trust boundaries.
- `docs/CONFIGURATION.md`: settings, environment variables, and platform support.
- `docs/TROUBLESHOOTING.md`: operational diagnosis and recovery.
- `bench/RESULTS.md`: benchmark methodology, evidence, interpretation, and limits.
- `CONTRIBUTING.md`: contributor and release workflow.

## Repository map

- `src/server.ts`: stdio MCP entry point and the two tool surfaces.
- `src/contract.ts`, `src/prompt.ts`, `src/worker.ts`: task schemas, worker brief, worker
  lifecycle, evidence reconciliation, and verdict construction.
- `src/batch.ts`, `src/worktree.ts`, `src/git.ts`, `src/overlap.ts`: sequential and
  parallel scheduling, worktree isolation, integration, and conflict detection.
- `src/command.ts`, `src/verify.ts`, `src/scope.ts`, `src/workspace.ts`: security-sensitive
  command and filesystem boundaries.
- `src/events.ts` and `src/cli/activity*.ts`: append-only activity events and their
  user-facing projection.
- `src/cli.ts` and `src/cli/`: setup, diagnostics, status, activity, and uninstall.
- `src/bench/`: benchmark harness, fixtures, graders, and reference solutions.
- `bench/results/`: committed raw benchmark records and generated per-run summaries.
- `.github/workflows/ci.yml`: deterministic cross-platform validation.
- `.github/workflows/publish.yml`: tag-only npm Trusted Publishing via OIDC.

More specific instructions apply in `src/`, `src/cli/`, `src/bench/`, and `bench/`.

## Development commands

Requires Node.js >=22.12. CI tests Node 24 and 26 on Windows, Ubuntu, and macOS.

```bash
npm ci                 # reproducible dependency install
npm run build          # compile src/ to ignored dist/
npm run typecheck      # strict TypeScript, no output
npm run format:check   # Prettier check
npm test               # build plus deterministic test suites
npm run smoke          # deterministic MCP protocol handshake
npm run verify         # typecheck, tests, and protocol smoke
npm run bench:validate # deterministic benchmark fixture validation
```

`smoke:cli`, `bench:report`, and `bench:analyze` are also deterministic and make no
model calls. `smoke:live`, `smoke:parallel`, `smoke:isolation`, and `bench` invoke real
Codex turns and may consume quota or incur billing; run them only when live validation
is necessary and authorized. CI additionally runs `npm run format:check`,
`bench:validate`, and `npm pack --dry-run` (on one matrix leg).

Choose verification proportionally. At minimum, run `npm run typecheck` and the tests
covering the changed area. Run `npm run verify` for broad runtime changes. Documentation-
only changes do not require model-backed smoke tests.

## Global implementation rules

- This is strict ESM TypeScript (`NodeNext`); source imports use `.js` extensions.
- Preserve `strict` and `noUncheckedIndexedAccess`. Do not loosen types or suppress
  errors to make a change pass.
- Keep pure policy/reduction logic separate from process and filesystem I/O where the
  existing design does so. Comments should explain non-obvious constraints or measured
  upstream behavior, not restate code.
- Treat task contracts, repository contents, paths, worker reports, and verification
  commands as untrusted. Operator-controlled environment/configuration is the policy
  boundary.
- File scopes are detective, not a write sandbox. Verification runs outside the Codex
  sandbox. Never describe either more strongly than `SECURITY.md` does.
- Preserve cross-platform behavior. Use argument arrays rather than shell command
  strings, resolve paths canonically, and account for Windows junctions/process cleanup
  and case-insensitive Windows/macOS matching.
- Do not edit generated `dist/`, dependencies in `node_modules/`, runtime logs/events,
  or `.sol-luna/` worktrees. Change source and regenerate only for local verification.
- Add regression tests for behavior changes. Changes to security-sensitive modules
  (`command.ts`, `scope.ts`, `verify.ts`, or `workspace.ts`) require a case in
  `src/security.test.ts` that fails without the fix.
- When user-visible setup, configuration, security, tool contracts, or review guidance
  changes, update the applicable authoritative docs and tests in the same change.

## Release discipline

Do not publish from a branch or pull request. Maintainers bump `package.json` and the
lockfile, update `CHANGELOG.md`, stage the release narrative in `RELEASE_NOTES.md`, wait
for green CI on `main`, then push an annotated `vX.Y.Z` tag. The publish workflow checks
that the tag matches `package.json` and publishes through OIDC. Do not add npm tokens or
publish secrets.
