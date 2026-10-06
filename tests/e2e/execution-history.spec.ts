import { test as base, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace, TEST_ACCESS_TOKEN } from "../helpers/workspace-entry";
import { browserApi, browserData } from "../helpers/browser-api";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ desktopScheduler: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

test.beforeEach(async ({ page }) => {
  await page.context().addCookies([{ name: "desktop_session", value: TEST_ACCESS_TOKEN, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
});

test("settings exposes failure recovery, a distinct retry and sanitized diagnostic download", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  const job = (await browserApi(page, "/api/schedules", "POST", {
    kind: "dailyBrief", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily",
  })).body.data;
  // A due occurrence is prepared in the isolated database. Restart drives the
  // real desktop startup scheduler, without adding a test-only API to the app.
  const { DatabaseSync } = await import("node:sqlite");
  // The harness only exposes reads, so resolve its database from the test
  // environment via the standard SQLite database_list pragma.
  const file = app.readRows("PRAGMA database_list")[0] as { file: string };
  await app.restart(() => {
    const sqlite = new DatabaseSync(file.file);
    try {
      sqlite.exec("CREATE TRIGGER reject_period_review BEFORE INSERT ON workspace_reviews BEGIN SELECT RAISE(ABORT, 'fixture-persistence-failure'); END");
      sqlite.prepare("UPDATE scheduled_jobs SET nextRunAt = ? WHERE id = ?").run(0, job.id);
    } finally { sqlite.close(); }
  });
  await page.goto(`${app.origin}/settings`);
  const history = page.getByRole("region", { name: "定时执行历史" });
  await expect(history.getByText(/INTERNAL_ERROR/)).toBeVisible();
  await expect(history.getByRole("button", { name: "重新执行一次" })).toBeEnabled();
  const first = (await browserData(page, "/api/schedules/runs"))[0];
  await history.getByRole("button", { name: "重新执行一次" }).click();
  await expect(history.getByText(/手动重试/)).toBeVisible();
  const runs = await browserData(page, "/api/schedules/runs");
  expect(runs).toHaveLength(2);
  expect(runs[0].id).not.toBe(first.id);
  expect(runs[0].requestId).not.toBe(first.requestId);
  const download = page.waitForEvent("download");
  await history.getByRole("link", { name: "导出脱敏诊断" }).click();
  const artifact = await download;
  expect(artifact.suggestedFilename()).toBe("ria-execution-diagnostics.json");
  const downloadedPath = await artifact.path();
  expect(downloadedPath).toBeTruthy();
  const diagnostics = JSON.parse(await readFile(downloadedPath!, "utf8"));
  expect(diagnostics.scheduled).toHaveLength(2);
  expect(diagnostics.scheduled[0].id).not.toBe(runs[0].id);
  expect(diagnostics.scheduled[0].errorCode).toBe("INTERNAL_ERROR");
  expect(JSON.stringify(diagnostics)).not.toContain(file.file);
  const screenshots = join(tmpdir(), "ria-execution-history-qa");
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "desktop.png"), fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(history.getByRole("link", { name: "导出脱敏诊断" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: join(screenshots, "mobile.png"), fullPage: true, animations: "disabled" });
  await browserApi(page, `/api/schedules/${job.id}`, "DELETE");
  await page.reload();
  await expect(history.getByText("原计划已删除，执行证据仍保留。")).toHaveCount(2);
  await expect(history.getByRole("button", { name: "重新执行一次" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("desktop restart marks an unfinished execution interrupted without replaying it", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  const job = (await browserApi(page, "/api/schedules", "POST", {
    kind: "scheduledBackup", enabled: true, localTime: "09:00", timeZone: "UTC", interval: "daily",
  })).body.data;
  const { DatabaseSync } = await import("node:sqlite");
  const file = app.readRows("PRAGMA database_list")[0] as { file: string };
  await app.restart(() => {
    const sqlite = new DatabaseSync(file.file);
    try {
      sqlite.prepare("UPDATE scheduled_jobs SET lastStatus = 'running', nextRunAt = 0 WHERE id = ?").run(job.id);
      sqlite.prepare("INSERT INTO scheduled_runs (id, jobId, kind, requestId, status, startedAt) VALUES (?, ?, ?, ?, 'running', ?)").run("interrupted-fixture", job.id, job.kind, "interrupted-request", Date.now() - 60_000);
    } finally { sqlite.close(); }
  });
  await page.goto(`${app.origin}/settings`);
  const history = page.getByRole("region", { name: "定时执行历史" });
  await expect(history.getByText(/进程中断/)).toBeVisible();
  await expect(history.getByText(/应用退出前执行未完成/)).toBeVisible();
  await expect(history.getByRole("button", { name: "重新执行一次" })).toHaveCount(0);
  const runs = await browserData(page, "/api/schedules/runs");
  expect(runs).toHaveLength(1);
  expect(runs[0].status).toBe("interrupted");
  expect(app.readRows("SELECT count(*) AS count FROM scheduled_runs")[0]).toMatchObject({ count: 1 });
  expect(app.readRows("SELECT count(*) AS count FROM chats")[0]).toMatchObject({ count: 0 });
});


test("accepted desktop reminder claims remain visible after restart without claiming native delivery", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  const { DatabaseSync } = await import("node:sqlite");
  const file = app.readRows("PRAGMA database_list")[0] as { file: string };
  await app.restart(() => {
    const fixture = new DatabaseSync(file.file);
    try {
      fixture.prepare("INSERT INTO tasks (id,title,dueDate,reminderEnabled,updatedAt) VALUES (?,?,?,?,?)").run("durable-reminder", "到期记录浏览器验证", Date.now() - 60_000, 1, Date.now());
    } finally { fixture.close(); }
  });
  const accepted = await browserApi(page, "/api/tasks/reminders", "POST");
  expect(accepted.status).toBe(200); expect(accepted.body.data).toHaveLength(1);
  expect((await browserApi(page, "/api/tasks/reminders", "POST")).body.data).toEqual([]);
  await page.goto(`${app.origin}/settings`);
  await expect(page.getByText("任务已到期", { exact: true })).toBeVisible();
  await expect(page.getByText(/到期记录浏览器验证.*系统通知可能被拒绝或错过/)).toBeVisible();
  await app.restart(); await page.reload();
  await expect(page.getByText("任务已到期", { exact: true })).toBeVisible();
  expect(app.readRows("SELECT count(*) AS count FROM app_notices WHERE kind='taskReminder'")[0]).toMatchObject({ count: 1 });
});
