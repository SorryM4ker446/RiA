type Stoppable = { stop(): Promise<void> };

type ShutdownState = {
  isQuitting: boolean;
  tray: { destroy(): void } | null;
  reminderPoller: Stoppable | null;
  conversationAlerts: Stoppable | null;
  restartAbort: AbortController | null;
  restartInProgress: Promise<void> | null;
  nextServer: Stoppable | null;
};

/** Starts one quit. Remove the desktop presence before any asynchronous service cleanup. */
export function beginDesktopShutdown(state: ShutdownState, hideWindows: () => void, unregisterShortcuts: () => void) {
  if (state.isQuitting) return;
  state.isQuitting = true;
  hideWindows();
  state.tray?.destroy();
  state.tray = null;
  unregisterShortcuts();
  state.restartAbort?.abort(new Error("The application is quitting."));

  return (async () => {
    const stopped = await Promise.allSettled([
      state.reminderPoller?.stop(),
      state.conversationAlerts?.stop(),
      state.restartInProgress,
    ]);
    // A restart owns any child it has not adopted yet. Wait for it to settle
    // before looking up the service the application still owns.
    await state.nextServer?.stop();
    const failure = stopped.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  })();
}
