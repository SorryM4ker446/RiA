import { expect, test as base, type Page } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { browserApi } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";
import { toasts } from "../helpers/toast";

/*
 * Notes after an action, as the user meets them: in the bottom-right corner,
 * stacked newest at the bottom, paused while pointed at, closable by hand, and
 * kept above the chat composer instead of covering it.
 */
type App = Awaited<ReturnType<typeof startStandaloneServer>>;
const test = base.extend<{ app: App }>({ app: async ({}, provide) => {
  const runtime = await startStandaloneServer({ modelFixture: true });
  try { await provide(runtime); } finally { await runtime.close(); }
} });

async function chat(page: Page, app: App, title: string) {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const created = (await browserApi(page, "/api/conversations", "POST", { title })).body.data;
  await page.goto(`${app.origin}/chat?conversationId=${created.id}`);
  await expect(page.locator(".composer-surface")).toBeVisible();
}
/** Changes the conversation's approval rule from the composer, which confirms with a note. */
async function chooseRule(page: Page, rule: string) {
  await page.locator(".composer-surface").getByRole("button", { name: /^审批规则：/ }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${rule}${rule === "自动" ? "(?!接受)" : ""}`) }).click();
  await expect(toasts(page).locator('.toast:not([data-state="leaving"])').last()).toContainText(`审批规则已改为“${rule}”`);
}
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));

test("notes stack in the bottom-right corner above the composer, newest at the bottom, at most three", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await chat(page, app, "通知位置");
  for (const rule of ["自动接受编辑", "自动", "完全访问", "询问"]) await chooseRule(page, rule);
  const notes = toasts(page).locator('.toast:not([data-state="leaving"])');
  await expect(notes).toHaveCount(3);
  await expect(notes.last()).toContainText("审批规则已改为“询问”");
  await expect(notes.first()).toContainText("审批规则已改为“自动”");
  await settled(page);
  // Each sits above the next, right-aligned 20px from the edge, all above the composer.
  const composer = (await page.locator(".composer-surface").boundingBox())!;
  const boxes = await Promise.all((await notes.all()).map(note => note.boundingBox()));
  await expect.poll(async () => {
    const now = await Promise.all((await notes.all()).map(note => note.boundingBox()));
    return now.every(box => box && Math.abs(1280 - (box.x + box.width) - 20) <= 1 && box.y + box.height <= composer.y)
      && now.every((box, index) => index === 0 || box!.y >= now[index - 1]!.y + now[index - 1]!.height);
  }).toBe(true);
  expect(boxes.length).toBe(3);
});

test("pointing at a note keeps it, it can be closed by hand, and it then goes on its own", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await chat(page, app, "通知停留");
  await chooseRule(page, "完全访问");
  const note = toasts(page).locator(".toast").last();
  await expect(note).toContainText("审批规则已改为“完全访问”");
  // Clicks go through it to whatever is beneath; pointing at it still keeps it.
  await expect(note).toHaveCSS("pointer-events", "none");
  await note.hover({ force: true });
  await page.waitForTimeout(6_000);
  await expect(note).toBeVisible();
  await expect(note.getByRole("button", { name: "关闭通知", exact: true })).toBeVisible();
  await page.mouse.move(10, 10);
  await expect(toasts(page).locator(".toast")).toHaveCount(0, { timeout: 8_000 });
  await chooseRule(page, "询问");
  const second = toasts(page).locator(".toast").last();
  await second.hover({ force: true });
  await second.getByRole("button", { name: "关闭通知", exact: true }).click();
  await expect(toasts(page).locator(".toast")).toHaveCount(0);
});

test("a note fades and slides in, and leaves without a jump", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await chat(page, app, "通知动效");
  await chooseRule(page, "自动");
  const note = toasts(page).locator(".toast").last();
  // It moves into its place through a transition, rather than appearing there.
  expect(await note.evaluate(element => getComputedStyle(element).transitionProperty)).toMatch(/transform/);
  await expect(note).toHaveAttribute("data-state", "shown");
  await note.hover({ force: true });
  await note.getByRole("button", { name: "关闭通知", exact: true }).click();
  await expect(note).toHaveAttribute("data-state", "leaving");
  await expect(toasts(page).locator(".toast")).toHaveCount(0);
});

test("a failure is marked as one and read out at once", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await chat(page, app, "会归档失败");
  await page.route("**/api/conversations/*", route => route.request().method() === "PATCH" ? route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } } }) : route.fallback());
  await page.getByRole("button", { name: "会话操作：会归档失败", exact: true }).click();
  await page.getByRole("menuitem", { name: "归档", exact: true }).click();
  const note = toasts(page).locator(".toast").last();
  await expect(note).toContainText("没能完成这项操作");
  await expect(note).toHaveAttribute("data-tone", "error");
  await expect(note).toHaveAttribute("role", "alert");
  await expect(note.locator(".toast-icon")).toBeVisible();
});

test("in a narrow window notes run across the bottom, above the composer", async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await chat(page, app, "窄窗口通知");
  await chooseRule(page, "自动");
  const note = toasts(page).locator(".toast").last();
  await expect(note).toBeVisible();
  await settled(page);
  const box = (await note.boundingBox())!;
  const composer = (await page.locator(".composer-surface").boundingBox())!;
  expect(Math.round(box.x)).toBe(16);
  expect(Math.round(box.width)).toBe(390 - 32);
  expect(box.y + box.height).toBeLessThanOrEqual(composer.y);
});
