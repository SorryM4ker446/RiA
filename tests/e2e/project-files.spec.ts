import { expect, test as base, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { openExecutionDetails } from "../helpers/execution-records";
import { trackChatStreams, waitForChatStream } from "../helpers/chat-stream";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";
import { decodePersistedAssistantToolMessage } from "../../src/lib/ai/ui-message";

type App = Awaited<ReturnType<typeof startStandaloneServer>> & { folder: string };
const test = base.extend<{ app: App }>({ app: async ({}, provide) => {
  const runtime = await startStandaloneServer({ modelFixture: true });
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "ria-project-edit-browser-")));
  try { await provide({ ...runtime, folder }); } finally {
    await runtime.close();
    if (dirname(folder) !== realpathSync.native(tmpdir()) || !basename(folder).startsWith("ria-project-edit-browser-")) throw new Error("Unexpected test directory");
    rmSync(folder, { recursive: true, force: true });
  }
} });

async function propose(page: Page, app: App) {
  writeFileSync(join(app.folder, "README.md"), "# 旧标题\n\n正文保持不变。\n");
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const grant = (await browserApi(page, "/api/directory-grants", "POST", { path: app.folder })).body.data;
  expect((await browserApi(page, `/api/directory-grants/${grant.id}`, "PATCH", { terminalEnabled: true, terminalApprovalMode: "approval", revision: grant.updatedAt })).status).toBe(200);
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "文件编辑" })).body.data;
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.origin}/chat?conversationId=${chat.id}`);
  await page.getByPlaceholder(/输入你的问题/).fill(`OFFLINE_PROJECT_EDIT GRANT_ID=${grant.id}`);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const card = page.getByRole("region", { name: "操作审批", exact: true });
  await expect(card.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  await expect(card.getByText("编辑项目文件", { exact: true })).toBeVisible();
  await expect(card.getByText("文件：README.md （+1 −1）", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "查看详情", exact: true }).click();
  const diff = page.getByLabel("待批准的文件修改", { exact: true });
  await expect(diff.locator('[data-diff-line="removed"]')).toHaveText("-# 旧标题");
  await expect(diff.locator('[data-diff-line="added"]')).toHaveText("+# 新标题");
  await expect(diff.locator('[data-diff-line="context"]').first()).toHaveText(" ");
  expect(readFileSync(join(app.folder, "README.md"), "utf8")).toBe("# 旧标题\n\n正文保持不变。\n");
  // Tracks the approval continuation this page is about to send.
  await trackChatStreams(page);
  return { chat, card };
}

async function storedEdits(page: Page, chatId: string) {
  const rows = await browserData(page, `/api/conversations/${chatId}/messages`);
  return rows.filter(row => row.role === "assistant")
    .flatMap(row => decodePersistedAssistantToolMessage(row.content)?.tools ?? [])
    .filter(tool => tool.toolName === "editProjectFile");
}

test("an exact edit shows its diff for approval, writes once when approved and is summarized under the reply", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 960 });
  const { chat, card } = await propose(page, app);
  await page.screenshot({ path: join(tmpdir(), "ria-edit-approval-desktop.png"), animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(tmpdir(), "ria-edit-approval-mobile.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 960 });

  const continuation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST");
  await card.getByRole("button", { name: "批准", exact: true }).click();
  expect((await continuation).status()).toBe(200);
  await waitForChatStream(page);
  await expect(card).toBeHidden();
  await expect.poll(() => readFileSync(join(app.folder, "README.md"), "utf8")).toBe("# 新标题\n\n正文保持不变。\n");
  await expect.poll(async () => (await storedEdits(page, chat.id)).map(tool => tool.state)).toEqual(["output-available"]);
  await expect(page.getByRole("button", { name: /README\.md/ }).first()).toBeVisible();

  await page.reload();
  await openExecutionDetails(page);
  const record = page.getByRole("dialog", { name: "执行记录", exact: true });
  await record.getByText(/编辑项目文件/).first().click();
  await expect(record.locator('[data-diff-line="added"]').first()).toHaveText("+# 新标题");
  expect(readFileSync(join(app.folder, "README.md"), "utf8")).toBe("# 新标题\n\n正文保持不变。\n");
  expect(errors).toEqual([]);
});

test("rejecting an edit leaves the file untouched", async ({ page, app }) => {
  const { chat, card } = await propose(page, app);
  const continuation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST");
  await card.getByRole("button", { name: "拒绝", exact: true }).click();
  expect((await continuation).status()).toBe(200);
  await waitForChatStream(page);
  await expect(card).toBeHidden();
  await expect.poll(async () => (await storedEdits(page, chat.id)).map(tool => tool.state)).not.toContain("output-available");
  expect(readFileSync(join(app.folder, "README.md"), "utf8")).toBe("# 旧标题\n\n正文保持不变。\n");
});
