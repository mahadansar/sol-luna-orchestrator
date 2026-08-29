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

/**
 * Efforts this installation permits, narrowing `EFFORTS`.
 *
 * Part of the operator-owned compute policy baseline (see `policy.ts`). Comma
 * separated, order-insensitive; unrecognised entries are dropped and an empty
 * or wholly invalid list falls back to the full range rather than bricking
 * delegation. The advertised schema still offers every effort in `EFFORTS`, so
 * a narrowed installation refuses a disallowed effort before spending a turn
 * instead of silently substituting one.
 */
const splitEffortList = (raw: string | null | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

export function parseAllowedEfforts(raw: string | null | undefined): readonly Effort[] {
  const entries = splitEffortList(raw);
  if (entries.length === 0) return [...EFFORTS];
  const permitted = EFFORTS.filter((effort) => entries.includes(effort));
  return permitted.length > 0 ? permitted : [...EFFORTS];
}

export function allowedEffortsInvalid(raw: string | null | undefined): boolean {
  const entries = splitEffortList(raw);
  return (
    entries.length > 0 &&
    entries.some((entry) => !(EFFORTS as readonly string[]).includes(entry))
  );
}

/**
 * Opt-out flags: absent or anything other than `0` means permitted, so an
 * installation that sets nothing keeps its pre-policy behaviour exactly.
 */
export const parseOptOutFlag = (raw: string | null | undefined): boolean => raw !== "0";

export const ALLOWED_EFFORTS: readonly Effort[] = parseAllowedEfforts(
  process.env.SOL_LUNA_ALLOWED_EFFORTS,
);

/** Whether SOL_LUNA_ALLOWED_EFFORTS held entries we could not use as given. */
export const ALLOWED_EFFORTS_INVALID = allowedEffortsInvalid(
  process.env.SOL_LUNA_ALLOWED_EFFORTS,
);

/**
 * Default effort, kept inside the operator's allowed set.
 *
 * `effort` is a defaulted input, so a baseline that excludes the default would
 * otherwise refuse every call that omitted the field. Prefer `high`; failing
 * that take the cheapest permitted effort.
 */
export const DEFAULT_EFFORT: Effort = ALLOWED_EFFORTS.includes("high")
  ? "high"
  : (ALLOWED_EFFORTS[0] as Effort);

/**
 * The Codex TypeScript SDK types `modelReasoningEffort` as
 * "minimal"|"low"|"medium"|"high"|"xhigh" — its type list predates `max`.
 * The SDK forwards the value verbatim as `--config model_reasoning_effort="…"`,
 * and the CLI accepts `max` for Luna (verified against codex-cli 0.147.0), so
 * widening the type here is safe rather than speculative.
 */
export type SdkEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export const asSdkEffort = (effort: Effort): SdkEffort => effort as SdkEffort;

/**
 * Seconds budgets, read the same way every other operator bound here is.
 *
 * A bare `Number(...)` accepted anything: `abc` became `NaN` and `0` and `-1`
 * stayed as given. Both reach `setTimeout`, which coerces `NaN` and every
 * non-positive value to a ~1ms deadline, so one typo silently turned every
 * worker turn and every verification command into an immediate timeout - i.e.
 * a failing verdict with no failure the operator could see. Fall back to the
 * documented default instead, and record that the value was unusable.
 */
export function parseTimeoutSeconds(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

export function timeoutSecondsInvalid(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = Number(raw.trim());
  return !Number.isFinite(value) || value <= 0;
}

export const DEFAULT_TIMEOUT_SECONDS_FALLBACK = 1800;
export const VERIFY_TIMEOUT_SECONDS_FALLBACK = 600;

/** Default wall-clock budget for a single delegated task. */
export const DEFAULT_TIMEOUT_SECONDS = parseTimeoutSeconds(
  process.env.LUNA_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS_FALLBACK,
);

/** Whether LUNA_TIMEOUT_SECONDS held a value we could not use as given. */
export const DEFAULT_TIMEOUT_SECONDS_INVALID = timeoutSecondsInvalid(
  process.env.LUNA_TIMEOUT_SECONDS,
);

/** Per-verification-command timeout when the orchestrator re-runs them. */
export const VERIFY_TIMEOUT_SECONDS = parseTimeoutSeconds(
  process.env.LUNA_VERIFY_TIMEOUT_SECONDS,
  VERIFY_TIMEOUT_SECONDS_FALLBACK,
);

/** Whether LUNA_VERIFY_TIMEOUT_SECONDS held a value we could not use as given. */
export const VERIFY_TIMEOUT_SECONDS_INVALID = timeoutSecondsInvalid(
  process.env.LUNA_VERIFY_TIMEOUT_SECONDS,
);

/**
 * Sandbox the worker runs under. `workspace-write` lets it actually edit code.
 *
 * Validated rather than cast. The value is forwarded verbatim to the Codex SDK
 * as the worker's filesystem confinement, and an unchecked `as` meant a typo
 * reached the runtime as an unknown mode with no local signal at all.
 *
 * An unrecognised value falls back to `read-only`, not to the documented
 * default. The two typos are not symmetric: an operator who meant `read-only`
 * and got `workspace-write` would be silently *widened*, while one who meant
 * `workspace-write` and gets `read-only` sees every task fail immediately
 * beside a startup warning naming the bad value. Only the second is recoverable
 * by reading the error. An unset variable still resolves to `workspace-write`,
 * so nothing changes for an installation that configures nothing.
 */
export const WORKER_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
export type WorkerSandboxMode = (typeof WORKER_SANDBOX_MODES)[number];
export const DEFAULT_WORKER_SANDBOX: WorkerSandboxMode = "workspace-write";

export function parseWorkerSandbox(raw: string | undefined): WorkerSandboxMode {
  if (raw === undefined) return DEFAULT_WORKER_SANDBOX;
  const normalized = raw.trim().toLowerCase();
  return (WORKER_SANDBOX_MODES as readonly string[]).includes(normalized)
    ? (normalized as WorkerSandboxMode)
    : "read-only";
}

export function workerSandboxInvalid(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return !(WORKER_SANDBOX_MODES as readonly string[]).includes(raw.trim().toLowerCase());
}

export const WORKER_SANDBOX: WorkerSandboxMode = parseWorkerSandbox(
  process.env.LUNA_SANDBOX,
);

/** Whether LUNA_SANDBOX named a mode this runtime does not recognise. */
export const WORKER_SANDBOX_INVALID = workerSandboxInvalid(process.env.LUNA_SANDBOX);

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
 * Most workers one batch may enlist, narrowing `MAX_BATCH_SIZE`.
 *
 * Separate from the advertised `maxItems` ceiling on purpose: the schema keeps
 * publishing the protocol's `MAX_BATCH_SIZE` so tool metadata stays identical
 * across installations, and this baseline refuses an oversized batch at
 * admission instead. Applies to sequential batches too — they enlist just as
 * many workers, one at a time.
 */
export function clampBatchWorkers(value: number): number {
  if (!Number.isFinite(value) || value < 1) return MAX_BATCH_SIZE;
  return Math.min(Math.floor(value), MAX_BATCH_SIZE);
}

export const MAX_WORKERS_PER_BATCH = clampBatchWorkers(
  Number(process.env.SOL_LUNA_MAX_WORKERS_PER_BATCH ?? MAX_BATCH_SIZE),
);

/** Whether SOL_LUNA_MAX_WORKERS_PER_BATCH held a value we could not use as given. */
export const MAX_WORKERS_PER_BATCH_CLAMPED =
  process.env.SOL_LUNA_MAX_WORKERS_PER_BATCH !== undefined &&
  String(MAX_WORKERS_PER_BATCH) !== process.env.SOL_LUNA_MAX_WORKERS_PER_BATCH.trim();

/**
 * Whether the runtime may recommend raising effort, or reaching for a stronger
 * executor, after a repeated trustworthy implementation failure.
 *
 * Both default on, preserving pre-policy behaviour. Set to `0` to cap the
 * escalation ladder: the decision then stops at parent takeover, which is the
 * conservative direction — never a costlier action than the one refused.
 */
export const ALLOW_EFFORT_ESCALATION = parseOptOutFlag(
  process.env.SOL_LUNA_ALLOW_EFFORT_ESCALATION,
);
export const ALLOW_STRONGER_FALLBACK = parseOptOutFlag(
  process.env.SOL_LUNA_ALLOW_STRONGER_FALLBACK,
);

/**
 * Worker models this installation authorises.
 *
 * `LUNA_MODEL` remains authorised because it is the configured baseline worker.
 * Extra entries only grant membership; their position carries no preference or
 * strength meaning.
 */
export function parseAllowedModels(
  raw: string | null | undefined,
  baselineModel: string,
): readonly string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set([baselineModel, ...entries])];
}

