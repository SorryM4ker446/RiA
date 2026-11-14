import { test as base, expect, type Page } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi } from "../helpers/browser-api";
import { openRecentConversations } from "../helpers/conversations";

/**
 * The performance baseline: how long everyday interactions take on this
 * machine, and how much main-thread blocking they cause. Run on demand with
 * `npm run test:perf`; the numbers are printed and attached to the report so
 * they can be compared before and after a change. Only gross failures fail.
 */
const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});
test.use({ viewport: { width: 1280, height: 800 } });

async function longConversation(page: Page, title: string, count: number) {
  const chat = (await browserApi(page, "/api/conversations", "POST", { title })).body.data;
  for (let index = 0; index < count; index++) {
    const content = index % 2
      ? `## ${title} 第 ${index} 段\n\n${"这是一段用于测量渲染的回答内容，包含**强调**、\`代码\`和列表。".repeat(4)}\n\n- 第一点\n- 第二点\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``
      : `${title} 的第 ${index} 个问题？`;
    await browserApi(page, `/api/conversations/${chat.id}/messages`, "POST", { role: index % 2 ? "assistant" : "user", content, status: "success" });
  }
  return chat.id as string;
}

/** Starts counting main-thread tasks over 50ms; returns a reader of their total and longest. */
async function watchLongTasks(page: Page) {
  await page.evaluate(() => {
    const state = { total: 0, longest: 0, count: 0 };
    (window as unknown as { longTasks: typeof state }).longTasks = state;
    new PerformanceObserver(list => { for (const entry of list.getEntries()) { state.total += entry.duration; state.longest = Math.max(state.longest, entry.duration); state.count++; } }).observe({ type: "longtask" });
  });
  return () => page.evaluate(() => ({ ...(window as unknown as { longTasks: { total: number; longest: number; count: number } }).longTasks }));
}

test("everyday interactions on long conversations @perf", async ({ page, app }, info) => {
  test.setTimeout(600_000);
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await longConversation(page, "长会话甲", 300);
  await longConversation(page, "长会话乙", 300);
  const results: Record<string, unknown> = {};

  // Opening chat on a 300-message conversation, from navigation to its last message on screen.
  await page.goto(`${app.origin}/tasks`);
  const longTasks = await watchLongTasks(page);
  let started = Date.now();
  await page.getByRole("navigation", { name: "工作区导航" }).getByRole("link", { name: "聊天", exact: true }).click();
  await expect(page.getByText("长会话乙 第 299 段", { exact: true })).toBeVisible({ timeout: 60_000 });
  results.openLongConversationMs = Date.now() - started;
  results.openLongTasks = await longTasks();

  // Switching to the other long conversation.
  const sidebar = await openRecentConversations(page);
  started = Date.now();
  await sidebar.getByRole("button", { name: /^长会话甲/ }).click();
  await expect(page.getByText("长会话甲 第 299 段", { exact: true })).toBeVisible({ timeout: 60_000 });
  results.switchLongConversationMs = Date.now() - started;

  // Typing: from each key press to the frame that shows it.
  const composer = page.getByPlaceholder(/输入你的问题/);
  await composer.click();
  const latencies = await composer.evaluate(async node => {
    const area = node as HTMLTextAreaElement;
    const samples: number[] = [];
    for (let index = 0; index < 40; index++) {
      const start = performance.now();
      area.value += "字";
      area.dispatchEvent(new InputEvent("input", { bubbles: true, data: "字", inputType: "insertText" }));
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { median: samples[Math.floor(samples.length / 2)], p95: samples[Math.floor(samples.length * 0.95)] };
  });
  results.typingFrameMs = latencies;

  // Opening the command palette.
  started = Date.now();
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("combobox", { name: "命令面板" })).toBeVisible();
  results.openPaletteMs = Date.now() - started;
  await page.keyboard.press("Escape");

  console.log(`Performance baseline: ${JSON.stringify(results, null, 2)}`);
  await info.attach("performance.json", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  // Only a gross regression fails; the numbers are for comparison.
  expect(results.openLongConversationMs as number).toBeLessThan(30_000);
});

/** Answers each chat request with `text`, `size` characters every `everyMs`, the way a model streams at a steady pace. */
async function scriptedStream(page: Page, text: string, size: number, everyMs: number) {
  await page.addInitScript(({ text, size, everyMs }) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!new URL(url, location.href).pathname.endsWith("/api/chat")) return original(input, init);
      const encoder = new TextEncoder();
      const send = (chunk: object) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(send({ type: "start", messageId: `streamed-${Date.now()}` }));
          controller.enqueue(send({ type: "text-start", id: "answer" }));
          for (let offset = 0; offset < text.length; offset += size) {
            controller.enqueue(send({ type: "text-delta", id: "answer", delta: text.slice(offset, offset + size) }));
            await new Promise(resolve => setTimeout(resolve, everyMs));
          }
          controller.enqueue(send({ type: "text-end", id: "answer" }));
          controller.enqueue(send({ type: "finish", finishReason: "stop" }));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
    };
  }, { text, size, everyMs });
}

test("a long answer streams with its words fading in, on a slowed processor @perf", async ({ page, app }, info) => {
  test.setTimeout(600_000);
  const paragraph = (index: number) => `第 ${index + 1} 段：先把最要紧的放在前面，再按截止时间排好顺序。Keep the **main action** easy to find, and let details unfold on demand. 每一项都写了预计用时，方便安排日程。`;
  const answer = ["## 计划", ...Array.from({ length: 24 }, (_, index) => index % 6 === 5 ? `- 要点一：${paragraph(index)}\n- 要点二：保持层级清楚。` : paragraph(index))].join("\n\n");
  await scriptedStream(page, answer, 4, 16);
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const cdp = await page.context().newCDPSession(page);
  const results: Record<string, unknown> = { characters: answer.length };
  for (const motion of ["fading", "reduced"] as const) {
    await page.emulateMedia({ reducedMotion: motion === "reduced" ? "reduce" : "no-preference" });
    await browserApi(page, "/api/conversations", "POST", { title: `流式 ${motion}` });
    await page.goto(`${app.origin}/chat`);
    const composer = page.getByPlaceholder(/输入你的问题/);
    await composer.fill("给我一份计划");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const longTasks = await watchLongTasks(page);
    // Frames: the gaps between painted frames while the answer is written.
    await page.evaluate(() => {
      const state = { frames: 0, over50: 0, longest: 0, running: true };
      (window as unknown as { frameGaps: typeof state }).frameGaps = state;
      let last = performance.now();
      const tick = (now: number) => { const gap = now - last; last = now; state.frames++; if (gap > 50) state.over50++; state.longest = Math.max(state.longest, gap); if (state.running) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const started = Date.now();
    await composer.press("Enter");
    await expect(page.getByText(/第 24 段：/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible({ timeout: 120_000 });
    const elapsedMs = Date.now() - started;
    const frames = await page.evaluate(() => { const state = (window as unknown as { frameGaps: { frames: number; over50: number; longest: number; running: boolean } }).frameGaps; state.running = false; return { frames: state.frames, over50: state.over50, longest: Math.round(state.longest) }; });
    results[motion] = { elapsedMs, frames, longTasks: await longTasks() };
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    // The finished answer drops its word spans once the last word has faded in.
    await expect(page.locator(".stream-word")).toHaveCount(0);
  }
  console.log(`Streaming baseline: ${JSON.stringify(results, null, 2)}`);
  await info.attach("streaming.json", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  // Only a gross regression fails: no single frame may freeze the page for a second.
  for (const motion of ["fading", "reduced"]) expect((results[motion] as { frames: { longest: number } }).frames.longest).toBeLessThan(1000);
});
