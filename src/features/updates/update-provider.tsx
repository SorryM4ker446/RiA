"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf } from "@/lib/locale";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type UpdateContextValue = {
  /** The main process's view of the update; null outside the desktop app or before it answers. */
  state: DesktopUpdateState | null;
  /** Downloads, verifies and installs the offered update, showing its progress. */
  start: () => void;
  /** Shows the progress of an update already under way. */
  show: () => void;
};

const UpdateContext = createContext<UpdateContextValue>({ state: null, start: () => {}, show: () => {} });

export function useUpdate() {
  return useContext(UpdateContext);
}

/** Phases in which an update has been found and not yet handed over. */
export function updatePending(state: DesktopUpdateState | null): state is DesktopUpdateState {
  return Boolean(state?.supported && state.availableVersion && ["available", "downloading", "ready", "installing"].includes(state.phase));
}

export function updatePercent(state: DesktopUpdateState) {
  return state.total > 0 ? Math.min(100, Math.floor((state.received / state.total) * 100)) : 0;
}

/**
 * One copy of the update state for the whole window, and the dialog that shows
 * an update going through.
 *
 * The main process owns the update and broadcasts every change; this only
 * mirrors it. Starting is one request — download, verify, install — and the
 * dialog follows it to the end: the app quits once the installer is ready, so
 * the last thing the dialog says is that it is about to.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  useLocale();
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const bridge = window.riaDesktop?.updates;
    if (!bridge) return;
    let cancelled = false;
    void bridge.state().then(next => { if (!cancelled) setState(next); }, () => {});
    const stop = bridge.onChange(next => setState(next));
    return () => { cancelled = true; stop(); };
  }, []);

  const start = useCallback(() => {
    const bridge = window.riaDesktop?.updates;
    if (!bridge) return;
    setUnavailable(false);
    setOpen(true);
    void bridge.apply().then(setState, () => setUnavailable(true));
  }, []);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ state, start, show }), [state, start, show]);

  return <UpdateContext.Provider value={value}>
    {children}
    {state ? <UpdateDialog open={open} state={state} unavailable={unavailable} onClose={hide} onRetry={start} /> : null}
  </UpdateContext.Provider>;
}

function UpdateDialog({ open, state, unavailable, onClose, onRetry }: { open: boolean; state: DesktopUpdateState; unavailable: boolean; onClose: () => void; onRetry: () => void }) {
  const version = state.availableVersion ?? "";
  const percent = updatePercent(state);
  const failure = unavailable ? t("settings.updates.unavailable") : state.failure ? t(`settings.updates.failure.${state.failure}`) : null;
  // A failed install leaves the verified download in place ("ready"), so a failure outranks that phase.
  const failed = Boolean(failure) && state.phase !== "downloading" && state.phase !== "installing";
  const working = !failed && (state.phase === "downloading" || state.phase === "ready" || state.phase === "installing");
  // A cancelled download returns to "available" without a failure: nothing left to show.
  const visible = open && (working || failed);
  const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

  /*
   * Escape belongs to this dialog while it is up, including over the settings.
   * Radix decides which layer gets Escape by the order the layers registered in,
   * and a dialog reopened over the settings (hidden, then shown again from the
   * card) was ranked beneath them: Escape closed the settings behind it and left
   * this one open. Taking the key at the window, before any layer sees it, makes
   * the topmost dialog the one that answers, whatever that order says.
   */
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, onClose]);

  async function cancel() {
    await window.riaDesktop?.updates?.cancel().catch(() => undefined);
    onClose();
  }

  return (
    // Escape only hides it: the download carries on and the sidebar keeps its progress.
    <AlertDialog open={visible} onOpenChange={next => { if (!next) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{failed ? t("update.dialog.failedTitle") : tf("update.dialog.title", { version })}</AlertDialogTitle>
          <AlertDialogDescription>
            {failed ? failure
              : state.phase === "downloading" ? t("update.dialog.downloading")
              : state.phase === "ready" ? t("update.dialog.verified")
              : t("update.dialog.installing")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {working ? (
          <div className="flex flex-col gap-1.5">
            <div aria-label={t("settings.updates.progress")} aria-valuemax={100} aria-valuemin={0} aria-valuenow={state.phase === "downloading" ? percent : 100} className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar">
              <div className="h-full rounded-full bg-primary transition-[width] duration-[--dur-base] ease-[--ease-out]" style={{ width: `${state.phase === "downloading" ? percent : 100}%` }} />
            </div>
            <p className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
              <span>{state.phase === "downloading" ? `${percent}%` : t("update.dialog.restarting")}</span>
              {state.total > 0 ? <span>{tf("update.dialog.size", { received: megabytes(state.received), total: megabytes(state.total) })}</span> : null}
            </p>
          </div>
        ) : null}
        <AlertDialogFooter>
          {state.phase === "downloading" ? <>
            {/* The dialog's cancel: it takes the focus when the dialog opens, and only hides the dialog. */}
            <AlertDialogCancel type="button">{t("update.dialog.background")}</AlertDialogCancel>
            <Button onClick={() => void cancel()} size="sm" type="button" variant="outline">{t("update.dialog.cancel")}</Button>
          </> : !working ? <>
            <AlertDialogCancel type="button">{t("update.dialog.close")}</AlertDialogCancel>
            <Button onClick={onRetry} size="sm" type="button">{t("update.dialog.retry")}</Button>
          </> : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
