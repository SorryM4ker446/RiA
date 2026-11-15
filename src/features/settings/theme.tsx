"use client";

import { useSyncExternalStore } from "react";
import { SunMoon } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingsSection } from "@/features/settings/settings-section";
import { t } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { THEME_STORAGE_KEY } from "@/lib/ui-preferences";

type ThemeMode = "light" | "dark";

function watchTheme(changed: () => void) {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/**
 * The light or dark theme. The page's first script has already applied the saved choice to
 * <html> before anything is drawn, so that element is what this reads and what a choice changes;
 * the choice is kept in this window's storage, where that script finds it at the next start.
 */
export function ThemeSettings() {
  useLocale();
  // The prerendered page cannot know which theme the window is in, so nothing is chosen there.
  const theme = useSyncExternalStore<ThemeMode | null>(watchTheme, () => document.documentElement.classList.contains("dark") ? "dark" : "light", () => null);

  function choose(next: ThemeMode) {
    const root = document.documentElement;
    root.classList.toggle("dark", next === "dark");
    root.style.colorScheme = next;
    // The theme still changes for this session where storage is refused.
    try { window.localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* not kept */ }
  }

  return <SettingsSection
    icon={SunMoon} title={t("settings.theme.title")}
    action={<SegmentedControl
      aria-label={t("settings.theme.title")} aria-describedby="interface-theme-description" size="sm" value={theme}
      options={[{ value: "light", label: t("settings.theme.light") }, { value: "dark", label: t("settings.theme.dark") }]}
      onValueChange={choose}
    />}
  >
    <p id="interface-theme-description" className="text-xs leading-relaxed text-muted-foreground">{t("settings.theme.description")}</p>
  </SettingsSection>;
}
