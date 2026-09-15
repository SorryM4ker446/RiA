import { lstat, mkdir, open, realpath, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getMediaDirectory, mediaOwnerDirectory } from "@/lib/media/storage";
import { LOCAL_WORKSPACE_ID } from "@/lib/local/workspace";
import { ApiError } from "@/lib/server/api-error";
import { backupId, BACKUP_LIMITS } from "@/lib/backups/schema";

// Backups live beside the media directory in a folder named after the
// workspace, so an installation that already has backups keeps finding them.
const workspaceDirectoryName = () => mediaOwnerDirectory(LOCAL_WORKSPACE_ID);

export async function backupDirectory() {
  const root = join(dirname(getMediaDirectory()), "backups");
  await mkdir(root, { recursive: true });
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new ApiError({ code: "CONFLICT", message: "备份目录不安全。" });
  const directory = join(await realpath(/* turbopackIgnore: true */ root), workspaceDirectoryName());
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ directory) !== directory) throw new ApiError({ code: "CONFLICT", message: "备份目录不安全。" });
  return directory;
}
export async function backupFile(id: string, extension = "paib") {
  backupId.parse(id);
  return join(/* turbopackIgnore: true */ await backupDirectory(), `${id}.${extension}`);
}
export async function openBackup(id: string, extension = "paib", writable = false) {
  const file = await backupFile(id, extension);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ file) !== file || stat.size > BACKUP_LIMITS.bytes) throw new Error("Unsafe file");
    const handle = await open(/* turbopackIgnore: true */ file, writable ? "r+" : "r");
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.size !== stat.size) { await handle.close(); throw new Error("Changed file"); }
    return handle;
  } catch { throw new ApiError({ code: "NOT_FOUND", message: "备份文件不存在或不可用。" }); }
}
export async function listBackupFiles() {
  const directory = await backupDirectory();
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.(paib|upload|partial)$/.test(entry.name)) continue;
    const stat = await lstat(join(directory, entry.name));
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    records.push({ id: entry.name.split(".")[0], extension: entry.name.split(".")[1], bytes: stat.size, createdAt: stat.mtime.toISOString() });
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
export async function removeBackupFile(id: string, extension = "paib") {
  const handle = await openBackup(id, extension);
  await handle.close();
  await unlink(await backupFile(id, extension));
}
