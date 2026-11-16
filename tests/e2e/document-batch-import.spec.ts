import { test as base, expect } from "@playwright/test";
import { openDocumentImport } from "../helpers/knowledge";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { browserData } from "../helpers/browser-api";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer();
    try { await runTest(app); } finally { await app.close(); }
  },
});

const text = (name: string, body: string) => ({ name, mimeType: "text/plain", buffer: Buffer.from(body) });

test("several documents import as a batch: each shows how it went, an unreadable one is skipped, and a rate limit is waited out", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/knowledge?view=documents`);
  const form = await openDocumentImport(page);
  // The service is busy once, as it says with Retry-After; the batch waits and goes on rather than failing.
  let refused = false;
  await page.route("**/api/documents", async route => {
    if (route.request().method() === "POST" && !refused) { refused = true; await route.fulfill({ status: 429, headers: { "Retry-After": "1" }, json: { error: { code: "RATE_LIMITED", message: "请求过于频繁", details: { retryAfterSeconds: 1 } } } }); return; }
    await route.fallback();
  });
  await page.getByLabel("所属主题（可选）").fill("制度");
  await page.getByLabel("选择知识文档").setInputFiles([
    text("考勤.txt", "每天九点前打卡，迟到需在当天说明原因。"),
    text("报销.md", "# 报销\n\n回程后十个工作日内提交费用核销申请。"),
    { name: "照片.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71]) },
  ]);
  await expect(page.getByRole("status").filter({ hasText: "已选择 3 个文件" })).toContainText("其中 2 个可以导入");
  await form.getByRole("button", { name: "导入 2 个文档", exact: true }).click();

  const list = page.getByRole("region", { name: "批量导入", exact: true });
  await expect(list.locator('li[data-status="retrying"]')).toHaveCount(1);
  await expect(list.getByRole("status")).toHaveText("批量导入：3/3", { timeout: 15_000 });
  await expect(list.locator('li[data-status="added"]')).toHaveCount(2);
  await expect(list.locator("li").filter({ hasText: "照片.png" })).toContainText("不支持的文件类型");
  await expect(list.locator("li").filter({ hasText: "照片.png" })).toContainText("已跳过");
  await expect(page.getByText(/批量导入完成：新增 2，更新 0，未变化 0，失败 0，跳过 1。/)).toBeVisible();
  const documents = (await browserData(page, `${app.origin}/api/documents`)) as { filename: string; collection: string | null }[];
  expect(documents.map(document => [document.filename, document.collection]).sort()).toEqual([["考勤.txt", "制度"], ["报销.md", "制度"]].sort());

  // Importing the same files again says they are unchanged, not new.
  await list.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByLabel("选择知识文档").setInputFiles([text("考勤.txt", "每天九点前打卡，迟到需在当天说明原因。"), text("报销.md", "# 报销\n\n回程后十个工作日内提交费用核销申请。")]);
  await form.getByRole("button", { name: "导入 2 个文档", exact: true }).click();
  await expect(list.locator('li[data-status="unchanged"]')).toHaveCount(2, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("one chosen document still goes through the preview before it is saved", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/knowledge?view=documents`);
  const form = await openDocumentImport(page);
  await page.getByLabel("选择知识文档").setInputFiles(text("单个.txt", "只有一个文档时先预览。"));
  await form.getByRole("button", { name: "预览导入", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认保存文档", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "批量导入", exact: true })).toHaveCount(0);
});
