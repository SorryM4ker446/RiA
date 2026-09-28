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
