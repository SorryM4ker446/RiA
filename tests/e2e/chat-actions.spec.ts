import { expect, test, type Page } from "@playwright/test";

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
  await page.route("**/api/conversations", (route) => route.fulfill({ json: { data: [{ id: "chat-actions", title: "Actions", lastMessageAt: now, messageCount: history.length }] } }));
  await page.route("**/api/conversations/*/messages", (route) => route.fulfill({ json: { data: history } }));
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));
}

function streamBody(chunks: object[]) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
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
    await page.getByText(/工具详情：createTask/).click();
    await page.getByRole("button", { name: approved ? "批准" : "拒绝", exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await expect(page.getByText(/Approval handled/)).toBeVisible();
    await expect(page.getByRole("button", { name: "批准", exact: true })).toHaveCount(0);
    expect(calls).toBe(1);
  });
}

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
