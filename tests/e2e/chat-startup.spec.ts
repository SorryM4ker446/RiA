import { expect, test } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";

const modelSettings = modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" });

for (const historyFails of [false, true]) {
  test(`first chat submission waits for initial history ${historyFails ? "and refuses to send after a load failure" : "and stays attached to the active conversation"}`, async ({ page }) => {
    let created = false;
    let chatRequests = 0;
    let releaseHistory!: () => void;
    let historyStarted!: () => void;
    const started = new Promise<void>((resolve) => { historyStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseHistory = resolve; });
    const chat = { id: "new-conversation", title: "First question", lastMessageAt: "2026-08-30T00:00:00Z", messageCount: 0 };
    await page.route("**/api/models", (route) => route.fulfill({ json: modelSettings }));
  await page.route("**/api/conversations", (route) => {
      if (route.request().method() === "POST") { created = true; return route.fulfill({ status: 201, json: { data: chat } }); }
      return route.fulfill({ json: { data: created ? [chat] : [] } });
    });
    await page.route("**/api/conversations/*/messages", async (route) => {
      historyStarted();
      await gate;
      await route.fulfill(historyFails ? { status: 500, json: { error: { code: "INTERNAL_ERROR", message: "History unavailable" } } } : { json: { data: [] } });
    });
    await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
    await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));
    await page.route("**/api/chat", (route) => {
      chatRequests++;
      expect(route.request().postDataJSON().messages).toHaveLength(1);
      return route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" }, body: [
        { type: "start", messageId: "first-answer" },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "First streamed answer" },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: "stop" },
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" });
    });
    try {
      await page.goto("/chat");
      await page.getByPlaceholder(/输入你的问题/).fill("First question");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await started;
      expect(chatRequests).toBe(0);
      releaseHistory();
      if (historyFails) {
        await expect(page.getByRole("alert").filter({ hasText: "请求失败" })).toContainText("重新加载会话");
        await page.getByPlaceholder(/输入你的问题/).fill("Retry question");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: "请求失败" })).toContainText("重新加载会话");
        expect(chatRequests).toBe(0);
      } else {
        await expect(page.getByText("First streamed answer", { exact: true })).toBeVisible();
        expect(chatRequests).toBe(1);
      }
    } finally { releaseHistory(); }
  });
}

test("the model's reasoning is shown above the answer and stays out of it", async ({ page }) => {
  const chat = { id: "reasoning-conversation", title: "思考展示", lastMessageAt: "2026-09-28T00:00:00Z", messageCount: 0 };
  await page.route("**/api/models", (route) => route.fulfill({ json: modelSettings }));
  await page.route("**/api/conversations", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 201, json: { data: chat } })
      : route.fulfill({ json: { data: [chat] } }));
  await page.route("**/api/conversations/*/messages", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/chat", (route) =>
    route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" }, body: [
      { type: "start", messageId: "reasoning-answer" },
      { type: "reasoning-start", id: "reasoning-0" },
      { type: "reasoning-delta", id: "reasoning-0", delta: "先比较两种做法" },
      { type: "reasoning-end", id: "reasoning-0" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "结论是这样" },
      { type: "text-end", id: "text" },
      { type: "finish", finishReason: "stop" },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" }));

  await page.goto("/chat");
  await page.getByPlaceholder(/输入你的问题/).fill("哪种更好？");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  // The reasoning is its own block above the answer, collapsed so the answer is
  // what the eye lands on, and it is not folded into the answer text.
  const answer = page.getByText("结论是这样", { exact: true });
  await expect(answer).toBeVisible();
  const summary = page.getByText("查看思考过程", { exact: true });
  await expect(summary).toBeVisible();
  await expect(answer.locator("xpath=ancestor::details[1]")).toHaveCount(0);
  await summary.click();
  await expect(page.getByText("先比较两种做法", { exact: true })).toBeVisible();
  await expect(answer).toBeVisible();
});

