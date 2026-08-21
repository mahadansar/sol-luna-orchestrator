/**
 * How the supervisor waits for a delegated batch, and how that wait is measured.
 *
 * Why this file exists. A width-6 and a width-12 delegated run were not
 * comparable, and the reason had nothing to do with width. Both made exactly one
 * `delegate_tasks` MCP call; both asked for `resultDetail: "compact"`; neither
 * had a worker, provider or integration failure. What differed was how often the
 * supervisor woke itself up while the call was outstanding:
 *
 *   width 6   worker window 181s   4 `wait` turns at yield_time_ms 55,000
 *   width 12  worker window 424s  34 `wait` turns, mostly yield_time_ms 10,000
 *
 * Parent input went 174,664 -> 785,750 (4.5x) while the result actually returned
 * over the boundary grew 26,931 -> 42,267 characters (1.6x). Parent output barely
 * moved (3,487 -> 4,340). Almost the whole difference was the supervisor being
 * re-sampled, with the full transcript as input, once per poll.
 *
 * Where the polls come from. `gpt-5.6-sol` is `tool_mode: "code_mode_only"` in
 * Codex's model catalog, so MCP tools are not function tools it can call: they
 * are reachable only as `tools.*` inside a `functions.exec` code cell. A cell
 * that is still running when its `yield_time_ms` elapses yields, and resuming it
 * requires a model-visible `wait` call. Both the cell's pragma yield and every
 * `wait`'s yield are chosen by the model, and Codex's own defaults are small:
 * the documented pragma example is 10,000 ms and `wait` defaults to 10,000 ms.
 * The base instructions also tell the model to avoid blocking for more than 60
 * seconds, which is why width 6 landed on 55,000. Nothing in the harness, the
 * Codex CLI config surface, or `@openai/codex-sdk` chooses those numbers, and
 * the SDK gives a host no way to answer a `wait` on the model's behalf: it
 * writes the prompt to `codex exec`'s stdin, closes it, and reads JSONL back.
 *
 * So the wait cannot be moved host-side. It can be made *deterministic*: state
 * one waiting protocol, fix every number in it, and then check the run against
 * it from the Codex rollout rather than trusting that it was followed. That is
 * what {@link WAIT_PROTOCOL} states and what {@link readParentWait} measures.
 *
 * Limitation, stated rather than hidden: this removes the *choice* of poll
 * interval, not the model's ability to ignore the instruction, and not Codex's
 * ability to clamp the yield it was given. So {@link assessComparability}
 * returns two verdicts rather than one: whether the supervisor complied, and
 * whether the resulting parent cost may be compared. A run with any `wait` turn
 * at all fails the second even when it passes the first, because the behaviour
 * being approximated — one blocking call, one complete result — has no
 * supervisor inference in between.
 */
import fs from "node:fs";
import path from "node:path";
import { REQUIRED_SETTINGS } from "../cli/settings.js";

/**
 * The tool timeout the orchestrator is registered with, from the single place
 * that defines it. The mandated yield is derived from this rather than picked: a
 * cell should be willing to stay on the call for exactly as long as the call is
 * allowed to live, and no longer.
 */
export const TOOL_TIMEOUT_SECONDS = Number(
  REQUIRED_SETTINGS.find((setting) => setting.key === "tool_timeout_sec")?.value ?? 3600,
);

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `${name} must be a positive integer, got "${raw}". Unset it to use the ` +
        `default of ${fallback}.`,
    );
  }
  return parsed;
}

/**
 * The canonical yield: the whole life the delegation call is allowed, so the
 * cell has no reason to yield at all. Runs of the study are only comparable with
 * each other when they all waited under this number, which is why the canonical
 * value is a separate constant from the effective one below.
 */
export const CANONICAL_YIELD_MS = TOOL_TIMEOUT_SECONDS * 1000;

/**
 * The canonical output budget.
 *
 * This is a comparability axis in its own right. The canonical result is both
 * MCP surfaces, which was 42,267 characters at width 12 and scales with task
 * count; Codex's own defaults are 1,000 tokens for the pragma and 10,000 for a
 * `wait`, either of which would truncate it. A truncated ingestion is a cheaper
 * parent for a reason that is not the width being tested, so the budget is
 * mandated and the delivered volume is checked against what the server returned.
 */
