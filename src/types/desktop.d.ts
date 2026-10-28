type DesktopSettingsView = {
  locale: "zh-CN" | "en-US";
  hasOpenrouterApiKey: boolean;
  hasDeepseekApiKey: boolean;
  outboundProxyUrl: string;
  openrouterSiteName: string;
  openrouterHttpReferer: string;
  encryptionAvailable: boolean;
  closeBehaviour: "quit" | "tray";
  windowBounds: { x: number; y: number; width: number; height: number } | null;
  globalHotkey: string;
  autoCheckUpdates: boolean;
};

type DesktopUpdateState = {
  supported: boolean;
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing";
  currentVersion: string;
  availableVersion: string | null;
  checkedAt: string | null;
  received: number;
  total: number;
  failure: "network" | "verification" | "install" | null;
  previousInstall:
    | { outcome: "installed" | "cancelled"; version: string }
    | { outcome: "failed"; version: string; exitCode: number | null; logFile: string | null }
    | null;
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
  locale?: "zh-CN" | "en-US";
  openrouterApiKey?: string;
  deepseekApiKey?: string;
  clearOpenrouterApiKey?: boolean;
  clearDeepseekApiKey?: boolean;
  outboundProxyUrl?: string;
  openrouterSiteName?: string;
  openrouterHttpReferer?: string;
  closeBehaviour?: "quit" | "tray";
  globalHotkey?: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
  autoCheckUpdates?: boolean;
};

interface Window {
  riaDesktop?: {
    startup?: {
      claim: () => Promise<string | null>;
      present: (token: string) => Promise<boolean>;
    };
    getRuntimeInfo: () => Promise<DesktopRuntimeInfo>;
    getSettings: () => Promise<DesktopSettingsView>;
    saveSettings: (
      input: DesktopSettingsInput,
    ) => Promise<{ settings: DesktopSettingsView; restarting: boolean }>;
    chooseFolder: () => Promise<{ canceled: boolean; path: string }>;
    revealPath: (target: string) => Promise<{ revealed: boolean }>;
    openFile: (target: string) => Promise<{ opened: boolean }>;
    quitToTray: () => Promise<{ quitting: boolean }>;
    showFromTray: () => Promise<{ shown: boolean }>;
    globalHotkey: string;
    setGlobalHotkey: (
      accelerator: string,
    ) => Promise<{ ok: boolean; hotkey: string; reason?: "conflict" | "invalid" | "not-stored" }>;
    updates?: {
      state: () => Promise<DesktopUpdateState>;
      check: () => Promise<DesktopUpdateState>;
      apply: () => Promise<DesktopUpdateState>;
      cancel: () => Promise<DesktopUpdateState>;
      onChange: (listener: (state: DesktopUpdateState) => void) => () => void;
      onOpen: (listener: () => void) => () => void;
    };
    windowControls?: {
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      state: () => Promise<{ maximized: boolean }>;
      onMaximizedChange: (listener: (maximized: boolean) => void) => () => void;
    };
  };
}
