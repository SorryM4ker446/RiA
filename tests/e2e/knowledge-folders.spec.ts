import { expect, test as base, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { acceptConfirm } from "../helpers/confirm";
import { searchDocumentContent } from "../helpers/knowledge";

type App = Awaited<ReturnType<typeof startStandaloneServer>> & { folder: string };
const test = base.extend<{ app: App }>({ app: async ({}, provide) => {
  const runtime = await startStandaloneServer();
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-knowledge-folders-")));
  const folder = join(root, "Handbook");
  mkdirSync(join(folder, "finance"), { recursive: true });
  writeFileSync(join(folder, "travel.md"), "# Travel\n\nHotels are booked through the travel desk.");
  writeFileSync(join(folder, "finance", "invoices.txt"), "Invoices are paid within thirty days.");
  try { await provide({ ...runtime, folder }); } finally {
    await runtime.close();
    if (dirname(root) !== realpathSync.native(tmpdir()) || !basename(root).startsWith("ria-knowledge-folders-")) throw new Error("Unexpected folder sync test directory");
    rmSync(root, { recursive: true, force: true });
  }
} });

/** The desktop bridge as the app sees it, with the folder dialog answering with the test folder. */
async function desktop(page: Page, app: App) {
  await page.addInitScript(folder => {
    Object.defineProperty(window, "riaDesktop", { value: {
      chooseFolder: async () => ({ canceled: false, path: folder }),
      getSettings: async () => ({ hasOpenrouterApiKey: false, hasDeepseekApiKey: false, encryptionAvailable: true, outboundProxyUrl: "", openrouterSiteName: "RiA", openrouterHttpReferer: "", closeBehaviour: "quit", globalHotkey: "Control+Shift+Space", windowBounds: null }),
      getRuntimeInfo: async () => ({ appVersion: "0.1.3", packaged: false, dataDirectory: "fixture/data", mediaDirectory: "fixture/media", logFile: "fixture/log" }),
    } });
  }, app.folder);
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/knowledge?view=documents`);
}

test("a synced folder fills the library, follows changes on Sync now, reports a file it cannot read, and stops syncing on request", { tag: "@integration" }, async ({ page, app }) => {
  await desktop(page, app);
  const folders = page.getByRole("region", { name: "同步的文件夹" });
  await expect(folders.getByText("还没有同步的文件夹。")).toBeVisible();
  await folders.getByRole("button", { name: "添加文件夹" }).click();
  const card = page.getByRole("form", { name: "同步一个文件夹" });
  await expect(card.getByText(app.folder)).toBeVisible();
  await card.getByLabel("主题").fill("Ops");
  await card.getByRole("button", { name: "开始同步" }).click();
  await expect(page.getByText("已开始同步这个文件夹。")).toBeVisible();
  const row = folders.getByRole("listitem").filter({ hasText: "Handbook" });
  await expect(row.getByText("已同步")).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("2 份文档");

  // Its documents are in the list, named by their path in the folder, and are not deleted from here.
  const library = page.getByRole("list", { name: "已导入文档" });
  await expect(library.getByRole("link", { name: "Handbook/travel.md", exact: true })).toBeVisible();
  await expect(library.getByRole("link", { name: "Handbook/finance/invoices.txt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "更多操作 Handbook/travel.md", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "删除文档 Handbook/travel.md", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A changed file and one that cannot be read, picked up by Sync now.
  writeFileSync(join(app.folder, "travel.md"), "# Travel\n\nHotels are booked through the new travel portal.");
  utimesSync(join(app.folder, "travel.md"), new Date(), new Date(Date.now() + 5_000));
  writeFileSync(join(app.folder, "broken.pdf"), "not a PDF");
  await page.getByRole("button", { name: "更多操作 Handbook", exact: true }).click();
  await page.getByRole("menuitem", { name: "立即同步 Handbook", exact: true }).click();
  await expect(row.getByText("1 个文件未导入")).toBeVisible({ timeout: 30_000 });
  await row.getByText("查看未导入的文件").click();
  await expect(row.getByText("broken.pdf")).toBeVisible();
  await searchDocumentContent(page, "new travel portal");
  await expect(page.getByText(/new travel portal/).first()).toBeVisible();

  // Stopping keeps the documents, now ordinary ones that can be deleted here.
  await page.getByRole("button", { name: "更多操作 Handbook", exact: true }).click();
  await page.getByRole("menuitem", { name: "停止同步 Handbook", exact: true }).click();
  await acceptConfirm(page, "Handbook");
  await expect(page.getByText("已停止同步，文档已保留。")).toBeVisible();
  await expect(folders.getByText("还没有同步的文件夹。")).toBeVisible();
  await expect(library.getByRole("link", { name: "Handbook/travel.md", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "更多操作 Handbook/travel.md", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "删除文档 Handbook/travel.md", exact: true })).toBeVisible();
});
