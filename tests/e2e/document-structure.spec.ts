import { test as base, expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";
import { wordTableDocument } from "../helpers/document-fixtures";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});
async function preview(page: Page, name: string, buffer: Buffer) {
  await page.getByLabel("选择知识文档").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  await page.getByRole("button", { name: "导入文档", exact: true }).click();
  await expect(page.getByRole("region", { name: "文档导入预览" })).toBeVisible();
}
async function save(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith("/api/documents") && response.request().method() === "POST");
  await page.getByRole("button", { name: "确认保存文档", exact: true }).click();
  const result = await response; expect(result.ok(), await result.text()).toBe(true);
  await expect(page.getByRole("button", { name: "导入文档", exact: true })).toBeEnabled();
  return (await result.json()).data.document;
}

test("Word preview is read-only, retains table context and requires confirmation before retrieval", { tag: "@integration" }, async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/knowledge`);
  await expect(page).toHaveURL(/\/knowledge$/);
  expect(await page.title()).toBeTruthy();
  const file = await wordTableDocument([["项目", "金额", "条件"], ["住宿", "500 元", "主管审批"], ["交通", "200 元", "保留票据"], ["`样例", "100 元", "特殊标记"]]);
  await preview(page, "费用标准.docx", file);
  const panel = page.getByRole("region", { name: "文档导入预览" });
  await expect(panel).toContainText("| 项目 | 金额 | 条件 |");
  await expect(panel).toContainText("| 住宿 | 500 元 | 主管审批 |");
  await expect(panel).toContainText("| \\`样例 | 100 元 | 特殊标记 |");
  await expect(page.locator("nextjs-portal")).toHaveCount(0);
  expect(await browserData(page, "/api/documents")).toEqual([]);
  expect(app.providerCalls).toHaveLength(0);
  const directory = join(tmpdir(), "ria-document-structure-qa"); await mkdir(directory, { recursive: true });
  await panel.screenshot({ path: join(directory, "desktop-preview.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await panel.screenshot({ path: join(directory, "mobile-preview.png"), animations: "disabled" });
  await page.getByRole("button", { name: "放弃预览", exact: true }).click();
  await expect(panel).toHaveCount(0);
  expect(await browserData(page, "/api/documents")).toEqual([]);
  await preview(page, "费用标准.docx", file);
  const document = await save(page);
  expect(document.indexVersion).toBe(3);
  const response = await browserApi(page, "/api/documents/search", "POST", { query: "住宿金额审批" });
  expect(response.body.data.some(source => source.snippet.includes("500 元") && source.snippet.includes("主管审批") && source.snippet.includes("金额"))).toBe(true);
  await app.restart(); await page.reload();
  await expect(page.getByRole("link", { name: "费用标准.docx", exact: true })).toBeVisible();
  const stored = await browserData(page, `/api/documents/${document.id}`);
  expect(stored.chunks.some(chunk => chunk.text.includes("| 住宿 | 500 元 | 主管审批 |"))).toBe(true);
  expect(app.providerCalls).toHaveLength(0);
  expect(errors).toEqual([]);
  await writeFile(join(directory, "preview-health.json"), JSON.stringify({ url: page.url(), title: await page.title(), viewports: ["1280x720", "390x844"], pageAndConsoleErrors: errors, frameworkOverlay: false, confirmedDocumentId: document.id, providerCalls: app.providerCalls.length }, null, 2));
});

test("confirmation refuses a concurrently updated document and preserves the newer version", { tag: "@integration" }, async ({ page, app }) => {
  await openWorkspace(page, app.origin); await page.goto(`${app.origin}/knowledge`);
  await preview(page, "限额.txt", Buffer.from("旧版住宿限额为 300 元。")); const doc = await save(page);
  await preview(page, "限额.txt", Buffer.from("准备导入的住宿限额为 500 元。"));
  await expect(page.getByRole("region", { name: "文档导入预览" })).toContainText("确认保存将更新同名文档");
  const cookies = (await page.context().cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  const data = new FormData(); data.append("file", new File(["另一请求更新的住宿限额为 700 元。"], "限额.txt"));
  const updated = await fetch(`${app.origin}/api/documents`, { method: "POST", headers: { cookie: cookies, origin: app.origin }, body: data });
  expect(updated.status).toBe(200);
  await page.getByRole("button", { name: "确认保存文档", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("同名文档在预览后已改变");
  const current = await browserData(page, `/api/documents/${doc.id}`);
  expect(current.chunks.map(chunk => chunk.text).join("\n")).toContain("700 元");
  expect(current.chunks.map(chunk => chunk.text).join("\n")).not.toContain("500 元");
  await page.getByRole("button", { name: "放弃预览", exact: true }).click();
  await preview(page, "限额.txt", Buffer.from("准备导入的住宿限额为 500 元。")); await save(page);
  expect((await browserData(page, `/api/documents/${doc.id}`)).chunks.map(chunk => chunk.text).join("\n")).toContain("500 元");
});

test("Markdown examples and compact escaped paths retain real sections and table headers through preview and retrieval", { tag: "@integration" }, async ({ page, app }) => {
  await openWorkspace(page, app.origin); await page.goto(`${app.origin}/knowledge`);
  const path = String.raw`C:\\`;
  const text = "# 实际费用章节\n\n```md\n# 示例中的其他章节\n示例代码不是实际章节。\n```\n\n| 项目 | 条件 | 路径 |\n| --- | --- | --- |\n" + Array.from({ length: 80 }, (_, i) => `| 住宿${i} | 保留票据并审批 | ${path}|`).join("\n");
  const response = page.waitForResponse(response => response.url().endsWith("/api/documents/preview"));
  await preview(page, "路径与章节.md", Buffer.from(text));
  const parsed = (await (await response).json()).data;
  const tables = parsed.chunks.filter(chunk => chunk.text.includes("| 住宿"));
  expect(tables.length).toBeGreaterThan(1);
  expect(tables.every(chunk => chunk.heading === "实际费用章节" && chunk.text.startsWith("| 项目 | 条件 | 路径 |"))).toBe(true);
  for (let i = 0; i < 80; i++) expect(tables.filter(chunk => chunk.text.includes(`| 住宿${i} | 保留票据并审批 | ${path}|`))).toHaveLength(1);
  expect(await browserData(page, "/api/documents")).toEqual([]);
  const doc = await save(page);
  const stored = app.readRows("SELECT id,heading,text FROM document_chunks WHERE documentId=? ORDER BY ordinal", doc.id);
  expect(stored.filter(row => String(row.text).includes("| 住宿")).every(row => row.heading === "实际费用章节")).toBe(true);
  const searchResponse = page.waitForResponse(response => response.url().endsWith("/api/documents/search"));
  await page.getByLabel("检索文档", { exact: true }).fill("住宿票据审批");
  await page.getByRole("button", { name: "检索文档", exact: true }).click();
  const sources = (await (await searchResponse).json()).data.filter(source => source.snippet.includes("| 住宿"));
  expect(sources.length).toBeGreaterThan(0); expect(sources.every(source => source.heading === "实际费用章节")).toBe(true);
  expect(app.providerCalls).toHaveLength(0);
});

test("bulk indexing cancels at a controlled request boundary and resumes persisted batches after restart", { tag: "@integration" }, async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin); await configureOfflineModels(page, { embedding: "openai/text-embedding-3-small" });
  await page.goto(`${app.origin}/knowledge`);
  await preview(page, "短规程.md", Buffer.from("费用需要保留税务票据。")); const short = await save(page);
  await preview(page, "长规程.md", Buffer.from(Array.from({ length: 40 }, (_, i) => `费用规定${i}：公务出行须保留票据。`).join("\n\n"))); const long = await save(page);
  const summaries = await browserData(page, "/api/documents"); expect(summaries[0].id).toBe(long.id);
  let arrived!: () => void; const secondRequest = new Promise<void>(resolve => { arrived = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let finished!: () => void; const handled = new Promise<void>(resolve => { finished = resolve; });
  let batches = 0;
  await page.route(`**/api/documents/${long.id}/embeddings`, async route => {
    if (++batches === 2) { arrived(); await gate; try { await route.abort(); } finally { finished(); } }
    else await route.continue();
  });
  page.once("dialog", dialog => { expect(dialog.message()).toContain("可能产生费用"); return dialog.accept(); });
  await page.getByRole("button", { name: "批量构建或继续", exact: true }).click();
  await secondRequest;
  const maintenance = page.getByTestId("index-maintenance");
  await expect(maintenance).toContainText("长规程.md：构建中 · 32/40");
  await expect(maintenance).toContainText("短规程.md：等待");
  await page.getByRole("button", { name: "取消索引构建", exact: true }).click();
  await expect(maintenance).toContainText("长规程.md：已取消 · 32/40");
  await expect(page.getByRole("button", { name: "批量构建或继续", exact: true })).toBeEnabled();
  release(); await handled; await page.unroute(`**/api/documents/${long.id}/embeddings`);
  expect(app.readRows("SELECT id FROM document_chunks WHERE documentId=? AND embedding IS NOT NULL", long.id)).toHaveLength(32);
  expect(app.readRows("SELECT id FROM document_chunks WHERE documentId=? AND embedding IS NOT NULL", short.id)).toHaveLength(0);
  expect(app.readRows("SELECT id FROM model_requests WHERE mode='embedding'")).toHaveLength(1);
  await app.restart(); await page.reload();
  await expect(page.getByText(/语义索引 32\/40/)).toBeVisible();
  page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "批量构建或继续", exact: true }).click();
  await expect(maintenance).toContainText("长规程.md：已完成 · 40/40");
  await expect(maintenance).toContainText("短规程.md：已完成 · 1/1");
  await expect(page.getByRole("button", { name: "批量构建或继续", exact: true })).toBeDisabled();
  expect(app.readRows("SELECT id FROM model_requests WHERE mode='embedding'")).toHaveLength(3);
  const directory = join(tmpdir(), "ria-document-structure-qa"); await mkdir(directory, { recursive: true });
  await maintenance.screenshot({ path: join(directory, "desktop-index.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await maintenance.screenshot({ path: join(directory, "mobile-index.png"), animations: "disabled" });
  // An already complete document is skipped locally without another provider request.
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("构建语义索引 长规程.md").click();
  await expect(page.getByRole("button", { name: "批量构建或继续", exact: true })).toBeDisabled();
  expect(app.readRows("SELECT id FROM model_requests WHERE mode='embedding'")).toHaveLength(3);
  expect(errors).toEqual([]);
});
