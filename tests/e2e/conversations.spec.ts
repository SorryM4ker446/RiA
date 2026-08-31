import { test as base, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});
async function register(page: Page, origin: string) {
  await page.goto(`${origin}/register`);
  await page.getByPlaceholder("邮箱", { exact: true }).fill(`${randomUUID()}@example.invalid`);
  await page.getByPlaceholder("密码（至少 8 位）").fill(randomUUID());
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page).toHaveURL(`${origin}/chat`);
}
async function create(page: Page, title: string) {
  const result = await browserApi(page, "/api/conversations", "POST", { title });
  expect(result.status).toBe(201);
  return result.body.data.id as string;
}
async function manage(page: Page, origin: string) {
  await page.goto(`${origin}/conversations`);
  await expect(page.getByRole("button", { name: "搜索 / 筛选" })).toBeEnabled();
}
async function filter(page: Page) {
  const response = page.waitForResponse(response => response.url().includes("/api/conversations?") && response.request().method() === "GET");
  await page.getByRole("button", { name: "搜索 / 筛选" }).click();
  await response;
  await expect(page.getByRole("button", { name: "搜索 / 筛选" })).toBeEnabled();
}

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
  await row.getByRole("button", { name: "编辑标签" }).click();
  await row.getByLabel("标签（逗号分隔）").fill("Work, ＷＯＲＫ, 旅行");
  await row.getByRole("button", { name: "保存标签" }).click();
  await expect(row.getByText("work", { exact: true })).toBeVisible();
  await page.getByLabel("标签筛选").fill("WORK");
  await filter(page);
  await row.getByRole("button", { name: "归档", exact: true }).click();
  await expect(page.getByText("没有符合条件的会话。")).toBeVisible();
  expect((await browserData(page, `/api/conversations/${id}`)).archived).toBe(true);
  // An old saved selection must not inject an archived chat back into the sidebar.
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), id);
  await page.getByRole("link", { name: "返回聊天" }).click();
  await expect(page.getByText("其他会话", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("旅行记录", { exact: true })).toHaveCount(0);
  await app.restart();
  await manage(page, app.origin);
  await page.getByLabel("会话状态").selectOption("archived");
  await filter(page);
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
  await page.getByLabel("会话状态").selectOption("all");
  await filter(page);
  await expect(page.getByRole("button", { name: "删除所选" })).toBeDisabled();
  await page.getByRole("button", { name: "选择前 50 个已加载会话" }).click();
  await page.getByRole("button", { name: "删除所选" }).click();
  await confirm.getByRole("button", { name: "确认永久删除" }).click();
  await expect(page.getByText("已删除 30 个会话。")).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(3);
  expect(app.readRows("SELECT id FROM chats")).toHaveLength(3);
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
    await page.getByRole("button", { name: `导出 ${format}`, exact: true }).click();
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
  const other = await browser.newContext();
  try {
    expect((await other.request.get(`${app.origin}/api/conversations/${id}/export`)).status()).toBe(401);
    const stranger = await other.newPage(); await register(stranger, app.origin);
    expect((await browserApi(stranger, `/api/conversations/${id}/export?format=json`)).status).toBe(404);
    const own = await create(stranger, "保留自己的会话");
    expect((await browserApi(stranger, "/api/conversations/bulk-delete", "POST", { ids: [own, id], confirm: true })).status).toBe(404);
    expect((await browserData(stranger, "/api/conversations")).map((chat: { id: string }) => chat.id)).toEqual([own]);
    expect((await browserApi(stranger, asset.url)).status).toBe(404);
  } finally { await other.close(); }
  expect(app.providerCalls).toHaveLength(0);
});

test("conversation validation, rate limits and expired sessions surface actionable errors", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  const id = await create(page, "边界验证");
  await manage(page, app.origin);
  await page.getByLabel("搜索标题和消息正文").fill("x"); await filter(page);
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "重置", exact: true }).click();
  const row = page.getByRole("article");
  await row.getByRole("button", { name: "编辑标签" }).click();
  await row.getByLabel("标签（逗号分隔）").fill("x".repeat(33));
  await row.getByRole("button", { name: "保存标签" }).click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible();
  await expect(row.getByLabel("标签（逗号分隔）")).toHaveValue("x".repeat(33));
  for (let i = 0; i < 6; i++) expect((await browserApi(page, `/api/conversations/${id}/export?format=json`)).status).toBe(200);
  await row.getByRole("button", { name: "导出 JSON", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText(/rate|频繁|稍后|limit/i);
  const cookies = (await page.context().cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  const denied = await fetch(`${app.origin}/api/conversations/bulk-delete`, { method: "POST", headers: { cookie: cookies, origin: "https://outside.invalid", "content-type": "application/json" }, body: JSON.stringify({ ids: [id], confirm: true }) });
  expect(denied.status).toBe(403);
  app.expireSessions();
  await page.getByRole("button", { name: "刷新列表" }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText(/登录|Unauthorized|Authentication/i);
  expect(app.readRows("SELECT id FROM chats")).toHaveLength(1);
  await page.reload(); await expect(page).toHaveURL(`${app.origin}/login`);
  expect(app.providerCalls).toHaveLength(0);
});
