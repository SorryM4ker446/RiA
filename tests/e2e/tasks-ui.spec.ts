import { test as base, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { browserApi, browserData } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";
import { chooseOption } from "../helpers/select";
import { chooseTaskDateTime } from "../helpers/task-date-picker";

const test = base.extend<{
  app: Awaited<ReturnType<typeof startStandaloneServer>>;
}>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try {
      await runTest(app);
    } finally {
      await app.close();
    }
  },
});
test.use({ locale: "en-US", timezoneId: "America/New_York" });

type Task = { id: string; title: string; cron: string | null; timeZone: string; enabled: boolean; nextRunAt: string; chatId: string | null; lastStatus: string | null };
const row = (page: Page, title: string) => page.getByTestId("task-item").filter({ hasText: title });
async function rowAction(page: Page, title: string, action: string) {
  await page.getByRole("button", { name: `More actions for ${title}`, exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: action, exact: true }).click();
  await expect(menu).toBeHidden();
}
async function openEditor(page: Page) {
  await page.getByRole("button", { name: "New task", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "New task", exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
}

test("a repeating task is made in the form, keeps what was typed when refused, and fits a phone", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/tasks`);
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.getByText(/^No tasks yet\./)).toBeVisible();
  const sheet = await openEditor(page);
  // What each run works with is folded away until asked for.
  await expect(sheet.getByLabel("Time zone", { exact: true })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Advanced", exact: true }).click();
  // The zone a schedule is read in starts as the device's own; a new task follows the default model and has no folder.
  await expect(sheet.getByLabel("Time zone", { exact: true })).toHaveValue("America/New_York");
  await expect(sheet.getByRole("combobox", { name: "Model", exact: true })).toContainText("Follow the default chat model");
  await expect(sheet.getByRole("combobox", { name: "Working folder", exact: true })).toContainText("No folder");
  await sheet.getByLabel("Name", { exact: true }).fill("Weekly review");
  await sheet.getByRole("button", { name: "Create", exact: true }).click();
  await expect(sheet.getByRole("alert")).toContainText("Say what the task should do");
  await expect(sheet.getByLabel("Name", { exact: true })).toHaveValue("Weekly review");
  await sheet.getByLabel("What to do", { exact: true }).fill("Summarise what changed this week.");
  await chooseOption(sheet.getByRole("combobox", { name: "When to run", exact: true }), "Every week");
  await chooseOption(sheet.getByRole("combobox", { name: "Day of the week", exact: true }), "Monday");
  await sheet.getByLabel("Time", { exact: true }).fill("09:30");
  await sheet.getByLabel("Time", { exact: true }).blur();
  // A save the service refuses leaves the form as it was.
  await page.route("**/api/tasks", route => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: { message: "Tasks are briefly unavailable" } } }) : route.continue());
  await sheet.getByRole("button", { name: "Create", exact: true }).click();
  await expect(sheet.getByRole("alert")).toContainText("Tasks are briefly unavailable");
  await expect(sheet.getByLabel("What to do", { exact: true })).toHaveValue("Summarise what changed this week.");
  await page.unroute("**/api/tasks");
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(sheet.getByRole("button", { name: "Create", exact: true })).toBeVisible();
  expect(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), "ria-tasks-ui", "create-mobile.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await sheet.getByRole("button", { name: "Create", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row(page, "Weekly review")).toContainText("Every Monday at 09:30");
  await expect(row(page, "Weekly review")).toContainText("Scheduled");
  const [task] = await browserData(page, `${app.origin}/api/tasks`) as Task[];
  expect(task).toMatchObject({ cron: "30 9 * * 1", timeZone: "America/New_York", enabled: true, chatId: null });
  // A Monday at 09:30 in New York, whichever side of daylight saving it falls.
  const next = new Date(task.nextRunAt);
  expect(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(next)).toBe("Mon 09:30");

  // The editor opens on what was saved, and a change to it is what runs next.
  await rowAction(page, "Weekly review", "Edit");
  const editor = page.getByRole("dialog", { name: "Edit task", exact: true });
  await expect(editor.getByRole("combobox", { name: "When to run", exact: true })).toContainText("Every week");
  await expect(editor.getByLabel("Time", { exact: true })).toHaveValue("09:30");
  await chooseOption(editor.getByRole("combobox", { name: "When to run", exact: true }), "Custom");
  await editor.getByLabel("Cron expression", { exact: true }).fill("not a schedule");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("not a valid cron expression");
  await editor.getByLabel("Cron expression", { exact: true }).fill("0 18 1,15 * *");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(row(page, "Weekly review")).toContainText("Cron: 0 18 1,15 * *");
  expect((await browserData(page, `${app.origin}/api/tasks`) as Task[])[0].cron).toBe("0 18 1,15 * *");
  expect(app.providerCalls).toEqual([]);
  expect(errors).toEqual([]);
});

test("running a task by hand answers in its one conversation, and every run continues it", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  expect((await browserApi(page, `${app.origin}/api/tasks`, "POST", { kind: "prompt", title: "Water reminder", prompt: "Remind me to drink water", cron: "0 9 * * *", timeZone: "UTC" })).status).toBe(201);
  await page.goto(`${app.origin}/tasks`);
  await expect(row(page, "Water reminder")).toContainText("Paused");
  const runOnce = async (count: number) => {
    await rowAction(page, "Water reminder", "Run now");
    await expect.poll(async () => (await browserData(page, `${app.origin}/api/tasks/runs`) as unknown[]).length, { timeout: 20_000 }).toBe(count);
    await expect.poll(async () => ((await browserData(page, `${app.origin}/api/tasks`)) as Task[])[0].lastStatus, { timeout: 20_000 }).toBe("done");
  };
  await runOnce(1);
  const chatId = ((await browserData(page, `${app.origin}/api/tasks`)) as Task[])[0].chatId!;
  expect(chatId).toBeTruthy();
  await runOnce(2);
  const after = ((await browserData(page, `${app.origin}/api/tasks`)) as Task[])[0];
  expect(after.chatId).toBe(chatId);
  // Running it by hand did not switch it on.
  expect(after.enabled).toBe(false);
  expect((await browserData(page, `${app.origin}/api/conversations`) as unknown[]).length).toBe(1);
  await page.reload();
  await page.getByText("Run history", { exact: true }).click();
  await expect(page.getByRole("list", { name: "Run history" }).getByText("Run by hand", { exact: false })).toHaveCount(2);
  await rowAction(page, "Water reminder", "Open conversation");
  // The conversation opened, and the address no longer names it.
  await expect(page).toHaveURL(`${app.origin}/chat`);
  await expect(page.getByText("Remind me to drink water", { exact: true })).toHaveCount(2);
  expect(app.providerCalls.length).toBe(2);
});

test("a one-off task asks for a new time before it is switched back on, and deleting keeps its conversation", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/tasks`);
  const sheet = await openEditor(page);
  await sheet.getByLabel("Name", { exact: true }).fill("Send the report");
  await sheet.getByLabel("What to do", { exact: true }).fill("Remind me to send the quarterly report");
  await chooseOption(sheet.getByRole("combobox", { name: "When to run", exact: true }), "Once");
  await chooseTaskDateTime(page, sheet, "Date", "2030-01-15T09:30");
  await sheet.getByRole("button", { name: "Create", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const [task] = await browserData(page, `${app.origin}/api/tasks`) as Task[];
  expect(task).toMatchObject({ cron: null, nextRunAt: "2030-01-15T14:30:00.000Z", enabled: true });
  await expect(row(page, "Send the report")).toContainText("Once,");
  await rowAction(page, "Send the report", "Run now");
  await expect.poll(async () => ((await browserData(page, `${app.origin}/api/tasks`)) as Task[])[0].lastStatus, { timeout: 20_000 }).toBe("done");
  // It ran by hand before its time, so its time is still to come and it stays on.
  await page.reload();
  await expect(row(page, "Send the report")).toContainText("Scheduled");
  await rowAction(page, "Send the report", "Pause");
  await expect(row(page, "Send the report")).toContainText("Paused");
  await rowAction(page, "Send the report", "Turn on");
  await expect(row(page, "Send the report")).toContainText("Scheduled");

  const chatId = ((await browserData(page, `${app.origin}/api/tasks`)) as Task[])[0].chatId;
  await rowAction(page, "Send the report", "Delete");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Its conversation is kept");
  await confirm.getByRole("button").last().click();
  await expect(row(page, "Send the report")).toHaveCount(0);
  expect(await browserData(page, `${app.origin}/api/tasks`)).toEqual([]);
  expect((await browserData(page, `${app.origin}/api/conversations`) as Array<{ id: string }>).map(chat => chat.id)).toEqual([chatId]);
});

test("a built-in action needs no prompt and makes a backup without the model", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/tasks`);
  const sheet = await openEditor(page);
  await chooseOption(sheet.getByRole("combobox", { name: "Start from", exact: true }), "Scheduled backup");
  // The template filled the form in; it is saved only when the user saves it.
  await expect(sheet.getByLabel("Name", { exact: true })).toHaveValue("Back up the workspace");
  expect(await browserData(page, `${app.origin}/api/tasks`)).toEqual([]);
  await expect(sheet.getByLabel("What to do", { exact: true })).toHaveCount(0);
  await expect(sheet.getByText(/No model is involved/)).toBeVisible();
  await sheet.getByLabel("Name", { exact: true }).fill("Nightly backup");
  await sheet.getByRole("button", { name: "Create", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await rowAction(page, "Nightly backup", "Run now");
  await expect.poll(async () => ((await browserData(page, `${app.origin}/api/tasks/runs`)) as Array<{ status: string; backupId: string | null }>)[0]?.status, { timeout: 20_000 }).toBe("succeeded");
  const [run] = await browserData(page, `${app.origin}/api/tasks/runs`) as Array<{ backupId: string | null; chatId: string | null }>;
  expect(run.backupId).toBeTruthy();
  expect(run.chatId).toBeNull();
  expect((await browserData(page, `${app.origin}/api/backups`) as unknown[]).length).toBe(1);
  expect(app.providerCalls).toEqual([]);
});

test("the daily brief and weekly summary are templates that fill the form and create nothing on their own", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/tasks`);
  const templates = page.getByRole("group", { name: "Start from a template", exact: true });
  await expect(templates.getByRole("button")).toHaveText(["Daily brief", "Weekly summary", "Scheduled backup", "Backup reminder"]);
  await templates.getByRole("button", { name: "Weekly summary", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "New task", exact: true });
  await expect(sheet.getByLabel("Name", { exact: true })).toHaveValue("Weekly summary");
  // The prompt follows the interface language, and the schedule is a suggestion to change.
  await expect(sheet.getByLabel("What to do", { exact: true })).toHaveValue(/^Use readWorkspaceActivity .*complete week/);
  await expect(sheet.getByRole("combobox", { name: "When to run", exact: true })).toContainText("Every week");
  await expect(sheet.getByRole("combobox", { name: "Day of the week", exact: true })).toContainText("Monday");
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  expect(await browserData(page, `${app.origin}/api/tasks`)).toEqual([]);

  await templates.getByRole("button", { name: "Daily brief", exact: true }).click();
  await chooseOption(sheet.getByRole("combobox", { name: "Start from", exact: true }), "Custom task");
  await expect(sheet.getByLabel("What to do", { exact: true })).toHaveValue("");
  await chooseOption(sheet.getByRole("combobox", { name: "Start from", exact: true }), "Daily brief");
  await sheet.getByLabel("Time", { exact: true }).fill("07:45");
  await sheet.getByLabel("Time", { exact: true }).blur();
  await sheet.getByRole("button", { name: "Create", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const [task] = await browserData(page, `${app.origin}/api/tasks`) as Task[];
  // Saved still worded as the template, so it keeps following the interface language.
  expect(task).toMatchObject({ template: "dailyBrief", title: "", prompt: null, cron: "45 7 * * *", enabled: true });
  await expect(row(page, "Daily brief")).toContainText("Every day at 07:45");
  expect(app.providerCalls).toEqual([]);
});

test("a task's link opens its own conversation, whichever one chat had open last", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const other = (await browserApi(page, `${app.origin}/api/conversations`, "POST", { title: "Something else entirely" })).body.data as { id: string };
  expect((await browserApi(page, `${app.origin}/api/tasks`, "POST", { kind: "prompt", title: "Stretch reminder", prompt: "Remind me to stretch", cron: "0 9 * * *", timeZone: "UTC" })).status).toBe(201);
  await page.goto(`${app.origin}/tasks`);
  await rowAction(page, "Stretch reminder", "Run now");
  await expect.poll(async () => ((await browserData(page, `${app.origin}/api/tasks`)) as Task[])[0].lastStatus, { timeout: 20_000 }).toBe("done");
  // Chat last had the other conversation open.
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), other.id);
  await page.reload();
  await row(page, "Stretch reminder").getByRole("link", { name: "Stretch reminder", exact: true }).click();
  await expect(page.getByText("Remind me to stretch", { exact: true })).toBeVisible();
  // The address does not keep forcing it once it has opened.
  await expect(page).toHaveURL(`${app.origin}/chat`);
  await page.reload();
  await expect(page.getByText("Remind me to stretch", { exact: true })).toBeVisible();
});

