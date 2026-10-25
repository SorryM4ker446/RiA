"use client";

import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

/** The same pause before every tooltip, whether it comes from a title or cut-off text. */
const DELAY_MS = 300;
const GAP = 6;

type Tip = { text: string; top: number; left: number; below: boolean };

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
        const below = box.top < 48;
        element.setAttribute("aria-describedby", id);
        setTip({ text: found.text, left: Math.min(Math.max(box.left + box.width / 2, 12), window.innerWidth - 12), top: below ? box.bottom + GAP : box.top - GAP, below });
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
  return createPortal(<div id={id} role="tooltip" className="ui-tooltip-content app-tooltip" data-side={tip.below ? "bottom" : "top"}
    style={{ left: tip.left, top: tip.top }}>{tip.text}</div>, document.body);
}
