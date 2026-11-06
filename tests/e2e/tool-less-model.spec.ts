import { expect, test, test as base, type Page } from "@playwright/test";
import { configureOfflineModels, fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";
import { browserApi } from "../helpers/browser-api";
import { chosenWords, composerInput, slashOption } from "../helpers/slash-menu";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";

const TOOL_LESS = "vendor/no-tools", SECOND_TOOL_LESS = "vendor/no-tools-2", CAPABLE = "vendor/with-tools";
const IMAGE = "vendor/picture";

async function library(page: Page, chat = TOOL_LESS) {
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([
    fixtureLibraryItem(TOOL_LESS, ["chat"], { supportsTools: false }),
    fixtureLibraryItem(SECOND_TOOL_LESS, ["chat"], { supportsTools: false }),
    fixtureLibraryItem(CAPABLE, ["chat"]),
    fixtureLibraryItem(IMAGE, ["image"], { supportsTools: false }),
  ], { chat, image: IMAGE, video: null } as never) }));
}
const notice = (page: Page) => page.getByRole("alertdialog", { name: "当前模型的部分功能受限" });

test("a model that cannot call tools is confirmed before chatting, once for each model", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", error => consoleErrors.push(error.message));
  await library(page);
  await page.goto("/chat");
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText(TOOL_LESS);
  await expect(notice(page)).toContainText("不支持工具调用");
  await page.screenshot({ path: test.info().outputPath("notice.png") });

  await notice(page).getByRole("button", { name: "继续使用" }).click();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();

  // Coming back in the same run of the app does not ask again.
  await page.reload();
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);

  // Another model that cannot is its own decision.
  await page.getByRole("combobox", { name: "选择模型" }).click();
  await page.getByRole("option", { name: new RegExp(SECOND_TOOL_LESS) }).click();
  await expect(notice(page)).toContainText(SECOND_TOOL_LESS);
  await notice(page).getByRole("button", { name: "继续使用" }).click();
  await page.getByRole("combobox", { name: "选择模型" }).click();
  await page.getByRole("option", { name: new RegExp(CAPABLE) }).click();
  await expect(notice(page)).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("declining opens the model menu, and leaving it without a change asks again", async ({ page }) => {
  await library(page);
  await page.goto("/chat");
  await notice(page).getByRole("button", { name: "更换模型" }).click();
  await expect(notice(page)).toHaveCount(0);
  const capable = page.getByRole("option", { name: new RegExp(CAPABLE) });
  await expect(capable, "the menu stays open for the choice").toBeVisible();

  await page.keyboard.press("Escape");
  await expect(notice(page), "no model was chosen, so the question stands").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(capable, "Escape is declining too").toBeVisible();
  await capable.click();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "选择模型" })).toContainText(CAPABLE);
});

test("a capable model, a media mode and a template with no tools are not asked about", async ({ page }) => {
  await library(page, CAPABLE);
  await page.goto("/chat");
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);

  // The image model cannot call tools either, but image mode has no use for them.
  await page.unroute("**/api/models");
  await library(page);
  await page.addInitScript(() => localStorage.setItem("chat:prefs:draft", JSON.stringify({ modelMode: "image" })));
  await page.route("**/api/conversations", async route => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { data: [{ id: "bound", title: "Bound", lastMessageAt: "2026-08-30T00:00:00Z", messageCount: 0, assistantConfig: { templateId: "t", templateRevision: 1, name: "No tools", description: "", instructions: "Help.", model: null, tools: [], collections: [], usesMemory: true } }] } });
  });
  await page.route("**/api/conversations/bound**", route => route.fulfill({ json: { data: [] } }));
  await page.goto("/chat?conversationId=bound");
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);
});

const withTools = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => {
    const app = await startStandaloneServer({ modelFixture: true });
    try { await runTest(app); } finally { await app.close(); }
  },
});

