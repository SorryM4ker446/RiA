"use client";
import { useLocale } from "@/lib/locale/client";

import { formatDateTime, t, tf } from "@/lib/locale";

import { useEffect, useId, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Reveal } from "@/components/ui/reveal";
import { Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { SettingsSection } from "@/features/settings/settings-section";
import { useDesktopRuntime } from "@/lib/use-desktop-runtime";
import { updatePercent, useUpdate } from "@/features/updates/update-provider";

type Bridge = NonNullable<NonNullable<Window["riaDesktop"]>["updates"]>;

/**
 * The installed version and the next one.
 *
 * The main process owns the update: it checks, downloads, verifies and starts
 * the installer, and this card only shows where that stands and offers the one
 * next step. A found version is neither downloaded nor installed until the user
 * says so; updating then runs in the same dialog the sidebar opens.
 */
export function UpdateSettings() {
  useLocale();
  const toast = useToast();
  const id = useId();
  const isDesktopRuntime = useDesktopRuntime();
  const { state, start, show } = useUpdate();
  const [automatic, setAutomatic] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.riaDesktop?.getSettings().then(view => { if (!cancelled) setAutomatic(view.autoCheckUpdates); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!isDesktopRuntime || !window.riaDesktop?.updates) return null;
  const bridge: Bridge = window.riaDesktop.updates;

  async function check() {
    setProblem(null);
    try { await bridge.check(); }
    catch { setProblem(t("settings.updates.unavailable")); }
  }

  async function toggleAutomatic(next: boolean) {
    const previous = automatic;
    setAutomatic(next);
    setProblem(null);
    try {
      const result = await window.riaDesktop!.saveSettings({ autoCheckUpdates: next });
      setAutomatic(result.settings.autoCheckUpdates);
      toast(t(next ? "settings.updates.autoOn" : "settings.updates.autoOff"));
    } catch {
      setAutomatic(previous);
      setProblem(t("settings.updates.saveFailed"));
    }
  }

  const failure = state?.failure ? t(`settings.updates.failure.${state.failure}`) : null;
  const percent = state ? updatePercent(state) : 0;

  return (
    <SettingsSection
      id="updates"
      title={<><RefreshCw aria-hidden="true" className="h-4 w-4 text-muted-foreground" />{t("settings.updates.title")}</>}
      description={state ? tf("settings.updates.current", { version: state.currentVersion }) : null}
      action={state?.supported ? <UpdateAction state={state} check={check} start={start} show={show} /> : null}
    >
      <div className="flex flex-col gap-3">
        {state ? <UpdateStatus state={state} percent={percent} /> : null}
        {state?.phase === "downloading" ? (
          <div aria-label={t("settings.updates.progress")} aria-valuemax={100} aria-valuemin={0} aria-valuenow={percent} className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar">
            <div className="h-full rounded-full bg-primary transition-[width] duration-[--dur-base] ease-[--ease-out]" style={{ width: `${percent}%` }} />
          </div>
        ) : null}
        {/* Closed, it gives back the gap above it, so it takes no room until it opens. */}
        <Reveal className="-mt-3">{problem || failure ? <Alert className="mt-3" variant="destructive"><AlertDescription>{problem ?? failure}</AlertDescription></Alert> : null}</Reveal>
        {state?.previousInstall ? <PreviousInstallNote previous={state.previousInstall} /> : null}
        {state?.supported ? (
          <Field orientation="horizontal">
            <Checkbox checked={automatic ?? false} disabled={automatic === null} id={`${id}-automatic`} onCheckedChange={value => void toggleAutomatic(value === true)} />
            <FieldLabel htmlFor={`${id}-automatic`}>{t("settings.updates.automatic")}</FieldLabel>
          </Field>
        ) : null}
        <p className="text-[11px] text-muted-foreground">{t(state && !state.supported ? "settings.updates.unsupported" : "settings.updates.note")}</p>
      </div>
    </SettingsSection>
  );
}

function UpdateAction({ state, check, start, show }: { state: DesktopUpdateState; check: () => Promise<void>; start: () => void; show: () => void }) {
  switch (state.phase) {
    case "available":
      return <Button onClick={start} size="sm" type="button">{t("settings.updates.update")}</Button>;
    case "downloading":
    case "ready":
    case "installing":
      return <Button onClick={show} size="sm" type="button" variant="ghost">{t("settings.updates.showProgress")}</Button>;
    default:
      return <Button disabled={state.phase === "checking"} onClick={() => void check()} size="sm" type="button" variant="outline">{t("settings.updates.check")}</Button>;
  }
}

function UpdateStatus({ state, percent }: { state: DesktopUpdateState; percent: number }) {
  const version = state.availableVersion ?? "";
  switch (state.phase) {
    case "checking": return <Status>{t("settings.updates.checking")}</Status>;
    case "current": return <Status tone="success">{state.checkedAt ? tf("settings.updates.upToDateAt", { time: formatDateTime(state.checkedAt, { dateStyle: "short", timeStyle: "short" }) }) : t("settings.updates.upToDate")}</Status>;
    case "available": return <Status tone="warning">{tf("settings.updates.available", { version })}</Status>;
    case "downloading": return <Status tone="warning">{tf("settings.updates.downloading", { version, percent })}</Status>;
    case "ready": return <Status tone="success">{tf("settings.updates.ready", { version })}</Status>;
    case "installing": return <Status>{t("settings.updates.installing")}</Status>;
    default: return state.supported ? <Status>{t("settings.updates.notChecked")}</Status> : null;
  }
}

function PreviousInstallNote({ previous }: { previous: NonNullable<DesktopUpdateState["previousInstall"]> }) {
  if (previous.outcome !== "failed") {
    return <p className="text-xs text-muted-foreground">{tf(previous.outcome === "installed" ? "settings.updates.installed" : "settings.updates.cancelled", { version: previous.version })}</p>;
  }
  const logFile = previous.logFile;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{tf("settings.updates.failed", { version: previous.version, code: previous.exitCode ?? "—" })}</span>
      {logFile ? <Button onClick={() => void window.riaDesktop?.revealPath(logFile)} size="sm" type="button" variant="ghost">{t("settings.updates.showLog")}</Button> : null}
    </div>
  );
}