export const CANONICAL_OUTPUT_TOKENS = 60_000;

/**
 * The yield every delegating arm is told to use, for the cell and for any `wait`
 * that follows it. One number, used everywhere, so the number of poll turns a
 * run performs is a function of the batch's real duration and of whatever
 * ceiling Codex applies, never of the supervisor's mood.
 *
 * `BENCH_WAIT_YIELD_MS` exists to investigate the mechanism — to find a clamp,
 * or to reproduce the old behaviour deliberately. It is not a way to run the
 * study differently: a run made under an overridden protocol is recorded as
 * non-canonical and is never parent-cost comparable, however well it complied.
 */
export const MANDATED_YIELD_MS = integerEnv("BENCH_WAIT_YIELD_MS", CANONICAL_YIELD_MS);

/** The effective output budget. Overridable on the same terms as the yield. */
export const MANDATED_OUTPUT_TOKENS = integerEnv(
  "BENCH_WAIT_OUTPUT_TOKENS",
  CANONICAL_OUTPUT_TOKENS,
);

/**
 * Whether the protocol in force is the canonical one.
 *
 * Recorded per results file and per run. An override is a legitimate thing to
 * do and a silent one is not, so this is the flag that keeps a probing run out
 * of the study's own comparisons.
 */
export const PROTOCOL_IS_CANONICAL =
  MANDATED_YIELD_MS === CANONICAL_YIELD_MS &&
  MANDATED_OUTPUT_TOKENS === CANONICAL_OUTPUT_TOKENS;

/**
 * The waiting protocol, appended to every delegating arm's prompt.
 *
 * Written to be reproducible rather than persuasive: every number is fixed, and
 * each rule is something a reader can check against the rollout afterwards. The
 * last paragraph exists because Codex's base instructions tell the model to
 * avoid blocking for more than 60 seconds; without addressing that directly the
 * mandated yield reads as a contradiction and gets rounded down to something
 * under a minute, which is exactly the behaviour being removed.
 */
export const WAIT_PROTOCOL = `Wait for a delegation call the way a host that put the tool in front of you directly would: block once, return once.

- Make the call from ONE code cell whose first line is exactly:

      // @exec: {"yield_time_ms": ${MANDATED_YIELD_MS}, "max_output_tokens": ${MANDATED_OUTPUT_TOKENS}}

  ${MANDATED_YIELD_MS} ms is the tool timeout this server is registered with, so the cell may
  stay on the call for as long as the call is allowed to live. The output budget
  is there so the whole result reaches you unsummarised.
- Call the delegation tool exactly once in that cell, and consume its result in
  that same cell, exactly as stated above: once, both surfaces, nothing else.
- If the cell yields before the call returns, resume it with \`wait\` and
  \`{"yield_time_ms": ${MANDATED_YIELD_MS}, "max_tokens": ${MANDATED_OUTPUT_TOKENS}}\`, the same numbers every time.
  Never poll faster than that, and do nothing at all between the call and its
  result: no other tool calls, no repository reading, no reasoning about what the
  workers might be doing. A \`wait\` returns as soon as the cell finishes, so a
  long yield costs no wall-clock.
- The general advice to avoid blocking for more than 60 seconds does not apply to
  this call. There is no user to talk to during this run, a delegated batch takes
  minutes, and polling it does not make it finish sooner.`;

