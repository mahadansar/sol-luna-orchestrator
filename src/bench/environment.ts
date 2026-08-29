/**
 * Reproducibility evidence for a benchmark campaign.
 *
 * Every field is either an observed fact or `null`. The capture layer shells
 * out and reads files; the record builders are pure, so the committed shape can
 * be tested without a repository, a network, or an installed toolchain. Nothing
 * here estimates, defaults, or back-fills a value it could not read.
 *
 * The record has three deliberately separate layers, because they carry
 * different guarantees and a single "environment" blob would let the weakest of
 * them borrow the strongest one's credibility:
 *
 * 1. **Production-owned execution settings** — the named Sol-Luna and harness
 *    variables the shipped code reads. Values are recorded verbatim, and a
 *    deterministic source scan detects the direct-access forms it explicitly
 *    supports in the current production sources.
 * 2. **Ambient inherited environment** — every other variable this process
 *    inherited and therefore passes to the Codex SDK, the Codex CLI, and the
 *    orchestrator it launches. Names are recorded in full; values only where a
 *    name is explicitly classified as safe, and credential-shaped state is
 *    recorded as present-and-opaque rather than silently omitted.
 * 3. **Effective Codex configuration** — the non-secret identity of the
 *    configuration and authentication state a measured run executes under.
 *
 * `REPRODUCIBILITY_BOUNDARY` states in one place what these layers do and do
 * not establish. No layer claims to enumerate everything an inherited
 * environment can change.
 */
import { sync as spawnSync } from "cross-spawn";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parse as parseToml,
  stringify as stringifyToml,
  type TomlValue,
} from "smol-toml";
import {
  ExecutableResolutionError,
  resolveExecutable,
  withoutCwdExecutableLookup,
  type ResolveExecutableOptions,
} from "../executable.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..");

const sha256 = (value: string): string =>
  crypto.createHash("sha256").update(value, "utf8").digest("hex");

/** Locale-independent ordering, so a record is byte-identical everywhere. */
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/* -------------------------------------------------------------------------- */
/* Shared version derivation                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Read an installed package version relative to the repository root.
 *
 * One implementation for the runner, the environment probe, and the pre-launch
 * checkpoint. A second copy is how a checkpoint ends up recording `null` for a
 * version the runner reads without difficulty.
 */
