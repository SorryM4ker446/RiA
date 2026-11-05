import { expect, type Page } from "@playwright/test";

/** The message box, whichever hint it is showing. */
export const composerInput = (page: Page) => page.locator(".composer-input");

/** The menu's row for a name; a row's accessible name also carries its description. */
export const slashOption = (page: Page, name: string) => page.getByRole("option").filter({ has: page.locator(".slash-item-label", { hasText: new RegExp(`^${name}$`) }) });

/** Opens the menu at the start of the message and chooses a row, as a person would with the mouse. */
export async function chooseFromSlashMenu(page: Page, name: string) {
  const input = composerInput(page);
  await input.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type("/");
  await expect(page.getByRole("listbox", { name: "工具、技能和插件", exact: true })).toBeVisible();
  await slashOption(page, name).click();
  await expect(page.getByRole("listbox", { name: "工具、技能和插件", exact: true })).toBeHidden();
}

/** The words chosen for the next message, in order. */
export const chosenWords = (page: Page) => page.locator(".composer-choices .composer-choice");

/** A task made directly, for tests that need one to exist rather than the way it was made. */
export const newTask = (title: string, extra: Record<string, unknown> = {}) => ({ title, priority: "medium", timeZone: "UTC", reminderEnabled: false, repeatRule: "none", ...extra });
