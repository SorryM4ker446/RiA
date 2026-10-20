import { test as base, expect, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";
import { textPdf, wordTableDocument } from "../helpers/document-fixtures";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({ app: async ({}, provide) => {
  const app = await startStandaloneServer({ modelFixture: true });
  try { await provide(app); } finally { await app.close(); }
} });
const screenshots = join(tmpdir(), "ria-document-processor-qa");
const sample = "# 差旅标准\n\n**住宿**上限为 500 元。\n\n| 项目 | 金额 | 条件 |\n| --- | --- | --- |\n| 住宿 | 500 元 | 主管审批 |\n| 交通 | 200 元 | 保留票据 |\n\n- 第一项\n- 第二项\n\n```c\nif (a < b) return 1;\n```\n\n<script>window.__documentScriptRan = true</script>\n\n![外部图](https://foreign.invalid/private.png)";


async function importFile(page: Page, name: string, bytes: Buffer) {
  return page.evaluate(async ({ name, bytes }) => {
    const form = new FormData(); form.set("file", new File([new Uint8Array(bytes)], name));
    const response = await fetch("/api/documents", { method: "POST", body: form });
    if (!response.ok) throw new Error(`Import failed: ${response.status}`);
    return (await response.json()).data.document;
  }, { name, bytes: [...bytes] });
}
async function importKnowledge(page: Page, content: string) { return importFile(page, "差旅标准.md", Buffer.from(content)); }
async function openCopy(page: Page, app: { origin: string }, id: string) {
  await page.goto(`${app.origin}/knowledge/documents/${id}`);
  await page.getByRole("button", { name: "编辑副本", exact: true }).click();
  await expect(page.getByLabel("文档内容", { exact: true })).toBeVisible();
}
async function exportAs(page: Page, format: string, label: string, copy = true) {
  await page.getByRole("button", { name: copy ? "导出副本" : "导出", exact: true }).click();
  const waiting = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: `${label} · .${format}`, exact: true }).click();
  return waiting;
}

