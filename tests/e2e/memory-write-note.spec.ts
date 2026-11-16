import { expect, test, type Page } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";

const now = "2026-11-15T09:00:00Z";
const history = [
  { id: "row-u", clientMessageId: "user-1", role: "user", content: "我是夜班护士，回答尽量简短。以后记住这一点。", createdAt: now },
  { id: "row-a", clientMessageId: "assistant-1", role: "assistant", content: "好的，我会按你说的来：简短、要点式。", createdAt: now },
];

/** The conversation open in chat, and a follow stream that says a background note-taking run for it has ended. */
async function openWithMemoryEvent(page: Page, event: Record<string, unknown>, chatId = "chat-memory") {
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("anthropic/claude-opus-4.6", ["chat"])], { chat: "anthropic/claude-opus-4.6" }) }));
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [{ id: "chat-memory", title: "夜班与回答偏好", lastMessageAt: now, messageCount: history.length }] } }));
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: history } }));
  await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
  let sent = false;
  await page.route("**/api/conversations/events", async route => {
    // Said once, a moment after the page has the conversation open, as a run ending would.
    if (!sent) await new Promise(resolve => setTimeout(resolve, 1_500));
    const body = `retry: 600000\n\nevent: ready\ndata: {"answering":[]}\n\n${sent ? "" : `event: memory\ndata: ${JSON.stringify({ chatId, added: 0, updated: 0, removed: 0, dropped: 0, ...event })}\n\n`}`;
    sent = true;
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" }, body });
  });
  await page.goto("/chat?conversationId=chat-memory");
  await expect(page.getByText("我是夜班护士", { exact: false })).toBeVisible();
}
const answer = (page: Page) => page.getByTestId("message-list").locator('[data-message-role="assistant"]').last();

test("what a background note-taking run kept is one quiet line under the answer, not a pop-up", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWithMemoryEvent(page, { outcome: "updated", added: 2 });
  const note = answer(page).locator(".answer-memory-note");
  await expect(note).toHaveText("已更新长期记忆：新增 2 条，修改 0 条，删除 0 条");
  await expect(page.locator(".toast-stack .toast")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("memory-note.png"), animations: "disabled" });
});

for (const [outcome, text] of [
  ["unchanged", "这次没有需要长期记住的内容"],
  ["full", "长期记忆已满，有 1 条没有保存 · 去整理"],
  ["failed", "整理长期记忆时出错，没有变化"],
] as const) {
  test(`a note-taking run that ended ${outcome} says so under the answer too`, async ({ page }) => {
    await openWithMemoryEvent(page, { outcome, dropped: outcome === "full" ? 1 : 0 });
    await expect(answer(page).locator(".answer-memory-note")).toHaveText(text);
    if (outcome === "full") {
      await answer(page).getByRole("link", { name: "去整理" }).click();
      await expect(page).toHaveURL(/[?&]settings=ria/);
    }
  });
}

test("a run for another conversation leaves this one's answers alone", async ({ page }) => {
  await openWithMemoryEvent(page, { outcome: "updated", added: 1 }, "some-other-chat");
  await page.waitForTimeout(2_500);
  await expect(page.locator(".answer-memory-note")).toHaveCount(0);
});
