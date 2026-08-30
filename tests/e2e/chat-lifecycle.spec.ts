import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_IMAGE_MODEL, DEFAULT_MODEL, DEFAULT_VIDEO_MODEL } from "../../src/config/model";

const now = "2026-08-30T00:00:00Z";
const summary = (id: string, title: string) => ({ id, title, lastMessageAt: now, messageCount: 1 });
const storedMessage = (id: string, content: string) => ({ id, clientMessageId: id, role: "assistant", content, createdAt: now });

async function emptyPanels(page: Page) {
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
      await page.getByRole("button", { name: /^Beta/ }).click();
      await betaRequest;
      await expect(page.getByRole("checkbox", { name: "仅手动" })).toBeChecked();
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
      expect(preferences[1].manualToolsOnly).toBe(true);
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
  const row = page.getByRole("button", { name: /^New Chat/ }).locator("..");
  await row.getByRole("button", { name: "重命名" }).click();
  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("textbox").fill("Renamed conversation");
  await sidebar.getByRole("button", { name: "保存", exact: true }).click();
  const renamed = page.getByRole("button", { name: /^Renamed conversation/ }).locator("..");
  await renamed.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  expect(deletes).toBe(0);
  await renamed.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByText("Alpha answer", { exact: true })).toBeVisible();
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
    expect(route.request().postDataJSON().prompt).toBe("A short clip");
    await route.fulfill({ json: { asset, modelId: "fixture-model" } });
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
