import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { MediaAsset } from "@prisma/client";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { MEDIA_LIMITS } from "@/lib/media/limits";
import { ASSET_ID_PATTERN, mediaUrl, type MediaReference } from "@/lib/media/message-codec";

const extensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};
const managedFilePattern = /^(?:[0-9a-f-]{36}\.(?:png|jpg|webp|gif|mp4|webm|mov)|\.tmp-[0-9a-f-]{36})$/;

export function getMediaDirectory(): string {
  const configured = process.env.MEDIA_DIRECTORY?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "MEDIA_DIRECTORY must be absolute" });
    return resolve(configured);
  }
  const url = process.env.DATABASE_URL || "";
  const databaseFile = url.startsWith("file://") ? fileURLToPath(url) : url.startsWith("file:") ? url.slice(5) : "";
  if (!isAbsolute(databaseFile)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "Media storage requires an absolute local SQLite path" });
  return join(dirname(databaseFile), "media");
}

export function mediaOwnerDirectory(userId: string): string {
  return createHash("sha256").update(userId).digest("hex");
}

function pathError() { return new ApiError({ code: "NOT_FOUND", message: "Media file is unavailable" }); }
function isMissing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

async function safeOwnerDirectory(userId: string, create: boolean) {
  const root = getMediaDirectory();
  if (create) await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw pathError();
  // Runtime user data is not a build input and must never enter standalone output.
  const canonicalRoot = await realpath(/* turbopackIgnore: true */ root);
  const directory = join(canonicalRoot, mediaOwnerDirectory(userId));
  if (create) await mkdir(directory, { recursive: true });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw pathError();
  if (await realpath(directory) !== directory) throw pathError();
  return directory;
}

function assertRelativePath(asset: Pick<MediaAsset, "id" | "userId" | "mediaType" | "relativePath">) {
  if (!ASSET_ID_PATTERN.test(asset.id) || !extensions[asset.mediaType] ||
      asset.relativePath !== `${mediaOwnerDirectory(asset.userId)}/${asset.id}.${extensions[asset.mediaType]}`) throw pathError();
}

export function validateMediaBytes(bytes: Uint8Array, mediaType: string, maxBytes: number) {
  if (!bytes.length || bytes.length > maxBytes) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "Media is empty or exceeds the size limit" });
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 32));
  const matches = mediaType === "image/png" ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mediaType === "image/jpeg" ? head[0] === 255 && head[1] === 216 && head[2] === 255
    : mediaType === "image/gif" ? /^(GIF87a|GIF89a)/.test(head.toString("ascii"))
    : mediaType === "image/webp" ? head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP"
    : mediaType === "video/webm" ? head.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
    : mediaType === "video/mp4" || mediaType === "video/quicktime" ? head.toString("ascii", 4, 8) === "ftyp"
    : false;
  if (!matches) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unsupported media type or mismatched file signature" });
}

export function decodeImageDataUrl(url: string, maxBytes: number) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match || match[2].length % 4 !== 0) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid image data URL" });
  if (match[2].length > Math.ceil(maxBytes / 3) * 4) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "Image exceeds the size limit" });
  const bytes = Buffer.from(match[2], "base64");
  validateMediaBytes(bytes, match[1], maxBytes);
  return { bytes, mediaType: match[1] };
}

export function toMediaReference(asset: MediaAsset): MediaReference {
  return { assetId: asset.id, relativePath: asset.relativePath, mediaType: asset.mediaType, byteSize: asset.byteSize, url: mediaUrl(asset.id) };
}

export async function createMediaAsset(input: {
  userId: string; bytes: Uint8Array; mediaType: string; kind: "attachment" | "generated-image" | "generated-video";
  modelId?: string; description?: string;
}) {
  const maximum = input.kind === "attachment" ? MEDIA_LIMITS.attachmentBytes : input.kind === "generated-image" ? MEDIA_LIMITS.generatedImageBytes : MEDIA_LIMITS.generatedVideoBytes;
  if ((input.kind === "generated-video") !== input.mediaType.startsWith("video/")) throw new ApiError({ code: "VALIDATION_ERROR", message: "Unexpected media type" });
  validateMediaBytes(input.bytes, input.mediaType, maximum);
  const directory = await safeOwnerDirectory(input.userId, true);
  const id = randomUUID();
  const filename = `${id}.${extensions[input.mediaType]}`;
  const temporary = join(directory, `.tmp-${id}`);
  const destination = join(/* turbopackIgnore: true */ directory, filename);
  // Write and close a complete file before making it visible in the database.
  // Interrupted writes remain unreferenced and can be reclaimed after the grace period.
  await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, destination);
  return db.mediaAsset.create({ data: {
    id, userId: input.userId, relativePath: `${mediaOwnerDirectory(input.userId)}/${filename}`,
    mediaType: input.mediaType, byteSize: input.bytes.byteLength, kind: input.kind,
    modelId: input.modelId?.slice(0, 200), description: input.description?.slice(0, 4000),
  } });
}

export async function getMediaAsset(userId: string, id: string) {
  if (!ASSET_ID_PATTERN.test(id)) throw pathError();
  const asset = await db.mediaAsset.findFirst({ where: { id, userId, deletedAt: null } });
  if (!asset) throw pathError();
  assertRelativePath(asset);
  return asset;
}

