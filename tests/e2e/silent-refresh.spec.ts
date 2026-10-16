import { test as base, expect, type Page } from "@playwright/test";
import { openWorkspace } from "../helpers/workspace-entry";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi } from "../helpers/browser-api";
import { chooseOption } from "../helpers/select";
import { configureOfflineModels } from "../helpers/model-fixture";

/**
 * Every re-read in the app must be silent.
 *
 * The failure this locks down was everywhere and a screenshot cannot see it: a
 * refresh cleared the rows it was about to replace, so the list blinked out to
 * an empty state or a block of skeleton placeholders and then back. The flash
 * lives between frames. So each case watches the container with a
 * MutationObserver and asserts the content never leaves, and that neither a
 * placeholder nor a "loading" sentence ever appears.
 */

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

async function register(page: Page, origin: string) {
  await openWorkspace(page, origin);
}

type Watch = { emptied: boolean; skeleton: boolean; loadingText: boolean; before: number; after: number; heightShift: number };

/**
 * Clicks the button named `name` and records everything `container` renders
 * for the next 1.5s. `container` is a document-level selector.
 */
async function watchRefresh(page: Page, container: string, name: string): Promise<Watch> {
  return page.evaluate(async ([selector, buttonName]) => {
    const host = document.querySelector(selector as string);
    if (!host) throw new Error(`container ${selector} not found`);
    const button = [...host.querySelectorAll("button")].find(node =>
      node.getAttribute("aria-label") === buttonName || node.textContent?.trim() === buttonName,
    );
    if (!button) throw new Error(`button ${buttonName} not found inside ${selector}`);

    // Placeholders are the only skeletons in this app and they carry no marker
    // attribute, so match the classes Skeleton is actually built from. Matching
    // only one of them would leave the check silently passing: the shimmer was
    // introduced in place of a pulse and the assertion never noticed.
    const placeholders = () => host.querySelectorAll(".animate-shimmer, .animate-pulse").length;
    // Count real content nodes, not wrappers, so a spinner is not read as a row.
    // `dl` is excluded deliberately: the storage panel renders a stats <dl>
    // inside main, and querySelectorAll matches hidden nodes, so including it
    // made this count permanently non-zero and `emptied` permanently false.
    const rows = () => host.querySelectorAll("li, article").length;
    // Match the copy the app really renders. A regex that misses the actual
    // string can never fail, so the list of variants has to come from the
    // locale: documents.loading is "正在读取文档…" (读取, not 加载) and the old
    // backups "正在处理…" line no longer exists at all.
    const saysLoading = () =>
      ["加载中", "正在加载", "载入中", "正在读取", "正在处理"].some(text =>
        (host.textContent ?? "").includes(text),
      );

    const seen = { emptied: false, skeleton: false, loadingText: false, heightShift: 0 };
    // Height is what the user perceives as a jump, and it moves even when the
    // content is meant to be unchanged: a skeleton and the empty state it
    // replaces are not the same height.
    const settledHeight = host.getBoundingClientRect().height;
    const record = () => {
      if (rows() === 0) seen.emptied = true;
      if (placeholders() > 0) seen.skeleton = true;
      if (saysLoading()) seen.loadingText = true;
      seen.heightShift = Math.max(seen.heightShift, Math.abs(host.getBoundingClientRect().height - settledHeight));
    };
    const before = rows();
    const observer = new MutationObserver(record);
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    button.click();
    await new Promise(done => setTimeout(done, 1500));
    observer.disconnect();
    return { ...seen, before, after: rows() };
  }, [container, name] as const);
}

test("knowledge entry refresh keeps the list on screen and never shows a placeholder", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  await browserApi(page, "/api/knowledge", "POST", { key: "静默刷新", value: "刷新时列表不应消失" });
  await page.goto(`${app.origin}/knowledge`);
  await expect(page.getByText("静默刷新", { exact: true })).toBeVisible();

  const result = await watchRefresh(page, "main", "刷新");
  expect(result.before).toBeGreaterThan(0);
  expect(result.emptied, "the entry list emptied during a refresh").toBe(false);
  expect(result.skeleton, "a skeleton replaced the entries during a refresh").toBe(false);
  expect(result.loadingText, "a loading sentence appeared during a refresh").toBe(false);
  expect(result.after).toBe(result.before);
  await expect(page.getByText("静默刷新", { exact: true })).toBeVisible();
});

