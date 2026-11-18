import { test as base, expect, type Page } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { acceptConfirm } from "../helpers/confirm";
import { chooseRowAction } from "../helpers/row-menu";
import { toasts } from "../helpers/toast";

/*
 * The storage settings as the desktop app shows them. The shell is stood in for
 * by a bridge that records what the page asks; the move itself, which runs at
 * the next start, is covered by tests/desktop/data-location.test.ts and the
 * data-move smoke run.
 */

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

type Fixture = { view: Partial<DesktopDataLocationView>; checks?: Record<string, DesktopLocationCheck>; chosen?: string[] };
async function desktopBridge(page: Page, fixture: Fixture) {
  await page.addInitScript((input: Fixture) => {
    const calls: unknown[][] = [];
    (window as unknown as { __calls: unknown[][] }).__calls = calls;
    const chosen = [...(input.chosen ?? [])];
    const view: DesktopDataLocationView = {
      defaultPath: "C:\\Users\\me\\AppData\\Roaming\\RiA\\data",
      data: { path: "C:\\Users\\me\\AppData\\Roaming\\RiA\\data", moved: false },
      cache: { path: "C:\\Users\\me\\AppData\\Roaming\\RiA\\data", custom: false, unavailable: null },
      copies: [], pending: false, result: null, lowSpace: null, ...input.view,
    };
    const settings = { hasOpenrouterApiKey: true, hasDeepseekApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "", windowBounds: null, autoCheckUpdates: false, taskNotifications: {} };
    Object.defineProperty(window, "riaDesktop", { value: {
      getSettings: async () => settings,
      getRuntimeInfo: async () => ({ appVersion: "0.1.2", packaged: false, platform: "win32", dataDirectory: view.data.path, mediaDirectory: "", logFile: "", notificationsSupported: false }),
      saveSettings: async () => ({ settings, restarting: false }),
      dataLocation: {
        view: async () => { calls.push(["view"]); return view; },
        sizes: async () => ({ dataBytes: 3.2 * 1024 ** 3, cacheBytes: 820 * 1024 ** 2, freeBytes: 120 * 1024 ** 3, copies: Object.fromEntries(view.copies.map(copy => [copy.path, 3.1 * 1024 ** 3])) }),
        choose: async (kind: string) => { calls.push(["choose", kind]); return chosen.shift() ?? null; },
        check: async (kind: string, target: string | null) => { calls.push(["check", kind, target]); return input.checks?.[String(target)] ?? { ok: false, code: "unknown" }; },
        move: async (kind: string, target: string | null) => { calls.push(["move", kind, target]); return { ok: true }; },
        deleteCopy: async (path: string) => { calls.push(["deleteCopy", path]); view.copies = view.copies.filter(copy => copy.path !== path); return { ok: true }; },
        forgetCopy: async (path: string) => { calls.push(["forgetCopy", path]); view.copies = view.copies.filter(copy => copy.path !== path); return { ok: true }; },
        acknowledge: async (id: string) => { calls.push(["acknowledge", id]); if (view.result?.id === id) view.result = { ...view.result, seen: true }; },
        dismissLowSpace: async () => { calls.push(["dismissLowSpace"]); view.lowSpace = null; },
        open: async (path: string) => { calls.push(["open", path]); return { opened: true }; },
      },
    } });
  }, fixture);
}
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: unknown[][] }).__calls);
const storage = async (page: Page, origin: string) => {
  await page.goto(`${origin}/chat?settings=storage`);
  const section = page.getByRole("region", { name: "数据位置", exact: true });
  await expect(section).toBeVisible();
  return section;
};

