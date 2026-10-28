import { runBackgroundDataOperation } from "@/lib/server/data-operations";
import { pruneAccountBackups } from "@/lib/backups/archive";
const shared = globalThis as typeof globalThis & { backupMaintenanceTimer?: ReturnType<typeof setInterval> };
export async function maintainBackups() {
  // One workspace, so retention is a single pass. It only removes expired backup
  // files, so like any background work it keeps backups, restores and imports
  // from starting while it runs (and is skipped during one) without turning
  // ordinary requests away as if a backup or restore were in progress.
  await runBackgroundDataOperation(async () => {
    await pruneAccountBackups();
  });
}
export function startBackupMaintenance() {
  if (shared.backupMaintenanceTimer) return;
  const check = () => { void maintainBackups().catch(() => { /* A busy or unavailable service will be checked on the next timer tick. */ }); };
  shared.backupMaintenanceTimer = setInterval(check, 60 * 60_000);
  shared.backupMaintenanceTimer.unref();
  const startup = setTimeout(check, 30_000); startup.unref();
}
