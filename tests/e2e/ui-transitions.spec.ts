import { expect, test } from "@playwright/test";

test("the first launch is dark and the wordmark stays readable across saved themes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/dark/);
  const wordmark = page.locator(".workspace-brand-wordmark");
  await expect(wordmark).toHaveText("RiA");
  await expect(page.locator(".workspace-brand img")).toHaveCount(0);
  const darkColor = await wordmark.evaluate(node => getComputedStyle(node).color);
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(wordmark).toHaveCSS("color", "rgb(23, 23, 23)");
  expect(darkColor).not.toBe("rgb(23, 23, 23)");
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(wordmark).toHaveText("RiA");
});

test("desktop settings hydrate before exposing controls supplied by preload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "privateAiDesktop", { value: {
      getSettings: async () => { throw new Error("Settings bridge unavailable in renderer fixture"); },
      getRuntimeInfo: async () => { throw new Error("Runtime bridge unavailable in renderer fixture"); },
    } });
  });
  await page.goto("/settings");
  await page.getByRole("tab", { name: "应用偏好", exact: true }).click();
  await expect(page.getByRole("heading", { name: "关闭窗口时", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "全局快捷键", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("navigation sheets animate in both directions and return keyboard focus", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 780 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "打开导航" });
  await trigger.click();
  const navigation = page.getByRole("dialog", { name: "工作区导航" });
  await expect(navigation).toBeVisible();
  await expect(navigation).toHaveCSS("animation-name", "sheet-in");
  await page.keyboard.press("Shift+Tab");
  expect(await navigation.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  await trigger.click();
  await navigation.getByRole("link", { name: "知识库", exact: true }).click();
  await expect(page).toHaveURL(/\/knowledge$/);
  await expect(navigation).toBeHidden();
  await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");
  await expect(page.locator("main h1")).toContainText("知识库");
  expect(errors).toEqual([]);
});

test("reduced motion keeps navigation and model tabs usable without animations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "打开导航" }).click();
  const navigation = page.getByRole("dialog", { name: "工作区导航" });
  await expect(navigation).toHaveCSS("animation-name", "none");
  await navigation.getByRole("link", { name: "模型与用量", exact: true }).click();
  await expect(navigation).toBeHidden();
  const imageTab = page.getByRole("tab", { name: "图片生成", exact: true });
  await imageTab.click();
  await expect(imageTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "视频生成", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
  await expect(page.getByRole("tabpanel")).toHaveCSS("animation-name", "none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
