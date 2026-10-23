/**
 * Where each part of the settings overlay is addressed. The overlay opens over
 * whatever page is showing and is named in that page's address as
 * `?settings=<section>`, so the address alone says what is open: a reload keeps
 * it, going back closes it, and a link can point straight at one part.
 */
export const SETTINGS_PARAM = "settings";

export const SETTINGS_SECTIONS = ["services", "application", "automation", "files", "models", "usage", "extensions", "backups", "storage"] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

const isSection = (value: string): value is SettingsSectionId => (SETTINGS_SECTIONS as readonly string[]).includes(value);

/** The provider keys can only be edited in the desktop app, so the browser opens on the preferences instead. */
export function defaultSettingsSection(desktop: boolean): SettingsSectionId {
  return desktop ? "services" : "application";
}

/** An empty or unknown value opens the default section rather than nothing. */
export function resolveSettingsSection(value: string, desktop: boolean): SettingsSectionId {
  return isSection(value) ? value : defaultSettingsSection(desktop);
}

/**
 * The address that opens a section when there is no page to open it over: a
 * link written by the server (a notice, a tool's "where to set this up"), or a
 * visit to one of the old addresses below. Chat is where the app starts, so
 * closing the settings lands there.
 */
export function settingsHref(section: SettingsSectionId | null) {
  return `/chat?${SETTINGS_PARAM}=${section ?? ""}`;
}

/**
 * The pages these sections used to be. Bookmarks and notices stored before the
 * overlay existed still name them: the server redirects each to `settingsHref`,
 * and inside the app they open the matching section in place.
 */
export const LEGACY_SETTINGS_PATHS: Readonly<Record<string, SettingsSectionId | null>> = {
  "/settings": null,
  "/models": "models",
  "/extensions": "extensions",
  "/backups": "backups",
  "/storage": "storage",
};

/**
 * The section a link points at, whether it is written as a settings address
 * (`…?settings=backups`) or as an old page. `{ section: null }` means the
 * default section; null means an ordinary page. Every link that comes from
 * stored data goes through this, so following one never leaves the page in use.
 */
export function settingsSectionForHref(href: string): { section: SettingsSectionId | null } | null {
  let url: URL;
  try { url = new URL(href, "http://local.invalid"); } catch { return null; }
  if (url.origin !== "http://local.invalid") return null;
  const value = url.searchParams.get(SETTINGS_PARAM);
  if (value !== null) return { section: isSection(value) ? value : null };
  return url.pathname in LEGACY_SETTINGS_PATHS ? { section: LEGACY_SETTINGS_PATHS[url.pathname] } : null;
}

/** The current address with the overlay set to `section`, or without it for null. */
export function settingsUrl(section: SettingsSectionId | null) {
  const url = new URL(window.location.href);
  if (section) url.searchParams.set(SETTINGS_PARAM, section);
  else url.searchParams.delete(SETTINGS_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
