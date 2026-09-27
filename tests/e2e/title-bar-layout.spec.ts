import { test as base, expect } from "@playwright/test";
import { openWorkspace } from "../helpers/workspace-entry";
import { startStandaloneServer } from "../helpers/standalone-server";

/**
 * The top row is part of the interface, not a band painted above it.
 *
 * Two regressions are cheap to reintroduce and invisible in a screenshot taken
 * after the fact: a border or padding that re-creates the band the design
 * removed, and a sticky panel whose offset still assumes the band is there, so
 * its top edge disappears behind the header. Both are geometry, so both are
 * asserted as geometry.
 */

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

async function open(page: import("@playwright/test").Page, origin: string, path: string) {
  await openWorkspace(page, origin);
  await page.goto(`${origin}${path}`);
  // The sticky rails only exist at the `xl` breakpoint; the suite's desktop
  // viewport is 1280px, which is exactly it. Fail loudly rather than silently
  // measuring a stacked layout that has no sticky offset to check.
  expect(page.viewportSize()!.width, "this test needs the xl breakpoint").toBeGreaterThanOrEqual(1280);
}

test("the top row carries no reserved band above the page", { tag: "@integration" }, async ({ page, app }) => {
  await open(page, app.origin, "/storage");

  const geometry = await page.evaluate(() => {
    const root = document.querySelector("div.min-h-screen") as HTMLElement;
    const rail = document.querySelector("nav")?.closest("div.fixed") as HTMLElement;
    const bar = [...document.querySelectorAll<HTMLElement>("div.sticky")].find(node => node.className.includes("h-10") && node.getBoundingClientRect().width > 0)!;
    const barStyle = getComputedStyle(bar);
    return {
      rootPaddingTop: getComputedStyle(root).paddingTop,
      railTop: rail.getBoundingClientRect().top,
      railPaddingTop: getComputedStyle(rail).paddingTop,
      barTop: bar.getBoundingClientRect().top,
      barHeight: bar.getBoundingClientRect().height,
      barBorderBottom: barStyle.borderBottomWidth,
      barBackground: barStyle.backgroundColor,
      pageBackground: getComputedStyle(document.body).backgroundColor,
    };
  });

  // No band: the page starts at the very top of the window.
  expect(geometry.rootPaddingTop, "the page root reserves a band for the title bar").toBe("0px");
  expect(geometry.railTop, "the nav rail no longer reaches the top of the window").toBe(0);
  expect(geometry.railPaddingTop, "the nav rail pads itself away from the title row").toBe("0px");
  expect(geometry.barTop, "the section header is not at the top of the window").toBe(0);
  // The row is 40px so the native caption controls sit inside it rather than
  // over the content.
  expect(geometry.barHeight).toBe(40);
  // A rule under the row is what made it read as a separate strip.
  expect(geometry.barBorderBottom, "a border re-creates the seam under the top row").toBe("0px");
  // The row and the page are one surface, so they must be one colour.
  expect(geometry.barBackground).toBe(geometry.pageBackground);
});

test("sticky side panels clear the top row instead of hiding behind it", { tag: "@integration" }, async ({ page, app }) => {
  await open(page, app.origin, "/chat");

  const geometry = await page.evaluate(() => {
    const bar = [...document.querySelectorAll<HTMLElement>("div.sticky")].find(node => node.className.includes("h-10") && node.getBoundingClientRect().width > 0)!;
    const panels = [...document.querySelectorAll<HTMLElement>("aside")].map(node => {
      const style = getComputedStyle(node);
      return { label: node.getAttribute("aria-label"), position: style.position, top: style.top };
    });
    return { barBottom: bar.getBoundingClientRect().bottom, barHeight: bar.getBoundingClientRect().height, panels };
  });

  expect(geometry.barHeight).toBe(40);
  expect(geometry.panels.length, "expected the conversation and task rails").toBeGreaterThanOrEqual(2);
  for (const panel of geometry.panels) {
    if (panel.position !== "sticky") continue;
    const offset = Number.parseFloat(panel.top);
    // A sticky panel that offsets less than the header's height slides under
    // it, and the first thing the user loses is the panel's own title row.
    expect(offset, `the ${panel.label} rail sticks at ${panel.top}, inside the ${geometry.barHeight}px header`).toBeGreaterThanOrEqual(geometry.barHeight);
  }
});

test("the brand stays clickable inside the drag row", { tag: "@integration" }, async ({ page, app }) => {
  await open(page, app.origin, "/media");
  const brand = page.getByRole("link", { name: "RiA", exact: true }).first();
  await expect(brand).toBeVisible();
  // The top row is a window drag region, and a drag region swallows clicks on
  // whatever sits under it unless that element opts out. Verify the opt-out is
  // present in the stylesheet, since no browser build renders the strip.
  const optedOut = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList; try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule.cssText && /desktop-titlebar-interactive/.test(rule.cssText) && /no-drag/.test(rule.cssText)) return true;
      }
    }
    return false;
  });
  expect(optedOut, "the .desktop-titlebar-interactive no-drag rule is missing").toBe(true);
  await brand.click();
  await expect(page).toHaveURL(`${app.origin}/chat`);
});
