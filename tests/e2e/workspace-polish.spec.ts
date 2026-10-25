import { expect, test } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";
import { settingsDialog } from "../helpers/settings";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const pointer of ["mouse", "touch"] as const) {
  test.describe(`select trigger using ${pointer}`, () => {
    test.use({ hasTouch: pointer === "touch" });
    for (const narrow of [false, true]) {
      test(`clicking an open select trigger closes it without changing its selection ${narrow ? "in a narrow window" : "on desktop"}`, async ({ page }) => {
        await page.setViewportSize(narrow ? { width: 390, height: 780 } : { width: 1440, height: 960 });
        await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("fixture/chat", ["chat"])], { chat: "fixture/chat" }) }));
        await page.route("**/api/conversations", route => route.fulfill({ json: { data: [{ id: "toggle", title: "重复展开与收起", messageCount: 0, lastMessageAt: new Date().toISOString() }] } }));
        await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [] } }));
        await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [] } }));
        let writes = 0;
        page.on("request", request => { if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes++; });
        await page.goto("/chat");
        const click = async (locator: import("@playwright/test").Locator) => pointer === "touch" ? locator.tap() : locator.click();
        for (const name of ["助理模板", "聊天模式", "选择模型", "选择工具"]) {
          const trigger = page.getByRole("combobox", { name, exact: true, includeHidden: true });
          await expect(trigger).toBeEnabled();
          const selected = await trigger.textContent();
          const bounds = await page.locator(".composer-surface").boundingBox();
          for (let i = 0; i < 2; i++) {
            await click(trigger);
            await expect(trigger).toHaveAttribute("aria-expanded", "true");
            await expect(page.getByRole("listbox")).toBeVisible();
            await click(trigger);
            await expect(trigger).toHaveAttribute("aria-expanded", "false");
            await expect(page.getByRole("listbox")).toHaveCount(0);
            await expect(trigger).toBeFocused();
            await expect(trigger).toHaveText(selected!);
          }
          expect(await page.locator(".composer-surface").boundingBox()).toEqual(bounds);
          await trigger.press("Enter");
          await expect(page.getByRole("listbox")).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(page.getByRole("listbox")).toHaveCount(0);
          await expect(trigger).toBeFocused();
        }
        // A real keyboard selection still updates the value and closes the list.
        const mode = page.getByRole("combobox", { name: "聊天模式", exact: true });
        await mode.press("Enter");
        await expect(page.getByRole("option", { name: "聊天模式", exact: true })).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("option", { name: "文生图模式", exact: true })).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(mode).toContainText("文生图模式");
        await expect(page.getByRole("listbox")).toHaveCount(0);
        expect(writes).toBe(0);
      });
    }
  });
}

test("model lists omit introductions while catalog search still matches descriptions", async ({ page }) => {
  const description = "用于挑选时阅读的模型介绍。".repeat(20);
  const model = fixtureLibraryItem("fixture/compact", ["chat"], { name: "紧凑模型", description });
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([model], { chat: model.modelId }) }));
  await page.route("**/api/models/catalog?*", route => route.fulfill({ json: { catalogs: { openrouter: { chat: { models: [model], fetchedAt: "2026-10-16T18:00:00Z", stale: false, source: "cache", error: null, skipped: 0 } } } } }));
  await page.goto("/models");
  const library = page.getByRole("region", { name: "我的模型", exact: true });
  await expect(library.getByRole("listitem")).toHaveCount(1);
  for (const text of ["紧凑模型", model.modelId, "OpenRouter", "可用"]) await expect(library).toContainText(text);
  await expect(library).not.toContainText(description);
  await expect(library.getByRole("button", { name: "移除", exact: true })).toBeEnabled();
  const catalog = page.getByRole("region", { name: "模型目录结果", exact: true });
  await expect(catalog).not.toContainText(description.slice(0, 20));
  await page.getByRole("textbox", { name: "搜索模型目录", exact: true }).fill(description.slice(0, 20));
  await expect(catalog.getByRole("listitem")).toHaveCount(1);
  await expect(catalog).toContainText("紧凑模型");
});