test("document details integrate compact copy editing and export while legacy links redirect into knowledge", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${app.origin}/document-processor`);
  await expect(page).toHaveURL(`${app.origin}/knowledge`);
  await expect(page.getByRole("link", { name: "文档处理器", exact: true })).toHaveCount(0);
  const document = await importKnowledge(page, "# 可编辑副本\n\n保留本次修改。");
  await page.goto(`${app.origin}/document-processor?document=${document.id}`);
  await expect(page).toHaveURL(`${app.origin}/knowledge/documents/${document.id}`);
  await expect(page.getByRole("heading", { name: "差旅标准.md", exact: true })).toBeVisible();
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveCount(0);
  await expect(page.getByText("导出选项", { exact: true })).toHaveCount(0);
  const edit = page.getByRole("button", { name: "编辑副本", exact: true });
  const box = (await edit.boundingBox())!; expect(box.y + box.height).toBeLessThan(844);
  await edit.click();
  const content = page.getByLabel("文档内容", { exact: true });
  await expect(content).toHaveValue("# 可编辑副本\n\n保留本次修改。");
  await content.fill("# 整理后的副本\n\n保留这次编辑。");
  await page.getByRole("button", { name: "返回原文", exact: true }).click();
  await expect(page.getByText("保留本次修改。", { exact: false }).last()).toBeVisible();
  await page.getByRole("button", { name: "继续编辑副本", exact: true }).click();
  await expect(content).toHaveValue("# 整理后的副本\n\n保留这次编辑。");
  const source = await browserData(page, `/api/documents/${document.id}`);
  await page.evaluate(chunkId => { window.location.hash = chunkId; }, source.chunks[0].id);
  await expect(page.locator(`[id="${source.chunks[0].id}"]`)).toBeVisible();
  await page.getByRole("button", { name: "继续编辑副本", exact: true }).click();
  await expect(content).toHaveValue("# 整理后的副本\n\n保留这次编辑。");
  await expect(page.getByLabel("文件名称", { exact: true })).toBeHidden();
  await page.getByText("导出选项", { exact: true }).click();
  await expect(page.getByLabel("文件名称", { exact: true })).toHaveValue("差旅标准.md");
  await page.getByLabel("内容类型", { exact: true }).click();
  await page.getByRole("option", { name: "纯文本", exact: true }).click();
  await page.getByLabel("内容类型", { exact: true }).click();
  await page.getByRole("option", { name: "Markdown 结构", exact: true }).click();
  await page.getByText("导出选项", { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "mobile-layout.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.getByRole("tab", { name: "版式预览", exact: true }).click();
  await expect(page.frameLocator('iframe[title="文档版式预览"]').getByRole("heading", { name: "整理后的副本", exact: true })).toBeVisible();
  await page.screenshot({ path: join(screenshots, "desktop-light.png"), animations: "disabled" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("tab", { name: "编辑内容", exact: true }).click();
  await expect(page.getByRole("tabpanel").filter({ has: content })).toHaveCSS("animation-name", "none");
  expect(errors).toEqual([]);
});

test("document actions select files as parameters and return to automatic tools after one explicit execution", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${app.origin}/knowledge`);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const document = await importKnowledge(page, "# 执行说明\n\n请保留这些文档内容。");
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "显式文档操作" })).body.data;
  await page.evaluate(id => {
    localStorage.setItem("chat:last-active-id", id);
    localStorage.setItem(`chat:prefs:${id}`, JSON.stringify({ modelMode: "chat", selectedChatModel: { providerId: "openrouter", modelId: "anthropic/claude-opus-4.6" }, selectedManualTool: "readDocument", manualToolsOnly: true }));
  }, chat.id);
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  const tools = page.getByRole("combobox", { name: "选择工具", exact: true });
  await expect(tools).toContainText("自动工具");
  await expect(page.getByRole("checkbox", { name: "仅手动", exact: true })).toHaveCount(0);
  await expect(page.locator(".composer-input")).toHaveCSS("height", "80px");
  expect((await page.locator(".composer-surface").boundingBox())!.width).toBe(672);
  await page.getByPlaceholder(/输入你的问题/).fill("保留这份普通对话草稿");
  await tools.click();
  await expect(page.getByRole("option", { name: "文档 ID", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "读取文档", exact: true }).click();
  const submit = page.getByRole("button", { name: "读取文档", exact: true });
  await expect(submit).toBeDisabled();
  const source = page.getByRole("combobox", { name: "知识库文档", exact: true });
  await expect(source).toBeEnabled(); await source.click();
  await page.getByRole("option", { name: "差旅标准.md", exact: true }).click();
  const calls = app.providerCalls.length;
  await submit.click();
  await expect(tools).toContainText("自动工具");
  await expect(page.getByText("读取文档：差旅标准.md", { exact: true })).toBeVisible();
  await expect(page.getByText(/请保留这些文档内容。/).first()).toBeVisible();
  await expect(page.getByPlaceholder(/输入你的问题/)).toHaveValue("保留这份普通对话草稿");
  expect(app.providerCalls.length).toBe(calls);
  const requests: unknown[] = []; page.on("request", request => { if (request.url().endsWith("/api/chat") && request.method() === "POST") requests.push(request.postDataJSON()); });
  await page.getByPlaceholder(/输入你的问题/).fill("OFFLINE_CREATE_TASK 帮我创建任务");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeVisible();
  expect((requests[0] as { manualToolsOnly?: boolean }).manualToolsOnly).toBeUndefined();
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await expect.poll(async () => (await browserData(page, "/api/tasks")).length).toBe(1);
  await expect(page.getByRole("dialog", { name: "执行记录", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  await page.getByRole("dialog", { name: "执行记录", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  const history = await browserData(page, `/api/conversations/${chat.id}/messages`);
  expect(history.some(message => message.content.includes(`"documentId":"${document.id}"`))).toBe(true);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "automatic-tools.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("document action failures retain the chosen resource and scope changes discard obsolete choices", async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${app.origin}/knowledge`);
  const docs = await page.evaluate(async () => {
    const docs = [];
    for (const collection of ["本次资料", "其他资料"]) {
      const form = new FormData(); form.set("file", new File([`# ${collection}\n\n可导出内容。`], `${collection}.md`)); form.set("collection", collection);
      const response = await fetch("/api/documents", { method: "POST", body: form }); if (!response.ok) throw new Error(`Import failed ${response.status}`);
      docs.push((await response.json()).data.document);
    }
    return docs;
  });
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "文档操作恢复" })).body.data;
  await browserApi(page, `/api/conversations/${chat.id}`, "PATCH", { documentScope: ["本次资料"] });
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  const tools = page.getByRole("combobox", { name: "选择工具", exact: true });
  await tools.click(); await page.getByRole("option", { name: "转换并导出文档", exact: true }).click();
  const source = page.getByRole("combobox", { name: "知识库文档", exact: true });
  await expect(source).toBeEnabled(); await source.click();
  await expect(page.getByRole("option", { name: "其他资料.md · 其他资料", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "本次资料.md · 本次资料", exact: true }).click();
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    let fail = true;
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (fail && new URL(url, location.href).pathname === "/api/tools/run") {
        fail = false;
        return Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "文档服务暂不可用" } }, { status: 503 });
      }
      return original(input, init);
    };
  });
  await page.getByRole("button", { name: "转换并导出文档", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "请求失败" })).toContainText("文档服务暂不可用");
  await expect(tools).toContainText("转换并导出文档"); await expect(source).toContainText("本次资料.md");
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "document-action-mobile.png"), animations: "disabled" });
  await page.getByRole("button", { name: "转换并导出文档", exact: true }).click();
  await expect(tools).toContainText("自动工具");
  await expect(page.getByRole("button", { name: "下载 Word · 本次资料.docx", exact: true })).toBeVisible();
  await tools.click(); await page.getByRole("option", { name: "读取文档", exact: true }).click();
  await expect(source).toBeEnabled(); await source.click();
  await page.getByRole("option", { name: "本次资料.md · 本次资料", exact: true }).click();
  await browserApi(page, `/api/conversations/${chat.id}`, "PATCH", { documentScope: ["其他资料"] });
  await page.reload();
  await expect(tools).toContainText("自动工具");
  await tools.click(); await page.getByRole("option", { name: "读取文档", exact: true }).click();
  await expect(page.getByRole("button", { name: "读取文档", exact: true })).toBeDisabled();
  await expect(source).toBeEnabled(); await source.click();
  await expect(page.getByRole("option", { name: "本次资料.md · 本次资料", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "其他资料.md · 其他资料", exact: true }).click();
  await page.getByRole("button", { name: "读取文档", exact: true }).click();
  await expect(tools).toContainText("自动工具");
  expect((await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes(`"documentId":"${docs[1].id}"`))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(app.providerCalls).toHaveLength(0);
});


