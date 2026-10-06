import { test as base, expect, type Page } from "@playwright/test";
import { openWorkspace } from "../helpers/workspace-entry";
import { startStandaloneServer } from "../helpers/standalone-server";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

async function open(page: Page, origin: string, path: string) {
  await openWorkspace(page, origin);
  await page.goto(origin + path);
  expect(page.viewportSize()!.width, "this test needs the desktop conversation rail").toBeGreaterThanOrEqual(1280);
  await expect(page.locator(".workspace-topbar:visible")).toHaveCount(1);
  await expect(page.locator("main")).toBeVisible();
}

test("the top row starts at the window edge and owns its content row", { tag: "@integration" }, async ({ page, app }) => {
  await open(page, app.origin, "/storage");
  const geometry = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".workspace-shell")!;
    const rail = document.querySelector<HTMLElement>(".workspace-rail")!;
    const bar = [...document.querySelectorAll<HTMLElement>(".workspace-topbar")].find(node => node.getClientRects().length > 0)!;
    const content = document.querySelector<HTMLElement>(".workspace-content")!;
    return {
      rootPaddingTop: getComputedStyle(root).paddingTop,
      rootTop: root.getBoundingClientRect().top,
      railTop: rail.getBoundingClientRect().top,
      railPaddingTop: getComputedStyle(rail).paddingTop,
      barTop: bar.getBoundingClientRect().top,
      barHeight: bar.getBoundingClientRect().height,
      barBottom: bar.getBoundingClientRect().bottom,
      barBackground: getComputedStyle(bar).backgroundColor,
      rootBackground: getComputedStyle(root).backgroundColor,
      contentTop: content.getBoundingClientRect().top,
      contentBottom: content.getBoundingClientRect().bottom,
      viewportHeight: innerHeight,
    };
  });
  expect(geometry.rootPaddingTop).toBe("0px");
  expect(geometry.rootTop).toBe(0);
  expect(geometry.railTop).toBe(0);
  expect(geometry.railPaddingTop).toBe("0px");
  expect(geometry.barTop).toBe(0);
  expect(geometry.barHeight).toBe(44);
  expect(geometry.contentTop).toBe(geometry.barBottom);
  expect(geometry.contentBottom).toBe(geometry.viewportHeight);
  expect(geometry.barBackground).toBe(geometry.rootBackground);
});

test("the conversation rail stays below the title row and tasks have their own page", { tag: "@integration" }, async ({ page, app }) => {
  await open(page, app.origin, "/chat");
  const rail = page.getByRole("complementary", { name: "会话列表", exact: true });
  await expect(rail).toBeVisible();
  await expect(page.locator(".chat-rail-right")).toHaveCount(0);
  const geometry = await page.evaluate(() => {
    const bar = [...document.querySelectorAll<HTMLElement>(".workspace-topbar")].find(node => node.getClientRects().length > 0)!;
    const rail = document.querySelector<HTMLElement>(".chat-rail-left")!;
    return { barBottom: bar.getBoundingClientRect().bottom, railTop: rail.getBoundingClientRect().top, railBottom: rail.getBoundingClientRect().bottom, viewportHeight: innerHeight };
  });
  expect(geometry.railTop).toBe(geometry.barBottom);
  expect(geometry.railBottom).toBe(geometry.viewportHeight);
  await page.getByRole("button", { name: "收起会话列表", exact: true }).click();
  await expect(rail).toHaveCSS("width", "40px");
  expect((await rail.boundingBox())!.y).toBe(geometry.barBottom);
  await page.getByRole("button", { name: "展开会话列表", exact: true }).click();
  await expect(rail).toHaveCSS("width", "232px");
  expect((await rail.boundingBox())!.y).toBe(geometry.barBottom);
  await page.getByRole("link", { name: "定时任务", exact: true }).click();
  await expect(page).toHaveURL(app.origin + "/tasks");
  await expect(page.getByTestId("task-panel")).toBeVisible();
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
