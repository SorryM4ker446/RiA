"use client";
import { useLocale } from "@/lib/locale/client";

import { t, localizeMessage } from "@/lib/locale";

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Power } from "lucide-react";
import { SettingsSection } from "@/features/settings/settings-section";
import { useDesktopRuntime } from "@/lib/use-desktop-runtime";

/**
 * What happens when the window is closed.
 *
 * The default is that the app exits, and it stays the default. A tray keeps a
 * local service listening after the window is gone, which is convenient and is
 * also a process the user has to know how to stop — so becoming resident is a
 * switch they flip, not something the app does quietly the first time somebody
 * clicks the X.
 */
export function CloseBehaviourSettings() {
  useLocale();
  const isDesktopRuntime = useDesktopRuntime();
  const [behaviour, setBehaviour] = useState<"quit" | "tray" | null>(null);
  const [saving, setSaving] = useState(false);
  // The choice being saved shows at once; a save that fails puts the saved one back.
  const [pending, setPending] = useState<"quit" | "tray" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.riaDesktop
      ?.getSettings()
      .then((view) => { if (!cancelled) setBehaviour(view.closeBehaviour); })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : t("settings.close.failed")); });
    return () => { cancelled = true; };
  }, []);

  // Keep the prerender and first client render identical before exposing IPC controls.
  if (!isDesktopRuntime) {
    // Outside the desktop shell the question does not exist: closing the window
    // ends the app, and there is nothing to choose.
    return null;
  }

  async function choose(next: "quit" | "tray") {
    if (saving || next === behaviour) return;
    setSaving(true);
    setPending(next);
    setError(null);
    try {
      const result = await window.riaDesktop!.saveSettings({ closeBehaviour: next });
      setBehaviour(result.settings.closeBehaviour);
      // This save touches nothing the local service reads at start-up, so it
      // neither restarts the service nor blanks the window. The tray is built
      // before this returns, and a tray that could not be built rejects here
      // rather than leaving the card claiming a setting that never took.
      if (next === "tray") await window.riaDesktop!.showFromTray();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("settings.close.failed"));
    } finally {
      setPending(null);
      setSaving(false);
    }
  }

  return (
    <SettingsSection icon={Power} title={t("settings.close.title")} description={t("ui.settings.close-behaviour.chooseWhetherClosingTheWindowQuits")}>
        <div className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{t("settings.close.failedTitle")}</AlertTitle>
            <AlertDescription>{localizeMessage(error)}</AlertDescription>
          </Alert>
        ) : null}
        <SegmentedControl
          aria-label={t("settings.close.title")}
          value={pending ?? behaviour}
          busy={saving}
          options={[{ value: "quit", label: t("settings.close.quit") }, { value: "tray", label: t("settings.close.tray") }]}
          onValueChange={next => void choose(next)}
        />
        {/* Quitting is the one outcome worth a word: the tray choice explains itself, and the tray icon carries its own Quit. */}
        {behaviour === "quit" ? <p className="text-[11px] text-muted-foreground">{t("settings.close.quitNote")}</p> : null}
      </div>
    </SettingsSection>
  );
}
