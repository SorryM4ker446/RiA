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

test("narrow document workspaces put editing before export settings and keep dropdown triggers stable", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${app.origin}/document-processor`);
  const create = page.getByRole("button", { name: "新建内容", exact: true });
  await expect(create).toBeVisible();
  const createBox = (await create.boundingBox())!;
  expect(createBox.y + createBox.height).toBeLessThan(844);
  await create.click();
  const content = page.getByLabel("文档内容", { exact: true });
  await content.fill("# 可编辑草稿\n\n保留本次修改。");
  const editor = page.getByRole("heading", { name: "内容与预览", exact: true });
  const settings = page.getByRole("heading", { name: "导出设置", exact: true });
  expect((await editor.boundingBox())!.y).toBeLessThan((await settings.boundingBox())!.y);
  expect((await content.boundingBox())!.height).toBe(320);
  const select = page.getByLabel("导出格式", { exact: true });
  await select.scrollIntoViewIfNeeded();
  const before = (await select.boundingBox())!;
  await select.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("listbox")).toHaveCSS("animation-name", "pop-in");
  const opened = (await select.boundingBox())!;
  expect(opened.x).toBeCloseTo(before.x, 1); expect(opened.y).toBeCloseTo(before.y, 1);
  await select.click();
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(select).toBeFocused();
  await create.scrollIntoViewIfNeeded();
  page.once("dialog", dialog => dialog.dismiss()); await create.click();
  await expect(content).toHaveValue("# 可编辑草稿\n\n保留本次修改。");
  await content.scrollIntoViewIfNeeded();
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "mobile-layout.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator(".workspace-content").evaluate(node => { node.scrollTop = 0; });
  expect((await editor.boundingBox())!.x).toBeGreaterThan((await settings.boundingBox())!.x);
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("tab", { name: "版式预览", exact: true }).click();
  await expect(page.frameLocator('iframe[title="文档版式预览"]').getByRole("heading", { name: "可编辑草稿", exact: true })).toBeVisible();
  await page.screenshot({ path: join(screenshots, "desktop-light.png"), animations: "disabled" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("tab", { name: "编辑内容", exact: true }).click();
  await expect(page.getByRole("tabpanel").filter({ has: content })).toHaveCSS("animation-name", "none");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

async function upload(page: Page, name: string, buffer: Buffer) {
  await page.getByLabel("选择待处理文档", { exact: true }).setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  await expect(page.getByLabel("文档内容", { exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "解析完成" })).toBeVisible();
}
async function importKnowledge(page: Page, content: string) {
  return page.evaluate(async content => {
    const form = new FormData(); form.set("file", new File([content], "差旅标准.md"));
    const response = await fetch("/api/documents", { method: "POST", body: form });
    if (!response.ok) throw new Error(`Import failed: ${response.status}`);
    return (await response.json()).data.document;
  }, content);
}

test("document actions select files as parameters and return to automatic tools after one explicit execution", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${app.origin}/document-processor`);
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
  await page.goto(`${app.origin}/document-processor`);
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
  await page.route("**/api/tools/run", route => route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "文档服务暂不可用" } } }), { times: 1 });
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

