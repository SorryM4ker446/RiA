import { expect, test, type Page } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";
import { openExecutionDetails } from "../helpers/execution-records";

type HistoryMessage = { id: string; clientMessageId: string; role: "user" | "assistant"; content: string; createdAt: string };
const now = "2026-08-30T00:00:00Z";
const userMessage: HistoryMessage = { id: "row-u", clientMessageId: "user-1", role: "user", content: "Original question", createdAt: now };
const assistantMessage: HistoryMessage = { id: "row-a", clientMessageId: "assistant-1", role: "assistant", content: "Original answer", createdAt: now };
const pendingMessage: HistoryMessage = { id: "row-p", clientMessageId: "pending-1", role: "assistant", createdAt: now, content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({
  type: "assistant-tool-message", text: "Please approve this task",
  tools: [{ toolName: "createTask", toolCallId: "call-1", state: "approval-requested", input: { title: "Task" }, approval: { id: "approval-1" } }],
}) };

// These browser tests isolate UI interactions; server/SQLite behavior is tested by test:server.
async function mockHistory(page: Page, history: HistoryMessage[]) {
  await page.route("**/api/models", (route) => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" }) }));
  await page.route("**/api/conversations", (route) => route.fulfill({ json: { data: [{ id: "chat-actions", title: "Actions", lastMessageAt: now, messageCount: history.length }] } }));
  await page.route("**/api/conversations/*/messages", (route) => route.fulfill({ json: { data: history } }));
  await page.route("**/api/conversations/*/runs?*", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));
}

function streamBody(chunks: object[]) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

