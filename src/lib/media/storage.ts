import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { MediaAsset } from "@prisma/client";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { MEDIA_LIMITS } from "@/lib/media/limits";
import { ASSET_ID_PATTERN, mediaUrl, type MediaReference } from "@/lib/media/message-codec";
import { generationRecipeSchema, type GenerationRecipe } from "@/lib/media/generation-recipe";
import { LOCAL_WORKSPACE_ID } from "@/lib/local/workspace";
import { localDataDirectory } from "@/lib/local/data-directory";

import { t } from "@/lib/locale";
const extensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "application/pdf": "pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
const managedFilePattern = /^(?:[0-9a-f-]{36}\.(?:png|jpg|webp|gif|mp4|webm|mov|pdf|docx)|\.tmp-[0-9a-f-]{36})$/;

export function getMediaDirectory(): string {
  const configured = process.env.MEDIA_DIRECTORY?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "MEDIA_DIRECTORY must be absolute" });
    return resolve(configured);
  }
  return join(localDataDirectory("Media storage"), "media");
}

/**
 * Every file belongs to the one local workspace. The workspace id still names
 * the directory the files live in, because those directories already exist on
 * disk and must not move.
 */
export function mediaOwnerDirectory(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex");
}

function pathError() { return new ApiError({ code: "NOT_FOUND", message: t("server.media.fileUnavailable") }); }
function isMissing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

async function safeOwnerDirectory(workspaceId: string, create: boolean) {
  const root = getMediaDirectory();
  if (create) await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw pathError();
  // Runtime user data is not a build input and must never enter standalone output.
  const canonicalRoot = await realpath(/* turbopackIgnore: true */ root);
  const directory = join(canonicalRoot, mediaOwnerDirectory(workspaceId));
  if (create) await mkdir(directory, { recursive: true });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw pathError();
  if (await realpath(directory) !== directory) throw pathError();
  return directory;
}

function assertRelativePath(asset: Pick<MediaAsset, "id" | "mediaType" | "relativePath">) {
  if (!ASSET_ID_PATTERN.test(asset.id) || !extensions[asset.mediaType] ||
      asset.relativePath !== `${mediaOwnerDirectory(LOCAL_WORKSPACE_ID)}/${asset.id}.${extensions[asset.mediaType]}`) throw pathError();
}

export function validateMediaBytes(bytes: Uint8Array, mediaType: string, maxBytes: number) {
  if (!bytes.length || bytes.length > maxBytes) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: t("server.media.emptyOrTooLarge") });
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 32));
  const matches = mediaType === "image/png" ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mediaType === "image/jpeg" ? head[0] === 255 && head[1] === 216 && head[2] === 255
    : mediaType === "image/gif" ? /^(GIF87a|GIF89a)/.test(head.toString("ascii"))
    : mediaType === "image/webp" ? head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP"
    : mediaType === "video/webm" ? head.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))
    : mediaType === "video/mp4" || mediaType === "video/quicktime" ? head.toString("ascii", 4, 8) === "ftyp"
    : mediaType === "application/pdf" ? head.toString("ascii", 0, 5) === "%PDF-"
    : mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ? head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    : false;
  if (!matches) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.media.unsupportedType") });
}

export function decodeImageDataUrl(url: string, maxBytes: number) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match || match[2].length % 4 !== 0) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.media.invalidImageDataUrl") });
  if (match[2].length > Math.ceil(maxBytes / 3) * 4) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: t("server.media.imageTooLarge") });
  const bytes = Buffer.from(match[2], "base64");
  validateMediaBytes(bytes, match[1], maxBytes);
  return { bytes, mediaType: match[1] };
}

export function toMediaReference(asset: MediaAsset): MediaReference {
  return { assetId: asset.id, relativePath: asset.relativePath, mediaType: asset.mediaType, byteSize: asset.byteSize, url: mediaUrl(asset.id) };
}

export async function createMediaAsset(input: {
  bytes: Uint8Array; mediaType: string; kind: "attachment" | "generated-image" | "generated-video";
  modelId?: string; modelProvider?: string; description?: string;
  generation?: GenerationRecipe; sourceChatId?: string;
}) {
  const generation = input.generation ? generationRecipeSchema.parse(input.generation) : undefined;
  const inputIds = [...new Set(generation?.inputImages.map(image => image.assetId) ?? [])];
  const contentHash = hashBytes(input.bytes);
  // Attaching what the library already holds (an image generated here, one attached before) reuses
  // that asset: one file, however many messages refer to it. A generated output is always new.
  if (input.kind === "attachment") {
    const same = await findSameContent(input.bytes, input.mediaType, contentHash);
    if (same) return same;
  }
  const staged = await stageMediaFile(input);
  return db.$transaction(async tx => {
    if (await tx.mediaAsset.count({ where: { id: { in: inputIds }, deletedAt: null } }) !== inputIds.length) throw pathError();
    const source = input.sourceChatId ? await tx.chat.findFirst({ where: { id: input.sourceChatId }, select: { id: true } }) : null;
    await tx.mediaAsset.updateMany({ where: { id: { in: inputIds } }, data: { lastUsedAt: new Date() } });
    return tx.mediaAsset.create({ data: {
      ...staged, contentHash,
      modelId: input.modelId?.slice(0, 200), modelProvider: input.modelProvider, description: input.description?.slice(0, 4000),
      ...(generation ? { generation, inputs: { create: inputIds.map(inputAssetId => ({ inputAssetId })) } } : {}),
      sourceChatId: source?.id,
    } });
  });
}