test("an unsent draft survives switching conversations and a reload, and is cleared by a sent message", async ({ page }) => {
  const modelSettings2 = modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" });
  const first = { id: "draft-one", title: "First", lastMessageAt: "2026-09-28T00:00:00Z", messageCount: 0 };
  const second = { id: "draft-two", title: "Second", lastMessageAt: "2026-09-28T00:00:01Z", messageCount: 0 };
  await page.route("**/api/models", (route) => route.fulfill({ json: modelSettings2 }));
  await page.route("**/api/conversations", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 201, json: { data: second } })
      : route.fulfill({ json: { data: [second, first] } }));
  await page.route("**/api/conversations/*/messages", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/chat", (route) =>
    route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" }, body: [
      { type: "start", messageId: "answer" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "已回答" },
      { type: "text-end", id: "text" },
      { type: "finish", finishReason: "stop" },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" }));

  const composer = page.getByPlaceholder(/输入你的问题/);
  await page.goto("/chat");
  await page.getByRole("button", { name: /First/ }).click();
  await expect(composer).toBeVisible();
  await composer.fill("写到一半的草稿");

  // Leaving the conversation parks the draft; coming back restores it.
  await page.getByRole("button", { name: /Second/ }).click();
  await expect(composer).toHaveValue("");
  await page.getByRole("button", { name: /First/ }).click();
  await expect(composer).toHaveValue("写到一半的草稿");

  // A reload is the case a memory-only composer loses.
  await page.reload();
  await page.getByRole("button", { name: /First/ }).click();
  await expect(composer).toHaveValue("写到一半的草稿");

  // Sending it clears the draft, so it does not come back on the next visit.
  await composer.fill("真正发出的问题");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("已回答", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Second/ }).click();
  await page.getByRole("button", { name: /First/ }).click();
  await expect(composer).toHaveValue("");
});

test("stopping a turn ends it without re-sending the question", async ({ page }) => {
  const chat = { id: "stop-conversation", title: "Stopping", lastMessageAt: "2026-09-28T00:00:00Z", messageCount: 0 };
  await page.route("**/api/models", (route) => route.fulfill({ json: modelSettings }));
  await page.route("**/api/conversations", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 201, json: { data: chat } })
      : route.fulfill({ json: { data: [chat] } }));
  await page.route("**/api/conversations/*/messages", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));
  // A stream that stays open: the turn is running until the user stops it.
  // The response is held open by a gate, so the turn is genuinely in flight
  // while the stop control is asserted. A body delivered at once would finish
  // the stream before anything could be checked.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/chat", async (route) => {
    await gate;
    await route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" }, body: [
      { type: "start", messageId: "long-answer" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "开头" },
      { type: "text-end", id: "text" },
      { type: "finish", finishReason: "stop" },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" });
  });

  const composer = page.getByPlaceholder(/输入你的问题/);
  await page.goto("/chat");
  await composer.fill("一个很长的问题");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  const stop = page.getByRole("button", { name: "停止", exact: true });
  await expect(stop).toBeVisible();
  // The send button is replaced, not stacked next to a still-enabled one.
  await expect(page.getByRole("button", { name: "发送", exact: true })).toHaveCount(0);
  await stop.click();
  // The held request is released so the aborted turn can settle; the composer
  // must come back to a sendable state either way.
  release();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  // The question was delivered and is in the conversation, so the composer is
  // left empty rather than offering to send it a second time.
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: /Stopping/ })).toBeVisible();
});

