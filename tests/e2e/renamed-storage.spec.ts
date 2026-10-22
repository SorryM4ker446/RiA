import { expect, test } from "@playwright/test";
import { fixtureLibraryItem, modelsRouteFixture } from "../helpers/model-fixture";

const now = "2026-10-22T00:00:00Z";

test("panel layout and unsent drafts saved before the RiA rename survive the upgrade", async ({ page }) => {
  await page.route("**/api/models", route => route.fulfill({ json: modelsRouteFixture([fixtureLibraryItem("fixture/chat", ["chat"])], { chat: "fixture/chat" }) }));
  await page.route("**/api/conversations", route => route.fulfill({ json: { data: [{ id: "renamed-chat", title: "Renamed", messageCount: 1, lastMessageAt: now }] } }));
  await page.route("**/api/conversations/*/messages", route => route.fulfill({ json: { data: [{ id: "u", clientMessageId: "u", role: "user", content: "Earlier question", createdAt: now }] } }));
  await page.route("**/api/conversations/*/runs?*", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tasks**", route => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", route => route.fulfill({ json: { data: [] } }));
  // Seed only once, as an installation upgraded from the pre-rename build would be.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("private-ai.chat.panel-visibility", JSON.stringify({ conversations: false, tasks: true }));
    localStorage.setItem("private-ai.chat.draft.renamed-chat", JSON.stringify({ text: "Draft from the old build", attachments: [], updatedAt: Date.now() }));
  });
  // The first paint already uses the saved layout, before any client code runs.
  let firstPaint: string | undefined;
  page.on("domcontentloaded", async () => { firstPaint = await page.evaluate(() => document.documentElement.dataset.conversationsOpen).catch(() => undefined); });
  await page.goto("/chat?conversationId=renamed-chat");
  await expect(page.getByPlaceholder(/输入你的问题/)).toHaveValue("Draft from the old build");
  expect(firstPaint).toBe("false");
  await expect(page.locator("html")).toHaveAttribute("data-conversations-open", "false");
  const stored = await page.evaluate(() => ({
    panels: localStorage.getItem("ria.chat.panel-visibility"), legacyPanels: localStorage.getItem("private-ai.chat.panel-visibility"),
    draft: localStorage.getItem("ria.chat.draft.renamed-chat"), legacyDraft: localStorage.getItem("private-ai.chat.draft.renamed-chat"),
  }));
  expect(JSON.parse(stored.panels!)).toEqual({ conversations: false, tasks: true });
  expect(stored.legacyPanels).toBeNull();
  expect(JSON.parse(stored.draft!).text).toBe("Draft from the old build");
  expect(stored.legacyDraft).toBeNull();
  // After the move, a reload reads the RiA keys alone.
  await page.reload();
  await expect(page.getByPlaceholder(/输入你的问题/)).toHaveValue("Draft from the old build");
  await expect(page.locator("html")).toHaveAttribute("data-conversations-open", "false");
});
