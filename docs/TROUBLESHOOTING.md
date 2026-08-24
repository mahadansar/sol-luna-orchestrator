# Troubleshooting

Symptoms and what they usually mean. For literal settings and defaults see
[Configuration](CONFIGURATION.md#codex-settings-and-environment-variables); for
the trust model see
[SECURITY.md](../SECURITY.md).

---

`SOL_LUNA_LOG` is ground truth for the first three. Model self-reports are not: a
low-effort model will cheerfully claim it has a tool it does not have.

| Symptom                                                | Cause                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Log file never created                                 | Codex never started the server — config or path problem. Check `codex mcp get sol-luna-orchestrator`.                                                                                                                                                                                                                                                                        |
| Log has `client connected` but no `delegate_task` line | The server is fine; the model chose not to call it. Prompt more directly.                                                                                                                                                                                                                                                                                                    |
| `user cancelled MCP tool call`                         | The required approval setting is missing or incorrect. Rerun `sol-luna-orchestrator init`; see [required Codex settings](CONFIGURATION.md#required-codex-settings).                                                                                                                                                                                                          |
| Delegations die at ~60 seconds                         | The required tool timeout is missing. Rerun `sol-luna-orchestrator init`; see [required Codex settings](CONFIGURATION.md#required-codex-settings).                                                                                                                                                                                                                           |
| `not inside a git repository` on a parallel batch      | Parallel mode needs git worktrees. Use `mode: "sequential"`, or `git init` + one commit.                                                                                                                                                                                                                                                                                     |
| `uncommitted changes inside the file scopes`           | Workers branch from `HEAD` and would not see that work. Commit, stash, narrow the scopes, or set `SOL_LUNA_ALLOW_DIRTY=1`.                                                                                                                                                                                                                                                   |
| `overlapping file scopes`                              | Working as intended. Give disjoint scopes or use sequential mode.                                                                                                                                                                                                                                                                                                            |
| Verification fails with "module not found" in a batch  | The worktree link for `node_modules` failed. Check the task warnings; see `SOL_LUNA_WORKTREE_LINK`.                                                                                                                                                                                                                                                                          |
| Worktrees left in `.sol-luna/worktrees/`               | Expected after a failure, conflict, or fail-closed lease-renewal error (`SOL_LUNA_KEEP_WORKTREES`). Do not delete an active or continuation-owned worktree; bounded owner leases protect both across MCP server processes. A later batch sweeps expired generation, acquisition-reservation, and interrupted-publication artifacts, then prunes unprotected stale worktrees. |
| `Command refused by verification policy`               | Working as intended. One command per entry, no `&&`; or permit the executable via `SOL_LUNA_VERIFY_ALLOW`.                                                                                                                                                                                                                                                                   |
| A worker appears able to delegate                      | Don't trust the model's answer. Run `npm run smoke:isolation`.                                                                                                                                                                                                                                                                                                               |
| Fresh chat does not find this MCP                      | See [Configuration: discovery hint and adaptive routing](CONFIGURATION.md#discovery-hint-and-adaptive-routing) and [adaptive delegation rules](../SOL_RULES.md#roles-and-adaptive-delegation). Codex may defer MCP discovery; check `sol-luna-orchestrator status` for the managed hint.                                                                                     |
| Discovery hint is missing or modified                  | Run `sol-luna-orchestrator init`, or keep it absent with `init --no-discovery-hint`. User-edited marker content is preserved; see [Configuration: discovery hint and adaptive routing](CONFIGURATION.md#discovery-hint-and-adaptive-routing).                                                                                                                                |
| Changed and rebuilt source but behaviour is unchanged  | Codex may still be configured for the installed package, or the current session may own an older MCP process. Verify the effective local MCP `args`, run `npm run build`, then close the session and open a new one.                                                                                                                                                         |

## Recovering a broken configuration

Start with `sol-luna-orchestrator doctor`. It checks the Node range, git and
Codex availability, Codex's local authentication file, the registration, the
resolved server path, required settings, logs, discovery hint and runtime
policy, and prints the command that fixes each failure. It does not validate
git's numeric minimum or prove that stored credentials still work. `--json`
gives the same report for scripts.

Most problems are repaired by re-running `sol-luna-orchestrator init`. It is
idempotent, it repairs only what is wrong, and it preserves any custom paths
you set. Config writes are atomic and replacing an existing config leaves a
`config.toml.sol-luna-backup` beside the original. The discovery-hint write is
atomic but does not create a backup.

`sol-luna-orchestrator uninstall` removes this project's MCP table and exact
managed discovery hint, and nothing else. It deliberately leaves your other
`AGENTS.md` instructions, log and activity files on disk: that history is yours,
not the installer's to delete. Use `--dry-run` to inspect the removal without
writing.

## Activity shows nothing

`No orchestration activity found.` means the event log is configured but no
delegation has been recorded in it yet. That is the expected state on a fresh
install, and `--watch` will keep waiting.

If instead you get `Activity logging is not configured.`, the event path is
missing from the registered server. Run `sol-luna-orchestrator init` to add it.
Installations created before v0.6.1 need this once.

`sol-luna-orchestrator status` shows the effective event path and whether it
came from the configuration or from a `SOL_LUNA_EVENTS` override in your shell. See [Observability](OBSERVABILITY.md) for what each log contains and how to read
`activity` output.

## Testing a change to the server

First confirm the effective MCP `args` point at this checkout's
`dist/server.js`, not the installed package; see
[Developing the MCP locally](../CONTRIBUTING.md#developing-the-mcp-locally).
Then run `npm run build` and open a fresh Codex session. Rebuilding `dist/` does
not restart the MCP process owned by the current session. See
[Live model-backed acceptance](../CONTRIBUTING.md#live-model-backed-acceptance)
for the complete deterministic and fresh-client procedure.
