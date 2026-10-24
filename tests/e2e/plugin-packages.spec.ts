import { useLightTheme } from "../helpers/theme";
import { expect, test as base, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { startExtensionService } from "../helpers/extension-service";
import { pluginFixture } from "../helpers/plugin-fixture";
import { configureOfflineModels } from "../helpers/model-fixture";
import { browserApi, browserData } from "../helpers/browser-api";
import { acceptConfirm } from "../helpers/confirm";
import { chooseRowAction, openRowMenu } from "../helpers/row-menu";
import { toasts } from "../helpers/toast";
import { trackChatStreams, waitForChatStream } from "../helpers/chat-stream";

type App = { runtime: Awaited<ReturnType<typeof startStandaloneServer>>; service: Awaited<ReturnType<typeof startExtensionService>> };
const test = base.extend<{ app: App }>({ app: async ({}, provide) => {
  const service = await startExtensionService();
  const runtime = await startStandaloneServer({ modelFixture: true, extensionFixtureOrigin: service.origin });
  try { await provide({ runtime, service }); } finally { await runtime.close(); await service.close(); }
} });
const shots = join(tmpdir(), "ria-plugins-qa");
async function open(page: Page, app: App) {
  await page.goto(`${app.runtime.origin}/extensions`);
  await expect(page.getByRole("heading", { name: "扩展", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "导入插件", exact: true })).toBeEnabled();
}
async function send(page: Page, app: App, text: string) {
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "Plugin skill acceptance" })).body.data;
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.runtime.origin}/chat`);
  await expect(page.getByRole("heading", { name: "Plugin skill acceptance", exact: true })).toBeVisible();
  await trackChatStreams(page);
  await page.getByPlaceholder(/输入你的问题/).fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  return chat;
}
function systemText(app: App) { return app.runtime.providerCalls.filter(call => call.stream).at(-1)?.messages.filter(message => message.role === "system").map(message => JSON.stringify(message.content)).join("\n") ?? ""; }

test("marketplace installs a skill package, applies it to real chat context and preserves enablement after restart", { tag: "@integration" }, async ({ page, app }) => {
  const errors: string[] = [], logs: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); page.on("console", message => { if (message.type() === "error") logs.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 960 }); await open(page, app);
  await page.getByRole("tab", { name: "插件市场", exact: true }).click();
  const market = page.getByRole("region", { name: "RiA 插件市场", exact: true });
  await expect(market.getByRole("article")).toHaveCount(3);
  await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, "market-dark.png"), animations: "disabled" });
  await market.getByRole("article").filter({ has: page.getByRole("heading", { name: "写作与润色", exact: true }) }).getByRole("button", { name: "查看插件", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "写作与润色", exact: true });
  await expect(preview).toHaveCSS("animation-name", "sheet-in");
  await expect(preview).toContainText("无需连接服务");
  expect((await browserData(page, "/api/plugins")).items).toHaveLength(0);
  await preview.getByRole("button", { name: "安装插件", exact: true }).click();
  await expect(preview).toBeHidden(); await expect(page.getByRole("tab", { name: "我的扩展", exact: true })).toHaveAttribute("aria-selected", "true");
  const plugin = (await browserData(page, "/api/plugins")).items[0];
  expect(plugin.enabled).toBe(false);
  const card = page.getByTestId(`plugin-${plugin.id}`);
  await card.getByRole("button", { name: "启用插件", exact: true }).click(); await expect(card.getByText("已启用", { exact: true })).toBeVisible();
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = await send(page, app, "请润色：我们明天见面。");
  // A tool-capable model gets the skill index; instructions load through readPluginSkill.
  await expect.poll(() => systemText(app)).toContain("用户需要起草、改写、润色、缩写或校对文本时使用。");
  expect(systemText(app)).not.toContain("先识别文本用途");
  await expect.poll(async () => (await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.role === "assistant")).toBe(true);
  // The answer is saved before its stream closes; restarting in between would cut the open response.
  await waitForChatStream(page);
  await app.runtime.restart(); await open(page, app);
  await expect(card.getByText("已启用", { exact: true })).toBeVisible();
  await chooseRowAction(page, card, "停用插件"); await expect(card.getByText("已停用", { exact: true })).toBeVisible();
  const before = app.runtime.providerCalls.length;
  await send(page, app, "请润色：今天开始工作。");
  await expect.poll(() => app.runtime.providerCalls.length).toBeGreaterThan(before);
  expect(systemText(app)).not.toContain("用户需要起草、改写、润色、缩写或校对文本时使用。");
  expect(app.service.state.calls).toHaveLength(0); expect(app.service.state.probes).toBe(0);
  expect(errors).toEqual([]); expect(logs).toEqual([]);
});

for (const kind of ["http", "mcp-http"] as const) test(`${kind} combination packages import, configure, require approval and uninstall without deleting other connections`, { tag: "@integration" }, async ({ page, app }) => {
  await open(page, app);
  const unrelated = (await browserApi(page, "/api/extensions", "POST", { name: "Unrelated connection", config: { type: "mcp-http", url: `${app.service.origin}/mcp` } })).body.data;
  await page.getByRole("button", { name: "导入插件", exact: true }).click();
  let drawer = page.getByRole("dialog", { name: "导入插件", exact: true });
  const manifest = pluginFixture(app.service.origin, kind);
  await drawer.getByLabel("插件包文件", { exact: true }).setInputFiles({ name: "research.ria-plugin.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(manifest)) });
  await drawer.getByRole("button", { name: "预览插件", exact: true }).click();
  drawer = page.getByRole("dialog", { name: "Research bundle", exact: true });
  await expect(drawer).toContainText("Research skill"); await expect(drawer).toContainText("Authorization · 必填");
  expect((await browserData(page, "/api/plugins")).items).toHaveLength(0); expect(app.service.state.probes).toBe(0);
  await drawer.getByRole("button", { name: "安装插件", exact: true }).click(); await expect(drawer).toBeHidden();
  const plugin = (await browserData(page, "/api/plugins")).items[0], card = page.getByTestId(`plugin-${plugin.id}`);
  await expect(page.getByTestId(`extension-${plugin.connections[0].id}`)).toHaveCount(0);
  await expect(card.getByText("待配置", { exact: true })).toBeVisible(); await expect(card.getByRole("button", { name: "启用插件", exact: true })).toHaveCount(0);
  const menu = await openRowMenu(page, card); await expect(menu.getByRole("menuitem", { name: "启用插件", exact: true })).toBeDisabled(); await page.keyboard.press("Escape"); await expect(menu).toBeHidden();
  await card.getByRole("button", { name: "Research bundle", exact: true }).click();
  drawer = page.getByRole("dialog", { name: "Research bundle", exact: true });
  await drawer.getByRole("button", { name: "配置连接", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑扩展", exact: true });
  await expect(editor.getByLabel("凭据名称 1", { exact: true })).toHaveValue("Authorization");
  await editor.getByLabel("凭据值 1", { exact: true }).fill("Bearer synthetic-plugin-secret");
  await editor.getByRole("button", { name: "保存配置", exact: true }).click(); await expect(editor).toBeHidden();
  await expect(card.getByRole("button", { name: "Research bundle", exact: true })).toBeFocused();
  await card.getByRole("button", { name: "Research bundle", exact: true }).click();
  await drawer.getByRole("button", { name: "检测连接", exact: true }).click();
  const tools = page.getByRole("dialog", { name: "Package echo · 工具", exact: true });
  await tools.getByLabel(kind === "http" ? "request" : "echo", { exact: true }).check();
  await tools.getByRole("button", { name: "启用所选工具", exact: true }).click(); await expect(tools).toBeHidden();
  await card.getByRole("button", { name: "启用插件", exact: true }).click(); await expect(card.getByText("已启用", { exact: true })).toBeVisible();
  if (kind === "http") {
    app.service.state.hold = true;
    await card.getByRole("button", { name: "Research bundle", exact: true }).click();
    await drawer.getByRole("button", { name: "检测连接", exact: true }).click();
    await page.getByRole("button", { name: "取消检测", exact: true }).click();
    await expect(toasts(page).getByText("检测已取消")).toBeVisible();
    app.service.state.hold = false;
  }
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = await send(page, app, "OFFLINE_EXTENSION_TOOL");
  const approval = page.getByRole("button", { name: "批准", exact: true }); await expect(approval).toBeEnabled();
  await expect.poll(() => systemText(app)).toContain("Use for package acceptance questions."); expect(app.service.state.calls).toHaveLength(0);
  await approval.click(); await expect.poll(() => app.service.state.calls.length).toBe(1);
  expect(app.service.state.calls[0].authorization).toBe("Bearer synthetic-plugin-secret");
  await expect.poll(async () => (await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes('"state":"output-available"'))).toBe(true);
  await open(page, app);
  await chooseRowAction(page, card, "卸载"); await acceptConfirm(page);
  await expect(card).toHaveCount(0);
  expect((await browserData(page, "/api/extensions")).items.map(item => item.id)).toEqual([unrelated.id]);
  expect((await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes('"state":"output-available"'))).toBe(true);
});

test("plugin preview handles malformed input, narrow layouts, focus and reduced motion", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 }); await open(page, app);
  const trigger = page.getByRole("button", { name: "导入插件", exact: true }); await trigger.click();
  let drawer = page.getByRole("dialog", { name: "导入插件", exact: true });
  await drawer.getByLabel("插件包 JSON", { exact: true }).fill("not JSON"); await drawer.getByRole("button", { name: "预览插件", exact: true }).click();
  await expect(drawer.getByRole("alert")).toContainText("有效的 JSON");
  await drawer.getByLabel("插件包 JSON", { exact: true }).fill(JSON.stringify({ ...pluginFixture(), scripts: { install: "unsupported" } })); await drawer.getByRole("button", { name: "预览插件", exact: true }).click();
  await expect(drawer.getByRole("alert")).toBeVisible();
  await drawer.getByLabel("插件包 JSON", { exact: true }).fill(JSON.stringify(pluginFixture())); await drawer.getByRole("button", { name: "预览插件", exact: true }).click();
  drawer = page.getByRole("dialog", { name: "Research bundle", exact: true }); await expect(drawer.getByRole("button", { name: "安装插件", exact: true })).toBeEnabled();
  await expect(drawer.getByRole("button", { name: "安装插件", exact: true })).toBeInViewport();
  await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, "import-mobile.png"), animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape"); await expect(drawer).toBeHidden(); await expect(trigger).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("tab", { name: "插件市场", exact: true }).click();
  const market = page.getByRole("region", { name: "RiA 插件市场", exact: true });
  await market.getByLabel("搜索插件", { exact: true }).fill("写作"); await expect(market.getByRole("article")).toHaveCount(1);
  await market.getByRole("button", { name: "查看插件", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "写作与润色", exact: true })).toHaveCSS("animation-name", "none");
  await page.keyboard.press("Escape"); await page.setViewportSize({ width: 1440, height: 960 });
  await useLightTheme(page);
  await page.screenshot({ path: join(shots, "market-light.png"), animations: "disabled" });
  await expect(page).toHaveTitle(/RiA/); await expect(page.locator("nextjs-portal")).toHaveCount(0); expect(errors).toEqual([]);
});

test("editing or closing an import cancels its preview and stale data cannot become installable", async ({ page, app }) => {
  await open(page, app); await page.getByRole("button", { name: "导入插件", exact: true }).click();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  await page.route("**/api/plugins/preview", async route => {
    const response = await route.fetch(); entered(); await held;
    if (!route.request().failure()) await route.fulfill({ response });
  }, { times: 1 });
  try {
    const drawer = page.getByRole("dialog", { name: "导入插件", exact: true });
    await drawer.getByLabel("插件包 JSON", { exact: true }).fill(JSON.stringify(pluginFixture()));
    await drawer.getByRole("button", { name: "预览插件", exact: true }).click(); await started;
    await drawer.getByLabel("插件包 JSON", { exact: true }).fill(JSON.stringify({ ...pluginFixture(), name: "New draft" }));
    await drawer.getByRole("button", { name: "预览插件", exact: true }).click();
    const updated = page.getByRole("dialog", { name: "New draft", exact: true });
    await expect(updated.getByRole("button", { name: "安装插件", exact: true })).toBeEnabled(); release();
    await expect(page.getByRole("dialog", { name: "Research bundle", exact: true })).toHaveCount(0);
    await updated.getByRole("button", { name: "修改包内容", exact: true }).click();
    await expect(drawer.getByLabel("插件包 JSON", { exact: true })).toHaveValue(/New draft/);
    await expect(drawer.getByRole("button", { name: "安装插件", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "导入插件", exact: true }).click();
    await expect(drawer.getByLabel("插件包 JSON", { exact: true })).toHaveValue("");
    await expect(drawer.getByRole("button", { name: "安装插件", exact: true })).toHaveCount(0);
    expect((await browserData(page, "/api/plugins")).items).toHaveLength(0);
    expect(app.service.state.probes).toBe(0);
  } finally { release(); }
});