export async function openMediaAsset(asset: MediaAsset) {
  assertRelativePath(asset);
  try {
    const directory = await safeOwnerDirectory(asset.userId, false);
    const file = join(/* turbopackIgnore: true */ directory, `${asset.id}.${extensions[asset.mediaType]}`);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.byteSize || await realpath(/* turbopackIgnore: true */ file) !== file) throw pathError();
    const handle = await open(/* turbopackIgnore: true */ file, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== asset.byteSize || opened.ino !== stat.ino) throw pathError();
      return handle;
    } catch (error) { await handle.close(); throw error; }
  } catch (error) { if (isMissing(error)) throw pathError(); throw error; }
}

export async function readMediaAsset(asset: MediaAsset) {
  const handle = await openMediaAsset(asset);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function removeClaimedAsset(asset: MediaAsset) {
  assertRelativePath(asset);
  try {
    const directory = await safeOwnerDirectory(asset.userId, false);
    const file = join(/* turbopackIgnore: true */ directory, `${asset.id}.${extensions[asset.mediaType]}`);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ file) !== file) throw pathError();
    await unlink(file);
  } catch (error) { if (!isMissing(error)) throw error; }
  await db.mediaAsset.deleteMany({ where: { id: asset.id, userId: asset.userId, deletedAt: { not: null }, references: { none: {} } } });
}

export async function deleteMediaAsset(userId: string, id: string, olderThan?: Date) {
  if (!ASSET_ID_PATTERN.test(id)) throw pathError();
  const asset = await db.$transaction(async (tx) => {
    const existing = await tx.mediaAsset.findFirst({ where: { id, userId } });
    if (!existing) throw pathError();
    const claimed = await tx.mediaAsset.updateMany({ where: {
      id, userId, references: { none: {} }, ...(olderThan ? { lastUsedAt: { lt: olderThan } } : {}),
    }, data: { deletedAt: new Date() } });
    if (claimed.count !== 1) throw new ApiError({ code: "CONFLICT", message: "Media is still referenced or too recent to clean up" });
    return existing;
  });
  await removeClaimedAsset(asset);
  return asset.byteSize;
}

async function listManagedFiles(userId: string) {
  try {
    const directory = await safeOwnerDirectory(userId, false);
    const entries = await readdir(directory, { withFileTypes: true });
    const files: Array<{ path: string; relativePath: string; size: number; modifiedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !managedFilePattern.test(entry.name)) continue;
      const file = join(directory, entry.name);
      const stat = await lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink()) files.push({ path: file, relativePath: `${mediaOwnerDirectory(userId)}/${entry.name}`, size: stat.size, modifiedAt: stat.mtimeMs });
    }
    return files;
  } catch (error) { if (isMissing(error)) return []; throw error; }
}

export async function getMediaStats(userId: string) {
  const assets = await db.mediaAsset.findMany({ where: { userId }, include: { _count: { select: { references: true } } } });
  const files = await listManagedFiles(userId);
  const known = new Set(assets.map((asset) => asset.relativePath));
  const cutoff = Date.now() - MEDIA_LIMITS.orphanGraceMs;
  const unreferenced = assets.filter((asset) => asset._count.references === 0);
  const looseFiles = files.filter((file) => !known.has(file.relativePath));
  return {
    assetCount: assets.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    referencedCount: assets.length - unreferenced.length, unreferencedCount: unreferenced.length,
    reclaimableCount: unreferenced.filter((asset) => asset.lastUsedAt.getTime() < cutoff).length + looseFiles.filter((file) => file.modifiedAt < cutoff).length,
    looseFileCount: looseFiles.length, graceHours: MEDIA_LIMITS.orphanGraceMs / 3_600_000,
  };
}

export async function cleanupMedia(userId: string) {
  const cutoff = new Date(Date.now() - MEDIA_LIMITS.orphanGraceMs);
  const candidates = await db.mediaAsset.findMany({ where: { userId, lastUsedAt: { lt: cutoff }, references: { none: {} } } });
  let removedCount = 0, freedBytes = 0, failedCount = 0;
  for (const asset of candidates) {
    try { freedBytes += await deleteMediaAsset(userId, asset.id, cutoff); removedCount += 1; }
    catch { failedCount += 1; } // Keep failed tombstones for a later cleanup attempt.
  }
  const known = new Set((await db.mediaAsset.findMany({ where: { userId }, select: { relativePath: true } })).map((asset) => asset.relativePath));
  for (const file of await listManagedFiles(userId)) {
    if (known.has(file.relativePath) || file.modifiedAt >= cutoff.getTime()) continue;
    try {
      // Check again immediately before deleting: a file may have acquired metadata.
      if (await db.mediaAsset.findUnique({ where: { relativePath: file.relativePath } })) continue;
      const directory = await safeOwnerDirectory(userId, false);
      if (!file.path.startsWith(`${directory}${sep}`) || (await lstat(file.path)).isSymbolicLink()) throw pathError();
      await unlink(file.path); freedBytes += file.size; removedCount += 1;
    } catch { failedCount += 1; }
  }
  return { removedCount, freedBytes, failedCount };
}
