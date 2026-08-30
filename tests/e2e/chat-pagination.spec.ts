import { expect, test, type Page } from "@playwright/test";

const summary = (id: string) => ({ id, title: `Conversation ${id}`, messageCount: 1, lastMessageAt: "2026-08-30T00:00:00Z" });
const message = (id: string) => ({ id, clientMessageId: id, role: "assistant", content: `History ${id}`, createdAt: "2026-08-30T00:00:00Z" });
async function panels(page: Page) {
  await page.route("**/api/tasks**", (route) => route.fulfill({ json: { data: [] } }));
  await page.route("**/api/tools?*", (route) => route.fulfill({ json: { data: [] } }));
}

test("conversation and history controls fetch only requested pages and deduplicate boundaries", async ({ page }) => {
  await panels(page);
  const messagePages: string[] = [];
  await page.route(/\/api\/conversations(?:\?.*)?$/, (route) => {
    const older = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({ json: { data: older ? [summary("a"), summary("b")] : [summary("a")], pageInfo: { nextCursor: older ? null : "chats-next", hasMore: !older } } });
  });
  await page.route(/\/api\/conversations\/[^/]+\/messages(?:\?.*)?$/, (route) => {
    const older = new URL(route.request().url()).searchParams.has("cursor");
    messagePages.push(older ? "older" : "newest");
    return route.fulfill({ json: { data: older ? [message("old"), message("new")] : [message("new")], pageInfo: { nextCursor: older ? null : "messages-next", hasMore: !older } } });
  });
  await page.goto("/chat");
  await expect(page.getByText("History new", { exact: true })).toBeVisible();
  await expect(page.getByText("History old", { exact: true })).toHaveCount(0);
  expect(messagePages).not.toContain("older");
  await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
  await expect(page.getByText("History old", { exact: true })).toBeVisible();
  await expect(page.getByText("History new", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "加载更早消息", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "加载更多会话", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Conversation b/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Conversation a/ })).toHaveCount(1);
});

test("reload restores an active conversation outside the first list page", async ({ page }) => {
  await panels(page);
  await page.addInitScript(() => localStorage.setItem("chat:last-active-id", "older"));
  await page.route("**/api/conversations", (route) => route.fulfill({ json: { data: [summary("newer")], pageInfo: { nextCursor: "next", hasMore: true } } }));
  await page.route("**/api/conversations/older", (route) => route.fulfill({ json: { data: summary("older") } }));
  await page.route("**/api/conversations/*/messages", (route) => route.fulfill({ json: { data: [message(route.request().url().includes("/older/") ? "restored" : "wrong-conversation")] } }));
  await page.goto("/chat");
  await expect(page.getByText("History restored", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("History restored", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("chat:last-active-id"))).toBe("older");
});

for (const failure of [false, true]) {
  test(`switching conversations ignores delayed older-page ${failure ? "errors" : "results"}`, async ({ page }) => {
    await panels(page);
    await page.route("**/api/conversations", (route) => route.fulfill({ json: { data: [summary("a"), summary("b")] } }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/\/api\/conversations\/[^/]+\/messages(?:\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("cursor")) {
        await gate;
        return route.fulfill(failure
          ? { status: 500, json: { error: { code: "INTERNAL_ERROR", message: "Delayed older-page error" } } }
          : { json: { data: [message("stale-old")] } });
      }
      const isA = url.pathname.includes("/a/");
      return route.fulfill({ json: { data: [message(isA ? "a-new" : "b-new")], pageInfo: { nextCursor: isA ? "older-a" : null, hasMore: isA } } });
    });
    try {
      await page.goto("/chat");
      await expect(page.getByText("History a-new", { exact: true })).toBeVisible();
      const request = page.waitForRequest(/messages\?cursor=/);
      await page.getByRole("button", { name: "加载更早消息", exact: true }).click();
      await request;
      await page.getByRole("button", { name: /^Conversation b/ }).click();
      await expect(page.getByText("History b-new", { exact: true })).toBeVisible();
      const response = page.waitForResponse(/messages\?cursor=/);
      release();
      await response;
      await expect(page.getByText("History b-new", { exact: true })).toBeVisible();
      await expect(page.getByText("History stale-old", { exact: true })).toHaveCount(0);
      await expect(page.getByText("Delayed older-page error", { exact: true })).toHaveCount(0);
    } finally { release(); }
  });
}
