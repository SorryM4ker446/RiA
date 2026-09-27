"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { t } from "@/lib/locale";
import { cn } from "@/lib/utils/cn";

const noopSubscribe = () => () => {};

/**
 * The window's own caption controls.
 *
 * Windows used to draw these itself through `titleBarOverlay`, which meant an
 * opaque strip sat on top of the page: it could not be styled to match the
 * interface, and it covered the top of the document scrollbar. Drawing them
 * here removes the strip — the top row is the same surface as everything else,
 * and the scrollbar, which belongs to the content below, is never underneath a
 * button.
 *
 * The native frame is still in place, so resizing and snap layouts keep
 * working; only the caption is ours. What is genuinely lost is the hover
 * outline Windows draws over the maximise button for its snap-layout picker,
 * and the OS-drawn tooltip.
 */

type Controls = NonNullable<Window["privateAiDesktop"]>["windowControls"];

function useControls(): Controls | null {
  return useSyncExternalStore(
    noopSubscribe,
    // The bridge is injected by the preload script, and the preload only
    // exposes these verbs on win32, where the native caption is hidden.
    () => window.privateAiDesktop?.windowControls ?? null,
    () => null,
  );
}

export function WindowControls() {
  const controls = useControls();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let cancelled = false;
    // The state pull is an invoke, so it rejects if the sender is refused.
    // `restartLocalService` parks the window on about:blank for a moment,
    // whose origin parses as the string "null" and fails the trust check, so
    // this is a reachable path and not a defensive nicety.
    void controls
      .state()
      .then(state => { if (!cancelled) setMaximized(state.maximized); })
      .catch(() => { /* the caption simply keeps its current glyph */ });
    const off = controls.onMaximizedChange(setMaximized);
    return () => { cancelled = true; off(); };
  }, [controls]);

  if (!controls) return null;

  return (
    <div className="flex h-full items-stretch self-stretch">
      <CaptionButton action={controls.minimize} label={t("window.minimize")}>
        <svg aria-hidden="true" className="h-3 w-3" fill="none" viewBox="0 0 12 12">
          <path d="M2 6.25h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1" />
        </svg>
      </CaptionButton>
      <CaptionButton action={controls.toggleMaximize} label={t(maximized ? "window.restore" : "window.maximize")}>
        {maximized ? (
          /* Two offset squares: the rear one is drawn first and clipped by the
             page, which is what a restore glyph reads as. */
          <svg aria-hidden="true" className="h-3 w-3" fill="none" viewBox="0 0 12 12">
            <path d="M4.25 2.25h5.5v5.5" stroke="currentColor" strokeLinejoin="round" strokeWidth="1" />
            <path d="M7.75 4.25v5.5h-5.5v-5.5z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1" />
          </svg>
        ) : (
          <svg aria-hidden="true" className="h-3 w-3" fill="none" viewBox="0 0 12 12">
            <path d="M2.75 2.75h6.5v6.5h-6.5z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1" />
          </svg>
        )}
      </CaptionButton>
      <CaptionButton action={controls.close} close label={t("window.close")}>
        <svg aria-hidden="true" className="h-3 w-3" fill="none" viewBox="0 0 12 12">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeLinecap="round" strokeWidth="1" />
        </svg>
      </CaptionButton>
    </div>
  );
}

function CaptionButton({ action, label, close, children }: {
  action: () => void;
  label: string;
  /** Close is the one destructive verb, so it alone takes the red hover. */
  close?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        // The header carries `app-region: drag`, and that does not inherit: a
        // no-drag wrapper leaves these buttons inside the drag region, where a
        // click moves the window instead of firing. Each button has to opt out.
        "desktop-titlebar-interactive",
        close
        ? "grid h-full w-11 place-items-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        : "grid h-full w-11 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
      // Never hand the event to `action`. These functions come from the preload
      // bridge, and contextBridge structured-clones every argument before
      // invoking one — a React SyntheticEvent is not cloneable, so passing it
      // throws "An object could not be cloned" and the verb never reaches the
      // window. The button looks wired and the direct bridge call still works,
      // which is why only a real click exposes it.
      onClick={() => action()}
      // The top row is a window drag region; without this the transparent
      // strip above would swallow the click and the button would look dead.
      type="button"
    >
      {children}
    </button>
  );
}
