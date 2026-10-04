import { test as base, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

test("a task-only response exposes approval, creates the task after approval and survives reload", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "工具执行验证" })).body.data;
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await expect(page).toHaveTitle(/RiA|Private AI Assistant/);
  await page.getByPlaceholder(/输入你的问题/).fill("OFFLINE_CREATE_TASK 帮我创建任务");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const approve = page.getByRole("button", { name: "批准", exact: true });
  await expect(approve).toBeVisible();
  await expect(approve).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: "操作尚未执行" })).toBeVisible();
  expect(await browserData(page, "/api/tasks")).toHaveLength(0);
  const screenshots = join(tmpdir(), "ria-tool-qa");
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "task-approval.png"), fullPage: true, animations: "disabled" });
  await approve.click();
  await expect.poll(async () => (await browserData(page, "/api/tasks")).length).toBe(1);
  await expect(page.getByText("浏览器真实任务", { exact: true })).toBeVisible();
  const messages = await browserData(page, `/api/conversations/${chat.id}/messages`);
  expect(messages.some(message => message.content.includes('"state":"output-available"'))).toBe(true);
  await page.reload();
  await expect(page.getByText("浏览器真实任务", { exact: true })).toBeVisible();
  await expect(approve).toHaveCount(0);
  expect(await browserData(page, "/api/tasks")).toHaveLength(1);
  await page.screenshot({ path: join(screenshots, "task-created.png"), fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
});

test("knowledge tool results stay within the conversation collection and remain citable", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  for (const [collection, label] of [["A|B", "A"], ["B", "B"]]) {
    const result = await page.evaluate(async ({ collection, label }) => {
      const form = new FormData();
      form.set("file", new File([`发布回滚窗口为${label === "A" ? "三十" : "六十"}分钟。`], `发布${label}.txt`, { type: "text/plain" }));
      form.set("collection", collection);
      const response = await fetch("/api/documents", { method: "POST", body: form });
      return response.status;
    }, { collection, label });
    expect(result).toBe(201);
  }
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "集合检索验证" })).body.data;
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  const scope = page.getByRole("button", { name: "A|B", exact: true });
  await scope.click();
  await expect(scope).toHaveAttribute("aria-pressed", "true");
  await page.getByPlaceholder(/输入你的问题/).fill("OFFLINE_SEARCH_KNOWLEDGE 检索发布回滚窗口");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("link", { name: /发布A.txt/ }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /发布B.txt/ })).toHaveCount(0);
  await expect.poll(async () => {
    const rows = await browserData(page, `/api/conversations/${chat.id}/messages`);
    return rows.some(row => row.content.includes('"toolName":"searchKnowledge"') && row.content.includes('"state":"output-available"'));
  }).toBe(true);
  const rows = await browserData(page, `/api/conversations/${chat.id}/messages`);
  const reply = rows.find(row => row.role === "assistant");
  const payload = JSON.parse(reply.content.slice(reply.content.indexOf(":") + 1));
  expect(payload.tools[0].output.results.map(result => result.reference.filename)).toEqual(["发布A.txt"]);
  await page.reload();
  await expect(scope).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("link", { name: /发布A.txt/ }).first()).toBeVisible();
});
