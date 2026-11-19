import { expect, test as base, type Page } from "@playwright/test";
import { trackChatStreams, waitForChatStream } from "../helpers/chat-stream";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi } from "../helpers/browser-api";

type App = Awaited<ReturnType<typeof startStandaloneServer>>;
const test = base.extend<{ app: App }>({ app: async ({}, provide) => {
  const runtime = await startStandaloneServer({ modelFixture: true });
  try { await provide(runtime); } finally { await runtime.close(); }
} });

async function open(page: Page, app: App) {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6", image: "google/gemini-3.1-flash-image-preview" });
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "聊天里画图" })).body.data;
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await trackChatStreams(page);
  return chat.id as string;
}
async function send(page: Page, text: string) {
  await page.getByPlaceholder(/输入你的问题/).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}
const answer = (page: Page) => page.getByTestId("message-list").locator('[data-message-role="assistant"]').last();

test("a picture the user asks for in chat is made without an approval, shown in the answer and kept after a reload", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, app);
  await send(page, "OFFLINE_DRAW 画一只穿宇航服的猫");
  await waitForChatStream(page);
  // The model got the picture back to look at.
  await expect(answer(page)).toContainText("图画好了，我看过了。");
  await expect(page.locator("#chat-approval-card")).toHaveCount(0);
  const picture = answer(page).getByTestId("generated-picture").getByRole("img", { name: "生成的图片", exact: true });
  await expect(picture).toBeVisible();
  await expect(picture).toHaveAttribute("src", /^\/api\/media\/[0-9a-f-]{36}$/);
  await expect.poll(() => picture.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
  await page.screenshot({ path: test.info().outputPath("generated-picture.png"), animations: "disabled" });
  const src = await picture.getAttribute("src");
  const library = (await browserApi(page, "/api/media/library?kind=generated-image")).body.data as { id: string }[];
  expect(library.map(item => `/api/media/${item.id}`)).toContain(src);
  await page.reload();
  await expect(answer(page).getByTestId("generated-picture").getByRole("img")).toHaveAttribute("src", src!);
  const usage = (await browserApi(page, "/api/usage?source=media")).body.data;
  expect(usage.totals).toMatchObject({ requests: 1, costUsd: 0.0123, unknownCostRequests: 0 });
  expect(usage.recent[0]).toMatchObject({ mode: "image", source: "media", status: "success", costSource: "provider" });
  expect(errors).toEqual([]);
});

test("image mode and library regeneration each record the provider's charge", async ({ page, app }) => {
  const chatId = await open(page, app);
  const image = await browserApi(page, "/api/image", "POST", { chatId, prompt: "Draw a red tree." });
  expect(image.status).toBe(200);
  const regenerated = await browserApi(page, `/api/media/${image.body.asset.assetId}/regenerate`, "POST", { confirm: true });
  expect(regenerated.status).toBe(201);
  const usage = (await browserApi(page, "/api/usage?source=media")).body.data;
  expect(usage.totals).toMatchObject({ requests: 2, unknownCostRequests: 0 });
  expect(usage.totals.costUsd).toBeCloseTo(0.0246, 10);
  expect(usage.recent).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
    mode: "image", source: "media", status: "success", costUsd: 0.0123, costSource: "provider",
  })));
});

test("image mode continues editing a generated picture over 8 MiB without uploading it again", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, app);
  await page.getByRole("combobox").filter({ hasText: "聊天模式" }).click();
  await page.getByRole("option", { name: "文生图模式", exact: true }).click();
  const input = page.getByPlaceholder(/描述你想生成的图片/);
  const sendImage = page.getByRole("button", { name: "发送", exact: true });
  const imageResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === "/api/image" && response.request().method() === "POST");
  await input.fill("OFFLINE_LARGE_IMAGE Draw a red tree");
  const originalResponse = imageResponse();
  await sendImage.click();
  const original = await originalResponse;
  expect(original.status()).toBe(200);
  const { asset } = await original.json();
  expect(asset.byteSize).toBeGreaterThan(8 * 1024 * 1024);

  const uploads: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/media/upload") uploads.push(request.url());
  });
  const headResponse = page.waitForResponse(response => new URL(response.url()).pathname === asset.url && response.request().method() === "HEAD");
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  expect((await headResponse).status()).toBe(200);
  const composerImage = page.getByRole("list", { name: "已添加的附件" }).getByRole("img");
  await expect(composerImage).toHaveAttribute("src", asset.url);
  await input.fill("Change the tree to blue");
  const editResponse = imageResponse();
  await sendImage.click();
  const edited = await editResponse;
  expect(edited.status()).toBe(200);
  expect(edited.request().postDataJSON().inputImages).toEqual([{ url: asset.url, mediaType: "image/png" }]);
  const result = await edited.json();
  const details = await browserApi(page, `/api/media/${result.asset.assetId}/details`, "GET");
  expect(details.body.data.generation.inputImages).toEqual([{ assetId: asset.assetId, mediaType: "image/png" }]);
  expect(uploads).toEqual([]);
  expect(errors).toEqual([]);
});

test("a picture the model decides on by itself waits for approval, showing its description and cost", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, app);
  await send(page, "OFFLINE_DRAW 总结一下这段话");
  const card = page.locator("#chat-approval-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("生成图片");
  await expect(card).toContainText("A cat in a white spacesuit floating above the Moon");
  await expect(card).toContainText("生成会产生费用");
  await page.screenshot({ path: test.info().outputPath("picture-approval.png"), animations: "disabled" });
  // The review's reason is saved with the call, so the card shows it once the conversation is read back.
  await page.reload();
  await trackChatStreams(page);
  await expect(card).toContainText("生成图片");
  await expect(card).toContainText("用户没有要求画图。");
  await card.getByRole("button", { name: "拒绝", exact: true }).click();
  await waitForChatStream(page);
  await expect(answer(page)).toContainText("你没有批准，没画。");
  await expect(answer(page).getByTestId("generated-picture")).toHaveCount(0);
});

test("text in the image mode that reads as a question gets a hint, which switches back to chat", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, app);
  await page.getByRole("combobox").filter({ hasText: "聊天模式" }).click();
  await page.getByRole("option", { name: "文生图模式", exact: true }).click();
  const input = page.getByRole("textbox").last();
  await input.fill("一只穿宇航服的猫，水彩风格");
  await expect(page.getByTestId("image-question-hint")).toBeHidden();
  await input.fill("为什么天空是蓝色的？");
  await expect(page.getByTestId("image-question-hint")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("image-question-hint.png"), animations: "disabled" });
  await page.getByRole("button", { name: "切回聊天", exact: true }).click();
  await expect(page.getByRole("combobox").filter({ hasText: "聊天模式" })).toBeVisible();
  await expect(page.getByTestId("image-question-hint")).toBeHidden();
  await expect(page.getByPlaceholder(/输入你的问题/)).toHaveValue("为什么天空是蓝色的？");
});
