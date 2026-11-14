import { test as base, expect } from "@playwright/test";
import { chatTitle, chooseTemplate } from "../helpers/chat-header";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserData } from "../helpers/browser-api";

// Each test starts from an empty installation: no conversation exists yet.
const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});

test("before the first conversation a template can be chosen, and the first message leaves the composer", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/chat`);
  expect(await browserData(page, "/api/conversations")).toHaveLength(0);
  // Choosing a template starts the conversation it applies to.
  await chooseTemplate(page, "写作助理");
  await expect(chatTitle(page)).toHaveText("写作助理");
  await expect.poll(async () => (await browserData(page, "/api/conversations")).map((chat: { assistantConfig?: { templateId?: string } }) => chat.assistantConfig?.templateId)).toEqual(["builtin_writing"]);
  const composer = page.getByPlaceholder(/输入你的问题/);
  await composer.fill("第一条消息");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect(page.getByText("离线回答：第一条消息", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("");
  expect(await browserData(page, "/api/conversations")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("the first message on an empty installation creates its conversation without coming back into the composer", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/chat`);
  expect(await browserData(page, "/api/conversations")).toHaveLength(0);
  const composer = page.getByPlaceholder(/输入你的问题/);
  await composer.fill("没有模板的第一条消息");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  // Watched from the click on, so a single render that puts the text back is caught.
  const restored = await composer.evaluate(node => new Promise<boolean>(resolve => {
    const area = node as HTMLTextAreaElement;
    const deadline = Date.now() + 3000;
    const check = () => { if (area.value) resolve(true); else if (Date.now() > deadline) resolve(false); else requestAnimationFrame(check); };
    check();
  }));
  expect(restored).toBe(false);
  await expect(page.getByText("离线回答：没有模板的第一条消息", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("");
  expect(await browserData(page, "/api/conversations")).toHaveLength(1);
  await page.reload();
  await expect(page.getByText("离线回答：没有模板的第一条消息", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("");
});

test("text written before any conversation exists survives a reload and moves into the first conversation", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/chat`);
  expect(await browserData(page, "/api/conversations")).toHaveLength(0);
  const composer = page.getByPlaceholder(/输入你的问题/);
  await composer.fill("还没有会话时写下的草稿");
  await page.reload();
  await expect(composer).toHaveValue("还没有会话时写下的草稿");
  // Choosing a template creates the first conversation; the draft goes with it.
  await chooseTemplate(page, "写作助理");
  await expect.poll(async () => (await browserData(page, "/api/conversations")).length).toBe(1);
  await expect(composer).toHaveValue("还没有会话时写下的草稿");
  const [conversation] = await browserData(page, "/api/conversations");
  expect(await page.evaluate(() => localStorage.getItem("ria.chat.draft.:new"))).toBeNull();
  expect(JSON.parse((await page.evaluate(id => localStorage.getItem(`ria.chat.draft.${id}`), conversation.id))!).text).toBe("还没有会话时写下的草稿");
  await page.reload();
  await expect(composer).toHaveValue("还没有会话时写下的草稿");
});

test("the message just sent arrives with motion, and history that is loaded appears at once", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/chat`);
  // Note every message row that is marked as arriving while the turn is live.
  await page.evaluate(() => {
    const seen = new Set<string>();
    (window as unknown as { arriving: Set<string> }).arriving = seen;
    new MutationObserver(() => document.querySelectorAll<HTMLElement>("[data-arriving]").forEach(node => seen.add(`${node.dataset.messageRole}`)))
      .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-arriving"] });
  });
  const composer = page.getByPlaceholder(/输入你的问题/);
  await composer.fill("动起来的问题");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("离线回答：动起来的问题", { exact: true })).toBeVisible();
  expect([...await page.evaluate(() => [...(window as unknown as { arriving: Set<string> }).arriving])].sort()).toEqual(["user"]);
  // Once the turn ends nothing is still marked, and a reload shows the history without motion.
  await expect(page.locator("[data-arriving]")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("离线回答：动起来的问题", { exact: true })).toBeVisible();
  await expect(page.locator("[data-arriving]")).toHaveCount(0);
});
