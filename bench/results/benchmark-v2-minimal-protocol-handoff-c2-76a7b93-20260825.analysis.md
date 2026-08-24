# Benchmark results

Source: `combined Benchmark V2 JSON`

Schema: 4 | suite: v2-campaign | campaign: benchmark-v2-minimal-protocol-handoff-c2-76a7b93-20260825 | supervisor: `gpt-5.6-sol` / medium

Codex speed: standard (Fast mode disabled: yes; service tier: unavailable (not-exposed-by-codex-sdk); SDK pinning: unsupported; enforcement: operator-confirmed-pre-run).

Credit profile: `benchmark-v2-chatgpt-plus-codex-credits-2026-08-24` (snapshot 2026-08-24; [official rate card](https://help.openai.com/en/articles/20001106)).

## Primary comparison

| Task | Strategy | Pass | Credits | Basis | Time | Credit Δ | Time Δ | Trade-off | Delegated | Workers |
|---|---|---:|---:|---|---:|---:|---:|---|---:|---:|
| v2-config-overlay | solo-medium | 1/1 | 4.56 | rate-card | 65s | baseline | baseline | baseline | 0% | 0 |
| v2-config-overlay | adaptive-medium | 1/1 | 6.15 | rate-card | 99s | +35% | +52% | more expensive + slower / dominated | 0% | 0 |
| v2-data-contracts | solo-medium | 1/1 | 11.07 | rate-card | 182s | baseline | baseline | baseline | 0% | 0 |
| v2-data-contracts | adaptive-medium | 1/1 | 14.43 | rate-card | 290s | +30% | +59% | more expensive + slower / dominated | 100% | 3 |
| v2-integration-toolkit | solo-medium | 1/1 | 9.33 | rate-card | 137s | baseline | baseline | baseline | 0% | 0 |
| v2-integration-toolkit | adaptive-medium | 1/1 | 13.37 | rate-card | 334s | +43% | +144% | more expensive + slower / dominated | 100% | 4 |
| v2-integration-toolkit | forced-delegation | 1/1 | 8.3 | rate-card | 220s | -11% | +61% | cheaper + slower | 100% | 4 |

## Credits by run

| Task | Strategy | Rep | Actual | Rate-card total | Sol | Luna | Profile |
|---|---|---:|---:|---:|---:|---:|---|
| v2-config-overlay | solo-medium | 1 | unknown | 4.56 | 4.56 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-config-overlay | adaptive-medium | 1 | unknown | 6.15 | 6.15 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-integration-toolkit | solo-medium | 1 | unknown | 9.33 | 9.33 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-integration-toolkit | adaptive-medium | 1 | unknown | 13.37 | 11.89 | 1.48 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-data-contracts | solo-medium | 1 | unknown | 11.07 | 11.07 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-data-contracts | adaptive-medium | 1 | unknown | 14.43 | 13.27 | 1.16 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-integration-toolkit | forced-delegation | 1 | unknown | 8.3 | 6.89 | 1.41 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |

## Routing and stragglers

| Task | Strategy | Worker counts | Efforts | Peak concurrency | Slowest workers |
|---|---|---|---|---:|---|
| v2-config-overlay | solo-medium | 0 | - | unknown | unknown |
| v2-config-overlay | adaptive-medium | 0 | - | unknown | unknown |
| v2-data-contracts | solo-medium | 0 | - | unknown | unknown |
| v2-data-contracts | adaptive-medium | 3 | high, medium, high | 3 | 169.2s |
| v2-integration-toolkit | solo-medium | 0 | - | unknown | unknown |
| v2-integration-toolkit | adaptive-medium | 4 | medium, high, medium, high | 4 | 213.2s |
| v2-integration-toolkit | forced-delegation | 4 | medium, high, medium, high | 4 | 135s |

## Participant accounting by run

| Task | Strategy | Rep | Participant | Role | Model / effort | Input | Cached | Output | Reasoning | Cache write | Credits | Worker duration | End-to-end |
|---|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| v2-config-overlay | solo-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 99110 | 84736 | 2276 | 654 | unknown | 4.56 | unknown | - |
| v2-config-overlay | solo-medium | 1 | Sol total | total | - | - | - | - | - | - | 4.56 | - | - |
| v2-config-overlay | solo-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-config-overlay | solo-medium | 1 | Run total | total | - | - | - | - | - | - | 4.56 | - | 65s |
| v2-config-overlay | adaptive-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 147976 | 130304 | 3084 | 1248 | unknown | 6.15 | unknown | - |
| v2-config-overlay | adaptive-medium | 1 | Sol total | total | - | - | - | - | - | - | 6.15 | - | - |
| v2-config-overlay | adaptive-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-config-overlay | adaptive-medium | 1 | Run total | total | - | - | - | - | - | - | 6.15 | - | 99s |
| v2-integration-toolkit | solo-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 138784 | 107008 | 5367 | 1616 | unknown | 9.33 | unknown | - |
| v2-integration-toolkit | solo-medium | 1 | Sol total | total | - | - | - | - | - | - | 9.33 | - | - |
| v2-integration-toolkit | solo-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-integration-toolkit | solo-medium | 1 | Run total | total | - | - | - | - | - | - | 9.33 | - | 137s |
| v2-integration-toolkit | adaptive-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 354537 | 319232 | 4645 | 1306 | unknown | 11.89 | unknown | - |
| v2-integration-toolkit | adaptive-medium | 1 | Worker (task t3, thread 01a03609-37e1-73e1-9bcb-fbeb4da57bbc) | worker | gpt-5.6-luna / medium | 84483 | 62464 | 1274 | 402 | 0 | 0.18 | 43s | - |
| v2-integration-toolkit | adaptive-medium | 1 | Worker (task t1, thread 01a03609-37d2-7532-86e3-8166751c28af) | worker | gpt-5.6-luna / medium | 157683 | 132096 | 2367 | 982 | 0 | 0.26 | 70s | - |
| v2-integration-toolkit | adaptive-medium | 1 | Worker (task t4, thread 01a03609-388f-7811-a131-096d8630d9d3) | worker | gpt-5.6-luna / high | 205008 | 176640 | 3722 | 1606 | 0 | 0.34 | 97s | - |
| v2-integration-toolkit | adaptive-medium | 1 | Worker (task t2, thread 01a03609-3816-7283-8035-341ad7dfc1a0) | worker | gpt-5.6-luna / high | 371025 | 317184 | 9020 | 5047 | 0 | 0.7 | 213s | - |
| v2-integration-toolkit | adaptive-medium | 1 | Sol total | total | - | - | - | - | - | - | 11.89 | - | - |
| v2-integration-toolkit | adaptive-medium | 1 | Luna total | total | - | - | - | - | - | - | 1.48 | - | - |
| v2-integration-toolkit | adaptive-medium | 1 | Run total | total | - | - | - | - | - | - | 13.37 | - | 334s |
| v2-data-contracts | solo-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 242218 | 218624 | 7183 | 1706 | unknown | 11.07 | unknown | - |
| v2-data-contracts | solo-medium | 1 | Sol total | total | - | - | - | - | - | - | 11.07 | - | - |
| v2-data-contracts | solo-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-data-contracts | solo-medium | 1 | Run total | total | - | - | - | - | - | - | 11.07 | - | 182s |
| v2-data-contracts | adaptive-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 362833 | 316416 | 4679 | 1479 | unknown | 13.27 | unknown | - |
| v2-data-contracts | adaptive-medium | 1 | Worker (task t2, thread 01a03611-0110-7801-940b-0ba2f0a7f717) | worker | gpt-5.6-luna / medium | 127110 | 102912 | 2426 | 789 | 0 | 0.25 | 68s | - |
| v2-data-contracts | adaptive-medium | 1 | Worker (task t3, thread 01a03611-010c-7bb3-a619-a49ff425d2ab) | worker | gpt-5.6-luna / high | 214104 | 182784 | 5375 | 2594 | 0 | 0.41 | 130s | - |
| v2-data-contracts | adaptive-medium | 1 | Worker (task t1, thread 01a03611-0194-7672-9829-469be17635ac) | worker | gpt-5.6-luna / high | 248893 | 215552 | 7654 | 3267 | 0 | 0.5 | 169s | - |
| v2-data-contracts | adaptive-medium | 1 | Sol total | total | - | - | - | - | - | - | 13.27 | - | - |
| v2-data-contracts | adaptive-medium | 1 | Luna total | total | - | - | - | - | - | - | 1.16 | - | - |
| v2-data-contracts | adaptive-medium | 1 | Run total | total | - | - | - | - | - | - | 14.43 | - | 290s |
| v2-integration-toolkit | forced-delegation | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 178758 | 155648 | 2745 | 726 | unknown | 6.89 | unknown | - |
| v2-integration-toolkit | forced-delegation | 1 | Worker (task t3, thread 01a03615-8e74-7d30-ab27-6139ab931175) | worker | gpt-5.6-luna / medium | 150538 | 123136 | 1656 | 510 | 0 | 0.25 | 58s | - |
| v2-integration-toolkit | forced-delegation | 1 | Worker (task t1, thread 01a03615-8e48-78d1-930f-5b2c25f8aae8) | worker | gpt-5.6-luna / medium | 175092 | 130048 | 2396 | 843 | 0 | 0.36 | 77s | - |
| v2-integration-toolkit | forced-delegation | 1 | Worker (task t4, thread 01a03615-8f0b-74f2-86cf-288226ad9222) | worker | gpt-5.6-luna / high | 238109 | 201728 | 3429 | 1682 | 0 | 0.39 | 87s | - |
| v2-integration-toolkit | forced-delegation | 1 | Worker (task t2, thread 01a03615-8efc-79d3-945b-9a5cd4b59ac4) | worker | gpt-5.6-luna / high | 200325 | 169728 | 5867 | 3557 | 0 | 0.41 | 135s | - |
| v2-integration-toolkit | forced-delegation | 1 | Sol total | total | - | - | - | - | - | - | 6.89 | - | - |
| v2-integration-toolkit | forced-delegation | 1 | Luna total | total | - | - | - | - | - | - | 1.41 | - | - |
| v2-integration-toolkit | forced-delegation | 1 | Run total | total | - | - | - | - | - | - | 8.3 | - | 220s |

## Third-repetition recommendations

None under the predeclared rules.

## Measurement notes

- Correctness is determined after the model turn by deterministic grade commands, immutable-file checks, and mutation checks where applicable.
- `rateCardCredits` is calculated from the snapshotted official rate card. `actualCredits` remains null unless an authoritative per-run value becomes available.
- Codex SDK `inputTokens` includes cached input, so cached tokens are removed from the full-rate input portion and charged once at the cached-input rate. Cache writes are uncharged.
- Output tokens already include reasoning output; reasoning tokens are retained as diagnostics and are not charged twice.
- Wall-clock covers the full supervisor turn, including delegation setup, workers, integration, review, and verification.
- Participant worker durations remain individual execution times. They are never summed or substituted for end-to-end wall-clock; supervisor participant duration stays unavailable because the harness does not observe a single authoritative supervisor-only duration.
- Raw tokens, worker effort, concurrency, duration, and straggler fields are supporting diagnostics rather than the headline economic metric.
- Two repetitions are directional evidence. A third is recommended only for the conditions listed above; no statistical significance is claimed.
