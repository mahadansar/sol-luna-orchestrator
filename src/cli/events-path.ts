import path from "node:path";
import { codexHome } from "./paths.js";
import { serverEnvTable } from "./settings.js";
import { fromTomlValue, readKey } from "./toml-edit.js";

/**
 * One place that decides which event file the Activity commands read.
 *
 * Before this existed, `activity` and `status` each looked only at their own
 * `process.env.SOL_LUNA_EVENTS`. That can never work for the normal flow: the
 * value lives in `[mcp_servers.<name>.env]`, which Codex injects into the MCP
 * server it launches. A separate CLI process is not that child and never sees
 * it, so `activity` reported "SOL_LUNA_EVENTS is not set" no matter how well
 * `init` had configured things.
 *
 * Resolution order, highest first:
 *
 *   1. `SOL_LUNA_EVENTS` in this process — an explicit, deliberate override.
 *   2. `SOL_LUNA_EVENTS` in the registered server's env table — what `init`
 *      writes, and what the running server is actually using.
 *   3. Nothing configured. Deliberately *not* defaulted here: falling back to
 *      the default path would make a never-initialised install look merely
 *      empty, when the honest answer is "run init".
 *
 * `defaultEventsPath()` is the value `init` writes. It is only consulted by
 * `init`, so changing it later cannot silently redirect an existing install.
 */

export type EventsPathSource = "override" | "configured" | "unconfigured";

export interface EventsPathResolution {
  /** Absolute path to the JSONL event file, or null when nothing is set up. */
  path: string | null;
  source: EventsPathSource;
}

/** Environment variables are strings; an empty one means "not set", not "". */
const trimmed = (value: string | undefined): string | null => {
  const text = value?.trim();
  return text ? text : null;
};

/**
 * Where `init` puts the event log by default.
 *
 * Under the Codex home rather than the current project: the file accumulates
 * across every repository the user delegates in, and writing it into whichever
 * directory they happened to run `init` from would scatter history and risk
 * committing it. `codexHome()` already honours `CODEX_HOME`.
 */
export const defaultEventsPath = (): string =>
  path.join(codexHome(), "sol-luna-orchestrator.events.jsonl");

/**
 * Resolve the effective event file from this process and a Codex config.
 *
 * Pure with respect to the filesystem: the caller supplies the config text, so
 * this is trivial to test against hostile and unusual configurations.
 */
export function resolveEventsPath(
  configText: string,
  env: NodeJS.ProcessEnv = process.env,
): EventsPathResolution {
  const override = trimmed(env.SOL_LUNA_EVENTS);
  if (override) return { path: override, source: "override" };

  const configured = trimmed(
    fromTomlValue(readKey(configText, serverEnvTable(), "SOL_LUNA_EVENTS")) ?? undefined,
  );
  if (configured) return { path: configured, source: "configured" };

  return { path: null, source: "unconfigured" };
}

/** How to describe where a resolved path came from, for `status`. */
export const describeEventsSource = (source: EventsPathSource): string =>
  source === "override"
    ? "SOL_LUNA_EVENTS override"
    : source === "configured"
      ? "configured by init"
      : "not configured";
