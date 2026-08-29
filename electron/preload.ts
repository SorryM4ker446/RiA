import { contextBridge, ipcRenderer } from "electron";
import type { DesktopSettingsInput } from "./settings";

contextBridge.exposeInMainWorld("privateAiDesktop", {
  getRuntimeInfo: () => ipcRenderer.invoke("desktop:runtime:get"),
  getSettings: () => ipcRenderer.invoke("desktop:settings:get"),
  saveSettings: (input: DesktopSettingsInput) => ipcRenderer.invoke("desktop:settings:save", input),
});
