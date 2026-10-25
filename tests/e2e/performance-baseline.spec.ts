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
  await openRecentConversations(page);
  started = Date.now();
  await page.getByRole("complementary", { name: "会话列表", exact: true }).getByRole("button", { name: /^长会话甲/ }).click();
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
