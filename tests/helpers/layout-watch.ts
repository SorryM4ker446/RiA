import { expect, type Locator, type Page } from "@playwright/test";

/** A painted box, rounded to whole pixels. */
export type Box = { top: number; left: number; width: number; height: number };
export type LayoutRecord = {
  /** The box of each watched element in every painted frame it was visible in. */
  frames: Record<string, Box[]>;
  /** Layout shifts the browser reported, including ones right after input. */
  shifts: { value: number; nodes: string[]; allowed: boolean }[];
};
export type LayoutWatch = { read(): Promise<LayoutRecord> };

type WatchState = LayoutRecord & { stop?: () => void };
type WatchWindow = Window & { __layoutWatches?: Record<string, WatchState> };
let nextWatch = 0;

/**
 * Follows elements frame by frame from now on, and records every layout shift
 * the browser reports — including the ones within 500ms of input, which the
 * browser's own score leaves out but a user still sees.
 *
 * Each target is a selector or a locator; an element counts only while it is
 * visible. Boxes are read just after a frame is painted: inside
 * requestAnimationFrame the layout is read before ResizeObserver callbacks have
 * applied that frame's sizes. Shifts of nodes inside `allowShiftsIn` (the
 * interaction's own target, say) are marked allowed rather than dropped, so a
 * failure can still show them.
 */
export async function watchLayout(page: Page, targets: Record<string, string | Locator>, { allowShiftsIn = [] as string[] } = {}): Promise<LayoutWatch> {
  const id = `watch-${++nextWatch}`;
  const selectors: Record<string, string> = {};
  for (const [name, target] of Object.entries(targets)) {
    if (typeof target === "string") { selectors[name] = target; continue; }
    const attribute = `data-layout-watch-${id}-${name}`;
    await target.evaluate((element, attribute) => element.setAttribute(attribute, ""), attribute);
    selectors[name] = `[${attribute}]`;
  }
  await page.evaluate(({ id, selectors, allowShiftsIn }) => {
    const state: WatchState = { frames: Object.fromEntries(Object.keys(selectors).map(name => [name, []])), shifts: [] };
    const watches = ((window as WatchWindow).__layoutWatches ??= {});
    watches[id] = state;
    const name = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`;
    // The node, two of its ancestors and its text: enough to find it in the page.
    const describe = (node: Node | null) => {
      if (!(node instanceof Element)) return String(node?.nodeName ?? "?");
      const path = [node, node.parentElement, node.parentElement?.parentElement].filter((element): element is Element => !!element).map(name).reverse().join(" > ");
      return `${path} "${(node.textContent ?? "").trim().slice(0, 30)}"`;
    };
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; sources?: { node: Node | null }[] })[]) {
        const nodes = (entry.sources ?? []).map(source => source.node);
        const allowed = nodes.length > 0 && nodes.every(node => node instanceof Element && allowShiftsIn.some(selector => node.closest(selector)));
        state.shifts.push({ value: entry.value, nodes: nodes.map(describe), allowed });
      }
    });
    observer.observe({ type: "layout-shift", buffered: false });
    let running = true;
    const sample = () => setTimeout(() => {
      if (!running) return;
      for (const [name, selector] of Object.entries(selectors)) {
        const element = document.querySelector(selector);
        if (!element || getComputedStyle(element).visibility !== "visible") continue;
        const box = element.getBoundingClientRect();
        state.frames[name].push({ top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) });
      }
      requestAnimationFrame(sample);
    }, 0);
    requestAnimationFrame(sample);
    state.stop = () => { running = false; observer.disconnect(); };
  }, { id, selectors, allowShiftsIn });
  return {
    async read() {
      // Two more painted frames, so the state the test just waited for is in the record.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
      return page.evaluate(id => {
        const state = (window as WatchWindow).__layoutWatches![id];
        return { frames: state.frames, shifts: state.shifts };
      }, id);
    },
  };
}

const edges = (boxes: Box[], edge: keyof Box | "box") => boxes.map(box => edge === "box" ? `${box.left},${box.top} ${box.width}x${box.height}` : box[edge]);

/** The element was painted, and in the same place (or box) in every frame. */
export function expectSteady(record: LayoutRecord, name: string, edge: keyof Box | "box" = "box") {
  const values = edges(record.frames[name], edge);
  expect(values.length, `${name} was never painted`).toBeGreaterThan(0);
  expect(new Set(values).size, `${name} ${edge}: ${values.join(" | ")}`).toBe(1);
}

/** No reported layout shift moved anything outside the interaction's own target. */
export function expectNoUnexpectedShift(record: LayoutRecord) {
  const unexpected = record.shifts.filter(shift => !shift.allowed);
  expect(unexpected, JSON.stringify(unexpected)).toEqual([]);
}

/**
 * The element moved by at least `atLeast` pixels along the edge, and did so
 * smoothly: over several frames with no single step above `maxStep` of the
 * whole move, or in a single frame when motion is reduced.
 */
export function expectEased(record: LayoutRecord, name: string, edge: keyof Box, { atLeast, reducedMotion = false, maxStep = 0.6 }: { atLeast: number; reducedMotion?: boolean; maxStep?: number }) {
  const values = edges(record.frames[name], edge) as number[];
  const steps = values.slice(1).map((value, index) => Math.abs(value - values[index])).filter(step => step > 0);
  const total = Math.abs(values.at(-1)! - values[0]);
  expect(total, `${name} ${edge}: ${values.join(",")}`).toBeGreaterThanOrEqual(atLeast);
  if (reducedMotion) expect(steps, `${name} ${edge}: ${values.join(",")}`).toHaveLength(1);
  else {
    expect(steps.length, `${name} ${edge}: ${values.join(",")}`).toBeGreaterThan(3);
    expect(Math.max(...steps), `${name} ${edge}: ${values.join(",")}`).toBeLessThan(total * maxStep);
  }
}
