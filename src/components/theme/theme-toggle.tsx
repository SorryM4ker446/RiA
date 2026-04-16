"use client";

import { useEffect } from "react";
import { Moon, SunMedium } from "lucide-react";
import { Button } from "@/components/ui/button";

const THEME_STORAGE_KEY = "ui:theme";

type ThemeMode = "light" | "dark";

function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export function ThemeToggle() {
  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    const initialTheme: ThemeMode = stored === "dark" ? "dark" : "light";
    applyTheme(initialTheme);
  }, []);

  function onToggleTheme() {
    const currentTheme: ThemeMode = document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
    const nextTheme: ThemeMode = currentTheme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  }

  return (
    <Button
      aria-label="切换主题"
      className="fixed right-4 top-4 z-50 h-9 w-9 rounded-full border-border/70 bg-background/80 shadow-sm backdrop-blur hover:bg-muted/80"
      onClick={onToggleTheme}
      size="icon"
      type="button"
      variant="outline"
    >
      <SunMedium className="hidden h-4 w-4 dark:block" />
      <Moon className="h-4 w-4 dark:hidden" />
    </Button>
  );
}