test("document details preview safely and export original or edited copies in all four formats without a model", async ({ page, app }) => {
  const errors: string[] = [], consoleErrors: string[] = [], remoteRequests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", request => { if (request.url().includes("foreign.invalid")) remoteRequests.push(request.url()); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${app.origin}/knowledge`);
  const document = await importKnowledge(page, sample);
  await page.goto(`${app.origin}/knowledge/documents/${document.id}`);
  const original = await exportAs(page, "txt", "纯文本", false);
  expect((await readFile((await original.path())!)).toString()).toContain("500 元");
  await page.getByRole("button", { name: "编辑副本", exact: true }).click();
  const edited = sample.replaceAll("500 元", "550 元");
  await page.getByLabel("文档内容", { exact: true }).fill(edited);
  await page.getByRole("tab", { name: "版式预览", exact: true }).click();
  const preview = page.frameLocator('iframe[title="文档版式预览"]');
  await expect(preview.getByRole("heading", { name: "差旅标准", exact: true })).toBeVisible();
  await expect(preview.getByRole("cell", { name: "550 元", exact: true })).toBeVisible();
  await expect(preview.locator("body")).toContainText("<script>");
  await expect(preview.locator("img, script")).toHaveCount(0);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "desktop.png"), animations: "disabled" });
  for (const [format, label] of [["docx", "Word"], ["md", "Markdown"], ["txt", "纯文本"], ["html", "HTML"]]) {
    const download = await exportAs(page, format, label);
    expect(download.suggestedFilename()).toBe(`差旅标准.${format}`);
    const bytes = await readFile((await download.path())!);
    if (format === "docx") {
      const zip = await JSZip.loadAsync(bytes), xml = await zip.file("word/document.xml")!.async("string");
      expect(xml).toContain("<w:tbl>"); expect(xml).toContain("主管审批"); expect(xml).toContain("Heading1"); expect(xml).toContain("550 元");
    } else {
      expect(bytes.toString()).toContain("550 元");
      if (format === "md") expect(bytes.toString()).toBe(edited);
      if (format === "html") expect(bytes.toString()).not.toContain("<script>");
    }
    await expect(page.getByRole("button", { name: "导出副本", exact: true })).toBeEnabled();
  }
  const unchanged = await browserData(page, `/api/documents/${document.id}`);
  expect(unchanged.contentHash).toBe(document.contentHash);
  expect(unchanged.chunks.map(chunk => chunk.text).join("\n")).toContain("500 元");
  expect(app.providerCalls).toEqual([]);
  const sandboxDiagnostic = "Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.";
  expect(errors).toEqual([]); expect(consoleErrors.filter(message => message !== sandboxDiagnostic)).toEqual([]); expect(remoteRequests).toEqual([]);
});

