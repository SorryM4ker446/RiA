import { test as base, expect, type Locator, type Page } from "@playwright/test";
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

const clockToday = /^\d{1,2}:\d{2}$/;
const send = async (page: Page, text: string) => {
  await composerInput(page).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
};
const opacity = (node: Locator) => node.evaluate(element => Number(getComputedStyle(element.closest(".message-actions")!).opacity));
const expectLeftOf = async (time: Locator, button: Locator) => {
  const [a, b] = await Promise.all([time.boundingBox(), button.boundingBox()]);
  expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);
  // Centred on the icon beside it.
  expect(Math.abs((a!.y + a!.height / 2) - (b!.y + b!.height / 2))).toBeLessThan(1);
};

test("what was asked and what was answered each show their time on hover, left of the actions, after a reload too", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = (await page.evaluate(() => fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "消息时间" }) }).then(response => response.json()))).data;
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await send(page, "普通问题");
  const answer = page.locator("article").filter({ hasText: "离线回答" }).last();
  await expect(answer).toBeVisible();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();

  const verify = async () => {
    const question = page.locator("article").filter({ hasText: "普通问题" }).first();
    const asked = question.locator("time.message-time"), answered = answer.locator("time.message-time");
    await page.mouse.move(0, 0);
    await expect.poll(() => opacity(asked)).toBe(0);
    await question.hover();
    await expect.poll(() => opacity(asked)).toBe(1);
    await expect(asked).toHaveText(clockToday);
    // The exact moment on hovering the time itself, in a small label rather than a panel.
    await asked.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toHaveText(/^\d{4}年\d{1,2}月\d{1,2}日 \d{1,2}:\d{2}$/);
    // The theme's own popover colours, in whichever theme is showing.
    const look = await tip.evaluate(node => {
      const probe = document.body.appendChild(document.createElement("div"));
      probe.style.cssText = "background:hsl(var(--popover));color:hsl(var(--popover-foreground))";
      const style = getComputedStyle(node), theme = getComputedStyle(probe);
      const read = { radius: style.borderRadius, blur: style.backdropFilter, size: style.fontSize, background: style.backgroundColor, color: style.color, themeBackground: theme.backgroundColor, themeColor: theme.color };
      probe.remove();
      return read;
    });
    expect(look).toMatchObject({ radius: "6px", blur: "none", size: "12px", background: look.themeBackground, color: look.themeColor });
    await question.hover({ position: { x: 4, y: 4 } });
    await expect(tip).toHaveCount(0);
    await expectLeftOf(asked, question.getByRole("button", { name: "编辑消息" }));
    await answer.hover();
    await expect.poll(() => opacity(answered)).toBe(1);
    await expect(answered).toHaveText(clockToday);
    await expectLeftOf(answered, answer.getByRole("button", { name: "重新生成" }));
    // Reads along one line with the role label across the header: same type, same centre.
    const label = answer.locator("header .label-mono").first();
    await expect(label).toHaveText(/RiA/i);
    const [labelBox, timeBox] = await Promise.all([label.boundingBox(), answered.boundingBox()]);
    expect(Math.abs((labelBox!.y + labelBox!.height / 2) - (timeBox!.y + timeBox!.height / 2))).toBeLessThan(1);
    expect(await answered.evaluate(node => getComputedStyle(node).fontSize)).toBe(await label.evaluate(node => getComputedStyle(node).fontSize));
    return { asked: await asked.getAttribute("datetime"), answered: await answered.getAttribute("datetime") };
  };
  const live = await verify();
  await page.reload();
  await expect(answer).toBeVisible();
  const stored = await verify();
  // The stored time replaces the one the page held, and they are the same moment.
  for (const key of ["asked", "answered"] as const) expect(Math.abs(Date.parse(live[key]!) - Date.parse(stored[key]!))).toBeLessThan(5_000);
  expect(Date.parse(stored.answered!)).toBeGreaterThanOrEqual(Date.parse(stored.asked!));
  expect(errors).toEqual([]);
});

test("earlier messages say the day, a message with no time shows none, and an answer in progress shows none yet", async ({ page }) => {
  const chat = { id: "message-times", title: "历史时间", lastMessageAt: "2026-09-28T00:00:00Z", messageCount: 4 };
  const local = (daysAgo: number) => { const at = new Date(); at.setDate(at.getDate() - daysAgo); at.setHours(9, 5, 0, 0); return at.toISOString(); };
  const lastYear = new Date(new Date().getFullYear() - 1, 2, 3, 9, 5).toISOString();
  const row = (id: string, role: string, content: string, createdAt?: string) => ({ id, clientMessageId: null, role, content, status: "success", ...(createdAt ? { createdAt } : {}) });
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" }) }));
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [chat] } }));
  await page.route("**/api/conversations/*/messages**", route => route.fulfill({ json: { data: [
    row("last-year", "user", "去年的问题", lastYear),
    row("no-time", "assistant", "没有时间的回答"),
    row("yesterday", "user", "昨天的问题", local(1)),
    row("today", "assistant", "今天的回答", local(0)),
  ] } }));
  await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
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
  await page.goto(`/chat?conversationId=${chat.id}`);
  const article = (text: string) => page.locator("article").filter({ hasText: text });
  await expect(article("今天的回答").locator("time.message-time")).toHaveText(clockToday);
  await expect(article("昨天的问题").locator("time.message-time")).toHaveText(/^昨天 9:05$/);
  await expect(article("去年的问题").locator("time.message-time")).toHaveText(`${new Date().getFullYear() - 1}年3月3日 9:05`);
  await expect(article("没有时间的回答").locator("time.message-time")).toHaveCount(0);

  const emit = (chunks: unknown[], close = false) => page.evaluate(([items, done]) => (window as unknown as { replyStream: { send: (chunks: unknown[], close?: boolean) => void } }).replyStream.send(items as unknown[], done as boolean), [chunks, close] as const);
  await send(page, "新的问题");
  await expect(article("新的问题").locator("time.message-time")).toHaveText(clockToday);
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { replyStream: { controller: unknown } }).replyStream.controller))).toBe(true);
  const at = new Date().toISOString();
  await emit([{ type: "start", messageId: "live", messageMetadata: { createdAt: at } }, { type: "start-step" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "正在写的回答" }]);
  await expect(article("正在写的回答")).toBeVisible();
  await expect(article("正在写的回答").locator("time.message-time")).toHaveCount(0);
  await emit([{ type: "text-end", id: "t" }, { type: "finish-step" }, { type: "finish", finishReason: "stop", messageMetadata: { createdAt: at } }], true);
  await expect(article("正在写的回答").locator("time.message-time")).toHaveText(clockToday);
});
