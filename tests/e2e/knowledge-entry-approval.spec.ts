import { expect, test as base, type Page } from "@playwright/test";
import { trackChatStreams, waitForChatStream } from "../helpers/chat-stream";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";

type App = Awaited<ReturnType<typeof startStandaloneServer>>;
const test = base.extend<{ app: App }>({ app: async ({}, provide) => {
  const runtime = await startStandaloneServer({ modelFixture: true });
  try { await provide(runtime); } finally { await runtime.close(); }
} });

async function propose(page: Page, app: App, key: string, value: string) {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "知识条目" })).body.data;
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await page.getByPlaceholder(/输入你的问题/).fill(`OFFLINE_SAVE_ENTRY KEY=${key} VALUE=${value}`);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const card = page.getByRole("region", { name: "操作审批", exact: true });
  await expect(card.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  await trackChatStreams(page);
  return card;
}
const entries = async (page: Page) => (await browserData(page, "/api/knowledge")) as { key: string; value: string }[];

test("saving under an existing key shows the text it replaces, and approving replaces that entry", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  expect((await browserApi(page, "/api/knowledge", "POST", { key: "投影仪遥控器", value: "放在前台抽屉。" })).status).toBe(201);
  const card = await propose(page, app, "投影仪遥控器", "现在放在行政室。");
  await expect(card.getByText("保存知识条目", { exact: true })).toBeVisible();
  await expect(card.getByText("替换条目：投影仪遥控器", { exact: true })).toBeVisible();
  // What is being replaced is shown without opening the details.
  const text = page.getByLabel("待保存的条目内容", { exact: true });
  await expect(text.locator('[data-diff-line="removed"]')).toHaveText("- 放在前台抽屉。");
  await expect(text.locator('[data-diff-line="added"]')).toHaveText("+ 现在放在行政室。");
  expect((await entries(page)).filter(entry => entry.key.startsWith("投影仪遥控器")).map(entry => entry.value)).toEqual(["放在前台抽屉。"]);

  await card.getByRole("button", { name: "批准", exact: true }).click();
  await waitForChatStream(page);
  await expect(card).toBeHidden();
  await expect.poll(async () => (await entries(page)).filter(entry => entry.key.startsWith("投影仪遥控器")).map(entry => [entry.key, entry.value]))
    .toEqual([["投影仪遥控器", "现在放在行政室。"]]);
});

test("a new key is shown as a new entry and adds one", async ({ page, app }) => {
  const card = await propose(page, app, "咖啡机", "每周五清洗。");
  await expect(card.getByText("新增条目：咖啡机", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "批准", exact: true }).click();
  await waitForChatStream(page);
  await expect.poll(async () => (await entries(page)).map(entry => [entry.key, entry.value])).toContainEqual(["咖啡机", "每周五清洗。"]);
});
