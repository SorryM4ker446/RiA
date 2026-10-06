import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

// Only the application's redacted log is printed. Settings, databases and
// Chromium profile files are not diagnostic output and must stay private.
export function printDesktopSmokeDiagnostics(root, write = console.error) {
  const logFile = join(root, "data", "logs", "desktop.log");
  let descriptor;
  try {
    descriptor = openSync(logFile, "r");
    const size = fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(size, 32 * 1024));
    const bytes = readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    write(`Desktop application log (last ${bytes} bytes):\n${buffer.subarray(0, bytes).toString("utf8")}`);
  } catch (error) {
    write(`Desktop application log unavailable (${error.code ?? "read error"}): ${logFile}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
