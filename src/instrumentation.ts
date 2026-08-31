export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startBackupMaintenance } = await import("@/lib/backups/maintenance");
    startBackupMaintenance();
  }
}
