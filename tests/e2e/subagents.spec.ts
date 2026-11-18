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
