import { createHash } from "node:crypto";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { isSameOrInside } from "@/lib/local-files/safe-path";
import type { TerminalFileChange, TerminalFileChanges } from "./schema";

const ignored = new Set([".git", "node_modules", ".next", ".venv", "__pycache__"]);
const limits = { entries: 10_000, readBytes: 8 * 1024 * 1024, fileBytes: 256 * 1024, durationMs: 1500, changes: 100 };
type FileVersion = { bytes: number; lines?: number; hash?: string; modified: number; changed: number };
export type FileSnapshot = { files: Map<string, FileVersion>; complete: boolean };

/** Observe the working tree without following junctions or retaining file text. */
export async function captureFileSnapshot(root: string, commandDeadline = Infinity): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = { files: new Map(), complete: true };
  let entries = 0, readBytes = 0;
  const deadline = Math.min(Date.now() + limits.durationMs, commandDeadline);
  async function visit(relative: string): Promise<void> {
    const directory = path.join(root, relative);
    if (!isSameOrInside(await realpath(directory), root)) { snapshot.complete = false; return; }
    const stream = await opendir(directory);
    for await (const entry of stream) {
      if (++entries > limits.entries || Date.now() > deadline) { snapshot.complete = false; return; }
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const name = path.posix.join(relative, entry.name);
      const absolute = path.join(root, name);
      try {
        if (entry.isDirectory()) { await visit(name); continue; }
        if (!entry.isFile()) continue;
        const info = await lstat(absolute);
        if (!info.isFile() || !isSameOrInside(await realpath(absolute), root)) { snapshot.complete = false; continue; }
        const version: FileVersion = { bytes: info.size, modified: info.mtimeMs, changed: info.ctimeMs };
        if (info.size <= limits.fileBytes && readBytes + info.size <= limits.readBytes) {
          const file = await open(absolute, "r");
          try {
            const buffer = Buffer.alloc(info.size + 1);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            const current = await file.stat();
            if (bytesRead !== info.size || current.size !== info.size || current.mtimeMs !== info.mtimeMs) { snapshot.complete = false; continue; }
            readBytes += bytesRead;
            const bytes = buffer.subarray(0, bytesRead);
            version.hash = createHash("sha256").update(bytes).digest("hex");
            try {
              const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              if (!text.includes("\0")) version.lines = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
            } catch { /* Binary files have a size summary rather than a line count. */ }
          } finally { await file.close(); }
        }
        snapshot.files.set(name, version);
      } catch { snapshot.complete = false; }
    }
  }
  try {
    if (await realpath(root) !== root) return { files: new Map(), complete: false };
    await visit("");
  } catch { snapshot.complete = false; }
  return snapshot;
}

export function compareFileSnapshots(before: FileSnapshot, after: FileSnapshot): TerminalFileChanges {
  const files: TerminalFileChange[] = [];
  const version = (value: FileVersion | undefined) => value ? { bytes: value.bytes, ...(value.lines === undefined ? {} : { lines: value.lines }) } : null;
  for (const name of new Set([...before.files.keys(), ...after.files.keys()])) {
    const first = before.files.get(name), last = after.files.get(name);
    // A partial walk cannot establish that an unobserved file was absent.
    if ((!first && !before.complete) || (!last && !after.complete)) continue;
    const equal = first && last && (first.hash && last.hash ? first.hash === last.hash
      : first.bytes === last.bytes && first.modified === last.modified && first.changed === last.changed);
    if (equal) continue;
    files.push({ path: name, kind: !first ? "created" : !last ? "deleted" : "modified", before: version(first), after: version(last) });
  }
  return { files: files.slice(0, limits.changes), complete: before.complete && after.complete && files.length <= limits.changes };
}
