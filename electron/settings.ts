import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";

/**
 * What closing the window does.
 *
 * `quit` is the default and stays the default. An assistant that keeps running
 * in the tray is a resident process the user did not ask for: it is harder to
 * notice, harder to stop, and it keeps a local service listening after the
 * window is gone. Becoming resident is something the user turns on, not
 * something the app does to itself.
 */
export type DesktopCloseBehaviour = "quit" | "tray";

export type DesktopWindowBounds = { x: number; y: number; width: number; height: number };

export type DesktopSettingsInput = {
  openrouterApiKey?: string;
  tavilyApiKey?: string;
  deepseekApiKey?: string;
  clearOpenrouterApiKey?: boolean;
  clearTavilyApiKey?: boolean;
  clearDeepseekApiKey?: boolean;
  outboundProxyUrl?: string;
  openrouterSiteName?: string;
  openrouterHttpReferer?: string;
  closeBehaviour?: DesktopCloseBehaviour;
  globalHotkey?: string;
  windowBounds?: DesktopWindowBounds;
};

export type DesktopSettingsView = {
  hasOpenrouterApiKey: boolean;
  hasTavilyApiKey: boolean;
  hasDeepseekApiKey: boolean;
  outboundProxyUrl: string;
  openrouterSiteName: string;
  openrouterHttpReferer: string;
  encryptionAvailable: boolean;
  closeBehaviour: DesktopCloseBehaviour;
  globalHotkey: string;
  windowBounds: DesktopWindowBounds | null;
};

type StoredDesktopSettings = {
  version: 1;
  encryptedOpenrouterApiKey?: string;
  encryptedTavilyApiKey?: string;
  // Each provider keeps its own key. They are not interchangeable and neither
  // is derivable from the other, so a provider can be configured on its own.
  encryptedDeepseekApiKey?: string;
  outboundProxyUrl?: string;
  openrouterSiteName?: string;
  openrouterHttpReferer?: string;
  closeBehaviour?: DesktopCloseBehaviour;
  windowBounds?: DesktopWindowBounds;
  globalHotkey?: string;
};

/**
 * A global shortcut, or nothing.
 *
 * The form itself is validated by the operating system at registration rather
 * than here, so this only bounds the length and rejects the obvious nothing. A
 * combination the system refuses is reported as a conflict, not stored as if it
 * had worked.
 */
function normalizeHotkey(value: string | undefined): string {
  return normalizeText(value, 64).replace(/\s+/g, "");
}

function normalizeText(value: string | undefined, maxLength: number): string {
  return (value || "").trim().slice(0, maxLength);
}

function normalizeHttpUrl(value: string | undefined, label: string): string {
  const normalized = normalizeText(value, 2048);
  if (!normalized) return "";
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }
  return parsed.toString();
}

export class DesktopSettingsStore {
  constructor(private readonly settingsFile: string) {}

  /*
   * Two writers, one file.
   *
   * Every write is a read-modify-write of the same record: the settings screen
   * rewrites the credentials and the proxy, and the debounced window geometry
   * rewrites the bounds. Running those concurrently let whichever finished second
   * write back a snapshot taken before the other one landed, so a resize followed
   * by a key save reverted the geometry. Serialising them costs one write in
   * flight at a time, which is what a single settings file can hold anyway.
   */
  private writes: Promise<unknown> = Promise.resolve();

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(work, work);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private readStored(): StoredDesktopSettings {
    if (!existsSync(this.settingsFile)) return { version: 1 };
    try {
      const parsed = JSON.parse(readFileSync(this.settingsFile, "utf8")) as StoredDesktopSettings;
      return parsed.version === 1 ? parsed : { version: 1 };
    } catch {
      throw new Error(`Desktop settings are unreadable: ${this.settingsFile}`);
    }
  }

  private writeStored(settings: StoredDesktopSettings) {
    const temporaryFile = join(dirname(this.settingsFile), `.settings-${process.pid}.tmp`);
    writeFileSync(temporaryFile, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryFile, this.settingsFile);
  }

