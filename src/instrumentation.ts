export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { recoverModelAttempts } = await import("@/lib/models/call-controls");
    await recoverModelAttempts();
    const { startBackupMaintenance } = await import("@/lib/backups/maintenance");
    startBackupMaintenance();
    // Started here rather than from a route: a schedule the user switched on has
    // to fire whether or not anything is open. The poller is inert while every
    // job is off or nothing is due.
    //
    // Only the desktop shell runs one. `next dev` and the test suites run this
    // same file, and a poller there takes real backups and makes billed model
    // calls against a workspace nobody asked it to touch — with no way to stop
    // it short of pausing every schedule in the settings card.
    if (process.env.APP_RUNTIME === "desktop") {
      const { startScheduler } = await import("@/lib/scheduler/runner");
      startScheduler().start();
    }
  }
}