test("catalog prices show dollars per million tokens while retaining non-token units and unknown prices", async ({ page }, info) => {
  const models = [
    fixtureLibraryItem("fixture/paid", ["chat"], { name: "按量模型", description: "这段模型介绍不应显示", pricing: { prompt: "0.0000025", completion: "0.00001", input_cache_read: "0.00000025", image: "0.04", request: "0.003" } }),
    fixtureLibraryItem("fixture/free", ["chat"], { name: "免费模型", pricing: { prompt: "0", completion: "0" } }),
    fixtureLibraryItem("fixture/unknown", ["chat"], { name: "未提供价格模型" }),
  ];
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([]) }));
  await page.route("**/api/models/catalog?*", route => route.fulfill({ json: { catalogs: { openrouter: { chat: { models, fetchedAt: "2026-10-16T18:00:00Z", stale: false, source: "cache", error: null, skipped: 0 } } } } }));
  await page.goto("/models");
  const catalog = page.getByRole("region", { name: "模型目录结果", exact: true });
  const paid = catalog.getByRole("listitem").filter({ hasText: "fixture/paid" });
  for (const price of ["$2.5/百万输入 Token", "$10/百万输出 Token", "$0.25/百万缓存读取 Token", "$0.04/张输入图片", "$0.003/次请求"]) await expect(paid).toContainText(price);
  await expect(paid).not.toContainText("这段模型介绍不应显示");
  await expect(paid.getByRole("button", { name: "添加", exact: true })).toBeEnabled();
  const free = catalog.getByRole("listitem").filter({ hasText: "fixture/free" });
  await expect(free).toContainText("$0/百万输入 Token");
  await expect(free).toContainText("$0/百万输出 Token");
  const unknown = catalog.getByRole("listitem").filter({ hasText: "fixture/unknown" });
  await expect(unknown).toContainText("价格暂未提供");
  await expect(unknown).not.toContainText("$0");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await catalog.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const row = (await paid.boundingBox())!;
    const add = (await paid.getByRole("button", { name: "添加", exact: true }).boundingBox())!;
    expect(add.x + add.width).toBeLessThanOrEqual(row.x + row.width);
    await page.screenshot({ path: info.outputPath(`catalog-pricing-${width}.png`) });
  }
});

async function expectStableAnimationEnd(locator: import("@playwright/test").Locator) {
  const measurements = await locator.evaluate(node => {
    const animations = node.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity);
    for (const animation of animations) { animation.pause(); animation.currentTime = Number(animation.effect!.getTiming().duration) * .999; }
    const nearEnd = node.getBoundingClientRect();
    for (const animation of animations) animation.finish();
    const end = node.getBoundingClientRect();
    return { animations: animations.length, dx: Math.abs(end.x - nearEnd.x), dy: Math.abs(end.y - nearEnd.y), dw: Math.abs(end.width - nearEnd.width), dh: Math.abs(end.height - nearEnd.height) };
  });
  expect(measurements.animations).toBeGreaterThan(0);
  for (const delta of [measurements.dx, measurements.dy, measurements.dw, measurements.dh]) expect(delta).toBeLessThan(.5);
}

