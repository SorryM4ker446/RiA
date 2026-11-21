import { test as base, expect } from "@playwright/test";
import { chatTitle } from "../helpers/chat-header";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";
import { settingsDialog } from "../helpers/settings";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});

test("without a model the home page offers to add one instead of a box that cannot send", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/`);
  const note = page.getByRole("note");
  await expect(note).toContainText("先添加一个模型");
  await expect(page.getByRole("textbox", { name: "快速提问", exact: true })).toHaveCount(0);
  await note.getByRole("button", { name: "添加模型", exact: true }).click();
  await expect(settingsDialog(page).getByRole("tab", { name: "模型", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("the quick ask starts a new conversation and sends the question there", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await browserApi(page, "/api/conversations", "POST", { title: "以前的会话" });
  await page.goto(`${app.origin}/`);
  const ask = page.getByRole("textbox", { name: "快速提问", exact: true });
  await ask.fill("从首页问的问题");
  // Typing alone creates nothing.
  expect(await browserData(page, "/api/conversations")).toHaveLength(1);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await ask.press("Enter");
  await expect(page).toHaveURL(/\/chat/);
  await expect(page.getByText("离线回答：从首页问的问题", { exact: true })).toBeVisible();
  await expect(chatTitle(page)).not.toHaveText("以前的会话");
  await expect.poll(async () => (await browserData(page, "/api/conversations")).length).toBe(2);
  // It went to the new conversation, not the one opened before.
  const older = (await browserData(page, "/api/conversations")).find((chat: { title: string }) => chat.title === "以前的会话");
  expect(older.messageCount ?? 0).toBe(0);
  expect(errors).toEqual([]);
});

test("a question asked on the home page arrives as a message at once, without showing the last conversation or an empty one on the way", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  // A conversation with an answer in it, and the one chat would return to.
  await page.goto(`${app.origin}/chat`);
  await page.locator(".composer-input").fill("旧问题");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const transcript = page.getByTestId("message-list");
  await expect(transcript.getByText("离线回答：旧问题", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "首页", exact: true }).click();
  const ask = page.getByRole("textbox", { name: "快速提问", exact: true });
  await ask.fill("新问题");
  // Everything the transcript shows from here on is recorded as it changes, not only where it ends up.
  await page.evaluate(() => {
    const seen = { earlier: false, welcome: false, questionRows: 0, questionBeforeAnswer: false };
    const rows = new Set<Element>();
    (window as unknown as { transcriptSeen: typeof seen }).transcriptSeen = seen;
    new MutationObserver(() => {
      const list = document.querySelector('[data-testid="message-list"]');
      if (list?.textContent?.includes("离线回答：旧问题")) seen.earlier = true;
      if (document.querySelector(".chat-welcome")) seen.welcome = true;
      // The question is one row from the moment the page opens: the message that arrives takes that row over.
      const row = [...list?.querySelectorAll('[data-message-role="user"]') ?? []].find(element => element.textContent?.includes("新问题"));
      if (row) { rows.add(row); seen.questionRows = rows.size; if (!list?.textContent?.includes("离线回答：新问题")) seen.questionBeforeAnswer = true; }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  // The input can accept text before the model is loaded and the form can submit.
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
  await ask.press("Enter");
  await expect(page).toHaveURL(/\/chat/);
  await expect(transcript.getByText("离线回答：新问题", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { transcriptSeen: unknown }).transcriptSeen)).toEqual({ earlier: false, welcome: false, questionRows: 1, questionBeforeAnswer: true });
  // The earlier conversation is still there to go back to.
  expect(await browserData(page, "/api/conversations")).toHaveLength(2);
});

test("home says in one line what waits on you and what the tasks still do, shows recent conversations and the day's tasks, each leading to its place", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  for (const title of ["周报草稿", "读书笔记", "旅行清单"]) await browserApi(page, "/api/conversations", "POST", { title });
  const chats = await browserData(page, "/api/conversations") as Array<{ id: string; title: string }>;
  const travel = chats.find(chat => chat.title === "旅行清单")!;
  // Fixed times of today, so the order of the day does not depend on when the test runs.
  const at = (hours: number, minutes = 0) => { const time = new Date(); time.setHours(hours, minutes, 0, 0); return time; };
  const morning = at(8), noon = at(12), evening = at(21, 30);
  const task = (id: string, title: string, extra: Record<string, unknown>) => ({
    id, kind: "prompt", title, prompt: `${title}。`, template: null, enabled: true, cron: "0 9 * * *", timeZone: "UTC", chatId: null,
    nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null, catchUp: false, model: null, workspaceGrantId: null,
    approvalRule: "default", usesMemory: false, notify: "important", reasoningEffort: null, ...extra,
  });
  await page.route("**/api/tasks", route => route.fulfill({ json: { data: [
    task("t-evening", "晚间整理", { nextRunAt: evening.toISOString() }),
    task("t-noon", "午间汇总", { lastRunAt: noon.toISOString(), lastStatus: "done" }),
    task("t-failed", "同步日程", { lastRunAt: morning.toISOString(), lastStatus: "failed", lastError: "日历服务没有响应", chatId: travel.id }),
    task("t-tomorrow", "明天的事", { nextRunAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }),
  ], automaticExecution: true } }));
  await page.route("**/api/notices", route => route.fulfill({ json: { data: { unread: 1, notices: [
    { id: "n1", kind: "task", title: "备份已完成", detail: "保存了 3 个会话。", href: null, createdAt: new Date().toISOString(), readAt: null },
  ] } } }));
  await page.goto(`${app.origin}/`);

  // One sentence says what waits on you and what the tasks still have to do; the items open from it.
  const waiting = page.getByRole("button", { name: "2 件事等你处理", exact: true });
  await expect(page.locator(".home-summary")).toContainText("今天还有 1 个任务");
  await waiting.click();
  const list = page.getByRole("dialog", { name: "需要你处理", exact: true });
  await expect(list.getByRole("button", { name: /同步日程/ })).toContainText("日历服务没有响应");
  await expect(list.getByRole("button", { name: /备份已完成/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // Today's tasks are one line at the foot of the page, in the order of the day.
  const day = page.getByRole("region", { name: "今天", exact: true });
  const items = day.locator(".home-day-item");
  await expect(items.nth(0)).toContainText("同步日程");
  await expect(items.filter({ hasText: "午间汇总" }).getByLabel("已完成")).toBeVisible();
  await expect(items.filter({ hasText: "晚间整理" })).toBeVisible();
  await expect(day).not.toContainText("明天的事");

  const recent = page.getByRole("navigation", { name: "最近的会话", exact: true });
  await expect(recent.locator(".home-pill")).toHaveCount(3);
  // The question box sits at the page's centre, whatever the lines above and below it hold.
  const middle = async (selector: string) => { const box = (await page.locator(selector).boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  const [boxMiddle, pageMiddle] = [await middle(".home-ask"), await middle("main.home")];
  expect(Math.abs(boxMiddle.x - pageMiddle.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxMiddle.y - pageMiddle.y)).toBeLessThanOrEqual(1);
  // A failed task leads to its conversation.
  await waiting.click();
  await list.getByRole("button", { name: /同步日程/ }).click();
  await expect(page).toHaveURL(/\/chat/);
  await expect(chatTitle(page)).toHaveText("旅行清单");
});
