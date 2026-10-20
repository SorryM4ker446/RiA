import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";
import { openRecentConversations } from "../helpers/conversations";

const screenshots = join(tmpdir(), "ria-message-navigation-qa");
const now = "2026-10-20T00:00:00Z";
const summary = (id: string) => ({ id, title: id === "a" ? "产品页面设计" : "另一段对话", messageCount: 24, lastMessageAt: now });
const history = (prefix = "a", start = 0, count = 24) => Array.from({ length: count }, (_, offset) => {
  const index = start + offset;
  const question = ["帮我整理一下首页的布局方向", "导航和内容区域应该怎么划分？", "希望页面保持简洁，减少重复的信息", "再完善一下窄屏下的阅读体验"];
  const content = index % 2 === 0 ? `${question[(index / 2) % question.length]} · ${index + 1}`
    : `第 ${index + 1} 段建议\n\n${"保留清楚的层级，让主要操作更容易找到。每个区域只承担必要的内容，细节按需展开。\n\n".repeat(7)}`;
  return { id: `${prefix}-${index}`, clientMessageId: `${prefix}-${index}`, role: index % 2 === 0 ? "user" : "assistant", content, createdAt: now };
});

async function panels(page: Page) {
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" }) }));
  await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [] } }));
  await page.addInitScript(() => localStorage.setItem("chat:last-active-id", "a"));
}

