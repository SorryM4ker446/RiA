import { openExecutionDetails } from "../helpers/execution-records";
import { openRecentConversations } from "../helpers/conversations";
import { chooseMenuAction } from "../helpers/row-menu";
import { acceptConfirm } from "../helpers/confirm";
import { test as base, expect, type Page } from "@playwright/test";
import { NO_CREDENTIAL_STATE, openWorkspace } from "../helpers/workspace-entry";
import { randomUUID } from "node:crypto";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";
import { decodePersistedAssistantToolMessage } from "../../src/lib/ai/ui-message";
import { chooseFromSlashMenu, composerInput, newTask } from "../helpers/slash-menu";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

async function register(page: Page, origin: string) {
  // The workspace has no login: the run's access cookie is already active.
  await openWorkspace(page, origin);
}

test("streamed chat, follow-up context and edited regeneration survive a service restart", { tag: "@integration" }, async ({ page, browser, app }) => {
  await register(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await expect(page.getByRole("checkbox", { name: "仅手动", exact: true })).toHaveCount(0);
  const send = async (text: string) => {
    await page.getByPlaceholder(/输入你的问题/).fill(text);
    const response = page.waitForResponse((response) => response.url() === `${app.origin}/api/chat`);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const stream = await response;
    expect(stream.status()).toBe(200);
    await expect(page.getByText(`离线回答：${text}`, { exact: true })).toBeVisible();
  };
  await send("第一轮问题");
  const chats = await browserData(page, `${app.origin}/api/conversations`);
  const chatId = chats[0].id;
  const historyURL = `${app.origin}/api/conversations/${chatId}/messages`;
  const history = () => browserData(page, historyURL);
  await expect.poll(async () => (await history()).length).toBe(2);
  await send("继续解释上一轮");
  await expect.poll(async () => (await history()).length).toBe(4);
  const calls = app.providerCalls.filter((call) => call.stream);
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(calls[1].messages)).toContain("离线回答：第一轮问题");
  expect(calls[1].messages.some((message) => message.role === "assistant")).toBe(true);
  expect(app.readRows("SELECT role, status FROM messages WHERE chatId = ?", chatId)).toHaveLength(4);

  await page.reload();
  await expect(page.getByText("离线回答：继续解释上一轮", { exact: true })).toBeVisible();
  const firstTurn = page.locator("article").filter({ has: page.getByText("第一轮问题", { exact: true }) });
  await firstTurn.hover();
  await firstTurn.getByRole("button", { name: "编辑消息" }).click();
  const editor = page.locator("article").filter({ has: page.locator("textarea") });
  await editor.locator("textarea").fill("修改后的问题");
  // A later turn follows it, so it goes out again at the end and the rest stays.
  await editor.getByRole("button", { name: "重新发送", exact: true }).click();
  await expect(page.getByText("离线回答：修改后的问题", { exact: true })).toBeVisible();
  const transcript = ["第一轮问题", "离线回答：第一轮问题", "继续解释上一轮", "离线回答：继续解释上一轮", "修改后的问题", "离线回答：修改后的问题"];
  await expect.poll(async () => (await history()).map((row: { content: string }) => decodePersistedAssistantToolMessage(row.content)?.text ?? row.content)).toEqual(transcript);
  const savedAnswer = (await history()).filter((row: { role: string }) => row.role === "assistant").at(-1);
  expect(app.readRows("SELECT status FROM messages WHERE chatId = ?", chatId)).toEqual(transcript.map(() => ({ status: "success" })));

  await app.restart();
  await page.reload();
  await expect(page.getByText("离线回答：修改后的问题", { exact: true })).toBeVisible();
  await expect(page.getByText("离线回答：第一轮问题", { exact: true })).toBeVisible();
  expect((await browserApi(page, `${app.origin}/api/conversations`)).status).toBe(200);
  const stranger = await browser.newContext({ storageState: NO_CREDENTIAL_STATE });
  try {
    // Without the local credential no request reaches the stored workspace.
    expect((await stranger.request.get(historyURL)).status()).toBe(401);
    const otherPage = await stranger.newPage();
    await otherPage.goto(`${app.origin}/chat`);
    expect((await browserApi(otherPage, historyURL)).status).toBe(401);
    expect((await browserApi(otherPage, `${app.origin}/api/conversations/${chatId}`, "DELETE")).status).toBe(401);
    expect((await browserApi(otherPage, `${app.origin}/api/conversations`)).status).toBe(401);
  } finally { await stranger.close(); }
  expect((await history()).length).toBe(transcript.length);

  // With only its own answer below it, the latest message is answered again where it is.
  const latestTurn = page.locator("article").filter({ has: page.getByText("修改后的问题", { exact: true }) });
  await latestTurn.hover();
  await latestTurn.getByRole("button", { name: "编辑消息" }).click();
  const latestEditor = page.locator("article").filter({ has: page.locator("textarea") });
  await latestEditor.locator("textarea").fill("再改一次");
  await latestEditor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("离线回答：再改一次", { exact: true })).toBeVisible();
  await expect.poll(async () => (await history()).map((row: { content: string }) => decodePersistedAssistantToolMessage(row.content)?.text ?? row.content)).toEqual([...transcript.slice(0, 4), "再改一次", "离线回答：再改一次"]);
});

