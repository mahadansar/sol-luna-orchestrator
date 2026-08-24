/**
 * Static configuration for the Sol-Luna delegation bridge.
 *
 * Everything here is operator-controlled: it comes from the environment the
 * server was launched with, never from the model. That separation matters —
 * see `command.ts`, where model-supplied input is checked against these values.
 */
import path from "node:path";

/** Worker model. Verified present in the local Codex model cache. */
export const DEFAULT_LUNA_MODEL = "gpt-5.6-luna";
export const LUNA_MODEL = process.env.LUNA_MODEL ?? DEFAULT_LUNA_MODEL;

/**
 * The name this server is registered under in Codex's config.toml.
 *
 * Workers are isolated by passing `mcp_servers.<name>.enabled=false`, so this
 * MUST match the registered name or the worker will inherit `delegate_task`
 * and be able to delegate recursively. If you re-register the server under a
 * different name, set SOL_LUNA_SERVER_NAME to match.
 *
 * Note: `mcp_servers={}` does NOT work for this — Codex merges that override
 * into the existing table rather than replacing it, and every server still
 * starts. Verified against codex-cli 0.147.0.
 */
export const DEFAULT_ORCHESTRATOR_SERVER_NAME = "sol-luna-orchestrator";
export const ORCHESTRATOR_SERVER_NAME =
  process.env.SOL_LUNA_SERVER_NAME ?? DEFAULT_ORCHESTRATOR_SERVER_NAME;

/**
 * Env marker set on worker processes. A server instance that sees it refuses to
 * serve `delegate_task` at all — a config-independent backstop against
 * recursive delegation if the name above ever drifts.
 */
export const WORKER_MARKER_ENV = "SOL_LUNA_WORKER";
export const IS_WORKER_PROCESS = process.env[WORKER_MARKER_ENV] === "1";

/**
 * Reasoning efforts the parent orchestrator may select for a delegated task.
 *
 * `gpt-5.6-luna` advertises low|medium|high|xhigh|max. We deliberately expose
 * only the top four: delegation always carries a fixed handoff cost, so a
 * `low`-effort worker is never the right trade against the parent doing it.
 */
export const EFFORTS = ["medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const DEFAULT_EFFORT: Effort = "high";

/**
 * The Codex TypeScript SDK types `modelReasoningEffort` as
 * "minimal"|"low"|"medium"|"high"|"xhigh" — its type list predates `max`.
 * The SDK forwards the value verbatim as `--config model_reasoning_effort="…"`,
 * and the CLI accepts `max` for Luna (verified against codex-cli 0.147.0), so
 * widening the type here is safe rather than speculative.
 */
export type SdkEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export const asSdkEffort = (effort: Effort): SdkEffort => effort as SdkEffort;

/** Default wall-clock budget for a single delegated task. */
export const DEFAULT_TIMEOUT_SECONDS = Number(process.env.LUNA_TIMEOUT_SECONDS ?? 1800);

/** Per-verification-command timeout when the orchestrator re-runs them. */
export const VERIFY_TIMEOUT_SECONDS = Number(
  process.env.LUNA_VERIFY_TIMEOUT_SECONDS ?? 600,
);

/** Sandbox the worker runs under. `workspace-write` lets it actually edit code. */
export const WORKER_SANDBOX = (process.env.LUNA_SANDBOX ?? "workspace-write") as
  "read-only" | "workspace-write" | "danger-full-access";

/** Whether the worker may reach the network from inside the sandbox. */
export const WORKER_NETWORK_ACCESS = process.env.LUNA_NETWORK_ACCESS === "1";

/**
 * How the orchestrator re-runs `verificationCommands` after the worker exits.
 *
 * Re-running them ourselves is what makes a worker's PASS falsifiable. But
 * those command strings come from a model, so how we execute them is a real
 * trust decision:
 *
 *   allowlist (default) - parse into argv with no shell, and only launch
 *                         executables the operator has permitted. Safe default.
 *   off                 - never execute. Verification claims stay unchecked and
 *                         the result says so explicitly.
 *   shell               - hand the raw string to a system shell. Equivalent to
 *                         letting the model run arbitrary commands as you.
 *                         Opt-in only.
 *
 * See SECURITY.md for the full trust boundary.
 */
export const VERIFY_MODES = ["allowlist", "off", "shell"] as const;
export type VerifyMode = (typeof VERIFY_MODES)[number];
export const DEFAULT_VERIFY_MODE: VerifyMode = "allowlist";

const rawVerifyMode = (
  process.env.SOL_LUNA_VERIFY_MODE ?? DEFAULT_VERIFY_MODE
).toLowerCase();
export const VERIFY_MODE: VerifyMode = (VERIFY_MODES as readonly string[]).includes(
  rawVerifyMode,
)
  ? (rawVerifyMode as VerifyMode)
  : "allowlist";

/** Whether SOL_LUNA_VERIFY_MODE held a value we did not recognise. */
export const VERIFY_MODE_INVALID =
  process.env.SOL_LUNA_VERIFY_MODE !== undefined &&
  !(VERIFY_MODES as readonly string[]).includes(rawVerifyMode);

/**
 * Extra executables the operator permits, comma separated.
 *
 * Comma only: an entry may be an exact path, and splitting on `:` or `;` would
 * mangle `C:\tools\runner.exe`.
 */
export const EXTRA_ALLOWED_EXECUTABLES = (process.env.SOL_LUNA_VERIFY_ALLOW ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

/**
 * Strip credential-shaped variables from the environment of verification
 * commands. Defence in depth: a test suite should not need your API keys, and
 * command output is fed back into a model transcript.
 */
export const VERIFY_SCRUB_ENV = process.env.SOL_LUNA_VERIFY_ENV_PASSTHROUGH !== "1";

/**
 * Optional confinement for `workingDirectory`. When set, delegation is refused
 * outside these roots. Unset means any existing directory is allowed.
 */
export const ALLOWED_WORKSPACE_ROOTS = (process.env.SOL_LUNA_ALLOWED_ROOTS ?? "")
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean);

/**
 * Optional JSONL file recording one line per completed delegation.
 *
 * Machine-readable counterpart to SOL_LUNA_LOG: effort, verdict, duration and
 * token usage. The benchmark harness reads this; it is also the honest way to
 * see what delegation actually costs you.
 */
export const EVENTS_FILE = process.env.SOL_LUNA_EVENTS;

/** Hard ceiling, independent of configuration, against runaway spawning. */
export const MAX_PARALLEL_LIMIT = 8;
export const DEFAULT_MAX_PARALLEL = 3;

/** Most tasks accepted in one batch, however they are scheduled. */
export const MAX_BATCH_SIZE = 12;

export function clampParallel(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), MAX_PARALLEL_LIMIT);
}