test("moving the data says what will happen, and a refused folder says why", async ({ page, app }) => {
  await desktopBridge(page, {
    view: {},
    chosen: ["\\\\server\\share", "D:\\RiA"],
    checks: {
      "\\\\server\\share": { ok: false, code: "network-path" },
      "D:\\RiA": { ok: true, kind: "data", target: "D:\\RiA", mode: "copy", copyBytes: 3.2 * 1024 ** 3, requiredBytes: 3.8 * 1024 ** 3, availableBytes: 120 * 1024 ** 3 },
    },
  });
  await openWorkspace(page, app.origin);
  const section = await storage(page, app.origin);
  const data = section.getByRole("article", { name: /^数据 C:/ });
  await expect(data).toContainText("使用中");
  await expect(data).toContainText("默认位置 · 所在磁盘可用 120 GB");
  await expect(data).toContainText("3.2 GB");
  await expect(section.getByRole("article", { name: /^缓存 / })).toContainText("跟随数据");

  await section.getByRole("button", { name: "更改位置…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "移动数据" });
  await expect(dialog).toContainText("网络位置不能存放数据");
  await expect(dialog.getByRole("button", { name: "移动并重新启动" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "换一个文件夹…", exact: true }).click();
  await expect(dialog).toContainText("D:\\RiA");
  await expect(dialog).toContainText("要复制3.2 GB");
  await expect(dialog).toContainText("目标磁盘可用120 GB");
  await expect(dialog).toContainText("原来的文件夹会保留");
  await dialog.getByRole("button", { name: "移动并重新启动", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "正在重新启动…" })).toBeDisabled();
  expect(await calls(page)).toContainEqual(["move", "data", "D:\\RiA"]);
});

test("a folder that already holds RiA data is used as it is, and the user is told the current data is not merged", async ({ page, app }) => {
  await desktopBridge(page, {
    view: {}, chosen: ["E:\\Old RiA"],
    checks: { "E:\\Old RiA": { ok: true, kind: "data", target: "E:\\Old RiA", mode: "adopt", copyBytes: 0, requiredBytes: 0, availableBytes: 50 * 1024 ** 3 } },
  });
  await openWorkspace(page, app.origin);
  const section = await storage(page, app.origin);
  await section.getByRole("button", { name: "更改位置…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "移动数据" });
  await expect(dialog).toContainText("当前的数据不会合并过去");
  await expect(dialog).not.toContainText("要复制");
  await dialog.getByRole("button", { name: "使用这份数据并重新启动", exact: true }).click();
  expect(await calls(page)).toContainEqual(["move", "data", "E:\\Old RiA"]);
});

test("old copies can be opened and deleted after a confirmation, and a missing one is only taken off the list", async ({ page, app }) => {
  await desktopBridge(page, {
    view: {
      data: { path: "D:\\RiA", moved: true },
      copies: [
        { path: "C:\\Users\\me\\AppData\\Roaming\\RiA\\data.moved-20261117T080000Z", at: "2026-11-17T08:00:00.000Z", exists: true },
        { path: "F:\\Gone", at: "2026-11-10T08:00:00.000Z", exists: false },
      ],
    },
  });
  await openWorkspace(page, app.origin);
  const section = await storage(page, app.origin);
  await expect(section.getByRole("article", { name: /^数据 D:/ })).toContainText("已移到其他位置");
  const copy = section.getByRole("article", { name: /data\.moved-/ });
  await expect(copy).toContainText("3.1 GB");
  await chooseRowAction(page, copy, "删除…");
  await acceptConfirm(page, "无法恢复");
  await expect(toasts(page)).toContainText("旧数据已删除");
  await expect(copy).toHaveCount(0);

  const missing = section.getByRole("article", { name: /F:\\Gone/ });
  await expect(missing).toContainText("找不到这个文件夹");
  await chooseRowAction(page, missing, "从列表移除");
  await expect(missing).toHaveCount(0);
  const recorded = await calls(page);
  expect(recorded).toContainEqual(["deleteCopy", "C:\\Users\\me\\AppData\\Roaming\\RiA\\data.moved-20261117T080000Z"]);
  expect(recorded).toContainEqual(["forgetCopy", "F:\\Gone"]);
});

test("a move that went through is announced once when the app comes back", async ({ page, app }) => {
  await desktopBridge(page, { view: { result: { id: "moved-1", kind: "data", outcome: "moved", target: "D:\\RiA", at: "2026-11-17T08:00:00.000Z" } } });
  await openWorkspace(page, app.origin);
  await expect(toasts(page)).toContainText("数据已移到新位置");
  await expect.poll(() => calls(page)).toContainEqual(["acknowledge", "moved-1"]);
});

test("a failed move is shown on the storage page until dismissed", async ({ page, app }) => {
  await desktopBridge(page, { view: { result: { id: "failed-1", kind: "data", outcome: "failed", target: "D:\\RiA", at: "2026-11-17T08:00:00.000Z", code: "in-use" } } });
  await openWorkspace(page, app.origin);
  const section = await storage(page, app.origin);
  const alert = section.getByRole("alert").filter({ hasText: "数据没有移动" });
  await expect(alert).toContainText("有其他程序正在使用这个文件夹");
  await expect(alert).toContainText("数据仍在原来的位置");
  await alert.getByRole("button", { name: "知道了" }).click();
  await expect(alert).toHaveCount(0);
  expect(await calls(page)).toContainEqual(["acknowledge", "failed-1"]);
});

test("the move dialog warns when answers are running, since the restart cuts them short", async ({ page, app }) => {
  await desktopBridge(page, {
    view: {}, chosen: ["D:\RiA"],
    checks: { "D:\RiA": { ok: true, kind: "data", target: "D:\RiA", mode: "copy", copyBytes: 1024 ** 3, requiredBytes: 1.4 * 1024 ** 3, availableBytes: 90 * 1024 ** 3 } },
  });
  await openWorkspace(page, app.origin);
  await page.route("**/api/conversations/live", route => route.fulfill({ json: { data: { answering: 2 } } }));
  const section = await storage(page, app.origin);
  await section.getByRole("button", { name: "更改位置…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "移动数据" });
  await expect(dialog).toContainText("有 2 个对话正在回答");
  await expect(dialog.getByRole("button", { name: "移动并重新启动", exact: true })).toBeEnabled();
});

test("data left behind when starting empty is labelled as such and can be switched back to", async ({ page, app }) => {
  await desktopBridge(page, {
    view: { copies: [{ path: "F:\RiA", at: "2026-11-17T08:00:00.000Z", exists: true, reason: "left" }] },
    checks: { "F:\RiA": { ok: true, kind: "data", target: "F:\RiA", mode: "adopt", copyBytes: 0, requiredBytes: 0, availableBytes: 40 * 1024 ** 3 } },
  });
  await openWorkspace(page, app.origin);
  const section = await storage(page, app.origin);
  const left = section.getByRole("article", { name: /F:\RiA/ });
  await expect(left).toContainText("新建空工作区时找不到的数据");
  await chooseRowAction(page, left, "使用这份数据…");
  const dialog = page.getByRole("dialog", { name: "改用这份数据" });
  await expect(dialog).toContainText("当前的数据不会合并过去");
  await expect(dialog.getByRole("button", { name: "换一个文件夹…" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "使用这份数据并重新启动", exact: true }).click();
  expect(await calls(page)).toContainEqual(["move", "data", "F:\RiA"]);
});