test("shared menus finish their transitions without a position jump and toolbar controls align", async ({ page }) => {
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("fixture/chat", ["chat"])], { chat: "fixture/chat" }) }));
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [{ id: "menu-chat", title: "菜单定位", messageCount: 0, lastMessageAt: new Date().toISOString() }] } }));
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [] } }));
  // Hold each animation at its last frame, then compare against its resting position.
  await page.goto("/chat");
  await page.addStyleTag({ content: ":root { --dur-fast: 300ms; }" });
  const assistant = page.getByRole("combobox", { name: "助理模板", exact: true, includeHidden: true });
  await expect(assistant).toBeEnabled();
  const manage = page.getByRole("link", { name: "管理模板", exact: true });
  for (const control of [assistant, manage]) {
    await expect(control).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    expect((await control.boundingBox())!.height).toBe(32);
  }
  const memory = page.getByRole("switch", { name: "长期记忆", exact: true });
  await expect(memory).toHaveAttribute("aria-checked", "true");
  expect((await memory.boundingBox())!.y).toBe((await assistant.boundingBox())!.y);
  for (const control of [assistant, page.getByRole("combobox", { name: "聊天模式", exact: true, includeHidden: true }), page.getByRole("combobox", { name: "选择模型", exact: true, includeHidden: true }), page.getByRole("combobox", { name: "选择工具", exact: true, includeHidden: true })]) {
    const before = await control.boundingBox();
    await control.click();
    await expectStableAnimationEnd(page.getByRole("listbox"));
    expect(await control.boundingBox()).toEqual(before);
    await page.keyboard.press("Escape");
  }
  const recent = page.getByRole("button", { name: "会话列表", exact: true });
  await recent.click();
  await expectStableAnimationEnd(page.getByRole("dialog", { name: "最近会话", exact: true }));
  await page.getByRole("button", { name: "会话操作：菜单定位", exact: true }).click();
  await expectStableAnimationEnd(page.getByRole("menu"));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(recent).toBeFocused();
});

test("model browsing reveals batches only when scrolled and searches the entire cached catalog", async ({ page }) => {
  let catalogReads = 0;
  const models = Array.from({ length: 400 }, (_, i) => fixtureLibraryItem(`fixture/model-${i}`, ["chat"], { name: `目录模型 ${i}`, description: "用于浏览的模型说明。".repeat(5) }));
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([]) }));
  await page.route("**/api/models/catalog?*", route => {
    catalogReads++;
    const mode = new URL(route.request().url()).searchParams.get("mode") ?? "chat";
    return route.fulfill({ json: { catalogs: { openrouter: { [mode]: { models, fetchedAt: "2026-10-16T18:00:00Z", stale: false, source: "cache", error: null, skipped: 0 } } } } });
  });
  await page.clock.install();
  await page.goto("/models");
  const results = page.getByRole("region", { name: "模型目录结果", exact: true });
  await expect(results.getByRole("listitem")).toHaveCount(8);
  await page.clock.fastForward(30_000);
  await expect(results.getByRole("listitem")).toHaveCount(8);
  expect(catalogReads).toBe(1);
  await results.evaluate(node => node.scrollTo({ top: node.scrollHeight }));
  await expect(results.getByRole("listitem")).toHaveCount(16);
  await results.evaluate(node => node.scrollTo({ top: node.scrollHeight }));
  await expect(results.getByRole("listitem")).toHaveCount(24);
  expect(catalogReads).toBe(1);
  await page.getByRole("textbox", { name: "搜索模型目录", exact: true }).fill("model-399");
  await expect(results.getByRole("listitem")).toHaveCount(1);
  await expect(results).toContainText("目录模型 399");
  await page.getByRole("textbox", { name: "搜索模型目录", exact: true }).fill("");
  await expect(results.getByRole("listitem")).toHaveCount(8);
  await page.getByRole("tab", { name: "图片生成", exact: true }).click();
  await expect(results.getByRole("listitem")).toHaveCount(8);
  expect(catalogReads).toBe(2);
  await expect(settingsDialog(page).locator("select:visible")).toHaveCount(0);
});

