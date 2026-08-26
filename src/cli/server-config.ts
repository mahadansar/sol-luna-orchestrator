import {
  clampBatchWorkers,
  clampParallel,
  DEFAULT_LUNA_MODEL,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_ORCHESTRATOR_SERVER_NAME,
  DEFAULT_VERIFY_MODE,
  MAX_BATCH_SIZE,
  parseAllowedEfforts,
  parseOptOutFlag,
  VERIFY_MODES,
  type VerifyMode,
} from "../config.js";
import { buildComputePolicy, type ComputePolicy } from "../policy.js";
import { serverEnvTable } from "./settings.js";
import { fromTomlValue, readKey } from "./toml-edit.js";

export interface RegisteredServerConfig {
  workerModel: string;
  maxParallel: number;
  verificationMode: VerifyMode;
  allowedRoots: string | null;
  recursionDisableTarget: string;
  /** The operator-owned compute baseline this registration resolves to. */
  computePolicy: ComputePolicy;
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

  const workerModel = configuredEnv(configText, "LUNA_MODEL") ?? DEFAULT_LUNA_MODEL;
  const maxParallel = clampParallel(
    Number(configuredEnv(configText, "SOL_LUNA_MAX_PARALLEL") ?? DEFAULT_MAX_PARALLEL),
  );

  return {
    workerModel,
    maxParallel,
    verificationMode,
    allowedRoots: configuredEnv(configText, "SOL_LUNA_ALLOWED_ROOTS"),
    recursionDisableTarget:
      configuredEnv(configText, "SOL_LUNA_SERVER_NAME") ??
      DEFAULT_ORCHESTRATOR_SERVER_NAME,
    computePolicy: buildComputePolicy({
      model: workerModel,
      allowedEfforts: parseAllowedEfforts(
        configuredEnv(configText, "SOL_LUNA_ALLOWED_EFFORTS"),
      ),
      maxConcurrency: maxParallel,
      maxWorkersPerBatch: clampBatchWorkers(
        Number(
          configuredEnv(configText, "SOL_LUNA_MAX_WORKERS_PER_BATCH") ?? MAX_BATCH_SIZE,
        ),
      ),
      allowEffortEscalation: parseOptOutFlag(
        configuredEnv(configText, "SOL_LUNA_ALLOW_EFFORT_ESCALATION"),
      ),
      allowStrongerFallback: parseOptOutFlag(
        configuredEnv(configText, "SOL_LUNA_ALLOW_STRONGER_FALLBACK"),
      ),
    }),
  };
}
