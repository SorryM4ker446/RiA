import { expect, test as base, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStandaloneServer } from "../helpers/standalone-server";
import { startExtensionService } from "../helpers/extension-service";
import { browserApi, browserData } from "../helpers/browser-api";
import { configureOfflineModels } from "../helpers/model-fixture";
import { trackChatStreams, waitForChatStream, isContinuationHeld, releaseContinuation } from "../helpers/chat-stream";

type App = { runtime: Awaited<ReturnType<typeof startStandaloneServer>>; service: Awaited<ReturnType<typeof startExtensionService>> };
const test = base.extend<{ app: App }>({ app: async ({}, provide) => {
  const service = await startExtensionService();
  const runtime = await startStandaloneServer({ modelFixture: true, extensionFixtureOrigin: service.origin });
  try { await provide({ runtime, service }); } finally { await runtime.close(); await service.close(); }
} });
const shots = join(tmpdir(), "ria-registry-qa");
async function discover(page: Page, app: App) {
  await page.goto(`${app.runtime.origin}/extensions`);
  await expect(page.getByRole("heading", { name: "扩展", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "发现扩展", exact: true }).click();
  await expect(page.getByRole("region", { name: "发现扩展", exact: true }).getByRole("article").first()).toBeVisible();
}
async function search(page: Page, value: string) {
  await page.getByRole("textbox", { name: "搜索 MCP 扩展", exact: true }).fill(value);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
}

test("official metadata discovery adds a disabled MCP connection and uses the existing approval pipeline", { tag: "@integration" }, async ({ page, app }) => {
  const errors: string[] = [], consoles: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoles.push(message.text()); });
  let registryReads = 0;
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/extensions/registry")) registryReads++; });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${app.runtime.origin}/extensions`);
  await expect(page.getByRole("button", { name: "添加扩展", exact: true }).first()).toBeEnabled();
  expect(registryReads).toBe(0);
  await page.getByRole("tab", { name: "发现扩展", exact: true }).click();
  const region = page.getByRole("region", { name: "发现扩展", exact: true });
  await expect(region.getByRole("article")).toHaveCount(20);
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, "discover-desktop.png"), animations: "disabled" });
  const results = page.getByRole("region", { name: "扩展目录结果", exact: true });
  expect(await results.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  const initialHeight = await results.evaluate(node => node.getBoundingClientRect().height);
  await results.evaluate(node => node.scrollTo({ top: node.scrollHeight, behavior: "instant" }));
  await expect(region.getByRole("article")).toHaveCount(22);
  await expect(results.getByText("已展示全部匹配扩展", { exact: true })).toBeVisible();
  expect(await results.evaluate(node => node.getBoundingClientRect().height)).toBe(initialHeight);
  await search(page, "echo"); await expect(region.getByRole("article")).toHaveCount(1);
  await expect.poll(() => results.evaluate(node => node.scrollTop)).toBe(0);
  const detailsTrigger = page.getByRole("button", { name: "查看详情 Echo MCP", exact: true });
  await detailsTrigger.click();
  const details = page.getByRole("dialog", { name: "Echo MCP", exact: true });
  await expect(details.getByRole("button", { name: "添加连接", exact: true })).toBeEnabled();
  await expect(details).toHaveCSS("animation-name", "sheet-in");
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, "details-desktop.png"), animations: "disabled" });
  expect(app.service.state.probes).toBe(0); expect(app.service.state.calls).toHaveLength(0);
  await details.getByRole("button", { name: "添加连接", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "添加扩展", exact: true });
  await expect(editor.getByLabel("扩展名称", { exact: true })).toHaveValue("Echo MCP");
  await expect(editor.getByLabel("接口地址", { exact: true })).toHaveValue(`${app.service.origin}/mcp`);
  await expect(editor.getByLabel("凭据名称 1", { exact: true })).toHaveValue("Authorization");
  await expect(editor.getByLabel("凭据值 1", { exact: true })).toHaveValue("");
  await expect(editor.getByLabel("扩展名称", { exact: true })).toBeFocused();
  // Native required validation must prevent a credential-less save.
  await editor.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(editor.getByLabel("凭据值 1", { exact: true })).toBeFocused();
  expect((await browserData(page, "/api/extensions")).items).toHaveLength(0);
  await editor.getByLabel("凭据值 1", { exact: true }).fill("Bearer synthetic-registry-token");
  await editor.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(editor).toBeHidden(); await expect(page.getByRole("tab", { name: "我的扩展", exact: true })).toHaveAttribute("aria-selected", "true");
  const row = (await browserData(page, "/api/extensions")).items[0];
  expect(row.enabled).toBe(false); expect(row.tested).toBe(false); expect(row.hasCredentials).toBe(true);
  expect(app.service.state.probes).toBe(0); expect(app.service.state.calls).toHaveLength(0);
  const card = page.getByTestId(`extension-${row.id}`);
  await card.getByRole("button", { name: "检测连接", exact: true }).click();
  const tools = page.getByRole("dialog", { name: "Echo MCP · 工具", exact: true });
  await tools.getByLabel("echo", { exact: true }).check(); await tools.getByRole("button", { name: "启用所选工具", exact: true }).click();
  await expect(card.getByText("已启用", { exact: true })).toBeVisible();
  await configureOfflineModels(page, { chat: "anthropic/claude-opus-4.6" });
  const chat = (await browserApi(page, "/api/conversations", "POST", { title: "Registry 工具调用验证" })).body.data;
  await page.evaluate(id => localStorage.setItem("chat:last-active-id", id), chat.id);
  await page.goto(`${app.runtime.origin}/chat`);
  await trackChatStreams(page, true);
  await page.getByPlaceholder(/输入你的问题/).fill("OFFLINE_EXTENSION_TOOL"); await page.getByRole("button", { name: "发送", exact: true }).click();
  const approve = page.getByRole("button", { name: "批准", exact: true }); await expect(approve).toBeEnabled();
  expect(app.service.state.calls).toHaveLength(0);
  await approve.click(); await expect.poll(() => app.service.state.calls.length).toBe(1);
  expect(app.service.state.calls[0].authorization).toBe("Bearer synthetic-registry-token");
  await expect.poll(async () => (await browserData(page, `/api/conversations/${chat.id}/messages`)).some(message => message.content.includes('"state":"output-available"'))).toBe(true);
  // Persistence precedes the end of the continuation. Restart only after the
  // client has consumed it, otherwise the test itself resets an active request.
  await expect.poll(() => isContinuationHeld(page)).toBe(true);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toHaveCount(0);
  await releaseContinuation(page);
  await waitForChatStream(page);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await page.goto("about:blank");
  await app.runtime.restart(); await page.goto(`${app.runtime.origin}/extensions`);
  await expect(page.getByTestId(`extension-${row.id}`)).toContainText("已启用");
  expect(errors).toEqual([]); expect(consoles).toEqual([]);
});

