import { contextBridge, ipcRenderer } from "electron";
import type { DesktopSettingsInput } from "./settings";

// The window controls are only drawn where the native caption is hidden. On
// every other platform `titleBarStyle` is left alone, so the OS keeps drawing
// minimise/maximise/close and a page-drawn set would sit on top of them.
const drawsOwnCaption = process.platform === "win32";

contextBridge.exposeInMainWorld("privateAiDesktop", {
  getRuntimeInfo: () => ipcRenderer.invoke("desktop:runtime:get"),
  getSettings: () => ipcRenderer.invoke("desktop:settings:get"),
  saveSettings: (input: DesktopSettingsInput) => ipcRenderer.invoke("desktop:settings:save", input),
  // A folder the user chose with the operating system dialog. There is no other
  // way to obtain one: the assistant has no channel that could add a grant.
  chooseFolder: () => ipcRenderer.invoke("desktop:folder:choose") as Promise<{ canceled: boolean; path: string }>,
  // Point a file manager at something the service has already resolved inside a
  // granted folder. The path is never composed here; the shell only selects it.
  revealPath: (target: string) => ipcRenderer.invoke("desktop:folder:reveal", target) as Promise<{ revealed: boolean }>,
  // Leaving the app or coming back to it, both from the settings screen.
  quitToTray: () => ipcRenderer.invoke("desktop:tray:quit") as Promise<{ quitting: boolean }>,
  showFromTray: () => ipcRenderer.invoke("desktop:tray:show") as Promise<{ shown: boolean }>,
  // The shortcut only brings the window forward, and that happens in the main
  // process. There is no renderer notification for it: a channel nothing in the
  // app listens to invites a handler nobody wrote, and the shortcut already works.
  setGlobalHotkey: (accelerator: string) => ipcRenderer.invoke("desktop:hotkey:set", accelerator) as Promise<{ ok: boolean; hotkey: string; reason?: "conflict" | "invalid" | "not-stored" }>,
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