/** Tokens for one bucket of the parent's inferences. */
export interface UsageTotals {
  /** Model round-trips counted into this bucket. */
  inferences: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

const emptyUsage = (): UsageTotals => ({
  inferences: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
});

/** One `wait` call the supervisor made against the delegating cell. */
export interface WaitCall {
  cellId: string | null;
  yieldTimeMs: number | null;
  maxTokens: number | null;
  /** Seconds the parent was blocked inside this call. */
  blockedSeconds: number | null;
  /** Seconds spent sampling the model in order to issue it. The poll tax. */
  turnSeconds: number | null;
  /** Wall time the runtime reported honouring, for detecting a clamped yield. */
  honoredSeconds: number | null;
}

/** The pragma on an `exec` cell, as the model wrote it. */
export interface ExecPragma {
  yieldTimeMs: number | null;
  maxOutputTokens: number | null;
}

/**
 * What the parent did while one delegated batch was outstanding.
 *
 * Read from the Codex rollout, which Codex writes for its own reasons, so
 * measuring this cannot change what is measured. That is the same rule the
 * wall-clock breakdown already follows.
 */
export interface ParentWait {
  rollout: string | null;
  /** Model round-trips in the whole turn. */
  inferences: number;
  /** `exec` cells the supervisor ran, delegating or not. */
  execCells: number;
  /** Cells that actually invoked a delegation tool. Must be exactly one. */
  delegationCells: number;
  /** Delegation invocations inside the delegating cell. Must be exactly one. */
  delegationCallsInCell: number;
  pragma: ExecPragma | null;
  cellId: string | null;
  /** Whether the cell yielded before the call returned, i.e. whether it polled. */
  cellYielded: boolean;
  waits: WaitCall[];
  waitTurns: number;
  /** Waits whose numbers were not the mandated ones. */
  offProtocolWaits: number;
  /** Anything the supervisor called while the batch was outstanding. */
  interleavedCalls: string[];
  /**
   * Inferences that completed while the batch was outstanding and were neither
   * the delegating cell nor a `wait`. A supervisor thinking out loud between
   * polls issues no tool call, so it would otherwise be invisible, and it is
   * paid for in full transcript input just like a poll is.
   */
  interleavedInferences: number;
  /**
   * Syntactic evidence that the canonical consumption happened once: how many
   * times the delegating cell reads `result.content`, and how many times it
   * serialises the structured surface. Both must be 1. A source check, not a
   * proof: `resultIngestChars` is the volumetric one.
   */
  canonicalPrints: { content: number; structured: number };
  /** Characters the runtime actually handed back for the delegating cell. */
  resultIngestChars: number | null;
  seconds: {
    /** First to last rollout entry. */
    total: number | null;
    /** Time not blocked in any tool call: sampling, plus harness overhead. */
    supervisorActive: number | null;
    /** Time blocked in the delegating cell and its waits. Real worker latency. */
    blockedOnDelegation: number | null;
    /** Time spent sampling the model purely to issue waits. Pure overhead. */
    waitTurns: number | null;
  };
  /**
   * Parent tokens split by what the inference was for. Reported, never
   * subtracted: `total` is what the run cost, and the buckets say why.
   */
  usage: {
    total: UsageTotals;
    /** Inferences that produced a `wait`. The confound, quantified. */
    wait: UsageTotals;
    /** Inferences that produced an `exec` cell. */
    exec: UsageTotals;
    /** Everything else: reading the repository, the final message. */
    other: UsageTotals;
  };
  mandated: { yieldTimeMs: number; outputTokens: number };
}

interface RolloutEntry {
  at: number | null;
  type: string;
  payload: Record<string, unknown>;
}

interface CallRecord {
  callId: string;
  kind: "exec" | "wait" | "other";
  name: string;
  at: number | null;
  /** Seconds between the previous tool result and this call being issued. */
  turnSeconds: number | null;
  returnedAt: number | null;
  outputChars: number;
  outputText: string;
  cellId: string | null;
  yieldTimeMs: number | null;
  maxTokens: number | null;
  source: string;
  pragma: ExecPragma | null;
  delegationCalls: number;
  /** Whether the last output for this call reported the cell still running. */
  stillRunning: boolean;
}

const parseLine = (line: string): RolloutEntry | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: { timestamp?: unknown; type?: unknown; payload?: unknown };
  try {
    parsed = JSON.parse(trimmed) as typeof parsed;
  } catch {
    return null;
  }
  const at = Date.parse(String(parsed.timestamp ?? ""));
  return {
    at: Number.isNaN(at) ? null : at,
    type: typeof parsed.type === "string" ? parsed.type : "",
    payload: (parsed.payload ?? {}) as Record<string, unknown>,
  };
};

