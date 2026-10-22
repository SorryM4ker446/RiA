import { lstat, mkdir, open, realpath, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getMediaDirectory, mediaOwnerDirectory } from "@/lib/media/storage";
import { LOCAL_WORKSPACE_ID } from "@/lib/local/workspace";
import { t } from "@/lib/locale";
import { ApiError } from "@/lib/server/api-error";
import { backupId, BACKUP_LIMITS } from "@/lib/backups/schema";

// Backups live beside the media directory in a folder named after the
// workspace, so an installation that already has backups keeps finding them.
const workspaceDirectoryName = () => mediaOwnerDirectory(LOCAL_WORKSPACE_ID);

export async function backupDirectory() {
  const root = join(dirname(getMediaDirectory()), "backups");
  await mkdir(root, { recursive: true });
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new ApiError({ code: "CONFLICT", message: t("lib.backups.unsafeDirectory") });
  const directory = join(await realpath(/* turbopackIgnore: true */ root), workspaceDirectoryName());
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ directory) !== directory) throw new ApiError({ code: "CONFLICT", message: t("lib.backups.unsafeDirectory") });
  return directory;
}
/** Extension of complete archives written by this build. */
export const ARCHIVE_EXTENSION = "riab";
/** Extension of complete archives written before the RiA rename; still listed, pruned and restored. */
export const LEGACY_ARCHIVE_EXTENSION = "paib";
export const isArchiveExtension = (extension: string) => extension === ARCHIVE_EXTENSION || extension === LEGACY_ARCHIVE_EXTENSION;

export async function backupFile(id: string, extension = ARCHIVE_EXTENSION) {
  backupId.parse(id);
  return join(/* turbopackIgnore: true */ await backupDirectory(), `${id}.${extension}`);
}
/**
 * The extension of the complete archive saved under `id`: the current one, or
 * the legacy one for an archive written before the rename. Defaults to the
 * current extension when neither exists, so the caller reports it as missing.
 */
export async function archiveExtension(id: string) {
  for (const extension of [ARCHIVE_EXTENSION, LEGACY_ARCHIVE_EXTENSION]) {
    try { if ((await lstat(await backupFile(id, extension))).isFile()) return extension; } catch { /* try the next */ }
  }
  return ARCHIVE_EXTENSION;
}
/** Opens a staging file by its extension, or the complete archive of either name when none is given. */
export async function openBackup(id: string, extension?: string, writable = false) {
  const file = await backupFile(id, extension ?? await archiveExtension(id));
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ file) !== file || stat.size > BACKUP_LIMITS.bytes) throw new Error("Unsafe file");
    const handle = await open(/* turbopackIgnore: true */ file, writable ? "r+" : "r");
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.size !== stat.size) { await handle.close(); throw new Error("Changed file"); }
    return handle;
  } catch { throw new ApiError({ code: "NOT_FOUND", message: t("lib.backups.fileUnavailable") }); }
}
export async function listBackupFiles() {
  const directory = await backupDirectory();
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.(riab|paib|upload|partial)$/.test(entry.name)) continue;
    const stat = await lstat(join(directory, entry.name));
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    records.push({ id: entry.name.split(".")[0], extension: entry.name.split(".")[1], bytes: stat.size, createdAt: stat.mtime.toISOString() });
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
export async function removeBackupFile(id: string, extension?: string) {
  const resolved = extension ?? await archiveExtension(id);
  const handle = await openBackup(id, resolved);
  await handle.close();
  await unlink(await backupFile(id, resolved));
}
