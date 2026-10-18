import { randomUUID } from "node:crypto";
import type { BrowserWindow, WebContentsDidStartNavigationEventParams } from "electron";

/** Owns first-window readiness; decorative renderer work must never hide the app indefinitely. */
export function createStartupPresentation(window: BrowserWindow, options: { enabled: boolean; show: boolean; onError: (error: unknown) => void }) {
  // BrowserWindow.webContents is a native getter and cannot be read in `closed`.
  const contents = window.webContents;
  const token = randomUUID();
  let claimed = false, rendered = false, nativeReady = false, revealed = false, expired = false, disposed = false;
  let navigations = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiters = new Set<(play: boolean) => void>();

  function reveal(play: boolean) {
    if (disposed || revealed || !nativeReady || window.isDestroyed()) return;
    revealed = true;
    expired ||= !play;
    if (timer) clearTimeout(timer);
    contents.removeListener("did-start-navigation", navigation);
    try { if (options.show) window.show(); }
    catch (error) { options.onError(error); }
    for (const resolve of waiters) resolve(play);
    waiters.clear();
  }
  function ready() {
    nativeReady = true;
    if (!options.enabled || rendered || expired) { reveal(options.enabled && rendered && !expired); return; }
    // A broken or old renderer still gets a visible, closable native window.
    timer = setTimeout(() => { expired = true; reveal(false); }, 2000);
  }
  function navigation(details: Electron.Event<WebContentsDidStartNavigationEventParams>) {
    if (!details.isMainFrame || details.isSameDocument) return;
    if (++navigations > 1) { expired = true; reveal(false); }
  }
  function dispose() {
    disposed = true;
    if (timer) clearTimeout(timer);
    window.removeListener("ready-to-show", ready);
    contents.removeListener("did-start-navigation", navigation);
    for (const resolve of waiters) resolve(false);
    waiters.clear();
  }
  window.once("ready-to-show", ready);
  window.once("closed", dispose);
  contents.on("did-start-navigation", navigation);
  return {
    claim: () => {
      if (!options.enabled || disposed || revealed || expired || claimed) return null;
      claimed = true;
      return token;
    },
    present: (value: unknown): Promise<boolean> => {
      if (!claimed || value !== token || disposed || expired) return Promise.resolve(false);
      if (revealed) return Promise.resolve(true);
      return new Promise(resolve => {
        waiters.add(resolve);
        rendered = true;
        reveal(true);
      });
    },
  };
}