for (const narrow of [false, true]) {
  test(`execution records scroll separately and restore focus without shifting the composer ${narrow ? "in a narrow window" : "on desktop"}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize(narrow ? { width: 390, height: 780 } : { width: 1440, height: 960 });
    await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("fixture/chat", ["chat"])], { chat: "fixture/chat" }) }));
    await page.route("**/api/conversations", route => route.fulfill({ json: { data: [{ id: "runs", title: "执行记录布局", messageCount: 2, lastMessageAt: new Date().toISOString() }] } }));
    await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [{ id: "alignment", role: "assistant", content: "正文与输入框保持同一中线。".repeat(100) }] } }));
    const runs = Array.from({ length: 10 }, (_, i) => ({ id: `run-${i}`, goal: `${i + 1}：检查一段很长的执行记录标题与详细步骤。`.repeat(4), status: "succeeded", budget: { maxSteps: i === 0 ? null : 8, maxFailures: i === 0 ? null : 2, deadlineMs: i === 0 ? null : 120000, maxCostUsd: null }, stopReason: null, steps: [{ id: `step-${i}`, position: 1, kind: "tool", toolName: "searchKnowledge", state: "done", errorCode: null }] }));
    await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: new URL(route.request().url()).searchParams.has("runId") ? null : runs } }));
    await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
    await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
    await page.goto("/chat");
    const article = page.locator(".chat-transcript article").first();
    await expect(article).toBeVisible();
    await expect(article.locator("header")).not.toContainText("来源：");
    const message = (await article.locator("..").boundingBox())!;
    const composer = (await page.locator(".composer-surface").boundingBox())!;
    expect(Math.abs((message.x + message.width / 2) - (composer.x + composer.width / 2))).toBeLessThan(.5);
    if (!narrow) {
      expect(composer.width).toBe(672);
      expect(composer.width).toBe(message.width);
    }
    const trigger = page.getByRole("button", { name: "执行记录", exact: true });
    await expect(trigger).toContainText("10");
    await page.getByPlaceholder(/输入你的问题/).fill("保留未发送的草稿");
    const before = await page.locator(".composer-surface").boundingBox();
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "执行记录", exact: true });
    await expect(drawer).toBeVisible();
    const firstRun = drawer.getByRole("button", { name: /^1：检查/ });
    await expect(firstRun.locator("span.truncate")).toHaveCSS("white-space", "nowrap");
    expect((await firstRun.boundingBox())!.height).toBeLessThanOrEqual(44);
    await expect(drawer.getByTestId("run-full-goal").first()).not.toBeVisible();
    await firstRun.click();
    await expect(firstRun).toHaveAttribute("aria-expanded", "true");
    await expect(drawer.getByTestId("run-full-goal").first()).toHaveText(runs[0].goal);
    await expect(drawer.getByTestId("run-full-goal").first()).toBeVisible();
    await expect(drawer.getByText("工具详情：searchKnowledge · 执行完成", { exact: true }).first()).toBeVisible();
    await expect(drawer.getByText("上限: 步骤不限 / 无总时限 / 失败次数不限", { exact: true })).not.toBeVisible();
    await drawer.getByText("调试信息", { exact: true }).first().click();
    await expect(drawer.getByText("上限: 步骤不限 / 无总时限 / 失败次数不限", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "导出脱敏诊断" }).first()).toBeVisible();
    await page.screenshot({ path: join(tmpdir(), `ria-run-records-${narrow ? "mobile" : "desktop"}.png`), animations: "disabled" });
    await firstRun.click();
    await expect(firstRun).toHaveAttribute("aria-expanded", "false");
    const scroller = drawer.locator(".run-records-scroll");
    await page.setViewportSize({ width: narrow ? 390 : 1440, height: 400 });
    expect(await scroller.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await scroller.evaluate(node => node.scrollTo({ top: node.scrollHeight }));
    await expect(drawer.getByRole("button", { name: /^10：检查/ })).toBeInViewport();
    await page.setViewportSize(narrow ? { width: 390, height: 780 } : { width: 1440, height: 960 });
    expect(await page.locator(".composer-surface").boundingBox()).toEqual(before);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.getByPlaceholder(/输入你的问题/)).toHaveValue("保留未发送的草稿");
    await page.getByRole("combobox", { name: "聊天模式", exact: true }).click();
    await expect(page.getByRole("option", { name: "文生图模式", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
