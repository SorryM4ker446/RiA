import { expect, test } from "@playwright/test";

for (const historyFails of [false, true]) {
  test(`first chat submission waits for initial history ${historyFails ? "and refuses to send after a load failure" : "and stays attached to the active conversation"}`, async ({ page }) => {
    let created = false;
    let chatRequests = 0;
    let releaseHistory!: () => void;
    let historyStarted!: () => void;
    const started = new Promise<void>((resolve) => { historyStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseHistory = resolve; });
    const chat = { id: "new-conversation", title: "First question", lastMessageAt: "2026-08-30T00:00:00Z", messageCount: 0 };
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
