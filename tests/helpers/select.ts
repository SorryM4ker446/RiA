import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Chooses a value in one of the app's custom selects.
 *
 * These are Radix comboboxes, not native `<select>` elements: the native
 * control painted its own menu, ignored the palette and the interface
 * language, and could not be styled at all. `selectOption` only speaks to the
 * native element, so a test that used it now drives the real interaction —
 * open the trigger, then activate the option — which is also what a user does.
 *
 * `optionName` is the visible label; assert on that, not on the stored value,
 * because the stored id is not what the interface shows.
 */
export async function chooseOption(trigger: Locator, optionName: string | RegExp) {
  await trigger.click();
  const option = page_option(trigger, optionName);
  await option.click();
  await expect(trigger).toContainText(optionName instanceof RegExp ? optionName : new RegExp(escape(optionName)));
}

/** The listbox option matching `name`, scoped to the open menu. */
function page_option(trigger: Locator, name: string | RegExp) {
  return trigger.page().getByRole("option", { name, exact: typeof name === "string" });
}

function escape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Reads the value currently shown in a custom select. */
export async function selectedText(trigger: Locator): Promise<string> {
  return (await trigger.textContent())?.trim() ?? "";
}

/** Convenience for the common "open a page and pick an option" flow. */
export async function gotoAndChoose(page: Page, url: string, label: string, optionName: string) {
  await page.goto(url);
  await chooseOption(page.getByLabel(label, { exact: true }), optionName);
}
