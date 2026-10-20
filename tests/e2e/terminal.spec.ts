import { openExecutionDetails } from "../helpers/execution-records";
import { expect, test as base, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";
import { decodePersistedAssistantToolMessage } from "../../src/lib/ai/ui-message";

async function storedTerminalStates(page: Page, chatId: string) {
  const rows = await browserData(page, `/api/conversations/${chatId}/messages`);
  return rows.filter(row => row.role === "assistant")
    .flatMap(row => decodePersistedAssistantToolMessage(row.content)?.tools ?? [])
    .filter(tool => tool.toolName === "runTerminalCommand").map(tool => tool.state);
}

type App = Awaited<ReturnType<typeof startStandaloneServer>> & { folder: string };
const test = base.extend<{ app: App }>({ app: async ({}, provide) => {
  const runtime = await startStandaloneServer({ modelFixture: true });
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-terminal-browser-")));
  try { await provide({ ...runtime, folder }); } finally {
    await runtime.close();
    if (dirname(folder) !== realpathSync.native(tmpdir()) || !basename(folder).startsWith("ria-terminal-browser-")) throw new Error("Unexpected terminal test directory");
    rmSync(folder, { recursive: true, force: true });
  }
} });
async function setup(page: Page, app: App, ui = false, mode: "approval" | "full-access" = "approval") {
  if (ui) await page.addInitScript(() => {
    Object.defineProperty(window, "privateAiDesktop", { value: {
      getSettings: async () => ({ hasOpenrouterApiKey: true, hasDeepseekApiKey: false, hasTavilyApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "Control+Shift+Space", windowBounds: null }),
      getRuntimeInfo: async () => ({ appVersion: "0.1.3", packaged: false, dataDirectory: "fixture/data", mediaDirectory: "fixture/media", logFile: "fixture/log" }),
      openFile: async (target: string) => {
        const state = window as Window & { openedFiles?: string[]; failFileOpen?: boolean };
        (state.openedFiles ??= []).push(target);
        return { opened: !state.failFileOpen };
      },
    } });
  });
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const response = await browserApi(page, "/api/directory-grants", "POST", { path: app.folder });
  expect(response.status).toBe(201);
  const grant = response.body.data;
  expect(grant.terminalEnabled).toBe(false);
  if (ui) {
    await page.goto(`${app.origin}/settings`);
    await page.getByRole("tab", { name: "文件权限", exact: true }).click();
    await page.getByRole("button", { name: "开启终端", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "开启终端权限", exact: true });
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveCSS("animation-name", "sheet-in");
    await expect(sheet.getByText(/工作目录不是文件访问沙箱/)).toBeVisible();
    await expect(sheet.getByRole("combobox", { name: "终端模式" })).toHaveText("审批");
    if (mode === "full-access") {
      await sheet.getByRole("combobox", { name: "终端模式" }).click();
      await page.getByRole("option", { name: "完全访问", exact: true }).click();
      await expect(sheet.getByText("LLM 的终端操作自动执行，无需逐条批准。", { exact: true })).toBeVisible();
    }
    await sheet.getByRole("button", { name: "确认开启终端权限", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "关闭终端", exact: true })).toBeVisible();
  } else {
    expect((await browserApi(page, `/api/directory-grants/${grant.id}`, "PATCH", { terminalEnabled: true, terminalApprovalMode: mode, revision: grant.updatedAt })).status).toBe(200);
  }
  return grant;
}
async function ask(page: Page, app: App, grantId: string, stop = false) {
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "终端验证" })).body.data;
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await page.getByPlaceholder(/输入你的问题/).fill(`OFFLINE_TERMINAL_COMMAND GRANT_ID=${grantId}${stop ? " TERMINAL_STOP" : ""}`);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  await expect(page.getByRole("dialog", { name: "执行记录", exact: true })).toBeHidden();
  await page.getByRole("region", { name: "操作审批", exact: true }).getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(page.getByLabel("PowerShell 命令", { exact: true })).toContainText("terminal-proof.txt");
  await expect(page.getByText(`工作目录：${app.folder}`, { exact: true })).toBeVisible();
  return chat;
}

function trackChatRequestBytes(page: Page) {
  const sizes: number[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/chat" && request.method() === "POST") sizes.push(request.postDataBuffer()?.byteLength ?? 0);
  });
  return sizes;
}

type TerminalStreamWindow = Window & { terminalStreamDone?: Promise<void>; continuationHeld?: boolean; releaseContinuation?: () => void };

