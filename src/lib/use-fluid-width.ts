"use client";

import { useEffect, type RefObject } from "react";

/** Fallback for a width transition that never reports its end, such as one on a hidden element. */
const SETTLE_AFTER_MS = 400;

/**
 * Lets an inline control follow the width of its content without jumping.
 *
 * When the content resizes the control, it is held at the width it had and
 * eased to the new one, so the controls beside it glide instead of snapping
 * into place. ResizeObserver reports after layout and before paint, so the old
 * width is back before the new one is ever drawn. With reduced motion the
 * control takes its new width at once.
 */
export function useFluidWidth(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node || typeof ResizeObserver === "undefined") return;
    const base = getComputedStyle(node).transition;
    let shown = node.getBoundingClientRect().width;
    // Text shown at the last settled width. A label arriving where there was
    // none is a first appearance, not a change: easing it in from the empty
    // control's width would show its first character alone ("选") before the rest.
    let shownText = node.textContent?.trim() ?? "";
    let animating = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const animate = (from: number, to: number) => {
      animating = true;
      node.style.transition = "none";
      node.style.width = `${from}px`;
      void node.offsetWidth;
      node.style.transition = `${base && base !== "all 0s ease 0s" ? `${base}, ` : ""}width var(--dur-base) var(--ease-out)`;
      node.style.width = `${to}px`;
      shown = to;
      clearTimeout(timer);
      timer = setTimeout(settle, SETTLE_AFTER_MS);
    };
    // The content may have changed again while the width was easing; that
    // change continues from where the last one ended rather than snapping.
    function settle() {
      clearTimeout(timer);
      const target = shown;
      node!.style.width = "";
      node!.style.transition = "";
      const natural = node!.getBoundingClientRect().width;
      shownText = node!.textContent?.trim() ?? "";
      animating = false;
      if (Math.abs(natural - target) >= 0.5 && !reduced()) animate(target, natural);
      else shown = natural;
    }

    const observer = new ResizeObserver(() => {
      if (animating) return;
      const next = node.getBoundingClientRect().width;
      const firstText = !shownText;
      shownText = node.textContent?.trim() ?? "";
      // A change nobody can see, such as a label filled in while hidden, takes effect at once.
      if (Math.abs(next - shown) < 0.5 || shown === 0 || next === 0 || firstText || reduced() || !node.checkVisibility({ visibilityProperty: true })) { shown = next; return; }
      animate(shown, next);
    });
    const onEnd = (event: TransitionEvent) => { if (event.target === node && event.propertyName === "width") settle(); };
    node.addEventListener("transitionend", onEnd);
    observer.observe(node);
    return () => {
      observer.disconnect();
      node.removeEventListener("transitionend", onEnd);
      clearTimeout(timer);
      node.style.width = "";
      node.style.transition = "";
    };
  }, [ref, enabled]);
}
