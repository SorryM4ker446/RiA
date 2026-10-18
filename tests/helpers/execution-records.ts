import { expect, type Page } from "@playwright/test";

export async function openExecutionDetails(page: Page) {
  const dialog = page.getByRole("dialog", { name: "执行记录", exact: true });
  if (!await dialog.isVisible()) await page.getByRole("button", { name: "执行记录", exact: true }).click();
  const entry = dialog.locator(".run-record-trigger").first();
  await expect(entry).toBeVisible();
  if (await entry.getAttribute("aria-expanded") !== "true") await entry.click();
  return dialog;
}

export async function openDocumentReferences(page: Page) {
  const dialog = await openExecutionDetails(page);
  const references = dialog.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^文档参考/ }) });
  await expect(references).toBeVisible();
  if (await references.getAttribute("open") === null) await references.locator(":scope > summary").click();
  return dialog;
}
