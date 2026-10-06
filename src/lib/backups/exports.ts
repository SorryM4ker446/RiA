import { randomUUID } from "node:crypto";
import { copyFile, rename, rm, stat } from "node:fs/promises";
import { db } from "@/db";
import { BACKUP_LIMITS } from "@/lib/backups/schema";
import { backupFile } from "@/lib/backups/files";
import { backupId as backupIdSchema } from "@/lib/backups/schema";

/*
 * A copy the application wrote, rather than one the browser downloaded.
 *
 * Plan 5.8 asks the page to tell the newest *created* archive apart from the
 * newest one the user took elsewhere, and that is only possible if the
 * application is the thing that writes it. A browser download leaves nothing
 * here to record, so the desktop shell saves through this instead.
 *
 * The destination is recorded and shown, never resolved again. The application
 * has no reason to read, move or delete a copy the user now owns, and a record
 * it could act on would be a record it could get wrong.
 */

export type BackupExportView = {
  id: string;
  backupId: string;
  path: string;
  byteSize: number;
  exportedAt: string;
};

function toView(row: {
  id: string;
  backupId: string;
  path: string;
  byteSize: number;
  exportedAt: Date;
}): BackupExportView {
  return { ...row, exportedAt: row.exportedAt.toISOString() };
}

export async function listBackupExports(): Promise<BackupExportView[]> {
  const rows = await db.backupExport.findMany({ orderBy: [{ exportedAt: "desc" }], take: 50, select: { id: true, backupId: true, path: true, byteSize: true, exportedAt: true } });
  return rows.map(toView);
}

/**
 * Write a copy to a destination the user chose.
 *
 * The source is the same guarded open every read uses, and the copy is bounded
 * by the same archive limit: an export that could run away is not an export the
 * user meant to make.
 */
export async function exportBackupCopy(id: string, destination: string): Promise<BackupExportView> {
  const parsed = backupIdSchema.safeParse(id);
  if (!parsed.success) throw new Error("Invalid backup id.");
  const target = destination.trim();
  if (!target) throw new Error("A destination is required.");
  // An export path is chosen by the user in a save dialog, so it is absolute
  // and the application does not compose it from anything but that choice.
  if (target.length > 4096) throw new Error("The destination path is too long.");

  const source = await backupFile(parsed.data);
  const sourceStats = await stat(source);
  if (!sourceStats.isFile()) throw new Error("The backup file is not there.");
  if (sourceStats.size > BACKUP_LIMITS.bytes) throw new Error("The backup is too large to export.");

  // The copy is assembled beside the destination under a temporary name and only
  // takes the destination's own name once it is whole. A copy that fails part
  // way - a full disk, a destination another program has open, both ordinary on
  // Windows - would otherwise leave something named like a real archive at the
  // one place the user was told to trust, with no record that it is not one.
  const partial = `${target}.${randomUUID()}.part`;
  try {
    await copyFile(source, partial);
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
  const written = await stat(target);

  const row = await db.backupExport.create({
    data: { backupId: parsed.data, path: target, byteSize: written.size },
    select: { id: true, backupId: true, path: true, byteSize: true, exportedAt: true }
  });
  return toView(row);
}