const countMatches = (source: string, pattern: RegExp): number =>
  (source.match(pattern) ?? []).length;

/** `// @exec: {...}` on the cell's first line, or null when it was omitted. */
export function readExecPragma(source: string): ExecPragma | null {
  const first = source.split("\n", 1)[0] ?? "";
  const match = /^\s*\/\/\s*@exec:\s*(\{.*\})\s*$/.exec(first);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return { yieldTimeMs: null, maxOutputTokens: null };
  }
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    yieldTimeMs: number(parsed.yield_time_ms),
    maxOutputTokens: number(parsed.max_output_tokens),
  };
}

/** Text of a tool result, whose payload is either a string or content blocks. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((block) => String((block as { text?: unknown })?.text ?? ""))
      .join("");
  }
  return "";
}

const seconds = (from: number | null, to: number | null): number | null =>
  from === null || to === null ? null : Math.round(((to - from) / 1000) * 10) / 10;

const addUsage = (into: UsageTotals, usage: Record<string, unknown>): void => {
  const value = (key: string): number => {
    const raw = usage[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  };
  into.inferences += 1;
  into.inputTokens += value("input_tokens");
  into.cachedInputTokens += value("cached_input_tokens");
  into.outputTokens += value("output_tokens");
  into.reasoningOutputTokens += value("reasoning_output_tokens");
};

/**
 * Read one parent turn's waiting behaviour out of a Codex rollout.
 *
 * Deliberately total, for the same reason `readMcpCall` is: an unfamiliar
 * rollout shape must produce a record saying so, not lose a benchmark run that
 * has already been paid for. Anything unrecognised leaves its field null, and
 * the comparability check treats a null as a violation rather than as a pass.
 */
