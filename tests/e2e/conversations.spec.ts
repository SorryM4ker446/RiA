import { test as base, expect, type Page } from "@playwright/test";
import { NO_CREDENTIAL_STATE, localHostOrigin, openWorkspace } from "../helpers/workspace-entry";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";
import { chooseOption } from "../helpers/select";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});
async function register(page: Page, origin: string) {
  // The workspace has no login: the run's access cookie is already active.
  await openWorkspace(page, origin);
}
async function create(page: Page, title: string) {
  const result = await browserApi(page, "/api/conversations", "POST", { title });
  expect(result.status).toBe(201);
  return result.body.data.id as string;
}
async function manage(page: Page, origin: string) {
  await page.goto(`${origin}/conversations`);
  await expect(page.getByLabel("搜索标题和消息正文")).toBeEnabled();
}
/** Filters apply as typing pauses; Enter applies them at once. */
async function filter(page: Page) {
  const response = page.waitForResponse(response => response.url().includes("/api/conversations?") && response.request().method() === "GET");
  await page.getByLabel("搜索标题和消息正文").press("Enter");
  await response;
  await expect(page.getByLabel("搜索标题和消息正文")).toBeEnabled();
}

test("compact conversation rows keep actions accessible at desktop and mobile sizes", async ({ page, app }) => {
  const errors: string[] = [], consoleErrors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await register(page, app.origin);
  for (let i = 0; i < 8; i++) await create(page, `${i + 1} · 工作记录与项目讨论`);
  await page.setViewportSize({ width: 1440, height: 960 });
  await manage(page, app.origin);
  await expect(page).toHaveTitle(/RiA/);
  await expect(page.getByRole("heading", { name: "会话管理", exact: true })).toBeVisible();
  const row = page.getByRole("article").first();
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(80);
  await expect(row.getByRole("button")).toHaveCount(3);
  expect((await page.locator(".conversation-filters").boundingBox())!.height).toBeLessThanOrEqual(50);
  const more = row.getByRole("button", { name: /更多操作/ });
  await more.click(); await expect(page.getByRole("menuitem", { name: "导出 Markdown" })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(more).toBeFocused();
  await more.click(); await page.getByRole("menuitem", { name: "编辑标签" }).click();
  await expect(row.getByLabel("标签（逗号分隔）")).toBeFocused();
  await row.getByRole("button", { name: "取消", exact: true }).click(); await expect(more).toBeFocused();
  const dir = join(tmpdir(), "ria-template-management-qa"); await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, "conversations-dark.png"), animations: "disabled" });
  await page.evaluate(() => { localStorage.setItem("ui:theme", "light"); }); await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.screenshot({ path: join(dir, "conversations-light.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await more.click(); await expect(page.getByRole("menuitem", { name: "归档", exact: true })).toBeVisible();
  const menuBounds = (await page.getByRole("menu").boundingBox())!;
  expect(menuBounds.x).toBeGreaterThanOrEqual(0); expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(dir, "conversations-mobile.png"), animations: "disabled" });
  await expect(page.locator("nextjs-portal")).toHaveCount(0);
  expect(errors).toEqual([]); expect(consoleErrors).toEqual([]);
  expect(app.providerCalls).toHaveLength(0);
});

test("search controls keep their appearance during reads and ignore obsolete status results", async ({ page, app }) => {
  await register(page, app.origin);
  await create(page, "仍在进行的讨论");
  const archived = await create(page, "已经归档的讨论");
  await browserApi(page, `/api/conversations/${archived}`, "PATCH", { archived: true });
  await manage(page, app.origin);
  const search = page.getByLabel("搜索标题和消息正文");
  const state = page.getByLabel("会话状态");
  const appearance = () => search.evaluate(node => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return { opacity: style.opacity, color: style.color, background: style.backgroundColor, x: box.x, y: box.y, width: box.width, height: box.height };
  });
  const baseline = await appearance();
  let gate: Promise<void> | null = null;
  let reads = 0;
  await page.route("**/api/conversations?*", async route => {
    const wait = gate; reads++;
    const response = await route.fetch();
    if (wait) await wait;
    await route.fulfill({ response });
  });
  // Typing filters on its own; clearing the filter is offered once there is one.
  for (const action of ["输入", "重置", "已归档"]) {
    let release!: () => void;
    gate = new Promise<void>(resolve => { release = resolve; });
    const previousReads = reads;
    if (action === "已归档") await chooseOption(state, "已归档");
    else if (action === "输入") await search.fill("讨论");
    else await page.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(() => reads).toBeGreaterThan(previousReads);
    await expect(search).toBeEnabled(); await expect(state).toBeEnabled();
    expect(await appearance()).toEqual(baseline);
    const completed = page.waitForResponse(response => response.url().includes("/api/conversations?") && (action !== "已归档" || new URL(response.url()).searchParams.get("state") === "archived"));
    gate = null;
    if (action === "已归档") {
      // A newer filter finishes before the held archived response arrives.
      await chooseOption(state, "全部");
      await expect(page.getByRole("article")).toHaveCount(2);
    }
    release(); await completed;
    await expect(page.getByRole("button", { name: "置顶", exact: true }).first()).toBeEnabled();
  }
  await expect(state).toContainText("全部");
  await expect(page.getByRole("article")).toHaveCount(2);
  expect(await appearance()).toEqual(baseline);
});

