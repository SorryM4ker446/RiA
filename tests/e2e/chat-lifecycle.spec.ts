import { openRecentConversations } from "../helpers/conversations";
import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_IMAGE_MODEL, DEFAULT_MODEL, DEFAULT_VIDEO_MODEL } from "../../src/config/model";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";

const now = "2026-08-30T00:00:00Z";
const summary = (id: string, title: string) => ({ id, title, lastMessageAt: now, messageCount: 1 });
const storedMessage = (id: string, content: string) => ({ id, clientMessageId: id, role: "assistant", content, createdAt: now });

async function emptyPanels(page: Page) {
  await page.route("**/api/models", (route) => route.fulfill({ json: modelsRouteFixture(
    [fixtureLibraryItem(DEFAULT_MODEL, ["chat"]), fixtureLibraryItem(DEFAULT_IMAGE_MODEL, ["image"], { endpointImageInput: true, supportsTools: false }), fixtureLibraryItem(DEFAULT_VIDEO_MODEL, ["video"], { supportsTools: false })],
    { chat: DEFAULT_MODEL, image: DEFAULT_IMAGE_MODEL, video: DEFAULT_VIDEO_MODEL },
  ) }));
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));
}

for (const lateFailure of [false, true]) {
  test(`conversation switching ignores late history ${lateFailure ? "errors" : "results"} and restores its own preferences`, async ({ page }) => {
    await emptyPanels(page);
    await page.route("**/api/conversations", (route) => route.fulfill({ json: { data: [summary("a", "Alpha"), summary("b", "Beta")] } }));
    await page.addInitScript((defaults) => {
      localStorage.setItem("chat:last-active-id", "a");
      localStorage.setItem("chat:prefs:a", JSON.stringify({ ...defaults, modelMode: "image" }));
      localStorage.setItem("chat:prefs:b", JSON.stringify({ ...defaults, modelMode: "chat", manualToolsOnly: true }));
    }, { selectedChatModel: DEFAULT_MODEL, selectedImageModel: DEFAULT_IMAGE_MODEL, selectedVideoModel: DEFAULT_VIDEO_MODEL, selectedManualTool: "none", manualToolsOnly: false });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/conversations/*/messages", async (route) => {
      if (route.request().url().includes("/b/")) {
        await gate;
        await route.fulfill(lateFailure
          ? { status: 500, json: { error: { code: "INTERNAL_ERROR", message: "Delayed history failure" } } }
          : { json: { data: [storedMessage("b-answer", "Beta answer")] } });
      } else {
        await route.fulfill({ json: { data: [storedMessage("a-answer", "Alpha answer")] } });
      }
    });
    try {
      await page.goto("/chat");
      await expect(page.getByText("Alpha answer", { exact: true })).toBeVisible();
      await expect(page.getByPlaceholder(/描述你想生成的图片/)).toBeVisible();
      const betaRequest = page.waitForRequest("**/api/conversations/b/messages");
      await openRecentConversations(page);
      await page.getByRole("button", { name: /^Beta/ }).click();
      await betaRequest;
      await expect(page.getByRole("checkbox", { name: "仅手动" })).toHaveCount(0);
      await openRecentConversations(page);
      await page.getByRole("button", { name: /^Alpha/ }).click();
      await expect(page.getByText("Alpha answer", { exact: true })).toBeVisible();
      await expect(page.getByPlaceholder(/描述你想生成的图片/)).toBeVisible();
      const lateResponse = page.waitForResponse("**/api/conversations/b/messages");
      release();
      await (await lateResponse).finished();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByText("Alpha answer", { exact: true })).toBeVisible();
      await expect(page.getByText("Beta answer", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("alert").filter({ hasText: "请求失败" })).toHaveCount(0);
      const preferences = await page.evaluate(() => [JSON.parse(localStorage.getItem("chat:prefs:a")!), JSON.parse(localStorage.getItem("chat:prefs:b")!)]);
      expect(preferences[0].modelMode).toBe("image");
      expect(preferences[1].modelMode).toBe("chat");
      expect(preferences[1].manualToolsOnly).toBeUndefined();
      expect(preferences[1].selectedManualTool).toBeUndefined();
    } finally { release(); }
  });
}

test("conversation create, rename and confirmed deletion preserve the remaining history", async ({ page }) => {
  await emptyPanels(page);
  let chats = [summary("a", "Alpha")];
  let deletes = 0;
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() === "POST") {
      const created = summary("new-chat", route.request().postDataJSON().title);
      chats = [created, ...chats];
      await route.fulfill({ status: 201, json: { data: created } });
    } else await route.fulfill({ json: { data: chats } });
  });
  await page.route("**/api/conversations/*/messages", (route) => route.fulfill({ json: { data: route.request().url().includes("/a/") ? [storedMessage("a-answer", "Alpha answer")] : [] } }));
  await page.route("**/api/conversations/new-chat", async (route) => {
    if (route.request().method() === "PATCH") {
      chats[0] = { ...chats[0], title: route.request().postDataJSON().title };
      await route.fulfill({ json: { data: chats[0] } });
    } else {
      deletes++;
      chats = chats.filter((chat) => chat.id !== "new-chat");
      await route.fulfill({ json: { success: true } });
    }
  });
  await page.goto("/chat");
  await expect(page.getByText("Alpha answer", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "创建会话", exact: true }).click();
  await openRecentConversations(page);
  const row = page.getByRole("button", { name: /^New Chat/ }).locator("..");
  await row.getByRole("button", { name: /^会话操作：/ }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "会话列表", exact: true });
  await expect(sidebar.getByRole("textbox")).toBeFocused();
  await sidebar.getByRole("textbox").fill("Renamed conversation");
  await sidebar.getByRole("button", { name: "保存", exact: true }).click();
  const renamed = page.getByRole("button", { name: /^Renamed conversation/ }).locator("..");
  await renamed.getByRole("button", { name: /^会话操作：/ }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  expect(deletes).toBe(0);
  await openRecentConversations(page);
  await renamed.getByRole("button", { name: /^会话操作：/ }).click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByText("Alpha answer", { exact: true })).toBeVisible();
  await openRecentConversations(page);
  await expect(page.getByRole("button", { name: /^Renamed conversation/ })).toHaveCount(0);
  expect(deletes).toBe(1);
});

