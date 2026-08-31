import { randomUUID, createHash } from "node:crypto";
import { open, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { db } from "@/db";
import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/server/api-error";
import { getModelPreferences } from "@/lib/models/preferences";
import { openMediaAsset } from "@/lib/media/storage";
import { decodeMediaMessage } from "@/lib/media/message-codec";
import { BACKUP_LIMITS, backupManifestSchema, type BackupManifest } from "@/lib/backups/schema";
import { backupFile, listBackupFiles, openBackup, removeBackupFile } from "@/lib/backups/files";

const MAGIC = Buffer.from("PAIB0001");
const invalid = () => new ApiError({ code: "VALIDATION_ERROR", message: "备份格式、长度或校验值无效。" });
async function readExact(handle: FileHandle, length: number, position: number) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) { const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset); if (!bytesRead) throw invalid(); offset += bytesRead; }
  return buffer;
}
export async function readBackupManifest(handle: FileHandle) {
  const header = await readExact(handle, 44, 0);
  if (!header.subarray(0, 8).equals(MAGIC)) throw invalid();
  const length = header.readUInt32BE(8);
  if (length < 2 || length > BACKUP_LIMITS.manifest) throw invalid();
  let manifest: BackupManifest;
  try {
    const json = await readExact(handle, length, 44);
    if (!createHash("sha256").update(json).digest().equals(header.subarray(12, 44))) throw invalid();
    manifest = backupManifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)));
  }
  catch { throw invalid(); }
  const end = 44 + length + manifest.assets.reduce((sum, asset) => sum + asset.byteSize, 0);
  if (end > BACKUP_LIMITS.bytes || (await handle.stat()).size !== end) throw invalid();
  return { manifest, offset: 44 + length };
}
export async function readBackupAsset(handle: FileHandle, asset: BackupManifest["assets"][number], offset: number) {
  const bytes = await readExact(handle, asset.byteSize, offset);
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw invalid();
  return bytes;
}
async function copyAndHash(source: FileHandle, target?: FileHandle) {
  const buffer = Buffer.alloc(256 * 1024);
  const hash = createHash("sha256"); let position = 0;
  for (;;) { const { bytesRead } = await source.read(buffer, 0, buffer.length, position); if (!bytesRead) break; const bytes = buffer.subarray(0, bytesRead); hash.update(bytes); if (target) await target.writeFile(bytes); position += bytesRead; }
  return hash.digest("hex");
}
function omitOwner<T extends { userId: string }>(record: T) { const { userId: _owner, ...fields } = record; return fields; }
function portableContent(content: string) {
  const prefix = /^__(?:USER_MESSAGE|ASSISTANT_TOOL_MESSAGE|IMAGE_RESULT|VIDEO_RESULT)__:/.exec(content)?.[0];
  if (!prefix) return content;
  try { return prefix + JSON.stringify(JSON.parse(content.slice(prefix.length)), (key, value) => key === "relativePath" || key === "approval" ? undefined : value); }
  catch { return content; }
}