test("conversation search, pinning, tags and archive restoration survive browser and service restart", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  const id = await create(page, "旅行记录");
  await browserApi(page, `/api/conversations/${id}/messages`, "POST", { role: "user", content: "早期月光旅行路线" });
  await create(page, "其他会话");
  await page.reload();
  await page.getByRole("link", { name: "管理会话" }).click();
  await page.getByLabel("搜索标题和消息正文").fill("月光");
  await filter(page);
  const row = page.getByRole("article", { name: "旅行记录", exact: true });
  await expect(row).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);
  await row.getByRole("button", { name: "置顶", exact: true }).click();
  await expect(row.getByText("已置顶", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: /更多操作/ }).click();
  await page.getByRole("menuitem", { name: "编辑标签" }).click();
  await row.getByLabel("标签（逗号分隔）").fill("Work, ＷＯＲＫ, 旅行");
  await row.getByRole("button", { name: "保存标签" }).click();
  await expect(row.getByText("work", { exact: true })).toBeVisible();
  await page.getByLabel("标签筛选").fill("WORK");
  await filter(page);
  await row.getByRole("button", { name: /更多操作/ }).click();
  await page.getByRole("menuitem", { name: "归档", exact: true }).click();
  await expect(page.getByText("没有符合条件的会话。")).toBeVisible();
  expect((await browserData(page, `/api/conversations/${id}`)).archived).toBe(true);
  await chooseOption(page.getByLabel("会话状态"), "已归档");
  await expect(row).toBeVisible();
  await chooseOption(page.getByLabel("会话状态"), "未归档");
  await expect(page.getByText("没有符合条件的会话。")).toBeVisible();
  // An old saved selection must not inject an archived chat back into the sidebar.
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), id);
  await page.getByRole("navigation", { name: "工作区导航" }).getByRole("link", { name: "聊天", exact: true }).click();
  await expect(page.getByText("其他会话", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("旅行记录", { exact: true })).toHaveCount(0);
  await app.restart();
  await manage(page, app.origin);
  await chooseOption(page.getByLabel("会话状态"), "已归档");
  await expect(row).toBeVisible();
  await expect(row.getByText("work", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "恢复并打开" }).click();
  await expect(page).toHaveURL(`${app.origin}/chat`);
  await expect(page.getByText("早期月光旅行路线", { exact: true })).toBeVisible();
  expect((await browserData(page, `/api/conversations/${id}`)).archived).toBe(false);
  expect(app.providerCalls).toHaveLength(0);
});