export function readInstalledPackageVersion(...segments: string[]): string | null {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(PACKAGE_ROOT, ...segments, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

export const readRepositoryPackageVersion = (): string | null =>
  readInstalledPackageVersion();

/** The Codex SDK actually installed for this checkout, or null. */
export const readCodexSdkVersion = (): string | null =>
  readInstalledPackageVersion("node_modules", "@openai", "codex-sdk");

/* -------------------------------------------------------------------------- */
/* A. Production-owned execution settings                                      */
/* -------------------------------------------------------------------------- */

/**
 * Sol-Luna and harness variables the production sources read by name.
 *
 * This is the *production-owned* layer, not a claim about the whole inherited
 * environment. A listed key's value is recorded verbatim, so no name whose
 * value would be a credential may ever be added; ambient state that cannot be
 * recorded verbatim is handled by the ambient layer below.
 *
 * The list is derived from the production configuration a V3 run executes
 * under. Every delegation-enabled arm launches the shipped orchestrator through
 * Codex, which inherits this process's environment, so a variable the runtime
 * reads can change model choice, admission, routing, worktrees, verification,
 * timeouts, or context handling for a measured run. A production variable
 * deliberately not recorded belongs in `EXCLUDED_ENVIRONMENT_KEYS` with its
 * reason; `harness.test.ts` checks the direct `process.env` syntaxes it
 * explicitly supports. The scan is defense in depth, not a semantic proof of
 * every possible future access.
 *
 * It also proves nothing about computed or indirect reads, or variables read by
 * the Codex SDK, the Codex CLI, Node itself, or any other inherited consumer.
 * Those are the ambient layer's subject, and the distinction is load-bearing.
 */
export const RECORDED_ENVIRONMENT_KEYS = [
  // Harness bound on one live cell.
  "BENCH_TASK_TIMEOUT",
  // Codex configuration directory: model config, MCP registration, and auth.
  "CODEX_HOME",
  // Worker execution envelope.
  "LUNA_MODEL",
  "LUNA_NETWORK_ACCESS",
  "LUNA_SANDBOX",
  "LUNA_TIMEOUT_SECONDS",
  "LUNA_VERIFY_TIMEOUT_SECONDS",
  // Operator compute policy and admission.
  "SOL_LUNA_ALLOWED_EFFORTS",
  "SOL_LUNA_ALLOWED_MODELS",
  "SOL_LUNA_ALLOWED_ROOTS",
  "SOL_LUNA_ALLOW_DIRTY",
  "SOL_LUNA_ALLOW_EFFORT_ESCALATION",
  "SOL_LUNA_ALLOW_STRONGER_FALLBACK",
  "SOL_LUNA_EXECUTOR_ORDER",
  "SOL_LUNA_MAX_PARALLEL",
  "SOL_LUNA_MAX_WORKERS_PER_BATCH",
  // Context lifecycle thresholds.
  "SOL_LUNA_CONTEXT_COOLDOWN_TURNS",
  "SOL_LUNA_CONTEXT_MAX_BYTES",
  "SOL_LUNA_CONTEXT_MAX_CLEAN_TURNS",
  "SOL_LUNA_CONTEXT_MAX_TURNS",
  // Worktree lifecycle.
  "SOL_LUNA_KEEP_WORKTREES",
  "SOL_LUNA_WORKTREE_LINK",
  // Server identity: the name a solo arm disables and a worker isolates by.
  "SOL_LUNA_SERVER_NAME",
  // The recursive-delegation backstop. Set in the launching shell, it would
  // make an Adaptive arm refuse to delegate at all.
  "SOL_LUNA_WORKER",
  // Independent verification: whether, with what, and with which environment.
  "SOL_LUNA_VERIFY_ALLOW",
  "SOL_LUNA_VERIFY_ENV_PASSTHROUGH",
  "SOL_LUNA_VERIFY_MODE",
] as const;

export type RecordedEnvironmentKey = (typeof RECORDED_ENVIRONMENT_KEYS)[number];

/**
 * Production variables deliberately left out of the record, with the reason.
 *
 * Each entry is an argument that the variable cannot change what a V3 run
 * measures. Anything that can must be recorded instead; "noisy" and "long" are
 * not reasons. An excluded name still appears in the ambient name inventory, so
 * exclusion hides the value, never the fact that it was set.
 */
export const EXCLUDED_ENVIRONMENT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  SOL_LUNA_EVENTS:
    "Telemetry destination. The harness sets it explicitly in the orchestrator " +
    "configuration of every delegation-enabled arm, so an ambient value never " +
    "reaches the process under measurement, and a solo arm has no orchestrator " +
    "to read it. The effective path is recorded as campaign evidence instead.",
  SOL_LUNA_LOG:
    "Diagnostic log destination. It decides only where already-emitted stderr " +
    "text is teed, a failed append is swallowed, and it feeds no model, " +
    "admission, routing, verification, or grading decision.",
  NO_COLOR:
    "Terminal rendering in the CLI surface. A benchmark cell drives the MCP " +
    "server and the Codex SDK; no CLI renderer participates in a measured run.",
  TERM:
    "Terminal rendering in the CLI surface. A benchmark cell drives the MCP " +
    "server and the Codex SDK; no CLI renderer participates in a measured run.",
  TERM_PROGRAM:
    "Terminal capability detection in the CLI surface only; no measured run " +
    "renders CLI output.",
  WT_SESSION:
    "Terminal capability detection in the CLI surface only; no measured run " +
    "renders CLI output.",
});

/**
 * Names whose *value* would be a credential. Recording one verbatim is a leak
 * even if the variable is execution-affecting, so neither the production
 * allowlist nor the ambient safe-value lists may contain one.
 */
export const SECRET_SHAPED_ENVIRONMENT_NAME =
  /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION_ID)/i;

/* -------------------------------------------------------------------------- */
/* B. Ambient inherited environment                                            */
/* -------------------------------------------------------------------------- */

/**
 * How one ambient variable's value is represented in the record.
 *
 * `presence-only` and `credential-opaque` are the honest answers rather than
 * the missing ones: the variable was set, a measured run may have been affected
 * by it, and its value is deliberately not reproducible from this record.
 */
export const AMBIENT_REPRESENTATIONS = [
  "production-owned",
  "verbatim",
  "url-redacted",
  "trust-material-fingerprint",
  "presence-only",
  "credential-opaque",
] as const;
export type AmbientRepresentation = (typeof AMBIENT_REPRESENTATIONS)[number];

/**
 * Ambient names whose raw value is safe to persist and materially changes
 * execution.
 *
 * Matched case-insensitively, so the lowercase spellings of the proxy and
 * locale conventions are covered by the same entry. Every name here is a
 * setting, never an identity or a secret: `NODE_TLS_REJECT_UNAUTHORIZED` alone
 * can disable certificate validation for an entire campaign, and a record that
 * hid it would be describing a different run than the one that happened.
 */
export const AMBIENT_VERBATIM_ENVIRONMENT_KEYS = [
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "NODE_NO_WARNINGS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "NO_PROXY",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "TZ",
  "UV_THREADPOOL_SIZE",
  "UV_USE_IO_URING",
] as const;

/**
 * Ambient names whose value is a URL.
 *
 * A proxy URL routinely embeds `user:password@`, so the raw value is never
 * persisted. The record keeps the parts that identify the route — scheme, host,
 * port — and states whether credentials were embedded, which is itself a
 * reproducibility fact worth knowing.
 */
export const AMBIENT_URL_ENVIRONMENT_KEYS = [
  "ALL_PROXY",
  "FTP_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NPM_CONFIG_REGISTRY",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  "PROXY",
] as const;

