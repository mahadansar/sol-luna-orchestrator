# Feature Acceptance Ledger

This is the authoritative current capability, evidence, freshness, and
confidence ledger for the repository. The current release baseline is `0.13.0`.
Release notes from this baseline forward belong in
[`CHANGELOG.md`](../CHANGELOG.md); future work belongs in
[`ROADMAP.md`](../ROADMAP.md).

## Current baseline

- **Runtime baseline:** v0.13.0, with package and lockfile versions set to
  `0.13.0`.
- **Release-source deterministic acceptance:** [CI run
  37210120543](https://github.com/mahadansar/sol-luna-orchestrator/actions/runs/37210120543)
  passed on 2026-10-04 at release commit `438cd37` across Windows, Ubuntu, and
  macOS on Node 24 and 26. All six jobs passed the release gate, including
  typecheck, formatting, the complete deterministic test suite, MCP protocol
  smoke, and the packaging check where applicable.
- **Worker model:** the 0.13.0 release defaults to `gpt-6-luna`. Explicit
  `LUNA_MODEL` pins remain supported, and opt-in `LUNA_MODEL=latest-luna`
  performs bounded compatible catalog selection once before tool admission and
  freezes the concrete model for that server process. The SDK and bundled Codex
  dependency are 0.160.0.
- **Publication:** v0.13.0 was published on 2026-10-04 from annotated tag
  `v0.13.0` at `438cd37`, after the release-source CI gate passed. [Publish
  run 37211401834, attempt
  2](https://github.com/mahadansar/sol-luna-orchestrator/actions/runs/37211401834/attempts/2)
  completed the tag-triggered OIDC workflow. npm reported version and latest tag
  `0.13.0`, the matching Git head, and provenance. The
  [GitHub Release](https://github.com/mahadansar/sol-luna-orchestrator/releases/tag/v0.13.0)
  was created afterward against the existing remote tag.
- **Release retry evidence:** the first publish attempt stopped during the
  prepublish verification rerun on one shared-checkout capability fixture. The
  isolated case and complete focused lifecycle suite passed, and an unchanged
  retry of the tagged workflow passed both full suites and publication. No
  source, test, tag, or gate was changed to obtain the successful retry.

Acceptance evidence below describes the released 0.13.0 behavior. Documentation
cleanup after release does not retroactively turn a historical run into evidence
for changed runtime code.

`main` may contain unreleased hardening after the `v0.13.0` tag. Those changes are
not promoted into the release-source deterministic or live-evidence columns
below until a future release candidate is validated on its own exact commit.
Local or focused post-release tests are development evidence only, not a
replacement for that release gate.

## Current capability matrix

| Capability                                              | Deterministic | Live evidence | Confidence    |
| ------------------------------------------------------- | ------------- | ------------- | ------------- |
| Zero-worker/adaptive delegation                         | PASS          | PASS          | Strong        |
| Pinned/default and optional automatic Luna selection    | DEEP PASS     | PASS          | Strong        |
| Single delegation                                       | PASS          | PASS          | Strong        |
| Sequential batches                                      | PASS          | PASS          | Strong        |
| Parallel batches                                        | DEEP PASS     | DEEP PASS     | Battle-tested |
| Worktree isolation and integration                      | DEEP PASS     | DEEP PASS     | Battle-tested |
| Bounded concurrency                                     | PASS          | DEEP PASS     | Battle-tested |
| Adaptive effort                                         | PASS          | PASS          | Strong        |
| Independent verification                                | PASS          | DEEP PASS     | Strong        |
| Claimed-versus-observed reconciliation                  | PASS          | DEEP PASS     | Strong        |
| Context Capsule v2                                      | PASS          | PASS          | Strong        |
| Compact evidence and thin verified handoff              | PASS          | DEEP PASS     | Strong        |
| CLI lifecycle                                           | PASS          | PASS          | Strong        |
| Activity, observability, and privacy                    | PASS          | DEEP PASS     | Strong        |
| Natural discovery                                       | PASS          | PASS          | Strong        |
| Explicit change intent                                  | PASS          | DEEP PASS     | Strong        |
| Worker continuation                                     | DEEP PASS     | DEEP PASS     | Battle-tested |
| Bounded repair                                          | PASS          | DEEP PASS     | Strong        |
| Bounded parallel automatic recovery                     | PASS          | PASS          | Strong        |
| Parent identity and post-hoc cost foundation            | PASS          | N/A           | Strong        |
| Per-execution failure and usage evidence                | DEEP PASS     | PARTIAL       | Strong        |
| Reasoned retry and effort-escalation decisions          | DEEP PASS     | NOT TESTED    | Strong        |
| User-owned compute policy and enforcement               | PASS          | NOT TESTED    | Strong        |
| Adaptive routing and compute selection                  | PASS          | NOT TESTED    | Strong        |
| Context lifecycle management                            | PASS          | NOT TESTED    | Strong        |
| Optional Explorer                                       | PASS          | NOT TESTED    | Strong        |
| Lightweight cross-session handoff                       | PASS          | NOT TESTED    | Strong        |
| End-to-end automated workflow                           | DEEP PASS     | NOT TESTED    | Basic         |
| `failureCauses` and verification contradiction handling | PASS          | PASS          | Strong        |

The deterministic column refers to the 0.13.0 release gate and focused
regressions for the named capability. Live status is deliberately narrower:
deterministic coverage is not promoted to live evidence merely because another
part of the product was exercised by a model.

## 0.13.0 live acceptance

Representative live acceptance was recorded on 2026-10-04 before release. The
Windows campaign used package 0.13.0, SDK/bundled Codex 0.160.0, Node 22.23.2,
and a repo-local registration pointing at the candidate's absolute
`dist/server.js`. Parent sessions requested GPT-6.1 Sol at Low effort;
successful delegated turns recorded GPT-6 Luna at parent-selected Medium effort.

The accepted live evidence includes:

- a single bounded delegation with a required edit, authoritative verification,
  trustworthy completion, unchanged test bytes, and independent parent review;
- a three-worker parallel batch with three integrated files, authoritative final
  checks, peak concurrency three, and no retained worktrees;
- automatic Luna selection followed by a retained-worktree continuation on the
  original model/thread, successful follow-up verification, replay refusal, and
  lease settlement;
- cooperative MCP cancellation producing a canonical cancelled attempt with
  unavailable usage recorded as unavailable rather than zero;
- activity watch recovery through rename/recreate rotation while task prompt
  text remained absent from the activity stream; and
- zero-worker routing on work that did not justify delegation.

The successful parallel and continuation runs each started exactly one
orchestrator server; worker processes did not recurse into orchestration.
Continuation evidence recorded matching thread identity and preserved the
selected model and effort.

The Windows native sandbox exposed a real environment boundary: child-spawning
`node --test` could fail with `spawn EPERM` even when direct assertion scripts
and authoritative verification outside that sandbox passed. The runtime kept
the conflicting worker claim visible and did not treat a broad
`environment-tooling` claim as trustworthy success. The final single-worker
acceptance used a direct assertion script so both worker-side execution and the
authoritative rerun passed.

Linux also has representative live delegation evidence, with an explicit
qualification: the accepted Ubuntu host required the documented
`LUNA_SANDBOX=danger-full-access` trusted-development workaround because host
AppArmor policy blocked nested `workspace-write` bwrap/user-namespace setup.
macOS has deterministic CI evidence but no current live delegation record.

## Platform evidence

| Platform       | Deterministic CI | Live delegation | Current qualification                                                   |
| -------------- | ---------------- | --------------- | ----------------------------------------------------------------------- |
| Windows 11     | Verified         | Verified        | Native test-runner child spawning can hit the documented `spawn EPERM`. |
| Linux / Ubuntu | Verified         | Verified        | Accepted live host used the documented trusted-development workaround.  |
| macOS          | Verified         | Not yet run     | Deterministic Git/filesystem/process paths execute in CI.               |

See [Configuration](CONFIGURATION.md#platform-support) for the support summary
and [Troubleshooting](TROUBLESHOOTING.md) for host-specific diagnosis.

## Current evidence gaps and non-claims

- There is no current broad model-backed OS matrix. macOS has no live delegation
  record, and the accepted Ubuntu host does not prove that nested
  `workspace-write` works on every Linux configuration.
- No fresh natural-routing case selected a sequential batch. Sequential
  execution itself has deterministic and live acceptance; the gap is natural
  route selection evidence.
- Natural adaptive-effort evidence covers `medium` and `high`. No natural
  `xhigh` or `max` selection is claimed.
- Retention modes, continuation expiry, verification refusal/timeout, deceptive
  worker claims, and several abnormal cleanup paths have broader deterministic
  than live coverage.
- Exact usage is unavailable when a started execution never emits Codex
  `turn.completed`. Timeout, cancellation, failed-turn, stream/runtime, and
  abnormal-exit paths therefore retain an explicit unavailable reason; the
  runtime does not infer missing usage.
- Native graceful-shutdown signal delivery during active model-backed work and a
  deliberately hung Windows descendant are not part of the representative live
  release campaign.
- The workflow coordinator has deterministic end-to-end composition through a
  real single-delegation handler. Several batch, repair, recovery, continuation,
  and escalation branches remain stronger at the handler-contract level than as
  one live composed workflow.
- No current performance, latency, price, or savings claim is made. The runtime's
  post-hoc cost primitive uses caller-supplied authoritative rate-card evidence;
  it performs no account lookup or price retrieval.

## Reading this ledger

Evidence status uses a small vocabulary:

- **N/A:** that evidence class does not apply.
- **NOT TESTED:** the capability exists, but no applicable live execution is
  established.
- **PARTIAL:** only part of the relevant surface has applicable evidence.
- **PASS:** the stated relevant path passed at the stated baseline.
- **DEEP PASS:** broad or repeated evidence also exercised important failure or
  integration boundaries.

Confidence is **Unverified**, **Basic**, **Strong**, or **Battle-tested**.
Coverage means an applicable test or artifact exists; execution means it
actually ran. Freshness is dependency-aware: an unrelated documentation change
does not stale runtime evidence, while a changed semantic seam requires fresh
evidence for that seam.
