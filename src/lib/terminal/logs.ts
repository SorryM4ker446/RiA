import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { db } from "@/db";
import { localDataDirectory } from "@/lib/local/data-directory";
import { ApiError } from "@/lib/server/api-error";
import { terminalLogReferenceSchema, type TerminalLogReference } from "./schema";

/**
 * Full output of commands that exceeded the in-memory capture. Logs live beside
 * the local database, owned by the command's folder grant and run: they are
 * readable only while that folder keeps terminal access, are removed when
 * their run is deleted or they expire, and are not part of workspace backups.
 */
export const TERMINAL_LOG_LIMITS = {
  bytesPerCommand: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  retentionMs: 7 * 86_400_000,
  readLines: 400,
  readBytes: 48 * 1024,
  lineCharacters: 2000,
  searchMatches: 50,
};

const metaSchema = terminalLogReferenceSchema.extend({ grantId: z.string(), runId: z.string().nullable(), createdAt: z.string(), finishedAt: z.string().nullable() });
type Meta = z.infer<typeof metaSchema>;
type Stream = "stdout" | "stderr";

export const terminalLogRoot = () => join(localDataDirectory("Terminal logs"), "terminal-logs");
const logDirectory = (id: string) => join(terminalLogRoot(), id);
const notFound = () => new ApiError({ code: "NOT_FOUND", message: "此终端日志不存在、已过期或已清理；请重新执行命令获取输出。" });

async function readMeta(id: string): Promise<Meta | null> {
  try { return metaSchema.parse(JSON.parse(await readFile(join(logDirectory(id), "meta.json"), "utf8"))); } catch { return null; }
}

/**
 * Created only once a command's output first exceeds the capture, starting with
 * the complete output captured so far. Write failures, including a full disk,
 * mark the log incomplete and never affect the command itself.
 */
export async function openTerminalLog(input: { id: string; grantId: string; runId?: string | null; stdout: string; stderr: string; active: string[] }) {
  // Every running command is protected, including one whose log is being created.
  await pruneTerminalLogs([...input.active, input.id]).catch(() => console.error("terminal.log.prune.failed"));
  const directory = logDirectory(input.id);
  const now = new Date();
  const meta: Meta = { id: input.id, grantId: input.grantId, runId: input.runId ?? null, stdoutBytes: 0, stderrBytes: 0, complete: true,
    createdAt: now.toISOString(), finishedAt: null, expiresAt: new Date(now.getTime() + TERMINAL_LOG_LIMITS.retentionMs).toISOString() };
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "meta.json"), JSON.stringify(meta));
  } catch {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    return null;
  }
  let failed = false;
  const streams: Record<Stream, WriteStream> = {
    stdout: createWriteStream(join(directory, "stdout.log")),
    stderr: createWriteStream(join(directory, "stderr.log")),
  };
  for (const stream of Object.values(streams)) stream.on("error", () => { failed = true; meta.complete = false; });
  const write = (field: Stream, text: string) => {
    if (failed || !text) return;
    const bytes = Buffer.from(text);
    const room = TERMINAL_LOG_LIMITS.bytesPerCommand - meta.stdoutBytes - meta.stderrBytes;
    if (bytes.length > room) meta.complete = false;
    const selected = bytes.subarray(0, Math.max(0, room));
    if (!selected.length) return;
    meta[`${field}Bytes`] += selected.length;
    streams[field].write(selected);
  };
  write("stdout", input.stdout); write("stderr", input.stderr);
  return {
    write,
    reference: (): TerminalLogReference => ({ id: meta.id, stdoutBytes: meta.stdoutBytes, stderrBytes: meta.stderrBytes, complete: meta.complete, expiresAt: meta.expiresAt }),
    /** Flushes both files; `complete` is false when output was lost or the command did not finish. */
    async close(finished: boolean) {
      await Promise.all(Object.values(streams).map(stream => new Promise<void>(resolve => stream.end(() => resolve()))));
      if (!finished) meta.complete = false;
      meta.finishedAt = new Date().toISOString();
      await writeFile(join(directory, "meta.json"), JSON.stringify(meta)).catch(() => { meta.complete = false; });
      return { id: meta.id, stdoutBytes: meta.stdoutBytes, stderrBytes: meta.stderrBytes, complete: meta.complete, expiresAt: meta.expiresAt };
    },
  };
}
export type TerminalLogWriter = NonNullable<Awaited<ReturnType<typeof openTerminalLog>>>;

/**
 * Remove expired logs, logs whose run was deleted, unreadable directories and,
 * oldest first, finished logs beyond the total size. Logs named in `active`
 * belong to running commands and are left alone.
 */
