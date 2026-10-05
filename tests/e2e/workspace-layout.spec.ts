import { test as base, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { browserApi } from "../helpers/browser-api";

const test = base.extend<{
  app: Awaited<ReturnType<typeof startStandaloneServer>>;
}>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer();
    try {
      await runTest(app);
    } finally {
      await app.close();
    }
  },
});

test("workspace separates scheduled tasks and retains content during refresh", async ({
  page,
  app,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    if (!localStorage.getItem("ui:theme"))
      localStorage.setItem("ui:theme", "dark");
  });
  await openWorkspace(page, app.origin);
  const created = await browserApi(page, "/api/tools/run", "POST", {
    tool: "createTask",
    mode: "chat",
    input: { title: "保持可见的任务" },
  });
  expect(created.status).toBe(200);
  let finishInitial!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    finishInitial = resolve;
  });
  await page.route("**/api/tasks**", async (route) => {
    await firstGate;
    await route.continue();
  });
  await page.goto(`${app.origin}/tasks`);
  try {
    await expect(page.getByRole("status", { name: "加载任务" })).toBeVisible();
  } finally {
    finishInitial();
  }
  const task = page
    .getByTestId("task-panel")
    .getByText("保持可见的任务", { exact: true });
  await expect(task).toBeVisible();
  await page.unroute("**/api/tasks**");
  const createAction = page.getByRole("button", {
    name: "新建任务",
    exact: true,
  });
  const before = await createAction.boundingBox();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks**", async (route) => {
    await gate;
    await route.continue();
  });
  const refresh = page.getByRole("button", { name: "刷新任务", exact: true });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(task).toBeVisible();
  await expect(
    page.getByTestId("task-panel").locator('[role="status"]'),
  ).toHaveCount(0);
  expect(await createAction.boundingBox()).toEqual(before);
  release();
  await expect(refresh).toBeEnabled();
  expect(await createAction.boundingBox()).toEqual(before);
  await page.goto(`${app.origin}/chat`);
  const composer = page.getByPlaceholder(/输入你的问题/);
  await expect(page.getByTestId("task-panel")).toHaveCount(0);
  const screenshots = join(tmpdir(), "ria-workspace-ui");
  await mkdir(screenshots, { recursive: true });
  for (const size of [
    { width: 1440, height: 960 },
    { width: 900, height: 640 },
    { width: 390, height: 780 },
  ]) {
    await page.setViewportSize(size);
    await expect(composer).toBeVisible();
    expect(
      await page.evaluate(() => ({
        x: document.documentElement.scrollWidth > innerWidth,
        y: document.documentElement.scrollHeight > innerHeight,
      })),
    ).toEqual({ x: false, y: false });
    const box = await composer.boundingBox();
    expect(box!.y + box!.height).toBeLessThan(size.height);
    const workspace = await page.locator(".chat-workspace").boundingBox();
    expect(workspace!.x + workspace!.width).toBeCloseTo(size.width, 0);
    const surface = page.locator(".composer-surface");
    const beforeTyping = await surface.boundingBox();
    await composer.fill("一行短消息");
    expect(await surface.boundingBox()).toEqual(beforeTyping);
    await composer.fill(Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：测试长代码和换行不会移动输入区域。`).join("\n"));
    expect(await surface.boundingBox()).toEqual(beforeTyping);
    expect(await composer.boundingBox()).toEqual(box);
    expect(await composer.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await composer.evaluate(el => { el.scrollTop = el.scrollHeight; });
    expect(await composer.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({ path: join(screenshots, `chat-draft-${size.width}.png`), animations: "disabled" });
    await composer.fill("");
    expect(await surface.boundingBox()).toEqual(beforeTyping);
    if (size.width < 1280) {
      await page.getByRole("button", { name: "会话列表", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "创建会话", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(task).not.toBeVisible();
    }
    await page.screenshot({
      path: join(screenshots, `chat-${size.width}.png`),
      animations: "disabled",
    });
  }
  await page.getByRole("button", { name: "打开导航" }).click();
  const navigation = page.getByRole("dialog", { name: "工作区导航" });
  await expect(navigation).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(
    await navigation.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(navigation).not.toBeVisible();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "收起会话列表", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "会话列表", exact: true }),
  ).toHaveCSS("width", "40px");
  const collapsed = await page
    .getByRole("complementary", { name: "会话列表", exact: true })
    .boundingBox();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "展开会话列表", exact: true }),
  ).toBeVisible();
  expect(
    await page
      .getByRole("complementary", { name: "会话列表", exact: true })
      .boundingBox(),
  ).toEqual(collapsed);
  await page.getByRole("button", { name: "展开会话列表", exact: true }).click();
  for (const route of [
    "/",
    "/tasks",
    "/knowledge",
    "/conversations",
    "/media",
    "/models",
    "/backups",
    "/storage",
  ]) {
    await page.goto(`${app.origin}${route}`);
    await expect(page.locator("main")).toBeVisible();
    await page.screenshot({
      path: join(screenshots, `${route.slice(1) || "home"}.png`),
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  }
  await page.getByRole("button", { name: /主题/ }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.goto(`${app.origin}/tasks`);
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const taskComposer = page.getByRole("form", { name: "新建定时任务" });
  await taskComposer
    .getByLabel("任务名称", { exact: true })
    .fill("从新任务入口创建的计划");
  await taskComposer
    .getByRole("button", { name: "创建任务", exact: true })
    .click();
  const newTask = page
    .getByTestId("task-item")
    .filter({ hasText: "从新任务入口创建的计划" });
  await expect(newTask).toBeVisible();
  const completion = newTask.getByRole("checkbox", {
    name: "完成任务 从新任务入口创建的计划",
    exact: true,
  });
  let rejectUpdate!: () => void;
  const failedUpdate = new Promise<void>((resolve) => {
    rejectUpdate = resolve;
  });
  const rejectRoute = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await failedUpdate;
    await route.fulfill({
      status: 500,
      json: {
        error: { code: "INTERNAL_ERROR", message: "Fixture rejected update" },
      },
    });
  };
  await page.route("**/api/tasks/*", rejectRoute);
  try {
    await completion.check();
    await expect(completion).toBeDisabled();
    await expect(completion).toBeChecked();
  } finally {
    rejectUpdate();
  }
  await expect(completion).not.toBeChecked();
  await expect(completion).toBeEnabled();
  await expect(page.getByTestId("task-panel").getByRole("alert")).toContainText(
    "Fixture rejected update",
  );
  await page.unroute("**/api/tasks/*", rejectRoute);
  await completion.check();
  await expect(newTask.getByRole("combobox")).toContainText("已完成");
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await expect(newTask).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByTestId("task-item")
      .filter({ hasText: "从新任务入口创建的计划" })
      .getByRole("checkbox"),
  ).toBeChecked();
  expect(errors).toEqual([]);
});

test("chat alone exposes the desktop and execution history can be collapsed", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    // Simulate the preload presence for renderer styles; this does not emulate native Acrylic.
    Object.defineProperty(window, "privateAiDesktop", { value: {
      getSettings: async () => { throw new Error("Renderer style fixture"); },
      getRuntimeInfo: async () => { throw new Error("Renderer style fixture"); },
    } });
  });
  await openWorkspace(page, app.origin);
  const conversation = (
    await browserApi(page, "/api/conversations", "POST", {
      title: "折叠执行记录",
    })
  ).body.data;
  await page.route("**/runs?limit=10", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: "run-fixture",
            chatId: conversation.id,
            goal: "检查执行步骤",
            status: "succeeded",
            stopReason: null,
            budget: {
              maxSteps: 4,
              deadlineMs: 10000,
              maxFailures: 1,
              spentCostUsd: 0,
            },
            steps: [],
          },
        ],
      },
    }),
  );
  await page.goto(`${app.origin}/chat?conversationId=${conversation.id}`);
  await expect(page.locator(".chat-canvas")).toHaveCSS(
    "background-color",
    /0\.88/,
  );
  await expect(page.locator(".chat-rail-left")).toHaveCSS(
    "background-color",
    /rgb\(/,
  );
  await expect(page.locator(".chat-dock")).toHaveCSS(
    "background-color",
    /rgb\(/,
  );
  const records = page.locator(".run-records");
  await expect(records.locator("summary")).toContainText("1");
  await expect(
    records.getByText("检查执行步骤", { exact: true }),
  ).not.toBeVisible();
  await records.locator("summary").click();
  await expect(
    records.getByText("检查执行步骤", { exact: true }),
  ).toBeVisible();
  await records.locator("summary").click();
  await expect(
    records.getByText("检查执行步骤", { exact: true }),
  ).not.toBeVisible();
  for (const route of ["/", "/tasks", "/knowledge", "/settings", "/models"]) {
    await page.goto(`${app.origin}${route}`);
    await expect(page.locator(".workspace-shell")).toHaveAttribute(
      "data-chat-page",
      "false",
    );
    await expect(page.locator(".workspace-shell")).toHaveCSS(
      "background-color",
      /rgb\(/,
    );
  }
  await page.setViewportSize({ width: 390, height: 430 });
  await page.goto(`${app.origin}/`);
  const content = page.locator(".workspace-content");
  expect(
    await content.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await content.evaluate((element) =>
    element.scrollTo(0, element.scrollHeight),
  );
  expect(
    await content.evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
  await expect(content).toHaveCSS("overflow-y", "auto");
});

test("scheduled task creation validates time and persists without a model", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/tasks`);
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const form = page.getByRole("form", { name: "新建定时任务" });
  await form.getByLabel("任务名称", { exact: true }).fill("独立页面的每周提醒");
  await form.getByLabel("到期提醒", { exact: true }).check();
  await form.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("需要设置时间");
  expect(app.readRows("SELECT id FROM tasks")).toHaveLength(0);
  await form.getByLabel("时区", { exact: true }).fill("America/New_York");
  await form.getByLabel("到期时间", { exact: true }).fill("2026-03-08T02:30");
  await form.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("不存在这个本地时间");
  expect(app.readRows("SELECT id FROM tasks")).toHaveLength(0);
  await form.getByLabel("时区", { exact: true }).fill("Asia/Shanghai");
  await form.getByLabel("到期时间", { exact: true }).fill("2026-11-20T09:00");
  await form.getByRole("combobox", { name: /^重复/ }).selectOption("weekly");
  await page.setViewportSize({ width: 390, height: 780 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), "ria-workspace-ui", "tasks-create-mobile.png"), animations: "disabled" });
  await form.getByRole("button", { name: "创建任务", exact: true }).click();
  await expect(page.getByTestId("task-item").getByText("独立页面的每周提醒", { exact: true })).toBeVisible();
  const payload = await browserApi(page, "/api/tasks");
  expect(payload.body.data).toHaveLength(1);
  expect(payload.body.data[0]).toMatchObject({ dueDate: "2026-11-20T01:00:00.000Z", timeZone: "Asia/Shanghai", reminderEnabled: true, repeatRule: "weekly" });
  await app.restart(); await page.reload();
  await expect(page.getByTestId("task-item").getByRole("img", { name: "到期提醒" })).toBeVisible();
  expect(app.providerCalls).toEqual([]);
});
