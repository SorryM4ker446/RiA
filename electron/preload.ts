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
