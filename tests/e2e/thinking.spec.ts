import { test as base, expect, type Page } from "@playwright/test";
import { openWorkspace } from "../helpers/workspace-entry";
import { startStandaloneServer } from "../helpers/standalone-server";
import { configureOfflineModels, fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";
import { composerInput } from "../helpers/slash-menu";

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

test("full reasoning, a summary, hidden reasoning and none are each shown for what they are, after a reload too", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = (await page.evaluate(() => fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "思考类型" }) }).then(response => response.json()))).data;
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  const articles = page.locator("article");
  const verify = async () => {
    const full = articles.filter({ hasText: "完整思考的回答" });
    await expect(full.locator(".message-reasoning")).not.toHaveAttribute("open", "");
    await full.locator(".message-reasoning-summary").click();
    await expect(full.locator(".message-reasoning-body")).toContainText("逐步推理的内容");
    const summary = articles.filter({ hasText: "只有摘要的回答" });
    await expect(summary.locator(".message-reasoning-summary")).toContainText("思考摘要");
    await summary.locator(".message-reasoning-summary").click();
    await expect(summary.locator(".message-reasoning-body")).toContainText("概括后的思路");
    const hidden = articles.filter({ hasText: "没给思考的回答" });
    await expect(hidden.locator(".message-reasoning-static")).toContainText("模型没有提供思考内容");
    await expect(hidden.locator(".message-reasoning")).toHaveCount(0);
    const plain = articles.filter({ hasText: "离线回答" }).last();
    await expect(plain.locator(".message-reasoning, .message-reasoning-static")).toHaveCount(0);
  };
  await send(page, "OFFLINE_THINKING_FULL 第一条");
  await expect(articles.filter({ hasText: "完整思考的回答" })).toBeVisible();
  await send(page, "OFFLINE_THINKING_SUMMARY 第二条");
  await expect(articles.filter({ hasText: "只有摘要的回答" })).toBeVisible();
  await send(page, "OFFLINE_THINKING_HIDDEN 第三条");
  await expect(articles.filter({ hasText: "没给思考的回答" })).toBeVisible();
  await send(page, "普通问题");
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect(articles.filter({ hasText: "离线回答" }).last()).toBeVisible();
  await verify();
  await page.reload();
  await expect(articles.filter({ hasText: "完整思考的回答" })).toBeVisible();
  await verify();
  expect(errors).toEqual([]);
});

test("reasoning stays open while it arrives and folds as the answer starts, with its time and tool steps", async ({ page }) => {
  const chat = { id: "thinking-live", title: "思考过程", lastMessageAt: "2026-09-28T00:00:00Z", messageCount: 0 };
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" }) }));
  await page.route("**/api/conversations", route => route.request().method() === "POST" ? route.fulfill({ status: 201, json: { data: chat } }) : route.fulfill({ json: { data: [chat] } }));
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [{ id: "webSearch", displayName: "联网搜索", description: "", modeSupport: ["chat"], available: true, reason: null, requiresApproval: false, surface: { category: "web", user: null, template: "selectable" } }] } }));
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
  await send(page, "帮我想想");
  // Before anything comes back, the transcript says the reply is on its way.
  await expect(page.locator(".reply-pending")).toHaveText("正在回复…");
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { replyStream: { controller: unknown } }).replyStream.controller))).toBe(true);
  await emit([{ type: "start", messageId: "live" }, { type: "start-step" }, { type: "reasoning-start", id: "r1" }, { type: "reasoning-delta", id: "r1", delta: Array.from({ length: 40 }, (_, i) => `第 ${i} 行思考`).join("\n") }]);
  const reasoning = page.locator(".message-reasoning");
  const body = page.locator(".message-reasoning-body");
  await expect(reasoning).toHaveAttribute("open", "");
  await expect(reasoning.locator(".message-reasoning-summary")).toContainText("思考中");
  await expect(page.locator(".reply-pending")).toHaveCount(0);
  // Six lines tall, showing the newest.
  await expect.poll(() => body.evaluate(node => node.clientHeight <= 13 * 1.6 * 6 + 2 && node.scrollHeight - node.scrollTop - node.clientHeight <= 2)).toBe(true);

  await emit([{ type: "reasoning-end", id: "r1" }, { type: "tool-input-available", toolCallId: "search", toolName: "webSearch", input: { query: "x" } }, { type: "tool-output-available", toolCallId: "search", output: { results: [] } }, { type: "finish-step" }, { type: "start-step" }]);
  // Waiting on a tool is not the answer: it stays open.
  await expect(reasoning).toHaveAttribute("open", "");
  await expect(body).toContainText("调用了 联网搜索");
  await emit([{ type: "reasoning-start", id: "r2" }, { type: "reasoning-delta", id: "r2", delta: "再想一步" }, { type: "reasoning-end", id: "r2" }]);
  await expect(reasoning).toHaveAttribute("open", "");

  // The fold is one even motion: no jolt at the start and no snap at the end.
  const fold = await reasoning.evaluate(async node => {
    const heights: { at: number; height: number }[] = [];
    (window as unknown as { replyStream: { send: (chunks: unknown[]) => void } }).replyStream.send([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "这是回答" }]);
    for (let i = 0; i < 90; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      heights.push({ at: performance.now(), height: node.getBoundingClientRect().height });
      if (!(node as HTMLDetailsElement).open && !node.getAnimations({ subtree: true }).length && heights.length > 3) break;
    }
    return heights;
  });
  const moves = fold.slice(1).map((frame, index) => ({ step: fold[index].height - frame.height, ms: frame.at - fold[index].at })).filter(move => Math.abs(move.step) > 0.01);
  expect(fold[0].height - fold.at(-1)!.height).toBeGreaterThan(50);
  expect(Math.max(...moves.map(move => move.step / move.ms))).toBeLessThan(1.2);
  expect(moves.at(-1)!.step).toBeLessThan(3);
  // Whole pixels each frame: the text pinned below it cannot shake.
  expect(moves.filter(move => move.step > 0).every(move => Number.isInteger(Math.round(move.step * 100) / 100))).toBe(true);
  await expect(reasoning).not.toHaveAttribute("open", "");
  await expect(page.getByText("这是回答", { exact: true })).toBeVisible();
  // Opening it by hand holds while the answer keeps arriving.
  await reasoning.locator(".message-reasoning-summary").click();
  await expect(reasoning).toHaveAttribute("open", "");
  await emit([{ type: "text-delta", id: "t", delta: "，还有后半句" }]);
  await expect(reasoning).toHaveAttribute("open", "");
  await emit([{ type: "text-end", id: "t" }, { type: "finish-step" }, { type: "finish", finishReason: "stop", messageMetadata: { thinking: { kind: "full", durationMs: 12_400 } } }], true);
  await expect(reasoning.locator(".message-reasoning-summary")).toHaveText("已思考 12 秒");
});
