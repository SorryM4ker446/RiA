import { test as base, expect, type Page } from "@playwright/test";
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
async function upload(page: Page, filename: string, text: string, collection: string) {
  await page.getByLabel("所属主题（可选）").fill(collection);
  await page.getByLabel("选择知识文档").setInputFiles({ name: filename, mimeType: "text/markdown", buffer: Buffer.from(text) });
  const response = page.waitForResponse(response => response.url().endsWith("/api/documents") && response.request().method() === "POST");
  await page.getByRole("button", { name: "导入文档", exact: true }).click();
  await page.getByRole("button", { name: "确认保存文档", exact: true }).click();
  const result = await response; expect(result.ok(), await result.text()).toBe(true);
  await expect(page.getByRole("button", { name: "导入文档", exact: true })).toBeEnabled();
  return (await result.json()).data.document;
}
async function build(page: Page, filename: string) {
  page.once("dialog", async dialog => {
    expect(dialog.message()).toContain("可能产生费用"); await dialog.accept();
  });
  const response = page.waitForResponse(response => response.url().endsWith("/embeddings"));
  await page.getByLabel(`构建语义索引 ${filename}`).click();
  const result = await response; expect(result.ok(), await result.text()).toBe(true);
  const progress = (await result.json()).data;
  expect(progress.remaining).toBe(0);
  await expect(page.getByLabel(`构建语义索引 ${filename}`)).toBeEnabled();
  return progress;
}

test("semantic indexing delivers evidence to chat, marks actual citations and survives a service restart", { tag: "@integration" }, async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6", embedding: "openai/text-embedding-3-small" });
  await page.goto(`${app.origin}/knowledge`);
  const finance = await upload(page, "差旅规程.md", "# 差旅规程\n\n公务出行的开支需要保留税务票据，回程后的十个工作日内提交费用核销申请。\n\n超过期限需要主管提供书面说明。\n\n遗失票据必须提供替代证明，不能直接申报。", "财务");
  await upload(page, "医疗服务.md", "医院接诊需要预约，非急诊的医疗服务开放时间为八点至十七点。", "医疗");
  expect(app.readRows("SELECT id FROM model_requests WHERE mode='embedding'")).toHaveLength(0);
  await page.getByLabel("检索文档", { exact: true }).fill("出门办事的钱怎样领回来");
  await page.getByRole("button", { name: "检索文档", exact: true }).click();
  await expect(page.getByText(/当前未检索到支持这个问题的资料/)).toBeVisible();
  const progress = await build(page, "差旅规程.md");
  expect(progress.indexed).toBe(finance._count.chunks);
  expect(app.readRows("SELECT embeddingModelId,embeddingContextHash FROM document_chunks WHERE documentId=? AND embedding IS NOT NULL", finance.id)).toHaveLength(progress.total);
  const charged = app.readRows("SELECT id FROM model_requests WHERE mode='embedding'").length;
  // Complete indices now skip the HTTP batch as well as the provider call.
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("构建语义索引 差旅规程.md").click();
  await expect(page.getByLabel("构建语义索引 差旅规程.md")).toBeEnabled();
  await expect(page.getByTestId("index-maintenance")).toContainText("差旅规程.md：已完成");
  expect(app.readRows("SELECT id FROM model_requests WHERE mode='embedding'")).toHaveLength(charged);
  await page.getByLabel("检索资料集合").selectOption("财务");
  await page.getByRole("button", { name: "检索文档", exact: true }).click();
  const evidence = page.locator("details").filter({ hasText: "文档参考" }).last();
  await expect(evidence).toContainText("十个工作日"); await expect(evidence).toContainText("书面说明");
  await expect(evidence).not.toContainText("医疗服务.md");
  await expect(evidence).toContainText("语义检索");
  const dir = join(tmpdir(), "ria-document-rag-qa"); await mkdir(dir, { recursive: true });
  await evidence.screenshot({ path: join(dir, "desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await evidence.screenshot({ path: join(dir, "mobile.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${app.origin}/chat`);
  await page.getByRole("checkbox").check();
  await page.getByPlaceholder(/输入你的问题/).fill("出门办事的钱怎样领回来");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const article = page.locator("article").last();
  await expect(article).toContainText("逾期需要主管提供书面说明");
  await expect(article.getByText("回答已引用此片段（仍需核对内容）", { exact: true })).toHaveCount(2);
  await expect(article.getByText("检索参考：回答未引用此片段", { exact: true })).toHaveCount(1);
  expect(JSON.stringify(app.providerCalls.filter(call => call.stream).at(-1)?.messages)).toContain("十个工作日");
  expect(JSON.stringify(app.providerCalls.filter(call => call.stream).at(-1)?.messages)).not.toContain("医院接诊");
  await expect.poll(() => app.readRows("SELECT content FROM messages WHERE role='assistant'").map(row => String(row.content)).join("\n")).toContain('"citationStatus":"cited"');
  const saved = app.readRows("SELECT content FROM messages WHERE role='assistant'").map(row => String(row.content)).join("\n");
  expect(saved).toContain('"citationStatus":"cited"'); expect(saved).toContain('"citationStatus":"not-cited"');
  await app.restart(); await page.reload();
  await expect(article.getByText("回答已引用此片段（仍需核对内容）", { exact: true })).toHaveCount(2);
  const summaries = await browserData(page, "/api/documents");
  expect(summaries.find(doc => doc.id === finance.id).semantic.indexed).toBe(progress.total);
  const settings = (await browserApi(page, "/api/models")).body.data;
  settings.embedding = null;
  expect((await browserApi(page, "/api/models", "PUT", settings)).status).toBe(200);
  expect((await browserData(page, "/api/documents")).find(doc => doc.id === finance.id).semantic.indexed).toBe(0);
  expect((await browserApi(page, "/api/documents/search", "POST", { query: "出门办事的钱怎样领回来" })).body.data).toEqual([]);
  expect(errors).toEqual([]);
});

test("a failed later indexing batch exposes saved progress and resumes without charging completed chunks", { tag: "@integration" }, async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { embedding: "openai/text-embedding-3-small" });
  await page.goto(`${app.origin}/knowledge`);
  const doc = await upload(page, "费用规程.md", Array.from({ length: 40 }, (_, i) => `费用核销条款 ${i}：公务出行须保留票据。`).join("\n\n"), "财务");
  let batches = 0;
  await page.route(`**/api/documents/${doc.id}/embeddings`, async route => {
    if (++batches === 2) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UPSTREAM_FAILED", message: "模拟服务中断" } }) });
    else await route.continue();
  });
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("构建语义索引 费用规程.md").click();
  await expect(page.locator("main").getByRole("alert")).toContainText("模拟服务中断");
  await expect(page.getByText(/语义索引 32\/40/)).toBeVisible();
  expect(app.readRows("SELECT id FROM document_chunks WHERE documentId=? AND embedding IS NOT NULL", doc.id)).toHaveLength(32);
  expect(app.readRows("SELECT id FROM model_requests WHERE mode='embedding'")).toHaveLength(1);
  await page.unroute(`**/api/documents/${doc.id}/embeddings`);
  const completed = await build(page, "费用规程.md");
  expect(completed.indexed).toBe(40);
  expect(app.readRows("SELECT id FROM model_requests WHERE mode='embedding'")).toHaveLength(2);
});
