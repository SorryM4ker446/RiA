import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { browserApi, browserData } from "../helpers/browser-api";

type App = Awaited<ReturnType<typeof startStandaloneServer>> & { folder: string };
const test = base.extend<{ app: App }>({ app: async ({}, provide) => {
  const runtime = await startStandaloneServer();
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-chat-permissions-")));
  try { await provide({ ...runtime, folder }); } finally {
    await runtime.close();
    if (dirname(folder) !== realpathSync.native(tmpdir()) || !basename(folder).startsWith("ria-chat-permissions-")) throw new Error("Unexpected permissions test directory");
    rmSync(folder, { recursive: true, force: true });
  }
} });

async function desktop(page: Page, app: App) {
  await page.addInitScript(folder => {
    Object.defineProperty(window, "riaDesktop", { value: {
      chooseFolder: async () => {
        const calls = Number(sessionStorage.getItem("folder-dialog-calls") ?? 0);
        sessionStorage.setItem("folder-dialog-calls", String(calls + 1));
        return calls === 0 ? { canceled: true } : { canceled: false, path: folder };
      },
      getSettings: async () => ({ hasOpenrouterApiKey: false, hasDeepseekApiKey: false, hasTavilyApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "Control+Shift+Space", windowBounds: null }),
      getRuntimeInfo: async () => ({ appVersion: "0.1.3", packaged: false, dataDirectory: "fixture/data", mediaDirectory: "fixture/media", logFile: "fixture/log" }),
    } });
  }, app.folder);
  await openWorkspace(page, app.origin);
}

test("chat permissions choose and grant a directory without sending the draft, and synchronize terminal availability and settings", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let chatRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/chat" && request.method() === "POST") chatRequests++; });
  await page.setViewportSize({ width: 1440, height: 960 });
  await desktop(page, app);
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "目录授权验证" })).body.data;
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  const draft = page.getByPlaceholder(/输入你的问题/);
  await draft.fill("保留这段尚未发送的草稿");
  await page.getByRole("combobox", { name: "选择工具", exact: true }).click();
  await expect(page.getByRole("option", { name: "执行终端命令（未配置）", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const trigger = page.getByRole("button", { name: "文件权限", exact: true });
  const records = await page.getByRole("button", { name: "执行记录", exact: true }).boundingBox();
  const permissions = await trigger.boundingBox();
  expect(records!.x).toBeGreaterThanOrEqual(permissions!.x + permissions!.width);
  expect(permissions!.y).toBe(records!.y);
  await page.screenshot({ path: join(tmpdir(), "ria-chat-permissions-entry.png"), animations: "disabled" });
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "文件权限", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveCSS("animation-name", "sheet-in");
  await expect(sheet.getByText(/管理所有会话可用的本地目录/)).toBeVisible();
  await sheet.getByRole("button", { name: "选择目录", exact: true }).click();
  await expect(sheet.getByLabel("目录路径", { exact: true })).toHaveValue("");
  expect(await browserData(page, "/api/directory-grants")).toHaveLength(0);
  await sheet.getByRole("button", { name: "选择目录", exact: true }).click();
  await expect(sheet.getByLabel("目录路径", { exact: true })).toHaveValue(app.folder);
  expect(await browserData(page, "/api/directory-grants")).toHaveLength(0);
  await sheet.getByLabel("目录路径", { exact: true }).press("Enter");
  await expect(sheet.getByRole("button", { name: "开启终端", exact: true })).toBeVisible();
  const [grant] = await browserData(page, "/api/directory-grants");
  expect(grant.terminalEnabled).toBe(false);
  expect(chatRequests).toBe(0);
  await sheet.getByRole("button", { name: "开启终端", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "开启终端权限", exact: true });
  await expect(confirm.getByText(/工作目录不是文件访问沙箱/)).toBeVisible();
  await confirm.getByRole("button", { name: "确认开启终端权限", exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(sheet.getByRole("button", { name: "关闭终端", exact: true })).toBeVisible();
  await page.screenshot({ path: join(tmpdir(), "ria-chat-permissions-desktop.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭文件权限", exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(draft).toHaveValue("保留这段尚未发送的草稿");
  await page.getByRole("combobox", { name: "选择工具", exact: true }).click();
  await expect(page.getByRole("option", { name: "执行终端命令（未配置）", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(sheet).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await sheet.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), "ria-chat-permissions-mobile.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await trigger.click();
  await expect(sheet).toHaveCSS("animation-name", "none");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.goto(`${app.origin}/settings`);
  await page.getByRole("tab", { name: "文件权限", exact: true }).click();
  await expect(page.getByRole("button", { name: "关闭终端", exact: true })).toBeVisible();
  await page.goto(`${app.origin}/chat`);
  await trigger.click();
  await sheet.getByRole("button", { name: "关闭终端", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "开启终端", exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "撤销", exact: true }).click();
  // A withdrawn folder is removed from the list rather than kept as history.
  await expect(sheet.getByRole("list", { name: "目录授权", exact: true })).toHaveCount(0);
  await expect(sheet.getByText(/已撤销/)).toHaveCount(0);
  expect(await browserData(page, "/api/directory-grants")).toHaveLength(0);
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "选择工具", exact: true }).click();
  await expect(page.getByRole("option", { name: "执行终端命令（未配置）", exact: true })).toBeVisible();
  expect(chatRequests).toBe(0);
  expect(errors).toEqual([]);
});

test("failed directory authorization retains the entered path and chat draft and can be retried explicitly", async ({ page, app }) => {
  await desktop(page, app);
  const draft = page.getByPlaceholder(/输入你的问题/);
  await draft.fill("授权失败也不要发送这段文字");
  await page.getByRole("button", { name: "文件权限", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "文件权限", exact: true });
  await page.route("**/api/directory-grants", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "测试中的授权服务暂不可用" } }) });
  });
  await sheet.getByLabel("目录路径", { exact: true }).fill(app.folder);
  await sheet.getByRole("button", { name: "授权", exact: true }).click();
  await expect(sheet.getByRole("alert")).toContainText("测试中的授权服务暂不可用");
  await expect(sheet.getByLabel("目录路径", { exact: true })).toHaveValue(app.folder);
  expect(await browserData(page, "/api/directory-grants")).toHaveLength(0);
  await page.unroute("**/api/directory-grants");
  await sheet.getByRole("button", { name: "授权", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "开启终端", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(draft).toHaveValue("授权失败也不要发送这段文字");
});