/**
 * Ambient names whose value is a certificate or trust-configuration path.
 *
 * The path is a filesystem layout and is fingerprinted rather than copied; what
 * matters for reproducibility is which trust material was in effect, so the
 * file's own digest and size are recorded instead of its location.
 */
export const AMBIENT_PATH_ENVIRONMENT_KEYS = [
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
] as const;

export interface FileFingerprint {
  /** False when nothing looked; `exists` is then unknown, not "absent". */
  readonly inspected: boolean;
  readonly exists: boolean | null;
  readonly readable: boolean | null;
  readonly fileType: "file" | "directory" | "other" | null;
  readonly byteLength: number | null;
  readonly sha256: string | null;
}

export const UNINSPECTED_FILE: FileFingerprint = Object.freeze({
  inspected: false,
  exists: null,
  readable: null,
  fileType: null,
  byteLength: null,
  sha256: null,
});

export interface RedactedUrl {
  readonly parsed: boolean;
  readonly protocol: string | null;
  readonly hostname: string | null;
  readonly port: string | null;
  readonly hasPath: boolean | null;
  readonly hasQuery: boolean | null;
  /** True when the raw value carried `user:password@`; the pair is discarded. */
  readonly embeddedCredentials: boolean | null;
}

export interface TrustMaterialFingerprint {
  /** The variable was set. Its path is deliberately not retained. */
  readonly configured: true;
  readonly file: FileFingerprint;
}

export interface AmbientEnvironmentEntry {
  readonly name: string;
  readonly representation: AmbientRepresentation;
  /** Present only for `verbatim`. */
  readonly value?: string;
  /** Present only for `url-redacted`. */
  readonly url?: RedactedUrl;
  /** Present only for `trust-material-fingerprint`. */
  readonly trustMaterial?: TrustMaterialFingerprint;
}

export interface AmbientEnvironmentRecord {
  /** Every inherited variable name, sorted. Names only — never a dump. */
  readonly names: readonly string[];
  readonly nameCount: number;
  /** Lets two records be compared for ambient drift in a single field. */
  readonly namesSha256: string;
  readonly entries: readonly AmbientEnvironmentEntry[];
  readonly counts: Readonly<Record<AmbientRepresentation, number>>;
  /** Set, potentially execution-relevant, and deliberately not reproducible. */
  readonly credentialShapedNames: readonly string[];
  readonly opaqueValueCount: number;
}

/** Split a URL without ever keeping its userinfo. */
export function redactUrlValue(raw: string): RedactedUrl {
  try {
    const url = new URL(raw);
    return {
      parsed: true,
      protocol: url.protocol.replace(/:$/, ""),
      hostname: url.hostname === "" ? null : url.hostname,
      port: url.port === "" ? null : url.port,
      hasPath: url.pathname !== "" && url.pathname !== "/",
      hasQuery: url.search !== "",
      embeddedCredentials: url.username !== "" || url.password !== "",
    };
  } catch {
    // An unparseable value is reported as unparseable and never echoed: "not a
    // URL" does not imply "not a credential".
    return {
      parsed: false,
      protocol: null,
      hostname: null,
      port: null,
      hasPath: null,
      hasQuery: null,
      embeddedCredentials: null,
    };
  }
}

const upperCased = (keys: readonly string[]): ReadonlySet<string> =>
  new Set(keys.map((key) => key.toUpperCase()));

const AMBIENT_VERBATIM = upperCased(AMBIENT_VERBATIM_ENVIRONMENT_KEYS);
const AMBIENT_URL = upperCased(AMBIENT_URL_ENVIRONMENT_KEYS);
const AMBIENT_PATH = upperCased(AMBIENT_PATH_ENVIRONMENT_KEYS);
const PRODUCTION_OWNED = new Set<string>(RECORDED_ENVIRONMENT_KEYS);

/**
 * Decide how one ambient name may be represented.
 *
 * Order matters. Production ownership comes first so the production layer stays
 * authoritative, then the credential test, so a name like `PROXY_AUTH_TOKEN`
 * can never fall through to a safe-value list.
 */
export function classifyAmbientName(name: string): AmbientRepresentation {
  if (PRODUCTION_OWNED.has(name)) return "production-owned";
  if (SECRET_SHAPED_ENVIRONMENT_NAME.test(name)) return "credential-opaque";
  const upper = name.toUpperCase();
  if (AMBIENT_URL.has(upper)) return "url-redacted";
  if (AMBIENT_PATH.has(upper)) return "trust-material-fingerprint";
  if (AMBIENT_VERBATIM.has(upper)) return "verbatim";
  return "presence-only";
}

/**
 * Turn an inherited environment into a safe, deterministic inventory.
 *
 * Pure apart from the injected `fingerprint`, which is the only part that
 * touches the filesystem, so the classification rules are testable without one.
 */