test("video generation preserves the asset reference and renders it after reload", async ({ page }) => {
  await emptyPanels(page);
  const history: ReturnType<typeof storedMessage>[] = [];
  const asset = { assetId: "fixture-video", relativePath: "fixture.mp4", mediaType: "video/mp4", url: "/api/media/fixture-video" };
  await page.route("**/api/conversations", (route) => route.fulfill({ json: { data: [summary("video-chat", "Video fixture")] } }));
  await page.route("**/api/conversations/video-chat/messages", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      history.push({ ...storedMessage(body.clientMessageId, body.content), role: body.role });
      await route.fulfill({ status: 201, json: { data: history.at(-1) } });
    } else await route.fulfill({ json: { data: history } });
  });
  await page.route("**/api/video", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.prompt).toBe("A short clip");
    // Media requests select a model by provider and id, like every other call.
    expect(body.model).toEqual({ providerId: "openrouter", modelId: DEFAULT_VIDEO_MODEL });
    await route.fulfill({ json: { asset, modelId: "fixture-model", modelProvider: "openrouter" } });
  });
  await page.route("**/api/media/fixture-video", (route) => route.fulfill({ contentType: "video/mp4", body: Buffer.from([]) }));
  await page.goto("/chat");
  await page.getByRole("combobox").filter({ hasText: "聊天模式" }).click();
  await page.getByRole("option", { name: "视频生成模式", exact: true }).click();
  await page.getByPlaceholder(/描述你想生成的视频/).fill("A short clip");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("视频生成完成 · fixture-model", { exact: true })).toBeVisible();
  await expect.poll(() => history.length).toBe(2);
  expect(history[1].content).toContain(asset.assetId);
  expect(history[1].content).not.toContain("base64");
  await page.reload();
  await expect(page.locator("video")).toHaveAttribute("src", asset.url);
  await expect(page.getByPlaceholder(/描述你想生成的视频/)).toBeVisible();
});

for (const narrow of [false, true]) {
  test(`recent conversations keep date groups, long titles and keyboard menus usable ${narrow ? "in a narrow window" : "on desktop"}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-16T19:00:00Z"));
    if (narrow) await page.setViewportSize({ width: 390, height: 780 });
    await emptyPanels(page);
    const longTitle = "梳理产品界面的交互细节与下一阶段的完整设计计划";
    const chats = [
      { ...summary("pinned", "本周工作计划"), pinned: true, lastMessageAt: "2026-09-01T19:00:00Z" },
      { ...summary("today", longTitle), lastMessageAt: "2026-10-16T18:00:00Z" },
      { ...summary("yesterday", "读书笔记"), lastMessageAt: "2026-10-15T19:00:00Z" },
      { ...summary("week", "下周学习安排"), lastMessageAt: "2026-10-13T19:00:00Z" },
      { ...summary("older", "项目需求讨论"), lastMessageAt: "2026-09-20T19:00:00Z" },
      { ...summary("hidden", "知识库文档总结"), lastMessageAt: "2026-09-19T19:00:00Z" },
    ];
    await page.route("**/api/conversations", route => route.fulfill({ json: { data: chats } }));
    await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [] } }));
    await page.goto("/chat");
    await openRecentConversations(page);
    const sidebar = page.getByRole("complementary", { name: "会话列表", exact: true });
    for (const [group, title] of [["置顶", "本周工作计划"], ["今天", longTitle], ["昨天", "读书笔记"], ["近 7 天", "下周学习安排"], ["更早", "项目需求讨论"]]) {
      await expect(sidebar.getByRole("region", { name: group, exact: true }).getByRole("button", { name: new RegExp(`^${title}`) })).toBeVisible();
    }
    // Six fit in the first batch: every one shows without an expand step.
    await expect(sidebar.getByRole("button", { name: /^知识库文档总结/ })).toBeVisible();
    await expect(sidebar.getByText("下滑加载更多会话")).toHaveCount(0);
    await expect(sidebar.getByText("已加载 6 个会话", { exact: true })).toBeVisible();
    const action = sidebar.getByRole("button", { name: `会话操作：${longTitle}`, exact: true });
    await action.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(action).toBeFocused();
    if (narrow) await expect(page.getByRole("button", { name: "会话列表", exact: true })).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
    const editor = sidebar.getByRole("textbox", { name: "重命名", exact: true });
    await expect(editor).toBeFocused();
    await editor.fill("还未保存的标题");
    await page.keyboard.press("Escape");
    await expect(sidebar.getByRole("button", { name: new RegExp(`^${longTitle}`) })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (narrow) {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "会话列表", exact: true })).toHaveAttribute("aria-expanded", "false");
    }
  });
}
