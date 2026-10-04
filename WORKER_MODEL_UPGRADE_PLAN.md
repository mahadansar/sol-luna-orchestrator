# Worker model upgrade plan

Created: 2026-10-04

Branch: `feature/luna-model-upgrade-2026-10-04`

Base: `f3babea` on `main`, after merging the completed hardening branch.
Hardening runtime source `3224d4a` passed all six Windows/Ubuntu/macOS CI jobs
on Node 24 and 26; see [FEATURE_ACCEPTANCE.md](docs/FEATURE_ACCEPTANCE.md).
The existing stash is unrelated and must remain untouched.

Status: steps 1 and 2 implemented; full upgrade acceptance remains pending. This plan was first committed as `7a507bc` before
model implementation. The subsequent `main` ledger-wording fix `4a535f2` was
merged into this branch before the default-change commit.
The current implementation defaults to `gpt-6-luna`.

Step 1 validation: typecheck and build pass; 151 configuration/CLI/policy cases
passed, followed by all 44 guidance cases after correcting the ledger wording.
The single-delegation continuation-authority regression also passes with GPT-6
selected. These are deterministic tests with injected workers, not live GPT-6
inference evidence. Automatic discovery is implemented with 35 passing executable/catalog cases,
including selection, protocol bounds, startup cancellation, policy agreement,
session freezing, pinned-mode bypass, and offline configuration inspection.
The broader focused configuration/policy/guidance/capability gate passed all
214 cases before the additional execution/cleanup regressions. A continuation
fixture now proves a recorded future model (`gpt-7-luna`) reaches SDK thread
options, the result, and both attempt hooks unchanged. Offline CLI status/doctor
and descendant process-tree cancellation have dedicated regressions.
A real read-only Codex 0.147.0 catalog exchange completed but exposed only
GPT-5.6 Luna; automatic mode correctly refused to downgrade. It is not live
GPT-6 inference evidence. A temporary isolated SDK 0.160.0 probe then exposed
GPT-6 Luna with medium/high/xhigh/max and selected it successfully. This proved
a current compatibility blocker in the bundled catalog, so the package SDK and
lockfile were upgraded to 0.160.0 rather than leaving automatic mode unusable
with the installed dependency. SDK 0.160.0 also natively types `max`, so the old
unsafe widening cast was removed. Historical SDK-version fixtures remain intact.
After the dependency update, typecheck/build and all 168 catalog/configuration/
policy/guidance cases passed, followed by the exact-model continuation and
offline CLI regressions. A real MCP handshake using automatic mode advertised
GPT-6 Luna in server instructions and all three model-bearing tools, with no
unresolved selector. This was a catalog/protocol check with no inference turn.
Discovery starts no thread, so its recursion backstop
is the worker marker; worker execution retains both existing recursion guards.

## Authorized outcome

1. Change the normal worker default to the concrete model `gpt-6-luna`.
2. Preserve explicit operator-selected model IDs.
3. Add an optional automatic latest-available Luna mode. The default remains
   pinned; automatic upgrades require explicit operator opt-in.
4. Resolve automatic mode once before the MCP server admits work, freeze the
   concrete model for the server lifetime, and preserve that exact model in
   continuations, attempts, policies, and telemetry.
5. Keep documentation current in each implementation commit, including the
   limitations of model discovery and any untested live behavior.

No version bump, package publication, tag, release, or historical benchmark
rewrite is included in this work.

## Discovery and authority design

- Prefer the documented Codex app-server `model/list` protocol. Inspect the
  installed Codex/SDK implementation and exercise read-only catalog discovery
  before selecting the final integration details.
- Use a local operator selector such as `LUNA_MODEL=latest-luna`. This is a
  package-owned selector, not an upstream model alias. Never pass it to a worker
  or record it as the model actually used.
- Launch a trusted absolute executable; exclude repository-local executable
  lookup. Bound protocol startup, pagination, response size, and child cleanup.
  Discovery must not invoke an inference turn or expose credentials.
- Select only visible canonical numeric Luna-family model IDs. Compare versions
  numerically, exclude unrelated models and preview/date/custom aliases, and
  require support for every operator-permitted reasoning effort. Do not infer
  capabilities or model strength from catalog order or display names.
- Avoid silently downgrading below GPT-6 Luna. Discovery failure or absence of a
  compatible candidate must produce an actionable startup failure rather than
  silently falling back to a different model.
- Codex can return a cached or bundled catalog. Automatic mode selects the newest
  compatible Luna exposed by that catalog; it cannot guarantee global release
  freshness or account entitlement. Actual inference remains the access check.
  Updating Codex/catalog availability may be necessary for a future release,
  even when this package needs no model-name update.
- Keep offline `doctor` and configuration inspection free of catalog subprocesses
  and model calls. Show the requested automatic mode separately from the
  concrete model resolved by a running server.