async function trackTerminalStreams(page: Page, holdContinuation = false) {
  await page.evaluate(hold => {
    const original = window.fetch.bind(window);
    const state = window as TerminalStreamWindow;
    let chatRequests = 0;
    const gate = new Promise<void>(resolve => { state.releaseContinuation = resolve; });
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const chat = new URL(url, location.href).pathname === "/api/chat" && (init?.method ?? (input instanceof Request ? input.method : "GET")) === "POST";
      if (!chat) return original(input, init);
      const request = ++chatRequests;
      let finish!: () => void;
      state.terminalStreamDone = new Promise<void>(resolve => { finish = resolve; });
      const response = await original(input, init);
      if (!response.body) { finish(); return response; }
      return new Response(response.body.pipeThrough(new TransformStream({
        async flush() {
          if (hold && request === 2) {
            state.continuationHeld = true;
            await gate;
          }
          finish();
        },
      })), { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  }, holdContinuation);
}

async function approveAndFinish(page: Page) {
  const continuation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST");
  await page.getByRole("button", { name: "批准", exact: true }).click();
  const response = await continuation;
  expect(response.status()).toBe(200);
  // A command's file write precedes the next model step and message commit.
  // Wait for this stream's completion before asserting the next ready state.
  // Chromium does not reliably report loadingFinished for an SSE response.
  await page.evaluate(() => {
    const done = (window as TerminalStreamWindow).terminalStreamDone;
    if (!done) throw new Error("Terminal continuation stream was not tracked");
    return done;
  });
}

test("desktop folder permission, exact command approval and persisted output survive reload without re-execution", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  const grant = await setup(page, app, true);
  const chat = await ask(page, app, grant.id);
  expect(existsSync(join(app.folder, "terminal-proof.txt"))).toBe(false);
  await page.screenshot({ path: join(tmpdir(), "ria-inline-approval-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("region", { name: "操作审批", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), "ria-inline-approval-mobile.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  expect(existsSync(join(app.folder, "terminal-proof.txt"))).toBe(false);
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await openExecutionDetails(page);
  await expect(page.locator(".run-record-trigger")).toHaveCount(1);
  await expect(page.getByLabel("终端输出", { exact: true })).toContainText("terminal-ready-你好");
  await expect(page.getByText("退出码：0", { exact: true })).toBeVisible();
  await expect.poll(async () => (await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes('"state":"output-available"'))).toBe(true);
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
  await app.restart(); await page.reload();
  await openExecutionDetails(page);
  await expect(page.getByLabel("终端输出", { exact: true })).toContainText("terminal-ready-你好");
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), "ria-terminal-mobile.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("full access executes without approval, keeps live output and stop controls, persists and can switch back to approval", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const requestBytes = trackChatRequestBytes(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  const grant = await setup(page, app, true, "full-access");
  await expect(page.getByRole("button", { name: "终端：完全访问", exact: true })).toBeVisible();
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "自动终端" })).body.data;
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await page.getByPlaceholder(/输入你的问题/).fill(`OFFLINE_TERMINAL_COMMAND GRANT_ID=${grant.id} TERMINAL_STOP TERMINAL_LONG`);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await openExecutionDetails(page);
  await expect(page.getByLabel("终端输出", { exact: true })).toContainText("terminal-ready-你好");
  await expect(page.getByRole("region", { name: "操作审批", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "停止命令", exact: true }).click();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
  await page.getByRole("dialog", { name: "执行记录", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "请求失败" })).toHaveCount(0);
  expect(await storedTerminalStates(page, chat.id)).toEqual(["output-available"]);
  await page.reload();
  await page.getByPlaceholder(/输入你的问题/).fill("继续解释刚才的结果");
  const followup = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect((await followup).status()).toBe(200);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  expect(requestBytes.some(bytes => bytes > 2 * 1024 * 1024)).toBe(true);
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
  await app.restart();
  await page.goto(`${app.origin}/settings`);
  await page.getByRole("tab", { name: "文件权限", exact: true }).click();
  await page.getByRole("button", { name: "终端：完全访问", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "终端权限", exact: true });
  await expect(sheet.getByRole("combobox", { name: "终端模式" })).toHaveText("完全访问");
  await page.screenshot({ path: join(tmpdir(), "ria-terminal-mode-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), "ria-terminal-mode-mobile.png"), animations: "disabled" });
  await sheet.getByRole("combobox", { name: "终端模式" }).click();
  await page.getByRole("option", { name: "审批", exact: true }).click();
  await sheet.getByRole("button", { name: "保存终端权限", exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: "终端：审批", exact: true })).toBeVisible();
  await ask(page, app, grant.id);
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
  expect(errors).toEqual([]);
});

test("approval mode asks for every tool call and resumes a long script without truncation", async ({ page, app }) => {
  const requestBytes = trackChatRequestBytes(page);
  const grant = await setup(page, app);
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "逐次审批" })).body.data;
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await trackTerminalStreams(page);
  await page.getByPlaceholder(/输入你的问题/).fill(`OFFLINE_TERMINAL_COMMAND GRANT_ID=${grant.id} TERMINAL_TWICE TERMINAL_LONG`);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  expect(existsSync(join(app.folder, "terminal-proof.txt"))).toBe(false);
  expect(await storedTerminalStates(page, chat.id)).toEqual(["approval-requested"]);
  await approveAndFinish(page);
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert").filter({ hasText: "请求失败" })).toHaveCount(0);
  expect(await storedTerminalStates(page, chat.id)).toEqual(["output-available", "approval-requested"]);
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
  await expect(page.getByRole("region", { name: "最近编辑的文件", exact: true })).toHaveCount(0);
  await approveAndFinish(page);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("onceonce");
  expect(await storedTerminalStates(page, chat.id)).toEqual(["output-available", "output-available"]);
  expect(requestBytes.filter(bytes => bytes > 2 * 1024 * 1024)).toHaveLength(2);
  await page.reload();
  await openExecutionDetails(page);
  await expect(page.getByLabel("终端输出", { exact: true })).toHaveCount(2);
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("onceonce");
});

