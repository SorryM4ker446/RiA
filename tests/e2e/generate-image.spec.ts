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

test("a picture made between two pieces of text shows where it was made, holds its place while it is made, and keeps that order after a reload", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, app);
  await send(page, "OFFLINE_DRAW_TEXT 画一座灯塔");
  // The words before the picture, then the picture's own place while it is made.
  await expect(answer(page)).toContainText("先说明一下：要画一座灯塔。");
  const pending = answer(page).getByTestId("generating-picture");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("正在生成图片");
  // Measured from the words before it: the answer's record above may grow as the turn goes on.
  const below = () => answer(page).evaluate(node => {
    const text = [...node.querySelectorAll(".markdown-message")].find(element => element.textContent?.includes("先说明一下"))!.getBoundingClientRect().bottom;
    const box = node.querySelector('[data-testid="generating-picture"], [data-testid="generated-picture"]')!.getBoundingClientRect();
    return { gap: box.top - text, height: box.height };
  });
  const held = await below();
  const picture = answer(page).getByTestId("generated-picture");
  await expect(picture).toBeVisible({ timeout: 15_000 });
  // It lands where it was being made, as large as the room it held.
  const landed = await below();
  expect(Math.abs(landed.gap - held.gap)).toBeLessThanOrEqual(1);
  expect(Math.abs(landed.height - held.height)).toBeLessThanOrEqual(2);
  await waitForChatStream(page);
  await expect(answer(page)).toContainText("后面再补一句说明。");
  const order = async () => answer(page).evaluate(node => {
    const at = (selector: string, text?: string) => [...node.querySelectorAll(selector)].find(element => !text || element.textContent?.includes(text))!.getBoundingClientRect().top;
    return { before: at(".markdown-message", "先说明一下"), picture: at('[data-testid="generated-picture"]'), after: at(".markdown-message", "后面再补一句") };
  });
  const live = await order();
  expect(live.before).toBeLessThan(live.picture);
  expect(live.picture).toBeLessThan(live.after);
  // Its prompt is not shown over the picture.
  await expect(picture.getByRole("img")).not.toHaveAttribute("title", /.+/);
  await page.reload();
  await expect(answer(page).getByTestId("generated-picture")).toBeVisible();
  const saved = await order();
  expect(saved.before).toBeLessThan(saved.picture);
  expect(saved.picture).toBeLessThan(saved.after);
});

test("a picture in the conversation opens in the viewer by double-click or its button, Esc returns to it, and the viewer leads to its media detail", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, app);
  await send(page, "OFFLINE_DRAW 画一只穿宇航服的猫");
  await waitForChatStream(page);
  const figure = answer(page).getByTestId("generated-picture");
  const image = figure.getByRole("img", { name: "生成的图片", exact: true });
  const src = (await image.getAttribute("src"))!;
  const scroller = page.getByTestId("message-list");
  const scrolled = await scroller.evaluate(node => node.scrollTop);
  await image.dblclick();
  const viewer = page.locator(".image-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".image-viewer-picture")).toHaveAttribute("src", src);
  await expect(viewer.getByRole("button", { name: "适应窗口", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(figure.getByRole("button", { name: "查看大图", exact: true })).toBeFocused();
  expect(await scroller.evaluate(node => node.scrollTop)).toBe(scrolled);
  await figure.getByRole("button", { name: "查看大图", exact: true }).click();
  await viewer.getByRole("link", { name: "在媒体库中查看", exact: true }).click();
  const id = src.split("/").at(-1)!;
  await expect(page).toHaveURL(new RegExp(`/media\\?asset=${id}$`));
  const detail = page.getByRole("region", { name: "媒体详情" });
  await expect(detail).toContainText(id);
  // The full prompt is there, and only there.
  await expect(detail.getByTestId("asset-prompt")).toHaveText("A cat in a white spacesuit floating above the Moon, studio light");
  // The library's own card for it says what it is, not its prompt.
  await expect(page.locator(`article[aria-label="媒体 ${id}"]`)).not.toContainText("spacesuit");
});

test("adding a picture to the next question grows the message box smoothly: the send button, the box's bottom, the reading position and the draft stay put", async ({ page, app }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, app);
  await send(page, "OFFLINE_DRAW 画一只穿宇航服的猫");
  await waitForChatStream(page);
  const input = page.getByPlaceholder(/输入你的问题/);
  const attachments = page.getByRole("list", { name: "已添加的附件" });
  // Its name changes while it works ("加入中..."), so it is found by place: the action after "查看大图".
  const reuse = answer(page).getByTestId("generated-picture").getByRole("button").nth(1);
  await expect(reuse).toHaveText("带图追问");
  const layout = () => page.evaluate(() => {
    const form = document.querySelector("form textarea")!.closest("form")!;
    const list = document.querySelector('[data-testid="message-list"]')!;
    // Where the reader is: how far the transcript is from its end, which stays the same as the box grows.
    return { bottom: Math.round(form.getBoundingClientRect().bottom), fromEnd: Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) };
  });
  const watchStop = () => page.evaluate(() => {
    const seen = { stop: false };
    new MutationObserver(() => { if (document.querySelector('button[aria-label="停止"]')) seen.stop = true; }).observe(document.body, { subtree: true, childList: true, attributes: true });
    (window as unknown as { __seen: typeof seen }).__seen = seen;
  });
  // A slow read of the picture's type, an empty draft, then one already written, then one that fails.
  let release!: () => void, gate = new Promise<void>(resolve => { release = resolve; }), fail = false;
  await page.route(/\/api\/media\/[0-9a-f-]{36}$/, async route => {
    if (route.request().method() !== "HEAD") return route.continue();
    await gate;
    return fail ? route.fulfill({ status: 500 }) : route.continue();
  });
  for (const draft of ["", "这张图里"]) {
    if (draft) { await attachments.getByRole("button", { name: "移除这张图片" }).click(); await expect(attachments).toHaveCount(0); }
    await input.fill(draft);
    const before = await layout();
    await watchStop();
    await reuse.click();
    await expect(reuse).toHaveText("加入中...");
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    expect((await layout()).bottom).toBe(before.bottom);
    release();
    await expect(attachments.getByRole("img")).toHaveCount(1);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(draft);
    const after = await layout();
    expect(after.bottom).toBe(before.bottom);
    expect(Math.abs(after.fromEnd - before.fromEnd)).toBeLessThanOrEqual(2);
    expect((await page.evaluate(() => (window as unknown as { __seen: { stop: boolean } }).__seen)).stop, "the page never turned busy").toBe(false);
    gate = new Promise<void>(resolve => { release = resolve; });
  }
  await attachments.getByRole("button", { name: "移除这张图片" }).click();
  fail = true;
  const before = await layout();
  await reuse.click();
  release();
  await expect(page.getByRole("alert").filter({ hasText: "读取图片失败" }).first()).toBeVisible();
  await expect(attachments).toHaveCount(0);
  expect((await layout()).bottom).toBe(before.bottom);
  await expect(input).toHaveValue("这张图里");
  await expect(reuse).toBeEnabled();
});
