import { test as base, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";
const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});

test("topic workspace scopes conversations and artifacts, exports snapshots and preserves history after restart", { tag: "@integration" }, async ({ page, app }) => {
  const errors: string[] = [], consoleErrors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await openWorkspace(page, app.origin); await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6", embedding: "openai/text-embedding-3-small" });
  for (const collection of ["财务", "医疗"]) {
    const uploaded = await page.evaluate(async collection => {
      const body = new FormData(); body.set("collection", collection); body.set("file", new File([collection === "财务" ? "# 差旅规程\n公务出行的开支需要保留税务票据，回程后的十个工作日内提交费用核销申请。\n\n超过期限需要主管提供书面说明。" : "医疗费用核销机密不可出现在财务专题。"], `${collection}.md`, { type: "text/markdown" }));
      const response = await fetch("/api/documents", { method: "POST", body }); return { status: response.status, body: await response.json() };
    }, collection);
    expect(uploaded.status).toBe(201);
    const document = uploaded.body.data.document;
    const indexed = await browserApi(page, `/api/documents/${document.id}/embeddings`, "POST", { confirm: true, contentHash: document.contentHash, modelRef: { providerId: "openrouter", modelId: "openai/text-embedding-3-small" } }); expect(indexed.status).toBe(200);
  }
  await page.goto(`${app.origin}/topics`); await page.getByRole("button", { name: "新建专题", exact: true }).click();
  await page.getByLabel("专题名称", { exact: true }).fill("差旅研究"); await page.getByLabel("专题说明", { exact: true }).fill("整理报销规则与例外");
  await page.getByLabel("财务", { exact: true }).check(); await page.getByRole("button", { name: "保存专题", exact: true }).click();
  await page.getByRole("link", { name: "差旅研究", exact: true }).click(); await expect(page.getByRole("heading", { name: "差旅研究", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "财务.md", exact: true })).toBeVisible(); await expect(page.getByRole("link", { name: "医疗.md", exact: true })).toHaveCount(0);
  const financial = (await browserData(page, "/api/documents")).find(document => document.collection === "财务");
  expect(financial.semantic.indexed).toBe(financial._count.chunks);
  await expect(page.getByText(`语义索引 ${financial._count.chunks}/${financial._count.chunks}`, { exact: false })).toBeVisible();
  await page.getByLabel("专题检索问题", { exact: true }).fill("出门办事的钱怎样领回来"); await page.getByRole("button", { name: "检索专题", exact: true }).click(); await expect(page.getByRole("button", { name: "检索专题", exact: true })).toBeEnabled();
  await expect(page.getByText(/^检索诊断：/).first()).toBeVisible();
  const topic = (await browserData(page, "/api/topics"))[0], workspaceUrl = `${app.origin}/topics/${topic.id}`;
  await page.getByRole("button", { name: "开始专题会话", exact: true }).click(); await expect(page).toHaveURL(/\/chat$/);
  const chat = (await browserData(page, "/api/conversations"))[0]; expect(chat.documentScope).toBe("财务");
  await page.goto(workspaceUrl); await expect(page.getByRole("button", { name: "差旅研究 · 会话", exact: true })).toBeVisible();
  await page.getByLabel("成果标题", { exact: true }).fill("差旅核销总结"); await page.getByLabel("生成要求", { exact: true }).fill("出门办事的钱怎样领回来");
  await expect(page.getByRole("button", { name: "生成成果", exact: true })).toBeDisabled(); await page.getByLabel("确认模型调用", { exact: true }).check();
  const response = page.waitForResponse(value => value.url().endsWith(`/topics/${topic.id}/artifacts`) && value.request().method() === "POST");
  await page.getByRole("button", { name: "生成成果", exact: true }).click(); const completed = await response; expect(completed.status()).toBe(200);
  const artifact = (await completed.json()).data; expect(artifact.status).toBe("ready"); expect(artifact.metadata.sources.every(source => source.collection === "财务")).toBe(true);
  await expect(page.locator("article")).toContainText("十个工作日"); await expect(page.locator("article")).toContainText("书面说明");
  const calls = app.providerCalls.length; expect(JSON.stringify(app.providerCalls.at(-1)?.messages)).not.toContain("医疗费用核销机密");
  const download = page.waitForEvent("download"); await page.getByRole("link", { name: "导出 JSON 与引用快照", exact: true }).click(); const file = await download;
  const exported = JSON.parse(await readFile((await file.path())!, "utf8")); expect(exported.metadata.sources[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
  await page.getByRole("button", { name: "修改专题设置", exact: true }).click(); await page.getByLabel("专题说明", { exact: true }).fill("专题更新后的说明");
  await page.getByRole("button", { name: "保存专题", exact: true }).click(); await expect(page.getByRole("status").filter({ hasText: "专题已保存" })).toBeVisible();
  expect((await browserData(page, `/api/topics/${topic.id}/artifacts/${artifact.id}`)).topicRevision).toBe(1);
  await expect(page.locator("article")).toContainText("使用旧专题设置");
  await app.restart(); await page.reload(); await page.getByRole("button", { name: "差旅核销总结 · 已生成", exact: true }).click(); await expect(page.locator("article")).toContainText("十个工作日"); expect(app.providerCalls.length).toBe(calls);
  const dir = join(tmpdir(), "ria-knowledge-topics-qa"); await mkdir(dir, { recursive: true }); await page.screenshot({ path: join(dir, "desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: join(dir, "mobile.png"), fullPage: true, animations: "disabled" });
  page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "删除专题", exact: true }).click(); await expect(page).toHaveURL(`${app.origin}/topics`);
  expect(await browserData(page, "/api/topics")).toEqual([]); expect((await browserData(page, "/api/documents")).length).toBe(2); expect((await browserData(page, "/api/conversations")).some(item => item.id === chat.id)).toBe(true);
  expect(errors).toEqual([]); expect(consoleErrors).toEqual([]);
});

test("empty topic scope stays empty and failed loading recovers through explicit refresh", { tag: "@integration" }, async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  const created = await browserApi(page, "/api/topics", "POST", { name: "待导入专题", description: "", collections: ["未导入"], assistantTemplateId: null }); expect(created.status).toBe(200);
  const url = `${app.origin}/topics/${created.body.data.id}`;
  await page.route(`**/api/topics/${created.body.data.id}`, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UPSTREAM_FAILED", message: "专题读取失败" } }) }));
  await page.goto(url); await expect(page.getByRole("status")).toContainText("专题读取失败"); await page.unroute(`**/api/topics/${created.body.data.id}`);
  await page.getByRole("button", { name: "刷新专题和成果", exact: true }).click(); await expect(page.getByText("这些集合暂无文档，请导入资料后再检索或生成成果。")).toBeVisible();
  await page.getByLabel("确认模型调用", { exact: true }).check(); await expect(page.getByRole("button", { name: "生成成果", exact: true })).toBeDisabled(); expect(app.providerCalls.length).toBe(0);
});
