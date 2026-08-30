import { appendFileSync } from "node:fs";
import { inspect } from "node:util";

const SENSITIVE_VALUE_PATTERN = /(api[_-]?key|authorization|cookie|session[_-]?token|password)\s*[:=]\s*([^\s,;}]+)/gi;

function sanitize(value: unknown): string {
  const rendered = typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 120 });
  return rendered.replace(SENSITIVE_VALUE_PATTERN, "$1=[redacted]");
}

export type DesktopLogger = {
  info: (message: string, details?: unknown) => void;
  warn: (message: string, details?: unknown) => void;
  error: (message: string, details?: unknown) => void;
};

export function createDesktopLogger(logFile: string): DesktopLogger {
  function write(level: "INFO" | "WARN" | "ERROR", message: string, details?: unknown) {
    const suffix = details === undefined ? "" : ` ${sanitize(details)}`;
    const line = `[${new Date().toISOString()}] [${level}] ${sanitize(message)}${suffix}\n`;
    try {
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
