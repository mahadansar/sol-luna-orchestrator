import {
  allowedEffortsInvalid,
  clampBatchWorkers,
  clampParallel,
  DEFAULT_TIMEOUT_SECONDS_FALLBACK,
  DEFAULT_LUNA_MODEL,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_ORCHESTRATOR_SERVER_NAME,
  DEFAULT_VERIFY_MODE,
  keepWorktreesInvalid,
  MAX_BATCH_SIZE,
  parseAllowedModels,
  parseAllowedEfforts,
  parseExecutorOrder,
  parseKeepWorktrees,
  parseOptOutFlag,
  parseTimeoutSeconds,
  parseWorkerSandbox,
  timeoutSecondsInvalid,
  VERIFY_MODES,
  VERIFY_TIMEOUT_SECONDS_FALLBACK,
  workerSandboxInvalid,
  type KeepWorktreesMode,
  type VerifyMode,
  type WorkerSandboxMode,
} from "../config.js";
import {
  buildComputePolicy,
  executorOrderDeclaredButUnusable,
  type ComputePolicy,
  type ComputePolicyEnvironment,
} from "../policy.js";
import { serverEnvTable } from "./settings.js";
import { fromTomlValue, readKey } from "./toml-edit.js";

export interface RegisteredServerConfig {
  workerModel: string;
  maxParallel: number;
  maxWorkersPerBatch: number;
  verificationMode: VerifyMode;
  workerTimeoutSeconds: number;
  verificationTimeoutSeconds: number;
  workerSandbox: WorkerSandboxMode;
  workerNetworkAccess: boolean;
  keepWorktrees: KeepWorktreesMode;
  allowDirtyWorktreeBase: boolean;
  allowedRoots: string | null;
  recursionDisableTarget: string;
  /** The operator-owned compute baseline this registration resolves to. */
  computePolicy: ComputePolicy;
  /** SOL_LUNA_EXECUTOR_ORDER was declared but does not order authorisation. */
  executorOrderUnusable: boolean;
  diagnostics: RegisteredConfigDiagnostic[];
}

export interface RegisteredConfigDiagnostic {
  key: string;
  raw: string;
  effective: string;
  message: string;
}

