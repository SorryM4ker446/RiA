import { test as base, expect, type Page } from "@playwright/test";
import { openWorkspace } from "../helpers/workspace-entry";
import { startStandaloneServer } from "../helpers/standalone-server";
import { configureOfflineModels } from "../helpers/model-fixture";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

const frames = (page: Page, count: number) => page.evaluate(count => new Promise<void>(resolve => {
  const step = (left: number) => left ? requestAnimationFrame(() => step(left - 1)) : resolve();
  step(count);
}), count);

test("the tool menu scrolls only when asked, and a tool's fields leave the composer where it was", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const composer = page.locator("form").filter({ has: page.locator(".composer-surface") });
  const surface = composer.locator(".composer-surface");
  const place = async () => { const box = (await surface.boundingBox())!; return { y: box.y, height: box.height }; };
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
  const before = await place();

  // A short window makes the list overflow. Reaching its last visible row does
  // not start it scrolling (Radix's hover arrows did); the wheel still does.
  await page.setViewportSize({ width: 1280, height: 560 });
  const tools = page.getByRole("combobox", { name: "选择工具", exact: true });
  await tools.click();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await expect(list.getByRole("option", { name: "自动工具", exact: true })).toHaveAccessibleDescription("由模型按需调用工具。");
  await expect(list.getByRole("option", { name: "创建任务", exact: true })).toHaveAccessibleDescription("记下一件待办，可加详情、优先级和截止时间。");
  const viewport = list.locator("[data-radix-select-viewport]");
  expect(await viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 3);
  await frames(page, 12);
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(0);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();

  // The fields sit inside the composer, which keeps its place and its height.
  await page.setViewportSize({ width: 1280, height: 720 });
  await tools.click();
  await page.getByRole("option", { name: "创建任务", exact: true }).click();
  await expect(page.getByPlaceholder(/输入任务标题/)).toBeVisible();
  await expect(composer.getByRole("combobox", { name: "优先级", exact: true })).toContainText("中");
  expect(await place()).toEqual(before);
  await tools.click();
  await page.getByRole("option", { name: "自动工具", exact: true }).click();
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
  expect(await place()).toEqual(before);
  // The document tools put a document picker where the text area was, at its height.
  for (const name of ["读取文档", "转换并导出文档"]) {
    await tools.click();
    await page.getByRole("option", { name, exact: true }).click();
    await expect(composer.getByRole("combobox", { name: "知识库文档", exact: true })).toBeVisible();
    // Converting asks which format, beside the document; reading has no other choice.
    await expect(composer.getByRole("combobox", { name: "导出格式", exact: true })).toHaveCount(name === "转换并导出文档" ? 1 : 0);
    expect(await place()).toEqual(before);
  }

  // Paging months keeps the calendar on one side of its button: every month
  // has six rows, so its height never changes under the popover.
  await tools.click();
  await page.getByRole("option", { name: "创建任务", exact: true }).click();
  await composer.getByRole("button", { name: "截止时间", exact: true }).click();
  const calendar = page.getByRole("dialog", { name: "截止时间", exact: true });
  await expect(calendar).toBeVisible();
  const side = await calendar.getAttribute("data-side");
  const rows = await calendar.locator("tbody tr, .rdp-week").count();
  for (let month = 0; month < 6; month++) {
    await calendar.locator(".rdp-button_next").click();
    await expect(calendar).toHaveAttribute("data-side", side!);
    expect(await calendar.locator("tbody tr, .rdp-week").count()).toBe(rows);
  }
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});
