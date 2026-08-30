import { test as base, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

async function register(page: Page, origin: string) {
  await page.goto(`${origin}/register`);
  await page.getByPlaceholder("邮箱", { exact: true }).fill(`${randomUUID()}@example.invalid`);
  await page.getByPlaceholder("密码（至少 8 位）").fill(randomUUID());
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page).toHaveURL(`${origin}/chat`);
}

test("streamed chat, follow-up context and edited regeneration survive a service restart", { tag: "@integration" }, async ({ page, browser, app }) => {
  await register(page, app.origin);
  await page.getByRole("checkbox").check();
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
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("离线回答：修改后的问题", { exact: true })).toBeVisible();
  await expect.poll(async () => (await history()).map((row: { content: string }) => row.content)).toEqual(["修改后的问题", "离线回答：修改后的问题"]);
  expect(app.readRows("SELECT status FROM messages WHERE chatId = ?", chatId)).toEqual([{ status: "success" }, { status: "success" }]);

  await app.restart();
  await page.reload();
  await expect(page.getByText("离线回答：修改后的问题", { exact: true })).toBeVisible();
  await expect(page.getByText("离线回答：第一轮问题", { exact: true })).toHaveCount(0);
  expect((await browserApi(page, `${app.origin}/api/auth/me`)).status).toBe(200);
  const stranger = await browser.newContext();
  try {
    expect((await stranger.request.get(historyURL)).status()).toBe(401);
    const otherPage = await stranger.newPage();
    await register(otherPage, app.origin);
    expect((await browserApi(otherPage, historyURL)).status).toBe(404);
    expect((await browserApi(otherPage, `${app.origin}/api/conversations/${chatId}`, "DELETE")).status).toBe(404);
    expect(await browserData(otherPage, `${app.origin}/api/conversations`)).toEqual([]);
  } finally { await stranger.close(); }
  expect((await history()).length).toBe(2);
});

test("manual tasks and knowledge use real APIs, persist across restart and remain private", { tag: "@integration" }, async ({ page, browser, app }) => {
  await register(page, app.origin);
  await page.getByLabel("选择手动工具").click();
  await page.getByRole("option", { name: "手动：创建任务" }).click();
  await page.getByPlaceholder(/输入任务标题/).fill("浏览器持久化任务");
  await page.getByRole("button", { name: "执行工具" }).click();
  const taskPanel = page.getByTestId("task-panel");
  await expect(taskPanel.getByText("浏览器持久化任务", { exact: true })).toBeVisible();
  const task = (await browserData(page, `${app.origin}/api/tasks`))[0];
  await page.getByLabel("任务状态 浏览器持久化任务").click();
  await page.getByRole("option", { name: "已完成", exact: true }).click();
  await expect.poll(async () => (await browserData(page, `${app.origin}/api/tasks/${task.id}`)).status).toBe("done");
  expect(app.readRows("SELECT title, status FROM tasks WHERE id = ?", task.id)).toEqual([{ title: "浏览器持久化任务", status: "done" }]);

  await page.getByRole("link", { name: /知识库/ }).click();
  await page.getByPlaceholder("知识标题").fill("月光档案");
  await page.getByPlaceholder("知识内容").fill("月光档案保存在本地 SQLite。");
  await page.getByRole("button", { name: "新增知识" }).click();
  await expect(page.getByRole("heading", { name: "月光档案", exact: true })).toBeVisible();
  const entry = (await browserData(page, `${app.origin}/api/knowledge`))[0];
  await page.getByPlaceholder("知识标题").fill("月光档案");
  await page.getByPlaceholder("知识内容").fill("月光档案更新后仍然只有一份。");
  await page.getByRole("button", { name: "新增知识" }).click();
  await expect(page.locator("article").getByText("月光档案更新后仍然只有一份。", { exact: true })).toBeVisible();
  await expect.poll(() => app.readRows("SELECT id, value FROM memories WHERE key = ?", "月光档案")).toEqual([{ id: entry.id, value: "月光档案更新后仍然只有一份。" }]);
  await page.getByRole("link", { name: /返回聊天/ }).click();
  await page.getByLabel("选择手动工具").click();
  await page.getByRole("option", { name: "手动：知识检索" }).click();
  await page.getByPlaceholder(/输入要检索的关键词/).fill("月光档案");
  const toolResponse = page.waitForResponse((response) => response.url() === `${app.origin}/api/tools/run`);
  await page.getByRole("button", { name: "执行工具" }).click();
  const result = await (await toolResponse).json();
  expect(result.data.results.some((item: { id: string; snippet: string }) => item.id === entry.id && item.snippet.includes("更新后仍然只有一份"))).toBe(true);
  const chats = await browserData(page, `${app.origin}/api/conversations`);
  const chatId = chats[0].id;
  await expect.poll(() => app.readRows("SELECT id FROM messages WHERE chatId = ?", chatId).length).toBe(4);
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  await page.locator("aside input").fill("真实业务记录");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "真实业务记录", exact: true })).toBeVisible();
  await app.restart();
  await page.reload();
  await expect(page.getByRole("heading", { name: "真实业务记录", exact: true })).toBeVisible();
  await expect(taskPanel.getByText("已完成", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/工具详情：searchKnowledge/)).toBeVisible();

  const stranger = await browser.newContext();
  try {
    const otherPage = await stranger.newPage();
    await register(otherPage, app.origin);
    for (const path of ["tasks", "knowledge"]) {
      expect(await browserData(otherPage, `${app.origin}/api/${path}`)).toEqual([]);
    }
    expect((await browserApi(otherPage, `${app.origin}/api/tasks/${task.id}`, "PATCH", { status: "todo" })).status).toBe(404);
    expect((await browserApi(otherPage, `${app.origin}/api/knowledge/${entry.id}`, "DELETE")).status).toBe(404);
  } finally { await stranger.close(); }
  await page.getByLabel("删除任务 浏览器持久化任务").click();
  await expect.poll(() => app.readRows("SELECT id FROM tasks WHERE id = ?", task.id).length).toBe(0);
  await page.getByRole("link", { name: /知识库/ }).click();
  await expect(page.getByText("月光档案更新后仍然只有一份。", { exact: true })).toBeVisible();
  await page.getByLabel("删除知识 月光档案").click();
  await expect.poll(() => app.readRows("SELECT id FROM memories WHERE id = ?", entry.id).length).toBe(0);
  await page.getByRole("link", { name: /返回聊天/ }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect.poll(() => app.readRows("SELECT id FROM messages WHERE chatId = ?", chatId).length).toBe(0);
  expect((await browserApi(page, `${app.origin}/api/conversations/${chatId}`)).status).toBe(404);
  await page.reload();
  await expect(page.getByRole("heading", { name: "真实业务记录", exact: true })).toHaveCount(0);
  await expect(taskPanel.getByText("浏览器持久化任务", { exact: true })).toHaveCount(0);
});