export function classifyAmbientEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  fingerprint: (filePath: string) => FileFingerprint = () => UNINSPECTED_FILE,
): AmbientEnvironmentRecord {
  const names = Object.keys(env)
    .filter((name) => typeof env[name] === "string")
    .sort(byCodePoint);

  const counts: Record<AmbientRepresentation, number> = {
    "production-owned": 0,
    verbatim: 0,
    "url-redacted": 0,
    "trust-material-fingerprint": 0,
    "presence-only": 0,
    "credential-opaque": 0,
  };

  const entries: AmbientEnvironmentEntry[] = names.map((name) => {
    const representation = classifyAmbientName(name);
    counts[representation] += 1;
    const raw = env[name] as string;
    if (representation === "verbatim") return { name, representation, value: raw };
    if (representation === "url-redacted") {
      return { name, representation, url: redactUrlValue(raw) };
    }
    if (representation === "trust-material-fingerprint") {
      const normalized = path.normalize(raw);
      return {
        name,
        representation,
        trustMaterial: {
          configured: true,
          file: fingerprint(normalized),
        },
      };
    }
    return { name, representation };
  });

  return {
    names,
    nameCount: names.length,
    namesSha256: sha256(names.join("\n")),
    entries,
    counts,
    credentialShapedNames: names.filter((name) =>
      SECRET_SHAPED_ENVIRONMENT_NAME.test(name),
    ),
    opaqueValueCount: counts["presence-only"] + counts["credential-opaque"],
  };
}

/** Fingerprint one file for the record. Unreadable is `null`, never zero. */
export function fingerprintFile(filePath: string): FileFingerprint {
  try {
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      fs.readdirSync(filePath);
      return {
        inspected: true,
        exists: true,
        readable: true,
        fileType: "directory",
        byteLength: null,
        sha256: null,
      };
    }
    if (!stats.isFile()) {
      return {
        inspected: true,
        exists: true,
        readable: null,
        fileType: "other",
        byteLength: null,
        sha256: null,
      };
    }
    const bytes = fs.readFileSync(filePath);
    return {
      inspected: true,
      exists: true,
      readable: true,
      fileType: "file",
      byteLength: bytes.byteLength,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    const missing =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      ((error as { code?: unknown }).code === "ENOENT" ||
        (error as { code?: unknown }).code === "ENOTDIR");
    return {
      inspected: true,
      exists: missing ? false : null,
      readable: missing ? null : false,
      fileType: null,
      byteLength: null,
      sha256: null,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* C. Effective Codex configuration                                            */
/* -------------------------------------------------------------------------- */

/** Assignment keys inside `config.toml` whose value must never be persisted. */
export const CODEX_SECRET_PATH_SEGMENT =
  /(?:key|token|secret|password|passwd|credential|auth|cookie|bearer|headers?)/i;

export const CODEX_REDACTION_PLACEHOLDER = "<redacted>" as const;

export interface CodexConfigProbe {
  /** Resolved configuration directory, or null when it could not be resolved. */
  readonly home: string | null;
  readonly homeSource: "CODEX_HOME" | "default" | "unknown";
  readonly homeIsDefaultLocation: boolean | null;
  /** Raw text, used only to derive the redacted digest below. Never stored. */
  readonly configToml: string | null;
  /** Raw text, used only to derive an auth *mode*. Never stored. */
  readonly authJson: string | null;
}

export interface CodexConfigRecord {
  readonly homeSource: CodexConfigProbe["homeSource"];
  readonly homeIsDefaultLocation: boolean | null;
  readonly config: {
    readonly present: boolean;
    readonly parsed: boolean | null;
    /** Digest of the canonical structure after secret-shaped values are removed. */
    readonly redactedCanonicalSha256: string | null;
    readonly redactedAssignments: number | null;
    readonly mcpServerNames: readonly string[];
    readonly representation: "parsed-recursive-redacted-canonical-digest";
  };
  readonly auth: {
    readonly present: boolean;
    readonly mode: "api-key" | "chatgpt" | "unknown" | "absent";
    readonly containsSecretMaterial: boolean | null;
    readonly representation: "presence-and-mode-only";
  };
}

export interface RedactedCodexConfig {
  readonly canonical: string;
  readonly redactedAssignments: number;
  readonly mcpServerNames: readonly string[];
}

/**
 * Parse, recursively sanitize, and canonicalize a `config.toml`.
 *
 * Canonicalization removes what cannot change execution — line endings,
 * trailing whitespace, blank lines, comment-only lines — so the digest tracks
 * effective configuration rather than formatting. Structural redaction reaches
 * inline tables, arrays of tables, multiline values, and nested sensitive keys.
 * Header-bearing structures are conservatively replaced as a whole.
 */
export function redactCodexConfigToml(text: string): RedactedCodexConfig {
  let parsed: Record<string, TomlValue>;
  try {
    parsed = parseToml(text, { integersAsBigInt: "asNeeded" });
  } catch {
    // smol-toml diagnostics may quote the offending input. This exported
    // boundary must never let parser excerpts or secret-bearing lines escape.
    throw new Error("Codex config TOML could not be parsed");
  }
  let redactedAssignments = 0;

  const sanitize = (value: TomlValue, segments: readonly string[]): TomlValue => {
    if (segments.some((segment) => CODEX_SECRET_PATH_SEGMENT.test(segment))) {
      redactedAssignments += 1;
      return CODEX_REDACTION_PLACEHOLDER;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => sanitize(entry, segments));
    }
    if (value instanceof Date) return value;
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => byCodePoint(left, right))
          .map(([key, child]) => [key, sanitize(child as TomlValue, [...segments, key])]),
      );
    }
    return value;
  };

  const sanitized = sanitize(parsed, []) as Record<string, TomlValue>;
  const mcpServers = parsed["mcp_servers"];
  const servers =
    mcpServers !== null &&
    typeof mcpServers === "object" &&
    !Array.isArray(mcpServers) &&
    !(mcpServers instanceof Date)
      ? Object.keys(mcpServers).sort(byCodePoint)
      : [];
  const canonical = stringifyToml(sanitized).replace(/\r\n/g, "\n").trimEnd();

  return {
    canonical,
    redactedAssignments,
    mcpServerNames: servers,
  };
}

