"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";

type Toast = { id: number; message: string; leaving: boolean };
type Show = (message: string) => void;

const ToastContext = createContext<Show | null>(null);
/** Long enough to read a short line, more for longer ones; pointing at or focusing the stack holds it. */
const duration = (message: string) => Math.min(10_000, 4000 + message.length * 50);
/** Older toasts give way so the stack never grows past a glance. */
const LIMIT = 3;

/**
 * Short confirmations of something that just happened (saved, enabled,
 * deleted), stacked at the bottom right and gone on their own. A failure the
 * user has to act on stays next to the action instead of passing by here.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  useLocale();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [paused, setPaused] = useState(false);
  const next = useRef(0);

  const remove = useCallback((id: number) => setToasts(old => old.filter(item => item.id !== id)), []);
  // With reduced motion there is no exit animation to wait for, so it goes at once.
  const dismiss = useCallback((id: number) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) remove(id);
    else setToasts(old => old.map(item => item.id === id ? { ...item, leaving: true } : item));
  }, [remove]);
  const show = useCallback<Show>(message => {
    const id = ++next.current;
    setToasts(old => [...old.filter(item => !item.leaving).slice(-(LIMIT - 1)), { id, message, leaving: false }]);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Always mounted, so screen readers already watch it when a message arrives. A live
          region rather than a status: pages keep their own status lines, and this one is not one of them. */}
      <section aria-label={t("ui.toast.region")} aria-live="polite" className="toast-stack" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
        {toasts.map(toast => <ToastItem key={toast.id} toast={toast} paused={paused} onDismiss={dismiss} onRemove={remove} />)}
      </section>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, paused, onDismiss, onRemove }: { toast: Toast; paused: boolean; onDismiss: (id: number) => void; onRemove: (id: number) => void }) {
  const remaining = useRef(duration(toast.message));
  useEffect(() => {
    if (paused || toast.leaving) return;
    const started = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => { window.clearTimeout(timer); remaining.current -= Date.now() - started; };
  }, [paused, toast.leaving, toast.id, onDismiss]);
  return <div className="toast" data-leaving={toast.leaving || undefined} onAnimationEnd={event => { if (toast.leaving && event.target === event.currentTarget) onRemove(toast.id); }}>{toast.message}</div>;
}

export function useToast(): Show {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used inside ToastProvider");
  return toast;
}
