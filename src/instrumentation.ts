export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { recoverModelAttempts } = await import("@/lib/models/call-controls");
    await recoverModelAttempts();
    // No command survives a restart; expired or orphaned terminal logs can go.
    const { pruneTerminalLogs } = await import("@/lib/terminal/logs");
    await pruneTerminalLogs().catch(() => console.error("terminal.log.prune.failed"));
    // Undo checkpoints past their retention or the store's size go; so does content nothing needs.
    const { pruneCheckpoints } = await import("@/lib/checkpoints/prune");
    void pruneCheckpoints().catch(() => console.error("checkpoints.prune.failed"));
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
      // The knowledge base's vectors are loaded in the background shortly after start, so the
      // first search does not wait for them. Delayed so the window and the first page come first.
      const { warmDocumentSearch } = await import("@/lib/documents/semantic");
      const warm = setTimeout(() => { void warmDocumentSearch().catch(() => console.error("documents.index.warm.failed")); }, 5_000);
      warm.unref();
      // Scanned pages a restart left unread carry on, after the window and the first page.
      const { resumeDocumentOcr } = await import("@/lib/documents/ocr/runner");
      const ocr = setTimeout(() => { void resumeDocumentOcr().catch(() => console.error("documents.ocr.resume.failed")); }, 8_000);
      ocr.unref();
    }
  }
}
