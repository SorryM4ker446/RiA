"use client";

import { useEffect, useState } from "react";
import { Power } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/lib/locale";

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
  const [behaviour, setBehaviour] = useState<"quit" | "tray" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.privateAiDesktop
      ?.getSettings()
      .then((view) => { if (!cancelled) setBehaviour(view.closeBehaviour); })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : t("settings.close.failed")); });
    return () => { cancelled = true; };
  }, []);

  if (!window.privateAiDesktop) {
    // Outside the desktop shell the question does not exist: closing the window
    // ends the app, and there is nothing to choose.
    return null;
  }

  async function choose(next: "quit" | "tray") {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await window.privateAiDesktop!.saveSettings({ closeBehaviour: next });
      setBehaviour(result.settings.closeBehaviour);
      // This save touches nothing the local service reads at start-up, so it
      // neither restarts the service nor blanks the window. The tray is built
      // before this returns, and a tray that could not be built rejects here
      // rather than leaving the card claiming a setting that never took.
      if (next === "tray") await window.privateAiDesktop!.showFromTray();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("settings.close.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Power aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          {t("settings.close.title")}
        </CardTitle>
        <CardDescription>{t("settings.close.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{t("settings.close.failedTitle")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={saving || behaviour === "quit"}
            onClick={() => void choose("quit")}
            type="button"
            variant={behaviour === "quit" ? "default" : "outline"}
          >
            {t("settings.close.quit")}
          </Button>
          <Button
            disabled={saving || behaviour === "tray"}
            onClick={() => void choose("tray")}
            type="button"
            variant={behaviour === "tray" ? "default" : "outline"}
          >
            {t("settings.close.tray")}
          </Button>
        </div>
        {behaviour === "tray" ? (
          <div className="space-y-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
            <p>{t("settings.close.trayNote")}</p>
            <Button disabled={saving} onClick={() => void window.privateAiDesktop?.quitToTray()} size="sm" type="button" variant="outline">
              {t("settings.close.quitNow")}
            </Button>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">{t("settings.close.quitNote")}</p>
        )}
      </CardContent>
    </Card>
  );
}
