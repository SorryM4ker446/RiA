import { test as base, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startStandaloneServer } from "../helpers/standalone-server";
import { browserApi, browserData } from "../helpers/browser-api";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer();
    try { await runTest(app); } finally { await app.close(); }
  },
});
test.use({ timezoneId: "America/New_York" });

async function register(page: Page, origin: string) {
  await page.goto(`${origin}/register`);
  await page.getByPlaceholder("邮箱", { exact: true }).fill(`${randomUUID()}@example.invalid`);
  await page.getByPlaceholder("密码（至少 8 位）").fill(randomUUID());
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page).toHaveURL(`${origin}/chat`);
}

test("task reminder settings validate local dates and persist recurrence across browser and service restarts", { tag: "@integration" }, async ({ page, app, browser }) => {
  await register(page, app.origin);
  await page.getByLabel("选择手动工具").click();
  await page.getByRole("option", { name: "手动：创建任务" }).click();
  await page.getByPlaceholder(/输入任务标题/).fill("重复提醒浏览器验证");
  await page.locator('input[type="datetime-local"]').fill("2026-01-31T09:00");
  await page.getByRole("button", { name: "执行工具" }).click();
  const panel = page.getByTestId("task-panel");
  const row = panel.getByTestId("task-item").filter({ hasText: "重复提醒浏览器验证" });
  await expect(row.getByText("已逾期", { exact: true })).toBeVisible();
  const original = (await browserData(page, `${app.origin}/api/tasks`))[0];
  expect(original.timeZone).toBe("America/New_York");
  expect(original.dueDate).toBe("2026-01-31T14:00:00.000Z");
  await row.getByRole("button", { name: "设置时间与提醒" }).click();
  await row.getByLabel("到期桌面通知").check();
  await row.getByLabel("重复", { exact: true }).selectOption("monthly");
  await row.getByLabel("任务时区").fill("Invalid/Zone");
  await row.getByRole("button", { name: "保存提醒设置" }).click();
  await expect(row.getByRole("alert")).toContainText("有效的 IANA 时区");
  await row.getByLabel("任务时区").fill("America/New_York");
  await row.getByLabel("截止时间", { exact: true }).fill("2026-03-08T02:30");
  await row.getByRole("button", { name: "保存提醒设置" }).click();
  await expect(row.getByRole("alert")).toContainText("不存在这个本地时间");
  await row.getByLabel("任务时区").fill("Asia/Shanghai");
  await row.getByLabel("截止时间", { exact: true }).fill("2026-01-31T09:00");
  await row.getByRole("button", { name: "保存提醒设置" }).click();
  await expect(row.getByText("每月 · 完成后续建", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "保存提醒设置" })).toHaveCount(0);
  expect(await browserData(page, `${app.origin}/api/tasks/${original.id}`)).toMatchObject({
    dueDate: "2026-01-31T01:00:00.000Z", timeZone: "Asia/Shanghai", repeatRule: "monthly", reminderEnabled: true,
  });
  expect((await browserApi(page, `${app.origin}/api/tasks/reminders`, "POST")).status).toBe(403);
  expect(app.readRows("SELECT remindedAt FROM tasks WHERE id=?", original.id)).toEqual([{ remindedAt: null }]);
  await page.reload();
  await expect(row.getByText("到期提醒", { exact: true })).toBeVisible();
  await row.getByLabel("任务状态 重复提醒浏览器验证").click();
  await page.getByRole("option", { name: "已完成", exact: true }).click();
  await expect(panel.getByTestId("task-item")).toHaveCount(2);
  const after = await browserData(page, `${app.origin}/api/tasks`);
  const next = after.find((task: { id: string }) => task.id !== original.id);
  expect(next.status).toBe("todo");
  expect(Date.parse(next.dueDate)).toBeGreaterThan(Date.now());
  expect(next.repeatAnchor).toBe("2026-01-31T01:00:00.000Z");
  const done = panel.getByTestId("task-item").filter({ has: page.getByText("已完成", { exact: true }) });
  await expect(done.getByText("已逾期", { exact: true })).toHaveCount(0);
  await app.restart();
  await page.reload();
  await expect(panel.getByTestId("task-item")).toHaveCount(2);
  const retry = await browserApi(page, `${app.origin}/api/tasks/${original.id}`, "PATCH", { status: "done" });
  expect(retry.status).toBe(200);
  expect(retry.body.nextTask).toBeNull();
  expect(app.readRows("SELECT id FROM tasks")).toHaveLength(2);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await register(other, app.origin);
    expect((await browserApi(other, `${app.origin}/api/tasks/${next.id}`, "PATCH", { reminderEnabled: false })).status).toBe(404);
    expect(await browserData(other, `${app.origin}/api/tasks`)).toEqual([]);
  } finally { await otherContext.close(); }
  expect(app.providerCalls).toEqual([]);
});

test("task reminder mutations reject CSRF, incomplete schedules and expired sessions without changing data", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  const creation = await browserApi(page, `${app.origin}/api/tools/run`, "POST", { tool: "createTask", mode: "chat", input: { title: "安全提醒验证" } });
  expect(creation.status).toBe(200);
  const created = creation.body.data;
  const url = `${app.origin}/api/tasks/${created.taskId}`;
  expect((await browserApi(page, url, "PATCH", { reminderEnabled: true })).status).toBe(400);
  expect((await browserApi(page, url, "PATCH", { dueDate: "2026-02-30", repeatRule: "daily" })).status).toBe(400);
  const denied = await page.context().request.patch(url, { headers: { Origin: "https://outside.invalid" }, data: { reminderEnabled: true } });
  expect(denied.status()).toBe(403);
  app.expireSessions();
  expect((await browserApi(page, url, "PATCH", { dueDate: "2026-09-01T09:00Z", timeZone: "UTC", reminderEnabled: true })).status).toBe(401);
  expect(app.readRows("SELECT dueDate,reminderEnabled,repeatRule FROM tasks WHERE id=?", created.taskId)).toEqual([{ dueDate: null, reminderEnabled: 0, repeatRule: "none" }]);
  expect(app.providerCalls).toEqual([]);
});

test("changing reminder options preserves the stored DST occurrence and sub-minute deadline", { tag: "@integration" }, async ({ page, app }) => {
  await register(page, app.origin);
  const creation = await browserApi(page, `${app.origin}/api/tools/run`, "POST", { tool: "createTask", mode: "chat", input: {
    title: "精确时刻保留验证", dueDate: "2026-11-01T01:30:45.123-05:00", timeZone: "America/New_York", repeatRule: "monthly",
  } });
  expect(creation.status).toBe(200);
  const id = creation.body.data.taskId;
  await page.getByRole("button", { name: "刷新任务" }).click();
  const row = page.getByTestId("task-item").filter({ hasText: "精确时刻保留验证" });
  await row.getByRole("button", { name: "设置时间与提醒" }).click();
  await expect(row.getByLabel("截止时间", { exact: true })).toHaveValue("2026-11-01T01:30");
  await row.getByLabel("到期桌面通知").check();
  await row.getByRole("button", { name: "保存提醒设置" }).click();
  await expect(row.getByRole("button", { name: "保存提醒设置" })).toHaveCount(0);
  expect(await browserData(page, `${app.origin}/api/tasks/${id}`)).toMatchObject({
    dueDate: "2026-11-01T06:30:45.123Z", repeatAnchor: "2026-11-01T06:30:45.123Z", reminderEnabled: true,
  });
  expect(app.providerCalls).toEqual([]);
});
