"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** The same pause before every tooltip, whether it comes from a title or cut-off text. */
const DELAY_MS = 300;
const GAP = 6;
/** The nearest a tooltip comes to the window's edges. */
const MARGIN = 8;

type Tip = { text: string; anchor: { top: number; bottom: number; left: number; right: number } };

/**
 * Where a tooltip of this size goes: above its element when it fits there, below
 * when only that fits, otherwise on the roomier side; and always wholly inside the
 * window, sliding along an edge rather than hanging off it. Placement waits for the
 * real size, since a guess from the element alone cut long tooltips off at the
 * window's edges, near the window buttons above all.
 */
export function placeTooltip(anchor: Tip["anchor"], size: { width: number; height: number }, view: { width: number; height: number }) {
  const room = { above: anchor.top - GAP - MARGIN, below: view.height - MARGIN - anchor.bottom - GAP };
  const below = size.height > room.above && (size.height <= room.below || room.below > room.above);
  const top = below ? anchor.bottom + GAP : anchor.top - GAP - size.height;
  const centre = (anchor.left + anchor.right) / 2;
  return {
    side: below ? "bottom" as const : "top" as const,
    top: Math.min(Math.max(top, MARGIN), Math.max(MARGIN, view.height - MARGIN - size.height)),
    left: Math.min(Math.max(centre - size.width / 2, MARGIN), Math.max(MARGIN, view.width - MARGIN - size.width)),
  };
}

/** What a hovered or focused element would say: its title, or its full text when cut short. */
function tipFor(target: Element | null): { element: HTMLElement; text: string } | null {
  if (!(target instanceof Element)) return null;
  const titled = target.closest<HTMLElement>("[title]:not(iframe), [data-tip-title]");
  if (titled) {
    const text = titled.dataset.tipTitle ?? titled.getAttribute("title") ?? "";
    if (text.trim()) return { element: titled, text };
  }
  const clipped = target.closest<HTMLElement>(".truncate, [class*='line-clamp']");
  if (clipped && (clipped.scrollWidth > clipped.clientWidth + 1 || clipped.scrollHeight > clipped.clientHeight + 1)) {
    const text = clipped.textContent?.trim() ?? "";
    if (text) return { element: clipped, text };
  }
  return null;
}

/**
 * One tooltip for the whole app. Elements keep plain `title` attributes (they
 * remain the accessible description, and nothing has to wrap them); while one
 * is shown here its title is set aside so the browser's own tooltip — another
 * style, another delay — does not appear as well. Text cut short with an
 * ellipsis gets the same tooltip with its full text.
 */
export function AppTooltips() {
  const id = useId();
  const [tip, setTip] = useState<Tip | null>(null);
  const node = useRef<HTMLDivElement>(null);
  // Rendered unseen first, then measured and placed before it is painted.
  useLayoutEffect(() => {
    const element = node.current;
    if (!tip || !element) return;
    const place = placeTooltip(tip.anchor, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    element.style.left = `${place.left}px`;
    element.style.top = `${place.top}px`;
    element.dataset.side = place.side;
    element.style.visibility = "visible";
  }, [tip]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    const restore = () => {
      if (current?.dataset.tipTitle !== undefined) { current.setAttribute("title", current.dataset.tipTitle); delete current.dataset.tipTitle; }
      current?.removeAttribute("aria-describedby");
      current = null;
    };
    const hide = () => { clearTimeout(timer); restore(); setTip(null); };
    const show = (target: EventTarget | null) => {
      const found = tipFor(target as Element | null);
      if (!found) { hide(); return; }
      if (found.element === current) return;
      hide();
      current = found.element;
      // Set aside now, before the browser's own tooltip can start its timer.
      if (current.hasAttribute("title")) { current.dataset.tipTitle = current.getAttribute("title")!; current.removeAttribute("title"); }
      const element = current;
      timer = setTimeout(() => {
        if (!element.isConnected) return;
        const box = element.getBoundingClientRect();
        element.setAttribute("aria-describedby", id);
        setTip({ text: found.text, anchor: { top: box.top, bottom: box.bottom, left: box.left, right: box.right } });
      }, DELAY_MS);
    };
    const onOver = (event: PointerEvent) => show(event.target);
    const onOut = (event: PointerEvent) => { if (current && !current.contains(event.relatedTarget as Node | null)) hide(); };
    const onFocus = (event: FocusEvent) => { if ((event.target as Element | null)?.matches?.(":focus-visible")) show(event.target); };
    window.addEventListener("pointerover", onOver, true);
    window.addEventListener("pointerout", onOut, true);
    window.addEventListener("focusin", onFocus, true);
    window.addEventListener("focusout", hide, true);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("scroll", hide, true);
    return () => {
      hide();
      for (const [name, listener] of [["pointerover", onOver], ["pointerout", onOut], ["focusin", onFocus], ["focusout", hide], ["pointerdown", hide], ["keydown", hide], ["scroll", hide]] as const) window.removeEventListener(name, listener as EventListener, true);
    };
  }, [id]);
  if (!tip) return null;
  return createPortal(<div ref={node} id={id} role="tooltip" className="ui-tooltip-content app-tooltip"
    style={{ left: 0, top: 0, visibility: "hidden" }}>{tip.text}</div>, document.body);
}
