import {
  clampParallel,
  DEFAULT_LUNA_MODEL,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_ORCHESTRATOR_SERVER_NAME,
  DEFAULT_VERIFY_MODE,
  VERIFY_MODES,
  type VerifyMode,
} from "../config.js";
import { serverEnvTable } from "./settings.js";
import { fromTomlValue, readKey } from "./toml-edit.js";

export interface RegisteredServerConfig {
  workerModel: string;
  maxParallel: number;
  verificationMode: VerifyMode;
  allowedRoots: string | null;
  recursionDisableTarget: string;
}

const configuredEnv = (configText: string, key: string): string | null => {
  const value = fromTomlValue(readKey(configText, serverEnvTable(), key))?.trim();
  return value || null;
};

/**
 * Resolve the registered server's runtime policy and defaults.
 *
 * The MCP env table is authoritative for reporting: Codex applies it to the
 * server it launches, while this standalone CLI process may have unrelated
 * shell values. Activity keeps its separate explicit CLI override semantics.
 */
export function resolveRegisteredServerConfig(
  configText: string,
): RegisteredServerConfig {
  const rawVerifyMode = (
    configuredEnv(configText, "SOL_LUNA_VERIFY_MODE") ?? DEFAULT_VERIFY_MODE
  ).toLowerCase();
  const verificationMode = (VERIFY_MODES as readonly string[]).includes(rawVerifyMode)
    ? (rawVerifyMode as VerifyMode)
    : "allowlist";

  return {
    workerModel: configuredEnv(configText, "LUNA_MODEL") ?? DEFAULT_LUNA_MODEL,
    maxParallel: clampParallel(
      Number(configuredEnv(configText, "SOL_LUNA_MAX_PARALLEL") ?? DEFAULT_MAX_PARALLEL),
    ),
    verificationMode,
    allowedRoots: configuredEnv(configText, "SOL_LUNA_ALLOWED_ROOTS"),
    recursionDisableTarget:
      configuredEnv(configText, "SOL_LUNA_SERVER_NAME") ??
      DEFAULT_ORCHESTRATOR_SERVER_NAME,
  };
}
