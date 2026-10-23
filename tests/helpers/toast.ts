import type { Page } from "@playwright/test";

/** The stack of short confirmations shown after an action completes. */
export function toasts(page: Page) {
  return page.getByRole("region", { name: "通知", exact: true });
}
