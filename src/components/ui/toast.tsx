"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { CircleAlert, TriangleAlert, X } from "lucide-react";
import { useLocale } from "@/lib/locale/client";
import { t } from "@/lib/locale";

/**
 * A line of text, or a result with a quieter line on what it means, and
 * optionally one action that takes it back (such as Redo after an undo). The
 * action must name what it acts on when it is created, never act on whatever
 * is open by the time it is clicked.
 *
 * `tone` marks what needs noticing: an error (something did not happen) or a
 * warning (it happened, with a catch). A plain confirmation has no tone and no
 * icon, so the ones that matter stand out.
 */
export type ToastAction = { label: string; run: () => void };
export type ToastTone = "error" | "warning";
export type ToastInput = string | { title: string; description?: string; action?: ToastAction; tone?: ToastTone };
type Toast = { id: number; title: string; description?: string; action?: ToastAction; tone?: ToastTone; leaving: boolean };
type Show = (toast: ToastInput) => void;

const ToastContext = createContext<Show | null>(null);
/** At most this many at once; an older one leaves early to make room. */
const VISIBLE = 3;
const GAP = 8;
/** Long enough to read once, never long enough to linger. A failure, or one with an action, stays long enough to act on. */
const duration = (toast: Toast) => toast.action || toast.tone === "error" ? 5000
  : Math.min(4000, 2000 + (toast.title.length + (toast.description?.length ?? 0)) * 25);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Short notes on something that just happened (saved, enabled, deleted), in
 * the bottom-right corner, away from the content and the controls people work
 * with; in a narrow window they sit at the bottom, across it.
 *
 * Several stack, newest at the bottom: each one arriving slides in from below
 * and pushes the others up; one leaving fades out and the rest close the gap.
 * Pointing at a note, focusing it or leaving the window pauses them all, so
 * nothing disappears while it is being read.
 *
 * Clicks go through a note to whatever is under it, so a note never stands
 * between the user and a control; only its own buttons take clicks: an action,
 * and the close button, which shows on the note being pointed at. Pointing is
 * read from where the pointer is rather than from hover, for that reason. A page can keep them clear of its
 * own bottom area (the chat composer) with useToastClearance. A failure the
 * user has to act on stays next to the action instead of passing by here.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  useLocale();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [heights, setHeights] = useState<Record<number, number>>({});
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const next = useRef(0);

  // Which note the pointer is over, from its position, since notes let clicks through and get no hover of their own.
  const stack = useRef<HTMLElement>(null);
  /** Where the pointer last was in the window, or null once it left. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const locate = useCallback(() => {
    const at = pointer.current;
    let over: number | null = null;
    if (at) for (const note of stack.current?.querySelectorAll<HTMLElement>('.toast:not([data-state="leaving"])') ?? []) {
      const box = note.getBoundingClientRect();
      if (at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom) over = Number(note.dataset.id);
    }
    setHovered(over);
  }, []);
  useEffect(() => {
    let frame = 0;
    const find = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(locate);
    };
    const leave = () => { pointer.current = null; setHovered(null); };
    window.addEventListener("pointermove", find, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("pointermove", find); document.documentElement.removeEventListener("pointerleave", leave); };
  }, [locate]);
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const remove = useCallback((id: number) => {
    setToasts(old => old.filter(item => item.id !== id));
    setHeights(old => { const { [id]: _gone, ...rest } = old; return rest; });
  }, []);
  // With reduced motion there is no fade to wait for, so it goes at once.
  const dismiss = useCallback((id: number) => {
    if (reducedMotion()) remove(id);
    else setToasts(old => old.map(item => item.id === id ? { ...item, leaving: true } : item));
  }, [remove]);
  const show = useCallback<Show>(input => {
    const id = ++next.current;
    const arriving: Toast = { id, leaving: false, ...(typeof input === "string" ? { title: input } : input) };
    setToasts(old => {
      const staying = old.filter(item => !item.leaving);
      // Room for the new one: the oldest beyond the limit leave now.
      const overflow = new Set(staying.slice(0, Math.max(0, staying.length - (VISIBLE - 1))).map(item => item.id));
      return [...old.map(item => overflow.has(item.id) ? { ...item, leaving: true } : item), arriving];
    });
  }, []);
  const measure = useCallback((id: number, height: number) => setHeights(old => old[id] === height ? old : { ...old, [id]: height }), []);

  /*
   * What pauses the notes is read again whenever they change, not only when the
   * pointer or the focus moves. A note closed by hand takes its focused button
   * with it, and the browser sends no blur for a removed element, so the stack
   * stayed "focused" and every later note waited forever. Likewise the note the
   * pointer was over can go, or the stack can move out from under a still pointer.
   */
  useEffect(() => {
    setFocused(Boolean(stack.current?.contains(document.activeElement)));
    const frame = requestAnimationFrame(locate);
    return () => cancelAnimationFrame(frame);
  }, [toasts, heights, locate]);

  // Each one sits above the newer ones still showing; one leaving keeps its place as it fades.
  const offsets = new Map<number, number>();
  let below = 0;
  for (const toast of [...toasts].reverse()) {
    offsets.set(toast.id, below);
    if (!toast.leaving) below += (heights[toast.id] ?? 0) + GAP;
  }
  const paused = hovered !== null || focused || hidden;

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Always mounted, so screen readers already watch it when a message arrives. A live
          region rather than a status: pages keep their own status lines, and this one is not one of them. */}
      <section ref={stack} aria-label={t("ui.toast.region")} aria-live="polite" className="toast-stack" style={{ height: Math.max(0, below - GAP) }}
        onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
        {toasts.map(toast => <ToastItem key={toast.id} toast={toast} offset={offsets.get(toast.id) ?? 0} paused={paused} pointed={hovered === toast.id} onDismiss={dismiss} onRemove={remove} onMeasure={measure} />)}
      </section>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, offset, paused, pointed, onDismiss, onRemove, onMeasure }: {
  toast: Toast; offset: number; paused: boolean; pointed: boolean;
  onDismiss: (id: number) => void; onRemove: (id: number) => void; onMeasure: (id: number, height: number) => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  // Mounted below its place, then moved into it on the next frame, so it slides in.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
    return () => cancelAnimationFrame(frame);
  }, []);
  useLayoutEffect(() => {
    const element = node.current;
    if (!element) return;
    const report = () => onMeasure(toast.id, element.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [toast.id, onMeasure]);

  // The time left is kept across pauses, so reading it does not cost the reader its time.
  const remaining = useRef(duration(toast));
  useEffect(() => {
    if (toast.leaving || paused) return;
    const started = Date.now();
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => { window.clearTimeout(timer); remaining.current = Math.max(800, remaining.current - (Date.now() - started)); };
  }, [toast.id, toast.leaving, paused, onDismiss]);
  // The fade's end removes it; a page that skipped it (hidden, throttled) still does not keep it.
  useEffect(() => {
    if (!toast.leaving) return;
    const fallback = window.setTimeout(() => onRemove(toast.id), 600);
    return () => window.clearTimeout(fallback);
  }, [toast.id, toast.leaving, onRemove]);

  const Icon = toast.tone === "error" ? CircleAlert : toast.tone === "warning" ? TriangleAlert : null;
  return (
    <div ref={node} className="toast" data-id={toast.id} data-pointed={pointed ? "" : undefined} role={toast.tone === "error" ? "alert" : undefined}
      data-state={toast.leaving ? "leaving" : entered ? "shown" : "entering"} data-tone={toast.tone} data-action={toast.action ? "" : undefined} data-size={toast.description || toast.action ? "wide" : undefined}
      style={{ "--toast-offset": `${offset}px` } as React.CSSProperties}
      onTransitionEnd={event => { if (toast.leaving && event.target === event.currentTarget && event.propertyName === "opacity") onRemove(toast.id); }}>
      {Icon ? <Icon className="toast-icon" aria-hidden="true" /> : null}
      <div className="toast-text">
        <p className="toast-title">{toast.title}</p>
        {toast.description ? <p className="toast-description">{toast.description}</p> : null}
      </div>
      {toast.action ? <button type="button" className="toast-action" onClick={() => { const action = toast.action!; onDismiss(toast.id); action.run(); }}>{toast.action.label}</button> : null}
      <button type="button" className="toast-close" aria-label={t("ui.toast.dismiss")} onClick={() => onDismiss(toast.id)}><X aria-hidden="true" /></button>
    </div>
  );
}

/**
 * Keeps the notes clear of a page's own bottom area, such as the chat
 * composer and the cards above it: while the corner would overlap what is
 * inside the element, the stack rises to just above it, and it follows as that
 * area grows or shrinks.
 */
export function useToastClearance(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = document.documentElement;
    const update = () => {
      const stack = document.querySelector<HTMLElement>(".toast-stack");
      const parts = [...element.children].map(child => child.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
      if (!stack || !parts.length) { root.style.removeProperty("--toast-bottom"); return; }
      const column = stack.getBoundingClientRect();
      const top = Math.min(...parts.map(box => box.top));
      const overlaps = parts.some(box => box.right > column.left && box.left < column.right);
      if (overlaps) root.style.setProperty("--toast-bottom", `${Math.max(20, Math.round(window.innerHeight - top + 12))}px`);
      else root.style.removeProperty("--toast-bottom");
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    const mutations = new MutationObserver(() => { for (const child of element.children) observer.observe(child); update(); });
    mutations.observe(element, { childList: true });
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", update);
      root.style.removeProperty("--toast-bottom");
    };
  }, [ref]);
}

export function useToast(): Show {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used inside ToastProvider");
  return toast;
}
