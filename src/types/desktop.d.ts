type DesktopSettingsView = {
  locale: "zh-CN" | "en-US";
  hasOpenrouterApiKey: boolean;
  hasDeepseekApiKey: boolean;
  outboundProxyUrl: string;
  webFakeIpDoh: boolean;
  openrouterSiteName: string;
  openrouterHttpReferer: string;
  encryptionAvailable: boolean;
  closeBehaviour: "quit" | "tray";
  windowBounds: { x: number; y: number; width: number; height: number } | null;
  globalHotkey: string;
  autoCheckUpdates: boolean;
  taskNotifications: Record<DesktopTaskNoticeEvent, boolean>;
};

type DesktopTaskNoticeEvent = "task-finished" | "task-failed" | "task-needs-approval" | "task-skipped" | "task-missed";

type DesktopUpdateState = {
  supported: boolean;
  phase: "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing";
  currentVersion: string;
  availableVersion: string | null;
  checkedAt: string | null;
  received: number;
  total: number;
  failure: "network" | "verification" | "install" | "space" | null;
  /** Which volume lacked room, while the failure is "space". */
  shortfall: { volume: string; required: number; available: number } | null;
  previousInstall:
    | { outcome: "installed" | "cancelled"; version: string }
    | { outcome: "failed"; version: string; exitCode: number | null; logFile: string | null; diskFull: string | null }
    | null;
};

type DesktopLocationKind = "data" | "cache";
type DesktopMoveResult = {
  id: string;
  kind: DesktopLocationKind;
  outcome: "moved" | "failed" | "interrupted" | "cancelled";
  target: string | null;
  at: string;
  code?: string;
  message?: string;
  seen?: boolean;
};
type DesktopDataLocationView = {
  /** RiA's own data path; a link to the real folder once the data has moved. */
  defaultPath: string;
  data: { path: string; moved: boolean };
  cache: { path: string; custom: boolean; unavailable: string | null };
  copies: Array<{ path: string; at: string; exists: boolean; reason?: "moved" | "left" | "interrupted" }>;
  pending: boolean;
  result: DesktopMoveResult | null;
  lowSpace: { freeBytes: number } | null;
};
type DesktopDataLocationSizes = { dataBytes: number | null; cacheBytes: number | null; freeBytes: number | null; copies: Record<string, number | null> };
type DesktopLocationRefusal = { ok: false; code: string; details?: Record<string, unknown> };
type DesktopLocationCheck =
  | { ok: true; kind: DesktopLocationKind; target: string | null; mode: "copy" | "adopt"; copyBytes: number; requiredBytes: number; availableBytes: number | null }
  | DesktopLocationRefusal;

type DesktopRuntimeInfo = {
  appVersion: string;
  packaged: boolean;
  platform: string;
  /** Where the data really is, links resolved; and whether it was moved from its default place. */
  dataDirectory: string;
  dataMoved: boolean;
  cacheDirectory: string;
  /** The cache lives in a folder of its own rather than in the data folder. */
  cacheSeparate: boolean;
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
  webFakeIpDoh?: boolean;
  openrouterSiteName?: string;
  openrouterHttpReferer?: string;
  closeBehaviour?: "quit" | "tray";
  globalHotkey?: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
  autoCheckUpdates?: boolean;
  taskNotifications?: Partial<Record<DesktopTaskNoticeEvent, boolean>>;
};

interface Window {
  riaDesktop?: {
    startup?: {
      claim: () => Promise<string | null>;
      present: (token: string) => Promise<boolean>;
    };
    getRuntimeInfo: () => Promise<DesktopRuntimeInfo>;
    pasteIntoChat?: () => Promise<boolean>;
    openLogsFolder: () => Promise<{ opened: boolean }>;
    getSettings: () => Promise<DesktopSettingsView>;
    saveSettings: (
      input: DesktopSettingsInput,
    ) => Promise<{ settings: DesktopSettingsView; restarting: boolean }>;
    chooseFolder: () => Promise<{ canceled: boolean; path: string }>;
    revealPath: (target: string) => Promise<{ revealed: boolean }>;
    openFile: (target: string) => Promise<{ opened: boolean }>;
    onNavigate?: (listener: (path: string) => void) => () => void;
    globalHotkey: string;
    setGlobalHotkey: (
      accelerator: string,
    ) => Promise<{ ok: boolean; hotkey: string; reason?: "conflict" | "invalid" | "not-stored" }>;
    dataLocation?: {
      view: () => Promise<DesktopDataLocationView>;
      sizes: () => Promise<DesktopDataLocationSizes>;
      choose: (kind: DesktopLocationKind) => Promise<string | null>;
      check: (kind: DesktopLocationKind, target: string | null) => Promise<DesktopLocationCheck>;
      move: (kind: DesktopLocationKind, target: string | null) => Promise<{ ok: true } | DesktopLocationRefusal>;
      deleteCopy: (path: string) => Promise<{ ok: true } | DesktopLocationRefusal>;
      forgetCopy: (path: string) => Promise<{ ok: true } | DesktopLocationRefusal>;
      acknowledge: (id: string) => Promise<void>;
      dismissLowSpace: () => Promise<void>;
      open: (path: string) => Promise<{ opened: boolean }>;
    };
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
