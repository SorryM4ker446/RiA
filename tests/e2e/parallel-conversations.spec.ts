import { test as base, expect, type Page } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { browserApi, browserData } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";
import { openRecentConversations } from "../helpers/conversations";

/*
 * Answers the service holds: leaving a conversation while it answers leaves
 * the answer running; coming back, or reloading, shows it as it is written;
 * one that ends unseen is unread until opened; stopping is the one thing that
 * ends it early. Against the real service with the offline model, which echoes
 * the prompt; the service writes the answer out word by word, so a long prompt
 * makes an answer that takes several seconds.
 */

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});
test.describe.configure({ timeout: 90_000 });

const LONG = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
const LAST_WORD = "w299";
type Message = { role: string; content: string; status?: string };

async function conversation(page: Page, origin: string, title: string): Promise<string> {
  return (await browserApi(page, `${origin}/api/conversations`, "POST", { title })).body.data.id;
}
const messagesOf = async (page: Page, origin: string, id: string) => (await browserData(page, `${origin}/api/conversations/${id}/messages`)) as Message[];
const summaryOf = async (page: Page, origin: string, id: string) => (await browserData(page, `${origin}/api/conversations/${id}`)) as { answering: boolean; unread: boolean };
const transcript = (page: Page) => page.getByTestId("message-list");
const title = (page: Page) => page.locator(".chat-toolbar h3");
async function send(page: Page, text: string) {
  await page.getByPlaceholder(/输入你的问题/).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}
const row = (sidebar: Awaited<ReturnType<typeof openRecentConversations>>, name: string) => sidebar.getByRole("button", { name: new RegExp(`^${name}`) });

test("an answer keeps being written after leaving its conversation, shows live on return, and is unread until opened", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const first = await conversation(page, app.origin, "第一段");
  await conversation(page, app.origin, "第二段");
  await page.goto(`${app.origin}/chat?conversationId=${first}`);
  await expect(title(page)).toHaveText("第一段");
  const sidebar = await openRecentConversations(page);

  await send(page, LONG);
  await expect(transcript(page)).toContainText("离线回答：w0");
  // Away to the other conversation mid-answer: the first goes on answering.
  await row(sidebar, "第二段").click();
  await expect(title(page)).toHaveText("第二段");
  await expect(row(sidebar, "第一段").locator(".sidebar-chat-dot")).toHaveAttribute("data-state", "working");
  expect((await summaryOf(page, app.origin, first)).answering).toBe(true);

  // Back while it is still being written: it shows as it goes, and can be stopped from here.
  await row(sidebar, "第一段").click();
  await expect(title(page)).toHaveText("第一段");
  await expect(transcript(page)).toContainText("离线回答：w0");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await expect(transcript(page)).toContainText(LAST_WORD, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  // Saved once, whole, by the service.
  await expect.poll(async () => (await messagesOf(page, app.origin, first)).map(message => message.role)).toEqual(["user", "assistant"]);
  expect((await messagesOf(page, app.origin, first))[1].content).toContain(LAST_WORD);
  // Read as it was written, so not unread.
  await expect.poll(async () => (await summaryOf(page, app.origin, first)).unread).toBe(false);

  // An answer that ends while another conversation is open is unread until opened.
  await send(page, LONG);
  await expect(transcript(page)).toContainText("离线回答：w0");
  await row(sidebar, "第二段").click();
  await expect(row(sidebar, "第一段").locator(".sidebar-chat-dot")).toHaveAttribute("data-state", "unread", { timeout: 30_000 });
  await expect(row(sidebar, "第一段")).toHaveAccessibleName(/有新回答/);
  await row(sidebar, "第一段").click();
  await expect(transcript(page)).toContainText(LAST_WORD);
  await expect(row(sidebar, "第一段").locator(".sidebar-chat-dot")).not.toHaveAttribute("data-state", /.+/);
  await expect.poll(async () => (await summaryOf(page, app.origin, first)).unread).toBe(false);
  expect((await messagesOf(page, app.origin, first)).filter(message => message.role === "assistant")).toHaveLength(2);
});

test("stopping asks the service to stop, and what was written is kept once", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const id = await conversation(page, app.origin, "停下来");
  await page.goto(`${app.origin}/chat?conversationId=${id}`);
  await expect(title(page)).toHaveText("停下来");
  await send(page, LONG);
  await expect(transcript(page)).toContainText("离线回答：w0");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect.poll(async () => (await summaryOf(page, app.origin, id)).answering).toBe(false);
  await expect.poll(async () => (await messagesOf(page, app.origin, id)).map(message => message.role)).toEqual(["user", "assistant"]);
  const kept = (await messagesOf(page, app.origin, id))[1].content;
  expect(kept).not.toContain(LAST_WORD);
  // Really stopped: nothing more is written to it afterwards.
  await page.waitForTimeout(1_500);
  expect((await messagesOf(page, app.origin, id))[1].content).toBe(kept);
  // A stopped answer was watched; it is not left unread.
  expect((await summaryOf(page, app.origin, id)).unread).toBe(false);
});

