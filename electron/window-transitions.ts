import type { BrowserWindow } from "electron";

export type WindowAction = "minimize" | "toggle-maximize" | "close";
type Effect = "minimize" | "close" | "reframe-out" | "reframe-in" | "restore";

// The renderer animates its transparent canvas; native window geometry and
// saved restore bounds remain owned by Windows rather than a resize timer.
function animationScript(effect: Effect) {
  return `(() => {
    window.__riaWindowAnimation?.cancel();
    window.__riaWindowAnimation = null;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.visibilityState !== 'visible') return;
    const effect = ${JSON.stringify(effect)};
    const exit = effect === 'minimize' || effect === 'close' || effect === 'reframe-out';
    const minimized = effect === 'minimize';
    const reframe = effect.startsWith('reframe');
    const frame = { opacity: reframe ? .86 : 0, transform: minimized ? 'translateY(16px) scale(.94)' : 'scale(.985)' };
    const rest = { opacity: 1, transform: 'none' };
    const animation = document.documentElement.animate(exit ? [rest, frame] : [frame, rest], {
      duration: reframe ? (exit ? 75 : 130) : 160,
      easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'forwards'
    });
    window.__riaWindowAnimation = animation;
    return animation.finished.catch(() => {});
  })()`;
}

export function createWindowTransitions(window: BrowserWindow, onError: (error: unknown) => void) {
  let disposed = false, busy = false, closing = false;
  let entranceVersion = 0;
  let pending: "close" | "minimize" | null = null;
  const waits = new Set<() => void>();
  const alive = () => !disposed && !window.isDestroyed();

  function clearEffect() {
    if (!alive() || window.webContents.isDestroyed()) return;
    void window.webContents.executeJavaScript("window.__riaWindowAnimation?.cancel(); window.__riaWindowAnimation = null;").catch(() => {});
  }

  async function animate(effect: Effect) {
    if (!alive() || !window.isVisible() || window.isMinimized() || window.webContents.isDestroyed()) return;
    // An unavailable or stalled renderer must never prevent a native action.
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(timer); waits.delete(finish); resolve(); };
      waits.add(finish);
      timer = setTimeout(finish, 300);
      void window.webContents.executeJavaScript(animationScript(effect)).then(finish, finish);
    });
  }

  async function perform(action: WindowAction) {
    try {
      await animate(action === "toggle-maximize" ? "reframe-out" : action);
      if (!alive()) return;
      if (action === "toggle-maximize") {
        if (window.isMaximized()) window.unmaximize(); else window.maximize();
        await animate("reframe-in");
      } else if (action === "minimize") {
        window.minimize();
      } else {
        closing = true;
        try { window.close(); } finally { closing = false; }
      }
    } finally {
      clearEffect();
      busy = false;
      const next = pending;
      pending = null;
      if (next && alive()) request(next);
    }
  }

  function request(action: WindowAction) {
    if (!alive()) return;
    if (busy) {
      // Repeated maximize clicks coalesce, while a subsequent close is kept.
      if (action === "close" || (action === "minimize" && pending !== "close")) pending = action;
      return;
    }
    busy = true;
    entranceVersion++;
    void perform(action).catch(onError);
  }

  const playEntrance = (effect: "restore" | "reframe-in") => {
    if (busy || !alive()) return;
    const version = ++entranceVersion;
    void animate(effect).finally(() => { if (!busy && version === entranceVersion) clearEffect(); });
  };
  const entrance = () => playEntrance("restore");
  const reframe = () => playEntrance("reframe-in");
  function dispose() {
    disposed = true;
    pending = null;
    for (const finish of waits) finish();
    window.removeListener("restore", entrance);
    window.removeListener("show", entrance);
    window.removeListener("maximize", reframe);
    window.removeListener("unmaximize", reframe);
  }
  window.on("restore", entrance);
  window.on("show", entrance);
  window.on("maximize", reframe);
  window.on("unmaximize", reframe);
  window.once("closed", dispose);
  return { request, isClosing: () => closing };
}