test("conversation pagination and bulk deletion require visible selection and explicit confirmation", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  for (let i = 0; i < 33; i++) await create(page, `批量会话 ${i}`);
  await manage(page, app.origin);
  await expect(page.getByRole("article")).toHaveCount(30);
  await page.getByRole("button", { name: "加载更多会话" }).click();
  await expect(page.getByRole("article")).toHaveCount(33);
  await page.getByRole("checkbox", { name: "选择 批量会话 0", exact: true }).check();
  await page.getByRole("checkbox", { name: "选择 批量会话 1", exact: true }).check();
  await page.getByRole("button", { name: "删除所选" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("批量会话 0");
  await expect(confirm).toContainText("批量会话 1");
  await expect(confirm.getByRole("button", { name: "取消删除" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).not.toBeVisible();
  expect(app.readRows("SELECT id FROM chats")).toHaveLength(33);
  await chooseOption(page.getByLabel("会话状态"), "全部");
  await filter(page);
  // Bulk actions appear only once something is selected.
  await expect(page.getByRole("button", { name: "删除所选" })).toHaveCount(0);
  await page.getByRole("checkbox", { name: "选择前 50 个已加载会话" }).check();
  await page.getByRole("button", { name: "删除所选" }).click();
  await confirm.getByRole("button", { name: "确认永久删除" }).click();
  await expect(page.getByText("已删除 30 个会话。")).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(3);
  expect(app.readRows("SELECT id FROM chats")).toHaveLength(3);
  // Deleted conversations leave the selection, so another delete right after only sends what is listed.
  await expect(page.getByRole("button", { name: "删除所选" })).toHaveCount(0);
  await page.getByRole("article").first().getByRole("checkbox").check();
  await page.getByRole("article").nth(1).getByRole("checkbox").check();
  await expect(page.getByText(/已选 2 \/ 50/)).toBeVisible();
  await page.getByRole("button", { name: "删除所选" }).click();
  await confirm.getByRole("button", { name: "确认永久删除" }).click();
  await expect(page.getByText("已删除 2 个会话。")).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(1);
  expect(app.readRows("SELECT id FROM chats")).toHaveLength(1);
  expect(app.providerCalls).toHaveLength(0);
});

test("browser exports download complete text snapshots and keep media private", { tag: "@integration" }, async ({ page, browser, app }, info) => {
  await register(page, app.origin);
  const id = await create(page, "导出会话");
  const asset = await page.evaluate(async () => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII="), c => c.charCodeAt(0));
    const form = new FormData(); form.append("files", new Blob([bytes], { type: "image/png" }), "test.png");
    return (await (await fetch("/api/media/upload", { method: "POST", body: form })).json()).data[0];
  });
  expect((await browserApi(page, `/api/conversations/${id}/messages`, "POST", { role: "user", content: "__USER_MESSAGE__:" + JSON.stringify({ type: "user-message", text: "导出正文\n```\n<script>literal</script>", files: [{ url: asset.url, mediaType: asset.mediaType }] }) })).status).toBe(201);
  await manage(page, app.origin);
  for (const [format, suffix] of [["JSON", "json"], ["Markdown", "md"]]) {
    const pending = page.waitForEvent("download");
    await page.getByRole("article").getByRole("button", { name: /更多操作/ }).click();
    await page.getByRole("menuitem", { name: `导出 ${format}`, exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(new RegExp(`^conversation-[a-f0-9]{12}\\.${suffix}$`));
    const file = info.outputPath(download.suggestedFilename());
    await download.saveAs(file);
    const contents = await readFile(file, "utf8");
    expect(contents).toContain("导出正文"); expect(contents).toContain(asset.assetId);
    expect(contents).not.toContain("data:image"); expect(contents).not.toContain("relativePath");
    if (suffix === "json") {
      const snapshot = JSON.parse(contents);
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.messages[0].attachments[0].url).toBe(asset.url);
    } else expect(contents).toContain("````text");
  }
  const anonymous = await browser.newContext({ storageState: NO_CREDENTIAL_STATE });
  try {
    // The local access credential is the only remaining boundary: a context
    // that never obtained one can read nothing and change nothing.
    const base = localHostOrigin(app.origin);
    expect((await anonymous.request.get(`${base}/api/conversations/${id}/export`)).status()).toBe(401);
    expect((await anonymous.request.post(`${base}/api/conversations/bulk-delete`, { data: { ids: [id], confirm: true } })).status()).toBe(401);
    expect((await anonymous.request.get(`${base}${asset.url}`)).status()).toBe(401);
    expect(JSON.stringify(await (await anonymous.request.get(`${base}/api/conversations`)).json())).toContain("UNAUTHORIZED");
  } finally { await anonymous.close(); }
  // The workspace that did obtain one still holds its own data untouched.
  expect((await browserData(page, "/api/conversations")).map((chat: { id: string }) => chat.id)).toContain(id);
  expect(app.providerCalls).toHaveLength(0);
});

test("conversation validation, rate limits and credential refusal surface actionable errors", { tag: "@integration" }, async ({ page, browser, app }) => {
  await register(page, app.origin);
  const id = await create(page, "边界验证");
  await manage(page, app.origin);
  await page.getByLabel("搜索标题和消息正文").fill("x"); await filter(page);
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "重置", exact: true }).click();
  const row = page.getByRole("article");
  await row.getByRole("button", { name: /更多操作/ }).click();
  await page.getByRole("menuitem", { name: "编辑标签" }).click();
  await row.getByLabel("标签（逗号分隔）").fill("x".repeat(33));
  await row.getByRole("button", { name: "保存标签" }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(row.getByLabel("标签（逗号分隔）")).toHaveValue("x".repeat(33));
  for (let i = 0; i < 6; i++) expect((await browserApi(page, `/api/conversations/${id}/export?format=json`)).status).toBe(200);
  await row.getByRole("button", { name: /更多操作/ }).click();
  await page.getByRole("menuitem", { name: "导出 JSON", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText(/rate|频繁|稍后|limit/i);
  const cookies = (await page.context().cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  const denied = await fetch(`${localHostOrigin(app.origin)}/api/conversations/bulk-delete`, { method: "POST", headers: { cookie: cookies, origin: "https://outside.invalid", "content-type": "application/json" }, body: JSON.stringify({ ids: [id], confirm: true }) });
  expect(denied.status).toBe(403);
  // A request that presents no credential is refused before anything is read.
  const anonymous = await browser.newContext({ storageState: NO_CREDENTIAL_STATE });
  try {
    const base = localHostOrigin(app.origin);
    expect((await anonymous.request.post(`${base}/api/conversations/bulk-delete`, { data: { ids: [id], confirm: true }, headers: { origin: base } })).status()).toBe(401);
  } finally { await anonymous.close(); }
  expect(app.readRows("SELECT id FROM chats")).toHaveLength(1);
  // The workspace itself stays usable; there is no login page to fall back to.
  await page.reload(); await expect(page).not.toHaveURL(/\/login$/);
  expect(app.providerCalls).toHaveLength(0);
});
