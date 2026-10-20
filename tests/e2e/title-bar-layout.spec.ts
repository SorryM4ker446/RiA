import { test as base, expect, type Page } from "@playwright/test";
import { openWorkspace } from "../helpers/workspace-entry";
import { startStandaloneServer } from "../helpers/standalone-server";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      mainBackground: getComputedStyle(document.querySelector(".workspace-main")!).backgroundColor,
      contentBackground: getComputedStyle(content).backgroundColor,
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
  expect(geometry.barBackground).toBe("rgba(0, 0, 0, 0)");
  expect(geometry.mainBackground).toBe(geometry.contentBackground);
  expect(geometry.mainBackground).toBe(geometry.rootBackground);
});

test("recent conversations open over the canvas without reserving a sidebar", { tag: "@integration" }, async ({ page, app }) => {
  await open(page, app.origin, "/chat");
  const trigger = page.getByRole("button", { name: "会话列表", exact: true });
  const list = page.getByRole("complementary", { name: "会话列表", exact: true });
  await expect(list).toHaveCount(0);
  const before = await page.locator(".chat-canvas").boundingBox();
  await trigger.click();
  await expect(list).toBeVisible();
  expect(await page.locator(".chat-canvas").boundingBox()).toEqual(before);
  const box = await list.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(44);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(trigger).toBeFocused();
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

for (const locale of ["zh-CN", "en-US"] as const) {
  test(`navigation labels remain fully visible on desktop and in the drawer in ${locale}`, async ({ page, app }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript(value => localStorage.setItem("ui:locale", value), locale);
    await openWorkspace(page, app.origin);
    await page.goto(`${app.origin}/conversations`);
    await expect(page).toHaveTitle("RiA");
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const english = locale === "en-US";
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 860 });
      if (width < 1024) await page.getByRole("button", { name: english ? "Open navigation" : "打开导航", exact: true }).click();
      const nav = page.getByRole("navigation", { name: english ? "Workspace navigation" : "工作区导航", exact: true });
      await expect(nav).toBeVisible();
      const conversations = nav.getByRole("link", { name: english ? "Manage conversations" : "管理会话", exact: true });
      await expect(conversations).toHaveAttribute("aria-current", "page");
      const labels = await nav.locator(".workspace-nav-link span").evaluateAll(nodes => nodes.map(node => {
        const label = node as HTMLElement;
        const box = label.getBoundingClientRect();
        const link = label.closest("a")!.getBoundingClientRect();
        return { text: label.textContent, clippedX: label.scrollWidth > label.clientWidth + 1, clippedY: label.scrollHeight > label.clientHeight + 1, outside: box.left < link.left - 1 || box.right > link.right + 1 || box.top < link.top - 1 || box.bottom > link.bottom + 1 };
      }));
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.filter(label => label.clippedX || label.clippedY || label.outside), `clipped navigation at ${width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator(".workspace-rail:visible").screenshot({ path: join(tmpdir(), `ria-navigation-${locale}-${width}.png`) });
      if (width < 1024) {
        await nav.getByRole("link", { name: english ? "Knowledge" : "知识库", exact: true }).click();
        await expect(page).toHaveURL(`${app.origin}/knowledge`);
        await expect(nav).toBeHidden();
      }
    }
    expect(errors).toEqual([]);
  });
}
