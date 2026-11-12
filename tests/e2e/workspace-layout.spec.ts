import { test as base, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { settingsDialog } from "../helpers/settings";
import { browserApi } from "../helpers/browser-api";
import { toasts } from "../helpers/toast";
import { chooseTaskDateTime } from "../helpers/task-date-picker";
import { chooseMenuAction } from "../helpers/row-menu";
import { newTask as taskInput } from "../helpers/slash-menu";
import { conversationList } from "../helpers/conversations";

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
  const created = await browserApi(page, "/api/tasks", "POST", taskInput("保持可见的任务"));
  expect(created.status).toBe(201);
  let finishInitial!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    finishInitial = resolve;
  });
  await page.route("**/api/tasks", async (route) => {
    await firstGate;
    await route.continue();
  });
  await page.goto(`${app.origin}/tasks`);
  try {
    await expect(page.getByText("正在加载任务…", { exact: true })).toBeVisible();
  } finally {
    finishInitial();
  }
  const task = page.getByTestId("task-item").filter({ hasText: "保持可见的任务" });
  await expect(task).toBeVisible();
  await page.unroute("**/api/tasks");
  const createAction = page.getByRole("button", { name: "新建任务", exact: true });
  const before = await createAction.boundingBox();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() === "GET") await gate;
    await route.continue();
  });
  await chooseMenuAction(page, "保持可见的任务", "启用");
  // Saved; the list is being read again behind the row, which stays where it is.
  await expect(task).toBeVisible();
  await expect(page.getByText("正在加载任务…", { exact: true })).toHaveCount(0);
  expect(await createAction.boundingBox()).toEqual(before);
  release();
  await expect(task).toContainText("已安排");
  expect(await createAction.boundingBox()).toEqual(before);
  await page.unroute("**/api/tasks");
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
      // Folded here: pointing at the sidebar button shows it, conversations included, over the page.
      await page.getByRole("button", { name: "展开侧边栏", exact: true }).hover();
      await expect(conversationList(page).getByRole("button", { name: "新会话", exact: true })).toBeVisible();
      // Moving the pointer away puts it back.
      await page.mouse.move(size.width - 8, size.height - 8);
      await expect(page.locator(".rail-peek")).toHaveCount(0);
      await expect(task).not.toBeVisible();
    }
    await page.screenshot({
      path: join(screenshots, `chat-${size.width}.png`),
      animations: "disabled",
    });
  }
  // The narrow window starts folded; the sidebar button pins and folds it from the keyboard.
  await page.getByRole("button", { name: "展开侧边栏", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "工作区导航" })).toBeVisible();
  await expect(page.getByRole("button", { name: "收起侧边栏", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "展开侧边栏", exact: true })).toBeFocused();
  // Folding eases; measure the layout once it has settled, not in the middle of it.
  await expect(page.locator("html")).not.toHaveAttribute("data-rail-animating", "");
  await page.setViewportSize({ width: 1440, height: 960 });
  // A fold made on a narrow window lasts only while it is narrow: wide again, the
  // sidebar is docked, its conversations beside the page.
  await expect(conversationList(page)).toBeVisible();
  for (const route of [
    "/",
    "/tasks",
    "/knowledge",
    "/conversations",
    "/media",
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
  // Models, backups and storage are sections of the settings overlay, opened over a page.
  for (const section of ["models", "backups", "storage"]) {
    await page.goto(`${app.origin}/?settings=${section}`);
    await expect(settingsDialog(page)).toBeVisible();
    await page.screenshot({ path: join(screenshots, `settings-${section}.png`), animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  }
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toBeHidden();
  await page.getByRole("button", { name: /主题/ }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.goto(`${app.origin}/tasks`);
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "新建任务", exact: true });
  await sheet.getByLabel("名称", { exact: true }).fill("从新任务入口创建的计划");
  await sheet.getByLabel("要做什么", { exact: true }).fill("提醒我整理本周计划。");
  await sheet.getByRole("button", { name: "创建", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const newTask = page.getByTestId("task-item").filter({ hasText: "从新任务入口创建的计划" });
  await expect(newTask).toContainText("已安排");
  await expect(newTask).toContainText("每天 09:00");
  // A refused change says why and leaves the row as it was.
  let rejectUpdate!: () => void;
  const failedUpdate = new Promise<void>((resolve) => {
    rejectUpdate = resolve;
  });
  const rejectRoute = async (route: import("@playwright/test").Route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await failedUpdate;
    await route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "Fixture rejected update" } } });
  };
  await page.route("**/api/tasks/*", rejectRoute);
  try {
    await chooseMenuAction(page, "从新任务入口创建的计划", "暂停");
  } finally {
    rejectUpdate();
  }
  await expect(page.locator("main").getByRole("alert")).toContainText("Fixture rejected update");
  await expect(newTask).toContainText("已安排");
  await page.unroute("**/api/tasks/*", rejectRoute);
  await chooseMenuAction(page, "从新任务入口创建的计划", "暂停");
  await expect(newTask).toContainText("已暂停");
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("task-item").filter({ hasText: "从新任务入口创建的计划" })).toContainText("已暂停");
  expect(errors).toEqual([]);
});

