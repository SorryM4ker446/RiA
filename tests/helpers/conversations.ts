import { expect, type Locator, type Page } from "@playwright/test";

// Folded, the docked sidebar stays in the page, clipped and inert; the sidebar
// in use is the docked one when it is not folded, or the one shown over the page.
const IN_USE = ".workspace-rail-inner:not([inert])";

/** The conversations in the sidebar in use. */
export function conversationList(page: Page): Locator {
  return page.locator(IN_USE).getByRole("complementary", { name: "会话列表", exact: true }).first();
}

/** Shows the sidebar's conversations, pinning the sidebar first when it is folded. */
export async function openRecentConversations(page: Page): Promise<Locator> {
  // Rows (or the empty note) appear once the list has been read, after the page
  // has hydrated: by then whether the sidebar is folded is settled.
  await expect(page.locator(".sidebar-chat-open, .sidebar-chat-empty").first()).toBeAttached();
  if (!await page.locator(`${IN_USE} .sidebar-chats`).count()) {
    await page.getByRole("button", { name: "展开侧边栏", exact: true }).click();
    // Pinning hands focus to the docked sidebar's own button; wait for it rather than race it.
    await expect(page.getByRole("button", { name: "收起侧边栏", exact: true })).toBeFocused();
  }
  await expect(conversationList(page)).toBeVisible();
  return conversationList(page);
}