export async function pruneTerminalLogs(active: string[] = []) {
  const root = terminalLogRoot();
  const names = await readdir(root).catch(() => [] as string[]);
  const logs: { id: string; meta: Meta | null; bytes: number }[] = [];
  for (const id of names) {
    if (active.includes(id)) continue;
    const meta = await readMeta(id);
    logs.push({ id, meta, bytes: meta ? meta.stdoutBytes + meta.stderrBytes : 0 });
  }
  const runIds = [...new Set(logs.flatMap(log => log.meta?.runId ? [log.meta.runId] : []))];
  const existingRuns = new Set((await db.agentRun.findMany({ where: { id: { in: runIds } }, select: { id: true } })).map(run => run.id));
  const now = Date.now(), kept: typeof logs = [];
  for (const log of logs) {
    const stale = !log.meta || Date.parse(log.meta.expiresAt) <= now || (log.meta.runId !== null && !existingRuns.has(log.meta.runId));
    if (stale) await rm(join(root, log.id), { recursive: true, force: true });
    else kept.push(log);
  }
  let total = kept.reduce((sum, log) => sum + log.bytes, 0);
  for (const log of kept.sort((a, b) => Date.parse(a.meta!.createdAt) - Date.parse(b.meta!.createdAt))) {
    if (total <= TERMINAL_LOG_LIMITS.totalBytes) break;
    // An unfinished log may belong to a command still writing it; expiry removes one left by a crash.
    if (log.meta!.finishedAt === null) continue;
    await rm(join(root, log.id), { recursive: true, force: true });
    total -= log.bytes;
  }
}

export const readTerminalLogInputSchema = z.strictObject({
  logId: z.uuid().describe("The id of a terminal log referenced by an earlier runTerminalCommand result."),
  stream: z.enum(["stdout", "stderr"]).default("stdout"),
  startLine: z.number().int().min(1).default(1).describe("First 1-based line to return."),
  lineCount: z.number().int().min(1).max(TERMINAL_LOG_LIMITS.readLines).default(200),
  search: z.string().min(1).max(200).optional().describe("Case-insensitive text to find; returns matching line numbers from startLine instead of a range."),
});
export type ReadTerminalLogInput = z.infer<typeof readTerminalLogInputSchema>;

/** Bounded reads only: a page of lines or a list of matching lines, with where to continue. */
export async function readTerminalLog(input: ReadTerminalLogInput, authorize: (grantId: string) => Promise<unknown>, signal?: AbortSignal) {
  const meta = await readMeta(input.logId);
  if (!meta || Date.parse(meta.expiresAt) <= Date.now()) throw notFound();
  await authorize(meta.grantId);
  const file = join(logDirectory(meta.id), `${input.stream}.log`);
  const size = (await stat(file).catch(() => null))?.size;
  if (size === undefined) throw notFound();
  const needle = input.search?.toLocaleLowerCase();
  const lines: { line: number; text: string }[] = [];
  let lineNumber = 0, bytes = 0, nextLine: number | null = null, matches = 0;
  const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const raw of reader) {
      signal?.throwIfAborted();
      lineNumber++;
      if (lineNumber < input.startLine || nextLine !== null) continue;
      if (needle) {
        if (!raw.toLocaleLowerCase().includes(needle)) continue;
        matches++;
        if (matches > TERMINAL_LOG_LIMITS.searchMatches) { nextLine = lineNumber; continue; }
      } else if (lines.length >= input.lineCount) { nextLine = lineNumber; continue; }
      const text = raw.length > TERMINAL_LOG_LIMITS.lineCharacters ? `${raw.slice(0, TERMINAL_LOG_LIMITS.lineCharacters)} … [line truncated]` : raw;
      bytes += Buffer.byteLength(text) + 1;
      if (bytes > TERMINAL_LOG_LIMITS.readBytes && lines.length) { nextLine = lineNumber; continue; }
      lines.push({ line: lineNumber, text });
    }
  } finally { reader.close(); }
  return {
    logId: meta.id, stream: input.stream, totalLines: lineNumber, totalBytes: size,
    complete: meta.complete && meta.finishedAt !== null, ...(needle ? { search: input.search } : {}), lines, nextLine,
  };
}

/**
 * Remove a folder's logs when its terminal access ends. Logs of commands still
 * running are skipped; they stay unreadable without access and expire normally.
 */
export async function removeTerminalLogsForGrant(grantId: string, active: string[] = []) {
  const root = terminalLogRoot();
  for (const id of await readdir(root).catch(() => [] as string[])) {
    if (active.includes(id)) continue;
    const meta = await readMeta(id);
    if (meta?.grantId === grantId) await rm(join(root, id), { recursive: true, force: true });
  }
}
