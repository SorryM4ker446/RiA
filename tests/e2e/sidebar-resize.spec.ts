import { expect, test, type Page } from "@playwright/test";

const rail = (page: Page) => page.locator(".workspace-rail-docked");
const peek = (page: Page) => page.locator(".rail-peek");
const handle = (page: Page) => page.getByRole("separator", { name: "调整侧边栏宽度", exact: true });
// Folded: the corner button. Shown over the page, the sidebar's own pin button. Docked: its fold button.
const pin = (page: Page) => page.getByRole("button", { name: "展开侧边栏", exact: true });
const peekPin = (page: Page) => peek(page).getByRole("button", { name: "固定侧边栏", exact: true });
const fold = (page: Page) => page.getByRole("button", { name: "收起侧边栏", exact: true });
// Every sidebar motion runs on one 240ms curve; wait it out before measuring where things settle.
const settled = (page: Page) => page.waitForTimeout(320);
const width = async (page: Page) => Math.round((await rail(page).boundingBox())?.width ?? 0);

async function drag(page: Page, to: number, check?: () => Promise<void>) {
  const box = (await handle(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(to, box.y + 200, { steps: 12 });
  await check?.();
  await page.mouse.up();
  await settled(page);
}

test("the sidebar follows its dragged edge, gives below its minimum and folds away past it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/chat");
  await expect(rail(page)).toBeVisible();
  expect(await width(page)).toBe(208);
  await expect(fold(page)).toBeVisible();
  await expect(pin(page)).toBeHidden();

  // It follows the pointer directly while dragged, with no lag from a transition.
  await drag(page, 300, async () => {
    await expect(page.locator("html")).toHaveAttribute("data-rail-dragging", "");
    expect(await rail(page).evaluate(node => getComputedStyle(node).transitionProperty)).not.toMatch(/\bwidth\b|\ball\b/);
    expect(await width(page)).toBe(300);
  });
  expect(await width(page)).toBe(300);
  // Remembered and applied before the first paint, so a reload does not move it.
  await page.reload();
  await expect(rail(page)).toBeVisible();
  expect(await width(page)).toBe(300);

  // Below the minimum it gives a little, then settles back to the minimum.
  await drag(page, 150, async () => {
    const giving = await width(page);
    expect(giving).toBeGreaterThan(150);
    expect(giving).toBeLessThan(176);
  });
  expect(await width(page)).toBe(176);

  // Past the threshold it folds away; the page title moves over to clear the button.
  await drag(page, 60);
  expect(await width(page)).toBe(0);
  await expect(pin(page)).toBeVisible();
  await expect(handle(page)).toBeHidden();
  const button = (await pin(page).boundingBox())!;
  const title = (await page.locator(".workspace-section-title").boundingBox())!;
  expect(title.x).toBeGreaterThan(button.x + button.width);
  await page.reload();
  expect(await width(page)).toBe(0);

  // Pinned back at the width it had; double-click restores the default; the keyboard moves it in steps.
  await pin(page).click();
  await settled(page);
  expect(await width(page)).toBe(176);
  await handle(page).dblclick();
  await settled(page);
  expect(await width(page)).toBe(208);
  await handle(page).focus();
  await page.keyboard.press("ArrowRight");
  await settled(page);
  expect(await width(page)).toBe(224);
  await expect(handle(page)).toHaveAttribute("aria-valuenow", "224");
});

