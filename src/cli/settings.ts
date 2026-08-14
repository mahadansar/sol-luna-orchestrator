import { readKey } from "./toml-edit.js";

/**
 * The settings this project needs in Codex's config, and why.
 *
 * Kept in one place so `init` writes exactly what `doctor` checks — a drift
 * between those two is the classic way a setup tool starts lying to people.
 */

export const SERVER_NAME = process.env.SOL_LUNA_SERVER_NAME ?? "sol-luna-orchestrator";

export const serverTable = (name = SERVER_NAME): string[] => ["mcp_servers", name];
export const serverEnvTable = (name = SERVER_NAME): string[] => [
  "mcp_servers",
  name,
  "env",
];

export interface RequiredSetting {
  key: string;
  value: number | string;
  /** Rendered form used when comparing what is already in the file. */
  expected: string;
  required: boolean;
  why: string;
  comment?: string[];
}

/**
 * Codex settings that must be present for delegation to work at all.
 *
 * Both of the required ones were found the hard way: the default 60s tool
 * timeout aborts every delegation mid-flight, and `default_tools_approval_mode`
 * must be `"approve"` because `"auto"` causes non-interactive runs to cancel the
 * call outright despite its name.
 */
export const REQUIRED_SETTINGS: RequiredSetting[] = [
  {
    key: "tool_timeout_sec",
    value: 3600,
    expected: "3600",
    required: true,
    why: "Codex defaults to 60s, which aborts every real delegation mid-flight.",
    comment: ["A delegated task runs for minutes. Codex's 60s default would abort it."],
  },
  {
    key: "default_tools_approval_mode",
    value: "approve",
    expected: '"approve"',
    required: true,
    why: 'Without it Codex reports "user cancelled MCP tool call". "auto" does not work.',
    comment: ["Permit the delegation tools without prompting on every call."],
  },
  {
    key: "startup_timeout_sec",
    value: 30,
    expected: "30",
    required: false,
    why: "Headroom over the 10s default; the server starts in well under a second.",
  },
];

export type SettingState = "ok" | "wrong" | "missing";

export interface SettingCheck {
  key: string;
  state: SettingState;
  actual: string | null;
  expected: string;
  required: boolean;
  why: string;
}

/** Compare what is in the config against what this project needs. */
export function inspectSettings(configText: string, name = SERVER_NAME): SettingCheck[] {
  const table = serverTable(name);

  return REQUIRED_SETTINGS.map((setting) => {
    const actual = readKey(configText, table, setting.key);
    const state: SettingState =
      actual === null ? "missing" : actual === setting.expected ? "ok" : "wrong";
    return {
      key: setting.key,
      state,
      actual,
      expected: setting.expected,
      required: setting.required,
      why: setting.why,
    };
  });
}

/** True when every required setting is correct. Optional ones may be missing. */
export const settingsSatisfied = (checks: SettingCheck[]): boolean =>
  checks.every((check) => check.state === "ok" || !check.required);
