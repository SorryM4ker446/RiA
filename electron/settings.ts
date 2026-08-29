import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeStorage } from "electron";

export type DesktopSettingsInput = {
  openrouterApiKey?: string;
  tavilyApiKey?: string;
  clearOpenrouterApiKey?: boolean;
  clearTavilyApiKey?: boolean;
  outboundProxyUrl?: string;
  openrouterSiteName?: string;
  openrouterHttpReferer?: string;
};

export type DesktopSettingsView = {
  hasOpenrouterApiKey: boolean;
  hasTavilyApiKey: boolean;
  outboundProxyUrl: string;
  openrouterSiteName: string;
  openrouterHttpReferer: string;
  encryptionAvailable: boolean;
};

type StoredDesktopSettings = {
  version: 1;
  encryptedOpenrouterApiKey?: string;
  encryptedTavilyApiKey?: string;
  outboundProxyUrl?: string;
  openrouterSiteName?: string;
  openrouterHttpReferer?: string;
};

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

  async getView(): Promise<DesktopSettingsView> {
    const stored = this.readStored();
    return {
      hasOpenrouterApiKey: Boolean(stored.encryptedOpenrouterApiKey),
      hasTavilyApiKey: Boolean(stored.encryptedTavilyApiKey),
      outboundProxyUrl: stored.outboundProxyUrl || "",
      openrouterSiteName: stored.openrouterSiteName || "",
      openrouterHttpReferer: stored.openrouterHttpReferer || "",
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
    };
  }

  async save(input: DesktopSettingsInput): Promise<DesktopSettingsView> {
    const current = this.readStored();
    const next: StoredDesktopSettings = {
      ...current,
      version: 1,
      outboundProxyUrl: normalizeHttpUrl(input.outboundProxyUrl, "Proxy URL"),
      openrouterSiteName: normalizeText(input.openrouterSiteName, 200),
      openrouterHttpReferer: normalizeHttpUrl(input.openrouterHttpReferer, "HTTP referrer"),
    };

    if (input.clearOpenrouterApiKey) delete next.encryptedOpenrouterApiKey;
    if (input.clearTavilyApiKey) delete next.encryptedTavilyApiKey;

    const openrouterApiKey = normalizeText(input.openrouterApiKey, 4096);
    const tavilyApiKey = normalizeText(input.tavilyApiKey, 4096);
    if (openrouterApiKey) next.encryptedOpenrouterApiKey = await this.encrypt(openrouterApiKey);
    if (tavilyApiKey) next.encryptedTavilyApiKey = await this.encrypt(tavilyApiKey);

    this.writeStored(next);
    return this.getView();
  }

  async getServerEnvironment(): Promise<Record<string, string>> {
    const stored = this.readStored();
    const openrouterApiKey = await this.decrypt(stored.encryptedOpenrouterApiKey);
    const tavilyApiKey = await this.decrypt(stored.encryptedTavilyApiKey);
    return {
      OPENROUTER_API_KEY: openrouterApiKey,
      TAVILY_API_KEY: tavilyApiKey,
      OUTBOUND_PROXY_URL: stored.outboundProxyUrl || "",
      OPENROUTER_SITE_NAME: stored.openrouterSiteName || "Private AI Assistant Desktop",
      OPENROUTER_HTTP_REFERER: stored.openrouterHttpReferer || "",
    };
  }
}
