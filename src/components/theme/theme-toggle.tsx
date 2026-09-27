"use client";

import { useEffect } from "react";
import { Moon, SunMedium } from "lucide-react";
import { t } from "@/lib/locale";

const THEME_STORAGE_KEY = "ui:theme";

type ThemeMode = "light" | "dark";

function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

/** Square icon button, sized to sit inline with the navigation footer. */
export function ThemeToggle() {
  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    applyTheme(stored === "dark" ? "dark" : "light");
  }, []);

  function onToggleTheme() {
    const nextTheme: ThemeMode = document.documentElement.classList.contains("dark")
      ? "light"
      : "dark";
    applyTheme(nextTheme);
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  }

  return (
    /* Both icons live in the DOM and the .dark class on <html> picks one, so the
       swap costs no React state and cannot flash during hydration. */
    <button
      aria-label={t("theme.toggle")}
      className="group grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-[--dur-fast] ease-[--ease-out] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-90"
      onClick={onToggleTheme}
      type="button"
    >
      {/* Both glyphs stay in the DOM and share one grid cell so the rotation
          has something to interpolate against. Each one must REST visible in
          its own theme: the outgoing icon animates to opacity-0 while the
          incoming one animates to opacity-100. Giving both a resting opacity-0
          left the button with no glyph at all, which read as an empty black
          square against the dark rail. */}
      <SunMedium
        aria-hidden="true"
        className="col-start-1 row-start-1 h-4 w-4 rotate-0 scale-100 opacity-100 transition-[transform,opacity] duration-[--dur-base] ease-[--ease-spring] dark:-rotate-90 dark:scale-50 dark:opacity-0"
      />
      <Moon
        aria-hidden="true"
        className="col-start-1 row-start-1 h-4 w-4 rotate-90 scale-50 opacity-0 transition-[transform,opacity] duration-[--dur-base] ease-[--ease-spring] dark:rotate-0 dark:scale-100 dark:opacity-100"
      />
    </button>
  );
}
