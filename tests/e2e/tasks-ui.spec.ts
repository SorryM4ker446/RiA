import { test as base, expect } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { browserApi, browserData } from "../helpers/browser-api";
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

test("task creation has aligned dropdowns and a themed calendar on desktop and mobile", async ({
  page,
  app,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/tasks`);
  await expect(page).toHaveTitle(/RiA/);
  await expect(
    page.getByRole("heading", { name: "Scheduled tasks", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const form = page.getByRole("form", {
    name: "New scheduled task",
    exact: true,
  });
  await form.getByLabel("Task name", { exact: true }).fill("Calendar task");
  await form
    .getByLabel("Task description", { exact: true })
    .fill("Keep the selected wall time in the task time zone.");
  await form.getByLabel("Due reminder", { exact: true }).check();
  await chooseOption(
    form.getByRole("combobox", { name: "Repeat", exact: true }),
    "Weekly",
  );
  await form.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("require a time");
  await expect(form.getByLabel("Task name", { exact: true })).toHaveValue(
    "Calendar task",
  );
  await chooseTaskDateTime(page, form, "Due time", "2027-01-15T09:30");
  await form.getByLabel("Time zone", { exact: true }).fill("America/New_York");
  await chooseOption(
    form.getByRole("combobox", { name: "Priority", exact: true }),
    "High",
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    const priority = form.getByRole("combobox", {
      name: "Priority",
      exact: true,
    });
    const trigger = (await priority.boundingBox())!;
    const arrow = (await priority.locator("svg").boundingBox())!;
    const selectedText = (await priority
      .getByText("High", { exact: true })
      .boundingBox())!;
    expect(selectedText.x - trigger.x).toBeLessThanOrEqual(20);
    expect(arrow.y).toBeGreaterThanOrEqual(trigger.y);
    expect(arrow.y + arrow.height).toBeLessThanOrEqual(
      trigger.y + trigger.height,
    );
    await priority.click();
    await expect(
      page.getByRole("option", { name: "High", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: join(tmpdir(), `ria-tasks-select-${width}.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await form.getByLabel("Due time", { exact: true }).click();
    const calendar = page.getByRole("dialog", {
      name: "Due time",
      exact: true,
    });
    await expect(calendar.getByRole("grid")).toBeVisible();
    const bounds = (await calendar.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: join(tmpdir(), `ria-tasks-calendar-${width}.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await form.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(
    page.getByTestId("task-item").filter({ hasText: "Calendar task" }),
  ).toBeVisible();
  const tasks = await browserData(page, `${app.origin}/api/tasks`);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    title: "Calendar task",
    priority: "high",
    timeZone: "America/New_York",
    dueDate: "2027-01-15T14:30:00.000Z",
    repeatRule: "weekly",
    reminderEnabled: true,
  });
  await page.reload();
  await expect(
    page.getByTestId("task-item").getByText("Calendar task", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
  const card = page
    .getByTestId("task-item")
    .filter({ hasText: "Calendar task" });
  await card
    .getByRole("button", { name: "Set time and reminders", exact: true })
    .click();
  await card.getByLabel("Due date", { exact: true }).click();
  const calendar = page.getByRole("dialog", { name: "Due date", exact: true });
  await expect(calendar.getByRole("grid")).toBeVisible();
  await page.screenshot({
    path: join(tmpdir(), "ria-tasks-calendar-light.png"),
    animations: "disabled",
  });
  await calendar
    .getByRole("button", { name: "Clear date", exact: true })
    .click();
  await expect(card.getByLabel("Time", { exact: true })).toBeDisabled();
  await card
    .getByRole("button", { name: "Save reminder settings", exact: true })
    .click();
  await expect(card.getByRole("alert")).toBeVisible();
  await card
    .getByLabel("Desktop notification when due", { exact: true })
    .uncheck();
  await chooseOption(
    card.getByRole("combobox", { name: "Repeat", exact: true }),
    "Does not repeat",
  );
  await card
    .getByRole("button", { name: "Save reminder settings", exact: true })
    .click();
  await expect(
    card.getByRole("button", { name: "Save reminder settings", exact: true }),
  ).toHaveCount(0);
  expect((await browserData(page, `${app.origin}/api/tasks`))[0]).toMatchObject(
    { dueDate: null, repeatRule: "none", reminderEnabled: false },
  );
  expect(errors).toEqual([]);
  expect(app.providerCalls).toEqual([]);
});

test("filter changes preserve rows during requests and ignore late results", async ({
  page,
  app,
}) => {
  await openWorkspace(page, app.origin);
  for (const title of ["Pending task", "Completed task"]) {
    const result = await browserApi(
      page,
      `${app.origin}/api/tools/run`,
      "POST",
      { tool: "createTask", mode: "chat", input: { title } },
    );
    expect(result.status).toBe(200);
    if (title === "Completed task")
      await browserApi(
        page,
        `${app.origin}/api/tasks/${result.body.data.taskId}`,
        "PATCH",
        { status: "done" },
      );
  }
  await page.goto(`${app.origin}/tasks`);
  const panel = page.getByTestId("task-panel");
  await expect(panel.getByTestId("task-item")).toHaveCount(2);
  const filters = page.getByRole("radiogroup", {
    name: "Task list",
    exact: true,
  });
  const progress = filters.getByRole("radio", {
    name: "In progress",
    exact: true,
  });
  const completed = filters.getByRole("radio", {
    name: "Completed",
    exact: true,
  });
  const left = (await progress.boundingBox())!;
  const right = (await completed.boundingBox())!;
  expect(right.x - (left.x + left.width)).toBeGreaterThanOrEqual(8);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("status") === "todo")
      await gate;
    await route.continue();
  });
  try {
    await filters.getByRole("radio", { name: "To do", exact: true }).click();
    await expect(panel).toHaveAttribute("aria-busy", "true");
    await expect(panel.getByTestId("task-item")).toHaveCount(2);
    await expect(panel.getByRole("status")).toHaveCount(0);
    await completed.click();
    await expect(panel).toHaveAttribute("aria-busy", "false");
    await expect(panel.getByTestId("task-item")).toHaveCount(1);
    await expect(
      panel.getByText("Completed task", { exact: true }),
    ).toBeVisible();
    const response = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/tasks" &&
        new URL(response.url()).searchParams.get("status") === "todo",
    );
    release();
    await response;
    await expect(completed).toHaveAttribute("aria-checked", "true");
    await expect(
      panel.getByText("Completed task", { exact: true }),
    ).toBeVisible();
    await filters
      .getByRole("radio", { name: "In progress", exact: true })
      .click();
    await expect(panel.getByTestId("task-item")).toHaveCount(0);
    await expect(
      panel.getByText("No tasks in this view yet.", { exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});
