import { expect, type Locator, type Page } from "@playwright/test";

export async function chooseTaskDateTime(
  page: Page,
  scope: Locator,
  label: string,
  value: string,
) {
  const [date, time] = value.split("T");
  // The button is named by its label and the date and time it holds.
  await scope.getByRole("button", { name: new RegExp(`^${label}( |$)`) }).click();
  const dialog = page.getByRole("dialog", { name: label, exact: true });
  await expect(dialog).toBeVisible();
  for (let step = 0; step < 120; step++) {
    const day = dialog.locator(`button[data-day="${date}"]`);
    if (await day.count()) {
      await day.click();
      // The time is chosen in the same popover, which stays open until it is done.
      const inPopover = dialog.locator("[data-time-input]");
      await inPopover.fill(time);
      await expect(inPopover).toHaveValue(time);
      await dialog.getByRole("button", { name: /^(完成|Done)$/ }).click();
      await expect(dialog).toHaveCount(0);
      return;
    }
    const middle = await dialog
      .locator("button[data-day]")
      .nth(15)
      .getAttribute("data-day");
    await dialog
      .locator(date < middle! ? ".rdp-button_previous" : ".rdp-button_next")
      .click();
  }
  throw new Error(`Date ${date} was not reachable in the calendar`);
}