test("a task still worded as a template follows the interface language, and one rewritten keeps its words", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/tasks`);
  await page.getByRole("group", { name: "Start from a template", exact: true }).getByRole("button", { name: "Daily brief", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "New task", exact: true });
  await sheet.getByRole("button", { name: "Create", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  // Shown in Chinese once the interface is.
  await page.evaluate(() => localStorage.setItem("ui:locale", "zh-CN"));
  await page.reload();
  await expect(row(page, "每日简报")).toBeVisible();
  await page.getByRole("button", { name: "更多操作 每日简报", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑任务", exact: true });
  await expect(editor.getByLabel("要做什么", { exact: true })).toHaveValue(/^用 readWorkspaceActivity 读取上一个完整日/);
  // Saving it unchanged keeps it on the template.
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(((await browserData(page, `${app.origin}/api/tasks`)) as Task[])[0]).toMatchObject({ template: "dailyBrief", title: "", prompt: null });
  // Rewriting the prompt makes it the user's own.
  await page.getByRole("button", { name: "更多操作 每日简报", exact: true }).click();
  await page.getByRole("menuitem", { name: "编辑", exact: true }).click();
  await editor.getByLabel("要做什么", { exact: true }).fill("只看文档变化。");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(((await browserData(page, `${app.origin}/api/tasks`)) as Task[])[0]).toMatchObject({ template: "dailyBrief", title: "", prompt: "只看文档变化。" });
  expect(app.providerCalls).toEqual([]);
});

test("a task's conversation keeps the general assistant, and its model picker changes the task's model", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/tasks`);
  const sheet = await openEditor(page);
  await sheet.getByLabel("Name", { exact: true }).fill("Morning note");
  await sheet.getByLabel("What to do", { exact: true }).fill("Write the morning note.");
  await sheet.getByRole("button", { name: "Advanced", exact: true }).click();
  await chooseOption(sheet.getByRole("combobox", { name: "Model", exact: true }), "Gemini Flash Offline");
  await sheet.getByRole("button", { name: "Create", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const [created] = await browserData(page, `${app.origin}/api/tasks`) as Array<Task & { model: { modelId: string } | null }>;
  expect(created.model?.modelId).toBe("google/gemini-3-flash-preview");
  await rowAction(page, "Morning note", "Run now");
  await expect.poll(async () => ((await browserData(page, `${app.origin}/api/tasks`)) as Task[])[0].lastStatus, { timeout: 20_000 }).toBe("done");
  await page.reload();
  await row(page, "Morning note").getByRole("link", { name: "Morning note", exact: true }).click();
  await expect(page.getByText("Write the morning note.", { exact: true })).toBeVisible();
  // No template can be applied here: the menu stays on the general assistant.
  const template = page.getByRole("combobox", { name: "Assistant templates", exact: true });
  await expect(template).toBeDisabled();
  await expect(template).toContainText("General assistant");
  // The picker shows the task's model, and choosing Default hands the task back to the default chat model.
  const picker = page.getByRole("combobox", { name: "Choose model", exact: true });
  await expect(picker).toContainText("Gemini Flash Offline");
  await chooseOption(picker, /^Default \(Claude Opus Offline\)$/);
  await expect.poll(async () => ((await browserData(page, `${app.origin}/api/tasks`)) as Array<{ model: unknown }>)[0].model).toBeNull();
});

