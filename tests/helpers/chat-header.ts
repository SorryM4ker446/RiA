import { expect, type Page } from "@playwright/test";
import { openMenu } from "./row-menu";

/** The open conversation's title, in the window's top row. */
export const chatTitle = (page: Page) => page.locator(".chat-title-text");

/** Opens the menu on the conversation's title (template, its details, memory, managing templates). */
export async function openChatMenu(page: Page) {
  const menu = openMenu(page);
  if (!(await menu.isVisible())) await page.locator(".chat-title").click();
  await expect(menu).toBeVisible();
  return menu;
}

export async function closeChatMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(openMenu(page)).toBeHidden();
}

/** Chooses the conversation's assistant template from the title menu. */
export async function chooseTemplate(page: Page, name: string) {
  const menu = await openChatMenu(page);
  await menu.getByRole("menuitemradio", { name, exact: true }).click();
  await expect(menu).toBeHidden();
}

/** The template the conversation runs on, as its menu marks it. */
export async function expectTemplate(page: Page, name: string) {
  const menu = await openChatMenu(page);
  await expect(menu.getByRole("menuitemradio", { name, exact: true })).toHaveAttribute("aria-checked", "true");
  await closeChatMenu(page);
}

/** The conversation's long-term memory switch, inside the title menu. */
export const memorySwitch = (page: Page) => page.getByRole("menuitemcheckbox", { name: /^长期记忆/ });
