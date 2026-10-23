import { expect, type Page } from "@playwright/test";

/** Answers the app's confirmation dialog with its confirming button, after checking what it asks. */
export async function acceptConfirm(page: Page, text?: string) {
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  if (text) await expect(dialog).toContainText(text);
  await dialog.getByRole("button").last().click();
  await expect(dialog).toBeHidden();
}