test("desktop chat stays translucent and execution history opens without moving the composer", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    // Simulate the preload presence for renderer styles; this does not emulate native Acrylic.
    Object.defineProperty(window, "riaDesktop", { value: {
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
  await expect(page.locator(".workspace-main")).toHaveCSS(
    "background-color",
    /0\.88/,
  );
  await expect(page.locator(".chat-canvas")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.locator(".chat-dock")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".composer-surface")).toHaveCSS("background-color", /rgb\(/);
  expect((await page.locator(".composer-surface").boundingBox())!.width).toBeLessThanOrEqual(672);
  // The switch says what the conversation does, and its state is in its text.
  const memory = page.getByRole("switch", { name: "长期记忆", exact: true });
  await expect(memory).toBeChecked();
  await expect(memory).toHaveText("长期记忆：开");
  await memory.click();
  await expect(memory).not.toBeChecked();
  await expect(memory).toHaveText("长期记忆：关");
  await expect(toasts(page)).toContainText("这个会话不再读取或写入长期记忆");
  await expect.poll(async () => (await browserApi(page, "/api/conversations/" + conversation.id)).body.data.ephemeral).toBe(true);
  await page.reload();
  await expect(memory).not.toBeChecked();
  await memory.click();
  await expect(memory).toBeChecked();
  await expect(toasts(page)).toContainText("这个会话会使用长期记忆");
  await expect.poll(async () => (await browserApi(page, "/api/conversations/" + conversation.id)).body.data.ephemeral).toBe(false);
  const records = page.locator(".run-records");
  await expect(records.getByRole("button", { name: "执行记录", exact: true })).toContainText("1");
  const composerBounds = await page.locator(".composer-surface").boundingBox();
  await expect(
    records.getByText("检查执行步骤", { exact: true }),
  ).not.toBeVisible();
  await records.getByRole("button", { name: "执行记录", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "执行记录", exact: true });
  await expect(
    drawer.getByRole("button", { name: /检查执行步骤/ }),
  ).toBeVisible();
  expect(await page.locator(".composer-surface").boundingBox()).toEqual(composerBounds);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  for (const route of ["/", "/tasks", "/knowledge"]) {
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
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(content).toHaveCSS("overflow-y", "auto");
});

test("the memory confirmation states the result and its effect, then leaves on its own", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await browserApi(page, "/api/conversations", "POST", { title: "记忆提示" });
  await page.goto(`${app.origin}/chat`);
  const memory = page.getByRole("switch", { name: "长期记忆", exact: true });
  const notice = toasts(page).locator(".toast").last();
  // Saving and reading the list again must not blink the controls around it.
  await expect(page.locator(".chat-workspace-picker")).toBeEnabled();
  await page.evaluate(() => {
    const blinked: string[] = [];
    (window as unknown as { blinked: string[] }).blinked = blinked;
    const watched = [".chat-workspace-picker", ".chat-memory-toggle", "#chat-assistant"];
    new MutationObserver(records => {
      for (const record of records) {
        const node = record.target as Element;
        const name = watched.find(selector => node.matches(selector));
        if (name && (node.hasAttribute("disabled") || node.getAttribute("data-disabled") !== null)) blinked.push(name);
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["disabled", "data-disabled"] });
  });
  await memory.click();
  await expect(notice.locator(".toast-title")).toHaveText("长期记忆已关闭");
  await expect(notice.locator(".toast-description")).toHaveText("这个会话不再读取或写入长期记忆");
  // A notice, not a control: it takes no clicks and is gone within a few seconds.
  await expect(notice).toHaveCSS("pointer-events", "none");
  await expect(toasts(page).locator(".toast")).toHaveCount(0, { timeout: 4500 });
  expect(await page.evaluate(() => (window as unknown as { blinked: string[] }).blinked)).toEqual([]);
});

test("a one-off task checks its time in its own zone and persists without a model", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/tasks`);
  // Keep the real exit animation in progress long enough to expose typing
  // before the calendar has unmounted and returned focus to its trigger.
  await page.addStyleTag({ content: '.ui-popover-content[data-state="closed"] { animation-duration: 600ms; }' });
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  const form = page.getByRole("dialog", { name: "新建任务", exact: true });
  await form.getByRole("combobox", { name: "什么时候运行", exact: true }).click();
  await page.getByRole("option", { name: "只运行一次", exact: true }).click();
  await form.getByLabel("名称", { exact: true }).fill("独立页面的一次提醒");
  await form.getByRole("button", { name: "创建", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("请写下要做什么");
  await expect(form.getByLabel("名称", { exact: true })).toHaveValue("独立页面的一次提醒");
  await form.getByLabel("要做什么", { exact: true }).fill("提醒我交季度报告。");
  await form.getByRole("button", { name: "高级", exact: true }).click();
  await form.getByLabel("时区", { exact: true }).fill("America/New_York");
  // 02:30 does not happen in New York on the day the clocks go forward.
  await chooseTaskDateTime(page, form, "日期", "2030-03-10T02:30");
  await form.getByRole("button", { name: "创建", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("在该时区存在的日期和时间");
  expect(app.readRows("SELECT id FROM scheduled_jobs")).toHaveLength(0);
  await form.getByLabel("时区", { exact: true }).fill("Asia/Shanghai");
  await chooseTaskDateTime(page, form, "日期", "2030-11-20T09:00");
  await page.setViewportSize({ width: 390, height: 780 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), "ria-workspace-ui", "tasks-create-mobile.png"), animations: "disabled" });
  await form.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByTestId("task-item").filter({ hasText: "独立页面的一次提醒" })).toBeVisible();
  const payload = await browserApi(page, "/api/tasks");
  expect(payload.body.data).toHaveLength(1);
  expect(payload.body.data[0]).toMatchObject({ nextRunAt: "2030-11-20T01:00:00.000Z", timeZone: "Asia/Shanghai", cron: null, enabled: true, kind: "prompt" });
  await app.restart(); await page.reload();
  await expect(page.getByTestId("task-item").filter({ hasText: "独立页面的一次提醒" })).toContainText("已安排");
  expect(app.providerCalls).toEqual([]);

});