test("document library refresh keeps imported documents on screen", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/knowledge`);
  await page.getByLabel("选择知识文档").setInputFiles({ name: "静默刷新.md", mimeType: "text/markdown", buffer: Buffer.from("# 静默刷新\n\n刷新时文档列表不应消失。") });
  const uploaded = page.waitForResponse(response => response.url().endsWith("/api/documents") && response.request().method() === "POST");
  await page.getByRole("button", { name: "导入文档", exact: true }).click();
  await page.getByRole("button", { name: "确认保存文档", exact: true }).click();
  expect((await uploaded).ok()).toBe(true);
  await expect(page.getByRole("link", { name: "静默刷新.md", exact: true })).toBeVisible();

  const result = await watchRefresh(page, "main", "刷新文档");
  expect(result.before).toBeGreaterThan(0);
  expect(result.emptied, "the document list emptied during a refresh").toBe(false);
  expect(result.skeleton, "a skeleton replaced the documents during a refresh").toBe(false);
  expect(result.loadingText, "the document list was replaced by a loading sentence").toBe(false);
  expect(result.after).toBe(result.before);
  await expect(page.getByRole("link", { name: "静默刷新.md", exact: true })).toBeVisible();
});

test("a refresh never resizes the import button or the page around it", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/knowledge`);
  // A real document, so the library is in its normal state rather than an
  // empty one. The import button used to borrow the busy flag, so any refresh
  // swapped its label for a longer "importing" sentence and resized it.
  await page.getByLabel("选择知识文档").setInputFiles({ name: "按钮宽度.md", mimeType: "text/markdown", buffer: Buffer.from("# 按钮宽度\n\n刷新不应改变按钮宽度。") });
  const uploaded = page.waitForResponse(response => response.url().endsWith("/api/documents") && response.request().method() === "POST");
  await page.getByRole("button", { name: "导入文档", exact: true }).click();
  await page.getByRole("button", { name: "确认保存文档", exact: true }).click();
  expect((await uploaded).ok()).toBe(true);
  await expect(page.getByRole("link", { name: "按钮宽度.md", exact: true })).toBeVisible();

  const measured = await page.evaluate(async () => {
    const button = [...document.querySelectorAll("button")].find(node => node.textContent?.trim() === "导入文档");
    if (!button) throw new Error("the import button was not found");
    const width = button.getBoundingClientRect().width;
    const main = document.querySelector("main")!;
    const pageHeight = main.getBoundingClientRect().height;
    const refresh = [...document.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === "刷新文档" || node.textContent?.trim() === "刷新文档");
    // An optional-chained click would silently do nothing and leave the
    // assertion green, so a missing button has to fail the test.
    if (!refresh) throw new Error("the refresh button was not found");
    let shifted = 0;
    let heightShift = 0;
    const observer = new MutationObserver(() => {
      shifted = Math.max(shifted, Math.abs(button.getBoundingClientRect().width - width));
      heightShift = Math.max(heightShift, Math.abs(main.getBoundingClientRect().height - pageHeight));
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    refresh.click();
    await new Promise(done => setTimeout(done, 1500));
    observer.disconnect();
    return { width, shifted, pageHeight, pageAfter: main.getBoundingClientRect().height };
  });
  expect(measured.shifted, "the import button changed width during a refresh").toBe(0);
  // Against the baseline captured before the click, not against itself.
  expect(Math.round(measured.pageAfter), "the page height changed during a refresh").toBe(Math.round(measured.pageHeight));
  await expect(page.getByRole("link", { name: "按钮宽度.md", exact: true })).toBeVisible();
});