const configuredEnv = (configText: string, key: string): string | null => {
  const value = fromTomlValue(readKey(configText, serverEnvTable(), key));
  return value;
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
  const diagnostics: RegisteredConfigDiagnostic[] = [];
  const rawVerifyMode = configuredEnv(configText, "SOL_LUNA_VERIFY_MODE");
  const normalizedVerifyMode = (rawVerifyMode ?? DEFAULT_VERIFY_MODE).toLowerCase();
  const verificationMode = (VERIFY_MODES as readonly string[]).includes(
    normalizedVerifyMode,
  )
    ? (normalizedVerifyMode as VerifyMode)
    : "allowlist";
  if (
    rawVerifyMode !== null &&
    !(VERIFY_MODES as readonly string[]).includes(normalizedVerifyMode)
  ) {
    diagnostics.push({
      key: "SOL_LUNA_VERIFY_MODE",
      raw: rawVerifyMode,
      effective: verificationMode,
      message: "unrecognized verification mode; runtime falls back to allowlist",
    });
  }

  const rawWorkerModel = configuredEnv(configText, "LUNA_MODEL");
  const workerModel = rawWorkerModel ?? DEFAULT_LUNA_MODEL;

  const rawMaxParallel = configuredEnv(configText, "SOL_LUNA_MAX_PARALLEL");
  const maxParallel = clampParallel(Number(rawMaxParallel ?? DEFAULT_MAX_PARALLEL));
  if (rawMaxParallel !== null && String(maxParallel) !== rawMaxParallel.trim()) {
    diagnostics.push({
      key: "SOL_LUNA_MAX_PARALLEL",
      raw: rawMaxParallel,
      effective: String(maxParallel),
      message:
        "value was invalid, fractional, or outside the supported concurrency range",
    });
  }

  const rawMaxWorkers = configuredEnv(configText, "SOL_LUNA_MAX_WORKERS_PER_BATCH");
  const maxWorkersPerBatch = clampBatchWorkers(Number(rawMaxWorkers ?? MAX_BATCH_SIZE));
  if (rawMaxWorkers !== null && String(maxWorkersPerBatch) !== rawMaxWorkers.trim()) {
    diagnostics.push({
      key: "SOL_LUNA_MAX_WORKERS_PER_BATCH",
      raw: rawMaxWorkers,
      effective: String(maxWorkersPerBatch),
      message:
        "value was invalid, fractional, or outside the supported batch-worker range",
    });
  }

  const rawAllowedEfforts = configuredEnv(configText, "SOL_LUNA_ALLOWED_EFFORTS");
  if (
    rawAllowedEfforts !== null &&
    (rawAllowedEfforts.trim().length === 0 || allowedEffortsInvalid(rawAllowedEfforts))
  ) {
    diagnostics.push({
      key: "SOL_LUNA_ALLOWED_EFFORTS",
      raw: rawAllowedEfforts ?? "",
      effective: parseAllowedEfforts(rawAllowedEfforts).join(","),
      message: "one or more effort names were unrecognized and were ignored",
    });
  }

  const rawWorkerTimeout = configuredEnv(configText, "LUNA_TIMEOUT_SECONDS");
  const workerTimeoutSeconds = parseTimeoutSeconds(
    rawWorkerTimeout ?? undefined,
    DEFAULT_TIMEOUT_SECONDS_FALLBACK,
  );
  if (timeoutSecondsInvalid(rawWorkerTimeout ?? undefined)) {
    diagnostics.push({
      key: "LUNA_TIMEOUT_SECONDS",
      raw: rawWorkerTimeout ?? "",
      effective: String(workerTimeoutSeconds),
      message: "timeout must be a finite positive number; runtime uses the default",
    });
  }

  const rawVerificationTimeout = configuredEnv(configText, "LUNA_VERIFY_TIMEOUT_SECONDS");
  const verificationTimeoutSeconds = parseTimeoutSeconds(
    rawVerificationTimeout ?? undefined,
    VERIFY_TIMEOUT_SECONDS_FALLBACK,
  );
  if (timeoutSecondsInvalid(rawVerificationTimeout ?? undefined)) {
    diagnostics.push({
      key: "LUNA_VERIFY_TIMEOUT_SECONDS",
      raw: rawVerificationTimeout ?? "",
      effective: String(verificationTimeoutSeconds),
      message: "timeout must be a finite positive number; runtime uses the default",
    });
  }

  const rawSandbox = configuredEnv(configText, "LUNA_SANDBOX");
  const workerSandbox = parseWorkerSandbox(rawSandbox ?? undefined);
  if (workerSandboxInvalid(rawSandbox ?? undefined)) {
    diagnostics.push({
      key: "LUNA_SANDBOX",
      raw: rawSandbox ?? "",
      effective: workerSandbox,
      message: "unrecognized sandbox mode; runtime falls back to read-only",
    });
  }

  const rawKeepWorktrees = configuredEnv(configText, "SOL_LUNA_KEEP_WORKTREES");
  const keepWorktrees = parseKeepWorktrees(rawKeepWorktrees ?? undefined);
  if (keepWorktreesInvalid(rawKeepWorktrees ?? undefined)) {
    diagnostics.push({
      key: "SOL_LUNA_KEEP_WORKTREES",
      raw: rawKeepWorktrees ?? "",
      effective: keepWorktrees,
      message: "unrecognized retention mode; runtime falls back to onFailure",
    });
  }

  const policyEnvironment: ComputePolicyEnvironment = {
    model: workerModel,
    allowedModels: parseAllowedModels(
      configuredEnv(configText, "SOL_LUNA_ALLOWED_MODELS"),
      workerModel,
    ),
    allowedEfforts: parseAllowedEfforts(
      configuredEnv(configText, "SOL_LUNA_ALLOWED_EFFORTS"),
    ),
    maxConcurrency: maxParallel,
    maxWorkersPerBatch,
    allowEffortEscalation: parseOptOutFlag(
      configuredEnv(configText, "SOL_LUNA_ALLOW_EFFORT_ESCALATION"),
    ),
    allowStrongerFallback: parseOptOutFlag(
      configuredEnv(configText, "SOL_LUNA_ALLOW_STRONGER_FALLBACK"),
    ),
    executorOrder: parseExecutorOrder(
      configuredEnv(configText, "SOL_LUNA_EXECUTOR_ORDER"),
    ),
  };

  return {
    workerModel,
    maxParallel,
    maxWorkersPerBatch,
    verificationMode,
    workerTimeoutSeconds,
    verificationTimeoutSeconds,
    workerSandbox,
    workerNetworkAccess: configuredEnv(configText, "LUNA_NETWORK_ACCESS") === "1",
    keepWorktrees,
    allowDirtyWorktreeBase: configuredEnv(configText, "SOL_LUNA_ALLOW_DIRTY") === "1",
    allowedRoots: configuredEnv(configText, "SOL_LUNA_ALLOWED_ROOTS"),
    recursionDisableTarget:
      configuredEnv(configText, "SOL_LUNA_SERVER_NAME") ??
      DEFAULT_ORCHESTRATOR_SERVER_NAME,
    computePolicy: buildComputePolicy(policyEnvironment),
    // A ladder the envelope cannot use is discarded rather than applied. Report
    // it here so `status` and `doctor` do not show a compute policy that quietly
    // lost the operator's declared fallback order.
    executorOrderUnusable: executorOrderDeclaredButUnusable(policyEnvironment),
    diagnostics,
  };
}
