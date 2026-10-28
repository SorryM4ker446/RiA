"use client";

import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { t } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { RAIL_BOUNDS } from "@/lib/ui-preferences";
import { clampRailWidth, readRail, setRail, showFolded, useRailLayout } from "./rail-layout";

/** Below the minimum the rail gives a little, then folds away past the threshold. */
const RESISTANCE = 0.3;
const KEY_STEP = 16;

/**
 * The sidebar's right edge. Dragging it follows the pointer frame by frame;
 * dragging it well past the minimum folds the sidebar away, and dragging back
 * out in the same gesture brings it back. Double-click restores the default.
 */
export function RailResizer() {
  useLocale();
  const rail = useRailLayout();

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const root = document.documentElement;
    const start = readRail();
    const startX = event.clientX;
    let width = start.width;
    let folded = false;
    let frame = 0;
    // Holds the cursor and keeps this edge for the whole gesture. The rail follows
    // the pointer directly; only a snap open or shut eases (see showFolded).
    root.dataset.railDragging = "";
    const snap = (shut: boolean) => {
      folded = shut;
      showFolded(shut);
    };
    const move = (next: PointerEvent) => {
      const raw = start.width + next.clientX - startX;
      if (raw < RAIL_BOUNDS.collapseAt) { if (!folded) snap(true); return; }
      width = raw >= RAIL_BOUNDS.min ? Math.min(raw, RAIL_BOUNDS.max) : RAIL_BOUNDS.min - (RAIL_BOUNDS.min - raw) * RESISTANCE;
      if (folded) snap(false);
      frame ||= requestAnimationFrame(() => { frame = 0; root.style.setProperty("--rail-width", `${Math.round(width)}px`); });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      cancelAnimationFrame(frame);
      delete root.dataset.railDragging;
      // Folded away, it keeps the width it had, to come back to. A width in the
      // give below the minimum settles back to the minimum, animated.
      setRail(folded ? { width: start.width, folded: true } : { width: clampRailWidth(width), folded: false });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const { width } = readRail();
    const next = event.key === "ArrowLeft" ? width - KEY_STEP : event.key === "ArrowRight" ? width + KEY_STEP
      : event.key === "Home" ? RAIL_BOUNDS.min : event.key === "End" ? RAIL_BOUNDS.max : null;
    if (event.key === "Enter") { event.preventDefault(); setRail({ width, folded: true }); return; }
    if (next === null) return;
    event.preventDefault();
    setRail({ width: next, folded: false });
  }

  return (
    <div className="rail-resizer" aria-hidden={rail.folded || undefined}>
      <div
        role="separator" aria-orientation="vertical" tabIndex={rail.folded ? -1 : 0}
        aria-label={t("nav.resizeSidebar")} title={t("nav.resizeSidebarHint")}
        aria-valuemin={RAIL_BOUNDS.min} aria-valuemax={RAIL_BOUNDS.max} aria-valuenow={rail.width}
        className="rail-resizer-handle desktop-titlebar-interactive"
        onPointerDown={onPointerDown} onKeyDown={onKeyDown}
        onDoubleClick={() => setRail({ width: RAIL_BOUNDS.default, folded: false })}
      />
    </div>
  );
}
