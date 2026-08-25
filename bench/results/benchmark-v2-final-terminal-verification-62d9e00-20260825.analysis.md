# Benchmark results

Source: `combined Benchmark V2 JSON`

Schema: 4 | suite: v2-campaign | campaign: benchmark-v2-final-terminal-verification-62d9e00-20260825 | supervisor: `gpt-5.6-sol` / medium

Codex speed: standard (Fast mode disabled: yes; service tier: unavailable (not-exposed-by-codex-sdk); SDK pinning: unsupported; enforcement: operator-confirmed-pre-run).

Credit profile: `benchmark-v2-chatgpt-plus-codex-credits-2026-08-24` (snapshot 2026-08-24; [official rate card](https://help.openai.com/en/articles/20001106)).

## Primary comparison

| Task | Strategy | Pass | Credits | Basis | Time | Credit Δ | Time Δ | Trade-off | Delegated | Workers |
|---|---|---:|---:|---|---:|---:|---:|---|---:|---:|
| v2-checkout-engine | solo-medium | 2/2 | 6.85 | rate-card | 110.5s | baseline | baseline | baseline | 0% | 0 |
| v2-checkout-engine | adaptive-medium | 2/2 | 9.62 | rate-card | 206s | +40% | +86% | more expensive + slower / dominated | 100% | 1 |
| v2-config-overlay | solo-medium | 3/3 | 6.78 | rate-card | 108s | baseline | baseline | baseline | 0% | 0 |
| v2-config-overlay | adaptive-medium | 3/3 | 7.68 | rate-card | 107s | +13% | -1% | more expensive + faster | 0% | 0 |
| v2-data-contracts | solo-medium | 2/2 | 9.33 | rate-card | 159s | baseline | baseline | baseline | 0% | 0 |
| v2-data-contracts | adaptive-medium | 3/3 | unknown | unknown | 287s | unknown | +81% | unknown | 100% | 3 |
| v2-data-contracts | forced-delegation | 3/3 | 9.21 | rate-card | 238s | -1% | +50% | cheaper + slower | 100% | 3 |
| v2-frontmatter-parser | solo-medium | 2/2 | 8.47 | rate-card | 125s | baseline | baseline | baseline | 0% | 0 |
| v2-frontmatter-parser | adaptive-medium | 3/3 | 8.64 | rate-card | 134s | +2% | +7% | more expensive + slower / dominated | 0% | 0 |
| v2-frontmatter-parser | forced-delegation | 2/2 | 5.28 | rate-card | 205.5s | -38% | +64% | cheaper + slower | 100% | 1 |
| v2-integration-toolkit | solo-medium | 2/2 | 7.7 | rate-card | 110s | baseline | baseline | baseline | 0% | 0 |
| v2-integration-toolkit | adaptive-medium | 3/3 | 6.69 | rate-card | 155s | -13% | +41% | cheaper + slower | 100% | 4 |
| v2-integration-toolkit | forced-delegation | 2/2 | 10.15 | rate-card | 200.5s | +32% | +82% | more expensive + slower / dominated | 100% | 4 |
| v2-rate-limiter-tests | solo-medium | 2/2 | 5.05 | rate-card | 61.5s | baseline | baseline | baseline | 0% | 0 |
| v2-rate-limiter-tests | adaptive-medium | 3/3 | 4.72 | rate-card | 61s | -6% | -1% | cheaper + faster | 0% | 0 |
| v2-repository-tools | solo-medium | 2/2 | 7.97 | rate-card | 130.5s | baseline | baseline | baseline | 0% | 0 |
| v2-repository-tools | adaptive-medium | 2/2 | 6.26 | rate-card | 148.5s | -21% | +14% | cheaper + slower | 100% | 3 |
| v2-repository-tools | forced-delegation | 2/2 | 9.1 | rate-card | 195.5s | +14% | +50% | more expensive + slower / dominated | 100% | 3 |
| v2-worker-pool | solo-medium | 2/2 | 4.54 | rate-card | 51s | baseline | baseline | baseline | 0% | 0 |
| v2-worker-pool | adaptive-medium | 3/3 | 4.61 | rate-card | 59s | +1% | +16% | more expensive + slower / dominated | 0% | 0 |

## Credits by run

| Task | Strategy | Rep | Actual | Rate-card total | Sol | Luna | Profile |
|---|---|---:|---:|---:|---:|---:|---|
| v2-config-overlay | solo-medium | 1 | unknown | 7.17 | 7.17 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-config-overlay | adaptive-medium | 1 | unknown | 6.37 | 6.37 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-rate-limiter-tests | solo-medium | 1 | unknown | 4.95 | 4.95 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-rate-limiter-tests | adaptive-medium | 1 | unknown | 4.72 | 4.72 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-frontmatter-parser | solo-medium | 1 | unknown | 9.08 | 9.08 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-frontmatter-parser | adaptive-medium | 1 | unknown | 9.29 | 9.29 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-worker-pool | solo-medium | 1 | unknown | 5.08 | 5.08 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-worker-pool | adaptive-medium | 1 | unknown | 3.93 | 3.93 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-integration-toolkit | solo-medium | 1 | unknown | 7.95 | 7.95 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-integration-toolkit | adaptive-medium | 1 | unknown | 4.69 | 3.79 | 0.9 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-data-contracts | solo-medium | 1 | unknown | 9.14 | 9.14 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-data-contracts | adaptive-medium | 1 | unknown | 13.37 | 12.18 | 1.19 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-repository-tools | solo-medium | 1 | unknown | 7 | 7 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-repository-tools | adaptive-medium | 1 | unknown | 6.9 | 6.07 | 0.82 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-checkout-engine | solo-medium | 1 | unknown | 6.47 | 6.47 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-checkout-engine | adaptive-medium | 1 | unknown | 9.35 | 8.9 | 0.45 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-config-overlay | solo-medium | 2 | unknown | 6.31 | 6.31 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-config-overlay | adaptive-medium | 2 | unknown | 8.15 | 8.15 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-rate-limiter-tests | solo-medium | 2 | unknown | 5.15 | 5.15 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-rate-limiter-tests | adaptive-medium | 2 | unknown | 5.4 | 5.4 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-frontmatter-parser | solo-medium | 2 | unknown | 7.86 | 7.86 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-frontmatter-parser | adaptive-medium | 2 | unknown | 7.28 | 7.28 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-worker-pool | solo-medium | 2 | unknown | 4 | 4 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-worker-pool | adaptive-medium | 2 | unknown | 4.61 | 4.61 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-integration-toolkit | solo-medium | 2 | unknown | 7.44 | 7.44 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-integration-toolkit | adaptive-medium | 2 | unknown | 6.69 | 5.47 | 1.21 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-data-contracts | solo-medium | 2 | unknown | 9.52 | 9.52 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-data-contracts | adaptive-medium | 2 | unknown | unknown | 10.55 | unknown | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-repository-tools | solo-medium | 2 | unknown | 8.93 | 8.93 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-repository-tools | adaptive-medium | 2 | unknown | 5.61 | 4.73 | 0.88 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-checkout-engine | solo-medium | 2 | unknown | 7.23 | 7.23 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-checkout-engine | adaptive-medium | 2 | unknown | 9.89 | 9.4 | 0.49 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-frontmatter-parser | forced-delegation | 1 | unknown | 5.13 | 4.77 | 0.36 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-integration-toolkit | forced-delegation | 1 | unknown | 10.38 | 9.28 | 1.1 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-data-contracts | forced-delegation | 1 | unknown | 8.35 | 7.26 | 1.09 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-repository-tools | forced-delegation | 1 | unknown | 8.47 | 7.5 | 0.97 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-frontmatter-parser | forced-delegation | 2 | unknown | 5.43 | 4.85 | 0.58 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-integration-toolkit | forced-delegation | 2 | unknown | 9.92 | 8.79 | 1.13 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-data-contracts | forced-delegation | 2 | unknown | 11.31 | 10.38 | 0.93 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-repository-tools | forced-delegation | 2 | unknown | 9.73 | 8.75 | 0.97 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-config-overlay | solo-medium | 3 | unknown | 6.78 | 6.78 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-config-overlay | adaptive-medium | 3 | unknown | 7.68 | 7.68 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-rate-limiter-tests | adaptive-medium | 3 | unknown | 4.46 | 4.46 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-frontmatter-parser | adaptive-medium | 3 | unknown | 8.64 | 8.64 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-worker-pool | adaptive-medium | 3 | unknown | 4.72 | 4.72 | 0 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-integration-toolkit | adaptive-medium | 3 | unknown | 8.94 | 7.96 | 0.99 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-data-contracts | adaptive-medium | 3 | unknown | 7.66 | 6.56 | 1.09 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |
| v2-data-contracts | forced-delegation | 3 | unknown | 9.21 | 8.06 | 1.15 | benchmark-v2-chatgpt-plus-codex-credits-2026-08-24 |

## Routing and stragglers

| Task | Strategy | Worker counts | Efforts | Peak concurrency | Slowest workers |
|---|---|---|---|---:|---|
| v2-checkout-engine | solo-medium | 0, 0 | - | unknown | unknown, unknown |
| v2-checkout-engine | adaptive-medium | 1, 1 | high, high | 1 | 157.3s, 168s |
| v2-config-overlay | solo-medium | 0, 0, 0 | - | unknown | unknown, unknown, unknown |
| v2-config-overlay | adaptive-medium | 0, 0, 0 | - | unknown | unknown, unknown, unknown |
| v2-data-contracts | solo-medium | 0, 0 | - | unknown | unknown, unknown |
| v2-data-contracts | adaptive-medium | 3, 4, 3 | high, medium, medium, high, medium, high, high, medium, high | 3 | 236.4s, 300.3s, 187.8s |
| v2-data-contracts | forced-delegation | 3, 3, 3 | high, medium, high, high, medium, high, high, medium, high | 3 | 189.3s, 108.2s, 150.7s |
| v2-frontmatter-parser | solo-medium | 0, 0 | - | unknown | unknown, unknown |
| v2-frontmatter-parser | adaptive-medium | 0, 0, 0 | - | unknown | unknown, unknown, unknown |
| v2-frontmatter-parser | forced-delegation | 1, 1 | high, high | 1 | 139.2s, 188.6s |
| v2-integration-toolkit | solo-medium | 0, 0 | - | unknown | unknown, unknown |
| v2-integration-toolkit | adaptive-medium | 4, 4, 4 | medium, medium, medium, medium, medium, high, medium, medium, medium, medium, medium, medium | 4 | 82.5s, 124.7s, 87.7s |
| v2-integration-toolkit | forced-delegation | 4, 4 | medium, high, medium, medium, medium, high, medium, high | 4 | 121.1s, 133.9s |
| v2-rate-limiter-tests | solo-medium | 0, 0 | - | unknown | unknown, unknown |
| v2-rate-limiter-tests | adaptive-medium | 0, 0, 0 | - | unknown | unknown, unknown, unknown |
| v2-repository-tools | solo-medium | 0, 0 | - | unknown | unknown, unknown |
| v2-repository-tools | adaptive-medium | 3, 3 | medium, medium, medium, medium, medium, medium | 3 | 94.5s, 102.3s |
| v2-repository-tools | forced-delegation | 3, 3 | medium, high, medium, medium, high, high | 3 | 124.2s, 123.9s |
| v2-worker-pool | solo-medium | 0, 0 | - | unknown | unknown, unknown |
| v2-worker-pool | adaptive-medium | 0, 0, 0 | - | unknown | unknown, unknown, unknown |

## Participant accounting by run

| Task | Strategy | Rep | Participant | Role | Model / effort | Input | Cached | Output | Reasoning | Cache write | Credits | Worker duration | End-to-end |
|---|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| v2-config-overlay | solo-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 114497 | 87552 | 3612 | 1507 | unknown | 7.17 | unknown | - |
| v2-config-overlay | solo-medium | 1 | Sol total | total | - | - | - | - | - | - | 7.17 | - | - |
| v2-config-overlay | solo-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-config-overlay | solo-medium | 1 | Run total | total | - | - | - | - | - | - | 7.17 | - | 408s |
| v2-config-overlay | adaptive-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 119463 | 98816 | 3407 | 1560 | unknown | 6.37 | unknown | - |
| v2-config-overlay | adaptive-medium | 1 | Sol total | total | - | - | - | - | - | - | 6.37 | - | - |
| v2-config-overlay | adaptive-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-config-overlay | adaptive-medium | 1 | Run total | total | - | - | - | - | - | - | 6.37 | - | 105s |
| v2-rate-limiter-tests | solo-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 91014 | 69376 | 1835 | 275 | unknown | 4.95 | unknown | - |
| v2-rate-limiter-tests | solo-medium | 1 | Sol total | total | - | - | - | - | - | - | 4.95 | - | - |
| v2-rate-limiter-tests | solo-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-rate-limiter-tests | solo-medium | 1 | Run total | total | - | - | - | - | - | - | 4.95 | - | 60s |
| v2-rate-limiter-tests | adaptive-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 115679 | 97792 | 1686 | 238 | unknown | 4.72 | unknown | - |
| v2-rate-limiter-tests | adaptive-medium | 1 | Sol total | total | - | - | - | - | - | - | 4.72 | - | - |
| v2-rate-limiter-tests | adaptive-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-rate-limiter-tests | adaptive-medium | 1 | Run total | total | - | - | - | - | - | - | 4.72 | - | 54s |
| v2-frontmatter-parser | solo-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 180129 | 150272 | 4626 | 1023 | unknown | 9.08 | unknown | - |
| v2-frontmatter-parser | solo-medium | 1 | Sol total | total | - | - | - | - | - | - | 9.08 | - | - |
| v2-frontmatter-parser | solo-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-frontmatter-parser | solo-medium | 1 | Run total | total | - | - | - | - | - | - | 9.08 | - | 124s |
| v2-frontmatter-parser | adaptive-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 197084 | 173824 | 5613 | 1913 | unknown | 9.29 | unknown | - |
| v2-frontmatter-parser | adaptive-medium | 1 | Sol total | total | - | - | - | - | - | - | 9.29 | - | - |
| v2-frontmatter-parser | adaptive-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-frontmatter-parser | adaptive-medium | 1 | Run total | total | - | - | - | - | - | - | 9.29 | - | 134s |
| v2-worker-pool | solo-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 108577 | 84480 | 1348 | 402 | unknown | 5.08 | unknown | - |
| v2-worker-pool | solo-medium | 1 | Sol total | total | - | - | - | - | - | - | 5.08 | - | - |
| v2-worker-pool | solo-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-worker-pool | solo-medium | 1 | Run total | total | - | - | - | - | - | - | 5.08 | - | 50s |
| v2-worker-pool | adaptive-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 112713 | 99840 | 1426 | 457 | unknown | 3.93 | unknown | - |
| v2-worker-pool | adaptive-medium | 1 | Sol total | total | - | - | - | - | - | - | 3.93 | - | - |
| v2-worker-pool | adaptive-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-worker-pool | adaptive-medium | 1 | Run total | total | - | - | - | - | - | - | 3.93 | - | 59s |
| v2-integration-toolkit | solo-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 144988 | 115968 | 3829 | 725 | unknown | 7.95 | unknown | - |
| v2-integration-toolkit | solo-medium | 1 | Sol total | total | - | - | - | - | - | - | 7.95 | - | - |
| v2-integration-toolkit | solo-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-integration-toolkit | solo-medium | 1 | Run total | total | - | - | - | - | - | - | 7.95 | - | 106s |
| v2-integration-toolkit | adaptive-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 111482 | 99840 | 1454 | 179 | unknown | 3.79 | unknown | - |
| v2-integration-toolkit | adaptive-medium | 1 | Worker (task t3, thread 01a03705-9767-7ae1-89c4-2950962f9c2c) | worker | gpt-5.6-luna / medium | 108444 | 96768 | 1493 | 370 | 0 | 0.15 | 51s | - |
| v2-integration-toolkit | adaptive-medium | 1 | Worker (task t4, thread 01a03705-9806-7a40-9e94-bc0a71e5d673) | worker | gpt-5.6-luna / medium | 137927 | 113920 | 2239 | 632 | 0 | 0.24 | 71s | - |
| v2-integration-toolkit | adaptive-medium | 1 | Worker (task t2, thread 01a03705-9791-7073-9f50-e1d8bc4ba4a5) | worker | gpt-5.6-luna / medium | 145327 | 120064 | 2553 | 852 | 0 | 0.26 | 77s | - |
| v2-integration-toolkit | adaptive-medium | 1 | Worker (task t1, thread 01a03705-975a-7042-bf2f-769b0ff12d7f) | worker | gpt-5.6-luna / medium | 143289 | 118016 | 1744 | 615 | 0 | 0.24 | 82s | - |
| v2-integration-toolkit | adaptive-medium | 1 | Sol total | total | - | - | - | - | - | - | 3.79 | - | - |
| v2-integration-toolkit | adaptive-medium | 1 | Luna total | total | - | - | - | - | - | - | 0.9 | - | - |
| v2-integration-toolkit | adaptive-medium | 1 | Run total | total | - | - | - | - | - | - | 4.69 | - | 130s |
| v2-data-contracts | solo-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 172502 | 151552 | 6173 | 1044 | unknown | 9.14 | unknown | - |
| v2-data-contracts | solo-medium | 1 | Sol total | total | - | - | - | - | - | - | 9.14 | - | - |
| v2-data-contracts | solo-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-data-contracts | solo-medium | 1 | Run total | total | - | - | - | - | - | - | 9.14 | - | 152s |
| v2-data-contracts | adaptive-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 502365 | 465920 | 2399 | 248 | unknown | 12.18 | unknown | - |
| v2-data-contracts | adaptive-medium | 1 | Worker (task t2, thread 01a03709-f7ff-7f62-97d8-76c354dea552) | worker | gpt-5.6-luna / medium | 119513 | 96768 | 1821 | 547 | 0 | 0.22 | 59s | - |
| v2-data-contracts | adaptive-medium | 1 | Worker (task t3, thread 01a03709-f81b-7fa0-9609-c12e83ddc3ad) | worker | gpt-5.6-luna / medium | 143332 | 120064 | 2962 | 1017 | 0 | 0.27 | 76s | - |
| v2-data-contracts | adaptive-medium | 1 | Worker (task t1, thread 01a0370a-00d6-7921-9c73-c1fdf698777a) | worker | gpt-5.6-luna / high | 277387 | 222720 | 10834 | 6003 | 0 | 0.71 | 236s | - |
| v2-data-contracts | adaptive-medium | 1 | Sol total | total | - | - | - | - | - | - | 12.18 | - | - |
| v2-data-contracts | adaptive-medium | 1 | Luna total | total | - | - | - | - | - | - | 1.19 | - | - |
| v2-data-contracts | adaptive-medium | 1 | Run total | total | - | - | - | - | - | - | 13.37 | - | 287s |
| v2-repository-tools | solo-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 133108 | 116992 | 4698 | 1601 | unknown | 7 | unknown | - |
| v2-repository-tools | solo-medium | 1 | Sol total | total | - | - | - | - | - | - | 7 | - | - |
| v2-repository-tools | solo-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-repository-tools | solo-medium | 1 | Run total | total | - | - | - | - | - | - | 7 | - | 119s |
| v2-repository-tools | adaptive-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 136635 | 109824 | 1801 | 279 | unknown | 6.07 | unknown | - |
| v2-repository-tools | adaptive-medium | 1 | Worker (task t3, thread 01a03710-2b57-7240-b454-2d956d5a91e6) | worker | gpt-5.6-luna / medium | 102291 | 80640 | 2651 | 956 | 0 | 0.23 | 70s | - |
| v2-repository-tools | adaptive-medium | 1 | Worker (task t2, thread 01a03710-2aab-7b02-8d21-1526e8bfcc18) | worker | gpt-5.6-luna / medium | 124114 | 99840 | 3036 | 1862 | 0 | 0.26 | 83s | - |
| v2-repository-tools | adaptive-medium | 1 | Worker (task t1, thread 01a03710-2af7-7d50-8690-dad91ffe7a93) | worker | gpt-5.6-luna / medium | 202298 | 172800 | 3305 | 1255 | 0 | 0.33 | 94s | - |
| v2-repository-tools | adaptive-medium | 1 | Sol total | total | - | - | - | - | - | - | 6.07 | - | - |
| v2-repository-tools | adaptive-medium | 1 | Luna total | total | - | - | - | - | - | - | 0.82 | - | - |
| v2-repository-tools | adaptive-medium | 1 | Run total | total | - | - | - | - | - | - | 6.9 | - | 144s |
| v2-checkout-engine | solo-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 116165 | 98816 | 4087 | 1116 | unknown | 6.47 | unknown | - |
| v2-checkout-engine | solo-medium | 1 | Sol total | total | - | - | - | - | - | - | 6.47 | - | - |
| v2-checkout-engine | solo-medium | 1 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-checkout-engine | solo-medium | 1 | Run total | total | - | - | - | - | - | - | 6.47 | - | 108s |
| v2-checkout-engine | adaptive-medium | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 259295 | 219648 | 1596 | 329 | unknown | 8.9 | unknown | - |
| v2-checkout-engine | adaptive-medium | 1 | Worker (task t1, thread 01a03713-e382-7020-8b0a-1c665857b5f6) | worker | gpt-5.6-luna / high | 222514 | 190976 | 6612 | 3451 | 0 | 0.45 | 157s | - |
| v2-checkout-engine | adaptive-medium | 1 | Sol total | total | - | - | - | - | - | - | 8.9 | - | - |
| v2-checkout-engine | adaptive-medium | 1 | Luna total | total | - | - | - | - | - | - | 0.45 | - | - |
| v2-checkout-engine | adaptive-medium | 1 | Run total | total | - | - | - | - | - | - | 9.35 | - | 199s |
| v2-config-overlay | solo-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 113775 | 90624 | 3038 | 1276 | unknown | 6.31 | unknown | - |
| v2-config-overlay | solo-medium | 2 | Sol total | total | - | - | - | - | - | - | 6.31 | - | - |
| v2-config-overlay | solo-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-config-overlay | solo-medium | 2 | Run total | total | - | - | - | - | - | - | 6.31 | - | 84s |
| v2-config-overlay | adaptive-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 216989 | 193280 | 3700 | 1183 | unknown | 8.15 | unknown | - |
| v2-config-overlay | adaptive-medium | 2 | Sol total | total | - | - | - | - | - | - | 8.15 | - | - |
| v2-config-overlay | adaptive-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-config-overlay | adaptive-medium | 2 | Run total | total | - | - | - | - | - | - | 8.15 | - | 107s |
| v2-rate-limiter-tests | solo-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 89000 | 66304 | 1983 | 262 | unknown | 5.15 | unknown | - |
| v2-rate-limiter-tests | solo-medium | 2 | Sol total | total | - | - | - | - | - | - | 5.15 | - | - |
| v2-rate-limiter-tests | solo-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-rate-limiter-tests | solo-medium | 2 | Run total | total | - | - | - | - | - | - | 5.15 | - | 63s |
| v2-rate-limiter-tests | adaptive-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 115535 | 93696 | 2000 | 231 | unknown | 5.4 | unknown | - |
| v2-rate-limiter-tests | adaptive-medium | 2 | Sol total | total | - | - | - | - | - | - | 5.4 | - | - |
| v2-rate-limiter-tests | adaptive-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-rate-limiter-tests | adaptive-medium | 2 | Run total | total | - | - | - | - | - | - | 5.4 | - | 61s |
| v2-frontmatter-parser | solo-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 154174 | 130048 | 4298 | 1450 | unknown | 7.86 | unknown | - |
| v2-frontmatter-parser | solo-medium | 2 | Sol total | total | - | - | - | - | - | - | 7.86 | - | - |
| v2-frontmatter-parser | solo-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-frontmatter-parser | solo-medium | 2 | Run total | total | - | - | - | - | - | - | 7.86 | - | 126s |
| v2-frontmatter-parser | adaptive-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 170876 | 150528 | 3813 | 1081 | unknown | 7.28 | unknown | - |
| v2-frontmatter-parser | adaptive-medium | 2 | Sol total | total | - | - | - | - | - | - | 7.28 | - | - |
| v2-frontmatter-parser | adaptive-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-frontmatter-parser | adaptive-medium | 2 | Run total | total | - | - | - | - | - | - | 7.28 | - | 106s |
| v2-worker-pool | solo-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 123330 | 110848 | 1405 | 470 | unknown | 4 | unknown | - |
| v2-worker-pool | solo-medium | 2 | Sol total | total | - | - | - | - | - | - | 4 | - | - |
| v2-worker-pool | solo-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-worker-pool | solo-medium | 2 | Run total | total | - | - | - | - | - | - | 4 | - | 52s |
| v2-worker-pool | adaptive-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 134742 | 118016 | 1388 | 378 | unknown | 4.61 | unknown | - |
| v2-worker-pool | adaptive-medium | 2 | Sol total | total | - | - | - | - | - | - | 4.61 | - | - |
| v2-worker-pool | adaptive-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-worker-pool | adaptive-medium | 2 | Run total | total | - | - | - | - | - | - | 4.61 | - | 59s |
| v2-integration-toolkit | solo-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 149204 | 129280 | 4448 | 1300 | unknown | 7.44 | unknown | - |
| v2-integration-toolkit | solo-medium | 2 | Sol total | total | - | - | - | - | - | - | 7.44 | - | - |
| v2-integration-toolkit | solo-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-integration-toolkit | solo-medium | 2 | Run total | total | - | - | - | - | - | - | 7.44 | - | 114s |
| v2-integration-toolkit | adaptive-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 191607 | 176640 | 1861 | 319 | unknown | 5.47 | unknown | - |
| v2-integration-toolkit | adaptive-medium | 2 | Worker (task t1, thread 01a03722-d7ae-7ef0-b70f-0b74b6851204) | worker | gpt-5.6-luna / medium | 140314 | 98816 | 1897 | 670 | 0 | 0.31 | 65s | - |
| v2-integration-toolkit | adaptive-medium | 2 | Worker (task t3, thread 01a03722-cf85-7251-88a8-5e9c90763b48) | worker | gpt-5.6-luna / medium | 119868 | 95744 | 2146 | 972 | 0 | 0.23 | 73s | - |
| v2-integration-toolkit | adaptive-medium | 2 | Worker (task t4, thread 01a03722-d07f-7d01-845f-83671f868533) | worker | gpt-5.6-luna / medium | 144421 | 104960 | 2806 | 981 | 0 | 0.33 | 83s | - |
| v2-integration-toolkit | adaptive-medium | 2 | Worker (task t2, thread 01a03722-cf5c-7ba1-a5fc-73411fe623d5) | worker | gpt-5.6-luna / high | 128117 | 101888 | 4975 | 2922 | 0 | 0.33 | 125s | - |
| v2-integration-toolkit | adaptive-medium | 2 | Sol total | total | - | - | - | - | - | - | 5.47 | - | - |
| v2-integration-toolkit | adaptive-medium | 2 | Luna total | total | - | - | - | - | - | - | 1.21 | - | - |
| v2-integration-toolkit | adaptive-medium | 2 | Run total | total | - | - | - | - | - | - | 6.69 | - | 172s |
| v2-data-contracts | solo-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 173948 | 152576 | 6584 | 1747 | unknown | 9.52 | unknown | - |
| v2-data-contracts | solo-medium | 2 | Sol total | total | - | - | - | - | - | - | 9.52 | - | - |
| v2-data-contracts | solo-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-data-contracts | solo-medium | 2 | Run total | total | - | - | - | - | - | - | 9.52 | - | 166s |
| v2-data-contracts | adaptive-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 375911 | 339456 | 2335 | 258 | unknown | 10.55 | unknown | - |
| v2-data-contracts | adaptive-medium | 2 | Worker (task t3, thread 01a03728-119c-7d91-8f28-af6ea216b338) | worker | gpt-5.6-luna / high | 256817 | 223488 | 5735 | 2813 | 0 | 0.45 | 143s | - |
| v2-data-contracts | adaptive-medium | 2 | Worker (task t1, thread 01a03728-116b-7122-90c6-17a5ee3d4612) | worker | gpt-5.6-luna / high | 430620 | 384768 | 9217 | 4654 | 0 | 0.7 | 222s | - |
| v2-data-contracts | adaptive-medium | 2 | Worker (task t2, thread 01a03728-11c2-7573-8997-070570c0846e) | worker | gpt-5.6-luna / medium | unknown | unknown | unknown | unknown | unknown | unknown | 300s | - |
| v2-data-contracts | adaptive-medium | 2 | Worker (task t2, thread 01a03728-11c2-7573-8997-070570c0846e) | worker | gpt-5.6-luna / medium | 249718 | 201984 | 4402 | 1720 | 0 | 0.47 | 120s | - |
| v2-data-contracts | adaptive-medium | 2 | Sol total | total | - | - | - | - | - | - | 10.55 | - | - |
| v2-data-contracts | adaptive-medium | 2 | Luna total | total | - | - | - | - | - | - | unknown | - | - |
| v2-data-contracts | adaptive-medium | 2 | Run total | total | - | - | - | - | - | - | unknown | - | 475s |
| v2-repository-tools | solo-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 157909 | 131072 | 5250 | 2278 | unknown | 8.93 | unknown | - |
| v2-repository-tools | solo-medium | 2 | Sol total | total | - | - | - | - | - | - | 8.93 | - | - |
| v2-repository-tools | solo-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-repository-tools | solo-medium | 2 | Run total | total | - | - | - | - | - | - | 8.93 | - | 142s |
| v2-repository-tools | adaptive-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 136238 | 121088 | 1768 | 193 | unknown | 4.73 | unknown | - |
| v2-repository-tools | adaptive-medium | 2 | Worker (task t3, thread 01a03731-7a28-7b31-88e6-e43024e6aa16) | worker | gpt-5.6-luna / medium | 154310 | 127232 | 2502 | 928 | 0 | 0.27 | 71s | - |
| v2-repository-tools | adaptive-medium | 2 | Worker (task t1, thread 01a03731-7a1c-7bb0-b7f0-f75607e2ac1d) | worker | gpt-5.6-luna / medium | 160836 | 137216 | 3089 | 1199 | 0 | 0.28 | 90s | - |
| v2-repository-tools | adaptive-medium | 2 | Worker (task t2, thread 01a03731-79b9-7ad1-80d2-08f9e103bf95) | worker | gpt-5.6-luna / medium | 193758 | 165632 | 3396 | 1756 | 0 | 0.33 | 102s | - |
| v2-repository-tools | adaptive-medium | 2 | Sol total | total | - | - | - | - | - | - | 4.73 | - | - |
| v2-repository-tools | adaptive-medium | 2 | Luna total | total | - | - | - | - | - | - | 0.88 | - | - |
| v2-repository-tools | adaptive-medium | 2 | Run total | total | - | - | - | - | - | - | 5.61 | - | 153s |
| v2-checkout-engine | solo-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 147169 | 129280 | 4507 | 1071 | unknown | 7.23 | unknown | - |
| v2-checkout-engine | solo-medium | 2 | Sol total | total | - | - | - | - | - | - | 7.23 | - | - |
| v2-checkout-engine | solo-medium | 2 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-checkout-engine | solo-medium | 2 | Run total | total | - | - | - | - | - | - | 7.23 | - | 113s |
| v2-checkout-engine | adaptive-medium | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 362771 | 332288 | 1909 | 393 | unknown | 9.4 | unknown | - |
| v2-checkout-engine | adaptive-medium | 2 | Worker (task t1, thread 01a03735-7945-70c0-93e8-3f1331815fbe) | worker | gpt-5.6-luna / high | 268832 | 236800 | 7112 | 3725 | 0 | 0.49 | 168s | - |
| v2-checkout-engine | adaptive-medium | 2 | Sol total | total | - | - | - | - | - | - | 9.4 | - | - |
| v2-checkout-engine | adaptive-medium | 2 | Luna total | total | - | - | - | - | - | - | 0.49 | - | - |
| v2-checkout-engine | adaptive-medium | 2 | Run total | total | - | - | - | - | - | - | 9.89 | - | 213s |
| v2-frontmatter-parser | forced-delegation | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 151903 | 135168 | 1322 | 371 | unknown | 4.77 | unknown | - |
| v2-frontmatter-parser | forced-delegation | 1 | Worker (task t1, thread 01a03738-da7c-7ac1-87d2-bbfbb629bf37) | worker | gpt-5.6-luna / high | 130906 | 105984 | 6015 | 3418 | 0 | 0.36 | 139s | - |
| v2-frontmatter-parser | forced-delegation | 1 | Sol total | total | - | - | - | - | - | - | 4.77 | - | - |
| v2-frontmatter-parser | forced-delegation | 1 | Luna total | total | - | - | - | - | - | - | 0.36 | - | - |
| v2-frontmatter-parser | forced-delegation | 1 | Run total | total | - | - | - | - | - | - | 5.13 | - | 186s |
| v2-integration-toolkit | forced-delegation | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 199600 | 158464 | 2882 | 720 | unknown | 9.28 | unknown | - |
| v2-integration-toolkit | forced-delegation | 1 | Worker (task t3, thread 01a0373b-c34c-7831-894f-45a309175d68) | worker | gpt-5.6-luna / medium | 102510 | 79616 | 1404 | 385 | 0 | 0.2 | 52s | - |
| v2-integration-toolkit | forced-delegation | 1 | Worker (task t1, thread 01a0373b-cafb-7dd1-809e-ca8a0e08917f) | worker | gpt-5.6-luna / medium | 150098 | 123136 | 2199 | 875 | 0 | 0.26 | 75s | - |
| v2-integration-toolkit | forced-delegation | 1 | Worker (task t4, thread 01a0373b-be08-7423-884b-552ba593bd5c) | worker | gpt-5.6-luna / medium | 181273 | 156416 | 2611 | 768 | 0 | 0.28 | 85s | - |
| v2-integration-toolkit | forced-delegation | 1 | Worker (task t2, thread 01a0373b-c1b7-7613-b7f8-61dfa0ebc10d) | worker | gpt-5.6-luna / high | 178743 | 149504 | 4595 | 2387 | 0 | 0.36 | 121s | - |
| v2-integration-toolkit | forced-delegation | 1 | Sol total | total | - | - | - | - | - | - | 9.28 | - | - |
| v2-integration-toolkit | forced-delegation | 1 | Luna total | total | - | - | - | - | - | - | 1.1 | - | - |
| v2-integration-toolkit | forced-delegation | 1 | Run total | total | - | - | - | - | - | - | 10.38 | - | 199s |
| v2-data-contracts | forced-delegation | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 194011 | 167680 | 2491 | 688 | unknown | 7.26 | unknown | - |
| v2-data-contracts | forced-delegation | 1 | Worker (task t2, thread 01a0373e-c215-7dc3-b96a-4bda2704351f) | worker | gpt-5.6-luna / medium | 136960 | 111872 | 2019 | 647 | 0 | 0.24 | 63s | - |
| v2-data-contracts | forced-delegation | 1 | Worker (task t3, thread 01a0373e-c1a0-74e2-bf62-a719a5b2eecd) | worker | gpt-5.6-luna / high | 125620 | 98816 | 3540 | 1733 | 0 | 0.29 | 93s | - |
| v2-data-contracts | forced-delegation | 1 | Worker (task t1, thread 01a0373e-c1c0-7fd2-9816-e09b42905071) | worker | gpt-5.6-luna / high | 297979 | 258560 | 7766 | 3456 | 0 | 0.56 | 189s | - |
| v2-data-contracts | forced-delegation | 1 | Sol total | total | - | - | - | - | - | - | 7.26 | - | - |
| v2-data-contracts | forced-delegation | 1 | Luna total | total | - | - | - | - | - | - | 1.09 | - | - |
| v2-data-contracts | forced-delegation | 1 | Run total | total | - | - | - | - | - | - | 8.35 | - | 256s |
| v2-repository-tools | forced-delegation | 1 | Supervisor | supervisor | gpt-5.6-sol / medium | 236217 | 213248 | 2612 | 619 | unknown | 7.5 | unknown | - |
| v2-repository-tools | forced-delegation | 1 | Worker (task t3, thread 01a03742-a465-7b70-9299-26f3b9ffdd15) | worker | gpt-5.6-luna / medium | 123769 | 100864 | 2136 | 878 | 0 | 0.23 | 64s | - |
| v2-repository-tools | forced-delegation | 1 | Worker (task t1, thread 01a03742-a420-7e91-8acc-d9a9ef609455) | worker | gpt-5.6-luna / medium | 166401 | 140288 | 3107 | 1353 | 0 | 0.29 | 87s | - |
| v2-repository-tools | forced-delegation | 1 | Worker (task t2, thread 01a03742-a449-7741-8f36-5e09ff2e7248) | worker | gpt-5.6-luna / high | 234981 | 196608 | 5267 | 3483 | 0 | 0.45 | 124s | - |
| v2-repository-tools | forced-delegation | 1 | Sol total | total | - | - | - | - | - | - | 7.5 | - | - |
| v2-repository-tools | forced-delegation | 1 | Luna total | total | - | - | - | - | - | - | 0.97 | - | - |
| v2-repository-tools | forced-delegation | 1 | Run total | total | - | - | - | - | - | - | 8.47 | - | 198s |
| v2-frontmatter-parser | forced-delegation | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 129519 | 108800 | 1204 | 301 | unknown | 4.85 | unknown | - |
| v2-frontmatter-parser | forced-delegation | 2 | Worker (task t1, thread 01a03745-9d1c-76a3-ac7b-4102ddf844aa) | worker | gpt-5.6-luna / high | 162331 | 110080 | 8660 | 5434 | 0 | 0.58 | 189s | - |
| v2-frontmatter-parser | forced-delegation | 2 | Sol total | total | - | - | - | - | - | - | 4.85 | - | - |
| v2-frontmatter-parser | forced-delegation | 2 | Luna total | total | - | - | - | - | - | - | 0.58 | - | - |
| v2-frontmatter-parser | forced-delegation | 2 | Run total | total | - | - | - | - | - | - | 5.43 | - | 225s |
| v2-integration-toolkit | forced-delegation | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 328251 | 305152 | 2786 | 689 | unknown | 8.79 | unknown | - |
| v2-integration-toolkit | forced-delegation | 2 | Worker (task t3, thread 01a03749-3412-76f0-a774-b71fe0161b9e) | worker | gpt-5.6-luna / medium | 120743 | 95744 | 1761 | 508 | 0 | 0.23 | 59s | - |
| v2-integration-toolkit | forced-delegation | 2 | Worker (task t1, thread 01a03749-3432-71a3-b8b8-6da715877a80) | worker | gpt-5.6-luna / medium | 117864 | 93696 | 1806 | 573 | 0 | 0.22 | 65s | - |
| v2-integration-toolkit | forced-delegation | 2 | Worker (task t4, thread 01a03749-33ed-7e42-98b3-03f6a459780d) | worker | gpt-5.6-luna / high | 152363 | 124160 | 2715 | 1090 | 0 | 0.28 | 81s | - |
| v2-integration-toolkit | forced-delegation | 2 | Worker (task t2, thread 01a03749-33c6-7f90-bb18-8f246536296e) | worker | gpt-5.6-luna / high | 172492 | 142336 | 5705 | 3582 | 0 | 0.39 | 134s | - |
| v2-integration-toolkit | forced-delegation | 2 | Sol total | total | - | - | - | - | - | - | 8.79 | - | - |
| v2-integration-toolkit | forced-delegation | 2 | Luna total | total | - | - | - | - | - | - | 1.13 | - | - |
| v2-integration-toolkit | forced-delegation | 2 | Run total | total | - | - | - | - | - | - | 9.92 | - | 202s |
| v2-data-contracts | forced-delegation | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 292983 | 250368 | 2564 | 601 | unknown | 10.38 | unknown | - |
| v2-data-contracts | forced-delegation | 2 | Worker (task t2, thread 01a0374c-3c59-7650-a958-2d92d3da299e) | worker | gpt-5.6-luna / medium | 197561 | 167680 | 2274 | 814 | 0 | 0.3 | 68s | - |
| v2-data-contracts | forced-delegation | 2 | Worker (task t3, thread 01a0374c-3b6d-7f50-9771-5eab53f9b6b6) | worker | gpt-5.6-luna / high | 165456 | 140288 | 3832 | 1424 | 0 | 0.31 | 101s | - |
| v2-data-contracts | forced-delegation | 2 | Worker (task t1, thread 01a0374c-3c66-7f62-b7bc-6cc6120a0bfe) | worker | gpt-5.6-luna / high | 146730 | 121088 | 4361 | 1282 | 0 | 0.32 | 108s | - |
| v2-data-contracts | forced-delegation | 2 | Sol total | total | - | - | - | - | - | - | 10.38 | - | - |
| v2-data-contracts | forced-delegation | 2 | Luna total | total | - | - | - | - | - | - | 0.93 | - | - |
| v2-data-contracts | forced-delegation | 2 | Run total | total | - | - | - | - | - | - | 11.31 | - | 174s |
| v2-repository-tools | forced-delegation | 2 | Supervisor | supervisor | gpt-5.6-sol / medium | 205336 | 168448 | 2715 | 784 | unknown | 8.75 | unknown | - |
| v2-repository-tools | forced-delegation | 2 | Worker (task t1, thread 01a0374e-e4ad-71c0-95fd-47ed34982a4e) | worker | gpt-5.6-luna / medium | 143075 | 128000 | 2461 | 926 | 0 | 0.21 | 71s | - |
| v2-repository-tools | forced-delegation | 2 | Worker (task t2, thread 01a0374e-e450-7dc3-bfe8-04ae97b460b8) | worker | gpt-5.6-luna / high | 150181 | 122112 | 4886 | 3562 | 0 | 0.35 | 120s | - |
| v2-repository-tools | forced-delegation | 2 | Worker (task t3, thread 01a0374e-e410-7f50-924e-fbf379f098e3) | worker | gpt-5.6-luna / high | 248483 | 217344 | 4941 | 2632 | 0 | 0.41 | 124s | - |
| v2-repository-tools | forced-delegation | 2 | Sol total | total | - | - | - | - | - | - | 8.75 | - | - |
| v2-repository-tools | forced-delegation | 2 | Luna total | total | - | - | - | - | - | - | 0.97 | - | - |
| v2-repository-tools | forced-delegation | 2 | Run total | total | - | - | - | - | - | - | 9.73 | - | 193s |
| v2-config-overlay | solo-medium | 3 | Supervisor | supervisor | gpt-5.6-sol / medium | 115030 | 90624 | 3467 | 1350 | unknown | 6.78 | unknown | - |
| v2-config-overlay | solo-medium | 3 | Sol total | total | - | - | - | - | - | - | 6.78 | - | - |
| v2-config-overlay | solo-medium | 3 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-config-overlay | solo-medium | 3 | Run total | total | - | - | - | - | - | - | 6.78 | - | 108s |
| v2-config-overlay | adaptive-medium | 3 | Supervisor | supervisor | gpt-5.6-sol / medium | 141092 | 113920 | 3809 | 1483 | unknown | 7.68 | unknown | - |
| v2-config-overlay | adaptive-medium | 3 | Sol total | total | - | - | - | - | - | - | 7.68 | - | - |
| v2-config-overlay | adaptive-medium | 3 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-config-overlay | adaptive-medium | 3 | Run total | total | - | - | - | - | - | - | 7.68 | - | 110s |
| v2-rate-limiter-tests | adaptive-medium | 3 | Supervisor | supervisor | gpt-5.6-sol / medium | 115652 | 101888 | 1948 | 368 | unknown | 4.46 | unknown | - |
| v2-rate-limiter-tests | adaptive-medium | 3 | Sol total | total | - | - | - | - | - | - | 4.46 | - | - |
| v2-rate-limiter-tests | adaptive-medium | 3 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-rate-limiter-tests | adaptive-medium | 3 | Run total | total | - | - | - | - | - | - | 4.46 | - | 66s |
| v2-frontmatter-parser | adaptive-medium | 3 | Supervisor | supervisor | gpt-5.6-sol / medium | 212437 | 193024 | 5062 | 1656 | unknown | 8.64 | unknown | - |
| v2-frontmatter-parser | adaptive-medium | 3 | Sol total | total | - | - | - | - | - | - | 8.64 | - | - |
| v2-frontmatter-parser | adaptive-medium | 3 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-frontmatter-parser | adaptive-medium | 3 | Run total | total | - | - | - | - | - | - | 8.64 | - | 139s |
| v2-worker-pool | adaptive-medium | 3 | Supervisor | supervisor | gpt-5.6-sol / medium | 139736 | 123136 | 1474 | 418 | unknown | 4.72 | unknown | - |
| v2-worker-pool | adaptive-medium | 3 | Sol total | total | - | - | - | - | - | - | 4.72 | - | - |
| v2-worker-pool | adaptive-medium | 3 | Luna total | total | - | - | - | - | - | - | 0 | - | - |
| v2-worker-pool | adaptive-medium | 3 | Run total | total | - | - | - | - | - | - | 4.72 | - | 60s |
| v2-integration-toolkit | adaptive-medium | 3 | Supervisor | supervisor | gpt-5.6-sol / medium | 246892 | 219136 | 2331 | 296 | unknown | 7.96 | unknown | - |
| v2-integration-toolkit | adaptive-medium | 3 | Worker (task t3, thread 01a0375b-20e8-7821-b394-188ab30ad657) | worker | gpt-5.6-luna / medium | 177118 | 148480 | 2171 | 732 | 0 | 0.28 | 69s | - |
| v2-integration-toolkit | adaptive-medium | 3 | Worker (task t4, thread 01a0375b-2151-7b33-8ab1-7534fd970de3) | worker | gpt-5.6-luna / medium | 126644 | 101888 | 2254 | 547 | 0 | 0.24 | 73s | - |
| v2-integration-toolkit | adaptive-medium | 3 | Worker (task t2, thread 01a0375b-20d9-7610-a0d4-8e67c9aefacc) | worker | gpt-5.6-luna / medium | 90050 | 66560 | 3430 | 1990 | 0 | 0.25 | 85s | - |
| v2-integration-toolkit | adaptive-medium | 3 | Worker (task t1, thread 01a0375b-2088-7481-88c6-1900ba506201) | worker | gpt-5.6-luna / medium | 141593 | 129024 | 2736 | 1235 | 0 | 0.21 | 88s | - |
| v2-integration-toolkit | adaptive-medium | 3 | Sol total | total | - | - | - | - | - | - | 7.96 | - | - |
| v2-integration-toolkit | adaptive-medium | 3 | Luna total | total | - | - | - | - | - | - | 0.99 | - | - |
| v2-integration-toolkit | adaptive-medium | 3 | Run total | total | - | - | - | - | - | - | 8.94 | - | 155s |
| v2-data-contracts | adaptive-medium | 3 | Supervisor | supervisor | gpt-5.6-sol / medium | 176826 | 150272 | 1823 | 258 | unknown | 6.56 | unknown | - |
| v2-data-contracts | adaptive-medium | 3 | Worker (task t2, thread 01a0375d-46c4-7eb0-8d1e-37faeda22e1b) | worker | gpt-5.6-luna / medium | 149119 | 123136 | 3832 | 1611 | 0 | 0.31 | 102s | - |
| v2-data-contracts | adaptive-medium | 3 | Worker (task t3, thread 01a0375d-46fe-7c82-8bf1-3b89db2146cf) | worker | gpt-5.6-luna / high | 167215 | 140288 | 4024 | 2064 | 0 | 0.33 | 103s | - |
| v2-data-contracts | adaptive-medium | 3 | Worker (task t1, thread 01a0375d-4633-7020-923c-20de03f055ba) | worker | gpt-5.6-luna / high | 191259 | 161792 | 7694 | 3334 | 0 | 0.46 | 188s | - |
| v2-data-contracts | adaptive-medium | 3 | Sol total | total | - | - | - | - | - | - | 6.56 | - | - |
| v2-data-contracts | adaptive-medium | 3 | Luna total | total | - | - | - | - | - | - | 1.09 | - | - |
| v2-data-contracts | adaptive-medium | 3 | Run total | total | - | - | - | - | - | - | 7.66 | - | 239s |
| v2-data-contracts | forced-delegation | 3 | Supervisor | supervisor | gpt-5.6-sol / medium | 197622 | 166656 | 2813 | 910 | unknown | 8.06 | unknown | - |
| v2-data-contracts | forced-delegation | 3 | Worker (task t2, thread 01a03760-dd00-78e0-bfe5-1a553b88335b) | worker | gpt-5.6-luna / medium | 161796 | 135168 | 2605 | 969 | 0 | 0.28 | 84s | - |
| v2-data-contracts | forced-delegation | 3 | Worker (task t3, thread 01a03760-dd56-7373-860a-2ef35ea51b6a) | worker | gpt-5.6-luna / high | 186916 | 159488 | 2847 | 1245 | 0 | 0.3 | 89s | - |
| v2-data-contracts | forced-delegation | 3 | Worker (task t1, thread 01a03760-dd68-75a3-8910-9d8a6e94c7c9) | worker | gpt-5.6-luna / high | 324297 | 276224 | 6184 | 2609 | 0 | 0.56 | 151s | - |
| v2-data-contracts | forced-delegation | 3 | Sol total | total | - | - | - | - | - | - | 8.06 | - | - |
| v2-data-contracts | forced-delegation | 3 | Luna total | total | - | - | - | - | - | - | 1.15 | - | - |
| v2-data-contracts | forced-delegation | 3 | Run total | total | - | - | - | - | - | - | 9.21 | - | 238s |

## Third-repetition recommendations

- `v2-checkout-engine` / solo-medium: credit delta versus Solo is within 10%
- `v2-data-contracts` / solo-medium: credit delta versus Solo is within 10%
- `v2-frontmatter-parser` / solo-medium: credit delta versus Solo is within 10%
- `v2-integration-toolkit` / solo-medium: credit delta versus Solo is within 10%
- `v2-rate-limiter-tests` / solo-medium: credit delta versus Solo is within 10%
- `v2-repository-tools` / solo-medium: credit delta versus Solo is within 10%
- `v2-worker-pool` / solo-medium: credit delta versus Solo is within 10%

## Measurement notes

- Correctness is determined after the model turn by deterministic grade commands, immutable-file checks, and mutation checks where applicable.
- `rateCardCredits` is calculated from the snapshotted official rate card. `actualCredits` remains null unless an authoritative per-run value becomes available.
- Codex SDK `inputTokens` includes cached input, so cached tokens are removed from the full-rate input portion and charged once at the cached-input rate. Cache writes are uncharged.
- Output tokens already include reasoning output; reasoning tokens are retained as diagnostics and are not charged twice.
- Wall-clock covers the full supervisor turn, including delegation setup, workers, integration, review, and verification.
- Participant worker durations remain individual execution times. They are never summed or substituted for end-to-end wall-clock; supervisor participant duration stays unavailable because the harness does not observe a single authoritative supervisor-only duration.
- Raw tokens, worker effort, concurrency, duration, and straggler fields are supporting diagnostics rather than the headline economic metric.
- Two repetitions are directional evidence. A third is recommended only for the conditions listed above; no statistical significance is claimed.