test("folded, the sidebar shows over the page on hover and pins in place without anything moving", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("ria.sidebar", JSON.stringify({ width: 240, collapsed: true })));
  await page.reload();
  expect(await width(page)).toBe(0);
  const corner = (await pin(page).boundingBox())!;

  // Pointing at the button slides it out over the page, and it can be used.
  await pin(page).hover();
  await expect(peek(page)).toHaveAttribute("data-state", "open");
  await settled(page);
  const over = (await peek(page).boundingBox())!;
  expect(Math.round(over.x)).toBe(0);
  expect(Math.round(over.width)).toBe(240);
  expect(await width(page)).toBe(0);
  await peek(page).getByRole("link", { name: "知识库", exact: true }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(peek(page)).toHaveAttribute("data-state", "open");
  // Leaving it lets it slide back; Escape closes it at once.
  await page.mouse.move(900, 500);
  await expect(peek(page)).toHaveCount(0);
  await pin(page).hover();
  await expect(peek(page)).toHaveAttribute("data-state", "open");
  await page.keyboard.press("Escape");
  await expect(peek(page)).toHaveCount(0);

  // Pinned from there, the overlay holds still while the docked sidebar opens beneath it, then gives way to it.
  await page.mouse.move(900, 500);
  await pin(page).hover();
  await expect(peek(page)).toHaveAttribute("data-state", "open");
  await settled(page);
  const pinAt = (await peekPin(page).boundingBox())!;
  await peekPin(page).click();
  await expect(peek(page)).toHaveAttribute("data-state", "pinning");
  expect(await peek(page).boundingBox()).toEqual(over);
  // Removed outright, no slide: the docked sidebar is already in its place.
  await expect(peek(page)).toHaveCount(0);
  await settled(page);
  expect(await width(page)).toBe(240);
  // The docked sidebar's button is where the pin button was: the swap shows nothing.
  expect(await fold(page).boundingBox()).toEqual(pinAt);

  // Folded again, it does not spring back over the page, and the corner button is where it was.
  await fold(page).click();
  await page.waitForTimeout(400);
  await expect(peek(page)).toHaveCount(0);
  expect(await width(page)).toBe(0);
  expect(await pin(page).boundingBox()).toEqual(corner);
  // The button lies over the desktop window's drag band and opts out of it.
  expect(await pin(page).evaluate(node => getComputedStyle(node).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
});

test("a narrow window starts folded, can be pinned for now, and folds again when it narrows next time", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/chat");
  expect(await width(page)).toBe(208);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(pin(page)).toBeVisible();
  await settled(page);
  expect(await width(page)).toBe(0);
  await pin(page).click();
  await settled(page);
  expect(await width(page)).toBe(208);
  // Wider again it follows the saved choice; narrowing again folds it.
  await page.setViewportSize({ width: 1280, height: 800 });
  await settled(page);
  expect(await width(page)).toBe(208);
  await page.setViewportSize({ width: 900, height: 800 });
  await settled(page);
  expect(await width(page)).toBe(0);
  // A narrow window opens folded, whatever was saved for wide ones.
  await page.reload();
  expect(await width(page)).toBe(0);
});

// The desktop window reads `-webkit-app-region` in document order: a drag region
// that comes later claims the clicks of a control it overlaps. The browser has no
// drag regions, so this checks the order that the desktop window relies on.
async function laterDragRegions(page: Page, selector: string) {
  return page.evaluate(target => {
    for (const plain of document.querySelectorAll(".desktop-titlebar-plain")) plain.classList.remove("desktop-titlebar-plain");
    const control = document.querySelector(target)!;
    const box = control.getBoundingClientRect();
    return [...document.querySelectorAll("*")]
      .filter(node => getComputedStyle(node).getPropertyValue("-webkit-app-region") === "drag")
      .filter(node => { const area = node.getBoundingClientRect(); return area.left < box.right && area.right > box.left && area.top < box.bottom && area.bottom > box.top; })
      .filter(node => !node.contains(control) && control.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      .map(node => node.className);
  }, selector);
}

test("controls lying over the window's drag band come after it, so the desktop window lets them be used", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/chat");
  expect(await laterDragRegions(page, ".workspace-rail-docked .rail-header-button")).toEqual([]);
  expect(await laterDragRegions(page, ".rail-resizer-handle")).toEqual([]);
  await fold(page).click();
  await page.mouse.move(900, 500);
  await settled(page);
  expect(await laterDragRegions(page, ".rail-toggle")).toEqual([]);
  await pin(page).hover();
  await expect(peek(page)).toHaveAttribute("data-state", "open");
  expect(await laterDragRegions(page, ".rail-peek .rail-header-button")).toEqual([]);
  // Shown over the page it is all page: nothing in it drags the window.
  expect(await peek(page).evaluate(node => [node, ...node.querySelectorAll("*")].filter(item => getComputedStyle(item).getPropertyValue("-webkit-app-region") === "drag").map(item => item.className))).toEqual([]);
  expect(await peek(page).evaluate(node => getComputedStyle(node).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
  expect(await laterDragRegions(page, ".rail-peek .workspace-brand")).toEqual([]);
});

test("shown over the page, the sidebar stays while the pointer is anywhere on it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("ria.sidebar", JSON.stringify({ width: 240, collapsed: true })));
  await page.reload();
  const corner = (await pin(page).boundingBox())!;
  // The pointer rests on the corner button while the sidebar slides in under it.
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await expect(peek(page)).toHaveAttribute("data-state", "open");
  await page.waitForTimeout(700);
  await expect(peek(page)).toHaveAttribute("data-state", "open");
  // Along the top row to the pin button, slowly, then down through the list.
  const target = (await peekPin(page).boundingBox())!;
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await page.waitForTimeout(400);
  await expect(peek(page)).toHaveAttribute("data-state", "open");
  await page.mouse.move(120, 600, { steps: 20 });
  await page.waitForTimeout(400);
  await expect(peek(page)).toHaveAttribute("data-state", "open");
  // A brief stray past the edge is forgiven; staying out lets it go.
  await page.mouse.move(300, 600);
  await page.waitForTimeout(80);
  await page.mouse.move(200, 600);
  await page.waitForTimeout(400);
  await expect(peek(page)).toHaveAttribute("data-state", "open");
  await page.mouse.move(600, 600);
  await expect(peek(page)).toHaveCount(0);
});
