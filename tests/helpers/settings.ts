import { expect, type Page } from "@playwright/test";

/** The settings overlay. Its sections are tabs named as in its side list. */
export function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "设置", exact: true });
}

/** Opens settings from the sidebar over the current page, then the named section. */
export async function openSettings(page: Page, section?: string) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible();
  if (section) await dialog.getByRole("tab", { name: section, exact: true }).click();
  return dialog;
}

/** Closes settings with its close button, back to the page beneath. */
export async function closeSettings(page: Page) {
  await settingsDialog(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(settingsDialog(page)).toBeHidden();
}
