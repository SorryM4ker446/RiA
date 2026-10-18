import { expect, test as base, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";

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
async function setup(page: Page, app: App, ui = false) {
  if (ui) await page.addInitScript(() => {
    Object.defineProperty(window, "privateAiDesktop", { value: {
      getSettings: async () => ({ hasOpenrouterApiKey: true, hasDeepseekApiKey: false, hasTavilyApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "Control+Shift+Space", windowBounds: null }),
      getRuntimeInfo: async () => ({ appVersion: "0.1.3", packaged: false, dataDirectory: "fixture/data", mediaDirectory: "fixture/media", logFile: "fixture/log" }),
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
    await sheet.getByRole("button", { name: "确认开启终端权限", exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "关闭终端", exact: true })).toBeVisible();
  } else {
    expect((await browserApi(page, `/api/directory-grants/${grant.id}`, "PATCH", { terminalEnabled: true, revision: grant.updatedAt })).status).toBe(200);
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
  await expect(page.getByLabel("PowerShell 命令", { exact: true })).toContainText("terminal-proof.txt");
  await expect(page.getByText(`工作目录：${app.folder}`, { exact: true })).toBeVisible();
  return chat;
}

test("desktop folder permission, exact command approval and persisted output survive reload without re-execution", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  const grant = await setup(page, app, true);
  const chat = await ask(page, app, grant.id);
  expect(existsSync(join(app.folder, "terminal-proof.txt"))).toBe(false);
  await page.reload();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  expect(existsSync(join(app.folder, "terminal-proof.txt"))).toBe(false);
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.getByLabel("终端输出", { exact: true })).toContainText("terminal-ready-你好");
  await expect(page.getByText("退出码：0", { exact: true })).toBeVisible();
  await expect.poll(async () => (await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes('"state":"output-available"'))).toBe(true);
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
  await app.restart(); await page.reload();
  await expect(page.getByLabel("终端输出", { exact: true })).toContainText("terminal-ready-你好");
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), "ria-terminal-mobile.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("rejection executes nothing and a long command exposes live output and can be stopped", async ({ page, app }) => {
  const grant = await setup(page, app);
  await ask(page, app, grant.id);
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.getByRole("button", { name: "批准", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  expect(existsSync(join(app.folder, "terminal-proof.txt"))).toBe(false);
  const chat = await ask(page, app, grant.id, true);
  await page.getByRole("button", { name: "批准", exact: true }).click();
  await expect(page.getByLabel("终端输出", { exact: true })).toContainText("terminal-ready-你好");
  await expect(page.getByRole("button", { name: "停止命令", exact: true })).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), "ria-terminal-running.png"), animations: "disabled" });
  await page.getByRole("button", { name: "停止命令", exact: true }).click();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止命令", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes('"status":"stopped"'))).toBe(true);
  expect(readFileSync(join(app.folder, "terminal-proof.txt"), "utf8")).toBe("once");
});
