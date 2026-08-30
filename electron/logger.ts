import { appendFileSync, existsSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import { inspect } from "node:util";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const SENSITIVE_VALUE_PATTERN = /((?:[\w-]*(?:api[_-]?key|session[_-]?token|password|secret)|authorization|cookie|database_url)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;}]+)/gi;
export const DESKTOP_LOG_LIMITS = { maxBytes: 2 * 1024 * 1024, backupCount: 3, lineCharacters: 16 * 1024 } as const;

function sanitize(value: unknown): string {
  const rendered = typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 120 });
  return rendered.replace(SENSITIVE_VALUE_PATTERN, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s'"<>]+/gi, "[redacted database URL]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]");
}

export type DesktopLogger = {
  info: (message: string, details?: unknown) => void;
  warn: (message: string, details?: unknown) => void;
  error: (message: string, details?: unknown) => void;
};

export function createDesktopLogger(logFile: string, options: { maxBytes?: number; backupCount?: number } = {}): DesktopLogger {
  const { maxBytes = DESKTOP_LOG_LIMITS.maxBytes, backupCount = DESKTOP_LOG_LIMITS.backupCount } = options;
  if (!Number.isInteger(maxBytes) || maxBytes < 128 || !Number.isInteger(backupCount) || backupCount < 1 || backupCount > 10) {
    throw new Error("Invalid desktop log limits");
  }
  function rotate(incomingBytes: number) {
    if (!existsSync(logFile) || statSync(logFile).size + incomingBytes <= maxBytes) return;
    rmSync(`${logFile}.${backupCount}`, { force: true });
    for (let index = backupCount - 1; index >= 0; index -= 1) {
      const source = index === 0 ? logFile : `${logFile}.${index}`;
      if (!existsSync(source)) continue;
      // Cap logs created before rotation was introduced as well.
      if (statSync(source).size > maxBytes) truncateSync(source, maxBytes);
      renameSync(source, `${logFile}.${index + 1}`);
    }
  }
  function write(level: "INFO" | "WARN" | "ERROR", message: string, details?: unknown) {
    const suffix = details === undefined ? "" : ` ${sanitize(details)}`;
    let line = `[${new Date().toISOString()}] [${level}] ${sanitize(message)}${suffix}\n`;
    try {
      if (Buffer.byteLength(line) > maxBytes) line = `[${new Date().toISOString()}] [${level}] [oversized log entry omitted]\n`;
      rotate(Buffer.byteLength(line));
      appendFileSync(logFile, line, "utf8");
    } catch {
      // Logging must never prevent the desktop application from starting.
    }
  }

  return {
    info: (message, details) => write("INFO", message, details),
    warn: (message, details) => write("WARN", message, details),
    error: (message, details) => write("ERROR", message, details),
  };
}

/** Buffer complete bounded lines so split credentials are redacted before writing. */
export function createDesktopLogSink(logger: DesktopLogger, source: string): Writable {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let dropping = false;
  function consume(text: string) {
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!dropping) {
        if (pending.length + lines[index].length > DESKTOP_LOG_LIMITS.lineCharacters) {
          logger.info(source, "[oversized log line omitted]");
          pending = "";
          dropping = true;
        } else pending += lines[index];
      }
      if (index < lines.length - 1) {
        if (!dropping && pending) logger.info(source, pending.replace(/\r$/, ""));
        pending = "";
        dropping = false;
      }
    }
  }
  return new Writable({
    write(chunk: Buffer, _encoding, callback) { consume(decoder.write(chunk)); callback(); },
    final(callback) { consume(decoder.end()); if (pending && !dropping) logger.info(source, pending); callback(); },
  });
}