test("tasks and knowledge use real APIs, persist across restart and remain private", { tag: "@integration" }, async ({ page, browser, app }) => {
  await register(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  expect((await browserApi(page, `${app.origin}/api/tasks`, "POST", newTask("浏览器持久化任务"))).status).toBe(201);
  await page.goto(`${app.origin}/tasks`);
  const taskRow = page.getByTestId("task-item").filter({ hasText: "浏览器持久化任务" });
  await expect(taskRow).toContainText("已暂停");
  const task = (await browserData(page, `${app.origin}/api/tasks`))[0];
  await chooseMenuAction(page, "浏览器持久化任务", "启用");
  await expect(taskRow).toContainText("已安排");
  expect(app.readRows("SELECT title, enabled FROM scheduled_jobs WHERE id = ?", task.id)).toEqual([{ title: "浏览器持久化任务", enabled: 1 }]);

  await page.getByRole("link", { name: /知识库/ }).click();
  await page.getByRole("button", { name: "新增条目", exact: true }).click();
  await page.getByPlaceholder("条目名称").fill("月光档案");
  await page.getByPlaceholder("条目内容").fill("月光档案保存在本地 SQLite。");
  await page.getByRole("dialog", { name: "新增条目", exact: true }).getByRole("button", { name: "新增条目", exact: true }).click();
  await expect(page.getByRole("heading", { name: "月光档案", exact: true })).toBeVisible();
  const entry = (await browserData(page, `${app.origin}/api/knowledge`))[0];
  await page.getByRole("button", { name: "新增条目", exact: true }).click();
  await page.getByPlaceholder("条目名称").fill("月光档案");
  await page.getByPlaceholder("条目内容").fill("月光档案更新后仍然只有一份。");
  await page.getByRole("dialog", { name: "新增条目", exact: true }).getByRole("button", { name: "新增条目", exact: true }).click();
  await expect(page.locator("article").getByText("月光档案更新后仍然只有一份。", { exact: true })).toBeVisible();
  await expect.poll(() => app.readRows("SELECT id, value FROM memories WHERE key = ?", "月光档案")).toEqual([{ id: entry.id, value: "月光档案更新后仍然只有一份。" }]);
  await page.getByRole("navigation", { name: "工作区导航" }).getByRole("link", { name: "聊天", exact: true }).click();
  await chooseFromSlashMenu(page, "知识检索");
  await composerInput(page).fill("OFFLINE_SEARCH_KNOWLEDGE 月光档案");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message-choices").getByText("知识检索", { exact: true })).toBeVisible();
  const chats = await browserData(page, `${app.origin}/api/conversations`);
  const chatId = chats[0].id;
  await expect.poll(() => app.readRows("SELECT id FROM messages WHERE chatId = ?", chatId).length).toBe(2);
  await openRecentConversations(page);
  await page.getByRole("button", { name: /^会话操作：/ }).first().click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByRole("textbox", { name: "重命名", exact: true }).fill("真实业务记录");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "真实业务记录", exact: true })).toBeVisible();
  await app.restart();
  await page.reload();
  await expect(page.getByRole("heading", { name: "真实业务记录", exact: true })).toBeVisible();
  await openExecutionDetails(page);
  await expect(page.getByText(/工具详情：searchKnowledge/)).toBeVisible();
  await page.goto(`${app.origin}/tasks`);
  await expect(taskRow).toContainText("已安排");

  const stranger = await browser.newContext({ storageState: NO_CREDENTIAL_STATE });
  try {
    // The workspace is local, so it is the credential — not a second account —
    // that decides whether a request is served at all.
    for (const path of ["tasks", "knowledge"]) {
      expect((await stranger.request.get(`${app.origin}/api/${path}`)).status()).toBe(401);
    }
    expect((await stranger.request.patch(`${app.origin}/api/tasks/${task.id}`, { data: { enabled: false } })).status()).toBe(401);
    expect((await stranger.request.delete(`${app.origin}/api/knowledge/${entry.id}`)).status()).toBe(401);
  } finally { await stranger.close(); }
  // The refused calls changed nothing.
  expect(app.readRows("SELECT enabled FROM scheduled_jobs WHERE id = ?", task.id)).toEqual([{ enabled: 1 }]);
  expect(app.readRows("SELECT id FROM memories WHERE id = ?", entry.id)).toHaveLength(1);
  await page.goto(`${app.origin}/tasks`);
  await chooseMenuAction(page, "浏览器持久化任务", "删除");
  await acceptConfirm(page, "删除这个任务？");
  await expect.poll(() => app.readRows("SELECT id FROM scheduled_jobs WHERE id = ?", task.id).length).toBe(0);
  await page.getByRole("link", { name: /知识库/ }).click();
  await expect(page.getByText("月光档案更新后仍然只有一份。", { exact: true })).toBeVisible();
  await chooseMenuAction(page, "月光档案", "删除条目 月光档案");
  await expect.poll(() => app.readRows("SELECT id FROM memories WHERE id = ?", entry.id).length).toBe(0);
  await page.getByRole("navigation", { name: "工作区导航" }).getByRole("link", { name: "聊天", exact: true }).click();
  await openRecentConversations(page);
  await page.getByRole("button", { name: /^会话操作：/ }).first().click();
  await page.getByRole("menuitem", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect.poll(() => app.readRows("SELECT id FROM messages WHERE chatId = ?", chatId).length).toBe(0);
  expect((await browserApi(page, `${app.origin}/api/conversations/${chatId}`)).status).toBe(404);
  await page.reload();
  await expect(page.getByRole("heading", { name: "真实业务记录", exact: true })).toHaveCount(0);
  await page.goto(`${app.origin}/tasks`);
  await expect(page.getByTestId("task-item").filter({ hasText: "浏览器持久化任务" })).toHaveCount(0);
});