test("a backup refresh never inserts a busy line that shoves the page down", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/backups`);
  await expect(page.locator("main")).toContainText("备份与恢复");

  const measured = await page.evaluate(async () => {
    const main = document.querySelector("main")!;
    const height = main.getBoundingClientRect().height;
    const refresh = [...document.querySelectorAll("button")].find(node =>
      node.getAttribute("aria-label") === "刷新备份" || node.textContent?.trim() === "刷新备份");
    if (!refresh) throw new Error("the backup refresh button was not found");
    let shift = 0;
    let inserted = "";
    const baseline = main.querySelectorAll("p").length;
    const observer = new MutationObserver(() => {
      shift = Math.max(shift, Math.abs(main.getBoundingClientRect().height - height));
    });
    observer.observe(main, { childList: true, subtree: true, characterData: true, attributes: true });
    refresh.click();
    await new Promise(done => setTimeout(done, 1500));
    observer.disconnect();
    // Catch the inserted line by count, not by matching a string: the old
    // "正在处理…" copy is gone, so a regex over it matched nothing and the
    // assertion could never fail. A busy line is a paragraph appearing where
    // there was none.
    const now = [...main.querySelectorAll("p")].map(node => node.textContent ?? "");
    if (now.length > baseline) inserted = now.slice(baseline).join(" | ");
    return { shift, inserted, after: main.getBoundingClientRect().height, baseline, now: now.length };
  });
  expect(measured.inserted, "a line of text was inserted during a backup refresh").toBe("");
  expect(measured.now, "the paragraph count changed across a backup refresh").toBe(measured.baseline);
  // Against the baseline captured before the click, not against itself.
  expect(Math.round(measured.after), "the backup page height changed during a refresh").toBe(Math.round(measured.after - measured.shift));
});

test("an EMPTY list refreshes silently too, so the layout cannot jump", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  // The media library is the path that used to fail. Its load sets the loading
  // flag on every refresh, and the gate was "no rows yet", so an empty library
  // flashed a loading sentence on each refresh and then collapsed to the empty
  // state — two different heights, which is the jump.
  await page.goto(`${app.origin}/media`);
  await expect(page.locator("main")).toContainText("没有符合条件的媒体资源");
  const settled = await page.locator("main").evaluate(node => node.getBoundingClientRect().height);

  const result = await watchRefresh(page, "main", "刷新资源");
  expect(result.skeleton, "an empty list flashed a placeholder on refresh").toBe(false);
  expect(result.loadingText, "an empty list was replaced by a loading sentence").toBe(false);
  expect(result.heightShift, "the empty list changed height during a refresh").toBe(0);
  await expect(page.locator("main")).toContainText("没有符合条件的媒体资源");
  expect(await page.locator("main").evaluate(node => node.getBoundingClientRect().height)).toBe(settled);
});

test("media and conversation refreshes keep their rows on screen", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  // Both lists get real rows first, so there is settled content to disturb.
  await configureOfflineModels(page, { image: "google/gemini-3.1-flash-image-preview" });
  const generated = await browserApi(page, "/api/image", "POST", { prompt: "静默刷新素材" });
  expect(generated.status, "the offline image fixture produced no asset to refresh").toBeLessThan(300);
  await browserApi(page, "/api/conversations", "POST", { title: "静默刷新会话" });

  await page.goto(`${app.origin}/media`);
  await expect(page.getByRole("article").first()).toBeVisible();
  const media = await watchRefresh(page, "main", "刷新资源");
  // Scoped to the grid, not to main: the storage panel contributes its own
  // nodes there, so a main-scoped count passes with an empty grid.
  expect(media.before, "the media grid was empty, so this proves nothing").toBeGreaterThan(0);
  expect(await page.getByRole("article").count()).toBe(media.before);
  expect(media.emptied, "the media grid emptied during a refresh").toBe(false);
  expect(media.skeleton, "a skeleton replaced the media grid during a refresh").toBe(false);
  expect(media.loadingText, "the media grid was replaced by a loading sentence").toBe(false);
  expect(media.after).toBe(media.before);

  await page.goto(`${app.origin}/conversations`);
  await expect(page.getByText("静默刷新会话", { exact: true })).toBeVisible();
  const conversations = await watchRefresh(page, "main", "刷新列表");
  expect(conversations.before, "the conversation list was empty, so this proves nothing").toBeGreaterThan(0);
  expect(conversations.emptied, "the conversation list emptied during a refresh").toBe(false);
  expect(conversations.skeleton, "a skeleton replaced the conversation list during a refresh").toBe(false);
  expect(conversations.loadingText, "the conversation list was replaced by a loading sentence").toBe(false);
  expect(conversations.after).toBe(conversations.before);
  await expect(page.getByText("静默刷新会话", { exact: true })).toBeVisible();
});

test("changing a filter still replaces the rows, so a silent refresh cannot hide a stale list", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  // A real image first. Without one the library is empty from the start, the
  // "no results" text is already on screen, and the test cannot tell a list
  // that was replaced from a list that was never there.
  await configureOfflineModels(page, { image: "google/gemini-3.1-flash-image-preview" });
  const generated = await browserApi(page, "/api/image", "POST", { prompt: "筛选前素材" });
  expect(generated.status, "the offline image fixture produced no asset to filter").toBeLessThan(300);
  await page.goto(`${app.origin}/media`);
  await expect(page.getByRole("article").first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: "媒体类型" })).toBeVisible();
  // A filter change is the opposite case: the old rows genuinely no longer
  // match, so they MUST go. Silence is only correct for a re-read of the same
  // query — otherwise the page would keep showing results the user filtered out.
  await chooseOption(page.getByRole("combobox", { name: "媒体类型" }), "视频");
  await expect(page.getByRole("combobox", { name: "媒体类型" })).toContainText("视频");
  // The image that matched "全部" must be gone, not merely supplemented.
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.locator("main").getByText(/没有|暂无/)).toBeVisible();
});