/**
 * Derive the authentication *mode* without touching the credential.
 *
 * `auth.json` holds either an API key or a ChatGPT token set. Which one is in
 * effect changes how a run authenticates and is worth recording; neither value
 * is, so the record states the mode and that secret material is present.
 */
export function classifyCodexAuth(text: string | null): CodexConfigRecord["auth"] {
  if (text === null) {
    return {
      present: false,
      mode: "absent",
      containsSecretMaterial: null,
      representation: "presence-and-mode-only",
    };
  }
  let mode: CodexConfigRecord["auth"]["mode"] = "unknown";
  // An unparseable auth file is still credential-bearing state that exists, so
  // the pessimistic default stands unless parsing proves otherwise.
  let secret = true;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const apiKey = parsed["OPENAI_API_KEY"];
    const tokens = parsed["tokens"];
    const hasApiKey = typeof apiKey === "string" && apiKey.trim() !== "";
    const hasTokens = tokens !== null && typeof tokens === "object";
    if (hasApiKey) mode = "api-key";
    else if (hasTokens) mode = "chatgpt";
    secret = hasApiKey || hasTokens;
  } catch {
    mode = "unknown";
  }
  return {
    present: true,
    mode,
    containsSecretMaterial: secret,
    representation: "presence-and-mode-only",
  };
}

/** Pure: turn Codex configuration readings into a committable record. */
export function buildCodexConfigRecord(probe: CodexConfigProbe): CodexConfigRecord {
  let redacted: RedactedCodexConfig | null = null;
  let parsed: boolean | null = probe.configToml === null ? null : false;
  if (probe.configToml !== null) {
    try {
      redacted = redactCodexConfigToml(probe.configToml);
      parsed = true;
    } catch {
      // A parse failure may contain arbitrary credential text. Record presence
      // and failure only; never hash or serialize the unsanitized bytes.
      redacted = null;
    }
  }
  return {
    homeSource: probe.homeSource,
    homeIsDefaultLocation: probe.homeIsDefaultLocation,
    config: {
      present: probe.configToml !== null,
      parsed,
      redactedCanonicalSha256: redacted === null ? null : sha256(redacted.canonical),
      redactedAssignments: redacted === null ? null : redacted.redactedAssignments,
      mcpServerNames: redacted === null ? [] : [...redacted.mcpServerNames],
      representation: "parsed-recursive-redacted-canonical-digest",
    },
    auth: classifyCodexAuth(probe.authJson),
  };
}

const isDefaultCodexHome = (home: string, homedir: () => string): boolean | null => {
  try {
    return path.resolve(home) === path.resolve(path.join(homedir(), ".codex"));
  } catch {
    return null;
  }
};

/** Read the effective Codex configuration directory without keeping secrets. */
export function captureCodexConfigProbe(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homedir: () => string = os.homedir,
): CodexConfigProbe {
  const configured = env["CODEX_HOME"];
  let home: string | null = null;
  let homeSource: CodexConfigProbe["homeSource"] = "unknown";
  if (typeof configured === "string" && configured.trim() !== "") {
    home = path.normalize(configured.trim());
    homeSource = "CODEX_HOME";
  } else {
    try {
      home = path.join(homedir(), ".codex");
      homeSource = "default";
    } catch {
      home = null;
    }
  }

  const read = (name: string): string | null => {
    if (home === null) return null;
    try {
      return fs.readFileSync(path.join(home, name), "utf8");
    } catch {
      return null;
    }
  };

  const configToml = read("config.toml");
  return {
    home,
    homeSource,
    homeIsDefaultLocation: home === null ? null : isDefaultCodexHome(home, homedir),
    configToml,
    authJson: read("auth.json"),
  };
}

