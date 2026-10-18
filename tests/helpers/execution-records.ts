import { expect, type Page } from "@playwright/test";

export async function openExecutionDetails(page: Page) {
  const dialog = page.getByRole("dialog", { name: "执行记录", exact: true });
  if (!await dialog.isVisible()) await page.getByRole("button", { name: "执行记录", exact: true }).click();
  const entry = dialog.locator(".run-record-trigger").first();
  await expect(entry).toBeVisible();
  if (await entry.getAttribute("aria-expanded") !== "true") await entry.click();
  return dialog;
}
