import { test as base, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace, TEST_ACCESS_TOKEN } from "../helpers/workspace-entry";
import { browserApi, browserData } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ desktopScheduler: true, modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

test.beforeEach(async ({ page }) => {
  await page.context().addCookies([{ name: "desktop_session", value: TEST_ACCESS_TOKEN, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
});

type Task = { id: string; lastStatus: string | null; chatId: string | null };
const databaseOf = (app: { readRows: (sql: string) => unknown[] }) => (app.readRows("PRAGMA database_list")[0] as { file: string }).file;
/** Makes the task due in the isolated database, so the real startup scheduler is what runs it. */
const makeDue = (file: string, id: string) => {
  const sqlite = new DatabaseSync(file);
  try { sqlite.prepare("UPDATE scheduled_jobs SET nextRunAt = 0 WHERE id = ?").run(id); } finally { sqlite.close(); }
};

test("a due task runs on its own at startup, and every later run continues its one conversation", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const task = (await browserApi(page, "/api/tasks", "POST", { kind: "prompt", title: "晨间提醒", prompt: "提醒我喝水", enabled: true, cron: "0 9 * * *", timeZone: "UTC" })).body.data as Task;
  const file = databaseOf(app);
  const finished = async () => (await browserData(page, "/api/tasks") as Task[])[0];

  await app.restart(() => makeDue(file, task.id));
  await expect.poll(async () => (await finished()).lastStatus, { timeout: 30_000 }).toBe("done");
  const chatId = (await finished()).chatId!;
  expect(chatId).toBeTruthy();

  // The startup scheduler ran the first; the second, started by hand, must continue the same conversation.
  expect((await browserApi(page, `/api/tasks/${task.id}/run`, "POST")).status).toBe(202);
  await expect.poll(async () => (await browserData(page, "/api/tasks/runs") as unknown[]).length).toBe(2);
  await expect.poll(async () => (await finished()).lastStatus).toBe("done");
  expect((await finished()).chatId).toBe(chatId);
  expect(app.readRows("SELECT count(*) AS count FROM chats")[0]).toMatchObject({ count: 1 });
  expect(app.readRows("SELECT role FROM messages WHERE chatId = ? ORDER BY createdAt, id", chatId)).toEqual([{ role: "user" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }]);

  await page.goto(`${app.origin}/tasks`);
  const row = page.getByTestId("task-item").filter({ hasText: "晨间提醒" });
  await expect(row).toContainText("已安排");
  await page.getByText("执行记录", { exact: true }).click();
  await expect(page.getByRole("list", { name: "执行记录" }).getByText("完成", { exact: true })).toHaveCount(2);
  await row.getByRole("link", { name: "晨间提醒", exact: true }).click();
  // The conversation opened, and the address no longer names it.
  await expect(page).toHaveURL(`${app.origin}/chat`);
  await expect(page.getByText("提醒我喝水", { exact: true }).first()).toBeVisible();

  // Each run is announced to the desktop once.
  const announced = await browserApi(page, "/api/tasks/notifications", "POST");
  expect(announced.status).toBe(200);
  expect(announced.body.data.map((notice: { title: string; detail: string }) => [notice.title, notice.detail])).toEqual([["task-finished", "晨间提醒"]]);
  expect((await browserApi(page, "/api/tasks/notifications", "POST")).body.data).toEqual([]);
  await page.goto(`${app.origin}/settings`);
  await page.getByRole("tab", { name: "自动化与通知", exact: true }).click();
  await expect(page.getByText("任务已完成", { exact: true })).toBeVisible();

  // The diagnostics carry structure only, never the task's words or where the database is.
  const diagnostics = await page.evaluate(() => fetch("/api/diagnostics").then(response => response.text()));
  expect(diagnostics).toContain('"kind":"prompt"');
  expect(diagnostics).not.toContain("提醒我喝水");
  expect(diagnostics).not.toContain(file);
  expect(errors).toEqual([]);
});

test("desktop restart marks an unfinished run interrupted without replaying it", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  const task = (await browserApi(page, "/api/tasks", "POST", { kind: "scheduledBackup", title: "夜间备份", enabled: true, cron: "0 3 * * *", timeZone: "UTC" })).body.data as Task;
  const file = databaseOf(app);
  await app.restart(() => {
    const sqlite = new DatabaseSync(file);
    try {
      sqlite.prepare("UPDATE scheduled_jobs SET lastStatus = 'running', nextRunAt = 0 WHERE id = ?").run(task.id);
      sqlite.prepare("INSERT INTO scheduled_runs (id, jobId, kind, requestId, status, startedAt) VALUES (?, ?, ?, ?, 'running', ?)").run("interrupted-fixture", task.id, "scheduledBackup", "interrupted-request", Date.now() - 60_000);
    } finally { sqlite.close(); }
  });
  await expect.poll(async () => (await browserData(page, "/api/tasks/runs") as Array<{ status: string }>)[0]?.status).toBe("interrupted");
  const runs = await browserData(page, "/api/tasks/runs") as Array<{ status: string }>;
  expect(runs).toHaveLength(1);
  const [row] = await browserData(page, "/api/tasks") as Array<{ lastStatus: string; nextRunAt: string }>;
  expect(row.lastStatus).toBe("interrupted");
  expect(new Date(row.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  await page.goto(`${app.origin}/tasks`);
  await expect(page.getByTestId("task-item").filter({ hasText: "夜间备份" })).toContainText("上次失败");
  await page.getByText("执行记录", { exact: true }).click();
  await expect(page.getByRole("list", { name: "执行记录" }).getByText("被中断", { exact: true })).toBeVisible();
  expect(app.readRows("SELECT count(*) AS count FROM chats")[0]).toMatchObject({ count: 0 });
});