/* -------------------------------------------------------------------------- */
/* D. The reproducibility boundary, stated once                                */
/* -------------------------------------------------------------------------- */

/**
 * What the record does and does not establish.
 *
 * Committed verbatim into every campaign record so a reader never has to infer
 * the boundary from which fields happen to be present. The benchmark's claim is
 * that ambient state is *visible and classified*, not that it is *fully
 * captured*: an inherited environment feeds a Codex SDK, a Codex CLI, a Node
 * runtime, and an operating system whose reads this repository cannot
 * enumerate.
 */
export const REPRODUCIBILITY_BOUNDARY = Object.freeze({
  captured: Object.freeze([
    "Every named Sol-Luna and harness execution setting in the maintained " +
      "inventory, recorded verbatim, with a defense-in-depth source scan that " +
      "detects the explicitly supported direct process.env access patterns.",
    "The complete sorted name inventory of the inherited environment, so ambient " +
      "state is never silently invisible, plus a digest of that inventory for " +
      "run-to-run comparison.",
    "Values for ambient names explicitly classified as safe and " +
      "reproducibility-relevant; proxy and endpoint URLs as scheme/host/port with " +
      "an embedded-credential flag; explicitly safe certificate and trust " +
      "variables as presence, readability, file category, and content digest " +
      "where readable, without any path metadata.",
    "The non-secret identity of the effective Codex configuration: a digest of " +
      "the canonical config.toml with secret-shaped assignments redacted, its " +
      "registered MCP server names, and the authentication mode.",
    "Git commit, branch, describe, and working-tree cleanliness; Node, platform, " +
      "architecture, OS release, CPU, memory, and timezone; package, npm, Codex " +
      "CLI, and Codex SDK versions; and the exact invocation.",
  ]),
  notCaptured: Object.freeze([
    "Raw values of ambient variables that are not explicitly classified as safe. " +
      "They are recorded as present-and-opaque, not omitted.",
    "Any credential: API keys, tokens, passwords, cookies, authorization headers, " +
      "proxy userinfo, and the contents of auth.json. Presence is recorded, value " +
      "never is, so a run authenticated by a rotated or different credential is " +
      "not distinguishable from this record alone.",
    "Environment reads outside the source scan's explicitly supported syntactic " +
      "forms, including computed or indirect future repository reads, plus reads " +
      "performed by the Codex SDK, the Codex CLI, Node, or the operating system.",
    "Machine and account state outside the environment: installed system " +
      "certificates, network policy, DNS, clock skew, and provider-side model or " +
      "account configuration.",
  ]),
  statement:
    "The maintained allowlist plus a syntactic defense-in-depth scan records the " +
    "repository-owned settings in the explicitly supported access forms; it is " +
    "not a proof of every possible environment read. It does not prove the " +
    "inherited runtime environment is fully captured. Ambient and credential " +
    "state is surfaced as present-and-opaque so an unreproducible difference " +
    "between two runs is visible rather than hidden.",
});

/* -------------------------------------------------------------------------- */
/* Probe and record                                                            */
/* -------------------------------------------------------------------------- */

/** Raw readings handed to the pure builder. Unknown is null, never a guess. */
export interface EnvironmentProbe {
  readonly capturedAt: string;
  readonly gitCommit: string | null;
  readonly gitBranch: string | null;
  readonly gitStatusPorcelain: string | null;
  readonly gitDescribe: string | null;
  readonly nodeVersion: string | null;
  readonly npmVersion: string | null;
  readonly codexCliVersion: string | null;
  readonly codexSdkVersion: string | null;
  readonly packageVersion: string | null;
  readonly platform: string | null;
  readonly arch: string | null;
  readonly osRelease: string | null;
  readonly cpuCount: number | null;
  readonly totalMemoryBytes: number | null;
  readonly timezone: string | null;
  readonly argv: readonly string[];
  readonly cwd: string | null;
  readonly environment: Readonly<Partial<Record<RecordedEnvironmentKey, string>>>;
  /**
   * Already classified by the capture layer, so no raw ambient value ever
   * reaches a probe, a record, or a committed file. Optional so a test can
   * build a record from production-owned facts alone.
   */
  readonly ambient?: AmbientEnvironmentRecord;
  readonly codex?: CodexConfigRecord;
}

export interface EnvironmentRecord {
  readonly capturedAt: string;
  readonly git: {
    readonly commit: string | null;
    readonly branch: string | null;
    readonly describe: string | null;
    /** Null when `git status` itself could not be read. */
    readonly workingTreeClean: boolean | null;
    readonly dirtyPathCount: number | null;
  };
  readonly runtime: {
    readonly nodeVersion: string | null;
    readonly platform: string | null;
    readonly arch: string | null;
    readonly osRelease: string | null;
    readonly cpuCount: number | null;
    readonly totalMemoryBytes: number | null;
    readonly timezone: string | null;
  };
  readonly toolchain: {
    readonly packageVersion: string | null;
    readonly npmVersion: string | null;
    readonly codexCliVersion: string | null;
    readonly codexSdkVersion: string | null;
  };
  readonly invocation: {
    readonly argv: readonly string[];
    readonly cwd: string | null;
  };
  /** Production-owned settings: only allowlisted keys, and only those set. */
  readonly environment: Readonly<Partial<Record<RecordedEnvironmentKey, string>>>;
  /** Ambient inherited state: every name, safe values only. */
  readonly ambient: AmbientEnvironmentRecord;
  /** Non-secret identity of the effective Codex configuration. */
  readonly codex: CodexConfigRecord;
  /** What this record does and does not establish, stated in the record. */
  readonly boundary: typeof REPRODUCIBILITY_BOUNDARY;
}

