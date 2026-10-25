import { test as base, expect } from "@playwright/test";
import { startStandaloneServer } from "../helpers/standalone-server";
import { openWorkspace } from "../helpers/workspace-entry";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi } from "../helpers/browser-api";

const test = base.extend<{ app: Awaited<ReturnType<typeof startStandaloneServer>> }>({
  app: async ({}, runTest) => { const app = await startStandaloneServer({ modelFixture: true }); try { await runTest(app); } finally { await app.close(); } },
});

test("an empty list says so in one sentence and offers the one next step", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await page.goto(`${app.origin}/conversations`);
  await expect(page.getByText("还没有会话。", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "开始对话", exact: true }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await page.goto(`${app.origin}/media`);
  await expect(page.getByText(/还没有图片或视频/)).toBeVisible();
  await expect(page.getByRole("link", { name: "去聊天", exact: true })).toHaveAttribute("href", "/chat");
});

test("text cut short with an ellipsis shows in full on hover", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const title = (await browserApi(page, "/api/conversations", "POST", { title: "一个很长很长的会话标题，".repeat(8) + "结尾" })).body.data.title as string;
  await page.goto(`${app.origin}/chat`);
  const heading = page.locator(".chat-toolbar h3");
  await expect(heading).toHaveText(title);
  expect(await heading.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await heading.hover();
  // The app's own tooltip, in the app's style, describing the heading.
  const tip = page.getByRole("tooltip");
  await expect(tip).toHaveText(title);
  await expect(heading).toHaveAttribute("aria-describedby", (await tip.getAttribute("id"))!);
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);

  // A plain title gets the same tooltip, and the browser's own one is held back while it shows.
  const memory = page.getByRole("switch", { name: "长期记忆", exact: true });
  const note = await memory.getAttribute("title");
  await memory.hover();
  await expect(page.getByRole("tooltip")).toHaveText(note!);
  await expect(memory).not.toHaveAttribute("title", /.*/);
  await page.mouse.move(0, 0);
  await expect(memory).toHaveAttribute("title", note!);
});

test("a pin shows at once and is put back when the save is refused", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await browserApi(page, "/api/conversations", "POST", { title: "要置顶的会话" });
  await page.goto(`${app.origin}/conversations`);
  const row = page.getByRole("article", { name: "要置顶的会话", exact: true });
  await expect(row).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/conversations/*", async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    await held;
    await route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "暂时无法保存" } } });
  });
  await row.getByRole("button", { name: "置顶", exact: true }).click();
  // Before the server has answered, the row already reads as pinned.
  await expect(row.getByText("已置顶", { exact: true })).toBeVisible();
  release();
  await expect(page.locator("main").getByRole("alert")).toContainText("暂时无法保存");
  await expect(row.getByText("已置顶", { exact: true })).toHaveCount(0);
});

test("answers read at a comfortable line length and a streaming answer marks where words arrive", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  await page.goto(`${app.origin}/chat`);
  const composer = page.getByPlaceholder(/输入你的问题/);
  await composer.fill("行宽检查 ".repeat(30));
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const answer = page.locator(".markdown-message").filter({ hasText: "离线回答" }).last();
  await expect(answer).toBeVisible();
  await expect(answer).not.toHaveAttribute("data-streaming", /.*/);
  const paragraph = answer.locator("p").last();
  const widths = await paragraph.evaluate(node => {
    const probe = document.createElement("span"); probe.textContent = "0".repeat(68); probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
    node.appendChild(probe); const sixtyEight = probe.getBoundingClientRect().width; probe.remove();
    return { paragraph: node.getBoundingClientRect().width, sixtyEight, caret: getComputedStyle(node, "::after").content };
  });
  expect(widths.paragraph).toBeLessThanOrEqual(Math.ceil(widths.sixtyEight) + 1);
  // A finished answer has no caret; one still streaming does.
  expect(widths.caret).toBe("none");
  await answer.evaluate(node => node.setAttribute("data-streaming", "true"));
  expect(await paragraph.evaluate(node => getComputedStyle(node, "::after").content)).toBe('""');
});

test("an answer lists its sources as small cards, and a long earlier answer folds until opened", async ({ page, app }) => {
  await openWorkspace(page, app.origin);
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "来源与折叠" })).body.data;
  const results = Array.from({ length: 6 }, (_, index) => ({ title: `资料 ${index + 1}`, url: `https://example${index + 1}.com/page`, snippet: "摘要" }));
  const longText = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 段：较长的回答内容。`).join("\n\n");
  await browserApi(page, `/api/conversations/${chat.id}/messages`, "POST", { role: "user", content: "查一下资料", status: "success" });
  await browserApi(page, `/api/conversations/${chat.id}/messages`, "POST", { role: "assistant", status: "success", content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({ type: "assistant-tool-message", text: longText, tools: [{ toolName: "webSearch", toolCallId: "search", state: "output-available", input: { query: "资料" }, output: { query: "资料", results } }] }) });
  await browserApi(page, `/api/conversations/${chat.id}/messages`, "POST", { role: "user", content: "继续", status: "success" });
  await browserApi(page, `/api/conversations/${chat.id}/messages`, "POST", { role: "assistant", content: "最新的回答不折叠。", status: "success" });
  await page.goto(`${app.origin}/chat`);
  const sources = page.getByRole("navigation", { name: "使用资料" }).first();
  await expect(sources.getByRole("link")).toHaveCount(4);
  await expect(sources.getByRole("link").first()).toHaveAttribute("href", "https://example1.com/page");
  await expect(sources.getByRole("button", { name: "另外 2 个来源", exact: true })).toBeVisible();

  const toggle = page.getByRole("button", { name: "展开全文", exact: true });
  await expect(toggle).toHaveCount(1);
  const body = page.locator(".answer-fold-body").first();
  const folded = (await body.boundingBox())!.height;
  expect(folded).toBeLessThanOrEqual(450);
  await toggle.click();
  await expect(page.getByRole("button", { name: "收起", exact: true })).toHaveAttribute("aria-expanded", "true");
  expect((await body.boundingBox())!.height).toBeGreaterThan(folded + 200);
  // The latest answer is never folded.
  await expect(page.getByText("最新的回答不折叠。", { exact: true })).toBeVisible();
  expect(await page.locator(".answer-fold").count()).toBe(1);
});
