import { appendFileSync } from "node:fs";

/**
 * Collapse control characters so model-supplied text cannot forge log lines.
 *
 * Objective-derived previews and other model-supplied text can reach the log.
 * A newline inside them would otherwise let a delegated task fabricate a
 * convincing "done: verdict=PASS" entry in the operator's diagnostic file.
 */
export const sanitizeForLog = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f]/g, " ");

/**
 * Build the server's logger.
 *
 * stdout is the MCP transport: anything written there that is not a JSON-RPC
 * frame corrupts the session, so all diagnostics go to stderr. Codex swallows a
 * server's stderr, so `logFile` (SOL_LUNA_LOG) tees them somewhere readable.
 * That file is the only way to tell "Codex never started the server" apart from
 * "the server started but the model ignored the tool".
 */
export function createLogger(logFile: string | undefined) {
  return (message: string): void => {
    const line = `[sol-luna-orchestrator] ${sanitizeForLog(message)}\n`;
    process.stderr.write(line);
    if (!logFile) return;
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}`);
    } catch {
      // Never let logging break the server.
    }
  };
}
