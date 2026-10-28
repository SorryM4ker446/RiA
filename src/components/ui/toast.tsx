"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";

/** A line of text, or a result with a quieter line on what it means. */
export type ToastInput = string | { title: string; description?: string };
type Toast = { id: number; title: string; description?: string; leaving: boolean };
type Show = (toast: ToastInput) => void;

const ToastContext = createContext<Show | null>(null);
/** Long enough to read once, never long enough to linger. */
const duration = (toast: Toast) => Math.min(3500, 1800 + (toast.title.length + (toast.description?.length ?? 0)) * 20);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Short confirmations of something that just happened (saved, enabled,
 * deleted), shown one at a time and gone on their own. A new one fades in over
 * the last as that fades out, in the same place, so nothing moves. They take
 * no clicks, so they never stand between the user and a control. A failure the
 * user has to act on stays next to the action instead of passing by here.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  useLocale();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);

  const remove = useCallback((id: number) => setToasts(old => old.filter(item => item.id !== id)), []);
  // With reduced motion there is no fade to wait for, so it goes at once.
  const dismiss = useCallback((id: number) => {
    if (reducedMotion()) remove(id);
    else setToasts(old => old.map(item => item.id === id ? { ...item, leaving: true } : item));
  }, [remove]);
  const show = useCallback<Show>(input => {
    const id = ++next.current;
    const arriving: Toast = { id, leaving: false, ...(typeof input === "string" ? { title: input } : input) };
    setToasts(old => reducedMotion() ? [arriving] : [...old.map(item => ({ ...item, leaving: true })), arriving]);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Always mounted, so screen readers already watch it when a message arrives. A live
          region rather than a status: pages keep their own status lines, and this one is not one of them. */}
      <section aria-label={t("ui.toast.region")} aria-live="polite" className="toast-stack">
        {toasts.map(toast => <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} onRemove={remove} />)}
      </section>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss, onRemove }: { toast: Toast; onDismiss: (id: number) => void; onRemove: (id: number) => void }) {
  useEffect(() => {
    if (toast.leaving) return;
    const timer = window.setTimeout(() => onDismiss(toast.id), duration(toast));
    return () => window.clearTimeout(timer);
  }, [toast, onDismiss]);
  return (
    <div className="toast" data-leaving={toast.leaving || undefined} onAnimationEnd={event => { if (toast.leaving && event.target === event.currentTarget) onRemove(toast.id); }}>
      <p className="toast-title">{toast.title}</p>
      {toast.description ? <p className="toast-description">{toast.description}</p> : null}
    </div>
  );
}

/**
 * Centres confirmations on an element, such as the chat page's toolbar row,
 * for as long as it is on screen, so they appear in line with it instead of
 * over the content. They follow it as it moves and return to the bottom
 * centre when it goes.
 */
export function useToastAnchor(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const root = document.documentElement;
    const update = () => {
      const box = node.getBoundingClientRect();
      root.style.setProperty("--toast-top", `${Math.round(box.top + box.height / 2)}px`);
      root.style.setProperty("--toast-center", `${Math.round(box.left + box.width / 2)}px`);
    };
    update();
    root.dataset.toastAnchored = "";
    const observer = new ResizeObserver(update);
    observer.observe(node);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      delete root.dataset.toastAnchored;
      root.style.removeProperty("--toast-top");
      root.style.removeProperty("--toast-center");
    };
  }, [ref]);
}

export function useToast(): Show {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used inside ToastProvider");
  return toast;
}