for (const width of [1440, 390]) {
  test(`file permissions stay in place when execution activity appears at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockHistory(page, [userMessage, assistantMessage]);
    let releaseRuns!: () => void;
    const ready = new Promise<void>(resolve => { releaseRuns = resolve; });
    await page.route("**/api/conversations/*/runs?*", async route => {
      await ready;
      await route.fulfill({ json: { data: [{ id: "running-layout", goal: "Original question", status: "running", startedAt: now, steps: [], budget: { maxSteps: 8, maxFailures: 2, deadlineMs: 120000 } }] } });
    });
    await page.goto("/chat");
    const permissions = page.getByRole("button", { name: "文件权限", exact: true });
    const records = page.getByRole("button", { name: "执行记录", exact: true });
    await expect(permissions).toBeVisible();
    await expect(records).not.toContainText("执行中");
    const before = (await permissions.boundingBox())!;
    const recordBefore = (await records.boundingBox())!;
    try {
      expect(before.x + before.width).toBeLessThanOrEqual(recordBefore.x);
    } finally {
      releaseRuns();
    }
    await expect(records).toContainText("执行中");
    const after = (await permissions.boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.y).toBeCloseTo(before.y, 1);
    await expect(page.getByRole("dialog", { name: "执行记录", exact: true })).toBeHidden();
  });
}

for (const theme of ["dark", "light"] as const) {
test(`compact terminal approval expands above the permission toolbar in ${theme} theme`, async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: theme === "dark" ? "no-preference" : "reduce" });
  await page.setViewportSize({ width: 1440, height: 960 });
  const command = "@'\n<!doctype html>\n<html lang=\"zh-CN\">\n  <title>RiA · 项目介绍</title>\n  <h1>你好，我是 RiA</h1>\n</html>\n'@ | Set-Content -LiteralPath .\\index.html -Encoding UTF8";
  await mockHistory(page, [
    { ...userMessage, content: "在授权目录里创建一个简单的 HTML 页面，介绍一下 RiA。" },
    { ...pendingMessage, content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({
      type: "assistant-tool-message", text: "我会在项目目录中创建 index.html。请确认下方命令后执行。",
      tools: [{ toolName: "runTerminalCommand", toolCallId: "reference-command", state: "approval-requested", input: { grantId: "reference-folder", command, timeoutMs: 120000, binding: { cwd: "D:\\Projects\\ria-demo" } }, approval: { id: "reference-approval" } }],
    }) },
  ]);
  await page.goto("/chat");
  if (theme === "light") await page.getByRole("button", { name: "切换主题", exact: true }).click();
  const card = page.getByRole("region", { name: "操作审批", exact: true });
  await expect(card).toBeVisible();
  await expect(card).toContainText("D:\\Projects\\ria-demo");
  const code = card.locator("pre");
  await expect(code).toBeHidden();
  const collapsed = (await card.boundingBox())!;
  expect(collapsed.height).toBeLessThanOrEqual(100);
  const permissions = (await page.getByRole("button", { name: "文件权限", exact: true }).boundingBox())!;
  expect(collapsed.y + collapsed.height).toBeLessThanOrEqual(permissions.y);
  await expect(card.getByRole("button", { name: "批准", exact: true })).toBeEnabled();
  await expect(page.getByRole("dialog", { name: "执行记录", exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath(`approval-compact-${theme}-desktop.png`) });
  await card.screenshot({ path: testInfo.outputPath(`approval-compact-${theme}-card.png`) });
  const toggle = card.getByRole("button", { name: "查看详情", exact: true });
  const opening = await toggle.evaluate(async button => {
    const panel = document.getElementById(button.getAttribute("aria-controls")!)!;
    (button as HTMLButtonElement).click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { height: panel.getBoundingClientRect().height, duration: getComputedStyle(panel).transitionDuration, animations: panel.getAnimations().length };
  });
  const details = card.locator(".approval-details");
  await expect(details).toHaveCSS("opacity", "1");
  await expect(code).toBeVisible();
  await expect(code).toHaveText(command);
  if (theme === "dark") {
    expect(opening.animations).toBeGreaterThan(0);
    expect(opening.height).toBeGreaterThan(0);
    expect(opening.height).toBeLessThan((await details.boundingBox())!.height);
  } else {
    expect(opening.duration).toBe("0s");
    await expect(card).toHaveCSS("animation-name", "none");
  }
  await expect(card.getByRole("button", { name: "收起详情", exact: true })).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: testInfo.outputPath(`approval-expanded-${theme}-desktop.png`) });
  await card.getByRole("button", { name: "收起详情", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveCSS("visibility", "hidden");
  await expect(code).toBeHidden();
  expect((await card.boundingBox())!.height).toBeCloseTo(collapsed.height, 1);
  await expect(card.getByRole("button", { name: "查看详情", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card.getByRole("button", { name: "批准", exact: true })).toBeInViewport();
  await expect(card.getByRole("button", { name: "拒绝", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath(`approval-compact-${theme}-mobile.png`) });
  await card.getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(details).toHaveCSS("opacity", "1");
  await expect(card.getByRole("button", { name: "批准", exact: true })).toBeInViewport();
  await expect(card.getByRole("button", { name: "拒绝", exact: true })).toBeInViewport();
  await expect(page.getByRole("dialog", { name: "执行记录", exact: true })).toBeHidden();
});
}

test("an unavailable search is shown as skipped in execution details and leaves chat prose free of diagnostics", async ({ page }) => {
  await mockHistory(page, [userMessage, {
    ...assistantMessage,
    content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({ type: "assistant-tool-message", text: "Search could not be completed.", tools: [{ toolName: "webSearch", toolCallId: "skipped-search", state: "output-available", input: { query: "latest release" }, output: { query: "latest release", results: [], skipped: "temporarilyUnavailable" } }] }),
  }]);
  await page.goto("/chat");
  await expect(page.locator("article").last()).not.toContainText("工具详情");
  const details = await openExecutionDetails(page);
  await expect(details.getByText("工具详情：webSearch · 已跳过", { exact: true })).toBeVisible();
  await expect(details.getByText(/搜索来源/)).toHaveCount(0);
});

test("execution details summarize the user request and disclose each tool independently", async ({ page }) => {
  await mockHistory(page, [userMessage, {
    ...assistantMessage,
    content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({
      type: "assistant-tool-message", text: "A long synthesized answer. ".repeat(80),
      tools: [
        { toolName: "webSearch", toolCallId: "search-one", state: "output-available", input: { query: "latest release", maxResults: 14 }, output: { query: "latest release", results: [{ title: "Release source", url: "https://example.com/release", snippet: "Official release notes" }] } },
        { toolName: "searchKnowledge", toolCallId: "search-two", state: "output-available", input: { query: "release" }, output: { query: "release", total: 0, results: [] } },
      ],
    }),
  }]);
  await page.goto("/chat");
  const details = await openExecutionDetails(page);
  const row = details.locator(".run-record-trigger").first();
  await expect(row).toContainText("Original question");
  await expect(row).not.toContainText("A long synthesized answer");
  const calls = details.getByRole("region", { name: "工具调用", exact: true }).locator("details");
  await expect(calls).toHaveCount(2);
  await calls.first().locator("summary").click();
  await expect(calls.first().getByText("输入参数", { exact: true })).toBeVisible();
  await expect(calls.nth(1)).not.toHaveAttribute("open");
  await calls.nth(1).locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(calls.nth(1).getByText("执行结果", { exact: true })).toBeVisible();
  await expect(calls.first()).toHaveAttribute("open", "");
  await details.getByText(/搜索来源（1）/).click();
  await expect(details.getByRole("link", { name: /Release source/ })).toHaveAttribute("href", "https://example.com/release");
});

for (const code of ["RATE_LIMITED", "CONFLICT"]) {
  test(`chat displays a readable ${code} error`, async ({ page }) => {
    await mockHistory(page, [userMessage, assistantMessage]);
    const payload = { error: { code, message: code === "RATE_LIMITED" ? "请求过于频繁" : "Conversation changed", details: { retryAfterSeconds: 30 } } };
    await page.route("**/api/chat", (route) => code === "RATE_LIMITED"
      ? route.fulfill({ status: 429, json: payload })
      : route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" }, body: streamBody([{ type: "error", errorText: JSON.stringify(payload) }]) }));
    await page.goto("/chat");
    await page.getByPlaceholder(/输入你的问题/).fill("Follow-up");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: "请求失败" });
    await expect(alert).toContainText(code === "RATE_LIMITED" ? "30 秒后可重试" : "重新加载会话");
    await expect(alert).not.toContainText('"error"');
  });
}

for (const approved of [true, false]) {
  test(`reloaded tool approval ${approved ? "acceptance" : "denial"} sends one continuation`, async ({ page }) => {
    await mockHistory(page, [userMessage, pendingMessage]);
    let calls = 0;
    await page.route("**/api/chat", async (route) => {
      calls += 1;
      const body = route.request().postDataJSON();
      expect(body.messages.at(-1).parts.find((part: { type: string }) => part.type === "tool-createTask").approval).toEqual({ id: "approval-1", approved, ...(!approved ? { reason: "用户拒绝" } : {}) });
      await route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" }, body: streamBody([
        { type: "start", messageId: "pending-1" },
        { type: approved ? "tool-output-available" : "tool-output-denied", toolCallId: "call-1", ...(approved ? { output: { taskId: "task-1" } } : {}) },
        { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "Approval handled" },
        { type: "text-end", id: "answer" },
        { type: "finish", finishReason: "stop" },
      ]) });
    });
    await page.goto("/chat");
    await expect(page.getByRole("dialog", { name: "执行记录", exact: true })).toBeHidden();
    await expect(page.locator("article").last()).not.toContainText("工具详情");
    await expect(page.getByRole("region", { name: "操作审批", exact: true })).toBeVisible();
    await page.getByRole("region", { name: "操作审批", exact: true }).getByRole("button", { name: "查看详情", exact: true }).click();
    await expect(page.getByLabel("待审批参数", { exact: true })).toContainText("Task");
    await expect(page.getByRole("status").filter({ hasText: "操作尚未执行" })).toBeVisible();
    await page.getByRole("button", { name: approved ? "批准" : "拒绝", exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await expect(page.locator("article").last().getByText(/Approval handled/)).toBeVisible();
    await expect(page.getByRole("button", { name: "批准", exact: true })).toHaveCount(0);
    await expect(page.locator(".chat-dock").getByText("查看执行详情", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "操作审批", exact: true })).toHaveCount(0);
    expect(calls).toBe(1);
  });
}

test("linked run summaries and tool details render as one request instead of duplicate rows", async ({ page }) => {
  const linked = { ...assistantMessage, content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify({ type: "assistant-tool-message", text: "File read", tools: [{ toolName: "readLocalFile", toolCallId: "old-read", state: "output-available", input: { path: "notes.txt" }, output: { content: "Saved file details" } }] }) };
  await mockHistory(page, [userMessage, linked]);
  await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [{ id: "old-run", messageId: "assistant-1", goal: "Original question", status: "succeeded", steps: [], budget: { maxSteps: 8, maxFailures: 2, deadlineMs: 120000 } }] } }));
  await page.goto("/chat");
  const details = await openExecutionDetails(page);
  await expect(details.locator(".run-record-trigger")).toHaveCount(1);
  await details.getByText("工具详情：readLocalFile · 执行完成", { exact: true }).click();
  await expect(details.getByText("Saved file details", { exact: false })).toBeVisible();
});

test("the approval card advances one decision at a time without opening execution records", async ({ page }) => {
  const payload = JSON.parse(pendingMessage.content.slice("__ASSISTANT_TOOL_MESSAGE__:".length));
  payload.tools.push({ ...payload.tools[0], toolCallId: "call-2", input: { title: "Second task" }, approval: { id: "approval-2" } });
  await mockHistory(page, [userMessage, { ...pendingMessage, content: "__ASSISTANT_TOOL_MESSAGE__:" + JSON.stringify(payload) }]);
  let calls = 0;
  await page.route("**/api/chat", route => { calls++; return route.abort(); });
  await page.goto("/chat");
  const card = page.getByRole("region", { name: "操作审批", exact: true });
  await expect(card.getByText("还有 1 项", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "批准", exact: true }).dblclick();
  await expect(card.getByRole("button", { name: "查看详情", exact: true })).toHaveAttribute("aria-expanded", "false");
  await card.getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(card.getByLabel("待审批参数", { exact: true })).toContainText("Second task");
  expect(calls).toBe(0);
  await expect(page.getByRole("dialog", { name: "执行记录", exact: true })).toBeHidden();
});

test("saving an edited user message regenerates from the edited text", async ({ page }) => {
  await mockHistory(page, [userMessage, assistantMessage]);
  let saved = false;
  await page.route("**/api/conversations/*/messages/user-1", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().postDataJSON().content).toBe("Edited question");
    saved = true;
    await route.fulfill({ json: { data: { ...userMessage, content: "Edited question" } } });
  });
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON();
    expect(saved).toBe(true);
    expect(body.trigger).toBe("regenerate-message");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].parts[0].text).toBe("Edited question");
    await route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" }, body: streamBody([
      { type: "start", messageId: "replacement" },
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: "New answer" },
      { type: "text-end", id: "answer" },
      { type: "finish", finishReason: "stop" },
    ]) });
  });
  await page.goto("/chat");
  await page.getByText("Original question", { exact: true }).hover();
  await page.getByRole("button", { name: "编辑消息" }).click();
  const editor = page.locator("article textarea");
  await editor.fill("Edited question");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("New answer", { exact: true })).toBeVisible();
  await expect(page.getByText("Original answer", { exact: true })).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`user messages omit the role row and reveal actions below the bottom right corner at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockHistory(page, [userMessage, assistantMessage]);
    await page.goto("/chat");
    const bubble = page.locator('[data-message-id="user-1"] article');
    const actions = bubble.locator(".message-actions");
    await expect(bubble).toContainText("Original question");
    await expect(bubble.locator(".label-mono")).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    const before = (await bubble.boundingBox())!;
    await bubble.hover();
    await expect(actions).toHaveCSS("opacity", "1");
    const controls = (await actions.boundingBox())!;
    expect(controls.y).toBeGreaterThanOrEqual(before.y + before.height);
    expect(controls.x + controls.width).toBeCloseTo(before.x + before.width, 0);
    expect(await bubble.boundingBox()).toEqual(before);
    const edit = bubble.getByRole("button", { name: "编辑消息", exact: true });
    await edit.focus(); await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await expect(bubble.locator("textarea")).toHaveValue("Original question");
    await bubble.getByRole("button", { name: "取消", exact: true }).click();
    await expect(bubble.locator("textarea")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}


type ControlledChatStream = { requests: unknown[]; emit: (request: number, chunks: object[], finish?: boolean) => void };
type StreamWindow = Window & { approvalStream: ControlledChatStream };

// Keep the response open between phases, so layout assertions cover waiting
// for approval and resuming the same answer, rather than just a final snapshot.
async function controlledChatStream(page: Page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const requests: unknown[] = [];
    (window as unknown as StreamWindow).approvalStream = {
      requests,
      emit(index, chunks, finish = false) {
        for (const chunk of chunks) controllers[index].enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        if (finish) { controllers[index].enqueue(encoder.encode('data: [DONE]\n\n')); controllers[index].close(); }
      },
    };
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url, location.href).pathname !== '/api/chat') return originalFetch(input, init);
      requests.push(JSON.parse(String(init?.body)));
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); } }), {
        headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
      });
    };
  });
}

