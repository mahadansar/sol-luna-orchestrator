# CLI and Codex configuration instructions

This directory owns the user CLI internals. `src/cli.ts` is the CLI entry point;
`src/server.ts` remains a separate MCP stdio entry point. Running or importing CLI code
must never accidentally start the MCP server.

## Configuration ownership

- The user's Codex config is not this project's file. Change only the
  `[mcp_servers.<server-name>]` table, its owned keys, and its `env` subtable.
- Do not use `codex mcp add` or `codex mcp remove` for writes. Measured Codex versions
  round-trip unrelated TOML, losing comments and changing formatting. Use the surgical
  editor in `toml-edit.ts`.
- Preserve unrelated bytes, comments, table order, indentation, newline style, and MCP
  servers. Keep the editor intentionally narrow rather than turning it into a general
  TOML serializer.
- Writes go through `writeConfig`: same-directory temporary file, atomic rename, and a
  `.sol-luna-backup` of an existing config. `uninstall` removes only this server table
  and its subtables; it leaves logs, activity history, the package, and other config
  untouched.
- `init` is idempotent. A plain rerun repairs missing required values but preserves
  custom log/event paths; explicit `--log` or `--events` replaces the corresponding
  value. Dry runs write nothing.
- Parse mutating command options strictly. Unknown flags and missing values must fail
  before writes; a typo must not turn an intended dry run into a mutation.

## Shared behavior

- Keep required Codex settings centralized in `settings.ts` so `init` and `doctor`
  cannot drift. The current required values and their experimentally verified
  rationale are documented in [docs/CONFIGURATION.md](../../docs/CONFIGURATION.md);
  `"auto"` is not equivalent to the documented approval setting.
- Resolve the activity file in one place (`events-path.ts`): current process override,
  then the registered server's env table, then unconfigured. Do not silently guess the
  default for an installation that never ran `init`.
- `doctor` must remain deterministic, offline, and actionable. It may inspect local
  binaries/configuration but must not spend a model turn.
- Activity reduction is deterministic and represents only the latest batch. Parent
  supervisor state/usage is not observable through the MCP server and must not be
  fabricated. Watch mode must tolerate missing files, truncation, partial JSONL records,
  and split UTF-8 sequences.
- Respect non-TTY/`NO_COLOR` output and Windows ASCII fallbacks. Machine-readable modes
  must stay parseable and free of presentation noise.

## Verification

Use `src/cli.test.ts` for command/config editing behavior,
`src/activity-config.test.ts` for init and event-path resolution,
`src/activity.test.ts` for reducer behavior, and `src/activity-watch.test.ts` for stream
edge cases. `npm run smoke:cli` exercises the real CLI and Codex configuration lifecycle
without model calls. Update `docs/CONFIGURATION.md` or `docs/TROUBLESHOOTING.md` when a
user-visible setting, command, symptom, or recovery path changes.