test("PDF and Word knowledge documents support copy editing and version-bound original export", async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${app.origin}/knowledge`);
  const pdf = await importFile(page, "standards.pdf", textPdf("Invoice amount is 500 USD."));
  await openCopy(page, app, pdf.id);
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveValue(/Invoice amount is 500 USD\./);
  const word = await importFile(page, "费用标准.docx", await wordTableDocument());
  await openCopy(page, app, word.id);
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveValue(/主管审批/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "mobile.png"), animations: "disabled" });
  await page.goto(`${app.origin}/knowledge/documents/${word.id}`);
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeEnabled();
  expect((await browserApi(page, `/api/documents/${word.id}`, "DELETE")).status).toBe(200);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("menuitem", { name: "Word · .docx", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "不存在" })).toBeVisible();
});

test("cancelled source reads cannot replace a newer copy and failed preview or export preserves edits", async ({ page, app }) => {
  await page.goto(`${app.origin}/knowledge`);
  const document = await importKnowledge(page, "# 原始内容\n\n需要保留。");
  await page.goto(`${app.origin}/knowledge/documents/${document.id}`);
  let release!: () => void, received!: () => void, delivered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { received = resolve; }), ended = new Promise<void>(resolve => { delivered = resolve; });
  await page.route(`**/api/document-processor/source/${document.id}`, async route => {
    const response = await route.fetch(); received(); await gate;
    try { await route.fulfill({ response }); } catch {} finally { delivered(); }
  }, { times: 1 });
  await page.getByRole("button", { name: "编辑副本", exact: true }).click(); await entered;
  await page.getByRole("button", { name: "取消操作", exact: true }).click();
  await expect(page.getByRole("button", { name: "编辑副本", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "编辑副本", exact: true }).click();
  const content = page.getByLabel("文档内容", { exact: true });
  await expect(content).toBeVisible(); await content.fill("新的编辑内容"); release(); await ended;
  await expect(content).toHaveValue("新的编辑内容");
  await page.route("**/api/document-processor/export", route => route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "测试预览暂不可用" } } }), { times: 1 });
  await page.getByRole("tab", { name: "版式预览", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "测试预览暂不可用" })).toBeVisible();
  await page.getByRole("button", { name: "重新生成预览", exact: true }).click();
  await expect(page.frameLocator('iframe[title="文档版式预览"]').locator("body")).toContainText("新的编辑内容");
  await page.getByRole("tab", { name: "编辑内容", exact: true }).click();
  await page.route("**/api/document-processor/export", route => route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "测试导出暂不可用" } } }), { times: 1 });
  await page.getByRole("button", { name: "导出副本", exact: true }).click();
  await page.getByRole("menuitem", { name: "Word · .docx", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "测试导出暂不可用" })).toBeVisible();
  await expect(content).toHaveValue("新的编辑内容");
  expect((await exportAs(page, "docx", "Word")).suggestedFilename()).toBe("差旅标准.docx");
  await expect(content).toHaveValue("新的编辑内容");
});

test("chat conversion downloads survive restart, refuse stale versions and use integrated document details", async ({ page, app }) => {
  await page.goto(`${app.origin}/knowledge`);
  const document = await importKnowledge(page, sample);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "文档转换验证" })).body.data;
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.origin}/chat`);
  await page.getByPlaceholder(/输入你的问题/).fill(`OFFLINE_CONVERT_DOCUMENT DOCUMENT_ID=${document.id}`);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const button = page.getByRole("button", { name: "下载 Word · 差旅标准.docx", exact: true });
  await expect(button).toBeVisible();
  await expect.poll(async () => (await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes('"state":"output-available"'))).toBe(true);
  await app.restart(); await page.reload(); await expect(button).toBeVisible();
  const waiting = page.waitForEvent("download"); await button.click(); expect((await waiting).suggestedFilename()).toBe("差旅标准.docx");
  await importKnowledge(page, "# 更新后的差旅标准\n\n住宿上限为 600 元。");
  await button.click(); await expect(page.getByRole("alert").filter({ hasText: "文档已更新" })).toBeVisible();
  await openCopy(page, app, document.id);
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveValue(/600 元/);
  await page.getByText("导出选项", { exact: true }).click();
  await expect(page.getByLabel("文件名称", { exact: true })).toHaveValue("差旅标准.md");
});
