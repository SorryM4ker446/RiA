import { test as base, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try {
      const file = app.readRows("PRAGMA database_list")[0] as { file: string };
      // Seed only this fixture's database while its service is stopped.
      await app.restart(() => {
        const sqlite = new DatabaseSync(file.file);
        try {
          const insert = sqlite.prepare("INSERT INTO memories (id,key,value,source,confirmed,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)");
          sqlite.exec("BEGIN");
          for (let i = 0; i < 127; i++) {
            const index = String(i).padStart(3, "0");
            insert.run(`fixture-${index}`, `记忆 ${index}`, i < 3 ? "底部关键词" : "常规内容", i < 2 ? "assistant" : "manual", i < 2 ? 0 : 1, Date.parse("2026-08-01T00:00:00Z"), Date.parse("2026-08-01T00:00:00Z"));
          }
          sqlite.exec("COMMIT");
        } finally { sqlite.close(); }
      });
      await runTest(app);
    } finally { await app.close(); }
  },
});

test.beforeEach(async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/knowledge`);
  await expect(page.getByRole("heading", { name: "记忆 126", exact: true })).toBeVisible();
});

test("knowledge pagination reaches older entries and local search combines confirmation filters", { tag: "@integration" }, async ({ page, app }, info) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", error => consoleErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  const pagination = page.getByRole("navigation", { name: "知识条目分页" });
  await expect(page.locator("article")).toHaveCount(25);
  await expect(pagination.getByRole("button", { name: "上一页" })).toBeDisabled();
  for (let i = 2; i <= 6; i++) {
    await pagination.getByRole("button", { name: "下一页" }).click();
    await expect(pagination.getByText(`第 ${i} 页`, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "记忆 000", exact: true })).toBeVisible();
  await expect(page.locator("article")).toHaveCount(2);
  await expect(pagination.getByRole("button", { name: "下一页" })).toBeDisabled();
  await pagination.getByRole("button", { name: "上一页" }).click();
  await expect(pagination.getByText("第 5 页", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "搜索知识条目" }).fill("底部关键词");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(3);
  await expect(pagination.getByText("第 1 页", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "知识确认状态" }).selectOption("candidates");
  await expect(page.locator("article")).toHaveCount(2);
  await page.locator("article").filter({ has: page.getByRole("heading", { name: "记忆 001", exact: true }) }).getByRole("button", { name: "确认使用" }).click();
  await expect(page.locator("article")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "记忆 000", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "知识确认状态" }).selectOption("confirmed");
  await expect(page.locator("article")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "记忆 001", exact: true })).toBeVisible();
  expect(app.readRows("SELECT confirmed FROM memories WHERE id='fixture-001'")[0]).toEqual({ confirmed: 1 });
  await expect(page).toHaveURL(`${app.origin}/knowledge`);
  await expect(page).toHaveTitle(/RiA/);
  await expect(page.locator("nextjs-portal")).toHaveCount(0);
  const screenshots = join(tmpdir(), `ria-knowledge-qa-${info.testId.replace(/[^a-zA-Z0-9-]/g, "")}`);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("textbox", { name: "搜索知识条目" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await pagination.locator("..").screenshot({ path: join(screenshots, "mobile.png") });
  expect(consoleErrors).toEqual([]);
  await info.attach("knowledge-qa-screenshot-paths", { body: screenshots, contentType: "text/plain" });
});

test("a saved write with a failed list refresh disables obsolete pagination and recovers from the first page", { tag: "@integration" }, async ({ page, app }) => {
  const pagination = page.getByRole("navigation", { name: "知识条目分页" });
  await pagination.getByRole("button", { name: "下一页" }).click();
  await expect(pagination.getByText("第 2 页", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑 记忆 101", exact: true }).click();
  await page.getByRole("textbox", { name: "修改这条记忆的内容" }).fill("已保存的编辑");
  await page.route("**/api/knowledge?**", route => route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "模拟刷新失败" } } }));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("修改已保存，但列表刷新失败。请刷新列表后继续翻页。", { exact: true })).toBeVisible();
  expect(app.readRows("SELECT value FROM memories WHERE id='fixture-101'")[0]).toEqual({ value: "已保存的编辑" });
  await expect(pagination.getByRole("button", { name: "下一页" })).toBeDisabled();
  await expect(pagination.getByRole("button", { name: "上一页" })).toBeDisabled();
  await page.unroute("**/api/knowledge?**");
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(pagination.getByText("第 1 页", { exact: true })).toBeVisible();
  await expect(page.locator("article").first()).toContainText("记忆 101");
  await expect(page.getByText("已保存的编辑", { exact: true })).toBeVisible();
  await expect(pagination.getByRole("button", { name: "下一页" })).toBeEnabled();
});

test("failed knowledge writes preserve drafts and rows, then successful writes refill the filtered page", { tag: "@integration" }, async ({ page, app }) => {
  await page.getByRole("combobox", { name: "知识确认状态" }).selectOption("candidates");
  await expect(page.locator("article")).toHaveCount(2);
  await page.getByRole("button", { name: "编辑 记忆 001", exact: true }).click();
  await page.getByRole("textbox", { name: "修改这条记忆的内容" }).fill("修正后的内容");
  await page.route("**/api/knowledge/fixture-001", route => route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "模拟保存失败" } } }));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("模拟保存失败", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "修改这条记忆的内容" })).toHaveValue("修正后的内容");
  await page.unroute("**/api/knowledge/fixture-001");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(1);
  expect(app.readRows("SELECT value,confirmed FROM memories WHERE id='fixture-001'")[0]).toEqual({ value: "修正后的内容", confirmed: 1 });
  await page.route("**/api/knowledge/fixture-000", route => route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "模拟删除失败" } } }));
  await page.getByRole("button", { name: "删除知识 记忆 000", exact: true }).click();
  await expect(page.getByText("模拟删除失败", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "记忆 000", exact: true })).toBeVisible();
  await page.unroute("**/api/knowledge/fixture-000");
  await page.getByRole("button", { name: "删除知识 记忆 000", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(0);
  await expect(page.getByText("当前页没有符合条件的知识条目。可调整搜索或返回上一页。", { exact: true })).toBeVisible();
  expect(app.readRows("SELECT id FROM memories WHERE id='fixture-000'")).toEqual([]);
});

test("a superseded knowledge search cannot replace newer results, and failed search keeps its prior scope", { tag: "@integration" }, async ({ page }) => {
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { arrived = resolve; });
  await page.route("**/api/knowledge?**", async route => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "慢请求") {
      arrived();
      await gate;
      await route.fulfill({ json: { data: [], pageInfo: { nextCursor: null, hasMore: false } } }).catch(() => {});
    } else if (q === "失败") {
      await route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "模拟读取失败" } } });
    } else await route.continue();
  });
  try {
    const search = page.getByRole("textbox", { name: "搜索知识条目" });
    await search.fill("慢请求");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await received;
    await search.fill("底部关键词");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator("article")).toHaveCount(3);
    release();
    await search.fill("失败");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.getByText("模拟读取失败", { exact: true })).toBeVisible();
    await expect(page.locator("article")).toHaveCount(3);
    await expect(page.getByText("当前搜索： 底部关键词", { exact: true })).toBeVisible();
    await search.fill("没有结果");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(page.locator("article")).toHaveCount(0);
    await expect(page.getByText("当前搜索： 没有结果", { exact: true })).toBeVisible();
  } finally { release(); }
});
