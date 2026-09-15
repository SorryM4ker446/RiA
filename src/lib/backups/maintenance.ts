import { exclusiveDataOperation } from "@/lib/server/data-operations";
import { pruneAccountBackups } from "@/lib/backups/archive";
const shared = globalThis as typeof globalThis & { backupMaintenanceTimer?: ReturnType<typeof setInterval> };
export async function maintainBackups() {
  // One workspace, so retention is a single pass.
  await exclusiveDataOperation(async () => {
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
