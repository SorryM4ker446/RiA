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
  await expect(page.getByText("工具详情：createTask · 执行完成", { exact: true })).toBeVisible();
  // A tool output is streamed before the SDK's end-of-stream persistence callback.
  // Wait for durable history before testing restoration from that history.
  await expect.poll(async () => {
    const messages = await browserData(page, `/api/conversations/${chat.id}/messages`);
    return messages.some(message => message.content.includes('"state":"output-available"'));
  }).toBe(true);
  await page.reload();
  await expect(page.getByText("工具详情：createTask · 执行完成", { exact: true })).toBeVisible();
  await expect(approve).toHaveCount(0);
  expect(await browserData(page, "/api/tasks")).toHaveLength(1);
  await page.goto(`${app.origin}/tasks`);
  await expect(page.getByTestId("task-panel").getByText("浏览器真实任务", { exact: true })).toBeVisible();
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
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
  const holdHistory = async (route: import("@playwright/test").Route) => {
    await historyGate;
    await route.continue();
  };
  await page.route("**/api/conversations", holdHistory);
  let topicLoads = 0;
  await page.route("**/api/documents", async route => {
    topicLoads += 1;
    await route.continue();
  });
  const scope = page.getByRole("button", { name: "A|B", exact: true });
  try {
    await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
    await expect(scope).toBeVisible();
    await expect(scope).toBeDisabled();
  } finally {
    releaseHistory();
  }
  await expect(scope).toBeEnabled();
  await page.unroute("**/api/conversations", holdHistory);
  const composer = page.getByPlaceholder(/输入你的问题/);
  await composer.fill("OFFLINE_SEARCH_KNOWLEDGE 检索发布回滚窗口");
  let releaseScope!: () => void;
  const scopeGate = new Promise<void>(resolve => { releaseScope = resolve; });
  let scopeWrites = 0;
  const holdScope = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    scopeWrites += 1;
    if (scopeWrites === 1) {
      return route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "Scope save rejected" } } });
    }
    await scopeGate;
    await route.continue();
  };
  await page.route(`**/api/conversations/${chat.id}`, holdScope);
  await scope.click();
  await expect(page.getByRole("alert").filter({ hasText: "Scope save rejected" })).toBeVisible();
  await expect(scope).toHaveAttribute("aria-pressed", "false");
  await expect(scope).toBeEnabled();
  try {
    await scope.click();
    await expect.poll(() => scopeWrites).toBe(2);
    await expect(scope).toBeDisabled();
    await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  } finally {
    releaseScope();
  }
  await expect(scope).toHaveAttribute("aria-pressed", "true");
  await expect(scope).toBeEnabled();
  await page.unroute(`**/api/conversations/${chat.id}`, holdScope);
  expect(scopeWrites).toBe(2);
  expect(topicLoads).toBe(1);
  await expect(page.getByRole("alert").filter({ hasText: "Scope save rejected" })).toHaveCount(0);
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
  expect(topicLoads).toBe(2);
});
