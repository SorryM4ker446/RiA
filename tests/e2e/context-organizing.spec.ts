import { test as base, expect, type Page } from "@playwright/test";
import { openWorkspace } from "../helpers/workspace-entry";
import { startStandaloneServer } from "../helpers/standalone-server";
import { configureOfflineModels, fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";
import { chooseFromSlashMenu, chosenWords, composerInput } from "../helpers/slash-menu";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

const send = async (page: Page, text: string) => {
  await composerInput(page).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
};

test("the transcript says context is being organized until the answer can start", async ({ page }) => {
  const chat = { id: "organizing", title: "整理", lastMessageAt: "2026-09-28T00:00:00Z", messageCount: 0 };
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" }) }));
  await page.route("**/api/conversations", route => route.request().method() === "POST" ? route.fulfill({ status: 201, json: { data: chat } }) : route.fulfill({ json: { data: [chat] } }));
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
  // Delivers the reply piece by piece, so each moment can be looked at.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const stream = { controller: null as ReadableStreamDefaultController<Uint8Array> | null };
    (window as unknown as { replyStream: typeof stream & { send: (chunks: unknown[], close?: boolean) => void } }).replyStream = Object.assign(stream, {
      send(chunks: unknown[], close = false) {
        for (const chunk of chunks) stream.controller!.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        if (close) { stream.controller!.enqueue(encoder.encode("data: [DONE]\n\n")); stream.controller!.close(); }
      },
    });
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!new URL(url, location.href).pathname.endsWith("/api/chat")) return original(input, init);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream.controller = controller; } }), { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
    };
  });
  const emit = (chunks: unknown[], close = false) => page.evaluate(([items, done]) => (window as unknown as { replyStream: { send: (chunks: unknown[], close?: boolean) => void } }).replyStream.send(items as unknown[], done as boolean), [chunks, close] as const);
  await page.goto("/chat");
  await send(page, "接着上次说");
  const pending = page.locator(".reply-pending");
  await expect(pending).toHaveText("正在回复…");
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { replyStream: { controller: unknown } }).replyStream.controller))).toBe(true);
  await emit([{ type: "data-context-status", data: { organizing: true }, transient: true }]);
  await expect(pending).toHaveText("正在整理上下文…");
  await emit([{ type: "data-context-status", data: { organizing: false }, transient: true }]);
  await expect(pending).toHaveText("正在回复…");
  await emit([{ type: "start", messageId: "live" }, { type: "start-step" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "这是回答" }, { type: "text-end", id: "t" }, { type: "finish-step" }, { type: "finish", finishReason: "stop" }], true);
  await expect(page.getByText("这是回答", { exact: true })).toBeVisible();
  await expect(pending).toHaveCount(0);
  await expect(page.locator("article")).toHaveCount(2);

  // A reply that fails while organizing does not leave the status behind.
  await send(page, "再问一次");
  await expect(pending).toHaveText("正在回复…");
  await expect.poll(() => page.evaluate(() => (window as unknown as { replyStream: { controller: { desiredSize: number | null } | null } }).replyStream.controller?.desiredSize !== null)).toBe(true);
  await emit([{ type: "data-context-status", data: { organizing: true }, transient: true }]);
  await expect(pending).toHaveText("正在整理上下文…");
  await emit([{ type: "error", errorText: JSON.stringify({ error: { code: "UPSTREAM_FAILED", message: "模型暂时不可用" } }) }], true);
  await expect(pending).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
});

test("choosing compact context from the slash menu folds earlier turns with no model answering", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = (await page.evaluate(() => fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "压缩" }) }).then(response => response.json()))).data;
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  const articles = page.locator("article"), idle = page.getByRole("button", { name: "发送", exact: true });
  await send(page, "第一个问题");
  await expect(articles).toHaveCount(2);
  await expect(idle).toBeVisible();

  // Too little so far: the one exchange is kept as it is.
  await chooseFromSlashMenu(page, "压缩上下文");
  await expect(chosenWords(page)).toHaveCount(1);
  await page.getByRole("button", { name: "开始整理", exact: true }).click();
  await expect(page.getByText("前面的内容还不需要整理")).toBeVisible();
  await expect(chosenWords(page)).toHaveCount(0);

  await composerInput(page).fill("第二个问题");
  await idle.click();
  await expect(articles).toHaveCount(4);
  await expect(idle).toBeVisible();

  await chooseFromSlashMenu(page, "压缩上下文");
  await composerInput(page).click();
  await page.keyboard.type("保留第一个问题");
  await page.getByRole("button", { name: "开始整理", exact: true }).click();
  await expect(page.getByText("前面的对话已经整理好了")).toBeVisible();
  await expect(chosenWords(page)).toHaveCount(0);
  await expect(composerInput(page)).toHaveText("");
  await expect(articles).toHaveCount(4);
  await expect(page.locator(".reply-pending")).toHaveCount(0);
  // The turns stay readable, and the marker shows what now stands in for them.
  const marker = page.locator("[data-compaction-marker]");
  await expect(marker).toHaveCount(1);
  await expect(marker.locator("summary")).toHaveText("前面的对话已压缩");
  await expect(marker).not.toHaveAttribute("open", "");
  await marker.locator("summary").click();
  await expect(marker).toHaveAttribute("open", "");
  await expect(marker.locator(".message-reasoning-body")).not.toBeEmpty();
  await page.reload();
  await expect(page.locator("[data-compaction-marker]")).toHaveCount(1);
  await expect(articles).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("the auxiliary model is chosen in settings, follows the conversation by default, and clears when removed", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/chat?settings=models`);
  const select = page.getByRole("combobox", { name: "辅助模型", exact: true });
  await expect(select).toContainText("跟随对话模型");
  await select.click();
  await page.getByRole("option").filter({ hasText: /gemini/i }).first().click();
  await page.getByRole("button", { name: "保存模型偏好", exact: true }).click();
  await expect(page.getByText("模型偏好已保存")).toBeVisible();
  const auxiliary = (await browserData(page, "/api/models")).auxiliary;
  expect(auxiliary.modelId).toBe("google/gemini-3-flash-preview");
  expect((await browserApi(page, "/api/models/library", "POST", { action: "remove", model: auxiliary })).status).toBe(200);
  expect((await browserData(page, "/api/models")).auxiliary).toBeNull();
});