/**
 * How many workers may run at once in a parallel batch.
 *
 * Three is a deliberate default: enough to overlap real work, small enough that
 * a mistaken batch cannot saturate the machine or the account's rate limits.
 */
export const MAX_PARALLEL = clampParallel(
  Number(process.env.SOL_LUNA_MAX_PARALLEL ?? DEFAULT_MAX_PARALLEL),
);

/** Whether SOL_LUNA_MAX_PARALLEL held a value we could not use as given. */
export const MAX_PARALLEL_CLAMPED =
  process.env.SOL_LUNA_MAX_PARALLEL !== undefined &&
  String(MAX_PARALLEL) !== process.env.SOL_LUNA_MAX_PARALLEL.trim();

/**
 * Directory holding per-task git worktrees, relative to the repository root.
 * Kept inside the repo so relative tooling still resolves, and excluded from
 * git via `.git/info/exclude` rather than the user's tracked `.gitignore`.
 */
export const WORKTREE_DIR = ".sol-luna/worktrees";

/**
 * Directories linked from the main workspace into each worktree.
 *
 * A git worktree contains tracked files only, so `node_modules` is absent and
 * every verification command would fail with "module not found". Linking is the
 * difference between worktrees being usable and being a curiosity.
 */
export const WORKTREE_LINK_DIRS = (process.env.SOL_LUNA_WORKTREE_LINK ?? "node_modules")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

/**
 * When to keep a worktree after a batch finishes.
 *
 * `never` has final precedence over every intentional retention reason.
 */
export const KEEP_WORKTREES = (
  process.env.SOL_LUNA_KEEP_WORKTREES ?? "onFailure"
).toLowerCase() as "onfailure" | "always" | "never";

/**
 * Allow parallel delegation even when the repository has uncommitted changes
 * inside a task's declared scope. Off by default: workers branch from HEAD, so
 * they would silently work from a stale base.
 */
export const ALLOW_DIRTY_WORKTREE_BASE = process.env.SOL_LUNA_ALLOW_DIRTY === "1";

/** Truncation limit for command output echoed back to the parent orchestrator. */
export const MAX_OUTPUT_CHARS = 4000;
