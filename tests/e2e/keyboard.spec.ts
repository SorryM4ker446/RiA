import { test as base, expect, type Page } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi } from "../helpers/browser-api";

/**
 * Keyboard use: every stop Tab reaches is on screen, not hidden from
 * assistive technology, and shows where focus is. Run over the main pages.
 */
const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});

type Stop = { name: string; visible: boolean; hiddenFromAssistiveTech: boolean; indicator: boolean };

async function tabThrough(page: Page, count: number): Promise<Stop[]> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    // What focus may change on the element or the few boxes around it.
    (window as unknown as { look: (element: Element) => string }).look = element => {
      // The element and four boxes around it: a row may show the ring for the control inside it.
      const boxes: Element[] = [];
      for (let box: Element | null = element; box && boxes.length < 5; box = box.parentElement) boxes.push(box);
      return boxes.map(box => { const style = getComputedStyle(box); return [style.outlineStyle, style.outlineColor, style.boxShadow, style.borderTopColor, style.borderTopStyle, style.backgroundColor].join("|"); }).join(" / ");
    };
    (window as unknown as { stops: { element: Element; focused: string }[] }).stops = [];
  });
  const stops: Stop[] = [];
  for (let index = 0; index < count; index++) {
    await page.keyboard.press("Tab");
    // Controls that fade in on focus are judged once they have.
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));
    stops.push(await page.evaluate(() => {
      const state = window as unknown as { look: (element: Element) => string; stops: { element: Element; focused: string }[] };
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return { name: "body", visible: true, hiddenFromAssistiveTech: false, indicator: true };
      state.stops.push({ element, focused: state.look(element) });
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        name: `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}"`,
        visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden" && Number(style.opacity) > 0.05,
        hiddenFromAssistiveTech: !!element.closest("[aria-hidden='true']"),
        indicator: true,
      };
    }));
  }
  // Focus leaves, and each stop is looked at again: something must have looked different while it was focused.
  const changed = await page.evaluate(() => {
    const state = window as unknown as { look: (element: Element) => string; stops: { element: Element; focused: string }[] };
    (document.activeElement as HTMLElement | null)?.blur();
    return state.stops.map(stop => stop.focused !== state.look(stop.element));
  });
  let next = 0;
  return stops.map(stop => stop.name === "body" ? stop : { ...stop, indicator: changed[next++] });
}

for (const path of ["/chat", "/tasks", "/conversations", "/knowledge", "/media", "/assistants"]) {
  test(`every Tab stop on ${path} is visible, reachable by assistive technology and shows focus`, async ({ page, app }) => {
    await openWorkspace(page, app.origin);
    await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
    await browserApi(page, "/api/conversations", "POST", { title: "键盘检查" });
    await browserApi(page, "/api/tasks", "POST", { title: "键盘任务", priority: "medium", timeZone: "UTC", reminderEnabled: false, repeatRule: "none" });
    await page.goto(`${app.origin}${path}`);
    await expect(page.locator("main")).toBeVisible();
    await page.waitForTimeout(500);
    const stops = await tabThrough(page, 30);
    const problems = stops.filter(stop => !stop.visible || stop.hiddenFromAssistiveTech || !stop.indicator);
    expect(problems, JSON.stringify(problems, null, 1)).toEqual([]);
  });
}
