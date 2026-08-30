import { test as base, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";
import { textPdf, wordDocument } from "../helpers/document-fixtures.mjs";

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
async function importFile(page: Page, name: string, buffer: Buffer) {
  await page.getByLabel("选择知识文档").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  const response = page.waitForResponse(response => response.url().endsWith("/api/documents") && response.request().method() === "POST");
  await page.getByRole("button", { name: "导入文档", exact: true }).click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  await expect(page.getByRole("button", { name: "导入文档", exact: true })).toBeEnabled();
  return (await result.json()).data;
}

test("document imports, local retrieval and chat citations persist across reload and service restart", { tag: "@integration" }, async ({ page, browser, app }) => {
  await register(page, app.origin);
  await page.getByRole("link", { name: /知识库/ }).click();
  const original = await importFile(page, "星河运行手册.md", Buffer.from("# 星河运行手册\n\n星河补给每周三送达，回滚窗口为三十分钟。\n\n备用线路每月巡检。"));
  const documentId = original.document.id;
  await importFile(page, "support.pdf", textPdf());
  await importFile(page, "发布.docx", await wordDocument());
  await expect(page.getByRole("link", { name: "support.pdf", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "发布.docx", exact: true })).toBeVisible();
  expect(app.providerCalls).toHaveLength(0);
  await page.getByLabel("检索文档", { exact: true }).fill("星河补给回滚窗口");
  await page.getByRole("button", { name: "检索文档", exact: true }).click();
  await expect(page.getByText(/星河补给每周三送达/)).toBeVisible();
  const old = await browserData(page, `${app.origin}/api/documents/${documentId}`);
  const updated = await importFile(page, "星河运行手册.md", Buffer.from("# 星河运行手册\n\n星河补给每周四送达，回滚窗口为三十分钟。\n\n备用线路每月巡检。"));
  expect(updated.retained).toBe(2);
  expect(updated.document.id).toBe(documentId);
  const next = await browserData(page, `${app.origin}/api/documents/${documentId}`);
  expect(next.chunks[0].id).toBe(old.chunks[0].id);
  expect(next.chunks[1].id).not.toBe(old.chunks[1].id);
  await page.getByLabel("重新索引 星河运行手册.md").click();
  await expect(page.getByText("已根据保存的文本重建索引。")).toBeVisible();
  await page.getByRole("link", { name: /返回聊天/ }).click();
  await page.getByRole("checkbox").check();
  await page.getByPlaceholder(/输入你的问题/).fill("星河补给什么时候送达");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("离线回答：星河补给什么时候送达", { exact: true })).toBeVisible();
  const source = page.getByRole("link", { name: "星河运行手册.md · 片段 2", exact: true });
  await expect(source).toBeVisible();
  await expect(page.locator("article").getByText(/星河补给每周四送达/)).toBeVisible();
  expect(JSON.stringify(app.providerCalls.filter(call => call.stream).at(-1)?.messages)).toContain("每周四");
  await page.reload();
  await expect(source).toBeVisible();
  await app.restart();
  await page.reload();
  await expect(source).toBeVisible();
  await source.click();
  await expect(page.getByRole("heading", { name: "星河运行手册.md", exact: true })).toBeVisible();
  await expect(page.getByText(/星河补给每周四送达/)).toBeVisible();

  const stranger = await browser.newContext();
  try {
    expect((await stranger.request.get(`${app.origin}/api/documents/${documentId}`)).status()).toBe(401);
    const other = await stranger.newPage();
    await register(other, app.origin);
    expect(await browserData(other, `${app.origin}/api/documents`)).toEqual([]);
    for (const method of ["GET", "POST", "DELETE"]) expect((await browserApi(other, `${app.origin}/api/documents/${documentId}`, method)).status).toBe(404);
  } finally { await stranger.close(); }

  await page.getByRole("link", { name: "返回知识库", exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("删除文档 星河运行手册.md").click();
  await expect(page.getByText("文档及索引已删除。")).toBeVisible();
  expect(app.readRows("SELECT id FROM document_chunks WHERE documentId = ?", documentId)).toEqual([]);
  expect((await browserApi(page, `${app.origin}/api/documents/${documentId}`)).status).toBe(404);
  await page.getByRole("link", { name: /返回聊天/ }).click();
  await expect(source).toBeVisible();
  await source.click();
  await expect(page.locator("main").getByRole("alert")).toContainText("文档不存在或已删除");
});

test("document validation, Origin boundary and ingestion throttling work over authenticated HTTP", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  await page.getByRole("link", { name: /知识库/ }).click();
  await page.getByLabel("选择知识文档").setInputFiles({ name: "invalid.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a PDF") });
  await page.getByRole("button", { name: "导入文档", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("文件内容与扩展名不符");
  expect(await browserData(page, `${app.origin}/api/documents`)).toEqual([]);
  const cookies = await page.context().cookies();
  const cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  const denied = await fetch(`${app.origin}/api/documents`, { method: "POST", headers: { cookie, origin: "https://outside.invalid", "content-type": "application/json" }, body: "{}" });
  expect(denied.status).toBe(403);
  const result = await importFile(page, "valid.txt", Buffer.from("本地文档限流回归。"));
  for (let count = 0; count < 4; count++) expect((await browserApi(page, `${app.origin}/api/documents/${result.document.id}`, "POST")).status).toBe(200);
  expect((await browserApi(page, `${app.origin}/api/documents/${result.document.id}`, "POST")).status).toBe(429);
  app.expireSessions();
  expect((await browserApi(page, `${app.origin}/api/documents/${result.document.id}`)).status).toBe(401);
  expect(app.providerCalls).toHaveLength(0);
});
