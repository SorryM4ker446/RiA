import { expect, test as base } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi } from "../helpers/browser-api";
import { openExecutionDetails } from "../helpers/execution-records";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, provide) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await provide(app); } finally { await app.close(); }
  },
});

test("work handed to a sub-agent shows its report, what it did not run, and its own actions inside its entry", { tag: "@integration" }, async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = (await browserApi(page, `${app.origin}/api/conversations`, "POST", { title: "子代理" })).body.data;
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await page.getByPlaceholder(/输入你的问题/).fill("OFFLINE_SUBAGENT 整理差旅资料");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("离线回答：子代理已经交回报告。", { exact: true })).toBeVisible({ timeout: 30_000 });
  // Its card stays in the answer: the title, that it finished, and its report folded under it.
  const card = page.getByRole("group", { name: "子代理：整理差旅资料", exact: true });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-status", "done");
  await expect(card).toContainText("已完成");
  await expect(card).not.toContainText("后台");
  await card.locator("summary").click();
  await expect(card).toContainText("已查看差旅资料");
  await expect(card).toContainText("1 项需要你批准的操作没有执行");
  // Once the answer is in, nothing says it is still running.
  await expect(page.locator(".reply-pending")).toHaveCount(0);
  // The entry was not saved: under the default rule a sub-agent cannot ask for the approval.
  expect(app.readRows("SELECT key FROM memories WHERE key = ?", "差旅规程")).toEqual([]);

  const dialog = await openExecutionDetails(page);
  const entry = dialog.locator("details").filter({ has: page.locator("summary").filter({ hasText: "子代理：整理差旅资料" }) }).first();
  await expect(entry).toBeVisible();
  if (await entry.getAttribute("open") === null) await entry.locator(":scope > summary").click();
  await expect(entry.getByText("已查看差旅资料。保存“差旅规程”这条知识条目需要你批准，没有执行。")).toBeVisible();
  await expect(entry.getByText("需要你批准、没有执行的操作（1）")).toBeVisible();
  const actions = entry.getByRole("region", { name: "子代理的操作", exact: true });
  await expect(actions.getByText("子代理的操作（1）")).toBeVisible();
  await expect(actions.locator("details")).toHaveCount(1);
  await expect(actions.locator("summary").first()).toContainText("保存知识条目");
  expect(errors).toEqual([]);
});

test("work handed off in the background answers at once, then its report comes back, and RiA's notice reads as a line", { tag: "@integration" }, async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = (await browserApi(page, `${app.origin}/api/conversations`, "POST", { title: "后台子代理" })).body.data;
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await page.getByPlaceholder(/输入你的问题/).fill("OFFLINE_SUBAGENT_BG 整理差旅资料");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const card = page.getByRole("group", { name: "子代理：整理差旅资料", exact: true });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("后台");
  // The report reaches the model by itself: in the same turn if it was still going, or in a turn woken for it.
  await expect(page.getByText("离线回答：后台子代理的报告到了。", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveAttribute("data-status", "done");
  const records = app.readRows("SELECT status, delivered, background FROM subagent_runs WHERE chatId = ?", chat.id) as Array<{ status: string; delivered: number; background: number }>;
  expect(records).toEqual([{ status: "done", delivered: 1, background: 1 }]);
  expect(errors).toEqual([]);
});

test("a notice RiA wrote itself shows as a line between the turns, not as the user's message", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  const chat = (await browserApi(page, `${app.origin}/api/conversations`, "POST", { title: "通知行" })).body.data;
  const { DatabaseSync } = await import("node:sqlite");
  const file = (app.readRows("PRAGMA database_list") as Array<{ file: string }>)[0].file;
  const writer = new DatabaseSync(file);
  try {
    writer.exec("PRAGMA busy_timeout=5000");
    const content = `__USER_MESSAGE__:${JSON.stringify({ type: "user-message", text: "[Automatic notice from RiA, not a message from the user] …", files: [], notice: { kind: "subagents", titles: ["整理差旅资料", "查日志"] } })}`;
    writer.prepare("INSERT INTO messages (id, chatId, role, content, status, createdAt) VALUES (?, ?, 'user', ?, 'success', ?)").run("notice-message", chat.id, content, Date.now());
  } finally { writer.close(); }
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  const line = page.getByRole("note");
  await expect(line).toHaveText("子代理「整理差旅资料」、「查日志」已结束，RiA 继续处理");
  await expect(page.locator(".chat-user-bubble")).toHaveCount(0);
  await expect(page.getByText("Automatic notice from RiA")).toHaveCount(0);
});