  private async encrypt(value: string): Promise<string> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Operating-system credential encryption is not available.");
    }
    return (await safeStorage.encryptStringAsync(value)).toString("base64");
  }

  private async decrypt(value: string | undefined): Promise<string> {
    if (!value) return "";
    if (!safeStorage.isEncryptionAvailable()) return "";
    const result = await safeStorage.decryptStringAsync(Buffer.from(value, "base64"));
    return result.result;
  }

  /**
   * Read just the close behaviour.
   *
   * Separate from `getView` because the window close handler needs it on every
   * close, and a view that reported key status would be more than that path
   * wants to touch.
   */
  async getCloseBehaviour(): Promise<DesktopCloseBehaviour> {
    return this.readStored().closeBehaviour === "tray" ? "tray" : "quit";
  }

  async getGlobalHotkey(): Promise<string> {
    return normalizeHotkey(this.readStored().globalHotkey);
  }

  /**
   * Remember where the window was.
   *
   * Written on its own rather than through `save`, because it happens on every
   * move and resize and must not disturb the credentials, the proxy or the close
   * behaviour that are stored beside it.
   */
  async saveWindowBounds(bounds: DesktopWindowBounds): Promise<void> {
    return this.enqueue(async () => {
      const current = this.readStored();
      this.writeStored({
        ...current,
        windowBounds: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.max(900, Math.round(bounds.width)),
          height: Math.max(640, Math.round(bounds.height))
        }
      });
    });
  }

  async getView(): Promise<DesktopSettingsView> {
    const stored = this.readStored();
    return {
      hasOpenrouterApiKey: Boolean(stored.encryptedOpenrouterApiKey),
      hasTavilyApiKey: Boolean(stored.encryptedTavilyApiKey),
      hasDeepseekApiKey: Boolean(stored.encryptedDeepseekApiKey),
      outboundProxyUrl: stored.outboundProxyUrl || "",
      openrouterSiteName: stored.openrouterSiteName || "",
      openrouterHttpReferer: stored.openrouterHttpReferer || "",
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      closeBehaviour: stored.closeBehaviour === "tray" ? "tray" : "quit",
      globalHotkey: normalizeHotkey(stored.globalHotkey),
      windowBounds: stored.windowBounds ?? null,
    };
  }

  async save(input: DesktopSettingsInput): Promise<DesktopSettingsView> {
    return this.enqueue(() => this.applySave(input));
  }

  private async applySave(input: DesktopSettingsInput): Promise<DesktopSettingsView> {
    const current = this.readStored();
    /*
     * Only what was supplied is written.
     *
     * Normalising every field on every save meant that a partial save — the hotkey
     * picker sending `{ globalHotkey }`, the close-behaviour card sending
     * `{ closeBehaviour }` — ran the absent ones through `normalizeText` and wrote
     * empty strings, silently clearing the user's proxy, site name and referrer.
     * Each of those screens is a control on the same record, not an editor of it.
     */
    const next: StoredDesktopSettings = {
      ...current,
      version: 1,
      ...(input.outboundProxyUrl === undefined ? {} : { outboundProxyUrl: normalizeHttpUrl(input.outboundProxyUrl, "Proxy URL") }),
      ...(input.openrouterSiteName === undefined ? {} : { openrouterSiteName: normalizeText(input.openrouterSiteName, 200) }),
      ...(input.openrouterHttpReferer === undefined ? {} : { openrouterHttpReferer: normalizeHttpUrl(input.openrouterHttpReferer, "HTTP referrer") }),
      ...(input.closeBehaviour === "tray" || input.closeBehaviour === "quit" ? { closeBehaviour: input.closeBehaviour } : {}),
      globalHotkey: input.globalHotkey === undefined ? current.globalHotkey : normalizeHotkey(input.globalHotkey),
      ...(input.windowBounds ? { windowBounds: input.windowBounds } : {})
    };

    if (input.clearOpenrouterApiKey) delete next.encryptedOpenrouterApiKey;
    if (input.clearTavilyApiKey) delete next.encryptedTavilyApiKey;
    if (input.clearDeepseekApiKey) delete next.encryptedDeepseekApiKey;

    const openrouterApiKey = normalizeText(input.openrouterApiKey, 4096);
    const tavilyApiKey = normalizeText(input.tavilyApiKey, 4096);
    const deepseekApiKey = normalizeText(input.deepseekApiKey, 4096);
    if (openrouterApiKey) next.encryptedOpenrouterApiKey = await this.encrypt(openrouterApiKey);
    if (tavilyApiKey) next.encryptedTavilyApiKey = await this.encrypt(tavilyApiKey);
    if (deepseekApiKey) next.encryptedDeepseekApiKey = await this.encrypt(deepseekApiKey);

    this.writeStored(next);
    return this.getView();
  }

  async getServerEnvironment(): Promise<Record<string, string>> {
    const stored = this.readStored();
    const openrouterApiKey = await this.decrypt(stored.encryptedOpenrouterApiKey);
    const tavilyApiKey = await this.decrypt(stored.encryptedTavilyApiKey);
    const deepseekApiKey = await this.decrypt(stored.encryptedDeepseekApiKey);
    return {
      OPENROUTER_API_KEY: openrouterApiKey,
      TAVILY_API_KEY: tavilyApiKey,
      DEEPSEEK_API_KEY: deepseekApiKey,
      OUTBOUND_PROXY_URL: stored.outboundProxyUrl || "",
      OPENROUTER_SITE_NAME: stored.openrouterSiteName || "RiA Desktop",
      OPENROUTER_HTTP_REFERER: stored.openrouterHttpReferer || "",
    };
  }
}