withTools("with a model that cannot call tools the composer offers what still works, and says why the rest is missing", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await library(page, CAPABLE);
  await page.goto(`${app.origin}/chat`);
  const input = composerInput(page);
  await input.click();
  await page.keyboard.type("/检索");
  await page.keyboard.press("Enter");
  await expect(chosenWords(page)).toHaveText(["知识检索"]);
  await expect(page.getByRole("button", { name: /^工作区：/ })).toBeVisible();

  await page.getByRole("combobox", { name: "选择模型" }).click();
  await page.getByRole("option", { name: new RegExp(`${TOOL_LESS}(?!-)`) }).click();
  await notice(page).getByRole("button", { name: "继续使用" }).click();
  await expect(chosenWords(page), "a tool the model would have to call goes with it").toHaveCount(0);
  await expect(page.getByRole("button", { name: /^工作区：/ }), "no tool will use a folder").toHaveCount(0);

  await input.click();
  await page.keyboard.type("/");
  const list = page.getByRole("listbox", { name: "工具、技能和插件", exact: true });
  await expect(list.getByRole("status")).toContainText("当前模型不支持工具调用");
  await expect(slashOption(page, "压缩上下文"), "what needs no model call stays").toBeVisible();
  await expect(slashOption(page, "联网搜索")).toHaveCount(0);
  await page.keyboard.type("检索");
  const blocked = slashOption(page, "知识检索");
  await expect(blocked).toHaveAttribute("aria-disabled", "true");
  await expect(blocked).toContainText("当前模型不支持调用工具");
  await page.keyboard.press("Enter");
  await expect(chosenWords(page), "it cannot be chosen").toHaveCount(0);

  // A search with nothing to show still explains itself.
  await input.fill("");
  await page.keyboard.type("/不存在的工具名字");
  await expect(list.getByRole("status")).toBeVisible();
  await expect(list.getByRole("option")).toHaveCount(0);

  await input.fill("");
  await page.getByRole("combobox", { name: "选择模型" }).click();
  await page.getByRole("option", { name: new RegExp(CAPABLE) }).click();
  await expect(page.getByRole("button", { name: /^工作区：/ }), "changing back brings it all back").toBeVisible();
  await input.click();
  await page.keyboard.type("/");
  await expect(slashOption(page, "联网搜索")).toBeVisible();
  await expect(list.getByRole("status")).toHaveCount(0);
});

test("a request waiting for approval offers to change the model or give the request up, since either answer continues the turn", async ({ page }) => {
  const now = "2026-08-30T00:00:00Z";
  await library(page);
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [{ id: "pending", title: "Pending", lastMessageAt: now, messageCount: 2 }] } }));
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [
    { id: "u", clientMessageId: "u", role: "user", content: "Make a task", createdAt: now },
    { id: "a", clientMessageId: "a", role: "assistant", createdAt: now, content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({ type: "assistant-tool-message", text: "Please approve", tools: [{ toolName: "createTask", toolCallId: "call-1", state: "approval-requested", input: { title: "Task" }, approval: { id: "approval-1" } }] }) },
  ] } }));
  await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [] } }));
  let declined = 0, continued = 0;
  await page.route("**/api/conversations/pending/messages/a/decline", route => { declined++; return route.fulfill({ json: { data: { toolCallIds: ["call-1"] } } }); });
  await page.route("**/api/chat", route => { continued++; return route.abort(); });
  await page.goto("/chat");
  await notice(page).getByRole("button", { name: "继续使用" }).click();
  const region = page.getByRole("region", { name: "操作审批", exact: true });
  await expect(region).toContainText("可以更换模型后再处理，或放弃它继续对话");
  await expect(region.getByRole("button", { name: "批准", exact: true }), "approving would need the model to carry on").toHaveCount(0);

  // Changing the model is one click away, and with a capable model the usual answers return.
  await region.getByRole("button", { name: "更换模型", exact: true }).click();
  await page.getByRole("option", { name: new RegExp(CAPABLE) }).click();
  await expect(region.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  await expect(region.getByRole("button", { name: "拒绝", exact: true })).toBeEnabled();
  await expect(region).not.toContainText("放弃它继续对话");

  // Back on the model that cannot call tools, giving it up asks the model for nothing.
  await page.getByRole("combobox", { name: "选择模型" }).click();
  await page.getByRole("option", { name: new RegExp(`${TOOL_LESS}(?!-)`) }).click();
  await region.getByRole("button", { name: "放弃请求", exact: true }).click();
  await expect(region).toHaveCount(0);
  expect(declined).toBe(1);
  expect(continued, "no continuation was sent").toBe(0);
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeEnabled();
});