test("a reload mid-answer picks the answer up again, without writing it twice", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const id = await conversation(page, app.origin, "重新载入");
  await page.goto(`${app.origin}/chat?conversationId=${id}`);
  await expect(title(page)).toHaveText("重新载入");
  await send(page, LONG);
  await expect(transcript(page)).toContainText("离线回答：w0");
  await page.reload();
  await expect(title(page)).toHaveText("重新载入");
  await expect(transcript(page)).toContainText("离线回答：w0");
  await expect(transcript(page)).toContainText(LAST_WORD, { timeout: 30_000 });
  await expect.poll(async () => (await messagesOf(page, app.origin, id)).map(message => message.role)).toEqual(["user", "assistant"]);
  await expect(transcript(page).getByText(/离线回答：w0/)).toHaveCount(1);
});

test("a task's run shows in its open conversation as it is written", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const task = (await browserApi(page, `${app.origin}/api/tasks`, "POST", { kind: "prompt", title: "长任务", prompt: "short", cron: "0 9 * * *", timeZone: "UTC" })).body.data;
  // A first run makes the task's conversation; the second, long one is watched.
  await browserApi(page, `${app.origin}/api/tasks/${task.id}/run`, "POST");
  await expect.poll(async () => ((await browserData(page, `${app.origin}/api/tasks`)) as { lastStatus: string | null }[])[0].lastStatus, { timeout: 20_000 }).toBe("done");
  const chatId = ((await browserData(page, `${app.origin}/api/tasks`)) as { chatId: string }[])[0].chatId;
  expect((await browserApi(page, `${app.origin}/api/tasks/${task.id}`, "PATCH", { prompt: LONG })).status).toBe(200);
  await page.goto(`${app.origin}/chat?conversationId=${chatId}`);
  await expect(title(page)).toHaveText("长任务");
  await expect(transcript(page)).toContainText("离线回答：short");

  await browserApi(page, `${app.origin}/api/tasks/${task.id}/run`, "POST");
  // Shown while it is still being written, not only once it is done.
  await expect(transcript(page)).toContainText("离线回答：w0", { timeout: 20_000 });
  expect(await transcript(page).textContent()).not.toContain(LAST_WORD);
  await expect(transcript(page)).toContainText(LAST_WORD, { timeout: 30_000 });
  await expect.poll(async () => ((await browserData(page, `${app.origin}/api/tasks`)) as { lastStatus: string | null }[])[0].lastStatus, { timeout: 20_000 }).toBe("done");
  await expect(transcript(page).getByText(/离线回答：w0/)).toHaveCount(1);
});

test("with every place taken a conversation waits its turn, says so, and answers once one frees", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const settings = await browserData(page, `${app.origin}/api/models`);
  expect((await browserApi(page, `${app.origin}/api/models`, "PUT", { ...settings, callLimits: { ...settings.callLimits, maxConcurrent: 1 } })).status).toBe(200);
  const first = await conversation(page, app.origin, "先来的");
  const second = await conversation(page, app.origin, "后到的");
  await page.goto(`${app.origin}/chat?conversationId=${first}`);
  await expect(title(page)).toHaveText("先来的");
  const sidebar = await openRecentConversations(page);
  await send(page, LONG);
  await expect(transcript(page)).toContainText("离线回答：w0");
  await row(sidebar, "后到的").click();
  await expect(title(page)).toHaveText("后到的");
  await send(page, "排队的问题");
  // Not refused: it waits, says so here and in the sidebar, and can still be stopped.
  await expect(page.getByRole("status").filter({ hasText: /排队中/ })).toBeVisible();
  await expect(row(sidebar, "后到的").locator(".sidebar-chat-dot")).toHaveAttribute("data-state", "queued");
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  // Kept while it waits.
  expect((await messagesOf(page, app.origin, second)).map(message => message.role)).toEqual(["user"]);
  await expect(transcript(page)).toContainText("离线回答：排队的问题", { timeout: 40_000 });
  await expect.poll(async () => (await messagesOf(page, app.origin, second)).map(message => message.role)).toEqual(["user", "assistant"]);
  await expect.poll(async () => (await messagesOf(page, app.origin, first)).at(-1)?.content ?? "").toContain(LAST_WORD);
});

test("a message written while the answer is coming waits in the queue and is sent when it ends", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const id = await conversation(page, app.origin, "排队发送");
  await page.goto(`${app.origin}/chat?conversationId=${id}`);
  await expect(title(page)).toHaveText("排队发送");
  await send(page, LONG);
  await expect(transcript(page)).toContainText("离线回答：w0");
  const queue = page.getByRole("list", { name: "排队中的消息", exact: true });
  // Enter queues it while the answer is still coming; the button does the same.
  const input = page.getByPlaceholder(/输入你的问题/);
  await input.fill("接着问的问题");
  await input.press("Enter");
  await expect(queue.getByText("接着问的问题", { exact: true })).toBeVisible();
  await input.fill("不要了的问题");
  await page.getByRole("button", { name: "排队发送", exact: true }).click();
  await expect(queue.getByText("不要了的问题", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("");
  await queue.getByRole("listitem").filter({ hasText: "不要了的问题" }).getByRole("button", { name: "移除这条排队的消息", exact: true }).click();
  await expect(queue.getByText("不要了的问题", { exact: true })).toHaveCount(0);
  // The answer ends; the queued message goes by itself, in order, and the queue empties.
  await expect(transcript(page)).toContainText("离线回答：接着问的问题", { timeout: 40_000 });
  await expect(queue).toHaveCount(0);
  await expect.poll(async () => (await messagesOf(page, app.origin, id)).map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect((await messagesOf(page, app.origin, id)).some(message => message.content.includes("不要了的问题"))).toBe(false);
});

