"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { readRail, setRail, useRailLayout } from "./rail-layout";

/** A pointer passing over the button on its way elsewhere does not open the sidebar. */
const OPEN_DELAY = 80;
/** Time to cross from the button into the sidebar, or to come back, before it closes. */
const CLOSE_DELAY = 220;
/** The docked rail's own widening; the overlay holds still on top until it is done. */
const PIN_MS = 260;
/** How far past the sidebar's edge the pointer may stray before it counts as gone. */
const EDGE_SLACK = 12;

/**
 * open: sliding in or shown over the page. closing: sliding back out.
 * pinning: held still while the docked rail widens underneath, then removed
 * at once, the docked rail now in its place. Only these are rendered, so the
 * page never carries a second, hidden copy of the sidebar.
 */
type Peek = "closed" | "open" | "closing" | "pinning";

/** A button that hands over to another moves keyboard focus there, once it exists. */
function focusAfterRender(selector: string, event: MouseEvent<HTMLButtonElement>) {
  if (document.activeElement !== event.currentTarget) return;
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
}

/** The docked sidebar's own button, at the right of its header: folds it away. */
export function RailFoldButton() {
  useLocale();
  return (
    <Button
      className="rail-header-button desktop-titlebar-interactive" variant="ghost" size="icon-sm" type="button"
      aria-label={t("nav.foldSidebar")}
      onClick={event => { setRail({ width: readRail().width, folded: true }); focusAfterRender(".rail-toggle", event); }}
    >
      <PanelLeft aria-hidden="true" className="h-4 w-4" />
    </Button>
  );
}

/**
 * While the sidebar is folded: a button in the window's top-left corner, and
 * the sidebar shown over the page.
 *
 * Pointing at the corner button slides the sidebar out over the page, usable
 * as long as the pointer stays over it. Whether it does is read from where the
 * pointer is, not from enter and leave events, which do not fire when the
 * sidebar slides in under a pointer at rest. The sidebar shown that way has a pin
 * button exactly where the docked sidebar's fold button sits; clicking it (or
 * the corner button) pins the sidebar: the overlay stays where it is while the
 * docked sidebar opens beneath it and the page slides aside, then the overlay
 * goes without a trace, its button now the docked one.
 */
export function RailControls({ renderBody }: { renderBody: (action: ReactNode) => ReactNode }) {
  useLocale();
  const { folded } = useRailLayout();
  const [peek, setPeek] = useState<Peek>("closed");
  const timer = useRef(0);
  // Dismissed with Escape: the pointer may still rest where it opened it, so it
  // does not open again until the pointer has left and come back.
  const dismissed = useRef(false);
  // Pinned by any other way (a drag, the window crossing the boundary), the overlay no longer applies.
  const shown = peek === "pinning" || (peek === "open" && folded);
  const state: Peek = shown ? peek : peek === "closing" && folded ? "closing" : "closed";

  const later = (next: Peek, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPeek(next), delay);
  };
  // The corner button only opens it; once open, the pointer's position decides (below).
  const enter = () => {
    if (!folded || shown || dismissed.current) return;
    if (state === "closing") { window.clearTimeout(timer.current); setPeek("open"); }
    else later("open", OPEN_DELAY);
  };
  const leave = () => {
    dismissed.current = false;
    // A pointer passing over the button on its way elsewhere does not open it.
    if (!shown) window.clearTimeout(timer.current);
  };
  const pin = (event: MouseEvent<HTMLButtonElement>) => {
    window.clearTimeout(timer.current);
    setRail({ width: readRail().width, folded: false });
    if (shown) {
      setPeek("pinning");
      timer.current = window.setTimeout(() => setPeek("closed"), PIN_MS);
    } else setPeek("closed");
    focusAfterRender(".workspace-rail-docked .rail-header-button", event);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // While it is shown over the page: inside its area (with a little slack past
  // its edge) it stays; outside it, or out of the window, it goes after a short
  // grace, cancelled by coming back. The pin and close timers share `timer`, so
  // ending this watch leaves whatever is pending alone.
  const hovering = peek === "open" && folded;
  useEffect(() => {
    if (!hovering) return;
    let leaving = false;
    const go = () => {
      if (leaving) return;
      leaving = true;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setPeek("closing"), CLOSE_DELAY);
    };
    const stay = () => {
      if (!leaving) return;
      leaving = false;
      window.clearTimeout(timer.current);
    };
    const onMove = (event: PointerEvent) => { if (event.clientX > readRail().width + EDGE_SLACK) go(); else stay(); };
    const onOut = (event: PointerEvent) => { if (!event.relatedTarget) go(); };
    window.addEventListener("pointermove", onMove);
    document.addEventListener("pointerout", onOut);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onOut);
    };
  }, [hovering]);
  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { window.clearTimeout(timer.current); dismissed.current = true; setPeek("closing"); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown]);

  return (
    <>
      <Button
        className="rail-toggle desktop-titlebar-interactive" variant="ghost" size="icon-sm" type="button"
        // No tooltip: pointing at it already shows the sidebar, and a tip there would sit on top of it.
        aria-label={t("nav.expandSidebar")} tabIndex={folded ? 0 : -1}
        onClick={pin} onPointerEnter={enter} onPointerLeave={leave}
        // The top row maximises the window on double-click; a quick second press here must not.
        onDoubleClick={event => event.stopPropagation()}
      >
        <PanelLeft aria-hidden="true" className="h-4 w-4" />
      </Button>
      {state === "closed" ? null : (
        <div
          className="rail-peek" data-state={state}
          onAnimationEnd={event => { if (state === "closing" && event.target === event.currentTarget) setPeek("closed"); }}
        >
          <div className="workspace-rail-inner h-full">
            {renderBody(
              <Button className="rail-header-button desktop-titlebar-interactive" variant="ghost" size="icon-sm" type="button" aria-label={t("nav.pinSidebar")} onClick={pin}>
                <PanelLeft aria-hidden="true" className="h-4 w-4" />
              </Button>,
            )}
          </div>
        </div>
      )}
    </>
  );
}