test("discovery shows empty/error states, retries explicitly and leaves manual configuration available", async ({ page, app }) => {
  await discover(page, app);
  await search(page, "no-matching-entry"); await expect(page.getByText("没有找到匹配的扩展", { exact: true })).toBeVisible();
  await search(page, "unavailable"); await expect(page.getByRole("alert").filter({ hasText: "目录未更新" })).toContainText("官方目录暂时不可用");
  await page.route("**/api/extensions/registry?*", route => route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Synthetic one-shot failure" } } }), { times: 1 });
  await search(page, "echo"); await expect(page.getByRole("alert").filter({ hasText: "目录未更新" })).toContainText("Synthetic one-shot failure");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看详情 Echo MCP", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加扩展", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "添加扩展", exact: true });
  await expect(editor.getByLabel("扩展名称", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: "添加扩展", exact: true })).toBeFocused();
  expect((await browserData(page, "/api/extensions")).items).toHaveLength(0);
  expect(app.service.state.probes).toBe(0); expect(app.service.state.calls).toHaveLength(0);
});

test("directory scrolling loads one page at a time, preserves rows on failure and resets for a new search", async ({ page, app }) => {
  let reads = 0, pageReads = 0;
  let release!: () => void, began!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  await page.route("**/api/extensions/registry?*", async route => {
    reads++;
    if (!new URL(route.request().url()).searchParams.has("cursor")) { await route.continue(); return; }
    pageReads++;
    if (pageReads === 1) {
      began(); await held;
      if (!route.request().failure()) await route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE", message: "Synthetic paging failure" } } });
    } else await route.continue();
  });
  try {
    await discover(page, app);
    const results = page.getByRole("region", { name: "扩展目录结果", exact: true });
    await expect(results.getByRole("article")).toHaveCount(20);
    expect(reads).toBe(1);
    await results.focus(); await page.keyboard.press("ArrowDown");
    await expect.poll(() => results.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect(reads).toBe(1);
    await results.evaluate(node => node.scrollTo({ top: node.scrollHeight, behavior: "instant" })); await started;
    await expect(results.getByRole("status")).toContainText("正在加载更多");
    const scrollPosition = await results.evaluate(node => node.scrollTop);
    await results.evaluate(node => { node.scrollTop -= 10; node.dispatchEvent(new Event("scroll")); node.scrollTop += 10; node.dispatchEvent(new Event("scroll")); });
    expect(pageReads).toBe(1);
    release();
    await expect(page.getByRole("alert").filter({ hasText: "目录未更新" })).toContainText("Synthetic paging failure");
    await expect(results.getByRole("article")).toHaveCount(20);
    await expect(results.getByText("已展示全部匹配扩展", { exact: true })).toHaveCount(0);
    await results.evaluate(node => { node.scrollTop -= 10; node.dispatchEvent(new Event("scroll")); node.scrollTop += 10; node.dispatchEvent(new Event("scroll")); });
    expect(pageReads).toBe(1);
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(results.getByRole("article")).toHaveCount(22);
    expect(pageReads).toBe(2);
    expect(await results.evaluate(node => node.scrollTop)).toBeCloseTo(scrollPosition, 0);
    await expect(results.getByText("已展示全部匹配扩展", { exact: true })).toBeVisible();
    await search(page, "echo");
    await expect(results.getByRole("article")).toHaveCount(1);
    await expect.poll(() => results.evaluate(node => node.scrollTop)).toBe(0);
    await expect(results.getByRole("button", { name: "查看详情 Echo MCP", exact: true })).toBeVisible();
    expect(app.service.state.probes).toBe(0); expect(app.service.state.calls).toHaveLength(0);
  } finally { release(); }
});

test("local, legacy and variable-address entries explain compatibility without installing or connecting", async ({ page, app }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 }); await discover(page, app);
  for (const [title, text] of [["Local document service", "本地安装包"], ["Legacy SSE service", "当前仅支持 Streamable HTTP"], ["Tenant address service", "接口地址包含变量"]]) {
    const trigger = page.getByRole("button", { name: `查看详情 ${title}`, exact: true }); await trigger.click();
    const drawer = page.getByRole("dialog", { name: title, exact: true }); await expect(drawer).toContainText(text);
    if (title === "Local document service") await expect(drawer.getByRole("button", { name: "添加连接", exact: true })).toHaveCount(0);
    else await expect(drawer.getByRole("button", { name: "添加连接", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Escape"); await expect(drawer).toBeHidden(); await expect(trigger).toBeFocused();
  }
  await mkdir(shots, { recursive: true });
  await page.getByRole("region", { name: "扩展目录结果", exact: true }).evaluate(node => node.scrollTo({ top: 0, behavior: "instant" }));
  await page.locator(".workspace-content").evaluate(node => node.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: join(shots, "discover-mobile.png"), animations: "disabled" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("region", { name: "扩展目录结果", exact: true }).getByRole("article").first()).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "查看详情 Echo MCP", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Echo MCP", exact: true })).toHaveCSS("animation-name", "none");
  await page.keyboard.press("Escape"); await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "切换主题", exact: true }).click(); await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.locator(".workspace-content").evaluate(node => node.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: join(shots, "discover-light.png"), animations: "disabled" });
  await expect(page).toHaveTitle(/RiA/); await expect(page.locator("nextjs-portal")).toHaveCount(0);
  expect(errors).toEqual([]); expect(app.service.state.calls).toHaveLength(0); expect(app.service.state.probes).toBe(0);
});

