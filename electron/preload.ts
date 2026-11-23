import { contextBridge, ipcRenderer } from "electron";
import type { DesktopSettingsInput } from "./settings";

// The window controls are only drawn where the native caption is hidden. On
// every other platform `titleBarStyle` is left alone, so the OS keeps drawing
// minimise/maximise/close and a page-drawn set would sit on top of them.
const drawsOwnCaption = process.platform === "win32";
// One claim per document, shared by React's development effect replay. A reload
// gets a new preload, while the main process keeps the window's consumed claim.
let startupClaim: Promise<string | null> | undefined;

contextBridge.exposeInMainWorld("riaDesktop", {
  startup: {
    claim: () => startupClaim ??= ipcRenderer.invoke("desktop:startup:claim"),
    present: (token: string) => ipcRenderer.invoke("desktop:startup:present", token) as Promise<boolean>,
  },
  getRuntimeInfo: () => ipcRenderer.invoke("desktop:runtime:get"),
  pasteIntoChat: () => {
    const input = document.activeElement;
    if (!navigator.userActivation.isActive || !(input instanceof HTMLTextAreaElement)
      || !input.hasAttribute("data-chat-draft") || input.readOnly || input.disabled) return Promise.resolve(false);
    return ipcRenderer.invoke("desktop:chat:paste") as Promise<boolean>;
  },
  openLogsFolder: () => ipcRenderer.invoke("desktop:logs:open") as Promise<{ opened: boolean }>,
  getSettings: () => ipcRenderer.invoke("desktop:settings:get"),
  saveSettings: (input: DesktopSettingsInput) => ipcRenderer.invoke("desktop:settings:save", input),
  // A folder the user chose with the operating system dialog. There is no other
  // way to obtain one: the assistant has no channel that could add a grant.
  chooseFolder: () => ipcRenderer.invoke("desktop:folder:choose") as Promise<{ canceled: boolean; path: string }>,
  // Point a file manager at something the service has already resolved inside a
  // granted folder. The path is never composed here; the shell only selects it.
  revealPath: (target: string) => ipcRenderer.invoke("desktop:folder:reveal", target) as Promise<{ revealed: boolean }>,
  openFile: (target: string) => ipcRenderer.invoke("desktop:file:open", target) as Promise<{ opened: boolean }>,
  // Leaving the app or coming back to it, both from the settings screen.
  // The shortcut only brings the window forward, and that happens in the main
  // process. There is no renderer notification for it: a channel nothing in the
  // app listens to invites a handler nobody wrote, and the shortcut already works.
  setGlobalHotkey: (accelerator: string) => ipcRenderer.invoke("desktop:hotkey:set", accelerator) as Promise<{ ok: boolean; hotkey: string; reason?: "conflict" | "invalid" | "not-stored" }>,
  // A click on a notification that names a page inside the app.
  onNavigate: (listener: (path: string) => void) => {
    const handler = (_event: unknown, path: unknown) => { if (typeof path === "string") listener(path); };
    ipcRenderer.on("desktop:navigate", handler);
    return () => ipcRenderer.removeListener("desktop:navigate", handler);
  },
  // The main process owns the update; the page reads its state and asks for it.
  // Applying downloads, verifies and installs, which ends by quitting the app, so
  // its promise only reports the state at the start.
  updates: {
    state: () => ipcRenderer.invoke("desktop:update:state"),
    check: () => ipcRenderer.invoke("desktop:update:check"),
    apply: () => ipcRenderer.invoke("desktop:update:apply"),
    cancel: () => ipcRenderer.invoke("desktop:update:cancel"),
    onChange: (listener: (state: unknown) => void) => {
      const handler = (_event: unknown, state: unknown) => listener(state);
      ipcRenderer.on("desktop:update:changed", handler);
      return () => ipcRenderer.removeListener("desktop:update:changed", handler);
    },
    // A click on the system notification about a new version.
    onOpen: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("desktop:update:open", handler);
      return () => ipcRenderer.removeListener("desktop:update:open", handler);
    },
  },
  // Where the data and the cache live. A move is recorded here and runs at the
  // next start, so `move` is followed by the application restarting.
  dataLocation: {
    view: () => ipcRenderer.invoke("desktop:data-location:view"),
    sizes: () => ipcRenderer.invoke("desktop:data-location:sizes"),
    choose: (kind: "data" | "cache") => ipcRenderer.invoke("desktop:data-location:choose", kind),
    check: (kind: "data" | "cache", target: string | null) => ipcRenderer.invoke("desktop:data-location:check", { kind, target }),
    move: (kind: "data" | "cache", target: string | null) => ipcRenderer.invoke("desktop:data-location:move", { kind, target }),
    deleteCopy: (path: string) => ipcRenderer.invoke("desktop:data-location:delete-copy", path),
    forgetCopy: (path: string) => ipcRenderer.invoke("desktop:data-location:forget-copy", path),
    acknowledge: (id: string) => ipcRenderer.invoke("desktop:data-location:acknowledge", id),
    dismissLowSpace: () => ipcRenderer.invoke("desktop:data-location:dismiss-low-space"),
    open: (path: string) => ipcRenderer.invoke("desktop:data-location:open", path),
  },
  // The page draws the caption, so it needs the verbs and the current state.
  // Absent entirely where the platform keeps its own caption.
  ...(drawsOwnCaption
    ? {
        windowControls: {
          minimize: () => ipcRenderer.send("desktop:window:minimize"),
          toggleMaximize: () => ipcRenderer.send("desktop:window:toggle-maximize"),
          close: () => ipcRenderer.send("desktop:window:close"),
          state: () => ipcRenderer.invoke("desktop:window:state") as Promise<{ maximized: boolean }>,
          onMaximizedChange: (listener: (maximized: boolean) => void) => {
            const handler = (_event: unknown, maximized: boolean) => listener(maximized);
            ipcRenderer.on("desktop:window:maximized", handler);
            return () => ipcRenderer.removeListener("desktop:window:maximized", handler);
          },
        },
      }
    : {}),
});
