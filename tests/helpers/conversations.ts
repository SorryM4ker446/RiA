import { expect, type Page } from "@playwright/test";

export async function openRecentConversations(page: Page) {
  const trigger = page.getByRole("button", { name: "会话列表", exact: true });
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  await expect(page.getByRole("complementary", { name: "会话列表", exact: true })).toBeVisible();
}
