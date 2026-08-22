# Committed benchmark evidence instructions

This directory holds benchmark evidence and its human interpretation. Executable
fixtures and harness code live in `src/bench/` and follow that directory's instructions.

- Treat `results/*.json` as the authoritative raw records. Do not edit historical raw
  results to match a narrative or newer schema; readers must preserve unavailable fields
  as unknown rather than silently supplying zero.
- Timestamped `results/*.md` files are generated summaries of their corresponding raw
  files. Use `npm run bench:report -- <results.json>` to regenerate a summary rather than
  hand-adjusting measured values.
- `RESULTS.md` is the curated, human-written methodology and interpretation. Keep
  measured results, interpretation, counterfactuals, historical product-state context,
  and limitations explicitly separated. Every numerical or performance claim must be
  supported by committed raw records.
- Label historical product-state context explicitly wherever a past run's conclusions
  depend on discovery or guidance that has since changed. Never conflate a free-choice
  benchmark outcome, where the prompt named the tools, with a fresh-session discovery
  failure, and never manufacture causality for a routing decision the raw records do
  not explain.
- Do not claim statistical significance, universal superiority, currency cost, or a
  latency/token crossover that the data does not establish. Negative and inconclusive
  findings are results, not defects to hide.
- `npm run bench:analyze` reads committed records and reports the crossover verdict
  without model calls. A new live run is a deliberate experiment and requires the same
  predeclared arms, repetitions/stopping rules, environment metadata, and honest
  reporting used by the existing methodology.