for (const width of [1440, 390]) {
  test(`approval leaves reasoning and the reader's position intact at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockHistory(page, []);
    await controlledChatStream(page);
    await page.goto('/chat');
    await page.getByPlaceholder(/输入你的问题/).fill('Read the folder and summarize');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as StreamWindow).approvalStream.requests.length)).toBe(1);
    await page.evaluate(() => (window as unknown as StreamWindow).approvalStream.emit(0, [
      { type: 'start', messageId: 'live-approval' },
      { type: 'reasoning-start', id: 'reasoning' },
      { type: 'reasoning-delta', id: 'reasoning', delta: Array.from({ length: 100 }, (_, i) => `Reading step ${i}: inspect the granted directory before making changes.`).join('\n') },
      { type: 'reasoning-end', id: 'reasoning' },
    ]));
    const reasoning = page.locator('.message-reasoning');
    await expect(reasoning).toHaveAttribute('open', '');
    await expect(reasoning).toContainText('Reading step 99');
    const before = await page.locator('.chat-transcript').evaluate(async panel => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      panel.scrollTop = (panel.scrollHeight - panel.clientHeight) / 2;
      panel.dispatchEvent(new Event('scroll'));
      const body = panel.querySelector('.message-reasoning > div')!;
      body.setAttribute('data-reader-marker', 'same-content');
      return { top: panel.scrollTop, y: body.getBoundingClientRect().y, height: body.getBoundingClientRect().height };
    });
    expect(before.top).toBeGreaterThan(100);
    await page.evaluate(() => (window as unknown as StreamWindow).approvalStream.emit(0, [
      { type: 'tool-input-available', toolCallId: 'live-call', toolName: 'createTask', input: { title: 'Task' } },
      { type: 'tool-approval-request', toolCallId: 'live-call', approvalId: 'live-decision' },
      { type: 'finish', finishReason: 'tool-calls' },
    ], true));
    const card = page.getByRole('region', { name: '操作审批', exact: true });
    await expect(card.getByRole('button', { name: '批准', exact: true })).toBeEnabled();
    await expect(reasoning).toHaveAttribute('open', '');
    await expect(reasoning.locator('[data-reader-marker]')).toHaveCount(1);
    const position = await page.locator('.chat-transcript').evaluate(panel => ({ top: panel.scrollTop, y: panel.querySelector('.message-reasoning > div')!.getBoundingClientRect().y, height: panel.querySelector('.message-reasoning > div')!.getBoundingClientRect().height }));
    expect(position.top).toBeCloseTo(before.top, 0);
    expect(position.y).toBeCloseTo(before.y, 0);
    expect(position.height).toBeCloseTo(before.height, 0);
    await expect(page.locator('article').last()).not.toContainText('请在输入框上方的审批卡');
    await expect(page.getByRole('button', { name: '回到最新', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`approval-reading-${width}.png`) });
    // A deliberate disclosure choice also survives approval and continuation.
    if (width === 390) {
      await reasoning.locator('summary').click();
      await expect(reasoning).not.toHaveAttribute('open', '');
    }
    await card.getByRole('button', { name: '批准', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as StreamWindow).approvalStream.requests.length)).toBe(2);
    await expect(card).toHaveCount(0);
    await expect(page.locator('.chat-dock')).not.toContainText('查看执行详情');
    await page.evaluate(() => (window as unknown as StreamWindow).approvalStream.emit(1, [
      { type: 'start', messageId: 'live-approval' },
      { type: 'tool-output-available', toolCallId: 'live-call', output: { taskId: 'created-task' } },
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: 'The task was created.' },
      { type: 'text-end', id: 'answer' },
      { type: 'finish', finishReason: 'stop' },
    ], true));
    await expect(page.locator('article').last()).toContainText('The task was created.');
    if (width === 390) await expect(reasoning).not.toHaveAttribute('open', '');
    else await expect(reasoning).toHaveAttribute('open', '');
    await expect(page.locator('.chat-dock')).not.toContainText('查看执行详情');
    const records = await openExecutionDetails(page);
    await expect(records.getByText('工具详情：createTask · 执行完成', { exact: true })).toBeVisible();
  });
}
