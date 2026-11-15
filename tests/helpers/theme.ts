import type { Page } from "@playwright/test";

/**
 * Put the page in a theme without going through Settings → Application, where
 * the theme is chosen: the same class and stored preference that choice sets.
 * For tests about something else that only need to be looked at in a theme;
 * the control itself is covered where the settings are.
 */
async function useTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(next => {
    localStorage.setItem("ui:theme", next);
    document.documentElement.classList.toggle("dark", next === "dark");
    document.documentElement.style.colorScheme = next;
  }, theme);
}

export const useLightTheme = (page: Page) => useTheme(page, "light");
export const useDarkTheme = (page: Page) => useTheme(page, "dark");
