import { lstat, mkdir, open, realpath, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getMediaDirectory, mediaOwnerDirectory } from "@/lib/media/storage";
import { ApiError } from "@/lib/server/api-error";
import { backupId, BACKUP_LIMITS } from "@/lib/backups/schema";

export async function backupDirectory(userId: string) {
  const root = join(dirname(getMediaDirectory()), "backups");
  await mkdir(root, { recursive: true });
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new ApiError({ code: "CONFLICT", message: "备份目录不安全。" });
  const directory = join(await realpath(/* turbopackIgnore: true */ root), mediaOwnerDirectory(userId));
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ directory) !== directory) throw new ApiError({ code: "CONFLICT", message: "备份目录不安全。" });
  return directory;
}
export async function backupFile(userId: string, id: string, extension = "paib") {
  backupId.parse(id);
  return join(/* turbopackIgnore: true */ await backupDirectory(userId), `${id}.${extension}`);
}
export async function openBackup(userId: string, id: string, extension = "paib", writable = false) {
  const file = await backupFile(userId, id, extension);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ file) !== file || stat.size > BACKUP_LIMITS.bytes) throw new Error("Unsafe file");
    const handle = await open(/* turbopackIgnore: true */ file, writable ? "r+" : "r");
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.size !== stat.size) { await handle.close(); throw new Error("Changed file"); }
    return handle;
  } catch { throw new ApiError({ code: "NOT_FOUND", message: "备份文件不存在或不可用。" }); }
}
export async function listBackupFiles(userId: string) {
  const directory = await backupDirectory(userId);
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.(paib|upload|partial)$/.test(entry.name)) continue;
    const stat = await lstat(join(directory, entry.name));
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    records.push({ id: entry.name.split(".")[0], extension: entry.name.split(".")[1], bytes: stat.size, createdAt: stat.mtime.toISOString() });
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
export async function removeBackupFile(userId: string, id: string, extension = "paib") {
  const handle = await openBackup(userId, id, extension);
  await handle.close();
  await unlink(await backupFile(userId, id, extension));
}