export function readParentWait(
  lines: string[],
  options: {
    rollout?: string | null;
    mandatedYieldMs?: number;
    mandatedOutputTokens?: number;
  } = {},
): ParentWait {
  const mandatedYieldMs = options.mandatedYieldMs ?? MANDATED_YIELD_MS;
  const mandatedOutputTokens = options.mandatedOutputTokens ?? MANDATED_OUTPUT_TOKENS;

  const entries = lines
    .map(parseLine)
    .filter((entry): entry is RolloutEntry => entry !== null);

  const calls: CallRecord[] = [];
  const byId = new Map<string, CallRecord>();
  const usage = {
    total: emptyUsage(),
    wait: emptyUsage(),
    exec: emptyUsage(),
    other: emptyUsage(),
  };

  // The inference that produced a tool call is the one whose usage is reported
  // next, so a bucket is chosen by the most recent call and then cleared: a
  // second usage report with no call in between belongs to nothing in particular
  // and is counted as other work.
  let pendingBucket: "wait" | "exec" | "other" | null = null;
  const inferenceStamps: Array<{
    at: number | null;
    bucket: "wait" | "exec" | "other";
  }> = [];
  let lastOutputAt: number | null = null;
  let firstAt: number | null = null;
  let lastAt: number | null = null;

  for (const entry of entries) {
    if (entry.at !== null) {
      firstAt ??= entry.at;
      lastAt = entry.at;
    }
    const payload = entry.payload;
    const kind = String(payload.type ?? "");

    if (entry.type === "response_item" && kind === "custom_tool_call") {
      const source = String(payload.input ?? "");
      const record: CallRecord = {
        callId: String(payload.call_id ?? ""),
        kind: String(payload.name ?? "") === "exec" ? "exec" : "other",
        name: String(payload.name ?? "unknown"),
        at: entry.at,
        turnSeconds: seconds(lastOutputAt, entry.at),
        returnedAt: null,
        outputChars: 0,
        outputText: "",
        cellId: null,
        yieldTimeMs: null,
        maxTokens: null,
        source,
        pragma: readExecPragma(source),
        // `includes("delegate_tasks")` in a discovery cell is a mention, not a
        // call; only an invocation counts. The optional quote-and-bracket covers
        // `tools["mcp__..._delegate_tasks"](...)`, which is the same call written
        // the other way round.
        delegationCalls: countMatches(source, /delegate_tasks?(?:["'`]\s*\])?\s*\(/g),
        stillRunning: false,
      };
      calls.push(record);
      byId.set(record.callId, record);
      pendingBucket = record.kind === "exec" ? "exec" : "other";
      continue;
    }

    if (entry.type === "response_item" && kind === "function_call") {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(String(payload.arguments ?? "{}")) as Record<string, unknown>;
      } catch {
        args = {};
      }
      const name = String(payload.name ?? "unknown");
      const number = (value: unknown): number | null =>
        typeof value === "number" && Number.isFinite(value) ? value : null;
      const record: CallRecord = {
        callId: String(payload.call_id ?? ""),
        kind: name === "wait" ? "wait" : "other",
        name,
        at: entry.at,
        turnSeconds: seconds(lastOutputAt, entry.at),
        returnedAt: null,
        outputChars: 0,
        outputText: "",
        cellId: args.cell_id === undefined ? null : String(args.cell_id),
        yieldTimeMs: number(args.yield_time_ms),
        maxTokens: number(args.max_tokens),
        source: "",
        pragma: null,
        delegationCalls: 0,
        stillRunning: false,
      };
      calls.push(record);
      byId.set(record.callId, record);
      pendingBucket = record.kind === "wait" ? "wait" : "other";
      continue;
    }

    if (
      entry.type === "response_item" &&
      (kind === "custom_tool_call_output" || kind === "function_call_output")
    ) {
      const record = byId.get(String(payload.call_id ?? ""));
      lastOutputAt = entry.at ?? lastOutputAt;
      if (record) {
        const text = outputText(payload.output);
        record.returnedAt = entry.at;
        record.outputChars = text.length;
        record.outputText = text;
        record.stillRunning = /Script running with cell ID/.test(text);
        const cell = /cell ID (\S+)/.exec(text);
        if (cell && record.cellId === null) record.cellId = cell[1]!;
      }
      continue;
    }

    if (entry.type === "event_msg" && kind === "token_count") {
      const info = (payload.info ?? {}) as Record<string, unknown>;
      const last = (info.last_token_usage ?? {}) as Record<string, unknown>;
      const bucket = pendingBucket ?? "other";
      addUsage(usage.total, last);
      addUsage(usage[bucket], last);
      inferenceStamps.push({ at: entry.at, bucket });
      pendingBucket = null;
    }
  }

  const delegationCells = calls.filter(
    (call) => call.kind === "exec" && call.delegationCalls > 0,
  );
  const cell = delegationCells[0] ?? null;
  const cellId = cell?.cellId ?? null;

  // Waits belonging to the delegating cell, and the window the batch was
  // outstanding for. When the cell never yielded there is no window to police,
  // which is the outcome the protocol is aiming for.
  const cellWaits =
    cell === null
      ? []
      : calls.filter(
          (call) =>
            call.kind === "wait" &&
            (cellId === null || call.cellId === null || call.cellId === cellId),
        );
  const lastWait = cellWaits.at(-1);
  const outstandingUntil =
    lastWait !== undefined
      ? (lastWait.returnedAt ?? lastWait.at)
      : (cell?.returnedAt ?? null);

  const cellStart = cell?.at ?? null;
  const interleavedCalls =
    cell === null || cellStart === null || outstandingUntil === null
      ? []
      : calls
          .filter(
            (call) =>
              call !== cell &&
              call.kind !== "wait" &&
              call.at !== null &&
              call.at > cellStart &&
              call.at <= outstandingUntil,
          )
          .map((call) => call.name);

  // The delegating cell's own inference completes as the cell yields, which is
  // inside the window, so only the unattributed bucket counts as thinking the
  // parent did while it should have been waiting.
  const interleavedInferences =
    cellStart === null || outstandingUntil === null
      ? 0
      : inferenceStamps.filter(
          (stamp) =>
            stamp.bucket === "other" &&
            stamp.at !== null &&
            stamp.at > cellStart &&
            stamp.at <= outstandingUntil,
        ).length;

  const blocked = (record: CallRecord): number =>
    record.at === null || record.returnedAt === null
      ? 0
      : (record.returnedAt - record.at) / 1000;
  const totalBlocked = calls.reduce((total, call) => total + blocked(call), 0);
  const delegationBlocked =
    cell === null
      ? null
      : Math.round(
          (blocked(cell) + cellWaits.reduce((total, call) => total + blocked(call), 0)) *
            10,
        ) / 10;
  const waitTurnSeconds =
    Math.round(
      cellWaits.reduce((total, call) => total + (call.turnSeconds ?? 0), 0) * 10,
    ) / 10;
  const totalSeconds = seconds(firstAt, lastAt);

  const honored = (text: string): number | null => {
    const match = /Wall time ([\d.]+) seconds/.exec(text);
    return match ? Number(match[1]) : null;
  };

  const waits: WaitCall[] = cellWaits.map((call) => ({
    cellId: call.cellId,
    yieldTimeMs: call.yieldTimeMs,
    maxTokens: call.maxTokens,
    blockedSeconds: seconds(call.at, call.returnedAt),
    turnSeconds: call.turnSeconds,
    honoredSeconds: honored(call.outputText),
  }));

  // What the parent actually ingested is the last thing the runtime handed back
  // for that cell: the cell's own output if it never yielded, otherwise the
  // final wait's.
  const terminal = lastWait ?? cell;

  return {
    rollout: options.rollout ?? null,
    inferences: usage.total.inferences,
    execCells: calls.filter((call) => call.kind === "exec").length,
    delegationCells: delegationCells.length,
    delegationCallsInCell: cell?.delegationCalls ?? 0,
    pragma: cell?.pragma ?? null,
    cellId,
    cellYielded: cell !== null && cell.stillRunning,
    waits,
    waitTurns: waits.length,
    offProtocolWaits: waits.filter(
      (wait) =>
        wait.yieldTimeMs !== mandatedYieldMs || wait.maxTokens !== mandatedOutputTokens,
    ).length,
    interleavedCalls,
    interleavedInferences,
    canonicalPrints: {
      content: cell === null ? 0 : countMatches(cell.source, /result\.content\b/g),
      structured:
        cell === null
          ? 0
          : countMatches(
              cell.source,
              /JSON\.stringify\(\s*result\.structured(?:Content|_content)/g,
            ),
    },
    resultIngestChars:
      terminal === undefined || terminal === null ? null : terminal.outputChars,
    seconds: {
      total: totalSeconds,
      supervisorActive:
        totalSeconds === null
          ? null
          : Math.round((totalSeconds - totalBlocked) * 10) / 10,
      blockedOnDelegation: delegationBlocked,
      waitTurns: waitTurnSeconds,
    },
    usage,
    mandated: { yieldTimeMs: mandatedYieldMs, outputTokens: mandatedOutputTokens },
  };
}

/** Locate the rollout Codex wrote for a thread inside a CODEX_HOME. */
export function findRolloutFile(codexHome: string, threadId: string): string | null {
  const root = path.join(codexHome, "sessions");
  if (!threadId || !fs.existsSync(root)) return null;

  const walk = (dir: string, depth: number): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) return full;
      // sessions/<year>/<month>/<day>/, so three levels is the whole tree.
      if (entry.isDirectory() && depth < 3) {
        const found = walk(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  return walk(root, 0);
}

/** Read the rollout for a thread, or null when there is none to read. */
export function readParentWaitFor(
  codexHome: string,
  threadId: string | null,
): ParentWait | null {
  if (!threadId) return null;
  const rollout = findRolloutFile(codexHome, threadId);
  if (rollout === null) return null;
  let text: string;
  try {
    text = fs.readFileSync(rollout, "utf8");
  } catch {
    return null;
  }
  return readParentWait(text.split("\n"), { rollout });
}

/**
 * Two separate verdicts about one run, deliberately not one.
 *
 * Compliance is a statement about the supervisor: it did what the protocol
 * asked. Comparability is a statement about the measurement: this parent cost
 * may be put beside another run's. They come apart in exactly one case that
 * matters, and it is not a rare one — Codex may clamp the mandated yield, so a
 * perfectly compliant supervisor can still be forced into `wait` turns. Every
 * such turn is a model round-trip, charged at the full transcript, that the
 * reference behaviour — one blocking call, one complete result, no supervisor
 * inference in between — would never have produced. A run like that is worth
 * keeping and worth reporting; it is not worth comparing.
 */
export interface Comparability {
  /** Whether the supervisor followed the mandated exec/wait protocol. */
  waitProtocolCompliant: boolean;
  /** Empty when compliant. What the supervisor did instead. */
  protocolViolations: string[];
  /** Whether this run's parent cost may be compared with another run's. */
  parentCostComparable: boolean;
  /**
   * Every reason it may not be, protocol violations included, so a reader has
   * the whole story from one field.
   */
  reasons: string[];
  /**
   * Whether the protocol in force was the canonical one, i.e. neither
   * `BENCH_WAIT_YIELD_MS` nor `BENCH_WAIT_OUTPUT_TOKENS` changed it. A run made
   * under an override is never parent-cost comparable with the study.
   */
  canonicalProtocol: boolean;
  /** False when nothing was delegated, so neither verdict applies. */
  delegated: boolean;
}

/**
 * Check a delegated run against the waiting and consumption protocol.
 *
 * Every reason names the observed value, because "non-comparable" on its own
 * tells a later reader nothing about which run to distrust or why. A missing
 * rollout is itself a reason: an unobserved wait is not a compliant one.
 */
export function assessComparability(input: {
  parentWait: ParentWait | null;
  mcpCalls: Array<{
    tool: string;
    resultDetail: string | null;
    canonicalChars: number;
  }>;
  delegated: boolean;
}): Comparability {
  const wait = input.parentWait;

  // The protocol in force, taken from the run itself where possible so a record
  // can be re-assessed later without the environment that produced it.
  const canonicalProtocol =
    wait === null
      ? PROTOCOL_IS_CANONICAL
      : wait.mandated.yieldTimeMs === CANONICAL_YIELD_MS &&
        wait.mandated.outputTokens === CANONICAL_OUTPUT_TOKENS;

  if (!input.delegated) {
    return {
      waitProtocolCompliant: true,
      protocolViolations: [],
      parentCostComparable: true,
      reasons: [],
      canonicalProtocol,
      delegated: false,
    };
  }

  /** Broken rules that are the supervisor not following instructions. */
  const protocolViolations: string[] = [];
  /** Broken rules that make the parent cost incomparable regardless of that. */
  const costReasons: string[] = [];

  const batchCalls = input.mcpCalls.filter((call) => call.tool === "delegate_tasks");

  if (batchCalls.length !== 1) {
    costReasons.push(`delegate_tasks called ${batchCalls.length} time(s), expected 1`);
  }
  for (const call of batchCalls) {
    if (call.resultDetail !== "compact") {
      costReasons.push(
        `resultDetail was ${call.resultDetail ?? "omitted"}, expected compact`,
      );
    }
  }
  if (!canonicalProtocol) {
    const under = wait === null ? null : wait.mandated;
    costReasons.push(
      `the waiting protocol was overridden (yield ` +
        `${under?.yieldTimeMs ?? MANDATED_YIELD_MS}, budget ` +
        `${under?.outputTokens ?? MANDATED_OUTPUT_TOKENS}; canonical is ` +
        `${CANONICAL_YIELD_MS}/${CANONICAL_OUTPUT_TOKENS}), so this run is not part ` +
        `of the study`,
    );
  }

  if (wait === null) {
    protocolViolations.push(
      "no Codex rollout found, so the waiting protocol is unverified",
    );
    return {
      waitProtocolCompliant: false,
      protocolViolations,
      parentCostComparable: false,
      reasons: [...protocolViolations, ...costReasons],
      canonicalProtocol,
      delegated: true,
    };
  }

  const { yieldTimeMs, outputTokens } = wait.mandated;

  if (wait.delegationCells !== 1) {
    protocolViolations.push(
      `${wait.delegationCells} delegating exec cell(s), expected 1`,
    );
  }
  if (wait.delegationCallsInCell !== 1) {
    protocolViolations.push(
      `${wait.delegationCallsInCell} delegation call(s) in the cell, expected 1`,
    );
  }
  if (wait.pragma === null) {
    protocolViolations.push("the delegating cell carried no @exec pragma");
  } else {
    if (wait.pragma.yieldTimeMs !== yieldTimeMs) {
      protocolViolations.push(
        `cell yield_time_ms was ${wait.pragma.yieldTimeMs ?? "unset"}, ` +
          `expected ${yieldTimeMs}`,
      );
    }
    if (wait.pragma.maxOutputTokens !== outputTokens) {
      protocolViolations.push(
        `cell max_output_tokens was ${wait.pragma.maxOutputTokens ?? "unset"}, ` +
          `expected ${outputTokens}`,
      );
    }
  }
  if (wait.offProtocolWaits > 0) {
    const observed = [
      ...new Set(wait.waits.map((call) => `${call.yieldTimeMs}/${call.maxTokens}`)),
    ].join(", ");
    protocolViolations.push(
      `${wait.offProtocolWaits} of ${wait.waitTurns} wait(s) used other numbers ` +
        `(${observed}), expected ${yieldTimeMs}/${outputTokens}`,
    );
  }
  if (wait.interleavedCalls.length > 0) {
    protocolViolations.push(
      `the supervisor called ${[...new Set(wait.interleavedCalls)].join(", ")} ` +
        `while the batch was outstanding`,
    );
  }
  if (wait.interleavedInferences > 0) {
    protocolViolations.push(
      `${wait.interleavedInferences} inference(s) ran while the batch was ` +
        `outstanding without issuing a wait`,
    );
  }
  if (wait.canonicalPrints.content !== 1 || wait.canonicalPrints.structured !== 1) {
    costReasons.push(
      `the cell read result.content ${wait.canonicalPrints.content} time(s) and ` +
        `serialised the structured surface ${wait.canonicalPrints.structured} time(s), ` +
        `expected 1 each`,
    );
  }

  // The reference behaviour has no supervisor inference between the call and its
  // result, so any wait at all — even one the protocol asked for after a clamped
  // yield — is polling cost the comparison cannot absorb. Compliance is
  // unaffected: `offProtocolWaits` above is what judges the supervisor.
  if (wait.waitTurns > 0) {
    costReasons.push(
      `${wait.waitTurns} model-visible wait turn(s) added polling cost ` +
        `(${wait.usage.wait.inputTokens} input tokens over ` +
        `${wait.usage.wait.inferences} inference(s), ` +
        `${wait.seconds.waitTurns ?? "unknown"}s) that a blocking MCP host would ` +
        `not incur`,
    );
  }

  // Volumetric check on the canonical ingestion. Below what the server returned
  // means the parent never saw all of it; far above means it saw it twice. The
  // 1.5x band is deliberately loose: a runtime header cannot reach it and a
  // second full print cannot avoid it. Full ingestion has to be *proven*, so a
  // missing figure on either side is a reason rather than a skipped check.
  const canonical = batchCalls[0]?.canonicalChars ?? null;
  const ingested = wait.resultIngestChars;
  if (canonical === null || canonical <= 0 || ingested === null) {
    costReasons.push(
      `full ingestion is unproven (ingested ${ingested ?? "unknown"} characters ` +
        `against ${canonical ?? "unknown"} returned)`,
    );
  } else if (ingested < canonical) {
    costReasons.push(
      `the parent ingested ${ingested} of ${canonical} canonical characters`,
    );
  } else if (ingested > canonical * 1.5) {
    costReasons.push(
      `the parent ingested ${ingested} characters for a ${canonical}-character ` +
        `result, so it was not consumed exactly once`,
    );
  }

  return {
    waitProtocolCompliant: protocolViolations.length === 0,
    protocolViolations,
    parentCostComparable: protocolViolations.length === 0 && costReasons.length === 0,
    reasons: [...protocolViolations, ...costReasons],
    canonicalProtocol,
    delegated: true,
  };
}
