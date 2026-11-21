import { TERMINAL_LIMITS } from "./schema";

/*
 * What the model is sent of a command's output: all of it when it is short,
 * otherwise the beginning and the end of each stream within
 * TERMINAL_LIMITS.modelOutputBytes, with a line where the rest was left out that
 * says how to read it (the log, which is kept for any output this long). The
 * result itself, as the card, the execution record and approvals use it, is
 * unchanged. Like Codex, which sends the model a short head and tail of a
 * command's output, and Claude Code, which caps a shell result and reads more on
 * request.
 */

type Streams = {
  stdout?: unknown; stderr?: unknown; newStdout?: unknown; newStderr?: unknown;
  log?: { id?: unknown } | null; truncated?: boolean; omittedBytes?: number; modelOutputOmitted?: boolean;
};

/** The first `bytes` of text, without splitting a character. */
function head(text: string, bytes: number) {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}
/** The last `bytes` of text, without splitting a character. */
function tail(text: string, bytes: number) {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let start = buffer.length - bytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

function excerpt(text: string, budget: number, logId: string | null) {
  const size = Buffer.byteLength(text);
  if (size <= budget) return text;
  const start = head(text, Math.floor(budget * 0.75)), end = tail(text, budget - Buffer.byteLength(start));
  const left = size - Buffer.byteLength(start) - Buffer.byteLength(end);
  const where = logId ? `; read them with readTerminalLog (logId ${logId}), and search it before concluding something was not printed` : "";
  return `${start}\n… [${left} bytes of this output are not shown here${where}] …\n${end}`;
}

/** The command result as the model reads it. */
export function terminalResultForModel<T>(result: T): T {
  if (!result || typeof result !== "object") return result;
  const view = result as Streams;
  const update = "newStdout" in view;
  const outField = update ? "newStdout" : "stdout", errField = update ? "newStderr" : "stderr";
  const stdout = view[outField], stderr = view[errField];
  const out = typeof stdout === "string" ? stdout : "", err = typeof stderr === "string" ? stderr : "";
  const outBytes = Buffer.byteLength(out), errBytes = Buffer.byteLength(err), budget = TERMINAL_LIMITS.modelOutputBytes;
  const lost = view.modelOutputOmitted || (update ? Boolean(view.omittedBytes) : view.truncated);
  if (outBytes + errBytes <= budget) return lost ? { ...result, modelOutputOmitted: true } : result;
  // Shared between the streams by size, so a short error stream is shown whole beside a long log.
  const errBudget = Math.min(errBytes, Math.max(Math.floor(budget * errBytes / (outBytes + errBytes)), Math.min(errBytes, 2048)));
  const logId = typeof view.log?.id === "string" ? view.log.id : null;
  return { ...result, [outField]: excerpt(out, budget - errBudget, logId), [errField]: excerpt(err, errBudget, logId), modelOutputOmitted: true };
}

export function isTerminalOutputTool(name: string) {
  return name === "runTerminalCommand" || name === "checkTerminalCommand" || name === "stopTerminalCommand";
}