const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * A live asset with exactly these bytes, or null. Candidates are those of the
 * same type and size; one stored before hashes were kept is hashed from its file
 * the first time it is compared, and keeps the hash. The bytes are compared as
 * well, so a hash alone never makes two files one.
 */
async function findSameContent(bytes: Uint8Array, mediaType: string, contentHash: string): Promise<MediaAsset | null> {
  const candidates = await db.mediaAsset.findMany({
    where: { deletedAt: null, mediaType, byteSize: bytes.byteLength, OR: [{ contentHash }, { contentHash: null }] },
    orderBy: [{ contentHash: "desc" }, { createdAt: "asc" }], take: 20,
  });
  for (const candidate of candidates) {
    let stored: Buffer;
    try { stored = await readMediaAsset(candidate); } catch { continue; }
    const hash = candidate.contentHash ?? hashBytes(stored);
    if (!candidate.contentHash) await db.mediaAsset.updateMany({ where: { id: candidate.id, contentHash: null }, data: { contentHash: hash } }).catch(() => {});
    if (hash !== contentHash || !stored.equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))) continue;
    // Attached again: it is in use, so the library's cleanup leaves it for now.
    const used = await db.mediaAsset.updateMany({ where: { id: candidate.id, deletedAt: null }, data: { lastUsedAt: new Date() } });
    if (used.count) return { ...candidate, contentHash: hash, lastUsedAt: new Date() };
  }
  return null;
}

// A complete, unreferenced file can be staged before an atomic metadata restore.
// Failed transactions leave only managed orphan files for the normal grace period.
export async function stageMediaFile(input: { bytes: Uint8Array; mediaType: string; kind: "attachment" | "generated-image" | "generated-video" }) {
  const maximum = input.kind === "attachment" ? MEDIA_LIMITS.attachmentBytes : input.kind === "generated-image" ? MEDIA_LIMITS.generatedImageBytes : MEDIA_LIMITS.generatedVideoBytes;
  if ((input.kind === "generated-video") !== input.mediaType.startsWith("video/")) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.media.unexpectedType") });
  if (input.kind === "generated-image" && !input.mediaType.startsWith("image/")) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.media.unexpectedType") });
  validateMediaBytes(input.bytes, input.mediaType, maximum);
  const directory = await safeOwnerDirectory(LOCAL_WORKSPACE_ID, true);
  const id = randomUUID();
  const filename = `${id}.${extensions[input.mediaType]}`;
  const temporary = join(directory, `.tmp-${id}`);
  const destination = join(/* turbopackIgnore: true */ directory, filename);
  // Write and close a complete file before making it visible in the database.
  // Interrupted writes remain unreferenced and can be reclaimed after the grace period.
  await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, destination);
  return { id, relativePath: `${mediaOwnerDirectory(LOCAL_WORKSPACE_ID)}/${filename}`, mediaType: input.mediaType, byteSize: input.bytes.byteLength, kind: input.kind };
}

export async function getMediaAsset(id: string) {
  if (!ASSET_ID_PATTERN.test(id)) throw pathError();
  const asset = await db.mediaAsset.findFirst({ where: { id, deletedAt: null } });
  if (!asset) throw pathError();
  assertRelativePath(asset);
  return asset;
}

/** The asset's own file, checked: inside the media folder, the file itself (not a link), the size recorded. */
async function checkedAssetFile(asset: MediaAsset) {
  assertRelativePath(asset);
  const directory = await safeOwnerDirectory(LOCAL_WORKSPACE_ID, false);
  const file = join(/* turbopackIgnore: true */ directory, `${asset.id}.${extensions[asset.mediaType]}`);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.byteSize || await realpath(/* turbopackIgnore: true */ file) !== file) throw pathError();
  return { file, stat };
}

export async function openMediaAsset(asset: MediaAsset) {
  try {
    const { file, stat } = await checkedAssetFile(asset);
    const handle = await open(/* turbopackIgnore: true */ file, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== asset.byteSize || opened.ino !== stat.ino) throw pathError();
      return handle;
    } catch (error) { await handle.close(); throw error; }
  } catch (error) { if (isMissing(error)) throw pathError(); throw error; }
}

/**
 * Where the asset's own file is on disk, for showing it in the file manager:
 * checked as a read is (inside the media folder, the file itself, not a link,
 * the size recorded), so only the asset's file can be pointed at. Missing:
 * NOT_FOUND, as for a read.
 */
export async function locateMediaAsset(asset: MediaAsset): Promise<string> {
  try { return (await checkedAssetFile(asset)).file; } catch (error) { if (isMissing(error)) throw pathError(); throw error; }
}