test("a task can run only by hand, and decides its approval rule, memory, effort and notifications", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/tasks`);
  const sheet = await openEditor(page);
  await sheet.getByLabel("Name", { exact: true }).fill("Tidy the notes");
  await sheet.getByLabel("What to do", { exact: true }).fill("Tidy the notes folder.");
  await chooseOption(sheet.getByRole("combobox", { name: "When to run", exact: true }), "Run by hand only");
  // Nothing to time: no time row, and no missed-time choice under Advanced.
  await expect(sheet.getByLabel("Time", { exact: true })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(sheet.getByRole("combobox", { name: "If its time is missed", exact: true })).toHaveCount(0);
  await expect(sheet.getByRole("combobox", { name: "Approval rule", exact: true })).toContainText("Ask");
  await chooseOption(sheet.getByRole("combobox", { name: "Approval rule", exact: true }), "Accept edits");
  await sheet.getByRole("checkbox", { name: "Long-term memory", exact: true }).click();
  await chooseOption(sheet.getByRole("combobox", { name: "Effort", exact: true }), "High");
  await chooseOption(sheet.getByRole("combobox", { name: "Notifications", exact: true }), "Important only");
  await sheet.getByRole("button", { name: "Create", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const [task] = await browserData(page, `${app.origin}/api/tasks`) as Array<Task & { approvalRule: string; usesMemory: boolean; reasoningEffort: string | null; notify: string }>;
  expect(task).toMatchObject({ cron: null, nextRunAt: null, approvalRule: "acceptEdits", usesMemory: true, reasoningEffort: "high", notify: "important" });
  await expect(row(page, "Tidy the notes")).toContainText("Run by hand only");
  await expect(row(page, "Tidy the notes")).toContainText("Manual");
  // A task run only by hand has nothing to pause.
  await page.getByRole("button", { name: "More actions for Tidy the notes", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Run now", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Pause", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Opened again, the form shows what was saved.
  await rowAction(page, "Tidy the notes", "Edit");
  const editor = page.getByRole("dialog", { name: "Edit task", exact: true });
  await expect(editor.getByRole("combobox", { name: "When to run", exact: true })).toContainText("Run by hand only");
  await editor.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(editor.getByRole("combobox", { name: "Approval rule", exact: true })).toContainText("Accept edits");
  await expect(editor.getByRole("checkbox", { name: "Long-term memory", exact: true })).toBeChecked();
  expect(app.providerCalls).toEqual([]);
});
