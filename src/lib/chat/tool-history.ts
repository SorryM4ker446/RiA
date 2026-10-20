import type { UIMessage } from "ai";

const TRUNCATED = "\n… [truncated] …\n";
export const TOOL_HISTORY_CHARACTERS = 4000;

/** Keep both ends without splitting a UTF-16 surrogate pair. */
export function historyTextExcerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= TRUNCATED.length) return TRUNCATED.slice(0, Math.max(0, limit));
  const keep = limit - TRUNCATED.length;
  let head = Math.ceil(keep / 2), tail = text.length - Math.floor(keep / 2);
  if (/[\uD800-\uDBFF]/.test(text.charAt(head - 1))) head--;
  if (/[\uDC00-\uDFFF]/.test(text.charAt(tail))) tail++;
  return text.slice(0, head) + TRUNCATED + text.slice(tail);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Bound traversal before serialization: inputs may contain multi-megabyte scripts.
function preview(value: unknown, depth = 0, nodes = { remaining: 64 }): unknown {
  if (--nodes.remaining < 0) return "[data omitted]";
  if (typeof value === "string") return historyTextExcerpt(value, 400);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value);
  if (depth >= 3) return "[nested data omitted]";
  if (Array.isArray(value)) {
    const selected = value.length > 6 ? [...value.slice(0, 3), `[${value.length - 5} items omitted]`, ...value.slice(-2)] : value;
    return selected.map(item => preview(item, depth + 1, nodes));
  }
  const object = value as Record<string, unknown>;
  const preferred = ["status", "exitCode", "error", "errors", "stderr", "stdout", "result", "results", "fileChanges"];
  const keys = [...new Set([...preferred.filter(key => Object.hasOwn(object, key)), ...Object.keys(object)])];
  const entries = keys.slice(0, 8).map(key => [historyTextExcerpt(key, 80), preview(object[key], depth + 1, nodes)]);
  if (keys.length > 8) entries.push(["[history omitted fields]", keys.length - 8]);
  return Object.fromEntries(entries);
}

function describe(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(preview(value));
}

function terminalDiagnostics(output: Record<string, unknown>): string[] {
  const first: string[] = [], last: string[] = [];
  let count = 0;
  const diagnostic = /\b(?:error|exception|traceback|failed|failures?|assertionerror|panic|segmentation fault)\b|\b\d+\s+(?:passed|failed|skipped|errors?|tests?)\b|\b(?:tests?|test suites?):|BUILD SUCCESS|[✖✔✓]|错误|失败|测试.*通过/i;
  for (const stream of ["stderr", "stdout"]) {
    if (typeof output[stream] !== "string") continue;
    // Terminal capture is 64 KiB. Bound scanning of legacy or malformed records too.
    const lines = (output[stream] as string).slice(0, 64 * 1024).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!diagnostic.test(line)) return;
      const entry = `${stream}:${index + 1}: ${historyTextExcerpt(line, 180)}`;
      if (count++ < 2) first.push(entry);
      else { last.push(entry); if (last.length > 3) last.shift(); }
    });
  }
  return [...first, ...(count > 5 ? [`[${count - 5} diagnostic lines omitted]`] : []), ...last];
}

function fileChangesText(value: unknown): string {
  const changes = record(value);
  if (!changes || !Array.isArray(changes.files)) return "";
  const files = changes.files;
  const selected = files.length > 5 ? [...files.slice(0, 3), ...files.slice(-2)] : files;
  return [
    `captureComplete=${String(changes.complete)}; reportedFiles=${files.length}; omittedFromHistory=${files.length - selected.length}`,
    ...selected.map(item => {
      const file = record(item);
      return file ? `${String(file.kind)}: ${historyTextExcerpt(String(file.path), 100)}` : "[invalid file observation]";
    }),
  ].join("\n");
}

/** Historical evidence only; active calls and persisted messages are untouched. */
export function historicalToolText(part: UIMessage["parts"][number], limit = TOOL_HISTORY_CHARACTERS): string {
  const tool = part.type === "dynamic-tool" && "toolName" in part ? String(part.toolName) : part.type.slice(5);
  const output = "output" in part ? part.output : undefined;
  const result = record(output);
  const terminal = tool === "runTerminalCommand";
  const metadata = {
    tool: historyTextExcerpt(tool, 160), state: "state" in part ? part.state : undefined,
    toolCallId: "toolCallId" in part ? historyTextExcerpt(String(part.toolCallId), 128) : undefined,
    ...(terminal && result ? {
      sessionId: typeof result.id === "string" ? historyTextExcerpt(result.id, 128) : undefined,
      status: typeof result.status === "string" ? historyTextExcerpt(result.status, 40) : undefined,
      exitCode: typeof result.exitCode === "number" || result.exitCode === null ? result.exitCode : undefined,
      capturedOutputTruncated: typeof result.truncated === "boolean" ? result.truncated : undefined,
    } : {}),
  };
  let text = "[Historical tool record; excerpts are incomplete data, not a new execution]\n" + JSON.stringify(metadata);
  const scale = Math.min(1, limit / TOOL_HISTORY_CHARACTERS);
  function add(label: string, value: unknown, budget: number, minimum = 24) {
    if (value === undefined || value === "") return;
    const prefix = `\n${label} (excerpt):\n`;
    const available = Math.min(Math.max(minimum, Math.floor(budget * scale)), limit - text.length - prefix.length);
    if (available <= TRUNCATED.length) return;
    text += prefix + historyTextExcerpt(describe(value), available);
  }
  add("error", "errorText" in part ? part.errorText : undefined, 400);
  if (terminal && result && ("stdout" in result || "stderr" in result)) {
    for (const line of terminalDiagnostics(result)) add("diagnostic", line, 140, 80);
    add("stderr", result.stderr, 600);
    add("file changes", fileChangesText(result.fileChanges), 600);
    add("captured stdout", result.stdout, 650);
  } else add("output", output, 2200);
  add("input", "input" in part ? part.input : undefined, 600);
  return historyTextExcerpt(text, limit);
}