const text = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const count = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** An inventory that was never captured, distinct from an empty environment. */
export const UNCAPTURED_AMBIENT_ENVIRONMENT: AmbientEnvironmentRecord =
  classifyAmbientEnvironment({});

export const UNCAPTURED_CODEX_CONFIG: CodexConfigRecord = buildCodexConfigRecord({
  home: null,
  homeSource: "unknown",
  homeIsDefaultLocation: null,
  configToml: null,
  authJson: null,
});

/** Turn one probe into the committed record. Pure: no environment access. */
export function buildEnvironmentRecord(probe: EnvironmentProbe): EnvironmentRecord {
  const porcelain = probe.gitStatusPorcelain;
  const dirtyPaths =
    typeof porcelain === "string"
      ? porcelain
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : null;
  return {
    capturedAt: probe.capturedAt,
    git: {
      commit: text(probe.gitCommit),
      branch: text(probe.gitBranch),
      describe: text(probe.gitDescribe),
      workingTreeClean: dirtyPaths === null ? null : dirtyPaths.length === 0,
      dirtyPathCount: dirtyPaths === null ? null : dirtyPaths.length,
    },
    runtime: {
      nodeVersion: text(probe.nodeVersion),
      platform: text(probe.platform),
      arch: text(probe.arch),
      osRelease: text(probe.osRelease),
      cpuCount: count(probe.cpuCount),
      totalMemoryBytes: count(probe.totalMemoryBytes),
      timezone: text(probe.timezone),
    },
    toolchain: {
      packageVersion: text(probe.packageVersion),
      npmVersion: text(probe.npmVersion),
      codexCliVersion: text(probe.codexCliVersion),
      codexSdkVersion: text(probe.codexSdkVersion),
    },
    invocation: {
      argv: [...probe.argv],
      cwd: text(probe.cwd),
    },
    environment: Object.fromEntries(
      RECORDED_ENVIRONMENT_KEYS.filter(
        (key) => text(probe.environment[key]) !== null,
      ).map((key) => [key, probe.environment[key] as string]),
    ),
    ambient: probe.ambient ?? UNCAPTURED_AMBIENT_ENVIRONMENT,
    codex: probe.codex ?? UNCAPTURED_CODEX_CONFIG,
    boundary: REPRODUCIBILITY_BOUNDARY,
  };
}

/**
 * Reproducibility fields a live campaign may not launch without.
 *
 * A benchmark whose commit, branch, runtime, or invocation is unknown cannot be
 * audited later, so the launch fails loudly here rather than producing evidence
 * that quietly cannot be reproduced. The Codex SDK version is required for the
 * same reason: it is the library that drives every measured turn, it is
 * deterministically readable from the installed dependency tree, and a record
 * that says `null` for it is recording a gap that does not exist.
 */
export const REQUIRED_ENVIRONMENT_FIELDS = [
  "git.commit",
  "git.branch",
  "git.workingTreeClean",
  "runtime.nodeVersion",
  "runtime.platform",
  "runtime.arch",
  "toolchain.packageVersion",
  "toolchain.codexSdkVersion",
  "invocation.cwd",
] as const;

export type RequiredEnvironmentField = (typeof REQUIRED_ENVIRONMENT_FIELDS)[number];

export function missingEnvironmentEvidence(
  record: EnvironmentRecord,
): RequiredEnvironmentField[] {
  const values: Record<RequiredEnvironmentField, unknown> = {
    "git.commit": record.git.commit,
    "git.branch": record.git.branch,
    "git.workingTreeClean": record.git.workingTreeClean,
    "runtime.nodeVersion": record.runtime.nodeVersion,
    "runtime.platform": record.runtime.platform,
    "runtime.arch": record.runtime.arch,
    "toolchain.packageVersion": record.toolchain.packageVersion,
    "toolchain.codexSdkVersion": record.toolchain.codexSdkVersion,
    "invocation.cwd": record.invocation.cwd,
  };
  return REQUIRED_ENVIRONMENT_FIELDS.filter(
    (field) => values[field] === null || values[field] === undefined,
  );
}

/**
 * Refuse to launch without auditable provenance.
 *
 * A dirty working tree is rejected for a holdout campaign because the recorded
 * commit would then not describe the code that actually ran.
 */