withTools("choosing a template that uses tools asks again, and what follows is the same as for the model", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await library(page);
  await page.goto(`${app.origin}/chat`);
  await notice(page).getByRole("button", { name: "继续使用" }).click();
  await expect(notice(page)).toHaveCount(0);

  const input = composerInput(page);
  await input.click();
  await page.keyboard.type("/资料研究");
  await page.keyboard.press("Enter");
  await expect(notice(page), "the template relies on tools the model cannot call").toBeVisible();
  await expect(notice(page)).toContainText("不支持工具调用");
  await notice(page).getByRole("button", { name: "继续使用" }).click();
  await expect(notice(page)).toHaveCount(0);

  await input.click();
  await page.keyboard.type("/");
  const list = page.getByRole("listbox", { name: "工具、技能和插件", exact: true });
  await expect(list.getByRole("status")).toContainText("当前模型不支持工具调用");
  await expect(page.getByRole("button", { name: /^工作区：/ })).toHaveCount(0);

  // The same model with the same template is not asked about again.
  await page.reload();
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);
});

withTools("giving up a request leaves the conversation free, and the next message goes to the model without tools", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page);
  expect((await browserApi(page, "/api/models/library", "POST", { action: "add", model: { providerId: "openrouter", modelId: "offline/plain-text" } })).status).toBe(200);
  const settings = (await browserApi(page, "/api/models")).body.data;
  expect(settings.library.find((item: { modelId: string }) => item.modelId === "offline/plain-text")?.supportsTools).toBe(false);
  settings.chat.model = { providerId: "openrouter", modelId: "offline/plain-text" };
  expect((await browserApi(page, "/api/models", "PUT", settings)).status).toBe(200);

  const chatId = "pending-approval";
  expect((await browserApi(page, "/api/conversations", "POST", { id: chatId, title: "Pending" })).status).toBe(201);
  expect((await browserApi(page, `/api/conversations/${chatId}/messages`, "POST", { role: "user", content: "帮我建一个任务", clientMessageId: "ask" })).status).toBe(201);
  const pending = "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({ type: "assistant-tool-message", text: "需要你确认", tools: [{ toolName: "createTask", toolCallId: "call-1", state: "approval-requested", input: { title: "周报" }, approval: { id: "approval-1" } }] });
  expect((await browserApi(page, `/api/conversations/${chatId}/messages`, "POST", { role: "assistant", content: pending, clientMessageId: "reply" })).status).toBe(201);

  await page.goto(`${app.origin}/chat?conversationId=${chatId}`);
  await notice(page).getByRole("button", { name: "继续使用" }).click();
  const region = page.getByRole("region", { name: "操作审批", exact: true });
  const calls = app.providerCalls.length;
  await region.getByRole("button", { name: "放弃请求", exact: true }).click();
  await expect(region).toHaveCount(0);
  expect(app.providerCalls.length, "giving up asks the model for nothing").toBe(calls);
  expect(app.readRows("SELECT id FROM tasks")).toHaveLength(0);
  const stored = app.readRows("SELECT content FROM messages WHERE clientMessageId='reply'")[0] as { content: string };
  expect(stored.content).toContain('"state":"output-denied"');

  await page.reload();
  await expect(page.getByPlaceholder(/输入你的问题/)).toBeVisible();
  await expect(region, "it stays given up").toHaveCount(0);
  await page.getByPlaceholder(/输入你的问题/).fill("继续聊点别的");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("article").last()).toContainText("离线回答：继续聊点别的");
  const sent = app.providerCalls.filter(call => call.stream).at(-1);
  expect(sent?.toolCount, "the model is sent no tools").toBe(0);
  expect(errors).toEqual([]);
});
