import { db } from "@/db";
import { exclusiveDataOperation } from "@/lib/server/data-operations";
import { pruneAccountBackups } from "@/lib/backups/archive";
const shared = globalThis as typeof globalThis & { backupMaintenanceTimer?: ReturnType<typeof setInterval> };
export async function maintainBackups() {
  await exclusiveDataOperation(async () => {
    let cursor: string | undefined;
    for (;;) {
      const users = await db.user.findMany({ orderBy: { id: "asc" }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true } });
      for (const user of users) await pruneAccountBackups(user.id);
      if (users.length < 100) break;
      cursor = users.at(-1)!.id;
    }
  });
}
export function startBackupMaintenance() {
  if (shared.backupMaintenanceTimer) return;
  const check = () => { void maintainBackups().catch(() => { /* A busy or unavailable service will be checked on the next timer tick. */ }); };
  shared.backupMaintenanceTimer = setInterval(check, 60 * 60_000);
  shared.backupMaintenanceTimer.unref();
  const startup = setTimeout(check, 30_000); startup.unref();
}