export function assertEnvironmentEvidence(
  record: EnvironmentRecord,
  options: { requireCleanWorkingTree?: boolean; requireAmbientInventory?: boolean } = {},
): void {
  const missing = missingEnvironmentEvidence(record);
  if (missing.length > 0) {
    throw new Error(
      `Benchmark launch requires reproducibility evidence; unavailable: ${missing.join(", ")}`,
    );
  }
  // An absent inventory means the capture layer did not run. That is not the
  // same fact as an empty environment and must not be recorded as if it were.
  if (options.requireAmbientInventory && record.ambient.nameCount === 0) {
    throw new Error(
      "Benchmark launch requires the ambient environment inventory; none was " +
        "captured, and an absent inventory is not evidence of an empty environment",
    );
  }
  if (options.requireCleanWorkingTree && record.git.workingTreeClean !== true) {
    throw new Error(
      `Benchmark launch requires a clean working tree; ${
        record.git.dirtyPathCount ?? "unknown"
      } path(s) differ from the recorded commit`,
    );
  }
}

/**
 * Resolve a tool the capture probe wants to run, from `PATH` only.
 *
 * The benchmark shells out to `git`, `npm`, and `codex` to record what a
 * campaign ran under. A bare name is not safe to hand a launcher: on Windows
 * both `cmd.exe` and libuv search the *current directory* ahead of `PATH`
 * unless `NoDefaultCurrentDirectoryInExePath` is set, and on POSIX the same
 * happens whenever `PATH` holds `.` or an empty entry. Evidence collection that
 * a file sitting in the directory being audited can answer is not evidence, so
 * the benchmark uses the production resolver unchanged — `PATH` only, current
 * directory never searched, absolute path handed to the launcher — exactly as
 * `git.ts` and `verify.ts` do. The production resolver is not relaxed to suit
 * the benchmark.
 *
 * An unresolvable tool is a `null` reading rather than a failure: the
 * methodology records each toolchain version as read or as `null`.
 */
export function resolveBenchExecutable(
  file: string,
  options: ResolveExecutableOptions = {},
): string | null {
  try {
    return resolveExecutable(file, options);
  } catch (error) {
    if (error instanceof ExecutableResolutionError) return null;
    throw error;
  }
}

/**
 * Run one resolved tool and return its stdout, or null.
 *
 * `cross-spawn` rather than `execFileSync`, matching `verify.ts`: `npm` and
 * `codex` are `.cmd` shims on Windows, which Node refuses to launch without a
 * shell, and which therefore recorded as unreadable on exactly the platform
 * this runs on. The launcher receives the absolute resolved path, and the child
 * environment pins off current-directory executable lookup so the nested
 * lookups inside a `.cmd` shim cannot be answered from the working directory
 * either.
 */
export const readToolOutput = (
  file: string,
  args: readonly string[],
  options: { cwd?: string } = {},
): string | null => {
  const env = withoutCwdExecutableLookup(process.env);
  const resolved = resolveBenchExecutable(file, { env });
  if (resolved === null) return null;
  try {
    const result = spawnSync(resolved, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
      env,
    });
    if (result.error || result.status !== 0) return null;
    return typeof result.stdout === "string" ? result.stdout : null;
  } catch {
    return null;
  }
};

/** Read the live environment. The only impure function in this module. */
export function captureEnvironmentProbe(
  options: {
    cwd?: string;
    argv?: readonly string[];
    packageVersion?: string | null;
    codexSdkVersion?: string | null;
  } = {},
): EnvironmentProbe {
  const environment: Partial<Record<RecordedEnvironmentKey, string>> = {};
  for (const key of RECORDED_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim() !== "") environment[key] = value;
  }
  return {
    capturedAt: new Date().toISOString(),
    gitCommit: readToolOutput("git", ["rev-parse", "HEAD"]),
    gitBranch: readToolOutput("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitStatusPorcelain: readToolOutput("git", ["status", "--porcelain"]),
    gitDescribe: readToolOutput("git", ["describe", "--always", "--dirty", "--tags"]),
    nodeVersion: process.version,
    npmVersion: readToolOutput("npm", ["--version"]),
    codexCliVersion: readToolOutput("codex", ["--version"]),
    // Shared with the runner rather than passed in: a checkpoint must never
    // record null for a version the campaign itself reads without difficulty.
    codexSdkVersion: options.codexSdkVersion ?? readCodexSdkVersion(),
    packageVersion: options.packageVersion ?? readRepositoryPackageVersion(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    argv: options.argv ?? process.argv.slice(2),
    cwd: options.cwd ?? process.cwd(),
    environment,
    // Classified here, so the raw inherited values never leave this function.
    ambient: classifyAmbientEnvironment(process.env, fingerprintFile),
    codex: buildCodexConfigRecord(captureCodexConfigProbe()),
  };
}

export const captureEnvironmentRecord = (
  options: Parameters<typeof captureEnvironmentProbe>[0] = {},
): EnvironmentRecord => buildEnvironmentRecord(captureEnvironmentProbe(options));
