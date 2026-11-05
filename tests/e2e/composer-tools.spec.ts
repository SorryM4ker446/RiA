import { test as base, expect } from "@playwright/test";
import { openWorkspace } from "../helpers/workspace-entry";
import { startStandaloneServer } from "../helpers/standalone-server";
import { configureOfflineModels } from "../helpers/model-fixture";
import { chooseFromSlashMenu, chosenWords, composerInput, slashOption } from "../helpers/slash-menu";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

test("the slash menu offers only what a person can call, by keyboard and mouse, and reopens after Escape", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const input = composerInput(page);
  const list = page.getByRole("listbox", { name: "工具、技能和插件", exact: true });
  await input.click();

  // A slash inside a word or a path is just text.
  await page.keyboard.type("a/b D:/work");
  await expect(list).toBeHidden();
  await input.fill("");

  await page.keyboard.type("/");
  await expect(list).toBeVisible();
  await expect(slashOption(page, "联网搜索")).toBeVisible();
  await expect(slashOption(page, "压缩上下文")).toBeVisible();
  for (const internal of ["执行终端命令", "读取终端日志", "读取项目文件", "编辑项目文件", "读取插件技能", "工具调用"]) await expect(slashOption(page, internal)).toHaveCount(0);
  await expect(input).toBeFocused();

  // Escape keeps the typed slash; a second slash, or typing it again, brings the menu back.
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(input).toHaveValue("/");
  await page.keyboard.type("/");
  await expect(list).toBeVisible();
  await expect(input).toHaveValue("/");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/");
  await expect(list).toBeVisible();

  // Typing narrows; arrows move; Enter chooses and leaves the caret ready to write.
  await page.keyboard.type("检索");
  await expect(page.getByRole("option").first()).toContainText("知识检索");
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
  await expect(input).toHaveValue("");
  await expect(chosenWords(page)).toHaveText(["知识检索"]);
  await expect(input).toBeFocused();
  await page.keyboard.type("周报");
  await expect(input).toHaveValue("周报");

  // The text starts after the chosen word, never under it.
  const word = (await chosenWords(page).boundingBox())!;
  const indent = await input.evaluate(element => parseFloat(getComputedStyle(element).textIndent) + parseFloat(getComputedStyle(element).paddingLeft) + element.getBoundingClientRect().left);
  expect(indent).toBeGreaterThanOrEqual(word.x + word.width);

  // One tool at a time: another replaces it, and Backspace at the start removes it.
  await chooseFromSlashMenu(page, "创建任务");
  await expect(chosenWords(page)).toHaveText(["创建任务"]);
  await expect(input).toHaveValue("周报");
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Backspace");
  await expect(chosenWords(page)).toHaveCount(0);
  await expect(input).toHaveValue("周报");
  expect(errors).toEqual([]);
});

test("choosing a tool leaves the composer where it was, and a document tool's controls replace what it does not use", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.setViewportSize({ width: 1280, height: 720 });
  const surface = page.locator(".composer-surface");
  const place = async () => { const box = (await surface.boundingBox())!; return { y: box.y, height: box.height }; };
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
  const before = await place();
  const model = page.getByRole("combobox", { name: "选择模型", exact: true });
  const mode = page.getByRole("combobox", { name: "聊天模式", exact: true });
  const format = page.getByRole("combobox", { name: "输出格式", exact: true });

  await chooseFromSlashMenu(page, "联网搜索");
  await expect(page.getByPlaceholder("想搜索什么？")).toBeVisible();
  expect(await place()).toEqual(before);

  await chooseFromSlashMenu(page, "转换并导出文档");
  await expect(format).toBeVisible();
  await expect(model).toHaveCount(0);
  await expect(mode).toHaveCount(0);
  expect(await place()).toEqual(before);

  await chooseFromSlashMenu(page, "读取文档");
  await expect(format).toHaveCount(0);
  await expect(model).toBeVisible();
  expect(await place()).toEqual(before);

  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Backspace");
  await expect(mode).toBeVisible();
  expect(await place()).toEqual(before);
});

test("the chosen tool shows on the sent message and is offered first", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await chooseFromSlashMenu(page, "知识检索");
  await composerInput(page).fill("OFFLINE_SEARCH_KNOWLEDGE 发布回滚窗口");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message-choices").getByText("知识检索", { exact: true })).toBeVisible();
  await expect(chosenWords(page)).toHaveCount(0);
  await expect.poll(() => app.providerCalls.length).toBeGreaterThan(1);
  // The model was given the chosen tool and did call it, so no note says otherwise.
  await expect(page.getByText(/没有调用你选择的/)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".message-choices").getByText("知识检索", { exact: true })).toBeVisible();
});

test("the menu keeps its contents while it fades out, so it never shrinks to a sliver above the composer", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await composerInput(page).click();
  await page.keyboard.type("/");
  const menu = page.locator(".slash-menu");
  await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(100);
  const opened = await menu.evaluate(element => element.getBoundingClientRect().height);
  await page.evaluate(() => {
    const heights: number[] = [];
    (window as unknown as { menuHeights: number[] }).menuHeights = heights;
    const sample = () => {
      const element = document.querySelector(".slash-menu");
      if (!element) return;
      heights.push(element.getBoundingClientRect().height);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  const heights = await page.evaluate(() => (window as unknown as { menuHeights: number[] }).menuHeights);
  expect(heights.length).toBeGreaterThan(0);
  // The exit animation scales it slightly; its contents do not collapse.
  expect(Math.min(...heights)).toBeGreaterThan(opened * 0.9);
});
