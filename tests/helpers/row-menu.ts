import { expect, type Locator, type Page } from "@playwright/test";

/** Opens a list row's "more actions" menu and returns it. */
export async function openRowMenu(page: Page, row: Locator) {
  await row.getByRole("button", { name: /^更多操作 / }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** Opens the "more actions" menu named after `owner` and chooses `action` (a menu item's accessible name). */
export async function chooseMenuAction(page: Page, owner: string, action: string) {
  await page.getByRole("button", { name: `更多操作 ${owner}`, exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: action, exact: true }).click();
  await expect(menu).toBeHidden();
}

/** Chooses one action from a list row's "more actions" menu. */
export async function chooseRowAction(page: Page, row: Locator, action: string) {
  const menu = await openRowMenu(page, row);
  await menu.getByRole("menuitem", { name: action, exact: true }).click();
  await expect(menu).toBeHidden();
}
