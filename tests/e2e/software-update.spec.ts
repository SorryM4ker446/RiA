import { test as base, expect, type Page } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { closeSettings, settingsDialog } from "../helpers/settings";
import { toasts } from "../helpers/toast";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

type Recorded = { calls: string[]; saved: unknown[]; revealed: string[] };
type Controls = { __updates: Recorded; __set: (next: Record<string, unknown>) => void; __openUpdates: () => void };

/*
 * The main process owns the update, so the page is driven by a bridge that moves
 * through the same states it reports. Applying starts a download whose progress
 * and completion the test sets; the first check fails and the second finds a
 * release.
 */
async function updateBridge(page: Page, initial: Record<string, unknown> = {}) {
  await page.addInitScript((initial) => {
    const recorded: Recorded = { calls: [], saved: [], revealed: [] };
    const listeners = new Set<(state: unknown) => void>();
    const openers = new Set<() => void>();
    let checks = 0;
    let state: Record<string, unknown> = {
      supported: true, phase: "idle", currentVersion: "0.1.15", availableVersion: null, checkedAt: null,
      received: 0, total: 0, failure: null, previousInstall: null, ...initial,
    };
    const change = (next: Record<string, unknown>) => { state = { ...state, ...next }; listeners.forEach(listener => listener(state)); return state; };
    const settings = { hasOpenrouterApiKey: true, hasDeepseekApiKey: false, hasTavilyApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "", windowBounds: null, autoCheckUpdates: true, locale: "zh-CN" };
    Object.assign(window, { __updates: recorded, __set: change, __openUpdates: () => openers.forEach(open => open()) });
    Object.defineProperty(window, "riaDesktop", { value: {
      getSettings: async () => settings,
      getRuntimeInfo: async () => ({ appVersion: "0.1.15", packaged: true, dataDirectory: "fixture/data", mediaDirectory: "fixture/media", logFile: "fixture/log" }),
      saveSettings: async (input: Record<string, unknown>) => {
        recorded.saved.push(input);
        Object.assign(settings, input);
        return { settings, restarting: false };
      },
      revealPath: async (target: string) => { recorded.revealed.push(target); return { revealed: true }; },
      updates: {
        state: async () => state,
        check: async () => {
          recorded.calls.push("check");
          return ++checks === 1 ? change({ failure: "network" }) : change({ phase: "available", availableVersion: "0.1.16", failure: null });
        },
        apply: async () => {
          recorded.calls.push("apply");
          return state.phase === "available" ? change({ phase: "downloading", received: 0, total: 52_428_800, failure: null }) : change({ phase: "installing", failure: null });
        },
        cancel: async () => { recorded.calls.push("cancel"); return change({ phase: "available", received: 0 }); },
        onChange: (listener: (state: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        onOpen: (listener: () => void) => { openers.add(listener); return () => openers.delete(listener); },
      },
    } });
  }, initial);
}

const recorded = (page: Page) => page.evaluate(() => (window as unknown as Controls).__updates);
const set = (page: Page, next: Record<string, unknown>) => page.evaluate(value => (window as unknown as Controls).__set(value), next);

test("a new version appears above settings and one click updates it with visible progress", async ({ page, app }) => {
  await updateBridge(page, { phase: "available", availableVersion: "0.1.16" });
  await openWorkspace(page, app.origin);
  const notice = page.getByRole("button", { name: /新版本 0\.1\.16/ });
  await expect(notice).toHaveAccessibleName("新版本 0.1.16 · 点击更新");
  await expect(notice).toHaveText("新版本 0.1.16更新");

  await notice.click();
  const dialog = page.getByRole("alertdialog", { name: "更新到 0.1.16" });
  await expect(dialog).toBeVisible();
  await set(page, { received: 20_971_520 });
  await expect(dialog.getByRole("progressbar", { name: "下载进度" })).toHaveAttribute("aria-valuenow", "40");
  await expect(dialog).toContainText("40%");
  await expect(dialog).toContainText("20.0 / 50.0 MB");
  // The dialog holds the focus, so the keyboard acts on it rather than the page beneath.
  await expect(dialog.getByRole("button", { name: "后台下载", exact: true })).toBeFocused();

  // Hiding it leaves the download running; the sidebar shows it and brings it back.
  await dialog.getByRole("button", { name: "后台下载", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(notice).toHaveAccessibleName("新版本 0.1.16 · 正在下载 40%");
  await expect(notice).toHaveText("新版本 0.1.1640%");
  await notice.click();
  await expect(dialog).toBeVisible();

  await set(page, { phase: "ready", received: 52_428_800 });
  await expect(dialog).toContainText("更新包已通过校验");
  await set(page, { phase: "installing" });
  await expect(dialog).toContainText("RiA 即将退出并安装新版本");
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  await expect(dialog.getByRole("button")).toHaveCount(0);
  expect((await recorded(page)).calls).toEqual(["apply"]);
});

test("cancelling stops the update, and a failure offers a retry", async ({ page, app }) => {
  await updateBridge(page, { phase: "available", availableVersion: "0.1.16" });
  await openWorkspace(page, app.origin);
  const notice = page.getByRole("button", { name: /新版本 0\.1\.16/ });
  await notice.click();
  const dialog = page.getByRole("alertdialog", { name: "更新到 0.1.16" });
  await dialog.getByRole("button", { name: "取消更新", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(notice).toHaveAccessibleName("新版本 0.1.16 · 点击更新");

  await notice.click();
  await set(page, { phase: "available", received: 0, failure: "verification" });
  const failed = page.getByRole("alertdialog", { name: "更新未完成" });
  await expect(failed).toContainText("未通过签名或校验");
  await failed.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "更新到 0.1.16" })).toBeVisible();
  expect((await recorded(page)).calls).toEqual(["apply", "cancel", "apply", "apply"]);
});

test("the settings card checks, reports the last install and starts the same update", async ({ page, app }) => {
  await updateBridge(page, { previousInstall: { outcome: "failed", version: "0.1.15", exitCode: 1603, logFile: "C:\\RiA\\logs\\update-install.log" } });
  await openWorkspace(page, app.origin);
  // Nothing is offered yet, so the sidebar says nothing.
  await expect(page.getByRole("button", { name: /新版本/ })).toHaveCount(0);
  await page.goto(`${app.origin}/chat?settings=application`);
  const card = settingsDialog(page).locator("#updates");
  await expect(card).toContainText("当前版本 0.1.15");
  await expect(card).toContainText("尚未检查更新");
  await expect(card).toContainText("0.1.15 未能安装（错误代码 1603），安装包已删除。");
  await card.getByRole("button", { name: "查看安装日志", exact: true }).click();
  expect((await recorded(page)).revealed).toEqual(["C:\\RiA\\logs\\update-install.log"]);

  const check = card.getByRole("button", { name: "检查更新", exact: true });
  await check.click();
  await expect(card.getByRole("alert")).toContainText("无法连接更新服务器");
  await check.click();
  await expect(card).toContainText("0.1.16 可以更新");
  await expect(card.getByRole("alert")).toHaveCount(0);

  await card.getByRole("button", { name: "立即更新", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "更新到 0.1.16" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "后台下载", exact: true }).click();
  await set(page, { received: 26_214_400 });
  await expect(card).toContainText("正在下载 0.1.16 · 50%");
  await card.getByRole("button", { name: "查看进度", exact: true }).click();
  await expect(dialog).toBeVisible();
  // Escape hides the update dialog alone; the settings beneath stay open.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(card).toBeVisible();

  const automatic = card.getByRole("checkbox", { name: "自动检查更新", exact: true });
  await expect(automatic).toBeChecked();
  await automatic.click();
  await expect(automatic).not.toBeChecked();
  await expect(toasts(page)).toContainText("已关闭自动检查更新");
  const calls = await recorded(page);
  expect(calls.calls).toEqual(["check", "check", "apply"]);
  expect(calls.saved).toEqual([{ autoCheckUpdates: false }]);
});

test("clicking the new-version notification opens the update card", async ({ page, app }) => {
  await updateBridge(page, { phase: "available", availableVersion: "0.1.16" });
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/tasks?settings=application`);
  await closeSettings(page);
  await page.evaluate(() => (window as unknown as Controls).__openUpdates());
  await expect(page).toHaveURL(`${app.origin}/tasks?settings=application`);
  await expect(settingsDialog(page).locator("#updates")).toBeInViewport();
});
