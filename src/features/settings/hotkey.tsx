"use client";
import { useLocale } from "@/lib/locale/client";

import { t } from "@/lib/locale";

import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/features/settings/settings-section";
import { Input } from "@/components/ui/input";
import { useDesktopRuntime } from "@/lib/use-desktop-runtime";

/**
 * One global shortcut, and it only brings this window forward.
 *
 * The combination is registered by the operating system, which is the only
 * thing that can know whether it is free. A refusal is reported rather than
 * swallowed: a shortcut that silently does nothing is worse than one the user
 * is told another program already owns.
 */
export function HotkeySettings() {
  useLocale();
  const isDesktopRuntime = useDesktopRuntime();
  const [hotkey, setHotkey] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<"conflict" | "invalid" | "not-stored" | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.privateAiDesktop
      ?.getSettings()
      .then((view) => setHotkey(view.globalHotkey ?? ""))
      .catch(() => setProblem("invalid"));
  }, []);

  if (!isDesktopRuntime) return null;

  async function apply(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setProblem(null);
    setSaved(false);
    try {
      const outcome = await window.privateAiDesktop!.setGlobalHotkey(hotkey.trim());
      // A refusal reports the combination still in force, so the field shows
      // that rather than one the shell never took.
      if (!outcome.ok) {
        setProblem(outcome.reason ?? "conflict");
        setHotkey(outcome.hotkey);
      } else setSaved(true);
    } catch {
      setProblem("invalid");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title={<><Keyboard aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          {t("settings.hotkey.title")}</>} description={t("ui.settings.hotkey.bringRiAToTheFrontFrom")}>
        <div className="flex flex-col gap-4">
        {problem ? (
          <Alert variant="destructive">
            <AlertTitle>
              {problem === "conflict"
                ? t("settings.hotkey.conflictTitle")
                : problem === "not-stored"
                  ? t("settings.close.failedTitle")
                  : t("settings.hotkey.invalidTitle")}
            </AlertTitle>
            <AlertDescription>
              {problem === "conflict"
                ? t("settings.hotkey.conflict")
                : problem === "not-stored"
                  ? t("settings.close.failed")
                  : t("settings.hotkey.invalid")}
            </AlertDescription>
          </Alert>
        ) : null}
        {saved ? <p className="text-xs text-success">{t("settings.hotkey.saved")}</p> : null}
        <form className="flex flex-wrap items-center gap-2" onSubmit={apply}>
          <Input
            className="min-w-0 flex-1 sm:max-w-sm"
            aria-label={t("settings.hotkey.label")}
            onChange={(event) => { setHotkey(event.target.value); setSaved(false); }}
            placeholder="Ctrl+Shift+R"
            value={hotkey}
          />
          <Button disabled={saving} type="submit">{t("settings.hotkey.apply")}</Button>
          {hotkey ? (
            <Button disabled={saving} onClick={() => { setHotkey(""); setSaved(false); }} type="button" variant="outline">
              {t("settings.hotkey.clear")}
            </Button>
          ) : null}
        </form>
        <p className="text-[11px] text-muted-foreground">{t("settings.hotkey.note")}</p>
      </div>
    </SettingsSection>
  );
}