export async function readMediaAsset(asset: MediaAsset) {
  const handle = await openMediaAsset(asset);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function removeClaimedAsset(asset: MediaAsset) {
  assertRelativePath(asset);
  try {
    const directory = await safeOwnerDirectory(LOCAL_WORKSPACE_ID, false);
    const file = join(/* turbopackIgnore: true */ directory, `${asset.id}.${extensions[asset.mediaType]}`);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ file) !== file) throw pathError();
    await unlink(file);
  } catch (error) {
    // The claim is the only record that the bytes are gone. A file that cannot
    // be removed must leave the asset live, or it stays invisible to the
    // library and the user has no way left to retry it. A restore failure is
    // not worth hiding the original error.
    if (!isMissing(error)) {
      await db.mediaAsset.updateMany({ where: { id: asset.id, deletedAt: { not: null } }, data: { deletedAt: null } }).catch(() => {});
      throw error;
    }
  }
  await db.$transaction(async tx => {
    await tx.mediaAsset.updateMany({ where: { usedByGenerations: { some: { assetId: asset.id } } }, data: { lastUsedAt: new Date() } });
    await tx.mediaAsset.deleteMany({ where: { id: asset.id, deletedAt: { not: null }, references: { none: {} }, usedByGenerations: { none: {} } } });
  });
}

export async function deleteMediaAsset(id: string, olderThan?: Date) {
  if (!ASSET_ID_PATTERN.test(id)) throw pathError();
  const asset = await db.$transaction(async (tx) => {
    const existing = await tx.mediaAsset.findFirst({ where: { id } });
    if (!existing) throw pathError();
    const claimed = await tx.mediaAsset.updateMany({ where: {
      id, references: { none: {} }, usedByGenerations: { none: {} }, ...(olderThan ? { lastUsedAt: { lt: olderThan } } : {}),
    }, data: { deletedAt: new Date() } });
    if (claimed.count !== 1) throw new ApiError({ code: "CONFLICT", message: t("server.media.stillReferenced") });
    return existing;
  });
  await removeClaimedAsset(asset);
  return asset.byteSize;
}

async function listManagedFiles() {
  try {
    const directory = await safeOwnerDirectory(LOCAL_WORKSPACE_ID, false);
    const entries = await readdir(directory, { withFileTypes: true });
    const files: Array<{ path: string; relativePath: string; size: number; modifiedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !managedFilePattern.test(entry.name)) continue;
      const file = join(directory, entry.name);
      const stat = await lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink()) files.push({ path: file, relativePath: `${mediaOwnerDirectory(LOCAL_WORKSPACE_ID)}/${entry.name}`, size: stat.size, modifiedAt: stat.mtimeMs });
    }
    return files;
  } catch (error) { if (isMissing(error)) return []; throw error; }
}

export async function getMediaStats() {
  const assets = await db.mediaAsset.findMany({ select: { relativePath: true, lastUsedAt: true, _count: { select: { references: true, usedByGenerations: true } } } });
  const files = await listManagedFiles();
  const known = new Set(assets.map((asset) => asset.relativePath));
  const cutoff = Date.now() - MEDIA_LIMITS.orphanGraceMs;
  const unreferenced = assets.filter((asset) => asset._count.references === 0 && asset._count.usedByGenerations === 0);
  const looseFiles = files.filter((file) => !known.has(file.relativePath));
  return {
    assetCount: assets.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    referencedCount: assets.length - unreferenced.length, unreferencedCount: unreferenced.length,
    reclaimableCount: unreferenced.filter((asset) => asset.lastUsedAt.getTime() < cutoff).length + looseFiles.filter((file) => file.modifiedAt < cutoff).length,
    looseFileCount: looseFiles.length, graceHours: MEDIA_LIMITS.orphanGraceMs / 3_600_000,
  };
}

export async function cleanupMedia() {
  const cutoff = new Date(Date.now() - MEDIA_LIMITS.orphanGraceMs);
  const candidates = await db.mediaAsset.findMany({ where: { lastUsedAt: { lt: cutoff }, references: { none: {} }, usedByGenerations: { none: {} } } });
  let removedCount = 0, freedBytes = 0, failedCount = 0;
  for (const asset of candidates) {
    try { freedBytes += await deleteMediaAsset(asset.id, cutoff); removedCount += 1; }
    catch { failedCount += 1; } // Keep failed tombstones for a later cleanup attempt.
  }
  const known = new Set((await db.mediaAsset.findMany({ select: { relativePath: true } })).map((asset) => asset.relativePath));
  for (const file of await listManagedFiles()) {
    if (known.has(file.relativePath) || file.modifiedAt >= cutoff.getTime()) continue;
    try {
      // Check again immediately before deleting: a file may have acquired metadata.
      if (await db.mediaAsset.findUnique({ where: { relativePath: file.relativePath } })) continue;
      const directory = await safeOwnerDirectory(LOCAL_WORKSPACE_ID, false);
      if (!file.path.startsWith(`${directory}${sep}`) || (await lstat(file.path)).isSymbolicLink()) throw pathError();
      await unlink(file.path); freedBytes += file.size; removedCount += 1;
    } catch { failedCount += 1; }
  }
  return { removedCount, freedBytes, failedCount };
}
