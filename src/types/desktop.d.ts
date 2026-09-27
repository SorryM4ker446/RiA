type DesktopSettingsView = {
  hasOpenrouterApiKey: boolean;
  hasTavilyApiKey: boolean;
  outboundProxyUrl: string;
  openrouterSiteName: string;
  openrouterHttpReferer: string;
  encryptionAvailable: boolean;
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
  clearOpenrouterApiKey?: boolean;
  clearTavilyApiKey?: boolean;
  outboundProxyUrl?: string;
  openrouterSiteName?: string;
  openrouterHttpReferer?: string;
};

interface Window {
  privateAiDesktop?: {
    getRuntimeInfo: () => Promise<DesktopRuntimeInfo>;
    getSettings: () => Promise<DesktopSettingsView>;
    saveSettings: (
      input: DesktopSettingsInput,
    ) => Promise<{ settings: DesktopSettingsView; restarting: boolean }>;
    windowControls?: {
      minimize: () => void;
      toggleMaximize: () => void;
      close: () => void;
      state: () => Promise<{ maximized: boolean }>;
      onMaximizedChange: (listener: (maximized: boolean) => void) => () => void;
    };
  };
}