const mark = (page: Page, id: string) => page.locator(`[data-message-mark="${id}"]`);
const anchor = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`);
async function expectLocated(page: Page, id: string) {
  await expect(anchor(page, id)).not.toBeFocused();
  await expect.poll(() => anchor(page, id).evaluate(element => {
    const panel = element.closest(".chat-transcript")!;
    return Math.abs(element.getBoundingClientRect().top - panel.getBoundingClientRect().top - 20);
  })).toBeLessThan(3);
  await expect(anchor(page, id).locator("article")).toHaveCSS("outline-style", "none");
}

test("desktop markers preview and locate messages with mouse and keyboard while scrolling tracks the reader", async ({ page }) => {
  await panels(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [summary("a")] } }));
  await page.route("**/api/conversations/a/messages", route => route.fulfill({ json: { data: history() } }));
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/chat");
  await expect(page).toHaveURL(/\/chat$/); await expect(page).toHaveTitle(/RiA/);
  const nav = page.getByRole("navigation", { name: "当前对话定位" });
  await expect(nav).toBeVisible(); await expect(mark(page, "a-22")).toHaveAttribute("aria-current", "location");
  await expect(page.locator("[data-message-mark]")).toHaveCount(12);
  await expect(mark(page, "a-1")).toHaveCount(0);
  await expect(nav).not.toContainText(/\d+\s*\/\s*\d+/);
  await expect(nav).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(mark(page, "a-22").locator("span")).toHaveCSS("width", "24px");
  await expect(mark(page, "a-20").locator("span")).toHaveCSS("width", "14px");
  const rail = (await nav.boundingBox())!, frame = (await page.locator(".chat-transcript-frame").boundingBox())!;
  expect(rail.x - frame.x).toBeLessThan(16); expect(rail.width).toBeLessThanOrEqual(28); expect(rail.height).toBeLessThanOrEqual(224);
  await mark(page, "a-0").hover();
  const preview = page.locator(".message-nav-preview");
  await expect(preview).toContainText("帮我整理一下首页的布局方向");
  await expect(preview).toContainText("第 2 段建议");
  await expect(preview).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(preview).toHaveCSS("animation-name", "message-preview-in");
  await preview.hover(); await expect(preview).toBeVisible();
  await page.evaluate(() => {
    const nav = document.querySelector('.message-navigator')!;
    const locations: string[] = [];
    const observer = new MutationObserver(() => {
      const id = nav.querySelector<HTMLElement>('[data-message-mark][aria-current="location"]')?.dataset.messageMark;
      if (id) locations.push(id);
    });
    observer.observe(nav, { subtree: true, attributes: true, attributeFilter: ["aria-current"] });
    (window as Window & { finishLocationTrace?: () => string[] }).finishLocationTrace = () => { observer.disconnect(); return locations; };
  });
  await mark(page, "a-0").click(); await expectLocated(page, "a-0");
  const selected = await page.evaluate(() => (window as Window & { finishLocationTrace?: () => string[] }).finishLocationTrace!());
  expect([...new Set(selected)]).toEqual(["a-0"]);
  await mark(page, "a-22").click();
  await page.mouse.move(800, 400); await page.mouse.wheel(0, -600);
  await expect(mark(page, "a-22")).not.toHaveAttribute("aria-current", "location");
  await page.mouse.move(300, 100);
  await expect(preview).toHaveCount(0);
  await mark(page, "a-0").focus(); await page.keyboard.press("ArrowDown");
  await expect(mark(page, "a-2")).toBeFocused();
  await page.keyboard.press("Enter"); await expectLocated(page, "a-2");
  await expect(mark(page, "a-2")).toHaveAttribute("aria-current", "location");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await mark(page, "a-2").focus(); await page.keyboard.press("Home");
  await expect(mark(page, "a-0")).toBeFocused();
  await page.keyboard.press("Escape"); await expect(preview).toHaveCount(0);
  await page.locator(".chat-transcript").evaluate(panel => { panel.scrollTop = panel.scrollHeight; });
  await expect(mark(page, "a-22")).toHaveAttribute("aria-current", "location");
  await page.getByRole("button", { name: "打开对话目录", exact: true }).click();
  const outline = page.getByRole("dialog", { name: "对话目录", exact: true });
  await expect(outline.locator("[data-location-id]")).toHaveCount(12);
  await expect(outline).not.toContainText("按提问定位");
  await expect(outline).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(outline).not.toContainText("第 2 段建议");
  expect((await outline.locator('[data-location-id="a-0"]').boundingBox())!.height).toBeLessThanOrEqual(32);
  await outline.getByRole("button", { name: "定位提问 2：导航和内容区域应该怎么划分？ · 3", exact: true }).click();
  await expect(outline).toBeHidden(); await expectLocated(page, "a-2");
  await mkdir(screenshots, { recursive: true });
  await mark(page, "a-2").hover();
  await expect(preview).toBeVisible();
  await page.screenshot({ path: join(screenshots, "desktop-dark.png"), animations: "disabled" });
  await page.mouse.move(300, 100);
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mark(page, "a-4").click(); await expectLocated(page, "a-4");
  await page.mouse.move(800, 100); await expect(preview).toHaveCount(0);
  await expect(mark(page, "a-4").locator("span")).toHaveCSS("transition-duration", "0s");
  await page.screenshot({ path: join(screenshots, "desktop-light.png"), animations: "disabled" });
  expect(errors).toEqual([]);
  await expect(page.locator("nextjs-portal")).toHaveCount(0);
});

test("narrow screens use a compact outline that preserves the composer and can load earlier messages without losing position", async ({ page }) => {
  await panels(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [summary("a")] } }));
  let olderCalls = 0;
  await page.route(/\/api\/conversations\/a\/messages(?:\?.*)?$/, route => {
    const older = new URL(route.request().url()).searchParams.has("cursor");
    if (older) olderCalls++;
    return route.fulfill({ json: { data: older ? history("a", 0, 10) : history("a", 10, 14), pageInfo: { nextCursor: older ? null : "older", hasMore: !older } } });
  });
  await page.goto("/chat");
  await expect(page.getByRole("navigation", { name: "当前对话定位" })).toBeVisible();
  await expect(page.locator(".message-nav-track")).toBeHidden(); expect(olderCalls).toBe(0);
  const before = (await page.locator(".composer-surface").boundingBox())!;
  await page.getByPlaceholder(/输入你的问题/).fill("保留这份草稿");
  await page.getByRole("button", { name: "打开对话目录", exact: true }).click();
  const outline = page.getByRole("dialog", { name: "对话目录", exact: true });
  await expect(outline.locator("[data-location-id]")).toHaveCount(7);
  const readerBefore = await anchor(page, "a-23").evaluate(element => element.getBoundingClientRect().top);
  await outline.getByRole("button", { name: "加载更早的定位", exact: true }).click();
  await expect(outline.locator("[data-location-id]")).toHaveCount(12); expect(olderCalls).toBe(1);
  expect(await anchor(page, "a-23").evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(readerBefore, 0);
  await outline.getByRole("button", { name: "定位提问 1：帮我整理一下首页的布局方向 · 1", exact: true }).click();
  await expectLocated(page, "a-0");
  await expect(page.getByPlaceholder(/输入你的问题/)).toHaveValue("保留这份草稿");
  const after = (await page.locator(".composer-surface").boundingBox())!;
  expect(after.x).toBe(before.x); expect(after.width).toBe(before.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(screenshots, { recursive: true });
  await page.getByRole("button", { name: "打开对话目录", exact: true }).click();
  await page.screenshot({ path: join(screenshots, "mobile-outline.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "打开对话目录", exact: true })).toBeFocused();
});

test("switching conversations removes old locations during loading and ignores an obsolete older page", async ({ page }) => {
  await panels(page); await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [summary("a"), summary("b")] } }));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  await page.route(/\/api\/conversations\/[^/]+\/messages(?:\?.*)?$/, async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursor")) { entered(); await gate; return route.fulfill({ json: { data: history("stale", 0, 4) } }); }
    const isA = url.pathname.includes("/a/");
    return route.fulfill({ json: { data: history(isA ? "a" : "b", 0, 4), pageInfo: { nextCursor: isA ? "old-a" : null, hasMore: isA } } });
  });
  try {
    await page.goto("/chat"); await expect(mark(page, "a-2")).toBeVisible();
    await page.getByRole("navigation", { name: "当前对话定位" }).getByRole("button", { name: "加载更早的定位", exact: true }).click(); await started;
    await openRecentConversations(page); await page.getByRole("button", { name: /^另一段对话/ }).click();
    await expect(mark(page, "b-2")).toBeVisible(); await expect(mark(page, "a-0")).toHaveCount(0);
    const response = page.waitForResponse(/messages\?cursor=/); release(); await (await response).finished();
    await expect(page.locator("[data-message-mark]")).toHaveCount(2);
    await expect(mark(page, "stale-0")).toHaveCount(0);
    await mark(page, "b-0").click(); await expectLocated(page, "b-0");
  } finally { release(); }
});

test("locating an earlier message during streaming preserves reading position and returning to latest resumes following", async ({ page }) => {
  await panels(page); await page.setViewportSize({ width: 1440, height: 960 });
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [summary("a")] } }));
  await page.route("**/api/conversations/a/messages", route => route.fulfill({ json: { data: history() } }));
  type StreamWindow = Window & { navigationStream: { started: boolean; emit: (chunks: object[], finish?: boolean) => void } };
  await page.addInitScript(() => {
    const original = window.fetch.bind(window), encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = { started: false, emit(chunks: object[], finish = false) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      if (finish) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); }
    } };
    (window as unknown as StreamWindow).navigationStream = stream;
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url, location.href).pathname !== "/api/chat") return original(input, init);
      stream.started = true;
      return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
    };
  });
  await page.goto("/chat"); await expect(mark(page, "a-22")).toBeVisible();
  await page.getByPlaceholder(/输入你的问题/).fill("继续完善这个方案");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as StreamWindow).navigationStream.started)).toBe(true);
  await page.evaluate(() => (window as unknown as StreamWindow).navigationStream.emit([
    { type: "start", messageId: "live-answer" }, { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: "正在继续整理方案。\n\n".repeat(15) },
  ]));
  await expect(anchor(page, "live-answer")).toBeVisible();
  await expect(mark(page, "live-answer")).toHaveCount(0);
  const latestQuestion = page.getByRole("button", { name: /定位提问 13：继续完善这个方案/ });
  await mark(page, "a-2").click(); await expectLocated(page, "a-2");
  const top = await page.locator(".chat-transcript").evaluate(panel => panel.scrollTop);
  await page.evaluate(() => (window as unknown as StreamWindow).navigationStream.emit([{ type: "text-delta", id: "text", delta: "补充更多设计细节。\n\n".repeat(30) }]));
  await expect(page.getByRole("button", { name: "回到最新", exact: true })).toBeVisible();
  expect(await page.locator(".chat-transcript").evaluate(panel => panel.scrollTop)).toBeCloseTo(top, 0);
  await expect(mark(page, "a-2")).toHaveAttribute("aria-current", "location");
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  await expect(latestQuestion).toHaveAttribute("aria-current", "location");
  await page.evaluate(() => (window as unknown as StreamWindow).navigationStream.emit([
    { type: "text-end", id: "text" }, { type: "finish", finishReason: "stop" },
  ], true));
});

test("deleting a located message updates the directory and short or empty conversations do not show a rail", async ({ page }) => {
  await panels(page); await page.setViewportSize({ width: 1440, height: 960 });
  let rows = history("a", 0, 2);
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [summary("a")] } }));
  await page.route("**/api/conversations/a/messages", route => route.fulfill({ json: { data: rows } }));
  await page.route("**/api/conversations/a/messages/*", route => {
    rows = rows.filter(row => !route.request().url().endsWith(`/${row.id}`));
    return route.fulfill({ json: { data: { deleted: true } } });
  });
  await page.goto("/chat");
  await expect(mark(page, "a-0")).toBeVisible();
  await mark(page, "a-0").click();
  await anchor(page, "a-0").getByRole("button", { name: "删除消息", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(anchor(page, "a-0")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "当前对话定位" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "当前对话定位" })).toHaveCount(0);
  rows = []; await page.reload();
  await expect(page.getByRole("heading", { name: "今天，有什么想一起完成？", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "当前对话定位" })).toHaveCount(0);
});
