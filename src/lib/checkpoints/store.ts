import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { db } from "@/db";
import { localDataDirectory } from "@/lib/local/data-directory";

/*
 * Content kept so a turn's file changes can be undone: one file per distinct
 * content, named by its SHA-256, beside the database (`checkpoints/blobs`).
 * The same content is stored once however many files or turns hold it, and
 * compressed when that saves space (`<hash>.gz`). What refers to a blob (a
 * checkpoint row, the workspace backup's current view) is recorded elsewhere;
 * this stores, reads, measures and prunes.
 */

export const CHECKPOINT_LIMITS = {
  /** The largest file whose content is copied, edited or changed by a command. */
  fileBytes: 64 * 1024 * 1024,
  /** All kept content together, unless the user set another limit. */
  totalBytes: 2 * 1024 * 1024 * 1024,
  /** How long a turn's changes stay undoable. */
  retentionMs: 14 * 24 * 60 * 60 * 1000,
} as const;
/** The limits the user can choose from, in MiB. */
export const CHECKPOINT_LIMIT_CHOICES_MB = [1024, 2048, 5120, 10240, 20480] as const;

export const checkpointRoot = () => join(localDataDirectory("File checkpoints"), "checkpoints");
const blobRoot = () => join(checkpointRoot(), "blobs");
const blobPath = (hash: string, compressed: boolean) => join(blobRoot(), hash.slice(0, 2), compressed ? `${hash}.gz` : hash);
const isHash = (value: string) => /^[a-f0-9]{64}$/.test(value);

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const exists = (file: string) => stat(file).then(() => true, () => false);
const compress = promisify(gzip), decompress = promisify(gunzip);

/*
 * What the store holds now, counted once from disk and kept up to date by
 * writes and removals. `generation` moves on whenever room opens up again, so
 * files that were not copied because the store was full are tried again then,
 * and not on every walk before that.
 */
type State = { used: number | null; counting: Promise<number> | null; limit: number | null; generation: number };
const state = (): State => ((globalThis as { __riaCheckpointStore?: State }).__riaCheckpointStore ??= { used: null, counting: null, limit: null, generation: 0 });

export async function storeUsage(): Promise<number> {
  const current = state();
  if (current.used !== null) return current.used;
  current.counting ??= listBlobs().then(blobs => (current.used = blobs.reduce((sum, blob) => sum + blob.bytes, 0)));
  return current.counting;
}

/** The limit the user chose, or the default. */
export async function storeLimit(): Promise<number> {
  const current = state();
  if (current.limit !== null) return current.limit;
  const row = await db.checkpointPreference.findUnique({ where: { id: "local" }, select: { limitMb: true } }).catch(() => null);
  return (current.limit = row ? row.limitMb * 1024 * 1024 : CHECKPOINT_LIMITS.totalBytes);
}

export async function saveStoreLimit(limitMb: number) {
  await db.checkpointPreference.upsert({ where: { id: "local" }, create: { id: "local", limitMb }, update: { limitMb } });
  const current = state();
  const raised = limitMb * 1024 * 1024 > (current.limit ?? CHECKPOINT_LIMITS.totalBytes);
  current.limit = limitMb * 1024 * 1024;
  if (raised) current.generation++;
}

export const storeGeneration = () => state().generation;
/** Room opened up (a prune went well under the limit): copies refused before may be tried again. */
export function storeHasRoom() { state().generation++; }

/**
 * Keeps content, once; returns its hash. A baseline copy (a file only kept in
 * case a later command changes it) is refused, with null, once the store is
 * full: what undo already needs is never pushed out to make room for it.
 * Written to a temporary name first, so a half-written file is never a blob.
 */
export async function putBlob(bytes: Uint8Array, known?: string, options: { baseline?: boolean } = {}): Promise<string | null> {
  const hash = known ?? sha256(bytes);
  if (await hasBlob(hash)) return hash;
  if (options.baseline && await storeUsage() + bytes.byteLength > await storeLimit()) return null;
  // Compressed only when a sample shows it pays: media and archives are stored as they are.
  const sample = bytes.subarray(0, 64 * 1024);
  const worthwhile = sample.byteLength > 512 && (await compress(sample)).byteLength < sample.byteLength * 0.9;
  const stored = worthwhile ? await compress(bytes) : bytes;
  const compressed = worthwhile && stored.byteLength < bytes.byteLength;
  const target = blobPath(hash, compressed);
  await mkdir(join(blobRoot(), hash.slice(0, 2)), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, compressed ? stored : bytes, { flag: "wx" });
    await rename(temporary, target).catch(async error => {
      // Another writer kept the same content first: the same bytes are already there.
      if (await exists(target)) return;
      throw error;
    });
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  const current = state();
  if (current.used !== null) current.used += (compressed ? stored : bytes).byteLength;
  return hash;
}

export async function hasBlob(hash: string): Promise<boolean> {
  return isHash(hash) && (await exists(blobPath(hash, true)) || await exists(blobPath(hash, false)));
}

/** The content kept under a hash, checked against it; null when it is not there or not what it should be. */
export async function readBlob(hash: string): Promise<Buffer | null> {
  if (!isHash(hash)) return null;
  const packed = await readFile(blobPath(hash, true)).catch(() => null);
  const bytes = packed ? await decompress(packed).catch(() => null) : await readFile(blobPath(hash, false)).catch(() => null);
  return bytes && sha256(bytes) === hash ? bytes : null;
}

/** Every kept blob, oldest first by when it was last written, with its size on disk. */
export async function listBlobs(): Promise<{ hash: string; bytes: number; modified: number }[]> {
  const found: { hash: string; bytes: number; modified: number }[] = [];
  const shards = await readdir(blobRoot()).catch(() => [] as string[]);
  for (const shard of shards) {
    for (const name of await readdir(join(blobRoot(), shard)).catch(() => [] as string[])) {
      const hash = name.endsWith(".gz") ? name.slice(0, -3) : name;
      if (!isHash(hash)) {
        // A temporary file left by a process that stopped mid-write.
        if (name.endsWith(".tmp")) await rm(join(blobRoot(), shard, name), { force: true }).catch(() => {});
        continue;
      }
      const info = await stat(join(blobRoot(), shard, name)).catch(() => null);
      if (info) found.push({ hash, bytes: info.size, modified: info.mtimeMs });
    }
  }
  return found.sort((a, b) => a.modified - b.modified);
}

export async function removeBlob(hash: string) {
  if (!isHash(hash)) return;
  for (const compressed of [true, false]) {
    const file = blobPath(hash, compressed);
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    await rm(file, { force: true }).catch(() => {});
    const current = state();
    if (current.used !== null) current.used = Math.max(0, current.used - info.size);
  }
}
