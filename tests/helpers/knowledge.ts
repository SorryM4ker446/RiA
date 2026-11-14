import { expect, type Page } from "@playwright/test";

/** The import form, which the knowledge page's "导入文档" action opens as a card above the documents. */
export const importForm = (page: Page) => page.getByRole("form", { name: "导入知识文档", exact: true });

/** Opens the import card unless it is already open, and returns its form. */
export async function openDocumentImport(page: Page) {
  const form = importForm(page);
  if (!(await form.isVisible())) await page.getByRole("button", { name: "导入文档", exact: true }).click();
  await expect(form).toBeVisible();
  return form;
}

/** The card's submit, which reads the chosen file into a preview before anything is saved. */
export const previewImportButton = (page: Page) => page.getByRole("button", { name: "预览导入", exact: true });

/** A confirmed save folds the import card away; waiting for that waits for the save to finish. */
export async function expectImportClosed(page: Page) {
  await expect(importForm(page)).toBeHidden();
}

/**
 * Searches the content of the documents. That search lives in the documents view and runs on Enter;
 * from the overview this first follows the documents section's "全部 N 份" link.
 */
export async function searchDocumentContent(page: Page, query: string) {
  const field = page.getByRole("textbox", { name: "检索文档", exact: true });
  if (!(await field.isVisible())) {
    await page.getByRole("button", { name: /^全部 \d+ 份$/ }).click();
    await expect(page).toHaveURL(/[?&]view=documents/);
  }
  await field.fill(query);
  await field.press("Enter");
}

/** The full list of knowledge entries, with its search, status filter and paging. */
export async function openEntriesView(page: Page, origin = "") {
  await page.goto(`${origin}/knowledge?view=entries`);
  await expect(page.getByRole("heading", { level: 1, name: "知识条目", exact: true })).toBeVisible();
}
