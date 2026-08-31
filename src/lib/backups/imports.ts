import { randomUUID } from "node:crypto";
import { open, rename } from "node:fs/promises";
import { ApiError } from "@/lib/server/api-error";
import { readLimitedBody } from "@/lib/server/request-body";
import { BACKUP_LIMITS } from "@/lib/backups/schema";
import { backupFile, listBackupFiles, openBackup, removeBackupFile } from "@/lib/backups/files";
import { inspectAccountBackup, readBackupAsset, readBackupManifest } from "@/lib/backups/archive";
import { validateMediaBytes } from "@/lib/media/storage";

const shared = globalThis as typeof globalThis & { backupUploads?: Map<string, { id: string; size: number; offset: number; expires: number }> };
const uploads = shared.backupUploads ??= new Map();
export async function beginBackupImport(userId: string, size: number) {
  for (const [owner, upload] of uploads) if (upload.expires < Date.now()) uploads.delete(owner);
  if (uploads.size >= 32 && !uploads.has(userId)) throw new ApiError({ code: "SERVICE_UNAVAILABLE", message: "上传任务过多，请稍后重试。" });
  const existing = uploads.get(userId);
  if (existing && existing.expires > Date.now()) throw new ApiError({ code: "CONFLICT", message: "已有备份正在上传，请先取消或等待过期。" });
  // Partial uploads cannot resume after restart. Only this owner's managed
  // staging files are removed when starting a replacement upload.
  for (const file of await listBackupFiles(userId)) if (file.extension === "upload") await removeBackupFile(userId, file.id, "upload");
  const id = randomUUID(); const file = await open(await backupFile(userId, id, "upload"), "wx", 0o600); await file.close();
  uploads.set(userId, { id, size, offset: 0, expires: Date.now() + BACKUP_LIMITS.stagingAgeMs });
  return { id, chunkBytes: BACKUP_LIMITS.chunk };
}
function pending(userId: string, id: string) {
  const upload = uploads.get(userId);
  if (!upload || upload.id !== id || upload.expires < Date.now()) throw new ApiError({ code: "NOT_FOUND", message: "上传已过期或不存在，请重新导入。" });
  return upload;
}
export async function appendBackupImport(userId: string, id: string, offset: number, request: Request) {
  const upload = pending(userId, id);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/octet-stream") throw new ApiError({ code: "UNSUPPORTED_MEDIA_TYPE", message: "请使用二进制分块上传。" });
  if (upload.offset !== offset) throw new ApiError({ code: "CONFLICT", message: "上传偏移不一致，请重新导入。" });
  const bytes = await readLimitedBody(request, Math.min(BACKUP_LIMITS.chunk, upload.size - offset));
  if (!bytes.length) throw new ApiError({ code: "VALIDATION_ERROR", message: "上传分块不能为空。" });
  const file = await openBackup(userId, id, "upload", true);
  try {
    if ((await file.stat()).size !== offset) throw new ApiError({ code: "CONFLICT", message: "上传文件大小不一致。" });
    let written = 0;
    while (written < bytes.length) { const result = await file.write(bytes, written, bytes.length - written, offset + written); if (!result.bytesWritten) throw new Error("Backup write failed"); written += result.bytesWritten; }
  }
  finally { await file.close(); }
  upload.offset += bytes.length;
  return { offset: upload.offset };
}
export async function completeBackupImport(userId: string, id: string) {
  const upload = pending(userId, id);
  if (upload.offset !== upload.size) throw new ApiError({ code: "CONFLICT", message: "备份尚未完整上传。" });
  const file = await openBackup(userId, id, "upload");
  try {
    const { manifest, offset: start } = await readBackupManifest(file); let offset = start;
    for (const asset of manifest.assets) { validateMediaBytes(await readBackupAsset(file, asset, offset), asset.mediaType, asset.kind === "attachment" ? 8 * 1024 * 1024 : asset.kind === "generated-image" ? 20 * 1024 * 1024 : 100 * 1024 * 1024); offset += asset.byteSize; }
  } finally { await file.close(); }
  await rename(await backupFile(userId, id, "upload"), await backupFile(userId, id)); uploads.delete(userId);
  return inspectAccountBackup(userId, id);
}
export async function cancelBackupImport(userId: string, id: string) {
  pending(userId, id); await removeBackupFile(userId, id, "upload"); uploads.delete(userId);
}
