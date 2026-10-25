/**
 * Removing items from a list without the rest of the page jumping.
 *
 * In a stacked list the item collapses in place — height, padding, margins and
 * its share of the list's spacing go to zero while it fades — so the items after
 * it move up into its place. In a grid of several columns it fades out, and the
 * cards that follow then slide from where they were to where they end up. Only
 * after the item has gone is `commit` run, whether it filters the list locally
 * or reloads it. Marking items with `data-removal-key` is all a list needs. An
 * item still there once `commit` settles, for example because the removal
 * failed, is shown again.
 */
// A row leaving takes the list-change duration (--dur-base) and eases in and
// out (--ease-in-out): the content below starts moving gently instead of
// lurching in the first frame, as a strongly decelerating curve would make it.
// Read from the motion tokens when the removal runs, since the Web Animations
// API takes numbers rather than CSS variables.
function token(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
function removalTiming() {
  const duration = token("--dur-base", "240ms");
  return { duration: duration.endsWith("ms") ? parseFloat(duration) : parseFloat(duration) * 1000, easing: token("--ease-in-out", "") || undefined };
}

export function removalKey(key: string) {
  return { "data-removal-key": key };
}

function findItem(key: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-removal-key="${CSS.escape(key)}"]`);
}

/** A grid placing items side by side, where collapsing one does not close its gap. */
function inColumns(item: HTMLElement) {
  const layout = item.parentElement ? getComputedStyle(item.parentElement) : null;
  return Boolean(layout?.display.includes("grid") && layout.gridTemplateColumns.trim().split(/\s+/).length > 1);
}

/** The spacing that disappears along with the item, so the end state matches the list without it. */
function collapsedMargins(item: HTMLElement) {
  const layout = item.parentElement ? getComputedStyle(item.parentElement) : null;
  const stacked = layout && (layout.display.includes("grid") || (layout.display.includes("flex") && layout.flexDirection.startsWith("column")));
  const gap = stacked ? parseFloat(layout.rowGap) || 0 : 0;
  const previous = item.previousElementSibling, next = item.nextElementSibling;
  let top = 0, bottom = 0;
  if (gap) { if (next) bottom -= gap; else if (previous) top -= gap; }
  // Stacked spacing (`space-y`) sits on the following item; it goes when this one was first.
  if (!previous && next instanceof HTMLElement) bottom -= parseFloat(getComputedStyle(next).marginTop) || 0;
  return { top, bottom };
}

function collapse(item: HTMLElement): Animation {
  const style = getComputedStyle(item);
  const margins = collapsedMargins(item);
  return item.animate([
    { height: `${item.offsetHeight}px`, opacity: 1, transform: "scale(1)",
      marginTop: style.marginTop, marginBottom: style.marginBottom,
      paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, borderTopWidth: style.borderTopWidth, borderBottomWidth: style.borderBottomWidth },
    { opacity: 0, transform: "scale(0.98)", offset: 0.45 },
    { height: "0px", opacity: 0, transform: "scale(0.98)",
      marginTop: `${margins.top}px`, marginBottom: `${margins.bottom}px`,
      paddingTop: "0px", paddingBottom: "0px", borderTopWidth: "0px", borderBottomWidth: "0px" },
  ], { ...removalTiming(), fill: "forwards" });
}

function fadeOut(item: HTMLElement): Animation {
  return item.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.95)" }],
    { duration: removalTiming().duration * 0.75, easing: removalTiming().easing, fill: "forwards" });
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** Removes every listed item together, then commits once. */
export async function animateRemoval(keys: string | string[], commit: () => unknown): Promise<void> {
  const items = (Array.isArray(keys) ? keys : [keys]).map(findItem).filter((item): item is HTMLElement => item !== null);
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!items.length || reduced || typeof items[0].animate !== "function") { await commit(); return; }
  // Cards beside and after the removed ones, with where they are before the removal.
  const removed = new Set(items);
  const neighbours = [...new Set(items.filter(inColumns).flatMap(item => [...item.parentElement!.children] as HTMLElement[]))]
    .filter(item => !removed.has(item)).map(item => ({ item, before: item.getBoundingClientRect() }));
  const running = items.map(item => {
    item.style.overflow = "hidden";
    item.style.pointerEvents = "none";
    return { item, animation: inColumns(item) ? fadeOut(item) : collapse(item) };
  });
  try {
    await Promise.all(running.map(({ animation }) => animation.finished.catch(() => {})));
    await commit();
    if (neighbours.length) {
      await nextFrame();
      for (const { item, before } of neighbours) {
        if (!item.isConnected) continue;
        const after = item.getBoundingClientRect();
        const dx = before.left - after.left, dy = before.top - after.top;
        if (dx || dy) item.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], removalTiming());
      }
    }
  } finally {
    // An item that is still there was not removed: show it again.
    for (const { item, animation } of running) {
      if (!item.isConnected) continue;
      animation.cancel();
      item.style.overflow = "";
      item.style.pointerEvents = "";
    }
  }
}