export async function createAccountBackup(userId: string, prune = true) {
  const counts = await Promise.all([db.chat.count({ where: { userId } }), db.message.count({ where: { chat: { userId } } }), db.memory.count({ where: { userId } }), db.task.count({ where: { userId } }), db.mediaAsset.count({ where: { userId } })]);
  const [documentsCount, termsCount] = await Promise.all([db.knowledgeDocument.count({ where: { userId } }), db.documentTerm.count({ where: { chunk: { document: { userId } } } })]);
  const [volume] = await db.$queryRaw<{ bytes: number | bigint }[]>(Prisma.sql`SELECT
    (SELECT coalesce(sum(length(CAST(content AS BLOB))),0) FROM messages WHERE chatId IN (SELECT id FROM chats WHERE userId=${userId})) +
    (SELECT coalesce(sum(length(CAST(title AS BLOB))),0) FROM chats WHERE userId=${userId}) +
    (SELECT coalesce(sum(length(CAST(title AS BLOB))+coalesce(length(CAST(details AS BLOB)),0)),0) FROM tasks WHERE userId=${userId}) +
    (SELECT coalesce(sum(length(CAST(key AS BLOB))+length(CAST(value AS BLOB))+coalesce(length(CAST(embedding AS BLOB)),0)),0) FROM memories WHERE userId=${userId}) +
    (SELECT coalesce(sum(length(CAST(pages AS BLOB))),0) FROM knowledge_documents WHERE userId=${userId}) +
    (SELECT coalesce(sum(length(CAST(text AS BLOB))),0) FROM document_chunks WHERE documentId IN (SELECT id FROM knowledge_documents WHERE userId=${userId})) +
    (SELECT coalesce(sum(coalesce(length(CAST(description AS BLOB)),0)+coalesce(length(CAST(generation AS BLOB)),0)),0) FROM media_assets WHERE userId=${userId}) AS bytes`);
  if (counts.some(count => count > BACKUP_LIMITS.rows) || documentsCount > 100 || termsCount > 100_000 || Number(volume.bytes) > BACKUP_LIMITS.manifest) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "账户数据超出便携备份上限，请使用离线目录备份。" });
  const [chats, memories, tasks, documents, assets, preferences, usage] = await Promise.all([
    db.chat.findMany({ where: { userId }, include: { tags: true, messages: true } }),
    db.memory.findMany({ where: { userId } }), db.task.findMany({ where: { userId } }),
    db.knowledgeDocument.findMany({ where: { userId }, include: { chunks: { include: { terms: true } } } }),
    db.mediaAsset.findMany({ where: { userId, deletedAt: null }, include: { references: true, inputs: true } }),
    getModelPreferences(userId), db.modelRequest.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 5000 }),
  ]);
  if (chats.some(chat => chat.messages.some(message => { const media = decodeMediaMessage(message.content); return media?.type === "video-result" && !media.assetId; }))) throw new ApiError({ code: "CONFLICT", message: "存在尚未迁移的旧视频。请先打开对应会话完成媒体迁移，或停机备份数据库、媒体及旧视频目录。" });
  if (assets.reduce((sum, asset) => sum + asset.byteSize, 0) > BACKUP_LIMITS.bytes) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "备份超过 512 MiB 上限，请先减少数据或使用离线目录备份。" });
  const media = [];
  for (const asset of assets) {
    const file = await openMediaAsset(asset);
    try {
      const { userId: _owner, relativePath: _path, deletedAt: _deleted, ...fields } = asset;
      media.push({ ...fields, sha256: await copyAndHash(file) });
    } finally { await file.close(); }
  }
  const manifest = backupManifestSchema.parse(JSON.parse(JSON.stringify({ format: "private-ai-account-backup", version: 1, createdAt: new Date().toISOString(), chats: chats.map(chat => ({ ...omitOwner(chat), messages: chat.messages.map(message => ({ ...message, content: portableContent(message.content) })) })), memories: memories.map(omitOwner), tasks: tasks.map(omitOwner), documents: documents.map(omitOwner), assets: media, preferences, usage: usage.map(omitOwner) })));
  const json = Buffer.from(JSON.stringify(manifest));
  if (json.length > BACKUP_LIMITS.manifest || 44 + json.length + assets.reduce((sum, asset) => sum + asset.byteSize, 0) > BACKUP_LIMITS.bytes) throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "备份内容超过支持的大小上限。" });
  const id = randomUUID(), temporary = await backupFile(userId, id, "partial");
  const target = await open(temporary, "wx", 0o600);
  try {
    const header = Buffer.alloc(44); MAGIC.copy(header); header.writeUInt32BE(json.length, 8); createHash("sha256").update(json).digest().copy(header, 12);
    await target.writeFile(header); await target.writeFile(json);
    for (let i = 0; i < assets.length; i++) {
      const source = await openMediaAsset(assets[i]);
      try { if (await copyAndHash(source, target) !== manifest.assets[i].sha256) throw invalid(); }
      finally { await source.close(); }
    }
    await target.sync();
  } finally { await target.close(); }
  await rename(temporary, await backupFile(userId, id));
  const cleanup = prune ? await pruneAccountBackupsSafely(userId, id) : undefined;
  return { id, createdAt: manifest.createdAt, bytes: 44 + json.length + assets.reduce((sum, asset) => sum + asset.byteSize, 0), cleanupFailed: !!cleanup?.failed };
}
export async function pruneAccountBackupsSafely(userId: string, preserveId?: string) {
  // Cleanup cannot turn an already committed backup or restore into a failure.
  try { return await pruneAccountBackups(userId, preserveId); }
  catch { console.error("backup.cleanup.failed"); return { removed: 0, failed: 1 }; }
}
export async function pruneAccountBackups(userId: string, preserveId?: string) {
  const preferences = await getModelPreferences(userId);
  const files = await listBackupFiles(userId);
  const complete = files.filter(file => file.extension === "paib");
  let removed = 0, failed = 0;
  for (const file of files) {
    const age = Date.now() - Date.parse(file.createdAt);
    const expired = file.extension !== "paib" ? age > BACKUP_LIMITS.stagingAgeMs : file.id !== complete[0]?.id && (age > preferences.backupRetentionDays * 86_400_000 || complete.indexOf(file) >= preferences.backupMaxCount);
    if (!expired || file.id === preserveId) continue;
    try { await removeBackupFile(userId, file.id, file.extension); removed++; } catch { failed++; }
  }
  return { removed, failed };
}
export async function inspectAccountBackup(userId: string, id: string) {
  const file = await openBackup(userId, id);
  try {
    const { manifest } = await readBackupManifest(file);
    return { id, createdAt: manifest.createdAt, bytes: (await file.stat()).size, counts: { chats: manifest.chats.length, messages: manifest.chats.reduce((sum, chat) => sum + chat.messages.length, 0), tasks: manifest.tasks.length, memories: manifest.memories.length, documents: manifest.documents.length, assets: manifest.assets.length, usage: manifest.usage.length } };
  } finally { await file.close(); }
}