test("a late search response cannot replace a newer query and closing details returns focus", async ({ page, app }) => {
  await discover(page, app);
  let release!: () => void, began!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { began = resolve; });
  await page.route("**/api/extensions/registry?*", async route => {
    if (new URL(route.request().url()).searchParams.get("search") !== "slow") { await route.continue(); return; }
    began(); await held;
    if (!route.request().failure()) await route.fulfill({ json: { data: { items: [], nextCursor: null, skipped: 0, fetchedAt: new Date().toISOString() } } });
  });
  await search(page, "slow"); await started;
  await expect(page.getByRole("textbox", { name: "搜索 MCP 扩展", exact: true })).toBeEnabled();
  await search(page, "echo"); await expect(page.getByRole("button", { name: "查看详情 Echo MCP", exact: true })).toBeVisible(); release();
  const trigger = page.getByRole("button", { name: "查看详情 Echo MCP", exact: true }); await trigger.click();
  const drawer = page.getByRole("dialog", { name: "Echo MCP", exact: true });
  await expect(drawer.getByRole("button", { name: "添加连接", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await expect(page.getByRole("region", { name: "发现扩展", exact: true }).getByRole("article")).toHaveCount(1);
  expect((await browserData(page, "/api/extensions")).items).toHaveLength(0);
});

test("closing pending details cannot publish another server's connection and failed details retry explicitly", async ({ page, app }) => {
  await discover(page, app);
  let release!: () => void, began!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { began = resolve; });
  await page.route("**/api/extensions/registry/detail?*", async route => {
    const name = new URL(route.request().url()).searchParams.get("name");
    if (!name?.endsWith("/echo")) { await route.continue(); return; }
    const response = await route.fetch(); began(); await held;
    if (!route.request().failure()) await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole("button", { name: "查看详情 Echo MCP", exact: true }).click(); await started;
  await expect(page.getByRole("dialog", { name: "Echo MCP", exact: true }).getByRole("button", { name: "添加连接", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "查看详情 Local document service", exact: true }).click();
  const local = page.getByRole("dialog", { name: "Local document service", exact: true });
  await expect(local).toContainText("@ria-fixture/local-mcp"); release();
  await expect(local.getByRole("button", { name: "添加连接", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.route("**/api/extensions/registry/detail?*", route => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "目录条目已移除" } } }), { times: 1 });
  await page.getByRole("button", { name: "查看详情 Echo MCP", exact: true }).click();
  const echo = page.getByRole("dialog", { name: "Echo MCP", exact: true });
  await expect(echo.getByRole("alert")).toContainText("目录条目已移除");
  await expect(echo.getByRole("button", { name: "添加连接", exact: true })).toHaveCount(0);
  await echo.getByRole("button", { name: "重试详情", exact: true }).click();
  await expect(echo.getByRole("button", { name: "添加连接", exact: true })).toBeEnabled();
  expect((await browserData(page, "/api/extensions")).items).toHaveLength(0);
  expect(app.service.state.probes).toBe(0);
});

test("required registry credentials cannot be saved when local encryption is unavailable", async ({ page, app }) => {
  await page.route("**/api/extensions", async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    const response = await route.fetch(); const payload = await response.json();
    await route.fulfill({ json: { data: { ...payload.data, encryptionAvailable: false } } });
  });
  await discover(page, app);
  await page.getByRole("button", { name: "查看详情 Echo MCP", exact: true }).click();
  await page.getByRole("dialog", { name: "Echo MCP", exact: true }).getByRole("button", { name: "添加连接", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "添加扩展", exact: true });
  await expect(editor.getByLabel("凭据值 1", { exact: true })).toBeDisabled();
  await expect(editor.getByRole("button", { name: "保存配置", exact: true })).toBeDisabled();
  await expect(editor).toContainText("凭据加密不可用");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看详情 Echo MCP", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "添加扩展", exact: true }).click();
  await expect(editor.getByLabel("扩展名称", { exact: true })).toHaveValue("");
  await expect(editor.getByLabel("凭据名称 1", { exact: true })).toHaveValue("");
  await expect(editor.getByRole("button", { name: "保存配置", exact: true })).toBeEnabled();
  expect((await browserData(page, "/api/extensions")).items).toHaveLength(0);
});