export const ALLOWED_MODELS: readonly string[] = parseAllowedModels(
  process.env.SOL_LUNA_ALLOWED_MODELS,
  LUNA_MODEL,
);

/**
 * Optional operator-declared executor preference/strength ladder.
 *
 * Comma-separated list of model names in ascending capability/strength order:
 * [base, ..., stronger, strongest].
 * When unset, no ordering is declared and fallback recommendations remain unresolvable
 * (reported to the parent rather than guessed by list position).
 */
export function parseExecutorOrder(raw: string | null | undefined): readonly string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const EXECUTOR_ORDER: readonly string[] = parseExecutorOrder(
  process.env.SOL_LUNA_EXECUTOR_ORDER,
);

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
export const KEEP_WORKTREE_MODES = ["onfailure", "always", "never"] as const;
export type KeepWorktreesMode = (typeof KEEP_WORKTREE_MODES)[number];

export function parseKeepWorktrees(raw: string | undefined): KeepWorktreesMode {
  const normalized = (raw ?? "onFailure").trim().toLowerCase();
  return (KEEP_WORKTREE_MODES as readonly string[]).includes(normalized)
    ? (normalized as KeepWorktreesMode)
    : "onfailure";
}

export function keepWorktreesInvalid(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return !(KEEP_WORKTREE_MODES as readonly string[]).includes(raw.trim().toLowerCase());
}