- Establish the selected model and compute-policy baseline together before tool
  registration. Maintain operator model membership, explicit executor ordering,
  effort restrictions, and refusal of caller widening. Do not let configuration,
  policy, tool descriptions, or worker execution disagree.
- Continuations resume their recorded model and thread. Never rediscover or
  change their executor during a turn.

## Implementation sequence and commits

### 1. Pinned GPT-6 Luna default

Update `src/config.ts`, active configuration/guidance examples, CLI expectations,
and affected deterministic fixtures. Preserve explicit model overrides, effort
policy, recursion guards, and sandbox behavior. Record the change under
`CHANGELOG.md` `[Unreleased]` and update `docs/CONFIGURATION.md` in the same commit.
Run typecheck and the affected configuration/policy/CLI/guidance tests before
committing.

### 2. Optional automatic mode

Implement catalog selection and bounded protocol discovery, then wire one-time
server initialization into configuration and compute admission. Preserve import
side-effect rules: importing `server.ts` must not start the server or perform
catalog discovery. Add deterministic regressions for:

- numeric version ordering, capability filtering, hidden/unrelated/malformed
  entries, duplicate entries, and no compatible candidate;
- startup and response bounds, pagination, repeated cursors, malformed protocol,
  child spawn/exit failures, and cleanup;
- no discovery in pinned mode or offline CLI inspection;
- concrete model agreement across policy, workers, protocol descriptions,
  attempts, telemetry, and exact-model continuation;
- frozen session selection and unchanged explicit operator overrides.

Place regressions in an existing enumerated suite or update every required test
entry if a new test file is introduced. Keep security boundaries intact; changes
to `command.ts`, `scope.ts`, `verify.ts`, or `workspace.ts` require regression
coverage in `src/security.test.ts`.

### 3. Documentation reconciliation and acceptance

Audit all active Markdown, examples, settings, and model-bearing comments against
the final implementation. Update the canonical configuration, troubleshooting,
security, supervisor guidance, changelog, and acceptance records where behavior
changes. Update this plan with completed steps and exact verification evidence.

Do not replace model IDs in dated release notes, benchmark campaigns, rate-card
snapshots, or historical acceptance transcripts. Label historical evidence
clearly; do not invent GPT-6 costs or performance improvements.

Run the complete deterministic gate (`npm run verify` or its full CI equivalent),
format/link checks, and packaging validation. Any read-only real catalog check
must be labeled separately from deterministic tests. Do not claim live GPT-6
worker acceptance without an actual model-backed run.

## Full-gate corrections

The first complete upgrade gate at `7aed90d` exposed two runtime-default fixtures
that still expected/authorized GPT-5.6 despite the new default. Only those
fixtures now use the configured baseline; explicit legacy pins and historical
records remain unchanged. It also exposed a watcher fixture that used truncating
`writeFile(path)` to simulate an equal-size overwrite. A health poll could see
the legitimate intermediate empty file and recover by shrinking the cursor,
without the reattachment that this fixture asserted. The equal-size case now
writes through an `r+` handle without truncating, preserving the intended
regression seam. These are test corrections; the watcher runtime is unchanged.
All 66 exploration/session-handoff/activity-watch cases pass after those
corrections. Final review also removes the unused pre-startup MCP instance:
the server is constructed only after selection, before tools are registered.
The worker's unresolved-selector guard shares the canonical selector constant.
Full acceptance is pending the corrected source gate.

## Documentation audit findings

The committed hardening plan now names the completed merge and the separate
upgrade branch rather than describing model work as future work. The benchmark
results summary names the routing corrections as shipped in v0.12.0. Historical
campaign IDs, prices, model pins, and the content-addressed pre-results V3
methodology stay unchanged; the results document explains its preserved status
language. Direct live smoke helpers now resolve optional automatic mode before
worker execution and check the selected exact model. They were typechecked,
not run against a live model.

## Exit criteria

- The default worker is `gpt-6-luna`; explicit pins remain honored.
- Automatic mode is opt-in, bounded, fail-closed, frozen per server, and always
  resolves to a concrete compatible Luna model.
- Continuations and usage evidence retain exact executor identity.
- Offline CLI inspection remains offline and operator policy is never widened
  by a caller or a catalog response.
- Current docs agree with runtime/tests, historical evidence remains historical,
  and commits include focused regressions and relevant documentation.
- The final tree is committed and the complete deterministic acceptance evidence
  names its exact source checkpoint and platform skips.

## Primary references

- [GPT-6 Luna model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Codex app-server model catalog behavior](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Completed hardening plan](HARDENING_PLAN.md) and
  [independent branch audit](phase4-audit-report.md)

Model/protocol details must be checked against the installed implementation and
current primary documentation during implementation; these links do not certify
account access or a live worker run.