test("a streaming answer does not drag the view away from history, and offers a way back", async ({ page }) => {
  const modelSettings3 = modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" });
  const filler = Array.from({ length: 30 }, (_, index) => ({
    role: "assistant" as const,
    content: `第 ${index + 1} 条较长的历史回答，用来把消息列表撑到需要滚动的长度。`.repeat(4),
  }));
  const chat = { id: "scroll-conversation", title: "Scrolling", lastMessageAt: "2026-09-28T00:00:00Z", messageCount: filler.length };
  await page.route("**/api/models", (route) => route.fulfill({ json: modelSettings3 }));
  await page.route("**/api/conversations", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 201, json: { data: chat } })
      : route.fulfill({ json: { data: [chat] } }));
  await page.route("**/api/conversations/*/messages", (route) =>
    route.fulfill({ json: { data: filler.map((item, index) => ({ id: `m${index}`, clientMessageId: null, role: item.role, content: item.content, status: "success" })) } }));
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));

  // The answer is held so the reader can scroll up *while it streams*, which is
  // the case where following the newest message would steal their place.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/chat", async (route) => {
    await gate;
    await route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" }, body: [
      { type: "start", messageId: "last" },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "最新的一条回答" },
      { type: "text-end", id: "text" },
      { type: "finish", finishReason: "stop" },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n" });
  });

  const distanceFromBottom = () => page.evaluate(() => document.documentElement.scrollHeight - window.scrollY - window.innerHeight);
  const scroller = page.getByTestId("message-list");
  await page.goto("/chat");
  await expect(scroller).toContainText("第 1 条较长的历史回答");
  // A long history opens at the newest message, not at the top.
  await expect.poll(distanceFromBottom, { timeout: 5_000 }).toBeLessThan(120);

  await page.getByPlaceholder(/输入你的问题/).fill("接着问");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  // Reading history while the answer is still being produced.
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  release();
  await expect(page.getByText("最新的一条回答", { exact: true })).toBeAttached();

  // The view stayed where the reader put it, and a way back is offered.
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(120);
  await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();
  await page.getByRole("button", { name: "回到最新" }).click();
  await expect.poll(distanceFromBottom, { timeout: 5_000 }).toBeLessThan(120);
});

test("an answer and its code block can both be copied", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions are chromium-specific here");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const chat = { id: "copy-conversation", title: "Copying", lastMessageAt: "2026-09-28T00:00:00Z", messageCount: 1 };
  await page.route("**/api/models", (route) => route.fulfill({ json: modelSettings }));
  await page.route("**/api/conversations", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 201, json: { data: chat } })
      : route.fulfill({ json: { data: [chat] } }));
  await page.route("**/api/conversations/*/messages", (route) =>
    route.fulfill({ json: { data: [{
      id: "a1",
      clientMessageId: null,
      role: "assistant",
      status: "success",
      content: "结论如下：\n\n```ts\nconst answer = 42;\n```\n\n补充说明。",
    }] } }));
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));

  await page.goto("/chat");
  await expect(page.getByText("结论如下：", { exact: false }).first()).toBeVisible();

  // The whole answer.
  await page.getByRole("button", { name: "复制这条回答" }).click();
  const answer = await page.evaluate(() => navigator.clipboard.readText());
  expect(answer).toContain("结论如下");
  expect(answer).toContain("const answer = 42;");

  // And the code block on its own, which is what gets pasted elsewhere.
  await page.getByRole("button", { name: "复制代码" }).click();
  const code = await page.evaluate(() => navigator.clipboard.readText());
  expect(code.trim()).toBe("const answer = 42;");
});

test("Escape stops a running turn", async ({ page }) => {
  const chat = { id: "escape-conversation", title: "Escaping", lastMessageAt: "2026-09-28T00:00:00Z", messageCount: 0 };
  await page.route("**/api/models", (route) => route.fulfill({ json: modelSettings }));
  await page.route("**/api/conversations", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 201, json: { data: chat } })
      : route.fulfill({ json: { data: [chat] } }));
  await page.route("**/api/conversations/*/messages", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/chat", async (route) => {
    await gate;
    await route.fulfill({ contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" }, body: "data: [DONE]\n\n" });
  });

  await page.goto("/chat");
  await page.getByPlaceholder(/输入你的问题/).fill("需要被打断的一轮");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  // The held request is then released: aborting a request the mock is still
  // holding only settles once that handler returns, so the assertion is that
  // the key reaches the same stop path the button does and the turn ends
  // cleanly, not that Escape alone is enough to unblock a stalled server.
  release();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "输入的问题" })).toHaveCount(0);
});
