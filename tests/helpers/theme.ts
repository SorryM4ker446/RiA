import type { Page } from "@playwright/test";

/**
 * Switch to the light theme where the theme toggle is out of reach. The
 * settings overlay has no toggle of its own and covers the sidebar's one, so
 * screens inside it are switched the way the toggle stores the preference.
 */
export async function useLightTheme(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem("ui:theme", "light");
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "light";
  });
}
