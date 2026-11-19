"use client";
import { useEffect, useState } from "react";
import { Stethoscope } from "lucide-react";
import { useLocale } from "@/lib/locale/client";
import { t, tf } from "@/lib/locale";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useDesktopRuntime } from "@/lib/use-desktop-runtime";
import { writeToClipboard } from "@/lib/clipboard";
import { SettingsSection } from "@/features/settings/settings-section";

/** What a report of a problem needs: the version and how it was installed, and where the data, cache and log really are. */
export function diagnosticsText(info: DesktopRuntimeInfo) {
  return [
    `RiA ${info.appVersion} · ${t(info.packaged ? "settings.diagnostics.installed" : "settings.diagnostics.development")} · ${info.platform}`,
    tf("settings.diagnostics.data", { path: info.dataDirectory }) + (info.dataMoved ? t("settings.diagnostics.moved") : ""),
    tf("settings.diagnostics.cache", { path: info.cacheDirectory }) + (info.cacheSeparate ? t("settings.diagnostics.separate") : ""),
    tf("settings.diagnostics.log", { path: info.logFile }),
  ].join("\n");
}

/**
 * Help for when something goes wrong: the log folder, and the facts a report
 * needs, copied in one go. Where the data and cache are kept is shown and changed
 * under Storage; the version under Updates.
 */
export function DiagnosticsSettings() {
  useLocale();
  const desktop = useDesktopRuntime();
  const toast = useToast();
  const [info, setInfo] = useState<DesktopRuntimeInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.riaDesktop?.getRuntimeInfo().then(value => { if (!cancelled) setInfo(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!desktop) return null;

  async function copy() {
    const fresh = await window.riaDesktop?.getRuntimeInfo().catch(() => null) ?? info;
    if (!fresh) { toast({ title: t("settings.diagnostics.unavailable"), tone: "error" }); return; }
    const outcome = await writeToClipboard(diagnosticsText(fresh));
    toast(outcome === "copied" ? t("settings.diagnostics.copied") : { title: t("settings.diagnostics.copyFailed"), tone: "error" });
  }
  async function openLogs() {
    const result = await window.riaDesktop?.openLogsFolder().catch(() => null);
    if (!result?.opened) toast({ title: t("settings.diagnostics.openFailed"), tone: "error" });
  }

  return <SettingsSection icon={Stethoscope} title={t("settings.diagnostics.title")} description={t("settings.diagnostics.description")}
    action={<div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="secondary" onClick={() => void openLogs()}>{t("settings.diagnostics.openLogs")}</Button>
      <Button type="button" size="sm" variant="secondary" disabled={!info} onClick={() => void copy()}>{t("settings.diagnostics.copy")}</Button>
    </div>}>
    {null}
  </SettingsSection>;
}