test("local documents preview safely and download all four formats without saving originals or calling a model", async ({ page, app }) => {
  const errors: string[] = [], consoleErrors: string[] = [], remoteRequests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("request", request => { if (request.url().includes("foreign.invalid")) remoteRequests.push(request.url()); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${app.origin}/document-processor`);
  await expect(page.getByRole("heading", { name: "文档处理器", exact: true })).toBeVisible();
  await upload(page, "差旅标准.md", Buffer.from(sample));
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveValue(sample);
  await page.getByRole("tab", { name: "版式预览", exact: true }).click();
  const preview = page.frameLocator('iframe[title="文档版式预览"]');
  await expect(preview.getByRole("heading", { name: "差旅标准", exact: true })).toBeVisible();
  await expect(preview.getByRole("cell", { name: "500 元", exact: true })).toBeVisible();
  await expect(preview.locator("body")).toContainText("<script>");
  await expect(preview.locator("img, script")).toHaveCount(0);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "desktop.png"), fullPage: true, animations: "disabled" });
  for (const [format, label] of [["docx", "Word"], ["md", "Markdown"], ["txt", "纯文本"], ["html", "HTML"]]) {
    await page.getByLabel("导出格式", { exact: true }).click();
    await page.getByRole("option", { name: `${label} · .${format}`, exact: true }).click();
    const waiting = page.waitForEvent("download"); await page.getByRole("button", { name: `下载 ${label}`, exact: true }).click();
    const download = await waiting; expect(download.suggestedFilename()).toBe(`差旅标准.${format}`);
    const bytes = await readFile((await download.path())!);
    if (format === "docx") {
      const zip = await JSZip.loadAsync(bytes), xml = await zip.file("word/document.xml")!.async("string");
      expect(xml).toContain("<w:tbl>"); expect(xml).toContain("主管审批"); expect(xml).toContain("Heading1");
      await download.saveAs(join(screenshots, "converted.docx"));
    } else {
      expect(bytes.toString()).toContain("500 元");
      if (format === "md") expect(bytes.toString()).toBe(sample);
      if (format === "html") expect(bytes.toString()).not.toContain("<script>");
    }
    await expect(page.getByRole("button", { name: `下载 ${label}`, exact: true })).toBeEnabled();
  }
  expect(await browserData(page, "/api/documents")).toEqual([]); expect(app.providerCalls).toEqual([]);
  // Chromium refuses recorder/selector injection into a script-free srcdoc
  // frame. Keep the sandbox and require all other console errors to be absent;
  // the frame above must contain neither script elements nor remote images.
  const sandboxDiagnostic = "Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.";
  expect(errors).toEqual([]); expect(consoleErrors.filter(message => message !== sandboxDiagnostic)).toEqual([]); expect(remoteRequests).toEqual([]);
});

test("PDF and Word parsing keep readable content in narrow windows and failed replacements preserve the current draft", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${app.origin}/document-processor`);
  await upload(page, "standards.pdf", textPdf("Invoice amount is 500 USD."));
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveValue(/Invoice amount is 500 USD\./);
  await expect(page.getByText(/1 页/, { exact: false })).toBeVisible();
  await upload(page, "费用标准.docx", await wordTableDocument());
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveValue(/主管审批/);
  await page.getByLabel("文档内容", { exact: true }).fill("# 已编辑的内容\n\n请保留这份草稿。");
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("选择待处理文档", { exact: true }).setInputFiles({ name: "bad.pdf", mimeType: "application/pdf", buffer: Buffer.from("not pdf") });
  await expect(page.getByRole("alert").filter({ hasText: "操作未完成" })).toContainText("文件");
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveValue("# 已编辑的内容\n\n请保留这份草稿。");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "mobile.png"), fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
});

test("cancelled parsing cannot overwrite a newer draft and failed exports remain recoverable", async ({ page, app }) => {
  await page.goto(`${app.origin}/document-processor`);
  await page.getByRole("button", { name: "新建内容", exact: true }).click();
  await page.getByLabel("文档内容", { exact: true }).fill("需要保留的内容");
  let release!: () => void, received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { received = resolve; });
  await page.route("**/api/document-processor/parse", async route => {
    const response = await route.fetch(); received(); await gate;
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  page.once("dialog", dialog => dialog.accept());
  await page.getByLabel("选择待处理文档", { exact: true }).setInputFiles({ name: "obsolete.txt", mimeType: "text/plain", buffer: Buffer.from("过期解析结果") });
  await entered; await page.getByRole("button", { name: "取消操作", exact: true }).click();
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveValue("需要保留的内容");
  await page.getByLabel("文档内容", { exact: true }).fill("新的编辑内容"); release();
  await page.route("**/api/document-processor/export", route => route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "测试导出暂不可用" } } }), { times: 1 });
  await page.getByRole("button", { name: "下载 Word", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "操作未完成" })).toContainText("测试导出暂不可用");
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveValue("新的编辑内容");
  const waiting = page.waitForEvent("download"); await page.getByRole("button", { name: "下载 Word", exact: true }).click();
  expect((await waiting).suggestedFilename()).toBe("未命名文档.docx");
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveValue("新的编辑内容");
});

test("chat conversion downloads survive restart, refuse stale versions and open the source in the processor", async ({ page, app }) => {
  await page.goto(`${app.origin}/document-processor`);
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
  await page.goto(`${app.origin}/knowledge/documents/${document.id}`);
  await page.getByRole("link", { name: "转换与导出", exact: true }).click();
  await expect(page.getByLabel("文档内容", { exact: true })).toHaveValue(/600 元/);
  await expect(page.getByLabel("文件名称", { exact: true })).toHaveValue("差旅标准.md");
});
