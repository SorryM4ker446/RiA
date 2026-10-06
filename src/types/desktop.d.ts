type DesktopSettingsView = {
  hasOpenrouterApiKey: boolean;
  hasTavilyApiKey: boolean;
  hasDeepseekApiKey: boolean;
  outboundProxyUrl: string;
  openrouterSiteName: string;
  openrouterHttpReferer: string;
  encryptionAvailable: boolean;
  closeBehaviour: "quit" | "tray";
  windowBounds: { x: number; y: number; width: number; height: number } | null;
  globalHotkey: string;
};

type DesktopRuntimeInfo = {
  appVersion: string;
  packaged: boolean;
  platform: string;
  dataDirectory: string;
  mediaDirectory: string;
  logFile: string;
  notificationsSupported: boolean;
};

type DesktopSettingsInput = {
  openrouterApiKey?: string;
  tavilyApiKey?: string;
  deepseekApiKey?: string;
  clearOpenrouterApiKey?: boolean;
  clearTavilyApiKey?: boolean;
  clearDeepseekApiKey?: boolean;
  outboundProxyUrl?: string;
  openrouterSiteName?: string;
  openrouterHttpReferer?: string;
  closeBehaviour?: "quit" | "tray";
  globalHotkey?: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
};

interface Window {
  privateAiDesktop?: {
    getRuntimeInfo: () => Promise<DesktopRuntimeInfo>;
    getSettings: () => Promise<DesktopSettingsView>;
    saveSettings: (
      input: DesktopSettingsInput,
    ) => Promise<{ settings: DesktopSettingsView; restarting: boolean }>;
    chooseFolder: () => Promise<{ canceled: boolean; path: string }>;
    revealPath: (target: string) => Promise<{ revealed: boolean }>;
    quitToTray: () => Promise<{ quitting: boolean }>;
    showFromTray: () => Promise<{ shown: boolean }>;
    globalHotkey: string;
    setGlobalHotkey: (
      accelerator: string,
    ) => Promise<{ ok: boolean; hotkey: string; reason?: "conflict" | "invalid" | "not-stored" }>;
    windowControls?: {
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      state: () => Promise<{ maximized: boolean }>;
      onMaximizedChange: (listener: (maximized: boolean) => void) => () => void;
    };
  };
}