export const KEEP_WORKTREES: KeepWorktreesMode = parseKeepWorktrees(
  process.env.SOL_LUNA_KEEP_WORKTREES,
);

/**
 * Whether SOL_LUNA_KEEP_WORKTREES named a mode this runtime does not recognise.
 *
 * Previously an unrecognised value was cast and then compared against the two
 * named modes, so `never`-by-typo silently retained worktrees full of worker
 * output on every failure. The retention decision is unchanged - the fallback
 * is still the documented `onFailure` - but the operator now hears about it.
 */
export const KEEP_WORKTREES_INVALID = keepWorktreesInvalid(
  process.env.SOL_LUNA_KEEP_WORKTREES,
);

/**
 * Allow parallel delegation even when the repository has uncommitted changes
 * inside a task's declared scope. Off by default: workers branch from HEAD, so
 * they would silently work from a stale base.
 */
export const ALLOW_DIRTY_WORKTREE_BASE = process.env.SOL_LUNA_ALLOW_DIRTY === "1";

/** Truncation limit for command output echoed back to the parent orchestrator. */
export const MAX_OUTPUT_CHARS = 4000;

/**
 * Context lifecycle management defaults and environment overrides (P1.3).
 */
export const DEFAULT_CONTEXT_MAX_BYTES = 50_000;
export const DEFAULT_CONTEXT_MAX_TURNS = 20;
export const DEFAULT_CONTEXT_MAX_CLEAN_TURNS = 5;
export const DEFAULT_CONTEXT_MAX_TOOL_OVERHEAD_TURNS = 4;
export const DEFAULT_CONTEXT_MAX_TOOL_OVERHEAD_BYTES = 8_000;
export const DEFAULT_CONTEXT_RECLAIMABLE_RATIO_THRESHOLD = 0.25;
export const DEFAULT_CONTEXT_MIN_RECLAIMABLE_BYTES = 1_000;
export const DEFAULT_CONTEXT_COOLDOWN_TURNS = 2;

export function parseContextPositiveInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export function parseContextNonNegativeInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export const CONTEXT_MAX_BYTES = parseContextPositiveInteger(
  "SOL_LUNA_CONTEXT_MAX_BYTES",
  process.env.SOL_LUNA_CONTEXT_MAX_BYTES,
  DEFAULT_CONTEXT_MAX_BYTES,
);
export const CONTEXT_MAX_TURNS = parseContextPositiveInteger(
  "SOL_LUNA_CONTEXT_MAX_TURNS",
  process.env.SOL_LUNA_CONTEXT_MAX_TURNS,
  DEFAULT_CONTEXT_MAX_TURNS,
);
export const CONTEXT_MAX_CLEAN_TURNS = parseContextPositiveInteger(
  "SOL_LUNA_CONTEXT_MAX_CLEAN_TURNS",
  process.env.SOL_LUNA_CONTEXT_MAX_CLEAN_TURNS,
  DEFAULT_CONTEXT_MAX_CLEAN_TURNS,
);
export const CONTEXT_COOLDOWN_TURNS = parseContextNonNegativeInteger(
  "SOL_LUNA_CONTEXT_COOLDOWN_TURNS",
  process.env.SOL_LUNA_CONTEXT_COOLDOWN_TURNS,
  DEFAULT_CONTEXT_COOLDOWN_TURNS,
);
