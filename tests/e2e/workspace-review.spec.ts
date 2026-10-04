import { test as base, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { browserApi } from "../helpers/browser-api";
const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer(); try { await runTest(app); } finally { await app.close(); } },
});
test("local review exposes real recorded changes, current sources and deleted-source evidence without a model", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  const file = app.readRows("PRAGMA database_list")[0] as { file: string };
  const fixture = new DatabaseSync(file.file);
  const taskId = "review-task-fixture";
  try {
    fixture.prepare("INSERT INTO tasks (id, title, updatedAt) VALUES (?, ?, ?)").run(taskId, "回顾来源任务", Date.now());
  } finally { fixture.close(); }
  expect((await browserApi(page, `/api/tasks/${taskId}`, "PATCH", { status: "done" })).status).toBe(200);
  expect((await browserApi(page, `/api/tasks/${taskId}`, "PATCH", { status: "done" })).status).toBe(200);
  expect(app.readRows("SELECT count(*) AS count FROM workspace_events")[0]).toMatchObject({ count: 1 });
  const sqlite = new DatabaseSync(file.file);
  // Only the recorded timestamp is shifted to yesterday to exercise the public
  // calendar preview, after the real mutation proved idempotent event creation.
  const yesterday = new Date(); yesterday.setUTCDate(yesterday.getUTCDate() - 1); yesterday.setUTCHours(12, 0, 0, 0);
  try {
    sqlite.prepare("UPDATE workspace_events SET occurredAt = ?").run(yesterday.getTime());
    sqlite.prepare("UPDATE workspace_activity_state SET recordingStartedAt = ?, completeSince = ? WHERE id = 'local'").run(yesterday.getTime() - 86_400_000, yesterday.getTime() - 86_400_000);
  } finally { sqlite.close(); }
  await page.goto(`${app.origin}/settings`);
  const review = page.getByRole("region", { name: "工作区事实回顾" });
  await review.getByRole("textbox", { name: "回顾时区" }).fill("UTC");
  await review.getByRole("button", { name: "查看事实回顾" }).click();
  await expect(review.getByText("任务完成：1 次", { exact: true })).toBeVisible();
  await expect(review.getByText("任务重新打开：0 次", { exact: true })).toBeVisible();
  const source = review.getByRole("link", { name: "任务完成 · 回顾来源任务" });
  await source.click();
  await expect(page.getByRole("heading", { name: "回顾事件来源" })).toBeVisible();
  await expect(page.getByText("done", { exact: true })).toBeVisible();
  await browserApi(page, `/api/tasks/${taskId}`, "DELETE");
  await page.reload();
  await expect(page.getByText("原任务、资料或记忆已删除，历史事件仍然保留。")).toBeVisible();
  await page.getByRole("link", { name: "返回设置与回顾" }).click();
  await review.getByRole("textbox", { name: "回顾时区" }).fill("UTC");
  await review.getByRole("button", { name: "查看事实回顾" }).click();
  await expect(review.getByText("任务完成：1 次", { exact: true })).toBeVisible();
  expect(app.readRows("SELECT count(*) AS count FROM model_requests")[0]).toMatchObject({ count: 0 });
  const screenshots = join(tmpdir(), "ria-workspace-review-qa"); await mkdir(screenshots, { recursive: true });
  await review.screenshot({ path: join(screenshots, "desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await review.screenshot({ path: join(screenshots, "mobile.png"), animations: "disabled" });
  await review.getByRole("combobox", { name: "回顾期间" }).selectOption("weekly");
  await review.getByRole("button", { name: "查看事实回顾" }).click();
  await expect(review.getByText(/结束日期不包含/)).toBeVisible();
  expect(errors).toEqual([]);
});