test("the next approval stays disabled until the preceding continuation stream is consumed", async ({ page, app }) => {
  const grant = await setup(page, app);
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "审批流边界" })).body.data;
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await trackTerminalStreams(page, true);
  await page.getByPlaceholder(/输入你的问题/).fill(`OFFLINE_TERMINAL_COMMAND GRANT_ID=${grant.id} TERMINAL_TWICE`);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  try {
    await page.getByRole("button", { name: "批准", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as TerminalStreamWindow).continuationHeld)).toBe(true);
    expect(await storedTerminalStates(page, chat.id)).toEqual(["output-available", "approval-requested"]);
    await expect(page.getByRole("button", { name: "批准", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "拒绝", exact: true })).toBeDisabled();
    expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
  } finally {
    await page.evaluate(() => (window as TerminalStreamWindow).releaseContinuation?.());
  }
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  await approveAndFinish(page);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  expect(await storedTerminalStates(page, chat.id)).toEqual(["output-available", "output-available"]);
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("onceonce");
});

test("completed replies show real file changes, persist them and open validated files through the desktop bridge", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const grant = await setup(page, app, true, "full-access");
  mkdirSync(join(app.folder, "src"));
  writeFileSync(join(app.folder, "src", "theme.ts"), "export const theme = { radius: 4 };\n");
  writeFileSync(join(app.folder, "old-draft.txt"), "旧草稿\n");
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "个人资料卡片" })).body.data;
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await page.getByPlaceholder(/输入你的问题/).fill("请整理个人资料卡片：统一配色，新增资料卡组件和使用说明，并移除旧草稿。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const files = page.getByRole("region", { name: "最近编辑的文件", exact: true });
  await expect(files).toBeVisible();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect(files.getByText("新增 2 个 · 修改 1 个 · 删除 1 个", { exact: true })).toHaveCount(1);
  await expect(files.getByRole("button", { name: "打开文件 old-draft.txt", exact: true })).toHaveCount(0);
  await files.getByRole("button", { name: "展开其余 1 个文件", exact: true }).click();
  await expect(files.getByRole("button", { name: "打开文件 old-draft.txt", exact: true })).toBeDisabled();
  await expect(files.getByText("src · 1 → 5 行", { exact: true })).toBeVisible();
  await files.getByRole("button", { name: "收起", exact: true }).click();
  const component = files.getByRole("button", { name: "打开文件 src/components/profile-card.tsx", exact: true });
  await component.click();
  await expect.poll(() => page.evaluate(() => (window as Window & { openedFiles?: string[] }).openedFiles)).toEqual([realpathSync.native(join(app.folder, "src", "components", "profile-card.tsx"))]);
  await expect(component).toBeEnabled();
  await page.getByTestId("message-list").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: join(tmpdir(), "ria-edited-files-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await files.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), "ria-edited-files-mobile.png"), animations: "disabled" });
  await app.restart(); await page.reload();
  await expect(files).toBeVisible();
  await expect(files.getByText("新增 2 个 · 修改 1 个 · 删除 1 个", { exact: true })).toHaveCount(1);
  await page.evaluate(() => { (window as Window & { failFileOpen?: boolean }).failFileOpen = true; });
  await component.click();
  await expect(files.getByRole("alert")).toContainText("系统未能打开此文件");
  await page.evaluate(() => { (window as Window & { failFileOpen?: boolean }).failFileOpen = false; });
  await component.click();
  await expect(files.getByRole("alert")).toHaveCount(0);
  unlinkSync(join(app.folder, "src", "components", "profile-card.tsx"));
  await component.click();
  await expect(files.getByRole("alert")).toContainText("文件已移动或删除");
  const current = (await browserData(page, "/api/directory-grants")).find(row => row.id === grant.id);
  expect((await browserApi(page, `/api/directory-grants/${grant.id}`, "PATCH", { terminalEnabled: false, revision: current.updatedAt })).status).toBe(200);
  await files.getByRole("button", { name: "打开文件 README.md", exact: true }).click();
  await expect(files.getByRole("alert")).toContainText("终端权限");
  expect(errors).toEqual([]);
});

test("rejection executes nothing and a long command exposes live output and can be stopped", async ({ page, app }) => {
  const grant = await setup(page, app);
  await ask(page, app, grant.id);
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "执行记录", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  expect(existsSync(join(app.folder, "terminal-proof.txt"))).toBe(false);
  const chat = await ask(page, app, grant.id, true);
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await openExecutionDetails(page);
  await expect(page.getByLabel("终端输出", { exact: true })).toContainText("terminal-ready-你好");
  await expect(page.getByRole("button", { name: "停止命令", exact: true })).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), "ria-terminal-running.png"), animations: "disabled" });
  await page.getByRole("button", { name: "停止命令", exact: true }).click();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止命令", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes('"status":"stopped"'))).toBe(true);
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
});
