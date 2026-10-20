import { expect, type Locator, type Page } from "@playwright/test";

export async function chooseTaskDateTime(
  page: Page,
  scope: Locator,
  label: string,
  value: string,
) {
  const [date, time] = value.split("T");
  await scope.getByLabel(label, { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: label, exact: true });
  await expect(dialog).toBeVisible();
  for (let step = 0; step < 120; step++) {
    const day = dialog.locator(`button[data-day="${date}"]`);
    if (await day.count()) {
      await day.click();
      await scope.locator('input[type="time"]').fill(time);
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
