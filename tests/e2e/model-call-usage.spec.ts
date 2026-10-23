import { test as base, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});
test("model limits persist and source filters display real recorded chat calls without changing unsaved settings", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin); await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/chat`);
  await page.getByPlaceholder(/输入你的问题/).fill("Describe the local workspace");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => app.readRows("SELECT status FROM model_requests WHERE source = 'chat'").map(row => row.status)).toEqual(["success"]);
  await page.goto(`${app.origin}/models`);
  // Each limit states its range, and a value outside it is pointed out where it is typed and cannot be saved.
  const save = page.getByRole("button", { name: "保存模型偏好", exact: true });
  const compaction = page.getByLabel("每次请求压缩调用上限", { exact: true });
  await expect(page.getByText("1–16 的整数", { exact: true })).toBeVisible();
  await expect(page.getByText("0–1,000,000，留空表示不限制", { exact: true })).toHaveCount(2);
  const puts: string[] = []; page.on("request", request => { if (new URL(request.url()).pathname === "/api/models" && request.method() === "PUT") puts.push(request.url()); });
  for (const [label, value, message] of [
    ["每次请求压缩调用上限", "1001", "请输入 1–1,000 之间的整数"],
    ["最大并发调用数", "", "请输入 1–16 之间的整数"],
    ["后台每日调用次数", "1.5", "请输入 0–1,000 之间的整数"],
    ["后台单次预估上限 USD", "-1", "请输入 0–1,000,000 之间的金额，或留空表示不限制"],
    ["预算时区", "Mars/Base", "无法识别的时区，请输入 IANA 时区名称，例如 Asia/Shanghai"],
  ]) {
    const input = page.getByLabel(label, { exact: true }); const before = await input.inputValue();
    await input.fill(value);
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
    await expect(page.getByText("模型调用限制中有超出范围的值，修正后才能保存。")).toBeVisible();
    await expect(save).toBeDisabled();
    await input.fill(before); await expect(input).not.toHaveAttribute("aria-invalid", "true");
  }
  await expect(save).toBeEnabled(); expect(puts).toEqual([]);
  await compaction.fill("1000"); await expect(compaction).not.toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("后台每日调用次数").fill("3");
  await page.getByLabel("预算时区").fill("America/New_York");
  const saving = page.waitForResponse(response => new URL(response.url()).pathname === "/api/models" && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存模型偏好", exact: true }).click();
  const saved = await saving;
  expect(saved.status()).toBe(200);
  expect((await saved.json()).data.callLimits.backgroundDailyCalls).toBe(3);
  await expect(page.getByRole("button", { name: "保存模型偏好", exact: true })).toBeEnabled();
  await page.reload(); await expect(page.getByLabel("后台每日调用次数")).toHaveValue("3");
  await expect(page.getByLabel("预算时区")).toHaveValue("America/New_York");
  await page.getByLabel("后台每日调用次数").fill("2");
  // Usage is its own section; the unsaved limit waits in the models section meanwhile.
  await page.getByRole("tab", { name: "用量", exact: true }).click();
  await page.getByLabel("调用来源", { exact: true }).click(); await page.getByRole("option", { name: "历史摘要", exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.getByRole("button", { name: "查看调用明细", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "模型调用明细", exact: true });
  await expect(drawer.getByRole("listitem")).toHaveCount(0);
  await expect(drawer).toContainText("暂无模型调用记录。");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  await expect(page.getByLabel("后台每日调用次数")).toHaveValue("2");
  await page.getByRole("tab", { name: "用量", exact: true }).click();
  await page.getByLabel("调用来源", { exact: true }).click(); await page.getByRole("option", { name: "聊天", exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.getByRole("button", { name: "查看调用明细", exact: true }).click();
  await expect(drawer.getByRole("listitem")).toHaveCount(1);
  await expect(drawer).toContainText("聊天");
  await expect(drawer).toContainText("未知");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  await expect(page.getByLabel("后台每日调用次数")).toHaveValue("2");
  const directory = join(tmpdir(), "ria-model-call-qa"); await mkdir(directory, { recursive: true });
  await page.getByRole("group", { name: "模型调用限制" }).screenshot({ path: join(directory, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("group", { name: "模型调用限制" }).screenshot({ path: join(directory, "mobile.png") });
  expect(errors).toEqual([]);
});
test("offline local startup keeps tasks and stored conversations available", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.route(/https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, route => route.abort("internetdisconnected"));
  await page.goto(`${app.origin}/chat`);
  await page.getByLabel("选择工具").click();
  await page.getByRole("option", { name: "创建任务" }).click();
  await page.getByPlaceholder(/输入任务标题/).fill("Offline task");
  await page.getByRole("button", { name: "执行工具", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "选择工具", exact: true })).toContainText("自动工具");
  await expect(page.getByText(/Offline task/).first()).toBeVisible();
  await page.goto(`${app.origin}/tasks`);
  await expect(page.getByTestId("task-panel").getByText("Offline task", { exact: true })).toBeVisible();
  await app.restart(); await page.reload();
  const retained = await page.evaluate(() => fetch("/api/tasks").then(response => response.json()));
  expect(JSON.stringify(retained)).toContain("Offline task");
  expect(app.providerCalls).toHaveLength(0);
});

test("model context limits persist, fit narrow layouts, and explain oversized requests before model submission", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/models`);
  await page.getByText("上下文容量与压缩", { exact: true }).click();
  const model = page.getByRole("group", { name: "Claude Opus Offline", exact: true });
  await expect(model).toContainText("200,000");
  await model.getByLabel("上下文窗口（tokens）", { exact: true }).fill("32768");
  await model.getByLabel("每次最大输出（tokens）", { exact: true }).fill("2048");
  const saving = page.waitForResponse(response => new URL(response.url()).pathname === "/api/models" && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存模型偏好", exact: true }).click();
  expect((await saving).status()).toBe(200);
  await page.reload(); await page.getByText("上下文容量与压缩", { exact: true }).click();
  await expect(model.getByLabel("上下文窗口（tokens）", { exact: true })).toHaveValue("32768");
  await expect(model.getByLabel("每次最大输出（tokens）", { exact: true })).toHaveValue("2048");
  const directory = join(tmpdir(), "ria-context-qa"); await mkdir(directory, { recursive: true });
  await model.screenshot({ path: join(directory, "desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await model.screenshot({ path: join(directory, "mobile.png") });
  await page.goto(`${app.origin}/chat`);
  await page.getByPlaceholder(/输入你的问题/).fill("large input 0123456789 ".repeat(2500));
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect((await rejected).status()).toBe(413);
  await expect(page.getByText("当前必要上下文超过模型的输入预算。请切换更大上下文的模型，或缩小当前输入和附件。已有执行记录已保留。", { exact: true })).toBeVisible();
  expect(app.providerCalls).toHaveLength(0);
  expect(errors).toEqual([]);
});
